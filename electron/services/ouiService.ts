import { getDatabase } from '../database/connection'

export class OUIService {
  // PERF-01 (D-P1)：模块级 vendorMap 懒加载缓存。null = 未预载（启动时 preload() 全量载入）。
  private static vendorMap: Map<string, string> | null = null

  /** mac 归一化为 6 位 hex 大写（Map key 规范化，与 getVendor 查询逐字一致 — D-P1 红线）。 */
  private static normalizeMac(mac: string): string {
    return mac.replace(/[:\-\.]/g, '').toUpperCase().substring(0, 6)
  }

  /**
   * 反归一化：把 6 位 hex '000102' 还原为库内 oui_prefix 存储格式 '00:01:02'（两位一组冒号连接）。
   * 专供 getVendor 回退查询使用——库里 oui_prefix 列实际存的是 '00:01:02'（init.ts seed 带冒号），
   * 现状回退用归一化值 '000102' 查 '00:01:02' 列查不到（pre-existing bug），本 helper 修复之（W3 / T-03-06）。
   */
  private static denormalizePrefix(oui: string): string {
    return oui.match(/.{1,2}/g)?.join(':') ?? oui
  }

  /**
   * 启动预载：全量载入 oui_database 到内存 Map（O(1) 查找消除 getIPDetails N+1）。
   * 失败 → Map 保持 null → getVendor 回退查库（D-P1 优雅降级，功能不中断）。
   */
  static preload(): void {
    try {
      const db = getDatabase()
      const rows = db.prepare('SELECT oui_prefix, vendor_name FROM oui_database').all() as Array<{ oui_prefix: string; vendor_name: string }>
      const map = new Map<string, string>()
      for (const row of rows) {
        // oui_database.oui_prefix 存储形如 '00:01:02'（init.ts:299 seed 带冒号），归一化为 6 位 hex 大写作 Map key
        map.set(this.normalizeMac(row.oui_prefix), row.vendor_name)
      }
      this.vendorMap = map
    } catch (e: any) {
      // D-P1 优雅降级：预载失败 → vendorMap 保持 null → getVendor 回退查库路径。功能不中断，仅失去优化。
      this.vendorMap = null
      console.error('[oui] preload 失败，回退逐行查库:', e.message)
    }
  }

  static getVendor(mac: string): string {
    if (!mac) return 'Unknown'
    const oui = this.normalizeMac(mac)
    // D-P1：Map 已预载 → O(1) 内存查找；Map 为 null（预载失败/未调用）→ 回退 prepare().get() 查库路径
    if (this.vendorMap !== null) {
      return this.vendorMap.get(oui) || 'Unknown'
    }
    // 优雅降级：回退逐行查库。回退查询必须匹配库里 oui_prefix 实际存储格式（'00:01:02' 带冒号）。
    // 现状用归一化 '000102' 查 '00:01:02' 列查不到（pre-existing bug）——本 task 修复：denormalizePrefix(oui) → '00:01:02' 再查，
    // 使 D-P1 "preload 失败回退查库路径功能不中断" 真正可用（否则回退全部返 'Unknown' = 静默功能损坏）。
    const db = getDatabase()
    const row = db.prepare('SELECT vendor_name FROM oui_database WHERE oui_prefix = ?').get(this.denormalizePrefix(oui)) as { vendor_name: string } | undefined
    return row?.vendor_name || 'Unknown'
  }

  static getAll(): any[] {
    const db = getDatabase()
    return db.prepare('SELECT id, oui_prefix, vendor_name, is_custom, created_at, updated_at FROM oui_database ORDER BY vendor_name, oui_prefix').all()
  }

  static search(keyword: string): any[] {
    const db = getDatabase()
    return db.prepare('SELECT id, oui_prefix, vendor_name, is_custom, created_at, updated_at FROM oui_database WHERE oui_prefix LIKE ? OR vendor_name LIKE ? ORDER BY vendor_name, oui_prefix')
      .all(`%${keyword}%`, `%${keyword}%`)
  }

  static getById(id: number): any {
    return getDatabase().prepare('SELECT id, oui_prefix, vendor_name, is_custom, created_at, updated_at FROM oui_database WHERE id = ?').get(id)
  }

  static add(input: { ouiPrefix: string; vendorName: string }): any {
    const db = getDatabase()
    const normalizedPrefix = input.ouiPrefix.replace(/[:\-\.]/g, '').toUpperCase()
    if (!/^[0-9A-F]{6}$/.test(normalizedPrefix)) throw new Error('OUI 前缀格式无效，需要6位十六进制字符')
    const result = db.prepare('INSERT INTO oui_database (oui_prefix, vendor_name, is_custom) VALUES (?, ?, 1)').run(normalizedPrefix, input.vendorName)
    // PERF-01：写库成功后增量同步 Map（可选链，Map 未预载时 no-op）— 零脏读窗口（D-P1/T-03-05）
    this.vendorMap?.set(this.normalizeMac(input.ouiPrefix), input.vendorName)
    return this.getById(result.lastInsertRowid)
  }

