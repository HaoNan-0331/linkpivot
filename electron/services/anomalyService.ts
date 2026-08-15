import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { ipInCIDR } from '../utils/ipMath'
import type { PaginatedResult } from '../../src/types/pagination'

export type ChangeType = 'mac_changed' | 'new_ip' | 'ip_reused'

// 默认走生产单例 db；测试经 _setAnomalyDbGetter 注入 realDb（D-14-4 借 Phase 12 回归网范式，
// 镜像 experienceService._setExperienceDbGetter D-7-8）。生产路径 dbGetter 默认 = getDatabase 单例，
// 行为零变化（红线① anomaly:* IPC 仍 secure 包装不变，本注入口仅 main 进程测试代码可调，
// 无 IPC channel 暴露给 renderer）。
let dbGetter: () => Database.Database = getDatabase

/** @internal 测试专用：注入 db getter（生产不调用）。 */
export function _setAnomalyDbGetter(fn: () => Database.Database): void {
  dbGetter = fn
}

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
    return this.isIPExcludedCached(ip, this.preloadExcludedSet(dbGetter()))
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
    if (excluded.cidrs.some(c => ipInCIDR(ip, c))) return true
    for (const w of excluded.wildcards) {
      // WR-02：先转义全部正则元字符，再把通配符 '*' 还原为 '.*'。否则用户输入含 `(`/`[`/`+` 等字符的规则
      // 会让 new RegExp 抛 SyntaxError（被外层吞错 → 该 IP 静默跳过丢数据）或静默误配（字符集等语义偏差）。
      const escaped = w.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      const regex = new RegExp('^' + escaped + '$')
      if (regex.test(ip)) return true
    }
    return false
  }

  static processARPEntries(entries: Array<{ ip: string; mac: string }>): IPMACChange[] {
    const db = dbGetter()
    const changes: IPMACChange[] = []
    const now = new Date().toISOString()

    // excluded 预载放事务外（D-P2 / T-03-04：避免预载 SELECT 与写混在同一事务增加锁持有时间）
    const excluded = this.preloadExcludedSet(db)

    // 4 个 prepared statement 提到循环外复用（D-P2：消除循环内重复解析）
    const stmtCurrentBinding = db.prepare('SELECT id, mac FROM ip_mac_bindings WHERE ip = ? AND is_active = 1')
    const stmtDeactivate = db.prepare('UPDATE ip_mac_bindings SET is_active = 0 WHERE id = ?')
    const stmtUpdateLastSeen = db.prepare('UPDATE ip_mac_bindings SET last_seen = ? WHERE id = ?')
    const stmtOldBinding = db.prepare('SELECT mac FROM ip_mac_bindings WHERE ip = ? ORDER BY last_seen DESC LIMIT 1')

    // BUG-1（D-14-1）首次基线判定：库里有任意 is_baseline=1 行 = 基线已建。
    // 入口读一次（本次整批扫描期间基线状态不变），runBatch 结束后统一置基线（避免本批次中途 IP 一边建 binding 一边报 new_ip 不一致）。
    // 遗留库（升级前已有历史 binding 行，user_version≤11 经 v12 迁移加列默认 is_baseline=0）首次扫描时 hasBaseline=false，
    // 后置基线 UPDATE 会把所有现存存量行也置 1（向后兼容语义见下方后置 UPDATE 注释）。
    const hasBaseline = (db.prepare('SELECT 1 FROM ip_mac_bindings WHERE is_baseline = 1 LIMIT 1').get() as undefined | { 1: 1 }) !== undefined

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
        // BUG-1（D-14-1）补 recordChange('new_ip')：else 分支（currentBinding 与 oldBinding 都不存在 = 全新 IP）
        // 原本只 createBinding 缺 new_ip 告警，致 getStats().newIp 恒零。现补齐，但用 hasBaseline 门控——
        // 首次扫描（hasBaseline=false）只建 binding 不报 new_ip（建基线，防首次全量扫描刷屏）；
        // 基线后（hasBaseline=true）新增 IP 才报 new_ip 落 ip_mac_changes。
        // 遗留库（向后兼容，CLAUDE.md「迁移改动必须向后兼容历史数据」硬约束）：遗留库存量 IP 升级后首次扫描时走
        // 上方 currentBinding 分支（存量 active binding 命中），**不进此 else 分支**，故存量 IP 不被误报为 new_ip（Test 6 (a) 佐证）。
        if (hasBaseline) {
          const change = this.recordChange(ip, null, mac, 'new_ip')
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
      // CR-02 fix（code-review BLOCKER）：后置基线 UPDATE 移入 runBatch 事务体——与本次 changes/binding 同事务原子提交。
      // 原实现 UPDATE 在 runBatch() COMMIT 之后 autocommit：UPDATE 失败则基线状态丢失但 changes/binding 已落库，
      // 下次扫描 hasBaseline 仍 false → 基线窗口期新增 IP 静默漏报 new_ip（直接威胁 SC1）。移入事务后原子（全成或全回滚），
      // 顺带消 WR-03（原整批 throw 时事务外 UPDATE 仍跑）。
      // 遗留库向后兼容语义不变：WHERE is_baseline=0 把遗留库存量行也置 1（首次扫描把现存 IP 含遗留纳入基线，Test 6 (c) 佐证）。
      if (!hasBaseline) {
        db.prepare('UPDATE ip_mac_bindings SET is_baseline = 1 WHERE is_baseline = 0').run()
      }
    })
    runBatch()

    return changes
  }

  // CR-01 fix（code-review BLOCKER）：统一 localtime 时间戳（项目 datetime('now','localtime') 规约，
  // experienceService.ts:78-79 警告——UTC 与 localtime 混用致 ORDER BY detected_at 字典序排序失真，
  // 直接掩盖 BUG-1 修复成果：getChanges 面板时间线 / 导出 CSV 时间错乱）。
  // JS 端生成 localtime 字符串 + SQL 参数绑定，确保 DB 存值与 recordChange 返回值逐字一致（无 1 秒漂移）。
  private static localNow(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  private static createBinding(db: any, ip: string, mac: string, now: string): void {
    try {
      db.prepare('INSERT INTO ip_mac_bindings (ip, mac, first_seen, last_seen, is_active) VALUES (?, ?, ?, ?, 1)').run(ip, mac, now, now)
    } catch {
      db.prepare('UPDATE ip_mac_bindings SET last_seen = ?, is_active = 1 WHERE ip = ? AND mac = ?').run(now, ip, mac)
    }
  }

  private static recordChange(ip: string, oldMac: string | null, newMac: string | null, changeType: ChangeType): IPMACChange | null {
    // 事务边界：dbGetter() 返回当前 db（生产默认 getDatabase 单例，测试经 _setAnomalyDbGetter 注入 realDb），
    // processARPEntries 事务内的调用自动落入同一事务（better-sqlite3 单连接同步）
    const db = dbGetter()
    try {
      const ts = AnomalyService.localNow()
      const result = db.prepare('INSERT INTO ip_mac_changes (ip, old_mac, new_mac, change_type, detected_at) VALUES (?, ?, ?, ?, ?)').run(ip, oldMac, newMac, changeType, ts)
      return { id: result.lastInsertRowid as number, ip, oldMac, newMac, changeType, detectedAt: ts, acknowledged: false, acknowledgedAt: null, notes: null }
    } catch (e: any) { console.error('[anomaly] recordChange 插入失败:', ip, e.message); return null }
  }

  static getChanges(unacknowledgedOnly: boolean = false, limit: number = 100, offset: number = 0): PaginatedResult<any> {
    const db = dbGetter()
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
    const ts = AnomalyService.localNow()
    dbGetter().prepare('UPDATE ip_mac_changes SET acknowledged = 1, acknowledged_at = ?, notes = ? WHERE id = ?').run(ts, notes || null, id)
  }

  static acknowledgeAll(): number {
    const ts = AnomalyService.localNow()
    return dbGetter().prepare('UPDATE ip_mac_changes SET acknowledged = 1, acknowledged_at = ? WHERE acknowledged = 0').run(ts).changes
  }

  static deleteChange(id: number): void {
    dbGetter().prepare('DELETE FROM ip_mac_changes WHERE id = ?').run(id)
  }

  static deleteChanges(ids: number[]): number {
    const placeholders = ids.map(() => '?').join(',')
    return dbGetter().prepare(`DELETE FROM ip_mac_changes WHERE id IN (${placeholders})`).run(...ids).changes
  }

  static getStats(): { total: number; unacknowledged: number; macChanged: number; newIp: number; ipReused: number } {
    const db = dbGetter()
    return {
      total: (db.prepare('SELECT COUNT(*) as count FROM ip_mac_changes').get() as any).count,
      unacknowledged: (db.prepare('SELECT COUNT(*) as count FROM ip_mac_changes WHERE acknowledged = 0').get() as any).count,
      macChanged: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'mac_changed'").get() as any).count,
      newIp: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'new_ip'").get() as any).count,
      ipReused: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'ip_reused'").get() as any).count,
    }
  }

  static getBindingHistory(ip: string): any[] {
    const rows = dbGetter().prepare('SELECT id, ip, mac, first_seen as firstSeen, last_seen as lastSeen, is_active as isActive FROM ip_mac_bindings WHERE ip = ? ORDER BY last_seen DESC').all(ip) as any[]
    return rows.map(row => ({ ...row, isActive: row.isActive === 1 }))
  }

  static getExcludedIPs(): any[] {
    return dbGetter().prepare('SELECT id, ip_or_cidr as ipOrCidr, description, created_at as createdAt FROM excluded_ips ORDER BY created_at DESC').all()
  }

  static addExcludedIP(input: { ipOrCidr: string; description?: string }): any {
    const result = dbGetter().prepare('INSERT INTO excluded_ips (ip_or_cidr, description) VALUES (?, ?)').run(input.ipOrCidr, input.description || null)
    return { id: result.lastInsertRowid, ipOrCidr: input.ipOrCidr, description: input.description || null, createdAt: new Date().toISOString() }
  }

  static deleteExcludedIP(id: number): void {
    dbGetter().prepare('DELETE FROM excluded_ips WHERE id = ?').run(id)
  }

  static checkIPExcluded(ip: string): boolean {
    return this.isIPExcluded(ip)
  }
}
