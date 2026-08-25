import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 29 Plan 29-06（PKG-05，D-16/D-17）—— mcpService 设备级 env 扩展真路径测试。
 *
 * Mock 策略（mcpDeviceEnvMigration.test.ts 惯例）：
 *   - getDatabase → vi.hoisted 内存库（service 本体真跑，含 encField/decField 真加密）
 *
 * 断言面：
 *   - saveConfig deviceEnvs：逐设备哨兵合并（UNCHANGED_ENV_SENTINEL 沿用旧值 / '' 删除键）
 *     + 未列出键保留语义 + 未绑定设备忽略（防越行写，T-29-06-04）
 *   - listConfigs 出口 deviceEnvMasked 只含 "KEY=****尾4"，永无明文（T-29-06-02）
 */

const h = vi.hoisted(() => ({
  db: null as Database.Database | null,
  registryMock: {
    listActive: vi.fn().mockReturnValue([]),
    killTree: vi.fn().mockReturnValue(true),
    register: vi.fn(),
    unregister: vi.fn(),
  },
  closeConfigConnections: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => h.db
}))

// WR-03：deleteConfig 杀实例路径——registry mock（不真 taskkill）
vi.mock('../../../electron/services/mcpProcessRegistry', () => ({
  McpProcessRegistry: h.registryMock,
}))

// 29-09 走查四：saveConfig env 变更杀连接路径——mock mcpClient（不真连 SDK）
vi.mock('../../../electron/services/mcpClient', () => ({
  closeConfigConnections: h.closeConfigConnections,
}))

import { McpService, UNCHANGED_ENV_SENTINEL } from '../../../electron/services/mcpService'
import { encField, decField } from '../../../electron/utils/crypto'

const TEST_MK = 'test-mk-29-06-manual'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('stdio','http','package')),
      command_or_url TEXT NOT NULL,
      args_json TEXT,
      env_json_enc TEXT,
      credential_enc TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_test_at TEXT,
      last_test_status TEXT,
      last_test_tool_count INTEGER,
      package_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE mcp_device_rel (
      id TEXT PRIMARY KEY,
      mcp_config_id INTEGER NOT NULL,
      device_id TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      env_json_enc TEXT,
      FOREIGN KEY (mcp_config_id) REFERENCES mcp_configs(id) ON DELETE CASCADE
    );
    CREATE TABLE mcp_tools (
      config_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      skip_confirm INTEGER NOT NULL DEFAULT 0,
      tool_meta TEXT,
      updated_at TEXT,
      PRIMARY KEY (config_id, tool_name)
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name_enc TEXT NOT NULL,
      model_enc TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

function seed(db: Database.Database, envByDevice: Record<string, Record<string, string> | null>): number {
  const r = db.prepare(
    "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('manual-cfg', 'stdio', 'node x.js')"
  ).run()
  const ins = db.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id, env_json_enc) VALUES (?, ?, ?, ?)')
  let i = 0
  for (const [deviceId, env] of Object.entries(envByDevice)) {
    db.prepare('INSERT INTO devices (id, name_enc) VALUES (?, ?)').run(deviceId, encField(`dev-${deviceId}`, TEST_MK))
    ins.run(`rel-${i++}`, Number(r.lastInsertRowid), deviceId, env ? encField(JSON.stringify(env), TEST_MK) : null)
  }
  return Number(r.lastInsertRowid)
}

function relEnv(db: Database.Database, deviceId: string): Record<string, string> | null {
  const row = db.prepare('SELECT env_json_enc FROM mcp_device_rel WHERE device_id = ?').get(deviceId) as { env_json_enc: string | null }
  if (!row?.env_json_enc) return null
  return JSON.parse(decField(row.env_json_enc, TEST_MK)!) as Record<string, string>
}

beforeEach(() => {
  h.db = makeDb()
  McpService._setDbGetter(() => h.db!)
  McpService.setMcpMasterKey(TEST_MK)
  h.registryMock.listActive.mockReset().mockReturnValue([])
  h.registryMock.killTree.mockReset().mockReturnValue(true)
  h.closeConfigConnections.mockReset().mockResolvedValue(undefined)
})

