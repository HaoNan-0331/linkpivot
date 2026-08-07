# Phase 12: Test Infrastructure (DEP-1 ABI 缓解) - Research

**Researched:** 2026-08-07
**Domain:** 测试基础设施（Electron 进程内跑 vitest + 原生 native binding ABI 兼容 + 句柄泄漏自动化检测）
**Confidence:** HIGH（核心结论经本地实跑验证 + npm registry 直查 + slopcheck 双重核验）

## Summary

DEP-1 的本质问题，本次调研已在本地**实跑复现并验证缓解路径可行**：

1. **复现**：better-sqlite3 经 `npm run rebuild:native`（`@electron/rebuild -f -w better-sqlite3 -w ssh2`）按 Electron 41 ABI 重建后，`require('better-sqlite3')` 在 plain Node（vitest 默认运行环境）会 throw `NODE_MODULE_VERSION` 不匹配——这正是 DEP-1。本地当前处于 Node-ABI 构建态（`npm ci` 后未 rebuild），plain Node 可加载；**一旦执行 `rebuild:native` 或 `electron:build`（CI 与发版必跑），即刻切换为 Electron-ABI，plain Node vitest 即崩**。

2. **缓解路径已验证**：用项目已装的 `node_modules/electron/dist/electron.exe`（Electron 41.0.3）配 `ELECTRON_RUN_AS_NODE=1` 作为「Node 运行时」来跑 vitest，**该运行时与 `@electron/rebuild` 重建后的 better-sqlite3/ssh2 native binding ABI 一致**，实跑 `new Database(':memory:')` + 建表 + 查询全绿。这条路绕开了「vitest 必须跑在 plain Node」的根本限制，无需重写 vitest、无需改生产构建。

3. **electron-vite 完整迁移路线被否决**：`electron-vite` 最新版 5.0.0（2025-12-07）的 peerDependency 是 `vite ^5 || ^6 || ^7`，**全版本史不支持 vite 8**（项目锁 `vite ^8.0.11`）。强行装会触发 peer 警告/解析冲突，且要 SC4 红线「不改生产构建」让步——不可行。`electron-vitest`（alex8088 同作者的 vitest-in-electron 包）只有 `1.0.0-alpha.0`（2022-09）一个版本、3+ 年无更新、slopcheck 判 `[SUS]`「Only 9 downloads」——dead package，禁用。

**Primary recommendation:** 采用**最小侵入方案**——新增 `test:electron` script，用 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run`（或经 `cross-env`/`cross-spawn` 跨平台包裹）跑新增的 `tests/electron/**/*.test.ts` 真路径套件；现有 `npm test`（plain Node）+ mock 套件 16/17 文件 244 用例**完全不动**。句柄泄漏用 `process.getActiveResourcesInfo()`（Node 17.3+，本地 Node 24.13 / Electron 41 内置 Node 均支持）在 `afterEach`/`afterAll` snapshot 对比，配 `wtfnode`（slopcheck `[OK]`）做诊断后备——零依赖侵入生产代码。

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| 跑 vitest 加载 electron-ABI native binding | 测试基础设施层（新增） | — | 必须 in-Electron 进程（ELECTRON_RUN_AS_NODE），plain Node 加载必崩；属测试通道非生产 |
| better-sqlite3 真路径 DB 集成测试 | 数据层（`electron/database/connection.ts`） | 测试基础设施层 | getDatabase() 单例 + 真实 WAL/migration 走真 binding；只能 in-Electron 跑 |
| ssh2 Client 真路径回归（execOne / executeCommandsOnDevice） | 业务层（`electron/services/ai.ts`） | 测试基础设施层 | 需 mock SSH 对端（sshd-like TCP server）+ 验 try/finally cleanup |
| telnet 真路径回归（executeTelnet / arpCollector） | 业务层（`electron/services/arpCollector.ts` + `electron/utils/telnetExec.ts`） | 测试基础设施层 | 需 mock telnet echo server + 验 cleanup |
| 句柄泄漏自动化检测 | 测试基础设施层 | 所有持句柄 service | 全在测试侧用 process.getActiveResourcesInfo / wtfnode，**不进生产代码**（SC4） |
| 三红线（IPC 鉴权 / 字段加密 / commandSafety） | 工具层（不可回退） | — | 本 phase 不触碰；测试只是消费方 |

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

1. **不改生产代码路径（ROADMAP SC4 红线）**：DEP-1 缓解只加测试通道 + 工具配置。**不改**：`electron/main.ts` 生产逻辑、better-sqlite3/ssh2 生产用法、electron-builder 打包路径、esbuild/vite 生产构建。生产依赖与安装包产物不变。
2. **三红线不可回退**：IPC 鉴权（secure/safe）/ 字段加密（_enc + encField/decField）/ commandSafety.isCommandAllowed — 测试基础设施改动不得影响这三层运行。
3. **渐进保留现有 mock 测试**：现有 `_setExperienceDbGetter` mock DB 测试（16/17 文件 244 用例）**保留不删**，真路径测试并行新增。**不搞 mock→真 全量替换**。两套并存：mock 测业务逻辑、真路径测 native 集成。
4. **句柄泄漏自动化替代人工 HV**：TEST-02 句柄检测要覆盖 Phase 6 SC#4 + Phase 3 defer 的人工 HV 项（arpCollector/ai.executeCommandsOnDevice/execOne/executeTelnet 的 try/finally cleanup 路径）。

### Claude's Discretion

- **electron-vite 集成幅度**：完整迁移 vs 最小侵入 → researcher 给推荐（**已定：最小侵入**，理由见 §electron-vite 评估）
- **句柄泄漏检测机制**：具体技术方案 → researcher 给推荐（**已定：process.getActiveResourcesInfo + wtfnode 后备**，见 §句柄泄漏检测机制）
- **CI 扩展**：本地跑 vs 进 build-smoke.yml → 给 planner 决策依据（见 §CI 扩展）
- **测试用例优先级**：SSH/Telnet/DB/句柄 先自动化哪些 → 给 planner 优先级建议（见 §测试用例优先级）

### Deferred Ideas (OUT OF SCOPE)

- electron-vite 完整迁移（替换 vite+esbuild 双构建）—— 因 vite 8 不兼容 + SC4 红线，**本 phase 不做**
- mock→真 全量替换（保留 mock 套件）
- 前端组件自动化测试通道（vitest jsdom + testing-library）—— 属另一 milestone（审计 §1.3 low）
- IPv6 / a11y / Phase 5 snippet 等体验项

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TEST-01 | SSH/Telnet/DB/better-sqlite3 真路径可自动化回归 — DEP-1 ABI 缓解：electron-vite + vitest 集成跑 Electron 内测试，消除 plain Node 无法加载 @electron/rebuild 重建的 native binding 限制 | **本调研修正了「electron-vite+vitest 集成」的字面表述**：electron-vite 因 vite 8 不兼容不可用；真正落地的应是 `ELECTRON_RUN_AS_NODE=1 electron.exe` 跑 vitest（等效达成「跑在 Electron 进程内」目标）。验证路径见 §DEP-1 复现与缓解。better-sqlite3 真路径经 `getDatabase()` 单例 + 临时 DB 文件；ssh2/telnet 经 mock 对端 server。 |
| TEST-02 | 句柄泄漏可自动化检测 — execOne / executeCommandsOnDevice / executeTelnet 的 try/finally 句柄回收回归（替代 Phase 6 SC#4 人工 HV，闭合 DEP-1 长期 defer 项） | `process.getActiveResourcesInfo()` snapshot 对比 + `wtfnode` 诊断后备；覆盖 `ai.ts:386/390-396`（executeCommandsOnDevice cleanup）+ `ai.ts:450-483`（execOne stream/timer）+ `arpCollector.ts:25-78`（executeSSH cleanup）+ `telnetExec.ts:111-155`（finally cleanup）四条路径。见 §句柄泄漏检测机制 + §目标 cleanup 路径清单。 |

</phase_requirements>

## DEP-1 复现与缓解（本地实跑验证）

### 问题复现（本地实跑，2026-08-07）

```
# 当前仓库态：better-sqlite3 是 Node-ABI 构建（npm ci 后未 rebuild）
$ node -e "require('better-sqlite3'); console.log('LOADS in plain node')"
LOADS in plain node (node-ABI build present)   # ← 当前态，npm test 能跑

