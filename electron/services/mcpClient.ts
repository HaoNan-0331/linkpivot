/**
 * mcpClient —— MCP 连接器（21-03，MCP-04/MCP-05）。
 *
 * 双 transport（spike V-1~V-5 实证形态，以 21-SPIKE.md 为准）：
 *  - stdio：三路径分流（绝对路径 existsSync 直用 / node·npx PATH 主路径 / process.execPath
 *    + ELECTRON_RUN_AS_NODE='1' 兜底重试）
 *  - http：Streamable HTTP 主路径 + SSE-only 旧对端显式 fallback（SDK v2 无内建降级，
 *    spike V-3：connect 期 404/405 抛 SdkHttpError → SSEClientTransport(baseUrl + '/sse')，
 *    已弃用但仍正常导出；两层各建独立 Client；fallback 只判 connect 期错误，勿吞运行期异常）
 *
 * 防御红线（STATE 红线：防御不许后补）：
 *  - env 白名单显式构造（SAFE_BASE），源码零处 spread process.env（grep 守卫）；凭证只经 env，零处进 args（T-21-03-01/02）
 *  - HTTP token 只进 Authorization header，URL 构造零处拼接凭证（T-21-03-03）
 *  - 全 RPC Promise.race 硬超时：listTools 10s / callTool 60s / stdio 连接测试冷启动 60s 预算；
 *    超时 transport.destroy + Registry.killTree + 结构化错误（T-21-03-05）
 *  - spawn 后 pid 登记 McpProcessRegistry，关闭即树杀；连接测试测完即杀不留连接（T-21-03-04）
 *  - 空闲回收：IDLE_TIMEOUT_MS=10min，sweep 定时器本模块自持并 unref()（裁决：Registry 保持
 *    纯登记/杀最小职责，连接生命周期归连接器——见 mcpProcessRegistry.ts 头注）
 *
 * cancel 统一形态（21-04 对齐）：mcpClient.cancelTest(testId)——Map<testId, AbortController>，
 * abort 触发 destroy + killTree 清理路径。
 */

import { Client, StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Transport } from '@modelcontextprotocol/client'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { McpProcessRegistry } from './mcpProcessRegistry'
import { buildFingerprintTree } from './mcpPackageValidator'
import type { McpDecodedConfig } from './mcpService'

/** env 白名单（21-RESEARCH Pattern 3）——显式拷贝，禁止 spread process.env */
const SAFE_BASE = ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'USERPROFILE', 'LANG']

/**
 * node 工具链命令清单（24-04 Gap #1）：这些命令 spawn 失败（ENOENT / Windows close 竞态
 * CONNECTION_CLOSED）时，最大可能是该机未安装 Node.js——给出针对性提示而非裸透 Connection closed。
 */
const NODE_TOOLCHAIN_COMMANDS = ['npx', 'node', 'npm', 'nodemon']

export const RPC_TOLISTOOLS_MS = 10000
export const RPC_CALLTOOL_MS = 60000
/** stdio 连接测试冷启动总预算（spawn + 握手 + listTools 全程） */
export const TEST_STDIO_BUDGET_MS = 60000
/** http 连接测试总预算（connect + listTools） */
export const TEST_HTTP_BUDGET_MS = 30000
/** 长连接空闲回收阈值（裁决：10 分钟） */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000

export type McpStage = 'starting' | 'handshake' | 'listing'
export type StageCallback = (stage: McpStage, elapsedMs: number) => void

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: unknown
  annotations?: unknown
}

export interface McpTestError {
  code: string
  /** 人话原因 */
  reason: string
  errno?: string | number
}

export type McpTestResult =
  | { ok: true, protocolVersion: string | undefined, tools: McpToolInfo[] }
  | { ok: false, error: McpTestError }

interface ActiveConnection {
  client: Client
  transport: Transport
  pid: number | null
  lastUsedAt: number
}

/** 连接级 Map：key = `${configId}:${deviceId}` 复合键（29-04 D-15/D-18）或 tempKey——不进 sessions/windowSessionMap */
const connections = new Map<string, ActiveConnection>()

// ---------------------------------------------------------------------------
// Phase 29（29-04）：包 spawn 信息 + TOCTOU 全树重验 + integrity 副作用注入
// ---------------------------------------------------------------------------

