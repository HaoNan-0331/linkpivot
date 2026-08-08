---
phase: 12-test-infrastructure-dep-1-abi
reviewed: 2026-08-08T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - .github/workflows/build-smoke.yml
  - package.json
  - tests/electron/_helpers/handleLeakDetector.ts
  - tests/electron/_helpers/mockSshServer.ts
  - tests/electron/_helpers/mockTelnetServer.ts
  - tests/electron/_helpers/realDb.ts
  - tests/electron/ai.execCommands.real.test.ts
  - tests/electron/arpCollector.real.test.ts
  - tests/electron/db.real.test.ts
  - tests/electron/handleLeak.real.test.ts
  - tests/electron/telnetExec.real.test.ts
  - vitest.config.ts
  - vitest.electron.config.ts
findings:
  critical: 3
  warning: 7
  info: 4
  total: 14
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-08-08
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Phase 12 是纯测试基础设施（DEP-1 ABI 缓解），SC4 红线已验证——`git diff 687fca1..HEAD -- electron/` 为空，零生产代码改动。整体架构正确：双 vitest config 物理隔离（Pitfall 6）、CI-A 的 step 顺序（mock 在 rebuild 前 / 真路径在 rebuild 后）严谨、真路径测试不 mock 被测协议（grep `vi.mock('ssh2'`==0）。

但发现若干**会拖垮 CI-A 的 flaky / 误报 / 逻辑缺陷**：

1. **3 个 Critical**：`handleLeakDetector` 的 baseline 取在调用点（模块顶层 describe 执行期），跨多 `it` 共享一份基线 → 累积检测失效（漏检真实泄漏）；`mockSshServer` 的 `server.on('error')→reject` 在 `listen→resolve` 之后注册且只在首次 listen 错误触发，运行期 error（accept 异常 / 句柄异常）被吞 → silent failure；`build-smoke.yml` 的 `npm run rebuild:native` 调用 `electron-rebuild -w ssh2`，但 ssh2 的 native addon（cpu-features）在 1.17 默认是可选 dependency，`-w ssh2` 不一定触发其重建，CI-A 的 ssh2 真路径可能在 windows-latest 上加载失败。
2. **7 个 Warning**：arpCollector / ai 异常路径用 `port: 1` / `port: sshHandle.port + 1`（Windows GHA flaky EACCES/ECONNREFUSED 不确定）；`arpCollector.real.test.ts` 用 mock 桩 connection 但 service 不持久化（注释已澄清，OK），不过 `setArpMasterKey` 注入后 `MK` 永不被解密路径消费（dead injection）；`handleIac` 对 WILL/DO 固定 `i += 3` 对 2-byte IAC 命令越界吞字节；`realDb` 的 `hasColumn` 用 `PRAGMA table_info(${table})` 字符串插值（测试侧表名可控，但模式违反约定）；`mockTelnetServer` 不发 login/password prompt，依赖 telnet-client 不进入 login 状态的隐式契约（test 注释自承认"若卡住回 12-01 修"）；`db.real.test.ts` 的二次迁移用裸 SQL 内联而非复用 `runStandaloneMigrations`（测试没真验"二次调用 no-op"，验的是手写等价 SQL）；`handleLeak.real.test.ts` it3 经 `vi.importActual` 取真实 executeTelnetCommand 但顶部 spy mock 已替换模块导出，importActual 在 vitest 4 + ESM 下行为需验证。
3. **4 个 Info**：注释/魔法数/可读性。

下面逐项展开。Critical 必须在 CI-A 上线前修，否则句柄检测形同虚设 / ssh2 真路径在 CI 上随机崩。

## Critical Issues

### CR-01: handleLeakDetector baseline 在「调用点（模块顶层 describe）」取一次，afterEach 跨所有 it 共享同一基线 → 句柄累积检测失效

**File:** `tests/electron/_helpers/handleLeakDetector.ts:24-41`
**Issue:**

