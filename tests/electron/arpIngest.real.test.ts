// tests/electron/arpIngest.real.test.ts
//
// 18-04（TXN-01）arp 写链真路径事务性守门——ArpIngestService.ingestDeviceResult 单设备单事务：
//   1. 正常落库：INSERT arp_entries 直写真库 + 两嵌套 service 各调 1 次（入参一致）
//   2. UNIQUE 冲突行级容错：冲突行跳过不废事务，新行落库，inserted 计数正确
//   3. 中途 throw 整体回滚：anomaly 阶段抛错 → INSERT 已执行但随外层事务 ROLLBACK（事务性核心断言）
//   4. 部分条目坏行：非 UNIQUE 错误（bind 类型错）走 console.error 路径，不废事务其余行落库
//
// 12-02 反向范式：被测是 arp_entries 写链事务性，vi.mock 非被测重依赖 ipStatusService 与
// anomalyService（两 service 各有/将有独立覆盖；正常路径 mock 返回值计数，回滚路径 mock throw），
// DB 走 makeRealDb 真库（test:electron 通道，禁 npx vitest 直跑——DEP-1 ABI）。
//
// 造数说明：
//   - arp_entries/ip_status/ip_mac_bindings DDL 照 init.ts fresh-install 逐字抄（16-01 基线根基）。
//   - devices 为 FK 父表补建（foreign_keys=ON 下 INSERT prepare 即校验父 schema，16-04 Rule 3 先例），
//     仅建最小 id 主键（arp_entries FK 只引用 devices(id)）。
//   - arp_entries 生产 DDL 无 UNIQUE 约束（四索引皆非唯一）——it 2 在 fixture 内补建
//     (device_id, ip) 唯一索引作为测试专用构造，以确定性触发行级 UNIQUE catch 路径。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeRealDb } from './_helpers/realDb'
import type { RealDbHandle } from './_helpers/realDb'
import { ArpIngestService } from '../../electron/services/arpIngestService'

// mock 范围仅两嵌套 service（IO 边界外的「非被测重依赖」）：arpIngestService 对它们的调用被计数/可控抛错
const { batchUpdateIPStatusMock, processARPEntriesMock } = vi.hoisted(() => ({
  batchUpdateIPStatusMock: vi.fn(),
  processARPEntriesMock: vi.fn(),
}))
vi.mock('../../electron/services/ipStatusService', () => ({
  IPStatusService: { batchUpdateIPStatus: (...args: unknown[]) => batchUpdateIPStatusMock(...args) },
}))
vi.mock('../../electron/services/anomalyService', () => ({
  AnomalyService: { processARPEntries: (...args: unknown[]) => processARPEntriesMock(...args) },
}))

let handle: RealDbHandle | null = null

