# Testing Patterns

**Analysis Date:** 2026-08-07

> 适用范围：`network_toplogy`（Electron + React + TS + better-sqlite3）。当前测试覆盖 = **安全核心回归网 + v1.1 经验/AI 域 service 层单元测试**。语言：中文叙述 + 英文技术术语/代码标识符。
>
> **v1.1 增量（2026-08-07）：** 测试规模 7 文件/55 tests → **16 文件/232 tests**（vitest 232/232 绿，2026-08-07 实跑验证）；补 9 个 co-located 测试（experienceService/experienceRetrieval/draftingService/duplicateDetector/experienceDrafting/ai.saveChatMessage/ai.telnetRouting/piiMask/experienceService.browse）；`vitest.config.ts` include 实际含 `electron/**/*.test.ts`；service 层「0 测试」断言对 experience 域不再成立。

## Test Framework

**Runner:**
- **vitest** `^4.1.5`（devDependency，`package.json`）
- Config: `vitest.config.ts`
  ```ts
  export default defineConfig({
    test: {
      environment: 'node',                 // 主进程逻辑测试，不需要 DOM
      include: ['tests/**/*.test.ts', 'electron/**/*.test.ts'],  // 双 glob：集中 tests/ + co-located electron/
      server: { deps: { inline: ['../../electron'] } },  // inline electron/ 转换（相对路径绕过 native 外部化）
    },
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  })
  ```
  > **include 修正（v1.1）：** 实际配置采集 **两个 glob**——`tests/**/*.test.ts`（集中安全核心回归网）+ `electron/**/*.test.ts`（service 域 co-located 测试）。旧文档只写 `tests/**/*.test.ts` 是 v1.0 状态，v1.1 Phase 7-11 新增 9 个 co-located 测试后必须双 glob 才能采集全。

**Assertion Library:**
- vitest 内置 `expect`（`import { describe, it, expect, beforeEach } from 'vitest'`），无额外断言库。

**Run Commands:**
```bash
npm test            # vitest run（CI/单次，package.json "test" → "vitest run"）
npm run test:watch  # vitest（watch 模式，"test:watch" → "vitest"）
```
> 无 coverage 命令、无 `--coverage` 配置。

## Test File Organization

**Location（两种合法位置并存）：**
- **集中独立目录 `tests/unit/`**（与源码分离）—— 安全核心回归网（crypto / auth / commandSafety / authGuard / keyManager / migrationHelpers / pagination）走此路径。**7 文件 / 55 tests。**
- **Co-located 就近 `electron/<dir>/<name>.test.ts`**（service 域单元测试）—— v1.1 Phase 7-11 新增的 service 域测试走此路径。**9 文件 / 177 tests。** co-located 子目录 `__tests__/` 也合法（`electron/services/__tests__/experienceService.browse.test.ts`）。

**当前规模：16 文件 / 232 tests**（vitest 232/232 绿，2026-08-07 实跑）：

