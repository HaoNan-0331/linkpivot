import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * listDevices capabilities 投影测试（Phase 23 / DSL-03 / D-02）+
 * name_hash 唯一拦截/查重测试（Phase 25 / 25-02 / ASSET-03）。
 *
 * 约束：
 * - device:list 每设备下发 capabilities: { hasSSH, hasTelnet, hasMcp } 三独立布尔
 * - hasSSH/hasTelnet 严格按 connectionType 派生；hasMcp 由 mcp_device_rel LEFT JOIN 派生
 * - LEFT JOIN 不产生重复行（mcp_device_rel.device_id UNIQUE，每设备恰好一行）
 * - 同名（含大小写/首尾空格/连字符 Unicode 变体）create/update 被服务层 throw，
 *   message 含冲突设备名称+IP 明文（D-12）；编辑排除自身（D-11）；checkDeviceName
 *   返回冲突 { name, ipAddress } 或 null
 *
 * Mock 策略：getDatabase → 内存 mock（mock 路径按 device.ts 的模块解析写
 * ../../electron/database/connection）。capabilities 组用固定行 prepare；
 * name_hash 组经 H.delegate 注入真 better-sqlite3 内存库（test:electron 走 electron ABI，
 * native binding 可加载，优于 mock SQL 语义）。
 */

const H = vi.hoisted(() => {
  return {
    rows: [
      { id: 'd-ssh', connection_type: 'ssh', has_mcp: 0 },
      { id: 'd-telnet', connection_type: 'telnet', has_mcp: 0 },
      { id: 'd-web', connection_type: 'web', has_mcp: 0 },
      { id: 'd-rdp', connection_type: 'rdp', has_mcp: 0 },
      { id: 'd-ssh-mcp', connection_type: 'ssh', has_mcp: 1 },
      { id: 'd-web-mcp', connection_type: 'web', has_mcp: 1 },
    ] as any[],
    delegate: null as Database.Database | null,
    spy: [] as string[],
  }
})

vi.mock('../../electron/database/connection', () => ({
  getDatabase: () =>
    H.delegate ?? {
      prepare: (sql: string) => {
        H.spy.push(sql)
        return { all: () => H.rows.map((r) => ({ ...r })) }
      },
    },
}))

import { listDevices, createDevice, updateDevice, checkDeviceName, setDeviceMasterKey, createBatchDevices, listDuplicateGroups, backfillNameHash, ensureNameUniqueIndex } from '../../electron/services/device'
import { hashDeviceName } from '../../electron/services/deviceName'
import { encField } from '../../electron/utils/crypto'

describe('listDevices — capabilities 三布尔投影（D-02）', () => {
  it('单条 SQL LEFT JOIN mcp_device_rel 派生 has_mcp（无 N+1：prepare 恰好一次）', () => {
    H.spy.length = 0
    const devices = listDevices()
    expect(H.spy).toHaveLength(1)
    expect(H.spy[0]).toContain('mcp_device_rel')
    expect(H.spy[0]).toContain('LEFT JOIN')
    expect(devices).toHaveLength(H.rows.length) // 无重复行
  })

  it('ssh 设备无 MCP 绑定 → hasSSH true / hasTelnet false / hasMcp false', () => {
    const d = listDevices().find((x: any) => x.id === 'd-ssh')!
    expect(d.capabilities).toEqual({ hasSSH: true, hasTelnet: false, hasMcp: false })
  })

  it('telnet 设备 → hasTelnet true / hasSSH false', () => {
    const d = listDevices().find((x: any) => x.id === 'd-telnet')!
    expect(d.capabilities).toEqual({ hasSSH: false, hasTelnet: true, hasMcp: false })
  })

  it('web/rdp 设备无 MCP → 三布尔全 false（仅问答档）', () => {
    for (const id of ['d-web', 'd-rdp']) {
      const d = listDevices().find((x: any) => x.id === id)!
      expect(d.capabilities).toEqual({ hasSSH: false, hasTelnet: false, hasMcp: false })
    }
  })

  it('mcp_device_rel 有关联行 → hasMcp true（可与 hasSSH 并存，三布尔独立）', () => {
    const sshMcp = listDevices().find((x: any) => x.id === 'd-ssh-mcp')!
    expect(sshMcp.capabilities).toEqual({ hasSSH: true, hasTelnet: false, hasMcp: true })
    const webMcp = listDevices().find((x: any) => x.id === 'd-web-mcp')!
    expect(webMcp.capabilities).toEqual({ hasSSH: false, hasTelnet: false, hasMcp: true })
  })

  it('capabilities 三键均为布尔类型', () => {
    for (const d of listDevices()) {
      expect(typeof d.capabilities.hasSSH).toBe('boolean')
      expect(typeof d.capabilities.hasTelnet).toBe('boolean')
      expect(typeof d.capabilities.hasMcp).toBe('boolean')
    }
  })
})

