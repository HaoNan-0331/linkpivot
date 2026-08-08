// tests/electron/db.real.test.ts
//
// DB 真路径回归测试（Phase 12 DEP-1 ABI 缓解，TEST-01 之 DB 部分 + SC1）。
// 经 tests/electron/_helpers/realDb.ts 的 makeRealDb() 拿真实 better-sqlite3 实例（electron-ABI），
// 验：
//   1. 真路径 CRUD（INSERT/SELECT/UPDATE/DELETE 经真实 prepared statement 复用）
//   2. 迁移幂等（makeRealDb runMigrations 独立 DDL 连跑两次第二次 no-op，验证 hasColumn 守卫幂等模式）
//   3. WAL 模式生效（pragma journal_mode 返回 wal）
//
// OQ#1 决策（RESEARCH Open Question #1，方案 A：零生产改动）：
//   本测试不调 getDatabase() 单例（connection.ts import electron app 等重依赖，vi.mock 牵连过广），
//   而是直接持有 makeRealDb() 返回的真实 better-sqlite3 实例跑 CRUD/迁移。
//   验证「electron-ABI better-sqlite3 在 electron.exe 内可加载 + 真实 CRUD + 迁移」（TEST-01 核心断言）。
//   消费 getDatabase 的 service（ai/arpCollector/experienceService）真路径测试在 Plan 12-02 用 vi.mock 注入。
//   零生产代码改动（SC4 红线最优解）。

import { describe, it, expect, afterEach } from 'vitest'
import { makeRealDb, runStandaloneMigrations } from './_helpers/realDb'

// 集中持有本次测试的 db handle，afterEach 统一 close 清理（realDb.close 自带 db.close + unlink 侧车）
let handle: ReturnType<typeof makeRealDb> | null = null

afterEach(() => {
  if (handle) {
    handle.close()
    handle = null
  }
})

describe('DB 真路径回归（electron-ABI better-sqlite3）', () => {
  it('真路径 CRUD：INSERT/SELECT/UPDATE/DELETE 经真实 prepared statement', () => {
    handle = makeRealDb()
    const { db } = handle

    // 建测试表
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)')

    // 循环外 prepared statement 复用（CONVENTIONS Pattern 4，复刻生产 better-sqlite3 用法）
    const ins = db.prepare('INSERT INTO t (x) VALUES (?)')
    ins.run('a')
    ins.run('b')

    // SELECT
    const rows = db.prepare('SELECT * FROM t ORDER BY id').all() as Array<{
      id: number
      x: string
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0].x).toBe('a')
    expect(rows[1].x).toBe('b')

    // UPDATE
    db.prepare('UPDATE t SET x = ? WHERE id = ?').run('c', 1)
    const afterUpdate = db.prepare('SELECT x FROM t WHERE id = 1').get() as { x: string }
    expect(afterUpdate.x).toBe('c')

    // DELETE
    db.prepare('DELETE FROM t WHERE id = ?').run(2)
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM t').get() as { cnt: number }
    expect(remaining.cnt).toBe(1)
  })

  it('迁移幂等：runStandaloneMigrations 真二次调用 no-op（hasColumn 守卫，WR-06）', () => {
    // 第一次：fresh-install 跑迁移（建 experiences 表 + ALTER ADD severity 守卫）
    handle = makeRealDb({ runMigrations: true })
    const { db } = handle

    // 验迁移已跑（experiences 表存在）
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='experiences'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('experiences')

    // 验 severity 列存在（迁移守卫 ALTER 或 CREATE 已建）
    const cols = db.prepare('PRAGMA table_info(experiences)').all() as Array<{ name: string }>
    const colNames = cols.map((c) => c.name)
    expect(colNames).toContain('severity')
    expect(colNames).toContain('id')
    expect(colNames).toContain('title')

    // 在同 db 上「真二次调用 runStandaloneMigrations」（WR-06 修复：之前手写裸 SQL 等价，
    // 没真验 helper 的 hasColumn 守卫逻辑，若守卫写错如 !hasColumn 误为 hasColumn 致重复 ALTER
    // 抛 duplicate column，本测试测不出来）。现在真调 helper 第二次，验 no-op（不抛）+ 表结构未变。
    // —— 复刻生产迁移幂等守卫：CREATE TABLE IF NOT EXISTS + hasColumn 守卫 ALTER，第二次不抛、表结构未变
    expect(() => runStandaloneMigrations(db)).not.toThrow()

    // 二次跑后表结构未变：experiences 仍 4 列（id/title/severity/created_at）
    const colsAfter = db.prepare('PRAGMA table_info(experiences)').all() as Array<{ name: string }>
    expect(colsAfter.map((c) => c.name).sort()).toEqual(['created_at', 'id', 'severity', 'title'].sort())

    // fresh-install 路径迁移 user_version 概念（本 helper 不 bump user_version，但验可写入数据）
    db.prepare('INSERT INTO experiences (id, title, severity) VALUES (?, ?, ?)').run('exp-1', 'test exp', 'high')
    const exp = db.prepare('SELECT * FROM experiences WHERE id = ?').get('exp-1') as {
      id: string
      title: string
      severity: string
    }
    expect(exp.title).toBe('test exp')
    expect(exp.severity).toBe('high')
  })

  it('WAL 模式生效：pragma journal_mode 返回 wal', () => {
    handle = makeRealDb()
    const { db } = handle

    // 写一行业务数据触发 WAL 侧车文件生成（验证 journal_mode 真实生效）
    db.exec('CREATE TABLE w (v INTEGER)')
    db.prepare('INSERT INTO w (v) VALUES (?)').run(42)

    const mode = db.pragma('journal_mode') as Array<{ journal_mode: string }>
    expect(mode[0].journal_mode.toLowerCase()).toBe('wal')
  })
})
