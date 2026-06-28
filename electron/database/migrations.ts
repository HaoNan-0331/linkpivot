import type Database from 'better-sqlite3'
import { getDatabase } from './connection'
import { hasColumn } from './migrationHelpers'
import { createSystemLog } from '../services/systemLog'

/**
 * 版本→步骤注册表（D-16）。
 * 顺序整数 user_version：1, 2, 3, ...。每版本 = 一个原子迁移步骤（D-07）。
 * 遗留库 user_version=0 启动时重跑全部 pending 步骤（D-14/D-15），已是当前 schema 的步骤为 no-op。
 * MIGRATION_HEAD 随新增迁移递增。
 *
 * 注意：runMigrations() 的调用方是 connection.ts migrateAndSecure()（Plan 03），
 *      在 createTables() 建好基线表之后、premigration 备份之后执行（D-06）。
 *      init.ts 不直接调用 runMigrations（单一调用点原则）。
 */
export const MIGRATION_HEAD = 6

interface MigrationStep {
  version: number
  name: string
  run: (db: Database.Database) => void
}

// 每个步骤的 DDL 包在单个 db.transaction 内：throw 时 DDL 自动 ROLLBACK（D-08）。
// 注意：不要依赖 PRAGMA user_version 与 DDL 的事务原子性（user_version 语义不保证随事务回滚）——
// 真正的"可安全重跑"由 hasColumn / sqlite_master sql-content 幂等守卫保证（D-14）。
// 新增迁移步骤必须自带幂等守卫，不得仅靠版本号判定是否已执行。
const v1 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'chat_history', 'session_id')) {
      db.exec('ALTER TABLE chat_history ADD COLUMN session_id TEXT')
    }
    db.pragma('user_version = 1')
  })
  step()
}

const v2 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_exec_logs', 'prompt_text')) {
      db.exec("ALTER TABLE ai_exec_logs ADD COLUMN prompt_text TEXT DEFAULT ''")
    }
    if (!hasColumn(db, 'ai_exec_logs', 'ai_response')) {
      db.exec("ALTER TABLE ai_exec_logs ADD COLUMN ai_response TEXT DEFAULT ''")
    }
    db.pragma('user_version = 2')
  })
  step()
}

const v3 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'devices', 'status')) {
      db.exec("ALTER TABLE devices ADD COLUMN status TEXT DEFAULT 'unknown' CHECK(status IN ('online','offline','unknown'))")
    }
    if (!hasColumn(db, 'devices', 'last_checked')) {
      db.exec('ALTER TABLE devices ADD COLUMN last_checked TEXT')
    }
    db.pragma('user_version = 3')
  })
  step()
}

const v4 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_config', 'vision_base_url_enc')) {
      db.exec('ALTER TABLE ai_config ADD COLUMN vision_base_url_enc TEXT')
    }
    if (!hasColumn(db, 'ai_config', 'vision_api_key_enc')) {
      db.exec('ALTER TABLE ai_config ADD COLUMN vision_api_key_enc TEXT')
    }
    if (!hasColumn(db, 'ai_config', 'vision_model_enc')) {
      db.exec('ALTER TABLE ai_config ADD COLUMN vision_model_enc TEXT')
    }
    db.pragma('user_version = 4')
  })
  step()
}

const v5 = (db: Database.Database): void => {
  // devices 表 CHECK 重建（'rdp'）——保留 sqlite_master sql-content 守卫 + foreign_key_check 断言
  // （init.ts:312-356 既有模式，D-14 第二形式幂等守卫）
  const connTypeCheck = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get() as { sql?: string } | undefined)?.sql || ''
  if (connTypeCheck.includes("'rdp'")) {
    return // 已含 rdp，no-op（幂等重跑 D-14）
  }
  const step = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS devices_new")
    db.exec(`
      CREATE TABLE devices_new (
        id TEXT PRIMARY KEY,
        topology_id TEXT,
        name_enc TEXT NOT NULL,
        vendor_enc TEXT,
        model_enc TEXT,
        version_enc TEXT,
        ip_enc TEXT,
        device_type TEXT DEFAULT 'generic' CHECK(device_type IN ('router','switch','firewall','server','generic')),
        connection_type TEXT CHECK(connection_type IN ('ssh','telnet','web','rdp')),
        port_enc TEXT,
        username_enc TEXT,
        password_enc TEXT,
        ssh_key_path_enc TEXT,
        ssh_key_content_enc TEXT,
        web_url_enc TEXT,
        status TEXT DEFAULT 'unknown',
        last_checked TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (topology_id) REFERENCES topologies(id) ON DELETE SET NULL
      );
      INSERT INTO devices_new
        SELECT id, topology_id, name_enc, vendor_enc, model_enc, version_enc, ip_enc,
          COALESCE(device_type, 'generic'), connection_type, port_enc, username_enc,
          password_enc, ssh_key_path_enc, ssh_key_content_enc, web_url_enc,
          COALESCE(status, 'unknown'), last_checked, created_at, updated_at
        FROM devices;
      DROP TABLE devices;
      ALTER TABLE devices_new RENAME TO devices;
    `)
    const fkErrors = db.pragma('foreign_key_check') as unknown[]
    if (fkErrors.length > 0) {
      throw new Error('devices 重建后外键完整性校验失败: ' + JSON.stringify(fkErrors))
    }
    db.pragma('user_version = 5')
  })
  step()
}

