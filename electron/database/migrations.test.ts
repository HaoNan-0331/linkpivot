import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { v11 } from './migrations'

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

  it('4. MIGRATION_HEAD=11（注册完整性静态守卫，防 bump 漏改）', async () => {
    const mod = await import('./migrations')
    expect(mod.MIGRATION_HEAD).toBe(11)
  })
})
