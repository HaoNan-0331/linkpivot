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
export const MIGRATION_HEAD = 28

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

const v7 = (db: Database.Database): void => {
  // PERF-03：kb_chunks_au UPDATE trigger 加 WHEN（content/title/image_ids 未变时不删+插重索引）。
  // 幂等守卫 D-14 第二形式：sqlite_master 查 trigger sql 是否已含 WHEN（与 v5 查 'rdp'、v6 查 'warning' 同构）。
  const triggerSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='kb_chunks_au'"
  ).get() as { sql?: string } | undefined)?.sql || ''
  if (triggerSql.includes('WHEN')) {
    return // trigger 已带 WHEN，no-op（幂等重跑 D-14）
  }
  const step = db.transaction(() => {
    // CREATE TRIGGER IF NOT EXISTS 对"已存在但定义不同"的 trigger 不会替换，
    // 故现有库必须先 DROP 再 CREATE（PATTERNS caveat）。fresh-install 由 init.ts DDL 建带 WHEN 版本，此 v7 no-op。
    db.exec('DROP TRIGGER IF EXISTS kb_chunks_au')
    // 以下 CREATE TRIGGER DDL 必须与 init.ts fresh-install DDL 逐字一致（同一 WHEN + 两条 INSERT）。
    // image_desc 18-02（Q10 方案 A）随 v14 对齐为恒 NULL 常量：遗留库 v7→v14 重放与 fresh-install
    // 收敛到同一触发器定义（v14 DROP+CREATE 重建幂等，见 v14 注释）。
    db.exec(`CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks
WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids
BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
    VALUES ('delete', old.rowid, old.title, old.content, NULL);
  INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
    VALUES (new.rowid, new.title, new.content, NULL);
END`)
    db.pragma('user_version = 7')
  })
  step()
}