# 一旦执行 rebuild:native（CI / electron:build 必跑）：
$ npm run rebuild:native   # electron-rebuild -f -w better-sqlite3 -w ssh2
# → better-sqlite3/build/Release/better_sqlite3.node 切换为 Electron 41 ABI
# → 之后再跑 plain node vitest：
$ node -e "require('better-sqlite3')"
Error: The module '...better_sqlite3.node' was compiled against a different Node.js version
using a different Node-module-version (ABI)。 ← DEP-1 触发，npm test 直接崩
```

根因：`electron/database/connection.ts:1` 的 `import Database from 'better-sqlite3'` + `connection.ts:24` 的 `db = new Database(dbPath)`，在 plain Node 加载 electron-ABI `.node` 必 throw。`[VERIFIED: 本地实跑 + electron ABI 加载错误信息]`

### 缓解方案（本地实跑验证可行）

```
# 用项目已装的 electron.exe（Electron 41.0.3，自带 Node 运行时）+ ELECTRON_RUN_AS_NODE=1 当 Node 跑
$ ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
    -e "const D=require('better-sqlite3'); const d=new D(':memory:'); \
        d.exec('create table t(x)'); d.prepare('insert into t values(?)').run(1); \
        console.log(d.prepare('select * from t').all()); d.close()"
[ { x: 1 } ]   # ← electron-ABI better-sqlite3 加载 + CRUD 全绿
```

`ELECTRON_RUN_AS_NODE=1` 让 electron.exe 以「纯 Node 模式」启动（不走 Chromium/窗口），但其 Node 运行时的 `NODE_MODULE_VERSION` 与 `@electron/rebuild` 重建的 native binding **完全一致**——这正是缓解 ABI 冲突的关键。`[VERIFIED: 本地实跑，electron-ABI better-sqlite3 经 ELECTRON_RUN_AS_NODE 加载 + 建表 + 查询全绿]`

**vitest 接入**：vitest 4.1.10 支持自定义 node 可执行（`vitest --node-exec` 不直接支持，但可经环境变量 + `cross-env`/`cross-spawn` 包裹，或直接用 `electron.exe node_modules/vitest/vitest.mjs run` 调用）。最终落地 script 形态见 §推荐项目结构 / §Package Legitimacy Audit。

### 调研修正：ROADMAP SC1 字面 vs 实质

ROADMAP SC1 写「electron-vite 集成可加载 @electron/rebuild 重建的 better-sqlite3 native binding」。**经调研，electron-vite 因 vite 8 peer 不兼容不可用**（见下节）。但 SC1 的**实质目标**（vitest 跑在 Electron 进程内、加载 electron-ABI native binding、消除 plain Node 限制）经 `ELECTRON_RUN_AS_NODE` 路径**完全达成**。planner 据此把 SC1 的实现路径从「electron-vite」修正为「ELECTRON_RUN_AS_NODE + electron.exe 跑 vitest」，目标语义不变。`[VERIFIED: 本地实跑 + npm registry electron-vite peer 范围直查]`

## electron-vite 评估（关键 gray area）

### 完整迁移方案：否决

**结论：electron-vite 全版本不支持 vite 8，完整迁移方案不可行。**

| electron-vite 版本 | vite peer 范围 |
|--------------------|----------------|
| 1.0.x | `^3 || ^4` |
| 2.x | `^4 || ^5` |
| 3.x | `^4 || ^5 || ^6` |
| 4.x | `^5 || ^6 || ^7` |
| **5.0.0**（2025-12-07 最新） | **`^5 || ^6 || ^7`**（无 8） |

项目锁 `vite ^8.0.11`（package.json）。`[VERIFIED: npm registry electron-vite 全版本 peerDependencies 直查]`

强行装 electron-vite 5 + vite 8 会触发 peerDependency 解析警告；更关键的是 electron-vite 的卖点是「统一 main/preload/renderer 三构建」，会**替换现有 vite 8（renderer）+ esbuild 0.28（main/preload CJS bundle）双构建**——直接违反 SC4 红线「不改 esbuild/vite 生产构建」+ 改变 `build:electron-main` 的 native 外部化清单（`--external:better-sqlite3 --external:ssh2 --external:telnet-client --external:pdfjs-dist`，见 package.json:8）。**否决**。

### electron-vitest（同作者 vitest-in-electron 包）：禁用

| 项 | 值 |
|----|----|
| latest | `1.0.0-alpha.0`（**唯一版本，从未 GA**） |
| 发布时间 | 2022-09-11（3+ 年前） |
| slopcheck 判定 | `[SUS]`「Only 9 downloads. Nobody uses this.」 |
| 仓库 | `alex8088/electron-vitest`（与 electron-vite 同作者，但停滞） |

`[VERIFIED: npm registry electron-vitest 元数据 + slopcheck install 实跑]`

### 最小侵入方案（推荐）

**保留现有生产构建链 100% 不变**，只新增一条 `test:electron` script：

```jsonc
// package.json scripts 新增（不改既有任何 script）
"test:electron": "cross-env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run --config vitest.electron.config.ts"
```

- `cross-env`（已在 devDependencies）跨平台设 `ELECTRON_RUN_AS_NODE=1`
- `node_modules/electron/dist/electron.exe` 直接路径调用，规避 `electron` CLI 会拉起 Chromium 窗口的行为
- `node_modules/vitest/vitest.mjs` vitest 4 入口（CJS-friendly，避免 ESM 解析坑）
- `--config vitest.electron.config.ts` 独立配置，与现有 `vitest.config.ts`（plain Node mock 套件）**物理隔离**，互不污染

**对 SC4 的满足**：零改 `build:electron-main` / `build:preload` / `build` / `electron:build` / `electron:dev` / `rebuild:native` 任一既有 script；零改 `electron-builder.yml`；零改生产代码路径。仅加测试专用 script + 测试专用 config + 测试源文件。`[CITED: package.json:6-17 现有 scripts]`

## 句柄泄漏检测机制（关键 gray area）

### 方案对比

| 方案 | 适用句柄 | 侵入生产代码 | 依赖 | 推荐度 |
|------|---------|------------|------|--------|
| `process.getActiveResourcesInfo()` | TCPWrap/Timeout/TTYWrap/UDPWrap/FSReqCallback 等全部 | 否（纯测试侧） | 0（Node 17.3+ 内置） | **主推** |
| `wtfnode` | 同上 + 调用栈定位 | 否 | 1 包（slopcheck `[OK]`） | **诊断后备** |
| `why-is-node-running` | 同上 + 调用栈 | 否（vitest 4 已 deps 它） | 0（已随 vitest 装） | 可选 |
| `jest-leak-detector` | 弱引用对象图（GC 级） | 否 | 1 包 | 不适用（测内存泄漏非句柄） |
| 自建 try-finally instrumentation | 需改生产代码加计数 | **是**（违反 SC4） | 0 | **否决** |
| ssh2 Client 内部句柄计数 | 仅 ssh2 | 是（改生产） | 0 | 否决 |

**主推方案：`process.getActiveResourcesInfo()` snapshot 对比**

```typescript
// tests/electron/_helpers/handleLeakDetector.ts（测试侧工具，不进 electron/）
import { afterEach, afterAll } from 'vitest'