// 建被测表（arp_entries/ip_status/ip_mac_bindings DDL 照 init.ts 逐字抄 + devices FK 父表补建）
function createArpTables(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY
    );

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

    CREATE TABLE IF NOT EXISTS ip_status (
      ip TEXT PRIMARY KEY,
      mac TEXT,
      status TEXT NOT NULL DEFAULT 'used' CHECK(status IN ('used', 'deprecated')),
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_ip_status_status ON ip_status(status);

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
  `)
  db.prepare("INSERT INTO devices (id) VALUES ('dev-1')").run()
}

function countArpEntries(): number {
  return (handle!.db.prepare('SELECT COUNT(*) as c FROM arp_entries').get() as { c: number }).c
}

beforeEach(() => {
  handle = makeRealDb()
  createArpTables(handle.db)
  // 默认应答：batchUpdate 无返回值；processARP 返回数组（ingestDeviceResult 内取 .length）
  batchUpdateIPStatusMock.mockReturnValue(undefined)
  processARPEntriesMock.mockReturnValue([])
})

afterEach(() => {
  vi.resetAllMocks()
  if (handle) {
    handle.close()
    handle = null
  }
})

describe('ArpIngestService 单设备单事务（真路径 realDb）', () => {
  it('it 1：正常落库——3 条 entries 直写 arp_entries 逐字一致 + 两嵌套 service 各调 1 次', () => {
    const entries = [
      { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01', vlan: '10', interface: 'GE0/0/1' },
      { ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:02', vlan: null, interface: null },
      { ip: '10.0.0.3', mac: 'AA:BB:CC:DD:EE:03' },
    ]
    processARPEntriesMock.mockReturnValue([{ id: 1 }, { id: 2 }])
    const result = {
      deviceId: 'dev-1',
      entries,
      collectedAt: '2026-08-16T12:00:00.000Z',
    }
    const collectionTime = '2026-08-16T11:59:00.000Z'

    const ingested = ArpIngestService.ingestDeviceResult(handle!.db, result, collectionTime)

    // 返回计数：inserted=3 成功插入；changes=anomaly 返回数组长度
    expect(ingested.inserted).toBe(3)
    expect(ingested.changes).toBe(2)

    // arp_entries 直写真库（mock 未拦截）：3 行字段逐字断言（vlan/interface 缺省落 null）
    const rows = handle!.db
      .prepare('SELECT device_id, ip, mac, vlan, interface, collected_at FROM arp_entries ORDER BY id')
      .all() as Array<{ device_id: string; ip: string; mac: string; vlan: string | null; interface: string | null; collected_at: string }>
    expect(rows).toEqual([
      { device_id: 'dev-1', ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01', vlan: '10', interface: 'GE0/0/1', collected_at: '2026-08-16T12:00:00.000Z' },
      { device_id: 'dev-1', ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:02', vlan: null, interface: null, collected_at: '2026-08-16T12:00:00.000Z' },
      { device_id: 'dev-1', ip: '10.0.0.3', mac: 'AA:BB:CC:DD:EE:03', vlan: null, interface: null, collected_at: '2026-08-16T12:00:00.000Z' },
    ])

    // IPStatusService.batchUpdateIPStatus 恰 1 次：入参为 {ip,mac} 投影 + 采集窗口时间（非每设备 collectedAt）
    expect(batchUpdateIPStatusMock).toHaveBeenCalledTimes(1)
    expect(batchUpdateIPStatusMock.mock.calls[0][0]).toEqual([
      { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' },
      { ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:02' },
      { ip: '10.0.0.3', mac: 'AA:BB:CC:DD:EE:03' },
    ])
    expect(batchUpdateIPStatusMock.mock.calls[0][1]).toBe(collectionTime)

    // AnomalyService.processARPEntries 恰 1 次：入参为原始 entries 全量
    expect(processARPEntriesMock).toHaveBeenCalledTimes(1)
    expect(processARPEntriesMock.mock.calls[0][0]).toBe(entries)
  })

  it('it 2：UNIQUE 冲突行级容错——冲突行跳过不废事务，新行落库，inserted 计数正确', () => {
    // fixture 补建唯一索引（测试专用构造，见文件头说明）：arp_entries 生产 DDL 无 UNIQUE 约束
    handle!.db
      .exec('CREATE UNIQUE INDEX idx_arp_entries_test_did_ip ON arp_entries(device_id, ip)')
    // 预置既有冲突行（dev-1, 10.0.0.1）
    handle!.db
      .prepare("INSERT INTO arp_entries (device_id, ip, mac, vlan, interface, collected_at) VALUES ('dev-1', '10.0.0.1', 'AA:BB:CC:DD:EE:01', NULL, NULL, '2026-08-15T00:00:00.000Z')")
      .run()

    const ingested = ArpIngestService.ingestDeviceResult(
      handle!.db,
      {
        deviceId: 'dev-1',
        entries: [
          { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' },
          { ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:02' },
          { ip: '10.0.0.3', mac: 'AA:BB:CC:DD:EE:03' },
        ],
        collectedAt: '2026-08-16T12:00:00.000Z',
      },
      '2026-08-16T11:59:00.000Z'
    )

    // 冲突行被行级 catch 跳过：inserted=2（仅成功插入计）
    expect(ingested.inserted).toBe(2)

    // 事务未废：既有 1 行 + 新 2 行 = 3 行；10.0.0.1 保持预置 collectedAt（未被重写）
    expect(countArpEntries()).toBe(3)
    const ips = (handle!.db.prepare('SELECT ip FROM arp_entries ORDER BY id').all() as Array<{ ip: string }>).map(r => r.ip)
    expect(ips).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3'])

    // 后续嵌套 service 照常执行（事务未被单行冲突打断），入参仍是全量 entries（沿原 helper 语义）
    expect(batchUpdateIPStatusMock).toHaveBeenCalledTimes(1)
    expect(processARPEntriesMock).toHaveBeenCalledTimes(1)
    expect(processARPEntriesMock.mock.calls[0][0]).toHaveLength(3)
  })

  it('it 3：中途 throw 整体回滚——anomaly 抛错上抛，arp_entries 零行（INSERT 已执行随外层事务 ROLLBACK）', () => {
    processARPEntriesMock.mockImplementation(() => { throw new Error('anomaly boom') })

    expect(() =>
      ArpIngestService.ingestDeviceResult(
        handle!.db,
        {
          deviceId: 'dev-1',
          entries: [
            { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' },
            { ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:02' },
          ],
          collectedAt: '2026-08-16T12:00:00.000Z',
        },
        '2026-08-16T11:59:00.000Z'
      )
    ).toThrow('anomaly boom')

    // 事务性核心断言：INSERT 阶段已执行 2 行，但事务体后段 throw → 外层 ROLLBACK → 零行残留
    expect(countArpEntries()).toBe(0)
  })

  it('it 4：部分条目坏行——非 UNIQUE 错误走 console.error 不废事务，其余行落库', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // mac 传对象：better-sqlite3 bind 类型错（TypeError，不含 UNIQUE/CONSTRAINT）→ console.error 路径
      const ingested = ArpIngestService.ingestDeviceResult(
        handle!.db,
        {
          deviceId: 'dev-1',
          entries: [
            { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' },
            { ip: '10.0.0.2', mac: {} as unknown as string },
            { ip: '10.0.0.3', mac: 'AA:BB:CC:DD:EE:03' },
          ],
          collectedAt: '2026-08-16T12:00:00.000Z',
        },
        '2026-08-16T11:59:00.000Z'
      )

      // 好行落库（inserted=2），坏行被 catch 跳过
      expect(ingested.inserted).toBe(2)
      expect(countArpEntries()).toBe(2)
      const ips = (handle!.db.prepare('SELECT ip FROM arp_entries ORDER BY id').all() as Array<{ ip: string }>).map(r => r.ip)
      expect(ips).toEqual(['10.0.0.1', '10.0.0.3'])

      // 非 UNIQUE 错误不静默吞：console.error('[arpIngest] insert failed:', ...) 恰命中坏行 1 次
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(errSpy.mock.calls[0][0]).toBe('[arpIngest] insert failed:')

      // 事务未废：两嵌套 service 照常被调（坏行不中断整设备批次）
      expect(batchUpdateIPStatusMock).toHaveBeenCalledTimes(1)
      expect(processARPEntriesMock).toHaveBeenCalledTimes(1)
    } finally {
      errSpy.mockRestore()
    }
  })
})
