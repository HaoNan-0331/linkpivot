/**
 * DATA-01 / D-4-4：共享分页参数校验 helper。
 *
 * 复用 anomalyIpc.ts:7-11 既有 validateLimit 先例模式：
 * Number.isInteger + 范围校验 + 非法/超界 → 落回默认值（非钳到 ceiling）。
 * 理由：与既有先例行为统一，且默认值本身已是安全有界值。
 *
 * 网关层校验，service 层只接收安全值（不信 renderer）。
 */

/**
 * 校验 limit 参数：非法 / 超界 / 非整数 → 落回 defaultValue。
 *
 * @param limit renderer 传入的原始 limit（untrusted）
 * @param defaultValue 通道默认 cap（如 getIPDetails 2000 / oui 5000 / anomaly 100）
 * @param maxCeiling 通道硬上限（如 50000 / 10000）
 * @returns 安全的 limit 整数
 */
export function validateLimit(limit: unknown, defaultValue: number, maxCeiling: number): number {
  const n = Number(limit)
  if (!Number.isInteger(n) || n < 1 || n > maxCeiling) return defaultValue
  return n
}

/**
 * 校验 offset 参数：非法 / 负数 / 非整数 → 落回 0。
 *
 * @param offset renderer 传入的原始 offset（untrusted）
 * @returns 安全的 offset 整数（>= 0）
 */
export function validateOffset(offset: unknown): number {
  const n = Number(offset)
  if (!Number.isInteger(n) || n < 0) return 0
  return n
}
