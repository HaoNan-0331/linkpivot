# Phase 12: Test Infrastructure (DEP-1 ABI 缓解) - Pattern Map

**Mapped:** 2026-08-07
**Files analyzed:** 11（新增/修改）
**Analogs found:** 11 / 11（全部命中，0 无 analog）

## File Classification

| 新增/修改文件 | 角色 | 数据流 | 最接近的 analog | 匹配质量 |
|---------------|------|--------|-----------------|----------|
| `vitest.electron.config.ts`（新增） | config | request-response | `vitest.config.ts` | exact（同型双 config） |
| `package.json` scripts（修改：+1 `test:electron`） | config | request-response | `package.json` 现有 `test` / `rebuild:native` script | exact（同文件追加） |
| `tests/electron/_helpers/handleLeakDetector.ts`（新增） | utility | event-driven | `tests/unit/migrationHelpers.test.ts`（最小 mock 桩 util）+ `ai.telnetRouting.test.ts`（afterEach/mockClear 生命周期） | role-match（无现成 leak detector，但有测试 util + afterEach 范式） |
| `tests/electron/_helpers/mockSshServer.ts`（新增） | utility | request-response | `electron/services/arpCollector.ts` 的 `ssh2.Client` 用法（同库双向 Client↔Server） | role-match（无现成 Server，但同库 Client 用法即对端协议参考） |
| `tests/electron/_helpers/mockTelnetServer.ts`（新增） | utility | request-response | `electron/services/connection.ts:1-5`（`net` import）+ `electron/utils/telnetExec.ts`（telnet 协议消费方） | role-match（无现成 net.Server echo，但 net/telnet 消费方即协议参考） |
| `tests/electron/_helpers/realDb.ts`（新增） | utility | file-I/O | `electron/database/connection.ts:21-35`（`initDatabase` 真路径建库）+ `experienceService.ts:36-45`（`_setExperienceDbGetter` 注入钩子） | role-match（无现成临时 DB helper，但真路径建库 + 注入钩子两范式都在） |
| `tests/electron/db.real.test.ts`（新增） | test | CRUD | `tests/unit/migrationHelpers.test.ts`（DB mock 桩 + 真实 prepare/pragma API）+ `electron/database/migrations.test.ts`（迁移幂等 + 双路径 DDL 比对） | role-match（现有 DB 测试全 mock，真路径无前例，但 API shape + 迁移测试范式可循） |
| `tests/electron/ai.execCommands.real.test.ts`（新增） | test | event-driven | `electron/services/ai.telnetRouting.test.ts`（vi.mock ssh2 Client + executeCommandsOnDevice 入参断言） | exact（同被测函数 + 同 mock 库） |
| `tests/electron/arpCollector.real.test.ts`（新增） | test | event-driven | `electron/services/ai.saveChatMessage.test.ts`（mock ssh2/telnetExec/commandSafety 让 service 干净加载） | role-match（arpCollector 0 现有测试，但同「mock ssh2 让 service 加载」范式） |
| `tests/electron/telnetExec.real.test.ts`（新增） | test | request-response | `ai.telnetRouting.test.ts:44-50`（`vi.mock('../utils/telnetExec', importActual+spy)`） | role-match（现 mock telnetExec，真路径测 telnetExec 本身无前例，但被测协议+mock 范式可循） |
| `.github/workflows/build-smoke.yml`（可能修改） | config | batch | 现有 `build-smoke.yml:23-31`（npm ci → rebuild → build → test 步骤序列） | exact（同文件扩展） |

> 待 modify 的文件集合**严格限定**在测试/配置/dev chain（SC4 红线）：`vitest.electron.config.ts`（新）/ `package.json` scripts（+1）/ `tests/electron/**`（新）/ `.github/workflows/build-smoke.yml`（可能扩展）。**不可出现** `electron/main.ts` / `electron/services/*.ts` 生产逻辑 / `electron-builder.yml` / `vite.config.ts` / esbuild 配置改动。
>
> 唯一允许的生产代码微改候选（planner + 用户 plan review 定）：`electron/database/connection.ts` 或 `electron/database/init.ts` 加 `@internal _setDbGetter` 注入点（与 `experienceService.ts:39 _setExperienceDbGetter` 同范式）—— RESEARCH.md Open Question #1 优先推荐零侵入的 `vi.mock`，回退才考虑此微改。