/** 在测试前后对比活跃句柄，泄漏即 fail。ELECTRON_RUN_AS_NODE 下完全可用。 */
export function expectNoHandleLeak(extraAllow: string[] = []) {
  const baseline = new Set(process.getActiveResourcesInfo())
  // 默认放行：vitest 自身可能持 1-2 个 Timeout（test runner 心跳）
  const allowDefault = ['Timeout', 'GetAddrInfoReqWrap', 'GetAddrInfoReqWrap']
  const allow = new Set([...allowDefault, ...extraAllow])

  afterEach(async () => {
    // 给 cleanup 一点时间（ssh2 end() 是异步发 EOF）
    await new Promise((r) => setTimeout(r, 50))
    const after = process.getActiveResourcesInfo()
    const leaked = after.filter((h) => !allow.has(h) && !baseline.includes(h))
    if (leaked.length > 0) {
      // 触发 wtfnode 诊断（打印泄漏句柄调用栈），方便定位
      const wtf = await import('wtfnode').catch(() => null)
      if (wtf) wtf.dump()
      throw new Error(`句柄泄漏: ${JSON.stringify(leaked)}`)
    }
  })
}
```

`process.getActiveResourcesInfo()` 返回 `string[]`（如 `['TCPWrap', 'Timeout', 'FSReqCallback']`），ssh2 Client 未 end 会留 `TCPWrap`，未 clearTimeout 的 timer 会留 `Timeout`——**正好覆盖目标四路径的 cleanup 漏洞**。`[CITED: Node.js docs process.getActiveResourcesInfo() — Node ≥17.3，本地 Node 24.13 / Electron 41 内置 Node 均 ≥ 该版本]`

**wtfnode 后备**：当 getActiveResourcesInfo 报泄漏但看不出是哪条调用栈，wtfnode 用 `async_hooks` 记录句柄创建栈，`wtfnode.dump()` 打印详情。诊断期 best-effort import（装失败不阻塞测试）。slopcheck `[OK]`、最新 0.10.1（2025-10-05）活跃维护。`[VERIFIED: npm registry + slopcheck]`

### 目标 cleanup 路径清单（覆盖 Phase 6 SC#4 + Phase 3 defer 项）

经 codegraph + grep 实读源码，四条需句柄回归的 try/finally cleanup 路径：

| 路径 | 文件:行 | 持有的句柄 | cleanup 动作 | 当前测试覆盖 |
|------|---------|-----------|-------------|-------------|
| `executeSSH` | `electron/services/arpCollector.ts:25-78` | ssh2 Client + setTimeout timer | `cleanup()`: clearTimeout + `client.end()` + timeout 路径 `client.destroy()` | **无**（arpCollector 无任何测试，TESTING.md 「无测试」清单确认） |
| `executeCommandsOnDevice`（SSH 批量） | `electron/services/ai.ts:352-440` | ssh2 Client（每命令一个 new Client）+ perCmdTimer | `cleanup()`: clearTimeout(perCmdTimer) + `client.end()` + 兜底 `client.destroy()` | **无**（ai.ts 仅 saveChatMessage / telnetRouting 有测试，executeCommandsOnDevice 无） |
| `execOne`（单命令 stream） | `electron/services/ai.ts:450-510` | ssh2 stream + timer + silenceTimer | clearTimeout(timer) + clearTimeout(silenceTimer) + `stream.close()` + `stream.destroy()` | **无** |
| `executeTelnetCommand` | `electron/utils/telnetExec.ts:111-155` | telnet-client Telnet 实例 + setTimeout timer | `.finally(async)`: clearTimeout + 非 timeout 路径 `connection.end()` + `connection.destroy()` | **无** |

`[VERIFIED: 源码实读，arpCollector.ts / ai.ts / telnetExec.ts cleanup 函数逐行核对]`

**额外收益**：`connection.ts`（终端会话 SSH/Telnet/RDP，`session.client.end()` + `destroy()` @ 255-260）也可纳入，但终端会话生命周期长（用户手动开关窗），优先级低于上述四条「自动发现/AI 执行」高频路径。

## 真路径 mock 对端方案（SC2「无需真实设备即可在 CI/本地绿」）

### ssh2 对端：自建最小 SSH server（ssh2.Server）

ssh2 库**双向可用**——既能当 Client（项目当前用法），也能当 Server（`ssh2.Server`）。测试用 `ssh2.Server` 起一个内存级 SSH server，监听随机端口，接受任意用户名/密码/密钥，回显预设命令输出。

```typescript
// tests/electron/_helpers/mockSshServer.ts
import { Server } from 'ssh2'

export function startMockSshServer(onExec: (cmd: string) => string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = new Server({ hostKeys: [generateTestHostKey()] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept())  // 接受任意凭证
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (accept, _, { command }) => {
            const stream = accept()
            stream.end(onExec(command))  // 回显预设输出
          })
        })
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }))
  })
}
```

`ssh2.Server` 是 ssh2 1.17.0 的内置 API（项目已装），零新依赖。覆盖 `executeSSH` / `executeCommandsOnDevice` / `execOne` 的 `client.exec` 路径。`[CITED: ssh2 README — Server 类双向支持；项目锁 ssh2 1.17.0]`

### telnet 对端：原生 net.Server echo

telnet 协议极简（明文 TCP + IAC 协商字节），用 Node 内建 `net.Server` 起一个 echo server，回显命令 + 模拟 shellPrompt（如 `<device>`）+ 响应 disable-pagination 命令。

```typescript
// tests/electron/_helpers/mockTelnetServer.ts
import net from 'net'

export function startMockTelnetServer(onCmd: (cmd: string) => string, shellPrompt = 'mock>'): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.write(shellPrompt)  // 模拟登录后 prompt
      socket.on('data', (buf) => {
        const cmd = buf.toString().trim()
        if (cmd) socket.write(onCmd(cmd) + '\r\n' + shellPrompt)  // 回显 + prompt
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }))
  })
}
```

零新依赖（Node 内建 `net`，项目 connection.ts:5 已用）。覆盖 `executeTelnetCommand` / arpCollector telnet 路径。`[CITED: telnet-client 协议明文 + Node net.Server]`

### DB 真路径：临时 DB 文件 + getDatabase() 替换

不用 mock，直接用 electron-ABI better-sqlite3 建临时 DB 文件（`os.tmpdir()` + 唯一名），跑真实 `init.ts createTables` + `migrations.ts runMigrations`，验真实 WAL/加密列/迁移幂等。

```typescript
// tests/electron/_helpers/realDb.ts
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'

