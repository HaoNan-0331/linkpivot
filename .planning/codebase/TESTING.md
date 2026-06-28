# Testing Patterns

**Analysis Date:** 2026-06-28

> 适用范围：`network_toplogy`（Electron + React + TS + better-sqlite3）。当前测试覆盖集中在 **无 native binding 依赖的纯逻辑模块**（crypto / auth captcha / migration helper）。语言：中文叙述 + 英文技术术语/代码标识符。

## Test Framework

**Runner:**
- **vitest** `^4.1.5`（devDependency，`package.json`）
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
npm test            # vitest run（CI/单次，package.json "test"）
npm run test:watch  # vitest（watch 模式，"test:watch"）
```
> 无 coverage 命令、无 `--coverage` 配置。

## Test File Organization

**Location:**
- 集中独立目录 `tests/unit/`（与源码分离，非 co-located）。
- 当前 3 个测试文件：
  - `tests/unit/crypto.test.ts` — 4 tests
  - `tests/unit/auth.test.ts` — 4 tests
  - `tests/unit/migrationHelpers.test.ts` — 4 tests
  - **合计 12 tests。**

**Naming:**
- `<unitName>.test.ts`，`unitName` 对应被测模块名（`crypto` ↔ `electron/utils/crypto.ts`，`auth` ↔ `electron/services/auth.ts`，`migrationHelpers` ↔ `electron/database/migrationHelpers.ts`）。

**Structure:**
```
tests/
└── unit/
    ├── auth.test.ts
    ├── crypto.test.ts
    └── migrationHelpers.test.ts
```
> 无 `tests/integration/` 或 `tests/e2e/`，当前仅 unit 层。

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect } from 'vitest'
import { encrypt, decrypt, hashPassword, verifyPassword } from '../../electron/services/auth'

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
- `describe('<module>', ...)` 套件名 = 被测模块短名。
- 每条 `it('<行为描述>', ...)` 用英文短句描述行为（如 `accepts correct captcha`、`rejects wrong captcha`、`case insensitive`、`wrong key fails to decrypt`）。
- 共享前置用 `beforeEach`（见 `auth.test.ts`：`beforeEach(() => { captcha = generateCaptcha() })`）。
- 类型推导复用被测函数返回类型：`let captcha: ReturnType<typeof generateCaptcha>`。
- 断言风格简洁：`toBe(true)` / `toBeTruthy()` / `toHaveLength(4)` / `toContain('<svg')` / `.not.toBe(...)` / `expect(() => fn()).toThrow()`。

## Mocking

**Framework：** vitest 内置（本仓库当前测试未用 `vi.mock` / `vi.fn`，**全部用手写 typed mock object**）。

**核心策略 — 规避 better-sqlite3 native ABI：**
- better-sqlite3 是 native binding，在 Node 测试环境 vs Electron 运行时 `NODE_MODULE_VERSION` 不同会加载冲突。**测试一律不实例化真实 better-sqlite3**，改用最小手写桩对象满足被测函数所需接口。
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

**Patterns（手写 mock）：**
- 用 `as unknown as Database.Database` 把最小对象强转为 `better-sqlite3` 类型，只实现被测路径调到的方法（`.prepare()` 返回 `{ all }` / `.get()` / `.run()`）。
- crypto / auth 测试无需 mock：`electron/utils/crypto.ts` 纯用 Node `crypto`，`electron/services/auth.ts` 的 `generateCaptcha`/`verifyCaptcha` 纯内存 Map 操作（不触 DB）—— 这正是它们被优先测试的原因。

**What to Mock:**
- `better-sqlite3` Database 连接（手写最小桩，按被测 SQL 桩对应方法返回值）。

**What NOT to Mock:**
- Node 内建 `crypto`（直接用真实实现，crypto.test.ts 验真实 AES-256-GCM 加解密 + PBKDF2）。
- 被测模块自身的纯逻辑（如 `normalizeMac`、`verifyCaptcha`）。

## Fixtures and Factories

**Test Data:**
- 测试数据内联于 `it` 内（无独立 fixtures 目录）：
  - crypto：固定 key 字符串 `'test-key-32-bytes-long-enough!!'`、明文 `'hello world'` / `'same'` / `'secret'`、口令 `'Pass123!'`。
  - auth：`generateCaptcha()` 动态产出 + 错误输入 `'XXXX'`。
  - migrationHelpers：列名数组 `['id', 'name']` / `['id', 'session_id']` 经 `makeDb` 工厂构造。

**Location:**
- 无 `tests/fixtures/` 或 factory 模块。新增 fixture 就近放测试文件顶部（如 `makeDb` helper）。

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

**实际覆盖现状（仅 3 模块 / 12 tests）：**
- 有测试：`electron/utils/crypto.ts`、`electron/services/auth.ts`（captcha 部分）、`electron/database/migrationHelpers.ts`（`hasColumn`）。
- **无测试**：全部 IPC 注册（`electron/ipc/*`）、其余 service（`ouiService`/`anomalyService`/`ai`/`topology`/`device`/`knowledgeBaseService` 等）、`electron/utils/authGuard.ts`（`secure`/`safe`/`sanitizeMessage`）、`migrations.ts`（v1–v7）、全部 React 组件与 Zustand store。

## Test Types

**Unit Tests:**
- 当前唯一类型。范围：纯函数 / 无副作用方法（crypto 原语、captcha 生成校验、`hasColumn` 列检查）。
- 异步用 `async`/`await`（crypto: `it('password hash and verify', async () => { ... })`）。

**Integration Tests:**
- **未使用。** 无 IPC → service → DB 全链路测试（因 better-sqlite3 native 难点未解决）。

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
```

**可测试性设计约定（重要，指导新代码）：**
- 需要单测的纯逻辑函数 **不要在内部直接调 `getDatabase()` / `window.api` / Electron 模块** —— 把 `db` 或依赖作为参数注入（参考 `hasColumn(db, ...)`）。
- 涉及 DB 的逻辑若要可测，须把 SQL 执行与纯判定分离（判定函数可独立测，DB 执行走集成层 —— 当前集成层缺失，是已知 gap）。
- 涉及 Electron `ipcMain` / `app` 的模块（如 `ouiIpc.ts`、`connection.ts`）当前无可行的单测路径，新增此类代码默认不补单测，改以静态类型 + 手测保障。

---

*Testing analysis: 2026-06-28*
