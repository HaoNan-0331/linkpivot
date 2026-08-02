import { getChatHistory, getAiConfig } from './ai'
import { maskConversationText } from '../utils/piiMask'
import { findExistingForDraft } from './duplicateDetector'
import { draftSession, judgeVerdicts } from './draftingService'
import type { ExistingExperienceSummary, DraftDraft } from './draftingService'
import { createExperience, relateDevice } from './experienceService'
import type { ExperienceCategory, ExperienceAttrs } from './experienceService'

/**
 * 经验总结编排 service（Phase 8 D-01/02/03/04 + 5 SC + B-1/B-2/W-3/W-4 修订）。
 *
 * W-4 两阶段起草（避免 4×1000 context 溢出 + D-02 窄化语义）：
 * - 阶段 A：draftSession(existingSummaries=[]) 纯起草 → drafts[]（verdict 全 ADD 初值）
 * - 阶段 B：按 drafts 涉及的 distinct category 调 findExistingForDraft 窄查（≤50 条/分类截断）
 *           → existingByCategory 映射 → judgeVerdicts 复判覆盖 verdict + dupId
 *
 * D-03 落库语义（B-1 + B-2 方案 A，单语句原子）：
 * - ADD → createExperience({..., sourceSessionId}) + relateDevice；duplicateOfExpId 不传（写 NULL）
 * - UPDATE → createExperience({..., sourceSessionId, duplicateOfExpId: 命中旧id}) 单语句原子写 dup_id
 *   （CREATE 失败即 throw 中断该条 draft，标注与 draft 行共存亡 B-2；不 try/catch 吞错）
 * - NOOP → 不落库，noop[] 提示
 *
 * B-1 Service 封装红线：编排层不裸 SQL UPDATE duplicate_of_exp_id，唯一写入路径是
 *   experienceService.createExperience 门面（grep 反向守卫 = 0）。
 *
 * SC1：draftSession 返 [] → result.empty=true，IPC/UI 提示「该会话无可总结经验」不强产。
 * SC5：同 session 多次总结独立批次（每次生独立 draft 行，source_session_id 相同但行 id 不同，追加不覆盖）。
 *
 * demoMode：getAiConfig 返 null 或 apiKey 空 → 视为未配 AI，返 empty + demoMode=true 不抛错。
 *
 * 函数式（无 class、无 MK）——加密列由下游 experienceService/ai.ts 处理，本 service 纯编排。
 */

/** W-4 阶段 B 每分类窄查的存量截断上限（防 context 溢出）。 */
const MAX_EXISTING_PER_CATEGORY = 50

export interface DraftingResult {
  empty: boolean                // SC1：无可总结内容（draftSession 返 [] 或 demoMode）
  demoMode: boolean             // 是否走了 demoMode 降级（未配 AI）
  created: Array<{ exp_id: string; title: string; category: ExperienceCategory }>      // ADD 落库
  updated: Array<{ exp_id: string; title: string; category: ExperienceCategory; duplicate_of_exp_id: string }>  // UPDATE 落库
  noop: Array<{ duplicate_of_exp_id: string; reasoning: string }>                       // NOOP 跳过提示
}

interface ChatMessageLite {
  role: string
  content: string
  deviceId: string | null
}

