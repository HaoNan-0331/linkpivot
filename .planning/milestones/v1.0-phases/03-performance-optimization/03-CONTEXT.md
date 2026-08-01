# Phase 3: Performance Optimization - Context

**Gathered:** 2026-06-28
**Status:** Ready for planning

<domain>
## Phase Boundary

消除 4 个已知性能热点，**纯性能优化**——不改功能行为、不改 IPC 签名（大数据分页属 Phase 4）、不动 SQL schema 语义（仅加 trigger `WHEN` 条件 + 事务包裹）。全程向后兼容，复用 Phase 2 已建立的 `user_version` 迁移机制与幂等守卫模式。

四项交付（对应 PERF-01/02/03/04）：
- **PERF-01**：OUI 厂商查询消除 N+1——启动预载 `Map<macPrefix, vendor>`，`getIPDetails` 等批量读路径改读内存 Map（O(1)），不再逐行查库
- **PERF-02**：`processARPEntries` 写库包单事务 + 复用 prepared statement，一次 COMMIT 替代 N 次 autocommit
- **PERF-03**：FTS UPDATE 触发器加 `WHEN` 条件，content/title/image_ids 未变时不删+插重索引
- **PERF-04**：`init` 启动路径幂等化加固 + 跳过事件可观测日志，二次冷启动跳过可见

**不在本阶段范围（属于其他 phase）：**
- IPC 大数据分页/上限（`getIPDetails`/`oui:getAll`/`anomaly:getChanges`/`export:arpTable`）→ Phase 4 (DATA-01)
- 前端重构（AIPage 拆分、any→types、stale closure、AbortController）→ Phase 5
- 采集/发现句柄泄漏与静默吞错 → Phase 6
- `kb_images` 跨表反向触发器（让图片描述变化重索引 FTS）→ 新能力，见 Deferred

</domain>

<decisions>
## Implementation Decisions

> **决策授权说明：** 用户在本阶段讨论中明确委托"你决定"（与 Phase 2 一致）——以下 4 个 gray area 的决策由 Claude 依据代码现状（CodeGraph 全符号索引确认）、PROJECT.md 约束（向后兼容/打包红线/WAL）、核心价值（拓扑准确 + 设备/数据安全可控为最高优先级）、Phase 2 先例（D-07/D-14）拍板。用户保留 `/gsd-plan-phase` 前审阅/修改权。

### PERF-01｜OUI 缓存一致性

- **D-P1 方案：全量预载内存 Map + 写操作增量同步（非失效重载）。**
  - `OUIService` 增模块级 `private static vendorMap: Map<string, string> | null`，懒加载：首次访问或显式 `preload()` 时 `SELECT oui_prefix, vendor_name FROM oui_database` 全量载入。
  - `getVendor(mac)` 改读 Map（mac 归一化为 6 位 hex 大写后 `map.get(prefix)`，miss 返回 `'Unknown'`）——从每次 `prepare().get()` 查库降为 O(1) 内存查找。
  - **写路径增量同步**：`add` / `addBatch` / `update` / `delete` / `deleteBatch` 五个写方法在写库成功后即时 `map.set/delete` 对应 entry，保证 Map 与库零延迟一致。选增量而非失效重载的理由：`getIPDetails` 是高频读路径必须零脏读；写点少（5 个）且全部集中在 `OUIService`，`set/delete` 是 O(1)；失效重载会引入"用户改 OUI 后 getIPDetails 短暂返回旧值"窗口 + 重载时机复杂，收益更低风险更高。
  - **预载时机**：启动序列末尾（`main.ts` 中 `migrateAndSecure()` 之后、IPC 注册之前）显式调用 `OUIService.preload()`，确保首次 `getIPDetails` 时 Map 已就绪。
  - **优雅降级（强制）**：`preload()` 失败 → Map 保持 `null` → `getVendor` 回退原 `prepare().get()` 查库路径。功能不中断，仅失去优化。性能优化不得破坏功能可用性。
  - **顺带修 bug**：`networkSegmentService.ts:107` 当前 `entry.mac ? (OUIService.getVendor(entry.mac) === 'Unknown' ? undefined : OUIService.getVendor(entry.mac)) : undefined` 对每行**双查** `getVendor`——改为调用一次、局部变量缓存结果。此 bug 使 N+1 翻倍（/24 网段最多 ~508 次查库）。

### PERF-02｜processARPEntries 事务化与失败语义

