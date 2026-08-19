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
/** Phase 23 Plan 04 C4：全局经验（未关联当前选中设备）rerank 降权系数——同分时关联设备经验优先。 */
export const GLOBAL_RERANK_FACTOR = 0.85

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
    /** Phase 23 Plan 04 C2 供源：是否关联当前选中设备（true=关联/高可信，false=全局经验）。
     * 仅 deviceIds 非空时携带；search 分支（无选中设备）无分级语义，不带该字段。 */
    linked?: boolean
  }>
  reranked: Array<{ exp_id: string; score: number; reason: string }>
  finalAnswer: string
}

/**
 * 命令提取正则：限定只读首词（display/show/ping/traceroute），不提取变更类（D-11-7 / T-11-02）。
 * WR-03 fix：原含 debug/terminal/interface 三词，系英文散文高频词（"the interface of"/"terminal in"），
 * 导致大量非命令正文被当命令提取、isCommandAllowed 首词不在白名单即误标 unsupported=true。
 * 收窄为 4 个高置信 OPS 诊断命令前缀；debug/terminal/interface 留二期补结构化 command 字段后精确判定。
 */
const CMD_EXTRACT_RE = /(?:display|show|ping|traceroute)\s+[\w-/]+/g

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
  // CR-01 fix：强制 status:'published'——只许已发布（人工确认）经验进检索池，draft/confirmed 不进，
  // 否则 Phase 8 AI 起草 + Phase 9 未确认的 draft 经验会被注入 systemPrompt + incReuseCount 刷新，
  // 直接违反 milestone 红线③「AI 产出永远先进 draft 人工确认才 published」。
  const opts = input.deviceIds && input.deviceIds.length > 0
    ? { deviceId: input.deviceIds, status: 'published' as const, includeInvalid: false, includeGlobal: true, limit: MAX_CANDIDATES }
    : { search: input.userMessage, status: 'published' as const, includeInvalid: false, limit: MAX_CANDIDATES }
  const { rows } = listExperiences(opts)
  if (rows.length === 0) return empty  // 空库短路：不调精排 LLM

  // 3. 精排（粗筛候选喂 LLM 强 schema 打分；候选携带 isGlobal 供 C4 降权）
  const hasDevices = !!(input.deviceIds && input.deviceIds.length > 0)
  const isGlobalMap = new Map(rows.map((r: any) => [r.id as string, !!r.isGlobal]))
  const candidates = rows.map((r: any) => ({
    exp_id: r.id,
    title: r.title,
    content_preview: (r.content || '').slice(0, 150),
    ...(hasDevices ? { isGlobal: !!r.isGlobal } : {}),
  }))
  const entries = await rerank({ userMessage: input.userMessage, candidates })

  // 4. 阈值过滤 + top INJECT_LIMIT（D-11-4）
  //    Phase 23 Plan 04 C4：有选中设备时全局经验 rerank 分 ×GLOBAL_RERANK_FACTOR 降权
  //    （阈值判定在降权后——原分过阈值但降权跌破的全局经验让位给关联经验）。
  const adjusted = entries.map((e) => ({
    ...e,
    score: hasDevices && isGlobalMap.get(e.exp_id) ? e.score * GLOBAL_RERANK_FACTOR : e.score,
  }))
  const passed = adjusted
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
      ...(hasDevices ? { linked: !isGlobalMap.get(row.id) } : {}),
    })
  }

  return {
    demoMode: false,
    injected,
    reranked: passed,
    finalAnswer: input.userMessage,
  }
}
