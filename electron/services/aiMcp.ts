/**
 * aiMcp —— MCP 上下文装配 + 工具调用编排域。
 *
 * Phase 32（D-01 / D-05）：机械搬移自 ai.ts 原 MCP 域（拆分前原始行号 :852-1114），
 * 函数体逐字零改动，保持源函数形态（不转静态类）。
 *
 * 域职责：buildMcpContexts 装配选中设备的 MCP 注入上下文（含 29-04 设备级 env 解密）、
 * parseMcpToolCalls fail-closed 解析 [MCP_TOOL_CALL] 标记、runMcpCall 单次工具调用执行
 * （60s 硬超时 + 审计 + tool_result 载荷下发）。
 * 依赖方向：ToolResultPayload 契约被 aiChat / aiAgentLoop 消费——本模块先于两者就位是
 * D-06 P2 排序依据；AgentStep 以 import type 过渡引用 './ai'（agent 段 Phase 32 P3 搬至
 * aiAgent* 后改向，type-only 编译后擦除，零运行时环）。
 * MK 形态：模块级 let MK + setAiMcpMasterKey 启动注入（buildMcpContexts 设备级
 * env_json_enc 解密消费），由 ai.ts setAiMasterKey 链式调用（Shared Pattern 2）。
 */

import { getDatabase } from '../database/connection'
import { decField } from '../utils/crypto'
import { sanitizeUntrusted } from './untrustedText'
import { McpToolPolicy, type McpToolCacheRow } from './mcpToolPolicy'
import { McpService } from './mcpService'
import { callToolWithTimeout, type PackageSpawnInfo } from './mcpClient'
import type { EnvMetaEntry } from './mcpPackageValidator'
import { sanitizeEnvMeta } from './mcpPackageValidator'
import { McpPackageSwapGuard, packageSwappingError } from './mcpPackageSwapGuard'
import { updateLogStatus, appendLogAiResponse } from './aiExecLogger'
import type { AgentStep } from './ai'

let MK = ''
export function setAiMcpMasterKey(key: string) {
  MK = key
}

// ---------- Phase 22（22-03）MCP 工具链（MCS-01~05） ----------

/** tool_result 下发契约（D-03 数据源，22-05 ToolResultCard 唯一数据来源） */
export interface ToolResultPayload {
  type: 'tool_result'
  server: string
  tool: string
  deviceName: string
  argsJson: string
  resultJson: string
  status: 'success' | 'failed' | 'timeout'
  errorText?: string
  /** Phase 28（28-05，D-08 步骤级推送）：agent 步骤扩展字段——在场时 renderer 按步骤卡状态机
   *  以 stepIndex 定位更新；旧 MCP payload 无新字段自然降级（追加式）。 */
  stepIndex?: number
  actionType?: AgentStep['actionType']
  stepStatus?: AgentStep['status']
  /** 28-06 R6 增强 a：预取步骤卡标志（renderer 折叠态动作描述加「[预取]」前缀） */
  prefetched?: boolean
  /** Phase 31（31-02，FIX-02 D-01）：归属会话标识——在场时 renderer 按当前显示会话
   *  过滤步骤卡；旧 renderer 校验链只认基础字段，天然兼容。 */
  sessionId?: string
}

/** 选中设备的 MCP 上下文（注入 + 执行白名单判定用） */
export interface McpCallContext {
  configId: number
  serverName: string
  device: any
  tools: McpToolCacheRow[]
  skipConfirmSet: Set<string>
  /** 被禁工具名清单（22-05 裁决：注入提示词让 AI 知情 + 禁止令，无禁用为空数组） */
  disabledTools: string[]
  /** 29-04（D-15）：该设备 rel 行解密出的设备级 env 组（spawn 时注入子进程，互不串线） */
  deviceEnv: Record<string, string>
  /** 29-04：包创建配置的包 id（非包配置 null——spawn 走 TOCTOU 重验 + 包轨道） */
  packageId: number | null
}

/** 解析后的合法工具调用（server/tool 已对照注入清单白名单校验） */
export interface ValidMcpCall {
  context: McpCallContext
  tool: McpToolCacheRow
  args: Record<string, unknown>
  argsJson: string
}

/**
 * 构造选中设备的 MCP 注入上下文（设备 ↔ 配置一对多绑定，mcp_device_rel.device_id UNIQUE）。
 * 单条查询失败/配置禁用/无启用工具 → 该设备跳过（fail-closed，不阻塞对话）。
 */