`expectNoHandleLeak()` 在模块加载时（`describe` 回调内顶部调用）取一次 `baseline = process.getActiveResourcesInfo()`，注册的 `afterEach` 闭包共享这同一份 baseline。每个 `it` 执行后被测代码可能正常新增**非泄漏**的临时句柄（如 it2 启动但 it1 完成后未释放、或 vitest runner 在 it 间新增的 timer），这些都会进入 `after` 但不在 `baseline` 也不在 `allow` → 误报为泄漏；反之若某 it 真实泄漏的句柄恰好被后续 it 复用 / 复位，对比基线（首个 it 之前）也检测不出。

**注释声称**「baseline 在调用点取（紧贴被测代码执行前）」是错的——调用点是 `describe` 顶层（首个 it 之前），不是每个 it 之前。这使「累积泄漏」检测（Plan 12-03 it4 "5 次循环无累积"）的核心断言失效：5 次循环新增的 TCPWrap 若全部未回收，对比 baseline（循环前）应触发，但若 baseline 之后又有 it 间漂移句柄，噪声会淹没信号；更糟的是 baseline 一旦含某 TCPWrap，后续 it 即使泄漏同类型也被 `baseline.includes(h)` 放行。

**Fix:** 每个 it 各取自己的 baseline，在 `beforeEach` 而非调用点取：

```typescript
import { beforeEach, afterEach } from 'vitest'

export function expectNoHandleLeak(extraAllow: string[] = []): void {
  const allowDefault = ['Timeout', 'GetAddrInfoReqWrap', 'TCPServerWrap', 'TCPWrap', 'SimpleWriteWrap']
  const allow = new Set([...allowDefault, ...extraAllow])
  let baseline: string[] = []

  beforeEach(() => {
    // 紧贴被测代码执行前取 baseline（每个 it 独立基线，避免跨 it 共享）
    baseline = process.getActiveResourcesInfo()
  })

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50))
    const after = process.getActiveResourcesInfo()
    const leaked = after.filter((h) => !allow.has(h) && !baseline.includes(h))
    if (leaked.length > 0) {
      // ...wtfnode dump + throw（保留）
    }
  })
}
```

注意：`beforeAll` 起 mock server（beforeEach 之前）的 `TCPServerWrap` 已在 allowDefault，故 beforeEach 取基线时 mock server socket 不会污染基线。

---

### CR-02: mockSshServer 的 `server.on('error')→reject` 在 listen→resolve 之后才注册，且 reject 仅首次 listen error 有效；运行期 accept/connection error 全被吞

**File:** `tests/electron/_helpers/mockSshServer.ts:54-71`
**Issue:**

代码顺序：
```typescript
const server = new Server({ hostKeys: [...] }, (client) => { ... })  // L34
// 此时 server 已可 emit 'error'（如 hostKey 非法 / 端口冲突），但还没注册 listener
server.on('error', (err) => { reject(err) })  // L54
server.listen(0, '127.0.0.1', () => { ... resolve(...) })  // L59
```

两个问题：

1. **listen 前的同步 error 被吞**：ssh2 Server 构造或 listen 调用若同步抛 / 异步 emit error（如 hostKey 格式错），Node 对未监听 'error' 的 EventEmitter 会 throw `Unhandled 'error' event`（崩溃测试进程），而非走 `reject`。当前顺序虽在 listen 前 `on('error')`，但 `new Server` 到 `on('error')` 之间的窗口（L34→L54）若同步 emit 则崩。
2. **运行期 error 被吞**：`reject` 在 Promise 已 resolve 后是 no-op。一旦 listen 成功 resolve，后续 accept 阶段的 connection error（如 ssh2 内部 stream error 传播到 server）会调 `reject`（无效），但**没有任何兜底**——既不 fail 测试也不记日志。这些 error 在真实 CI（windows-latest / 网络抖动 / 进程句柄边界）会偶发，表现为"测试间歇性静默挂起或断言失败但无 error 线索"。

