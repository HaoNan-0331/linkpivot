export interface OUIEntry {
  id: number
  ouiPrefix: string
  vendorName: string
  isCustom: boolean
  createdAt: string
  updatedAt: string
}

/**
 * OUI IPC 真实返回行（FE-02 / D-5-3 缺 DTO 就近补）。
 * ouiService.getAll/search/getById 直接 SELECT 返回 snake_case 原始 DB 行
 * （oui_prefix / vendor_name / is_custom / created_at / updated_at），
 * 未做 camelCase 映射。OuiTab.tsx 读 record.oui_prefix / record.is_custom 等，
 * 故 IPC 契约用本 OUIRow（而非 OUIEntry，后者是 domain 概念的 camelCase 形态）。
 */
export interface OUIRow {
  id: number
  oui_prefix: string
  vendor_name: string
  is_custom: number
  created_at: string
  updated_at: string
}

export interface CreateOUIInput {
  ouiPrefix: string
  vendorName: string
}

export interface UpdateOUIInput {
  id: number
  ouiPrefix?: string
  vendorName?: string
}

export interface OUIStats {
  total: number
  custom: number
  vendors: number
}

export interface ScheduleConfig {
  id: number
  enabled: boolean
  intervalMinutes: number
  /** ARP 历史保留天数（D-07）：0=永不删除；v13 列 DEFAULT 90 兜底 */
  retentionDays: number
  lastRun: string | null
  nextRun: string | null
}

export interface SchedulerStatus {
  isRunning: boolean
  isTaskRunning: boolean
  config: ScheduleConfig
}

export interface UpdateScheduleInput {
  enabled?: boolean
  intervalMinutes?: number
  /** ARP 历史保留天数（D-07）：0=永不删除 */
  retentionDays?: number
}
