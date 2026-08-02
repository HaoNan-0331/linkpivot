import { callAI, getAiConfig } from './ai'
import type { ExperienceCategory, ExperienceAttrs } from './experienceService'

/**
 * AI 起草 service（Phase 8 D-01/D-03/D-04 起草侧 + DRAFT-04 + W-4 两阶段复判）。
 *
 * 两阶段编排（W-4，D-02 窄化语义 + 防 context 溢出）：
 * - 阶段 A：draftSession 纯起草（existingSummaries=[]）→ drafts[]（verdict 全 ADD 初值）
 * - 阶段 B：judgeVerdicts 复判（编排层按每条 draft.category 窄查喂 LLM）→ 覆盖 verdict + dupId
 * 避免单次起草「4 枚举 category × 设备全量预查」context 溢出（最坏 4000 条摘要）。
 *
 * 不落库、不脱敏、不调 IPC——纯「prompt→LLM→校验→返回」可测函数。
 * 落库交 Plan 03 IPC 层（createExperience status='draft' + duplicateOfExpId）；脱敏交 Plan 01 piiMask（IPC 层先调）；
 * 查重交 Plan 01 duplicateDetector（编排层按 draft.category 窄查，结果传 judgeVerdicts.existingByCategory）。
 *
 * 反幻觉（D-04，红线）：prompt 明确禁止 [CMD]/[KB_SEARCH] 执行标记、禁止编造命令、分类不超枚举、缺数据标 'gap'。
 *
 * 函数式（无 class、无 MK）——本 service 不读写加密列，与 CONVENTIONS Pattern 1b（无加密列 service）一致。
 */

export const MAX_DRAFT_RETRIES = 3

const VALID_CATEGORIES: ExperienceCategory[] = ['troubleshooting', 'best_practices', 'product', 'env']
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const VALID_VERDICTS = ['ADD', 'UPDATE', 'NOOP'] as const

export interface ExistingExperienceSummary {
  exp_id: string
  title: string
  content_preview: string
}

export interface DraftDraft {
  category: ExperienceCategory
  title: string
  content: string
  tags: string[]
  attrs: ExperienceAttrs | Record<string, never>
  confidence: number
  reasoning: string
  duplication_verdict: 'ADD' | 'UPDATE' | 'NOOP'
  duplicate_of_exp_id: string | null
}

export interface DraftSessionInput {
  maskedConversation: string
  deviceIds?: string[]
  existingSummaries: ExistingExperienceSummary[]
  demoMode?: boolean
}

/** W-4 两阶段复判输入：drafts（阶段 A 产出）+ 按分类窄查的同分类存量映射（编排层填充）。 */
export interface JudgeVerdictsInput {
  drafts: DraftDraft[]
  existingByCategory: Record<ExperienceCategory, ExistingExperienceSummary[]>
  demoMode?: boolean
}

const SYSTEM_PROMPT = [
  '你是网络运维经验提炼助手。回顾运维对话，提炼可复用经验。',
  '【反幻觉红线】禁止输出 [CMD]、[KB_SEARCH] 等执行标记；禁止编造命令；禁止虚构分类或字段；缺数据字段值必须填字符串 "gap"，严禁瞎编或强填。',
  '【分类固定枚举】只允许：troubleshooting、best_practices、product、env，禁止超出此枚举。',
  '【分类模板字段】',
  '- troubleshooting：attrs 必须含 severity（critical/high/medium/low/info），可含 symptoms/root_cause/resolution/prevention。',
  '- best_practices / product / env：attrs 可为空对象 {}。',
  '【判定规则】参考"已有经验列表"（阶段 A 通常为空，故全标 ADD；阶段 B 复判交 judgeVerdicts）。',
  '- ADD（新增，与存量不重复）→ duplicate_of_exp_id 必须为 null',
  '- UPDATE（命中存量需补充/更新）→ duplicate_of_exp_id 填命中 exp_id',
  '- NOOP（与存量重复，无新增价值）→ duplicate_of_exp_id 填命中 exp_id（提示跳过，不落库）',
  '【输出格式】严格输出 JSON 数组，不得有任何额外文字或解释。每条对象字段：',
  'category, title, content, tags(字符串数组), attrs(对象), confidence(0-1 数值), reasoning(字符串), duplication_verdict(ADD/UPDATE/NOOP), duplicate_of_exp_id(exp_id 字符串或 null)。',
  '若对话无可总结经验，返回空数组 []。',
].join('\n')