/** 从包创建的配置 spawn 前所需包元数据（ai.ts 从 mcp_packages 行装配） */
export interface PackageSpawnInfo {
  packageId: number
  dirPath: string
  runtime: 'node' | 'python'
  /** manifest.entry（posix 相对路径） */
  entry: string
  /** 落盘 fingerprint_json（mcp_packages.fingerprint_json 原文） */
  fingerprintJson: string
}

/** 设备级连接选项：deviceId 参与复合键；package 在场时 spawn 前做 TOCTOU 全树重验 */
export interface McpConnectionOpts {
  deviceId?: string
  package?: PackageSpawnInfo
}

/** 连接复合键（D-18）：deviceId 缺省 '0' 保持手工 stdio 配置旧语义不断 */
export function connectionKey(configId: string, deviceId?: string): string {
  return `${configId}:${deviceId ?? '0'}`
}

/** TOCTOU 检出回调（D-26 副作用链路）：main.ts 接 service 写包 disabled=1 + ai_system_logs security 行 */
type IntegrityHandler = (info: { packageId: number, dirPath: string, detail: string }) => void
let integrityHandler: IntegrityHandler | null = null

/** 注入/清除 TOCTOU 副作用处理器（mcpClient 自身零 DB 依赖，service 侧落库） */
export function setIntegrityHandler(fn: IntegrityHandler | null): void {
  integrityHandler = fn
}

/** 递归收集目录全树（posix 相对路径，D-27 全树——含新增文件） */
function collectDirFiles(dirPath: string, rel = ''): Array<{ path: string, content: Buffer }> {
  const out: Array<{ path: string, content: Buffer }> = []
  for (const name of readdirSync(join(dirPath, rel))) {
    const relPath = rel ? `${rel}/${name}` : name
    const abs = join(dirPath, ...relPath.split('/'))
    if (statSync(abs).isDirectory()) out.push(...collectDirFiles(dirPath, relPath))
    else out.push({ path: relPath, content: readFileSync(abs) })
  }
  return out
}

function integrityError(reason: string): { code: string, reason: string } {
  return { code: 'package_integrity_failed', reason }
}

/**
 * spawn 前全树指纹重验（T-29-04-01 / D-27）：目录全树重算 buildFingerprintTree 与
 * 落盘 fingerprint_json 比对——treeSha 或逐文件清单任一不一致（含新增/删除文件）即
 * 抛结构化 package_integrity_failed（调用方拒绝启动）。坏 JSON / 目录不可读同样 fail-closed。
 */
export function verifyPackageFingerprint(dirPath: string, expectedJson: string): void {
  let expected: { files?: Array<{ path: string, sha256: string }>, treeSha256?: string }
  try {
    expected = JSON.parse(expectedJson)
  } catch {
    throw integrityError(`包指纹清单损坏（fingerprint_json 不可解析），拒绝启动：${dirPath}`)
  }
  let actual: ReturnType<typeof buildFingerprintTree>
  try {
    actual = buildFingerprintTree(collectDirFiles(dirPath))
  } catch (e) {
    throw integrityError(`包目录不可读，拒绝启动：${dirPath}（${e instanceof Error ? e.message : String(e)}）`)
  }
  if (actual.treeSha256 !== expected.treeSha256) {
    // 逐文件差异定位（前 3 条人话细节；新增/删除/篡改均覆盖）
    const expMap = new Map((expected.files ?? []).map((f) => [f.path, f.sha256]))
    const actMap = new Map(actual.files.map((f) => [f.path, f.sha256]))
    const diffs: string[] = []
    for (const [p, h] of actMap) {
      if (!expMap.has(p)) diffs.push(`新增文件 ${p}`)
      else if (expMap.get(p) !== h) diffs.push(`内容变化 ${p}`)
      if (diffs.length >= 3) break
    }
    for (const p of expMap.keys()) {
      if (!actMap.has(p)) diffs.push(`文件缺失 ${p}`)
      if (diffs.length >= 3) break
    }
    throw integrityError(`包指纹重验失败（TOCTOU 检出），拒绝启动：${diffs.length > 0 ? diffs.join('；') : '全树哈希不一致'}`)
  }
}

/**
 * 包轨道 spawn 分流（D-02/D-03，T-29-04-06）：
 *  - runtime=python：包内嵌嵌入式 python.exe 绝对路径（python/python.exe → python.exe 双候选）
 *    + args=[entry 绝对路径]，envMode='plain'（env 仍走 buildChildEnv 白名单注入）；
 *    未内嵌即结构化拒绝（不静默换 PATH python——换运行时就不是校验过的包了）
 *  - runtime=node：command='node' + entry 绝对路径——沿用 resolveStdioCommand 的
 *    process.execPath + ELECTRON_RUN_AS_NODE 兜底（D-03 应用自带 node 运行时）
 */
