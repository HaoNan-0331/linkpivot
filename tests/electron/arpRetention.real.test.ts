// tests/electron/arpRetention.real.test.ts
//
// Phase 18 Plan 18-05 Task 3 —— TXN-03 arp_entries 保留策略真路径守门矩阵（P11 不可恢复风险五重断言）。
//
// 本 plan 是 v1.3 全程唯一不可恢复操作（bulk DELETE arp_entries）的落地测试：删除谓词
// 「EXISTS 严格大于守卫」永不命中每 IP 最新行 / tie 行全存活——一旦破防，网段视图（rn=1 窗口）
// 与导出取值不可恢复丢失。it 清单（≥9，P2/P3 双坑守门）：
//   it1 旧行删除新行保留（次新行有严格更大兄弟故可删）
//   it2 每 IP 最新行永不删（P11 核心断言——唯一行=字典序最大，无严格更大兄弟）
//   it3 tie 行全存活（EXISTS 严格大于不命中相等行）
//   it4 cutoff ISO 边界（毫秒级相邻行，JS toISOString 与库内 ISO 串同源比较固化）
//   it5 hasBaseline 不变（anomalyService 零依赖 arp_entries 的实证守门）
//   it6 网段视图双断言之一（getIPDetails rn=1 窗口查询复刻，清理前后取值一致）
//   it7 导出最新行双断言之二（exportService 最新行窗口查询复刻，清理前后一致）
//   it8 混合格式 fixture（非 ISO 旧格式 + ISO 新行同库，EXISTS 守卫与视图 ORDER BY 同种字符串比较）
//   it9 批间 yield 非冻结（>500 行分批 + setImmediate 回调批间可插入）+ retentionDays=0 直跳零删除
//
// 边界（12-02 反向范式）：被测是 SchedulerService.runArpRetention 的真 SQL 删除链，
// vi.mock 仅 database/connection（getDatabase 单例牵连 electron app），DB 为真 better-sqlite3（makeRealDb）。
// schedulerService 顶层 import BrowserWindow（'electron' 在 RUN_AS_NODE 下返回路径串、retention 路径不触及）
// 与 arpCollector/arpIngestService/ipStatusService（import 链无模块级 IO），加载安全（16-04 device 先例）。
// it6/it7 复刻消费方 SQL 逐字比对（plan 授权「直接调视图查询或复刻其 SQL」）：
//   it6 = networkSegmentService.getIPDetails LEFT JOIN rn=1 窗口（deviceName/interface 消费面）
//   it7 = exportService.exportNetworkUsage latest rn=1 窗口（导出消费面）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeRealDb, type RealDbHandle } from './_helpers/realDb'

// ---- Mock：database/connection（IO 边界，vi.hoisted 可变句柄防 hoisting 报错，connection.probe 先例） ----
const holder = vi.hoisted(() => ({
  handle: null as null | { db: import('better-sqlite3').Database },
}))
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => {
    if (!holder.handle) throw new Error('realDb not ready')
    return holder.handle.db
  },
}))

import { SchedulerService } from '../../electron/services/schedulerService'

const DAY_MS = 86_400_000
const RETENTION_BATCH = 500   // 与生产模块常量同步（断言批数用；值变化时本测试同步）

let handle: RealDbHandle | null = null

/** 相对 now 偏移 days 天（+ms 毫秒）的 ISO-UTC 串——与 arpCollector 写入格式逐字同源 */
function iso(days: number, ms = 0): string {
  return new Date(Date.now() - days * DAY_MS + ms).toISOString()
}

