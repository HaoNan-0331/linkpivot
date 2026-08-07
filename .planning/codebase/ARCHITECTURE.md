<!-- refreshed: 2026-08-07 -->
# Architecture

**Analysis Date:** 2026-08-07

## System Overview

`network_toplogy` 是面向运维人员的网络拓扑管理桌面工具，采用 Electron 三进程模型（main / preload / renderer）。主进程承载全部业务逻辑、数据库、加密与外部集成；preload 是受信任的 IPC 网关；renderer 是纯展示层，通过 `contextBridge` 暴露的 `window.api` 访问能力，无 Node 访问权。

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Renderer Process（React 19 + Ant Design + React Flow + Zustand）     │
│  `src/` — `src/main.tsx` → `src/App.tsx` → `src/components/MainLayout` │
│  ┌────────────┐ ┌──────────────┐ ┌─────────────┐ ┌────────────────┐  │
│  │ topology/  │ │ pages/       │ │ ip-mgmt/    │ │ settings/      │  │
│  │ 画布/节点  │ │ AI/设备/拓扑 │ │ ARP/网段/异常│ │ 命令白名单/日志│  │
│  └─────┬──────┘ └──────┬───────┘ └─────┬──────┘ └───────┬────────┘  │
│        └───────────────┴────────────────┴────────────────┘            │
│                         window.api.* （contextBridge）                 │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ ipcRenderer.invoke('channel', …args)
┌─────────────────────────────────▼────────────────────────────────────┐
│  Preload Process — `electron/preload.ts`                              │
│  contextIsolation:true / sandbox:true / nodeIntegration:false         │
│  仅暴露白名单 IPC channel → window.api{auth,device,topology,          │
│  connection,ai,arp,network,anomaly,oui,export,scheduler,kb,experience,experienceDrafting}           │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ ipcMain.handle(channel, secure(fn))
┌─────────────────────────────────▼────────────────────────────────────┐
│  Main Process — `electron/main.ts` (app.whenReady 启动序列)           │
│  ┌──────────────── IPC 网关层 ──────────────┐                         │
│  │ `electron/ipc/*Ipc.ts` + main.ts inline  │  secure() 鉴权+脱敏     │
│  └───────────────────┬──────────────────────┘                         │
│  ┌───────────────────▼──────────────────────┐                         │
│  │ 业务层 `electron/services/*.ts`          │  device/ai/topology/    │
│  │ commandSafety / discovery / *Service     │  connection/kb/arp/oui/exp │
│  └───────────────────┬──────────────────────┘                         │
│  ┌───────────────────▼──────────────────────┐                         │
│  │ 数据层 `electron/database/*`             │  better-sqlite3 (WAL)   │
│  │ connection/init/migrations/migrationHlp/acl │  AES-256-GCM 字段加密 │
│  └───────────────────┬──────────────────────┘                         │
│  ┌───────────────────▼──────────────────────┐                         │
│  │ 工具层 `electron/utils/*`                │  crypto/keyManager/     │
│  │                                          │  authGuard/webSecurity  │
│  └──────────────────────────────────────────┘                         │
└───────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| main.ts | App 启动序列、CSP 注入、masterKey 注入（7 个 service）、R2 解密失败 handler 注入、backfillSeverityFromHistory 钩子、IPC inline 注册、调度器启动 | `electron/main.ts` |
| preload.ts | contextBridge 暴露白名单 `window.api`，是 renderer 唯一 IPC 入口 | `electron/preload.ts` |
| authGuard | IPC 鉴权中间件 `secure()`/`safe()` + 异常脱敏 + 登录态 | `electron/utils/authGuard.ts` |
| crypto | AES-256-GCM 字段加解密、PBKDF2 密码 hash/verify、派生密钥 LRU 缓存、解密失败 handler 注入点 | `electron/utils/crypto.ts` |
| keyManager | masterKey 生成与 safeStorage（DPAPI/Keychain/libsecret）落盘 | `electron/utils/keyManager.ts` |
| webSecurity | BrowserWindow 加固（hardenWindow）、弹窗转系统浏览器 | `electron/utils/webSecurity.ts` |
| connection.ts | DB 生命周期（init/close/WAL pragma）、迁移与 ACL 收紧门控 | `electron/database/connection.ts` |
| init.ts | 基线表 DDL（createTables）、默认 OUI seed、command_whitelist seed | `electron/database/init.ts` |
| migrations.ts | 版本化迁移注册表（`MIGRATION_HEAD=10`，原子步骤+幂等守卫） | `electron/database/migrations.ts` |
| services/device,ai,topology,… | 各业务域 CRUD + 领域逻辑，持有模块级 `MK`（masterKey） | `electron/services/*.ts` |
| services/commandSafety | 命令白名单语义校验（注入分隔符拦截 + 黑/白名单首词） | `electron/services/commandSafety.ts` |
| services/connection | SSH/Telnet/RDP/Web 远程连接会话管理（xterm 终端窗口） | `electron/services/connection.ts` |
| services/ai | AI 对话、配置加解密、命令执行确认流（exec_mode confirm/auto） | `electron/services/ai.ts` |
| services/experience* | 运维经验子系统：经验 CRUD + 设备关联 + bi-temporal 软失效 + 复用计数 | `electron/services/experienceService.ts` |
| services/experienceRetrieval | 经验检索：关键词/类别/设备聚合 + 精排候选召回（reuse_count tiebreaker） | `electron/services/experienceRetrieval.ts` |
| services/experienceRerank | 经验精排：LLM rerank（强 schema JSON 输出 + extractJsonArray 解析） | `electron/services/experienceRerank.ts` |
| services/experienceDrafting | 经验起草：从 AI 会话总结结构化 draft（status=draft，待人工 review） | `electron/services/experienceDrafting.ts` |
| services/draftingService | 起草编排（含 summarizeSessionForUi，落库交 IPC 层 createExperience） | `electron/services/draftingService.ts` |
| services/duplicateDetector | 经验查重：标题/内容相似度判定，hit 则 UPDATE duplicate_of_exp_id | `electron/services/duplicateDetector.ts` |
| utils/piiMask | PII 分级脱敏（纯字符串 transform，写库前 IPC 层调用） | `electron/utils/piiMask.ts` |
| preload.experience | 经验子系统 renderer 入口：16 方法（list/get/create/update/delete/invalidate/restore/relate/unrelate/setDevices/listByDevice/listDevices/summarizeSession/confirmDrafts/listDrafts/getSessionMessages） | `electron/preload.ts:124` |
| stores/authStore | renderer 登录/首启态（Zustand），调 `window.api.auth.*` | `src/stores/authStore.ts` |
| components/MainLayout | 顶层布局 + 路由分发到各 Page | `src/components/MainLayout.tsx` |

