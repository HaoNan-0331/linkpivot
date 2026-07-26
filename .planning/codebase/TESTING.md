# Testing Patterns

**Analysis Date:** 2026-07-26

> 适用范围：`network_toplogy`（Electron + React + TS + better-sqlite3）。当前测试覆盖集中在 **无 native binding 依赖的纯逻辑模块 + 安全核心回归网**（crypto / auth captcha / migration helper / pagination / 命令白名单 / IPC 鉴权脱敏 / masterKey 加密降级）。语言：中文叙述 + 英文技术术语/代码标识符。

## Test Framework

**Runner:**
- **vitest** `^4.1.5`（devDependency，`package.json:50`）
- Config: `vitest.config.ts`
  ```ts
  export default defineConfig({
    test: {
      environment: 'node',                 // 主进程逻辑测试，不需要 DOM
      include: ['tests/**/*.test.ts'],     // 仅采集 tests/ 下测试
      server: { deps: { inline: ['../../electron'] } },  // inline electron/ 转换（相对路径绕过 native 外部化）
    },
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  })
  ```

**Assertion Library:**
- vitest 内置 `expect`（`import { describe, it, expect, beforeEach } from 'vitest'`），无额外断言库。

**Run Commands:**
```bash
npm test            # vitest run（CI/单次，package.json "test" → "vitest run"）
npm run test:watch  # vitest（watch 模式，"test:watch" → "vitest"）
```
> 无 coverage 命令、无 `--coverage` 配置。

## Test File Organization

**Location:**
- 集中独立目录 `tests/unit/`（与源码分离，非 co-located）。
- 当前 7 个测试文件 / **55 tests**（vitest 55/55 绿）：
  - `tests/unit/crypto.test.ts` — 10 tests（AES-256-GCM 加解密、PBKDF2 口令哈希、v1/v2 IV 兼容、`decField` 降级与可观测）
  - `tests/unit/commandSafety.test.ts` — 14 tests（命令白名单严格匹配、shell 注入分隔符拦截、黑名单首词、管道豁免）
  - `tests/unit/pagination.test.ts` — 13 tests（`validateLimit` / `validateOffset` / `PaginatedResult` envelope）
  - `tests/unit/authGuard.test.ts` — 7 tests（`secure` 鉴权 + `safe` 包装 + 路径/长度脱敏）
  - `tests/unit/auth.test.ts` — 4 tests（captcha 生成与校验）
  - `tests/unit/migrationHelpers.test.ts` — 4 tests（`hasColumn`）
  - `tests/unit/keyManager.test.ts` — 3 tests（masterKey 新建/复用/safeStorage 翻转抛错）
  - **合计 55 tests。**

**Naming:**
- `<unitName>.test.ts`，`unitName` 对应被测模块名（`crypto` ↔ `electron/utils/crypto.ts`，`commandSafety` ↔ `electron/services/commandSafety.ts`，`pagination` ↔ `electron/utils/pagination.ts`，`authGuard` ↔ `electron/utils/authGuard.ts`，`auth` ↔ `electron/services/auth.ts`，`migrationHelpers` ↔ `electron/database/migrationHelpers.ts`，`keyManager` ↔ `electron/utils/keyManager.ts`）。

**Structure:**
```
tests/
└── unit/
    ├── auth.test.ts
    ├── authGuard.test.ts
    ├── commandSafety.test.ts
    ├── crypto.test.ts
    ├── keyManager.test.ts
    ├── migrationHelpers.test.ts
    └── pagination.test.ts
```
> 无 `tests/integration/` 或 `tests/e2e/`，当前仅 unit 层。

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '../../electron/utils/crypto'