const v8 = (db: Database.Database): void => {
  // Phase 7：experiences + exp_device_rel 建表（幂等守卫 D-14 第二形式：sqlite_master sql-content）。
  // CREATE TABLE IF NOT EXISTS 本身幂等，但此处仍查特征串——与 v5/v6/v7 同构，保留"特征串命中即 no-op 早返"的可观测一致性。
  // 遗留库走此 v8 迁移建表；fresh-install 由 init.ts DDL 建表（两路径最终 schema 一致）。
  const expSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='experiences'"
  ).get() as { sql?: string } | undefined)?.sql || ''
  if (expSchema.includes('attrs_enc')) {
    return // 表已建含 attrs_enc 列，no-op（幂等重跑 D-14）
  }
  const step = db.transaction(() => {
    // 以下 DDL 必须与 init.ts fresh-install 块逐字一致（含所有列/CHECK/索引/FK，v7 注释同款要求）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS experiences (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'troubleshooting'
          CHECK(category IN ('troubleshooting','best_practices','product','env')),
        content TEXT NOT NULL DEFAULT '',
        tags TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft','confirmed','published','invalid')),
        source_session_id TEXT,
        attrs_enc TEXT,
        valid_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        invalid_at TEXT,
        last_verified_at TEXT,
        reuse_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (source_session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_experiences_category ON experiences(category);
      CREATE INDEX IF NOT EXISTS idx_experiences_status ON experiences(status);
      CREATE INDEX IF NOT EXISTS idx_experiences_valid ON experiences(valid_at);
      CREATE INDEX IF NOT EXISTS idx_experiences_invalid ON experiences(invalid_at);
      CREATE INDEX IF NOT EXISTS idx_experiences_source_session ON experiences(source_session_id);

      CREATE TABLE IF NOT EXISTS exp_device_rel (
        id TEXT PRIMARY KEY,
        experience_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        relation_type TEXT NOT NULL DEFAULT 'primary',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(experience_id, device_id),
        FOREIGN KEY (experience_id) REFERENCES experiences(id) ON DELETE CASCADE,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_exp_device_rel_exp ON exp_device_rel(experience_id);
      CREATE INDEX IF NOT EXISTS idx_exp_device_rel_device ON exp_device_rel(device_id);
    `)
    db.pragma('user_version = 8')
  })
  step()
}

const v9 = (db: Database.Database): void => {
  // Phase 8（D-03a）：experiences 加 duplicate_of_exp_id TEXT nullable 列。
  // 支撑起草 UPDATE 命中关联（Phase 9 确认时据 draft.duplicate_of_exp_id 定位旧条目）+ 二期经验↔经验关联预留。
  // 幂等守卫 D-14 第一形式：hasColumn 判定（与 v1/v2/v3/v4 同构，纯 ALTER ADD COLUMN）。
  // 不动 status 枚举（沿用 Phase 7 四态）、不动现有列、不加 CHECK/DEFAULT。
  const step = db.transaction(() => {
    if (!hasColumn(db, 'experiences', 'duplicate_of_exp_id')) {
      db.exec('ALTER TABLE experiences ADD COLUMN duplicate_of_exp_id TEXT')
    }
    db.pragma('user_version = 9')
  })
  step()
}

const v10 = (db: Database.Database): void => {
  // Phase 10（D-10-2）：experiences 加 severity TEXT nullable 明文列。
  // 支撑浏览页 SQL 直筛/排序（WHERE severity = ?）+ Phase 11 检索复用，从加密 attrs 拆明文列。
  // attrs.severity 保留向后兼容（create/update 双写 severity 列 + attrs.severity；service 层
  // rowToExperience severity fallback：明文列 NULL 时读 attrs.severity，保证历史数据可读）。
  // 幂等守卫 D-14 第一形式：hasColumn（与 v1/v2/v3/v4/v9 同构，纯 ALTER ADD COLUMN）。
  // 不动 status 枚举（沿用 Phase 7 四态）、不加 CHECK/DEFAULT（severity 值由 service 层
  // VALID_SEVERITIES 校验，与 v9 同款纯 ALTER）。
  // 数据回填 caveat：迁移在 MK 注入前跑（migrateAndSecure 早于 setExperienceMasterKey），
  // 无法在 v10 内解密 attrs_enc 回填 severity 明文列——历史数据 severity 仍只在 attrs_enc，
  // 由 service 层 rowToExperience fallback 兜底（保证历史数据可查）。
  const step = db.transaction(() => {
    if (!hasColumn(db, 'experiences', 'severity')) {
      db.exec('ALTER TABLE experiences ADD COLUMN severity TEXT')
    }
    db.pragma('user_version = 10')
  })
  step()
}

/**
 * v11：ai_system_logs.type CHECK widen security（反审计盲区修复）。
 *
 * 根因（体检报告 2026-08-07 §1.1 #5）：v6 当年仅放开 type('discovery','acl','migration','backup') + status 'warning'，
 * **未含 'security'**。但代码层已有两处写 type:'security' 日志：
 *   - electron/main.ts setDecryptFailureHandler（R2 字段解密失败告警）
 *   - electron/services/experienceDrafting.ts relateDevice 失败告警（WR-02 fix）
 * 这两条 INSERT 全撞 SQLITE_CONSTRAINT_CHECK，被外层 try/catch 静默吞 → R2 解密失败 + 经验关联失败
 * 告警**全部落空**，无声数据丢失，审计盲区。本迁移把 type CHECK 扩为含 'security'，让告警真正落库可观测。
 *
 * caveat 同 v10：迁移在 MK 注入前跑（migrateAndSecure 早于 setXxxMasterKey），**不解密**（本迁移也不碰
 * 加密列，只改 CHECK 约束，与 v6 同款纯 DDL 重建表）。
 *
 * 幂等守卫 D-14 第二形式：sqlite_master sql 含 "'security'" 则 no-op 早返
 * （与 v5 查 'rdp'、v6 查 'warning'、v7 查 'WHEN' 同构，不靠 user_version 判定）。
 *
 * 执行体包 db.transaction（throw 即 ROLLBACK）：DROP _new → CREATE _new（CHECK widen）→
 * INSERT…SELECT copy 全 10 列 → DROP old → RENAME → user_version=11。
 * CREATE _new DDL 与 init.ts:87 fresh-install ai_system_logs DDL 逐字一致（双路径一致红线）。
 */
export const v11 = (db: Database.Database): void => {
  const logSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_system_logs'"
  ).get() as { sql?: string } | undefined)?.sql || ''
  if (logSchema.includes("'security'")) {
    return // CHECK 已含 security，no-op（幂等重跑 D-14）
  }
  const step = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS ai_system_logs_new")
    db.exec(`
      CREATE TABLE ai_system_logs_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup','security')),
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
    db.pragma('user_version = 11')
  })
  step()
}

/**
 * v12：ip_mac_bindings 加 is_baseline 列（BUG-1 首次基线标志，FIX-01 / D-14-1）。
 *
 * 根因（审计 §1.0 BUG-1）：anomalyService.processARPEntries 全新 IP 分支（currentBinding 与 oldBinding 都不存在）
 * 原本只 createBinding 缺 recordChange('new_ip')，致 getStats().newIp COUNT 读取侧恒零
 * （异常检测面板「新 IP」数字 + 导出 CSV 恒为 0）。修复方案 A：补 recordChange('new_ip') + 首次扫描建基线机制
 * （首次扫描只建 binding 不报 new_ip，避免首次全量扫描刷屏；基线后新增 IP 才报）。本 v12 提供 is_baseline 列。
 *
 * 语义（向后兼容，CLAUDE.md「迁移改动必须向后兼容历史数据」硬约束）：
 * ALTER ADD COLUMN 默认 0——遗留库（user_version≤11，ip_mac_bindings 已有存量 binding 行）升级后存量行 is_baseline=0（未基线）。
 * processARPEntries 首次扫描后置基线 UPDATE（WHERE is_baseline=0）会把所有现存存量 binding 行也置 1，
 * 即「首次扫描把当前所有现存 IP（含遗留存量）纳入基线，之后新增 IP 才报 new_ip」——预期行为（老库升级第一次扫描即确立基线，不刷屏报全量 IP 为 new_ip）。
 * 同时遗留库存量 IP 首次扫描走 processARPEntries 的 currentBinding 分支（存量 active binding 命中），
 * 不进 else 全新 IP 分支，故存量 IP 不被误报为 new_ip（核心向后兼容不变量，Test 6 佐证）。
 *
 * 幂等守卫 D-14 第一形式：hasColumn（与 v1/v2/v3/v4/v9/v10 同构，纯 ALTER ADD COLUMN，不靠 user_version 判定）。
 * 执行体包 db.transaction（throw 即 ROLLBACK）。列定义与 init.ts fresh-install ip_mac_bindings DDL 逐字一致（双路径一致红线）。
 */
const v12 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ip_mac_bindings', 'is_baseline')) {
      db.exec('ALTER TABLE ip_mac_bindings ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0')
    }
    db.pragma('user_version = 12')
  })
  step()
}

