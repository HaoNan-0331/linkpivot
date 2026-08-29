/**
 * aiAgentState —— agent 循环参数与状态构造域。
 *
 * Phase 32（D-01 / D-02 / D-05）：机械搬移自 ai.ts agent 段（拆分前原始行号 :1115-1298 与
 * :1381-1412——后者 McpLoopCtx/McpLoopState/McpLoopResult 循环上下文类型因
 * AgentLoopState extends McpLoopState 同文件最内聚而随迁本文件），函数体逐字零改动，
 * 保持源函数形态（不转静态类）。
 *
 * 域职责（D-02 概念三分之「状态管理 + 四重硬顶参数」）：agent 循环四重硬顶参数
 * （maxRounds/burnout/cooldown 三参数 get/set + token 预算常量）、AgentLoopState/
 * McpLoopCtx 循环状态与上下文类型、createAgentLoopState 状态构造。
 * 依赖方向：agent 域叶子（运行时零 ai 域内依赖——McpLoopCtx 结构引用的
 * McpCallContext/ToolResultPayload/ExecMode/AgentTier 均为 import type，编译后擦除）；
 * 被 aiAgentLoop / ai.ts chat 段（值）与 aiMcp / aiPayload（类型）单向引用。
 * 三参数 get/set 保持 agentDbGetter 直调现状（CONTEXT 裁决：三参数读写 ai_config 表
 * 但归 agent 域，与 aiConfig 域直调 getDatabase() 并存是现状——机械搬移不统一 dbGetter）。
 */

import { getDatabase } from '../database/connection'
import type { ExecMode } from './aiConfig'
import type { McpCallContext, ToolResultPayload } from './aiMcp'
import type { AgentTier } from './agentRouter'

/**
 * 28-06 缺陷④（用户需求）：mcp_max_rounds 子限全链路退役——MCP 连续调用不再受
 * 「子限 mcp_max_rounds（默认 5）」钳制，MCP 步骤本就入 state.steps，统一受
 * agent_max_rounds 步数硬顶约束（D-13 诚实收尾路径不变）。DB 列 ai_config.mcp_max_rounds
 * 保留不清除不迁移（向后兼容红线，只是不再读）；getMcpMaxRounds/setMcpMaxRounds 及
 * mcpRoundLimitPrompt、设置页 McpRoundsInput、IPC/preload 暴露一并退役。
 *
 * Phase 28（AGENT-04，D-04）：agent 循环硬顶三参数——步数上限/熔断次数/冷却时长。
 * token 预算为内部硬顶（28-03）不暴露设置页。三参数照 mcp_max_rounds 同款
 * get（fail-safe 回退默认）/set（非法拒绝落库显式回错）模式。
 * DB getter 经 _setAiDbGetter 注入（测试解耦，aiExecLogger 先例），生产默认 getDatabase。
 */
export const DEFAULT_AGENT_MAX_ROUNDS = 12
export const AGENT_MAX_ROUNDS_UPPER_BOUND = 30
export const DEFAULT_AGENT_BURNOUT_COUNT = 2
export const AGENT_BURNOUT_COUNT_UPPER_BOUND = 5
export const DEFAULT_AGENT_COOLDOWN_SECS = 60
export const AGENT_COOLDOWN_SECS_LOWER_BOUND = 10
export const AGENT_COOLDOWN_SECS_UPPER_BOUND = 600

let agentDbGetter: () => ReturnType<typeof getDatabase> = getDatabase

/** 测试注入口：内存库替换生产单例（仅 agent 三参数 get/set 使用，不影响其余 ai.ts 读库路径） */
export function _setAiDbGetter(getter: () => ReturnType<typeof getDatabase>): void {
  agentDbGetter = getter
}

/** 读 ai_config.agent_max_rounds；NULL/非整数/<1/>30（含列缺失异常）一律回退 12（fail-safe） */
export function getAgentMaxRounds(): number {
  try {
    const row = agentDbGetter()
      .prepare('SELECT agent_max_rounds FROM ai_config LIMIT 1')
      .get() as { agent_max_rounds?: number | null } | undefined
    const v = Number(row?.agent_max_rounds)
    if (!Number.isInteger(v) || v < 1 || v > AGENT_MAX_ROUNDS_UPPER_BOUND) {
      return DEFAULT_AGENT_MAX_ROUNDS
    }
    return v
  } catch {
    return DEFAULT_AGENT_MAX_ROUNDS
  }
}