describe('29-06：saveConfig deviceEnvs（D-16 手工 stdio 编辑态）', () => {
  it('逐设备哨兵合并：UNCHANGED 沿用旧值 / 新明文覆盖 / 空串删除键', () => {
    const cfgId = seed(h.db!, { d1: { TOKEN: 'tok-secret-0001', PORT: '8000' }, d2: { TOKEN: 'tok-secret-0002' } })
    const res = McpService.saveConfig({
      id: cfgId,
      name: 'manual-cfg',
      type: 'stdio',
      commandOrUrl: 'node x.js',
      deviceIds: ['d1', 'd2'],
      deviceEnvs: [
        { deviceId: 'd1', env: { TOKEN: UNCHANGED_ENV_SENTINEL, PORT: '9000' } },
        { deviceId: 'd2', env: { TOKEN: '' } },
      ],
    })
    expect(res.ok).toBe(true)
    expect(relEnv(h.db!, 'd1')).toEqual({ TOKEN: 'tok-secret-0001', PORT: '9000' })
    expect(relEnv(h.db!, 'd2')).toEqual({}) // 全部键删除 → 空对象密文（CR-01：不再写 NULL）
    // CR-01：清空落 '{}' 密文（非 NULL）——NULL 单义=未回填，backfill 不再复活已删凭证
    const enc = (h.db!.prepare("SELECT env_json_enc FROM mcp_device_rel WHERE device_id = 'd2'").get() as { env_json_enc: string | null }).env_json_enc
    expect(enc).toBeTruthy()
    expect(enc!.startsWith('v2:')).toBe(true)
  })

  it('未绑定设备的 deviceEnv 条目忽略（防越行写，T-29-06-04）', () => {
    const cfgId = seed(h.db!, { d1: { TOKEN: 't1' } })
    h.db!.prepare('INSERT INTO devices (id, name_enc) VALUES (?, ?)').run('d9', encField('dev-d9', TEST_MK))
    const res = McpService.saveConfig({
      id: cfgId,
      name: 'manual-cfg',
      type: 'stdio',
      commandOrUrl: 'node x.js',
      deviceIds: ['d1'],
      deviceEnvs: [
        { deviceId: 'd1', env: { TOKEN: 't2' } },
        { deviceId: 'd9', env: { TOKEN: 'evil' } },
      ],
    })
    expect(res.ok).toBe(true)
    expect(relEnv(h.db!, 'd1')).toEqual({ TOKEN: 't2' })
    expect(h.db!.prepare("SELECT COUNT(*) AS c FROM mcp_device_rel WHERE device_id = 'd9'").get()).toEqual({ c: 0 })
  })

  it('listConfigs 出口 deviceEnvMasked 只含 ****尾4，永无明文（T-29-06-02）', () => {
    seed(h.db!, { d1: { TOKEN: 'tok-secret-0001' } })
    const list = McpService.listConfigs()
    expect(list).toHaveLength(1)
    expect(list[0].deviceEnvMasked['d1']).toEqual(['TOKEN=****0001'])
    expect(JSON.stringify(list)).not.toContain('tok-secret-0001')
  })

  // WR-05（Phase 29 code-review）：deviceIds 缺省（契约=不动绑定）时 deviceEnvs 不得静默丢弃——
  // 以 DB 现绑定设备集合为 boundSet 逐设备合并
  it('WR-05：只传 deviceEnvs 不传 deviceIds → 以 DB 现绑定设备为 boundSet 生效', () => {
    const cfgId = seed(h.db!, { d1: { TOKEN: 'old-1' }, d2: { TOKEN: 'old-2' } })
    const res = McpService.saveConfig({
      id: cfgId,
      name: 'manual-cfg',
      type: 'stdio',
      commandOrUrl: 'node x.js',
      deviceEnvs: [{ deviceId: 'd2', env: { TOKEN: 'new-2' } }],
    })
    expect(res.ok).toBe(true)
    expect(relEnv(h.db!, 'd1')).toEqual({ TOKEN: 'old-1' }) // 未提及设备原值不动
    expect(relEnv(h.db!, 'd2')).toEqual({ TOKEN: 'new-2' }) // 不再被静默丢弃
    // 绑定关系未被改动（缺省=不动绑定）
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel WHERE mcp_config_id = ?').get(cfgId)).toEqual({ c: 2 })
  })

  // WR-01（Phase 29 code-review）：只传 deviceIds 不传 deviceEnvs 时 DELETE+重建不得
  // 静默抹掉设备级 env——重建行带回原密文（纯搬密文列）
  it('WR-01：只传 deviceIds 不传 deviceEnvs → 既有设备级 env 密文原样保留', () => {
    const cfgId = seed(h.db!, { d1: { TOKEN: 'keep-1' }, d2: { TOKEN: 'keep-2' } })
    const res = McpService.saveConfig({
      id: cfgId,
      name: 'manual-cfg',
      type: 'stdio',
      commandOrUrl: 'node x.js',
      deviceIds: ['d1', 'd2'], // 只改绑定，不传 deviceEnvs
    })
    expect(res.ok).toBe(true)
    expect(relEnv(h.db!, 'd1')).toEqual({ TOKEN: 'keep-1' })
    expect(relEnv(h.db!, 'd2')).toEqual({ TOKEN: 'keep-2' })
    // 解绑再同保存重绑的设备（本次 save 前已不在绑定集）不凭空造 env
    const res2 = McpService.saveConfig({
      id: cfgId, name: 'manual-cfg', type: 'stdio', commandOrUrl: 'node x.js',
      deviceIds: ['d1'],
    })
    expect(res2.ok).toBe(true)
    expect(relEnv(h.db!, 'd1')).toEqual({ TOKEN: 'keep-1' })
    expect(h.db!.prepare("SELECT COUNT(*) AS c FROM mcp_device_rel WHERE mcp_config_id = ?").get(cfgId)).toEqual({ c: 1 })
  })
})