| 文件 | tests | 行数 | 覆盖 |
|------|-------|------|------|
| `tests/unit/crypto.test.ts` | 10 | — | AES-256-GCM 加解密、PBKDF2 口令哈希、v1/v2 IV 兼容、`decField` 降级与可观测 |
| `tests/unit/commandSafety.test.ts` | 14 | — | 命令白名单严格匹配、shell 注入分隔符拦截、黑名单首词、管道豁免 |
| `tests/unit/pagination.test.ts` | 13 | — | `validateLimit` / `validateOffset` / `PaginatedResult` envelope |
| `tests/unit/authGuard.test.ts` | 7 | — | `secure` 鉴权 + `safe` 包装 + 路径/长度脱敏 |
| `tests/unit/auth.test.ts` | 4 | — | captcha 生成与校验 |
| `tests/unit/migrationHelpers.test.ts` | 4 | — | `hasColumn` |
| `tests/unit/keyManager.test.ts` | 3 | — | masterKey 新建/复用/safeStorage 翻转抛错 |
| `electron/services/experienceService.test.ts` | — | 1121 | 经验 CRUD / 设备多对多 / bi-temporal 软失效 / attrs_enc 加密 / severity 校验 / MAX_BATCH |
| `electron/services/__tests__/experienceService.browse.test.ts` | — | 865 | Phase 10 浏览页：listExperiences 多维筛选（search/severity/tags/deviceId）/ invalidate/restore / stripEncColumns |
| `electron/services/experienceRetrieval.test.ts` | — | 359 | Phase 11 检索：召回 + 阈值过滤 + 设备命中 + tiebreaker（WR-08）|
| `electron/services/draftingService.test.ts` | — | 361 | Phase 8：`validateDrafts` 强 schema Gate / confidence 边界 / verdict 枚举 / `draftSession` 重试 |
| `electron/services/experienceDrafting.test.ts` | — | 266 | Phase 8 起草编排：`judgeVerdicts` W-4 两阶段复判 / piiMask 串联 |
| `electron/services/duplicateDetector.test.ts` | — | 97 | Phase 8 重复检测：duplication_verdict 判定 |
| `electron/services/ai.telnetRouting.test.ts` | — | 230 | AI 路由：telnet 设备命令分流判定 |
| `electron/services/ai.saveChatMessage.test.ts` | — | 84 | AI 会话消息持久化 |
| `electron/utils/piiMask.test.ts` | — | 143 | Phase 8 D-04：凭证/IPv4/MAC 三级脱敏 + 连接词形态 + 中文关键词 + 边界 |

**Naming:**
- `<unitName>.test.ts`，`unitName` 对应被测模块名：
  - 集中：`crypto` ↔ `electron/utils/crypto.ts`、`commandSafety` ↔ `electron/services/commandSafety.ts`、`pagination` ↔ `electron/utils/pagination.ts`、`authGuard` ↔ `electron/utils/authGuard.ts`、`auth` ↔ `electron/services/auth.ts`、`migrationHelpers` ↔ `electron/database/migrationHelpers.ts`、`keyManager` ↔ `electron/utils/keyManager.ts`。
  - Co-located：`experienceService` ↔ `electron/services/experienceService.ts`、`draftingService` ↔ `electron/services/draftingService.ts`、`piiMask` ↔ `electron/utils/piiMask.ts`、`experienceRetrieval` ↔ `electron/services/experienceRetrieval.ts`、`duplicateDetector` ↔ `electron/services/duplicateDetector.ts`、`experienceDrafting` ↔ `electron/services/experienceDrafting.ts`、`ai.saveChatMessage` / `ai.telnetRouting` ↔ `electron/services/ai.ts`（同模块多测试文件用 `<module>.<feature>.test.ts` 点分命名区分）。

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
electron/
├── services/
│   ├── ai.saveChatMessage.test.ts
│   ├── ai.telnetRouting.test.ts
│   ├── draftingService.test.ts
│   ├── duplicateDetector.test.ts
│   ├── experienceDrafting.test.ts
│   ├── experienceRetrieval.test.ts
│   ├── experienceService.test.ts
│   └── __tests__/
│       └── experienceService.browse.test.ts
└── utils/
    └── piiMask.test.ts
```
> 无 `tests/integration/` 或 `tests/e2e/`，当前仅 unit 层（co-located + 集中并存）。

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
- `describe('<module>', ...)` 套件名 = 被测模块短名（commandSafety 套件为 `commandSafety isCommandAllowed`，体现「模块 + 被测函数」两级；experience 域常按行为分组多 `describe`，如 `describe('bi-temporal 软失效')` / `describe('severity 校验')`）。
- 每条 `it('<行为描述>', ...)` 用英文短句描述行为（如 `allows whitelist first word exact match`、`rejects newline injection`、`secure sanitizes Windows absolute path from error`、`case insensitive`、`wrong key fails to decrypt`、`maskCredentials masks password is hunter2`）。
- 共享前置用 `beforeEach`（见 `auth.test.ts`：`beforeEach(() => { captcha = generateCaptcha() })`；`authGuard.test.ts`：`beforeEach(() => setAuthenticated(false))`；`keyManager.test.ts` 重置 memStore + safeStorage 状态；`experienceService.test.ts`：`beforeEach` 注入内存 mock DB + `setExperienceMasterKey('test-key')` + 清表）。
- 类型推导复用被测函数返回类型：`let captcha: ReturnType<typeof generateCaptcha>`。
- 断言风格简洁：`toBe(true)` / `toBeTruthy()` / `toHaveLength(4)` / `toContain('<svg')` / `.not.toBe(...)` / `.resolves.toBe(...)` / `.rejects.toThrow(...)` / `expect(() => fn()).toThrow()` / `expect.unreachable('should have thrown')`。
- 安全核心测试（commandSafety / authGuard）在文件顶部注释标注回归网来源（`// 安全核心回归网（审计 R5 / TEST-1）`），说明「改一行可能放行 reboot 而无拦截」的拦截意图。