export function resolvePackageSpawn(pkg: PackageSpawnInfo): StdioSpawnPlan {
  const entryAbs = join(pkg.dirPath, ...pkg.entry.replace(/\\/g, '/').split('/'))
  if (pkg.runtime === 'python') {
    const pyCandidates = ['python/python.exe', 'python.exe']
      .map((rel) => join(pkg.dirPath, ...rel.split('/')))
    const py = pyCandidates.find((p) => existsSync(p))
    if (!py) {
      throw {
        code: 'MCP_PYTHON_MISSING',
        reason: `python 轨道包内未找到内嵌嵌入式 Python（python/python.exe），拒绝启动：${pkg.dirPath}`
      }
    }
    return { command: py, args: [entryAbs], envMode: 'plain', fallback: null }
  }
  return resolveStdioCommand('node', [entryAbs])
}


/**
 * 握手期孤儿清理入口（CR-01）：connectStdio 从 spawn 到 connect 成败落定期间登记，
 * 使「握手挂起被超时/取消抢占」路径（此时 connections 里尚无该 key，closeConnection 原为空操作）
 * 也能 destroy transport 并树杀已 spawn 的子进程。
 */
const pendingStdioCleanups = new Map<string, () => Promise<void>>()

/** 取消接口：Map<testId, AbortController>（21-04 D-07 取消按钮复用） */
const testControllers = new Map<string, AbortController>()

// ---------------------------------------------------------------------------
// env 白名单构造（T-21-03-01/02 红线）
// ---------------------------------------------------------------------------

export type ChildEnvMode = 'plain' | 'electron-run-as-node'

/**
 * 显式白名单构造子进程 env：SAFE_BASE 逐键拷贝 + 用户 env 键值对（凭证值来自 _enc 解密）。
 * mode='electron-run-as-node' 显式置 ELECTRON_RUN_AS_NODE='1'，其余路径显式清除（防继承干扰）。
 * 零处 spread process.env；凭证零处进 args。
 */
export function buildChildEnv(userEnvPairs: Record<string, string>, mode: ChildEnvMode): Record<string, string> {
  const childEnv: Record<string, string> = {}
  for (const k of SAFE_BASE) {
    const v = process.env[k]
    if (v !== undefined) childEnv[k] = v
  }
  Object.assign(childEnv, userEnvPairs)
  if (mode === 'electron-run-as-node') childEnv.ELECTRON_RUN_AS_NODE = '1'
  else delete childEnv.ELECTRON_RUN_AS_NODE
  return childEnv
}

// ---------------------------------------------------------------------------
// stdio 三路径分流
// ---------------------------------------------------------------------------

export interface StdioSpawnPlan {
  command: string
  args: string[]
  envMode: ChildEnvMode
  /** 兜底重试预案（主路径 spawn ENOENT 时启用） */
  fallback: StdioSpawnPlan | null
}

function isAbsoluteLike(command: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(command) || command.startsWith('\\\\') || command.startsWith('/')
}

/**
 * 三路径分流：
 *  1. 绝对路径（含 .exe/.cmd 等）→ fs.existsSync 校验，缺失即结构化失败（不静默换路径）
 *  2. 命令名 node/npx → PATH 主路径（cross-spawn 解析 .cmd shim）
 *  3. 其余命令名 → PATH 主路径 + process.execPath + ELECTRON_RUN_AS_NODE='1' 兜底重试预案
 */
export function resolveStdioCommand(command: string, args: string[]): StdioSpawnPlan {
  if (isAbsoluteLike(command)) {
    // 用户自配绝对路径：仅 existsSync 校验直用，不提供兜底（换了路径就不是用户配的程序了）
    return { command, args, envMode: 'plain', fallback: null }
  }
  const lowered = command.toLowerCase()
  const primary: StdioSpawnPlan = { command, args, envMode: 'plain', fallback: null }
  if (lowered === 'node' || lowered === 'npx') {
    // node/npx 走 PATH 主路径；node 可兜底 electron.exe(ELECTRON_RUN_AS_NODE)（npx 是 cmd shim 不适用）
    if (lowered === 'node') {
      primary.fallback = { command: process.execPath, args, envMode: 'electron-run-as-node', fallback: null }
    }
    return primary
  }
  // 其余命令名：PATH 主路径失败（ENOENT）→ 兜底按 node 脚本跑（process.execPath 形态）
  primary.fallback = { command: process.execPath, args, envMode: 'electron-run-as-node', fallback: null }
  return primary
}