const v13 = (db: Database.Database): void => {
  // Phase 17（SEC-06 / S-M1，D-04）：ai_exec_logs / ai_system_logs 加密列地基 + scheduler_config.retention_days。
  // 根因：两日志表 prompt_text / ai_response 明文列（v2 迁移所加）明文落库 AI 对话原文，可含凭证/拓扑
  // 敏感信息，SEC-06 切换 AES-256-GCM _enc 加密列；本 v13 只落 schema 地基（写侧切换 17-02、读侧
  // fallback + 回填 17-03），纯加列零数据搬动，系统行为零变化。
  // 语义：4 个 _enc 列一律 nullable（禁 NOT NULL、禁空串默认值）——NULL（从未写密文）与空串
  // （写过但空内容）双态区分是读侧「列存在性判据、禁试解密」的语义根基（P3）。
  // retention_days 归属 scheduler_config 单行配置表，ALTER DEFAULT 90 对存量行立即生效；
  // 本 phase 只加列零消费，清理调度语义留给 Phase 18（D-04）。
  // ai_system_logs 纯加列不 rebuild（P6 自举）：迁移失败日志（runMigrations 内 createSystemLog）
  // 正写这张表，CREATE/DROP/RENAME 会在迁移窗口期自举坏死。
  // 幂等守卫 D-14 第一形式：hasColumn（与 v1/v2/v3/v4/v9/v10/v12 同构，纯 ALTER ADD COLUMN，
  // 不靠 user_version 判定）。列定义串与 init.ts fresh-install 三处 DDL 逐字一致（双路径红线）。
  // 数据回填 caveat：P1 实测 main.ts:88-95（MK 注入）先于 :105-106（migrateAndSecure 迁移）——
  // 技术上迁移内可解密回填，但刻意不做：回填可失败重试（post-MK 回填钩子 warn 不阻塞启动，判据
  // 「明文列 IS NOT NULL AND _enc IS NULL」幂等续跑），而迁移失败必须中止启动（runMigrations
  // throw 即中止）+ DDL 零数据依赖 + realDb 测试路径无 MK。历史明文行由 17-03 读侧 fallback 兼容。
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_exec_logs', 'prompt_text_enc')) {
      db.exec('ALTER TABLE ai_exec_logs ADD COLUMN prompt_text_enc TEXT')
    }
    if (!hasColumn(db, 'ai_exec_logs', 'ai_response_enc')) {
      db.exec('ALTER TABLE ai_exec_logs ADD COLUMN ai_response_enc TEXT')
    }
    if (!hasColumn(db, 'ai_system_logs', 'prompt_text_enc')) {
      db.exec('ALTER TABLE ai_system_logs ADD COLUMN prompt_text_enc TEXT')
    }
    if (!hasColumn(db, 'ai_system_logs', 'ai_response_enc')) {
      db.exec('ALTER TABLE ai_system_logs ADD COLUMN ai_response_enc TEXT')
    }
    if (!hasColumn(db, 'scheduler_config', 'retention_days')) {
      db.exec('ALTER TABLE scheduler_config ADD COLUMN retention_days INTEGER DEFAULT 90')
    }
    db.pragma('user_version = 13')
  })
  step()
}

const v14 = (db: Database.Database): void => {
  // Phase 18（18-02 / TXN-01 Q10 方案 A 终裁 + TXN-03 前置）：arp_entries.collected_at 索引
  // + kb 三触发器 image_desc 恒 NULL 重建。
  //
  // Q10 根因：ai/ad/au 三触发器 image_desc 取 kb_images 描述列的 GROUP_CONCAT 聚合子查询——
  // 非确定性来源（图片行可在 chunk 索引化之后插入/变更），delete 端命令值与索引实际值不符时
  // FTS5 抛 database disk image is malformed（生产线索：vision 描述非空时 docx 路径
  // processDocument 落 status='error'，16-QUIRKS Q10）。方案 A 终裁：image_desc 全链路恒定
  // NULL——kb_chunks_fts 零生产 MATCH 读者（18-RESEARCH 全库 grep 实证）+ Q9 已裁该列不可
  // 读回，双端常量可静态证明不 mismatch（T-18-06）。
  //
  // collected_at 索引为 18-05 retention（按时间窗删除 arp_entries）备好 schema，纯加索引零行为变化。
  //
  // 幂等守卫：索引走 CREATE INDEX IF NOT EXISTS 天然幂等（v8 先例）；触发器走 DROP IF EXISTS +
  // CREATE（v7 先例：CREATE IF NOT EXISTS 对「已存在但定义不同」的 trigger 不替换，必须先 DROP）；
  // 重放收敛同一结果，不靠 user_version 判定（文件头红线）。throw 即 ROLLBACK 回到 v13 态可重试（T-18-05）。
  // 三触发器 DDL 与 init.ts fresh-install 三触发器段逐字一致（双路径一致红线，v7 注释同款要求）。
  const step = db.transaction(() => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_arp_entries_collected_at ON arp_entries(collected_at)')
    db.exec('DROP TRIGGER IF EXISTS kb_chunks_ai')
    db.exec('DROP TRIGGER IF EXISTS kb_chunks_ad')
    db.exec('DROP TRIGGER IF EXISTS kb_chunks_au')
    db.exec(`CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
    VALUES (new.rowid, new.title, new.content, NULL);
END`)
    db.exec(`CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
    VALUES ('delete', old.rowid, old.title, old.content, NULL);
END`)
    db.exec(`CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks
WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids
BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
    VALUES ('delete', old.rowid, old.title, old.content, NULL);
  INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
    VALUES (new.rowid, new.title, new.content, NULL);
END`)
    db.pragma('user_version = 14')
  })
  step()
}