/** 设置页写入口：仅收纳 1-30 整数，非法值拒绝落库（不静默钳制，错误显式回传 UI） */
export function setAgentMaxRounds(rounds: number): { success: boolean; error?: string } {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > AGENT_MAX_ROUNDS_UPPER_BOUND) {
    return { success: false, error: `Agent 步数上限必须在 1-${AGENT_MAX_ROUNDS_UPPER_BOUND} 之间` }
  }
  agentDbGetter().prepare('UPDATE ai_config SET agent_max_rounds = ?').run(rounds)
  return { success: true }
}

/** 读 ai_config.agent_burnout_count；NULL/非整数/<1/>5（含列缺失异常）一律回退 2（fail-safe） */
export function getAgentBurnoutCount(): number {
  try {
    const row = agentDbGetter()
      .prepare('SELECT agent_burnout_count FROM ai_config LIMIT 1')
      .get() as { agent_burnout_count?: number | null } | undefined
    const v = Number(row?.agent_burnout_count)
    if (!Number.isInteger(v) || v < 1 || v > AGENT_BURNOUT_COUNT_UPPER_BOUND) {
      return DEFAULT_AGENT_BURNOUT_COUNT
    }
    return v
  } catch {
    return DEFAULT_AGENT_BURNOUT_COUNT
  }
}

/** 设置页写入口：仅收纳 1-5 整数，非法值拒绝落库 */
export function setAgentBurnoutCount(count: number): { success: boolean; error?: string } {
  if (!Number.isInteger(count) || count < 1 || count > AGENT_BURNOUT_COUNT_UPPER_BOUND) {
    return { success: false, error: `Agent 熔断次数必须在 1-${AGENT_BURNOUT_COUNT_UPPER_BOUND} 之间` }
  }
  agentDbGetter().prepare('UPDATE ai_config SET agent_burnout_count = ?').run(count)
  return { success: true }
}

/** 读 ai_config.agent_cooldown_secs；NULL/非整数/<10/>600（含列缺失异常）一律回退 60（fail-safe） */
export function getAgentCooldownSecs(): number {
  try {
    const row = agentDbGetter()
      .prepare('SELECT agent_cooldown_secs FROM ai_config LIMIT 1')
      .get() as { agent_cooldown_secs?: number | null } | undefined
    const v = Number(row?.agent_cooldown_secs)
    if (!Number.isInteger(v) || v < AGENT_COOLDOWN_SECS_LOWER_BOUND || v > AGENT_COOLDOWN_SECS_UPPER_BOUND) {
      return DEFAULT_AGENT_COOLDOWN_SECS
    }
    return v
  } catch {
    return DEFAULT_AGENT_COOLDOWN_SECS
  }
}

/** 设置页写入口：仅收纳 10-600 整数，非法值拒绝落库 */
export function setAgentCooldownSecs(secs: number): { success: boolean; error?: string } {
  if (!Number.isInteger(secs) || secs < AGENT_COOLDOWN_SECS_LOWER_BOUND || secs > AGENT_COOLDOWN_SECS_UPPER_BOUND) {
    return { success: false, error: `Agent 冷却时长必须在 ${AGENT_COOLDOWN_SECS_LOWER_BOUND}-${AGENT_COOLDOWN_SECS_UPPER_BOUND} 秒之间` }
  }
  agentDbGetter().prepare('UPDATE ai_config SET agent_cooldown_secs = ?').run(secs)
  return { success: true }
}

// ---------- Phase 28（AGENT-04/06，28-03）：AgentLoopState 循环状态对象 ----------

/** agent 循环内部 token 预算硬顶（估算口径，不暴露设置页——D-04 裁决） */
export const AGENT_TOKEN_BUDGET = 200000

/** 每 key 默认重试预算（D-14：失败限次静默重试，超限转「需人工处理」） */
export const DEFAULT_AGENT_RETRY_BUDGET = 2

/** 循环步骤轨迹（只存 deviceName/command/输出摘要，绝不缓存明文凭证——Pitfall 5） */
export interface AgentStep {
  stepIndex: number
  actionType: 'cmd' | 'kb' | 'exp' | 'mcp'
  status: 'running' | 'done' | 'failed' | 'retrying' | 'burned' | 'cooldown' | 'interrupted'
  deviceName?: string
  command?: string
  /** 28-06 R2 缺陷①：kb/exp 步骤的检索词（步骤卡 argsJson 数据源） */
  query?: string
  outputSummary?: string
  /**
   * 28-06 R6 增强 a：分档预取步骤标志——预取在循环前完成，硬顶计数按 state.rounds
   * （回注轮数），预取步天然不占 agent_max_rounds 步数 N；renderer 据此加「[预取]」前缀。
   */
  prefetched?: boolean
  /**
   * 28-06 R8：后置证据补查步骤标志——runEvidenceBackfill 收尾按 TIER_RETRIEVAL_PLAN
   * 补查缺席源（真实检索），同样不占步数硬顶；renderer 据此加「[补查]」前缀。
   */
  backfilled?: boolean
}

