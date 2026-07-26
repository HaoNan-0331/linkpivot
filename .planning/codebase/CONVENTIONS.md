# Coding Conventions

**Analysis Date:** 2026-07-26

> 适用范围：`network_toplogy`（Electron + React + TS + better-sqlite3）。本文档描述当前实际编码规范，新增代码必须遵循。语言：中文叙述 + 英文技术术语/代码标识符。

## Naming Patterns

**Files:**
- React 组件文件：`PascalCase.tsx`（如 `src/components/topology/DeviceNode.tsx`、`src/components/pages/TopologyPage.tsx`）
- 后端 service / util / database 模块：`camelCase.ts`（如 `electron/services/ouiService.ts`、`electron/utils/crypto.ts`、`electron/database/migrationHelpers.ts`）
- IPC 注册模块：`<domain>Ipc.ts`（如 `electron/ipc/ouiIpc.ts`、`electron/ipc/anomalyIpc.ts`）
- 类型定义：`src/types/<domain>.ts`（如 `src/types/device.ts`、`src/types/anomaly.ts`）
- 测试文件：`<unitName>.test.ts`（如 `tests/unit/crypto.test.ts`）
- 入口：渲染进程 `src/main.tsx` / `src/App.tsx`；主进程 `electron/main.ts`；preload `electron/preload.ts`

**Functions / Methods:**
- 普通函数与 service 内导出函数：`camelCase`（如 `createSystemLog`、`verifyCaptcha`、`hasColumn`、`generateCaptcha`）
- React 组件：`PascalCase`（如 `function DeviceNode(...)`、`export default function TopologyPage()`）
- Service 静态类方法：`camelCase`（`OUIService.getVendor`、`OUIService.addBatch`）

**Variables / Constants:**
- 局部变量：`camelCase`（如 `normalizedPrefix`、`derivedKeyCache`）
- 模块级常量：`UPPER_SNAKE_CASE`（如 `ALGORITHM`、`V2_IV_LEN`、`ITERATIONS`、`MAX_BATCH`、`MIGRATION_HEAD`、`LOCK_MS`）
- 模块级可变密钥持有例外：函数式 service 用小写 `let MK = ''`（masterKey，由 `setXxxMasterKey` 注入，见下文 Pattern 1）
- migration step 内部函数例外：`v1`…`v7` 小写（版本号语义，见 `electron/database/migrations.ts`）

**Types / Interfaces:**
- `PascalCase`（如 `interface SystemLog`、`type ChangeType`、`interface AuthState`）
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
2. 类型导入用 `import type`（如 `import type Database from 'better-sqlite3'`、`import type { NodeProps } from 'reactflow'`）
3. 项目内绝对路径（`@/...`，仅渲染进程用）或相对路径（`../`，主进程 `electron/` 内用相对路径）
4. 静态资源（`import routerIcon from '@/assets/icons/router.svg'`）

**路径别名：**
- `@/*` → `./src/*`（`tsconfig.web.json`、`vite.config.ts`、`vitest.config.ts` 三处一致配置）
- 仅渲染进程 `src/` 使用 `@/`；主进程 `electron/` 一律相对路径（因 `tsconfig.node.json` 未配 `paths` 且经 esbuild 打包）

## 核心模式（Core Patterns）

### 1. Service 风格（两种合法形态并存，按是否持有加密字段选择）

仓库实际存在 **两种等价合法** 的 service 形态，**不是**只允许静态类。选择标准：service 内是否需要读写加密列（`<col>_enc`）。

#### 1a. 函数式 + 模块级 masterKey（含加密字段的 service）

