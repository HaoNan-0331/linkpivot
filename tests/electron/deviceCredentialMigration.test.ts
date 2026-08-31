import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 36 Plan 36-01 Task 2 —— DeviceCredentialMigration post-MK 回填 + 清列钩子
 * 真路径验证（LOGIN-03 / D-08）。
 *
 * 模式：_setDbGetter 注入真 better-sqlite3 内存库（test:electron 走 electron ABI，
 * native binding 可加载）+ setDeviceCredentialMasterKey 注入测试 MK（mcpDeviceEnvMigration
 * 骨架自带测试口）。测试自建 schema：旧形态 devices 表（含六个行内凭证列）+ v32 建表
 * device_credentials 子表。
 *
 * 用例（plan 验收 a-e）：
 *   a) ssh/telnet/web/rdp 四通道各一设备回填：子表行落在正确 (device_id, channel)，
 *      列映射符合 36-CONTEXT 回填映射表，resolution 恒 NULL，devices 原行身份不动
 *   b) 凭证全空设备（六列全 NULL）不产生子表行（零通道设备，D-02 兜底前提）
 *   c) 坏密文行 skipped=1 不插行、六列仍在、droppedColumns=false（保数据待重试）
 *   d) 全部迁完 → 六列被 DROP、droppedColumns=true；再次调用根守卫 no-op 全零（幂等）
 *   e) MK 未注入（空串）→ 直接返回全零不碰库
 *
 * 安全域：内存库（`:memory:`）无落盘；只跑回填钩子本体不碰 runMigrations/system log。
 */

import { DeviceCredentialMigration } from '../../electron/services/deviceCredentialMigration'
import { v32 } from '../../electron/database/migrations'
import { encField, decField } from '../../electron/utils/crypto'
import { hasColumn } from '../../electron/database/migrationHelpers'

const TEST_MK = 'dc-migration-test-key'
const BAD_CIPHER = '@@@not-a-valid-cipher@@@'

/** 旧形态 devices 表（六行内凭证列在场）+ v32 建子表 */
function createLegacySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name_enc TEXT NOT NULL,
      connection_type TEXT CHECK(connection_type IN ('ssh','telnet','web','rdp')),
      port_enc TEXT,
      username_enc TEXT,
      password_enc TEXT,
      ssh_key_path_enc TEXT,
      ssh_key_content_enc TEXT,
      web_url_enc TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `)
  v32(db)
}

interface SeedDevice {
  id: string
  connectionType: string | null
  port?: string
  username?: string
  password?: string
  sshKeyPath?: string
  sshKeyContent?: string
  webUrl?: string
  /** 直写裸串（不走 encField）——坏密文场景用 */
  rawPasswordEnc?: string
}

function seedDevice(db: Database.Database, d: SeedDevice): void {
  db.prepare(`
    INSERT INTO devices (id, name_enc, connection_type, port_enc, username_enc, password_enc,
      ssh_key_path_enc, ssh_key_content_enc, web_url_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.id,
    encField(`name-${d.id}`, TEST_MK),
    d.connectionType,
    d.port != null ? encField(d.port, TEST_MK) : null,
    d.username != null ? encField(d.username, TEST_MK) : null,
    d.rawPasswordEnc !== undefined ? d.rawPasswordEnc : (d.password != null ? encField(d.password, TEST_MK) : null),
    d.sshKeyPath != null ? encField(d.sshKeyPath, TEST_MK) : null,
    d.sshKeyContent != null ? encField(d.sshKeyContent, TEST_MK) : null,
    d.webUrl != null ? encField(d.webUrl, TEST_MK) : null
  )
}

interface ChildRow {
  device_id: string
  channel: string
  port_enc: string | null
  username_enc: string | null
  password_enc: string | null
  ssh_key_path_enc: string | null
  ssh_key_content_enc: string | null
  web_url_enc: string | null
  resolution: string | null
}

function getChildRows(db: Database.Database): ChildRow[] {
  return db
    .prepare('SELECT device_id, channel, port_enc, username_enc, password_enc, ssh_key_path_enc, ssh_key_content_enc, web_url_enc, resolution FROM device_credentials ORDER BY device_id')
    .all() as ChildRow[]
}

/** 解密子表行回明文形态（null 保持 null，断言映射用） */
function decryptChild(row: ChildRow) {
  return {
    device_id: row.device_id,
    channel: row.channel,
    port: row.port_enc == null ? null : decField(row.port_enc, TEST_MK),
    username: row.username_enc == null ? null : decField(row.username_enc, TEST_MK),
    password: row.password_enc == null ? null : decField(row.password_enc, TEST_MK),
    sshKeyPath: row.ssh_key_path_enc == null ? null : decField(row.ssh_key_path_enc, TEST_MK),
    sshKeyContent: row.ssh_key_content_enc == null ? null : decField(row.ssh_key_content_enc, TEST_MK),
    webUrl: row.web_url_enc == null ? null : decField(row.web_url_enc, TEST_MK),
    resolution: row.resolution,
  }
}

