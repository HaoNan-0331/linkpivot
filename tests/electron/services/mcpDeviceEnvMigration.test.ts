import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 29 Plan 29-02 Task 2 —— post-MK 存量 env 回填 backfillDeviceEnv（D-17）真路径测试。
 *
 * Mock 策略（mcpService.real.test.ts 惯例）：
 *   - getDatabase → vi.hoisted 内存库（service 本体真跑，含 encField/decField 真加密）
 *
 * 断言面：
 *   - 配置共享 env 复制到每台绑定设备 rel.env_json_enc（可解密副本，D-17）
 *   - 幂等：非空行不重写（二次调用零写入、密文稳定）
 *   - 配置 env 空/坏密文 → rel 保持 NULL 不 throw（读路径永不炸，T-29-02-02）
 *   - 全新库 no-op；MK 未注入（空串）no-op（T-29-02-04）
 */

const h = vi.hoisted(() => ({
  db: null as Database.Database | null
}))

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => h.db
}))

import { v27 } from '../../../electron/database/migrations'
import { McpDeviceEnvMigration } from '../../../electron/services/mcpDeviceEnvMigration'
import { encField, decField } from '../../../electron/utils/crypto'

const TEST_MK = 'test-mk-29-02'

/** v26 形态基线 + v27 跑完的 mcp_* 三表（本测试只关心 mcp_configs / mcp_device_rel） */
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE mcp_device_rel (
      id TEXT PRIMARY KEY,
      mcp_config_id INTEGER NOT NULL,
      device_id TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (mcp_config_id) REFERENCES mcp_configs(id) ON DELETE CASCADE
    );
  `)
  v27(db)
  return db
}

function insertConfig(db: Database.Database, name: string, envJsonEnc: string | null): number {
  const r = db.prepare(
    'INSERT INTO mcp_configs (name, type, command_or_url, env_json_enc) VALUES (?, ?, ?, ?)'
  ).run(name, 'stdio', 'node x.js', envJsonEnc)
  return Number(r.lastInsertRowid)
}

function bind(db: Database.Database, configId: number, relId: string): void {
  db.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id) VALUES (?, ?, ?)').run(relId, configId, relId)
}

beforeEach(() => {
  h.db = makeDb()
  McpDeviceEnvMigration._setDbGetter(() => h.db!)
  McpDeviceEnvMigration.setMcpDeviceEnvMasterKey(TEST_MK)
})

afterEach(() => {
  h.db?.close()
  h.db = null
})

describe('backfillDeviceEnv（D-17 存量共享 env 复制）', () => {
  it('a) 配置 env 绑 3 台设备 → 3 行 rel.env_json_enc 均为可解密副本', () => {
    const envJson = JSON.stringify({ TOKEN: 'x' })
    const cfgId = insertConfig(h.db!, 'm1', encField(envJson, TEST_MK))
    for (const rel of ['rel-1', 'rel-2', 'rel-3']) bind(h.db!, cfgId, rel)

    const r = McpDeviceEnvMigration.backfillDeviceEnv()
    expect(r.backfilled).toBe(3)

    const rows = h.db!.prepare('SELECT id, env_json_enc FROM mcp_device_rel ORDER BY id').all() as Array<{ id: string, env_json_enc: string }>
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.env_json_enc).toBeTruthy()
      expect(decField(row.env_json_enc, TEST_MK)).toBe(envJson) // 可解密副本（D-17）
      expect(row.env_json_enc!.startsWith('v2:')).toBe(true) // 密文形态
    }
  })

  it('b) 幂等：二次调用零写入（密文稳定不重写）', () => {
    const envJson = JSON.stringify({ TOKEN: 'x' })
    const cfgId = insertConfig(h.db!, 'm1', encField(envJson, TEST_MK))
    bind(h.db!, cfgId, 'rel-1')

    const r1 = McpDeviceEnvMigration.backfillDeviceEnv()
    expect(r1.backfilled).toBe(1)
    const cipherBefore = (h.db!.prepare('SELECT env_json_enc FROM mcp_device_rel').get() as { env_json_enc: string }).env_json_enc

    const r2 = McpDeviceEnvMigration.backfillDeviceEnv()
    expect(r2.backfilled).toBe(0)
    const cipherAfter = (h.db!.prepare('SELECT env_json_enc FROM mcp_device_rel').get() as { env_json_enc: string }).env_json_enc
    expect(cipherAfter).toBe(cipherBefore) // 未重写
  })

  it('c) 配置 env 空 / 坏密文 → 对应 rel 行保持 NULL 不 throw', () => {
    const cfgEmpty = insertConfig(h.db!, 'empty-env', null)
    const cfgBad = insertConfig(h.db!, 'bad-cipher', 'v2:!!not-a-valid-cipher!!')
    bind(h.db!, cfgEmpty, 'rel-empty')
    bind(h.db!, cfgBad, 'rel-bad')

    expect(() => McpDeviceEnvMigration.backfillDeviceEnv()).not.toThrow()
    const rows = h.db!.prepare('SELECT id, env_json_enc FROM mcp_device_rel').all() as Array<{ id: string, env_json_enc: string | null }>
    for (const row of rows) expect(row.env_json_enc).toBeNull() // 不造假数据
  })

  it('d) 全新库（无 mcp 配置）→ no-op', () => {
    const r = McpDeviceEnvMigration.backfillDeviceEnv()
    expect(r.backfilled).toBe(0)
  })

  it('e) MK 未注入（空串）→ no-op 不 throw（T-29-02-04）', () => {
    McpDeviceEnvMigration.setMcpDeviceEnvMasterKey('')
    const envJson = JSON.stringify({ TOKEN: 'x' })
    const cfgId = insertConfig(h.db!, 'm1', encField(envJson, TEST_MK))
    bind(h.db!, cfgId, 'rel-1')

    const r = McpDeviceEnvMigration.backfillDeviceEnv()
    expect(r.backfilled).toBe(0)
    const row = h.db!.prepare('SELECT env_json_enc FROM mcp_device_rel').get() as { env_json_enc: string | null }
    expect(row.env_json_enc).toBeNull()
  })

  it('f) 混合场景：好配置回填、坏配置跳过同批完成', () => {
    const envJson = JSON.stringify({ TOKEN: 'x' })
    const goodId = insertConfig(h.db!, 'good', encField(envJson, TEST_MK))
    const badId = insertConfig(h.db!, 'bad', 'v2:!!garbage!!')
    bind(h.db!, goodId, 'rel-good')
    bind(h.db!, badId, 'rel-bad')

    const r = McpDeviceEnvMigration.backfillDeviceEnv()
    expect(r.backfilled).toBe(1)
    expect(r.skipped).toBe(1)
    const bad = h.db!.prepare("SELECT env_json_enc FROM mcp_device_rel WHERE id = 'rel-bad'").get() as { env_json_enc: string | null }
    expect(bad.env_json_enc).toBeNull()
  })

  // CR-01（Phase 29 code-review）：用户清空设备 env 后 saveConfig 写 '{}' 密文（非 NULL）——
  // 重启 backfill 不得把配置级共享 env 复制回来复活已删除凭证
  it('g) 清空语义（{} 密文）重启不被回填复活（CR-01 回归）', () => {
    const envJson = JSON.stringify({ TOKEN: 'x' })
    const cfgId = insertConfig(h.db!, 'm1', encField(envJson, TEST_MK))
    bind(h.db!, cfgId, 'rel-cleared')
    // 用户清空后的落库形态（mcpService CR-01 修复后写 encField('{}')）
    h.db!.prepare('UPDATE mcp_device_rel SET env_json_enc = ? WHERE id = ?')
      .run(encField('{}', TEST_MK), 'rel-cleared')

    const cipherBefore = (h.db!.prepare("SELECT env_json_enc FROM mcp_device_rel WHERE id = 'rel-cleared'").get() as { env_json_enc: string }).env_json_enc
    const r = McpDeviceEnvMigration.backfillDeviceEnv()
    expect(r.backfilled).toBe(0) // '{}' 密文非 NULL → 不在回填目标集
    const cipherAfter = (h.db!.prepare("SELECT env_json_enc FROM mcp_device_rel WHERE id = 'rel-cleared'").get() as { env_json_enc: string }).env_json_enc
    expect(cipherAfter).toBe(cipherBefore) // 已删除凭证未复活
    expect(decField(cipherAfter, TEST_MK)).toBe('{}') // 清空语义持久
  })
})