describe('crypto', () => {
  const key = 'test-key-32-bytes-long-enough!!'

  it('encrypt and decrypt correctly', () => {
    const enc = encrypt('hello world', key)
    expect(decrypt(enc, key)).toBe('hello world')
  })

  it('different ciphertext each time', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key))
  })
})
```

**Patterns:**
- `describe('<module>', ...)` 套件名 = 被测模块短名（commandSafety 套件为 `commandSafety isCommandAllowed`，体现「模块 + 被测函数」两级）。
- 每条 `it('<行为描述>', ...)` 用英文短句描述行为（如 `allows whitelist first word exact match`、`rejects newline injection`、`secure sanitizes Windows absolute path from error`、`case insensitive`、`wrong key fails to decrypt`）。
- 共享前置用 `beforeEach`（见 `auth.test.ts`：`beforeEach(() => { captcha = generateCaptcha() })`；`authGuard.test.ts`：`beforeEach(() => setAuthenticated(false))`；`keyManager.test.ts` 重置 memStore + safeStorage 状态）。
- 类型推导复用被测函数返回类型：`let captcha: ReturnType<typeof generateCaptcha>`。
- 断言风格简洁：`toBe(true)` / `toBeTruthy()` / `toHaveLength(4)` / `toContain('<svg')` / `.not.toBe(...)` / `.resolves.toBe(...)` / `.rejects.toThrow(...)` / `expect(() => fn()).toThrow()` / `expect.unreachable('should have thrown')`。
- 安全核心测试（commandSafety / authGuard）在文件顶部注释标注回归网来源（`// 安全核心回归网（审计 R5 / TEST-1）`），说明「改一行可能放行 reboot 而无拦截」的拦截意图。

## Mocking

**Framework：** vitest 内置（`vi.mock` / `vi.fn`）。本仓库 **大部分测试用手写 typed mock object**（crypto/auth/commandSafety/pagination/migrationHelpers），**仅 keyManager.test.ts 用 `vi.mock` 替换 `fs` 与 `electron` 模块**。

**核心策略 — 规避 better-sqlite3 native ABI（DEP-1）：**
- better-sqlite3 是 native binding，在 Node 测试环境 vs Electron 运行时 `NODE_MODULE_VERSION` 不同会加载冲突。**DB 层一律用 mock，测试不实例化真实 better-sqlite3**，改用最小手写桩对象满足被测函数所需接口。
- 被测函数因此 **必须设计为可注入 `db`**（不在内部调 `getDatabase()`）—— 这是 `hasColumn` 接受 `db` 参数的根因（`migrationHelpers.ts` 顶部注释明确说明）。
  ```typescript
  // tests/unit/migrationHelpers.test.ts
  function makeDb(colNames: string[]): Database.Database {
    const stmt = { all: () => colNames.map((name) => ({ name })) }
    return { prepare: () => stmt } as unknown as Database.Database
  }

  it('returns true when column exists', () => {
    const db = makeDb(['id', 'name'])
    expect(hasColumn(db, 't', 'name')).toBe(true)
  })
  ```
- 测试顶部注释解释设计意图：`hasColumn 接受 db 参数（不在内部调 getDatabase）—— 正是为可测试性而设计`。

**`vi.mock` 模式（keyManager.test.ts，mock Electron 依赖）：**
- keyManager 依赖 `electron.safeStorage` + `fs`，无法纯 node 直接跑。用 `vi.mock('fs', ...)` 提供 mem store，`vi.mock('electron', ...)` 提供可控 safeStorage（`isEncryptionAvailable` / `decryptString` / `encryptString`），通过模块级布尔标志（`safeStorageAvailable` / `safeStorageDecryptThrow`）在 `beforeEach` 切换场景。
- 关键回归：safeStorage 翻转（换账户/换机）+ master.key 是无法解读的 DPAPI blob 时，`getOrCreateMasterKey` 必须抛错，而非把二进制 blob 当 UTF-8 trim 出错误 masterKey（对应审计 R3）。

**Patterns（手写 mock）：**
- 用 `as unknown as Database.Database` 把最小对象强转为 `better-sqlite3` 类型，只实现被测路径调到的方法（`.prepare()` 返回 `{ all }` / `.get()` / `.run()`）。
- crypto / auth / commandSafety / pagination 测试无需 mock：`electron/utils/crypto.ts` 纯用 Node `crypto`、`electron/services/auth.ts` 的 `generateCaptcha`/`verifyCaptcha` 纯内存 Map 操作、`commandSafety.ts` 纯函数、`pagination.ts` 纯校验函数（均不触 DB/electron）—— 这正是它们被优先测试的原因。