/**
 * v15：Phase 20（20-01）prompt_overrides + mcp_configs 两表建表迁移。
 *
 * - prompt_overrides：提示词 override 存储（PMT-01/PMT-02）。content 列**明文不加密**——
 *   默认值本身在代码 registry（promptRegistry.ts）内明文单一来源，用户改的也只是文案模板，
 *   加密无增益（20-CONTEXT 决策）。override-only 落库：DB 只存用户改动行，读取侧
 *   getPrompt = override ?? registry 默认（promptService，20-01 Task 3）。
 * - mcp_configs：仅建表占位，本 phase 无任何读写路径，凭证 _enc 体系与业务归 Phase 21。
 *   credential_enc nullable（禁 NOT NULL、禁空串默认）——NULL（从未写密文）与空串
 *   （写过但空内容）双态区分是读侧「列存在性判据、禁试解密」的语义根基（v13:369-370 同款）。
 *
 * 幂等守卫：CREATE TABLE IF NOT EXISTS 天然幂等（v8 先例），不靠 user_version 判定（文件头红线）。
 * 执行体包 db.transaction（throw 即 ROLLBACK）。
 * 两表 DDL 与 init.ts fresh-install DDL 逐字一致（双路径一致红线，v7/v8/v13/v14 注释同款要求）。
 */
export const v15 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    // WR-02（20-REVIEW）：早期 v15 曾以 device_id INTEGER 建表，而 devices.id 是 TEXT uuid——
    // 列亲和性使 ON DELETE CASCADE 外键匹配不可预期（同库正确先例 arp_entries.device_id TEXT）。
    // 占位表零读写零数据，sqlite_master 特征串命中即 DROP 重建为 TEXT（幂等守卫红线，不靠 user_version）。
    const legacy = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_configs'"
    ).get() as { sql: string } | undefined
    if (legacy && legacy.sql.includes('device_id INTEGER')) {
      db.exec('DROP TABLE mcp_configs')
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_overrides (
        prompt_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        based_on_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS mcp_configs (
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
    db.pragma('user_version = 15')
  })
  step()
}

/**
 * v16：Phase 21（21-01）mcp_configs 一对多重建（D-03）+ mcp_device_rel 关联表 + source（D-06）+ 最近测试列（D-09）。
 *
 * - v15 mcp_configs 为一对一占位形态（device_id 列内嵌），D-03 需求修订为一对多绑定 →
 *   DROP 重建为无 device_id 主表 + 独立 mcp_device_rel 关联表（照 exp_device_rel 形态，
 *   但 device_id 为**单列 UNIQUE**——一台设备至多绑定一个 MCP 配置，D-04 冲突拦截在
 *   service 层事务判定，DB 层 UNIQUE 兜底锁死）。占位表零读写零数据（v15 起无任何读写路径），DROP 无损。
 * - env_json_enc：stdio 环境变量键值对整体 JSON 加密单列（A4 裁决形态）；credential_enc：
 *   http token，保持 nullable 双态语义（NULL=从未写密文 / 空串=写过但空内容，v13:369 同款）。
 *   读写只走 encField/decField（禁裸调 encrypt/decrypt，service 层红线）。
 * - source：配置来源（manual/imported），默认 'manual'，UI 不暴露（D-06）。
 * - last_test_at/last_test_status/last_test_tool_count：连接测试最近结果（D-09）。
 *
 * 幂等守卫：sqlite_master 查 mcp_configs.sql——含旧特征（device_id 内嵌）或不含 'source'
 * 列特征才 DROP 重建；已是新形态则全段 CREATE IF NOT EXISTS no-op（不靠 user_version，文件头红线）。
 * 执行体包 db.transaction（throw 即 ROLLBACK）。
 * DDL 与 init.ts fresh-install DDL 逐字一致（双路径一致红线，v7/v8/v13/v14/v15 注释同款要求）。
 */
export const v16 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    const existing = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_configs'"
    ).get() as { sql: string } | undefined
    if (existing && (existing.sql.includes('device_id') || !existing.sql.includes('source'))) {
      db.exec('DROP TABLE mcp_configs')
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_configs (
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

      CREATE TABLE IF NOT EXISTS mcp_device_rel (
        id TEXT PRIMARY KEY,
        mcp_config_id INTEGER NOT NULL,
        device_id TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (mcp_config_id) REFERENCES mcp_configs(id) ON DELETE CASCADE,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_device_rel_mcp ON mcp_device_rel(mcp_config_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_device_rel_device ON mcp_device_rel(device_id);
    `)
    db.pragma('user_version = 16')
  })
  step()
}

/**
 * v17：Phase 22（22-01）mcp_tools 工具级策略表（D-02）。
 *
 * - 连接测试成功后工具清单（name/description/annotations/inputSchema）持久化缓存落
 *   tool_meta（JSON 字符串，明文不加密——prompt_overrides 明文先例，工具级开关非敏感）。
 * - enabled：工具级启用开关（默认 1）；skip_confirm：免确认开关（默认 0，service 层
 *   双条件守卫 isReadOnlyEligible 拒绝写 1——判定权在 main，renderer 只消费
 *   skipConfirmEligible 契约字段）。
 * - UNIQUE(config_id, tool_name)：一配置一工具一行，saveToolCache 覆盖式重建。
 *
 * 幂等守卫：sqlite_master 查 mcp_tools.sql——含 'skip_confirm' 列特征即全段 no-op；
 * 存在但不含特征（旧形态）才 DROP 重建。执行体包 db.transaction（throw 即 ROLLBACK）。
 * DDL 与 init.ts fresh-install DDL 逐字一致（双路径一致红线，v7/v8/v13-v16 注释同款要求）。
 */
export const v17 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    const existing = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_tools'"
    ).get() as { sql: string } | undefined
    if (existing && !existing.sql.includes('skip_confirm')) {
      db.exec('DROP TABLE mcp_tools')
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_id INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        skip_confirm INTEGER NOT NULL DEFAULT 0,
        tool_meta TEXT,
        updated_at TEXT,
        UNIQUE(config_id, tool_name)
      );
    `)
    db.pragma('user_version = 17')
  })
  step()
}

