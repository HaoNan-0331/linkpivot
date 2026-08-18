import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { v11, v15 } from './migrations'

/**
 * v11 迁移单测（体检报告 2026-08-07 §1.1 #5 闭环）。
 *
 * DEP-1 约束：better-sqlite3 native binding 在 plain Node（vitest 运行时）下 ABI 冲突无法加载，
 * 故用 mock-DB 桩复刻 v11 迁移用到的 db 子集 API（prepare().get() / exec / pragma / transaction），
 * 验证幂等守卫 + DDL 序 + 双路径一致，不实例化 better-sqlite3（与 experienceService.test.ts 规避 native 思路一致）。
 *
 * 双路径一致性比对：直接读 migrations.ts / init.ts 源码字符串抽出各自 ai_system_logs DDL 块，
 * 做关键特征 includes 双断言（不动 init.ts 函数契约，避免 Rule 4 架构变更）。
 */

// ---------- mock-DB 桩 ----------
// v11 迁移函数实际调用形态：
//   db.prepare(sql).get()            → 查 sqlite_master（幂等守卫）
//   db.exec(sql)                     → DDL 执行（DROP/CREATE/INSERT/DROP/RENAME）
//   db.pragma(cmd)                   → user_version 设定
//   db.transaction(fn)()             → 包裹 DDL（throw ROLLBACK 语义由真实 better-sqlite3 提供，mock 直跑 fn）
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

// ---------- 双路径 DDL 字符串提取（静态守卫）----------
// v11 重建表 CREATE _new DDL 与 init.ts fresh-install ai_system_logs DDL 必须逐字一致
// （CONVENTIONS 双路径一致红线）。直接读 migrations.ts 源码字符串抽出 v11 的 CREATE _new 块，
// init.ts 经 createTablesSource 暴露 DDL 文本，做关键特征 includes 双断言。

function extractV11CreateNewDdl(): string {
  const src = fs.readFileSync(
    path.resolve(__dirname, 'migrations.ts'),
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
    path.resolve(__dirname, 'init.ts'),
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

  it('3. 双路径 DDL 一致：v11 CREATE _new DDL 与 init.ts fresh-install ai_system_logs DDL 特征逐字一致', () => {
    const v11Ddl = extractV11CreateNewDdl()
    const initDdl = extractInitFreshInstallDdl()

    // 双路径 type CHECK 串逐字相等
    const expectedTypeCheck = "CHECK(type IN ('discovery','acl','migration','backup','security'))"
    expect(v11Ddl).toContain(expectedTypeCheck)
    expect(initDdl).toContain(expectedTypeCheck)

    // 双路径 status CHECK 串逐字相等（v11 不动 status，验证未漂移）
    const expectedStatusCheck = "CHECK(status IN ('success','failed','warning'))"
    expect(v11Ddl).toContain(expectedStatusCheck)
    expect(initDdl).toContain(expectedStatusCheck)
  })

  it('4. MIGRATION_HEAD=15（注册完整性静态守卫，防 bump 漏改）', async () => {
    const mod = await import('./migrations')
    // Phase 18 18-02：v14 注册后 MIGRATION_HEAD=14；
    // Phase 20 20-01：v15 prompt_overrides + mcp_configs 两表迁移注册，HEAD 从 14 bump 到 15
    expect(mod.MIGRATION_HEAD).toBe(15)
  })

  it('5. v13 双路径 DDL 一致：v13 ALTER 列定义串与 init.ts 三处 fresh-install DDL 特征串逐字一致', () => {
    // fs 读 migrations.ts 源码，从 const v13 起 slice 出 v13 函数体（到 MIGRATIONS 数组止，
    // 镜像 Test 3 字符串抽取法；v13 注释在函数体内，一并纳入切片受反向守卫约束）
    const migSrc = fs.readFileSync(
      path.resolve(__dirname, 'migrations.ts'),
      'utf-8'
    )
    const v13Idx = migSrc.indexOf('const v13')
    expect(v13Idx).toBeGreaterThan(-1)
    const migrationsIdx = migSrc.indexOf('const MIGRATIONS', v13Idx)
    expect(migrationsIdx).toBeGreaterThan(v13Idx)
    const v13Body = migSrc.slice(v13Idx, migrationsIdx)

    // P1 反向守卫：v13 注释不得引用「迁移在 MK 注入前跑」过时论据
    // （17-RESEARCH P1 定论：现状 main.ts:88-95 MK 注入先于 :105-106 migrateAndSecure）
    expect(v13Body).not.toContain('MK 注入前')

    // fs 读 init.ts 源码抽出三处 CREATE TABLE 块（ai_exec_logs / ai_system_logs / scheduler_config）
    const initSrc = fs.readFileSync(
      path.resolve(__dirname, 'init.ts'),
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
      path.resolve(__dirname, 'migrations.ts'),
      'utf-8'
    )
    const v14Idx = migSrc.indexOf('const v14')
    expect(v14Idx).toBeGreaterThan(-1)
    const migrationsIdx = migSrc.indexOf('const MIGRATIONS', v14Idx)
    expect(migrationsIdx).toBeGreaterThan(v14Idx)
    const v14Body = migSrc.slice(v14Idx, migrationsIdx)

    const initSrc = fs.readFileSync(
      path.resolve(__dirname, 'init.ts'),
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
    const migSrc = fs.readFileSync(path.resolve(__dirname, 'migrations.ts'), 'utf-8')
    const v15Idx = migSrc.indexOf('const v15')
    expect(v15Idx).toBeGreaterThan(-1)
    const migrationsIdx = migSrc.indexOf('const MIGRATIONS', v15Idx)
    const v15Body = migSrc.slice(v15Idx, migrationsIdx)

    const initSrc = fs.readFileSync(path.resolve(__dirname, 'init.ts'), 'utf-8')
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

    // mcp_configs 关键列特征串：双路径逐字一致（credential_enc nullable 占位，业务归 Phase 21；
    // device_id TEXT 对齐 devices.id TEXT uuid —— WR-02 修复，同库先例 arp_entries.device_id TEXT）
    const mcpCols = [
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
      'device_id TEXT UNIQUE NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
      "type TEXT NOT NULL CHECK(type IN ('stdio','http'))",
      'credential_enc TEXT',
      'enabled INTEGER NOT NULL DEFAULT 1',
    ]
    for (const col of mcpCols) {
      expect(v15Body).toContain(col)
      expect(extractInitBlock('mcp_configs')).toContain(col)
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
