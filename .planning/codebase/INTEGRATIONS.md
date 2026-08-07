# External Integrations

**Analysis Date:** 2026-07-26 · **2026-08-07 增量刷新**（v1.1 Phases 7-11 落地后 drift 修正：CI 补录 / experiences 表 / LLM 经验集成点 / 行号漂移）

## APIs & External Services

**LLM (OpenAI 兼容 Chat Completions):**
- 用途：AI 运维助手对话 + 设备命令生成/执行结果分析 + 知识库问答 + **v1.1 经验起草/复判/精排/检索编排**
- 客户端：主进程 `fetch`（无 SDK，裸 HTTP）— `electron/services/ai.ts:259` `callAI()`
- 端点：`${baseUrl}/chat/completions`，POST，`Authorization: Bearer ${apiKey}`
- 请求体：`{ model, messages }`（非 streaming）
- 配置来源：SQLite `ai_config` 表（字段全部 AES-256-GCM 加密存储：`provider_enc`/`api_key_enc`/`base_url_enc`/`model_name_enc` 等）— `getAiConfig()` 解密读取
- 默认 provider 占位：火山方舟 `ark.cn-beijing.volces.com`（仅作为 vite dev proxy 默认 target `VITE_AI_PROXY_TARGET`，实际 baseUrl 由用户配置）
- 认证密钥：master key 派生（见 Authentication 段），运行时内存 `MK` 变量（`setAiMasterKey`）

**Vision LLM (图像理解，独立端点):**
- 用途：知识库文档中图片描述（供 AI 引用 `[图片N]` 标记）— `electron/services/knowledgeBaseService.ts` `describeImage()`
- 配置：`ai_config` 表 `vision_base_url_enc`/`vision_api_key_enc`/`vision_model_enc`（与文本 LLM 可分别配置不同 provider；`getVisionConfig()` 缺省回退到文本 LLM 的 baseUrl/apiKey）
- 调用：`knowledgeBaseService.ts` 主进程 `fetch` POST `${visionBaseUrl||baseUrl}/chat/completions`，请求体含 `image_url`（base64 data URL）

**v1.1 经验子系统 LLM 集成点（Phases 8/11，全部走 `callAI()` + 强 schema 解析）:**
- **经验起草两阶段编排（Phase 8）:**
  - 阶段 A 纯起草：`draftingService.ts:166` `draftSession()` → `callAI()` → `validateDrafts()` 强 schema JSON 解析（draftingService.ts:106），失败拒绝落库
  - 阶段 B 复判：`draftingService.ts:277` `judgeVerdicts()` → `callAI()` → `validateVerdicts()`（draftingService.ts:232），按 draft.category 窄查喂 LLM，覆盖 verdict + dupId
  - 编排入口：`experienceDrafting.ts:70` `summarizeSessionForUi()` 串接两阶段，IPC `experience:summarizeSession`（experienceDraftingIpc.ts:19）
  - **PII 分级脱敏送 LLM：** `electron/utils/piiMask.ts`（`maskCredentials`/`maskIpv4`/`maskMac`/`maskConversationText`，纯字符串 transform，无 DB 依赖），会话正文进起草 prompt 前先脱敏
- **经验精排（Phase 11）:**
  - `experienceRerank.ts:120` `rerank()` 粗筛候选喂精排 LLM 强 schema 打分（每条 `{exp_id, score, reason}`，score 边界归一化）；`extractJsonArray`（experienceRerank.ts:57）+ `validateRerank`（experienceRerank.ts:78）；`RELEVANCE_THRESHOLD=0.6`（experienceRerank.ts:19）
- **经验检索注入 + 引用溯源（Phase 11）:**
  - `experienceRetrieval.ts:55` `retrieveForAnswer()` 编排：粗筛（listExperiences by category/device）→ 精排（rerank）→ 阈值过滤（score >= RELEVANCE_THRESHOLD）→ top INJECT_LIMIT 条注入 chat prompt + `incReuseCount`/`touchLastVerifiedAt` 更新复用计数
  - 引用溯源：检索命中的经验作为 `[引用]` 标记注入 AI 回复，ChatMessageList 渲染可点击引用（详见 STACK.md experience 能力栈）

