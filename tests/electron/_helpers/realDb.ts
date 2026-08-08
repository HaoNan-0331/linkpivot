// tests/electron/_helpers/realDb.ts
//
// 真路径 DB helper（Phase 12 DEP-1 ABI 缓解，TEST-01 DB 部分）。
// 复刻 electron/database/connection.ts initDatabase 的 pragma 序列，但用 os.tmpdir() 临时文件路径，
// 不调 electron app.getPath（测试在 ELECTRON_RUN_AS_NODE 下无 app 上下文）。
//
// OQ#1 决策（RESEARCH Open Question #1，planner 已决方案 A：零生产改动）：
//   生产 createTables()/runMigrations() 经 getDatabase() 单例 + import electron app/backupScheduler 等重依赖，
//   测试侧无法直接调用（牵连过广 + app.getPath 在 RUN_AS_NODE 下不可用）。
//   故本 helper 不 import 生产 init/migrations —— 仅复刻 pragma 序列 + 提供独立幂等 DDL 选项（runMigrations），
//   用于验证「迁移幂等守卫模式」可在 electron-ABI better-sqlite3 下正常运行（TEST-01 核心断言之迁移部分）。
//   消费 getDatabase 的 service（ai/arpCollector/experienceService）真路径测试在 Plan 12-02 用 vi.mock 注入 realDb 实例。
//
// 安全域（threat_model T-12-03）：临时 DB 文件用 os.tmpdir() + 唯一名（Date.now+Math.random）防并发撞；
// close() 严格删 dbPath + -wal + -shm（try/catch ENOENT 容错）；测试不用真实 masterKey。

import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

export interface RealDbHandle {
  db: Database.Database
  dbPath: string
  close: () => void
}

export interface MakeRealDbOpts {
  /** 是否跑独立的幂等 DDL（模拟迁移注册表：建 experiences 测试表 + ALTER ADD COLUMN 幂等守卫）。默认 false。 */
  runMigrations?: boolean
}

/**
 * 建一个临时真实 better-sqlite3 DB（electron-ABI），复刻 connection.ts pragma 序列。
 * 唯一文件名防并发撞（Pitfall 3）。runMigrations=true 时跑独立幂等 DDL（TEST-01 迁移幂等回归）。
 */
export function makeRealDb(opts?: MakeRealDbOpts): RealDbHandle {
  const dbPath = path.join(
    os.tmpdir(),
    `nt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  )
  const db = new Database(dbPath)
  // 复刻 connection.ts:25-28 initDatabase pragma 四行（WAL/foreign_keys/busy_timeout/wal_autocheckpoint）
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 1000')

  if (opts?.runMigrations) {
    runStandaloneMigrations(db)
  }

  const close = (): void => {
    try {
      db.close()
    } catch {
      /* ignore double-close */
    }
    // 严格删主文件 + WAL/SHM 侧车（Pitfall 3），try/catch 容错 ENOENT（文件可能尚未生成或已被清）
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try {
        fs.unlinkSync(f)
      } catch {
        /* ENOENT 容错：侧车文件可能在 close 后未生成（如无写入），忽略 */
      }
    }
  }

  return { db, dbPath, close }
}

/**
 * 独立幂等迁移 DDL（测试侧，模拟生产 migrations.ts 的 hasColumn 守卫 + db.transaction 原子模式）。
 * 验证「迁移幂等守卫模式（hasColumn/sqlite_master 特征串）可在 electron-ABI better-sqlite3 下正常运行」。
 * 不 import 生产 migrations（避免牵连 getDatabase 单例 + electron app）。
 *
 * 幂等性：每次调用都安全重跑（CREATE TABLE IF NOT EXISTS + hasColumn 守卫 ALTER），
 *   第二次调用为 no-op（表/列已存在），不抛异常 —— 复刻生产迁移的幂等语义。
 */
function runStandaloneMigrations(db: Database.Database): void {
  const step = db.transaction(() => {
    // 建一张测试表（模拟 fresh-install DDL）
    db.exec(`
      CREATE TABLE IF NOT EXISTS experiences (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        severity TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `)
    // 幂等 ALTER ADD COLUMN（模拟 v9/v10 hasColumn 守卫迁移）
    if (!hasColumn(db, 'experiences', 'severity')) {
      // 上面 CREATE 已含 severity，此处守卫命中跳过（演示幂等 no-op）
      db.exec('ALTER TABLE experiences ADD COLUMN severity TEXT')
    }
  })
  step()
}

/** 复刻 electron/database/migrationHelpers.ts hasColumn（避免 import 生产模块牵连 getDatabase）。 */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}
