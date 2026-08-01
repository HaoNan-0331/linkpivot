# Phase 2: Architecture & DB Migration - Context

**Gathered:** 2026-06-28
**Status:** Ready for planning

<domain>
## Phase Boundary

让数据库迁移**可追踪、可跳过、可回滚**：引入 `PRAGMA user_version` 版本管理 + `hasColumn` helper，替代 `init.ts` 中散落的 4 处 `PRAGMA table_info` 幂等检查；DB 文件（主库 + WAL/SHM sidecar + 备份）权限收紧为仅当前用户可读写；建立基于 better-sqlite3 `.backup()` 的定时备份机制。全程在 Phase 1 稳定构建基线上做，**向后兼容历史数据**——旧库打开后自动迁移到位且无数据丢失。

**不在本阶段范围（属于其他 phase）：**
- 性能优化（OUI N+1、ARP 事务化、FTS WHEN、init 移出主线程）→ Phase 3
- IPC 大数据分页 → Phase 4
- 前端重构 → Phase 5
- 采集/发现句柄泄漏 → Phase 6

</domain>

<decisions>
## Implementation Decisions

> **决策授权说明：** 用户在本阶段讨论中明确委托"直接按照你认为对项目的最优解执行"——以下 4 个 gray area 的决策由 Claude 依据代码现状、PROJECT.md 约束（向后兼容/打包红线/WAL）、核心价值（数据安全可控）拍板，用户保留在 plan-phase 前审阅/修改权。

### 备份策略（Backup Policy）

- **D-01 触发时机：** 双触发——(a) **定时周期备份**（独立 `BackupScheduler` 静态类，镜像现有 `SchedulerService` 结构：start/stop/restart + DB 持久化配置行，默认间隔 24h/1440min，可配置），app ready 时与 SchedulerService 一同启动；(b) **迁移前即时备份**（见 D-06，安全网）。定时调度复用 SchedulerService 的 `shouldRunNow` "启动时若到期则补跑"模式。
- **D-02 保留与轮换（双桶）：**
  - **周期桶**：滚动保留最近 **7** 份（FIFO 按 mtime 裁剪），命名 `topology-periodic-YYYYMMDD-HHmmss.db.bak`
  - **迁移桶**：迁移前备份命名 `topology-premigration-v{from}-to-v{to}-YYYYMMDD-HHmmss.db.bak`，独立保留最近 **5** 份，不混入周期桶裁剪（迁移点是跨版本恢复点，需更长存活）
  - 两桶各自裁剪，互不干扰；保留份数后续可配置化
- **D-03 存放位置：** 固定 `userData/backups/` 子目录（与 DB 同卷、本地原子级拷贝、随用户数据存活、天然被 `electron-builder.yml` 排除不进安装包）。**本阶段不开放路径可配置**（→ 见 Deferred）。
- **D-04 备份格式：** 用 better-sqlite3 的 `db.backup(path)` **在线备份 API**（WAL 一致性快照、不长时间阻塞写、输出单文件无需 -wal/-shm），**不裸拷 `.db` 文件**（WAL 下不一致）。**不压缩**（SQLite 已紧凑，保留即时可恢复；压缩 → Deferred）。裁剪在每次备份成功后执行。
- **D-05 备份调度注册：** 新增 `BackupScheduler`（`electron/services/backupScheduler.ts`），结构对齐 `SchedulerService`；`BackupConfig` 类型对齐 `ScheduleConfig`（enabled/intervalMinutes/lastRun/nextRun + retention 配置）；app ready 注册，`before-quit`/`will-quit` 清理 interval。

### 迁移安全网（Migration Safety Net）

- **D-06 迁移前备份（强制）：** 当一次会话检测到有待执行迁移（current user_version < head）时，**在执行第一个迁移步骤前**先做一份迁移桶备份（命名带 from→to 版本）。这是最高价值数据防线，直接服务核心价值。
- **D-07 步骤原子性：** 每个版本步骤 = 单个 `db.transaction(() => { ...DDL...; db.pragma('user_version = ' + target) })`。`PRAGMA user_version` 在 SQLite 中是事务性的——DDL 与版本号在 **同一事务提交时一起生效**，回滚则两者皆不生效。版本号**仅在 commit 成功后推进**，杜绝"schema 改了一半但版本号没动"的中间态。
- **D-08 失败处理：** 步骤事务失败 → better-sqlite3 自动回滚（DB 停留在前一版本，schema + 数据完整）→ **启动中止**，抛出清晰错误（步骤名、失败 SQL 片段、错误信息），写入 system log。**不自动恢复**（静默恢复会掩盖问题）——错误信息指明对应的 premigration 备份文件供人工恢复。自动恢复 → Deferred。
- **D-09 hasColumn helper：** 将现有 `PRAGMA table_info(X).some(c => c.name === Y)` 模式收敛为集中式 `hasColumn(db, table, col)` helper（位于 `electron/database/` 下，复用现有 `getDatabase()`）。满足 ARCH-01 的 hasColumn 要求，并支撑 D-11 的幂等重跑。`init.ts:275-308` 的 4 处散落检查重构为：纳入版本化迁移 + 必要处用 hasColumn 守卫。