export function buildMcpContexts(targetDevices: any[]): McpCallContext[] {
  const contexts: McpCallContext[] = []
  for (const dev of targetDevices) {
    try {
      const rel = getDatabase()
        .prepare(
          `SELECT r.mcp_config_id AS id, c.name AS name, c.enabled AS enabled,
                  r.env_json_enc AS envEnc, c.package_id AS packageId, p.disabled AS pkgDisabled
           FROM mcp_device_rel r
           JOIN mcp_configs c ON c.id = r.mcp_config_id
           LEFT JOIN mcp_packages p ON p.id = c.package_id
           WHERE r.device_id = ?`
        )
        .get(dev.id) as { id: number; name: string; enabled: number; envEnc: string | null; packageId: number | null; pkgDisabled: number | null } | undefined
      if (!rel || !rel.enabled) continue
      // D-26：TOCTOU 检出/管理侧禁用的包整体 fail-closed 跳过（重新导入校验后恢复）
      if (rel.pkgDisabled) continue
      // 29-04（D-15）：设备级 env 解密（只从该设备 rel 行，互不串线；坏密文降级空组）
      let deviceEnv: Record<string, string> = {}
      const decEnv = decField(rel.envEnc, MK)
      if (decEnv) {
        try {
          const parsed = JSON.parse(decEnv)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deviceEnv = parsed as Record<string, string>
        } catch { /* 坏 JSON 降级空 env */ }
      }
      const tools = McpToolPolicy.getEnabledTools(rel.id)
      if (tools.length === 0) continue
      contexts.push({
        configId: rel.id,
        serverName: rel.name,
        device: dev,
        tools,
        skipConfirmSet: McpToolPolicy.getSkipConfirmTools(rel.id),
        disabledTools: McpToolPolicy.getDisabledToolNames(rel.id),
        deviceEnv,
        packageId: rel.packageId ?? null,
      })
    } catch (err) {
      console.warn('[ai.chat] MCP context build failed, skip device:', (err as Error).message)
    }
  }
  return contexts
}

/**
 * 29-04 + 29.1 CR MD-05：装配包轨道 spawn 信息（TOCTOU 重验 + python/node 双轨的 mcpClient 入参）。
 * 包不存在/disabled/查询异常 → null（调用方 fail-closed 拒绝执行，不给旧 spawn 路径）。
 * envMeta 单源 manifest_json（与 rowToView / testPackageConfig 同源——env_meta 列 29.1 MD-05
 * 起降级为仅写入镜像，任何强制层不再读取，杜绝「表单校验用的 meta」与「spawn 强制用的 meta」
 * 双源静默分叉）；消费前经 sanitizeEnvMeta 同构结构清洗（防 DB 篡改值直接进 spawn 合并）。
 * manifest_json 坏 JSON → null：required 硬拦在强制层静默消失属 fail-open，宁可拒绝装配。
 * （导出供单测直测装配源语义——29.1 CR MD-05 单源收敛的回归锚点。）
 */
export function loadPackageSpawnInfo(packageId: number): PackageSpawnInfo | null {
  // MD-02（29.1 CR）：换盘窗口守卫——抛可重试结构化错误（runMcpCall catch 透出 reason），
  // 不走后续装配/重验（getConnection 侧同款守卫双覆盖）
  if (McpPackageSwapGuard.isSwapping(packageId)) {
    throw packageSwappingError()
  }
  try {
    const row = getDatabase().prepare(
      'SELECT dir_path, runtime, entry, fingerprint_json, manifest_json, disabled FROM mcp_packages WHERE id = ?'
    ).get(packageId) as { dir_path: string; runtime: 'node' | 'python'; entry: string; fingerprint_json: string | null; manifest_json: string | null; disabled: number } | undefined
    if (!row || row.disabled) return null
    let envMeta: Record<string, EnvMetaEntry> | undefined
    try {
      const manifest = JSON.parse(row.manifest_json ?? '') as { envMeta?: unknown } | null
      envMeta = sanitizeEnvMeta(manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest.envMeta : undefined)
    } catch {
      return null // 坏 JSON fail-closed（见方法注）
    }
    return {
      packageId,
      dirPath: row.dir_path,
      runtime: row.runtime,
      entry: row.entry,
      fingerprintJson: row.fingerprint_json ?? '',
      envMeta,
    }
  } catch {
    return null
  }
}

/**
 * 解析 AI 回复中的 [MCP_TOOL_CALL] 标记（fail-closed，T-22-09）：
 * 逐字段 unknown 校验（server/tool string、args object）+ 工具名必须在注入清单白名单内
 * （防捏造）。畸形载荷不入执行，由调用方走对话兜底。
 */
