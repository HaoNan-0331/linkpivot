import type { AgentMeta, AgentSourceItem, AgentStepStatus, AgentTierName, ChatMsg, ConfirmData, ReferenceItem, ToolResultMessage } from './types'

/**
 * parseAiReply —— AI 应答解析纯函数（Phase 19 REN-02 / 审计 R-M5，D-10）。
 *
 * 抽取源：useAIChat.ts 两段同语义内联解析——
 * - handleSend :154-200（confirm_required / kb_answer / exp_answer 三分支 + references 归一）
 * - handleConfirm :222-238（exp_answer/kb_answer + flatMap references，「Phase 11 UAT fix」）
 *
 * P14 原则：LLM 输出是不可信输入（T-19-06），JSON.parse 结果按 unknown 逐字段边界校验
 * （typeof / Array.isArray），禁止 `as` 裸断言；非法载荷（含畸形 confirm_required）
 * 一律降级 plain，不进入 confirm 分支——确认流不可能被畸形 JSON 伪造触发。
 * 解析失败降级普通文本不崩（沿 ExperienceTab formatTs 降级先例）。
 */

export type ParsedAiReply =
  | { kind: 'plain'; content: string }
  | { kind: 'confirm'; content: string; confirm: ConfirmData }
  | { kind: 'answer'; content: string; references: ReferenceItem[]; agentMeta?: AgentMeta }
  | { kind: 'toolResult'; toolResult: ToolResultMessage }

/**
 * parsed → 追加用 assistant 消息行（Phase 22 code-review CR-01）。
 * 消费方必须以函数式更新 `setMessages((prev) => [...prev, ...parsedToMessages(parsed)])`
 * 追加——禁止基于发送前 snapshot 的整体替换（会覆盖 await 期间 ai:toolResult 事件
 * 追加进对话流的工具结果卡片）。本纯函数即该语义的可测锚点。
 */
export function parsedToMessages(parsed: ParsedAiReply): Array<{
  role: 'assistant'
  content: string
  references?: ReferenceItem[]
  toolResult?: ToolResultMessage
  agentMeta?: AgentMeta
}> {
  if (parsed.kind === 'answer') {
    return [{ role: 'assistant', content: parsed.content, references: parsed.references, agentMeta: parsed.agentMeta }]
  }
  if (parsed.kind === 'toolResult') {
    return [{ role: 'assistant', content: '', toolResult: parsed.toolResult }]
  }
  return [{ role: 'assistant', content: parsed.content }]
}

const isStr = (v: unknown): v is string => typeof v === 'string'

// Phase 28（28-05）：agent 轨迹 meta 逐字段校验（D-09/D-11/D-12——sources/tier/noRealtimeData
// 只能来自 payload 结构化字段，畸形项丢弃；AI 正文不可伪造）。meta 任一有效字段在场才产出。
const AGENT_SOURCE_KINDS = ['kb', 'exp', 'device', 'mcp'] as const
const AGENT_TIER_NAMES: readonly AgentTierName[] = ['troubleshoot', 'configQuery', 'knowledge', 'inspection']

function parseAgentMeta(p: Record<string, unknown>): AgentMeta | undefined {
  let meta: AgentMeta | undefined
  if (Array.isArray(p.sources)) {
    const sources: AgentSourceItem[] = p.sources.flatMap((s) => {
      if (s === null || typeof s !== 'object') return []
      const o = s as Record<string, unknown>
      if (!isStr(o.title) || !(AGENT_SOURCE_KINDS as readonly string[]).includes(o.kind as string)) return []
      const item: AgentSourceItem = { kind: o.kind as AgentSourceItem['kind'], title: o.title }
      if (isStr(o.summary)) item.summary = o.summary
      if (isStr(o.refId)) item.refId = o.refId
      return [item]
    })
    if (sources.length > 0) meta = { sources }
  }
  if (meta === undefined && Array.isArray(p.sources)) return undefined
  if (p.tier !== undefined) {
    if (!(AGENT_TIER_NAMES as readonly string[]).includes(p.tier as string)) return undefined
    meta = { sources: [], ...(meta ?? {}) , tier: p.tier as AgentTierName }
  }
  if (p.noRealtimeData === true) meta = { sources: [], ...(meta ?? {}), noRealtimeData: true }
  if (p.hardStop === 'user_cancel') meta = { sources: [], ...(meta ?? {}), hardStop: 'user_cancel' }
  if (Array.isArray(p.backfillNotes) && p.backfillNotes.every(isStr) && p.backfillNotes.length > 0) {
    meta = { sources: [], ...(meta ?? {}), backfillNotes: p.backfillNotes as string[] }
  }
  return meta
}

