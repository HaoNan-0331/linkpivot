import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 25.1（25.1-01）：updateDevice 拓扑级联同步回归护栏。
 *
 * 缺陷背景：TopologyPage.handleEditConfirm 旁路写库（只 setNodes + debounce 写
 * topologies.data_enc，不调 device:update）→ devices 主表/name_hash 零更新。
 * 修复：拓扑侧收敛 device:update 单一写路径，本测试集锁定 service 层
 * updateDevice 的既有正确行为（devices 同步 + topologies 级联 + name_hash 维护
 * + 事务回滚 + 级联容错），防未来回归。
 *
 * 注意：service 层级联已实现（缺陷在 renderer 不在 service），故本组用例
 * 预期直接全绿——定位为「防回归护栏」，RED 语义由 Task 2 真机路径覆盖。
 *
 * Mock 策略：经 vi.hoisted delegate 注入真 better-sqlite3 内存库
 * （test:electron 走 electron ABI，native binding 可加载）。
 * DDL 与 init.ts 对齐，devices 表含 name_hash 列（25-02 教训）。
 */

const H = vi.hoisted(() => ({
  delegate: null as Database.Database | null,
}))

vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => H.delegate,
}))

import { createDevice, updateDevice, setDeviceMasterKey } from '../../electron/services/device'
import { hashDeviceName } from '../../electron/services/deviceName'
import { encField, decField } from '../../electron/utils/crypto'

const TEST_MK = 'test-mk-25-1-01'

