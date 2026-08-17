import type { ConfirmData, ReferenceItem } from './types'

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

const isStr = (v: unknown): v is string => typeof v === 'string'

// ConfirmData 载荷校验：execId/aiExplanation string + commands 形状合法（缺任一降级 plain）
function isValidConfirmPayload(p: Record<string, unknown>): boolean {
  if (!isStr(p.execId) || !isStr(p.aiExplanation)) return false
  if (!Array.isArray(p.commands)) return false
  return p.commands.every(
    (c) =>
      c !== null &&
      typeof c === 'object' &&
      isStr((c as Record<string, unknown>).deviceName) &&
      isStr((c as Record<string, unknown>).command)
  )
}

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
    const refs: ReferenceItem[] = [{ kind: 'experience', expId: o.expId, title: o.title }]
    // unsupported 可选标记（命令失支持 Tag warning，D-11-7）
    if (o.unsupported !== undefined) {
      ;(refs[0] as { unsupported?: boolean }).unsupported = o.unsupported === true
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
      execId: p.execId as string,
      aiExplanation: p.aiExplanation as string,
      commands: (p.commands as Array<{ deviceName: string; command: string }>).map((c) => ({
        deviceName: c.deviceName,
        command: c.command,
      })),
    }
    if (Array.isArray(p.rejectedCommands)) {
      confirm.rejectedCommands = p.rejectedCommands
        .filter(
          (c) =>
            c !== null &&
            typeof c === 'object' &&
            isStr((c as Record<string, unknown>).command) &&
            isStr((c as Record<string, unknown>).reason)
        )
        .map((c) => ({
          command: (c as Record<string, unknown>).command as string,
          reason: (c as Record<string, unknown>).reason as string,
        }))
    }
    return { kind: 'confirm', content: '', confirm }
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
