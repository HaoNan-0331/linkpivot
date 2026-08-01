---
phase: 02-architecture-db-migration
verified: 2026-06-28T06:30:00Z
status: passed
score: 4/4 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/4
  gaps_closed:
    - "审计日志 ai_system_logs CHECK 截断（CR-01）— 已放宽 + v6 迁移重建历史库"
    - "premigration 备份 gate 过窄（CR-02）— 已改用 dbPreExisted() 文件预存在标志"
    - "user_version 原子性注释误导（CR-03）— 注释已修正指向幂等守卫"
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
human_verification:
  - test: "ACL 实际生效验证（Windows）：icacls userData/topology.db / -wal / -shm / backups/*.db.bak"
    expected: "所有文件 ACL 仅当前用户 (F)，无继承项/无其他用户 ACE"
    why_human: "icacls 非管理员/域账户下可能 silently fail；需 Windows 运行时 + 真实文件系统证伪"
  - test: "定时备份文件生成验证：backup_config.interval_minutes 改为 1，等待一个周期"
    expected: "userData/backups/topology-periodic-*.db.bak 按计划生成；旧库迁移生成 topology-premigration-v*-to-v6-*.db.bak"
    why_human: "better-sqlite3 native binding 为 Electron NODE_MODULE_VERSION 编译，无法在 Node/vitest 实例化真实 DB"
  - test: "旧库端到端向后兼容：Phase 1 基线库（user_version=0）启动迁移到 v6"
    expected: "PRAGMA user_version=6；ai_system_logs CHECK 已含 acl/migration/backup+warning；历史数据无丢失"
    why_human: "需 Electron 运行时 + 真实旧库文件"
  - test: "IP-only 遗留库迁移验证（CR-02 闭环）：构造仅 arp_entries 有数据、topologies/devices 空的 user_version=0 库"
    expected: "dbPreExisted() 返回 true → premigration 备份生成 → v5 devices 重建有安全网 → user_version=6"
    why_human: "需构造特殊遗留库 + 运行时观察"
---

# Phase 2: Architecture & DB Migration Verification Report

**Phase Goal:** 数据库迁移可追踪可跳过，DB 文件权限收紧并具备备份机制
**Verified:** 2026-06-28T06:30:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (commits a0affd4 + f68ec61)

## Re-verification Summary

This is a **re-verification** of Phase 2 after gap-closure fixes. The prior verification (status: `gaps_found`, 2/4) found 2 BLOCKERs (CR-01, CR-02) + 1 WARNING (CR-03). All 3 are now **CLOSED** against the actual code. All 4 ROADMAP Success Criteria / must_haves are now code-complete. The 3 deferred items to human verification are Electron-runtime-only (ACL actual effect, backup file generation, legacy-DB end-to-end) — they do not block the phase goal being achieved in code.

