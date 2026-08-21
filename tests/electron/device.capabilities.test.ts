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

import { listDevices, createDevice, updateDevice, checkDeviceName, setDeviceMasterKey } from '../../electron/services/device'
import { hashDeviceName } from '../../electron/services/deviceName'

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
describe('name_hash 唯一拦截与查重（25-02）', () => {
  const TEST_MK = 'test-mk-25-02'

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