`mockTelnetServer.ts:62-64` 有**完全相同**的 bug 模式（`server.on('error')→reject` 在 listen resolve 后无效）。

**Fix:** 用 once + 明确区分 listen 阶段 vs 运行期，运行期 error throw 到 vitest（让测试 fail 出原因，而非静默）：

```typescript
const onListenError = (err: unknown) => reject(err)
server.once('error', onListenError)

server.listen(0, '127.0.0.1', () => {
  // listen 成功：解绑 listen 阶段 reject，改挂运行期 error → console.error + 主动 fail
  server.off('error', onListenError)
  server.on('error', (err) => {
    // 运行期 error 不应静默 —— 打到 stderr 让 CI 日志可见
    console.error('[mockSshServer] runtime error:', err)
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : -1
  resolve({ port, close: () => new Promise<void>((res) => server.close(() => res())) })
})
```

mockTelnetServer.ts:62 同理修。

---

### CR-03: build-smoke.yml 调 `electron-rebuild -w ssh2`，但 ssh2 1.17 的 native addon (cpu-features) 是可选 dependency，`-w ssh2` 不保证重建 → CI-A ssh2 真路径可能在 windows-latest 上加载 wrong-ABI 崩

**File:** `.github/workflows/build-smoke.yml:28` + `package.json:13`
**Issue:**

`package.json` 的 `rebuild:native`：
```json
"rebuild:native": "electron-rebuild -f -w better-sqlite3 -w ssh2"
```

ssh2 1.17 自 v1.4 起，**默认不编译内置 native binding**，而是 dependency `cpu-features`（一个可选 native addon，提供 CPU 特性检测以加速）。`@electron/rebuild -w ssh2` 只针对 ssh2 包本身的 binding 做重建；`cpu-features` 是 ssh2 的 dependency 而非 ssh2 包内文件，**`-w ssh2` 不会递归到 cpu-features**（除非用 `--which-dependencies` 或全量 `-f` 无 `-w`）。

后果：
- `npm ci` 装好后 cpu-features 用 plain-node ABI 编译（若触发编译）。
- `electron-rebuild -f -w ssh2` 重建 ssh2 自身（其实 ssh2 1.17 是纯 JS + 可选 cpu-features，没有自带的 .node），cpu-features 仍是 node ABI。
- `npm run test:electron` 在 electron.exe 下 `require('ssh2')` → ssh2 内部 `require('cpu-features')` → 若 cpu-features 已 build 则 NODE_MODULE_VERSION mismatch 崩；若 cpu-features 未 build 则 ssh2 fallback 到纯 JS（不崩，但丢失"真 native binding 路径"的回归价值，DEP-1 缓解验证不到位）。

verify step（L34-39）只验 `better_sqlite3.node` 存在，**没验 cpu-features / ssh2 的 electron-ABI 产物**——所以 CI 即便 ssh2 ABI 失配也不会被 verify step 拦下，只在 `test:electron` 跑时随机崩。

本地 `npm run rebuild:native` 可能"看起来过了"（因为 ssh2 包内无 .node，rebuild 报 success 无事发生），掩盖问题。

**Fix:** rebuild 改为不限定 `-w`（全量重建所有 native addon，含 cpu-features），或显式追加 cpu-features：

```json
"rebuild:native": "electron-rebuild -f -w better-sqlite3 -w ssh2 -w cpu-features"
```

并在 verify step 追加 cpu-features 产物存在性检查（路径 `node_modules/cpu-structures/build/Release/cpufeatures.node`，需确认 cpu-features 1.x 的实际产物名）：

```yaml
- name: verify native binding built for electron ABI
  shell: bash
  run: |
    test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node
    # cpu-features 是可选 addon，若装了则验 electron-ABI
    test ! -d node_modules/cpu-features || \
      test -f node_modules/cpu-features/build/Release/cpufeatures.node
    test -f dist-electron/main.js
    echo "native binding + main bundle OK"
```