- **模式**：模块级 `let MK = ''` 持有 masterKey，`export function setXxxMasterKey(key)` 由启动流程（`main.ts` 拿到 safeStorage 解出的 masterKey 后）注入；模块内私有 `enc`/`dec` 包 `encField`/`decField` 绑定该 MK；CRUD 全部以 `export function` 形式导出，`rowToXxx(row)` 做解密映射。
- **范例**：`electron/services/device.ts`（`setDeviceMasterKey` + `enc`/`dec` + `rowToDevice` + `listDevices`/`createDevice`/...）、`electron/services/topology.ts`（`setTopologyMasterKey` + `rowToTopology`）、`electron/services/ai.ts`、`electron/services/aiExecLogger.ts`、`electron/services/knowledgeBaseService.ts`、`electron/services/connection.ts`、`electron/services/arpCollector.ts`。
  ```ts
  // electron/services/device.ts
  let MK = ''
  export function setDeviceMasterKey(key: string) { MK = key }
  function enc(val: string | null | undefined): string | null { return encField(val, MK) }
  function dec(val: string | null | undefined): string { return decField(val, MK) }
  function rowToDevice(row: any): any { return { name: dec(row.name_enc), ipAddress: dec(row.ip_enc), ... } }
  export function listDevices() { return (getDatabase().prepare('SELECT * FROM devices ...').all() as any[]).map(rowToDevice) }
  ```
- **为何不用静态类**：masterKey 是运行期注入的可变状态，函数式 + 闭包绑 MK 比挂在 `static` 字段更直观；且 `rowToXxx` 需在 `enc`/`dec` 闭包内反复调用，模块级 helper 比 `this.` 更省事。

#### 1b. 静态类 facade（无状态 service，DB 读写集中）

- **模式**：service 导出一个 `class`，全部方法 `static`，内部调 `getDatabase()` 取连接，不持有可变实例状态（缓存除外）。
- **范例**：`electron/services/ouiService.ts`（`class OUIService`）、`electron/services/anomalyService.ts`（`class AnomalyService`）、`electron/services/backupScheduler.ts`（`class BackupScheduler`）、`electron/services/exportService.ts`、`electron/services/ipStatusService.ts`、`electron/services/networkSegmentService.ts`、`electron/services/schedulerService.ts`。
- **私有静态 helper**：`private static normalizeMac(...)`、`private static preloadExcludedSet(...)` —— 命名清晰、与 static 方法同 `this.` 调用。
- **缓存例外**：模块级懒加载缓存允许挂在 `private static`（如 `OUIService.vendorMap: Map | null`），null = 未预载，失败优雅降级回退查库。函数式 service 的运行期状态则直接用模块级 `let`/`const`（如 `auth.ts` 的 `const captchaStore`/`const failedAttempts` 是模块级 Map，非 class 字段）。
- **选择原则**：service 读写加密列 → 用 1a 函数式；service 纯 DB CRUD / 无加密列 → 用 1b 静态类。**两者都不要写成 `new` 出来的实例类。**

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
- **IPC channel 命名**：`<domain>:<action>`（如 `oui:getAll`、`oui:addBatch`、`anomaly:check`、`kb:search`、`scheduler:start`、`export:topology`、`network:list`）。
- **分页通道**：列表类 handler（`oui:getAll` 等）接收 renderer 传入的 `limit?`/`offset?`，统一经 `electron/utils/pagination.ts` 的 `validateLimit(limit, default, ceiling)` / `validateOffset(offset)` 在网关层校验（非整数/超界 → 落回默认值，非钳到 ceiling），service 层只接收安全值（不信 renderer）。
- **批量上限**：IPC 层用模块常量 `MAX_BATCH = 1000` 拦截超大数组（如 `ouiIpc.ts`）。

### 3. AES-256-GCM 字段加密（enc/decField + 向后兼容）

- **实现**：`electron/utils/crypto.ts`
  - `encrypt(plaintext, masterKey)` / `decrypt(ciphertext, masterKey)` —— AES-256-GCM，PBKDF2（100000 次 sha512）派生密钥。
  - **版本前缀**：新密文 `v2:` 前缀 + 12 字节 IV（GCM 推荐 96 位）；历史无前缀密文用 16 字节 IV —— `decrypt` 自动识别兼容。
  - `encField(val, key)` / `decField(val, key)` —— **字段级包装**，是 service 读写加密列的唯一入口（`null`/空 → `null`/`''`）。
  - `decField` 降级 + 可观测：单条坏密文 try/catch → `console.error('[crypto] decField 解密失败')` + 返回 `''`，不让整列表加载失败；系统性失败（masterKey 不匹配 / safeStorage 翻转）经 `setDecryptFailureHandler` 注入的 handler 限流上报（窗口 60s，去重防刷屏），`main.ts` 启动时注入写 `system_log` 的实现（R2 加固）。
  - `hashPassword` / `verifyPasswordSync`：口令哈希 PBKDF2，`verifyPasswordSync` 含结构防御 + 输入长度上限（防 pbkdf2 超长 DoS）+ `timingSafeEqual`。
  - 派生密钥 LRU 缓存 `derivedKeyCache`（`DERIVED_CACHE_MAX = 2048`）降低列表解密同步阻塞。