const LEGACY_COLS = ['port_enc', 'username_enc', 'password_enc', 'ssh_key_path_enc', 'ssh_key_content_enc', 'web_url_enc']

afterEach(() => {
  // 静态态复位（migrations.test.ts v20-d 先例）：防跨用例 MK/dbGetter 泄漏
  DeviceCredentialMigration.setDeviceCredentialMasterKey('')
  DeviceCredentialMigration._setDbGetter(() => {
    throw new Error('neutral')
  })
})

describe('DeviceCredentialMigration.backfillDeviceCredentials（LOGIN-03/D-08）', () => {
  it('a) 四通道各一设备：子表行落正确 (device_id, channel)，列映射符合回填映射表，resolution 恒 NULL', () => {
    const db = new Database(':memory:')
    createLegacySchema(db)
    seedDevice(db, { id: 'dev-ssh', connectionType: 'ssh', port: '22', username: 'admin', password: 'secret-ssh', sshKeyPath: '/keys/id_rsa', sshKeyContent: 'KEYDATA' })
    seedDevice(db, { id: 'dev-telnet', connectionType: 'telnet', port: '23', username: 'tadmin', password: 'tsecret' })
    seedDevice(db, { id: 'dev-web', connectionType: 'web', webUrl: 'https://mgmt.local' })
    seedDevice(db, { id: 'dev-rdp', connectionType: 'rdp', port: '3389', username: 'rdpuser' })

    DeviceCredentialMigration.setDeviceCredentialMasterKey(TEST_MK)
    DeviceCredentialMigration._setDbGetter(() => db)
    const r = DeviceCredentialMigration.backfillDeviceCredentials()

    expect(r.backfilled).toBe(4)
    expect(r.skipped).toBe(0)
    expect(r.droppedColumns).toBe(true) // 全部迁完无坏行 → D-08 清列（T-36-01-03 预期收敛）

    const rows = getChildRows(db)
    expect(rows).toHaveLength(4)
    expect(decryptChild(rows[0])).toEqual({
      device_id: 'dev-rdp', channel: 'rdp', port: '3389', username: 'rdpuser',
      password: null, sshKeyPath: null, sshKeyContent: null, webUrl: null, resolution: null,
    })
    expect(decryptChild(rows[1])).toEqual({
      device_id: 'dev-ssh', channel: 'ssh', port: '22', username: 'admin', password: 'secret-ssh',
      sshKeyPath: '/keys/id_rsa', sshKeyContent: 'KEYDATA', webUrl: null, resolution: null,
    })
    expect(decryptChild(rows[2])).toEqual({
      device_id: 'dev-telnet', channel: 'telnet', port: '23', username: 'tadmin', password: 'tsecret',
      sshKeyPath: null, sshKeyContent: null, webUrl: null, resolution: null,
    })
    expect(decryptChild(rows[3])).toEqual({
      device_id: 'dev-web', channel: 'web', port: null, username: null, password: null,
      sshKeyPath: null, sshKeyContent: null, webUrl: 'https://mgmt.local', resolution: null,
    })
    // 回填不触碰 resolution 列（无历史来源，D-04 裁决补记——迁移后恒 NULL）
    for (const row of rows) expect(row.resolution).toBeNull()
    // devices 原行身份不动（行数/主键/默认通道语义列保留）
    const devs = db.prepare('SELECT id, connection_type FROM devices ORDER BY id').all() as any[]
    expect(devs.map((d) => d.id)).toEqual(['dev-rdp', 'dev-ssh', 'dev-telnet', 'dev-web'])
    expect(devs.find((d) => d.id === 'dev-ssh')!.connection_type).toBe('ssh') // D-07 默认通道旧值保留
    db.close()
  })

  it('b) 凭证全空设备（六列全 NULL）不产生子表行（零通道设备，D-02 兜底前提）', () => {
    const db = new Database(':memory:')
    createLegacySchema(db)
    seedDevice(db, { id: 'dev-empty', connectionType: 'ssh' }) // 有 connection_type 但凭证全空
    seedDevice(db, { id: 'dev-real', connectionType: 'ssh', username: 'admin', password: 'pw' })

    DeviceCredentialMigration.setDeviceCredentialMasterKey(TEST_MK)
    DeviceCredentialMigration._setDbGetter(() => db)
    const r = DeviceCredentialMigration.backfillDeviceCredentials()

    expect(r.backfilled).toBe(1) // 只有 dev-real
    const rows = getChildRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].device_id).toBe('dev-real')
    expect(rows.findIndex((x) => x.device_id === 'dev-empty')).toBe(-1) // 空设备零子表行
    db.close()
  })

  it('c) 坏密文行 skipped=1 不插行、六列仍在（hasColumn true）、droppedColumns=false', () => {
    const db = new Database(':memory:')
    createLegacySchema(db)
    seedDevice(db, { id: 'dev-good', connectionType: 'telnet', port: '23', username: 'ok', password: 'ok-pw' })
    seedDevice(db, { id: 'dev-bad', connectionType: 'ssh', username: 'admin', rawPasswordEnc: BAD_CIPHER })

    DeviceCredentialMigration.setDeviceCredentialMasterKey(TEST_MK)
    DeviceCredentialMigration._setDbGetter(() => db)
    const r = DeviceCredentialMigration.backfillDeviceCredentials()

    expect(r.backfilled).toBe(1) // 好行正常迁
    expect(r.skipped).toBe(1) // 坏密文整行跳过（Pitfall 2 不造假数据）
    expect(r.droppedColumns).toBe(false) // skipped>0 保留旧列，下次启动重试
    for (const col of LEGACY_COLS) expect(hasColumn(db, 'devices', col)).toBe(true)
    const rows = getChildRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].device_id).toBe('dev-good')
    // 坏行数据原样保活（不清列不清值——保数据，下次启动可续跑重试）
    const bad = db.prepare('SELECT username_enc, password_enc FROM devices WHERE id = ?').get('dev-bad') as any
    expect(decField(bad.username_enc, TEST_MK)).toBe('admin')
    expect(bad.password_enc).toBe(BAD_CIPHER)
    db.close()
  })

  it('d) 全部迁完（含空设备）→ 六列被 DROP、droppedColumns=true；再次调用根守卫 no-op 全零（幂等）', () => {
    const db = new Database(':memory:')
    createLegacySchema(db)
    seedDevice(db, { id: 'dev-ssh', connectionType: 'ssh', port: '22', username: 'admin', password: 'pw' })
    seedDevice(db, { id: 'dev-empty', connectionType: 'web' }) // 空设备同库

    DeviceCredentialMigration.setDeviceCredentialMasterKey(TEST_MK)
    DeviceCredentialMigration._setDbGetter(() => db)
    const r1 = DeviceCredentialMigration.backfillDeviceCredentials()

    expect(r1).toEqual({ backfilled: 1, skipped: 0, droppedColumns: true })
    for (const col of LEGACY_COLS) expect(hasColumn(db, 'devices', col)).toBe(false) // D-08 物理清理
    // 子表行保活（清列不丢数据）
    expect(getChildRows(db)).toHaveLength(1)

    // 再次调用：根守卫（password_enc 不存在）整体 no-op 返回全零
    const r2 = DeviceCredentialMigration.backfillDeviceCredentials()
    expect(r2).toEqual({ backfilled: 0, skipped: 0, droppedColumns: false })
    expect(getChildRows(db)).toHaveLength(1) // 零动作不重插
    db.close()
  })

  it('e) MK 未注入（空串）→ 直接返回全零不碰库（T-29-02-04 防空 key 造假密文）', () => {
    const db = new Database(':memory:')
    createLegacySchema(db)
    seedDevice(db, { id: 'dev-ssh', connectionType: 'ssh', username: 'admin', password: 'pw' })

    DeviceCredentialMigration.setDeviceCredentialMasterKey('')
    DeviceCredentialMigration._setDbGetter(() => db)
    const r = DeviceCredentialMigration.backfillDeviceCredentials()

    expect(r).toEqual({ backfilled: 0, skipped: 0, droppedColumns: false })
    expect(getChildRows(db)).toHaveLength(0) // 不插行
    for (const col of LEGACY_COLS) expect(hasColumn(db, 'devices', col)).toBe(true) // 不清列
    db.close()
  })

  it('f) 重试续跑幂等：首轮迁好后二轮回填零重插（INSERT OR IGNORE，Pitfall 1 防约束死锁）', () => {
    const db = new Database(':memory:')
    createLegacySchema(db)
    seedDevice(db, { id: 'dev-ssh', connectionType: 'ssh', port: '22', username: 'admin', password: 'pw' })
    seedDevice(db, { id: 'dev-bad', connectionType: 'telnet', username: 'admin', rawPasswordEnc: BAD_CIPHER })

    DeviceCredentialMigration.setDeviceCredentialMasterKey(TEST_MK)
    DeviceCredentialMigration._setDbGetter(() => db)
    const r1 = DeviceCredentialMigration.backfillDeviceCredentials()
    expect(r1).toEqual({ backfilled: 1, skipped: 1, droppedColumns: false })

    // 修好坏密文后重跑：好行零重插（OR IGNORE）、坏行补迁、清列收敛
    db.prepare('UPDATE devices SET password_enc = ? WHERE id = ?').run(encField('fixed-pw', TEST_MK), 'dev-bad')
    const r2 = DeviceCredentialMigration.backfillDeviceCredentials()
    expect(r2).toEqual({ backfilled: 1, skipped: 0, droppedColumns: true })
    const rows = getChildRows(db)
    expect(rows).toHaveLength(2) // 恰两行（dev-ssh 未重插）
    expect(rows.filter((x) => x.device_id === 'dev-ssh')).toHaveLength(1)
    db.close()
  })
})