export function parseMcpToolCalls(
  reply: string,
  contexts: McpCallContext[]
): { valid: ValidMcpCall[]; hadMarker: boolean; malformed: boolean } {
  const hadMarker = reply.includes('[MCP_TOOL_CALL]')
  if (!hadMarker) return { valid: [], hadMarker: false, malformed: false }
  const valid: ValidMcpCall[] = []
  // Phase 23（用户规划裁决）：畸形分诊——载荷非 JSON/缺字段/类型错 → malformed=true
  // （触发格式纠正回注重试）；合法 JSON 但工具不在清单 → malformed=false（走 22 期管控文案）
  let malformed = false
  let totalMarkers = 0
  const markerRe = /\[MCP_TOOL_CALL\]/g
  while (markerRe.exec(reply) !== null) totalMarkers++
  let matchedMarkers = 0
  const re = /\[MCP_TOOL_CALL\]\s*(\{[^\n]*\})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(reply)) !== null) {
    matchedMarkers++
    try {
      const parsed: unknown = JSON.parse(m[1])
      if (typeof parsed !== 'object' || parsed === null) {
        malformed = true
        continue
      }
      const { server, tool, args } = parsed as Record<string, unknown>
      if (typeof server !== 'string' || typeof tool !== 'string') {
        malformed = true
        continue
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        malformed = true
        continue
      }
      const ctx = contexts.find((c) => c.serverName === server)
      if (!ctx) continue // 合法 JSON，server 不在清单 → 管控语义，非畸形
      const toolRow = ctx.tools.find((t) => t.name === tool)
      if (!toolRow) continue // 合法 JSON，工具不在白名单 → 管控语义，非畸形
      valid.push({ context: ctx, tool: toolRow, args: args as Record<string, unknown>, argsJson: JSON.stringify(args) })
    } catch {
      // 畸形 JSON：跳过该标记（fail-closed 不入执行）→ 纠格分诊
      malformed = true
    }
  }
  // 存在无 JSON 载荷的标记（自然语言载荷等）→ 畸形
  if (matchedMarkers < totalMarkers) malformed = true
  return { valid, hadMarker, malformed }
}

/** 审计参数/结果摘要截断上限（truncate 先于加密，T-22-11/T-22-13） */
export const MCP_LOG_PARAM_MAX = 2000
const MCP_LOG_RESULT_MAX = 4000

/**
 * 执行单次 MCP 工具调用（main 内直调 callToolWithTimeout，60s 硬超时 + 树杀复用 Phase 21）。
 * 三分支（success/failed/timeout）均：审计 status 更新 + tool_result 载荷下发（D-03）。
 * 返回回注用文本（结果/错误均经 sanitizeUntrusted 清洗）。
 */
export async function runMcpCall(
  call: ValidMcpCall,
  logId: string,
  emitToolResult?: (p: ToolResultPayload) => void,
  /** Phase 31（31-02，FIX-02 D-01）：归属会话标识——直执传 ctx.sessionId，确认续跑
   *  传挂起批次携带的 loopCtx.sessionId（T-31-05：确认分支不能丢，否则步骤卡被错归因过滤） */
  sessionId?: string | null
): Promise<{ status: ToolResultPayload['status']; text: string }> {
  const deviceName = String(call.context.device?.name ?? '')
  const config = McpService.decodeForTest(call.context.configId)
  let status: ToolResultPayload['status'] = 'success'
  let resultJson = ''
  let errorText: string | undefined
  try {
    if (!config) throw new Error('MCP 配置不存在或已被删除')
    // 29-04（D-15）：设备级 env 组覆盖进 spawn env（只从该设备 rel 行解密注入）+
    // 复合键 configId:deviceId（同配置多设备多实例互不串线，D-18）。
    config.env = { ...config.env, ...call.context.deviceEnv }
    let pkgInfo: PackageSpawnInfo | undefined
    if (call.context.packageId != null) {
      const info = loadPackageSpawnInfo(call.context.packageId)
      if (!info) throw new Error('MCP 包已被禁用或已删除（TOCTOU 检出后需重新导入校验）')
      pkgInfo = info
    }
    const result: unknown = await callToolWithTimeout(
      String(call.context.configId), config, call.tool.name, call.args,
      { deviceId: String(call.context.device?.id ?? ''), package: pkgInfo }
    )
    resultJson = sanitizeUntrusted(JSON.stringify(result ?? null), 4000)
    updateLogStatus(logId, 'executed')
  } catch (err: any) {
    const timedOut = !!(err as { timedOut?: boolean })?.timedOut
    status = timedOut ? 'timeout' : 'failed'
    // 29.1-04：spawn 侧结构化错误（MCP_ENV_REQUIRED_MISSING / package_integrity_failed 等
    // plain object 无 message）优先透出 reason——否则 String(err) 产出 "[object Object]"，
    // 「XX 未配置，请到设备环境变量补填」等可操作文案被丢弃
    errorText = timedOut ? `工具调用超时（60s 硬超时，连接已被强制回收）` : `执行失败: ${typeof err?.reason === 'string' ? err.reason : (err?.message ?? String(err))}`
    updateLogStatus(logId, 'failed')
  }
  // 审计结果摘要（截断先于加密，createLog/appendLogAiResponse 内部走 encField）
  appendLogAiResponse(logId, sanitizeUntrusted(call.argsJson, MCP_LOG_PARAM_MAX), sanitizeUntrusted(resultJson || errorText || '', MCP_LOG_RESULT_MAX))
  emitToolResult?.({
    type: 'tool_result',
    server: call.context.serverName,
    tool: call.tool.name,
    deviceName,
    argsJson: call.argsJson,
    resultJson,
    status,
    errorText,
    // Phase 31（31-02，FIX-02 D-01）：MCP 工具卡载荷携带发起会话标识（缺失自然降级）
    ...(sessionId ? { sessionId } : {}),
  })
  return { status, text: `工具 ${call.context.serverName} · ${call.tool.name}\n状态: ${status}\n${resultJson || errorText || ''}` }
}