export function buildDraftingPrompt(input: DraftSessionInput): { system: string; user: string } {
  const deviceLine = input.deviceIds && input.deviceIds.length > 0
    ? input.deviceIds.join(', ')
    : '（无关联设备）'
  const existingLine = input.existingSummaries.length > 0
    ? input.existingSummaries.map((s) => `- exp_id: ${s.exp_id} | 标题: ${s.title} | 摘要: ${s.content_preview}`).join('\n')
    : '（同分类+设备暂无存量——阶段 A 纯起草，全标 ADD；查重复判交 judgeVerdicts）'
  const user = [
    '以下是脱敏后的会话正文：',
    input.maskedConversation,
    '',
    `关联设备 id 列表：${deviceLine}`,
    '',
    '同分类+设备已有经验列表（标题+前150字摘要+exp_id）：',
    existingLine,
    '',
    '请按 system 约束输出 JSON 数组。',
  ].join('\n')
  return { system: SYSTEM_PROMPT, user }
}

/** 剥离 ```json 包裹与首尾多余文字，提取第一个 [ 到最后一个 ]。 */
function extractJsonArray(raw: string): string {
  const first = raw.indexOf('[')
  const last = raw.lastIndexOf(']')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('输出未找到 JSON 数组边界')
  }
  return raw.slice(first, last + 1)
}

export function validateDrafts(raw: string): { ok: true; drafts: DraftDraft[] } | { ok: false; error: string } {
  let arr: any[]
  try {
    arr = JSON.parse(extractJsonArray(raw))
  } catch (e: any) {
    return { ok: false, error: 'JSON 解析失败: ' + (e?.message || String(e)) }
  }
  if (!Array.isArray(arr)) return { ok: false, error: '输出非数组' }

  const drafts: DraftDraft[] = []
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i]
    if (!d || typeof d !== 'object') return { ok: false, error: `第 ${i + 1} 条非对象` }
    if (!VALID_CATEGORIES.includes(d.category)) return { ok: false, error: `第 ${i + 1} 条 category 非法: ${d.category}` }
    if (typeof d.title !== 'string' || !d.title.trim()) return { ok: false, error: `第 ${i + 1} 条 title 为空` }
    if (typeof d.content !== 'string' || !d.content.trim()) return { ok: false, error: `第 ${i + 1} 条 content 为空` }
    const tags = Array.isArray(d.tags) ? d.tags.filter((t: any) => typeof t === 'string') : []
    const attrs = d.attrs && typeof d.attrs === 'object' ? d.attrs : {}
    if (d.category === 'troubleshooting') {
      if (!attrs.severity || !VALID_SEVERITIES.includes(attrs.severity)) {
        return { ok: false, error: `第 ${i + 1} 条 troubleshooting 缺合法 severity` }
      }
    }
    if (!VALID_VERDICTS.includes(d.duplication_verdict)) {
      return { ok: false, error: `第 ${i + 1} 条 duplication_verdict 非法: ${d.duplication_verdict}` }
    }
    const verdict: 'ADD' | 'UPDATE' | 'NOOP' = d.duplication_verdict
    const dupId = d.duplicate_of_exp_id
    if (verdict === 'ADD') {
      if (dupId !== null && dupId !== undefined && dupId !== '') {
        return { ok: false, error: `第 ${i + 1} 条 ADD 时 duplicate_of_exp_id 必须为 null` }
      }
    } else {
      if (typeof dupId !== 'string' || !dupId.trim()) {
        return { ok: false, error: `第 ${i + 1} 条 ${verdict} 时 duplicate_of_exp_id 必须填命中 exp_id` }
      }
    }
    // W-2 confidence 边界：'85%' → 0.85；'0.9' → 0.9；'high' → NaN fail；1.5 → 超界 fail
    let confidence = d.confidence
    if (typeof confidence === 'string') {
      confidence = confidence.endsWith('%') ? parseFloat(confidence) / 100 : parseFloat(confidence)
    }
    if (typeof confidence !== 'number' || isNaN(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, error: `第 ${i + 1} 条 confidence 非法（须 0-1 数值，支持 '85%' 百分比或 '0.85' 字符串）: ${d.confidence}` }
    }
    drafts.push({
      category: d.category,
      title: d.title,
      content: d.content,
      tags,
      attrs,
      confidence,
      reasoning: typeof d.reasoning === 'string' ? d.reasoning : '',
      duplication_verdict: verdict,
      duplicate_of_exp_id: verdict === 'ADD' ? null : String(dupId),
    })
  }
  return { ok: true, drafts }
}

