import { callAI, getAiConfig } from './ai'

/**
 * 经验精排 LLM service（Phase 11 D-11-3 方案 Y / D-11-4 阈值防噪声）。
 *
 * 粗筛候选喂精排 LLM 强 schema 打分（每条 exp_id + score + reason），score 边界归一化
 * 复用 Phase 8 draftingService confidence 模式（'85%'→0.85 / '0.9'→0.9 / 'high'→NaN fail / 1.5→超界 fail）。
 * 反幻觉红线：禁止编造 exp_id（必须命中候选集 candidateExpIds）+ 严格 JSON 数组输出 + 不相关返空 []。
 *
 * 函数式（无 class、无 MK）——本 service 不读写加密列，候选经 listExperiences 已解密 attrs 明文，
 * 与 CONVENTIONS Pattern 1b（无加密列 service）一致。
 *
 * 不落库、不脱敏、不调 IPC——纯「prompt→LLM→校验→返回」可测函数（仿 draftingService.ts）。
 */

export const MAX_RERANK_RETRIES = 3

/** D-11-4 相关度阈值：score < 此值的候选不注入（防噪声），planner 定值 0.6 可调。 */
export const RELEVANCE_THRESHOLD = 0.6

export interface RerankEntry {
  exp_id: string
  score: number
  reason: string
}

export interface RerankInput {
  userMessage: string
  candidates: Array<{ exp_id: string; title: string; content_preview: string }>
  demoMode?: boolean
}

const RERANK_SYSTEM_PROMPT = [
  '你是网络运维经验检索助手。对每条候选经验，结合用户问题判相关度并打分。',
  '【反幻觉红线】禁止编造 exp_id；score 必须 0-1 数值；只对给定候选打分，不得新增。',
  '【输出格式】严格输出 JSON 数组，不得有任何额外文字。每条对象字段：',
  'exp_id(候选列表中既有的 id), score(0-1 数值，支持 "0.85" 或 "85%" 百分比字符串), reason(为何相关/不相关)。',
  '若全部不相关，返回空数组 []。',
].join('\n')

export function buildRerankPrompt(input: RerankInput): { system: string; user: string } {
  const candLine = input.candidates.length > 0
    ? input.candidates.map((c) => `- exp_id: ${c.exp_id} | 标题: ${c.title} | 内容前150字: ${c.content_preview}`).join('\n')
    : '（无候选）'
  const user = [
    `用户问题：${input.userMessage}`,
    '',
    '候选经验列表（按 exp_id 引用，只对此列表打分，不得新增）：',
    candLine,
    '',
    '请按 system 约束输出 JSON 数组（每条含 exp_id + score + reason；全部不相关返 []）。',
  ].join('\n')
  return { system: RERANK_SYSTEM_PROMPT, user }
}

/** 剥离 ```json 包裹与首尾多余文字，提取第一个 [ 到最后一个 ]（复刻 draftingService.ts:97-104 同逻辑）。 */
function extractJsonArray(raw: string): string {
  const first = raw.indexOf('[')
  const last = raw.lastIndexOf(']')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('输出未找到 JSON 数组边界')
  }
  return raw.slice(first, last + 1)
}

/** score 边界归一化（复用 draftingService.ts:144-150 confidence 边界模式）。 */
function normalizeScore(raw: any): number | null {
  let score = raw
  if (typeof score === 'string') {
    score = score.endsWith('%') ? parseFloat(score) / 100 : parseFloat(score)
  }
  if (typeof score !== 'number' || isNaN(score) || score < 0 || score > 1) {
    return null
  }
  return score
}

export function validateRerank(
  raw: string,
  candidateExpIds: Set<string>
): { ok: true; entries: RerankEntry[] } | { ok: false; error: string } {
  let arr: any[]
  try {
    arr = JSON.parse(extractJsonArray(raw))
  } catch (e: any) {
    return { ok: false, error: 'JSON 解析失败: ' + (e?.message || String(e)) }
  }
  if (!Array.isArray(arr)) return { ok: false, error: '输出非数组' }

  const entries: RerankEntry[] = []
  const seen = new Set<string>()
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i]
    if (!d || typeof d !== 'object') return { ok: false, error: `第 ${i + 1} 条非对象` }
    if (typeof d.exp_id !== 'string' || !d.exp_id.trim()) {
      return { ok: false, error: `第 ${i + 1} 条 exp_id 为空` }
    }
    // T-11-06 防编造：exp_id 必须在候选集
    if (!candidateExpIds.has(d.exp_id)) {
      return { ok: false, error: `第 ${i + 1} 条 exp_id 不在候选集: ${d.exp_id}` }
    }
    // CR-02 fix：防 LLM 返重复 exp_id（导致 retrieveForAnswer 对同 id 多次 incReuseCount 累加 +
    // references 重复渲染）。T-11-06 防编造不覆盖「重复」，故显式去重。
    if (seen.has(d.exp_id)) {
      return { ok: false, error: `第 ${i + 1} 条 exp_id 重复: ${d.exp_id}` }
    }
    seen.add(d.exp_id)
    const score = normalizeScore(d.score)
    if (score === null) {
      return { ok: false, error: `第 ${i + 1} 条 score 非法（须 0-1 数值，支持 '85%' 或 '0.85' 字符串）: ${d.score}` }
    }
    if (typeof d.reason !== 'string') {
      return { ok: false, error: `第 ${i + 1} 条 reason 非字符串` }
    }
    entries.push({ exp_id: d.exp_id, score, reason: d.reason })
  }
  return { ok: true, entries }
}

export async function rerank(input: RerankInput): Promise<RerankEntry[]> {
  if (input.demoMode) return []
  // 候选空短路：不调 LLM（D-11 discretion）
  if (input.candidates.length === 0) return []
  const config = getAiConfig()
  if (!config || !config.apiKey) {
    throw new Error('请先配置 AI 服务（API Key 未设置）')
  }
  const { system, user } = buildRerankPrompt(input)
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  const candidateExpIds = new Set(input.candidates.map((c) => c.exp_id))
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= MAX_RERANK_RETRIES; attempt++) {
    const raw = await callAI(config, messages)
    const result = validateRerank(raw, candidateExpIds)
    if (result.ok) return result.entries
    lastError = result.error
  }
  throw new Error(`AI 精排失败（已重试 ${MAX_RERANK_RETRIES} 次）：${lastError}`)
}