更稳妥：本地先在 windows 实跑一次 `npm run rebuild:native && npm run test:electron`，确认 ssh2 不报 ABI mismatch，再据此调整 rebuild 命令；RESEARCH A2 checkpoint 的"ssh2.Server 在 RUN_AS_NODE 下 listen"只验了 listen 可行，没验 cpu-features ABI。

## Warnings

### WR-01: 异常路径测试用 `port: 1` / `port: sshHandle.port + 1` 触发连接失败 —— Windows GHA 上 EACCES/ECONNREFUSED 行为不确定，CI-A flaky 风险

**File:** `tests/electron/arpCollector.real.test.ts:143`（`port: 1`）、`tests/electron/handleLeak.real.test.ts:225`（`port: 1`）、`tests/electron/ai.execCommands.real.test.ts:196`（`port: sshHandle.port + 1`）
**Issue:**

- `port: 1`：Windows 上 1-1023 是保留端口，连接尝试可能返回 `EACCES`（permission）而非 `ECONNREFUSED`，ssh2 client 的 error 分支能否稳定触发 reject 不确定；某些 Windows 配置下 1 端口可能被分配（罕见但存在）→ 反而连上未知服务，测试断言 `error.truthy()` 失败。
- `port: sshHandle.port + 1`：随机端口的 +1 同样可能被其他进程占用（CI runner 共享环境），偶发连上非预期 server → banner 等待 → timeout 而非立即 reject，testTimeout 15s 内可能挂满。

**Fix:** 用专用的"必然不可达"端口——绑定一个 socket 占住端口后立即 close 拿 `EADDRNOTAVAIL` 不可达段，或直接连一个明确未监听的高位端口 + 短 timeout 兜底。更稳的做法是复用 `handleLeak.real.test.ts:107` 的 RST server 模式（accept 后 destroy，确定性触发 client error），统一三个文件的异常路径构造：

```typescript
// 起一个一次性 RST server：accept 后立即 destroy，确定性触发 client 'error'
const rstServer = net.createServer((socket) => { socket.destroy() })
await new Promise<void>((r) => rstServer.listen(0, '127.0.0.1', r))
const badPort = (rstServer.address() as net.AddressInfo).port
// ... 测试体 ...
// finally 关 rstServer
```

---

### WR-02: handleIac 对 WILL/DO 分支固定 `i += 3`，对 2-byte IAC 命令（IAC+NOP/AYT/BRK）越界吞字节

**File:** `tests/electron/_helpers/mockTelnetServer.ts:92-96`
**Issue:**

```typescript
if (cmd === WILL || cmd === DO) {
  const resp = cmd === WILL ? DONT : WONT
  socket.write(Buffer.from([IAC, resp, buf[i + 2] ?? 0]))
  i += 3 // IAC + cmd + option
}
```

telnet 协议中 WILL/DO 确实是 3-byte（IAC + WILL + option），故此分支 `i += 3` 对 WILL/DO 正确。但 `else` 分支（L104-105）的 `i += 2` 处理 2-byte 命令（IAC + NOP/DM/BRK/IP 等），而 SB 子协商分支（L99-103）的 `while (i < buf.length - 1 && !(buf[i] === IAC && buf[i + 1] === SE)) i++` 在无 IAC SE 终止符的畸形输入下会一直扫描到末尾，然后 `i += 2` 越过 buf.length，循环条件 `i < buf.length` 退出——逻辑上 OK 但脆弱。

更关键：`buf[i + 2] ?? 0` 的 `?? 0` 在 buf 长度恰为 i+2 时（畸形 WILL/DO 末尾缺 option 字节）发送 `option=0`（Binary Transmission）的 DONT/WONT 响应——语义错误（应跳过不响应）。telnet-client 实际不太可能发畸形 WILL/DO，但 defensive coding 应判长度。

**Fix:** 主路径（telnet-client 发的标准 3-byte WILL/DO/WONT/DONT）当前处理正确，可不动；但建议在 WILL/DO 分支加长度守卫防畸形输入：

