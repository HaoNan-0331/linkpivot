# External Integrations

**Analysis Date:** 2026-06-28

## APIs & External Services

**LLM (OpenAI 兼容 Chat Completions):**
- 用途：AI 运维助手对话 + 设备命令生成/执行结果分析 + 知识库问答
- 客户端：主进程 `fetch`（无 SDK，裸 HTTP）— `electron/services/ai.ts:228` `callAI()`
- 端点：`${baseUrl}/chat/completions`，POST，`Authorization: Bearer ${apiKey}`
- 请求体：`{ model, messages }`（非 streaming）
- 配置来源：SQLite `ai_config` 表（字段全部 AES-256-GCM 加密存储：`provider_enc`/`api_key_enc`/`base_url_enc`/`model_name_enc` 等）— `getAiConfig()` 解密读取
- 默认 provider 占位：火山方舟 `ark.cn-beijing.volces.com`（仅作为 vite dev proxy 默认 target `VITE_AI_PROXY_TARGET`，实际 baseUrl 由用户配置）
- 认证密钥：master key 派生（见 Authentication 段），运行时内存 `MK` 变量（`setAiMasterKey`）

**Vision LLM (图像理解，独立端点):**
- 用途：知识库文档中图片描述（供 AI 引用 `[图片N]` 标记）— `electron/services/knowledgeBaseService.ts`
- 配置：`ai_config` 表 `vision_base_url_enc`/`vision_api_key_enc`/`vision_model_enc`（与文本 LLM 可分别配置不同 provider）
- 调用：经 `getAiConfig()` 解密后由 knowledgeBaseService 调用

**工具调用约定（非标准 function-calling，自定义文本协议）:**
- AI 回复中嵌入标记由 `chat()` 正则解析：
  - `[CMD:设备名]命令[/CMD]` / `[CMD]命令[/CMD]` → SSH 执行（`ai.ts:663` `cmdRegex`）
  - `[KB_SEARCH]关键词[/KB_SEARCH]` → 知识库检索（`ai.ts:605`，调 `kbSearch`）
- 命令执行受 `command_whitelist` 白名单 + `isCommandAllowed()` 强制校验（`electron/services/commandSafety.ts`）— 执行层兜底，见 `executeCommandsOnDevice` `ai.ts:308`
- 执行模式：`confirm`（默认，pending→用户确认） / `auto`（自动执行）— `ai_config.exec_mode`，切换需 admin 密码二次验证 (`setExecMode`)

## Data Storage