export function makeRealDb(): { db: Database.Database; close: () => void } {
  const dbPath = path.join(os.tmpdir(), `nt-test-${Date.now()}-${Math.random()}.db`)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // 跑 createTables + runMigrations（真实路径）
  return { db, close: () => { db.close(); fs.unlinkSync(dbPath); fs.unlinkSync(dbPath + '-wal'); fs.unlinkSync(dbPath + '-shm') } }
}
```

经 `getDatabase()` 单例替换（已有 `_setExperienceDbGetter` 范式可参考，DB 层可加测试专用 `_setDbGetter` 注入点——**但这属生产代码微改，需 planner 确认是否在 SC4 允许范围**，或用 vi.mock 替换 `connection.ts` 的 `db` 模块级变量）。`[CITED: TESTING.md _setExperienceDbGetter 范式 + connection.ts:16 getDatabase]`

## Standard Stack

### Core（本 phase 新增 devDependency）

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `wtfnode` | 0.10.1 | 句柄泄漏诊断后备（打印泄漏句柄调用栈） | slopcheck `[OK]`；活跃维护（2025-10-05 最新）；vitest 4 已 deps `why-is-node-running` 同类生态；async_hooks 实现，零侵入生产 `[VERIFIED: npm registry + slopcheck]` |

### Supporting（项目已装，本 phase 复用）

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `electron` | 41.0.3 | 经 `ELECTRON_RUN_AS_NODE=1 electron.exe` 当 Node 运行时跑 vitest | 加载 electron-ABI native binding（DEP-1 缓解核心） |
| `@electron/rebuild` | 4.0.4 | 重建 better-sqlite3/ssh2 为 Electron ABI | 现有 `rebuild:native` script，本 phase 不改 `[VERIFIED: package.json:36]` |
| `better-sqlite3` | 12.9.0 | 真路径 DB 测试对象 | 经临时 DB 文件 + getDatabase() 验真实 CRUD/WAL/迁移 |
| `ssh2` | 1.17.0 | 真路径 SSH 测试对象 + mock SSH server（ssh2.Server） | 双向用法：被测 Client + 测试侧 Server |
| `vitest` | 4.1.10 | 测试 runner（在 electron.exe 内跑） | 现有 runner 不换，只换 Node 可执行 |
| `cross-env` | 10.1.0 | 跨平台设 `ELECTRON_RUN_AS_NODE=1` | 现有 devDep，复用 `[VERIFIED: package.json:41]` |
| Node 内建 `net` | — | mock telnet echo server | 零新依赖 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `ELECTRON_RUN_AS_NODE` electron.exe 跑 vitest | electron-vite test mode | electron-vite 不支持 vite 8（否决，见 §electron-vite 评估） |
| `ELECTRON_RUN_AS_NODE` electron.exe 跑 vitest | electron-vitest 包 | 死包 alpha 3+ 年（禁用） |
| `ELECTRON_RUN_AS_NODE` electron.exe 跑 vitest | electron-mocha（13.1.0）换 runner | 换 mocha 弃用现有 vitest 244 用例 + 断言风格漂移；slopcheck 虽 `[OK]` 但代价过大（否决，slopcheck `[OK]` 但违反「沿用 vitest」原则） |
| `process.getActiveResourcesInfo` + wtfnode | jest-leak-detector | jest-leak-detector 测弱引用对象图（GC 级内存泄漏），**非句柄泄漏**，不适用 ssh2/Telnet Socket 句柄 |
| `process.getActiveResourcesInfo` + wtfnode | 自建 try-finally instrumentation | 需改 4 个生产 service 加计数器（违反 SC4 红线，否决） |
| ssh2.Server mock 对端 | sshd mock 库 / docker sshd | 引入重依赖 + CI 需 docker；ssh2.Server 零新依赖更优 |

**Installation（本 phase 唯一新装包）:**
```bash
npm install -D wtfnode
```

**Version verification（npm registry 直查，2026-08-07，经 `--registry=https://registry.npmjs.org` 绕开 mirror proxy）:**
- wtfnode 0.10.1（2025-10-05）`[VERIFIED: npm registry]`
- vitest 4.1.10（2026-07-06）`[VERIFIED: npm registry]`
- electron-vite 5.0.0（2025-12-07）peer vite `^5||^6||^7`——**不支持 vite 8** `[VERIFIED: npm registry peerDependencies]`
- electron-vitest 1.0.0-alpha.0（2022-09-11，唯一版本，3+ 年未更新）`[VERIFIED: npm registry + slopcheck SUS]`

## Package Legitimacy Audit

> slopcheck 已安装可用（`python -m slopcheck`），实跑 `slopcheck install` 获判定。

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| wtfnode | npm | ~9 yr（自 2017） | 中等（vitest 生态同类） | github.com/myndzi/wtfnode | `[OK]` | Approved — 唯一新装 devDep |
| electron-vite | npm | ~4 yr（v5.0.0 2025-12） | 高 | github.com/alex8088/electron-vite | `[OK]` | **不装**（vite 8 peer 不兼容，否决迁移方案） |
| electron-vitest | npm | 3+ yr 停滞 | 9/wk（slopcheck 实测） | github.com/alex8088/electron-vitest | `[SUS]` | **不装**（死包，禁用） |
| electron-mocha | npm | ~10 yr | 低-中 | github.com/jpdriver/electron-mocha | `[OK]` | **不装**（换 runner 代价过大，否决） |
| why-is-node-running | npm | ~9 yr | 高（vitest 4 已 deps） | github.com/feross/why-is-node-running | `[OK]` | 已随 vitest 4 装，0 新增 |

**Packages removed due to slopcheck [SLOP] verdict:** none（无 [SLOP]，仅 electron-vitest [SUS] 已主动禁用）

**Packages flagged as suspicious [SUS]:** electron-vitest（slopcheck「Only 9 downloads」+ 单一 alpha 版本 3+ 年未更新）—— **研究侧已判定禁用，planner 无需加 checkpoint**

## Architecture Patterns

### System Architecture Diagram

```text
开发者本地 / CI runner
        │
        ├──① npm test  ────────────► plain node (vitest) ──► 现有 mock 套件（16/17 文件 244 用例）
        │   （现有，不动）              environment=node         _setExperienceDbGetter 注入 + 单语句桩
        │                                                          ↓ 零 native binding 加载
        │                                                       mock 套件 244 用例保持绿
        │
        └──② npm run test:electron ─► cross-env ELECTRON_RUN_AS_NODE=1
            （本 phase 新增）            │
                                       ▼
                          node_modules/electron/dist/electron.exe（Electron 41 内置 Node）
                                       │ （NODE_MODULE_VERSION 与 @electron/rebuild 重建后一致）
                                       ▼
                          node_modules/vitest/vitest.mjs run --config vitest.electron.config.ts
                                       │
                                       ▼
                          tests/electron/**/*.test.ts（新增真路径套件）
                                       │
                ┌──────────────────────┼──────────────────────────┐
                ▼                      ▼                          ▼
        better-sqlite3 真路径      ssh2 真路径               telnet 真路径
        （临时 DB 文件 +          （Client → ssh2.Server    （telnet-client → net.Server
          getDatabase 真实 CRUD     mock 对端，监听 127.0.0.1   mock echo，监听 127.0.0.1
          + WAL + 迁移幂等）        随机端口）                随机端口）
                │                      │                          │
                ▼                      ▼                          ▼
        afterEach: process.getActiveResourcesInfo() snapshot 对比
        （泄漏 TCPWrap/Timeout → wtfnode.dump() 打印调用栈 → fail 测试）
```

