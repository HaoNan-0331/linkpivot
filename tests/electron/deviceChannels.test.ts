import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 36（36-02，LOGIN-01）设备通道写路径 + 投影红线测试。
 *
 * 覆盖裁决（36-02-PLAN interfaces）：
 * - a) channels 四节提交：enabled 节 UPSERT 落子表（列映射 + rdp 行 resolution 明文直写，D-04）
 * - b) D-09 滑落：删默认通道按固定序滑到下一条已配 / 全删置 NULL；D-07 默认通道必为已配
 *      （显式指向未配置通道被滑回）；拓扑级联以滑落终值刷新（Pitfall 9 快照跟随）
 * - c) 字段级「留空=不修改」（H-1）：凭证字段 !== undefined 才写，单字段更新其余保留
 * - d) 过渡 shim：旧平铺入参按 connectionType 映射单通道节走同一 UPSERT（36-04 移除）；
 *      纯改名等操作零通道写
 * - e) H-1 递归脱敏红线：maskDeviceSecrets 后投影 JSON 无明文凭证，
 *      channels[*].password / sshKeyContent 匹配 ****尾4，resolution 明文保留（非脱敏清单）
 *
 * Mock 策略：经 vi.hoisted delegate 注入真 better-sqlite3 内存库（H.delegate 模式，
 * capabilities 组同款——test:electron 走 electron ABI，native binding 可加载）。
 * schema 为 36-02 后 fresh 形态：devices 无六行内凭证列（照抄 init.ts），
 * 凭证唯一真源 device_credentials——写路径若仍引用旧列立即 SQL 报错（D-08 反向锁死）。
 */

const H = vi.hoisted(() => ({
  delegate: null as Database.Database | null,
}))

vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => H.delegate,
}))

import { createDevice, updateDevice, listDevices, maskDeviceSecrets, setDeviceMasterKey } from '../../electron/services/device'
import { encField, decField } from '../../electron/utils/crypto'

const TEST_MK = 'test-mk-36-02'

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
      device_type TEXT DEFAULT 'generic' CHECK(device_type IN ('router','switch','firewall','server','generic')),
      connection_type TEXT CHECK(connection_type IN ('ssh','telnet','web','rdp')),
      name_hash TEXT,
      status TEXT DEFAULT 'unknown',
      last_checked TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (topology_id) REFERENCES topologies(id) ON DELETE SET NULL
    );
    CREATE TABLE device_credentials (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('ssh','telnet','web','rdp')),
      port_enc TEXT,
      username_enc TEXT,
      password_enc TEXT,
      ssh_key_path_enc TEXT,
      ssh_key_content_enc TEXT,
      web_url_enc TEXT,
      resolution TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(device_id, channel),
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_device_credentials_device ON device_credentials(device_id);
    CREATE TABLE mcp_device_rel (
      mcp_config_id TEXT NOT NULL,
      device_id TEXT NOT NULL UNIQUE
    );
  `)
  return db
}

/** 直读某设备某通道子表行（裸 SQL，不经 service 解密路径）。 */
function credRow(deviceId: string, channel: string): any {
  return (H.delegate as Database.Database)
    .prepare('SELECT * FROM device_credentials WHERE device_id = ? AND channel = ?')
    .get(deviceId, channel) as any
}

/** 该设备全部已配通道（固定序无关，排序后比对）。 */
function rowChannels(deviceId: string): string[] {
  return ((H.delegate as Database.Database)
    .prepare('SELECT channel FROM device_credentials WHERE device_id = ?')
    .all(deviceId) as any[])
    .map((r) => r.channel as string)
    .sort()
}

/** devices.connection_type 当前值（D-09 滑落终值权威断言源）。 */
function connType(deviceId: string): string | null {
  const row = (H.delegate as Database.Database)
    .prepare('SELECT connection_type FROM devices WHERE id = ?')
    .get(deviceId) as any
  return row?.connection_type ?? null
}

/** 直插一条引用指定设备的拓扑（updateDevice topoFields 级联断言用）。 */
function insertTopologyWithNode(db: Database.Database, topoId: string, deviceId: string, connectionType: string) {
  db.prepare(`
    INSERT INTO topologies (id, name_enc, data_enc, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(topoId, encField(`拓扑-${topoId}`, TEST_MK), encField(JSON.stringify({
    nodes: [{ id: 'n-1', data: { deviceId, deviceName: '节点', connectionType } }],
    edges: [],
  }), TEST_MK))
}

function readTopoNodes(db: Database.Database, topoId: string): any[] {
  const row = db.prepare('SELECT data_enc FROM topologies WHERE id = ?').get(topoId) as any
  return (JSON.parse(decField(row.data_enc, TEST_MK)) as any).nodes
}