// ---------------------------------------------------------------------------
// 超时 / 取消基建
// ---------------------------------------------------------------------------

function structuredError(e: unknown, prefix: string): McpTestError {
  const err = e as { code?: string | number, errno?: string | number, status?: number, message?: string, reason?: string }
  // WR-01：超时/取消等自带人话 reason 的结构化错误（无 message 字段）原样透传——
  // 否则 String(e) 产出 "[object Object]"，精心构造的文案被丢弃
  if (err && typeof err.reason === 'string' && typeof err.message !== 'string') {
    return {
      code: typeof err.code === 'string' ? err.code : 'MCP_ERROR',
      reason: err.reason,
      errno: err.errno
    }
  }
  const rawMsg = err && typeof err.message === 'string' ? err.message : String(e)
  let reason: string
  const code = err && err.code
  if (code === 'ENOENT') {
    reason = `${prefix}：找不到可执行程序（ENOENT）——请检查命令名/路径是否正确`
  } else if (code === 'EACCES' || code === 'EPERM') {
    reason = `${prefix}：无权限执行该程序（${String(code)}）`
  } else if (typeof err?.status === 'number') {
    reason = `${prefix}：HTTP ${err.status}——${rawMsg}`
  } else {
    reason = `${prefix}：${rawMsg}`
  }
  return {
    code: typeof code === 'string' ? code : 'MCP_ERROR',
    reason,
    errno: err && (err.errno ?? (typeof code === 'string' || typeof code === 'number' ? code : undefined))
  }
}

function timeoutError(budgetMs: number, phase: string): McpTestError {
  return {
    code: 'MCP_TIMEOUT',
    reason: `${phase}超时（${Math.round(budgetMs / 1000)}s 预算耗尽）——已终止进程，请检查 server 是否卡死`
  }
}

/** Promise.race 硬超时 wrapper（T-21-03-05）；reject 带 timeout 标记，调用方统一 destroy+树杀 */
function withTimeout<T>(promise: Promise<T>, budgetMs: number, phase: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        const e = timeoutError(budgetMs, phase) as McpTestError & { timedOut?: boolean }
        e.timedOut = true
        reject(e)
      }, budgetMs).unref()
    })
  ])
}

// ---------------------------------------------------------------------------
// 连接建立 / 关闭
// ---------------------------------------------------------------------------

async function connectStdio(
  key: string,
  config: McpDecodedConfig,
  plan: StdioSpawnPlan
): Promise<{ client: Client, transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: plan.command,
    args: plan.args, // 29-04：包轨道 args 由 resolvePackageSpawn 装配（entry 绝对路径）；手工轨道与 config.args 同源
    env: buildChildEnv(config.env, plan.envMode),
    stderr: 'pipe'
  })
  const client = new Client({ name: 'network-toplogy', version: '1.4.0' }, { capabilities: {} })

  let registeredPid: number | null = null
  // CR-02：子进程退出（自然退出/被树杀）即注销登记并断开连接表条目——
  // 防 idle sweeper 对已被系统复用的陈旧 pid 下 taskkill 误杀无关进程。
  // 同 key 重连场景由 transport 同一性比对守卫（旧 transport 迟到的 close 不清新连接）。
  transport.onclose = () => {
    if (registeredPid !== null) McpProcessRegistry.unregister(registeredPid)
    const cur = connections.get(key)
    if (cur && cur.transport === transport) connections.delete(key)
  }

  // CR-01：spawn 成功但握手失败/挂起被抢占时，也必须 destroy transport + 树杀已 spawn 的子进程。
  // pid 必须在 close 前读（SDK close 会清空内部 _process 使 pid 变 null）；
  // killTree 先行（onclose 注销会使后续 killTree 查表不中而漏杀 npx 孙进程链）。
  const cleanupSpawned = async (): Promise<void> => {
    const pid = transport.pid
    connections.delete(key)
    if (pid !== null) {
      McpProcessRegistry.register(pid, key)
      McpProcessRegistry.killTree(pid)
    }
    try { await client.close() } catch { /* 关闭失败继续清理 */ }
    try { await transport.close() } catch { /* 同上 */ }
    try { await (transport as { destroy?: () => Promise<void> }).destroy?.() } catch { /* 同上 */ }
  }
  pendingStdioCleanups.set(key, cleanupSpawned)
  try {
    await client.connect(transport)
  } catch (e) {
    if (pendingStdioCleanups.get(key) === cleanupSpawned) pendingStdioCleanups.delete(key)
    await cleanupSpawned()
    throw e
  }
  pendingStdioCleanups.delete(key)
  // transport.pid 在 connect（spawn 完成）后可读——登记树杀面
  const pid = transport.pid
  registeredPid = pid
  if (pid !== null) McpProcessRegistry.register(pid, key)
  connections.set(key, { client, transport, pid, lastUsedAt: Date.now() })
  return { client, transport }
}