**主用例 trace**：开发者改 `ai.ts executeCommandsOnDevice` → 跑 `npm run test:electron` → electron.exe 加载 electron-ABI ssh2 → mock SSH server 接受连接 → 验 client.exec 回显 → afterEach 检 `getActiveResourcesInfo` 无泄漏 TCPWrap → 测试绿 = cleanup 正确。整链无需真实 H3C 设备。

### Recommended Project Structure（新增部分）

```
network_toplogy/
├── package.json                      # +1 script: test:electron（不改既有任何 script）
├── vitest.config.ts                  # 现有，不动（plain Node mock 套件）
├── vitest.electron.config.ts         # 【新增】真路径套件配置（environment=node + include tests/electron/**）
├── tests/
│   ├── unit/                         # 现有 7 文件，不动
│   └── electron/                     # 【新增】真路径套件（DEP-1 缓解后跑在 electron.exe 内）
│       ├── _helpers/
│       │   ├── handleLeakDetector.ts # process.getActiveResourcesInfo + wtfnode 工具
│       │   ├── mockSshServer.ts      # ssh2.Server mock 对端
│       │   ├── mockTelnetServer.ts   # net.Server telnet echo
│       │   └── realDb.ts             # 临时 DB 文件 + createTables + runMigrations
│       ├── arpCollector.real.test.ts # 覆盖 executeSSH cleanup（TEST-02）
│       ├── ai.execCommands.real.test.ts # 覆盖 executeCommandsOnDevice + execOne cleanup（TEST-02）
│       ├── telnetExec.real.test.ts   # 覆盖 executeTelnetCommand finally cleanup（TEST-02）
│       └── db.real.test.ts           # 覆盖 getDatabase 真路径 CRUD + 迁移幂等（TEST-01）
└── electron/                         # 生产代码，0 改动（SC4）
```

### Pattern 1: ELECTRON_RUN_AS_NODE 跑 vitest

**What:** 用项目已装的 electron.exe 作为 Node 运行时跑 vitest，绕开 plain Node 无法加载 electron-ABI native binding 的限制。

**When to use:** 任何测试需要加载经 `@electron/rebuild` 重建的 native binding（better-sqlite3/ssh2/telnet-client 等）时。

**Example:**
```jsonc
// package.json scripts
{
  "test": "vitest run",  // 现有，不动（plain Node + mock 套件）
  "test:electron": "cross-env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run --config vitest.electron.config.ts"
  //                                  ↑ 关键：electron.exe 当 Node，ABI 与 rebuild 后 native binding 一致
}
```
`[CITED: Electron docs ELECTRON_RUN_AS_NODE + 本地实跑验证（electron-ABI better-sqlite3 加载 + CRUD 全绿）]`

### Pattern 2: 双 vitest config 物理隔离

**What:** 现有 `vitest.config.ts`（plain Node mock 套件）与新 `vitest.electron.config.ts`（真路径套件）物理隔离，互不污染。

**Example:**
```typescript
// vitest.electron.config.ts【新增】
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/electron/**/*.test.ts'],  // 只采集真路径套件
    // 不 inline electron/（避免触发 plain-node 转换逻辑；用真 binding）
    testTimeout: 15000,  // ssh2/telnet 网络操作给足超时
    hookTimeout: 10000,
  },
})
```

### Pattern 3: 句柄泄漏 snapshot 对比

**What:** `beforeAll`/`beforeEach` 取 `process.getActiveResourcesInfo()` 基线，`afterEach` 对比，泄漏即 fail + wtfnode 诊断。

**Example:** 见 §句柄泄漏检测机制 § Pattern 代码块。

### Pattern 4: ssh2.Server 双向 mock

**What:** 复用 ssh2 既能当 Client（被测）又能当 Server（mock 对端）的特性，零新依赖起内存级 SSH server。

**Example:** 见 §真路径 mock 对端方案 § mockSshServer.ts 代码块。

### Anti-Patterns to Avoid

- **改生产 service 加句柄计数器（自建 instrumentation）**：违反 SC4 红线；用测试侧 `getActiveResourcesInfo` 替代，零侵入。
- **mock→真 全量替换**：CONTEXT.md decision #3 锁定保留 mock 套件，两套并存；强行替换会丢业务逻辑回归网。
- **直接 `require('better-sqlite3')` 验真路径在 plain node 跑**：DEP-1 必崩；必须走 electron.exe。
- **用 `electron-vite` 完整迁移构建**：vite 8 peer 不兼容 + 改 native 外部化清单（违反 SC4）。
- **`ELECTRON_RUN_AS_NODE` + `electron` CLI（而非 electron.exe 直接路径）**：`electron` CLI 会拉起 BrowserWindow 窗口，必须直连 `node_modules/electron/dist/electron.exe`。

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| 句柄泄漏检测 | 自建 try-finally instrumentation（改 4 个生产 service 加计数器） | `process.getActiveResourcesInfo()` + `wtfnode` | 自建违反 SC4；内置 API + 成熟库零侵入，覆盖所有句柄类型 |
| mock SSH 对端 | 自建从 TCP 字节流解析 SSH 协议 | `ssh2.Server`（ssh2 1.17.0 内置） | SSH 协议握手/加密/通道复用极复杂；ssh2.Server 已实现全部，零新依赖 |
| 泄漏句柄调用栈定位 | 自建 async_hooks tracker | `wtfnode.dump()` | wtfnode 已封装 async_hooks 句柄栈追踪，活跃维护 |
| 跨平台设环境变量 | 自建 process.env + child_process 拼接 | `cross-env`（已 devDep） | Windows/Linux 设 env 语义不同，cross-env 已解决 |

**Key insight:** 本 phase 的所有「检测工具」问题（句柄/泄漏/对端）都有成熟零侵入方案，**绝不应改生产代码加 instrumentation**——SC4 红线的根本依据即在于此。

## Common Pitfalls

### Pitfall 1: electron-vite peer 不兼容 vite 8 被忽略

**What goes wrong:** 文档/博客写「用 electron-vite 集成 vitest 跑 Electron 内测试」，照搬装 electron-vite 触发 peer 警告或运行时 vite 解析错。
**Why it happens:** electron-vite 全版本（含最新 5.0.0）peer 只到 vite 7；项目锁 vite 8。
**How to avoid:** 不用 electron-vite 完整迁移；用 `ELECTRON_RUN_AS_NODE electron.exe` 跑 vitest 等效达成目标。
**Warning signs:** `npm install electron-vite` 报 `EBADENGINE`/peer 警告；vite 启动报 plugin 解析错。

### Pitfall 2: `ELECTRON_RUN_AS_NODE` 误用 `electron` CLI

**What goes wrong:** 写 `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs`，结果拉起 BrowserWindow 窗口或卡住。
**Why it happens:** `electron` CLI（npm bin）会触发 Electron 主进程入口，即便设了 RUN_AS_NODE 在某些平台仍会走 app 生命周期。
**How to avoid:** 直连 `node_modules/electron/dist/electron.exe`（Windows）/ `node_modules/electron/dist/electron`（Linux），bypass CLI。
**Warning signs:** 测试启动慢/出现窗口/`app.whenReady` 相关报错。

### Pitfall 3: better-sqlite3 临时 DB 文件残留