/** 来源轨迹（D-09：由代码层按执行轨迹生成，prompt 文本不参与来源判定） */
export interface SourceRecord {
  kind: 'kb' | 'exp' | 'device' | 'mcp'
  title: string
  summary?: string
  refId?: string
}

/**
 * 28-06 R2 缺陷②：device 来源按 deviceId 判重入栈——同设备多条命令（version+vlan）
 * 只计一条设备来源；kb/exp 按条目不去重（不同文档/经验条目是真实来源数）。
 */
export function pushDeviceSource(state: AgentLoopState, deviceName: string, deviceId: string): void {
  if (state.sources.some((s) => s.kind === 'device' && s.refId === deviceId)) return
  state.sources.push({ kind: 'device', title: deviceName, refId: deviceId })
}

/**
 * Phase 28（28-03，Pitfall 1 结构性修复）：agent 循环可变状态对象化——steps/sources/
 * failureCounts/cooldowns/tokenUsed/retryBudgets 并入状态对象，随确认批次（pendingBatches）
 * 按引用携带续跑，confirm 模式（默认 exec_mode）每步确认后不再丢轨迹。wrapupPrompted
 * 为 D-13 诚实收尾一次性标志（挂起续跑不复位防死循环）。
 */
export interface AgentLoopState extends McpLoopState {
  steps: AgentStep[]
  sources: SourceRecord[]
  /** key = 归一化串（normalizeAgentKey 产出），值 = 连续失败次数（成功清零） */
  failureCounts: Map<string, number>
  /** key = `deviceId:command`，值 = 冷却到期时间戳（D-15：仅本循环内生效） */
  cooldowns: Map<string, number>
  /** 累计 token（网关 usage 优先，估算 fallback）——超 AGENT_TOKEN_BUDGET 触发 D-13 收尾 */
  tokenUsed: number
  /** key = 归一化串，值 = 剩余重试次数（默认 DEFAULT_AGENT_RETRY_BUDGET） */
  retryBudgets: Map<string, number>
  wrapupPrompted?: boolean
  /** 28-04（AGENT-05）：用户中断硬停标志（D-06 立即中止不总结）——meta_enc/落库回看用 */
  hardStop?: 'user_cancel'
  /** 28-04（AGENT-03）：收尾证据补查的知情记录（零命中/设备未查提示），随 payload/meta 持久化 */
  backfillNotes?: string[]
  /**
   * Phase 28（28-05，D-08 步骤级推送）：步骤轨迹 → ai:toolResult 扩展载荷推送回调。
   * chat() 构造 state 后注入（ctx.emitToolResult 包装）；pendingBatches 按引用携带 agentState，
   * confirm 续跑推送不断链。旧 renderer 校验链（isValidToolResultPayload）只认基础字段，天然兼容。
   */
  emitStep?: (step: AgentStep) => void
}

export function createAgentLoopState(): AgentLoopState {
  return {
    rounds: 0,
    extra: [],
    steps: [],
    sources: [],
    failureCounts: new Map(),
    cooldowns: new Map(),
    tokenUsed: 0,
    retryBudgets: new Map(),
  }
}

/** 循环共享上下文（chat() 构造；确认挂起后经 pendingBatches 原样带回复跑） */
export interface McpLoopCtx {
  fullMessages: Array<{ role: string; content: string }>
  config: Record<string, string>
  execMode: ExecMode
  deviceNames: string[]
  mcpContexts: McpCallContext[]
  emitToolResult?: (p: ToolResultPayload) => void
  sessionId: string | null
  expReferences: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
  /** Phase 28（28-03）：agent 循环 CMD 动作解析目标/K 检索 deviceIds/KB 来源累计 */
  targetDevices?: any[]
  deviceIds?: string[]
  kbReferences?: Array<{ docTitle: string; chunkTitle: string; docId: string }>
  /** Phase 28（28-04）：分档分类结果与用户原话（证据补查检索关键词 / meta 溯源） */
  tier?: AgentTier
  userMessage?: string
  /** Phase 28（28-04，AGENT-05/D-06）：用户停止中断信号（ai:cancelChat → AbortController） */
  signal?: AbortSignal
}

/** 循环可变状态（轮次计数 + 累积回注消息；确认批次按引用携带续跑） */
interface McpLoopState {
  rounds: number
  extra: Array<{ role: string; content: string }>
}

export type McpLoopResult =
  | { kind: 'final'; reply: string }
  | { kind: 'confirm_required'; payload: string; count: number }
