---
phase: 12-test-infrastructure-dep-1-abi
plan: 01
subsystem: testing
tags: [vitest, electron, electron-run-as-node, better-sqlite3, ssh2, telnet, wtfnode, abi, leak-detection]

# Dependency graph
requires:
  - phase: 12-test-infrastructure-dep-1-abi (research/pattern/context)
    provides: DEP-1 ABI 缓解路径（ELECTRON_RUN_AS_NODE electron.exe 跑 vitest）+ helper 落地骨架 + 11 文件 analog
provides:
  - test:electron npm script（cross-env ELECTRON_RUN_AS_NODE=1 electron.exe vitest.mjs 入口）
  - vitest.electron.config.ts 真路径套件独立配置（与 plain node mock 套件物理隔离 Pitfall 6）
  - tests/electron/_helpers/realDb.ts（临时 better-sqlite3 DB + pragma + close 清理侧车）
  - tests/electron/_helpers/mockSshServer.ts（ssh2.Server 内存级 SSH 对端 + 随机 hostKey + loopback）
  - tests/electron/_helpers/mockTelnetServer.ts（net.Server telnet echo + IAC 协商响应）
  - tests/electron/_helpers/handleLeakDetector.ts（getActiveResourcesInfo snapshot + wtfnode 后备）
  - tests/electron/db.real.test.ts（electron-ABI better-sqlite3 真路径 CRUD + 迁移幂等 + WAL 回归）
  - wtfnode@0.10.1 devDep（句柄泄漏诊断后备，不进生产打包）
affects: [12-02 SSH/Telnet 真路径测试, 12-03 句柄泄漏专项 + CI 扩展, TEST-01, TEST-02]

# Tech tracking
tech-stack:
  added: [wtfnode@0.10.1 (devDep)]
  patterns:
    - "ELECTRON_RUN_AS_NODE=1 electron.exe 跑 vitest（DEP-1 ABI 缓解核心，直连 electron.exe 路径非 CLI）"
    - "双 vitest config 物理隔离（plain node mock 套件 vs electron.exe 真路径套件）"
    - "makeRealDb 临时 DB + pragma 复刻 + 侧车文件清理（OQ#1 方案 A 零生产改动）"
    - "ssh2.Server 双向 mock（Client 被测 + Server 对端，零新依赖）"
    - "net.Server telnet echo + IAC 协商最小响应（DONT/WONT）"
    - "process.getActiveResourcesInfo snapshot 对比 + afterEach sleep(50) + wtfnode.dump 诊断"