/**
 * v18：Phase 22（22-02）ai_config.exec_mode CHECK 放宽至三档（confirm/smart/auto，D-01）。
 *
 * 旧 DDL `CHECK(exec_mode IN ('confirm','auto'))` 使 'smart' 写入触发 SQLITE_CONSTRAINT_CHECK——
 * plan 原定「无数据迁移」，但存量库约束硬阻塞三档落库，执行期 Rule 3 deviation 补此迁移。
 * 存量值语义不变（confirm/auto 原值保留），仅放开 CHECK 收纳新档 'smart'。
 *
 * 幂等守卫：sqlite_master 查 ai_config.sql——已含 'smart' 特征则 no-op（v5/v6 同构，不靠 user_version）。
 * 重建走 v5 镜像模式：建新表 → 数据搬迁 → DROP → RENAME。DDL 与 init.ts fresh-install 逐字一致
 * （双路径一致红线，v7/v8/v13-v17 注释同款要求）。
 */
export const v18 = (db: Database.Database): void => {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_config'"
  ).get() as { sql: string } | undefined
  if (!existing || existing.sql.includes("'smart'")) {
    return // fresh-install（init.ts 已建三值 CHECK）或已迁移，no-op
  }
  const step = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS ai_config_new')
    db.exec(`
      CREATE TABLE ai_config_new (
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
      INSERT INTO ai_config_new
        SELECT id, provider_enc, api_key_enc, base_url_enc, model_name_enc,
          vision_base_url_enc, vision_api_key_enc, vision_model_enc, exec_mode, created_at
        FROM ai_config;
      DROP TABLE ai_config;
      ALTER TABLE ai_config_new RENAME TO ai_config;
    `)
    db.pragma('user_version = 18')
  })
  step()
}

/**
 * v19：Phase 22（22-03）ai_exec_logs.mode CHECK 放宽至三档（confirm/smart/auto）。
 *
 * 22-02 只放宽了 ai_config.exec_mode（v18），ai_exec_logs.mode 的 CHECK 仍为
 * ('confirm','auto')——smart 档审计写入（createLog mode='smart'）会触发约束失败。
 * 执行期 Rule 3 deviation 补此迁移（22-02 SUMMARY 跨 plan 留意项）。
 * 存量值语义不变，仅放开 CHECK 收纳新档 'smart'。
 *
 * 幂等守卫：sqlite_master 查 ai_exec_logs.sql——已含 'smart' 特征则 no-op（v18 同构）。
 * 重建走镜像模式，DDL 与 init.ts fresh-install 逐字一致（双路径一致红线）。
 */
export const v19 = (db: Database.Database): void => {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_exec_logs'"
  ).get() as { sql: string } | undefined
  if (!existing || existing.sql.includes("'smart'")) {
    return // fresh-install（init.ts 已建三值 CHECK）或已迁移，no-op
  }
  const step = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS ai_exec_logs_new')
    db.exec(`
      CREATE TABLE ai_exec_logs_new (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        device_name_enc TEXT,
        command TEXT NOT NULL,
        status TEXT CHECK(status IN ('approved','rejected','pending','executed','failed')),
        mode TEXT CHECK(mode IN ('confirm','smart','auto')),
        ai_reason TEXT,
        prompt_text TEXT,
        ai_response TEXT,
        prompt_text_enc TEXT,
        ai_response_enc TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO ai_exec_logs_new
        SELECT id, device_id, device_name_enc, command, status, mode, ai_reason,
          prompt_text, ai_response, prompt_text_enc, ai_response_enc, created_at
        FROM ai_exec_logs;
      DROP TABLE ai_exec_logs;
      ALTER TABLE ai_exec_logs_new RENAME TO ai_exec_logs;
    `)
    db.pragma('user_version = 19')
  })
  step()
}

/**
 * v20：Phase 22（22-05）补回 v19 误丢的 ai_exec_logs.prompt_text / ai_response 明文列。
 *
 * 22-03 的 v19 重建 ai_exec_logs 时新表 DDL 只含 prompt_text_enc / ai_response_enc，
 * 丢了明文列——SEC-06 运行时代码（aiExecLogger appendLogAiResponse / backfillAiExecLogEnc /
 * getLogs）在「明文列存在」假设下写 SQL，确认执行后的第二次 AI 调用记录路径报
 * no such column: prompt_text（22-05 人工验证发现）。
 *
 * 修复方案（已裁决）：补列，不改运行时代码——旧行明文/新行密文两态兼容设计恢复成立。
 * v19 DDL 已同步修正（只对未跑 v19 的库生效）；本迁移对已跑丢列版 v19 的存量库补列。
 *
 * 幂等守卫：hasColumn——列已存在 no-op（v2 同构，不靠 user_version）。
 */
export const v20 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_exec_logs', 'prompt_text')) {
      db.exec('ALTER TABLE ai_exec_logs ADD COLUMN prompt_text TEXT')
    }
    if (!hasColumn(db, 'ai_exec_logs', 'ai_response')) {
      db.exec('ALTER TABLE ai_exec_logs ADD COLUMN ai_response TEXT')
    }
    db.pragma('user_version = 20')
  })
  step()
}