## Pattern Overview

**Overall:** Electron 三进程 + 分层单进程后端（IPC 网关 → 业务 service → 数据层），renderer 严格隔离（contextIsolation + sandbox），主进程是唯一持有 Node/DB/密钥的信任边界。

**Key Characteristics:**
- **单一信任边界**：masterKey 只存在于主进程内存；renderer 永远拿不到明文凭证，只拿脱敏后的 `****xxxx`。
- **字段级加密**：敏感列以 `_enc` 后缀存储 AES-256-GCM 密文，明文不落盘（见 `electron/database/init.ts` 的表定义）。
- **网关式鉴权**：所有特权 IPC 必须包 `secure(handler)`；登录前 IPC 用 `safe()`（仅脱敏）。
- **命令执行安全层**：AI/远程执行命令统一过 `isCommandAllowed()` 语义校验，exec_mode 决定 confirm/auto。
- **解密失败可观测（R2）**：`decField` 解密失败时通过注入的 handler 上报（限流去重），系统性失败（masterKey 不匹配 / safeStorage 翻转）写 `ai_system_logs`，避免历史密文无声变空。

## Layers

**IPC 网关层（Gateway）：**
- Purpose: 接收 renderer 请求，做鉴权 + 参数校验 + 异常脱敏，转发给 service。
- Location: `electron/ipc/*Ipc.ts`（模块化注册）+ `electron/main.ts`（inline 注册 device/topology/connection/ai/auth）。
- Contains: `ipcMain.handle(channel, secure(fn))` 注册语句、输入校验（如 `networkIpc.ts` 的 mask/IPv4 校验）。
- Depends on: `electron/utils/authGuard` 的 `secure()`，业务 service。
- Used by: renderer 经 `window.api.*` → preload `ipcRenderer.invoke`。