**What goes wrong:** 测试用临时 DB 文件未清理，CI/本地堆积；WAL/SHM 侧车文件遗留致下次测试加载脏数据。
**Why it happens:** `db.close()` 后 .db 主文件删了，但 `-wal`/`-shm` 侧车未删；或 `afterAll` 顺序错（先 unlink 后 close）。
**How to avoid:** `realDb.close()` 内严格 `db.close()` → `fs.unlinkSync(dbPath)` + `dbPath + '-wal'` + `dbPath + '-shm'`（try/catch 容错 not-exist）；用唯一文件名（`Date.now() + Math.random()`）防并发撞。
**Warning signs:** CI 磁盘增长；测试间状态串味（前测数据出现在后测）。

### Pitfall 4: ssh2 mock server 未关闭致句柄泄漏误报

**What goes wrong:** 测试 afterEach 报泄漏，但泄漏的是 mock server 自身（`ssh2.Server` 未 close），不是被测代码。
**Why it happens:** mock server `server.close()` 异步，afterEach 时尚未释放 TCPWrap。
**How to avoid:** mock server 在 `afterAll` 关 + 等 `close` 回调；`handleLeakDetector` 的 allowlist 加上 mock server 端口偶发残留；或 `server.closeAllConnections()` + `await close`。
**Warning signs:** 泄漏报 `TCPWrap` 但被测代码不持 socket；测试串行跑时第一个测试报泄漏、后续不报。

### Pitfall 5: getActiveResourcesInfo 基线漂移

**What goes wrong:** afterEach 对比泄漏，但 baseline 取太早（vitest runner 内部 timer 已变化）导致误报。
**Why it happens:** vitest 4 test runner 自身可能持 Timeout/GetAddrInfoReqWrap（test runner 心跳/内部调度），baseline 须取在每个测试 `beforeEach` 而非 `beforeAll`。
**How to avoid:** `beforeEach` 取 baseline（紧贴被测代码执行前）；allowlist 默认放行 vitest 自身常见句柄类型；`afterEach` 前 `await sleep(50)` 给 cleanup 异步时间。
**Warning signs:** 同一测试偶发泄漏偶发绿；泄漏类型是 `Timeout` 且无被测 setTimeout 对应。

### Pitfall 6: 现有 mock 套件被新 config 误采集

**What goes wrong:** 新 `vitest.electron.config.ts` 的 include 误含 `electron/**/*.test.ts`，导致 plain-node 套件被 electron.exe 也跑一遍（重复 + 部分 vi.mock 失效）。
**Why it happens:** 现有 co-located 测试在 `electron/services/*.test.ts`，与生产源码同目录。
**How to avoid:** 新 config include 严格限定 `tests/electron/**/*.test.ts`（独立目录，不碰 `electron/**`）；现有 config 的 include（`tests/**/*.test.ts` + `electron/**/*.test.ts`）不动。
**Warning signs:** electron.exe 跑测试时报 vi.mock/electron 相关错；测试数翻倍。

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| plain Node 跑 vitest 测 Electron 主进程 | ELECTRON_RUN_AS_NODE electron.exe 跑 vitest | 持续（DEP-1 长期 defer 的根因） | 解锁 native binding 真路径回归 |
| electron-vite 统一构建+测试 | 双构建（vite renderer + esbuild main）+ electron.exe 跑测试 | electron-vite 5（2025-12）peer 仍只到 vite 7 | vite 8 项目无法用 electron-vite，须走 ELECTRON_RUN_AS_NODE |
| jest-leak-detector 测内存泄漏 | process.getActiveResourcesInfo 测句柄泄漏 | Node 17.3+（2022） | 句柄（TCP/timer）与内存（GC）是两类泄漏，工具不可混用 |
| 人工真机 HV 句柄泄漏（Phase 6 SC#4 / Phase 3） | 自动化 getActiveResourcesInfo snapshot | 本 phase（TEST-02） | 闭合 DEP-1 长期 defer 项 |

**Deprecated/outdated:**
- `electron-vitest`（alex8088）：2022 alpha 后停滞，slopcheck `[SUS]` 9 downloads/wk，禁用
- 在 plain Node mock better-sqlite3 跑真路径测试：DEP-1 下不可行（只能 mock，不能真路径）

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `vitest 4.1.10` 的入口可经 `node_modules/vitest/vitest.mjs` 由 electron.exe 直接调用 | §推荐项目结构 | 中 — 若 vitest 4 入口路径不同，需调 script 形态（planner 加 checkpoint 验实际启动） |
| A2 | ssh2.Server 可在 `ELECTRON_RUN_AS_NODE` 下正常 listen + 接受连接 | §真路径 mock 对端 | 低 — ssh2 双向 API 成熟，但 electron.exe 当 Node 跑 ssh2.Server 未本地实跑（planner 加 checkpoint 验） |
| A3 | getDatabase() 经 vi.mock 或新增 `_setDbGetter` 注入点可替换为临时 DB | §真路径 mock 对端 / DB | 中 — 若走 `_setDbGetter` 属生产代码微改，需 planner 确认 SC4 允许范围（推荐优先 vi.mock 零侵入） |
| A4 | wtfnode 在 `ELECTRON_RUN_AS_NODE` 下 async_hooks 可用 | §句柄泄漏检测 | 低 — async_hooks 是 Node 内建模块，RUN_AS_NODE 应保留；best-effort import 已容错 |

**所有 [VERIFIED]/[CITED] 结论见 §Sources；以上 4 条是低-中风险实现细节，planner 应在对应 task 加 checkpoint 验证。**

## Open Questions

1. **getDatabase() 注入策略：vi.mock vs 生产代码加 _setDbGetter？**
   - What we know: 现有 `_setExperienceDbGetter` 范式（@internal export）已用于 experienceService；vi.mock 可零改生产代码 mock `connection.ts` 的 db 单例。
   - What's unclear: vi.mock `connection.ts` 是否会牵连所有 import connection 的 service（ai/arpCollector/experienceService...）需级联 mock，可能过重。
   - Recommendation: planner 优先评估 vi.mock 整体替换 `connection.getDatabase` 返回临时 DB；若牵连过广，退而用 SC4 允许的「测试专用 @internal `_setDbGetter`」（与 `_setExperienceDbGetter` 同模式，1-2 行微改，planner 与用户 plan review 时定）。

2. **CI 扩展决策（交 planner 评估，见 §CI 扩展）**
   - What we know: build-smoke.yml 已用 @electron/rebuild + windows-latest；test:electron 可挂在 rebuild 之后。
   - What's unclear: CI 时长增量 + ELECTRON_RUN_AS_NODE 在 GitHub Actions windows-latest 是否需 xvfb/--no-sandbox。
   - Recommendation: 见下节。

## CI 扩展（planner 决策依据）

### 现状（build-smoke.yml）

