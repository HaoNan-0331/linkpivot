import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

/**
 * Phase 21 Plan 21-01 Task 2 —— v16 迁移（mcp_configs 一对多重建 D-03 + mcp_device_rel +
 * source D-06 + last_test_* D-09）真路径验证。
 *
 * 与 logEncMigration.real.test.ts 不同点：本组仅依赖 migrations.ts 的纯函数 v16
 * （签名 `(db) => void`，不调 getDatabase——实测验 import 链在 ELECTRON_RUN_AS_NODE 下可加载，
 * 故直接 import 生产 v16 真跑，优于照抄函数体的 17-03 先例）。
 *
 * 用例（plan 验收 a-d）：
 *   a) v15 形态库跑 v16 → sqlite_master 新 DDL 含 'source'，mcp_device_rel 存在
 *   b) v16 重复执行幂等（不 throw、表不重建——created_at 数据保活证明）
 *   c) init.ts 与 migrations.ts 的 mcp_configs / mcp_device_rel DDL 逐字一致（文件级抽取比对）
 *   d) mcp_device_rel 同 device_id 二次 INSERT 抛 UNIQUE 约束
 *
 * 安全域：内存库（`:memory:`）无落盘；只跑 v16 本体不碰 runMigrations/system log。
 */

import { v16, v17 } from '../../electron/database/migrations'

/** v15 占位形态基线：devices + prompt_overrides + 旧 mcp_configs（DDL 照抄 v15 迁移段） */
function createV15Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('stdio','http')),
      command_or_url TEXT NOT NULL,
      args_json TEXT,
      env_whitelist_json TEXT,
      credential_enc TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

function getTableSql(db: Database.Database, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined
  return row?.sql ?? ''
}