**What to Mock:**
- `better-sqlite3` Database 连接（手写最小桩，按被测 SQL 桩对应方法返回值）。
- `electron`（`app`/`safeStorage`）与 `fs` —— 仅当被测模块在模块顶层依赖它们时（如 keyManager），用 `vi.mock` 替换。

**What NOT to Mock:**
- Node 内建 `crypto`（直接用真实实现，crypto.test.ts 验真实 AES-256-GCM 加解密 + PBKDF2，包括 v1 16 字节 IV / v2 12 字节 IV 前缀两条路径）。
- 被测模块自身的纯逻辑（如 `isCommandAllowed`、`validateLimit`、`normalizeMac`、`verifyCaptcha`、`secure`/`safe` 的鉴权与脱敏判定）。

## Fixtures and Factories

**Test Data:**
- 测试数据内联于 `it` 内（无独立 fixtures 目录）：
  - crypto：固定 key 字符串 `'test-key-32-bytes-long-enough!!'`、明文 `'hello world'` / `'same'` / `'secret'` / `'设备密码'`、口令 `'Pass123!'`；v1 密文用 `crypto.randomBytes` 现场构造（salt 64B + iv 16B + tag + ciphertext，无 `v2:` 前缀）。
  - auth：`generateCaptcha()` 动态产出 + 错误输入 `'XXXX'`。
  - migrationHelpers：列名数组 `['id', 'name']` / `['id', 'session_id']` 经 `makeDb` 工厂构造。
  - commandSafety：内联白名单 `['display', 'show', 'ping', 'terminal', 'traceroute']` 与黑名单首词数组（reboot/reload/shutdown/configure/...）。
  - authGuard：构造含敏感信息的错误消息（`'failed to open C:\\Users\\admin\\secret.db'`、`'cannot read /home/operator/config/key.pem'`、500 字符长串）验证脱敏。
  - keyManager：`crypto.randomBytes(32).toString('base64')` 造合法 masterKey；`Buffer.from([0x01,0x02,...])` 造无法解读的 DPAPI blob。

**Location:**
- 无 `tests/fixtures/` 或 factory 模块。新增 fixture 就近放测试文件顶部（如 `makeDb` helper、`memStore` Map、`safeStorageAvailable` 标志）。

**Factory pattern（推荐复用）：**
```typescript
function makeDb(colNames: string[]): Database.Database {
  const stmt = { all: () => colNames.map((name) => ({ name })) }
  return { prepare: () => stmt } as unknown as Database.Database
}
```
> 新增涉及 DB 的单元测试时，沿用此「最小手写桩 + `as unknown as Database.Database`」模式，**不要尝试加载真实 better-sqlite3**。

## Coverage

**Requirements:** 无强制覆盖率门槛（未配置 `--coverage`、无 thresholds）。

**View Coverage:**
```bash
npx vitest run --coverage   # 需先装 coverage provider（@vitest/coverage-v8），当前未配置
```

**实际覆盖现状（7 模块 / 55 tests，安全核心已有回归网）：**
- 有测试：
  - `electron/utils/crypto.ts` — `encrypt`/`decrypt`/`hashPassword`/`verifyPassword`（`:30`/`:41`/`:56`/`:84`）、`decField` 降级与可观测（`:107`）、`setDecryptFailureHandler`（`:102`）、v1/v2 IV 兼容。
  - `electron/services/commandSafety.ts` — `isCommandAllowed`（`:24`）白名单严格匹配 + 注入分隔符拦截 + 黑名单首词 + 管道豁免。
  - `electron/utils/pagination.ts` — `validateLimit`（`:19`）/ `validateOffset`（`:31`）+ `PaginatedResult` envelope。
  - `electron/utils/authGuard.ts` — `secure`（`:31`）鉴权 + `safe`（`:44`）脱敏 + `setAuthenticated`（`:8`），通过 `secure()`/`safe()` 包装行为间接验证 `sanitizeMessage` 脱敏（Win/Unix 路径、长度截断、空消息兜底）。
  - `electron/utils/keyManager.ts` — `getOrCreateMasterKey`（`:27`）新建/明文复用/safeStorage 翻转抛错。
  - `electron/services/auth.ts` — `generateCaptcha`/`verifyCaptcha`（`:12`/`:22`）。
  - `electron/database/migrationHelpers.ts` — `hasColumn`（`:8`）。
