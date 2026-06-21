import { getDatabase } from '../database/connection'
import { OUIService } from './ouiService'

export class NetworkSegmentService {
  static getAll(): any[] {
    const db = getDatabase()
    return (db.prepare('SELECT id, name, network, mask, cidr, gateway, description, is_auto_discovered, created_at, updated_at FROM network_segments ORDER BY created_at DESC').all() as any[])
      .map(row => ({ ...row, isAutoDiscovered: row.is_auto_discovered === 1 }))
  }

  static getById(id: number): any {
    const row = getDatabase().prepare('SELECT id, name, network, mask, cidr, gateway, description, is_auto_discovered, created_at, updated_at FROM network_segments WHERE id = ?').get(id) as any
    if (!row) return null
    return { ...row, isAutoDiscovered: row.is_auto_discovered === 1 }
  }

  static create(input: { name: string; network: string; mask: string; gateway?: string; description?: string }): any {
    const db = getDatabase()
    const cidr = this.maskToCIDR(input.mask)
    const result = db.prepare('INSERT INTO network_segments (name, network, mask, cidr, gateway, description) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.name, input.network, input.mask, cidr, input.gateway || null, input.description || null)
    return this.getById(result.lastInsertRowid)
  }

  static update(input: { id: number; name?: string; network?: string; mask?: string; gateway?: string; description?: string }): any {
    const db = getDatabase()
    const updates: string[] = []
    const values: any[] = []
    if (input.name !== undefined) { updates.push('name = ?'); values.push(input.name) }
    if (input.network !== undefined) { updates.push('network = ?'); values.push(input.network) }
    if (input.mask !== undefined) { updates.push('mask = ?', 'cidr = ?'); values.push(input.mask, this.maskToCIDR(input.mask)) }
    if (input.gateway !== undefined) { updates.push('gateway = ?'); values.push(input.gateway) }
    if (input.description !== undefined) { updates.push('description = ?'); values.push(input.description) }
    if (updates.length === 0) return this.getById(input.id)
    updates.push('updated_at = CURRENT_TIMESTAMP'); values.push(input.id)
    db.prepare(`UPDATE network_segments SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    return this.getById(input.id)
  }

  static delete(id: number): void {
    getDatabase().prepare('DELETE FROM network_segments WHERE id = ?').run(id)
  }

  static autoDiscover(): any[] {
    const db = getDatabase()
    const arpEntries = db.prepare('SELECT DISTINCT ip FROM arp_entries ORDER BY ip').all() as any[]
    if (arpEntries.length === 0) return []

    const segments = new Map<string, { ips: string[]; count: number }>()
    for (const entry of arpEntries) {
      const parts = entry.ip.split('.')
      const network = `${parts[0]}.${parts[1]}.${parts[2]}.0`
      if (!segments.has(network)) segments.set(network, { ips: [], count: 0 })
      segments.get(network)!.ips.push(entry.ip)
      segments.get(network)!.count++
    }

    const existingNetworks = new Set(this.getAll().map((s: any) => s.network))
    const discovered: any[] = []

    for (const [network, data] of segments) {
      if (!existingNetworks.has(network) && data.count >= 2) {
        try {
          const result = db.prepare('INSERT INTO network_segments (name, network, mask, cidr, description, is_auto_discovered) VALUES (?, ?, ?, ?, ?, 1)')
            .run(`自动发现-${network}/24`, network, '255.255.255.0', 24, `自动发现，包含 ${data.count} 个IP地址`)
          const segment = this.getById(result.lastInsertRowid)
          if (segment) discovered.push(segment)
        } catch { /* ignore duplicate */ }
      }
    }
    return discovered
  }

  static getIPUsage(networkId: number): { networkId: number; total: number; used: number; available: number; usagePercent: number } {
    const segment = this.getById(networkId)
    if (!segment) return { networkId, total: 0, used: 0, available: 0, usagePercent: 0 }
    const db = getDatabase()
    const total = Math.pow(2, 32 - segment.cidr) - 2
    const cidr = `${segment.network}/${segment.cidr}`
    // 真实 CIDR 匹配（替代前3段 LIKE），修正 /16 等非 /24 网段的跨段误计
    const rows = db.prepare("SELECT ip FROM ip_status WHERE status = 'used'").all() as Array<{ ip: string }>
    const used = rows.filter((r) => this.ipInCIDR(r.ip, cidr)).length
    const available = Math.max(0, total - used)
    const usagePercent = total > 0 ? Math.round((used / total) * 100) : 0
    return { networkId, total, used, available, usagePercent }
  }

  static getIPDetails(networkId: number, searchIp?: string, searchMac?: string, sortBy: string = 'ip', sortOrder: string = 'asc'): any[] {
    const segment = this.getById(networkId)
    if (!segment) return []
    const db = getDatabase()
    const cidr = `${segment.network}/${segment.cidr}`
    const sortColumnMap: Record<string, string> = { ip: 'ips.ip', mac: 'ips.mac', lastSeen: 'ips.last_seen' }
    const safeSortBy = sortColumnMap[sortBy] || 'ips.ip'
    const safeSortOrder = sortOrder === 'desc' ? 'DESC' : 'ASC'
    // 去掉前3段 LIKE 条件：SQL 返回全部 + JOIN 并排序，JS 端按真实 CIDR 过滤（保持 SQL 排序顺序）
    const query = `SELECT ips.ip, ips.mac, ips.status, ips.last_seen as collectedAt, arp.interface, arp.device_id as deviceName
      FROM ip_status ips
      LEFT JOIN (SELECT ip, interface, device_id, ROW_NUMBER() OVER (PARTITION BY ip ORDER BY collected_at DESC) as rn FROM arp_entries) arp ON arp.ip = ips.ip AND arp.rn = 1
      ORDER BY ${safeSortBy} ${safeSortOrder}`
    let rows = (db.prepare(query).all() as any[]).filter((r) => this.ipInCIDR(r.ip, cidr))
    if (searchIp) rows = rows.filter((r) => r.ip?.includes(searchIp))
    if (searchMac) rows = rows.filter((r) => r.mac?.includes(searchMac))
    return rows.map((entry) => ({
      ip: entry.ip, mac: entry.mac, status: entry.status, lastSeen: entry.collectedAt,
      interface: entry.interface, deviceName: entry.deviceName || undefined,
      macVendor: entry.mac ? (OUIService.getVendor(entry.mac) === 'Unknown' ? undefined : OUIService.getVendor(entry.mac)) : undefined,
    }))
  }

  /** IP 转数值（非法返回 null），用 >>>0 规范化为无符号 32 位。 */
  private static ipToNumber(ip: string): number | null {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
    return ((parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
  }

  /** 判断 ip 是否落在 cidr 网段内（替代前3段 LIKE 的跨网段误判）。 */
  private static ipInCIDR(ip: string, cidr: string): boolean {
    const [network, prefixStr] = cidr.split('/')
    const prefix = parseInt(prefixStr, 10)
    const ipNum = this.ipToNumber(ip)
    const netNum = this.ipToNumber(network)
    if (ipNum === null || netNum === null || isNaN(prefix) || prefix < 0 || prefix > 32) return false
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
    return (ipNum & mask) === (netNum & mask)
  }

  private static maskToCIDR(mask: string): number {
    return mask.split('.').reduce((cidr, p) => cidr + (parseInt(p, 10).toString(2).match(/1/g) || []).length, 0)
  }
}