**工具调用约定（非标准 function-calling，自定义文本协议）:**
- AI 回复中嵌入标记由 `chat()` 正则解析（行号为 2026-08-07 实测，整体较 2026-07-26 漂移 +30~120 行）：
  - `[CMD:设备名]命令[/CMD]` / `[CMD]命令[/CMD]` → SSH 执行（`ai.ts:835` `cmdRegex`，2026-07-26 为 ai.ts:727）
  - `[KB_SEARCH]关键词[/KB_SEARCH]` → 知识库检索（`ai.ts:777` 正则匹配，命中后 `ai.ts:784` 调 `kbSearch`；2026-07-26 为 ai.ts:669/676）
- 命令执行受 `command_whitelist` 白名单 + `isCommandAllowed()` 强制校验（`electron/services/commandSafety.ts`）— 执行层兜底，见 `executeCommandsOnDevice` `ai.ts:324`（2026-07-26 为 ai.ts:290）；`buildSSHConfig` 行号 `ai.ts:306`（2026-07-26 为 ai.ts:280）
- 执行模式：`confirm`（默认，pending→用户确认） / `auto`（自动执行）— `ai_config.exec_mode`，切换需 admin 密码二次验证 (`setExecMode` `ai.ts:109`)
- **v1.1：经验引用标记（Phase 11）作为新的回复内嵌协议补充上述两条。**

## Data Storage