const v6 = (db: Database.Database): void => {
  // CR-01 修复：ai_system_logs 原 CHECK type IN ('discovery') / status IN ('success','failed') 过窄，
  // Phase 2 的 acl/migration/backup + warning 日志全部触发 SQLITE_CONSTRAINT_CHECK 被吞，D-08/D-13 审计落空。
  // 重建表放开 CHECK（镜像 v5 rebuild 模式）。幂等守卫：sqlite_master sql-content（已含 'warning' 则 no-op）。
  const logSchema = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_system_logs'").get() as { sql?: string } | undefined)?.sql || ''
  if (logSchema.includes("'warning'")) {
    return // CHECK 已放开，no-op（幂等重跑 D-14）
  }
  const step = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS ai_system_logs_new")
    db.exec(`
      CREATE TABLE ai_system_logs_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup')),
        status TEXT NOT NULL CHECK(status IN ('success','failed','warning')),
        device_ids TEXT,
        device_names TEXT,
        prompt_text TEXT,
        ai_response TEXT,
        parsed_result TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO ai_system_logs_new
        SELECT id, type, status, device_ids, device_names, prompt_text, ai_response, parsed_result, error_message, created_at
        FROM ai_system_logs;
      DROP TABLE ai_system_logs;
      ALTER TABLE ai_system_logs_new RENAME TO ai_system_logs;
    `)
    db.pragma('user_version = 6')
  })
  step()
}

const MIGRATIONS: MigrationStep[] = [
  { version: 1, name: 'chat_history.session_id', run: v1 },
  { version: 2, name: 'ai_exec_logs.prompt_text+ai_response', run: v2 },
  { version: 3, name: 'devices.status+last_checked', run: v3 },
  { version: 4, name: 'ai_config.vision_*', run: v4 },
  { version: 5, name: 'devices.connection_type CHECK rdp rebuild', run: v5 },
  { version: 6, name: 'ai_system_logs CHECK widen (acl/migration/backup + warning)', run: v6 },
]

/**
 * 运行迁移（D-14/D-16）。从 current+1 到 MIGRATION_HEAD 顺序执行。
 * 遗留库 user_version=0 → 重跑全部步骤，已是当前 schema 的 no-op（hasColumn/sqlite_master 守卫），抵达 head。
 * 每步骤失败 → better-sqlite3 自动回滚（DB 停留前版本）→ 写 system log → 抛出（启动中止，D-08）。
 *
 * 注意：D-06「迁移前备份」由 connection.ts migrateAndSecure() 在调用 runMigrations 之前完成（Plan 03）。
 *      本函数仅做迁移本身，不负责备份/ACL。
 *      调用前必须已 createTables()（hasColumn 需基线表存在）。
 */
export function runMigrations(): void {
  const db = getDatabase()
  const currentRow = db.pragma('user_version') as Array<{ user_version: number }>
  const current = currentRow[0]?.user_version ?? 0

  if (current >= MIGRATION_HEAD) return

  for (const step of MIGRATIONS) {
    if (step.version <= current) continue
    try {
      step.run(db)
    } catch (err) {
      const msg = (err as Error).message
      // D-08：写 system log（try/catch 包裹，不让日志失败掩盖迁移失败）
      try {
        createSystemLog({
          type: 'migration',
          status: 'failed',
          errorMessage: `迁移步骤 v${step.version} (${step.name}) 失败: ${msg}`,
        })
      } catch { /* 日志失败不影响抛出 */ }
      // D-08：抛出清晰错误，启动中止。不自动恢复（指明备份由调用方/人工处理）。
      throw new Error(
        `数据库迁移失败：步骤 v${step.version} (${step.name}) — ${msg}。` +
        `数据库已回滚至 v${step.version - 1}。请从 userData/backups/ 下的 premigration 备份人工恢复后重试。`
      )
    }
  }
}