export async function draftSession(input: DraftSessionInput): Promise<DraftDraft[]> {
  if (input.demoMode) return []
  const config = getAiConfig()
  if (!config || !config.apiKey) {
    throw new Error('请先配置 AI 服务（API Key 未设置）')
  }
  const { system, user } = buildDraftingPrompt(input)
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= MAX_DRAFT_RETRIES; attempt++) {
    const raw = await callAI(config, messages)
    const result = validateDrafts(raw)
    if (result.ok) return result.drafts
    lastError = result.error
  }
  throw new Error(`AI 起草失败（已重试 ${MAX_DRAFT_RETRIES} 次）：${lastError}`)
}

// ---------- W-4 阶段 B：judgeVerdicts 两阶段复判 ----------

const VERDICT_SYSTEM_PROMPT = [
  '你是经验查重判定助手。对每条草稿，参考其同分类已有经验列表，判定 duplication_verdict。',
  '【判定规则】',
  '- ADD（与同分类存量不重复）→ duplicate_of_exp_id = null',
  '- UPDATE（命中同分类存量需补充/更新）→ duplicate_of_exp_id 填命中 exp_id',
  '- NOOP（与同分类存量重复，无新增价值）→ duplicate_of_exp_id 填命中 exp_id',
  '【输出格式】严格输出 JSON 数组，每条对象含：draft_index(草稿在输入 drafts[] 中的 0-based 下标), verdict(ADD/UPDATE/NOOP), duplicate_of_exp_id(exp_id 或 null)。',
  '每条输入草稿必须输出一条判定，不得遗漏。',
].join('\n')

/** 构建复判 prompt：drafts[] 摘要（index+title+category+content 前80字）+ 按 category 分组的同分类存量。 */
export function buildVerdictPrompt(input: JudgeVerdictsInput): { system: string; user: string } {
  const draftsLine = input.drafts.map((d, i) =>
    `- draft_index: ${i} | category: ${d.category} | 标题: ${d.title} | 内容前80字: ${d.content.slice(0, 80)}`
  ).join('\n')
  const existingBlocks = (Object.keys(input.existingByCategory) as ExperienceCategory[])
    .filter((cat) => input.existingByCategory[cat].length > 0)
    .map((cat) => {
      const sums = input.existingByCategory[cat]
        .map((s) => `  - exp_id: ${s.exp_id} | 标题: ${s.title} | 摘要: ${s.content_preview}`)
        .join('\n')
      return `【分类 ${cat}】同分类已有经验：\n${sums}`
    })
    .join('\n\n')
  const user = [
    '以下是待判定的草稿列表（按 draft_index 引用）：',
    draftsLine,
    '',
    '以下是按草稿自身 category 分组的同分类已有经验（仅参考草稿同分类项判定，跨分类不匹配）：',
    existingBlocks || '（全部分类暂无存量——所有草稿判 ADD）',
    '',
    '请按 system 约束对每条草稿输出判定 JSON 数组。',
  ].join('\n')
  return { system: VERDICT_SYSTEM_PROMPT, user }
}

interface VerdictEntry {
  draft_index: number
  verdict: 'ADD' | 'UPDATE' | 'NOOP'
  duplicate_of_exp_id: string | null
}