- **无测试**：全部 IPC 注册（`electron/ipc/*`）、其余 service（`ouiService`/`anomalyService`/`ai`/`topology`/`device`/`knowledgeBaseService` 等）、`migrations.ts`（v1–v7 迁移链）、全部 React 组件与 Zustand store。
- **DB 层仍用 mock**：因 DEP-1（better-sqlite3 native binding 在 Node/Electron 不同 `NODE_MODULE_VERSION` 下加载冲突），DB 相关逻辑通过手写桩 + `db` 参数注入测纯判定部分，**无真实 DB 的集成层测试**（已知 gap）。

## Test Types

**Unit Tests:**
- 当前唯一类型。范围：纯函数 / 无副作用方法 / 可 mock 依赖的模块（crypto 原语、命令白名单判定、分页校验、captcha 生成校验、IPC 鉴权脱敏判定、masterKey 降级、`hasColumn` 列检查）。
- 异步用 `async`/`await`（crypto: `it('password hash and verify', async () => { ... })`；authGuard: `.resolves`/`.rejects.toThrow`）。

**Integration Tests:**
- **未使用。** 无 IPC → service → DB 全链路测试（因 better-sqlite3 native 难点 DEP-1 未解决）。

**E2E Tests:**
- **未使用。** 无 Electron / Playwright / Spectron 端到端测试。

## Common Patterns

**Async Testing:**
```typescript
it('password hash and verify', async () => {
  const hash = await hashPassword('Pass123!')
  expect(await verifyPassword('Pass123!', hash)).toBe(true)
  expect(await verifyPassword('wrong', hash)).toBe(false)
})
```

**Error Testing（throw 断言）:**
```typescript
it('wrong key fails to decrypt', () => {
  const enc = encrypt('secret', key)
  expect(() => decrypt(enc, 'wrong-key-00000000000000000')).toThrow()
})

// keyManager: safeStorage 翻转必须抛错（非静默返回错误 masterKey）
it('throws when safeStorage flipped and master.key is undecodable blob', () => {
  // ... setup DPAPI blob + safeStorageDecryptThrow = true
  expect(() => getOrCreateMasterKey()).toThrow(/无法解读|safeStorage|backups|master\.key/)
})
```

**Rejects 断言（IPC 鉴权脱敏）:**
```typescript
it('secure rejects when not authenticated', async () => {
  const wrapped = secure(() => 'should not reach')
  await expect(wrapped({})).rejects.toThrow('未登录或会话已过期')
})
```

**可测试性设计约定（重要，指导新代码）：**
- 需要单测的纯逻辑函数 **不要在内部直接调 `getDatabase()` / `window.api` / Electron 模块** —— 把 `db` 或依赖作为参数注入（参考 `hasColumn(db, ...)`）。
- 涉及 DB 的逻辑若要可测，须把 SQL 执行与纯判定分离（判定函数可独立测，DB 执行走集成层 —— 当前集成层缺失，是已知 gap，根因 DEP-1）。
- 必须在模块顶层依赖 `electron`/`fs` 的模块（如 keyManager），用 `vi.mock` 替换依赖即可纳入单测（无需重构注入）。
- 涉及 Electron `ipcMain` / `app` 且无法 mock 的模块（如 `ouiIpc.ts`、`connection.ts`）当前无可行的单测路径，新增此类代码默认不补单测，改以静态类型 + 手测保障。

---

*Testing analysis: 2026-07-26（v0.1.2，含安全核心回归网 R5：commandSafety / authGuard / keyManager；crypto v1/v2 IV 兼容 + decField 可观测 R2）*
