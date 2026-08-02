import { listExperiences, MAX_BATCH } from './experienceService'
import type { ExperienceCategory } from './experienceService'

/**
 * 查重 service（Phase 8 D-02）。
 * 起草前查存量候选，喂起草 LLM 判 ADD/UPDATE/NOOP。
 *
 * D-02 策略：
 * - 草稿关联设备 → 查「同 category + 同 deviceId（任一）」有效存量
 * - 无设备关联 → 查「同 category 全库」
 * - 喂 AI 形式 = 「标题 + 内容前 150 字摘要 + exp_id」列表
 * - 无硬相似度阈值（信任 LLM 判定，红线③ 人工确认兜底）
 * - 自动过滤已失效（includeInvalid=false，复用 listExperiences bi-temporal 过滤）
 *
 * 函数式（无 class、无 MK 持有）——本 service 不读写加密列，
 * 只经 experienceService.listExperiences 聚合，与 CONVENTIONS Pattern 1b（无加密列 service）一致。
 */

const PREVIEW_LEN = 150

export interface FindExistingInput {
  category: ExperienceCategory
  deviceIds?: string[]
}

export interface ExistingExperienceSummary {
  exp_id: string
  title: string
  content_preview: string
}

/** 查同分类+设备（或全库）有效存量，返回「标题+前150字摘要+exp_id」列表供起草 LLM 判定。 */
export function findExistingForDraft(input: FindExistingInput): ExistingExperienceSummary[] {
  const { category, deviceIds } = input
  const has = Array.isArray(deviceIds) && deviceIds.length > 0

  const seen = new Map<string, ExistingExperienceSummary>()

  const collect = (rows: any[]): void => {
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.set(r.id, {
        exp_id: r.id,
        title: r.title || '',
        content_preview: typeof r.content === 'string' ? r.content.slice(0, PREVIEW_LEN) : '',
      })
    }
  }

  if (has) {
    for (const did of deviceIds!) {
      const res = listExperiences({ category, deviceId: did, includeInvalid: false, limit: MAX_BATCH, offset: 0 })
      collect(res.rows)
    }
  } else {
    const res = listExperiences({ category, includeInvalid: false, limit: MAX_BATCH, offset: 0 })
    collect(res.rows)
  }

  return Array.from(seen.values())
}
