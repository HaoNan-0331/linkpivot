---
phase: 02-architecture-db-migration
verified: 2026-06-28T05:10:00Z
status: gaps_found
score: 2/4 must-haves verified
overrides_applied: 0
gaps:
  - truth: "迁移失败/ACL 失败/备份失败的审计日志实际可被持久化（D-08/D-13/备份审计）"
    status: failed
    reason: >
      ai_system_logs 表的 CHECK 约束过窄：init.ts:86 `type TEXT CHECK(type IN ('discovery'))`、
      init.ts:87 `status TEXT CHECK(status IN ('success','failed'))`。本阶段所有非 discovery 的
      createSystemLog 调用（type='acl'/'migration'/'backup'，status='warning'/'failed'）全部违反约束，
      抛 SQLITE_CONSTRAINT_CHECK 后被各调用点的 try/catch 静默吞掉。D-08 迁移失败审计、
      D-13 ACL 失败审计、备份失败审计在代码中实际从未落库——锁定决策承诺的可观测性不存在。
    artifacts:
      - path: "electron/database/init.ts"
        issue: "ai_system_logs CHECK(type IN ('discovery')) / CHECK(status IN ('success','failed')) 未放宽，未新增 v6 迁移修复历史库的窄 CHECK"
      - path: "electron/database/migrations.ts"
        issue: "createSystemLog({type:'migration', status:'failed'}) 违反 type CHECK"
      - path: "electron/database/acl.ts"
        issue: "createSystemLog({type:'acl', status:'warning'}) 同时违反 type+status CHECK（2 处）"
      - path: "electron/database/connection.ts"
        issue: "createSystemLog({type:'backup', status:'warning'}) 同时违反 type+status CHECK"
      - path: "electron/services/backupScheduler.ts"
        issue: "createSystemLog({type:'backup', status:'failed'/'warning'}) 违反 type CHECK（2 处）"
    missing:
      - "放宽 ai_system_logs 的 CHECK 至 type IN ('discovery','acl','migration','backup','scheduler') + status IN ('success','failed','warning')"
      - "作为新迁移步骤 v6（rebuild-with-CHECK 模式，沿用 v5 模式）修正遗留库已存在的窄 CHECK（不能只改 createTables，遗留库表已建不会重建）"
      - "同步递增 MIGRATION_HEAD 至 6"
  - truth: "旧库（含 IP 监控数据但 topologies/devices 为空）迁移前有 premigration 备份安全网（SC#4 无数据丢失）"
    status: failed
    reason: >
      connection.ts:76 hasUserData() 仅检查 topologies/devices 行数 > 0；任一异常被 catch 后保守返回 false。
      一个只含 IP 监控数据（arp_entries/ip_mac_bindings/network_segments 等）而 topologies/devices
      为空的遗留库会被判为 'fresh-install 空库' 跳过 premigration 备份，随后 runMigrations 执行 v5
      devices 表 DROP/CREATE/INSERT/RENAME 重建（破坏性）时无任何安全网——与 SC#4「旧库无数据丢失」
      及 D-06「迁移前备份强制」直接冲突。
    artifacts:
      - path: "electron/database/connection.ts"
        issue: "hasUserData() gate 仅看 topologies/devices 行数，IP-only 遗留库被误判为空库跳过 premigration 备份"
    missing:
      - "将 premigration 备份 gate 改为基于 currentVersion>0 或文件已存在标志（initDatabase 前拓扑 topology.db 是否已存在于磁盘），而非依赖核心业务表行数"
      - "或 gate on 任意应用表有行（sqlite_master 应用表 count>0），并移除异常时保守返回 false 的行为（异常应触发备份而非跳过）"
deferred: []
---

# Phase 2: Architecture & DB Migration Verification Report

**Phase Goal:** 数据库迁移可追踪可跳过，DB 文件权限收紧并具备备份机制
**Verified:** 2026-06-28T05:10:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP 4 Success Criteria as must-haves)

