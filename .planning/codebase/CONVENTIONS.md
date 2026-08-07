# Coding Conventions

**Analysis Date:** 2026-08-07

> 适用范围：`network_toplogy`（Electron + React + TS + better-sqlite3）。本文档描述当前实际编码规范，新增代码必须遵循。语言：中文叙述 + 英文技术术语/代码标识符。
>
> **v1.1 增量（2026-08-07）：** 补 experience 域函数式 service 范例、masterKey 注入清单（device/topology/connection/ai/arp/kb/**experience** 7 注入器）、MIGRATION_HEAD 7→10、Logging type 枚举 `security`、新增 5 条 v1.1 约定（co-located 测试 / 强 schema LLM 输出 / PII 分级脱敏纯字符串 transform / bi-temporal 软失效 + assertCanonicalTimestamp / experience IPC 全 secure + 白名单正向投影）。

## Naming Patterns

**Files:**
- React 组件文件：`PascalCase.tsx`（如 `src/components/topology/DeviceNode.tsx`、`src/components/pages/TopologyPage.tsx`）
- 后端 service / util / database 模块：`camelCase.ts`（如 `electron/services/ouiService.ts`、`electron/utils/crypto.ts`、`electron/database/migrationHelpers.ts`、`electron/utils/piiMask.ts`）
- IPC 注册模块：`<domain>Ipc.ts`（如 `electron/ipc/ouiIpc.ts`、`electron/ipc/anomalyIpc.ts`、`electron/ipc/experienceIpc.ts`、`electron/ipc/experienceDraftingIpc.ts`）
- 类型定义：`src/types/<domain>.ts`（如 `src/types/device.ts`、`src/types/anomaly.ts`、`src/types/experience.ts`）
- 测试文件：`<unitName>.test.ts`。**两种合法位置并存**（见 TESTING.md）：
  - 集中独立目录 `tests/unit/<unitName>.test.ts`（与源码分离，安全核心回归网走此路径）
  - co-located 就近 `electron/<dir>/<unitName>.test.ts`（service 域单元测试，如 `electron/services/experienceService.test.ts`、`electron/utils/piiMask.test.ts`）
- 入口：渲染进程 `src/main.tsx` / `src/App.tsx`；主进程 `electron/main.ts`；preload `electron/preload.ts`

**Functions / Methods:**
- 普通函数与 service 内导出函数：`camelCase`（如 `createSystemLog`、`verifyCaptcha`、`hasColumn`、`generateCaptcha`、`assertCanonicalTimestamp`、`maskConversationText`）
- React 组件：`PascalCase`（如 `function DeviceNode(...)`、`export default function TopologyPage()`）
- Service 静态类方法：`camelCase`（`OUIService.getVendor`、`OUIService.addBatch`）

**Variables / Constants:**
- 局部变量：`camelCase`（如 `normalizedPrefix`、`derivedKeyCache`）
- 模块级常量：`UPPER_SNAKE_CASE`（如 `ALGORITHM`、`V2_IV_LEN`、`ITERATIONS`、`MAX_BATCH`、`MIGRATION_HEAD`、`LOCK_MS`、`CANONICAL_TS_RE`、`MAX_DRAFT_RETRIES`、`RELEVANCE_THRESHOLD`）
- 模块级可变密钥持有例外：函数式 service 用小写 `let MK = ''`（masterKey，由 `setXxxMasterKey` 注入，见下文 Pattern 1）
- migration step 内部函数例外：`v1`…`v10` 小写（版本号语义，见 `electron/database/migrations.ts`）

**Types / Interfaces:**
- `PascalCase`（如 `interface SystemLog`、`type ChangeType`、`interface AuthState`、`interface ExperienceInput`、`type ExperienceCategory`）
- DB 行类型就近断言，不强制建独立 interface：`as { vendor_name: string } | undefined`、`as any[]`、`as Array<{ oui_prefix: string; vendor_name: string }>`

## Code Style

**Formatting:**
- 无 prettier / eslint / biome / editorconfig 配置文件（仓库未检测到）。缩进 2 空格，单引号字符串，语句末尾无分号，尾随逗号（多行对象/数组）。
- 这些是事实约定（由现有代码一致体现），新增代码须手工保持一致。

**TypeScript Strictness（强制红线）：**
- `tsconfig.web.json`（渲染进程）：`strict: true` + `noUnusedLocals: true` + `noUnusedParameters: true` + `noFallthroughCasesInSwitch: true`，`target: ES2020`，`module: ESNext`，`moduleResolution: bundler`，`jsx: react-jsx`，`isolatedModules: true`，`paths: { "@/*": ["./src/*"] }`，`include: ["src"]`
- `tsconfig.node.json`（主进程 `electron/`）：`strict: true` + `composite: true`，`rootDir: electron`，`outDir: dist-electron`
- 构建门禁：`npm run build` 执行 `tsc -p tsconfig.web.json` —— 上述严格项必须全绿，否则构建失败。**禁止新增未使用的 import / 局部变量 / 参数。**
- 主进程实际经 `esbuild` 打包（`build:electron-main`），外部化 `better-sqlite3` / `ssh2` / `telnet-client` / `electron` / `pdfjs-dist`，避免 native binding 被打进 bundle。

**Linting:**
- 无静态分析工具。依赖 `tsc --noEmit`（即 `tsc -p tsconfig.web.json`）做类型与未用项检查。

## Import Organization

**Order（观察到的稳定顺序）：**
1. Node 内建 / 第三方库（`crypto`、`fs`、`path`、`electron`、`react`、`zustand`、`uuid`）
2. 类型导入用 `import type`（如 `import type Database from 'better-sqlite3'`、`import type { NodeProps } from 'reactflow'`、`import type { ExperienceInput } from '../../src/types/experience'`）
3. 项目内绝对路径（`@/...`，仅渲染进程用）或相对路径（`../`，主进程 `electron/` 内用相对路径；**主进程 service 跨域引用 renderer 类型合法**——experience 域 service 经 `../../src/types/experience` 复用 renderer 共享类型，避免双份手写漂移）
4. 静态资源（`import routerIcon from '@/assets/icons/router.svg'`）

**路径别名：**
- `@/*` → `./src/*`（`tsconfig.web.json`、`vite.config.ts`、`vitest.config.ts` 三处一致配置）
- 仅渲染进程 `src/` 使用 `@/`；主进程 `electron/` 一律相对路径（因 `tsconfig.node.json` 未配 `paths` 且经 esbuild 打包）

## 核心模式（Core Patterns）

### 1. Service 风格（两种合法形态并存，按是否持有加密字段选择）

仓库实际存在 **两种等价合法** 的 service 形态，**不是**只允许静态类。选择标准：service 内是否需要读写加密列（`<col>_enc`）。

#### 1a. 函数式 + 模块级 masterKey（含加密字段的 service）

- **模式**：模块级 `let MK = ''` 持有 masterKey，`export function setXxxMasterKey(key)` 由启动流程（`main.ts` 拿到 safeStorage 解出的 masterKey 后）注入；模块内私有 `enc`/`dec` 包 `encField`/`decField` 绑定该 MK；CRUD 全部以 `export function` 形式导出，`rowToXxx(row)` 做解密映射。
- **范例（7 个函数式 service + 主进程 masterKey 注入器）**：
  - `electron/services/device.ts`（`setDeviceMasterKey` + `enc`/`dec` + `rowToDevice` + `listDevices`/`createDevice`/...）
  - `electron/services/topology.ts`（`setTopologyMasterKey` + `rowToTopology`）
  - `electron/services/connection.ts`（`setConnectionMasterKey`）
  - `electron/services/ai.ts`（`setAiMasterKey`）
  - `electron/services/arpCollector.ts`（`setArpMasterKey`）
  - `electron/services/knowledgeBaseService.ts`（`setKbMasterKey`）
  - `electron/services/experienceService.ts`（**Phase 7**：`setExperienceMasterKey` + `enc`/`dec` + `rowToExperience` + `createExperience`/`listExperiences`/...，加密列 `attrs_enc`）
  - `electron/services/aiExecLogger.ts`（无加密列但同知识库域，函数式形态）
  ```ts
  // electron/services/device.ts
  let MK = ''
  export function setDeviceMasterKey(key: string) { MK = key }
  function enc(val: string | null | undefined): string | null { return encField(val, MK) }
  function dec(val: string | null | undefined): string { return decField(val, MK) }
  function rowToDevice(row: any): any { return { name: dec(row.name_enc), ipAddress: dec(row.ip_enc), ... } }
  export function listDevices() { return (getDatabase().prepare('SELECT * FROM devices ...').all() as any[]).map(rowToDevice) }
  ```
  ```ts
  // electron/services/experienceService.ts（Phase 7 函数式 service，attrs_enc 加密 + bi-temporal 软失效）
  let MK = ''
  export function setExperienceMasterKey(key: string) { MK = key }
  function enc(val: string | null | undefined): string | null { return encField(val, MK) }
  function dec(val: string | null | undefined): string { return decField(val, MK) }
  function rowToExperience(row: any): any {
    const attrs = dec(row.attrs_enc) ? JSON.parse(dec(row.attrs_enc)) : null
    delete row.attrs_enc            // 解密回填后剥离密文列，防外泄（SEC-02）
    return { ...row, attrs }
  }
  ```
- **为何不用静态类**：masterKey 是运行期注入的可变状态，函数式 + 闭包绑 MK 比挂在 `static` 字段更直观；且 `rowToXxx` 需在 `enc`/`dec` 闭包内反复调用，模块级 helper 比 `this.` 更省事。
- **测试 db 注入约定（v1.1 经验域新增）**：函数式 service 内部默认调 `getDatabase()` 单例，但**测试需注入内存 mock DB 规避 DEP-1 native binding**。约定导出 `@internal _setXxxDbGetter(fn)`（如 `experienceService.ts` 的 `_setExperienceDbGetter`），生产代码不调用——比把 `db` 提到每个 public 函数签名更干净（`hasColumn` 的 `db` 参数注入是另一种合法形态，见 Pattern 6）。

#### 1b. 静态类 facade（无状态 service，DB 读写集中）

- **模式**：service 导出一个 `class`，全部方法 `static`，内部调 `getDatabase()` 取连接，不持有可变实例状态（缓存除外）。
- **范例**：`electron/services/ouiService.ts`（`class OUIService`）、`electron/services/anomalyService.ts`（`class AnomalyService`）、`electron/services/backupScheduler.ts`（`class BackupScheduler`）、`electron/services/exportService.ts`、`electron/services/ipStatusService.ts`、`electron/services/networkSegmentService.ts`、`electron/services/schedulerService.ts`。
- **私有静态 helper**：`private static normalizeMac(...)`、`private static preloadExcludedSet(...)` —— 命名清晰、与 static 方法同 `this.` 调用。
- **缓存例外**：模块级懒加载缓存允许挂在 `private static`（如 `OUIService.vendorMap: Map | null`），null = 未预载，失败优雅降级回退查库。函数式 service 的运行期状态则直接用模块级 `let`/`const`（如 `auth.ts` 的 `const captchaStore`/`const failedAttempts` 是模块级 Map，非 class 字段）。
- **选择原则**：service 读写加密列 → 用 1a 函数式；service 纯 DB CRUD / 无加密列 → 用 1b 静态类。**两者都不要写成 `new` 出来的实例类。**

#### 1c. masterKey 注入清单（启动序列，`main.ts`）

启动时 `main.ts` 解出 masterKey 后**顺序注入 7 个函数式 service**，service 自身不读 `keyManager`（解耦 + 可测试）：
```ts
// electron/main.ts（注入序列）
setDeviceMasterKey(masterKey)
setTopologyMasterKey(masterKey)
setConnectionMasterKey(masterKey)
setAiMasterKey(masterKey)
setArpMasterKey(masterKey)
setKbMasterKey(masterKey)
setExperienceMasterKey(masterKey)     // ← Phase 7 新增
// R2: decField 解密失败可观测 handler 在此注入（写 system_log type=security 告警）
setDecryptFailureHandler(() => { createSystemLog({ type: 'security', status: 'warning', ... }) })
```
> 新增加密型 service 必须在此序列追加 `setXxxMasterKey(masterKey)` 一行，否则 MK 空 → 全表解密失败。

### 2. IPC secure 高阶函数鉴权（红线，不可回退）

- **模式**：每个 IPC handler 必须经 `secure(...)` 或 `safe(...)` 包装后注册。
- **实现**：`electron/utils/authGuard.ts`
  - `secure(handler)` — **特权通道**：先查 `authenticated`（未登录 → `throw new Error('未登录或会话已过期')`，在 try 之外不被脱敏覆盖），再 `try { await handler } catch { console.error + throw sanitizeMessage(err.message) }`。
  - `safe(handler)` — **登录前通道**（如 `auth:*`）：仅异常脱敏，不做鉴权。
  - 登录态由 `setAuthenticated(true)`（login 成功）置位，应用启动为 false。
- **脱敏**：`sanitizeMessage` 移除绝对路径（`[A-Za-z]:\\...`、`/usr|home|...`）、截断 > 200 字符 —— 不向渲染层泄露 SQL/路径等内部细节。
- **注册范例**（`electron/ipc/ouiIpc.ts`）：
  ```ts
  import { validateLimit, validateOffset } from '../utils/pagination'
  const MAX_BATCH = 1000
  export function registerOuiIpc() {
    // DATA-01：分页参数经网关校验后下推 SQL LIMIT/OFFSET（默认 5000、硬上限 50000）
    ipcMain.handle('oui:getAll', secure((_e, limit?: number, offset?: number) =>
      OUIService.getAll(validateLimit(limit, 5000, 50000), validateOffset(offset))))
    ipcMain.handle('oui:add', secure((_e, data: any) => {
      if (!data || typeof data !== 'object') throw new Error('参数无效')
      return OUIService.add(data)
    }))
    ipcMain.handle('oui:deleteBatch', secure((_e, ids: number[]) => {
      if (!Array.isArray(ids) || ids.length > MAX_BATCH) throw new Error(`批量上限 ${MAX_BATCH} 条`)
      return OUIService.deleteBatch(ids)
    }))
  }
  ```
- **experience 域范例（Phase 7-10，全 secure 基线）**：`electron/ipc/experienceIpc.ts` 10 channel + `electron/ipc/experienceDraftingIpc.ts` 1 channel，**全部 `secure(...)` 包装**（无 `safe` channel——经验数据属登录后特权操作，涉敏感 attrs/凭证片段）：
  ```ts
  // electron/ipc/experienceIpc.ts（全 secure，IPC 层 MAX_BATCH 双层防御）
  ipcMain.handle('experience:list', secure((_e, opts?: ExperienceListInput) => listExperiences(opts || {})))
  ipcMain.handle('experience:confirmDrafts', secure((_e, input: ConfirmDraftsInput) => {
    if (!input || !Array.isArray(input.drafts) || input.drafts.length > MAX_BATCH)
      throw new Error(`批量上限 ${MAX_BATCH} 条（或入参无效）`)
    return confirmDrafts(input)
  }))
  ipcMain.handle('experience:summarizeSession', secure((_e, sessionId: string) => summarizeSession(sessionId)))  // draftingIpc.ts
  ```
- **IPC channel 命名**：`<domain>:<action>`（如 `oui:getAll`、`oui:addBatch`、`anomaly:check`、`kb:search`、`experience:list`、`experience:summarizeSession`、`scheduler:start`、`export:topology`、`network:list`）。复合词 action 用 camelCase（`experience:relateDevice`、`experience:listByDevice`、`experience:confirmDrafts`），与既有 channel（`kb:listDocuments`、`anomaly:acknowledgeAll`）一致。
- **分页通道**：列表类 handler（`oui:getAll`、`experience:list` 等）接收 renderer 传入的 `limit?`/`offset?`，统一经 `electron/utils/pagination.ts` 的 `validateLimit(limit, default, ceiling)` / `validateOffset(offset)` 在网关层校验（非整数/超界 → 落回默认值，非钳到 ceiling），service 层只接收安全值（不信 renderer）。
- **批量上限**：IPC 层用模块常量 `MAX_BATCH = 1000` 拦截超大数组（如 `ouiIpc.ts`、`experienceIpc.ts` 的 `confirmDrafts` 二次校验，与 service 层兜底 throw 形成双层防御）。

### 3. AES-256-GCM 字段加密（enc/decField + 向后兼容）

- **实现**：`electron/utils/crypto.ts`
  - `encrypt(plaintext, masterKey)` / `decrypt(ciphertext, masterKey)` —— AES-256-GCM，PBKDF2（100000 次 sha512）派生密钥。
  - **版本前缀**：新密文 `v2:` 前缀 + 12 字节 IV（GCM 推荐 96 位）；历史无前缀密文用 16 字节 IV —— `decrypt` 自动识别兼容。
  - `encField(val, key)` / `decField(val, key)` —— **字段级包装**，是 service 读写加密列的唯一入口（`null`/空 → `null`/`''`）。
  - `decField` 降级 + 可观测：单条坏密文 try/catch → `console.error('[crypto] decField 解密失败')` + 返回 `''`，不让整列表加载失败；系统性失败（masterKey 不匹配 / safeStorage 翻转）经 `setDecryptFailureHandler` 注入的 handler 限流上报（窗口 60s，去重防刷屏），`main.ts` 启动时注入写 `system_log`（`type: 'security'`，见 Pattern 1c / Logging）的实现（R2 加固）。
  - `hashPassword` / `verifyPasswordSync`：口令哈希 PBKDF2，`verifyPasswordSync` 含结构防御 + 输入长度上限（防 pbkdf2 超长 DoS）+ `timingSafeEqual`。
  - 派生密钥 LRU 缓存 `derivedKeyCache`（`DERIVED_CACHE_MAX = 2048`）降低列表解密同步阻塞。
- **加密列命名**：`<col>_enc`（如 `name_enc`、`password_enc`、`vision_api_key_enc`、`web_url_enc`、`data_enc`、`attrs_enc`（experience））。
- **新增加密字段一律走 `encField`/`decField`**，禁止裸调 `encrypt`/`decrypt` 漏掉 null/降级处理。
- **解密回填后剥离密文列**：函数式 service 的 `rowToXxx` 解密回填后必须 `delete row.<col>_enc`（如 `rowToExperience` delete `attrs_enc`），密文不外泄；IPC 边界再经白名单正向投影 / `stripEncColumns` 兜底（见 Pattern 7）。

### 4. Prepared Statement 复用（性能红线 D-P2）

- **模式**：循环外 `const stmt = db.prepare(...)` 一次，循环内 `stmt.run(...)`/`stmt.get(...)` 复用，消除重复解析。
- **范例**：`electron/services/anomalyService.ts` `processARPEntries` 把 4 个 statement（`stmtCurrentBinding`/`stmtDeactivate`/`stmtUpdateLastSeen`/`stmtOldBinding`）提到循环外；`electron/services/ouiService.ts` `addBatch` 用 `const insert = db.prepare('INSERT OR REPLACE ...')` 循环复用；`electron/services/experienceService.ts` `setExperienceDevices`（diff + 事务内预载设备集，零 N+1）。
- **批量预载**：循环内需要只读判定时，事务前一次性预载进内存结构（`Set`/数组），消除 N+1（如 `preloadExcludedSet` 把 `excluded_ips` 预载为 `{ ips: Set, cidrs: [], wildcards: [] }`）。

### 5. db.transaction 事务（原子性 D-08）

- **模式**：多写操作包 `db.transaction(() => { ... })()`，throw 自动 ROLLBACK。
- **范例**：`electron/database/migrations.ts` 每个 `v1`…`v10` step 内 `const step = db.transaction(() => {...}); step()`；`electron/services/ai.ts`、`knowledgeBaseService.ts`、`ipStatusService.ts`、`experienceService.ts`（`setExperienceDevices` 单事务原子 diff，WR-02）同模式。
- **注意**：`PRAGMA user_version` 不保证随事务回滚 —— 真正的可重跑由幂等守卫（见下条）保证，不能仅靠版本号。
- **只读预载放事务外**：避免 SELECT 与写混在同一事务增加锁持有时间（`anomalyService.ts` 注释 D-P2）。

### 6. 幂等迁移守卫（hasColumn / sqlite_master，D-14 红线）

- **集中式列检查**：`electron/database/migrationHelpers.ts` `hasColumn(db, table, col)` —— 传入 `db`（不在内部调 `getDatabase`，为可测试 + 可在事务作用域内组合而设计）。
  ```ts
  export function hasColumn(db: Database.Database, table: string, col: string): boolean {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return cols.some((c) => c.name === col)
  }
  ```
- **ALTER 类迁移**：`if (!hasColumn(db, 'X', 'y')) db.exec('ALTER TABLE X ADD COLUMN y ...')`（如 v9 `experiences.duplicate_of_exp_id`、v10 `experiences.severity`）。
- **表/trigger 重建类迁移**：第二形式守卫 —— 查 `sqlite_master.sql` 内容判定目标 schema 是否已含特征串，已含则 `return` no-op：
  - v5：`SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'` → `.includes("'rdp'")`
  - v6：`name='ai_system_logs'` → `.includes("'warning'")`
  - v7：`type='trigger' AND name='kb_chunks_au'` → 查 sql 是否已含 `WHEN`
  - v8：`name='experiences'` 表存在性判定（建表幂等）
- **重建后断言**：`db.pragma('foreign_key_check')` 非空 → `throw`（如 v5 devices 重建）。
- **版本注册表**：`MIGRATION_HEAD` 常量（当前 = **10**）+ `MIGRATIONS: MigrationStep[]`（`{ version, name, run }`）。新增迁移：递增 `MIGRATION_HEAD` + 追加 `vN` + 数组项，**步骤必须自带幂等守卫**。当前注册表（v1-v10）：
  ```
  v1  chat_history.session_id
  v2  ai_exec_logs.prompt_text+ai_response
  v3  devices.status+last_checked
  v4  ai_config.vision_*
  v5  devices.connection_type CHECK rdp rebuild
  v6  ai_system_logs CHECK widen (acl/migration/backup + warning)
  v7  kb_chunks_au FTS UPDATE trigger add WHEN
  v8  experiences + exp_device_rel create (Phase 7)            ← v1.1 新增
  v9  experiences.duplicate_of_exp_id (Phase 8 drafting)       ← v1.1 新增
  v10 experiences.severity (Phase 10 browse filter/sort)       ← v1.1 新增
  ```
- **premigration 备份**：`connection.ts migrateAndSecure()` 在 `runMigrations()` 前按 `dbPreExisted()`（DB 文件预存在，CR-02）门控调 `BackupScheduler.createPremigrationBackup`。
- **数据回填 caveat（v10）**：迁移在 masterKey 注入**前**跑（`migrateAndSecure` 早于 `setExperienceMasterKey`），故 v10 severity 回填不能读 attrs_enc 解密——改走 `backfillSeverityFromHistory` 钩子（`main.ts` 注入 MK 后调用），从历史 chat_history/ai_exec_logs 推断 severity。新增迁移若需解密数据，遵循同一「迁移期不解密、注入后回填」模式。

### 7. v1.1 新增约定（Phase 7-11，5 条红线）

#### 7a. Co-located 测试布局（与 tests/unit 并存）

- **约定**：service 域单元测试 co-located 于被测模块同目录（`electron/services/<name>.test.ts`、`electron/utils/<name>.test.ts`），安全核心回归网保留 `tests/unit/`。`vitest.config.ts` `include: ['tests/**/*.test.ts', 'electron/**/*.test.ts']` 双 glob 采集。详见 TESTING.md。
- **范例**：`electron/services/experienceService.test.ts`（1121 行）、`electron/services/experienceRetrieval.test.ts`、`electron/services/draftingService.test.ts`、`electron/services/duplicateDetector.test.ts`、`electron/services/experienceDrafting.test.ts`、`electron/services/ai.saveChatMessage.test.ts`、`electron/services/ai.telnetRouting.test.ts`、`electron/utils/piiMask.test.ts`、`electron/services/__tests__/experienceService.browse.test.ts`（子目录 `__tests__/` 合法）。