function makeDb(): Database.Database {
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
    CREATE UNIQUE INDEX idx_devices_name_hash ON devices(name_hash);
    CREATE TABLE mcp_device_rel (
      mcp_config_id TEXT NOT NULL,
      device_id TEXT NOT NULL UNIQUE
    );
  `)
  return db
}

/** 直插一条 topologies 行，data_enc 为加密后的 JSON（内嵌节点引用指定设备）。 */
function insertTopology(db: Database.Database, topoId: string, nodes: any[], mk: string) {
  db.prepare(`
    INSERT INTO topologies (id, name_enc, data_enc, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(topoId, encField(`拓扑-${topoId}`, mk), encField(JSON.stringify({ nodes, edges: [] }), mk))
}

/** 解密拓扑 data_enc 并 JSON.parse。 */
function readTopologyNodes(db: Database.Database, topoId: string, mk: string): any[] {
  const row = db.prepare('SELECT data_enc FROM topologies WHERE id = ?').get(topoId) as any
  return (JSON.parse(decField(row.data_enc, mk)) as any).nodes
}

describe('updateDevice 拓扑级联同步（25.1-01 防回归护栏）', () => {
  beforeEach(() => {
    H.delegate = makeDb()
    setDeviceMasterKey(TEST_MK)
  })

  afterEach(() => {
    H.delegate?.close()
    H.delegate = null
    setDeviceMasterKey('')
  })

  it('Test 1: devices 同步——name/ip/deviceType/vendor/model 落表且 updated_at 刷新', async () => {
    const dev = createDevice({ name: '旧名', ipAddress: '10.0.0.1', connectionType: 'ssh' })
    await new Promise((r) => setTimeout(r, 10)) // 保证时间戳精度区分 created/updated
    updateDevice(dev.id, { name: '新名', ipAddress: '10.0.0.99', deviceType: 'switch', vendor: 'H3C', model: 'S5735' })
    const row = (H.delegate as Database.Database).prepare('SELECT * FROM devices WHERE id = ?').get(dev.id) as any
    expect(decField(row.name_enc, TEST_MK)).toBe('新名')
    expect(decField(row.ip_enc, TEST_MK)).toBe('10.0.0.99')
    expect(row.device_type).toBe('switch')
    expect(decField(row.vendor_enc, TEST_MK)).toBe('H3C')
    expect(decField(row.model_enc, TEST_MK)).toBe('S5735')
    expect(row.updated_at).not.toBe(row.created_at)
  })

  it('Test 2: 拓扑级联——topologies.data_enc 内嵌节点字段逐字段更新且 updated_at 刷新', async () => {
    const db = H.delegate as Database.Database
    const dev = createDevice({ name: '旧名', ipAddress: '10.0.0.1', connectionType: 'ssh' })
    insertTopology(db, 'topo-1', [
      { id: 'n-1', data: { deviceId: dev.id, deviceName: '旧名', ipAddress: '10.0.0.1', deviceType: 'generic' } },
      { id: 'n-2', data: { deviceId: 'other-device', deviceName: '无关设备', ipAddress: '172.16.0.1' } },
    ], TEST_MK)
    const before = db.prepare('SELECT updated_at FROM topologies WHERE id = ?').get('topo-1') as any
    await new Promise((r) => setTimeout(r, 1100)) // 拓扑行 DDL 时间戳为 localtime 秒级
    updateDevice(dev.id, { name: '新名', ipAddress: '10.0.0.99' })
    const nodes = readTopologyNodes(db, 'topo-1', TEST_MK)
    expect(nodes[0].data.deviceName).toBe('新名')
    expect(nodes[0].data.ipAddress).toBe('10.0.0.99')
    // 非引用节点不被误改
    expect(nodes[1].data.deviceName).toBe('无关设备')
    expect(nodes[1].data.ipAddress).toBe('172.16.0.1')
    const after = db.prepare('SELECT updated_at FROM topologies WHERE id = ?').get('topo-1') as any
    expect(after.updated_at).not.toBe(before.updated_at)
  })

  it('Test 3: name_hash 维护——update 后 devices.name_hash == hashDeviceName(新名)', () => {
    const db = H.delegate as Database.Database
    const dev = createDevice({ name: '旧名', ipAddress: '10.0.0.1', connectionType: 'ssh' })
    updateDevice(dev.id, { name: '新名' })
    const row = db.prepare('SELECT name_hash FROM devices WHERE id = ?').get(dev.id) as any
    expect(row.name_hash).toBe(hashDeviceName('新名'))
  })

  it('Test 4: 重名拦截——改名撞他人 throw 且事务回滚 devices 行未变', () => {
    const db = H.delegate as Database.Database
    const a = createDevice({ name: '设备A', ipAddress: '10.0.0.1', connectionType: 'ssh' })
    createDevice({ name: '设备B', ipAddress: '10.0.0.2', connectionType: 'ssh' })
    expect(() => updateDevice(a.id, { name: '设备B', ipAddress: '10.9.9.9' }))
      .toThrow(/设备名称已存在：设备B \(10\.0\.0\.2\)/)
    const row = db.prepare('SELECT name_enc, ip_enc FROM devices WHERE id = ?').get(a.id) as any
    expect(decField(row.name_enc, TEST_MK)).toBe('设备A') // 回滚，未落脏值
    expect(decField(row.ip_enc, TEST_MK)).toBe('10.0.0.1')
  })

  it('Test 5: 清空 vendor/model 落库（CR-01 25.1）——传空串时 devices 表真实清空且拓扑级联一致', () => {
    const db = H.delegate as Database.Database
    const dev = createDevice({ name: '设备X', ipAddress: '10.0.0.1', connectionType: 'ssh', vendor: '华为', model: 'S5735' })
    insertTopology(db, 'topo-1', [
      { id: 'n-1', data: { deviceId: dev.id, deviceName: '设备X', ipAddress: '10.0.0.1', vendor: '华为', model: 'S5735' } },
    ], TEST_MK)
    // 模拟 EditNodeModal 修复后的提交语义：空串=清空（修复前是 undefined，`!== undefined` 守卫旁路）
    updateDevice(dev.id, { vendor: '', model: '' })
    const row = db.prepare('SELECT vendor_enc, model_enc FROM devices WHERE id = ?').get(dev.id) as any
    expect(decField(row.vendor_enc, TEST_MK)).toBe('')
    expect(decField(row.model_enc, TEST_MK)).toBe('')
    const nodes = readTopologyNodes(db, 'topo-1', TEST_MK)
    expect(nodes[0].data.vendor).toBe('')
    expect(nodes[0].data.model).toBe('')
  })

  it('Test 6: 级联容错——data_enc 非法 JSON 的拓扑被跳过，其余拓扑正常级联且不 throw', () => {
    const db = H.delegate as Database.Database
    const dev = createDevice({ name: '旧名', ipAddress: '10.0.0.1', connectionType: 'ssh' })
    // topo-bad: 非法 JSON（解密后不是合法 JSON）
    db.prepare(`
      INSERT INTO topologies (id, name_enc, data_enc, created_at, updated_at)
      VALUES ('topo-bad', ?, ?, datetime('now'), datetime('now'))
    `).run(encField('坏拓扑', TEST_MK), encField('not-a-json{{{', TEST_MK))
    insertTopology(db, 'topo-good', [
      { id: 'n-1', data: { deviceId: dev.id, deviceName: '旧名', ipAddress: '10.0.0.1' } },
    ], TEST_MK)
    expect(() => updateDevice(dev.id, { name: '新名' })).not.toThrow()
    const nodes = readTopologyNodes(db, 'topo-good', TEST_MK)
    expect(nodes[0].data.deviceName).toBe('新名')
    const bad = db.prepare('SELECT data_enc FROM topologies WHERE id = ?').get('topo-bad') as any
    expect(decField(bad.data_enc, TEST_MK)).toBe('not-a-json{{{') // 坏行原样保留
  })
})
