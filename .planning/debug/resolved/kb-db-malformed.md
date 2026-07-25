---
slug: kb-db-malformed
status: resolved
trigger: |
  资料库文档详情操作（删除章节 kb:deleteChunk、编辑后保存 kb:editChunk）报错：Error invoking remote method 'kb:deleteChunk': Error: database disk image is malformed。SQLite DB 损坏。
created: 2026-07-25
updated: 2026-07-25
goal: find_and_fix
---

# Debug Session: kb-db-malformed

## Symptoms

- **Expected**: 资料库文档详情删除章节 / 编辑后保存正常持久化。
- **Actual**: `kb:deleteChunk` / `kb:editChunk` 报 `database disk image is malformed`。
- **Error**: `database disk image is malformed`（SQLite B-tree 页校验失败）。
- **Timeline**: 开发调试期间出现。此前为验证 `ai-connect-timeout` / `exec-cmd-concat` 两个 debug 修复，多次重启 `electron:dev` 并用 `PowerShell Stop-Process -Force` / `taskkill //F` 强制 kill electron 进程。
- **Reproduction**: 资料库 → 文档详情 → 删除章节 / 编辑保存。

## Resolution

- **root_cause**: FTS5 虚拟表 `kb_chunks_fts` 的影子表（shadow tables）损坏——主库 `topology.db` 本身完好（`PRAGMA integrity_check` = ok，`quick_check` = ok，`kb_chunks` 193 行可读）。证据：`kb_chunks_fts_docsize` 为 0 行而 `kb_chunks_fts_data`=98 / `kb_chunks_fts_idx`=96 行不一致；FTS5 `integrity-check` 命令在 readonly 下报 `attempt to write a readonly database`（说明它需要重建 docsize，即确认 shadow 状态坏）；`PRAGMA wal_checkpoint` 在运行中的进程旁报 `disk I/O error`（WAL 未 checkpoint）。`deleteChunk` / `editChunk` 经 `kb_chunks_ad` / `kb_chunks_au` 触发器对 FTS5 做 `DELETE` / `INSERT`，命中损坏 shadow 状态时 SQLite 将其归类为通用 malformed。
- **fix**: (1) 数据层：停应用 → 备份当前 topology.db (+wal/+shm) 到 `backups/topology-pre-rebuild-20260725-143933.db.bak*` → DROP+CREATE `kb_chunks_fts` + 按触发器计算逻辑（image_desc=GROUP_CONCAT(kb_images.description)）从 kb_chunks 193 行重灌 shadow → 重建 `kb_chunks_ai/_ad/_au` 触发器 → wal_checkpoint(TRUNCATE)。结果：`_docsize` 0→193（与主表一致）、MATCH 命中正常（配置=13 hits）、integrity_check=ok、DELETE/INSERT/UPDATE 三触发器路径全绿（原 malformed 复现路径已消除）。注：标准 `INSERT INTO kb_chunks_fts VALUES('rebuild')` 因 FTS5 external-content 含计算列 `image_desc`（不在 content 表 kb_chunks 内）抛 `no such column: T.image_desc`，故改用 DROP+重灌方案；11:13 干净备份经核对与当前库 kb_chunks 完全同字节（193 行/63728 chars/2 docs，shadow 同为 _data=98/_idx=96/_docsize=0），证实"shadow 自 11:13 起即坏"，整库替换无价值。(2) 代码层：`knowledgeBaseService.ts` 的 updateChunk/deleteChunk/mergeChunks/splitChunk/deleteDocument 多语句显式包进 `db.transaction()`（deleteChunk 的文件 unlink 移事务外；updateChunk 的 FTS sync 仍 try/catch 不回滚主数据）。(3) 自愈：`main.ts` 启动序列（migrateAndSecure 之后）新增 FTS5 integrity-check → 失败即 rebuild → 仍失败仅 warn 不阻塞 init（与 safeLog 惯例一致），把"被动 malformed"转"主动自愈"。(4) 三门禁：tsc -p tsconfig.web.json(strict+noUnusedLocals)=绿；esbuild main+preload=绿；vitest 25/25=绿。(5) 备份保留：11:13 periodic + 14:39 pre-rebuild 双备份在 `backups/`，可回滚。应用当前已停（PowerShell Stop-Process electron），由 orchestrator 负责重启供用户 HV 验证。
## Current Focus