#### 7b. 强 schema LLM 输出（validateDrafts / experienceRerank schema Gate）

- **约定**：所有 LLM JSON 输出（起草 / 精排）必须经 service 层 schema Gate 校验后才落库——**不信 LLM 返回结构**。Gate 返回 `{ ok: true; data } | { ok: false; error }`，调用方循环重试（`MAX_DRAFT_RETRIES` / rerank retry），全失败 throw。
- **校验内容**：分类枚举锁（`VALID_CATEGORIES`）、troubleshooting severity 枚举（`VALID_SEVERITIES`）、`duplication_verdict` 枚举（`VALID_VERDICTS`：ADD/UPDATE/NOOP）、confidence 边界归一化（`'85%'` → 0.85，`'0.9'` → 0.9，超界/NaN fail）、必填字段非空。
- **范例**：`electron/services/draftingService.ts:106-164` `validateDrafts`（起草）+ `electron/services/experienceRerank.ts`（精排，仿 `validateDrafts`）。JSON 提取先按 ```` ```json ```` fence，再退化首末括号截取（WR-02：纯首末括号在 LLM 前置文字含括号时会截错）。
  ```ts
  // draftingService.ts:106（强 schema Gate 范式）
  export function validateDrafts(raw: string): { ok: true; drafts: DraftDraft[] } | { ok: false; error: string } {
    let arr: any[]
    try { arr = JSON.parse(extractJsonArray(raw)) }
    catch (e: any) { return { ok: false, error: 'JSON 解析失败: ' + (e?.message || String(e)) } }
    if (!Array.isArray(arr)) return { ok: false, error: '输出非数组' }
    // ... 枚举锁 / severity / verdict / confidence 边界逐条校验，任一失败 return { ok: false, error }
    return { ok: true, drafts }
  }
  // 调用方重试（draftSession）：3 次 callAI → validateDrafts，全 fail throw
  ```
- **反幻觉（WR-01，已知 gap 待闭环）**：当前仅 prompt 提示禁 `[CMD]`/`[KB_SEARCH]` 标记，`validateDrafts` 未做正则扫描。补强方向（审计 §1.1 #4）：schema Gate 加标记正则，含执行标记的草稿拒绝落库。

#### 7c. PII 分级脱敏（纯字符串 transform，不涉加密/DB）

- **约定**：送 LLM 起草前的会话正文副本必须经 PII 分级脱敏——**纯字符串 transform**，不读写 DB、不依赖 masterKey、不复用 `getAiConfigMasked` 的 `****xxxx`（那是 apiKey 给 renderer 的脱敏，场景不同）。原始 `chat_history` 明文不动（Phase 9 原始会话回链用明文）。
- **实现**：`electron/utils/piiMask.ts`（Phase 8 D-04）。三步串联，顺序固定（凭证 → IPv4 → MAC，避免互相误伤）：
  - 凭证（最敏感，全脱敏 `****`）：`password|passwd|pwd|secret|token|apiKey|api_key|key(?![a-z])|密码|口令|凭证` 关键词 + 分隔符（`: =` 或自然语言连接词 is/are/was/为/是/等于）+ 值，整体替换值为 `****`。用捕获组直接重组（避免回调内 `\S+$` 在中文/`[:=]` 场景跨越吞前缀）。
  - IPv4：前三段掩码 `***.***.***.`，末段保留（LLM 可区分不同设备）。
  - MAC：前三段掩码 `**:**:**:`，后三段保留（尾4 字符可见）。
  ```ts
  // piiMask.ts（纯字符串 transform 范式，无 DB/无加密/无 masterKey）
  export function maskConversationText(text: string): string {
    if (!text || !text.trim()) return text || ''
    let out = maskCredentials(text)
    out = maskIpv4(out)
    out = maskMac(out)
    return out
  }
  ```
- **测试**：`electron/utils/piiMask.test.ts`（143 行，co-located）覆盖三种分级 + 连接词形态 + 中文关键词 + 边界 case。

#### 7d. Bi-temporal 软失效 + assertCanonicalTimestamp 前瞻守卫

- **约定**：经验记录不物理删除——失效走 `invalidateExperience`（写 `invalid_at = datetime('now','localtime')`），`listExperiences` 默认过滤 `invalid_at IS NULL OR invalid_at > datetime('now','localtime')`，保留可追溯历史。`restoreExperience`（Phase 10）清 `invalid_at` 受控恢复。
- **文本比较格式契约（CR-02）**：`valid_at` / `invalid_at` / `last_verified_at` 三列所有写入必须是 `YYYY-MM-DD HH:MM:SS`（localtime，无毫秒/无时区偏移）——与 `datetime('now','localtime')` 的字典序文本比较才不失真（`'T'(0x54) > 空格(0x20)` 会误判更晚）。当前写入路径全走 DB `datetime('now','localtime')` 默认值，合规。
- **前瞻守卫 `assertCanonicalTimestamp(v, col)`**（`experienceService.ts:86`，Phase 11 CR-02 preplant）：为未来「外部时间戳入参」入口（如回填校验时间）预留的格式校验。任何未来新增的 external-timestamp 入口必须经此守卫，否则拒绝。当前 0 runtime caller（07-VERIFICATION 明确为有意保留的前瞻守卫，非死代码）。
  ```ts
  // experienceService.ts:86（前瞻守卫，未来 external-timestamp 入口必须经此）
  const CANONICAL_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
  export function assertCanonicalTimestamp(v: string, col: string): void {
    if (!CANONICAL_TS_RE.test(v)) throw new Error(`${col} 格式必须是 YYYY-MM-DD HH:MM:SS（localtime），收到: ${v}`)
  }
  ```

#### 7e. Experience IPC 全 secure + 白名单正向投影（stripEncColumns→白名单）

- **约定**：`experience:*` 全部 11 channel 经 `secure(...)` 包装（鉴权 + 异常脱敏），无 `safe` channel（经验数据属登录后特权操作）。`experience:listDevices` 跨域返 devices 行时，**主防线是 service 层白名单正向投影**（`listDevicesByExperience` 走 `deviceService.getDeviceById` → `rowToDevice` 安全白名单映射，返回 Device DTO 已无 `_enc` 列），IPC 边界 `stripEncColumns` 兜底删 `_enc` 后缀 key 作深度防御（防未来 device 域 rowToDevice 误返密文残留）。
- **为何白名单正向投影优于黑名单剥离（WR-05/WR-09）**：`stripEncColumns` 黑名单删 `_enc` 后缀对当前 schema 安全，但 `ExperienceRelatedDevice` 曾用开放索引签名 `[key: string]: unknown`——未来若 devices 表新增非 `_enc` 后缀敏感列（如 `raw_secret` / 明文 `notes`），黑名单不剥、索引签名不报错、renderer 静默拿到明文。白名单正向投影（显式 `rowToDevice` 只输出已知安全字段）消除该脆弱性；`stripEncColumns` 保留作纵深防御。
- **范例**：`electron/ipc/experienceIpc.ts:52-60`（`stripEncColumns` 兜底）+ `:101-102`（`listDevices` 经它包装）+ service 层 `listDevicesByExperience` 走 `getDeviceById`。
  ```ts
  // experienceIpc.ts:49-60（白名单正向投影为主，stripEncColumns 兜底）
  // WR-05 深度防御：listDevicesByExperience 改走 deviceService.getDeviceById（rowToDevice 安全白名单映射），
  // 返回的 Device DTO 已无 _enc 密文列。stripEncColumns 兜底剥离保留，防未来 device 域误返密文残留。
  function stripEncColumns(rows: any[]): any[] {
    return rows.map((row) => {
      const safe: Record<string, unknown> = {}
      for (const key of Object.keys(row)) { if (!key.endsWith('_enc')) safe[key] = (row as Record<string, unknown>)[key] }
      return safe
    })
  }
  ```

## Error Handling

**Strategy：分级 — 非致命 try/catch 降级 + 致致命抛出中止启动。**

**Patterns:**
- **IPC 层**：所有 handler 经 `secure`/`safe` 包装，异常 `console.error('[ipc] handler error:', err)` + `throw new Error(sanitizeMessage(...))`（脱敏后传递，不泄露内部细节）。
- **非致命降级**：单点失败不应让整体功能中断，try/catch 后回退安全值：
  - `decField` 坏密文 → 返回 `''`（并经 handler 上报系统性失败，见 Pattern 3）
  - `OUIService.preload` 失败 → `vendorMap = null`，回退逐行查库
  - `runMigrations` 跳过时的 `createSystemLog` 失败 → `catch { console.log(...) }`
  - LLM 调用单次失败 → 重试循环（draftingService `MAX_DRAFT_RETRIES` / experienceRerank retry），全失败 throw `AI 起草失败（已重试 N 次）`
- **致命抛出**：迁移步骤失败 → better-sqlite3 自动 ROLLBACK → `createSystemLog({status:'failed'})` → 抛出让启动中止（D-08，DB 停留前版本）。外键重建校验失败 → `throw`。
- **校验抛错**：参数非法直接 `throw new Error('OUI 前缀格式无效...')` / `throw new Error('第 N 条 category 非法')`（如 `OUIService.add`、`validateDrafts`），由上层 IPC `secure` 捕获脱敏。
- **schema Gate 不抛错而返 `{ ok: false, error }`**：LLM 输出校验（`validateDrafts`）用返回值而非 throw——调用方据返回值决定重试，避免单次坏输出直接 throw 中断整个起草。

## Logging

**Framework：** 主进程用 `console`（`console.error`/`console.log`），无独立日志库。

**持久化审计日志：** `electron/services/systemLog.ts` `createSystemLog({ type, status, deviceIds?, ..., errorMessage? })` 写 `ai_system_logs` 表。
- **type 取值（运行期实际使用）**：`'discovery' | 'acl' | 'migration' | 'backup' | 'security'`。
  - **DB CHECK 约束现状（已知 gap）**：`ai_system_logs.type` 的 CHECK 仍是 `('discovery','acl','migration','backup')`（v6 / init.ts:87），**未含 `'security'`**。但运行期已有 2 处写 `type: 'security'`：`main.ts:100`（R2 解密失败 handler）+ `experienceDrafting.ts:137`。⚠️ 这两处写库会触发 `SQLITE_CONSTRAINT_CHECK` 被 `catch` 静默吞掉（解密失败告警落空）。**新增 `type: 'security'` 写库前，须先扩 v6 CHECK 约束（迁移重建表放开枚举）。** 审计 §1 已登记此 gap。
- **status 取值**：`'success' | 'failed' | 'warning'`。
- **字段截断**：`truncate()` 超长字段（`MAX_LOG_FIELD_LEN = 16000`）加 `...[truncated]` 后缀。
- **何时记**：迁移执行/跳过、备份跳过/执行、ACL 收紧、解密系统性失败（R2，`type: 'security'`）、AI 起草关键事件（`experienceDrafting.ts:137`，`type: 'security'`）等。
- **前缀约定**：`[ipc]` / `[crypto]` / `[oui]` / `[startup]` —— console 输出按模块加方括号前缀。

## Comments

**When to Comment：**
- 中文行内/块注释解释 **设计决策与红线编号**（如 `// PERF-01 (D-P1)：...`、`// CR-02：...`、`// WR-02：...`、`// D-08/D-13`、`// SEC-02`、`// W-4`）。这些编号关联 `.planning/` 设计文档，不可删除。
- 解释 **为什么**（why）而非 **做什么**（what）：如 `decField` 注「单条坏密文不应让整个列表加载失败」、`authGuard` 注「未登录在 try 之外不被脱敏覆盖」、`piiMask` 注「`key(?![a-z])` 排除 keyboard/keys，前置边界兼容中文关键词（`\b` 不认中文边界）」。
- 迁移步骤注释当前修复了什么 pre-existing bug（如 v6 CR-01、v5 rdp、v7 WHEN、v10 severity 回填 caveat）。
- 标注「前瞻守卫」（如 `assertCanonicalTimestamp` 注「为未来 external-timestamp 入口预留，当前 0 caller」），避免被误删为死代码。