/** 直插 arp_entries 一行（绕过采集链，fixture 专用） */
function insertArp(ip: string, collectedAt: string, opts?: { iface?: string; deviceId?: string; mac?: string }): void {
  handle!.db
    .prepare('INSERT INTO arp_entries (device_id, ip, mac, vlan, interface, collected_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(opts?.deviceId ?? 'dev-1', ip, opts?.mac ?? 'AA:BB:CC:DD:EE:01', null, opts?.iface ?? null, collectedAt)
}

/** 该 IP 现存 collected_at 集合（按字典序） */
function arpTimes(ip: string): string[] {
  return (handle!.db.prepare('SELECT collected_at FROM arp_entries WHERE ip = ? ORDER BY collected_at').all(ip) as Array<{ collected_at: string }>)
    .map((r) => r.collected_at)
}

/** 该 IP 现存行数 */
function arpCount(ip: string): number {
  return (handle!.db.prepare('SELECT COUNT(*) as c FROM arp_entries WHERE ip = ?').get(ip) as { c: number }).c
}

/** it6 复刻：networkSegmentService.getIPDetails 的 rn=1 窗口取数（deviceName/interface 消费面，SQL 逐字） */
function viewPick(ip: string): { interface: string | null; deviceName: string | null }[] {
  return handle!.db.prepare(
    `SELECT ips.ip, arp.interface, arp.device_id as deviceName
      FROM ip_status ips
      LEFT JOIN (SELECT ip, interface, device_id, ROW_NUMBER() OVER (PARTITION BY ip ORDER BY collected_at DESC) as rn FROM arp_entries) arp ON arp.ip = ips.ip AND arp.rn = 1
      WHERE ips.ip = ?`
  ).all(ip) as { interface: string | null; deviceName: string | null }[]
}

/** it7 复刻：exportService.exportNetworkUsage 的 latest rn=1 窗口（导出消费面，SQL 逐字） */
function exportPick(): Array<{ ip: string; mac: string; collected_at: string }> {
  return handle!.db.prepare(
    `SELECT latest.ip, latest.mac, latest.collected_at FROM (SELECT a.ip, a.mac, a.collected_at, ROW_NUMBER() OVER (PARTITION BY a.ip ORDER BY a.collected_at DESC) as rn FROM arp_entries a) latest WHERE latest.rn = 1 ORDER BY latest.ip`
  ).all() as Array<{ ip: string; mac: string; collected_at: string }>
}

/**
 * 建被测表。arp_entries / ip_mac_bindings / ip_status / scheduler_config DDL 照 init.ts fresh-install
 * 逐字抄（arp_entries 含 18-02 v14 的 collected_at 索引）；devices 为 FK 父表最小形态
 * （18-04 arpIngest.real 先例：FK 校验需父 schema，非「逐字抄」对象）。
 */
function createTables(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS arp_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      mac TEXT NOT NULL,
      vlan TEXT,
      interface TEXT,
      collected_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_arp_entries_ip ON arp_entries(ip);
    CREATE INDEX IF NOT EXISTS idx_arp_entries_mac ON arp_entries(mac);
    CREATE INDEX IF NOT EXISTS idx_arp_entries_device ON arp_entries(device_id);
    CREATE INDEX IF NOT EXISTS idx_arp_entries_collected_at ON arp_entries(collected_at);

    CREATE TABLE IF NOT EXISTS ip_mac_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      mac TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_baseline INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(ip, mac)
    );

    CREATE TABLE IF NOT EXISTS ip_status (
      ip TEXT PRIMARY KEY,
      mac TEXT,
      status TEXT NOT NULL DEFAULT 'used' CHECK(status IN ('used', 'deprecated')),
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS scheduler_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      last_run TEXT,
      next_run TEXT,
      retention_days INTEGER DEFAULT 90
    );
  `)
  db.prepare("INSERT INTO devices (id) VALUES ('dev-1')").run()
  db.prepare("INSERT INTO devices (id) VALUES ('dev-2')").run()
  db.prepare('INSERT INTO scheduler_config (id, enabled, interval_minutes, retention_days) VALUES (1, 0, 60, 90)').run()
}

/** 设定保留天数（D-06/D-07 链路落点） */
function setRetentionDays(days: number): void {
  handle!.db.prepare('UPDATE scheduler_config SET retention_days = ? WHERE id = 1').run(days)
}

beforeEach(() => {
  handle = makeRealDb()
  holder.handle = handle
  createTables(handle.db)
})

afterEach(() => {
  holder.handle = null
  if (handle) {
    handle.close()
    handle = null
  }
})

describe('TXN-03 arp retention 真路径守门矩阵（realDb）', () => {
  it('it1：旧行删除、次新与最新行保留（谓词按「非最新且超期」删）', async () => {
    const old100 = iso(100), mid10 = iso(10), recent1 = iso(1)
    insertArp('10.1.1.1', old100, { iface: 'GE0/0/1' })
    insertArp('10.1.1.1', mid10, { iface: 'GE0/0/2' })
    insertArp('10.1.1.1', recent1, { iface: 'GE0/0/3' })

    const r = await SchedulerService.runArpRetention()

    expect(r.deleted).toBe(1)
    // 仅 100 天前行被删；次新（有严格更大兄弟）与最新存活
    expect(arpTimes('10.1.1.1')).toEqual([mid10, recent1])
  })

  it('it2：每 IP 最新行永不删——唯一行 200 天前仍存活（P11 核心断言）', async () => {
    const lone = iso(200)
    insertArp('10.1.1.2', lone)

    const r = await SchedulerService.runArpRetention()

    // 唯一行 = 该 IP 字典序最大行，EXISTS 严格大于守卫不命中 → 永不删
    expect(r.deleted).toBe(0)
    expect(arpCount('10.1.1.2')).toBe(1)
    expect(arpTimes('10.1.1.2')).toEqual([lone])
  })

  it('it3：tie 行全存活——同 collected_at 两行均不命中严格大于', async () => {
    const tie = iso(200)
    insertArp('10.1.1.3', tie, { iface: 'GE0/0/1' })
    insertArp('10.1.1.3', tie, { iface: 'GE0/0/2' })

    const r = await SchedulerService.runArpRetention()

    // 相等行互不为「严格更大」→ 两行全存活（防 tie 破坏 rn=1 取值）
    expect(r.deleted).toBe(0)
    expect(arpCount('10.1.1.3')).toBe(2)
  })

  it('it4：cutoff ISO 边界——毫秒级相邻行仅字典序小于 cutoff 者被删', async () => {
    // 两行跨在 90 天边界两侧 ±150ms；retention 运行时刻与 fixture 构造时刻的漂移（δ，同同步流远小于 150ms）
    // 使 cutoff 必落两行之间——固化 JS toISOString 与库内 ISO 串的同源字典序比较
    const below = iso(90, -150), above = iso(90, 150)
    insertArp('10.1.1.4', below)
    insertArp('10.1.1.4', above)

    const r = await SchedulerService.runArpRetention()

    expect(r.deleted).toBe(1)
    expect(arpTimes('10.1.1.4')).toEqual([above])   // 仅字典序小于 cutoff 的行删除
  })

  it('it5：hasBaseline 清理前后不变（anomalyService 零依赖 arp_entries 实证守门）', async () => {
    handle!.db
      .prepare("INSERT INTO ip_mac_bindings (ip, mac, first_seen, last_seen, is_active, is_baseline) VALUES (?, ?, ?, ?, 1, 1)")
      .run('10.1.1.5', 'AA:BB:CC:DD:EE:05', iso(300), iso(1))
    const before = handle!.db.prepare('SELECT ip, mac, is_baseline FROM ip_mac_bindings WHERE is_baseline = 1 LIMIT 1').get()

    insertArp('10.1.1.5', iso(200), { mac: 'AA:BB:CC:DD:EE:05' })
    insertArp('10.1.1.5', iso(1), { mac: 'AA:BB:CC:DD:EE:05' })
    const r = await SchedulerService.runArpRetention()

    const after = handle!.db.prepare('SELECT ip, mac, is_baseline FROM ip_mac_bindings WHERE is_baseline = 1 LIMIT 1').get()
    expect(r.deleted).toBe(1)               // 清理确实发生（200 天前行删除）
    expect(after).toEqual(before)           // 基线行不动（异常检测域与 arp_entries 删除解耦）
  })

  it('it6：网段视图双断言之一——rn=1 窗口 deviceName/interface 清理前后一致', async () => {
    handle!.db
      .prepare("INSERT INTO ip_status (ip, mac, status, first_seen, last_seen) VALUES (?, ?, 'used', ?, ?)")
      .run('10.1.1.6', 'AA:BB:CC:DD:EE:06', iso(300), iso(1))
    insertArp('10.1.1.6', iso(200), { iface: 'GE0/0/1', deviceId: 'dev-1' })
    insertArp('10.1.1.6', iso(100), { iface: 'GE0/0/2', deviceId: 'dev-1' })
    insertArp('10.1.1.6', iso(1), { iface: 'GE0/0/3', deviceId: 'dev-2' })
    const before = viewPick('10.1.1.6')

    const r = await SchedulerService.runArpRetention()

    // 200/100 天前两行删除（均有更大兄弟），1 天前行存活且 rn=1 取值不变
    expect(r.deleted).toBe(2)
    expect(arpCount('10.1.1.6')).toBe(1)
    expect(viewPick('10.1.1.6')).toEqual(before)
    expect(before[0]).toEqual({ ip: '10.1.1.6', interface: 'GE0/0/3', deviceName: 'dev-2' })
  })

  it('it7：导出最新行双断言之二——exportService 窗口查询清理前后一致', async () => {
    insertArp('10.1.1.7', iso(200), { mac: 'AA:BB:CC:DD:EE:07' })
    const recentTs = iso(1)
    insertArp('10.1.1.7', recentTs, { mac: 'AA:BB:CC:DD:EE:77' })
    const before = exportPick()

    const r = await SchedulerService.runArpRetention()

    expect(r.deleted).toBe(1)
    expect(arpCount('10.1.1.7')).toBe(1)
    expect(exportPick()).toEqual(before)
    expect(before).toEqual([{ ip: '10.1.1.7', mac: 'AA:BB:CC:DD:EE:77', collected_at: recentTs }])
  })

  it('it8：混合格式 fixture——非 ISO 旧行删除后视图取值不变量不破', async () => {
    // 非ISO 旧格式（localtime 风格）+ ISO 新行同库：EXISTS 守卫与视图 ORDER BY 用同一种字符串比较，
    // 同降级同取值（A3 论证固化）——'2025-01-01 ...' < '2026-xx-xxT...' 字典序，rn=1 恒取 ISO 新行
    handle!.db
      .prepare("INSERT INTO ip_status (ip, mac, status, first_seen, last_seen) VALUES (?, ?, 'used', ?, ?)")
      .run('10.1.1.8', 'AA:BB:CC:DD:EE:08', iso(300), iso(200))
    insertArp('10.1.1.8', '2025-01-01 00:00:00', { iface: 'GE0/0/1', deviceId: 'dev-1' })
    const isoRow = iso(200)
    insertArp('10.1.1.8', isoRow, { iface: 'GE0/0/2', deviceId: 'dev-2' })
    const before = viewPick('10.1.1.8')
    expect(before[0]).toEqual({ ip: '10.1.1.8', interface: 'GE0/0/2', deviceName: 'dev-2' })   // rn=1 = ISO 行

    const r = await SchedulerService.runArpRetention()

    // 非ISO 旧行（有严格更大 ISO 兄弟）被删；ISO 行（该 IP 最新）存活，视图取值不变
    expect(r.deleted).toBe(1)
    expect(arpTimes('10.1.1.8')).toEqual([isoRow])
    expect(viewPick('10.1.1.8')).toEqual(before)
  })

  it('it9：批间 yield 非冻结（>500 行两批 + setImmediate 批间可插入）+ retentionDays=0 直跳零删除', async () => {
    // 同 IP 520 行互异时间戳：519 行可删（最新存活）→ 两批（500 + 19）
    const base = Date.now() - 200 * DAY_MS
    for (let i = 0; i < 520; i++) {
      insertArp('10.1.1.9', new Date(base + i).toISOString())
    }

    // 先排队自身 setImmediate 再启动清理：批 1（同步）完成后 yield 入队 R1 晚于 T0 →
    // T0 在批 1 与批 2 之间获调度（若无批间 yield，清理全程同步完成，断言时 interleaved 仍为 0）
    let interleaved = 0
    setImmediate(() => { interleaved++ })
    const r = await SchedulerService.runArpRetention()

    expect(r.batches).toBe(Math.ceil(519 / RETENTION_BATCH))   // 500+19 两批
    expect(r.deleted).toBe(519)
    expect(arpCount('10.1.1.9')).toBe(1)
    expect(arpTimes('10.1.1.9')).toEqual([new Date(base + 519).toISOString()])   // 字典序最大行存活
    expect(interleaved).toBe(1)

    // retentionDays=0（永不删除特殊值）：插入本可删的旧行，直跳 deleted=0 且零行被删
    setRetentionDays(0)
    insertArp('10.1.1.10', iso(200))
    insertArp('10.1.1.10', iso(1))
    const r0 = await SchedulerService.runArpRetention()
    expect(r0).toEqual({ deleted: 0, batches: 0 })
    expect(arpCount('10.1.1.10')).toBe(2)
  })
})