### ACL 收紧范围与时机（File ACL）

- **D-10 保护范围：** 主库 `topology.db` + WAL sidecar `topology.db-wal` + `topology.db-shm` + `userData/backups/` 下所有备份文件（备份是敏感数据副本：加密凭证、AI 日志、设备清单，必须同等保护）。
- **D-11 跨平台机制：** 集中式 `restrictFilePermissions(path)` helper，按 `process.platform` 分支：
  - **Windows**：`icacls "<path>" /inheritance:r /grant:r "<currentUser>:(F)"`（剥离继承、仅当前用户完全控制、替换显式项）
  - **Unix/macOS**：`fs.chmod(path, 0o600)`
  - 当前用户名取 `os.userInfo().username` / `process.env.USERNAME`
- **D-12 强制时机（幂等，无 sentinel 状态）：**
  - (a) **活跃 DB 文件**（db/wal/shm）每次 app 启动后重新收紧（幂等、低成本，顺带修正历史宽松权限 + 防外部篡改）
  - (b) **每个备份文件**在 `.backup()` 创建后立即收紧
  - 无需 marker/sentinel 记录是否已加固——幂等重跑最简最稳
- **D-13 失败处理（非致命）：** icacls/chmod 失败（权限不足/非管理员等）**不崩溃**——写 system log 警告后继续。理由：数据已在应用层 AES-256-GCM + safeStorage 加密，ACL 是纵深防御层，非硬性闸门；非致命与 Phase 6 健壮性原则一致。

### 遗留库版本化（Legacy DB Versioning）

- **D-14 方案：幂等重跑（非盲目戳版本）。** 选 (b) 而非 (a) 纯 stamp。所有基线迁移（含待整合的 4 处 table_info 检查 + devices 表重建）保持**幂等守卫**（列新增用 `hasColumn` 守卫、表重建用 `sqlite_master` sql 内容检查——现有代码已是此模式）。遗留库（user_version=0）启动时**重跑全部待执行迁移**：已是当前 schema 的步骤是 no-op，逐步推进到 head 版本，**每个旧库都自我校验 schema 一致性**而非盲目信任戳记。
- **D-15 选择 (b) 而非 stamp 的理由：** 现有迁移代码本就幂等（到处是守卫），(b) 零额外成本却增加校验；纯 stamp 若某旧库曾漏迁移（部分态）会永久留下不一致；(b) 能发现并修正。契合核心价值（数据安全）与"只考虑最优秀方案"。
- **D-16 版本号方案：** 顺序整数 `user_version`（1, 2, 3, ...），每版本 = 一个迁移步骤；维护版本→步骤函数注册表（`migrations` map），head 版本随迁移新增而递增。具体 version→change 映射由 researcher/planner 定义。

### Claude's Discretion

用户全权委托本阶段 4 个 gray area 决策。上述 D-01 至 D-16 均为 Claude 按"项目最优"拍板。**下游 researcher/planner 在不违背这些决策与 PROJECT.md 约束的前提下，对纯实现细节（具体文件拆分、迁移注册表数据结构、icacls 命令封装、BackupScheduler 与 SchedulerService 是否抽公共基类等）有自由度。**

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 定义与需求
- `.planning/ROADMAP.md` §Phase 2 — 阶段 Goal / Depends on / 4 条 Success Criteria（迁移可追踪可跳过、ACL 仅当前用户、定时 backup 注册、旧库自动迁移无丢失）
- `.planning/REQUIREMENTS.md` §Architecture — **ARCH-01**（user_version + hasColumn 替代散落 table_info）、**ARCH-02**（DB 文件 ACL 收紧 + 定时 backup）

### 项目约束（红线）
- `.planning/PROJECT.md` §Constraints — 向后兼容（迁移/加密改动必须兼容历史数据）、打包红线（禁止打包用户数据/DB/账号进安装包）、Tech stack 不可换核心栈
- `.planning/PROJECT.md` §Context — WAL 已开启（备份须用 `.backup()` API 保证一致性）；AES-256-GCM + safeStorage 已加密凭证（ACL 是纵深防御第二层）

