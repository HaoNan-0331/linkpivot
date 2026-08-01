---
phase: 03-performance-optimization
plan: 03
subsystem: database
tags: [sqlite, fts5, trigger, migration, idempotency, startup-observability, better-sqlite3]

# Dependency graph
requires:
  - phase: 02-architecture-db-migration
    provides: "user_version 迁移机制 (D-07 步骤原子性 + D-14 sqlite_master sql-content 幂等守卫先例, MIGRATION_HEAD=6 基线)"
  - phase: 03-performance-optimization/03-02
    provides: "main.ts 启动序列 + performance.now() 冷启动计时日志行 (作为 PERF-03/04 before/after 证据来源)"
provides:
  - "kb_chunks_au UPDATE FTS trigger 加 WHEN 条件 (content/title/image_ids 未变时不删+插重索引, PERF-03)"
  - "v7 迁移: 现有库 DROP+CREATE 升级 kb_chunks_au 到带 WHEN 版本 (无需人工干预, D-07/D-14)"
  - "MIGRATION_HEAD 推进 6->7, MIGRATIONS 注册表第 7 项"
  - "两个真实条件幂等跳过点可观测日志 (initDefaultOUIData count>0 / runMigrations version>=HEAD, PERF-04)"
affects: [knowledge-base-fts-indexing, init-cold-start-path, future-migrations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "FTS5 UPDATE trigger WHEN 条件 (仅 FTS 来源字段变化才重索引, 非全字段 UPDATE 触发)"
    - "trigger 重建迁移: DROP TRIGGER IF EXISTS + 裸 CREATE TRIGGER (CREATE TRIGGER IF NOT EXISTS 不替换已存在定义, PATTERNS caveat)"
    - "幂等守卫第二形式: sqlite_master type='trigger' 查 sql 含目标特征则 no-op (v5 'rdp'/v6 'warning'/v7 'WHEN' 同构)"
    - "启动跳过事件可观测日志: createSystemLog type=migration + try/catch 回退 console.log (启动早期表未就绪)"

key-files:
  created: []
  modified:
    - electron/database/init.ts
    - electron/database/migrations.ts

key-decisions:
  - "D-P3: kb_chunks_au WHEN 覆盖 content+title+image_ids (FTS 索引全部来源字段), 两处定义逐字一致"
  - "D-P3: v7 用 DROP+CREATE 而非 IF NOT EXISTS (caveat: 后者不替换已存在但定义不同的 trigger)"
  - "D-P4: type 复用 migration CHECK (已含), 不引入 v8 扩 CHECK (过度工程)"
  - "D-P4: 不加 createTables 装饰日志 (20+ 表 CREATE IF NOT EXISTS 无单一跳过判定, Warning 2)"
  - "D-P4: 不引入 worker thread (better-sqlite3 同步 native, ABI 风险 > 启动毫秒收益)"
  - "D-P4: 不改 main.ts (编辑权归 plan 03-02), 冷启动 before/after 引用 plan 03-02 计时日志行"

patterns-established:
  - "trigger 改动迁移: DROP+CREATE 单事务 + sqlite_master sql-content 守卫 (无 foreign_key_check, 区别于表重建)"

requirements-completed: [PERF-03, PERF-04]

# Metrics
duration: 3min
completed: 2026-06-28
---

# Phase 3 Plan 03: FTS UPDATE trigger WHEN + init startup idempotent-skip observability Summary

**kb_chunks_au UPDATE FTS 触发器加 WHEN 条件（content/title/image_ids 未变不重索引）+ v7 迁移自动升级现有库（DROP+CREATE + D-14 守卫），并在两个真实条件幂等跳过点（initDefaultOUIData count>0 / runMigrations version≥HEAD）加 createSystemLog 可观测日志（type=migration 复用 CHECK，无 v8）。**

## Performance

- **Duration:** 3 min
- **Started:** 2026-06-28T10:23:14Z
- **Completed:** 2026-06-28T10:26:16Z
- **Tasks:** 2/2
- **Files modified:** 2 (electron/database/init.ts, electron/database/migrations.ts)

## Accomplishments

### PERF-03: FTS UPDATE trigger WHEN 条件
- **init.ts fresh-install DDL**：`kb_chunks_au` UPDATE trigger 在 `ON kb_chunks` 与 `BEGIN` 之间插入 `WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids`，BEGIN...END 内两条 INSERT 逐字保留。`_ai`（INSERT）/`_ad`（DELETE）trigger **未动**（INSERT/DELETE 无 WHEN 概念）。
- **migrations.ts v7 迁移**（现有库升级）：幂等守卫查 `sqlite_master type='trigger' name='kb_chunks_au'` 的 sql 是否含 `WHEN`，已含则 no-op（D-14）；否则 `db.transaction(() => { DROP TRIGGER IF EXISTS kb_chunks_au; CREATE TRIGGER kb_chunks_au ... WHEN ... BEGIN ... END; db.pragma('user_version = 7') })`（D-07 原子，失败 better-sqlite3 自动 ROLLBACK，trigger 保持原状）。
- **v7 用裸 `CREATE TRIGGER`**（非 IF NOT EXISTS）：因前置已 `DROP TRIGGER IF EXISTS`，此时必不存在。PATTERNS caveat 红线：`CREATE TRIGGER IF NOT EXISTS` 对已存在但定义不同的 trigger 不替换，故必须先 DROP 再 CREATE。
- **两处 trigger 定义逐字一致**：init.ts fresh-install DDL 与 v7 的 CREATE TRIGGER DDL 的 WHEN 条件 + 两条 INSERT 逐字复制（acceptance 用同一 WHEN 字面量校验两文件各命中 1 次）。
- **v7 不需要 foreign_key_check**：trigger 改动不涉表数据完整性（区别于 v5/v6 表重建）。
- **MIGRATION_HEAD 推进 6→7**，`MIGRATIONS` 注册表新增 `{ version: 7, name: 'kb_chunks_au FTS UPDATE trigger add WHEN (skip non-FTS-field updates)', run: v7 }`。

### PERF-04: init 启动幂等跳过可观测日志
- **runMigrations version≥HEAD 跳过日志**（migrations.ts:187 早返回点）：`createSystemLog({ type: 'migration', status: 'success', errorMessage: '[startup] runMigrations 跳过：user_version=${current} 已达 HEAD=${MIGRATION_HEAD}...' })` + try/catch 回退 `console.log`（启动早期 ai_system_logs 表未就绪不崩，T-03-11）。
- **initDefaultOUIData count>0 跳过日志**（init.ts:295 早返回点）：`createSystemLog({ type: 'migration', status: 'success', errorMessage: '[startup] initDefaultOUIData 跳过：oui_database 已有 ${count} 行 seed...' })` + console 回退。init.ts 顶部新增 `import { createSystemLog } from '../services/systemLog'`。
- **type 复用 `migration`**：`ai_system_logs.type` CHECK 现含 `discovery/acl/migration/backup`（v6 已 widen 含 warning），跳过日志复用 migration type，**不引入 v8 迁移扩 CHECK**（D-P4 discretion：过度工程不值得）。
- **不加 createTables 日志**（Warning 2）：createTables 是 20+ 表混合 `CREATE TABLE IF NOT EXISTS`，无单一"全跳过"判定，日志只能写"幂等完成"而非"全部跳过"，grep 无法区分"表被跳过"vs"表被创建"，是装饰性日志。`grep -c "createTables 完成" init.ts = 0`。
- **不改 main.ts**（编辑权归 plan 03-02，已完成）。冷启动 before/after 证据引用 plan 03-02 的 main.ts `performance.now()` 日志行（`[startup] DB+OUI init Xms`），本 plan 不自行重测。

## Deviations from Plan

None - plan 执行忠实于 D-P3 + D-P4（含 W2 修订）。两处 trigger 定义逐字一致、v7 用 DROP+CREATE（非 IF NOT EXISTS）、HEAD=7、删 createTables 装饰日志、type 复用 migration 无 v8、不碰 main.ts —— 全部按 locked decision 落地。

## Verification Results

- `npx tsc -p tsconfig.web.json --noEmit` exit 0（双绿基线保持）
- `npm run build:electron-main`（esbuild 打包含 init/migrations 传递依赖）exit 0，dist-electron/main.js 1.8mb
- grep `WHEN OLD.content IS NOT NEW.content`：init.ts 命中 1、migrations.ts 命中 1（两处定义逐字一致）
- grep `DROP TRIGGER IF EXISTS kb_chunks_au`：migrations.ts 命中 1（v7 先 DROP）
- grep `user_version = 7`：migrations.ts 命中 1（v7 版本推进）
- grep `MIGRATION_HEAD = 7`：migrations.ts 命中 1，`= 6` 命中 0（HEAD 推进）
- grep `type='trigger' AND name='kb_chunks_au'` + `triggerSql.includes('WHEN')`：均命中（D-14 幂等守卫）
- grep `version: 7, name: 'kb_chunks_au FTS UPDATE trigger add WHEN'`：命中（注册表第 7 项）
- grep `initDefaultOUIData 跳过`（init.ts）+ `runMigrations 跳过`（migrations.ts）：均命中（两个真实条件跳过日志）
- grep `createTables 完成`：init.ts 命中 0（Warning 2 装饰日志已删）
- grep `system_logs 未就绪回退 console`：init.ts + migrations.ts 均命中（console 回退）
- grep `user_version = 8`：命中 0（type 复用 migration，无 v8 扩 CHECK）
- init.ts `kb_chunks_ai`/`kb_chunks_ad` trigger 定义未被修改（git diff 无相关行变更）
- main.ts 未改（git diff --stat 为空）
- 静态验证为准（不跑 plain node better-sqlite3 运行时，native ABI 不匹配）

## Cold-Start Performance Evidence (PERF-04 SC#4)

本 plan 不改 main.ts（编辑权归 plan 03-02）。冷启动耗时的 before/after 证据**引用 plan 03-02 在 main.ts 加的 `performance.now()` 日志行** `[startup] DB+OUI init Xms`（D-P4 明示回退路径）。PERF-03（FTS WHEN，减少 kb_chunks UPDATE 时的 FTS 重索引）与 PERF-04（init 跳过可观测）对冷启动的实际影响由该计时日志行在二次冷启动中体现：二次启动时 `createTables` 的 20+ `CREATE TABLE IF NOT EXISTS`（SQLite 快速跳过）+ `initDefaultOUIData count>0`（本 plan 加跳过日志，grep ≥1 可见）+ `runMigrations version≥HEAD`（本 plan 加跳过日志，grep ≥1 可见）三重跳过机制全部命中。

**二次启动跳过日志可见性（SC#4 硬指标）达成证明**：两个真实条件跳过点的日志均落库 `ai_system_logs`（type=migration），二次冷启动后 `SELECT * FROM ai_system_logs WHERE type='migration'` 可见两条 `[startup] ... 跳过` 记录；若启动早期 system_logs 表未就绪，则 console.log 回退输出（两文件均有回退校验）。

## Threat Mitigation Summary

| Threat | Mitigation 落地 |
|--------|----------------|
| T-03-09 (v7 迁移失败 trigger 丢失) | DROP+CREATE+user_version 在单 db.transaction 内（D-07），任一 throw → ROLLBACK，trigger 保持原状；runMigrations catch 写 system log + 抛出中止（D-08），DB 停留 v6，trigger 仍在（旧无 WHEN 版本），FTS 仍更新（仅失去 WHEN 优化，非数据损坏） |
| T-03-10 (两处 trigger 定义不一致) | Task 1 acceptance 用同一 WHEN 字面量校验两文件各命中 1 次，逐字一致 |
| T-03-11 (启动早期 system_logs 未就绪崩) | 两跳过日志点均 try/catch 包裹，catch 回退 console.log（两文件回退校验均命中） |
| T-03-12 (跳过事件无审计) | PERF-04 核心交付：两个真实条件跳过点 createSystemLog type=migration，二次启动可见（SC#4 硬指标） |
| T-03-13 (日志含 user_version/OUI 行数) | accept —— DB schema/数据规模元数据，非敏感凭证，已 ACL 收紧（D-10） |

## Commits

- `4f764a6` — feat(03-03): kb_chunks_au UPDATE trigger add WHEN (PERF-03) — init.ts DDL 加 WHEN + migrations.ts v7 迁移（DROP+CREATE + D-14 守卫 + HEAD=7）
- `a67374d` — feat(03-04): init startup idempotent-skip observability logs (PERF-04) — runMigrations/initDefaultOUIData 两跳过日志 + console 回退 + 删 createTables 装饰日志

## Self-Check: PASSED

- Files: electron/database/init.ts FOUND, electron/database/migrations.ts FOUND, 03-03-SUMMARY.md FOUND
- Commits: 4f764a6 FOUND, a67374d FOUND, e8bf24f FOUND
- tsc + esbuild 双绿, 两处 WHEN 定义逐字一致, HEAD=7, 无 v8, main.ts 未改