key-files:
  created:
    - vitest.electron.config.ts
    - tests/electron/_helpers/realDb.ts
    - tests/electron/_helpers/mockSshServer.ts
    - tests/electron/_helpers/mockTelnetServer.ts
    - tests/electron/_helpers/handleLeakDetector.ts
    - tests/electron/db.real.test.ts
  modified:
    - package.json (+test:electron script +wtfnode devDep)
    - package-lock.json
    - vitest.config.ts (exclude tests/electron/** Pitfall 6)
    - .gitignore (+*.baiduyun.uploading.cfg)

key-decisions:
  - "A1 入口最终路径：node_modules/vitest/vitest.mjs（vitest 4.1.5，经 electron.exe 实跑确认可调起，无需 fallback）"
  - "OQ#1 注入策略：方案 A 直持 makeRealDb 真实 better-sqlite3 实例（零生产改动），不调 getDatabase 单例（connection.ts import electron app 等重依赖，vi.mock 牵连过广）；Plan 12-02 service 真路径测试用 vi.mock 注入 realDb 实例"
  - "wtfnode 装包方式：npm_config_proxy=\"\" npm_config_https_proxy=\"\" --registry=npmjs.org --userconfig=/dev/null（绕开 ~/.npmrc 配的 npmmirror proxy 127.0.0.1:10809 ECONNREFUSED）"
  - "telnet IAC 处理策略：识别 buf[0]===0xFF(255) 序列，对 WILL/DO 回 DONT/WONT 最小协商 + stripIac 剥离明文（待 Plan 12-02 telnetExec.real 连真实 telnet-client 实跑确认）"
  - "realDb 不 import 生产 init.ts/migrations.ts（createTables/runMigrations 用 getDatabase() 单例无 db 参数 + 牵连 electron app）→ runMigrations 选项独立幂等 DDL（hasColumn 守卫模式验证）"
  - "vitest.config.ts exclude tests/electron/**（Rule 3 阻塞修复 Pitfall 6，非 SC4 触发——SC4 仅约束 electron/ 生产代码）"

patterns-established:
  - "Pattern: test:electron 通道（cross-env ELECTRON_RUN_AS_NODE=1 electron.exe vitest.mjs run --config vitest.electron.config.ts）"
  - "Pattern: 双 vitest config 物理隔离（plain config exclude tests/electron/**，electron config include 仅 tests/electron/**）"
  - "Pattern: makeRealDb({ runMigrations?: boolean }) → { db, dbPath, close } 契约（Plan 12-02/12-03 复用）"
  - "Pattern: startMockSshServer(onExec) → { port, close } 契约（Plan 12-02 SSH 真路径复用）"
  - "Pattern: startMockTelnetServer(onCmd, shellPrompt?) → { port, close } 契约（Plan 12-02 telnet 真路径复用）"
  - "Pattern: expectNoHandleLeak(extraAllow?) → afterEach 句柄泄漏检测（Plan 12-03 句柄专项复用）"

requirements-completed: [TEST-01]

# Metrics
duration: ~76min
completed: 2026-08-08
---

# Phase 12 Plan 01: 测试基础设施主干（DEP-1 ABI 缓解）Summary

**vitest 经 ELECTRON_RUN_AS_NODE=1 electron.exe 跑通加载 electron-ABI better-sqlite3（A1 实跑确认 vitest/4.1.5），落地 DB 真路径 CRUD+迁移幂等+WAL 回归 + 4 个 helper 契约（realDb/mockSshServer/mockTelnetServer/handleLeakDetector）供 Plan 12-02/12-03 复用，零生产代码改动（SC4）**

## Performance

- **Duration:** ~76min（含 wtfnode 装包 3 次重试 + 百度云同步 git index 锁重试）
- **Started:** 2026-08-08T01:39:54Z
- **Completed:** 2026-08-08T02:56:10Z
- **Tasks:** 3
- **Files modified:** 10（6 新增 + 4 修改）

## Accomplishments

- **SC1 达成**：`npm run test:electron` 经 `cross-env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run --config vitest.electron.config.ts` 加载 electron-ABI better-sqlite3，不 throw ABI 冲突（A1 实跑确认 vitest/4.1.5 + Node v24.14.0 内嵌）
- **SC2 之 DB 部分达成**：`tests/electron/db.real.test.ts` 3 个 it 全绿（真路径 CRUD + 迁移幂等 + WAL 生效），证明 electron-ABI native binding 在 electron.exe 内可加载 + 真实业务操作
- **SC4 兜底达成**：`git diff --exit-code electron/` 退出码 0（生产代码零改动），唯一例外 vitest.config.ts 是测试基础设施配置（root，非 electron/ 生产代码，RESEARCH Pitfall 6 明确要求）
- **四个 helper 接口契约落地**：realDb / mockSshServer / mockTelnetServer / handleLeakDetector，构成 Plan 12-02（SSH/Telnet 真路径）+ 12-03（句柄泄漏专项）的复用基础
- **现有 mock 套件无回归**：`npm test` 244/244 全绿（17 文件），物理隔离后 db.real.test.ts 不被 plain node 采集（Pitfall 6）
- **三绿门禁全绿**：test:electron 3/3 + npm test 244/244 + build:electron-main esbuild OK（native 外部化清单未破坏）

## Task Commits

每个 task 原子提交：

1. **Task 1: 装 wtfnode + 双 vitest config + test:electron script（SC1 主干）** - `aea9154` (chore)
2. **Task 2: 落地四个测试 helper（接口契约）** - `3022350` (feat)
3. **Task 3: DB 真路径回归测试 + SC4 git diff 兜底** - `dae9f18` (feat)

## Files Created/Modified

- `vitest.electron.config.ts`（新增）— 真路径套件独立 vitest 配置（environment=node + include tests/electron/** + testTimeout/hookTimeout）
- `package.json`（修改）— +test:electron script（直连 electron.exe 路径非 CLI）+ wtfnode devDep
- `package-lock.json`（修改）— wtfnode@0.10.1 装包同步
- `tests/electron/_helpers/realDb.ts`（新增）— 临时 better-sqlite3 DB（os.tmpdir 唯一名 + pragma WAL/foreign_keys/busy_timeout/wal_autocheckpoint + close 严格删主文件/-wal/-shm try/catch ENOENT）+ 独立幂等 DDL 选项
- `tests/electron/_helpers/mockSshServer.ts`（新增）— ssh2.Server 内存级 SSH 对端（crypto.generateKeyPairSync 随机 hostKey + listen(0,'127.0.0.1') loopback + accept 任意凭证 + session.exec 回显 + close 返回 Promise）
- `tests/electron/_helpers/mockTelnetServer.ts`（新增）— net.Server telnet echo（含 IAC 协商 checkpoint：识别 0xFF 序列回 DONT/WONT 最小协商 + stripIac 剥离 + 明文命令回显 shellPrompt）
- `tests/electron/_helpers/handleLeakDetector.ts`（新增）— process.getActiveResourcesInfo snapshot 对比 + afterEach await sleep(50) + 默认放行 Timeout/GetAddrInfoReqWrap + wtfnode.dump best-effort 诊断
- `tests/electron/db.real.test.ts`（新增）— 3 it 真路径回归（CRUD + 迁移幂等 + WAL）
- `vitest.config.ts`（修改）— exclude tests/electron/**（Pitfall 6 物理隔离，Rule 3 阻塞修复）
- `.gitignore`（修改）— +*.baiduyun.uploading.cfg（百度云同步临时标记）

## Decisions Made

- **A1 入口路径确认**：`node_modules/vitest/vitest.mjs`（vitest 4.1.5）经 electron.exe 直调成功，无需 fallback（dist/cli.js / .bin/vitest 未触发）。A1 checkpoint 实跑输出 `vitest/4.1.5 win32-x64 node-v24.14.0`。
- **OQ#1 注入策略（方案 A）**：DB 真路径测试直持 makeRealDb() 返回的真实 better-sqlite3 实例跑 CRUD/迁移，**不**调 getDatabase() 单例（因 connection.ts import electron app/backupScheduler 等重依赖，vi.mock 整模块牵连过广）。零生产代码改动（SC4 最优解）。Plan 12-02 消费 getDatabase 的 service（ai/arpCollector/experienceService）真路径测试用 vi.mock 注入 realDb 实例。
- **realDb 不 import 生产 migrations**：生产 `createTables()`/`runMigrations()` 经 `getDatabase()` 单例（无 db 参数）+ import electron app，测试侧无法直接调用。故 realDb 的 runMigrations 选项跑**独立幂等 DDL**（CREATE TABLE IF NOT EXISTS + hasColumn 守卫 ALTER），验证「迁移幂等守卫模式（hasColumn/sqlite_master 特征串）可在 electron-ABI better-sqlite3 下正常运行」——TEST-01 核心断言之迁移部分。生产迁移注册表的真实回归由 Plan 12-02 service 真路径测试间接覆盖（vi.mock 注入 + 真实 init 调用）。
- **telnet IAC 处理策略**：识别 buf[0]===0xFF(255) 序列，对 WILL/DO 回 DONT/WONT（拒绝所有选项，最小协商），stripIac 剥离 IAC 字节后处理明文命令。待 Plan 12-02 telnetExec.real 连真实 telnet-client 实跑确认；若 connect 卡住超 testTimeout，回退加完整 IAC 响应或调整 echo 时序。
- **wtfnode 装包方式**：~/.npmrc 配了 npmmirror proxy 127.0.0.1:10809（代理未开致 ECONNREFUSED），`--registry=npmjs.org` 单独不够（proxy 配置覆盖 registry），最终用 `npm_config_proxy="" npm_config_https_proxy="" --registry=npmjs.org --userconfig=/dev/null` 四件套绕开，3m 装包成功（wtfnode@0.10.1）。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - 阻塞性] vitest.config.ts exclude tests/electron/**（Pitfall 6 物理隔离）**
- **Found during:** Task 3（npm test 验证阶段）
- **Issue:** 现有 `vitest.config.ts` 的 `include: ['tests/**/*.test.ts', 'electron/**/*.test.ts']` 会采集新增的 `tests/electron/db.real.test.ts`，导致 plain node `npm test` 加载 electron-ABI better-sqlite3 触发 `NODE_MODULE_VERSION 145≠137` ABI 崩（DEP-1 在测试隔离层的体现）。RESEARCH Pitfall 6 已预警此风险但未在 PLAN action 明确要求改 plain config。
- **Fix:** plain `vitest.config.ts` 加 `exclude: ['tests/electron/**', '**/node_modules/**', '**/dist/**']`，真路径套件仅 `test:electron`（electron.exe ABI 匹配）跑。
- **Files modified:** vitest.config.ts
- **Verification:** `npm test` 244/244 全绿（17 文件，db.real 不在采集列表，`grep -c "db.real"` 输出 0）；`test:electron` 3/3 仍绿。
- **Committed in:** dae9f18（Task 3 commit）
- **SC4 红线说明:** 本修改**不触**SC4——SC4 验收命令是 `git diff --exit-code electron/`（仅约束 electron/ 生产代码目录），vitest.config.ts 是 root 级测试基础设施配置。RESEARCH Pitfall 6 + PLAN must_haves.truths「npm test 与 test:electron 物理隔离」明确要求此隔离。

**2. [Rule 2 - 关键功能] realDb runMigrations 独立 DDL（不 import 生产 migrations）**
- **Found during:** Task 2（read_first 阶段实读 init.ts/migrations.ts 源码）
- **Issue:** PLAN Task 2 action 假设「调 createTables(db) 与 runMigrations(db) 从 init.ts/migrations.ts import，传 db 参数」，但实读发现生产 `createTables()`/`runMigrations()` 经 `getDatabase()` 单例（无 db 参数）+ import electron app/backupScheduler 等重依赖。测试侧无法直接调用（app.getPath 在 ELECTRON_RUN_AS_NODE 下不可用 + 牵连过广）。
- **Fix:** realDb.ts 的 runMigrations 选项跑**独立幂等 DDL**（CREATE TABLE IF NOT EXISTS experiences + hasColumn 守卫 ALTER severity），复刻生产迁移的幂等守卫模式（hasColumn/sqlite_master 特征串 + db.transaction 原子），验证守卫模式可在 electron-ABI better-sqlite3 下正常运行。PLAN Task 2 action 已预判此 fallback（「若这些函数签名不接受 db 参数则需在测试内联同等 DDL，executor 先 codegraph 查 createTables/runMigrations 签名确认」）。
- **Files modified:** tests/electron/_helpers/realDb.ts
- **Verification:** db.real.test.ts it 2（迁移幂等）连跑两次第二次 no-op（hasColumn 守卫命中），表结构未变，全绿。
- **Committed in:** 3022350（Task 2 commit）

**3. [Rule 2 - 关键功能] telnet IAC 协商落地（checkpoint 实跑确认策略）**
- **Found during:** Task 2（mockTelnetServer 落地，PLAN + RESEARCH + PATTERNS 标记 IAC checkpoint 未完全展开）
- **Issue:** telnet-client connect 默认发 IAC WILL/WONT 协商字节（0xFF 0xFB/0xFC），若 mock server 不响应或不显式吞掉 IAC 字节，connect 会卡住。
- **Fix:** mockTelnetServer 的 socket.on('data') 内识别 buf[0]===0xFF(255) 序列，对 WILL/DO 回 DONT/WONT（最小协商响应）+ stripIac 剥离 IAC 字节后处理明文命令。落地 IAC 常量（IAC=255/WILL=251/WONT=252/DO=253/DONT=254/SB=250/SE=240）。
- **Files modified:** tests/electron/_helpers/mockTelnetServer.ts
- **Verification:** acceptance grep 含 0xFF/255 字面量（IAC 落地证明）。完整实跑验证待 Plan 12-02 telnetExec.real 连真实 telnet-client（本 plan 不测 telnet 真路径，仅落地 helper 契约）。
- **Committed in:** 3022350（Task 2 commit）

**4. [Rule 3 - 阻塞性] wtfnode 装包绕开 npmmirror proxy ECONNREFUSED**
- **Found during:** Task 1（npm install -D wtfnode 阶段）
- **Issue:** `~/.npmrc` 配了 `proxy=http://127.0.0.1:10809` + `https-proxy=http://127.0.0.1:10809`（代理未开），`npm install` 直连 npmmirror 和 npmjs.org 都 ECONNREFUSED。RESEARCH 已验证「代理未开时用 --registry=npmjs.org 直连」但未提到 proxy 配置覆盖 registry。
- **Fix:** `npm_config_proxy="" npm_config_https_proxy="" npm install -D wtfnode --registry=https://registry.npmjs.org --userconfig=/dev/null` 四件套绕开（env 变量空值覆盖 + 空 userconfig 跳过 ~/.npmrc）。
- **Files modified:** package.json, package-lock.json
- **Verification:** wtfnode@0.10.1 装入 devDependencies，node_modules/wtfnode 可加载。
- **Committed in:** aea9154（Task 1 commit）

---

**Total deviations:** 4 auto-fixed（2 Rule 3 阻塞性 + 2 Rule 2 关键功能）
**Impact on plan:** 全部 auto-fix 是 PLAN/RESEARCH 已预警或预判的实现细节，无 scope creep。Rule 3 修复（vitest.config.ts exclude + wtfnode 装包）是任务完成的硬阻塞；Rule 2 修复（realDb 独立 DDL + telnet IAC）是 PLAN action 明确 fallback 路径。SC4 红线（electron/ 生产零改动）全程未触。

## Issues Encountered

- **百度云同步 git index 锁（EBUSY）**：3 次 commit 触发 `fatal: unable to write new index file`（百度云同步占用 .git/index），按 MEMORY.md 经验等 8s 重试同一命令均成功（无数据丢失）。
- **npm install EBUSY cleanup warning**：wtfnode 装包末尾报 `@emnapi/.wasi-threads-i8E4Xnza\README.md EBUSY`（百度云同步锁临时文件），不影响装包结果（wtfnode@0.10.1 正常装入）。
- **TS5112 tsc 文件参数与 tsconfig 冲突**：standalone type-check 4 个 helper 时 `tsc file.ts` 报 TS5112，用 `--ignoreConfig` flag 解决（TS 6.x 支持）。
- **wtfnode 无 @types 声明**：handleLeakDetector.ts 的 `import('wtfnode')` 报 TS7016 隐式 any，用 `// @ts-expect-error` 抑制（best-effort 动态 import，运行时 catch 兜底）。

## User Setup Required

None — 无外部服务配置（wtfnode 经 devDep 装包完成，test:electron 通道自包含）。

## Checkpoint 结论汇总

- **A1（vitest 入口路径）**：PASS — `node_modules/vitest/vitest.mjs` 经 electron.exe 直调成功，输出 `vitest/4.1.5 win32-x64 node-v24.14.0`。无需 fallback。
- **A2（ssh2.Server 在 ELECTRON_RUN_AS_NODE 下 listen）**：本 plan 未实跑（仅落地 helper 契约），待 Plan 12-02 ai.execCommands.real.test 实跑确认。
- **A3（getDatabase 注入策略）**：已决方案 A（vi.mock / 直持 realDb 实例，零生产改动），Plan 12-02 service 真路径测试落地 vi.mock 注入。
- **A4（wtfnode 在 ELECTRON_RUN_AS_NODE 下 async_hooks）**：best-effort import 已容错（.catch(() => null)），本 plan 未触发 dump 路径（db.real.test 无句柄泄漏），待 Plan 12-03 句柄专项实跑确认。
- **telnet IAC**：策略已落地（识别 0xFF 回 DONT/WONT），待 Plan 12-02 telnetExec.real 连真实 telnet-client 实跑确认。

## Next Phase Readiness

- **Plan 12-02（SSH/Telnet 真路径测试）就绪**：mockSshServer / mockTelnetServer / realDb / handleLeakDetector 四个 helper 契约已落地，直接复用。A2 checkpoint 待 12-02 实跑闭合。
- **Plan 12-03（句柄泄漏专项 + CI 扩展）就绪**：handleLeakDetector 契约已落地，expectNoHandleLeak(extraAllow?) 可直接挂到各 service 真路径测试的 describe 内。CI 扩展（build-smoke.yml 加 test:electron step）待 12-03 决策（CI-A/B/C 三方案，RESEARCH 推荐 CI-A：mock 套件放 rebuild 前，真路径放 rebuild 后）。
- **无阻塞**：三绿门禁全绿，SC4 兜底通过，零生产代码改动，零回归。

---
*Phase: 12-test-infrastructure-dep-1-abi*
*Plan: 01*
*Completed: 2026-08-08*