const TOOL_RESULT_STATUSES = ['success', 'failed', 'timeout'] as const

/**
 * tool_result 载荷逐字段 unknown 校验（Phase 22 / 22-05，T-22-16 fail-closed）。
 * 消费方有二：parseAiReply 字符串解析分支 + useAIChat `ai:toolResult` 事件订阅
 * （事件 payload 为 unknown，校验失败整条丢弃，不降级展示）。
 */
export function isValidToolResultPayload(v: unknown): v is ToolResultMessage {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const p = v as Record<string, unknown>
  return (
    p.type === 'tool_result' &&
    isStr(p.server) &&
    isStr(p.tool) &&
    isStr(p.deviceName) &&
    isStr(p.argsJson) &&
    isStr(p.resultJson) &&
    isStr(p.status) &&
    (TOOL_RESULT_STATUSES as readonly string[]).includes(p.status)
  )
}

// ConfirmData 载荷校验：execId/aiExplanation string + commands 形状合法（缺任一降级 plain）。
// WR-04：谓词签名产出 narrowing，confirm 分支消费免 as 断言（校验体逻辑不变）。
// Phase 27 checkpoint fix：guardInfo 可选字段纳入校验——存在但畸形（伪造/篡改）整载荷降级 plain
// （T-19-06 fail-closed：越权警示数据不可信时宁可不进确认流，防伪造 payload 绕过警示层）。
function isValidConfirmPayload(p: Record<string, unknown>): p is {
  execId: string
  aiExplanation: string
  guardInfo?: GuardInfoShape
  commands: Array<{
    deviceName: string
    command: string
    server?: string
    tool?: string
    argsJson?: string
  }>
  rejectedCommands?: unknown[]
} {
  if (!isStr(p.execId) || !isStr(p.aiExplanation)) return false
  if (p.guardInfo !== undefined && !isGuardInfo(p.guardInfo)) return false
  if (!Array.isArray(p.commands)) return false
  return p.commands.every(
    (c) =>
      c !== null &&
      typeof c === 'object' &&
      isStr((c as Record<string, unknown>).deviceName) &&
      isStr((c as Record<string, unknown>).command) &&
      // Phase 22（22-05）：MCP 工具行可选字段——存在即必须 string（畸形行整批拒绝 fail-closed）
      ((c as Record<string, unknown>).server === undefined || isStr((c as Record<string, unknown>).server)) &&
      ((c as Record<string, unknown>).tool === undefined || isStr((c as Record<string, unknown>).tool)) &&
      ((c as Record<string, unknown>).argsJson === undefined || isStr((c as Record<string, unknown>).argsJson))
  )
}

/** guardInfo 形状（契约固定于 main 侧 privilegeGuard.GuardHit + 27-04 分区映射，types.ts GuardHitInfo 逐字对齐） */
type GuardInfoShape = {
  expectedTarget: string
  hits: Array<{ ruleId: string; level: 'red' | 'yellow'; target: string; explanation: string }>
  hitCommandIndexes?: number[]
}

// guardInfo 逐字段校验（Phase 27 checkpoint）：expectedTarget/hits 必填，hit 元素四字段 string 且
// level 限 red|yellow（分色契约，禁第三方值）；hitCommandIndexes 可选——存在即必须 number[]。
function isGuardInfo(v: unknown): v is GuardInfoShape {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const g = v as Record<string, unknown>
  if (!isStr(g.expectedTarget) || !Array.isArray(g.hits)) return false
  const hitsOk = g.hits.every(
    (h) =>
      h !== null &&
      typeof h === 'object' &&
      isStr((h as Record<string, unknown>).ruleId) &&
      isStr((h as Record<string, unknown>).target) &&
      isStr((h as Record<string, unknown>).explanation) &&
      ((h as Record<string, unknown>).level === 'red' || (h as Record<string, unknown>).level === 'yellow')
  )
  if (!hitsOk) return false
  if (g.hitCommandIndexes === undefined) return true
  return Array.isArray(g.hitCommandIndexes) && g.hitCommandIndexes.every((n) => typeof n === 'number')
}

// rejectedCommands 单项守卫：command/reason 均 string 才透传（T-19-06，窄化免 as）
const isRejectedCommand = (c: unknown): c is { command: string; reason: string } =>
  c !== null &&
  typeof c === 'object' &&
  isStr((c as Record<string, unknown>).command) &&
  isStr((c as Record<string, unknown>).reason)