| # | Truth (Success Criterion) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `PRAGMA user_version` 在 init 中被读写，散落 `PRAGMA table_info` 检查被 `hasColumn` 替代 | ✓ VERIFIED | migrations.ts:146-149 读 `db.pragma('user_version')`；v1-v5 各写 `db.pragma('user_version = N')`（5 处，lines 32/45/58/74/124）；init.ts grep `PRAGMA table_info` = 0（散落块已物理删除，line 283-287 注释说明已迁入 migrations.ts）；hasColumn 在 migrationHelpers.ts:8 定义，被 migrations.ts:3 import + 8 处调用 |
| 2 | DB 文件 ACL 仅当前用户可读写（Windows ACL / chmod 0600） | ✓ VERIFIED (code present) | acl.ts:24-34 Windows `icacls /inheritance:r /grant:r <user>:(F)` via execFileSync(shell:false)；acl.ts:37 Unix `chmodSync(0o600)`；connection.ts:67-69 对 db/wal/shm 三处收紧；connection.ts:26 启动收紧 backups 目录；backupScheduler.ts:65,83 备份创建即收紧。代码路径完整。**运行时 ACL 实际生效需 Electron 运行时人工验证**（见 Human Verification） |
| 3 | 定时 `.backup()` 机制存在并被注册（备份文件按计划生成） | ✓ VERIFIED (code present) | backupScheduler.ts:64 `getDatabase().backup(backupPath)`；main.ts:92 `BackupScheduler.start()` 注册；main.ts:160 `BackupScheduler.stop()` before-quit 先于 closeDatabase；双桶 FIFO pruneBackups（periodic retention 7 / premigration retention 5）。代码路径完整。**实际备份文件生成需运行时人工验证**（见 Human Verification） |
| 4 | 旧库打开后 user_version 自动迁移到位且历史数据无丢失（向后兼容） | ✗ FAILED | 见 Gaps。两处实质性失败：(a) 审计日志因 CHECK 约束无法落库使 D-08 失败可观测性落空；(b) IP-only 遗留库 hasUserData 误判跳过 premigration 备份，v5 重建 devices 无安全网——SC#4「无数据丢失」对这类库无保障 |