**业务层（Services）：**
- Purpose: 领域逻辑、DB 读写、字段加解密、外部协议（SSH/Telnet/LLM fetch）。
- Location: `electron/services/*.ts`（25 个文件，不含 `*.test.ts`）。
- Contains: 每个服务持有模块级 `MK`（masterKey）变量，由 `setXxxMasterKey()` 在启动时注入；纯函数 + better-sqlite3 同步语句。
- Depends on: `electron/database/connection.getDatabase()`、`electron/utils/crypto`、`electron/services/*` 互调（如 ai → commandSafety/knowledgeBaseService；experienceDrafting → experienceRerank/experienceRetrieval/experienceService；duplicateDetector → experienceService）。
- Used by: IPC 网关层。

**数据层（Database）：**
- Purpose: 持久化、迁移、文件 ACL。
- Location: `electron/database/`（`connection.ts`/`init.ts`/`migrations.ts`/`migrationHelpers.ts`/`acl.ts`）。
- Contains: better-sqlite3 单例、WAL pragma、基线 DDL、迁移注册表、`restrictFilePermissions`/`restrictDirPermissions`。
- Depends on: `electron/services/systemLog`、`electron/services/backupScheduler`（迁移前备份）。
- Used by: 业务层。

**工具层（Utils）：**
- Purpose: 横切安全原语。
- Location: `electron/utils/`（`crypto.ts`/`keyManager.ts`/`authGuard.ts`/`webSecurity.ts`）。
- Used by: 所有主进程层。

**渲染层（Renderer）：**
- Purpose: UI、状态、用户交互；无业务/无 Node。
- Location: `src/`（`components/{pages,topology,ip-management,settings}`、`stores/`、`types/`）。
- Depends on: 仅 `window.api.*`（preload 暴露）。状态用 Zustand（`src/stores/`），UI 用 Ant Design v6，拓扑画布用 React Flow。

## Data Flow

### Primary Request Path（典型：renderer 读设备列表）

1. renderer 调 `window.api.device.list()` → preload `ipcRenderer.invoke('device:list')` (`electron/preload.ts:11`)
2. main `ipcMain.handle('device:list', secure(() => listDevices()))` 命中鉴权中间件 (`electron/main.ts:147`、`electron/utils/authGuard.ts:31`)
3. `secure()` 校验 `authenticated`，未登录直接 reject `'未登录或会话已过期'`；通过则调 `listDevices()`
4. `listDevices` 读 DB 行，用模块 `MK` 经 `decField` 解密 `_enc` 字段，返回明文对象数组 (`electron/services/device.ts`、`electron/utils/crypto.ts:107`)
5. handler 异常被 `secure()` 捕获 → `console.error` 全量 + reject 脱敏 Error（移除路径/截断 200 字符）
6. 结果经 IPC 序列化回 renderer → Zustand store / 组件渲染

### Secondary Flow（AI 执行命令：最敏感路径）