- **加密列命名**：`<col>_enc`（如 `name_enc`、`password_enc`、`vision_api_key_enc`、`web_url_enc`、`data_enc`）。
- **新增加密字段一律走 `encField`/`decField`**，禁止裸调 `encrypt`/`decrypt` 漏掉 null/降级处理。

### 4. Prepared Statement 复用（性能红线 D-P2）

- **模式**：循环外 `const stmt = db.prepare(...)` 一次，循环内 `stmt.run(...)`/`stmt.get(...)` 复用，消除重复解析。
- **范例**：`electron/services/anomalyService.ts` `processARPEntries` 把 4 个 statement（`stmtCurrentBinding`/`stmtDeactivate`/`stmtUpdateLastSeen`/`stmtOldBinding`）提到循环外；`electron/services/ouiService.ts` `addBatch` 用 `const insert = db.prepare('INSERT OR REPLACE ...')` 循环复用。
- **批量预载**：循环内需要只读判定时，事务前一次性预载进内存结构（`Set`/数组），消除 N+1（如 `preloadExcludedSet` 把 `excluded_ips` 预载为 `{ ips: Set, cidrs: [], wildcards: [] }`）。

### 5. db.transaction 事务（原子性 D-08）

- **模式**：多写操作包 `db.transaction(() => { ... })()`，throw 自动 ROLLBACK。
- **范例**：`electron/database/migrations.ts` 每个 `v1`…`v7` step 内 `const step = db.transaction(() => {...}); step()`；`electron/services/ai.ts`、`knowledgeBaseService.ts`、`ipStatusService.ts` 同模式。
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
- **ALTER 类迁移**：`if (!hasColumn(db, 'X', 'y')) db.exec('ALTER TABLE X ADD COLUMN y ...')`。
- **表/trigger 重建类迁移**：第二形式守卫 —— 查 `sqlite_master.sql` 内容判定目标 schema 是否已含特征串，已含则 `return` no-op：
  - v5：`SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'` → `.includes("'rdp'")`
  - v6：`name='ai_system_logs'` → `.includes("'warning'")`
  - v7：`type='trigger' AND name='kb_chunks_au'` → 查 sql 是否已含 `WHEN`
- **重建后断言**：`db.pragma('foreign_key_check')` 非空 → `throw`（如 v5 devices 重建）。
- **版本注册表**：`MIGRATION_HEAD` 常量（当前 = 7）+ `MIGRATIONS: MigrationStep[]`（`{ version, name, run }`）。新增迁移：递增 `MIGRATION_HEAD` + 追加 `vN` + 数组项，**步骤必须自带幂等守卫**。
- **premigration 备份**：`connection.ts migrateAndSecure()` 在 `runMigrations()` 前按 `dbPreExisted()`（DB 文件预存在，CR-02）门控调 `BackupScheduler.createPremigrationBackup`。

## Error Handling

**Strategy：分级 — 非致命 try/catch 降级 + 致致命抛出中止启动。**

**Patterns:**
- **IPC 层**：所有 handler 经 `secure`/`safe` 包装，异常 `console.error('[ipc] handler error:', err)` + `throw new Error(sanitizeMessage(...))`（脱敏后传递，不泄露内部细节）。
- **非致命降级**：单点失败不应让整体功能中断，try/catch 后回退安全值：
  - `decField` 坏密文 → 返回 `''`（并经 handler 上报系统性失败，见 Pattern 3）
  - `OUIService.preload` 失败 → `vendorMap = null`，回退逐行查库
  - `runMigrations` 跳过时的 `createSystemLog` 失败 → `catch { console.log(...) }`
- **致命抛出**：迁移步骤失败 → better-sqlite3 自动 ROLLBACK → `createSystemLog({status:'failed'})` → 抛出让启动中止（D-08，DB 停留前版本）。外键重建校验失败 → `throw`。
- **校验抛错**：参数非法直接 `throw new Error('OUI 前缀格式无效...')`（如 `OUIService.add`），由上层 IPC `secure` 捕获脱敏。

