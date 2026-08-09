// tests/electron/anomalyNewIp.real.test.ts
//
// BUG-1 真路径回归测试（Phase 14 FIX-01 / D-14-1）。
// 验 anomalyService.processARPEntries 全新 IP 分支补 recordChange('new_ip') + 首次基线机制后：
//   1. 首次扫描建基线（is_baseline=1）不报 new_ip
//   2. 基线后新增 IP 报 new_ip 落 ip_mac_changes
//   3. 基线内已知 IP 不报（仅 update last_seen）
//   4. mac_changed/ip_reused 既有逻辑不回归
//   5. getStats().newIp 修前恒零修后反映真实新增数
//   6. 遗留库场景（CLAUDE.md「迁移改动必须向后兼容历史数据」硬约束）：预置存量 binding（is_baseline=0）
//      喂该存量 IP 不误报 new_ip + last_seen 更新 + 后置基线 UPDATE 纳入存量行
//
// 借 Phase 12 realDb 真路径范式（D-14-4）：经 makeRealDb() 拿真实 better-sqlite3 实例，
// 自建 ip_mac_bindings / ip_mac_changes / excluded_ips 三表（DDL 照 init.ts fresh-install 抄，含 is_baseline 列），
// 经 _setAnomalyDbGetter 注入（D-14-4 mock 注入口，镜像 experienceService._setExperienceDbGetter）。
// processARPEntries 内部 INSERT/UPDATE/SELECT 全走真 SQL，无需 mock 单条 SQL。
// assert 直接查 realDb 表行数 + change_type 字段值（行为断言非主观词）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeRealDb } from './_helpers/realDb'
import type { RealDbHandle } from './_helpers/realDb'
import {
  AnomalyService,
  _setAnomalyDbGetter,
} from '../../electron/services/anomalyService'
import { getDatabase } from '../../electron/database/connection'

// 集中持有本次测试的 db handle，afterEach 统一 close + 还原 dbGetter
let handle: RealDbHandle | null = null