- **hypothesis**: 已确认并修复。FTS5 shadow 损坏（mutation 路径触发 malformed，read 路径正常），主库完好。
- **next_action**: 已完成（数据 shadow 重灌 + 代码事务化 + 启动自愈）。待 orchestrator 重启应用供用户 HV 验证 kb:deleteChunk / kb:editChunk。

## Evidence

- timestamp: 2026-07-25 — 读 `electron/main.ts:171` `app.on('before-quit', () => { BackupScheduler.stop(); closeDatabase() })`：正常退出已注册 `db.close()`。
- timestamp: 2026-07-25 — 读 `electron/database/connection.ts:25-28`：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`wal_autocheckpoint=1000`。
- timestamp: 2026-07-25 — 读 `electron/database/init.ts:229-283`：`kb_chunks` / `kb_chunks_fts`(fts5 external content) 同库 topology.db；`kb_chunks_ai`/`_ad`/`_au` 触发器在 INSERT/DELETE/UPDATE 时同步 FTS（DELETE 时先 `INSERT INTO kb_chunks_fts(kb_chunks_fts,rowid,...) VALUES('delete',...)`）。
- timestamp: 2026-07-25 — 读 `electron/services/knowledgeBaseService.ts:122-140 deleteChunk` / `106-120 updateChunk`：触发 FTS 触发器；多语句未包事务。
- timestamp: 2026-07-25 — `ls userData`：`topology.db`=1847296B mtime **7月5日**（主库 20 天没写过），`topology.db-wal`=1919952B mtime **7月25日 14:21**（WAL 持续增长未 checkpoint），`-shm`=32K mtime 7月25日 14:03。
- timestamp: 2026-07-25 — `ls backups/`：`topology-periodic-20260725-111350.db.bak`（今日 11:13，`db.backup()` 在线一致性快照，WAL 已 checkpoint，干净）。
- timestamp: 2026-07-25 — readonly 重开 topology.db（`ELECTRON_RUN_AS_NODE=1 + electron.exe`，规避 ABI）：`PRAGMA integrity_check` = `ok`；`PRAGMA quick_check` = `ok`；`kb_chunks` = 193 行；FTS5 shadow 表结构在（`_data`/`_idx`/`_docsize`/`_config`）。
- timestamp: 2026-07-25 — FTS5 内部检查：`INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('integrity-check')` 在 readonly 下抛 `attempt to write a readonly database`（说明该命令需写 docsize 修复，即 shadow 状态坏）；`kb_chunks_fts_docsize` = 0 行（非空表应 ~N 行）；`_data`=98 / `_idx`=96 不一致；`_config` 仅 `version=4`。
- timestamp: 2026-07-25 — `PRAGMA wal_checkpoint`（PASSIVE，运行中进程旁 readonly 测）= `disk I/O error`（WAL 未能 checkpoint，与 `-wal` 持续膨胀相互印证）。

## Eliminated

- 主库 B-tree 页损坏 — `integrity_check` / `quick_check` 均 ok，排除。
- 单次文件级损坏（不可恢复） — backups/ 有 11:13 干净快照，可恢复，排除"不可恢复"。
- `kb_chunks` 表本身损坏 — 193 行可读，排除。

## Investigation Notes

- `taskkill //F` / `Stop-Process -Force` = Windows 上的 SIGKILL 等价物，**不触发** Electron `before-quit` → `closeDatabase()` 不执行 → `db.close()` 内部 WAL checkpoint 未跑 → better-sqlite3/Native 句柄被强杀。重复多次后，FTS5 多行触发器（`_ad`/`_au` 各含 1 delete + 1 insert + 1 子查询 GROUP_CONCAT）的半途中断写入累积在 WAL，shadow 表（尤其 `docsize`）落到不一致状态。
- better-sqlite3 对 FTS5 shadow 损坏统一抛 `SqliteError: database disk image is malformed`（code SQLITE_CORRUPT / 26），不细分 FTS5 子表，故用户看到的"主库 malformed"是误导性措辞。