## Pattern Assignments

### `vitest.electron.config.ts`（config, request-response）

**Analog:** `vitest.config.ts`（1-18 全文）

**Imports + 配置骨架** —— 复制 analog 的 `defineConfig` + `environment: 'node'` 结构，**改 include + 删 server.deps.inline + 加 timeout**：

```typescript
// vitest.config.ts:1-18（analog 全文，作为模板）
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'electron/**/*.test.ts'],  // ← 新 config 改为 ['tests/electron/**/*.test.ts']
    server: {
      deps: {
        inline: ['../../electron'],  // ← 新 config 删除（真路径用真 binding，不 inline 转换）
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
})
```

**新 config 应落地形态**（RESEARCH.md §Pattern 2 已给推荐，planner 据此 copy）：

```typescript
// vitest.electron.config.ts【新增】
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/electron/**/*.test.ts'],  // 严格限定，不碰 electron/**（Pitfall 6）
    testTimeout: 15000,   // ssh2/telnet 网络操作
    hookTimeout: 10000,
  },
})
```

**关键差异（必须体现）**：
- include 限定 `tests/electron/**` —— 现有 config include 含 `electron/**/*.test.ts`，新 config **绝不重复采集**（Pitfall 6：否则 electron.exe 跑一遍 plain-node mock 套件，vi.mock 失效 + 用例数翻倍）
- 删 `server.deps.inline` —— 真路径用 electron-ABI 真 binding，不需 inline 转换

---

### `package.json` scripts +1 `test:electron`（config, request-response）

**Analog:** `package.json:13-16`（现有 test 相关 scripts）

**现有 scripts 段（analog，严格不动）**：

```jsonc
// package.json:13-16
"rebuild:native": "electron-rebuild -f -w better-sqlite3 -w ssh2",
"electron:build": "npm run rebuild:native && npm run build && electron-builder",
"test": "vitest run",
"test:watch": "vitest"
```

**新增 script 形态**（RESEARCH.md §最小侵入方案 + §Pattern 1）：

```jsonc
// 在 scripts 段追加（不改既有任何 script）
"test:electron": "cross-env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run --config vitest.electron.config.ts"
```

**复用的现有 devDep**（package.json:43 `cross-env` 已在，零新增除 wtfnode）：
- `cross-env ^10.1.0`（line 43）—— 跨平台设 `ELECTRON_RUN_AS_NODE=1`
- `electron ^41.0.3`（line 44）—— 提供 `node_modules/electron/dist/electron.exe`
- `vitest ^4.1.5`（line 50）—— 入口 `node_modules/vitest/vitest.mjs`（A1 待 planner checkpoint 验实际启动）

**红线**（Pitfall 2）：直连 `node_modules/electron/dist/electron.exe` 路径，**不用** `electron` CLI（CLI 会拉起 BrowserWindow）。

---

### `tests/electron/_helpers/handleLeakDetector.ts`（utility, event-driven）

**Analog（组合）**：
1. `tests/unit/migrationHelpers.test.ts:11-14` —— 最小 util/helper 模式（函数式 export + 类型断言桩）
2. `electron/services/ai.telnetRouting.test.ts:69-76` —— `beforeEach` mockClear 生命周期（afterEach 取基线 + 清理的节奏参考）

**vitest import + lifecycle hook 范式**（ai.telnetRouting.test.ts:1）：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
```

**handleLeakDetector 应落地形态**（RESEARCH.md §句柄泄漏检测机制 §Pattern 代码块已给完整骨架，planner copy）：

```typescript
// tests/electron/_helpers/handleLeakDetector.ts
import { afterEach } from 'vitest'