// 单条原始 reference 归一（unknown → ReferenceItem[]）：
// - kind==='kb' 或含 docTitle → kb 项（kb_answer 既有形态无 kind，消费时统一补 kind:'kb'，Phase 11 D-11）
// - kind==='experience' → experience 项 + sourceSessionId 非空拆 session 项（D-11-10）
// - 形状不合法 → 丢弃（T-19-06：不把未校验字段透传给渲染层）
function normalizeReference(r: unknown): ReferenceItem[] {
  if (r === null || typeof r !== 'object') return []
  const o = r as Record<string, unknown>
  if (o.kind === 'kb' || o.docTitle !== undefined) {
    if (isStr(o.docTitle) && isStr(o.chunkTitle) && isStr(o.docId)) {
      return [{ kind: 'kb', docTitle: o.docTitle, chunkTitle: o.chunkTitle, docId: o.docId }]
    }
    return []
  }
  if (o.kind === 'experience') {
    if (!isStr(o.expId) || !isStr(o.title)) return []
    // WR-05：首项提具名 const 保持 experience 变体窄类型，unsupported 直赋免 cast
    const experienceRef: ReferenceItem = { kind: 'experience', expId: o.expId, title: o.title }
    const refs: ReferenceItem[] = [experienceRef]
    // unsupported 可选标记（命令失支持 Tag warning，D-11-7）
    if (o.unsupported !== undefined) {
      experienceRef.unsupported = o.unsupported === true
    }
    // ai.ts:835 references 已含 sourceSessionId（camelCase），非空拆 session 引用（D-11-10）
    if (isStr(o.sourceSessionId) && o.sourceSessionId) {
      refs.push({ kind: 'session', sessionId: o.sourceSessionId, title: '原始会话' })
    }
    return refs
  }
  return []
}

// 28-06 R2 缺陷⑥：历史消息 meta → 渲染层消息恢复（切换会话再切回，步骤卡/徽章/标签不丢）。
// meta.steps → toolResult 步骤卡消息（stepStatus 用落库终态，重建 payload 与 main 侧
// agentStepToToolResultPayload 同构）；meta.sources/tier/noRealtimeData/backfillNotes →
// agentMeta（复用 parseAgentMeta fail-closed 校验）。畸形 steps 项逐条丢弃不降级整批。
const AGENT_STEP_ACTION_TYPES = ['cmd', 'kb', 'exp', 'mcp'] as const
const AGENT_STEP_STATUS_VALUES: readonly AgentStepStatus[] = [
  'running', 'done', 'failed', 'retrying', 'burned', 'cooldown', 'interrupted',
]

function stepToToolResultMessage(s: unknown): ToolResultMessage | undefined {
  if (s === null || typeof s !== 'object') return undefined
  const o = s as Record<string, unknown>
  const isStr = (v: unknown): v is string => typeof v === 'string'
  if (!(AGENT_STEP_ACTION_TYPES as readonly string[]).includes(o.actionType as string)) return undefined
  if (typeof o.stepIndex !== 'number') return undefined
  // 28-06 R5 缺陷A：main 侧 AgentStep 序列化字段为 status（buildAgentMeta 原样落 meta.steps），
  // 此前误读 stepStatus（恒 undefined）→ 历史恢复时所有步骤卡被静默丢弃（切会话再切回卡片全消失）。
  const stepStatus = o.status !== undefined ? o.status : o.stepStatus
  if (!(AGENT_STEP_STATUS_VALUES as readonly string[]).includes(stepStatus as string)) return undefined
  const actionType = o.actionType as ToolResultMessage['actionType']
  const toolLabel =
    actionType === 'cmd' ? '命令执行'
    : actionType === 'kb' ? '知识库检索'
    : actionType === 'exp' ? '经验库检索'
    : 'MCP 工具'
  const payload: ToolResultMessage = {
    type: 'tool_result',
    server: 'agent',
    tool: toolLabel,
    deviceName: isStr(o.deviceName) ? o.deviceName : '',
    argsJson: actionType === 'kb' || actionType === 'exp'
      ? (isStr(o.query) ? o.query : '')
      : (isStr(o.command) ? o.command : ''),
    resultJson: isStr(o.outputSummary) ? o.outputSummary : '',
    status: stepStatus === 'failed' || stepStatus === 'burned' ? 'failed' : 'success',
    stepIndex: o.stepIndex,
    actionType,
    stepStatus: stepStatus as AgentStepStatus,
    ...(o.prefetched === true ? { prefetched: true } : {}),
  }
  return isValidToolResultPayload(payload) ? payload : undefined
}