/** 校验复判返回：每条 draft_index 有效 + verdict 枚举 + UPDATE/NOOP 时 dupId 必填 + ADD 时 null。 */
export function validateVerdicts(raw: string, draftCount: number): { ok: true; entries: VerdictEntry[] } | { ok: false; error: string } {
  let arr: any[]
  try {
    arr = JSON.parse(extractJsonArray(raw))
  } catch (e: any) {
    return { ok: false, error: '复判 JSON 解析失败: ' + (e?.message || String(e)) }
  }
  if (!Array.isArray(arr)) return { ok: false, error: '复判输出非数组' }
  const entries: VerdictEntry[] = []
  const seen = new Set<number>()
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (!v || typeof v !== 'object') return { ok: false, error: `复判第 ${i + 1} 条非对象` }
    const idx = typeof v.draft_index === 'number' ? v.draft_index : parseInt(v.draft_index, 10)
    if (!Number.isInteger(idx) || idx < 0 || idx >= draftCount) {
      return { ok: false, error: `复判第 ${i + 1} 条 draft_index 越界: ${v.draft_index}` }
    }
    if (seen.has(idx)) return { ok: false, error: `复判 draft_index=${idx} 重复` }
    seen.add(idx)
    if (!VALID_VERDICTS.includes(v.verdict)) {
      return { ok: false, error: `复判 draft_index=${idx} verdict 非法: ${v.verdict}` }
    }
    const verdict: 'ADD' | 'UPDATE' | 'NOOP' = v.verdict
    const dupId = v.duplicate_of_exp_id
    if (verdict === 'ADD') {
      if (dupId !== null && dupId !== undefined && dupId !== '') {
        return { ok: false, error: `复判 draft_index=${idx} ADD 时 duplicate_of_exp_id 必须为 null` }
      }
    } else {
      if (typeof dupId !== 'string' || !dupId.trim()) {
        return { ok: false, error: `复判 draft_index=${idx} ${verdict} 时 duplicate_of_exp_id 必须填命中 exp_id` }
      }
    }
    entries.push({ draft_index: idx, verdict, duplicate_of_exp_id: verdict === 'ADD' ? null : String(dupId) })
  }
  return { ok: true, entries }
}

/**
 * W-4 阶段 B 复判：对 drafts[] 每条按其 category 同分类存量判 ADD/UPDATE/NOOP + 命中 exp_id。
 * 编排层（Plan 03）按每条 draft.category 调 findExistingForDraft 窄查后填充 existingByCategory（≤50 条/分类截断）。
 * demoMode=true → 不调 LLM，原 drafts 保持（verdict 维持阶段 A 初值）。
 * 复判失败重试 MAX_DRAFT_RETRIES=3 次；WR-03：LLM 未返某 draft_index 时，该条按其 category 是否有同分类存量处理——
 * 有存量保守判 NOOP（跳过落库，宁漏勿重，交 Phase 9 人工兜底），无存量保持 ADD（不可能重复）。
 */
export async function judgeVerdicts(input: JudgeVerdictsInput): Promise<DraftDraft[]> {
  if (input.demoMode) return input.drafts
  // 无任何同分类存量 → 全 ADD，不调 LLM（短路优化）
  const hasAny = (Object.values(input.existingByCategory) as ExistingExperienceSummary[][]).some((arr) => arr.length > 0)
  if (!hasAny) return input.drafts

  const config = getAiConfig()
  if (!config || !config.apiKey) {
    throw new Error('请先配置 AI 服务（API Key 未设置）')
  }
  const { system, user } = buildVerdictPrompt(input)
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= MAX_DRAFT_RETRIES; attempt++) {
    const raw = await callAI(config, messages)
    const result = validateVerdicts(raw, input.drafts.length)
    if (result.ok) {
      // 回填：按 draft_index 覆盖 verdict + dupId
      const out = input.drafts.map((d) => ({ ...d }))
      const covered = new Set<number>()
      for (const e of result.entries) {
        out[e.draft_index].duplication_verdict = e.verdict
        out[e.draft_index].duplicate_of_exp_id = e.duplicate_of_exp_id
        covered.add(e.draft_index)
      }
      // WR-03：LLM 未覆盖的 draft，若其 category 有同分类存量，保守判 NOOP（宁漏落库不重复落库）。
      // 无存量时保持 ADD（不可能重复）；有存量但 LLM 漏判 → 疑似重复，跳过落库交 Phase 9 人工兜底。
      for (let i = 0; i < out.length; i++) {
        if (!covered.has(i)) {
          const sameCat = input.existingByCategory[out[i].category]
          if (sameCat && sameCat.length > 0) {
            out[i].duplication_verdict = 'NOOP'
            out[i].duplicate_of_exp_id = null
          }
        }
      }
      return out
    }
    lastError = result.error
  }
  throw new Error(`AI 复判失败（已重试 ${MAX_DRAFT_RETRIES} 次）：${lastError}`)
}
