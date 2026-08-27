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

import { v16, v17, v19, v20, v21, v22, v23, v24, v26, v27, v28, MIGRATION_HEAD, MIGRATIONS } from '../../electron/database/migrations'
import { encField } from '../../electron/utils/crypto'
import {
  appendLogAiResponse,
  setAiExecLoggerMasterKey,
  _setAiExecLoggerDbGetter,
} from '../../electron/services/aiExecLogger'

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

    // 29-02 v27 后 init.ts 新增 package_id/env_json_enc 两列（迁移路径 ALTER 追加）、
    // 29-09 v28 后 init.ts CHECK 放开 'package'——剔除后再比对，v16 逐字一致语义保持
    for (const table of ['mcp_configs', 'mcp_device_rel']) {
      const extra = table === 'mcp_configs' ? 'package_id INTEGER REFERENCES mcp_packages(id)' : 'env_json_enc TEXT'
      const stripped = extract(initSrc, table)
        .replace(`, ${extra}`, '').replace(`${extra}, `, '').replace(extra, '')
        .replace("CHECK(type IN ('stdio','http','package'))", "CHECK(type IN ('stdio','http'))")
      expect(extract(v16Src, table)).toBe(stripped)
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

    // 29.1-01 v29 后 init.ts mcp_tools 为双列并存形态——剔除新增列/约束再比对，
    // v17 逐字一致语义保持（v16-c 剔除先例同款）
    const stripped = extract(initSrc, 'mcp_tools')
      .replace('config_id INTEGER,', 'config_id INTEGER NOT NULL,')
      .replace('package_id INTEGER,', '')
      .replace('UNIQUE(package_id, tool_name)', '')
      .replace(/\s+/g, ' ').trim().replace(/,\s*$/, '')
    expect(extract(v17Src, 'mcp_tools')).toBe(stripped)
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

/**
 * Phase 22 Plan 22-05 收尾 —— 22-03 v19 回归修复（ai_exec_logs 丢明文列）验证。
 *
 * 回归根因：v19 重建 ai_exec_logs 时 DDL 只含 prompt_text_enc/ai_response_enc，
 * 丢了明文列 prompt_text/ai_response——SEC-06 运行时代码（appendLogAiResponse /
 * backfillAiExecLogEnc / getLogs）在「明文列存在」假设下写 SQL，运行时报
 * no such column: prompt_text。
 *
 * 修复：v19 DDL 补回两明文列（对 fresh-v19 生效）+ v20 迁移给已跑丢列版 v19 的
 * 存量库补列（hasColumn 守卫幂等）+ init.ts fresh DDL 同步。
 *
 * 用例：
 *   a) pre-v19 形态库跑 v19 → 新表含两明文列 + _enc 列，明文数据搬迁保活
 *   b) 丢列版 v19 存量库跑 v20 → 两列补回，既有 _enc 密文保活，user_version=20
 *   c) v20 幂等重跑 no-op
 *   d) appendLogAiResponse 在 v20 库上正常执行（SELECT/UPDATE 不再 no such column）
 *   e) init.ts fresh ai_exec_logs DDL 含两明文列，与 v19 修正后 DDL 列集一致
 */
describe('v19 fix + v20 ai_exec_logs 补明文列', () => {
  const TEST_MK = 'v20-test-master-key'

  /** pre-v19 形态：v13 后 ai_exec_logs（含明文 + _enc 列，mode CHECK 两值） */
  function createPreV19Table(db: Database.Database): void {
    db.exec(`
      CREATE TABLE ai_exec_logs (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        device_name_enc TEXT,
        command TEXT NOT NULL,
        status TEXT CHECK(status IN ('approved','rejected','pending','executed','failed')),
        mode TEXT CHECK(mode IN ('confirm','auto')),
        ai_reason TEXT,
        prompt_text TEXT,
        ai_response TEXT,
        prompt_text_enc TEXT,
        ai_response_enc TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `)
  }

  /** 丢列版 v19 形态：无明文列（22-03 回归产物），user_version=19 */
  function createBuggyV19Table(db: Database.Database): void {
    db.exec(`
      CREATE TABLE ai_exec_logs (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        device_name_enc TEXT,
        command TEXT NOT NULL,
        status TEXT CHECK(status IN ('approved','rejected','pending','executed','failed')),
        mode TEXT CHECK(mode IN ('confirm','smart','auto')),
        ai_reason TEXT,
        prompt_text_enc TEXT,
        ai_response_enc TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `)
    db.pragma('user_version = 19')
  }

  function columnsOf(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  }

  it('a) pre-v19 库跑 v19 后新表含两明文列（DDL 修正）且明文数据搬迁保活', () => {
    const db = new Database(':memory:')
    createPreV19Table(db)
    db.prepare(
      "INSERT INTO ai_exec_logs (id, device_id, device_name_enc, command, status, mode, ai_reason, prompt_text, ai_response) VALUES ('r1', 'd1', NULL, 'show ver', 'executed', 'confirm', 'ok', '旧明文 prompt', '旧明文 response')"
    ).run()

    v19(db)

    const cols = columnsOf(db, 'ai_exec_logs')
    expect(cols).toContain('prompt_text')
    expect(cols).toContain('ai_response')
    expect(cols).toContain('prompt_text_enc')
    expect(cols).toContain('ai_response_enc')
    expect(getTableSql(db, 'ai_exec_logs')).toContain("'smart'")
    const row = db.prepare('SELECT prompt_text, ai_response FROM ai_exec_logs WHERE id = ?').get('r1') as any
    expect(row.prompt_text).toBe('旧明文 prompt')
    expect(row.ai_response).toBe('旧明文 response')
    db.close()
  })

  it('b) 丢列版 v19 存量库跑 v20 → 两列补回，_enc 密文保活，user_version=20', () => {
    const db = new Database(':memory:')
    createBuggyV19Table(db)
    const encP = encField('密文 prompt', TEST_MK)
    const encR = encField('密文 response', TEST_MK)
    db.prepare(
      "INSERT INTO ai_exec_logs (id, device_id, device_name_enc, command, status, mode, ai_reason, prompt_text_enc, ai_response_enc) VALUES ('r1', 'd1', NULL, 'display', 'executed', 'smart', 'why', ?, ?)"
    ).run(encP, encR)

    v20(db)

    const cols = columnsOf(db, 'ai_exec_logs')
    expect(cols).toContain('prompt_text')
    expect(cols).toContain('ai_response')
    const row = db.prepare('SELECT prompt_text, ai_response, prompt_text_enc, ai_response_enc FROM ai_exec_logs WHERE id = ?').get('r1') as any
    expect(row.prompt_text).toBeNull() // 补列为 NULL，不触碰既有密文
    expect(row.prompt_text_enc).toBe(encP)
    expect(row.ai_response_enc).toBe(encR)
    expect(db.pragma('user_version', { simple: true })).toBe(20)
    db.close()
  })

  it('c) v20 重复执行幂等（列已存在 no-op，不 throw）', () => {
    const db = new Database(':memory:')
    createBuggyV19Table(db)
    v20(db)
    expect(() => v20(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(20)
    db.close()
  })

  it('d) appendLogAiResponse 在 v20 库上正常执行（不再 no such column: prompt_text）', () => {
    const db = new Database(':memory:')
    createBuggyV19Table(db)
    v20(db)
    db.prepare(
      "INSERT INTO ai_exec_logs (id, device_id, device_name_enc, command, status, mode, ai_reason, prompt_text_enc, ai_response_enc) VALUES ('r1', 'd1', NULL, 'show cpu', 'executed', 'smart', 'ok', ?, ?)"
    ).run(encField('first prompt', TEST_MK), encField('first response', TEST_MK))

    setAiExecLoggerMasterKey(TEST_MK)
    _setAiExecLoggerDbGetter(() => db)
    try {
      expect(() => appendLogAiResponse('r1', 'second prompt', 'second response')).not.toThrow()
      const row = db.prepare('SELECT prompt_text, ai_response, prompt_text_enc, ai_response_enc FROM ai_exec_logs WHERE id = ?').get('r1') as any
      expect(row.prompt_text_enc).not.toBeNull()
      expect(row.prompt_text).toBeNull() // append 写全量 _enc 后明文列即刻清空
    } finally {
      _setAiExecLoggerDbGetter(() => { throw new Error('neutral') })
      setAiExecLoggerMasterKey('')
    }
    db.close()
  })

  it('e) init.ts fresh ai_exec_logs DDL 含两明文列（与 v20 后结构一致）', () => {
    const root = path.resolve(__dirname, '../..')
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    const m = initSrc.match(/CREATE TABLE IF NOT EXISTS ai_exec_logs \(([\s\S]*?)\);/)
    expect(m).toBeTruthy()
    const ddl = m![1]
    expect(ddl).toContain('prompt_text TEXT')
    expect(ddl).toContain('ai_response TEXT')
    expect(ddl).toContain('prompt_text_enc TEXT')
    expect(ddl).toContain('ai_response_enc TEXT')
  })
})

/**
 * Phase 22 Plan 22-05 checkpoint 追加 —— v21 迁移（ai_config.mcp_max_rounds 系统设置可调）。
 *
 * 用例：
 *   a) v20 形态库跑 v21 → mcp_max_rounds 列补上，默认 5，user_version=21
 *   b) v21 幂等重跑 no-op（hasColumn 守卫，既有值保活）
 *   c) init.ts fresh ai_config DDL 含 mcp_max_rounds 列
 */
describe('v21 ai_config.mcp_max_rounds', () => {
  function createV20Form(db: Database.Database): void {
    db.exec(`
      CREATE TABLE ai_config (
        id TEXT PRIMARY KEY,
        provider_enc TEXT,
        api_key_enc TEXT,
        base_url_enc TEXT,
        model_name_enc TEXT,
        vision_base_url_enc TEXT,
        vision_api_key_enc TEXT,
        vision_model_enc TEXT,
        exec_mode TEXT DEFAULT 'confirm' CHECK(exec_mode IN ('confirm','smart','auto')),
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `)
    db.pragma('user_version = 20')
  }

  function columnsOf(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  }

  it('a) v20 形态库跑 v21 → 补 mcp_max_rounds 列（存量行默认 5），user_version=21', () => {
    const db = new Database(':memory:')
    createV20Form(db)
    db.prepare("INSERT INTO ai_config (id) VALUES ('cfg1')").run()

    v21(db)

    expect(columnsOf(db, 'ai_config')).toContain('mcp_max_rounds')
    const row = db.prepare('SELECT mcp_max_rounds FROM ai_config WHERE id = ?').get('cfg1') as any
    expect(row.mcp_max_rounds).toBe(5)
    expect(db.pragma('user_version', { simple: true })).toBe(21)
    db.close()
  })

  it('b) v21 幂等重跑 no-op（列已存在不 throw，用户改过的值保活）', () => {
    const db = new Database(':memory:')
    createV20Form(db)
    db.prepare("INSERT INTO ai_config (id) VALUES ('cfg1')").run()
    v21(db)
    db.prepare('UPDATE ai_config SET mcp_max_rounds = 12').run()

    expect(() => v21(db)).not.toThrow()
    const row = db.prepare('SELECT mcp_max_rounds FROM ai_config WHERE id = ?').get('cfg1') as any
    expect(row.mcp_max_rounds).toBe(12)
    db.close()
  })

  it('c) init.ts fresh ai_config DDL 含 mcp_max_rounds 列', () => {
    const root = path.resolve(__dirname, '../..')
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    const m = initSrc.match(/CREATE TABLE IF NOT EXISTS ai_config \(([\s\S]*?)\);/)
    expect(m).toBeTruthy()
    expect(m![1]).toContain('mcp_max_rounds INTEGER NOT NULL DEFAULT 5')
  })
})

/**
 * Phase 25 Plan 25-01 Task 3 —— v22/v23/v24 name_hash 三段式迁移验证。
 *
 * 用例（plan 验收）：
 *   a) v22 幂等：已有 name_hash 列的库重跑不 throw 且 user_version 不回退
 *   b) v22 后 devices 有 name_hash 列且无 idx_devices_name_hash 索引（三段式第一段红线）
 *   c) v24 门控：两行相同 name_hash → 不 throw 不建索引；清零后复用 v24 → 建索引且 UNIQUE
 *   d) MIGRATION_HEAD=24 且注册表含 v22/v23/v24；init.ts fresh DDL 含 name_hash 列
 *   e) 全量迁移双跑幂等（user_version=0 内存库，v22-v24 连续执行两遍无异常）
 */
describe('v22/v23/v24 devices.name_hash 三段式', () => {
  /** v21 形态 devices 基线（无 name_hash 列） */
  function createV21Devices(db: Database.Database): void {
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        topology_id TEXT,
        name_enc TEXT NOT NULL,
        ip_enc TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `)
    db.pragma('user_version = 21')
  }

  function columnsOf(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  }

  function indexExists(db: Database.Database, name: string): boolean {
    const row = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name=?")
      .get(name) as { name: string; sql: string } | undefined
    return Boolean(row)
  }

  it('a) v22 幂等重跑：不 throw 且 user_version 不回退', () => {
    const db = new Database(':memory:')
    createV21Devices(db)
    v22(db)
    db.pragma('user_version = 99') // 模拟后续版本推进
    expect(() => v22(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(22) // 重跑把版本拉回 22 不越界（注册表按序执行语义）
    expect(columnsOf(db, 'devices')).toContain('name_hash')
    db.close()
  })

  it('b) v22 后有 name_hash 列且无 idx_devices_name_hash 索引', () => {
    const db = new Database(':memory:')
    createV21Devices(db)
    v22(db)
    v23(db)
    expect(columnsOf(db, 'devices')).toContain('name_hash')
    expect(indexExists(db, 'idx_devices_name_hash')).toBe(false)
    expect(db.pragma('user_version', { simple: true })).toBe(23)
    db.close()
  })

  it('c) v24 门控：有重名跳过不 throw；清零后建索引且 UNIQUE', () => {
    const db = new Database(':memory:')
    createV21Devices(db)
    v22(db)
    const insert = db.prepare('INSERT INTO devices (id, name_enc, name_hash) VALUES (?, ?, ?)')
    insert.run('d1', 'enc1', 'hash-same')
    insert.run('d2', 'enc2', 'hash-same') // 存量重名

    expect(v24(db)).toBe(false) // 门控：跳过建索引，不 throw
    expect(indexExists(db, 'idx_devices_name_hash')).toBe(false)

    db.prepare("UPDATE devices SET name_hash = 'hash-unique' WHERE id = 'd2'").run() // 清零
    expect(v24(db)).toBe(true)
    expect(indexExists(db, 'idx_devices_name_hash')).toBe(true)

    // UNIQUE 语义：同 name_hash 二次写入抛约束（NULL 不参与 UNIQUE）
    expect(() => insert.run('d3', 'enc3', 'hash-same')).toThrow(/UNIQUE/i)
    insert.run('d4', 'enc4', null)
    insert.run('d5', 'enc5', null) // 多行 NULL 合法
    expect(() => v24(db)).not.toThrow() // 二次调用幂等
    db.close()
  })

  it('d) MIGRATION_HEAD=24、注册表含 v22/v23/v24、init.ts fresh DDL 含 name_hash', () => {
    expect(MIGRATION_HEAD).toBe(30) // 30-02 v30（ai_config 升级压制两列）推进
    const versions = MIGRATIONS.map((m) => m.version)
    expect(versions).toContain(22)
    expect(versions).toContain(23)
    expect(versions).toContain(24)

    const root = path.resolve(__dirname, '../..')
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    const m = initSrc.match(/CREATE TABLE IF NOT EXISTS devices \(([\s\S]*?)\);/)
    expect(m).toBeTruthy()
    expect(m![1]).toContain('name_hash TEXT')
    // init.ts fresh-install 不预建 UNIQUE 索引（v24 统一负责）
    expect(initSrc).not.toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_name_hash')
  })

  it('e) 全量迁移双跑幂等（内存库 user_version=0 → v22-v24 连续两遍无异常）', () => {
    const db = new Database(':memory:')
    createV21Devices(db)
    db.pragma('user_version = 21')
    const runTail = () => { v22(db); v23(db); v24(db) }
    expect(() => runTail()).not.toThrow()
    expect(() => runTail()).not.toThrow() // 第二遍幂等
    expect(db.pragma('user_version', { simple: true })).toBe(23)
    expect(indexExists(db, 'idx_devices_name_hash')).toBe(true)
    db.close()
  })
})

/**
 * Phase 29 Plan 29-02 Task 1 —— v27 迁移（mcp_packages 新表 + mcp_configs.package_id +
 * mcp_device_rel.env_json_enc 设备级 env 列 D-15 存储形态）真路径验证。
 *
 * 用例（plan behavior）：
 *   a) v26 库跑 v27 → mcp_packages 表存在（含 last_test/fingerprint_json/disabled）、
 *      mcp_configs.package_id 列存在、mcp_device_rel.env_json_enc 列存在、user_version=27
 *   b) 已有 mcp_packages 的库重跑 v27 幂等 no-op（不 throw，既有行保活）
 *   c) init.ts fresh DDL 与迁移路径 PRAGMA table_info 逐列一致（双路径一致红线）
 *   d) MIGRATION_HEAD=27 且注册表含 v27；init.ts fresh DDL 含三处结构
 */
describe('v27 mcp_packages + 设备级 env 列', () => {
  /** v26 形态基线：mcp_configs（v16 形态）+ mcp_device_rel，无 mcp_packages / package_id / env_json_enc */
  function createV26McpSchema(db: Database.Database): void {
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
    db.pragma('user_version = 26')
  }

  function columnsOf(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  }

  it('a) v26 库跑 v27 → 三结构就位 + user_version=27 + runtime CHECK 约束', () => {
    const db = new Database(':memory:')
    createV26McpSchema(db)
    v27(db)

    const pkgSql = getTableSql(db, 'mcp_packages')
    expect(pkgSql).toContain("runtime TEXT NOT NULL CHECK(runtime IN ('node','python'))")
    expect(pkgSql).toContain('last_test TEXT')
    expect(pkgSql).toContain('fingerprint_json TEXT NOT NULL')
    expect(pkgSql).toContain('disabled INTEGER NOT NULL DEFAULT 0')
    expect(pkgSql).toContain('name TEXT NOT NULL UNIQUE')

    expect(columnsOf(db, 'mcp_configs')).toContain('package_id')
    expect(columnsOf(db, 'mcp_device_rel')).toContain('env_json_enc')
    expect(db.pragma('user_version', { simple: true })).toBe(27)
    db.close()
  })

  it('b) v27 重复执行幂等 no-op（不 throw，既有包行保活）', () => {
    const db = new Database(':memory:')
    createV26McpSchema(db)
    v27(db)
    db.prepare(`
      INSERT INTO mcp_packages (name, version, runtime, entry, manifest_json, fingerprint, fingerprint_json, dir_path, size_bytes)
      VALUES ('demo', '1.0.0', 'node', 'main.js', '{}', 'fp', '[]', 'C:/pkg', 123)
    `).run()
    expect(() => v27(db)).not.toThrow()
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get() as { c: number }
    expect(cnt.c).toBe(1)
    // runtime CHECK 拒绝非法值
    expect(() =>
      db.prepare(`
        INSERT INTO mcp_packages (name, runtime, entry, manifest_json, fingerprint, fingerprint_json, dir_path, size_bytes)
        VALUES ('bad', 'java', 'x.jar', '{}', 'fp', '[]', 'C:/x', 1)
      `).run()
    ).toThrow(/CHECK/i)
    db.close()
  })

  it('c) init.ts fresh mcp_* DDL 与迁移路径 PRAGMA table_info 逐列一致', () => {
    const root = path.resolve(__dirname, '../..')
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    expect(initSrc).toContain('CREATE TABLE IF NOT EXISTS mcp_packages')

    // 迁移路径：v26 基线跑 v27
    const mig = new Database(':memory:')
    createV26McpSchema(mig)
    v27(mig)
    // fresh 路径：从 init.ts 源码执行 mcp_* 三表 DDL（其它表与比对无关，不建）
    const fresh = new Database(':memory:')
    const tables = initSrc.match(/CREATE TABLE IF NOT EXISTS (mcp_packages|mcp_configs|mcp_device_rel) \(([\s\S]*?)\);/g)
    expect(tables).toBeTruthy()
    expect(tables!.length).toBe(3)
    for (const stmt of tables!) fresh.exec(stmt)
    for (const t of ['mcp_packages', 'mcp_configs', 'mcp_device_rel']) {
      // 29.1-01 v29 后 init.ts mcp_packages 多出 env_meta（迁移路径 v27 后由 v29 ALTER 追加）——
      // 剔除后再比对，v27 逐列一致语义保持
      const freshCols = columnsOf(fresh, t).filter((c) => c !== 'env_meta')
      expect(freshCols).toEqual(columnsOf(mig, t))
    }
    mig.close()
    fresh.close()
  })

  it('d) MIGRATION_HEAD=28、注册表含 v27、init.ts fresh DDL 含三处结构', () => {
    expect(MIGRATION_HEAD).toBe(30) // 30-02 v30 推进
    expect(MIGRATIONS.map((m) => m.version)).toContain(27)

    const root = path.resolve(__dirname, '../..')
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    const pkg = initSrc.match(/CREATE TABLE IF NOT EXISTS mcp_packages \(([\s\S]*?)\);/)
    expect(pkg).toBeTruthy()
    expect(pkg![1]).toContain('last_test TEXT')
    expect(pkg![1]).toContain('fingerprint_json TEXT NOT NULL')
    expect(initSrc.match(/CREATE TABLE IF NOT EXISTS mcp_configs \(([\s\S]*?)\);/)![1]).toContain('package_id')
    expect(initSrc.match(/CREATE TABLE IF NOT EXISTS mcp_device_rel \(([\s\S]*?)\);/)![1]).toContain('env_json_enc')
  })

  it('e) v26 老库链路（v26 后接 v27）双跑幂等', () => {
    const db = new Database(':memory:')
    createV26McpSchema(db)
    expect(() => { v26guard(db); v27(db) }).not.toThrow()
    expect(() => v27(db)).not.toThrow()
    db.close()
  })
})

/**
 * Phase 29.1 Plan 29.1-01 —— v29 迁移（mcp_packages.env_meta 明文 JSON 列 D-04 +
 * mcp_tools 归属从 config_id 借存迁 package_id D-05）真路径验证。
 *
 * 用例（plan behavior）：
 *   a) v28 库跑 v29 → mcp_packages.env_meta 列就位（默认 NULL）、借存行 package_id 回填
 *      且 config_id 置 NULL（双列并存）、手工轨不动、双 UNIQUE 索引、user_version=29
 *   b) 搬迁前后策略行计数一致（借存+手工分组，T-29.1-02）
 *   c) v29 幂等重跑 no-op（hasColumn + sqlite_master 特征串双守卫，数据不变）
 *   d) MIGRATION_HEAD=29 且注册表含 v29；init.ts fresh DDL 双列并存逐字一致
 *   e) 双 UNIQUE 语义：同 (package_id, tool_name) 二次 INSERT 抛约束、
 *      同 (config_id, tool_name) 二次 INSERT 抛约束、NULL 轨互不冲突
 */
describe('v29 mcp_packages.env_meta + mcp_tools.package_id 借存迁移', () => {
  /** v28 形态基线：v27 形态 + mcp_configs CHECK 已含 'package'（自建，不依赖 v28 describe 内部 helper） */
  function createV28Form(db: Database.Database): void {
    createV15Schema(db)
    v16(db)
    v17(db)
    db.exec(`
      CREATE TABLE mcp_packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        version TEXT,
        runtime TEXT NOT NULL CHECK(runtime IN ('node','python')),
        entry TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        fingerprint_json TEXT NOT NULL,
        dir_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_test TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    v27(db)
    v28(db)
    db.pragma('user_version = 28')
  }

  /** 三组夹具：同包 2 配置（策略行借存 MIN(id) 根配置）、手工配置策略行、无策略行的包 */
  function seedFixtures(db: Database.Database): void {
    const insPkg = db.prepare(`
      INSERT INTO mcp_packages (name, version, runtime, entry, manifest_json, fingerprint, fingerprint_json, dir_path, size_bytes)
      VALUES (?, '1.0.0', 'node', 'main.js', '{}', 'fp', '[]', 'C:/pkg', 1)
    `)
    insPkg.run('demo')   // id=1：有策略行
    insPkg.run('bare')   // id=2：无策略行
    const insCfg = db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, package_id, source) VALUES (?, 'package', ?, ?, ?)"
    )
    insCfg.run('pkg-root', 'demo', 1, 'package')      // id=1：根配置（MIN(id)，策略借存载体）
    insCfg.run('pkg-second', 'demo', 1, 'package')    // id=2：同包第二配置
    db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, package_id, source) VALUES ('manual-cfg', 'stdio', 'node x.js', NULL, 'manual')"
    ).run() // id=3：手工轨
    const insTool = db.prepare(
      'INSERT INTO mcp_tools (config_id, tool_name, enabled, skip_confirm, tool_meta) VALUES (?, ?, ?, ?, ?)'
    )
    insTool.run(1, 'get_status', 0, 1, '{}')  // 借存：挂在根配置
    insTool.run(1, 'run_scan', 1, 0, '{}')    // 借存：挂在根配置
    insTool.run(3, 'http_fetch', 1, 0, '{}')  // 手工轨
  }

  function runV29(db: Database.Database): void {
    const step = MIGRATIONS.find((m) => m.version === 29)
    expect(step, 'v29 迁移步骤尚未注册').toBeTruthy()
    step!.run(db)
  }

  function columnsOf(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  }

  it('a) v28 库跑 v29 → env_meta 列 + 借存行迁 package_id + 手工轨不动 + user_version=29', () => {
    const db = new Database(':memory:')
    createV28Form(db)
    seedFixtures(db)

    runV29(db)

    // D-04：env_meta 明文 JSON 列，默认 NULL
    expect(columnsOf(db, 'mcp_packages')).toContain('env_meta')
    const pkg = db.prepare('SELECT env_meta FROM mcp_packages WHERE id = 1').get() as any
    expect(pkg.env_meta).toBeNull()

    // D-05：借存行迁 package_id 且 config_id 置 NULL（双列并存）
    const borrowed = db.prepare("SELECT package_id, config_id, enabled, skip_confirm FROM mcp_tools WHERE tool_name IN ('get_status','run_scan') ORDER BY tool_name").all() as any[]
    expect(borrowed).toHaveLength(2)
    for (const row of borrowed) {
      expect(row.package_id).toBe(1)
      expect(row.config_id).toBeNull()
    }
    expect(borrowed[0].enabled).toBe(0)      // 策略值保活
    expect(borrowed[0].skip_confirm).toBe(1)

    // 手工轨不动
    const manual = db.prepare("SELECT package_id, config_id FROM mcp_tools WHERE tool_name = 'http_fetch'").get() as any
    expect(manual.config_id).toBe(3)
    expect(manual.package_id).toBeNull()

    // 双 UNIQUE 索引（表级约束形态）
    const sql = getTableSql(db, 'mcp_tools')
    expect(sql).toContain('UNIQUE(package_id, tool_name)')
    expect(sql).toContain('UNIQUE(config_id, tool_name)')
    expect(db.pragma('user_version', { simple: true })).toBe(29)
    db.close()
  })

  it('b) 搬迁前后策略行计数一致（T-29.1-02）', () => {
    const db = new Database(':memory:')
    createV28Form(db)
    seedFixtures(db)
    const before = db.prepare('SELECT COUNT(*) AS c FROM mcp_tools').get() as { c: number }
    expect(before.c).toBe(3)

    runV29(db)

    const after = db.prepare('SELECT COUNT(*) AS c FROM mcp_tools').get() as { c: number }
    expect(after.c).toBe(before.c)
    // 分组：包轨 2（demo）+ 手工轨 1
    const byTrack = db.prepare(
      'SELECT CASE WHEN package_id IS NOT NULL THEN (SELECT name FROM mcp_packages p WHERE p.id = package_id) ELSE \'manual\' END AS track, COUNT(*) AS c FROM mcp_tools GROUP BY track ORDER BY track'
    ).all() as Array<{ track: string; c: number }>
    expect(byTrack).toEqual([{ track: 'demo', c: 2 }, { track: 'manual', c: 1 }])
    db.close()
  })

  it('c) v29 幂等重跑 no-op（数据不变、不 throw）', () => {
    const db = new Database(':memory:')
    createV28Form(db)
    seedFixtures(db)
    runV29(db)
    db.prepare("UPDATE mcp_tools SET enabled = 0 WHERE tool_name = 'http_fetch'").run()

    expect(() => runV29(db)).not.toThrow()

    const rows = db.prepare('SELECT tool_name, package_id, config_id, enabled FROM mcp_tools ORDER BY tool_name').all() as any[]
    expect(rows).toEqual([
      { tool_name: 'get_status', package_id: 1, config_id: null, enabled: 0 },
      { tool_name: 'http_fetch', package_id: null, config_id: 3, enabled: 0 }, // 幂等重跑不回滚用户改动
      { tool_name: 'run_scan', package_id: 1, config_id: null, enabled: 1 },
    ])
    expect(db.pragma('user_version', { simple: true })).toBe(29)
    db.close()
  })

  it('d) MIGRATION_HEAD=29、注册表含 v29、init.ts fresh DDL 双列并存', () => {
    expect(MIGRATION_HEAD).toBe(30) // 30-02 v30 推进
    expect(MIGRATIONS.map((m) => m.version)).toContain(29)

    const root = path.resolve(__dirname, '../..')
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    const pkg = initSrc.match(/CREATE TABLE IF NOT EXISTS mcp_packages \(([\s\S]*?)\);/)!
    expect(pkg[1]).toContain('env_meta TEXT')
    const tools = initSrc.match(/CREATE TABLE IF NOT EXISTS mcp_tools \(([\s\S]*?)\);/)!
    expect(tools[1]).toContain('package_id')
    expect(tools[1]).toContain('config_id')
    expect(tools[1]).toContain('UNIQUE(package_id, tool_name)')
    expect(tools[1]).toContain('UNIQUE(config_id, tool_name)')

    // 双路径逐字一致：迁移路径 v28 库跑 v29 后的表结构 vs fresh 路径
    const mig = new Database(':memory:')
    createV28Form(mig)
    runV29(mig)
    const fresh = new Database(':memory:')
    for (const stmt of initSrc.match(/CREATE TABLE IF NOT EXISTS mcp_tools \([\s\S]*?\);/g)!) fresh.exec(stmt)
    expect(columnsOf(fresh, 'mcp_tools')).toEqual(columnsOf(mig, 'mcp_tools'))
    mig.close()
    fresh.close()
  })

  it('e) 双 UNIQUE 语义：各自轨道防重、NULL 轨互不冲突', () => {
    const db = new Database(':memory:')
    createV28Form(db)
    seedFixtures(db)
    runV29(db)

    // 包轨防重
    expect(() =>
      db.prepare("INSERT INTO mcp_tools (package_id, config_id, tool_name) VALUES (1, NULL, 'get_status')").run()
    ).toThrow(/UNIQUE/i)
    // 手工轨防重
    expect(() =>
      db.prepare("INSERT INTO mcp_tools (package_id, config_id, tool_name) VALUES (NULL, 3, 'http_fetch')").run()
    ).toThrow(/UNIQUE/i)
    // NULL 与具体值在 SQLite UNIQUE 中互不相等：同 tool_name 手工新配置合法
    db.prepare("INSERT INTO mcp_tools (package_id, config_id, tool_name) VALUES (NULL, 999, 'get_status')").run()
    db.close()
  })
})