async function connectHttp(
  key: string,
  config: McpDecodedConfig
): Promise<{ client: Client, transport: Transport }> {
  // token 只进 Authorization header，URL 构造零处拼接凭证（T-21-03-03）
  // Bug A（生产实测）：存量脏 credential 带粘贴引入的 \t/\n/BOM 前后缀 → LocalProtocolError
  // Illegal header——构造前防御性 strip（存量数据自愈，不要求用户重输）
  const headers: Record<string, string> = {}
  const cleanCredential = (config.credential ?? '').replace(/^[\s\uFEFF\u00A0]+|[\s\uFEFF\u00A0]+$/g, '')
  if (cleanCredential) headers.Authorization = `Bearer ${cleanCredential}`

  // 主路径：Streamable HTTP
  // 24-04 Gap #2（分支 B）：SDK transport 收到 401 后会内部自行 GET /sse 探测 legacy 协议，
  // 最终以 405 形态 reject——首个 401 响应体被 SDK 吞掉，catch 面无从还原根因。
  // 注入只读响应的 fetch wrapper 记录首个 >=400 的 { status, bodyText }（不记录请求头，
  // Authorization 不落任何日志/错误文案——T-24-13），供 catch 面还原真实根因（401 优先于 405）。
  let firstHttpError: { status: number, bodyText: string } | null = null
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init)
    if (!firstHttpError && res.status >= 400) {
      let bodyText = ''
      try { bodyText = await res.clone().text() } catch { /* body 读取失败不阻断 */ }
      firstHttpError = { status: res.status, bodyText }
    }
    return res
  }
  const primaryTransport = new StreamableHTTPClientTransport(new URL(config.commandOrUrl), {
    requestInit: { headers },
    fetch: recordingFetch
  })
  const primaryClient = new Client({ name: 'network-toplogy', version: '1.4.0' }, { capabilities: {} })
  try {
    await primaryClient.connect(primaryTransport)
    connections.set(key, { client: primaryClient, transport: primaryTransport, pid: null, lastUsedAt: Date.now() })
    return { client: primaryClient, transport: primaryTransport }
  } catch (e) {
    // 24-04 Gap #2：首个 4xx 为 401 → 鉴权失败是真实根因，优先于面上 405 透出，
    // 不再走 SSE fallback（fallback 探测只会二次失败并掩盖根因）。
    // reason 只透出服务端返回的 error.message（服务端语义），零处内插本地 credential。
    // TS 控制流分析不跟踪闭包赋值（wrapper 在 connect 期间已写入）——读点显式断言还原宽类型
    const rec = firstHttpError as unknown as { status: number, bodyText: string } | null
    if (rec?.status === 401) {
      try { await primaryClient.close() } catch { /* 连接未成，close 失败忽略 */ }
      let srvMsg = ''
      try {
        const parsed = JSON.parse(rec.bodyText) as { error?: { message?: string } }
        srvMsg = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
      } catch { /* body 非 JSON 回退面上 message */ }
      const fallbackMsg = (e as { message?: string })?.message ?? 'HTTP 401'
      throw {
        code: 'MCP_HTTP_UNAUTHORIZED',
        reason: `HTTP 连接失败：鉴权失败（HTTP 401）——${srvMsg || fallbackMsg}，请检查 token/凭证是否正确`,
        errno: 401
      }
    }
    // SSE-only 旧对端显式 fallback（spike V-3）：仅 connect 期 404/405 类错误降级，
    // 运行期异常/凭证错误原样抛出；两层各建独立 Client
    const err = e as { code?: string, status?: number }
    const isNotStreamable =
      err?.code === 'CLIENT_HTTP_NOT_IMPLEMENTED' || err?.status === 404 || err?.status === 405
    if (!isNotStreamable) throw e
    try { await primaryClient.close() } catch { /* 主路径连接未成，close 失败忽略 */ }
    // SSE URL 推导用 URL 解析（21-04 修复）：URL 可能带 query 认证串（?key=xxx），
    // 字符串 endsWith('/sse') 判定会把 '/sse' 拼到 query 之后（…?key=xxx/sse → 401）。
    // 规则：pathname 已以 /sse 结尾 → 原样；否则去尾斜杠后补 /sse；query/hash 原样保留。
    const sseUrl = new URL(config.commandOrUrl)
    if (!sseUrl.pathname.endsWith('/sse')) {
      sseUrl.pathname = sseUrl.pathname.replace(/\/+$/, '') + '/sse'
    }
    const sseTransport = new SSEClientTransport(sseUrl, {
      requestInit: { headers }
    })
    const sseClient = new Client({ name: 'network-toplogy', version: '1.4.0' }, { capabilities: {} })
    await sseClient.connect(sseTransport)
    connections.set(key, { client: sseClient, transport: sseTransport, pid: null, lastUsedAt: Date.now() })
    return { client: sseClient, transport: sseTransport }
  }
}

