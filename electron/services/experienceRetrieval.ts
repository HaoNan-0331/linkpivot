import { getAiConfig, getCommandWhitelist } from './ai'
import { listExperiences, incReuseCount, touchLastVerifiedAt } from './experienceService'
import { isCommandAllowed } from './commandSafety'
import { rerank } from './experienceRerank'
import { RELEVANCE_THRESHOLD } from './experienceRerank'

/**
 * 经验检索编排 service（Phase 11 D-11-1 b 自动预取 + D-11-2 粗筛窄查 + D-11-3 精排 + D-11-4 阈值 +
 * D-11-6 两项验证 + D-11-7 降级策略 + D-11-9 不阻塞主路径）。
 *
 * 编排骨架（仿 experienceDrafting.ts:70-156 summarizeSessionForUi）：
 * 1. demoMode 判定（未配 AI → 返空注入不抛错）
 * 2. 粗筛 listExperiences（D-11-2：有勾选设备走 deviceId 窄查，无勾选走 search 宽匹配；includeInvalid=false 天然过滤失效）
 * 3. 精排 rerank（粗筛候选喂 LLM 强 schema 打分）
 * 4. 阈值过滤（score >= RELEVANCE_THRESHOLD 保留，top INJECT_LIMIT 条）
 * 5. read-time 两项验证（D-11-6）：有效期二次确认（失效剔除）+ 命令白名单（失支持降权 unsupported=true）
 * 6. 命中刷新 incReuseCount/touchLastVerifiedAt（失败 console.warn 不阻塞 D-11-9）
 * 7. 返注入元数据（renderer 永不收 attrs 密文，只 exp_id/title/content/source_session_id/unsupported）
 *
 * 函数式（无 class、无 MK）——本 service 纯编排，加密列由下游 experienceService 已解密回填 attrs 明文传入，
 * 与 CONVENTIONS Pattern 1b（无加密列 service）一致。
 */

/** 经验注入条数上限（planner 定值 5——比 Phase 8 W-4 ≤50 窄，经验注入要精不要多，防 context 溢出）。 */
export const INJECT_LIMIT = 5
/** 粗筛捞候选上限（喂精排），= INJECT_LIMIT * 4。 */
export const MAX_CANDIDATES = INJECT_LIMIT * 4

export interface RetrieveInput {
  userMessage: string
  deviceIds?: string[]
}

export interface RetrieveResult {
  demoMode: boolean
  injected: Array<{
    exp_id: string
    title: string
    content: string
    source_session_id: string | null
    unsupported: boolean
  }>
  reranked: Array<{ exp_id: string; score: number; reason: string }>
  finalAnswer: string
}

/** 命令提取正则：限定只读首词（display/show/ping/traceroute/debug/terminal/interface），不提取变更类（D-11-7 / T-11-02）。 */
const CMD_EXTRACT_RE = /(?:display|show|ping|traceroute|debug|terminal|interface)\s+[\w-/]+/g

export async function retrieveForAnswer(input: RetrieveInput): Promise<RetrieveResult> {
  const empty: RetrieveResult = {
    demoMode: false,
    injected: [],
    reranked: [],
    finalAnswer: input.userMessage,
  }

  // 1. demoMode 判定（未配 AI）—— 不抛错，返空注入（仿 experienceDrafting.ts:79-81）
  const config = getAiConfig()
  if (!config || !config.apiKey) return { ...empty, demoMode: true }

  // 2. 粗筛（D-11-2 窄查策略）
  const opts = input.deviceIds && input.deviceIds.length > 0
    ? { deviceId: input.deviceIds, includeInvalid: false, limit: MAX_CANDIDATES }
    : { search: input.userMessage, includeInvalid: false, limit: MAX_CANDIDATES }
  const { rows } = listExperiences(opts)
  if (rows.length === 0) return empty  // 空库短路：不调精排 LLM

  // 3. 精排（粗筛候选喂 LLM 强 schema 打分）
  const candidates = rows.map((r: any) => ({
    exp_id: r.id,
    title: r.title,
    content_preview: (r.content || '').slice(0, 150),
  }))
  const entries = await rerank({ userMessage: input.userMessage, candidates })

  // 4. 阈值过滤 + top INJECT_LIMIT（D-11-4）
  const passed = entries
    .filter((e) => e.score >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, INJECT_LIMIT)

  // 5 + 6. read-time 两项验证 + 命中刷新
  const whitelist = getCommandWhitelist()
  const injected: RetrieveResult['injected'] = []
  for (const e of passed) {
    const row = rows.find((r: any) => r.id === e.exp_id)
    if (!row) continue

    // (a) 有效期二次确认（D-11-7）：粗筛 includeInvalid=false 已过滤，但窗口跨天二次确认
    if (row.invalid_at) {
      const inv = new Date(row.invalid_at).getTime()
      if (!isNaN(inv) && inv <= Date.now()) continue  // 已失效 → 剔除
    }

    // (b) 命令白名单扫描（D-11-7）：正文 + attrs.resolution + attrs.root_cause 提取类命令文本逐条 isCommandAllowed
    const text = `${row.content || ''} ${row.attrs?.resolution || ''} ${row.attrs?.root_cause || ''}`
    const cmds = [...text.matchAll(CMD_EXTRACT_RE)].map((m) => m[0].trim())
    // 有命令且任一失支持即标 unsupported（保守，宁可多标降权不漏放，T-11-02）
    const unsupported = cmds.length > 0 && cmds.some((c) => !isCommandAllowed(c, whitelist).allowed)

    // (c) 命中刷新（D-11-9 不阻塞主路径：失败 console.warn 兜底）
    try {
      incReuseCount(row.id)
      touchLastVerifiedAt(row.id)
    } catch (err) {
      console.warn('[experienceRetrieval] refresh failed', row.id, (err as Error).message)
    }

    injected.push({
      exp_id: row.id,
      title: row.title,
      content: row.content,
      source_session_id: row.source_session_id ?? null,
      unsupported,
    })
  }

  return {
    demoMode: false,
    injected,
    reranked: passed,
    finalAnswer: input.userMessage,
  }
}