/** v26 在 mcp 基线上的最小形态守卫（无 ai_config/chat_history 时跳过 v26 本体，仅锚定版本） */
function v26guard(db: Database.Database): void {
  db.pragma('user_version = 26')
}

/**
 * Phase 29 Plan 29-09 走查二 —— v28 迁移（mcp_configs.type CHECK widen 'package' +
 * 存量包配置 type 真实化）真路径验证。
 *
 * 用例：
 *   a) v27 形态库跑 v28 → CHECK 含 'package'、id/env 密文等全列数据保活、
 *      存量 source='package'+package_id 行 type 转换为 'package'，user_version=28
 *   b) v28 重复执行幂等（sqlite_master 特征串守卫，created_at 保活证明）
 *   c) 转换后 CHECK 拒绝非法 type；mcp_device_rel 子表行经 FK 重建不丢失
 *   d) init.ts fresh mcp_configs DDL CHECK 含 'package'（双路径一致红线）
 */
describe('v28 mcp_configs.type CHECK widen package', () => {
  /** v27 形态基线：v16 形态 mcp_configs + mcp_packages + package_id + rel env 列 */
  function createV27Form(db: Database.Database): void {
    createV15Schema(db)
    v16(db)
    v17(db)
    db.exec(`
      CREATE TABLE mcp_packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        version TEXT,
        runtime TEXT NOT NULL CHECK(runtime IN ('node','python')),
        entry TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        fingerprint_json TEXT NOT NULL,
        dir_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_test TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    v27(db)
    db.pragma('user_version = 27')
  }

  it('a) v27 库跑 v28 → CHECK 放开 + 存量包配置 type 转换 + 数据保活', () => {
    const db = new Database(':memory:')
    createV27Form(db)
    db.prepare(`
      INSERT INTO mcp_packages (name, version, runtime, entry, manifest_json, fingerprint, fingerprint_json, dir_path, size_bytes)
      VALUES ('demo', '1.0.0', 'node', 'main.js', '{}', 'fp', '[]', 'C:/pkg', 1)
    `).run()
    const ins = db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, env_json_enc, package_id, source) VALUES (?, ?, ?, ?, ?, ?)"
    )
    ins.run('pkg-cfg', 'stdio', 'demo', 'env-enc-1', 1, 'package') // 29-09 前暗号形态存量行
    ins.run('manual-cfg', 'stdio', 'node x.js', 'env-enc-2', null, 'manual')
    db.prepare("INSERT INTO devices (id, name) VALUES ('d1', 'dev-1')").run()
    db.prepare("INSERT INTO mcp_device_rel (id, mcp_config_id, device_id) VALUES ('r1', 1, 'd1')").run()

    v28(db)

    expect(getTableSql(db, 'mcp_configs')).toContain("'package'")
    const pkg = db.prepare('SELECT id, type, command_or_url, env_json_enc FROM mcp_configs WHERE id = 1').get() as any
    expect(pkg.type).toBe('package') // 暗号行转换
    expect(pkg.id).toBe(1) // id 值保留
    expect(pkg.command_or_url).toBe('demo') // 原值不动（读取处不再依赖）
    expect(pkg.env_json_enc).toBe('env-enc-1') // 密文列保活
    const manual = db.prepare('SELECT type FROM mcp_configs WHERE id = 2').get() as any
    expect(manual.type).toBe('stdio') // 手工行不动
    expect(db.pragma('user_version', { simple: true })).toBe(28)
    // FK 重建不丢子表行
    expect(db.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get()).toEqual({ c: 1 })
    db.close()
  })

  it('b) v28 重复执行幂等（特征串守卫，不 throw、created_at 保活）', () => {
    const db = new Database(':memory:')
    createV27Form(db)
    v28(db)
    db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('m1', 'stdio', 'node x.js')"
    ).run()
    const before = (db.prepare('SELECT created_at FROM mcp_configs WHERE id = 1').get() as any).created_at
    expect(() => v28(db)).not.toThrow()
    expect((db.prepare('SELECT created_at FROM mcp_configs WHERE id = 1').get() as any).created_at).toBe(before)
    db.close()
  })

  it('c) 转换后 type=package 可写入、非法 type 仍被 CHECK 拒绝', () => {
    const db = new Database(':memory:')
    createV27Form(db)
    v28(db)
    db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, package_id, source) VALUES ('p', 'package', 'main.js', NULL, 'package')"
    ).run()
    expect(() =>
      db.prepare("INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('bad', 'ftp', 'x')").run()
    ).toThrow(/CHECK/i)
    db.close()
  })

  it('d) init.ts fresh mcp_configs DDL CHECK 含 package（双路径一致）', () => {
    const root = path.resolve(__dirname, '../..')
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    const ddl = initSrc.match(/CREATE TABLE IF NOT EXISTS mcp_configs \(([\s\S]*?)\);/)!
    expect(ddl[1]).toContain("CHECK(type IN ('stdio','http','package'))")
    expect(MIGRATION_HEAD).toBe(30) // 30-02 v30 推进
    expect(MIGRATIONS.map((m) => m.version)).toContain(28)
  })
})