### 现有实现（待重构/复用的活代码）
- `electron/database/connection.ts` — `initDatabase`/`closeDatabase`/`getDatabase`，迁移注册与 ACL 强制的 hook 点；DB 路径 `userData/topology.db`
- `electron/database/init.ts` §273-340 — 现有散落迁移块（4 处 `PRAGMA table_info` 幂等检查 + devices 表事务化重建），ARCH-01 的重构对象
- `electron/services/schedulerService.ts` — `SchedulerService` 静态类（interval + 配置持久化 + shouldRunNow），`BackupScheduler` 的结构模板
- `src/types/oui.ts` §ScheduleConfig/SchedulerStatus — `BackupConfig` 类型模板

### Phase 1 基线
- `.planning/phases/01-build-dependency-foundation/01-01-SUMMARY.md` — Phase 1 完成的稳定构建基线（原生依赖 exact 锁定 + npm ci 可复现），本阶段改动不得破坏构建双绿

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`SchedulerService`**（`electron/services/schedulerService.ts`）：静态类 + `setInterval` + DB 持久化配置（enabled/intervalMinutes/lastRun/nextRun）+ `shouldRunNow` 启动补跑。`BackupScheduler` 直接镜像此结构，差异仅在 runTask 调 `.backup()` + 裁剪而非 ARP 采集。
- **`ScheduleConfig`/`SchedulerStatus` 类型**（`src/types/oui.ts`）：`BackupConfig` 类型直接套用并扩展 retention 字段。
- **`getDatabase()`**（`electron/database/connection.ts`）：所有迁移/ACL/备份代码取库的统一入口，已存在。
- **better-sqlite3 API**：`db.backup(toPath)`（在线一致性备份）、`db.transaction(fn)`（原子步骤）、`db.pragma('user_version = N')`（事务性版本号）、`db.pragma('table_info(...)')`（hasColumn 底层）——均为现成 API。

### Established Patterns
- **事务化 schema 重建**：`init.ts:316` devices 表重建已用 `db.transaction(() => { DROP...CREATE...INSERT...RENAME })` 包裹保证原子——迁移步骤事务化的先例已存在。
- **幂等守卫迁移**：现有 4 处迁移均为"检查再改"幂等模式（`if (!cols.some(...)) ALTER`），是 D-14 幂等重跑的基础，无需重写逻辑，只需纳入版本注册表。
- **静态类服务 + 配置 DB 持久化**：调度类服务的既定架构，BackupScheduler 沿用保持一致。
- **system log 写入**：`createSystemLog`（discovery 等已用）可用于记录 ACL 警告、迁移失败、备份事件。

### Integration Points
- **`main.ts` app ready**：`initDatabase()` 之后注册 `BackupScheduler.start()` 与 ACL 收紧；迁移在 `initDatabase` 内或紧随其后、备份/ACL 之前/之后由 planner 定序（迁移前备份 D-06 决定顺序：backup → migrate → 失败则中止）。
- **`before-quit`/`will-quit`**：`closeDatabase()` 前 `BackupScheduler.stop()` 清理 interval。
- **`userData/backups/`**：新建子目录，受 `electron-builder.yml` 排除规则覆盖（userData 本就不进安装包，但需确认排除规则未意外纳入）。

</code_context>

<specifics>
## Specific Ideas

- WAL sidecar（`-wal`/`-shm`）含活跃数据，ACL 与备份一致性都必须覆盖——这是容易被忽略的点，已纳入 D-10 与 D-04。
- 备份"双桶"（周期桶 7 + 迁移桶 5）是本阶段对数据安全的强化设计：迁移恢复点不被高频周期备份挤掉。
- 迁移前备份 + 步骤原子事务 + 失败中止指明备份，三件套构成完整数据防线，是对核心价值"设备/数据安全可控"的直接兑现。

</specifics>

<deferred>
## Deferred Ideas

- **备份路径用户可配置**（自定义目录、网络盘）：本阶段固定 `userData/backups/`；可配置化属未来增强，记入 backlog。
- **迁移失败自动恢复**（自动从 premigration 备份还原后重试）：本阶段仅中止 + 指明备份供人工恢复；自动恢复涉及数据覆盖风险，留待未来评估。
- **压缩备份**（gzip/zstd）：SQLite 已紧凑，本阶段不压缩保留即时可恢复；磁盘压力显著时再加。
- **备份加密**（备份文件本身加密）：凭证已 AES + safeStorage 加密，备份是加密密文的副本，额外加密备份文件收益有限，暂不做。
- **BackupScheduler 与 SchedulerService 抽公共基类**：若 planner 判断重复度值得抽象可做，否则保持两份镜像——实现细节，留给 planner 裁量。

</deferred>

---

*Phase: 2-Architecture & DB Migration*
*Context gathered: 2026-06-28*
