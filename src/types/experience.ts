// Phase 7 (07-02)：Experience DTO，字段严格反推自 experienceService 返回 + IPC 调用面。
// D-5-3「缺 DTO 就近补」，DB 行原生字段保留下划线（非驼峰），与消费面一致。
// service 层 rowToExperience 已 decField 回填 attrs 并 delete attrs_enc，故 Experience 不含密文列。

import type { PaginatedResult } from './pagination'

export type ExperienceCategory = 'troubleshooting' | 'best_practices' | 'product' | 'env'
export type ExperienceStatus = 'draft' | 'confirmed' | 'published' | 'invalid'

/** troubleshooting 类深度字段（其他类轻结构，attrs 可为空） */
export interface ExperienceAttrs {
  symptoms?: string
  root_cause?: string
  resolution?: string
  prevention?: string
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'
}

/** experience:create 入参（对齐 experienceService.createExperience） */
export interface ExperienceInput {
  title: string
  category: ExperienceCategory
  content: string
  tags?: string[]
  sourceSessionId?: string | null
  attrs?: ExperienceAttrs | null
}

/** experience:update 入参（白名单字段，对齐 experienceService.updateExperience 的 ExperienceUpdateFields）。
 * CR-01 收紧：移除 status / validAt / invalidAt / lastVerifiedAt / reuseCount 五个审计/状态字段。
 * - status / invalid_at：只能经 experience:invalidate 软失效入口
 * - reuse_count：只能经 incReuseCount（Phase 11 暴露 IPC 后）
 * - last_verified_at：只能经 touchLastVerifiedAt（Phase 11 暴露 IPC 后）
 * - valid_at：仅 create 时 DB 默认值生成，不可改 */
export interface ExperienceUpdateInput {
  title?: string
  category?: ExperienceCategory
  content?: string
  tags?: string[]
  attrs?: ExperienceAttrs | null
}

/** experience:list 入参（对齐 experienceService.ListExperiencesOpts） */
export interface ExperienceListInput {
  category?: ExperienceCategory
  status?: ExperienceStatus
  deviceId?: string
  includeInvalid?: boolean
  limit?: number
  offset?: number
}

/** DB 行原生 snake_case（service 层 attrs_enc 已解密回填 attrs 并 delete 密文列） */
export interface Experience {
  id: string
  title: string
  category: ExperienceCategory
  content: string
  tags: string[]              // JSON.parse 后
  status: ExperienceStatus
  source_session_id?: string | null
  attrs?: ExperienceAttrs | null
  valid_at: string
  invalid_at?: string | null
  last_verified_at?: string | null
  reuse_count: number
  created_at: string
  updated_at: string
  /** Phase 8 v9 列：UPDATE 草稿命中的存量旧条目 id（draft 态标注，Phase 9 确认时据此显 supersedeOld Checkbox）。
   * 全量 SELECT 运行时已带此列，DTO 补声明对齐 rowToExperience 返参。 */
  duplicate_of_exp_id?: string | null
}

/** 复用全仓分页信封（DATA-01 / D-4-2），渲染层读 .rows/.total/.truncated */
export type ExperienceListResult = PaginatedResult<Experience>

/**
 * experience:listDevices 返回的关联设备。
 * WR-05：service listDevicesByExperience 改走 deviceService.getDeviceById（rowToDevice
 * 安全白名单映射），返回的是标准 Device DTO（显式字段，密文经 device MK 解密为明文）。
 * 复用 Device 类型替代原开放索引签名 `[key: string]: unknown`，未来 devices 新增非 `_enc`
 * 敏感列不会静默泄露（device 域 rowToDevice 控制投影白名单）。
 */
import type { Device } from './device'
export type ExperienceRelatedDevice = Device

/**
 * experience:summarizeSession 返回（Phase 8 Plan 03）。
 * renderer 不收会话原文，仅收 draft 落库结果（exp_id/title/category + NOOP 提示）。
 * 字段对齐 service 层 experienceDrafting.DraftingResult，不加冗余字段
 * （draftSession/judgeVerdicts 失败即 throw 经 secure 脱敏透出，不静默返 retryExhausted）。
 */
export interface DraftingResult {
  empty: boolean
  demoMode: boolean
  created: Array<{ exp_id: string; title: string; category: ExperienceCategory }>
  updated: Array<{ exp_id: string; title: string; category: ExperienceCategory; duplicate_of_exp_id: string }>
  noop: Array<{ duplicate_of_exp_id: string; reasoning: string }>
}

/**
 * experience:confirmDrafts 入参（Phase 9，对齐 service 层 experienceService.ConfirmDraftItem）。
 * fields 复用 ExperienceUpdateInput（CR-01 白名单，不含 status）；renderer 入参 camelCase，
 * service 层 fields 类型 ExperienceUpdateFields 与 ExperienceUpdateInput 同构（同 5 个可选字段，
 * TS 结构化类型兼容）。supersedeOld：D-9-2，UPDATE 草稿专用，默认 false
 * （防 AI 误判 UPDATE 实为 ADD 误删旧条目）。
 */
export interface ConfirmDraftItem {
  expId: string
  action: 'adopt' | 'discard'
  fields?: ExperienceUpdateInput
  relateDevices?: string[]
  supersedeOld?: boolean
}
export interface ConfirmDraftsInput { drafts: ConfirmDraftItem[] }

/** experience:confirmDrafts 返回（采纳/丢弃/标失效计数）。 */
export interface ConfirmDraftsResult { adopted: number; discarded: number; superseded: number }

/** experience:listDrafts 返回（draft 态 Experience 列表，复用现有 Experience DTO）。 */
export type DraftSummary = Experience

/**
 * experience:getSessionMessages 返回（原始会话明文消息数组，design D-04 明文回链 renderer）。
 * 字段对齐 ai.ts getChatHistory 返回形态（DB 行返原生 snake_case 保留，见文件头注释约定）。
 */
export interface SessionMessage {
  id: string
  role: string
  content: string
  deviceId: string | null
  createdAt: string
}
