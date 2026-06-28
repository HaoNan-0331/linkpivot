/**
 * 分页信封类型（renderer + main 共用）。
 *
 * DATA-01 / D-4-2：list 通道返回值由裸数组 any[] 改为信封对象，明确告知截断，
 * 运维不静默漏看 rogue 设备/IP（核心价值：设备安全可控）。
 *
 * 字段口径：
 * - rows: 当前页（或截断后）的结果数组
 * - total: 应用 search/filter 后、应用 limit 前的总数（前置过滤总数）
 * - truncated: rows.length < total（本次 rows 是否被 cap 截断）
 */
export interface PaginatedResult<T> {
  rows: T[]
  /** 过滤后、应用 limit 前的总数 */
  total: number
  /** rows 是否被 cap 截断（rows.length < total） */
  truncated: boolean
}