/**
 * v21：Phase 22（22-05 checkpoint 追加）ai_config.mcp_max_rounds——MCP 连续调用轮次上限系统设置可调。
 *
 * 旧硬编码 MAX_MCP_TOOL_ROUNDS=5 改为读 ai_config.mcp_max_rounds（合法 1-20，
 * 非法一律 fail-safe 回退 5，见 ai.ts getMcpMaxRounds）。仅加列，无需重建表。
 *
 * 幂等守卫：hasColumn——列已存在 no-op（v2/v20 同构，不靠 user_version）。
 */
export const v21 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_config', 'mcp_max_rounds')) {
      db.exec('ALTER TABLE ai_config ADD COLUMN mcp_max_rounds INTEGER NOT NULL DEFAULT 5')
    }
    db.pragma('user_version = 21')
  })
  step()
}

/**
 * v22：Phase 25（25-01，ASSET-03）三段式迁移第一段——devices 加 name_hash TEXT 列。
 *
 * devices.name_enc 是 AES-256-GCM 密文，UNIQUE 不能直接建；name_hash 存归一化名
 * SHA-256（deviceName.ts 单一来源，25-02 service 写入维护 / 25-03 post-MK 回填）。
 * 本段只加列：nullable、无索引、无 UNIQUE（存量未回填，建索引必炸存量重名，T-25-01）。
 *
 * 幂等守卫 D-14 第一形式：hasColumn（与 v1/v3/v9/v10/v12/v20/v21 同构，纯 ALTER ADD COLUMN，
 * 不靠 user_version 判定）。执行体包 db.transaction（throw 即 ROLLBACK）。
 * 列定义与 init.ts fresh-install devices DDL 逐字一致（双路径一致红线，v7-v21 注释同款要求）。
 */
export const v22 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'devices', 'name_hash')) {
      db.exec('ALTER TABLE devices ADD COLUMN name_hash TEXT')
    }
    db.pragma('user_version = 22')
  })
  step()
}

/**
 * v23：Phase 25（25-01）三段式迁移第二段——版本占位（回填发生在 post-MK 钩子）。
 *
 * name_hash 存量回填需解密 name_enc，而迁移在 MK 注入前跑（migrateAndSecure 早于
 * setDeviceMasterKey，v10/v13 caveat 同款）——回填由 25-03 的 backfillNameHash
 * post-MK 钩子执行（幂等守卫 WHERE name_hash IS NULL，失败 warn 不阻塞启动）。
 * 本步骤仅推进 user_version=23 作为三段式版本锚点，无 DDL、无数据搬动。
 */
export const v23 = (db: Database.Database): void => {
  db.pragma('user_version = 23')
}

/**
 * v24：Phase 25（25-01）三段式迁移第三段——清零门控建 UNIQUE 索引（D-10 运行时可复用）。
 *
 * idx_devices_name_hash UNIQUE 索引是 DB 层唯一兜底（service 层校验之上的第二拦）。
 * 存量重名库直接建索引会 SQLITE_CONSTRAINT——步骤内先 GROUP BY name_hash HAVING
 * COUNT(*)>1 检测：有重名则跳过不 throw（清零门控，T-25-01 mitigate），
 * 待 25-03 重名清零后运行时复用本导出函数补建。
 *
 * 独立于 user_version 判定（签名纯 (db)，可被迁移注册与运行时清零路径双调用）。
 * CREATE UNIQUE INDEX IF NOT EXISTS 天然幂等（v14 索引先例）。DDL 与 init.ts
 * fresh-install DDL 逐字一致（双路径一致红线）。
 *
 * @returns true=已建索引；false=存量重名跳过（门控未过）
 */
export const v24 = (db: Database.Database): boolean => {
  const dup = db.prepare(
    'SELECT COUNT(*) AS c FROM (SELECT name_hash FROM devices WHERE name_hash IS NOT NULL GROUP BY name_hash HAVING COUNT(*) > 1)'
  ).get() as { c: number }
  if (dup.c > 0) {
    return false // 存量重名：不建索引不 throw（清零门控，25-03 运行时复用补建）
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_name_hash ON devices(name_hash)')
  return true
}

/**
 * v24 迁移注册包装：索引建立（或门控跳过）后推进 user_version=24。
 * 意外错误（非重名）throw 即中止启动，符合迁移红线。
 */
const v24MigrationStep = (db: Database.Database): void => {
  const step = db.transaction(() => {
    v24(db)
    db.pragma('user_version = 24')
  })
  step()
}

/**
 * v25：Phase 27（27-02，GUARD-05/D-07）—— ai_exec_logs 越权审计两列。
 *
 * guard_hits TEXT 存 GuardHit[] JSON（NULL=未命中；明文 JSON 不含凭证，A5，无需 _enc）；
 * guard_outcome TEXT 存 'user_confirmed' | 'user_cancelled'（NULL=未走用户确认路径）。
 * 不并入独立表（D-07），status 列枚举与 CHECK 约束零改动（v19 教训，Pitfall 6）。
 *
 * 幂等守卫 D-14 第一形式：hasColumn（与 v1/v2/v20/v21/v22 同构，纯 ALTER ADD COLUMN，
 * 不靠 user_version 判定）。init.ts fresh-install DDL 已含两列（双路径一致红线）。
 */
export const v25 = (db: Database.Database): void => {
  // WR-04：与 v1-v24 一致，步骤执行体包 db.transaction（throw 即 ROLLBACK，原子迁移红线）
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_exec_logs', 'guard_hits')) {
      db.exec('ALTER TABLE ai_exec_logs ADD COLUMN guard_hits TEXT')
    }
    if (!hasColumn(db, 'ai_exec_logs', 'guard_outcome')) {
      db.exec('ALTER TABLE ai_exec_logs ADD COLUMN guard_outcome TEXT')
    }
    db.pragma('user_version = 25')
  })
  step()
}