- **D-P2 方案：整批单事务 + 条目级 try/catch 跳过继续（保留现有"尽力而为"语义，单条失败不 abort 整批）。**
  - 整个 `processARPEntries` 循环包 `db.transaction(() => { for... })`，一次 COMMIT 替代逐条 autocommit。目标纯粹是降低提交开销，**不改变异常检测语义**。
  - **为何不"单条失败 abort 整批"**：当前 `recordChange`/`createBinding` 已 try/catch 吞错——这是 ARP 周期采集的合理语义（个别条目失败下次重试）。若改 abort 整批，则原本可处理的 A、C 条目会因 B 失败被回滚阻断，**违背向后兼容红线**（PROJECT.md §Constraints）。
  - **better-sqlite3 事务下"单条跳过"的正确实现**：条目级 try/catch 保留（捕获后 `continue`，不让 throw 冒泡到 transaction 回调——任何未捕获 throw 会触发整批 ROLLBACK）。即"失败的条目被跳过，成功的条目随最终 COMMIT 一次性提交"。
  - **prepared statement 复用**：循环内 4 处 `db.prepare(...)`（`SELECT ip_mac_bindings WHERE ip AND is_active=1`、`UPDATE is_active=0`、`UPDATE last_seen`、`SELECT ip_mac_bindings ORDER BY last_seen LIMIT 1`）提到循环外 prepare 一次、循环内 `.get/.run` 复用。
  - **额外消除隐含 N+1**：`isIPExcluded(ip)`（`anomalyService.ts:12`）当前每个条目都 `SELECT ip_or_cidr FROM excluded_ips` 全表扫——循环外一次性预载为 `Set`（普通 IP）+ 规则数组（CIDR/通配），循环内纯内存判定。`createBinding`/`recordChange` 内部的 `prepare` 调用也纳入同一事务边界（db 句柄已在循环内可用）。
  - **事务边界覆盖**：currentBinding 查询、UPDATE、createBinding（INSERT/UPDATE）、recordChange（INSERT ip_mac_changes）全部在同一事务——保证绑定状态与变更记录原子一致。返回的 `changes[]` 数组照常累积。

### PERF-03｜FTS UPDATE 触发器 WHEN 条件

- **D-P3 方案：`WHEN` 覆盖 content + title + image_ids（FTS 索引的全部来源字段）。**
  - `kb_chunks_fts` 索引 `title` / `content` / `image_desc` 三列。`title`、`content` 直接来自 `kb_chunks` 列；`image_desc` 由子查询 `GROUP_CONCAT(description) FROM kb_images WHERE chunk_id = NEW.id` 决定，其取值依赖 `kb_chunks.image_ids` 关联的图片集合。
  - 故 `kb_chunks` 的 UPDATE 仅在 `content` / `title` / `image_ids` 变化时需重索引；`chunk_index` / `level` / `char_count` / `created_at` / `document_id` 变化不影响 FTS 内容，跳过是正确优化。仅覆盖 `content` 会漏 title 改动场景；覆盖 image_ids 是因为图片集合变化会改变 image_desc。
  - **WHEN 条件**：`WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids`
  - **已知限制（本 phase 不修，标注入 Deferred）**：`kb_images.description` 的变化或 `kb_images` 的增删**不触发** `kb_chunks` 的 UPDATE（跨表），故"仅图片描述变化"时 image_desc 不会重索引。这是 FTS contentless/外部表设计的固有限制，修复需在 `kb_images` 上加反向触发器——属新能力，超出 PERF-03（仅要求"content 未变不重索引"，聚焦 kb_chunks 自身 UPDATE）。
  - **落地两处**：(a) `init.ts:273` 修改 DDL（新装库直接建带 WHEN 的 `kb_chunks_au`）；(b) 新增迁移 **v7**——`DROP TRIGGER IF EXISTS kb_chunks_au` + `CREATE TRIGGER kb_chunks_au AFTER UPDATE ... WHEN ... BEGIN ... END`（现有库更新）。遵循 Phase 2 **D-07**（`db.transaction(() => {DDL; db.pragma('user_version = 7')})`）与 **D-14**（幂等守卫：`sqlite_master` 检查现有 trigger sql 是否已含 `WHEN`，已含则 no-op 不重跑）。`MIGRATION_HEAD` 由 6 推进到 **7**，`MIGRATIONS` 注册表新增第 7 项。

### PERF-04｜init 冷启动优化路径