describe('v16 mcp_configs_v16_rebuild', () => {
  it('a) v15 形态库跑 v16 后重建为新形态（source 列 + mcp_device_rel 存在）', () => {
    const db = new Database(':memory:')
    createV15Schema(db)
    v16(db)

    const cfgSql = getTableSql(db, 'mcp_configs')
    expect(cfgSql).toContain('source TEXT NOT NULL DEFAULT')
    expect(cfgSql).toContain('env_json_enc')
    expect(cfgSql).toContain('last_test_tool_count')
    expect(cfgSql).not.toContain('device_id') // 一对一内嵌列已移除（D-03）

    const relSql = getTableSql(db, 'mcp_device_rel')
    expect(relSql).toContain('mcp_config_id')
    expect(relSql).toContain('device_id TEXT NOT NULL UNIQUE')

    expect(db.pragma('user_version', { simple: true })).toBe(16)
    db.close()
  })

  it('b) v16 重复执行幂等（不 throw、表不重建）', () => {
    const db = new Database(':memory:')
    createV15Schema(db)
    v16(db)

    // 写入一行数据，二次执行后必须保活（证明未 DROP 重建）
    db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('m1', 'stdio', 'node x.js')"
    ).run()
    const createdBefore = (
      db.prepare('SELECT created_at FROM mcp_configs WHERE id = 1').get() as { created_at: string }
    ).created_at

    expect(() => v16(db)).not.toThrow()

    const row = db.prepare('SELECT count(*) AS c FROM mcp_configs').get() as { c: number }
    expect(row.c).toBe(1)
    const createdAfter = (
      db.prepare('SELECT created_at FROM mcp_configs WHERE id = 1').get() as { created_at: string }
    ).created_at
    expect(createdAfter).toBe(createdBefore)
    db.close()
  })

  it('c) init.ts 与 migrations.ts 的 mcp_configs/mcp_device_rel DDL 逐字一致（文件级抽取比对）', () => {
    const root = path.resolve(__dirname, '../..')
    const migrationsSrc = fs.readFileSync(
      path.join(root, 'electron/database/migrations.ts'),
      'utf-8'
    )
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')

    // migrations.ts 内 v15 也有 mcp_configs DDL（旧形态）——先截取 v16 函数体再抽取，防误命中
    const v16Idx = migrationsSrc.indexOf('export const v16')
    expect(v16Idx).toBeGreaterThanOrEqual(0)
    const v16Src = migrationsSrc.slice(v16Idx, migrationsSrc.indexOf('const MIGRATIONS'))

    // 抽取 CREATE TABLE ... mcp_configs(...) / mcp_device_rel(...) 块（归一空白后比对）
    const extract = (src: string, table: string): string => {
      const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`)
      const m = src.match(re)
      expect(m, `${table} DDL 未在源文件命中`).toBeTruthy()
      return m![1].replace(/\s+/g, ' ').trim()
    }

    for (const table of ['mcp_configs', 'mcp_device_rel']) {
      expect(extract(v16Src, table)).toBe(extract(initSrc, table))
    }
  })

  it('d) mcp_device_rel 同 device_id 二次 INSERT 抛 UNIQUE 约束', () => {
    const db = new Database(':memory:')
    createV15Schema(db)
    v16(db)
    db.prepare(
      "INSERT INTO devices (id, name) VALUES ('dev-1', 'd1')"
    ).run()
    db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('m1', 'stdio', 'node x.js')"
    ).run()
    const insert = db.prepare(
      'INSERT INTO mcp_device_rel (id, mcp_config_id, device_id) VALUES (?, ?, ?)'
    )
    insert.run('rel-1', 1, 'dev-1')
    expect(() => insert.run('rel-2', 1, 'dev-1')).toThrow(/UNIQUE/i)
    // 不同配置绑定同一设备同样被拒（单列 UNIQUE 语义，非复合）
    db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('m2', 'http', 'http://x')"
    ).run()
    expect(() => insert.run('rel-3', 2, 'dev-1')).toThrow(/UNIQUE/i)
    db.close()
  })
})

/**
 * Phase 22 Plan 22-01 Task 1 —— v17 迁移（mcp_tools 工具策略表）真路径验证。
 *
 * 用例（plan 验收）：
 *   a) v16 形态库跑 v17 → mcp_tools 表存在且含全部列；user_version=17
 *   b) v17 重复执行幂等（不 throw、表不重建——既有行策略值保活证明）
 *   c) init.ts 与 migrations.ts 的 mcp_tools DDL 逐字一致（文件级抽取比对）
 *   d) UNIQUE(config_id, tool_name) 二次 INSERT 抛约束
 */
describe('v17 mcp_tools', () => {
  function createV17Base(db: Database.Database): void {
    // v16 形态基线：先跑 v15 占位 + v16（复用本文件既有 helper），mcp_tools 不存在
    createV15Schema(db)
    v16(db)
  }

  it('a) v16 形态库跑 v17 后 mcp_tools 表存在且含全部列，user_version=17', () => {
    const db = new Database(':memory:')
    createV17Base(db)
    expect(getTableSql(db, 'mcp_tools')).toBe('') // 前置：v17 前不存在

    v17(db)

    const sql = getTableSql(db, 'mcp_tools')
    expect(sql).toContain('config_id INTEGER NOT NULL')
    expect(sql).toContain('tool_name TEXT NOT NULL')
    expect(sql).toContain('enabled INTEGER NOT NULL DEFAULT 1')
    expect(sql).toContain('skip_confirm INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('tool_meta TEXT')
    expect(sql).toContain('UNIQUE(config_id, tool_name)')
    expect(db.pragma('user_version', { simple: true })).toBe(17)
    db.close()
  })

  it('b) v17 重复执行幂等（不 throw、表不重建——行保活证明）', () => {
    const db = new Database(':memory:')
    createV17Base(db)
    v17(db)
    db.prepare(
      "INSERT INTO mcp_tools (config_id, tool_name, enabled, skip_confirm, tool_meta) VALUES (1, 'get_status', 0, 1, '{}')"
    ).run()

    expect(() => v17(db)).not.toThrow()

    const row = db.prepare("SELECT enabled, skip_confirm FROM mcp_tools WHERE tool_name = 'get_status'").get() as any
    expect(row.enabled).toBe(0)
    expect(row.skip_confirm).toBe(1)
    db.close()
  })

  it('c) init.ts 与 migrations.ts 的 mcp_tools DDL 逐字一致（文件级抽取比对）', () => {
    const root = path.resolve(__dirname, '../..')
    const migrationsSrc = fs.readFileSync(
      path.join(root, 'electron/database/migrations.ts'),
      'utf-8'
    )
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')

    const v17Idx = migrationsSrc.indexOf('export const v17')
    expect(v17Idx).toBeGreaterThanOrEqual(0)
    const v17Src = migrationsSrc.slice(v17Idx, migrationsSrc.indexOf('const MIGRATIONS'))

    const extract = (src: string, table: string): string => {
      const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`)
      const m = src.match(re)
      expect(m, `${table} DDL 未在源文件命中`).toBeTruthy()
      return m![1].replace(/\s+/g, ' ').trim()
    }

    expect(extract(v17Src, 'mcp_tools')).toBe(extract(initSrc, 'mcp_tools'))
  })

  it('d) mcp_tools UNIQUE(config_id, tool_name) 二次 INSERT 抛约束', () => {
    const db = new Database(':memory:')
    createV17Base(db)
    v17(db)
    const insert = db.prepare('INSERT INTO mcp_tools (config_id, tool_name) VALUES (?, ?)')
    insert.run(1, 'get_status')
    expect(() => insert.run(1, 'get_status')).toThrow(/UNIQUE/i)
    insert.run(2, 'get_status') // 不同 config 同名工具合法
    db.close()
  })
})