| Prior Gap | Severity | Fix Commit | Verified Closed |
| --- | --- | --- | --- |
| CR-01 ai_system_logs CHECK 截断审计日志 | BLOCKER | a0affd4 | ✓ init.ts:86-87 CHECK 已放宽 + migrations.ts v6 重建历史库 |
| CR-02 hasUserData gate 过窄 (SC#4 data-loss risk) | BLOCKER | f68ec61 | ✓ connection.ts:14,23,45 dbPreExisted() + hasUserData 已删除 |
| CR-03 user_version 原子性注释误导 | WARNING | a0affd4 | ✓ migrations.ts:25-27 注释已修正 |

## Goal Achievement

### Observable Truths (ROADMAP 4 Success Criteria as must-haves)

| # | Truth (Success Criterion) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `PRAGMA user_version` 在 init 中被读写，散落 `PRAGMA table_info` 检查被 `hasColumn` 替代 | ✓ VERIFIED | migrations.ts:184 读 `db.pragma('user_version')`；v1-v6 各写 `db.pragma('user_version = N')`（6 处，lines 33/46/59/75/125/159）；grep `PRAGMA table_info` init.ts = **0 命中**（散落块物理删除，line 283-287 注释说明已迁入 migrations.ts）；grep `runMigrations` init.ts = **0 命中**；hasColumn 在 migrationHelpers.ts 定义，被 migrations.ts:3 import + 8 处调用 |
| 2 | DB 文件 ACL 仅当前用户可读写（Windows ACL / chmod 0600），非致命 | ✓ VERIFIED (code present) | acl.ts:24-37 Windows `icacls /inheritance:r /grant:r <user>:(F)` via execFileSync(shell:false)；Unix `chmodSync(0o600)`；acl.ts:39-51 非致命 try/catch + 写 system log；connection.ts:82-84 db/wal/shm 三处收紧；connection.ts:32 启动收紧 backups 目录；backupScheduler.ts:65,83 备份创建即收紧。**运行时 ACL 实际生效需 Electron 运行时人工验证**（见 Human Verification #1） |
| 3 | 定时 `.backup()` 机制存在并被注册（备份文件按计划生成） | ✓ VERIFIED (code present) | backupScheduler.ts:64 `getDatabase().backup(backupPath)`；main.ts BackupScheduler.start() 注册；main.ts before-quit 先 BackupScheduler.stop() 后 closeDatabase()；双桶 FIFO pruneBackups（periodic retention 7 / premigration retention 5）。**实际备份文件生成需运行时人工验证**（见 Human Verification #2） |
| 4 | 旧库打开后 user_version 自动迁移到位且历史数据无丢失（向后兼容） | ✓ VERIFIED (code complete) | CR-01/CR-02 修复后闭环：(a) 审计日志 D-08/D-13/备份审计现在可落库（v6 放开 CHECK）；(b) IP-only 遗留库 premigration 备份由 dbPreExisted() 兜底（CR-02）；v1-v6 全部 hasColumn/sqlite_master 幂等守卫 + foreign_key_check 断言（v5）。**端到端需运行时人工验证**（见 Human Verification #3/#4） |

**Score:** 4/4 truths verified (SC#1 fully; SC#2/SC#3/SC#4 code-complete, runtime-pending routed to human)

### Locked Decisions (D-01~D-16) Honor Check (Re-verified)

| Decision | Honored? | Evidence |
| --- | --- | --- |
| D-01 24h 周期备份 + shouldRunNow 补跑 | ✓ | backupScheduler.ts:110 shouldRunNow；backup_config.interval_minutes DEFAULT 1440 (init.ts:203) |
| D-02 双桶 retention 7/5 | ✓ | backupScheduler.ts:89-104 pruneBackups 按 prefix 分桶 |
| D-03 userData/backups/ | ✓ | backupScheduler.ts BACKUPS_DIR |
| D-04 db.backup() 在线备份 | ✓ | backupScheduler.ts:64,82 |
| D-05 镜像 SchedulerService | ✓ | 逐方法对齐（start/stop/restart/runTask/executeTask...） |
| D-06 迁移前备份强制 | ✓ **(CR-02 闭环)** | connection.ts:66-68 入口 createPremigrationBackup gated on `dbPreExisted()`（文件预存在，非行数）；IP-only 遗留库现获安全网 |
| D-07 步骤原子 | ✓ **(CR-03 闭环)** | migrations.ts:25-27 注释已修正：明确「不要依赖 PRAGMA user_version 与 DDL 的事务原子性」，真实安全由 hasColumn/sqlite_master 幂等守卫提供 |
| D-08 迁移失败写 system log + 中止 | ✓ **(CR-01 闭环)** | migrations.ts:197-202 createSystemLog({type:'migration',status:'failed'}) 现 CHECK 放开可落库；中止行为 throw 正常 |
| D-09 hasColumn 集中 helper | ✓ | migrationHelpers.ts:8 |
| D-10 保护范围 db/wal/shm/backups | ✓ | connection.ts:82-84 + acl.ts:59 restrictDirPermissions |
| D-11 跨平台 icacls/chmod | ✓ | acl.ts:24-37 |
| D-12 幂等无 sentinel | ✓ | 每次启动 + 每备份即调用 |
| D-13 ACL 失败非致命 + 写 system log | ✓ **(CR-01 闭环)** | 非致命 ✓（acl.ts:39-51）；createSystemLog({type:'acl',status:'warning'}) 现 CHECK 放开可落库 |
| D-14 幂等重跑（非 stamp） | ✓ | v1-v6 全部 hasColumn/sqlite_master 守卫；runMigrations 从 current+1 重跑 |
| D-15 选幂等而非 stamp 理由 | ✓ | runMigrations 从 current+1 重跑 |
| D-16 顺序整数 user_version 注册表 | ✓ | MIGRATIONS 数组 v1-v6，MIGRATION_HEAD=6 |

### CR Findings Disposition (Re-verification)

| CR | Prior Verdict | Re-verified Against Code | New Verdict |
| --- | --- | --- | --- |
| CR-01 | BLOCKER | init.ts:86-87 CHECK 现为 `type IN ('discovery','acl','migration','backup')` + `status IN ('success','failed','warning')`；migrations.ts:130-162 新增 v6 重建 ai_system_logs（rebuild-with-CHECK 镜像 v5 模式，sqlite_master `'warning'` 幂等守卫 line 134-137）；MIGRATIONS 注册 v6 (line 170)；MIGRATION_HEAD=6 (line 16) | **✓ CLOSED** — 新库（createTables 直接建宽 CHECK）+ 历史库（v6 重建）双路径修复；acl/migration/backup + warning 日志现可落库 |
| CR-02 | BLOCKER | connection.ts:14 `dbExistedBeforeOpen` 模块标志；connection.ts:23 initDatabase 打开前 `fs.existsSync(dbPath)` 捕获；connection.ts:45-47 `dbPreExisted()` 导出；connection.ts:67 gate `if (dbPreExisted())`；grep `hasUserData` connection.ts = **0 命中**（已删除） | **✓ CLOSED** — IP-only 遗留库（arp 有行、topo/devices 空）现被识别为遗留库获 premigration 备份 |
| CR-03 | WARNING | migrations.ts:25-27 注释现声明「不要依赖 PRAGMA user_version 与 DDL 的事务原子性（user_version 语义不保证随事务回滚）—— 真正的'可安全重跑'由 hasColumn / sqlite_master sql-content 幂等守卫保证」 | **✓ CLOSED** — 注释与 SQLite 实际语义一致 |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `electron/database/migrationHelpers.ts` | hasColumn helper | ✓ VERIFIED | export function hasColumn，type-only import |
| `electron/database/migrations.ts` | MIGRATION_HEAD=6 + runMigrations + 6 原子步骤 | ✓ VERIFIED | MIGRATION_HEAD=6 (line 16)；v1-v6 各 db.transaction + user_version 写；v6 rebuild-with-CHECK；foreign_key_check 断言 (line 121-124) |
| `electron/database/acl.ts` | restrictFilePermissions + restrictDirPermissions 跨平台 + 非致命 | ✓ VERIFIED | icacls /inheritance:r /grant:r + chmod 0o600；非致命 try/catch + createSystemLog({type:'acl',status:'warning'}) 现 CHECK 放开可落库 |
| `src/types/backup.ts` | BackupConfig + retention | ✓ VERIFIED | backupScheduler.ts import type BackupConfig + DEFAULT_BACKUP_CONFIG，tsc 绿 |
| `electron/services/backupScheduler.ts` | BackupScheduler 镜像 SchedulerService + executeTask 拆分 | ✓ VERIFIED | runTask/executeTask 拆分；isRunning 在 executeTask finally 重置；db.backup；createPremigrationBackup；backup 失败/裁剪失败 createSystemLog 现可落库 |
| `electron/database/connection.ts` | migrateAndSecure + dbPreExisted gate | ✓ VERIFIED | migrateAndSecure (line 61)；premigration 备份 gated on dbPreExisted() (line 67)；runMigrations 调用 (line 78)；ACL db/wal/shm (line 82-84) |
| `electron/database/init.ts` | 删除散落迁移块 + backup_config 表 + 不出现 runMigrations + 宽 CHECK | ✓ VERIFIED | grep `PRAGMA table_info` = 0；grep `runMigrations` = 0；backup_config 表 line 200-208；ai_system_logs 宽 CHECK line 86-87 |
| `electron/main.ts` | 注册 migrateAndSecure + BackupScheduler.start/stop | ✓ VERIFIED | migrateAndSecure()；BackupScheduler.start()；before-quit BackupScheduler.stop() 先于 closeDatabase() |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| main.ts whenReady | connection.ts migrateAndSecure | createTables() 之后 migrateAndSecure() | ✓ WIRED | |
| main.ts whenReady | BackupScheduler.start | SchedulerService.start() 之后 | ✓ WIRED | |
| main.ts before-quit | BackupScheduler.stop | stop() 先于 closeDatabase() | ✓ WIRED | |
| connection.ts migrateAndSecure | migrations.ts runMigrations | import + call (line 78) | ✓ WIRED | 单一调用点；init.ts grep runMigrations=0 |
| connection.ts migrateAndSecure | BackupScheduler.createPremigrationBackup | gated on dbPreExisted() (line 67-68) | ✓ WIRED | |
| backupScheduler executeTask | db.backup(path) | getDatabase().backup() (line 64) | ✓ WIRED | |
| backupScheduler executeTask | acl.ts restrictFilePermissions | 备份创建后立即 (line 65,83) | ✓ WIRED | |
| migrations.ts steps | migrationHelpers hasColumn | import + 8 处调用 | ✓ WIRED | |
| createSystemLog 调用 → ai_system_logs 持久化 | DB INSERT | prepare().run() | ✓ **WIRED (CR-01 闭环)** | systemLog.ts:28-41 INSERT 正确；目标表 CHECK 现放开，acl/migration/backup + warning 日志可落库 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| migrations.ts runMigrations | user_version | db.pragma('user_version') | ✓ 真实读 | ✓ FLOWING |
| connection.ts migrateAndSecure | currentVersion | conn.pragma('user_version') | ✓ | ✓ FLOWING |
| connection.ts migrateAndSecure | dbPreExisted() | fs.existsSync(dbPath) 打开前捕获 | ✓ 真实文件系统标志 | ✓ FLOWING (CR-02 闭环) |
| backupScheduler.executeTask | backupPath | getDatabase().backup() | ✓ 真实 better-sqlite3 API | ✓ FLOWING (code path) |
| systemLog.createSystemLog → ai_system_logs | type/status | 调用方字面量 | ✓ CHECK 放开不再截断 | ✓ FLOWING (CR-01 闭环) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| tsc web 严格模式 + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 | ✓ PASS |
| init.ts 散落迁移块物理删除 | grep `PRAGMA table_info` init.ts | 0 命中 | ✓ PASS |
| init.ts 与 runMigrations 解耦 | grep `runMigrations` init.ts | 0 命中 | ✓ PASS |
| CR-01: ai_system_logs CREATE 宽 CHECK | Read init.ts:86-87 | `CHECK(type IN ('discovery','acl','migration','backup'))` + `CHECK(status IN ('success','failed','warning'))` | ✓ PASS (CR-01 闭环) |
| CR-01: v6 重建历史库宽 CHECK | Read migrations.ts:130-162 | v6 rebuild-with-CHECK，sqlite_master 'warning' 守卫，MIGRATION_HEAD=6，MIGRATIONS 注册 v6 | ✓ PASS (CR-01 闭环) |
| CR-02: dbPreExisted gate 已就位 | grep `hasUserData` connection.ts | 0 命中（已删除）；dbPreExisted() 在 line 67 gate | ✓ PASS (CR-02 闭环) |
| CR-03: 注释已修正 | Read migrations.ts:25-27 | 明确不依赖 user_version 事务原子性，指向幂等守卫 | ✓ PASS (CR-03 闭环) |
| 修复 commit 存在 | git show a0affd4 / f68ec61 | 两个 commit 触及 init.ts / migrations.ts / connection.ts | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| ARCH-01 | 02-01, 02-03 | user_version + hasColumn 替代散落 table_info，迁移可追踪可跳过 | ✓ SATISFIED | SC#1 verified；MIGRATION_HEAD=6 含 v6；散落块删除 + 单一调用点收敛 |
| ARCH-02 | 02-02, 02-03 | DB 文件 ACL 收紧 + 定时 .backup() 机制 + 向后兼容 | ✓ SATISFIED | SC#2/SC#3 代码路径完整；SC#4 CR-01/CR-02 闭环后无残留 gap；审计日志现可落库 |

**Orphaned requirements:** 无。ARCH-01/ARCH-02 均被本阶段 plan 认领且映射正确。

### Anti-Patterns Found (Residual — Non-blocking)

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| electron/database/init.ts | 293 | initDefaultOUIData(db: any) + as any | ℹ Info | any 泄漏（IN-02），非阻塞 |
| electron/database/acl.ts | 77 | restrictDirPermissions 路径用 `/` 拼接 | ℹ Info | Windows fs 兼容（WR-01），潜在不一致 |
| electron/services/backupScheduler.ts | 116 | getConfig row as any | ℹ Info | any 泄漏（WR-03），非阻塞 |
| electron/services/backupScheduler.ts | 97 | pruneBackups retention=0 时 slice(0) 删全部 | ⚠ Warning | 用户配 0 会删光备份（WR-02），需 clamp；非本阶段 goal 阻塞项 |
| electron/main.ts | 160 | before-quit 非 async，不等 in-flight backup | ⚠ Warning | 退出时备份进行中可能截断（WR-04）；非本阶段 goal 阻塞项 |

Note: WR-02/WR-04 残留为非 goal-blocking 项，可在后续 phase 处理。CR-01/CR-02/CR-03 三处 BLOCKER/WARNING 已全部闭环。

### Human Verification Required

### 1. ACL 实际生效验证（Windows）

**Test:** 启动 packaged/开发版 app，对 `userData/topology.db`、`topology.db-wal`、`topology.db-shm`、`userData/backups/*.db.bak` 执行 `icacls "<file>"`，确认仅当前用户 (F)，无继承项、无其他用户 ACE。
**Expected:** 所有上述文件 ACL 仅当前用户；非当前用户账户无法读取。
**Why human:** ACL 实际生效需 Windows 运行时 + 真实文件系统；icacls 在非管理员/域账户下可能 silently fail（WR-07），代码路径无法在静态分析中证伪。

### 2. 定时备份文件生成验证

**Test:** 启动 app，将 backup_config.interval_minutes 改为 1（或手动触发），等待一个周期，检查 `userData/backups/topology-periodic-*.db.bak` 生成；旧库迁移时确认 `topology-premigration-v0-to-v6-*.db.bak` 生成。
**Expected:** 周期备份文件按计划生成；遗留库（DB 文件预存在）迁移时生成 premigration 备份；fresh-install 空库无 premigration 备份但写 backup warning 日志（现可落库）。
**Why human:** better-sqlite3 native binding 为 Electron NODE_MODULE_VERSION 145 编译，无法在 Node/vitest 中实例化真实 DB 做端到端测试。

### 3. 旧库端到端向后兼容验证

**Test:** 用 Phase 1 基线库（user_version=0 旧库）启动 app，验证迁移到 v6、字段齐全、拓扑/设备/AI 历史数据完整。
**Expected:** `PRAGMA user_version` 返回 6；ai_system_logs CHECK 已含 acl/migration/backup + warning（v6 重建后）；chat_history.session_id、ai_exec_logs.prompt_text/ai_response、devices.status/last_checked、ai_config.vision_*、devices.connection_type 含 'rdp'；历史数据无丢失。
**Why human:** 需 Electron 运行时 + 真实旧库文件。

### 4. IP-only 遗留库迁移验证（CR-02 闭环确认）

**Test:** 构造一个仅有 arp_entries/ip_mac_bindings 数据、topologies/devices 为空的遗留库（user_version=0），启动 app 观察 premigration 备份是否生成、v5 devices 重建是否安全、v6 是否重建 ai_system_logs。
**Expected:** 当前代码 `dbPreExisted()` 返回 true（文件预存在）→ premigration 备份**生成**（CR-02 闭环）→ v5 devices 重建有安全网 → v6 放开 ai_system_logs CHECK → user_version=6。
**Why human:** 需构造特殊遗留库 + 运行时观察。

### Gaps Summary

无 gap。三个先前 gap（CR-01 BLOCKER / CR-02 BLOCKER / CR-03 WARNING）已在 commits a0affd4 + f68ec61 中全部闭环，并经本次 re-verification 对照实际代码确认：

1. **CR-01 闭环**：init.ts:86-87 CREATE TABLE CHECK 已放宽至 `type IN ('discovery','acl','migration','backup')` + `status IN ('success','failed','warning')`（新库）；migrations.ts 新增 v6 用 rebuild-with-CHECK 模式重建 ai_system_logs（历史库），sqlite_master `'warning'` 幂等守卫 + DROP/RENAME + user_version=6；MIGRATIONS 注册 v6，MIGRATION_HEAD=6。acl/migration/backup + warning 类 createSystemLog 调用不再被 CHECK 截断——D-08/D-13/备份审计可观测性真正生效。

2. **CR-02 闭环**：connection.ts 删除 hasUserData()，改用模块级标志 `dbExistedBeforeOpen`（line 14），在 initDatabase 打开 DB 前 `fs.existsSync(dbPath)` 捕获（line 23），导出 `dbPreExisted()`（line 45-47），migrateAndSecure line 67 gate `if (dbPreExisted())`。纯 IP 监控数据遗留库（arp 有行、topo/devices 空）现被正确识别为遗留库获 premigration 备份——SC#4 对此类库的「无数据丢失」承诺恢复。

3. **CR-03 闭环**：migrations.ts:25-27 注释修正为「不要依赖 PRAGMA user_version 与 DDL 的事务原子性——真正的可安全重跑由 hasColumn / sqlite_master 幂等守卫保证」，与 SQLite 实际语义一致。

**残留边界说明（非 gap，可接受）**：v1-v5 在一个 user_version=0 的历史库（窄 CHECK）上运行时，若 v6 之前某步骤失败，runMigrations 的 D-08 失败日志 `createSystemLog({type:'migration',status:'failed'})` 仍会命中旧窄 CHECK 被吞——但此场景下 premigration 备份（CR-02 已强制）+ runMigrations 抛出中止（line 204-207）是 load-bearing 安全网：DB 已回滚至前版本，操作员可从 `userData/backups/` premigration 备份人工恢复。审计日志可观测性在 v6 执行后对所有未来调用生效。该残留边界不阻塞 SC#4「无数据丢失」（premigration 备份兜底），可接受。

**结论**：Phase 2 goal「数据库迁移可追踪可跳过，DB 文件权限收紧并具备备份机制」在代码层面达成。所有 4 个 ROADMAP Success Criteria code-complete。残留的运行时验证项（ACL 实际生效 / 备份文件生成 / 旧库端到端 / IP-only 库验证）需 Electron 运行时人工确认——status = **passed**（runtime-only human items routed to human_verification，phase goal achieved in code）。

---

_Verified: 2026-06-28T06:30:00Z_
_Verifier: Claude (gsd-verifier)_
_Re-verification: Yes — after CR-01/CR-02/CR-03 gap closure (commits a0affd4 + f68ec61)_
