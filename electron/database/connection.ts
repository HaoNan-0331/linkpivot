import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { runMigrations, MIGRATION_HEAD } from './migrations'
import { restrictFilePermissions, restrictDirPermissions } from './acl'
import { ensureBackupsDir, BackupScheduler } from '../services/backupScheduler'
import { createSystemLog } from '../services/systemLog'

let db: Database.Database | null = null
// CR-02：DB 文件在 initDatabase 打开前是否已存在（区分遗留库 vs fresh-install）。
// 比"按核心表行数判定"更鲁棒——纯 IP 监控数据（arp_entries 有行、topologies/devices 空）的旧库
// 也能被识别为"有数据"而获得 premigration 备份安全网，避免无网下跑破坏性迁移。
let dbExistedBeforeOpen = false

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function initDatabase(): Database.Database {
  const dbPath = path.join(app.getPath('userData'), 'topology.db')
  dbExistedBeforeOpen = fs.existsSync(dbPath) // CR-02：打开前捕获预存在标志
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
 * DB 文件在本次 initDatabase 打开前是否已存在（CR-02）。
 * true = 遗留库（有历史数据，迁移前需备份安全网）；false = fresh-install（空库，无数据可恢复）。
 */
export function dbPreExisted(): boolean {
  return dbExistedBeforeOpen
}

/**
 * 执行迁移 + 收紧活跃 DB 文件 ACL（D-06/D-12a）。
 * 由 main.ts 在 createTables() 之后调用（确保基线表已建，迁移可 hasColumn 检查 + premigration 备份捕获 post-基线表数据）。
 *
 * 顺序（D-06/D-12a）：
 *   1. 若 current < MIGRATION_HEAD 且 DB 文件预存在（遗留库）→ createPremigrationBackup（D-06 强制安全网）
 *   2. runMigrations（Plan 01：原子步骤，失败抛出+system log+中止，DB 停留前版本 D-08）
 *   3. ACL 收紧 db/wal/shm（D-12a 幂等，非致命 D-13）
 *
 * fresh-install（DB 文件新建）跳过 premigration 备份（无数据可恢复）；遗留库（文件预存在）必备份。
 * CR-02：门控改用 dbPreExisted()（文件预存在），不再按核心表行数判定——避免纯 IP 数据旧库误判为空。
 * BUG-3 修复（Phase 30-01）：premigration 备份完整 await 后才跑 runMigrations（防在线备份重拷贝捕获迁移后状态）。
 */
export async function migrateAndSecure(): Promise<void> {
  const conn = getDatabase()
  const currentVersion = (conn.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version ?? 0

  // D-06：迁移前备份（gated on DB 文件预存在，CR-02）。createTables 之后、runMigrations 之前。
  if (currentVersion < MIGRATION_HEAD) {
    if (dbPreExisted()) {
      await BackupScheduler.createPremigrationBackup(currentVersion, MIGRATION_HEAD)
    } else {
      // fresh-install 空库无数据可恢复，premigration 备份无价值，跳过并记录
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
