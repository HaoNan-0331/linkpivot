import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import { runMigrations, MIGRATION_HEAD } from './migrations'
import { restrictFilePermissions, restrictDirPermissions } from './acl'
import { ensureBackupsDir, BackupScheduler } from '../services/backupScheduler'
import { createSystemLog } from '../services/systemLog'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function initDatabase(): Database.Database {
  const dbPath = path.join(app.getPath('userData'), 'topology.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 1000')

  // D-12a：启动时确保 backups 目录就绪 + 重收紧历史 backups 目录 ACL（幂等，修正历史宽松权限）
  ensureBackupsDir()
  restrictDirPermissions(path.join(app.getPath('userData'), 'backups'))

  return db
}

export function closeDatabase() {
  if (db) { db.close(); db = null }
}

/**
 * 执行迁移 + 收紧活跃 DB 文件 ACL（D-06/D-12a）。
 * 由 main.ts 在 createTables() 之后调用（确保基线表已建，迁移可 hasColumn 检查 + premigration 备份捕获 post-基线表数据）。
 *
 * 顺序（D-06/D-12a）：
 *   1. 若 current < MIGRATION_HEAD 且库非空 → createPremigrationBackup（D-06 强制安全网，捕获迁移前数据态）
 *   2. runMigrations（Plan 01：原子步骤，失败抛出+system log+中止，DB 停留前版本 D-08）
 *   3. ACL 收紧 db/wal/shm（D-12a 幂等，非致命 D-13）
 *
 * fresh-install（空库）跳过 premigration 备份（无数据可恢复）；旧库（有数据）必备份。
 */
export function migrateAndSecure(): void {
  const conn = getDatabase()
  const currentVersion = (conn.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version ?? 0

  // D-06：迁移前备份（gated on 非空库）。createTables 之后、runMigrations 之前。
  if (currentVersion < MIGRATION_HEAD) {
    if (hasUserData()) {
      BackupScheduler.createPremigrationBackup(currentVersion, MIGRATION_HEAD)
    } else {
      // WARNING 1 fix：fresh-install 空库无数据可恢复，premigration 备份无价值，跳过并记录
      try {
        createSystemLog({ type: 'backup', status: 'warning', errorMessage: 'fresh-install 空库：跳过 premigration 备份（无数据可恢复），直接执行迁移' })
      } catch { /* 非致命 */ }
    }
  }

  // 迁移（Plan 01 runMigrations：原子步骤，失败抛出+system log+中止，DB 停留前版本 D-08）
  runMigrations()

  // D-12a：活跃 DB 文件每次启动重新收紧（幂等，顺带修正历史宽松权限）
  const dbPath = path.join(app.getPath('userData'), 'topology.db')
  restrictFilePermissions(dbPath, 'topology.db')
  restrictFilePermissions(`${dbPath}-wal`, 'topology.db-wal')
  restrictFilePermissions(`${dbPath}-shm`, 'topology.db-shm')
}

/**
 * 检测库是否有用户数据（用于 gate premigration 备份——fresh-install 空库跳过）。
 * topologies/devices 是核心业务表，任一有行即视为有数据。
 */
function hasUserData(): boolean {
  try {
    const conn = getDatabase()
    const tableCount = (conn.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table'").get() as { cnt: number }).cnt
    if (tableCount === 0) return false // 表都没建（理论上 createTables 后不会发生，防御）
    const topoCount = (conn.prepare('SELECT count(*) as cnt FROM topologies').get() as { cnt: number }).cnt
    if (topoCount > 0) return true
    const devCount = (conn.prepare('SELECT count(*) as cnt FROM devices').get() as { cnt: number }).cnt
    return devCount > 0
  } catch {
    // 表不存在（createTables 异常或 schema 不全）→ 视为无数据，保守返回 false
    return false
  }
}