1. renderer `window.api.ai.chat(messages, deviceIds, sessionId)` (`electron/preload.ts:39`)
2. `secure(chat(...))` → `electron/services/ai.ts` `chat()`
3. AI 产出命令 → `isCommandAllowed(command, whitelist)` 语义校验 (`electron/services/commandSafety.ts:24`)：分隔符拦截 → 黑名单首词 → 白名单首词严格相等
4. exec_mode=`confirm` 时生成 execId 写 `ai_exec_logs`，renderer 经 `ai:confirmCommand` 二次确认；`auto` 直接执行
5. 执行经 `connection` 服务走 SSH/Telnet stream；结果回写 log + 返回 renderer

### Third Flow（App 启动序列）

1. `app.whenReady()` (`electron/main.ts:60`)：注入 CSP（prod 严格 / dev 跳过兼容 HMR）、`web-contents-created` 弹窗转外链
2. `getOrCreateMasterKey()` 取/建 masterKey → 7 个 `setXxxMasterKey(masterKey)` 注入各 service（device/topology/connection/ai/arp/kb/**experience**）(`electron/main.ts:88-95`)；随后注入 R2 解密失败 handler `setDecryptFailureHandler`（写 `ai_system_logs` 告警）(`electron/main.ts:98`)
3. `initDatabase()`（WAL/foreign_keys/busy_timeout）→ `createTables()`（基线表 + seed）→ `migrateAndSecure()`（premigration 备份 gated on `dbPreExisted()` → `runMigrations` → 收紧 db/wal/shm ACL）(`electron/database/connection.ts:61`)；迁移后跑 `backfillSeverityFromHistory()`（`electron/main.ts:112`）解密 attrs_enc.severity 回填 v10 新增 severity 明文列（幂等 `severity IS NULL` 守卫，失败仅 warn 不阻塞启动）；其中含 `kb_chunks_fts` 启动自愈（integrity-check → rebuild）
4. `OUIService.preload()` 预载 vendor Map（消除首查 N+1），打印 `[startup] DB+OUI init` 耗时 (`electron/main.ts:136`)
5. 注册各 `register*Ipc()`（含 v1.1 新增 `registerExperienceIpc()`/`registerExperienceDraftingIpc()` @ `electron/main.ts:147-148`）→ 启动 `SchedulerService.start()` + `BackupScheduler.start()`
6. inline 注册 auth/device/topology/connection/ai IPC（`electron/main.ts:153-212`）→ `createWindow()`（`electron/main.ts:212`）

**State Management:**
- 主进程：模块级单例（`db`、`authenticated`、各 service 的 `MK`、`sessions`/`windowSessionMap`）— 进程内可变全局态。
- renderer：Zustand store（`src/stores/authStore.ts` 登录态、`topologyToolbarStore.ts` 工具栏态）。无 Redux/Context 全局树。
- 跨进程态：唯一通过 IPC 传递；登录态是主进程 `authenticated` boolean，renderer 用 `token` + store 镜像。

## Key Abstractions

**Master Key 注入（setXxxMasterKey 模式）：**
- Purpose: service 不直接持有 keyManager，启动时由 main 注入，便于测试与解耦。
- Examples: `setDeviceMasterKey`/`setAiMasterKey`/`setTopologyMasterKey`/`setConnectionMasterKey`/`setArpMasterKey`/`setKbMasterKey`/`setExperienceMasterKey` (`electron/main.ts:88-95`)
- Pattern: 每个服务文件顶部 `let MK = ''` + `export function setXxxMasterKey(key)`。

**secure() / safe() 中间件：**
- Purpose: 强制所有 IPC 走鉴权 + 脱敏；`secure`=鉴权+脱敏，`safe`=仅脱敏（登录前 handler）。
- Examples: `electron/utils/authGuard.ts`；`electron/main.ts` 全部特权 handler、`electron/ipc/*Ipc.ts`。

**解密失败 handler 注入（R2 setDecryptFailureHandler 模式）：**
- Purpose: `decField` 保持「单条坏密文不阻断列表加载」的降级语义，但系统性失败（masterKey 不匹配 / safeStorage 翻转）经注入 handler 限流上报，避免无声数据丢失；crypto.ts 不 import services/DB，保持纯函数可单测。
- Examples: `setDecryptFailureHandler` 定义于 `electron/utils/crypto.ts:102`，由 `main.ts` 启动时注入写 `ai_system_logs` 的实现 (`electron/main.ts:94-98`)。

**版本化迁移注册表：**
- Purpose: 顺序整数 `user_version`，每版本一个原子事务步骤，自带幂等守卫（`hasColumn` 或 `sqlite_master.sql` 特征串判定），`MIGRATION_HEAD=10`。v8/v9/v10 为 v1.1 经验子系统迁移：**v8** 建 `experiences` + `exp_device_rel`（含 attrs_enc/content_enc/device_name_enc 加密列 + bi-temporal valid_at/invalid_at 索引 + reuse_count/duplicate_of_exp_id/severity 预埋列）；**v9** 加 `experiences.duplicate_of_exp_id`（Phase 8 drafting UPDATE hit link）；**v10** 加 `experiences.severity` 明文列（支撑浏览页 SQL 直筛/排序，service 层 rowToExperience fallback attrs.severity 保历史可读）。
- Examples: `electron/database/migrations.ts`、`electron/database/migrationHelpers.ts`。

**远程会话映射：**
- Purpose: 终端窗口 ↔ SSH/Telnet 会话绑定，按 webContents.id 隔离注入。
- Examples: `sessions: Map<sessionId, ActiveSession>`、`windowSessionMap: Map<webContentsId, sessionId>` (`electron/services/connection.ts:31-32`)。

## Entry Points

**Main Process:**
- Location: `electron/main.ts`
- Triggers: Electron `app.whenReady()`
- Responsibilities: 安全加固、密钥注入（7 service）、R2 解密失败 handler 注入、DB 初始化+迁移、severity 回填钩子、IPC 注册（含 experience/experienceDrafting）、调度器启动、主窗口创建。

**Preload:**
- Location: `electron/preload.ts`（主窗口）、`electron/terminal-preload.ts`（终端窗口）
- Triggers: BrowserWindow `webPreferences.preload`
- Responsibilities: 暴露白名单 `window.api`。

**Renderer:**
- Location: `src/main.tsx`（主）、`src/terminal-main.tsx`（终端窗口入口）、`src/App.tsx`（首启/登录/主布局分流）
- Triggers: `index.html` / `terminal.html` 加载
- Responsibilities: React 渲染、Ant Design ConfigProvider、ErrorBoundary 包裹。

## Architectural Constraints

- **进程模型:** 三进程；main 是唯一 Node/DB/密钥信任边界；renderer `contextIsolation:true` + `sandbox:true` + `nodeIntegration:false`（`electron/main.ts:36-41`）。
- **线程模型:** 主进程单线程事件循环；better-sqlite3 同步语句会阻塞主线程（`crypto.deriveKey` 用 LRU 缓存缓解 PBKDF2 10 万次开销，`electron/utils/crypto.ts:13`）。无 worker threads。
- **全局状态:** `electron/database/connection.ts` 的 `db` 单例；`electron/utils/authGuard.ts` 的 `authenticated`；各 service 的 `MK`；`electron/services/connection.ts` 的 `sessions`/`windowSessionMap`；`electron/services/schedulerService.ts`/`backupScheduler.ts` 的定时器实例。
- **加密兼容:** masterKey 值永不变（保证历史密文可解）；`decrypt` 兼容 v1（16B IV 无前缀）与 v2（12B IV + `v2:` 前缀）两种密文格式（`electron/utils/crypto.ts:41`）。
- **迁移原子性:** 每迁移步骤包单事务，throw 即 ROLLBACK；不得仅靠版本号判定，必须自带幂等守卫（`electron/database/migrations.ts:24-29`，幂等守卫两形式：`hasColumn(db, table, col)` 与 `sqlite_master.sql` 特征串）。
- **CSP:** 生产严格 `script-src 'self'`；dev 跳过以兼容 Vite HMR（`electron/main.ts:59-74`）。

## Anti-Patterns

### 在 init.ts 散落迁移逻辑

**What happens:** 历史上 DDL/迁移散落在 `init.ts` 的多个 `ALTER` 块中。
**Why it's wrong:** 多个真相源、难追踪版本、难安全重跑。
**Do this instead:** 所有迁移收敛进 `electron/database/migrations.ts` 注册表（v1-v10），`init.ts` 只保留基线 `CREATE TABLE IF NOT EXISTS` + seed（见 `electron/database/init.ts:286-292` 注释；v1.1 `experiences`/`exp_device_rel` 基线 DDL 也在此，迁移只负责幂等守卫 + 版本推进）。

### renderer 直接持有明文凭证

**What happens:** 不应发生 — 任何让明文 apiKey/password 流向 renderer 的设计都违反信任边界。
**Why it's wrong:** renderer 有 XSS 风险（虽 CSP 严格），明文凭证一旦泄露即设备失守。
**Do this instead:** renderer 只接收 `getAiConfigMasked()` 的 `****xxxx` 脱敏形式（`electron/services/ai.ts:39`）；明文仅存主进程内存用于 fetch。

### service 直接读 keyManager

**What happens:** service 自行 `getOrCreateMasterKey()` 会绕过统一注入与测试替身。
**Do this instead:** 一律经 `setXxxMasterKey()` 由 `main.ts` 启动时注入（`electron/main.ts:88-95`，7 个 service）。

### 仅靠表行数判定 fresh-install vs 遗留库

**What happens:** 历史按核心表行数判断是否做 premigration 备份。
**Why it's wrong:** 纯 IP 监控数据旧库（arp_entries 有行、devices 空）会被误判为空库，跳过备份安全网。
**Do this instead:** 用 `dbPreExisted()`（DB 文件打开前是否存在）门控（`electron/database/connection.ts:14,45,67`，CR-02）。

## Experience Subsystem (v1.1, Phase 7-11)

运维经验沉淀子系统：从 AI 会话总结结构化经验，存库（bi-temporal 软失效 + 复用计数 + severity 明文列），AI 助手检索复用，引用溯源回原会话。

**数据层（2 表 + 加密列扩展）:**
- `experiences`：经验主表。加密列 `attrs_enc`（结构化 troubleshooting 处置，含命令/标签，AES-256-GCM）、`content_enc`（正文）、`device_name_enc`（关联设备名快照）；明文列 `severity`（v10，浏览 SQL 直筛/排序）、`duplicate_of_exp_id`（v9，起草查重 hit link）；bi-temporal `valid_at`/`invalid_at`（各建索引，支撑「有效检索」过滤）；预埋 `source_session_id`/`last_verified_at`/`reuse_count`。DDL 在 `electron/database/init.ts:294`，迁移 v8/v9/v10 在 `electron/database/migrations.ts:194-278`。
- `exp_device_rel`：经验↔设备多对多关联（`experience_id`/`device_id`/`relation_type`，FK CASCADE）。DDL 在 `electron/database/init.ts:321`。

**业务层（6 service + 1 util）:**
- `experienceService.ts`：经验 CRUD + 设备关联 + 软失效/恢复 + `reuse_count` 自增 + `backfillSeverityFromHistory()`（MK 注入后回填 v10 severity 明文列，幂等）。持模块级 `MK`，经 `setExperienceMasterKey()` 注入。
- `experienceRetrieval.ts`：检索召回（关键词/类别/设备聚合 → 候选集，reuse_count tiebreaker 稳排序）。
- `experienceRerank.ts`：LLM 精排（强 schema JSON 输出，`extractJsonArray` 解析，RELEVANCE_THRESHOLD 过滤 + 重试）。
- `experienceDrafting.ts` + `draftingService.ts`：起草编排（`summarizeSessionForUi` 从 AI 会话结构化 draft，status=`draft` 待人工 review）。
- `duplicateDetector.ts`：标题/内容相似度查重，hit 则 UPDATE `duplicate_of_exp_id`。
- `utils/piiMask.ts`：PII 分级脱敏（纯字符串 transform，写库前 IPC 层先调用，不依赖 MK/DB）。

**IPC 网关层（全 secure，无 safe）:**
- `electron/ipc/experienceIpc.ts`：15 个 `experience:*` channel（list/get/create/update/delete/invalidate/restore/relateDevice/unrelateDevice/setDevices/listByDevice/listDevices/confirmDrafts/listDrafts/getSessionMessages），全 `secure()` 包装（鉴权 + 异常脱敏），无登录前 channel（经验涉敏感 attrs/凭证片段）。
- `electron/ipc/experienceDraftingIpc.ts`：1 个 channel `experience:summarizeSession`（`secure()` 包装）。
- inline 注册不在 main.ts，而是经 `registerExperienceIpc()`/`registerExperienceDraftingIpc()`（`electron/main.ts:147-148`）。

**preload 暴露:**
- `window.api.experience` 命名空间 16 方法（`electron/preload.ts:124-141`），覆盖上述 16 channel。

**masterKey 注入序列（7 个）:**
- `setExperienceMasterKey(masterKey)` 是第 7 个注入（`electron/main.ts:95`），紧跟 6 个 v1.0 service。

**数据流（经验起草→入库→检索复用）:**
1. renderer `window.api.experience.summarizeSession(sessionId)` → `experience:summarizeSession`（secure）→ `experienceDrafting.summarizeSession()` → LLM 产 draft → IPC 层 `piiMask` 脱敏 → `createExperience(status='draft')`（同时 `duplicateDetector` 判重，hit 设 `duplicate_of_exp_id`）。
2. renderer `window.api.experience.listDrafts()` + `confirmDrafts(input)`（Phase 9 人工 review，confirm 后 status 由 draft 转 active）。
3. AI 助手对话时，`experienceRetrieval.retrieve()` 按 query 召回候选 → `experienceRerank.rerank()` LLM 精排 → 命中经验附 `references`（source_session_id 溯源）注入 AI prompt 上下文，命中即 `reuse_count++`。

## Error Handling

**Strategy:** 边界统一脱敏 + 内部全量日志。

**Patterns:**
- IPC handler 抛错 → `secure()`/`safe()` 捕获 → `console.error('[ipc] handler error:', err)` 全量 + reject `sanitizeMessage(err.message)`（移除 Windows/Unix 绝对路径、截断 200 字符）（`electron/utils/authGuard.ts:17-24,36-38`）。
- 单条坏密文不阻断整列表：`decField` 解密失败降级返回空串并 `console.error`，同时经注入的 handler 限流上报系统性失败（`electron/utils/crypto.ts:107-122`）。
- 迁移失败抛出 + `createSystemLog` + 中止，DB 停留前版本（`electron/database/migrations.ts`、Plan 01 D-08）。

## Cross-Cutting Concerns

**Logging:** `console.*` 为主；关键系统事件（迁移/备份/发现/ACL/解密失败告警）写 `ai_system_logs` 表（`electron/services/systemLog.ts`）。AI 执行审计写 `ai_exec_logs`（`electron/services/aiExecLogger.ts`）。冷启动 DB+OUI 耗时打印 `[startup]` 日志（`electron/main.ts:123`，PERF-04）。
**Validation:** IPC 网关层做参数校验（如 `electron/ipc/networkIpc.ts` 的 IPv4/mask 校验）；`commandSafety` 做命令语义校验。
**Authentication:** 单机登录态 — `auth:login` 成功置主进程 `authenticated=true`（`electron/main.ts:156`）；renderer 侧 Zustand 镜像（`src/stores/authStore.ts`）。首次运行 `auth:isFirstRun` → `InitAdmin` 引导建管理员。密码用 PBKDF2 hash（`electron/utils/crypto.ts:56`）。

---

*Architecture analysis: 2026-08-07 (v1.1 经验子系统增量更新)*