## Mocking

**Framework：** vitest 内置（`vi.mock` / `vi.fn`）。本仓库 **大部分测试用手写 typed mock object**（crypto/auth/commandSafety/pagination/migrationHelpers/experience 域全系列），**仅 keyManager.test.ts 用 `vi.mock` 替换 `fs` 与 `electron` 模块**。

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

**经验域 service 的 db 注入约定（v1.1 新增）：**
- `experienceService.ts` 等函数式 service 内部默认调 `getDatabase()` 单例，但导出 `@internal _setExperienceDbGetter(fn)`（`experienceService.ts` 的 `_setExperienceDbGetter`）供测试注入**完整内存 mock DB**（不是单语句桩，而是带 `prepare/run/all/get/transaction/pragma` 的可建表可查 mock，因 service 测试需走真实 SQL 流程：建 experiences/exp_device_rel 表 → CRUD → 软失效 → 多维筛选）。
- `beforeEach` 注入：`_setExperienceDbGetter(() => memDb)` + `setExperienceMasterKey(MK_TEST_KEY)` + 清表，见 `experienceService.test.ts:548`。
  ```typescript
  // experienceService.test.ts（@internal db getter 注入 + masterKey 注入）
  import { setExperienceMasterKey, _setExperienceDbGetter } from './experienceService'
  beforeEach(() => {
    _setExperienceDbGetter(() => memDb)         // 内存 mock DB（带建表/事务/pragma）
    setExperienceMasterKey(MK_TEST_KEY)          // 注入测试 masterKey
    memDb.exec('DELETE FROM experiences; DELETE FROM exp_device_rel;')
  })
  ```
- **这是 v1.1 service 层可测试的关键**——相比 v1.0「service 层 0 测试」，v1.1 经验域 service 通过 `_setXxxDbGetter` 注入 + `setXxxMasterKey` 注入，使 CRUD/加密/事务/筛选全链路可单测（不触真实 better-sqlite3）。

**`vi.mock` 模式（keyManager.test.ts，mock Electron 依赖）：**
- keyManager 依赖 `electron.safeStorage` + `fs`，无法纯 node 直接跑。用 `vi.mock('fs', ...)` 提供 mem store，`vi.mock('electron', ...)` 提供可控 safeStorage（`isEncryptionAvailable` / `decryptString` / `encryptString`），通过模块级布尔标志（`safeStorageAvailable` / `safeStorageDecryptThrow`）在 `beforeEach` 切换场景。
- 关键回归：safeStorage 翻转（换账户/换机）+ master.key 是无法解读的 DPAPI blob 时，`getOrCreateMasterKey` 必须抛错，而非把二进制 blob 当 UTF-8 trim 出错误 masterKey（对应审计 R3）。

**Patterns（手写 mock）：**
- 用 `as unknown as Database.Database` 把最小对象强转为 `better-sqlite3` 类型，只实现被测路径调到的方法（`.prepare()` 返回 `{ all }` / `.get()` / `.run()`）。
- 经验域用更完整的内存 mock DB（支持 `transaction(fn)` 调用、`pragma('table_info')` 多表、`exec(DDL)`），因 service 走真实建表/事务。
- crypto / auth / commandSafety / pagination / piiMask 测试无需 mock：`electron/utils/crypto.ts` 纯用 Node `crypto`、`electron/services/auth.ts` 的 `generateCaptcha`/`verifyCaptcha` 纯内存 Map 操作、`commandSafety.ts` 纯函数、`pagination.ts` 纯校验函数、`piiMask.ts` 纯字符串 transform（均不触 DB/electron）—— 这正是它们被优先测试的原因。