export function expectNoHandleLeak(extraAllow: string[] = []) {
  const baseline = process.getActiveResourcesInfo()  // 取基线（注意：RESEARCH 原代码用 new Set(...)，实际应数组取值）
  const allowDefault = ['Timeout', 'GetAddrInfoReqWrap']
  const allow = new Set([...allowDefault, ...extraAllow])

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50))  // 给 cleanup 异步时间（Pitfall 5）
    const after = process.getActiveResourcesInfo()
    const leaked = after.filter((h) => !allow.has(h) && !baseline.includes(h))
    if (leaked.length > 0) {
      const wtf = await import('wtfnode').catch(() => null)  // best-effort 诊断（A4）
      if (wtf) wtf.dump()
      throw new Error(`句柄泄漏: ${JSON.stringify(leaked)}`)
    }
  })
}
```

**关键 pitfall（必须体现）**：
- baseline 在 `beforeEach`/调用点取（紧贴被测代码执行前），**不在 `beforeAll`**（Pitfall 5：vitest runner 自身 timer 会漂移）
- 默认 allowlist 放行 vitest 自身 `Timeout`/`GetAddrInfoReqWrap`（Pitfall 5）
- `await sleep(50)` 给 ssh2.end() 异步 EOF 时间（Pitfall 4：mock server 异步 close）
- wtfnode best-effort import，装失败不阻塞（A4 fallback）

---

### `tests/electron/_helpers/mockSshServer.ts`（utility, request-response）

**Analog:** `electron/services/arpCollector.ts:25-75`（`executeSSH` —— ssh2.Client 被测消费方，**同库双向 Client↔Server 协议参考**）

**ssh2.Client 被测用法**（arpCollector.ts:25-69，作为 Server 端必须镜像的协议序列）：

```typescript
// arpCollector.ts:25-69（analog —— 真实 Client 的 connect/exec/stream 序列）
import { Client } from 'ssh2'
// ...
const client = new Client()
client.on('ready', () => {
  client.exec(command, (err, stream) => {  // ← mock Server 必须响应 exec 事件
    stream.on('data', ...)                   // ← mock stream.end(onExec(cmd)) 回显
    stream.on('close', ...)
  })
})
client.on('error', ...)
client.connect({ host, port, username, password, readyTimeout, algorithms })  // ← Server 端 authentication.accept()
```

**ssh2 import 范式**（arpCollector.ts:1）：

```typescript
import { Client } from 'ssh2'   // analog；新 helper 改为 import { Server } from 'ssh2'（同库双向 API）
```

**mockSshServer 应落地形态**（RESEARCH.md §真路径 mock 对端方案 § mockSshServer 代码块已给完整骨架，planner copy）。关键点：
- `new Server({ hostKeys: [generateTestHostKey()] }, ...)` —— 测试用 `crypto.generateKeyPairSync` 随机 hostKey，**不写真实凭证**（安全域威胁已识别）
- `client.on('authentication', ctx => ctx.accept())` —— 镜像 Client.connect 的 username/password 流
- `session.on('exec', (accept, _, { command }) => accept().end(onExec(command)))` —— 镜像 Client 的 `client.exec(command, cb)` 流
- `server.listen(0, '127.0.0.1', ...)` —— 端口 0 随机分配，仅本地（CI/本地都不暴露）
- A2 待 planner checkpoint：ssh2.Server 在 ELECTRON_RUN_AS_NODE 下 listen 未本地实跑

---

### `tests/electron/_helpers/mockTelnetServer.ts`（utility, request-response）

**Analog:** `electron/services/connection.ts:5`（`import net from 'net'`）+ `electron/utils/telnetExec.ts:127-146`（telnet-client 消费方 —— mock echo server 必须镜像的 connect/exec 序列）

**net import 范式**（connection.ts:5）：

```typescript
import net from 'net'   // analog；新 helper 用 net.createServer 起 echo server
```

**telnet 消费方协议序列**（telnetExec.ts:127-146，mock server 端必须响应的 data 流）：

```typescript
// telnetExec.ts:127-146（analog —— telnet-client 的 connect + exec 真实序列）
await connection.connect({
  host, port, timeout, username, password,
  loginPrompt: /Username:|login:/i,       // ← mock server 需发 "Username:" / "Password:" 提示
  passwordPrompt: /Password:/i,
  shellPrompt: shellPrompt ?? /[>#]/,      // ← mock server 需发 shellPrompt（如 "mock>"）
  echoLines: 0, stripShellPrompt: true, execTimeout: timeout,
})
if (disablePaginationCmd) { await connection.exec(disablePaginationCmd) }  // ← 先发关分页命令
const out = await connection.exec(command)  // ← 再发主命令，mock server 回显
```

**mockTelnetServer 应落地形态**（RESEARCH.md §真路径 mock 对端方案 § mockTelnetServer 代码块已给完整骨架，planner copy）：

```typescript
// tests/electron/_helpers/mockTelnetServer.ts
import net from 'net'

export function startMockTelnetServer(onCmd: (cmd: string) => string, shellPrompt = 'mock>'): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.write(shellPrompt)
      socket.on('data', (buf) => {
        const cmd = buf.toString().trim()
        if (cmd) socket.write(onCmd(cmd) + '\r\n' + shellPrompt)
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as any).port, close: () => server.close() }))
  })
}
```

注意：telnet-client 协议是明文 TCP + IAC 协商字节；极简 echo server 需处理 telnet-client 握手（发 IAC 协商响应或忽略）。planner checkpoint：telnet-client 默认会发 IAC WILL/WONT 协商，mock server 需回 IAC DONT/WONT 否则 connect 卡住。这是 RESEARCH.md 未完全展开的细节。

---

### `tests/electron/_helpers/realDb.ts`（utility, file-I/O）

**Analog（组合）**：
1. `electron/database/connection.ts:21-35`（`initDatabase` 真路径建库 —— 复刻其 WAL/pragma 设置）
2. `electron/services/experienceService.ts:36-45`（`_setExperienceDbGetter` 注入钩子 —— DB 层真路径测试的注入参考）

**真路径建库范式**（connection.ts:21-35，realDb helper 应复刻的 pragma 序列）：

```typescript
// connection.ts:21-35（analog —— 生产建库路径）
export function initDatabase(): Database.Database {
  const dbPath = path.join(app.getPath('userData'), 'topology.db')
  dbExistedBeforeOpen = fs.existsSync(dbPath)
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')      // ← realDb 复刻
  db.pragma('foreign_keys = ON')        // ← realDb 复刻
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 1000')
  // ...
  return db
}
```

**注入钩子范式**（experienceService.ts:35-45，**关键 @internal + getter 替换模式**）：

```typescript
// experienceService.ts:35-45（analog —— 测试专用注入点的标准写法）
// 默认走生产单例 db；测试经 _setExperienceDbGetter 注入内存 mock（规避 DEP-1 native binding ABI 冲突）。
let dbGetter: () => Database.Database = getDatabase