/**
 * 关闭并树杀：killTree 先行 → client.close → transport.destroy（SSE 残留句柄顺序要求，spike V-3 附注）。
 * CR-01：连接尚未建立（握手挂起被超时/取消抢占）时走 pendingStdioCleanups 兜底清理，
 * 否则该路径原为空操作、已 spawn 的子进程泄露。
 * CR-02：killTree 必须先于 client.close——close 触发的 onclose 会即时注销 pid，
 * 顺序颠倒将使 killTree 查表不中而漏杀 npx→cmd→node 孙进程链。
 */
async function closeConnection(key: string): Promise<void> {
  const conn = connections.get(key)
  if (!conn) {
    const pending = pendingStdioCleanups.get(key)
    if (pending) {
      pendingStdioCleanups.delete(key)
      await pending()
    }
    return
  }
  connections.delete(key)
  if (conn.pid !== null) McpProcessRegistry.killTree(conn.pid)
  try { await conn.client.close() } catch { /* 关闭失败继续清理 */ }
  try { await (conn.transport as { destroy?: () => Promise<void> }).destroy?.() } catch { /* 同上 */ }
}

// ---------------------------------------------------------------------------
// listTools（cursor 循环取完，spike V-4）
// ---------------------------------------------------------------------------

async function listAllTools(client: Client): Promise<McpToolInfo[]> {
  let cursor: string | undefined
  const tools: McpToolInfo[] = []
  do {
    const res = await client.listTools(cursor !== undefined ? { cursor } : undefined)
    for (const t of res.tools) {
      tools.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: (t as { annotations?: unknown }).annotations
      })
    }
    cursor = res.nextCursor
  } while (cursor !== undefined)
  return tools
}

// ---------------------------------------------------------------------------
// 连接测试（测完即 close+树杀，不留连接）
// ---------------------------------------------------------------------------

/**
 * 连接测试统一入口（21-04 IPC 转发 onStage 进度事件）。
 * testId 由 IPC 层生成；取消走 cancelTest(testId)。
 */