**What to Mock:**
- `better-sqlite3` Database 连接：单语句桩（`makeDb`，适 `hasColumn` 等单 SQL 判定）或完整内存 mock DB（适 service CRUD 全链路，经 `_setXxxDbGetter` 注入）。
- `electron`（`app`/`safeStorage`）与 `fs` —— 仅当被测模块在模块顶层依赖它们时（如 keyManager），用 `vi.mock` 替换。
- masterKey：经 `setXxxMasterKey('test-key')` 注入测试值（不 mock crypto，用真实 AES-256-GCM 加解密验加解密闭环）。

**What NOT to Mock:**
- Node 内建 `crypto`（直接用真实实现，crypto.test.ts 验真实 AES-256-GCM 加解密 + PBKDF2，包括 v1 16 字节 IV / v2 12 字节 IV 前缀两条路径；experienceService.test.ts 验 attrs_enc 真实加解密）。
- 被测模块自身的纯逻辑（如 `isCommandAllowed`、`validateLimit`、`normalizeMac`、`verifyCaptcha`、`secure`/`safe` 的鉴权与脱敏判定、`validateDrafts` schema Gate、`maskConversationText` 脱敏）。

## Fixtures and Factories

**Test Data:**
- 测试数据内联于 `it` 内（无独立 fixtures 目录）：
  - crypto：固定 key 字符串 `'test-key-32-bytes-long-enough!!'`、明文 `'hello world'` / `'same'` / `'secret'` / `'设备密码'`、口令 `'Pass123!'`；v1 密文用 `crypto.randomBytes` 现场构造（salt 64B + iv 16B + tag + ciphertext，无 `v2:` 前缀）。
  - auth：`generateCaptcha()` 动态产出 + 错误输入 `'XXXX'`。
  - migrationHelpers：列名数组 `['id', 'name']` / `['id', 'session_id']` 经 `makeDb` 工厂构造。
  - commandSafety：内联白名单 `['display', 'show', 'ping', 'terminal', 'traceroute']` 与黑名单首词数组（reboot/reload/shutdown/configure/...）。
  - authGuard：构造含敏感信息的错误消息（`'failed to open C:\\Users\\admin\\secret.db'`、`'cannot read /home/operator/config/key.pem'`、500 字符长串）验证脱敏。
  - keyManager：`crypto.randomBytes(32).toString('base64')` 造合法 masterKey；`Buffer.from([0x01,0x02,...])` 造无法解读的 DPAPI blob。
  - piiMask：`'password is hunter2'` / `'token 为 xxx'` / `'密码 xxx'`（连接词形态）、`'10.0.0.1'`（IPv4）、`'AA:BB:CC:DD:EE:FF'`（MAC）、中文关键词 `'密码：secret123'`。
  - experienceService：`ExperienceInput` 对象工厂（`{ title, category: 'troubleshooting', content, attrs: { severity: 'high', symptoms, resolution } }`）、设备关联 fixture（exp_id + device_id 对）、bi-temporal 时间戳 `'2026-08-07 12:00:00'`。

**Location:**
- 无 `tests/fixtures/` 或 factory 模块。新增 fixture 就近放测试文件顶部（如 `makeDb` helper、`memDb` 内存 DB 构造函数、`memStore` Map、`safeStorageAvailable` 标志、`MK_TEST_KEY` 常量）。
- **已知重复（审计 §1.3 WR-08，待清理）**：Phase 10 两测试文件（`experienceService.test.ts` + `experienceService.browse.test.ts`）重复 ~400 行 MemDb mock 构造代码，应抽公共 fixture 模块。

