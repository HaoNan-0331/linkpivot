/**
 * IPv4 数值化 + CIDR 归属判定单一来源。
 *
 * 纯提取自 networkSegmentService.ts / anomalyService.ts / exportService.ts 三份逐字等价的
 * private static 实现（TXN-05 收敛地基），函数体逐字照搬，零语义改动。
 */

/** IP 转数值（非 4 段 / 段值非 0-255 整数返回 null），>>>0 规范化为无符号 32 位。 */
export function ipToNumber(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return ((parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

/**
 * 判断 ip 是否落在 cidr 网段内。
 * 畸形 CIDR/IP 返回 false（WR-04：防畸形规则如 `192.168.1.0/` 或 `notacidr/8` 让
 * (NaN & mask)===(NaN & mask) 恒为 true，误判所有 IP 已包含/已排除 → 全排除失效）。
 */
export function ipInCIDR(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr, 10)
  const ipNum = ipToNumber(ip)
  const netNum = ipToNumber(network)
  if (ipNum === null || netNum === null || isNaN(prefix) || prefix < 0 || prefix > 32) return false
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
  return (ipNum & mask) === (netNum & mask)
}