/**
 * v26：Phase 28（28-01，AGENT-04 前置）—— agent 循环硬顶三参数 + 聊天元数据列。
 *
 * ai_config 加 agent_max_rounds / agent_burnout_count / agent_cooldown_secs 三列
 * （均允许 NULL，NULL = 用代码级默认，fail-safe）；chat_history 加 meta_enc TEXT
 * （agent 来源清单/步骤持久化，方案 A——28-04 经 encField/decField 读写，本迁移只建列）。
 *
 * 幂等守卫：hasColumn（与 v1/v2/v20/v21/v22/v25 同构，纯 ALTER ADD COLUMN）。
 * init.ts fresh-install DDL 已同步含四列（双路径一致红线）。
 */
export const v26 = (db: Database.Database): void => {
  // 与 v1-v25 一致，步骤执行体包 db.transaction（throw 即 ROLLBACK，原子迁移红线）
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_config', 'agent_max_rounds')) {
      db.exec('ALTER TABLE ai_config ADD COLUMN agent_max_rounds INTEGER')
    }
    if (!hasColumn(db, 'ai_config', 'agent_burnout_count')) {
      db.exec('ALTER TABLE ai_config ADD COLUMN agent_burnout_count INTEGER')
    }
    if (!hasColumn(db, 'ai_config', 'agent_cooldown_secs')) {
      db.exec('ALTER TABLE ai_config ADD COLUMN agent_cooldown_secs INTEGER')
    }
    if (!hasColumn(db, 'chat_history', 'meta_enc')) {
      db.exec('ALTER TABLE chat_history ADD COLUMN meta_enc TEXT')
    }
    db.pragma('user_version = 26')
  })
  step()
}

/**
 * v27：Phase 29（29-02，PKG-02/PKG-05）—— mcp_packages 新表 + mcp_configs.package_id +
 * mcp_device_rel.env_json_enc（设备级 env 模型 D-15 的存储形态）。
 *
 * - mcp_packages：导入包登记表（导入登记制）。manifest_json/fingerprint/fingerprint_json
 *   存明文元数据（红线裁决：DB 只存明文元数据，非凭证；敏感值只在 env_json_enc 密文列）。
 *   name UNIQUE——D-05 同名即同包。runtime CHECK 双轨 node/python。last_test 列本迁移必建
 *   （29-03 testPackage 写入），dir_path/size_bytes 由 29-03 落库。
 * - mcp_configs.package_id：从包创建的配置可回溯包。
 * - mcp_device_rel.env_json_enc：设备级 env 覆盖（密文，只走 encField/decField）。
 *   存量共享 env 复制回填是加密写 → 必须在 MK 注入后执行，不能进迁移步骤（25-05 教训），
 *   归 mcpDeviceEnvMigration.backfillDeviceEnv post-MK 钩子（D-17）。
 *
 * 幂等守卫：CREATE TABLE IF NOT EXISTS 天然幂等（v15 先例）+ 两处 hasColumn（v1 同构），
 * 不靠 user_version 判定（文件头红线）。执行体包 db.transaction（throw 即 ROLLBACK）。
 * DDL 与 init.ts fresh-install DDL 逐字一致（双路径一致红线，v7/v8/v13-v16 注释同款要求）。
 */
export const v27 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_packages (
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
    if (!hasColumn(db, 'mcp_configs', 'package_id')) {
      db.exec('ALTER TABLE mcp_configs ADD COLUMN package_id INTEGER REFERENCES mcp_packages(id)')
    }
    if (!hasColumn(db, 'mcp_device_rel', 'env_json_enc')) {
      db.exec('ALTER TABLE mcp_device_rel ADD COLUMN env_json_enc TEXT')
    }
    db.pragma('user_version = 27')
  })
  step()
}

/**
 * v28：Phase 29（29-09 走查二）—— mcp_configs.type CHECK 放开收纳 'package' + 存量包配置转换。
 *
 * 根因：v27 落地「从包创建配置」时靠 DDL 硬约束外的暗号（type='stdio' + source='package' +
 * package_id）标识包配置，导致列表谎报「本地程序 (stdio)」、点【测试】走 stdio 旧通道
 * spawn 一个叫包名的命令 60s 超时。本迁移把 type 语义真实化：包配置 type='package'。
 *
 * - SQLite 不能 ALTER CHECK——表重建（v5/v18 镜像模式）：建新表（CHECK 含 'package'，
 *   列集与 init.ts fresh DDL 逐字一致，双路径红线）→ INSERT SELECT 全列拷贝（id 值保留）→
 *   DROP → RENAME → 存量行 UPDATE（source='package' AND package_id IS NOT NULL → type='package'）。
 * - mcp_device_rel 有指向 mcp_configs 的 FK CASCADE：DROP TABLE 隐式 DELETE 会连带级联子表。
 *   事务外 PRAGMA foreign_keys=OFF（事务内设置无效），重建后 foreign_key_check 断言再恢复 ON。
 *
 * 幂等守卫 D-14 第二形式：sqlite_master 查 mcp_configs.sql——已含 "'package'" 特征则 no-op 早返
 * （与 v5 查 'rdp'、v18 查 'smart' 同构，不靠 user_version 判定）。
 * 执行体包 db.transaction（throw 即 ROLLBACK）。
 */