/** @internal 测试专用：注入 db getter（生产不调用）。 */
export function _setExperienceDbGetter(fn: () => Database.Database): void {
  dbGetter = fn
}

function db(): Database.Database {
  return dbGetter()
}
```

**realDb 应落地形态**（RESEARCH.md §真路径 mock 对端方案 § realDb 代码块已给骨架，planner copy）。关键点：
- 临时文件路径 `os.tmpdir() + nt-test-${Date.now()}-${Math.random()}` —— 唯一防并发撞（Pitfall 3）
- `close()` 严格顺序：`db.close()` → `fs.unlinkSync(dbPath)` + `-wal` + `-shm`（Pitfall 3：侧车文件残留致状态串味）
- `-wal`/`-shm` unlink 必须 try/catch 容错 not-exist（Pitfall 3）

**getDatabase() 注入策略（RESEARCH.md Open Question #1，planner 必决）**：
- **方案 A（推荐，零侵入）**：`vi.mock('../../electron/database/connection', () => ({ getDatabase: () => realDb }))` —— 但 connection.ts 被 ai/arpCollector/experienceService 等多 service import，级联 mock 可能过重
- **方案 B（微改生产）**：在 `connection.ts` 加 `export function _setDbGetter(fn)` `@internal`（与 `_setExperienceDbGetter` 同范式 1-2 行）—— 属 SC4 边界，planner + 用户 plan review 定

---

### `tests/electron/db.real.test.ts`（test, CRUD）

**Analog（组合）**：
1. `tests/unit/migrationHelpers.test.ts:11-14`（DB 桩 API shape：`{ prepare: () => ({ all: ... }) }`）—— 真路径 better-sqlite3 同 API，桩替真
2. `electron/database/migrations.test.ts:100-168`（迁移幂等 + 双路径 DDL 比对测试范式）

**vitest import + DB 类型导入范式**（migrationHelpers.test.ts:1-3 + experienceService.test.ts:1-2）：

```typescript
// migrationHelpers.test.ts:1-3（analog）
import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'  // ← 真路径改 import Database from 'better-sqlite3'（实加载）
```

**迁移幂等测试范式**（migrations.test.ts:101-113，db.real 测试迁移幂等可复刻断言结构）：

```typescript
// migrations.test.ts:101-113（analog —— 幂等 no-op + 执行 DDL 序断言）
it('1. 幂等 no-op：sqlite_master sql 已含特征 → 不重建', () => {
  const { db, execCalls, pragmaCalls } = makeMockDb({ logSchemaSql: '...' })
  v11(db)
  expect(execCalls).toHaveLength(0)
  expect(pragmaCalls).toHaveLength(0)
})
```

**真路径测试应覆盖**（RESEARCH.md §测试用例优先级 P0）：
- `getDatabase()` 真路径 CRUD（INSERT/SELECT/UPDATE/DELETE 经真实 better-sqlite3 prepared statement）
- `createTables()` + `runMigrations()` 真实建表 + 迁移幂等（连跑两次迁移第二次 no-op）
- WAL 模式生效（`pragma('journal_mode')` 返回 `wal`）

---

### `tests/electron/ai.execCommands.real.test.ts`（test, event-driven）

**Analog:** `electron/services/ai.telnetRouting.test.ts`（**exact 同被测函数 `executeCommandsOnDevice`**，1-230 全文）

**vi.mock ssh2 范式**（ai.telnetRouting.test.ts:22-37）—— 真路径测试**反向操作**：不 mock ssh2（用真 ssh2.Client 连 mock ssh2.Server）：

```typescript
// ai.telnetRouting.test.ts:22-37（analog —— mock ssh2 的写法；真路径测试 NOT do this）
const sshClientCtor = vi.fn()
vi.mock('ssh2', () => {
  class Client {
    constructor() { sshClientCtor() }
    on = sshClientOn; connect = sshClientConnect; end = sshClientEnd; destroy = sshClientDestroy
  }
  return { Client }
})
```

**真路径测试应做**（与 analog 反向）：
- **不** `vi.mock('ssh2')` —— 让真实 `ssh2.Client` 加载（electron.exe 内 electron-ABI ssh2）
- `import { Client } from 'ssh2'` 真实 import，连 mockSshServer 的随机端口
- 复刻 analog 的入参断言（ai.telnetRouting.test.ts:94-106）：host/port/username/password/command 透传

**executeCommandsOnDevice + execOne cleanup 路径**（ai.ts:386-510，**句柄泄漏检测目标**）：

```typescript
// ai.ts:390-394（analog —— cleanup 必须无泄漏验证的 try/finally）
const cleanup = (): void => {
  if (perCmdTimer) { clearTimeout(perCmdTimer); perCmdTimer = undefined }
  try { client.end() } catch { /* ignore */ }
}
// ai.ts:450-513 execOne：stream.close() + stream.destroy() + clearTimeout(timer/silenceTimer)
```

**真路径测试应覆盖**（RESEARCH.md §测试用例优先级 P0 + TEST-02）：
- executeCommandsOnDevice SSH 路径经 mockSshServer 回显
- execOne silence/timeout/stream-error 三路径 cleanup（句柄泄漏检测 `expectNoHandleLeak`）
- telnet 分流仍走 executeTelnetCommand（反向断言：真路径不连 SSH server）

---

### `tests/electron/arpCollector.real.test.ts`（test, event-driven）

**Analog:** `electron/services/ai.saveChatMessage.test.ts`（1-84，**mock ssh2/telnetExec/commandSafety 让 service 干净加载**范式）

**mock 让 service 加载范式**（ai.saveChatMessage.test.ts:26-44）—— 真路径测试对**非被测依赖**仍 mock，仅被测 executeSSH 走真路径：

```typescript
// ai.saveChatMessage.test.ts:26-44（analog —— mock 重依赖让 service 可 import）
vi.mock('ssh2', () => {
  class Client { on = vi.fn(); connect = vi.fn(); end = vi.fn(); destroy = vi.fn() }
  return { Client }
})
vi.mock('../utils/telnetExec', () => ({
  executeTelnetCommand: vi.fn(),
  pickDisablePaginationCmd: vi.fn(),
  pickShellPrompt: vi.fn(),
}))
vi.mock('./commandSafety', () => ({ isCommandAllowed: () => ({ allowed: true, reason: '' }) }))
```

**executeSSH cleanup 路径**（arpCollector.ts:25-75，**句柄泄漏检测目标**）：

```typescript
// arpCollector.ts:33-52（analog —— cleanup 持 ssh2 Client + setTimeout timer）
const cleanup = (): void => {
  if (timer) { clearTimeout(timer); timer = undefined }
  try { client.end() } catch { /* ignore */ }
}
// timeout 路径追加 client.destroy()（arpCollector.ts:46-52）
timer = setTimeout(() => {
  finish(() => {
    try { client.destroy() } catch { /* ignore */ }
    reject(new Error(`SSH timeout after ${timeout}ms`))
  })
}, timeout)
```

**真路径测试应覆盖**（RESEARCH.md §测试用例优先级 P1 + TEST-02）：
- `collectFromDevice` connectionType=ssh 路径经 mockSshServer 回显 ARP 输出
- executeSSH timeout 路径 cleanup（句柄泄漏检测，构造对端不响应场景）
- `ARPParser.parse` 真实解析 mock server 回显（业务逻辑回归）

注意：arpCollector.ts 经 `getDatabase` 持久化 arp_entries（import line 2），真路径测试需解决 DB 注入（同 realDb helper）。

---

### `tests/electron/telnetExec.real.test.ts`（test, request-response）

**Analog:** `ai.telnetRouting.test.ts:44-50`（`vi.mock('../utils/telnetExec', importActual+spy)` —— telnetExec 是被测目标，真路径测试不 mock 它）

**importActual + spy 范式**（ai.telnetRouting.test.ts:44-50）—— 真路径测试对 telnetExec 本体走真路径：

```typescript
// ai.telnetRouting.test.ts:44-50（analog —— importActual 保留真实导出的写法）
vi.mock('../utils/telnetExec', async () => {
  const actual = await vi.importActual<any>('../utils/telnetExec')
  return { ...actual, executeTelnetCommand: (...args: any[]) => telnetExecSpy(...args) }
})
```

**executeTelnetCommand cleanup 路径**（telnetExec.ts:111-157，**句柄泄漏检测目标**）：

```typescript
// telnetExec.ts:115-157（analog —— finally cleanup 持 telnet-client Telnet + setTimeout timer）
const result = await new Promise<string>((resolve, reject) => {
  timer = setTimeout(() => {
    timedOut = true
    try { connection.destroy() } catch { /* ignore */ }
    reject(new Error(`Telnet timeout after ${timeout}ms`))
  }, timeout)
  // ... connect + exec
}).finally(async () => {
  if (timer) clearTimeout(timer)
  if (!timedOut) { try { await connection.end() } catch { /* ignore */ } }
  else { try { connection.destroy() } catch { /* ignore */ } }
})
```

**真路径测试应覆盖**（RESEARCH.md §测试用例优先级 P1 + TEST-02 + TEST-01）：
- executeTelnetCommand 经 mockTelnetServer echo 回显（正常路径）
- timeout 路径 cleanup（句柄泄漏检测，构造对端不响应）
- `pickDisablePaginationCmd` / `pickShellPrompt` 按 vendor 分流（真路径 + 入参断言）

注意：telnet-client 协议握手（IAC 协商）需 mockTelnetServer 正确响应，planner checkpoint。

---

### `.github/workflows/build-smoke.yml`（config, batch，可能修改）

**Analog:** `.github/workflows/build-smoke.yml:17-33`（现有 step 序列，exact 同文件扩展）

**现有 step 序列**（build-smoke.yml:17-33，analog）：

```yaml
# build-smoke.yml:17-33
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 20
      cache: npm
  - run: npm ci
  - run: npm run rebuild:native   # ← rebuild 后切 electron-ABI
  - run: npm run build
  - run: npm test                 # ← DEP-1 隐患：rebuild 后 plain node 跑会 ABI 崩（RESEARCH §CI 扩展已识别）
  - name: verify native binding built for electron ABI
    shell: bash
    run: |
      test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node
      test -f dist-electron/main.js