**Databases:**
- SQLite (better-sqlite3, 单文件嵌入式 DB)
  - 文件路径：`app.getPath('userData')/topology.db`（含 `-wal` / `-shm`）— `electron/database/connection.ts:22`
  - 连接配置：`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `wal_autocheckpoint=1000` (`connection.ts:25-28`)
  - Schema：`electron/database/init.ts` `createTables()`（devices, topologies, connections, users, ai_config, chat_sessions, chat_history, ai_exec_logs, command_whitelist, kb_documents, kb_chunks, kb_images, arp_entries, network_segments, anomalies, oui_database, system_logs, backups 等）
  - 迁移：`electron/database/migrations.ts` — `MIGRATION_HEAD=7`，顺序 `user_version`，每步 `db.transaction` + `hasColumn` 幂等守卫；调用入口 `migrateAndSecure()` (`connection.ts:61`)，迁移前对遗留库做 premigration 备份
  - 客户端：`better-sqlite3` 同步 API (`db.prepare().run/get/all`)
  - 权限：启动后 `restrictFilePermissions` 收紧 db/wal/shm 文件 ACL (`acl.ts`)

**File Storage (本地文件系统):**
- 知识库原文：`userData/kb_files/<uuid>.<ext>` — `knowledgeBaseService.ts` `kbDir()`
- 知识库提取图片：`userData/kb_images/` — `imgDir()`
- 数据库备份：`userData/backups/` — `ensureBackupsDir()` + `BackupScheduler`（定时 + premigration 备份，`electron/services/backupScheduler.ts`）
- RDP 临时文件：`os.tmpdir()/rdp_<id>.rdp`（一次性，`connection.ts:398`）

**Caching:**
- 内存级：
  - OUI 厂商映射 Map（`electron/services/ouiService.ts` `preload()`，启动全量载入 `oui_database`，O(1) 查找消除 N+1）
  - 派生密钥 LRU 缓存（`electron/utils/crypto.ts:13` `derivedKeyCache`，max 2048，避免重复 pbkdf2 10 万次）
  - 终端会话 Map（`connection.ts:31` `sessions` / `windowSessionMap`）
  - AI 待确认命令批次 Map（`ai.ts:421` `pendingBatches`，TTL 10 分钟）
- 无远端缓存服务（Redis 等未使用）

## Authentication & Identity

**本应用 Auth (本地单用户 admin):**
- 实现方式：自建，`electron/services/auth.ts`（登录 + 验证码 + 首次初始化 admin）
- 密码哈希：PBKDF2-SHA512，100000 轮，64 字节 salt — `electron/utils/crypto.ts:56` `hashPassword` / `verifyPasswordSync`（含长度上限 DoS 防护 + timingSafeEqual）
- IPC 鉴权网关：`electron/utils/authGuard.ts` `secure()` 包装器 — 所有敏感 `ipcMain.handle` 经 `secure(...)` 登录态校验 + 异常脱敏；登录前仅 `auth:*` 通道开放 (`main.ts:106-113`)
- 渲染进程登录态：`src/stores/authStore.ts` (Zustand)

**字段级加密 (敏感数据 at-rest):**
- 算法：AES-256-GCM，PBKDF2-SHA512 派生 key（100000 轮，64 字节 salt）— `electron/utils/crypto.ts`
- 密文格式：`v2:` 前缀 + 12 字节 IV（新）兼容历史 16 字节 IV（无前缀旧密文）— 向后兼容
- 加密字段：devices 几乎全部业务字段（name/vendor/model/version/ip/port/username/password/ssh_key_path/ssh_key_content）、ai_config 全字段、chat_history.content、ai_exec_logs（prompt/response）等
- Master Key：`getOrCreateMasterKey()` (`electron/utils/keyManager.ts`)，启动注入各 service 的 `setXxxMasterKey(MK)`（device/topology/connection/ai/arp/kb 共享同一 MK）

**SSH 设备认证:**
- 密钥认证优先（`sshKeyContent` → `sshKeyPath` → 回退 `password`）— `ai.ts:298` `buildSSHConfig` / `connection.ts:162`
- `CLAUDE.md` 安全规范：SSH 必须密钥认证

## Monitoring & Observability

**Error Tracking:** 无外部 Sentry 等。错误进 `console.error` + `system_logs` 表（`electron/services/systemLog.ts` `createSystemLog`），UI 经 `ai:getSystemLogs` / `LogAuditPage.tsx` 审计。

**Logs:**
- 应用日志：SQLite `system_logs`（type/status/errorMessage），含备份、迁移、安全事件
- AI 命令执行审计：`ai_exec_logs` 表（status: pending/approved/rejected/executed/failed，含 prompt_text/ai_response 全量留痕）— `electron/services/aiExecLogger.ts`
- 冷启动计时：`[startup] DB+OUI init <ms>` console 输出 (`main.ts:92`, PERF-04 证据 grep 点)

## CI/CD & Deployment

**Hosting:** 本地 Windows 桌面（无云端部署）

**CI Pipeline:** 未检测到（无 `.github/workflows`、无 CI 配置）。构建完全本地：`npm run electron:build` → `tsc -p tsconfig.web.json && vite build && build:electron && electron-builder`

**GitHub 上传规范 (CLAUDE.md):** push 前强制敏感信息扫描（LLM Key / 账号密码 / 证书）；公开仓库禁传，私有仓库列出清单提醒。

## Environment Configuration

**Required env vars:**
- 运行时：无强制硬性 env（所有配置落 SQLite / userData 文件）
- 开发可选：`NODE_ENV=development`（dev 行为分支）、`VITE_AI_PROXY_TARGET`（vite dev AI 代理 target）

**Secrets location:**
- 应用密钥：`app.getPath('userData')` 下 master key 文件（`keyManager.ts`），文件 ACL 收紧
- AI / 设备凭据：SQLite `topology.db` 内字段级 AES-256-GCM 加密存储
- `.env` 文件：**不存在**（项目不依赖 .env，配置走运行时 UI 录入）

## Webhooks & Callbacks

**Incoming:** 无（无 HTTP 服务端监听）

**Outgoing:**
- LLM/Vision API 调用（用户配置的 baseUrl，主进程 `fetch`）
- SSH (`ssh2`) / Telnet (`net`/`telnet-client`) 出站到设备 IP:port
- Web 设备：`shell.openExternal(url)`（仅 http/https 协议，`openWebSafe`）
- RDP：`child_process.exec('mstsc "<tmp.rdp>"')` (Windows)
- Dev only：vite proxy `/proxy/ai → <AI provider>`

---

*Integration audit: 2026-06-28*