- **D-P4 方案：幂等化加固 + 启动跳过事件可观测日志。DDL/OUI seed 保持主线程同步，不引入 worker thread。**
  - **代码现状结论**：真正的冷启动瓶颈是**首次启动**（fresh-install：建 20+ 表 + 插 ~150 OUI seed + 跑 v1-v6 迁移）；**二次启动已基本幂等**——`createTables()` 全 `CREATE TABLE IF NOT EXISTS`（SQLite 快速跳过已存在表）、`INSERT OR IGNORE` whitelist、`initDefaultOUIData()` 的 `count > 0 return`、`runMigrations()` 的 `if (current >= MIGRATION_HEAD) return` 三重跳过机制均已存在。
  - **为何不 worker thread**：better-sqlite3 是同步 native 绑定，跨线程需独立 DB 连接（worker_threads 内 `new Database`）；首屏硬依赖 DB 就绪（`getIPDetails` 等），"异步化"只是把阻塞从 `createTables` 挪到"等 worker 完成"，收益有限；而风险高——native binding ABI 兼容（Phase 1 已知 NODE_MODULE_VERSION 敏感）、主/worker IPC、生命周期管理。不符合核心价值（设备/数据安全可控 > 启动毫秒）。"最优秀方案"= 收益/风险比最优，非最复杂。
  - **OUI seed 守卫不强行版本化**：`initDefaultOUIData()` 的 `count > 0` 是 **data seed 的正确幂等判定**（行数判定对 seed data 合理）；强行塞入 `user_version` 体系会把 data seed 与 schema migration 混淆，过度工程化。PERF-04 的"按 user_version 跳过"由迁移层（现状已跳过）+ DDL 幂等层共同满足。首次启动 OUI seed ~150 行单事务（`init.ts:346` 现状已 `db.transaction` 包裹），开销可接受，不移出主线程。
  - **落地（满足 success criteria"二次启动跳过日志可见"）**：
    - 在 `createTables()`（DDL 幂等跳过点）、`runMigrations()`（version 跳过点 `migrations.ts:187`）、`initDefaultOUIData()`（count 跳过点 `init.ts:295`）关键幂等点记录**启动跳过日志**（`createSystemLog` 合适 type，或 console 受限于启动早期 system log 表未就绪时的回退）。
    - 测量冷启动耗时 before/after（首次 + 二次启动），证明 PERF-01/02/03/04 实际收益。

### Claude's Discretion

用户全权委托本阶段 4 个 gray area 决策（"你决定"）。D-P1 至 D-P4 均为 Claude 按"项目最优"拍板，与 Phase 2 委托模式一致。

**下游 researcher/planner 在不违背上述决策与 PROJECT.md 约束的前提下，对纯实现细节有自由度**：
- `OUIService.vendorMap` 的具体封装（static 字段 + preload 方法签名、Map key 归一化逻辑复用 getVendor 现有 `replace(/[:\-\.]/g,'').toUpperCase()`）
- `processARPEntries` 事务包裹的具体重构形式（是否抽 `preloadExcludedSet()` helper、prepared statement 变量命名）
- v7 迁移在 `migrations.ts` 的具体写法（trigger DDL 字符串、幂等守卫的 `sqlite_master` sql 检查片段）
- 启动跳过日志的具体 type/字段（`ai_system_logs.type` 现仅 `discovery/acl/migration/backup`——启动跳过日志是否复用 `migration` type 或评估是否需扩 CHECK；若扩 CHECK 则需 v8 迁移，由 planner 判断是否值得）
- 冷启动耗时的测量方式（console.time / performance.now / 独立 benchmark 脚本）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 定义与需求
- `.planning/ROADMAP.md` §Phase 3 — 阶段 Goal（消除已知 N+1 与逐条提交开销，冷启动加速）/ Depends on Phase 2 / 4 条 Success Criteria（OUI 预载 Map、ARP 单事务、FTS WHEN、init 跳过可观测）
- `.planning/REQUIREMENTS.md` §Performance — **PERF-01**（OUI 预载 Map 消除 N+1）、**PERF-02**（processARPEntries 事务+复用 prepared statement）、**PERF-03**（FTS WHEN）、**PERF-04**（init 移出主线程或按 user_version 跳过）

### 项目约束（红线）
- `.planning/PROJECT.md` §Constraints — 向后兼容（事务化不得改变 ARP 失败语义、trigger 改动不得丢索引）、Tech stack 不可换核心栈、Build（tsconfig.web.json 严格 + noUnusedLocals 全绿、electron main esbuild）
- `.planning/PROJECT.md` §Context — WAL 已开启（事务可见性 OK）、Phase 2 已交付 user_version+hasColumn+迁移注册表（MIGRATION_HEAD=6）

### Phase 2 先例（机制复用，MUST 遵循）
- `.planning/phases/02-architecture-db-migration/02-CONTEXT.md` — **D-07** 步骤原子性（`db.transaction(() => {DDL; db.pragma('user_version = N')})`，v7 迁移遵循）、**D-14/D-15** 幂等重跑守卫（hasColumn / sqlite_master sql-content，非盲目戳版本）、**D-09** hasColumn helper