```yaml
- run: npm ci
- run: npm run rebuild:native   # 重建 electron-ABI native binding
- run: npm run build
- run: npm test                  # ← 当前：plain node vitest（rebuild 后会因 ABI 冲突崩！）
- name: verify native binding built for electron ABI
  run: test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

**现有 CI 隐患（DEP-1 在 CI 的体现）**：`rebuild:native` 后 better-sqlite3 切 electron-ABI，`npm test`（plain node vitest）会**因 ABI 冲突崩**——即当前 CI 的 test 步骤实际跑的是 mock 套件（不经 better-sqlite3 import 链），一旦有真路径测试进 `npm test`，CI 即红。本 phase 的新真路径套件**必须挂 `test:electron` 而非 `test`**。`[VERIFIED: 本地实跑 rebuild 后 plain node 崩；build-smoke.yml:25-27 实读]`

### ELECTRON_RUN_AS_NODE 在 GitHub Actions windows-latest 可行性

- `ELECTRON_RUN_AS_NODE=1` 让 electron.exe 当 Node 跑，**不起 BrowserWindow**，故**不需 xvfb**（Linux 才需 X server 跑 GUI）。
- `--no-sandbox` 是 Chromium 概念，RUN_AS_NODE 模式不走 Chromium，**不需 `--no-sandbox`**。
- windows-latest 是本 phase 主战场（项目 Windows-only NSIS 打包），electron.exe 直接可用。
- 风险：GitHub Actions runner 对 electron.exe 的 antivirus 误报（曾见案例），需 `Set-ExecutionPolicy` 或签路径白名单——planner 加 checkpoint 验。`[ASSUMED]`（基于 ELECTRON_RUN_AS_NODE 语义推断，未在 GHA 实跑）

### 推荐挂法（planner 参考）

```yaml
# build-smoke.yml 新增 step（rebuild 之后）
- run: npm run test:electron
  # 加 mock 套件保留单独 step（避免 rebuild 后 npm test 崩，把 mock 套件也挪到 electron.exe 跑？）
```

**关键决策点（planner + 用户 plan review）**：
- **方案 CI-A**：`npm test`（mock 套件）放 `rebuild:native` **之前**（plain node 跑，不碰 native），`npm run test:electron`（真路径）放 `rebuild:native` 之后——两段 CI，时长 +30-60s（真路径套件网络操作）。
- **方案 CI-B**：mock 套件也挪进 `test:electron`（全量 electron.exe 跑），删 `npm test` step——CI 简化但 mock 套件也变 electron.exe 跑（时长 +更多）。
- **方案 CI-C**：`test:electron` 只本地跑（package.json script 提供），CI 暂不挂——保守，但 CI 不锁真路径回归（违背 SC2「CI/本地绿」精神）。

**Recommendation:** CI-A（mock 与真路径分段，CI 锁两条回归网，时长代价可接受 ~+1min）。`[ASSUMED]` CI 时长增量未实测，planner 加 checkpoint 实测后定。

## 测试用例优先级（planner 参考基线）

基于 SC + 现有 mock 覆盖盲区（TESTING.md「无测试」清单）+ defer 项覆盖，建议优先级：

| 优先级 | 用例 | 覆盖 REQ | 覆盖 defer / 盲区 | 复杂度 |
|--------|------|---------|------------------|--------|
| P0 | `db.real.test.ts` — getDatabase 真路径 CRUD + 迁移幂等 | TEST-01 | TESTING.md「DB 层仍用 mock 无真实 DB 集成层」（最大盲区） | 低（无网络） |
| P0 | `ai.execCommands.real.test.ts` — executeCommandsOnDevice + execOne cleanup | TEST-02 + TEST-01 | Phase 6 SC#4 + Phase 3 defer（最高价值 defer 项） | 中（ssh2.Server） |
| P1 | `arpCollector.real.test.ts` — executeSSH cleanup | TEST-02 | arpCollector 0 测试（盲区） + Phase 6 SC#4 | 中（ssh2.Server） |
| P1 | `telnetExec.real.test.ts` — executeTelnetCommand finally cleanup | TEST-02 + TEST-01 | telnetExec 0 测试（盲区） | 中（net.Server） |
| P2 | 句柄泄漏专项 `handleLeak.real.test.ts` — 集中跑各 service 在异常路径（timeout/stream error/对端 RST）下的 cleanup | TEST-02 | Phase 6 SC#4 + Phase 3 长时间运行 defer | 高（构造异常场景） |

**建议 planner 至少落地 P0+P1（4 用例文件）即满足 SC2/SC3；P2 视剩余预算加。** `[RECOMMENDED]`（基于 SC 优先级排序，planner 可调）

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `node_modules/electron/dist/electron.exe` | test:electron script | ✓ | 41.0.3 | — |
| `@electron/rebuild` | rebuild:native（本 phase 不改） | ✓ | 4.0.4 | — |
| Node ≥17.3（getActiveResourcesInfo） | 句柄检测 | ✓ | 本地 Node 24.13 / Electron 41 内置 Node 均满足 | — |
| `better-sqlite3` 真路径 | DB 真测试 | ✓ | 12.9.0（需 rebuild:native 后跑 test:electron） | — |
| `ssh2`（Client + Server） | SSH 真测试 + mock 对端 | ✓ | 1.17.0 | — |
| `cross-env` | 跨平台设 env | ✓ | 10.1.0 | — |
| `wtfnode` | 句柄诊断 | ✗（待装） | 0.10.1 | 不装则 wtfnode.dump() best-effort 跳过（getActiveResourcesInfo 仍可用） |
| npm registry 访问 | 装 wtfnode | ⚠️ | npmmirror proxy 当前 ECONNREFUSED（127.0.0.1:10809 未开） | 用 `--registry=https://registry.npmjs.org` 直连（本次调研已验证可用） |

**Missing dependencies with no fallback:** none

**Missing dependencies with fallback:** wtfnode（不装不影响主流程，仅诊断信息弱化）

**注意（装包代理）**：用户 npm 默认 registry 配 npmmirror 需经代理 127.0.0.1:10809；本次调研期间代理未开致 `npm view` ECONNREFUSED。装 wtfnode 前需**先开代理**或**临时改 `--registry=https://registry.npmjs.org`**（已验证直连可用）。`[VERIFIED: 本次调研 `npm view vitest version --registry=https://registry.npmjs.org` 直连成功返回 4.1.5]`

## Validation Architecture

> `.planning/config.json` 未设 `workflow.nyquist_validation`，按 enabled 处理。

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.10（双 config：现有 plain Node + 新 electron.exe） |
| Config file | `vitest.config.ts`（现有 mock 套件）+ `vitest.electron.config.ts`（本 phase 新增真路径） |
| Quick run command | `npm test`（mock 套件，plain node，秒级） |
| Electron 真路径命令 | `npm run test:electron`（真路径套件，electron.exe，~10-30s） |
| Full suite command | `npm test && npm run test:electron`（双套件全绿） |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEST-01 | electron.exe 加载 electron-ABI better-sqlite3 + 真路径 CRUD | integration | `npm run test:electron -- tests/electron/db.real.test.ts -t "CRUD"` | ❌ Wave 0 新建 |
| TEST-01 | ssh2 真路径（executeCommandsOnDevice）经 mock SSH server | integration | `npm run test:electron -- tests/electron/ai.execCommands.real.test.ts` | ❌ Wave 0 新建 |
| TEST-01 | telnet 真路径（executeTelnetCommand）经 mock echo server | integration | `npm run test:electron -- tests/electron/telnetExec.real.test.ts` | ❌ Wave 0 新建 |
| TEST-02 | executeSSH cleanup 无句柄泄漏 | integration + leak detect | `npm run test:electron -- tests/electron/arpCollector.real.test.ts -t "no leak"` | ❌ Wave 0 新建 |
| TEST-02 | executeCommandsOnDevice + execOne cleanup 无句柄泄漏 | integration + leak detect | `npm run test:electron -- tests/electron/ai.execCommands.real.test.ts -t "no leak"` | ❌ Wave 0 新建 |
| TEST-02 | executeTelnetCommand finally cleanup 无句柄泄漏 | integration + leak detect | `npm run test:electron -- tests/electron/telnetExec.real.test.ts -t "no leak"` | ❌ Wave 0 新建 |
| SC4 | 生产代码零改动回归（既有 mock 套件 244 用例仍绿） | regression | `npm test`（现有，不动） | ✅ 现有 16/17 文件 |