export async function testConnection(
  testId: string,
  config: McpDecodedConfig,
  onStage?: StageCallback
): Promise<McpTestResult> {
  const controller = new AbortController()
  testControllers.set(testId, controller)
  const startedAt = Date.now()
  const stage = (s: McpStage) => { if (onStage) onStage(s, Date.now() - startedAt) }
  const key = `test:${testId}`

  const fail = async (e: unknown, prefix: string): Promise<{ ok: false, error: McpTestError }> => {
    await closeConnection(key)
    return { ok: false, error: structuredError(e, prefix) }
  }

  // 取消即时性（21-05 修复）：abort 信号参与整体 race——此前 signal 只在阶段间隙检查，
  // 卡死 server 场景下取消要等到 10s 硬超时才生效。race 被 abort 抢占后走 fail 清理路径
  // （closeConnection → killTree 树杀子进程），后台孤儿 work 由 p.catch 吞掉防 unhandled。
  const cancelErr = (): McpTestError => ({ code: 'MCP_CANCELLED', reason: '已由用户取消' })
  const onAbort = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(cancelErr())
    else controller.signal.addEventListener('abort', () => reject(cancelErr()), { once: true })
  })

  const work = async (): Promise<McpTestResult> => {
   try {
    stage('starting')
    const budget = config.type === 'stdio' ? TEST_STDIO_BUDGET_MS : TEST_HTTP_BUDGET_MS

    let client: Client
    if (config.type === 'stdio') {
      const plan = resolveStdioCommand(config.commandOrUrl, config.args)
      try {
        if (isAbsoluteLike(plan.command) && !existsSync(plan.command)) {
          return await fail(
            { code: 'MCP_CMD_NOT_FOUND', message: plan.command }, '启动本地程序失败'
          )
        }
        // 孤儿 connect 防 unhandled rejection：race 被超时/取消抢占后 connect 仍会迟到 reject
        const connectP = connectStdio(key, config, plan)
        connectP.catch(() => { /* 清理由 fail 路径经 pendingStdioCleanups 接管 */ })
        ;({ client } = await withTimeout(connectP, budget, 'stdio 连接（冷启动）'))
      } catch (e) {
        const err = e as { timedOut?: boolean, code?: string | number }
        if (err?.timedOut) {
          await closeConnection(key)
          return { ok: false, error: structuredError(e, 'stdio 连接（冷启动）') }
        }
        // 主路径 spawn 失败 → 兜底 process.execPath + ELECTRON_RUN_AS_NODE 重试一次。
        // 21-05 修正：Windows 下命令不存在时 transport close 事件先于 spawn error 到达，
        // connect 以 CONNECTION_CLOSED 拒绝（ENOENT 被 close 竞态吞掉）——同列兜底触发条件。
        // CR-01 补：已被取消/超时抢占时不再重试——此前取消杀掉主路径子进程会触发
        // CONNECTION_CLOSED，进而重 spawn 兜底子进程造成新的泄露
        if (
          !controller.signal.aborted && !err?.timedOut && plan.fallback &&
          (err?.code === 'ENOENT' || err?.code === 'EACCES' || err?.code === 'CONNECTION_CLOSED')
        ) {
          const fallbackP = connectStdio(key, config, plan.fallback)
          fallbackP.catch(() => { /* 同上：race 抢占后的孤儿 connect */ })
          ;({ client } = await withTimeout(fallbackP, budget, 'stdio 连接（ELECTRON_RUN_AS_NODE 兜底）'))
        } else {
          // 24-04 Gap #1 分诊：node 工具链命令（npx 无兜底；node/npm/nodemon 兜底也失败）
          // ENOENT / CONNECTION_CLOSED（Windows close 竞态吞 ENOENT，21-05 已知形态）时，
          // 最大可能是该机未安装 Node.js——针对性提示并保留底层错误（不吞细节）
          const err = e as { code?: string | number, message?: string, errno?: string | number }
          const cmdLowered = config.commandOrUrl.toLowerCase()
          if (
            NODE_TOOLCHAIN_COMMANDS.includes(cmdLowered) &&
            (err?.code === 'ENOENT' || err?.code === 'CONNECTION_CLOSED')
          ) {
            const rawMsg = typeof err?.message === 'string' ? err.message : String(e)
            return await fail({
              code: 'MCP_NODE_MISSING',
              reason: `stdio 连接失败：命令 \`${config.commandOrUrl}\` 不存在，该机可能未安装 Node.js——请安装 Node.js 后重试（原始错误：${rawMsg}${err?.code ? ` / ${String(err.code)}` : ''}）`,
              errno: err?.errno ?? (typeof err?.code === 'string' || typeof err?.code === 'number' ? err.code : undefined)
            }, 'stdio 连接失败')
          }
          return await fail(e, 'stdio 连接失败')
        }
      }
    } else {
      try {
        ;({ client } = await withTimeout(connectHttp(key, config), budget, 'HTTP 连接'))
      } catch (e) {
        return await fail(e, 'HTTP 连接失败')
      }
    }
    if (controller.signal.aborted) return await fail(cancelErr(), '已取消')

    stage('handshake')
    stage('listing')
    let tools: McpToolInfo[]
    try {
      tools = await withTimeout(listAllTools(client), RPC_TOLISTOOLS_MS, '列出工具')
    } catch (e) {
      return await fail(e, '列出工具失败')
    }
    if (controller.signal.aborted) return await fail(cancelErr(), '已取消')

    const protocolVersion = client.getNegotiatedProtocolVersion() // spike A1 修正：非 getProtocolVersion
    // 连接测试测完即杀——不留连接（T-21-03-04：不持长寿命子进程）
    await closeConnection(key)
    testControllers.delete(testId)
    return { ok: true, protocolVersion, tools }
  } catch (e) {
    return await fail(e, '连接测试失败')
  }
  }

  try {
    const p = work()
    p.catch(() => { /* race 被 abort 抢占后的孤儿 work——清理已由 fail 路径接管 */ })
    return await Promise.race([p, onAbort])
  } catch (e) {
    return await fail(e, '连接测试已取消')
  } finally {
    testControllers.delete(testId)
  }
}

