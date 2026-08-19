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

import { v16, v17, v19, v20, v21 } from '../../electron/database/migrations'
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
