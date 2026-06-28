import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import type { PaginatedResult } from '../../src/types/pagination'

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
      // WR-02：先转义全部正则元字符，再把通配符 '*' 还原为 '.*'。否则用户输入含 `(`/`[`/`+` 等字符的规则
      // 会让 new RegExp 抛 SyntaxError（被外层吞错 → 该 IP 静默跳过丢数据）或静默误配（字符集等语义偏差）。
      const escaped = w.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      const regex = new RegExp('^' + escaped + '$')
      if (regex.test(ip)) return true
    }
    return false
  }

  // WR-04：镜像 networkSegmentService.ipInCIDR（line 123-131）的健壮实现——畸形 CIDR/IP 返回 false，
  // 避免一条畸形 cidr 规则（如 `192.168.1.0/` 或 `notacidr/8`）让 (NaN & mask)===(NaN & mask) 恒为 true，
  // 误判所有 IP 已排除 → processARPEntries 对所有 IP continue → ARP 处理整体失效。
  private static ipInCIDR(ip: string, cidr: string): boolean {
    const [network, prefixStr] = cidr.split('/')
    const prefix = parseInt(prefixStr, 10)
    const ipNum = this.ipToNumber(ip)
    const networkNum = this.ipToNumber(network)
    if (ipNum === null || networkNum === null || isNaN(prefix) || prefix < 0 || prefix > 32) return false
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
    return (ipNum & mask) === (networkNum & mask)
  }

  // WR-04：非法 IP（非 4 段 / 段值非 0-255 整数）返回 null，供 ipInCIDR 判定。>>>0 规范化为无符号 32 位。
  private static ipToNumber(ip: string): number | null {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
    return ((parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
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
    // WR-01：每条目的写逻辑用嵌套事务（better-sqlite3 的 db.transaction 嵌套自动用 SAVEPOINT 实现）包裹。
    // 这样单条目中途失败（例：UPDATE is_active=0 已执行但 createBinding 因 UNIQUE 冲突 + fallback UPDATE 失败而抛错）
    // 会被 entryTx 自动 ROLLBACK TO savepoint 回滚到该条起点（含已执行的 is_active=0），由外层 try/catch 捕获后 continue。
    // —— 修正原实现"单条部分写入被整批 COMMIT 静默持久化"的数据完整性 bug（MAC 变更场景：旧 binding 停用但新 binding 未建，
    // 后续扫描持续走 ip_reused 误报路径）。条目级 try/catch 保留 = D-P2 红线（单条失败不 ROLLBACK 整批）。
    const entryTx = db.transaction((entry: { ip: string; mac: string }) => {
      const { ip, mac } = entry
      if (this.isIPExcludedCached(ip, excluded)) return

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
    })

    const runBatch = db.transaction(() => {
      for (const entry of entries) {
        // 条目级 try/catch（D-P2 红线）：entryTx 抛错 → better-sqlite3 自动 ROLLBACK TO savepoint（该条目整体回滚）→
        // 被捕获后 continue，不让 throw 冒泡到 transaction 回调触发整批 ROLLBACK（与改造前"尽力而为"语义一致）
        try {
          entryTx(entry)
        } catch (e: any) {
          // T-03-02：失败 ip 与原因记录，不静默吞错。savepoint 已回滚该条全部写入，整批继续。
          console.error('[anomaly] processARPEntries 条目处理失败:', entry.ip, e.message)
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
    // 事务边界：getDatabase() 返回模块级单例 db，processARPEntries 事务内的调用自动落入同一事务（better-sqlite3 单连接同步）
    const db = getDatabase()
    try {
      const result = db.prepare('INSERT INTO ip_mac_changes (ip, old_mac, new_mac, change_type, detected_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(ip, oldMac, newMac, changeType)
      return { id: result.lastInsertRowid as number, ip, oldMac, newMac, changeType, detectedAt: new Date().toISOString(), acknowledged: false, acknowledgedAt: null, notes: null }
    } catch (e: any) { console.error('[anomaly] recordChange 插入失败:', ip, e.message); return null }
  }

  static getChanges(unacknowledgedOnly: boolean = false, limit: number = 100, offset: number = 0): PaginatedResult<any> {
    const db = getDatabase()
    // DATA-01 / D-4-1：补 OFFSET ?（prepared statement 绑定，T-04-02 防 SQL 注入）。total 单独 COUNT（带相同 WHERE 条件）。
    let query = 'SELECT id, ip, old_mac as oldMac, new_mac as newMac, change_type as changeType, detected_at as detectedAt, acknowledged, acknowledged_at as acknowledgedAt, notes FROM ip_mac_changes'
    let countQuery = 'SELECT COUNT(*) as c FROM ip_mac_changes'
    if (unacknowledgedOnly) {
      query += ' WHERE acknowledged = 0'
      countQuery += ' WHERE acknowledged = 0'
    }
    query += ' ORDER BY detected_at DESC LIMIT ? OFFSET ?'
    const rows = (db.prepare(query).all(limit, offset) as any[]).map(row => ({ ...row, acknowledged: row.acknowledged === 1 }))
    const total = (db.prepare(countQuery).get() as { c: number }).c
    return { rows, total, truncated: rows.length < total }
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