describe('Phase 29 code-review / 29-09 走查二：deleteConfig（WR-03 杀实例 / 策略迁移继承）', () => {
  function seedPackageConfigs(db: Database.Database, packageId: number, count: number): number[] {
    const ids: number[] = []
    for (let i = 0; i < count; i++) {
      const r = db.prepare(
        "INSERT INTO mcp_configs (name, type, command_or_url, package_id, source) VALUES (?, 'package', 'main.js', ?, 'package')"
      ).run(`pkg-cfg-${i}`, packageId)
      ids.push(Number(r.lastInsertRowid))
    }
    return ids
  }

  it('WR-03：删配置先杀该 configId 全部运行中 stdio 实例（含复合键，对齐 deletePackage）', () => {
    const ins = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES (?, 'stdio', 'node')"
    )
    const cfgA = Number(ins.run('cfg-a').lastInsertRowid)
    const cfgB = Number(ins.run('cfg-b').lastInsertRowid)
    h.registryMock.listActive.mockReturnValue([
      { pid: 501, configId: `${cfgA}:dev1`, startedAt: 0 },
      { pid: 502, configId: `${cfgA}:dev2`, startedAt: 0 },
      { pid: 503, configId: `${cfgB}:dev1`, startedAt: 0 },
      { pid: 504, configId: '999:dev1', startedAt: 0 },
    ])
    const res = McpService.deleteConfig(cfgA)
    expect(res.ok).toBe(true)
    // 只杀 cfgA 对应的 501/502，不误杀他配置（503/504）
    expect(h.registryMock.killTree).toHaveBeenCalledTimes(2)
    expect(h.registryMock.killTree).toHaveBeenCalledWith(501)
    expect(h.registryMock.killTree).toHaveBeenCalledWith(502)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 1 })
  })

  it('29-09 走查二：删包根配置 → mcp_tools 策略迁移继承到新根（MIN(id) 兄弟），不再拦截', () => {
    const ids = seedPackageConfigs(h.db!, 7, 2)
    const insTool = h.db!.prepare(
      'INSERT INTO mcp_tools (config_id, tool_name, enabled, skip_confirm) VALUES (?, ?, 0, 1)'
    )
    insTool.run(ids[0], 'get_status')
    insTool.run(ids[0], 'reboot')

    const res = McpService.deleteConfig(ids[0])
    expect(res.ok).toBe(true)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 1 })
    // 策略行迁移继承：enabled/skip_confirm 值原样保活，config_id 指向新根（兄弟 MIN(id)）
    const rows = h.db!.prepare('SELECT config_id, enabled, skip_confirm FROM mcp_tools ORDER BY tool_name').all() as any[]
    expect(rows).toEqual([
      { config_id: ids[1], enabled: 0, skip_confirm: 1 },
      { config_id: ids[1], enabled: 0, skip_confirm: 1 },
    ])
    // 删最后一条包配置：工具行一并清理（包保留）
    expect(McpService.deleteConfig(ids[1]).ok).toBe(true)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_tools').get()).toEqual({ c: 0 })
  })

  it('手工配置删除清理自身 mcp_tools 缓存行；行不存在幂等 ok', () => {
    const r = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, source) VALUES ('m', 'stdio', 'node', 'manual')"
    ).run()
    h.db!.prepare('INSERT INTO mcp_tools (config_id, tool_name) VALUES (?, ?)').run(r.lastInsertRowid, 't')
    expect(McpService.deleteConfig(Number(r.lastInsertRowid)).ok).toBe(true)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_tools').get()).toEqual({ c: 0 })
    expect(McpService.deleteConfig(99999)).toEqual({ ok: true })
  })
})