```typescript
if (cmd === WILL || cmd === DO) {
  if (i + 2 >= buf.length) break // 畸形：缺 option 字节，跳过不响应
  const resp = cmd === WILL ? DONT : WONT
  socket.write(Buffer.from([IAC, resp, buf[i + 2]]))
  i += 3
}
```

---

### WR-03: realDb 的 `hasColumn` 用 `PRAGMA table_info(${table})` 字符串插值 —— 违反 CONVENTIONS（SQL 不字符串拼接），即便测试侧可控也应示范正确模式

**File:** `tests/electron/_helpers/realDb.ts:102`
**Issue:**

```typescript
function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ...
}
```

PRAGMA 不支持参数绑定（SQLite 限制），故生产 `migrationHelpers.ts` 也是字符串拼接——但生产侧 table 名来自代码常量。本 helper `hasColumn` 仅在 `runStandaloneMigrations` 内以字面量 `'experiences'` 调用，无注入风险。但作为"复刻生产迁移幂等守卫模式"的演示代码（注释 L77 自承"复刻生产迁移的幂等语义"），不显式标注"PRAGMA 不可参数化、仅因 table 受控才安全"会误导后续照抄者。

**Fix:** 加注释明确边界，或用 `sqlite_master` 查询替代（生产迁移守卫本身用 `sqlite_master.sql LIKE` 特征串判定，参考 ARCHITECTURE 迁移章节）：

```typescript
/**
 * 复刻 migrationHelpers.ts hasColumn。
 * 注意：PRAGMA 不支持参数绑定（SQLite 限制），table 必须为代码常量（不可来自外部输入）。
 * 生产侧同样模式，本 helper table 仅传字面量 'experiences'，安全。
 */
function hasColumn(db, table, column) { ... }
```

---

### WR-04: mockTelnetServer 不发 login/password prompt，依赖 telnet-client 不进入 login 状态的隐式契约 —— 测试注释自承认 flaky 风险

**File:** `tests/electron/_helpers/mockTelnetServer.ts:42-44` + `tests/electron/telnetExec.real.test.ts:26-32`
**Issue:**

`executeTelnetCommand` connect 配置含 `loginPrompt: /Username:|login:/i` + `passwordPrompt: /Password:/i`（telnetExec.ts:131-132）。`mockTelnetServer` 连接时只 `socket.write(shellPrompt)`，不发 `Username:`。

经查 `telnet-client/lib/index.js:356-385`：connect 时进入 `getprompt` 状态，先查 loginPrompt，**再查 passwordPrompt，最后才查 shellPrompt**——若 server 不发 login/password，直接匹配 shellPrompt 进入 `standby` 并 emit ready，**不发用户名/密码**。故当前 mockTelnetServer 实际能 work（test 的 username/password 参数被忽略），telnetExec.real.test it1/it2 应能通过。

但这是**隐式契约**：telnet-client 库若升级改了状态机（如要求 login 先于 shellPrompt），mock 立即崩。test 注释（L26-32）自承"若 connect 卡住超 testTimeout，回 12-01 修 mockTelnetServer IAC/login 流程"——承认了不确定性。

**Fix:** 让 mockTelnetServer 显式实现 login/password 状态机（消除隐式契约），或在注释中固化"本 mock 假设 telnet-client 在 shellPrompt 优先于 loginPrompt 时不发凭证"的库版本约束（pin 到 `telnet-client@2.2.13`，package.json 已 pin）。当前 package.json 已 pin 版本，风险可控，建议至少在 mockTelnetServer 顶部加版本约束注释：

```typescript
// 假设：telnet-client@2.2.13 的 getprompt 状态机在 shellPrompt 优先匹配时跳过 login/password。
// 若库升级改了状态机顺序，需补 login/password prompt 状态机（参考 telnet-client/lib/index.js:356）。
```

---

### WR-05: arpCollector.real.test.ts 的 `setArpMasterKey(MK_TEST)` 注入是 dead injection —— arpCollector.collectFromDevice 不解密 device.password