/** 把脱敏会话明文按对话格式拼成单段文本（role: content 每行）。 */
function buildConversationText(messages: ChatMessageLite[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n')
}

/** 收集会话关联设备 id（chat_history.device_id 去重，过滤 null）。 */
function collectDeviceIds(messages: ChatMessageLite[]): string[] {
  const set = new Set<string>()
  for (const m of messages) {
    if (m.deviceId) set.add(m.deviceId)
  }
  return Array.from(set)
}

export interface SummarizeSessionInput {
  sessionId: string
}

export async function summarizeSessionForUi(input: SummarizeSessionInput): Promise<DraftingResult> {
  const { sessionId } = input
  const empty: DraftingResult = { empty: true, demoMode: false, created: [], updated: [], noop: [] }

  // 1. 读会话明文（getChatHistory 已 decField 解密）
  const messages = getChatHistory(sessionId)
  if (messages.length === 0) return empty

  // 2. 判 demoMode（未配 AI）—— 不抛错，UI 提示
  const config = getAiConfig()
  const demoMode = !config || !config.apiKey
  if (demoMode) return { ...empty, demoMode: true }

  // 3. PII 脱敏（D-04，T-08-01）—— 送 LLM 前主进程做，原始 chat_history 明文不动
  const conversationText = buildConversationText(messages)
  const maskedConversation = maskConversationText(conversationText)

  // 4. 关联设备收集
  const deviceIds = collectDeviceIds(messages)

  // 5. W-4 阶段 A：纯起草（existingSummaries=[] → verdict 全 ADD 初值，查重复判交阶段 B）
  const draftsA: DraftDraft[] = await draftSession({ maskedConversation, deviceIds, existingSummaries: [] })

  // 6. SC1：无可总结不强产
  if (draftsA.length === 0) return empty

  // 7. W-4 阶段 B：按 drafts 涉及的 distinct category 窄查同分类存量，组装 existingByCategory
  const distinctCategories = Array.from(new Set(draftsA.map((d) => d.category))) as ExperienceCategory[]
  const existingByCategory = {} as Record<ExperienceCategory, ExistingExperienceSummary[]>
  for (const cat of distinctCategories) {
    const sums = findExistingForDraft({ category: cat, deviceIds })
    existingByCategory[cat] = sums.slice(0, MAX_EXISTING_PER_CATEGORY)  // ≤50 条/分类截断防 context 溢出
  }
  // 复判覆盖 verdict + dupId（judgeVerdicts 内部短路：全分类无存量时直接返原 drafts 不调 LLM）
  const drafts: DraftDraft[] = await judgeVerdicts({ drafts: draftsA, existingByCategory })

  // 8. 落库（D-03 + B-1/B-2 方案 A）
  const created: DraftingResult['created'] = []
  const updated: DraftingResult['updated'] = []
  const noop: DraftingResult['noop'] = []

  for (const d of drafts) {
    if (d.duplication_verdict === 'NOOP') {
      noop.push({ duplicate_of_exp_id: d.duplicate_of_exp_id || '', reasoning: d.reasoning })
      continue
    }
    // B-1 + B-2 方案 A：经门面 createExperience 落库，UPDATE 时传 duplicateOfExpId 单语句原子写 dup_id
    // 不 try/catch 吞错——CREATE 失败即 throw 中断该条 draft，标注与 draft 行共存亡（B-2）
    const exp = createExperience({
      title: d.title,
      category: d.category,
      content: d.content,
      tags: d.tags,
      sourceSessionId: sessionId,    // SC5：source_session_id 溯源，同 session 多次总结生独立行
      attrs: (d.category === 'troubleshooting') ? (d.attrs as ExperienceAttrs) : null,
      duplicateOfExpId: d.duplication_verdict === 'UPDATE' ? d.duplicate_of_exp_id : null,
    })
    // 关联设备（draft 关联的设备 = 会话期间涉及的设备，全部 primary 关联）
    // relateDevice 独立于 createExperience dup_id 原子单元——关联失败不阻塞 draft 入库，
    // 关联缺失可 Phase 10 浏览页手动补；dup_id 已与 draft 行共存亡（B-2 在 createExperience 内保证）
    for (const did of deviceIds) {
      try { relateDevice(exp.id, did, 'primary') } catch { /* 设备关联失败不阻塞 draft 入库，日志兜底 */ }
    }
    if (d.duplication_verdict === 'ADD') {
      created.push({ exp_id: exp.id, title: exp.title, category: exp.category })
    } else {
      // UPDATE：duplicate_of_exp_id 已由 createExperience 单语句原子写入 v9 新列（B-1 门面 + B-2 原子）
      updated.push({ exp_id: exp.id, title: exp.title, category: exp.category, duplicate_of_exp_id: d.duplicate_of_exp_id || '' })
    }
  }

  return { empty: false, demoMode: false, created, updated, noop }
}