## Logging

**Framework：** 主进程用 `console`（`console.error`/`console.log`），无独立日志库。

**持久化审计日志：** `electron/services/systemLog.ts` `createSystemLog({ type, status, deviceIds?, ..., errorMessage? })` 写 `ai_system_logs` 表。
- **type 取值**：`'discovery' | 'acl' | 'migration' | 'backup'`（DB CHECK 约束，见 v6 迁移）。
- **status 取值**：`'success' | 'failed' | 'warning'`。
- **字段截断**：`truncate()` 超长字段（`MAX_LOG_FIELD_LEN = 16000`）加 `...[truncated]` 后缀。
- **何时记**：迁移执行/跳过、备份跳过/执行、ACL 收紧、解密系统性失败（R2）等关键运维事件。
- **前缀约定**：`[ipc]` / `[crypto]` / `[oui]` / `[startup]` —— console 输出按模块加方括号前缀。

## Comments

**When to Comment：**
- 中文行内/块注释解释 **设计决策与红线编号**（如 `// PERF-01 (D-P1)：...`、`// CR-02：...`、`// WR-02：...`、`// D-08/D-13`）。这些编号关联 `.planning/` 设计文档，不可删除。
- 解释 **为什么**（why）而非 **做什么**（what）：如 `decField` 注「单条坏密文不应让整个列表加载失败」、`authGuard` 注「未登录在 try 之外不被脱敏覆盖」。
- 迁移步骤注释当前修复了什么 pre-existing bug（如 v6 CR-01、v5 rdp、v7 WHEN）。

**JSDoc/TSDoc：**
- 公开导出函数用 `/** ... */` 块注释说明用途与关键约束（如 `secure`、`safe`、`hasColumn`、`migrateAndSecure`、`runMigrations`）。
- 行内说明用 `//`。

## Function Design

**Size：** 单函数职责单一；静态类方法普遍 < 30 行，长事务/重建类（如 v5/v6 迁移）例外。

**Parameters：**
- 多参数 service 方法用 **对象参数**（`add(input: { ouiPrefix: string; vendorName: string })`、`update(input: { id; ouiPrefix?; vendorName? })`）。
- IPC handler 第一参固定 `_e`（event，未用加下划线满足 `noUnusedParameters`），后续为渲染层传入参数。
- 可选/可空参数显式标 `?` 或 `| undefined`/`| null`。

**Return Values：**
- 查询返回 typed array 或 `any[]`（DB 行就近 `as` 断言）。
- 写操作返回新建/更新后的对象（`return this.getById(result.lastInsertRowid)`）或影响行数（`deleteBatch → number`）。
- 异步操作返回 `Promise`（`hashPassword: Promise<string>`、`verifyPassword: Promise<boolean>`）。
- 校验返回 `{ ok: boolean; error?: string }`（如 `validatePasswordStrength`）。

## Module Design

**Exports：**
- Service（静态类形态）：`export class XService { static ... }`（一个 class 一个文件，文件名 = `<name>Service.ts`）。
- Service（函数式形态）：多个 `export function` 同模块，文件名为领域名 `device.ts`/`topology.ts`（不带 `Service` 后缀）。
- Util：命名导出（`export function encrypt/decrypt/encField/decField`、`export function hasColumn`、`export function validateLimit/validateOffset`）。
- React 组件：`export default function Comp()`；页面级组件位于 `src/components/pages/`。
- IPC：每个 domain 导出 `register<Domain>Ipc()`，由 `electron/main.ts` 启动时调用。

**Barrel Files：** 未使用（无 `index.ts` 聚合导出，直接按文件路径导入）。

**State Management（渲染进程）：**
- Zustand store：`src/stores/<name>Store.ts`，`create<State>((set) => ({...}))`，调 `window.api.<domain>.<action>()` 走 preload 桥。
- 类型化的 `interface XState` 声明 state + action 方法签名（见 `src/stores/authStore.ts`）。

---

*Convention analysis: 2026-07-26（基于 HEAD `3adbbeb`，刷新 service 双形态 + oui:getAll 分页 + decField 可观测层）*