**Databases:**
- SQLite (better-sqlite3, 单文件嵌入式 DB)
  - 文件路径：`app.getPath('userData')/topology.db`（含 `-wal` / `-shm`）— `electron/database/connection.ts:22`
  - 连接配置：`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `wal_autocheckpoint=1000` (`connection.ts:25-28`)
  - Schema：`electron/database/init.ts` `createTables()`，2026-08-07 实测表清单（v1.1 后）：users, topologies, devices, ai_config, command_whitelist, ai_exec_logs, chat_history, chat_sessions, ai_system_logs, arp_entries, network_segments, ip_mac_bindings, ip_mac_changes, excluded_ips, oui_database, ip_status, scheduler_config, backup_config, kb_documents, kb_chunks, kb_images, kb_chunks_fts(FTS5), **experiences**（v1.1 Phase 7 新增，init.ts:294-319）, **exp_device_rel**（v1.1 Phase 7 新增，init.ts:321-332） 等
  - **`experiences` 表（v1.1，运维经验沉淀，bi-temporal + 复用计数 + 软失效）:**
    - 列：`id`(PK TEXT), `title`(TEXT NOT NULL), `category`(TEXT, CHECK in troubleshooting/best_practices/product/env), `content`(TEXT), `tags`(TEXT JSON array), `status`(TEXT, CHECK in draft/confirmed/published/invalid), `source_session_id`(TEXT FK→chat_sessions ON DELETE SET NULL), `attrs_enc`(TEXT AES-256-GCM 加密扩展字段), `duplicate_of_exp_id`(TEXT nullable, v1.1 Phase 8 migrations v9 新增, 链向存量命中), `severity`(TEXT nullable, v1.1 Phase 10 migrations v10 新增, browse filter/sort), `valid_at`(TEXT NOT NULL), `invalid_at`(TEXT nullable, bi-temporal 软失效), `last_verified_at`(TEXT nullable), `reuse_count`(INTEGER NOT NULL DEFAULT 0, 检索复用计数), `created_at`/`updated_at`
    - 索引：idx_experiences_category / idx_experiences_status / idx_experiences_valid / idx_experiences_invalid / idx_experiences_source_session
  - **`exp_device_rel` 表（v1.1，经验↔设备多对多关系）:**
    - 列：`id`(PK), `experience_id`(TEXT FK→experiences ON DELETE CASCADE), `device_id`(TEXT FK→devices ON DELETE CASCADE), `relation_type`(TEXT DEFAULT 'primary'), `created_at`，UNIQUE(experience_id, device_id)
    - 索引：idx_exp_device_rel_exp / idx_exp_device_rel_device
  - 迁移：`electron/database/migrations.ts` — **`MIGRATION_HEAD=10`**（v1.1 后，2026-07-26 为 7），顺序 `user_version`，每步 `db.transaction` + `hasColumn`/`sqlite_master.sql` 幂等守卫；调用入口 `migrateAndSecure()` (`connection.ts:61`)，迁移前对遗留库做 premigration 备份（gated on `dbPreExisted()`，fresh-install 空库跳过）
    - v8: experiences + exp_device_rel 建表（Phase 7）
    - v9: experiences.duplicate_of_exp_id（Phase 8 drafting UPDATE 命中链接）
    - v10: experiences.severity（Phase 10 browse filter/sort）
  - 客户端：`better-sqlite3` 同步 API (`db.prepare().run/get/all`)
  - 权限：启动后 `restrictFilePermissions` 收紧 db/wal/shm 文件 ACL (`acl.ts`)

**File Storage (本地文件系统):**
- 知识库原文：`userData/kb_files/<uuid>.<ext>` — `knowledgeBaseService.ts` `kbDir()`
- 知识库提取图片：`userData/kb_images/` — `imgDir()`
- 数据库备份：`userData/backups/` — `ensureBackupsDir()` + `BackupScheduler`（定时 + premigration 备份，`electron/services/backupScheduler.ts`）
- RDP 临时文件：`os.tmpdir()/rdp_<id>.rdp`（一次性，`connection.ts:390`）

**Caching:**
- 内存级：
  - OUI 厂商映射 Map（`electron/services/ouiService.ts` `preload()`，启动全量载入 `oui_database`，O(1) 查找消除 N+1）
  - 派生密钥 LRU 缓存（`electron/utils/crypto.ts:13` `derivedKeyCache`，max 2048，避免重复 pbkdf2 10 万次）
  - 终端会话 Map（`connection.ts:31` `sessions` / `windowSessionMap`）
  - AI 待确认命令批次 Map（`ai.ts` `pendingBatches`，TTL 10 分钟）
- 无远端缓存服务（Redis 等未使用）

## Authentication & Identity

**本应用 Auth (本地单用户 admin):**
- 实现方式：自建，`electron/services/auth.ts`（登录 + 验证码 + 首次初始化 admin）
- 密码哈希：PBKDF2-SHA512，100000 轮，64 字节 salt — `electron/utils/crypto.ts:56` `hashPassword` / `verifyPasswordSync`（含长度上限 DoS 防护 + timingSafeEqual）
- IPC 鉴权网关：`electron/utils/authGuard.ts:31` `secure()` 包装器 — 所有敏感 `ipcMain.handle` 经 `secure(...)` 登录态校验 + 异常脱敏；登录前 `auth:*` 通道用 `safe(...)`（仅脱敏、不鉴权，authGuard.ts:44）开放（`main.ts:153/154/159/160`：`auth:getCaptcha`/`auth:login`/`auth:isFirstRun`/`auth:initAdmin` 经 safe，2026-07-26 文档行号 137-144 已漂移；登录后置登录态）
- 渲染进程登录态：`src/stores/authStore.ts` (Zustand)

**字段级加密 (敏感数据 at-rest):**
- 算法：AES-256-GCM，PBKDF2-SHA512 派生 key（100000 轮，64 字节 salt）— `electron/utils/crypto.ts`
- 密文格式：`v2:` 前缀 + 12 字节 IV（新）兼容历史 16 字节 IV（无前缀旧密文）— 向后兼容
- 加密字段：devices 几乎全部业务字段（`name_enc`/`vendor_enc`/`model_enc`/`version_enc`/`ip_enc`/`port_enc`/`username_enc`/`password_enc`/`ssh_key_path_enc`/`ssh_key_content_enc`/`web_url_enc`）、ai_config 全字段（含 `vision_*_enc`）、`chat_history.content_enc`、`ai_exec_logs`（`prompt_text`/`ai_response`）、**`experiences.attrs_enc`（v1.1）** 等
- Master Key：`getOrCreateMasterKey()` (`electron/utils/keyManager.ts`)，启动注入各 service 的 `setXxxMasterKey(MK)`（device/topology/connection/ai/arp/kb/**experience** 共享同一 MK，v1.1 新增 `setExperienceMasterKey` experienceService.ts:29）；R3 加固：读取前校验合法 base64 32 字节，safeStorage 翻转时显式抛错而非把 DPAPI blob 当明文

**SSH 设备认证:**
- 密钥认证优先（`sshKeyContent` → `sshKeyPath` → 回退 `password`）— `ai.ts:306` `buildSSHConfig`（非交互命令执行路径，2026-07-26 行号 272）；交互式终端会话 `connection.ts` 内联构造 ConnectConfig，同样的密钥优先顺序（非复用 buildSSHConfig）
- `CLAUDE.md` 安全规范：SSH 推荐密钥认证（产品同时支持密钥 + 密码双通道，密钥优先）

## Monitoring & Observability

**Error Tracking:** 无外部 Sentry 等。错误进 `console.error` + `ai_system_logs` 表（`electron/services/systemLog.ts` `createSystemLog`，INSERT 进 `ai_system_logs`），UI 经 `ai:getSystemLogs` (`main.ts:210`) / `LogAuditPage.tsx` 审计。R2 加固：`decField` 解密失败经 `setDecryptFailureHandler` 写 `ai_system_logs` 告警，避免无声数据丢失。

**Logs:**
- 应用日志：SQLite `ai_system_logs`（type/status/errorMessage，type ∈ discovery/acl/migration/backup/security），含备份、迁移、安全事件
- AI 命令执行审计：`ai_exec_logs` 表（status: pending/approved/rejected/executed/failed，mode: confirm/auto，含 prompt_text/ai_response 全量留痕）— `electron/services/aiExecLogger.ts`
- 冷启动计时：`[startup] DB+OUI init <ms>` console 输出（`main.ts`，PERF-04 证据 grep 点）

## CI/CD & Deployment

**Hosting:** 本地 Windows 桌面（无云端部署）

**CI Pipeline（2026-08-07 补录，修正 2026-07-26「未检测到」错误断言）:**
- **GitHub Actions：** `.github/workflows/build-smoke.yml`（workflow name `build-smoke`）
- **触发：** push 到 master / PR 到 master / `workflow_dispatch` 手动
- **Runner：** `windows-latest`，Node 20，`cache: npm`
- **步骤：** `npm ci` → `npm run rebuild:native`（显式 native rebuild，见下）→ `npm run build` → `npm test` → 校验 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` + `dist-electron/main.js` 存在
- **目的：** P1-c 防护 `better-sqlite3`/`ssh2` native binding ABI 静默失配（CONCERNS DEP-1）—— CI 跑 rebuild + build + test + 验证 `.node` 产物，未来 native 版本升级或 ABI 变化会被 CI 拦截
- **本地 native rebuild：** `npm run rebuild:native` = `electron-rebuild -f -w better-sqlite3 -w ssh2`（强制按 Electron ABI 重建两个 native 包），CI 与本地 `electron:build` 前置均经此
- **当前 gap：** CI 不打 installer（electron-builder NSIS）—— 慢 + 需签名配置，留作后续扩展（见 CONCERNS DEP-1 + 2026-08-07-health-audit §1.2 medium「CI 不打 installer，native ABI 静默失配防护未完整闭环」）；后续扩展为打 installer 并校验 asarUnpack 含 `.node`
- **完整构建（本地）：** `npm run electron:build` → `tsc -p tsconfig.web.json && vite build && build:electron && electron-builder`