### 现有实现（待优化/复用的活代码 — PERF-01）
- `electron/services/networkSegmentService.ts:88` — `getIPDetails`（N+1 热点：`rows.map()` 行 107 对每 IP 调 getVendor，且双查）
- `electron/services/ouiService.ts:7` — `OUIService.getVendor`（每次 `prepare().get()` 查库；预载 Map 的改造对象）+ `getAll/search/getById/add/addBatch/update/delete/deleteBatch`（5 个写方法需增量同步 Map）
- `electron/ipc/ouiIpc.ts:29` — `oui:getVendor` IPC（单点调用，预载 Map 后同受益）

### 现有实现（PERF-02）
- `electron/services/anomalyService.ts:41` — `processARPEntries`（事务化 + prepared statement 复用对象；循环内 4 处 prepare + isIPExcluded 隐含 N+1）
- `electron/services/anomalyService.ts:12` — `isIPExcluded`（每行查 excluded_ips，预载 Set 消除）
- `electron/services/anomalyService.ts:73,81` — `createBinding`/`recordChange`（try/catch 吞错现状，事务化后保留条目级捕获）
- `electron/ipc/arpIpc.ts:37,59` + `electron/services/schedulerService.ts:64` — `processARPEntries` 调用点（事务化对调用方透明，签名不变）

### 现有实现（PERF-03 / PERF-04）
- `electron/database/init.ts:252-280` — FTS5 虚表 + 3 个 trigger（`kb_chunks_ai`/`_ad`/`_au`），`_au` UPDATE trigger（行 273）缺 WHEN，PERF-03 改造对象
- `electron/database/init.ts:3` — `createTables()`（主线程同步 exec 大段 DDL，PERF-04 幂等化点）
- `electron/database/init.ts:293` — `initDefaultOUIData()`（`count>0` 守卫行 295，OUI seed ~150 行单事务行 346，PERF-04 可观测日志点）
- `electron/database/migrations.ts:16` — `MIGRATION_HEAD = 6`（v7 迁移落地后推进到 7）；`migrations.ts:164` `MIGRATIONS` 注册表（新增第 7 项）；`migrations.ts:187` `runMigrations` version 跳过早返回点
- `electron/database/connection.ts:61` — `migrateAndSecure()`（启动序列中 runMigrations 调用点 + premigration 备份门控）；`connection.ts:21` `initDatabase`/`getDatabase` 单例
- `electron/database/migrationHelpers.ts` — `hasColumn(db, table, col)`（v7 迁移幂等守卫可复用）
- `electron/main.ts:79-81` — 启动序列 `initDatabase() → createTables() → migrateAndSecure()`（全在 `app.whenReady` 主线程同步；`OUIService.preload()` 插入点在 migrateAndSecure 之后）

### Phase 1/2 基线
- `.planning/phases/01-build-dependency-foundation/01-01-SUMMARY.md` — 稳定构建基线（本阶段改动不得破坏 tsc+esbuild 双绿）
- `.planning/phases/02-architecture-db-migration/02-VERIFICATION.md` — Phase 2 验证基线（迁移/ACL/Backup 已 4/4 通过，本阶段在其上做性能优化）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`OUIService`**（`electron/services/ouiService.ts`）：静态类，已集中所有 OUI 读写。`getVendor` 的 mac 归一化逻辑（`replace(/[:\-\.]/g,'').toUpperCase().substring(0,6)`）可直接复用为 Map key 规范化。5 个写方法（add/addBatch/update/delete/deleteBatch）是增量同步 Map 的全部 hook 点。
- **`getDatabase()`**（`electron/database/connection.ts`）：所有 DB 访问统一入口，事务/preload 复用。
- **better-sqlite3 API**：`db.transaction(fn)`（PERF-02 整批事务、PERF-03 v7 迁移原子步骤）、`db.prepare(sql)`（prepared statement 复用）、`db.pragma('user_version = N')`（v7 版本推进）、`db.pragma('user_version')`（version 读取）——均为现成 API。
- **`hasColumn` helper**（`electron/database/migrationHelpers.ts`）：v7 迁移幂等守卫可复用（检查 trigger 已含 WHEN 则用 sqlite_master sql-content 检查，与 v5/v6 模式一致）。
- **`createSystemLog`**（`electron/services/systemLog.ts`）：记录 PERF-04 启动跳过事件（注意启动早期 system log 表可能未就绪，需回退 console）。