/** Phase 25（25-02，ASSET-03）：name_hash 唯一拦截 + checkDeviceName 查重（D-11/D-12）。 */

/** withIndex=false 模拟存量重名库（v24 门控跳过未建索引），供 25-03 清零建索引用例。 */
function makeDb(withIndex = true): Database.Database {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE topologies (
        id TEXT PRIMARY KEY,
        name_enc TEXT NOT NULL,
        data_enc TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        topology_id TEXT,
        name_enc TEXT NOT NULL,
        vendor_enc TEXT,
        model_enc TEXT,
        version_enc TEXT,
        ip_enc TEXT,
        device_type TEXT DEFAULT 'generic',
        connection_type TEXT,
        port_enc TEXT,
        username_enc TEXT,
        password_enc TEXT,
        ssh_key_path_enc TEXT,
        ssh_key_content_enc TEXT,
        web_url_enc TEXT,
        status TEXT DEFAULT 'unknown',
        last_checked TEXT,
        created_at TEXT,
        updated_at TEXT,
        name_hash TEXT
      );
      ${withIndex ? 'CREATE UNIQUE INDEX idx_devices_name_hash ON devices(name_hash);' : ''}
      CREATE TABLE mcp_device_rel (
        mcp_config_id TEXT NOT NULL,
        device_id TEXT NOT NULL UNIQUE
      );
    `)
    return db
}

describe('name_hash 唯一拦截与查重（25-02）', () => {
  const TEST_MK = 'test-mk-25-02'

  beforeEach(() => {
    const db = makeDb()
    H.delegate = db
    setDeviceMasterKey(TEST_MK)
  })

  afterEach(() => {
    H.delegate?.close()
    H.delegate = null
    setDeviceMasterKey('')
  })

  it('create 重名（大小写/首尾空格/连字符 U+2011 变体）throw 且 message 含冲突名称+IP（D-12）', () => {
    createDevice({ name: 'Core-SW', ipAddress: '192.168.1.1', connectionType: 'ssh' })
    for (const variant of [' CORE-SW ', 'core-sw', 'CORE‑SW']) {
      expect(() => createDevice({ name: variant, ipAddress: '10.0.0.9' }))
        .toThrow(/设备名称已存在：Core-SW \(192\.168\.1\.1\)/)
    }
  })

  it('create 不重名成功且新行 name_hash 非空（= hashDeviceName 归一化值）', () => {
    const dev = createDevice({ name: 'Border-FW', ipAddress: '10.1.1.1', connectionType: 'ssh' })
    const row = (H.delegate as Database.Database).prepare('SELECT name_hash FROM devices WHERE id = ?').get(dev.id) as any
    expect(row.name_hash).toBeTruthy()
    expect(row.name_hash).toBe(hashDeviceName('Border-FW'))
  })

  it('update 重命名为他人名 throw；改回自身原名不 throw（D-11 排除自身）', () => {
    const a = createDevice({ name: 'Core-SW', ipAddress: '192.168.1.1', connectionType: 'ssh' })
    const b = createDevice({ name: 'Edge-SW', ipAddress: '192.168.1.2', connectionType: 'ssh' })
    expect(() => updateDevice(b.id, { name: ' Core-SW ' }))
      .toThrow(/设备名称已存在：Core-SW \(192\.168\.1\.1\)/)
    // 改回自身原名（归一化同自身）不误拦
    expect(() => updateDevice(a.id, { name: 'core-sw' })).not.toThrow()
    // name 未传（编辑其他字段）不触发查重
    expect(() => updateDevice(a.id, { vendor: 'HW' })).not.toThrow()
    expect(b.name).toBe('Edge-SW')
  })

  it('checkDeviceName 命中返回冲突明文对象；excludeId 排除自身返回 null（D-11）', () => {
    const a = createDevice({ name: 'Core-SW', ipAddress: '192.168.1.1', connectionType: 'ssh' })
    expect(checkDeviceName(' CORE-SW ')).toEqual({ name: 'Core-SW', ipAddress: '192.168.1.1' })
    expect(checkDeviceName('CORE‑SW')!.name).toBe('Core-SW')
    expect(checkDeviceName('core-sw', a.id)).toBeNull()
    expect(checkDeviceName('Not-Exist')).toBeNull()
  })
})

/** Phase 25（25-03，ASSET-02/ASSET-04）：批量单事务 / 回填幂等 / 重名分组 / 清零建索引（D-06/D-09/D-10）。 */
describe('批量创建/回填/重名分组/清零建索引（25-03）', () => {
  const TEST_MK = 'test-mk-25-03'

  const batchItem = (name: string, ip: string) => ({
    name, ipAddress: ip, connectionType: 'ssh', username: 'admin', password: 'pw',
  })

  /** 带凭证直插 SQL（绕过 service 校验），构造 name_hash 为 NULL 的存量行供回填用例。 */
  function insertRawDevice(db: Database.Database, name: string, ip: string, withHash: boolean, mk: string): string {
    const id = `raw-${name}-${Math.random().toString(36).slice(2, 8)}`
    const encCol = (v: string) => encField(v, mk)
    db.prepare(`
      INSERT INTO devices (id, name_enc, ip_enc, password_enc, connection_type, created_at, updated_at, name_hash)
      VALUES (?, ?, ?, ?, 'ssh', datetime('now'), datetime('now'), ?)
    `).run(id, encCol(name), encCol(ip), encCol('pw'), withHash ? hashDeviceName(name) : null)
    return id
  }

  beforeEach(() => {
    // 不预建 UNIQUE 索引：模拟 v24 门控跳过的存量重名库（25-02 组默认 true 不受影响）
    H.delegate = makeDb(false)
    setDeviceMasterKey(TEST_MK)
  })

  afterEach(() => {
    H.delegate?.close()
    H.delegate = null
    setDeviceMasterKey('')
  })

  const count = () => (H.delegate as Database.Database).prepare('SELECT COUNT(*) AS c FROM devices').get() as { c: number }

  it('批量 3 行其中 1 行与库内重名 → throw 且库内设备数不变（全 ROLLBACK，D-06）', () => {
    createDevice({ name: 'Core-SW', ipAddress: '192.168.1.1', connectionType: 'ssh', password: 'pw' })
    const before = count().c
    expect(() => createBatchDevices([
      batchItem('New-FW', '10.0.0.1'),
      batchItem(' core-sw ', '10.0.0.2'), // 归一化后与库内 Core-SW 冲突
      batchItem('New-RTR', '10.0.0.3'),
    ])).toThrow(/第 2 行设备名称已存在：Core-SW \(192\.168\.1\.1\)/)
    expect(count().c).toBe(before) // 一台不落库
  })

  it('批内两行同名 → throw（含行序号），且凭证缺失行同样 throw', () => {
    expect(() => createBatchDevices([
      batchItem('Dup-SW', '10.1.0.1'),
      batchItem('New-FW', '10.1.0.2'),
      batchItem('DUP‑SW', '10.1.0.3'), // U+2011 归一化后与第 1 行相同 → 批内互重
    ])).toThrow(/批内第 1 行与第 3 行设备名重复/)
    expect(() => createBatchDevices([
      { name: 'No-Cred', ipAddress: '10.1.0.4', connectionType: 'ssh', username: 'admin' }, // 密码/密钥均空
    ])).toThrow(/凭证缺失/)
    expect(count().c).toBe(0)
  })

  it('批量 3 行全部合法 → 库内新增 3 台且 name_hash 全非空', () => {
    createBatchDevices([
      batchItem('B-FW', '10.2.0.1'),
      batchItem('B-SW', '10.2.0.2'),
      batchItem('B-RTR', '10.2.0.3'),
    ])
    expect(count().c).toBe(3)
    const nulls = (H.delegate as Database.Database).prepare('SELECT COUNT(*) AS c FROM devices WHERE name_hash IS NULL').get() as { c: number }
    expect(nulls.c).toBe(0)
  })

  it('backfillNameHash 回填 NULL 行；再次调用 backfilled=0（幂等）并检测重名组', () => {
    const db = H.delegate as Database.Database
    const a = insertRawDevice(db, 'Core-SW', '192.168.1.1', false, TEST_MK)
    insertRawDevice(db, ' CORE-SW ', '192.168.1.2', false, TEST_MK) // 回填后归一化重名
    insertRawDevice(db, 'Solo-FW', '10.3.0.1', false, TEST_MK)
    const r1 = backfillNameHash()
    expect(r1.backfilled).toBe(3)
    expect(r1.duplicateGroups).toBe(1)
    const r2 = backfillNameHash() // WHERE name_hash IS NULL 守卫 → 幂等
    expect(r2.backfilled).toBe(0)
    expect(r2.duplicateGroups).toBe(1)
    expect(db.prepare('SELECT name_hash FROM devices WHERE id = ?').get(a)).toEqual({ name_hash: hashDeviceName('Core-SW') })
  })

  it('listDuplicateGroups 对两台 Core-SW 变体返回 1 组 2 成员且 name/ipAddress 为明文（D-09）', () => {
    const db = H.delegate as Database.Database
    insertRawDevice(db, 'Core-SW', '192.168.1.1', true, TEST_MK)
    insertRawDevice(db, ' CORE-SW ', '192.168.1.2', true, TEST_MK)
    insertRawDevice(db, 'Solo-FW', '10.3.0.1', true, TEST_MK)
    const groups = listDuplicateGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].nameHash).toBe(hashDeviceName('Core-SW'))
    expect(groups[0].devices).toHaveLength(2)
    const names = groups[0].devices.map((d) => d.name)
    expect(names).toContain('Core-SW')
    expect(names).toContain(' CORE-SW ')
    expect(groups[0].devices.every((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d.ipAddress))).toBe(true)
    expect(groups[0].devices[0]).toHaveProperty('model')
    expect(groups[0].devices[0]).toHaveProperty('vendor')
  })

  it('ensureNameUniqueIndex 有重名组返回 false；消除重名后返回 true 且 sqlite_master 出现索引（D-10）', () => {
    const db = H.delegate as Database.Database
    const a = insertRawDevice(db, 'Core-SW', '192.168.1.1', true, TEST_MK)
    insertRawDevice(db, 'core‑sw', '192.168.1.2', true, TEST_MK)
    expect(ensureNameUniqueIndex()).toBe(false) // 清零门控：重名跳过不 throw
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_devices_name_hash'").get()).toBeUndefined()
    updateDevice(a, { name: 'Core-SW-2' }) // 消除重名（后端自动接线也在本路径，下行断言）
    expect(ensureNameUniqueIndex()).toBe(true)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_devices_name_hash'").get()).toBeTruthy()
  })

  it('后端自动接线：updateDevice 重命名消重后无需手动调用即出现 idx_devices_name_hash（D-10）', () => {
    const db = H.delegate as Database.Database
    // 服务层唯一拦截使 createDevice 无法直接构造重名——用带 hash 直插模拟存量重名库（v24 门控跳过后的状态）
    const a = insertRawDevice(db, 'Core-SW', '192.168.1.1', true, TEST_MK)
    const b = insertRawDevice(db, ' CORE-SW ', '192.168.1.2', true, TEST_MK)
    expect(listDuplicateGroups()).toHaveLength(1)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_devices_name_hash'").get()).toBeUndefined()
    updateDevice(b, { name: 'Edge-SW' }) // 事务提交后自动检测清零并建索引
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_devices_name_hash'").get()).toBeTruthy()
    expect(a).toBeTruthy()
  })

  it('ensureNameUniqueIndex 已有索引时再调返回 true 且无副作用（幂等）', () => {
    const db = H.delegate as Database.Database
    insertRawDevice(db, 'Only-FW', '10.4.0.1', true, TEST_MK)
    expect(ensureNameUniqueIndex()).toBe(true)
    expect(ensureNameUniqueIndex()).toBe(true) // sqlite_master no-op 守卫，多次调用安全
    expect(count().c).toBe(1)
  })
})
