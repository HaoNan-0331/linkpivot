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
import { existsSync } from 'fs'
import { McpProcessRegistry } from './mcpProcessRegistry'
import type { McpDecodedConfig } from './mcpService'

/** env 白名单（21-RESEARCH Pattern 3）——显式拷贝，禁止 spread process.env */
const SAFE_BASE = ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'USERPROFILE', 'LANG']

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

/** 连接级 Map：key = configId 或 tempKey（连接测试临时键）——不进 sessions/windowSessionMap */
const connections = new Map<string, ActiveConnection>()

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
  const err = e as { code?: string | number, errno?: string | number, status?: number, message?: string }
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
    args: config.args,
    env: buildChildEnv(config.env, plan.envMode),
    stderr: 'pipe'
  })
  const client = new Client({ name: 'network-toplogy', version: '1.4.0' }, { capabilities: {} })
  await client.connect(transport)
  // transport.pid 在 connect（spawn 完成）后可读——登记树杀面
  const pid = transport.pid
  if (pid !== null) McpProcessRegistry.register(pid, key)
  connections.set(key, { client, transport, pid, lastUsedAt: Date.now() })
  return { client, transport }
}

async function connectHttp(
  key: string,
  config: McpDecodedConfig
): Promise<{ client: Client, transport: Transport }> {
  // token 只进 Authorization header，URL 构造零处拼接凭证（T-21-03-03）
  const headers: Record<string, string> = {}
  if (config.credential) headers.Authorization = `Bearer ${config.credential}`

  // 主路径：Streamable HTTP
  const primaryTransport = new StreamableHTTPClientTransport(new URL(config.commandOrUrl), {
    requestInit: { headers }
  })
  const primaryClient = new Client({ name: 'network-toplogy', version: '1.4.0' }, { capabilities: {} })
  try {
    await primaryClient.connect(primaryTransport)
    connections.set(key, { client: primaryClient, transport: primaryTransport, pid: null, lastUsedAt: Date.now() })
    return { client: primaryClient, transport: primaryTransport }
  } catch (e) {
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

/** 关闭并树杀：client.close → transport.destroy → killTree（SSE 残留句柄顺序要求，spike V-3 附注） */
async function closeConnection(key: string): Promise<void> {
  const conn = connections.get(key)
  if (!conn) return
  connections.delete(key)
  try { await conn.client.close() } catch { /* 关闭失败继续清理 */ }
  try { await (conn.transport as { destroy?: () => Promise<void> }).destroy?.() } catch { /* 同上 */ }
  if (conn.pid !== null) McpProcessRegistry.killTree(conn.pid)
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
        ;({ client } = await withTimeout(
          connectStdio(key, config, plan),
          budget,
          'stdio 连接（冷启动）'
        ))
      } catch (e) {
        const err = e as { timedOut?: boolean, code?: string | number }
        if (err?.timedOut) {
          await closeConnection(key)
          return { ok: false, error: structuredError(e, 'stdio 连接（冷启动）') }
        }
        // 主路径 spawn 失败（ENOENT 等）→ 兜底 process.execPath + ELECTRON_RUN_AS_NODE 重试一次
        if (plan.fallback && (err?.code === 'ENOENT' || err?.code === 'EACCES')) {
          ;({ client } = await withTimeout(
            connectStdio(key, config, plan.fallback),
            budget,
            'stdio 连接（ELECTRON_RUN_AS_NODE 兜底）'
          ))
        } else {
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
    if (controller.signal.aborted) return await fail({ code: 'MCP_CANCELLED' }, '已取消')

    stage('handshake')
    stage('listing')
    let tools: McpToolInfo[]
    try {
      tools = await withTimeout(listAllTools(client), RPC_TOLISTOOLS_MS, '列出工具')
    } catch (e) {
      return await fail(e, '列出工具失败')
    }
    if (controller.signal.aborted) return await fail({ code: 'MCP_CANCELLED' }, '已取消')

    const protocolVersion = client.getNegotiatedProtocolVersion() // spike A1 修正：非 getProtocolVersion
    // 连接测试测完即杀——不留连接（T-21-03-04：不持长寿命子进程）
    await closeConnection(key)
    testControllers.delete(testId)
    return { ok: true, protocolVersion, tools }
  } catch (e) {
    return await fail(e, '连接测试失败')
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

/** 懒建/复用长连接（key=configId）；不存在则按 config 建立 */
export async function getConnection(configId: string, config: McpDecodedConfig): Promise<Client> {
  const existing = connections.get(configId)
  if (existing) {
    existing.lastUsedAt = Date.now()
    if (existing.pid !== null) McpProcessRegistry.markUsed(existing.pid)
    return existing.client
  }
  if (config.type === 'stdio') {
    const plan = resolveStdioCommand(config.commandOrUrl, config.args)
    const { client } = await connectStdio(configId, config, plan)
    return client
  }
  const { client } = await connectHttp(configId, config)
  return client
}

/** callTool 硬超时包装（Phase 22 主消费；结果双兼容解析归 22 落） */
export async function callToolWithTimeout(
  configId: string,
  config: McpDecodedConfig,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const client = await getConnection(configId, config)
  const conn = connections.get(configId)
  if (conn) {
    conn.lastUsedAt = Date.now()
    if (conn.pid !== null) McpProcessRegistry.markUsed(conn.pid)
  }
  try {
    return await withTimeout(client.callTool({ name, arguments: args }), RPC_CALLTOOL_MS, '工具调用')
  } catch (e) {
    if ((e as { timedOut?: boolean })?.timedOut) {
      // 超时硬清理：destroy + 树杀，不留半死连接
      await closeConnection(configId)
    }
    throw e
  }
}

export async function closeMcpConnection(configId: string): Promise<void> {
  await closeConnection(configId)
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