```

**扩展方案（RESEARCH.md §CI 扩展 给 CI-A/B/C 三方案，planner 决策）**：

```yaml
# 方案 CI-A（RESEARCH 推荐）：mock 与真路径分段
- run: npm ci
- run: npm test                 # 移到 rebuild 前（plain node 跑 mock 套件，不碰 native）
- run: npm run rebuild:native
- run: npm run build
- run: npm run test:electron    # 新增：rebuild 后 electron.exe 跑真路径套件
- name: verify native binding built for electron ABI
  # ... 不变
```

**planner checkpoint（RESEARCH.md §CI 扩展）**：
- CI-A vs CI-B vs CI-C 三方案择一（CI-A 推荐：mock 套件放 rebuild 前，真路径放 rebuild 后）
- ELECTRON_RUN_AS_NODE 在 GHA windows-latest 不需 xvfb/--no-sandbox（基于语义推断，未实跑）
- CI 时长增量 ~+1min（未实测）
- antivirus 误报风险（electron.exe 在 runner 上的已知案例）

## Shared Patterns

### SC4 生产代码零改动验证（红线回归）
**Source:** RESEARCH.md §Validation Architecture §Wave 0 Gaps + CONTEXT.md decision #1
**Apply to:** 所有新增测试文件 + planner 的 phase gate

```bash
# phase gate 必跑：git diff electron/ 应为空（除非用户 plan review 批准 _setDbGetter 微改）
git diff --stat electron/  # 期望：空（或仅 connection.ts/init.ts 的 @internal _setDbGetter 1-2 行）
```

### DB 注入钩子（@internal _setXxxDbGetter）
**Source:** `electron/services/experienceService.ts:35-45`
**Apply to:** `tests/electron/_helpers/realDb.ts` + 所有真路径 DB 测试 + 可能的 `connection.ts`/`init.ts` 微改

```typescript
// experienceService.ts:35-45（范式全文）
let dbGetter: () => Database.Database = getDatabase
/** @internal 测试专用：注入 db getter（生产不调用）。 */
export function _setExperienceDbGetter(fn: () => Database.Database): void { dbGetter = fn }
function db(): Database.Database { return dbGetter() }
```

### masterKey 注入（setXxxMasterKey）
**Source:** `electron/services/ai.ts:16` / `arpCollector.ts:10` / `experienceService.ts:29`
**Apply to:** 所有真路径测试（arpCollector/ai 经 MK 加密 arp_entries；DB 测试若读 _enc 列需注入）

```typescript
// 现有测试注入范式（experienceService.test.ts:71 + 548）
const MK_TEST_KEY = 'test-master-key-32-bytes-ok!!'
beforeEach(() => {
  setExperienceMasterKey(MK_TEST_KEY)   // 或 setAiMasterKey / setArpMasterKey
})
```

### vi.mock 让 service 干净加载（mock 掉 native/重依赖）
**Source:** `electron/services/ai.saveChatMessage.test.ts:26-44` + `ai.telnetRouting.test.ts:22-64`
**Apply to:** arpCollector/ai 真路径测试（对**非被测**依赖仍 mock，仅被测协议走真路径）

```typescript
// 标准三件套 mock（让 service 模块可加载，不触发非被测 native 链）
vi.mock('./commandSafety', () => ({ isCommandAllowed: () => ({ allowed: true, reason: '' }) }))
// 真路径测试：ssh2 / telnet-client 不 mock（用真 binding 连 mock server）
// 仅 mock 与被测无关的重依赖（如 crypto/knowledgeBaseService/aiExecLogger）
```

### afterEach 清理 + mockClear 生命周期
**Source:** `electron/services/ai.telnetRouting.test.ts:69-76`
**Apply to:** 所有真路径测试（mock server close + mockClear + leak detect 都在 afterEach/afterAll）

```typescript
// ai.telnetRouting.test.ts:69-76（analog）
beforeEach(() => {
  sshClientCtor.mockClear()
  sshClientOn.mockClear()
  // ... 每个 mock 都 clear
})
// 真路径测试 afterAll: server.close() + await close 回调（Pitfall 4）
```

## No Analog Found

**11 / 11 全部命中 analog，0 无 analog 文件。**

但有以下「无完全相同前例，靠组合 analog + RESEARCH.md 骨架落地」的情况（planner 注意 checkpoint）：

| 文件 | 缺失的前例 | 落地依据 |
|------|-----------|----------|
| `mockSshServer.ts` | 项目无 ssh2.Server 用法（仅 Client） | RESEARCH.md §真路径 mock 对端方案 骨架 + arpCollector.ts Client 用法镜像 + ssh2 官方 README（A2 待验） |
| `mockTelnetServer.ts` | 项目无 net.createServer echo 用法（仅 connection.ts 用 net.Socket） | RESEARCH.md 骨架 + telnetExec.ts 消费方协议镜像 + telnet IAC 协商细节待 planner 验 |
| `realDb.ts` | 项目无临时 DB 文件 helper（现有全 mock） | RESEARCH.md 骨架 + connection.ts initDatabase 真路径建库复刻 + experienceService `_setExperienceDbGetter` 注入范式 |
| `db.real.test.ts` | 项目无真路径 DB 测试（现有全 mock） | migrationHelpers.test.ts DB 桩 API shape + migrations.test.ts 迁移幂等断言结构 |
| `handleLeakDetector.ts` | 项目无句柄泄漏检测前例 | RESEARCH.md §句柄泄漏检测机制 完整骨架（process.getActiveResourcesInfo + wtfnode） |

## Metadata

**Analog search scope:**
- 测试文件：`tests/unit/*.test.ts`（7 文件）+ `electron/services/*.test.ts`（co-located）+ `electron/database/migrations.test.ts` + `electron/utils/piiMask.test.ts`
- 被测生产源：`electron/services/arpCollector.ts` / `ai.ts`（executeCommandsOnDevice + execOne）/ `connection.ts` / `electron/utils/telnetExec.ts` / `electron/database/connection.ts` / `init.ts`
- 注入钩子范式：`electron/services/experienceService.ts`（`_setExperienceDbGetter` / `setExperienceMasterKey`）
- 配置：`vitest.config.ts` / `package.json` scripts / `.github/workflows/build-smoke.yml`

**Files scanned:** 14（11 analog 命中 + 3 验证用 grep/glob 扫描）

**Pattern extraction date:** 2026-08-07

**关键约束复盘（planner 落地必须遵守）：**
- SC4 红线：生产代码零改动（唯一例外 `_setDbGetter` 微改需用户 plan review 批准）
- 三红线不可回退：IPC secure/safe / _enc 加密 / commandSafety 测试基础设施不得影响
- 渐进保留：现有 16/17 文件 244 用例 mock 套件**不动**，真路径套件并行新增
- DEP-1 缓解核心：`ELECTRON_RUN_AS_NODE=1 electron.exe` 跑 vitest，加载 electron-ABI native binding