**Factory pattern（推荐复用）：**
```typescript
function makeDb(colNames: string[]): Database.Database {
  const stmt = { all: () => colNames.map((name) => ({ name })) }
  return { prepare: () => stmt } as unknown as Database.Database
}
```
> 新增涉及 DB 的单元测试时，沿用「最小手写桩 + `as unknown as Database.Database`」（单 SQL 判定）或「完整内存 mock DB + `_setXxxDbGetter` 注入」（service 全链路），**不要尝试加载真实 better-sqlite3**。

## Coverage

**Requirements:** 无强制覆盖率门槛（未配置 `--coverage`、无 thresholds）。

**View Coverage:**
```bash
npx vitest run --coverage   # 需先装 coverage provider（@vitest/coverage-v8），当前未配置
```

**实际覆盖现状（16 模块 / 232 tests，安全核心 + v1.1 经验域已有回归网）：**
- 有测试：
  - `electron/utils/crypto.ts` — `encrypt`/`decrypt`/`hashPassword`/`verifyPassword`、`decField` 降级与可观测、`setDecryptFailureHandler`、v1/v2 IV 兼容。
  - `electron/services/commandSafety.ts` — `isCommandAllowed` 白名单严格匹配 + 注入分隔符拦截 + 黑名单首词 + 管道豁免。
  - `electron/utils/pagination.ts` — `validateLimit` / `validateOffset` + `PaginatedResult` envelope。
  - `electron/utils/authGuard.ts` — `secure` 鉴权 + `safe` 脱敏 + `setAuthenticated`，间接验证 `sanitizeMessage` 脱敏。
  - `electron/utils/keyManager.ts` — `getOrCreateMasterKey` 新建/明文复用/safeStorage 翻转抛错。
  - `electron/services/auth.ts` — `generateCaptcha`/`verifyCaptcha`。
  - `electron/database/migrationHelpers.ts` — `hasColumn`。
  - **`electron/services/experienceService.ts`（v1.1 新增）** — CRUD / 设备多对多 / bi-temporal 软失效/恢复 / attrs_enc 加密 / severity 校验 / MAX_BATCH / assertCanonicalTimestamp 守卫。
  - **`electron/services/experienceRetrieval.ts`（v1.1 新增）** — 检索召回 + 阈值过滤 + 设备命中 + tiebreaker。
  - **`electron/services/draftingService.ts`（v1.1 新增）** — `validateDrafts` 强 schema Gate / confidence 边界 / verdict 枚举 / `draftSession` 重试 / `judgeVerdicts` W-4。
  - **`electron/services/experienceDrafting.ts`（v1.1 新增）** — 起草编排 / piiMask 串联。
  - **`electron/services/duplicateDetector.ts`（v1.1 新增）** — duplication_verdict 判定。
  - **`electron/services/ai.ts`（v1.1 新增部分）** — `saveChatMessage` / telnet 路由分流（同模块 2 测试文件点分命名）。
  - **`electron/utils/piiMask.ts`（v1.1 新增）** — 凭证/IPv4/MAC 三级脱敏 + 连接词 + 中文关键词。
- **无测试**：全部 IPC 注册（`electron/ipc/*`，含 `experienceIpc.ts`/`experienceDraftingIpc.ts`）、其余 service（`ouiService`/`anomalyService`/`topology`/`device`/`knowledgeBaseService`/`arpCollector`/`connection`/`experienceRerank` 等）、`migrations.ts`（v1–v10 迁移链）、全部 React 组件与 Zustand store。
- **DB 层仍用 mock**：因 DEP-1（better-sqlite3 native binding 在 Node/Electron 不同 `NODE_MODULE_VERSION` 下加载冲突），DB 相关逻辑通过手写桩 / 内存 mock DB + `_setXxxDbGetter` 注入测纯判定与 service 全链路，**无真实 DB 的集成层测试**（已知 gap）。v1.1 经验域通过 `_setExperienceDbGetter` 注入完整内存 mock DB，使 service 层 CRUD/加密/事务/筛选可单测，**「service 层 0 测试」断言对 experience 域不再成立**（其余 service 域仍 0 测试）。

## Test Types