describe('29-09 走查二：saveConfig package 编辑（保留包字段原值）', () => {
  it('type=package 编辑：只更新 name/enabled/绑定/env；type/command_or_url/args/credential 原值保留', () => {
    const r = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, args_json, package_id, source) VALUES ('orig', 'package', 'main.js', '[]', 3, 'package')"
    ).run()
    h.db!.prepare("INSERT INTO devices (id, name_enc) VALUES ('e1', ?)").run(encField('E1', TEST_MK))
    h.db!.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id) VALUES (?, ?, ?)')
      .run('rel-e1', r.lastInsertRowid, 'e1')
    const res = McpService.saveConfig({
      id: Number(r.lastInsertRowid),
      name: 'renamed',
      type: 'package',
      commandOrUrl: '(package)',
      args: [],
      deviceIds: ['e1'],
      deviceEnvs: [{ deviceId: 'e1', env: { TOKEN: 'v1' } }],
      enabled: true,
    })
    expect(res.ok).toBe(true)
    const row = h.db!.prepare('SELECT * FROM mcp_configs WHERE id = ?').get(r.lastInsertRowid) as any
    expect(row.name).toBe('renamed')
    expect(row.type).toBe('package') // 不被占位串覆盖
    expect(row.command_or_url).toBe('main.js')
    expect(row.args_json).toBe('[]')
    expect(relEnvOf('e1')).toEqual({ TOKEN: 'v1' })
  })

  it('type=package 新建（无 id）拒绝；非包配置以 package 类型保存拒绝', () => {
    expect(McpService.saveConfig({ name: 'x', type: 'package', commandOrUrl: '(package)' }).ok).toBe(false)
    const r = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, source) VALUES ('m', 'stdio', 'node', 'manual')"
    ).run()
    expect(McpService.saveConfig({ id: Number(r.lastInsertRowid), name: 'm', type: 'package', commandOrUrl: '(package)' }).ok).toBe(false)
  })

  // 29-09 走查四（缺陷2）：env 语义变更（deviceEnvs/env 在场）→ 保存成功后关闭该配置
  // 全部设备级长连接（旧子进程 env 烧死，不杀则编辑对新调用不生效）；不涉 env 的保存不杀
  it('saveConfig 携带 deviceEnvs → 关闭该配置全部连接；无 env 字段保存不触发', async () => {
    const cfgId = seed(h.db!, { d1: { TOKEN: 'old' } })
    const r1 = McpService.saveConfig({
      id: cfgId, name: 'manual-cfg', type: 'stdio', commandOrUrl: 'node x.js',
      deviceIds: ['d1'],
      deviceEnvs: [{ deviceId: 'd1', env: { TOKEN: 'new' } }],
    })
    expect(r1.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 0)) // void 异步清理 flush
    expect(h.closeConfigConnections).toHaveBeenCalledWith(cfgId)

    h.closeConfigConnections.mockClear()
    const r2 = McpService.saveConfig({
      id: cfgId, name: 'renamed-only', type: 'stdio', commandOrUrl: 'node x.js',
    })
    expect(r2.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.closeConfigConnections).not.toHaveBeenCalled()
  })
})

function relEnvOf(deviceId: string): Record<string, string> | null {
  const row = h.db!.prepare('SELECT env_json_enc FROM mcp_device_rel WHERE device_id = ?').get(deviceId) as { env_json_enc: string | null }
  if (!row?.env_json_enc) return null
  return JSON.parse(decField(row.env_json_enc, TEST_MK)!) as Record<string, string>
}