**JSDoc/TSDoc：**
- 公开导出函数用 `/** ... */` 块注释说明用途与关键约束（如 `secure`、`safe`、`hasColumn`、`migrateAndSecure`、`runMigrations`、`maskConversationText`、`assertCanonicalTimestamp`）。
- `@internal` 标注测试专用导出（如 `experienceService.ts` `_setExperienceDbGetter` 注 `@internal 测试专用：注入 db getter（生产不调用）`）。
- 行内说明用 `//`。

## Function Design

**Size：** 单函数职责单一；静态类方法普遍 < 30 行，长事务/重建类（如 v5/v6 迁移）例外。`validateDrafts`（~60 行 schema Gate）属合理例外。

**Parameters：**
- 多参数 service 方法用 **对象参数**（`add(input: { ouiPrefix: string; vendorName: string })`、`update(input: { id; ouiPrefix?; vendorName? })`、`createExperience(input: ExperienceInput)`）。
- IPC handler 第一参固定 `_e`（event，未用加下划线满足 `noUnusedParameters`），后续为渲染层传入参数。
- 可选/可空参数显式标 `?` 或 `| undefined`/`| null`。
- 主进程 service 跨域复用 renderer 共享类型（`import type { ExperienceInput } from '../../src/types/experience'`），避免双份手写。