**Unit Tests:**
- 当前唯一类型。范围：纯函数 / 无副作用方法 / 可 mock 依赖的模块（crypto 原语、命令白名单判定、分页校验、captcha 生成校验、IPC 鉴权脱敏判定、masterKey 降级、`hasColumn` 列检查、PII 脱敏 transform、强 schema LLM 输出 Gate、经验 CRUD/检索/起草全链路）。
- 异步用 `async`/`await`（crypto: `it('password hash and verify', async () => { ... })`；authGuard: `.resolves`/`.rejects.toThrow`；draftingService: `it('draftSession retries on validate fail', async () => { ... })`）。

**Integration Tests:**
- **未使用。** 无 IPC → service → DB 全链路测试（因 better-sqlite3 native 难点 DEP-1 未解决）。v1.1 经验域 service 测试通过内存 mock DB 逼近集成层，但仍非真实 DB。

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

// draftingService：LLM 重试循环（v1.1 新增）
it('draftSession retries on validate fail then succeeds', async () => {
  // mock callAI 第 1 次返坏 JSON，第 2 次复合法 JSON
  expect(await draftSession(input)).toHaveLength(expectedCount)
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

// experienceService: assertCanonicalTimestamp 前瞻守卫（v1.1 新增）
it('assertCanonicalTimestamp rejects non-canonical format', () => {
  expect(() => assertCanonicalTimestamp('2026-08-07T12:00:00', 'valid_at')).toThrow(/格式必须是 YYYY-MM-DD HH:MM:SS/)
})
```

**Rejects 断言（IPC 鉴权脱敏）:**
```typescript
it('secure rejects when not authenticated', async () => {
  const wrapped = secure(() => 'should not reach')
  await expect(wrapped({})).rejects.toThrow('未登录或会话已过期')
})
```

**schema Gate 返回值断言（v1.1 新增，validateDrafts 范式）:**
```typescript
it('validateDrafts rejects bad category enum', () => {
  const raw = JSON.stringify([{ category: 'bogus', title: 't', content: 'c', confidence: 0.9, duplication_verdict: 'ADD', duplicate_of_exp_id: null }])
  const result = validateDrafts(raw)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/category 非法/)
})

it('validateDrafts normalizes 85% confidence to 0.85', () => {
  const result = validateDrafts(validRawWithConfidence('85%'))
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.drafts[0].confidence).toBe(0.85)
})
```

**可测试性设计约定（重要，指导新代码）：**
- 需要单测的纯逻辑函数 **不要在内部直接调 `getDatabase()` / `window.api` / Electron 模块** —— 把 `db` 或依赖作为参数注入（参考 `hasColumn(db, ...)`）。
- 函数式 service 内部调 `getDatabase()` 单例时，**导出 `@internal _setXxxDbGetter(fn)` 供测试注入内存 mock DB**（参考 `experienceService._setExperienceDbGetter`），生产代码不调用——比把 `db` 提到每个 public 函数签名更干净。
- 加密型 service 经 `setXxxMasterKey('test-key')` 注入测试 masterKey，**不 mock crypto**（用真实 AES-256-GCM 验加解密闭环）。
- 涉及 DB 的逻辑若要可测，须把 SQL 执行与纯判定分离（判定函数可独立测，DB 执行走集成层 —— 当前集成层缺失，是已知 gap，根因 DEP-1）。v1.1 经验域用完整内存 mock DB 逼近集成层。
- 必须在模块顶层依赖 `electron`/`fs` 的模块（如 keyManager），用 `vi.mock` 替换依赖即可纳入单测（无需重构注入）。
- 涉及 Electron `ipcMain` / `app` 且无法 mock 的模块（如 `ouiIpc.ts`、`connection.ts`、`experienceIpc.ts`）当前无可行的单测路径，新增此类代码默认不补单测，改以静态类型 + 手测保障。

---

*Testing analysis: 2026-08-07（v1.1 增量刷新：16 文件/232 tests，补 9 co-located 经验/AI 域测试 + include 双 glob 修正 + `_setExperienceDbGetter` 注入范式 + service 层 experience 域已有回归网）*
