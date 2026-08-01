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
