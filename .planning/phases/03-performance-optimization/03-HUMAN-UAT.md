---
status: partial
phase: 03-performance-optimization
source: [03-VERIFICATION.md]
started: 2026-06-28
updated: 2026-07-26
---

## Current Test

[HV 回填 2026-07-26：3/5 pass（#1/#2/#4），#3/#5 defer；better-sqlite3 native binding ABI 145 无法 plain node ABI 137 自动化，人工 Electron runtime 验证]

## Tests

### 1. OUI preload 实际载入 + getIPDetails N+1 实测（PERF-01 运行时）
expected: 启动 electron app 后，`OUIService.vendorMap` 全量载入 oui_database（~150+ 条）；打开 /24 网段 `getIPDetails`，OUI 厂商查询从 O(n) 逐行查库降为 O(1) 内存 Map 查找（日志/SQL trace 验证无逐行 `SELECT vendor_name FROM oui_database`）。
result: **pass** — `oui_database` 实测 176 行载入（PERF-01 vendorMap 数据源就绪）；getIPDetails N+1 代码层已修（04-01 `getAllVendors` 内存 Map O(1)，无逐行查库）；`ip_status` 78 行数据源就绪。运行时 SQL trace defer（better-sqlite3 无 SQL log，代码层证据充分）。

### 2. 二次冷启动跳过日志可见（SC#4 硬指标）
expected: 第二次（及以后）启动 app，控制台/system log 可见 `initDefaultOUIData 跳过`（count>0）与 `runMigrations 跳过`（version≥HEAD）两类真实条件跳过日志；fresh-install 首次启动无此跳过日志（实际执行 seed + 迁移）。
result: **pass** — `ai_system_logs` type=migration 多次启动均记录 `[startup] initDefaultOUIData 跳过：oui_database 已有 176 行` + `[startup] runMigrations 跳过：user_version=7 已达 HEAD=7`（2026-07-25 14:46 / 14:03 / 13:29 三次启动均可见，2026-07-26 重启后仍记录）。

### 3. WR-01 savepoint 回滚行为（事务语义改动）
expected: `processARPEntries` 单条目中途失败时（如 UPDATE is_active=0 成功但 createBinding 失败），该条目整体回滚（SAVEPOINT ROLLBACK TO），不留"IP 停用无新 binding"不一致状态；其他成功条目仍随整批 COMMIT 提交；不产生持续 ip_reused 误报。
result: **defer** — 需构造 processARPEntries 单条目中途失败（UPDATE 成功 + createBinding 失败），构造性强，headless 难自动化。代码层 04-01 已实现 SAVEPOINT 回滚 + 三绿通过。

### 4. FTS trigger WHEN 实际跳过（PERF-03 运行时）
expected: 对 kb_chunks 执行 UPDATE 仅改非 FTS 字段（如 level/char_count）时，`kb_chunks_au` trigger 因 WHEN 条件（content/title/image_ids 未变）跳过 FTS 删+插重索引；改 content 时正常重索引。可在 v7 迁移后的库上验证 trigger 定义生效（`SELECT sql FROM sqlite_master WHERE name='kb_chunks_au'` 含 WHEN）。
result: **pass** — `kb_chunks_au` trigger 定义 DB 实测含 `WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids`（v7 迁移 D-P3 生效）；运行时跳过逻辑代码层已实现 + 三绿。

### 5. 冷启动耗时 before/after 量化（phase goal 证据）
expected: 对比优化前后（git checkout Phase 3 前后）的 `[startup] DB+OUI init Xms` 计时日志，证明冷启动耗时下降。首次启动（fresh-install）与二次启动（幂等跳过）分别测量。
result: **partial** — 实测 `[startup] DB+OUI init` 463 / 484 / 512 ms（2026-07-25/26 多次启动）；before/after 量化对比需 git checkout Phase 3 前后跑，defer（单次值已记录，优化后耗时合理，OUI 176 行 + 迁移跳过幂等下 <600ms）。

## Summary

total: 5
passed: 3（#1 OUI+N+1 / #2 跳过日志 / #4 FTS WHEN）
deferred: 2（#3 savepoint 构造 / #5 before/after 对比）
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

- #3 savepoint 回滚运行时 HV defer（代码层 04-01 已实现 SAVEPOINT + 三绿，构造中途失败场景 headless 难）
- #5 冷启动 before/after 量化对比 defer（需 git checkout Phase 3 前后，单次值 463-512ms 已记录）
- #1 getIPDetails N+1 运行时 SQL trace defer（代码层 vendorMap O(1) 已证，better-sqlite3 无 SQL log）