**File:** `tests/electron/arpCollector.real.test.ts:59-60`
**Issue:**

测试注入 `setArpMasterKey('test-master-key-32-bytes-ok!!')`，注释说"arpCollector 顶层 let MK，dec() 用之"。但读 `arpCollector.ts:89-117`，`collectFromDevice` 直接把 `device.password`（明文 `'test'`）传给 `executeSSH`，**整条 SSH 路径不调 `dec()`**。MK 注入在 SSH 路径用例中永不被消费（dead injection）。

后果：
1. 若 MK 未注入会让 arpCollector 模块加载失败（import 时 dec 需要 MK）—— 但实际 arpCollector.ts 顶层 `let MK = ''`（L9 附近），dec 调用才需要 MK，加载不需要。故 setArpMasterKey 在本文件 SSH 路径测试中**完全无作用**。
2. 注释"dec() 用之"是误导，未来若 arpCollector 改为解密 password 会引入隐式依赖。

**Fix:** 删除 `setArpMasterKey(MK_TEST)` 与 `MK_TEST` 常量（SSH 路径不解密，无需 MK）；或保留但在注释明确"防御性注入——当前 SSH 路径不解密，但保留以兼容未来 collectFromAll 走 device.password 解密的扩展"。建议删除以减少误导。

---

### WR-06: db.real.test.ts 的"二次迁移 no-op"用裸 SQL 内联，没复用 runStandaloneMigrations —— 实际没验"二次调用 makeRealDb migrations 守卫"

**File:** `tests/electron/db.real.test.ts:82-93`
**Issue:**

测试声称验"makeRealDb runMigrations 连跑两次第二次 no-op"，但实际：
- 第一次：`makeRealDb({ runMigrations: true })` 跑 `runStandaloneMigrations`（建表 + hasColumn 守卫）。
- "第二次"：测试体里手写裸 SQL（L84-89）`CREATE TABLE IF NOT EXISTS experiences (...)` + 内联 `hasColumn` 查询，**没调 `runStandaloneMigrations` 第二次**。

即测试验的是"手写等价 SQL 是幂等的"，不是"helper 的 runStandaloneMigrations 二次调用 no-op"。若 `runStandaloneMigrations` 内部 hasColumn 守卫逻辑写错（如 `!hasColumn` 误为 `hasColumn` 导致重复 ALTER 抛 duplicate column），本测试**测不出来**——因为根本没第二次调它。

**Fix:** 真正调两次 helper 的迁移函数。当前 `runStandaloneMigrations` 是 `realDb.ts` 内的私有函数未导出，需导出后二次调用：

```typescript
// realDb.ts: 导出 runStandaloneMigrations（或新增 makeRealDb 选项支持二次跑）
export function runStandaloneMigrations(db: Database.Database): void { ... }

// db.real.test.ts:
handle = makeRealDb({ runMigrations: true })
const { db } = handle
// 真二次调用：复用同一 db 跑迁移函数第二次，验 no-op（不抛 duplicate column）
expect(() => runStandaloneMigrations(db)).not.toThrow()
// 再验表结构未变（4 列）
```

---

### WR-07: handleLeak.real.test.ts it3 经 `vi.importActual` 取真实 executeTelnetCommand，但顶部已 `vi.mock('../../electron/utils/telnetExec', importActual+spy)` —— vitest 4 ESM 下 importActual 在 mock 内嵌套调用的行为需验证

**File:** `tests/electron/handleLeak.real.test.ts:62-70`（顶部 spy mock）+ `:178-181`（it3 内 vi.importActual）
**Issue:**

顶部 mock：
```typescript
vi.mock('../../electron/utils/telnetExec', async () => {
  const actual = await vi.importActual<any>('...')
  return { ...actual, executeTelnetCommand: (...args) => telnetExecSpy(...args) }
})
```
it3 内：
```typescript
const telnetExecReal = await vi.importActual<typeof import('...')>('...')
await telnetExecReal.executeTelnetCommand(...)  // 期望拿到真实实现
```