/**
 * 取消进行中的连接测试：abort 对应 controller，触发 testConnection 内既有
 * destroy + killTree 清理路径并从 Map 移除（统一形态，21-04 对齐）。
 */
export function cancelTest(testId: string): boolean {
  const controller = testControllers.get(testId)
  if (!controller) return false
  controller.abort()
  testControllers.delete(testId)
  return true
}

// ---------------------------------------------------------------------------
// 长连接（懒建 + 空闲回收，Phase 22 消费）
// ---------------------------------------------------------------------------

/** 懒建/复用长连接（key=`${configId}:${deviceId}` 复合键，D-15/D-18）；不存在则按 config 建立 */
export async function getConnection(configId: string, config: McpDecodedConfig, opts?: McpConnectionOpts): Promise<Client> {
  const key = connectionKey(configId, opts?.deviceId)
  const existing = connections.get(key)
  if (existing) {
    existing.lastUsedAt = Date.now()
    if (existing.pid !== null) McpProcessRegistry.markUsed(existing.pid)
    return existing.client
  }
  if (config.type === 'stdio') {
    let plan: StdioSpawnPlan
    if (opts?.package) {
      // TOCTOU 全树重验（D-26/D-27）：不一致拒绝启动 + integrityHandler 副作用（包 disabled + security 日志，
      // 由 main.ts 注入 service 落库——mcpClient 零 DB 依赖）；handler 故障不吞主线错误（安全语义不降级）
      try {
        verifyPackageFingerprint(opts.package.dirPath, opts.package.fingerprintJson)
      } catch (e) {
        if ((e as { code?: string })?.code === 'package_integrity_failed') {
          try {
            integrityHandler?.({
              packageId: opts.package.packageId,
              dirPath: opts.package.dirPath,
              detail: (e as { reason?: string }).reason ?? 'package_integrity_failed'
            })
          } catch { /* handler 故障不吞 TOCTOU 主错误 */ }
        }
        throw e
      }
      plan = resolvePackageSpawn(opts.package)
    } else {
      plan = resolveStdioCommand(config.commandOrUrl, config.args)
    }
    const { client } = await connectStdio(key, config, plan)
    return client
  }
  const { client } = await connectHttp(key, config)
  return client
}

/** callTool 硬超时包装（Phase 22 主消费；29-04 复合键 + 设备级实例透传） */
export async function callToolWithTimeout(
  configId: string,
  config: McpDecodedConfig,
  name: string,
  args: Record<string, unknown>,
  opts?: McpConnectionOpts
): Promise<unknown> {
  const key = connectionKey(configId, opts?.deviceId)
  const client = await getConnection(configId, config, opts)
  const conn = connections.get(key)
  if (conn) {
    conn.lastUsedAt = Date.now()
    if (conn.pid !== null) McpProcessRegistry.markUsed(conn.pid)
  }
  try {
    return await withTimeout(client.callTool({ name, arguments: args }), RPC_CALLTOOL_MS, '工具调用')
  } catch (e) {
    if ((e as { timedOut?: boolean })?.timedOut) {
      // 超时硬清理：destroy + 树杀，不留半死连接
      await closeConnection(key)
    }
    throw e
  }
}

export async function closeMcpConnection(configId: string, deviceId?: string): Promise<void> {
  await closeConnection(connectionKey(configId, deviceId))
}

// 空闲回收 sweep：Registry 自持登记表，定时器归连接器（裁决见文件头注）。
// unref() 防阻 Electron 退出（退出前另有 before-quit cleanupAll 兜底）。
const idleSweeper = setInterval(() => {
  for (const info of McpProcessRegistry.listIdleInfo()) {
    if (info.idleMs >= IDLE_TIMEOUT_MS) {
      void closeConnection(info.configId)
    }
  }
  // http 长连接（无 pid）按连接表 lastUsedAt 回收
  for (const [key, conn] of Array.from(connections.entries())) {
    if (conn.pid === null && Date.now() - conn.lastUsedAt >= IDLE_TIMEOUT_MS) {
      void closeConnection(key)
    }
  }
}, 60 * 1000)
idleSweeper.unref()

/** @internal 测试专用 */
export function _activeConnectionKeys(): string[] {
  return Array.from(connections.keys())
}