/** 单条历史消息（含可选 meta）→ 渲染层消息数组（步骤卡消息在前 + 本体带 agentMeta） */
export function historyMessageToChatMsgs(m: {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  meta?: Record<string, unknown>
}): ChatMsg[] {
  if (m.role !== 'assistant' || !m.meta || typeof m.meta !== 'object') {
    return [{ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt }]
  }
  const out: ChatMsg[] = []
  if (Array.isArray(m.meta.steps)) {
    for (const s of m.meta.steps) {
      const tr = stepToToolResultMessage(s)
      if (tr) out.push({ role: 'assistant', content: '', toolResult: tr })
    }
  }
  const agentMeta = parseAgentMeta(m.meta)
  out.push({
    id: m.id,
    role: 'assistant',
    content: m.content,
    createdAt: m.createdAt,
    ...(agentMeta ? { agentMeta } : {}),
  })
  return out
}

export function parseAiReply(raw: string): ParsedAiReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 非 JSON —— 普通回复
    return { kind: 'plain', content: raw }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'plain', content: raw }
  }
  const p = parsed as Record<string, unknown>

  // confirm_required：载荷全字段校验后才进入确认流（T-19-06 防伪造触发）
  if (p.type === 'confirm_required') {
    if (!isValidConfirmPayload(p)) return { kind: 'plain', content: raw }
    const confirm: ConfirmData = {
      type: 'confirm_required',
      execId: p.execId,
      aiExplanation: p.aiExplanation,
      // Phase 27 checkpoint fix：越权命中信息透传——此前白名单式挑字段丢弃 guardInfo，
      // 弹窗永远渲染普通「命令执行确认」形态（main 侧 hits 已落库但 renderer 不可见）。
      // 谓词已校验形状与 level 枚举；hitCommandIndexes 缺失由 CommandConfirmModal 降级全量列表。
      ...(p.guardInfo !== undefined ? { guardInfo: p.guardInfo } : {}),
      commands: p.commands.map((c) => ({
        deviceName: c.deviceName,
        command: c.command,
        ...(c.server !== undefined ? { server: c.server } : {}),
        ...(c.tool !== undefined ? { tool: c.tool } : {}),
        ...(c.argsJson !== undefined ? { argsJson: c.argsJson } : {}),
      })),
    }
    if (Array.isArray(p.rejectedCommands)) {
      confirm.rejectedCommands = p.rejectedCommands
        .filter(isRejectedCommand)
        .map((c) => ({ command: c.command, reason: c.reason }))
    }
    return { kind: 'confirm', content: '', confirm }
  }

  // tool_result（Phase 22 / 22-05，D-03）：逐字段校验合法才产出 toolResult（非法降级 plain）
  if (p.type === 'tool_result') {
    if (!isValidToolResultPayload(p)) return { kind: 'plain', content: raw }
    const toolResult: ToolResultMessage = { ...p }
    return { kind: 'toolResult', toolResult }
  }

  // Phase 28（28-05，AGENT-05）：agent_answer——无 kb/exp 引用但有执行轨迹的最终回答。
  // 照 exp_answer 先例逐字段校验；content 非 string 整体降级 plain（fail-closed）。
  // 28-04 refs-priority 契约：kb/exp 引用在场时保持 kb_answer/exp_answer 类型 + meta 附带。
  if (p.type === 'agent_answer') {
    if (!isStr(p.content)) return { kind: 'plain', content: raw }
    const references = Array.isArray(p.references)
      ? p.references.flatMap((r) => normalizeReference(r))
      : []
    return { kind: 'answer', content: p.content, references, agentMeta: parseAgentMeta(p) }
  }

  if (p.type === 'kb_answer' || p.type === 'exp_answer') {
    const references = Array.isArray(p.references)
      ? p.references.flatMap((r) => normalizeReference(r))
      : []
    // 28-04：既有契约类型 + agent meta 字段附带（sources/tier/noRealtimeData 同样交付）
    const agentMeta = parseAgentMeta(p)
    if (agentMeta) return { kind: 'answer', content: isStr(p.content) ? p.content : '', references, agentMeta }
    return { kind: 'answer', content: isStr(p.content) ? p.content : '', references }
  }

  // 其他 JSON（无 type / 未知 type）——按普通文本原样返回
  return { kind: 'plain', content: raw }
}
