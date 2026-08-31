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

import { v11, v15, v16, v17, v19, v20, v21, v22, v23, v24, v26, v27, v28, v31, v32, MIGRATION_HEAD, MIGRATIONS } from '../../electron/database/migrations'
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
    expect(MIGRATION_HEAD).toBe(32) // 36-01 v32（device_credentials 凭证子表）推进
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
    expect(MIGRATION_HEAD).toBe(32) // 36-01 v32 推进
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
    expect(MIGRATION_HEAD).toBe(32) // 36-01 v32 推进
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
    expect(MIGRATION_HEAD).toBe(32) // 36-01 v32 推进
    expect(MIGRATIONS.map((m) => m.version)).toContain(28)
  })
})

describe('v31 ai_system_logs CHECK widen update（30-05 真机审计链路修复）', () => {
  /**
   * security-era 基线 = 用户真库形态（30-SPIKE-RECORD §5.8）：CHECK 白名单无 'update'，
   * 列序模拟真实迁移路径（v13 ALTER 追加 _enc 两列在 created_at 之后——证明 v31 按列名寻址序无关）。
   */
  function createSecurityEraLogTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE ai_system_logs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup','security')),
        status TEXT NOT NULL CHECK(status IN ('success','failed','warning')),
        device_ids TEXT,
        device_names TEXT,
        prompt_text TEXT,
        ai_response TEXT,
        parsed_result TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        prompt_text_enc TEXT,
        ai_response_enc TEXT
      );
    `)
    db.pragma('user_version = 30')
  }

  it('a) 基线 INSERT type=update 抛 CHECK（复现根因）→ v31 放开 + 数据保活 + user_version=31', () => {
    const db = new Database(':memory:')
    createSecurityEraLogTable(db)
    db.prepare(
      "INSERT INTO ai_system_logs (id, type, status, error_message, prompt_text_enc) VALUES ('old-1', 'migration', 'success', '[startup] 老行', 'enc-甲')"
    ).run()
    // 根因复现：v31 前真库上 update 域审计必炸（生产 handler try/catch 静默吞掉的正是这个 throw）
    expect(() =>
      db.prepare("INSERT INTO ai_system_logs (id, type, status) VALUES ('x', 'update', 'failed')").run()
    ).toThrow(/CHECK/i)

    v31(db)

    expect(getTableSql(db, 'ai_system_logs')).toContain("'update'")
    expect(() =>
      db.prepare("INSERT INTO ai_system_logs (id, type, status, error_message) VALUES ('u-1', 'update', 'failed', '更新失败（proxy）: 测试')").run()
    ).not.toThrow()
    const old = db.prepare('SELECT error_message, prompt_text_enc FROM ai_system_logs WHERE id = ?').get('old-1') as any
    expect(old.error_message).toBe('[startup] 老行')
    expect(old.prompt_text_enc).toBe('enc-甲') // _enc 密文列保活（v6 时代没有的列，SELECT 显式携带）
    expect(db.pragma('user_version', { simple: true })).toBe(31)
    db.close()
  })

  it('b) v31 重复执行幂等（特征串守卫不重建，数据保活）；fresh 形态（已含 update）只推 user_version', () => {
    const db = new Database(':memory:')
    createSecurityEraLogTable(db)
    v31(db)
    db.prepare("INSERT INTO ai_system_logs (id, type, status) VALUES ('u-2', 'update', 'success')").run()
    expect(() => v31(db)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS c FROM ai_system_logs').get()).toEqual({ c: 1 })
    expect(db.pragma('user_version', { simple: true })).toBe(31)

    // fresh install 形态：init.ts 新 DDL（已含 'update'）→ guard 命中跳过重建，仅推进版本
    const fresh = new Database(':memory:')
    fresh.exec(`
      CREATE TABLE ai_system_logs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup','security','update')),
        status TEXT NOT NULL CHECK(status IN ('success','failed','warning')),
        device_ids TEXT, device_names TEXT, prompt_text TEXT, ai_response TEXT,
        parsed_result TEXT, error_message TEXT, prompt_text_enc TEXT, ai_response_enc TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `)
    fresh.pragma('user_version = 30')
    fresh.prepare("INSERT INTO ai_system_logs (id, type, status) VALUES ('f-1', 'update', 'success')").run()
    expect(() => v31(fresh)).not.toThrow()
    expect(fresh.prepare('SELECT COUNT(*) AS c FROM ai_system_logs').get()).toEqual({ c: 1 }) // 不重建不丢行
    expect(fresh.pragma('user_version', { simple: true })).toBe(31)
    db.close()
    fresh.close()
  })

  it('c) init.ts 与 migrations.ts 的 ai_system_logs CHECK 白名单特征串逐字一致（静态守卫，Phase 17 Test 5 模式）', () => {
    const root = path.resolve(__dirname, '../..')
    const expected = "CHECK(type IN ('discovery','acl','migration','backup','security','update'))"
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    const migrationsSrc = fs.readFileSync(path.join(root, 'electron/database/migrations.ts'), 'utf-8')
    expect(initSrc).toContain(expected)
    expect(migrationsSrc).toContain(expected)
  })

  it('d) MIGRATION_HEAD=31 且注册表含 v31', () => {
    expect(MIGRATION_HEAD).toBe(32) // 36-01 v32（device_credentials 凭证子表）推进
    expect(MIGRATIONS.map((m) => m.version)).toContain(31)
  })
})

/**
 * Phase 36 Plan 36-01 Task 1 —— v32 迁移（device_credentials 凭证子表建表）真路径验证。
 *
 * 用例（plan 验收 a-c）：
 *   a) 空库跑 v32 → sqlite_master 存在 device_credentials 且含 UNIQUE(device_id, channel) /
 *      CHECK(channel IN (...)) / resolution TEXT 明文列，user_version=32
 *   b) 幂等：重复跑 v32 第二次 no-op（不 throw），既有行保活，user_version 仍达 32
 *   c) DDL 逐字比对：init.ts 与 migrations.ts v32 的 CREATE TABLE device_credentials
 *      归一化（\s+→单空格）后相等（双路径一致红线，Pitfall 6）
 */
describe('v32 device_credentials 凭证子表（LOGIN-01/03）', () => {
  function columnsOf(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  }

  it('a) 空库跑 v32 → 建表含 UNIQUE/CHECK/resolution 明文列 + 索引，user_version=32', () => {
    const db = new Database(':memory:')
    v32(db)

    const sql = getTableSql(db, 'device_credentials')
    expect(sql).toContain('UNIQUE(device_id, channel)')
    expect(sql).toContain("CHECK(channel IN ('ssh','telnet','web','rdp'))")
    // D-04 裁决补记：resolution 为明文列（无 _enc 后缀），置于 web_url_enc 之后
    expect(sql).toContain('resolution TEXT')
    expect(sql).not.toContain('resolution_enc')
    expect(sql).toContain('FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE')

    const cols = columnsOf(db, 'device_credentials')
    expect(cols).toContain('port_enc')
    expect(cols).toContain('username_enc')
    expect(cols).toContain('password_enc')
    expect(cols).toContain('ssh_key_path_enc')
    expect(cols).toContain('ssh_key_content_enc')
    expect(cols).toContain('web_url_enc')
    expect(cols).toContain('resolution')

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_device_credentials_device'")
      .get() as { name: string } | undefined
    expect(idx?.name).toBe('idx_device_credentials_device')

    expect(db.pragma('user_version', { simple: true })).toBe(32)
    db.close()
  })

  it('b) 幂等：guard 命中第二次跑 v32 no-op（不 throw、行保活），user_version 仍达 32', () => {
    const db = new Database(':memory:')
    v32(db)
    // 建最小 devices 表 + 父行满足 FK 目标（better-sqlite3 默认 foreign_keys=ON，DML 即校验）
    db.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT);
    `)
    db.prepare("INSERT INTO devices (id, name) VALUES ('d1', 'dev-1')").run()
    db.prepare(
      "INSERT INTO device_credentials (id, device_id, channel, username_enc) VALUES ('c1', 'd1', 'ssh', 'enc-甲')"
    ).run()

    expect(() => v32(db)).not.toThrow() // guard 命中（表已存在）→ 建表段跳过

    const row = db.prepare("SELECT username_enc FROM device_credentials WHERE id = 'c1'").get() as any
    expect(row.username_enc).toBe('enc-甲') // 行保活（未重建表）
    expect(db.prepare('SELECT COUNT(*) AS c FROM device_credentials').get()).toEqual({ c: 1 })
    expect(db.pragma('user_version', { simple: true })).toBe(32) // Pitfall 7：guard 命中也推进
    db.close()
  })

  it('c) DDL 逐字比对：init.ts 与 migrations.ts 的 device_credentials DDL 归一化后相等', () => {
    const root = path.resolve(__dirname, '../..')
    const migrationsSrc = fs.readFileSync(
      path.join(root, 'electron/database/migrations.ts'),
      'utf-8'
    )
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')

    // 截取 v32 函数体再抽取，防误命中文件内其它 DDL
    const v32Idx = migrationsSrc.indexOf('export const v32')
    expect(v32Idx).toBeGreaterThanOrEqual(0)
    const v32Src = migrationsSrc.slice(v32Idx, migrationsSrc.indexOf('export const MIGRATIONS'))

    const extract = (src: string, table: string): string => {
      const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`)
      const m = src.match(re)
      expect(m, `${table} DDL 未在源文件命中`).toBeTruthy()
      return m![1].replace(/\s+/g, ' ').trim()
    }

    expect(extract(v32Src, 'device_credentials')).toBe(extract(initSrc, 'device_credentials'))
  })

  it('d) MIGRATION_HEAD=32 且注册表含 v32', () => {
    expect(MIGRATION_HEAD).toBe(32)
    expect(MIGRATIONS.map((m) => m.version)).toContain(32)
  })
})

/**
 * v11 / v13~v15 早期迁移 mock-DB 套件（F-01 归位合并，原 electron/database/migrations.test.ts）。
 *
 * 归位背景：原文件居 electron/database/ 时被 mock 轨（vitest.config.ts include electron/**）采集，
 * migrations.ts import 链牵 better-sqlite3（node ABI 加载失败）+ 部分断言停更 → plain npm test 3 failed。
 * 现并入 tests/electron/migrations.test.ts 由 electron 轨唯一采集（与上方 v16+ 真路径套件同文件互补：
 * 早期版本用 mock-DB 桩做调用序列/幂等守卫细粒度断言，后期版本用 :memory: 真库跑行为）。
 *
 * mock-DB 桩保留原因（electron ABI 下仍用 mock 而非真库）：v11/v15 用例断言的是
 * 「幂等守卫早返 → exec/pragma 零调用」这类调用序语义，mock 桩可精确计数；真库无法观测调用序。
 *
 * v11 迁移函数实际调用形态：
 *   db.prepare(sql).get()            → 查 sqlite_master（幂等守卫）
 *   db.exec(sql)                     → DDL 执行（DROP/CREATE/INSERT/DROP/RENAME）
 *   db.pragma(cmd)                   → user_version 设定
 *   db.transaction(fn)()             → 包裹 DDL（throw ROLLBACK 语义由真实 better-sqlite3 提供，mock 直跑 fn）
 */
interface MockDbOptions {
  /** sqlite_master 查 ai_system_logs 返的 sql 字段内容（幂等守卫判定依据） */
  logSchemaSql: string
}

function makeMockDb(opts: MockDbOptions) {
  const execCalls: string[] = []
  const pragmaCalls: string[] = []

  const db: any = {
    prepare(sql: string) {
      // 幂等守卫查询：返 sql 字段（含/不含 'security' 决定 no-op）
      if (sql.includes('sqlite_master') && sql.includes('ai_system_logs')) {
        return {
          get: () => ({ sql: opts.logSchemaSql }),
          all: () => [{ sql: opts.logSchemaSql }],
        }
      }
      // v11 内未走其他 prepare 路径（hasColumn 在 v11 未用）；返通用桩防意外
      return { get: () => undefined, all: () => [] }
    },
    exec(sql: string) {
      execCalls.push(sql)
    },
    pragma(cmd: string | string[]) {
      const c = Array.isArray(cmd) ? cmd.join(';') : cmd
      pragmaCalls.push(c)
    },
    transaction(fn: () => void) {
      return () => fn() // 直跑，无 ROLLBACK 语义（本测只验幂等 + DDL 序，不验回滚）
    },
  }

  return { db, execCalls, pragmaCalls }
}

// ---------- 双路径 DDL 字符串提取（静态守卫） ----------
// v11 重建表 CREATE _new DDL 与 init.ts fresh-install ai_system_logs DDL 关键特征一致
// （CONVENTIONS 双路径一致红线）。直接读 migrations.ts 源码字符串抽出 v11 的 CREATE _new 块，
// init.ts 直接全文抽取，做关键特征 includes 双断言。

function extractV11CreateNewDdl(): string {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../electron/database/migrations.ts'),
    'utf-8'
  )
  // 定位 v11 函数定义（migrations.ts 内有 v6/v11 两个 ai_system_logs_new CREATE 块，
  // 必须从 v11 函数体起搜，避免误抽 v6 块）
  const v11FnIdx = src.indexOf('export const v11')
  expect(v11FnIdx).toBeGreaterThan(-1)
  const srcAfterV11 = src.slice(v11FnIdx)
  // 抽 v11 函数体内 CREATE TABLE ai_system_logs_new ( ... ); 块
  const startMarker = 'CREATE TABLE ai_system_logs_new ('
  const startIdx = srcAfterV11.indexOf(startMarker)
  expect(startIdx).toBeGreaterThan(-1)
  // 取到该 CREATE 块结束的 ');' （INSERT INTO 之前）
  const insertMarker = 'INSERT INTO ai_system_logs_new'
  const insertIdx = srcAfterV11.indexOf(insertMarker, startIdx)
  expect(insertIdx).toBeGreaterThan(startIdx)
  return srcAfterV11.slice(startIdx, insertIdx)
}

function extractInitFreshInstallDdl(): string {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../electron/database/init.ts'),
    'utf-8'
  )
  // 抽 init.ts createTables() 内 CREATE TABLE IF NOT EXISTS ai_system_logs ( ... ); 块
  const startMarker = 'CREATE TABLE IF NOT EXISTS ai_system_logs ('
  const startIdx = src.indexOf(startMarker)
  expect(startIdx).toBeGreaterThan(-1)
  // 取到该 CREATE 块结束（下一个 ');'）
  const endIdx = src.indexOf(');', startIdx)
  expect(endIdx).toBeGreaterThan(startIdx)
  return src.slice(startIdx, endIdx)
}

describe('v11 ai_system_logs CHECK widen security 迁移', () => {
  it('1. 幂等 no-op：sqlite_master sql 已含 "security" → 不重建表，不设 user_version', () => {
    const { db, execCalls, pragmaCalls } = makeMockDb({
      // 模拟 v11 已执行后的 schema（CHECK 已含 security）
      logSchemaSql:
        "CREATE TABLE ai_system_logs (... type TEXT CHECK(type IN ('discovery','acl','migration','backup','security')) ...)",
    })

    v11(db)

    // 幂等守卫早返：exec 零调用，pragma 零调用
    expect(execCalls).toHaveLength(0)
    expect(pragmaCalls).toHaveLength(0)
  })

  it('2. 执行 4 步 DDL + user_version=11：sql 不含 "security"（遗留 v6 后状态）→ 重建', () => {
    const { db, execCalls, pragmaCalls } = makeMockDb({
      // 模拟遗留库（v6 后）状态：CHECK 不含 security
      logSchemaSql:
        "CREATE TABLE ai_system_logs (... type TEXT CHECK(type IN ('discovery','acl','migration','backup')) ...)",
    })

    v11(db)

    // exec 调用序列含 5 步：DROP _new / CREATE _new / INSERT...SELECT / DROP old / RENAME
    const execJoined = execCalls.join('\n')
    expect(execJoined).toContain('DROP TABLE IF EXISTS ai_system_logs_new')
    expect(execJoined).toContain('CREATE TABLE ai_system_logs_new')
    expect(execJoined).toContain('INSERT INTO ai_system_logs_new')
    expect(execJoined).toContain('DROP TABLE ai_system_logs')
    expect(execJoined).toContain('ALTER TABLE ai_system_logs_new RENAME TO ai_system_logs')

    // CREATE _new DDL 含 'security'（CHECK widen 生效）
    const createNewCall = execCalls.find((c) => c.includes('CREATE TABLE ai_system_logs_new'))
    expect(createNewCall).toBeDefined()
    expect(createNewCall!).toContain("'security'")
    expect(createNewCall!).toContain("CHECK(type IN ('discovery','acl','migration','backup','security'))")
    // status CHECK 不变（仍含 'warning'）
    expect(createNewCall!).toContain("CHECK(status IN ('success','failed','warning'))")

    // INSERT...SELECT copy 全 10 列（id, type, status, device_ids, device_names, prompt_text, ai_response, parsed_result, error_message, created_at）
    const insertCall = execCalls.find((c) => c.includes('INSERT INTO ai_system_logs_new'))
    expect(insertCall).toBeDefined()
    expect(insertCall!).toContain('id, type, status, device_ids, device_names, prompt_text, ai_response, parsed_result, error_message, created_at')

    // user_version=11
    expect(pragmaCalls.some((c) => c.includes('user_version = 11'))).toBe(true)
  })

  it('3. 双路径 DDL 一致：v11 CREATE _new 的 security widen 在 init.ts fresh-install DDL 全数在列（v31 update widen 后形态）', () => {
    const v11Ddl = extractV11CreateNewDdl()
    const initDdl = extractInitFreshInstallDdl()

    // v11 迁移体：历史 5 值 type CHECK（security widen 当期形态，v11 函数体不再随 HEAD 演进）
    const v11TypeCheck = "CHECK(type IN ('discovery','acl','migration','backup','security'))"
    expect(v11Ddl).toContain(v11TypeCheck)
    // init.ts fresh DDL：30-05 v31 再 widen 含 'update'（6 值）——v11 保证的 5 值全数在列；
    // HEAD 处双路径逐字一致由本文件 v31 describe 用例 c 守卫
    const initTypeCheck = "CHECK(type IN ('discovery','acl','migration','backup','security','update'))"
    expect(initDdl).toContain(initTypeCheck)

    // 双路径 status CHECK 串逐字相等（v11/v31 均不动 status，验证未漂移）
    const expectedStatusCheck = "CHECK(status IN ('success','failed','warning'))"
    expect(v11Ddl).toContain(expectedStatusCheck)
    expect(initDdl).toContain(expectedStatusCheck)
  })

  it('4. MIGRATION_HEAD=32（注册完整性静态守卫，防 bump 漏改）', () => {
    // Phase 18 18-02：v14；Phase 20 20-01：v15；Phase 21 21-01：v16；Phase 22/23 v17~v21；
    // Phase 25 v22~v24；Phase 29 29-02 v27 / 29-09 v28；29.1 v29~v30；Phase 30 30-05：v31；
    // Phase 36 36-01：v32（device_credentials 凭证子表，当前 HEAD）
    expect(MIGRATION_HEAD).toBe(32)
  })

  it('5. v13 双路径 DDL 一致：v13 ALTER 列定义串与 init.ts 三处 fresh-install DDL 特征串逐字一致', () => {
    // fs 读 migrations.ts 源码，从 const v13 起 slice 出 v13 起至 MIGRATIONS 数组的函数体区
    // （镜像本文件字符串抽取法；v13 注释在函数体内，一并纳入切片受反向守卫约束）
    const migSrc = fs.readFileSync(
      path.resolve(__dirname, '../../electron/database/migrations.ts'),
      'utf-8'
    )
    const v13Idx = migSrc.indexOf('const v13')
    expect(v13Idx).toBeGreaterThan(-1)
    const migrationsIdx = migSrc.indexOf('const MIGRATIONS', v13Idx)
    expect(migrationsIdx).toBeGreaterThan(v13Idx)
    const v13Body = migSrc.slice(v13Idx, migrationsIdx)

    // P1 反向守卫：v13 起函数体区不得引用「迁移在 MK 注入前跑」过时论据
    // （17-RESEARCH P1 定论：main.ts MK 注入先于 migrateAndSecure；F-01 修复时该守卫曾
    // 命中 v23 docstring 复制 v10 caveat 旧论据——已按 P1 口径改正，守卫继续防复发）
    expect(v13Body).not.toContain('MK 注入前')

    // fs 读 init.ts 源码抽出三处 CREATE TABLE 块（ai_exec_logs / ai_system_logs / scheduler_config）
    const initSrc = fs.readFileSync(
      path.resolve(__dirname, '../../electron/database/init.ts'),
      'utf-8'
    )
    const extractInitBlock = (table: string): string => {
      const startMarker = `CREATE TABLE IF NOT EXISTS ${table} (`
      const startIdx = initSrc.indexOf(startMarker)
      expect(startIdx).toBeGreaterThan(-1)
      const endIdx = initSrc.indexOf(');', startIdx)
      expect(endIdx).toBeGreaterThan(startIdx)
      return initSrc.slice(startIdx, endIdx)
    }
    const aiExecLogsDdl = extractInitBlock('ai_exec_logs')
    const aiSystemLogsDdl = extractInitBlock('ai_system_logs')
    const schedulerConfigDdl = extractInitBlock('scheduler_config')

    // 两日志表 _enc 特征串：v13 函数体与 init.ts 两处 DDL 块各含（双 toContain）
    for (const ddl of [v13Body, aiExecLogsDdl, aiSystemLogsDdl]) {
      expect(ddl).toContain('prompt_text_enc TEXT')
      expect(ddl).toContain('ai_response_enc TEXT')
    }
    // scheduler_config retention_days 特征串：v13 函数体与 init.ts DDL 块双 toContain
    expect(v13Body).toContain('retention_days INTEGER DEFAULT 90')
    expect(schedulerConfigDdl).toContain('retention_days INTEGER DEFAULT 90')
  })

  it('6. v14 双路径 DDL 一致：collected_at 索引 + 三触发器 image_desc 恒 NULL 特征串在 migrations.ts 与 init.ts 均命中，GROUP_CONCAT(description) 全文归零', () => {
    // fs 读 migrations.ts 源码，从 const v14 起 slice 出 v14 函数体（到 MIGRATIONS 数组止，
    // 镜像 Test 5 字符串抽取法）
    const migSrc = fs.readFileSync(
      path.resolve(__dirname, '../../electron/database/migrations.ts'),
      'utf-8'
    )
    const v14Idx = migSrc.indexOf('const v14')
    expect(v14Idx).toBeGreaterThan(-1)
    const migrationsIdx = migSrc.indexOf('const MIGRATIONS', v14Idx)
    expect(migrationsIdx).toBeGreaterThan(v14Idx)
    const v14Body = migSrc.slice(v14Idx, migrationsIdx)

    const initSrc = fs.readFileSync(
      path.resolve(__dirname, '../../electron/database/init.ts'),
      'utf-8'
    )

    // collected_at 索引特征串：v14 函数体与 init.ts 双 toContain（逐字同款 DDL）
    const idxFeature = 'CREATE INDEX IF NOT EXISTS idx_arp_entries_collected_at ON arp_entries(collected_at)'
    expect(v14Body).toContain(idxFeature)
    expect(initSrc).toContain(idxFeature)

    // 三触发器 image_desc NULL 常量特征串（插入端 + delete 端）：双路径逐字一致
    // （T-18-06：双端常量静态可证不 mismatch，防 init/migrations 漂移）
    expect(v14Body).toContain('VALUES (new.rowid, new.title, new.content, NULL)')
    expect(initSrc).toContain('VALUES (new.rowid, new.title, new.content, NULL)')
    expect(v14Body).toContain("VALUES ('delete', old.rowid, old.title, old.content, NULL)")
    expect(initSrc).toContain("VALUES ('delete', old.rowid, old.title, old.content, NULL)")

    // Q10 方案 A：GROUP_CONCAT(description) 非确定性子查询全文件归零（含 v7 历史触发器体，已随 v14 对齐）
    expect(migSrc).not.toContain('GROUP_CONCAT(description)')
    expect(initSrc).not.toContain('GROUP_CONCAT(description)')
  })
})

describe('v15 prompt_overrides + mcp_configs 建表迁移（Phase 20 20-01）', () => {
  // v15 迁移函数实际调用形态：db.exec(CREATE TABLE IF NOT EXISTS ...) + db.pragma('user_version = 15')，
  // 全部包在 db.transaction 内（throw 即 ROLLBACK，mock 直跑 fn，与 v11 mock 思路一致）。
  function makeMockDb() {
    const execCalls: string[] = []
    const pragmaCalls: string[] = []
    const db: any = {
      prepare() {
        return { get: () => undefined, all: () => [] }
      },
      exec(sql: string) {
        execCalls.push(sql)
      },
      pragma(cmd: string | string[]) {
        pragmaCalls.push(Array.isArray(cmd) ? cmd.join(';') : cmd)
      },
      transaction(fn: () => void) {
        return () => fn()
      },
    }
    return { db, execCalls, pragmaCalls }
  }

  it('1. 执行两表 CREATE TABLE IF NOT EXISTS + user_version=15，全部 DDL 带 IF NOT EXISTS 幂等守卫', () => {
    const { db, execCalls, pragmaCalls } = makeMockDb()
    v15(db)
    expect(execCalls.length).toBeGreaterThanOrEqual(1)
    const joined = execCalls.join('\n')
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS prompt_overrides')
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS mcp_configs')
    // 全部建表语句均带 IF NOT EXISTS 守卫（不靠 user_version 判定，可重复执行）
    for (const c of execCalls) {
      expect(c).toContain('IF NOT EXISTS')
    }
    expect(pragmaCalls.some((c) => c.includes('user_version = 15'))).toBe(true)
  })

  it('2. 幂等重跑：v15 二次执行不 throw，语句仍全为 IF NOT EXISTS', () => {
    const { db } = makeMockDb()
    expect(() => {
      v15(db)
      v15(db)
    }).not.toThrow()
  })

  it('3. 双路径 DDL 一致：v15 两表 DDL 特征串与 init.ts fresh-install DDL 逐字一致', () => {
    const migSrc = fs.readFileSync(path.resolve(__dirname, '../../electron/database/migrations.ts'), 'utf-8')
    const v15Idx = migSrc.indexOf('const v15')
    expect(v15Idx).toBeGreaterThan(-1)
    const migrationsIdx = migSrc.indexOf('const MIGRATIONS', v15Idx)
    const v15Body = migSrc.slice(v15Idx, migrationsIdx)

    const initSrc = fs.readFileSync(path.resolve(__dirname, '../../electron/database/init.ts'), 'utf-8')
    const extractInitBlock = (table: string): string => {
      const startIdx = initSrc.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)
      expect(startIdx).toBeGreaterThan(-1)
      const endIdx = initSrc.indexOf(');', startIdx)
      return initSrc.slice(startIdx, endIdx)
    }

    // prompt_overrides 关键列特征串：双路径逐字一致（content 明文不加 _enc，CONTEXT 决策）
    const promptCols = [
      'prompt_id TEXT PRIMARY KEY',
      'content TEXT NOT NULL',
      'based_on_version INTEGER NOT NULL',
      'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ]
    for (const col of promptCols) {
      expect(v15Body).toContain(col)
      expect(extractInitBlock('prompt_overrides')).toContain(col)
    }

    // mcp_configs 关键列特征串：v15 迁移体保持历史形态（device_id 内嵌占位）——
    // 21-01 v16 起 init.ts fresh-install 基线已切换为 v16 一对多形态（D-03），
    // v15 块与 init.ts 的 mcp_configs 双路径一致性断言由本文件上方 v16 describe 用例 c 接管。
    // 此处仅断言 v15 迁移体自身的历史 DDL 特征（WR-02 修复后的 TEXT 形态）。
    const mcpCols = [
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
      'device_id TEXT UNIQUE NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
      "type TEXT NOT NULL CHECK(type IN ('stdio','http'))",
      'credential_enc TEXT',
      'enabled INTEGER NOT NULL DEFAULT 1',
    ]
    for (const col of mcpCols) {
      expect(v15Body).toContain(col)
    }

    // 反向守卫：credential_enc 不得带 NOT NULL / 空串默认（v13:369-370 双态语义）
    expect(v15Body).not.toContain('credential_enc TEXT NOT NULL')
    expect(v15Body).not.toContain("credential_enc TEXT DEFAULT ''")
    // 反向守卫（WR-02）：device_id 不得回退 INTEGER（devices.id 是 TEXT uuid，亲和性致 CASCADE 失效；
    // 用 DDL 精确形态 'device_id INTEGER UNIQUE' 避免误命中守卫代码/注释里的检测字符串）
    expect(v15Body).not.toContain('device_id INTEGER UNIQUE')
    expect(extractInitBlock('mcp_configs')).not.toContain('device_id INTEGER')
  })

  it('4. WR-02 重建守卫：legacy device_id INTEGER 表被 DROP 重建为 TEXT，新表/无表不触发 DROP', () => {
    // legacy 形态：早期 v15 建出的 INTEGER 表
    const legacyDb: any = {
      prepare() {
        return { get: () => ({ sql: 'CREATE TABLE mcp_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER UNIQUE NOT NULL REFERENCES devices(id) ON DELETE CASCADE)' }) }
      },
      execCalls: [] as string[],
      exec(sql: string) { this.execCalls.push(sql) },
      pragma() { /* noop */ },
      transaction(fn: () => void) { return () => fn() },
    }
    v15(legacyDb)
    const joined = legacyDb.execCalls.join('\n')
    expect(joined).toContain('DROP TABLE mcp_configs')
    expect(joined).toContain('device_id TEXT UNIQUE NOT NULL REFERENCES devices(id)')

    // 干净库（无表）：不触发 DROP，直接 CREATE
    const freshDb: any = {
      prepare() { return { get: () => undefined } },
      execCalls: [] as string[],
      exec(sql: string) { this.execCalls.push(sql) },
      pragma() { /* noop */ },
      transaction(fn: () => void) { return () => fn() },
    }
    v15(freshDb)
    expect(freshDb.execCalls.join('\n')).not.toContain('DROP TABLE')
  })
})