vitest 的 `vi.importActual` 在已被 `vi.mock` 的模块上调用，**返回的是原始未 mock 模块**（vitest 文档语义）。但 vitest 4 + ESM + Electron RUN_AS_NODE 的组合下，`importActual` 在嵌套 mock factory 内已被消费一次（顶部 mock factory 调过），it3 再调一次的实际行为（是否走缓存 / 是否重新求值 / 是否触发 ssh2 真实 binding 加载）需验证。

更直接的隐患：顶部 mock 的 spy 在 it1/it2/it4/it5（SSH 路径）已被调用并 mockReset 过（ai.execCommands.real.test.ts:169 有 mockReset，本文件无），spy 状态可能跨 it 残留。

**Fix:** it3 不依赖 vi.importActual（绕 mock），改为**单独的测试文件**（如 `telnetExec.real.test.ts` 已存在，其顶部不 mock telnetExec）—— 把 telnet 真路径 timeout 验证放到 telnetExec.real.test.ts（它已 it3 验 silent server timeout），删 handleLeak.real.test.ts it3。handleLeak.real.test.ts 聚焦 SSH 异常 + 累积场景即可，避免 mock/importActual 嵌套的脆弱性。

## Info

### IN-01: handleLeakDetector 的 `await sleep(50)` 是魔法数

**File:** `tests/electron/_helpers/handleLeakDetector.ts:38`
**Issue:** `setTimeout(r, 50)` 硬编码 50ms，注释只说"给 cleanup 异步时间"未解释为何 50 而非 100/200。CI 上慢机器 50ms 可能不够（ssh2.end 异步 EOF 慢），导致 flaky 误报泄漏。
**Fix:** 提为常量并允许调用方覆盖：`const CLEANUP_GRACE_MS = 50`，或在 expectNoHandleLeak 选项加 `graceMs`。

---

### IN-02: ai.execCommands.real.test.ts 第一个 it 的 device 缺 vendor 字段，第二个 it 有 —— 不一致

**File:** `tests/electron/ai.execCommands.real.test.ts:101-108`（无 vendor）vs `:122-129`（无 vendor）vs `:140-150`（vendor: 'huawei'）
**Issue:** SSH 路径 device 对象有的带 vendor 有的不带，无统一工厂函数。非 bug（SSH 路径不强依赖 vendor），但可读性差，未来加 vendor 分流断言易漏。
**Fix:** 抽 `makeSshDevice(port)` 工厂统一字段。

---

### IN-03: mockSshServer 的 `server.address()` port 提取用 `typeof addr === 'object' && addr`，null 兜底返 -1 但不 fail

**File:** `tests/electron/_helpers/mockSshServer.ts:60-61`
**Issue:** `port = ... ? addr.port : -1`，若 address() 返回 null（理论不应在 listen 回调内发生，但 defensive）port=-1 会让后续 connect 失败但报错信息不直观。
**Fix:** port=-1 时显式 reject 而非 resolve 一个无效 port。

---

### IN-04: handleLeak.real.test.ts it2 注释承认"用回显正常路径覆盖 stream error 路径"——测试名与实际覆盖不符

**File:** `tests/electron/handleLeak.real.test.ts:134-159`
**Issue:** it 标题"SSH exec stream error：握手 OK 后 onExec 触发 stream.destroy"，但实际 mock server `_cmd => 'stream-error-sim\n'`（正常 end），注释自承"真实的 stream error 由库底层 destroy 触发，此处用回显正常路径覆盖"。即该 it **没真测 stream error 路径**，测的还是正常路径（与 it1/it4 重复）。it 名误导。
**Fix:** 改 it 名为"SSH exec 正常 stream close 路径 cleanup"（与实际一致），或真构造 stream error（mock server 在 exec 回调内 `stream.destroy()` 而非 `stream.end()`，触发 client 端 stream.on('error')）。后者更贴近 TEST-02 异常场景覆盖目标。

---

_Reviewed: 2026-08-08_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