// 建被测三表（DDL 照 init.ts:139-171 fresh-install 抄，含 BUG-1 新增 is_baseline 列）
function createAnomalyTables(db: import('better-sqlite3').Database): void {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_ip_mac_bindings_ip ON ip_mac_bindings(ip);
    CREATE INDEX IF NOT EXISTS idx_ip_mac_bindings_active ON ip_mac_bindings(is_active);

    CREATE TABLE IF NOT EXISTS ip_mac_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      old_mac TEXT,
      new_mac TEXT,
      change_type TEXT NOT NULL CHECK(change_type IN ('mac_changed', 'new_ip', 'ip_reused')),
      detected_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      acknowledged INTEGER NOT NULL DEFAULT 0,
      acknowledged_at TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ip_mac_changes_detected ON ip_mac_changes(detected_at);
    CREATE INDEX IF NOT EXISTS idx_ip_mac_changes_ack ON ip_mac_changes(acknowledged);

    CREATE TABLE IF NOT EXISTS excluded_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_or_cidr TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `)
}

beforeEach(() => {
  handle = makeRealDb()
  createAnomalyTables(handle.db)
  _setAnomalyDbGetter(() => handle!.db)
})

afterEach(() => {
  // 还原 dbGetter 为生产 getDatabase 单例（防跨测试污染）
  _setAnomalyDbGetter(getDatabase)
  if (handle) {
    handle.close()
    handle = null
  }
})

describe('BUG-1 anomaly new_ip 修复（真路径 realDb）', () => {
  it('Test 1：首次扫描建基线不报 new_ip', () => {
    // 空库（ip_mac_bindings 无行）→ 喂一个 IP → 首次扫描建基线
    const changes = AnomalyService.processARPEntries([
      { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' },
    ])

    // 首次扫描不报 new_ip（基线建立，防首次全量扫描刷屏）
    expect(changes).toHaveLength(0)

    // ip_mac_changes 0 行（首次基线不报）
    const changeCount = (
      handle!.db.prepare('SELECT COUNT(*) as c FROM ip_mac_changes').get() as { c: number }
    ).c
    expect(changeCount).toBe(0)

    // ip_mac_bindings 有 1 行且 is_baseline=1（后置基线 UPDATE 把首次扫描建的 binding 置 1）
    const baselineCount = (
      handle!.db
        .prepare('SELECT COUNT(*) as c FROM ip_mac_bindings WHERE is_baseline = 1')
        .get() as { c: number }
    ).c
    expect(baselineCount).toBe(1)
  })

  it('Test 2：基线后新增 IP 报 new_ip', () => {
    // 先建基线（首次扫描喂 10.0.0.1）
    AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])

    // 第二次扫描喂全新 IP 10.0.0.2 → 基线已建（hasBaseline=true）→ 报 new_ip
    const changes = AnomalyService.processARPEntries([
      { ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:02' },
    ])

    // changes 返回数组长度 1
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('new_ip')
    expect(changes[0].oldMac).toBeNull()
    expect(changes[0].newMac).toBe('AA:BB:CC:DD:EE:02')

    // ip_mac_changes 有 1 行 change_type='new_ip'
    const rows = handle!.db
      .prepare("SELECT * FROM ip_mac_changes WHERE change_type = 'new_ip'")
      .all() as Array<{ ip: string; old_mac: string | null; new_mac: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].ip).toBe('10.0.0.2')
    expect(rows[0].old_mac).toBeNull()
    expect(rows[0].new_mac).toBe('AA:BB:CC:DD:EE:02')

    // ip_mac_bindings 新增 1 行（10.0.0.2），但 is_baseline=0（仅首次基线标 1，后续新增 IP 不标）
    const totalBindings = (
      handle!.db.prepare('SELECT COUNT(*) as c FROM ip_mac_bindings').get() as { c: number }
    ).c
    expect(totalBindings).toBe(2)
    const newIpBaseline = (
      handle!.db
        .prepare("SELECT is_baseline as b FROM ip_mac_bindings WHERE ip = '10.0.0.2'")
        .get() as { b: number }
    ).b
    expect(newIpBaseline).toBe(0)
  })

  it('Test 3：基线内已知 IP 不报（仅 update last_seen）', async () => {
    // 建基线
    AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])
    const beforeLastSeen = (
      handle!.db
        .prepare("SELECT last_seen as l FROM ip_mac_bindings WHERE ip = '10.0.0.1'")
        .get() as { l: string }
    ).l

    // WR-02 fix：await 真等待（原 void wait(50) 未 await 实际未等），让 last_seen 时间戳必变化
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await wait(50)

    // 第二次扫描喂基线内 IP 10.0.0.1（mac 相同）→ 走 currentBinding 分支只 update last_seen
    const changes = AnomalyService.processARPEntries([
      { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' },
    ])

    // changes 空（已知 IP mac 不变不报）
    expect(changes).toHaveLength(0)

    // ip_mac_changes 0 新行
    const changeCount = (
      handle!.db.prepare('SELECT COUNT(*) as c FROM ip_mac_changes').get() as { c: number }
    ).c
    expect(changeCount).toBe(0)

    // last_seen 已更新（值变化）
    const afterLastSeen = (
      handle!.db
        .prepare("SELECT last_seen as l FROM ip_mac_bindings WHERE ip = '10.0.0.1'")
        .get() as { l: string }
    ).l
    // WR-02 fix：await wait(50) 后 last_seen 必变化（50ms > 毫秒精度），强断言 >（原 >= 在未 await 时可能误绿）
    expect(afterLastSeen > beforeLastSeen).toBe(true)

    // is_baseline 保持 1（基线内已知 IP 不被后置 UPDATE 动，本就 is_baseline=1）
    const baseline = (
      handle!.db
        .prepare("SELECT is_baseline as b FROM ip_mac_bindings WHERE ip = '10.0.0.1'")
        .get() as { b: number }
    ).b
    expect(baseline).toBe(1)
  })

  it('Test 4：mac_changed 不回归（既有逻辑不破坏）', () => {
    // 建基线（10.0.0.1 mac=AA:BB:CC:DD:EE:01）
    AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])

    // 第二次喂同一 IP 但 mac 变化 → 走 currentBinding 分支的 mac_changed 子分支
    const changes = AnomalyService.processARPEntries([
      { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:99' },
    ])

    // changes 1 条 mac_changed（既有逻辑不破坏）
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('mac_changed')
    expect(changes[0].oldMac).toBe('AA:BB:CC:DD:EE:01')
    expect(changes[0].newMac).toBe('AA:BB:CC:DD:EE:99')

    // ip_mac_changes 有 1 行 mac_changed（非 new_ip）
    const macChanged = (
      handle!.db
        .prepare("SELECT COUNT(*) as c FROM ip_mac_changes WHERE change_type = 'mac_changed'")
        .get() as { c: number }
    ).c
    expect(macChanged).toBe(1)
    const newIp = (
      handle!.db
        .prepare("SELECT COUNT(*) as c FROM ip_mac_changes WHERE change_type = 'new_ip'")
        .get() as { c: number }
    ).c
    expect(newIp).toBe(0)
  })

  it('Test 5：getStats newIp 不恒零（修前恒零修后反映真实新增数）', () => {
    // 建基线
    AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])
    // 基线后新增两个 IP
    AnomalyService.processARPEntries([
      { ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:02' },
      { ip: '10.0.0.3', mac: 'AA:BB:CC:DD:EE:03' },
    ])

    const stats = AnomalyService.getStats()
    // 修前 newIp 恒零（写入侧漏写），修后 = 2（真实新增数）
    expect(stats.newIp).toBe(2)
    // macChanged = 0（本测试无 mac 变化）
    expect(stats.macChanged).toBe(0)
    // ipReused = 0（本测试无历史 inactive 复用）
    expect(stats.ipReused).toBe(0)
    // total = 2（两条 new_ip）
    expect(stats.total).toBe(2)
  })

  it('Test 6：遗留库场景（CLAUDE.md 向后兼容硬约束）— 存量 IP 不误报 new_ip + last_seen 更新 + 后置基线纳入存量行', () => {
    // 模拟老库 user_version≤11 经 v12 升级后状态：预置存量 binding 行（is_baseline=0）
    // raw INSERT 绕过 processARPEntries 建基线逻辑，直接构造遗留库快照
    handle!.db
      .prepare(
        "INSERT INTO ip_mac_bindings (ip, mac, first_seen, last_seen, is_active, is_baseline) VALUES (?, ?, ?, ?, 1, 0)"
      )
      .run('10.0.0.99', 'AA:BB:CC:DD:EE:99', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const beforeLastSeen = (
      handle!.db
        .prepare("SELECT last_seen as l FROM ip_mac_bindings WHERE ip = '10.0.0.99'")
        .get() as { l: string }
    ).l

    // 喂该存量 IP（mac 不变）→ 走 currentBinding 分支（存量 active binding 命中），不进 else 全新 IP 分支
    const changes = AnomalyService.processARPEntries([
      { ip: '10.0.0.99', mac: 'AA:BB:CC:DD:EE:99' },
    ])

    // (a) ip_mac_changes 无 new_ip 新行（存量 IP 不误报为 new_ip，向后兼容核心不变量）
    expect(changes).toHaveLength(0)
    const newIpCount = (
      handle!.db
        .prepare("SELECT COUNT(*) as c FROM ip_mac_changes WHERE change_type = 'new_ip'")
        .get() as { c: number }
    ).c
    expect(newIpCount).toBe(0)

    // (b) 存量 binding 行的 last_seen 已更新（走 currentBinding 分支只 update last_seen）
    const afterLastSeen = (
      handle!.db
        .prepare("SELECT last_seen as l FROM ip_mac_bindings WHERE ip = '10.0.0.99'")
        .get() as { l: string }
    ).l
    expect(afterLastSeen).not.toBe(beforeLastSeen)

    // (c) 后置基线 UPDATE 把存量行置 is_baseline=1（首次扫描把现存 IP 含遗留存量纳入基线，预期行为）
    const baseline = (
      handle!.db
        .prepare("SELECT is_baseline as b FROM ip_mac_bindings WHERE ip = '10.0.0.99'")
        .get() as { b: number }
    ).b
    expect(baseline).toBe(1)
  })

  it('Test 7：混合批次（基线后单批含已知 IP + 全新 IP）— WR-04 补覆盖', () => {
    // 建基线（10.0.0.1）
    AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])

    // 单批含已知 IP（10.0.0.1 mac 不变 → update last_seen）+ 全新 IP（10.0.0.4 → new_ip）
    const changes = AnomalyService.processARPEntries([
      { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' },
      { ip: '10.0.0.4', mac: 'AA:BB:CC:DD:EE:04' },
    ])

    // 仅全新 IP 报 new_ip（已知 IP mac 不变只 update last_seen，不报）
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('new_ip')
    expect(changes[0].ip).toBe('10.0.0.4')

    // ip_mac_changes 仅 1 行 new_ip（10.0.0.4），无 mac_changed/ip_reused 混入
    const newIpRows = (
      handle!.db
        .prepare("SELECT COUNT(*) as c FROM ip_mac_changes WHERE change_type = 'new_ip'")
        .get() as { c: number }
    ).c
    expect(newIpRows).toBe(1)
    const totalChanges = (
      handle!.db.prepare('SELECT COUNT(*) as c FROM ip_mac_changes').get() as { c: number }
    ).c
    expect(totalChanges).toBe(1)
  })

  it('Test 8：createBinding UNIQUE fallback 重激活路径 — WR-04 补覆盖', () => {
    // 建基线（10.0.0.1 mac=EE:01 active）
    AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])
    // mac 变更：停用 EE:01，建 EE:02 active（mac_changed）
    AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:02' }])
    // 此时 bindings：EE:01(is_active=0) + EE:02(is_active=1)

    // 喂回原 mac EE:01 → currentBinding 命中 EE:02(active) mac 变 → mac_changed + 停用 EE:02
    // + createBinding(EE:01) INSERT 撞 UNIQUE(ip,mac EE:01 已存在 inactive) → fallback UPDATE 重激活 EE:01
    const changes = AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('mac_changed')
    expect(changes[0].oldMac).toBe('AA:BB:CC:DD:EE:02')
    expect(changes[0].newMac).toBe('AA:BB:CC:DD:EE:01')

    // EE:01 重激活（fallback UPDATE is_active=1），EE:02 停用（stmtDeactivate is_active=0）
    const ee01 = (
      handle!.db
        .prepare("SELECT is_active as a FROM ip_mac_bindings WHERE ip = '10.0.0.1' AND mac = 'AA:BB:CC:DD:EE:01'")
        .get() as { a: number }
    ).a
    const ee02 = (
      handle!.db
        .prepare("SELECT is_active as a FROM ip_mac_bindings WHERE ip = '10.0.0.1' AND mac = 'AA:BB:CC:DD:EE:02'")
        .get() as { a: number }
    ).a
    expect(ee01).toBe(1)
    expect(ee02).toBe(0)
  })
})
