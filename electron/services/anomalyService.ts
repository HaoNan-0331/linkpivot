import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'

export type ChangeType = 'mac_changed' | 'new_ip' | 'ip_reused'

export interface IPMACChange {
  id: number; ip: string; oldMac: string | null; newMac: string | null
  changeType: ChangeType; detectedAt: string; acknowledged: boolean
  acknowledgedAt: string | null; notes: string | null
}

// excluded_ips 预载结构：普通 IP 入 Set（O(1) 命中），CIDR/通配分别入数组（数量少，线性 some 判定）
type ExcludedRules = { ips: Set<string>; cidrs: string[]; wildcards: string[] }

export class AnomalyService {
  private static isIPExcluded(ip: string): boolean {
    // 单次调用点：预载 + 内存判定（checkIPExcluded 走此路径，不再每行全表扫）
    return this.isIPExcludedCached(ip, this.preloadExcludedSet(getDatabase()))
  }

  // 事务前一次性预载 excluded_ips 为内存结构，消除 processARPEntries 循环内 N+1 全表扫（D-P2）
  private static preloadExcludedSet(db: Database.Database): ExcludedRules {
    const rules = db.prepare('SELECT ip_or_cidr FROM excluded_ips').all() as Array<{ ip_or_cidr: string }>
    const excluded: ExcludedRules = { ips: new Set<string>(), cidrs: [], wildcards: [] }
    for (const rule of rules) {
      const pattern = rule.ip_or_cidr
      if (pattern.includes('/')) excluded.cidrs.push(pattern)
      else if (pattern.includes('*')) excluded.wildcards.push(pattern)
      else excluded.ips.add(pattern)
    }
    return excluded
  }