  static addBatch(entries: Array<{ ouiPrefix: string; vendorName: string }>): number {
    const db = getDatabase()
    let count = 0
    const insert = db.prepare('INSERT OR REPLACE INTO oui_database (oui_prefix, vendor_name, is_custom) VALUES (?, ?, 1)')
    for (const entry of entries) {
      const normalizedPrefix = entry.ouiPrefix.replace(/[:\-\.]/g, '').toUpperCase()
      if (/^[0-9A-F]{6}$/.test(normalizedPrefix)) {
        insert.run(normalizedPrefix, entry.vendorName)
        // PERF-01：每条 INSERT OR REPLACE 后增量同步 Map（可选链 no-op when null）
        this.vendorMap?.set(this.normalizeMac(entry.ouiPrefix), entry.vendorName)
        count++
      }
    }
    return count
  }

  static update(input: { id: number; ouiPrefix?: string; vendorName?: string }): any {
    const db = getDatabase()
    const updates: string[] = []
    const values: any[] = []
    if (input.ouiPrefix !== undefined) {
      const normalizedPrefix = input.ouiPrefix.replace(/[:\-\.]/g, '').toUpperCase()
      if (!/^[0-9A-F]{6}$/.test(normalizedPrefix)) throw new Error('OUI 前缀格式无效')
      updates.push('oui_prefix = ?'); values.push(normalizedPrefix)
    }
    if (input.vendorName !== undefined) { updates.push('vendor_name = ?'); values.push(input.vendorName) }
    if (updates.length === 0) return this.getById(input.id)
    // PERF-01：prefix 变更时需先取旧 prefix，UPDATE 后 delete 旧 Map key（避免脏键残留）
    const oldRow = this.getById(input.id) as { oui_prefix?: string } | undefined
    updates.push('updated_at = CURRENT_TIMESTAMP'); values.push(input.id)
    db.prepare(`UPDATE oui_database SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    const newRow = this.getById(input.id) as { oui_prefix?: string; vendor_name?: string } | undefined
    // 增量同步：set 新 key（prefix+vendorName 取自 UPDATE 后的最新行），旧 prefix 不同则 delete
    // WR-03：仅当 newRow.vendor_name 有值（非 null/undefined/空串）时同步 Map，避免向 Map 注入空 vendor 脏值。
    // （DB 层 vendor_name NOT NULL，此处防御性守卫与 DB 行为对齐。）
    if (newRow) {
      if (newRow.vendor_name) {
        this.vendorMap?.set(this.normalizeMac(newRow.oui_prefix ?? ''), newRow.vendor_name)
      }
      if (oldRow?.oui_prefix && oldRow.oui_prefix !== newRow.oui_prefix) {
        this.vendorMap?.delete(this.normalizeMac(oldRow.oui_prefix))
      }
    }
    return newRow
  }

  static delete(id: number): void {
    // PERF-01：删除前先取 prefix（仅 is_custom=1 可删），DELETE 成功后同步 delete Map key
    const row = this.getById(id) as { oui_prefix?: string } | undefined
    const result = getDatabase().prepare('DELETE FROM oui_database WHERE id = ? AND is_custom = 1').run(id)
    if (result.changes === 0) throw new Error('无法删除系统预设的 OUI 条目')
    this.vendorMap?.delete(this.normalizeMac(row?.oui_prefix ?? ''))
  }

  static deleteBatch(ids: number[]): number {
    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')
    // PERF-01：删除前批量取 prefix，DELETE 后循环 delete Map key
    const rows = db.prepare(`SELECT oui_prefix FROM oui_database WHERE id IN (${placeholders}) AND is_custom = 1`).all(...ids) as Array<{ oui_prefix: string }>
    const changes = db.prepare(`DELETE FROM oui_database WHERE id IN (${placeholders}) AND is_custom = 1`).run(...ids).changes
    for (const r of rows) {
      this.vendorMap?.delete(this.normalizeMac(r.oui_prefix))
    }
    return changes
  }

  static getAllVendors(): string[] {
    const rows = getDatabase().prepare('SELECT DISTINCT vendor_name FROM oui_database ORDER BY vendor_name').all() as any[]
    return rows.map((r: any) => r.vendor_name)
  }

  static getStats(): { total: number; custom: number; vendors: number } {
    const db = getDatabase()
    const total = (db.prepare('SELECT COUNT(*) as count FROM oui_database').get() as any).count
    const custom = (db.prepare('SELECT COUNT(*) as count FROM oui_database WHERE is_custom = 1').get() as any).count
    const vendors = (db.prepare('SELECT COUNT(DISTINCT vendor_name) as count FROM oui_database').get() as any).count
    return { total, custom, vendors }
  }
}
