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
  db: null as Database.Database | null
}))

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => h.db
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
      type TEXT NOT NULL CHECK(type IN ('stdio','http')),
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
    expect(relEnv(h.db!, 'd2')).toBeNull() // 全部键删除 → env 清空
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
})