  // 循环内纯内存判定：Set O(1) 命中 + CIDR/通配数组线性 some（规则数通常很少）
  private static isIPExcludedCached(ip: string, excluded: ExcludedRules): boolean {
    if (excluded.ips.has(ip)) return true
    if (excluded.cidrs.some(c => this.ipInCIDR(ip, c))) return true
    for (const w of excluded.wildcards) {
      const regex = new RegExp('^' + w.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
      if (regex.test(ip)) return true
    }
    return false
  }

  private static ipInCIDR(ip: string, cidr: string): boolean {
    const [network, prefixLength] = cidr.split('/')
    const prefix = parseInt(prefixLength, 10)
    const ipNum = this.ipToNumber(ip)
    const networkNum = this.ipToNumber(network)
    const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0
    return (ipNum & mask) === (networkNum & mask)
  }

  private static ipToNumber(ip: string): number {
    const parts = ip.split('.').map(Number)
    return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  }

  static processARPEntries(entries: Array<{ ip: string; mac: string }>): IPMACChange[] {
    const db = getDatabase()
    const changes: IPMACChange[] = []
    const now = new Date().toISOString()

    // excluded 预载放事务外（D-P2 / T-03-04：避免预载 SELECT 与写混在同一事务增加锁持有时间）
    const excluded = this.preloadExcludedSet(db)

    // 4 个 prepared statement 提到循环外复用（D-P2：消除循环内重复解析）
    const stmtCurrentBinding = db.prepare('SELECT id, mac FROM ip_mac_bindings WHERE ip = ? AND is_active = 1')
    const stmtDeactivate = db.prepare('UPDATE ip_mac_bindings SET is_active = 0 WHERE id = ?')
    const stmtUpdateLastSeen = db.prepare('UPDATE ip_mac_bindings SET last_seen = ? WHERE id = ?')
    const stmtOldBinding = db.prepare('SELECT mac FROM ip_mac_bindings WHERE ip = ? ORDER BY last_seen DESC LIMIT 1')

    // 整批单事务：一次 COMMIT 替代逐条 autocommit（D-P2 / init.ts:346 先例）
    const runBatch = db.transaction(() => {
      for (const entry of entries) {
        const { ip, mac } = entry
        // 条目级 try/catch（D-P2 红线）：单条失败捕获后 continue，不让 throw 冒泡到 transaction 回调触发整批 ROLLBACK
        // —— 与改造前 recordChange/createBinding 吞错"尽力而为"语义一致（PROJECT.md 向后兼容红线）
        try {
          if (this.isIPExcludedCached(ip, excluded)) continue

          const currentBinding = stmtCurrentBinding.get(ip) as { id: number; mac: string } | undefined

          if (currentBinding) {
            if (currentBinding.mac !== mac) {
              const change = this.recordChange(ip, currentBinding.mac, mac, 'mac_changed')
              if (change) changes.push(change)
              stmtDeactivate.run(currentBinding.id)
              this.createBinding(db, ip, mac, now)
            } else {
              stmtUpdateLastSeen.run(now, currentBinding.id)
            }
          } else {
            const oldBinding = stmtOldBinding.get(ip) as { mac: string } | undefined
            if (oldBinding) {
              const change = this.recordChange(ip, null, mac, 'ip_reused')
              if (change) changes.push(change)
            }
            this.createBinding(db, ip, mac, now)
          }
        } catch (e: any) {
          // T-03-02：失败 ip 与原因记录，不静默吞错
          console.error('[anomaly] processARPEntries 条目处理失败:', ip, e.message)
          continue
        }
      }
    })
    runBatch()

    return changes
  }

  private static createBinding(db: any, ip: string, mac: string, now: string): void {
    try {
      db.prepare('INSERT INTO ip_mac_bindings (ip, mac, first_seen, last_seen, is_active) VALUES (?, ?, ?, ?, 1)').run(ip, mac, now, now)
    } catch {
      db.prepare('UPDATE ip_mac_bindings SET last_seen = ?, is_active = 1 WHERE ip = ? AND mac = ?').run(now, ip, mac)
    }
  }

  private static recordChange(ip: string, oldMac: string | null, newMac: string | null, changeType: ChangeType): IPMACChange | null {
    const db = getDatabase()
    try {
      const result = db.prepare('INSERT INTO ip_mac_changes (ip, old_mac, new_mac, change_type, detected_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(ip, oldMac, newMac, changeType)
      return { id: result.lastInsertRowid as number, ip, oldMac, newMac, changeType, detectedAt: new Date().toISOString(), acknowledged: false, acknowledgedAt: null, notes: null }
    } catch (e: any) { console.error('[anomaly] recordChange 插入失败:', ip, e.message); return null }
  }

  static getChanges(unacknowledgedOnly: boolean = false, limit: number = 100): any[] {
    const db = getDatabase()
    let query = 'SELECT id, ip, old_mac as oldMac, new_mac as newMac, change_type as changeType, detected_at as detectedAt, acknowledged, acknowledged_at as acknowledgedAt, notes FROM ip_mac_changes'
    if (unacknowledgedOnly) query += ' WHERE acknowledged = 0'
    query += ' ORDER BY detected_at DESC LIMIT ?'
    return (db.prepare(query).all(limit) as any[]).map(row => ({ ...row, acknowledged: row.acknowledged === 1 }))
  }

  static acknowledgeChange(id: number, notes?: string): void {
    getDatabase().prepare('UPDATE ip_mac_changes SET acknowledged = 1, acknowledged_at = datetime(\'now\'), notes = ? WHERE id = ?').run(notes || null, id)
  }

  static acknowledgeAll(): number {
    return getDatabase().prepare('UPDATE ip_mac_changes SET acknowledged = 1, acknowledged_at = datetime(\'now\') WHERE acknowledged = 0').run().changes
  }

  static deleteChange(id: number): void {
    getDatabase().prepare('DELETE FROM ip_mac_changes WHERE id = ?').run(id)
  }

  static deleteChanges(ids: number[]): number {
    const placeholders = ids.map(() => '?').join(',')
    return getDatabase().prepare(`DELETE FROM ip_mac_changes WHERE id IN (${placeholders})`).run(...ids).changes
  }

  static getStats(): { total: number; unacknowledged: number; macChanged: number; newIp: number; ipReused: number } {
    const db = getDatabase()
    return {
      total: (db.prepare('SELECT COUNT(*) as count FROM ip_mac_changes').get() as any).count,
      unacknowledged: (db.prepare('SELECT COUNT(*) as count FROM ip_mac_changes WHERE acknowledged = 0').get() as any).count,
      macChanged: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'mac_changed'").get() as any).count,
      newIp: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'new_ip'").get() as any).count,
      ipReused: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'ip_reused'").get() as any).count,
    }
  }

  static getBindingHistory(ip: string): any[] {
    const rows = getDatabase().prepare('SELECT id, ip, mac, first_seen as firstSeen, last_seen as lastSeen, is_active as isActive FROM ip_mac_bindings WHERE ip = ? ORDER BY last_seen DESC').all(ip) as any[]
    return rows.map(row => ({ ...row, isActive: row.isActive === 1 }))
  }

  static getExcludedIPs(): any[] {
    return getDatabase().prepare('SELECT id, ip_or_cidr as ipOrCidr, description, created_at as createdAt FROM excluded_ips ORDER BY created_at DESC').all()
  }

  static addExcludedIP(input: { ipOrCidr: string; description?: string }): any {
    const result = getDatabase().prepare('INSERT INTO excluded_ips (ip_or_cidr, description) VALUES (?, ?)').run(input.ipOrCidr, input.description || null)
    return { id: result.lastInsertRowid, ipOrCidr: input.ipOrCidr, description: input.description || null, createdAt: new Date().toISOString() }
  }

  static deleteExcludedIP(id: number): void {
    getDatabase().prepare('DELETE FROM excluded_ips WHERE id = ?').run(id)
  }

  static checkIPExcluded(ip: string): boolean {
    return this.isIPExcluded(ip)
  }
}