**Return Values：**
- 查询返回 typed array 或 `any[]`（DB 行就近 `as` 断言）。
- 写操作返回新建/更新后的对象（`return this.getById(result.lastInsertRowid)`）或影响行数（`deleteBatch → number`）。
- 异步操作返回 `Promise`（`hashPassword: Promise<string>`、`verifyPassword: Promise<boolean>`、`draftSession: Promise<DraftDraft[]>`）。
- 校验返回 `{ ok: boolean; error?: string }`（如 `validatePasswordStrength`、`validateDrafts`——`{ ok: true; drafts } | { ok: false; error }`，不 throw）。

## Module Design

**Exports：**
- Service（静态类形态）：`export class XService { static ... }`（一个 class 一个文件，文件名 = `<name>Service.ts`）。
- Service（函数式形态）：多个 `export function` 同模块，文件名为领域名 `device.ts`/`topology.ts`/`experienceService.ts`/`draftingService.ts`（经验域因多 service 共域，带 `Service` 后缀区分）。
- Util：命名导出（`export function encrypt/decrypt/encField/decField`、`export function hasColumn`、`export function validateLimit/validateOffset`、`export function maskCredentials/maskIpv4/maskMac/maskConversationText`）。
- React 组件：`export default function Comp()`；页面级组件位于 `src/components/pages/`。
- IPC：每个 domain 导出 `register<Domain>Ipc()`，由 `electron/main.ts` 启动时调用（`registerExperienceIpc` / `registerExperienceDraftingIpc`）。

**Barrel Files：** 未使用（无 `index.ts` 聚合导出，直接按文件路径导入）。

**State Management（渲染进程）：**
- Zustand store：`src/stores/<name>Store.ts`，`create<State>((set) => ({...}))`，调 `window.api.<domain>.<action>()` 走 preload 桥（`window.api.experience.list()` / `window.api.experience.confirmDrafts()` 等 17 方法，见 `preload.ts:124-141`）。
- 类型化的 `interface XState` 声明 state + action 方法签名（见 `src/stores/authStore.ts`）。

---

*Convention analysis: 2026-08-07（v1.1 增量刷新：补 experience 函数式 service 范例 + 7 masterKey 注入器 + MIGRATION_HEAD 10 + Logging security type + 5 条 v1.1 红线 7a-7e）*