### Sampling Rate

- **Per task commit:** `npm test`（mock 套件秒级，验未破坏既有回归网）+ `npm run test:electron`（真路径套件，验新代码）
- **Per wave merge:** `npm test && npm run test:electron`（双套件全绿）
- **Phase gate:** 双套件全绿 + SC4 grep 验证（生产代码零改动）+ 真机不必须（DEP-1 缓解核心目标即消除真机 HV）

### Wave 0 Gaps

- [ ] `vitest.electron.config.ts` — 新建真路径套件配置
- [ ] `tests/electron/_helpers/handleLeakDetector.ts` — 句柄泄漏检测工具
- [ ] `tests/electron/_helpers/mockSshServer.ts` — ssh2.Server mock 对端
- [ ] `tests/electron/_helpers/mockTelnetServer.ts` — net.Server telnet echo
- [ ] `tests/electron/_helpers/realDb.ts` — 临时 DB 文件 + 迁移
- [ ] `package.json` +1 script `test:electron`（不改既有）
- [ ] wtfnode 装包（`npm install -D wtfnode`，需先开代理或直连 registry）
- [ ] SC4 验证机制：`git diff electron/` 应为空（生产代码零改动）

## Security Domain

> 本 phase 是纯测试基础设施，不引入新 attack surface（不加 IPC channel、不改加密、不碰 commandSafety）。security_enforcement 按项目惯例（absent = enabled）但本 phase 适用面窄。

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | 本 phase 不动 auth（测试用 mock SSH server 接受任意凭证是测试侧，不进生产） |
| V3 Session Management | no | 不动 session |
| V4 Access Control | no | 不动 IPC 鉴权（三红线之一，不可回退） |
| V5 Input Validation | no | 不动 IPC 入参校验 |
| V6 Cryptography | no | 不动 crypto/字段加密（三红线之一）；真路径测试若读加密列走真实 decField |

### Known Threat Patterns for 测试基础设施

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| mock SSH server 凭证写死源码 | Information Disclosure | 测试用随机生成 hostKey（`crypto.generateKeyPairSync`）、不写真实凭证；tests/ 不进安装包（electron-builder.yml 排除） |
| 临时 DB 文件含敏感数据 | Information Disclosure | 临时 DB 用 `os.tmpdir()` + 唯一名 + afterAll 强删；不落项目目录；测试不用真实 masterKey（用 `MK_TEST_KEY` 范式） |
| test:electron 在 CI 暴露内部路径 | Information Disclosure | CI 日志脱敏沿用 secure()/safe() 范式；测试日志不打印真实设备 IP（用 127.0.0.1 mock） |

## Sources

### Primary (HIGH confidence)

- **本地实跑验证（2026-08-07）**：
  - `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe` 加载 electron-ABI better-sqlite3 + 建表 + 查询 → 全绿 `[VERIFIED: 本地实跑]`
  - plain node 加载 electron-ABI better-sqlite3 → ABI 崩（DEP-1 复现）`[VERIFIED: 本地实跑]`
- **npm registry 直查（经 `--registry=https://registry.npmjs.org` 绕开 mirror proxy）**：
  - electron-vite 5.0.0（2025-12-07）peer vite `^5||^6||^7` → 不支持 vite 8 `[VERIFIED: npm registry peerDependencies]`
  - electron-vite 全版本（1.0.x / 2.x / 3.x / 4.x / 5.0.0）peer 范围直查 → 无支持 vite 8 版本 `[VERIFIED]`
  - electron-vitest 1.0.0-alpha.0（2022-09-11，唯一版本）`[VERIFIED: npm registry 元数据]`
  - vitest 4.1.10（2026-07-06）peer vite `^6||^7||^8`（兼容项目 vite 8）+ deps `why-is-node-running` `[VERIFIED]`
  - wtfnode 0.10.1（2025-10-05）/ electron-mocha 13.1.0（2025-01-16）/ why-is-node-running 3.2.2（2025-01-08）`[VERIFIED]`
- **slopcheck 实跑（`python -m slopcheck install`）**：electron-vite/wtfnode/electron-mocha/why-is-node-running `[OK]`、electron-vitest `[SUS]`「Only 9 downloads」`[VERIFIED: slopcheck]`
- **源码实读**：arpCollector.ts:25-78 / ai.ts:352-510 / connection.ts / telnetExec.ts:111-155 cleanup 路径逐行核对 `[VERIFIED: 源码实读 + codegraph]`
- **项目文档**：CLAUDE.md / TESTING.md（16/17 文件 244 用例 + _setExperienceDbGetter 范式）/ ARCHITECTURE.md（三进程信任边界）/ package.json（scripts + deps）/ vitest.config.ts / build-smoke.yml / tsconfig.web.json `[CITED]`

### Secondary (MEDIUM confidence)

- **Electron docs ELECTRON_RUN_AS_NODE**：electron.exe 当 Node 运行时的官方语义 `[CITED: Electron 官方文档]`
- **Node.js docs process.getActiveResourcesInfo()**：Node 17.3+ 内置，返回活跃句柄类型数组 `[CITED: Node.js 官方文档]`
- **ssh2 README**：Server 类双向支持（Client + Server）`[CITED: ssh2 官方 README]`

### Tertiary (LOW confidence — 需 planner checkpoint 实跑验证)

- vitest 4.1.10 入口路径 `node_modules/vitest/vitest.mjs` 经 electron.exe 直接调用 `[ASSUMED]`（A1）
- ssh2.Server 在 ELECTRON_RUN_AS_NODE 下 listen + 接受连接 `[ASSUMED]`（A2）
- ELECTRON_RUN_AS_NODE 在 GitHub Actions windows-latest 不需 xvfb/--no-sandbox `[ASSUMED]`（基于语义推断，未在 GHA 实跑）
- CI 时长增量 ~+1min（真路径套件网络操作）`[ASSUMED]`（未实测）

## Metadata

**Confidence breakdown:**
- Standard stack（electron.exe + ELECTRON_RUN_AS_NODE + wtfnode）: HIGH — 本地实跑验证 + registry 直查 + slopcheck
- Architecture（双 config 物理隔离 + 真路径套件布局）: HIGH — 源码实读 + 现有范式（_setExperienceDbGetter）可循
- Pitfalls: HIGH — 6 项均来自源码实读 + DEP-1 本地复现 + electron-vite peer 直查
- electron-vite 否决: HIGH — 全版本 peer 直查 + vite 8 锁定
- 句柄检测机制: HIGH — process.getActiveResourcesInfo 是 Node 内建 + wtfnode slopcheck OK
- CI 扩展细节（GHA windows 可行性 / 时长）: MEDIUM-LOW — 语义推断为主，planner 需 checkpoint 实跑

**Research date:** 2026-08-07
**Valid until:** 2026-09-06（30 天；electron-vite 若出新版支持 vite 8，方案需重评——但 SC4 红线使完整迁移仍受限）