### Established Patterns
- **事务化 schema 重建 / 步骤原子性**（Phase 2 D-07）：`db.transaction(() => {DDL; db.pragma('user_version = N')})`——v7 迁移遵循，每版本一步。
- **幂等守卫迁移**（Phase 2 D-14）：v5（devices rdp rebuild）、v6（ai_system_logs CHECK widen）均用 `sqlite_master` sql-content 检查 + 已含目标特征则 no-op——v7 的 trigger WHEN 检查同此模式。
- **better-sqlite3 事务 + 条目级 try/catch**：`initDefaultOUIData`（`init.ts:346`）已用 `db.transaction(() => {for...})` 包裹批量 INSERT——PERF-02 的 processARPEntries 事务化有先例。
- **静态类服务**：`OUIService`/`AnomalyService` 均静态方法 + `getDatabase()`，模块级单例 Map 与现有架构一致。

### Integration Points
- **`main.ts:79-81` 启动序列**：`OUIService.preload()` 插入在 `migrateAndSecure()` 之后、IPC 注册（`registerArpIpc` 等）之前——确保首次 `getIPDetails` 调用时 Map 就绪。
- **`networkSegmentService.ts:107`**：getVendor 双查 bug 修复点（PERF-01 顺带交付）。
- **`migrations.ts:164 MIGRATIONS`**：v7 注册表新增项（PERF-03 落地）；`migrations.ts:16 MIGRATION_HEAD` 6→7。
- **`init.ts:273` trigger DDL**：新装库建带 WHEN 的 trigger（与 v7 迁移对现有库的 DROP+CREATE 保持定义一致）。

</code_context>

<specifics>
## Specific Ideas

- **getIPDetails 双查 bug**（`networkSegmentService.ts:107`）：`OUIService.getVendor(entry.mac) === 'Unknown' ? undefined : OUIService.getVendor(entry.mac)` 对同一 mac 调用两次 getVendor——使 N+1 查询数翻倍。PERF-01 改造时必须顺带修为单次调用 + 局部缓存。这是审计中发现的"隐藏 2x 放大"。
- **isIPExcluded 隐含 N+1**（`anomalyService.ts:12`）：`processARPEntries` 循环内每条目全表扫 `excluded_ips`。PERF-02 事务化时一并预载为内存 Set/规则数组，是该 REQ 的"隐藏第二收益"，纳入交付。
- **FTS image_desc 跨表限制**：`kb_chunks_au` 的 image_desc 来自 `kb_images` 子查询，UPDATE trigger 天然不感知 `kb_images` 变化。这是设计固有限制，本 phase 明确标注不修（避免 scope creep 到"跨表反向触发器"新能力）。
- **PERF-04 的可观测性是硬指标**：success criteria 字面要求"二次启动跳过日志可见"——不是可选，是验收项。planner 必须确保跳过事件有可验证的日志输出。
- **v7 是 Phase 3 唯一新增迁移**：PERF-03 需要 v7（trigger WHEN）。PERF-04 不新增迁移（幂等机制已存在，只加可观测日志）。若启动跳过日志需扩 `ai_system_logs.type` CHECK，则可能需 v8——由 planner 判断是否值得（或用 console 回退避免 v8）。

</specifics>

<deferred>
## Deferred Ideas

- **`kb_images` 跨表反向触发器**：让 `kb_images` 的 description 变化/增删触发关联 `kb_chunks` 的 FTS image_desc 重索引。属新能力（跨表触发器），超出 PERF-03"content 未变不重索引"的 scope。记入 backlog，未来知识库检索优化时评估。
- **init 移到 worker thread / utilityProcess**：本 phase 经分析判定收益有限（首屏硬依赖 DB 就绪）且风险高（native ABI/IPC/生命周期），选择幂等化方案。若未来实测首次启动 DDL 在大库上显著慢，可再评估异步化。属性能优化的"下一档"。
- **OUI seed 纳入 user_version 版本化**：评估后判定 count>0 行数守卫对 data seed 是正确幂等判定，强行版本化会混淆 data seed 与 schema migration。不做。若未来 OUI seed 演变为可更新数据集（需检测内容变更），可重新评估。
- **冷启动性能基准测试套件**：本 phase 仅做 before/after 测量证明收益。建立持久化的启动性能基准/回归监控属未来增强（可能配合 Electron 启动追踪工具）。
- **`oui:getAll` / `anomaly:getChanges` 等大数据 IPC 的分页**：明确属 Phase 4 (DATA-01)，本 phase 不动 IPC 签名。

</deferred>

---

*Phase: 3-Performance Optimization*
*Context gathered: 2026-06-28*