**Score:** 2/4 truths verified (SC#1 fully verified; SC#2/SC#3 code-complete but runtime-pending; SC#4 failed)

### Locked Decisions (D-01~D-16) Honor Check

| Decision | Honored? | Evidence |
| --- | --- | --- |
| D-01 24h 周期备份 + shouldRunNow 补跑 | ✓ | backupScheduler.ts:110 shouldRunNow；DEFAULT_BACKUP_CONFIG.intervalMinutes=1440 (backup.ts) |
| D-02 双桶 retention 7/5 | ✓ | backupScheduler.ts:89-104 pruneBackups 按 prefix 分桶 |
| D-03 userData/backups/ | ✓ | backupScheduler.ts:10 BACKUPS_DIR |
| D-04 db.backup() 在线备份 | ✓ | backupScheduler.ts:64,82 |
| D-05 镜像 SchedulerService | ✓ | 逐方法对齐（start/stop/restart/runTask/executeTask...） |
| D-06 迁移前备份强制 | ✗ 部分 | 入口存在 (connection.ts:51-53 createPremigrationBackup)，但 hasUserData gate 过窄使 IP-only 遗留库被跳过——强制安全网对这类库失效 |
| D-07 步骤原子（DDL+user_version 同事务） | ⚠ 误导 | migrations.ts:24 注释声称「DDL 与 user_version 推进在同一事务内提交（D-07 原子）」。**SQLite 语义上 `PRAGMA user_version = N` 不参与事务**（CR-03），不会被 transaction rollback。实际安全由 hasColumn/sqlite_master 幂等守卫提供，非事务原子。代码可工作（因幂等守卫），但注释/锁定决策文本与 SQLite 实际语义不符——属文档/意图 gap |
| D-08 迁移失败写 system log + 中止 | ✗ | migrations.ts:161 createSystemLog({type:'migration',status:'failed'}) 被 ai_system_logs CHECK 拒绝，try/catch 吞掉——日志从未落库。中止行为本身（throw）正常 |
| D-09 hasColumn 集中 helper | ✓ | migrationHelpers.ts:8 |
| D-10 保护范围 db/wal/shm/backups | ✓ | connection.ts:67-69 + acl.ts:59 restrictDirPermissions |
| D-11 跨平台 icacls/chmod | ✓ | acl.ts:24-37 |
| D-12 幂等无 sentinel | ✓ | 每次启动 + 每备份即调用 |
| D-13 ACL 失败非致命 + 写 system log | ✗ 部分 | 非致命 ✓（acl.ts:39-51 不抛）；但 createSystemLog({type:'acl',status:'warning'}) 被 CHECK 拒绝吞掉——警告从未落库，可观测性落空 |
| D-14 幂等重跑（非 stamp） | ✓ | v1-v5 全部 hasColumn/sqlite_master 守卫 |
| D-15 选幂等而非 stamp 理由 | ✓ | runMigrations 从 current+1 重跑 |
| D-16 顺序整数 user_version 注册表 | ✓ | MIGRATIONS 数组 v1-v5 |

### Code Review (02-REVIEW.md) CR Findings Disposition

| CR | Review Claim | Verified Against Code | Verifier Verdict |
| --- | --- | --- | --- |
| CR-01 | ai_system_logs CHECK 过窄，本阶段所有 acl/migration/backup 日志被吞 | init.ts:86-87 CHECK(type IN ('discovery')) + CHECK(status IN ('success','failed')) 确认；7 处 createSystemLog 调用全部违反（acl.ts:44,67 / migrations.ts:162 / connection.ts:57 / backupScheduler.ts:51,102 + fresh-install 备份跳过日志） | **BLOCKER — 真实 gap。** D-08/D-13 审计承诺在代码中从未生效。createTables 对遗留库是 CREATE IF NOT EXISTS（表已存在不会重建），所以即使改 createTables 也不修复历史库——必须新增 v6 迁移用 rebuild-with-CHECK 重建 ai_system_logs |
| CR-02 | hasUserData 仅看 topologies/devices，IP-only 遗留库跳过 premigration 备份 | connection.ts:76-89 hasUserData() 仅 topoCount/devCount > 0；异常 catch 返回 false | **BLOCKER — 真实 gap。** 威胁 SC#4 对 IP-only 遗留库的「无数据丢失」承诺。v5 devices DROP/RENAME 重建在无 premigration 备份时无回滚安全网 |
| CR-03 | PRAGMA user_version 非事务性，D-07 原子性注释误导 | migrations.ts:24 注释「DDL 与 user_version 推进在同一事务内提交（D-07 原子）」与 SQLite 语义不符 | **WARNING — 文档/意图 gap。** 实际安全由幂等守卫保证（v1-v5 可重跑，v5 sqlite_master 守卫早退），运行时不会损坏数据。但注释会误导未来贡献者添加弱守卫迁移。需修正注释，非功能 gap |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `electron/database/migrationHelpers.ts` | hasColumn helper | ✓ VERIFIED | line 8 export function hasColumn，type-only import，无 getDatabase 调用 |
| `electron/database/migrations.ts` | MIGRATION_HEAD=5 + runMigrations + 5 原子步骤 | ✓ VERIFIED | MIGRATION_HEAD=5 (line 16)；runMigrations (line 146)；v1-v5 各 db.transaction + user_version 写；foreign_key_check 断言 (line 120) |
| `electron/database/acl.ts` | restrictFilePermissions + restrictDirPermissions 跨平台 | ✓ VERIFIED | icacls /inheritance:r /grant:r + chmod 0o600；非致命 try/catch；文件不存在静默跳过 |
| `src/types/backup.ts` | BackupConfig + retention | ✓ VERIFIED | （未单独 Read，但 backupScheduler.ts:7,8 import type BackupConfig + DEFAULT_BACKUP_CONFIG 且 tsc 绿，契约存在） |
| `electron/services/backupScheduler.ts` | BackupScheduler 镜像 SchedulerService + executeTask 拆分 | ✓ VERIFIED | runTask/executeTask 拆分；isRunning 在 executeTask finally 重置 (line 68-70)；db.backup (line 64)；createPremigrationBackup (line 78) |
| `electron/database/connection.ts` | migrateAndSecure | ✓ VERIFIED (存在但 hasUserData gate 有缺陷) | migrateAndSecure (line 46)；premigration 备份 gated (line 51-60)；runMigrations 调用 (line 63)；ACL db/wal/shm (line 67-69) |
| `electron/database/init.ts` | 删除散落迁移块 + backup_config 表 + 不出现 runMigrations | ✓ VERIFIED | grep `PRAGMA table_info` init.ts = 0；grep `runMigrations` init.ts = 0；backup_config 表 line 200-208；initDefaultOUIData(getDatabase()) line 290 |
| `electron/main.ts` | 注册 migrateAndSecure + BackupScheduler.start/stop | ✓ VERIFIED | line 81 migrateAndSecure()；line 92 BackupScheduler.start()；line 160 BackupScheduler.stop(); closeDatabase() |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| main.ts whenReady | connection.ts migrateAndSecure | createTables() 之后 migrateAndSecure() | ✓ WIRED | main.ts:80-81 |
| main.ts whenReady | BackupScheduler.start | SchedulerService.start() 之后 | ✓ WIRED | main.ts:91-92 |
| main.ts before-quit | BackupScheduler.stop | stop() 先于 closeDatabase() | ✓ WIRED | main.ts:160 |
| connection.ts migrateAndSecure | migrations.ts runMigrations | import + call | ✓ WIRED | connection.ts:4 import, line 63 call（单一调用点；init.ts grep runMigrations=0） |
| connection.ts migrateAndSecure | BackupScheduler.createPremigrationBackup | createTables 之后 runMigrations 之前 | ✓ WIRED | connection.ts:53 |
| backupScheduler executeTask | db.backup(path) | getDatabase().backup(backupPath) | ✓ WIRED | backupScheduler.ts:64 |
| backupScheduler executeTask | acl.ts restrictFilePermissions | 备份创建后立即调用 | ✓ WIRED | backupScheduler.ts:65,83 |
| migrations.ts steps | migrationHelpers hasColumn | import | ✓ WIRED | migrations.ts:3 import，8 处调用 |
| **createSystemLog 调用 → ai_system_logs 持久化** | DB INSERT | prepare().run() | ✗ **NOT_WIRED (功能层面)** | systemLog.ts:28-41 INSERT 本身正确，但目标表 CHECK 约束拒绝所有本阶段产生的 type/status 值——数据流被 SQLite CHECK 截断，被各调用点 try/catch 吞掉。物理 wired 但语义断路 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| migrations.ts runMigrations | user_version | db.pragma('user_version') | ✓ 真实读 | ✓ FLOWING |
| connection.ts migrateAndSecure | currentVersion | conn.pragma('user_version') | ✓ | ✓ FLOWING |
| backupScheduler.executeTask | backupPath | getDatabase().backup() | ✓ 真实 better-sqlite3 API（运行时待验） | ✓ FLOWING (code path) |
| systemLog.createSystemLog → ai_system_logs | type/status | 调用方字面量 | ✗ 被 CHECK 截断 | ✗ BROKEN — acl/migration/backup 类日志无法落库 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| tsc web 严格模式 + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 | ✓ PASS |
| init.ts 散落迁移块物理删除 | grep `PRAGMA table_info` init.ts | 0 命中 | ✓ PASS |
| init.ts 与 runMigrations 解耦 | grep `runMigrations` init.ts | 0 命中 | ✓ PASS |
| ai_system_logs CHECK 是否过窄 | Read init.ts:86-87 | CHECK(type IN ('discovery')) / CHECK(status IN ('success','failed')) | ✗ CONFIRMED 过窄（CR-01 成立） |
| 本阶段 createSystemLog 调用是否违反 CHECK | grep type='acl'/'migration'/'backup' | 7 处全部违反 | ✗ CONFIRMED 全部违反 |
| hasUserData 是否仅看 topologies/devices | Read connection.ts:76-89 | 仅 topoCount/devCount，异常返回 false | ✗ CONFIRMED gate 过窄（CR-02 成立） |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| ARCH-01 | 02-01, 02-03 | user_version + hasColumn 替代散落 table_info，迁移可追踪可跳过 | ✓ SATISFIED | SC#1 verified；migrations.ts + init.ts 散落块删除 + 单一调用点收敛全部达成 |
| ARCH-02 | 02-02, 02-03 | DB 文件 ACL 收紧 + 定时 .backup() 机制 | ⚠ PARTIALLY SATISFIED | SC#2/SC#3 代码路径完整（acl.ts + backupScheduler.ts + 生命周期注册），但 SC#4 向后兼容因 CR-01/CR-02 受损；REQUIREMENTS.md 已标 ARCH-02 为 Complete 但本验证发现审计日志与 IP-only 库安全网两处缺陷使其「完整闭环」未真正达成 |

**Orphaned requirements:** 无。ARCH-01/ARCH-02 均被本阶段 plan 认领且映射正确。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| electron/database/init.ts | 86-87 | ai_system_logs CHECK(type IN ('discovery')) / CHECK(status IN ('success','failed')) — 与本阶段所有非 discovery 日志调用冲突 | 🛑 Blocker | D-08/D-13 审计可观测性落空（CR-01） |
| electron/database/connection.ts | 76-89 | hasUserData gate 仅看 topologies/devices，异常保守返回 false | 🛑 Blocker | IP-only 遗留库 premigration 备份被跳过，v5 重建无安全网（CR-02） |
| electron/database/migrations.ts | 24 | 注释「DDL 与 user_version 同事务原子」与 SQLite 语义不符 | ⚠ Warning | 文档误导（CR-03），运行时由幂等守卫兜底 |
| electron/database/init.ts | 293 | initDefaultOUIData(db: any) + as any | ℹ Info | any 泄漏（IN-02），非阻塞 |
| electron/database/acl.ts | 77 | restrictDirPermissions 路径用 `/` 拼接 | ℹ Info | Windows 上 Node fs 兼容，潜在不一致（WR-01） |
| electron/services/backupScheduler.ts | 116 | getConfig row as any | ℹ Info | any 泄漏（WR-03） |
| electron/services/backupScheduler.ts | 97 | pruneBackups retention=0 时 slice(0) 删全部 | ⚠ Warning | 用户配 0 会删光备份（WR-02），需 clamp |
| electron/main.ts | 160 | before-quit 非 async，不等 in-flight backup | ⚠ Warning | 退出时备份进行中可能截断（WR-04） |

### Human Verification Required

### 1. ACL 实际生效验证（Windows）

**Test:** 启动 packaged/开发版 app，对 `userData/topology.db`、`topology.db-wal`、`topology.db-shm`、`userData/backups/*.db.bak` 执行 `icacls "<file>"`，确认仅当前用户 (F)，无继承项、无其他用户 ACE。
**Expected:** 所有上述文件 ACL 仅当前用户；非当前用户账户无法读取。
**Why human:** ACL 实际生效需 Windows 运行时 + 真实文件系统；icacls 调用在非管理员/域账户下可能 silently fail（CR-07/WR-07），代码路径无法在静态分析中证伪。

### 2. 定时备份文件生成验证

**Test:** 启动 app，将 backup_config.interval_minutes 改为 1（或手动触发），等待一个周期，检查 `userData/backups/topology-periodic-*.db.bak` 生成且 premigration 备份在首次旧库迁移时生成。
**Expected:** 周期备份文件按计划生成；旧库（user_version=0 且 topologies/devices 有行）迁移时生成 `topology-premigration-v0-to-v5-*.db.bak`；fresh-install 空库无 premigration 备份。
**Why human:** better-sqlite3 native binding 为 Electron NODE_MODULE_VERSION 145 编译，无法在 Node/vitest 中实例化真实 DB 做端到端测试（SUMMARY 已说明）。

### 3. 旧库端到端向后兼容验证

**Test:** 用 Phase 1 基线库（user_version=0 旧库）启动 app，验证迁移到 v5、字段齐全、拓扑/设备/AI 历史数据完整。
**Expected:** `PRAGMA user_version` 返回 5；chat_history.session_id、ai_exec_logs.prompt_text/ai_response、devices.status/last_checked、ai_config.vision_*、devices.connection_type 含 'rdp'；历史数据无丢失。
**Why human:** 同上，需 Electron 运行时 + 真实旧库文件。

### 4. IP-only 遗留库迁移验证（针对 CR-02）

**Test:** 构造一个仅有 arp_entries/ip_mac_bindings 数据、topologies/devices 为空的遗留库（user_version=0），启动 app 观察 premigration 备份是否生成、v5 devices 重建是否安全。
**Expected:** 当前代码会**跳过** premigration 备份（CR-02 gap），与「无数据丢失」承诺冲突。验证后应确认是否触发数据风险。
**Why human:** 需构造特殊遗留库 + 运行时观察。

### Gaps Summary

Phase 2 在 SC#1（user_version + hasColumn 收敛）上完全达成且实现质量高（原子事务、幂等守卫、单一调用点收敛、tsc 绿）。SC#2/SC#3 的代码路径完整存在（ACL helper、BackupScheduler、生命周期注册）但需运行时确认实际生效。

**两个 BLOCKER gap 阻碍 SC#4 向后兼容承诺与锁定决策的真正达成：**

1. **CR-01（审计日志 CHECK 截断）**：`ai_system_logs` 表的 CHECK 约束仅允许 `type='discovery'` + `status IN ('success','failed')`，但本阶段产生 `type='acl'/'migration'/'backup'` + `status='warning'` 共 7 处日志全部违反约束，被各调用点 try/catch 静默吞掉。**D-08（迁移失败可观测性）和 D-13（ACL 失败可观测性）在代码中从未真正生效**——锁定决策承诺的审计/可观测性不存在。修复需新增 v6 迁移（rebuild-with-CHECK 模式重建 ai_system_logs），仅改 createTables 不修复历史库。

2. **CR-02（hasUserData gate 过窄）**：`connection.ts:76` `hasUserData()` 仅检查 topologies/devices 行数，对只含 IP 监控数据的遗留库（arp_entries 等有数据但 topologies/devices 空）误判为 fresh-install 跳过 premigration 备份，随后 v5 devices DROP/RENAME 重建（破坏性）在无安全网下执行——**直接威胁 SC#4「旧库无数据丢失」**。修复需将 gate 改为基于 currentVersion>0 或 DB 文件预存在标志。

**一个 WARNING（CR-03）**：migrations.ts 注释声称 `PRAGMA user_version` 与 DDL 同事务原子，与 SQLite 实际语义不符（user_version 不参与事务）。运行时安全由幂等守卫兜底，非功能缺陷，但注释误导需修正。

**建议处置**：本阶段应回到 plan 阶段闭环 CR-01（v6 迁移修复 CHECK）+ CR-02（gate 改为 version/文件存在标志）+ CR-03（注释修正）。SC#2/SC#3 的运行时验证项（ACL 实际生效、备份文件生成、旧库端到端）需在 Electron 环境人工确认。

---

_Verified: 2026-06-28T05:10:00Z_
_Verifier: Claude (gsd-verifier)_