describe('device 通道写路径 + 投影红线（36-02）', () => {
  beforeEach(() => {
    H.delegate = makeDb()
    setDeviceMasterKey(TEST_MK)
  })

  afterEach(() => {
    H.delegate?.close()
    H.delegate = null
    setDeviceMasterKey('')
  })

  it('a) channels 四节提交：三节 enabled 落子表恰三行、列映射正确、rdp 行 resolution 明文直写', () => {
    const db = H.delegate as Database.Database
    const dev: any = createDevice({
      name: 'Core-FW', ipAddress: '10.0.0.1', connectionType: 'ssh',
      channels: [
        { channel: 'ssh', enabled: true, port: 22, username: 'admin', password: 'pw-ssh' },
        { channel: 'telnet', enabled: false },
        { channel: 'web', enabled: true, webUrl: 'https://10.0.0.1:8443' },
        { channel: 'rdp', enabled: true, username: 'rdpuser', resolution: '1920x1080' },
      ],
    })
    // enabled=false 节不落行：恰三行
    const cnt = (db.prepare('SELECT COUNT(*) AS c FROM device_credentials').get() as any).c
    expect(cnt).toBe(3)

    const ssh = credRow(dev.id, 'ssh')
    expect(decField(ssh.port_enc, TEST_MK)).toBe('22')
    expect(decField(ssh.username_enc, TEST_MK)).toBe('admin')
    expect(decField(ssh.password_enc, TEST_MK)).toBe('pw-ssh')
    expect(decField(ssh.web_url_enc, TEST_MK)).toBe('') // 未传字段 null → decField 空串

    const web = credRow(dev.id, 'web')
    expect(decField(web.web_url_enc, TEST_MK)).toBe('https://10.0.0.1:8443')

    const rdp = credRow(dev.id, 'rdp')
    expect(decField(rdp.username_enc, TEST_MK)).toBe('rdpuser')
    // D-04 裁决补记：resolution 为明文列直写（非 _enc、未加密、不以 v2: 前缀）
    expect(rdp.resolution).toBe('1920x1080')
    expect(String(rdp.resolution).startsWith('v2:')).toBe(false)

    // 投影回读：capabilities 按子表派生 + channels 固定序（ssh > telnet > web > rdp）
    expect(dev.capabilities.hasSSH).toBe(true)
    expect(dev.channels.map((c: any) => c.channel)).toEqual(['ssh', 'web', 'rdp'])
    expect(dev.channels[2].resolution).toBe('1920x1080')
  })

  it('b) 删默认通道滑落 + D-07 默认必为已配 + 全删置 NULL + 拓扑级联用滑落终值刷新', () => {
    const db = H.delegate as Database.Database
    const dev: any = createDevice({
      name: 'Slide-FW', ipAddress: '10.0.0.2', connectionType: 'ssh',
      channels: [
        { channel: 'ssh', enabled: true, username: 'u' },
        { channel: 'web', enabled: true, webUrl: 'https://10.0.0.2' },
        { channel: 'rdp', enabled: true, resolution: '1280x720' },
      ],
    })
    insertTopologyWithNode(db, 'topo-1', dev.id, 'ssh')
    expect(connType(dev.id)).toBe('ssh')

    // 删默认 ssh → 固定序下一条已配 = web（D-09）
    updateDevice(dev.id, {
      channels: [
        { channel: 'ssh', enabled: false },
        { channel: 'web', enabled: true },
        { channel: 'rdp', enabled: true },
      ],
    })
    expect(connType(dev.id)).toBe('web')
    // 拓扑节点快照以滑落终值刷新（connectionType 在 topoFields 级联集内，Pitfall 9）
    expect(readTopoNodes(db, 'topo-1')[0].data.connectionType).toBe('web')

    // D-07：默认通道必为已配通道——显式指向未配置通道按固定序滑回已配首条
    updateDevice(dev.id, {
      connectionType: 'telnet',
      channels: [
        { channel: 'web', enabled: true },
        { channel: 'rdp', enabled: true },
      ],
    })
    expect(connType(dev.id)).toBe('web')

    // 四节全 off → connection_type NULL 且子表零行（零通道，D-02 兜底）
    updateDevice(dev.id, {
      channels: [
        { channel: 'ssh', enabled: false }, { channel: 'telnet', enabled: false },
        { channel: 'web', enabled: false }, { channel: 'rdp', enabled: false },
      ],
    })
    expect(connType(dev.id)).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS c FROM device_credentials').get() as any).c).toBe(0)
    // 零通道后投影：channels 空 + capabilities 全 false
    const after: any = listDevices().find((x: any) => x.id === dev.id)
    expect(after.channels).toHaveLength(0)
    expect(after.capabilities).toEqual({ hasSSH: false, hasTelnet: false, hasMcp: false })
  })

  it('c) 字段级留空=不修改（H-1）：无凭证字段节点保留既有行；单字段更新其余保留', () => {
    const dev: any = createDevice({
      name: 'Keep-SW', ipAddress: '10.0.0.3', connectionType: 'ssh',
      channels: [{ channel: 'ssh', enabled: true, port: 2222, username: 'u1', password: 'p1' }],
    })

    // enabled 节无任何凭证字段（全 undefined）→ 既有子表行凭证不变（UPSERT 条件更新零命中）
    updateDevice(dev.id, { channels: [{ channel: 'ssh', enabled: true }] })
    let ssh = credRow(dev.id, 'ssh')
    expect(decField(ssh.port_enc, TEST_MK)).toBe('2222')
    expect(decField(ssh.username_enc, TEST_MK)).toBe('u1')
    expect(decField(ssh.password_enc, TEST_MK)).toBe('p1')

    // 仅传 password → 只改 password，username/port 保留（IIF 在场标志位字段级生效）
    updateDevice(dev.id, { channels: [{ channel: 'ssh', enabled: true, password: 'p2' }] })
    ssh = credRow(dev.id, 'ssh')
    expect(decField(ssh.password_enc, TEST_MK)).toBe('p2')
    expect(decField(ssh.username_enc, TEST_MK)).toBe('u1')
    expect(decField(ssh.port_enc, TEST_MK)).toBe('2222')
  })

  it('d) 过渡 shim：平铺入参按 connectionType 映射单通道节走同一 UPSERT；纯改名零通道写', () => {
    // create shim：默认通道 ssh 行落库（凭证空——旧行为 connectionType 决定通道存在性）
    const dev: any = createDevice({ name: 'Shim-R', ipAddress: '10.0.0.4', connectionType: 'ssh' })
    expect(rowChannels(dev.id)).toEqual(['ssh'])

    // update shim：connectionType + 在场平铺凭证字段 → telnet 行 UPSERT 落库
    updateDevice(dev.id, { connectionType: 'telnet', username: 'u', password: 'p' })
    expect(rowChannels(dev.id)).toEqual(['ssh', 'telnet'])
    const telnet = credRow(dev.id, 'telnet')
    expect(decField(telnet.username_enc, TEST_MK)).toBe('u')
    expect(decField(telnet.password_enc, TEST_MK)).toBe('p')
    expect(connType(dev.id)).toBe('telnet')

    // 纯改名（无平铺凭证字段）→ 不产生通道写、不清既有行、凭证不变
    updateDevice(dev.id, { name: 'Shim-R2' })
    expect(rowChannels(dev.id)).toEqual(['ssh', 'telnet'])
    expect(decField(credRow(dev.id, 'telnet').username_enc, TEST_MK)).toBe('u')
    expect(decField(credRow(dev.id, 'telnet').password_enc, TEST_MK)).toBe('p')
  })

  it('e) H-1 递归脱敏红线：投影 JSON 无明文凭证，channels[*] ****尾4，resolution 明文保留', () => {
    createDevice({
      name: 'Mask-FW', ipAddress: '10.0.0.5', connectionType: 'ssh',
      channels: [
        { channel: 'ssh', enabled: true, username: 'ops', password: 'secret123', sshKeyContent: 'KEYBODY-xyz9' },
        { channel: 'rdp', enabled: true, resolution: '1920x1080' },
      ],
    })
    const masked: any = maskDeviceSecrets(listDevices()[0])

    // 红线：整投影 JSON 不含明文凭证（channels 递归脱敏漏掉即红）
    const json = JSON.stringify(masked)
    expect(json).not.toContain('secret123')
    expect(json).not.toContain('KEYBODY-xyz9')

    for (const ch of masked.channels) {
      if (ch.password) expect(ch.password).toMatch(/^\*{4}.{0,4}$/)
      if (ch.sshKeyContent) expect(ch.sshKeyContent).toMatch(/^\*{4}.{0,4}$/)
    }
    const sshCh = masked.channels.find((c: any) => c.channel === 'ssh')
    expect(sshCh.password).toBe('****t123') // secret123 → ****尾4
    expect(sshCh.sshKeyContent).toBe('****xyz9')

    // resolution 非脱敏清单字段：明文合法下发（D-04 裁决补记）
    const rdpCh = masked.channels.find((c: any) => c.channel === 'rdp')
    expect(rdpCh.resolution).toBe('1920x1080')
    // 非脱敏字段原样透传（username 不在 SECRET_KEYS）
    expect(sshCh.username).toBe('ops')
  })
})
