import type { ConfirmData, ReferenceItem, ToolResultMessage } from './types'

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
  | { kind: 'answer'; content: string; references: ReferenceItem[] }
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
}> {
  if (parsed.kind === 'answer') {
    return [{ role: 'assistant', content: parsed.content, references: parsed.references }]
  }
  if (parsed.kind === 'toolResult') {
    return [{ role: 'assistant', content: '', toolResult: parsed.toolResult }]
  }
  return [{ role: 'assistant', content: parsed.content }]
}

const isStr = (v: unknown): v is string => typeof v === 'string'

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
function isValidConfirmPayload(p: Record<string, unknown>): p is {
  execId: string
  aiExplanation: string
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

  if (p.type === 'kb_answer' || p.type === 'exp_answer') {
    const references = Array.isArray(p.references)
      ? p.references.flatMap((r) => normalizeReference(r))
      : []
    return { kind: 'answer', content: isStr(p.content) ? p.content : '', references }
  }

  // 其他 JSON（无 type / 未知 type）——按普通文本原样返回
  return { kind: 'plain', content: raw }
}