export const v28 = (db: Database.Database): void => {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_configs'"
  ).get() as { sql: string } | undefined
  if (existing && existing.sql.includes("'package'")) {
    return // CHECK 已含 package，no-op（幂等重跑 D-14）
  }
  // FK 关闭必须在事务外（PRAGMA foreign_keys 在事务内是 no-op）
  db.pragma('foreign_keys = OFF')
  try {
    const step = db.transaction((): void => {
      db.exec('DROP TABLE IF EXISTS mcp_configs_new')
      db.exec(`
        CREATE TABLE mcp_configs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('stdio','http','package')),
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
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          package_id INTEGER REFERENCES mcp_packages(id)
        );
        INSERT INTO mcp_configs_new
          SELECT id, name, type, command_or_url, args_json, env_json_enc, credential_enc, source,
            enabled, last_test_at, last_test_status, last_test_tool_count, created_at, updated_at, package_id
          FROM mcp_configs;
        DROP TABLE mcp_configs;
        ALTER TABLE mcp_configs_new RENAME TO mcp_configs;
        UPDATE mcp_configs SET type = 'package' WHERE source = 'package' AND package_id IS NOT NULL;
      `)
      const fkErrors = db.pragma('foreign_key_check') as unknown[]
      if (fkErrors.length > 0) {
        throw new Error('mcp_configs 重建后外键完整性校验失败: ' + JSON.stringify(fkErrors))
      }
      db.pragma('user_version = 28')
    })
    step()
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

export const MIGRATIONS: MigrationStep[] = [
  { version: 1, name: 'chat_history.session_id', run: v1 },
  { version: 2, name: 'ai_exec_logs.prompt_text+ai_response', run: v2 },
  { version: 3, name: 'devices.status+last_checked', run: v3 },
  { version: 4, name: 'ai_config.vision_*', run: v4 },
  { version: 5, name: 'devices.connection_type CHECK rdp rebuild', run: v5 },
  { version: 6, name: 'ai_system_logs CHECK widen (acl/migration/backup + warning)', run: v6 },
  { version: 7, name: 'kb_chunks_au FTS UPDATE trigger add WHEN (skip non-FTS-field updates)', run: v7 },
  { version: 8, name: 'experiences + exp_device_rel create (Phase 7 experience data layer)', run: v8 },
  { version: 9, name: 'experiences.duplicate_of_exp_id (Phase 8 drafting UPDATE hit link)', run: v9 },
  { version: 10, name: 'experiences.severity (Phase 10 browse filter/sort)', run: v10 },
  { version: 11, name: 'ai_system_logs CHECK widen security (R2 decrypt-failure + exp relate-failure log)', run: v11 },
  { version: 12, name: 'ip_mac_bindings is_baseline (BUG-1 首次基线标志)', run: v12 },
  { version: 13, name: 'ai_exec_logs/ai_system_logs prompt_text+ai_response 加密列 + scheduler_config.retention_days (SEC-06)', run: v13 },
  { version: 14, name: 'arp_entries.collected_at index (TXN-03) + kb fts triggers image_desc constant NULL (Q10)', run: v14 },
  { version: 15, name: 'prompt_overrides + mcp_configs create (Phase 20 prompt registry / Phase 21 MCP placeholder)', run: v15 },
  { version: 16, name: 'mcp_configs_v16_rebuild', run: v16 },
  { version: 17, name: 'mcp_tools', run: v17 },
  { version: 18, name: 'ai_config.exec_mode CHECK widen (confirm/smart/auto)', run: v18 },
  { version: 19, name: 'ai_exec_logs.mode CHECK widen (confirm/smart/auto)', run: v19 },
  { version: 20, name: 'ai_exec_logs 补回 v19 误丢的 prompt_text/ai_response 明文列', run: v20 },
  { version: 21, name: 'ai_config.mcp_max_rounds（MCP 轮次上限系统设置可调）', run: v21 },
  { version: 22, name: 'devices.name_hash（ASSET-03 三段式第一段：加列无索引）', run: v22 },
  { version: 23, name: 'devices.name_hash 回填版本锚点（三段式第二段：post-MK 回填归 25-03）', run: v23 },
  { version: 24, name: 'idx_devices_name_hash UNIQUE 清零门控（三段式第三段，D-10 运行时可复用）', run: v24MigrationStep },
  { version: 25, name: 'ai_exec_logs.guard_hits+guard_outcome 越权审计列（GUARD-05/D-07）', run: v25 },
  { version: 26, name: 'agent loop limits + chat meta（ai_config 三列 + chat_history.meta_enc，AGENT-04）', run: v26 },
  { version: 27, name: 'mcp_packages + 设备级 env 列（PKG-02/PKG-05/D-15）', run: v27 },
  { version: 28, name: 'mcp_configs.type CHECK widen package + 存量包配置转换（29-09 走查二）', run: v28 },
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

  if (current >= MIGRATION_HEAD) {
    // PERF-04：迁移已最新跳过（可观测日志，二次启动可见）
    try {
      createSystemLog({ type: 'migration', status: 'success', errorMessage: `[startup] runMigrations 跳过：user_version=${current} 已达 HEAD=${MIGRATION_HEAD}，无待执行迁移` })
    } catch { console.log(`[startup] runMigrations 跳过：user_version=${current} 已达 HEAD=${MIGRATION_HEAD}（system_logs 未就绪回退 console）`) }
    return
  }

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