**GitHub 上传规范 (CLAUDE.md):** push 前强制敏感信息扫描（LLM Key / 账号密码 / 证书）；公开仓库禁传，私有仓库列出清单提醒。

## Environment Configuration

**Required env vars:**
- 运行时：无强制硬性 env（所有配置落 SQLite / userData 文件）
- 开发可选：`NODE_ENV=development`（dev 行为分支）、`VITE_AI_PROXY_TARGET`（vite dev AI 代理 target）
- CI：`actions/setup-node@v4` node-version 20（build-smoke.yml）

**Secrets location:**
- 应用密钥：`app.getPath('userData')` 下 master key 文件（`keyManager.ts`），文件 ACL 收紧
- AI / 设备凭据：SQLite `topology.db` 内字段级 AES-256-GCM 加密存储
- `.env` 文件：**不存在**（项目不依赖 .env，配置走运行时 UI 录入）
- GitHub Actions secrets：未使用（build-smoke.yml 无 secret 引用）

## Webhooks & Callbacks

**Incoming:** 无（无 HTTP 服务端监听）

**Outgoing:**
- LLM/Vision API 调用（用户配置的 baseUrl，主进程 `fetch`）— 含 v1.1 经验起草/复判/精排三类 LLM 调用（draftSession/judgeVerdicts/rerank，均经 callAI）
- SSH (`ssh2`) / Telnet 出站到设备 IP:port — Telnet 分两种实现：交互式终端会话用 node 内置 `net` 模块（`connection.ts` import / `net.Socket`）；ARP 采集非交互用 npm 包 `telnet-client`（`arpCollector.ts` `import { Telnet } from 'telnet-client'`）
- Web 设备：`shell.openExternal(url)`（仅 http/https 协议，`openWebSafe` → `openExternalSafe`）
- RDP：`child_process.execFile('mstsc', ['<tmp.rdp>'], { shell: false })` (Windows)
- Dev only：vite proxy `/proxy/ai → <AI provider>`

---

*Integration audit: 2026-07-26 · 增量刷新 2026-08-07（v1.1 Phases 7-11 落地后：CI 补录 build-smoke.yml + rebuild:native / experiences+exp_device_rel 两表 / 经验 LLM 集成点 / 行号漂移对齐）*
