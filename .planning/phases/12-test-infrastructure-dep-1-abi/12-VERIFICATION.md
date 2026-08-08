---
phase: 12-test-infrastructure-dep-1-abi
verified: 2026-08-08T05:25:00Z
status: human_needed
score: 4/4 truths verified
overrides_applied: 0
re_verification:
  previous_status: none
  is_re_verification: false
human_verification:
  - test: "push 到 master 或开 PR 触发 build-smoke workflow，在 GHA windows-latest runner 上观察 test:electron step 是否退出码 0"
    expected: "test:electron step 绿（22 it 通过），npm test（rebuild 前）绿（244 通过），verify native binding step 绿；CI 总时长增量 +30~60s"
    why_human: "GHA workflow 需 push/PR 触发，本地无法直接跑 GitHub Actions；orchestrator 已确认本地三绿全过但 GHA 实跑是 PLAN 12-03 明确的 defer 项"
  - test: "GHA 实跑时确认 ssh2 真路径不报 cpu-features ABI mismatch（CR-03 风险）"
    expected: "test:electron step 不出现 NODE_MODULE_VERSION 或 cpu-features 加载错误"
    why_human: "CR-03 指出 rebuild:native 的 -w ssh2 不递归到 cpu-features dependency，windows-latest 上的 ssh2 native 路径是否加载成功只能在 GHA 实跑确认；本地跑通不代表 GHA 同样跑通"
  - test: "确认 CR-01（handleLeakDetector baseline 跨 it 共享）不影响 SC3 实际网兜效果 —— 跨 it 累积泄漏场景"
    expected: "若未来引入跨多个 it 的真实累积泄漏，检测器仍能 fail；或采纳 code review 建议把 baseline 移到 beforeEach"
    why_human: "单 it 内泄漏检测（含 it4 单 it 内 5 次循环累积）经本地 22 it 全绿验证有效；CR-01 指出的跨 it 基线共享在当前用例集未触发误报/漏检，但属防御性质量缺陷，是否修复由人定（建议交 /gsd:code-review --fix）"
---

# Phase 12: Test Infrastructure (DEP-1 ABI 缓解) 验证报告

**Phase Goal:** 用户/CI 在自动化通道（非人工 HV）下能跑通 SSH/Telnet/DB/better-sqlite3 真路径回归，句柄泄漏有自动化网兜，告别 DEP-1 长期 defer 的人工核实
**Verified:** 2026-08-08T05:25:00Z
**Status:** human_needed
**Re-verification:** No — 初始验证

## Goal Achievement

### Observable Truths（roadmap SC1-4）

| # | Truth (SC) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1: vitest 在 Electron 内（electron.exe + ELECTRON_RUN_AS_NODE）可加载 @electron/rebuild 重建的 native binding，plain Node 限制消除 | ✓ VERIFIED | `npm run test:electron` 本 verifier 实跑 exit 0，输出 `Test Files 5 passed (5) / Tests 22 passed (22)`，加载真实 better-sqlite3/ssh2 native binding 无 `NODE_MODULE_VERSION` ABI 冲突。`test:electron` script = `cross-env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run --config vitest.electron.config.ts`（package.json:17 实读）。落地形式修正为 electron.exe 跑 vitest（非 ROADMAP 原文 electron-vite，REQUIREMENTS.md TEST-01 已注脚说明） |
| 2 | SC2: SSH/Telnet/DB 真路径有自动化回归用例（executeCommandsOnDevice/execOne/executeTelnet/executeSSH/DB），无需真实设备在 CI/本地绿 | ✓ VERIFIED (本地全绿) + human_needed (GHA 实跑) | 本地实跑 `test:electron` 22/22 全绿：db.real 3（真 better-sqlite3 prepared statement CRUD + 迁移幂等 + WAL）+ ai.execCommands 5 + arpCollector 4 + telnetExec 5 + handleLeak.real 5。真实协议库 import 确认：ai.execCommands.test.ts `import { Client } from 'ssh2'`（L2，注释 L71 明确不 vi.mock ssh2）；telnetExec.real.test.ts `import { executeTelnetCommand } from '../../electron/utils/telnetExec'`（L34，测本体）→ telnetExec.ts:1 `import { Telnet } from 'telnet-client'`。CI 侧 build-smoke.yml CI-A 配置就位（npm test 移 rebuild 前 L26 + test:electron 挂 rebuild 后 L33），但 GHA windows-latest 未实跑（需 push 触发） |
| 3 | SC3: 句柄泄漏有自动化检测（四条 cleanup 路径 try/finally 回归，替代 Phase 6 SC#4 + Phase 3 真机 HV defer） | ✓ VERIFIED（核心网兜有效）+ CR-01 质量缺陷 | 四条生产 cleanup 路径均存在并被测试覆盖：ai.ts:390-405（executeCommandsOnDevice cleanup）+ ai.ts:461-469（execOne stream/timer cleanup）+ arpCollector.ts:33-50（executeSSH cleanup + timeout destroy）+ telnetExec.ts:147-155（finally cleanup + connection.end/destroy）。handleLeak.real.test.ts 5 it 覆盖异常场景（SSH RST / stream error / telnet 断连 / 长时间循环 5 次 / 混合 timeout+正常）。22 it 全绿无 `句柄泄漏:` 报错。CR-01 指 handleLeakDetector baseline 在模块顶层 describe 取一次跨 it 共享（非 beforeEach）—— 单 it 内检测有效（含 it4 单 it 内 5 循环累积），但跨 it 累积场景准确性存缺陷 |
| 4 | SC4: DEP-1 缓解不改动生产代码路径（只加测试通道 + 工具配置） | ✓ VERIFIED | 本 verifier 实跑 `git diff --exit-code 687fca1..HEAD -- electron/` exit 0（生产代码零改动）。phase 12 commits 改动文件列表（23 文件）全部在 tests/ + vitest config + build-smoke.yml + package.json/lock + .gitignore + .planning/ + CHANGELOG.md，无 electron/ 路径 |

**Score:** 4/4 truths verified

### Deferred Items

无（Phase 12 是 v1.2 milestone 第一个 phase，后续 Phase 13/14 属不同域，不覆盖本 phase 的 defer 项）。本 phase 的 defer 项（GHA 实跑、CR-01/CR-03）属本 phase 内 human_needed，不跨 phase defer。

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `vitest.electron.config.ts` | 真路径套件独立 vitest 配置 | ✓ VERIFIED | 24 行，含 `include: ['tests/electron/**/*.test.ts']`（L20）+ testTimeout:15000 + hookTimeout:10000，无 `electron/**` include，无 server/deps 段 |
| `package.json` test:electron script | cross-env ELECTRON_RUN_AS_NODE electron.exe vitest 入口 | ✓ VERIFIED | L17 `cross-env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run --config vitest.electron.config.ts`；现有 `test`/`test:watch` 未改（L15-16）；rebuild:native 未改（L13） |
| `tests/electron/_helpers/realDb.ts` | 临时 better-sqlite3 DB + pragma + close 清理 | ✓ VERIFIED | 104 行，export `makeRealDb`，含 os.tmpdir + Date.now/Math.random 唯一名 + WAL/foreign_keys/busy_timeout/wal_autocheckpoint pragma + close 删主/-wal/-shm try/catch |
| `tests/electron/_helpers/mockSshServer.ts` | ssh2.Server 内存级 SSH 对端 | ✓ VERIFIED | 72 行，export `startMockSshServer`，含 `new Server` + `crypto.generateKeyPairSync`（随机 hostKey，无写死凭证）+ `server.listen(0,'127.0.0.1')` loopback + close 返回 Promise |
| `tests/electron/_helpers/mockTelnetServer.ts` | net.Server telnet echo + IAC 协商 | ✓ VERIFIED | 138 行，export `startMockTelnetServer`，含 `net.createServer` + listen(0,'127.0.0.1') + IAC 字节处理（0xFF/WILL/DO/DONT/WONT 常量 + DONT/WONT 响应 + stripIac） |
| `tests/electron/_helpers/handleLeakDetector.ts` | getActiveResourcesInfo snapshot + wtfnode 后备 | ✓ VERIFIED (w/ CR-01 缺陷) | 57 行，export `expectNoHandleLeak`，含 process.getActiveResourcesInfo() + afterEach + setTimeout(50) + 动态 import('wtfnode').catch 容错。CR-01：baseline 在调用点（describe 顶层）取一次，跨 it 共享——质量缺陷，单 it 检测仍有效 |
| `tests/electron/db.real.test.ts` | getDatabase 真路径 CRUD + 迁移幂等 | ✓ VERIFIED | 117 行，3 it，db.prepare 出现 6 次（INSERT/SELECT/UPDATE/DELETE），含 runMigrations + journal_mode WAL 断言 |
| `tests/electron/ai.execCommands.real.test.ts` | executeCommandsOnDevice + execOne SSH 真路径 | ✓ VERIFIED | 206 行，5 it，真实 `import { Client } from 'ssh2'`（L2），vi.mock 仅非 ssh2 依赖（commandSafety/knowledgeBaseService/aiExecLogger/experienceRetrieval/connection/telnetExec），含 startMockSshServer + expectNoHandleLeak |
| `tests/electron/arpCollector.real.test.ts` | executeSSH SSH 真路径 + ARPParser | ✓ VERIFIED | 163 行，4 it，含 startMockSshServer + ARPParser.parse 断言 + setArpMasterKey(MK_TEST) 注入（WR-05 指出此注入在 SSH 路径是 dead injection，质量建议非阻塞）+ expectNoHandleLeak |
| `tests/electron/telnetExec.real.test.ts` | executeTelnetCommand telnet 真路径 + IAC | ✓ VERIFIED | 133 行，5 it，真实 `import { executeTelnetCommand } from '../../electron/utils/telnetExec'`（L34，不 vi.mock telnetExec 本体），含 startMockTelnetServer + finally cleanup + timeout cleanup + vendor 分流 |
| `tests/electron/handleLeak.real.test.ts` | 句柄泄漏专项异常场景 | ✓ VERIFIED | 243 行，5 it（SSH RST / exec stream error / telnet 断连 / 长时间循环累积 5 次 / 混合 timeout+正常），含循环 for 语句（L208）+ mock server close |
| `.github/workflows/build-smoke.yml` | CI-A 扩展（test:electron 挂 rebuild 后） | ✓ VERIFIED (静态) + GHA 实跑 defer | 39 行，含 `npm run test:electron`（L33），step 顺序正确：npm test（L26）< rebuild:native（L28）< test:electron（L33）；verify native binding step（L34-39）。GHA windows-latest 实跑需 push 触发 |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| package.json test:electron | vitest.electron.config.ts | cross-env ELECTRON_RUN_AS_NODE electron.exe vitest.mjs --config | ✓ WIRED | package.json:17 → vitest.electron.config.ts:20，本 verifier 实跑 `npm run test:electron` 成功调起并读 config（22 it 通过） |
| db.real.test.ts | realDb.ts | import { makeRealDb } | ✓ WIRED | db.real.test.ts:import makeRealDb，调 makeRealDb() 拿真实 better-sqlite3 实例跑 CRUD（it1 INSERT/SELECT/UPDATE/DELETE 验） |
| ai.execCommands.real.test.ts | mockSshServer.ts | import startMockSshServer + 真实 ssh2.Client 连 mock 对端 | ✓ WIRED | 真实 `import { Client } from 'ssh2'`（L2）+ startMockSshServer（beforeAll 起）+ executeCommandsOnDevice 走真 Client 连 mock server（A2 checkpoint PASS） |
| ai.execCommands.real.test.ts | handleLeakDetector.ts | expectNoHandleLeak() 注册 afterEach | ✓ WIRED | 调用 expectNoHandleLeak()（grep 6 处含注释/调用），22 it 全绿无泄漏报错佐证 afterEach 生效 |
| telnetExec.real.test.ts | mockTelnetServer.ts | import startMockTelnetServer + 真 telnet-client 连 mock echo | ✓ WIRED | 真实 `import { executeTelnetCommand }` → telnetExec.ts:1 `import { Telnet } from 'telnet-client'` + startMockTelnetServer，telnet IAC 协商实跑 PASS（5 it 全绿） |
| git diff | electron/ | phase gate 兜底验生产零改动 | ✓ WIRED | `git diff --exit-code 687fca1..HEAD -- electron/` exit 0（本 verifier 实跑） |
| build-smoke.yml | package.json test:electron | CI step npm run test:electron 挂 rebuild 后 | ✓ WIRED (静态) | build-smoke.yml:33 `npm run test:electron`，顺序 L26 npm test < L28 rebuild < L33 test:electron。GHA 实跑 defer |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| db.real.test.ts | db 句柄 | makeRealDb() 返回的真实 better-sqlite3 Database | 是（真 .node binding，CRUD 写读验） | ✓ FLOWING |
| ai.execCommands.real.test.ts | results[0].output | executeCommandsOnDevice → 真 ssh2.Client → mockSshServer onExec 回显 | 是（mock server 回显 'Version 1.0-mock'，it1 断言 toContain 验） | ✓ FLOWING |
| arpCollector.real.test.ts | result.entries | collectFromDevice → executeSSH → ARPParser.parse | 是（mockSshServer 回显 ARP 表，parse 出 MAC/IP，it1 断言） | ✓ FLOWING |
| telnetExec.real.test.ts | output | executeTelnetCommand → 真 telnet-client → mockTelnetServer echo | 是（mock echo 回 shellPrompt+命令输出，it1 断言 toContain） | ✓ FLOWING |
| handleLeak.real.test.ts | leaked[] | afterEach getActiveResourcesInfo snapshot 对比 baseline | 是（真 process API，无泄漏时 leaked=[]，22 it 全绿） | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| mock 套件无回归（plain node） | `npm test` | 17 files / 244 tests passed, exit 0 | ✓ PASS |
| 真路径套件经 electron.exe 跑通（SC1+SC2） | `npm run test:electron` | 5 files / 22 tests passed, exit 0, 无 ABI 错 | ✓ PASS |
| main bundle 构建（SC4 外部化清单未破坏） | `npm run build:electron-main` | dist-electron/main.js 1.9mb, exit 0 | ✓ PASS |
| SC4 生产零改动 | `git diff --exit-code 687fca1..HEAD -- electron/` | exit 0 | ✓ PASS |
| 物理隔离（plain node 不采集 tests/electron） | `npm test 2>&1 | grep -c "db.real\|ai.execCommands\|..."` | 0 | ✓ PASS |
| wtfnode 装入 devDep（不进生产打包） | `grep wtfnode package.json` | L53 `"wtfnode": "^0.10.1"` | ✓ PASS |
| 真实 ssh2 import（非 vi.mock） | `grep "from 'ssh2'" ai.execCommands.real.test.ts` | L2 import 真实，无 vi.mock('ssh2')（grep 计数仅匹配注释引用） | ✓ PASS |

### Probe Execution

| Probe | Command | Result | Status |
| --- | --- | --- | --- |
| (无独立 probe-*.sh 脚本，验证经三绿门禁 + git diff 行为 spot-check 完成) | — | — | N/A |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| TEST-01 | 12-01, 12-02 | SSH/Telnet/DB/better-sqlite3 真路径可自动化回归（DEP-1 ABI 缓解） | ✓ SATISFIED | 三绿门禁全绿：test:electron 22 it（DB 3 + SSH ai 5 + arpCollector 4 + Telnet 5 + handleLeak 5）+ npm test 244 + build:electron-main 1.9mb。ABI 缓解落地形式修正为 ELECTRON_RUN_AS_NODE electron.exe 跑 vitest（非 electron-vite，REQUIREMENTS.md TEST-01 已注脚）。DB 真路径经真实 better-sqlite3 prepared statement CRUD + 迁移幂等 + WAL 验；SSH 真路径经真实 ssh2.Client 连 ssh2.Server mock 对端（A2 PASS）；Telnet 真路径经真实 telnet-client 连 mockTelnetServer（IAC 协商 PASS） |
| TEST-02 | 12-02, 12-03 | 句柄泄漏可自动化检测（execOne/executeCommandsOnDevice/executeTelnet/executeSSH 的 try/finally 句柄回收回归） | ✓ SATISFIED (w/ CR-01 质量缺陷) | 四条 cleanup 路径均存在并被测：ai.ts:390-405 + ai.ts:461-469 + arpCollector.ts:33-50 + telnetExec.ts:147-155。handleLeak.real.test.ts 5 异常场景全绿（RST/stream error/telnet 断连/循环累积 5 次/混合 timeout）。CR-01 指出 handleLeakDetector baseline 跨 it 共享缺陷，单 it 检测仍有效（含 it4 单 it 内 5 循环累积），核心网兜目标达成；跨 it 累积准确性属质量债务（建议交 /gsd:code-review --fix） |

REQ 覆盖完整：TEST-01/02 均在至少一 plan 的 `requirements_addressed` 字段声明且实际交付（12-01: TEST-01 / 12-02: TEST-01+TEST-02 / 12-03: TEST-02）。无 orphaned requirement。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| tests/electron/_helpers/handleLeakDetector.ts | 26 | CR-01: baseline 在调用点（describe 顶层）取一次，跨 it 共享（非 beforeEach 各取） | ⚠️ Warning（code review Critical，goal-level 非阻塞） | 单 it 检测有效（22 it 全绿），跨 it 累积场景准确性缺陷；CR 建议改 beforeEach 取基线 |
| tests/electron/_helpers/mockSshServer.ts / mockTelnetServer.ts | 54 / 62 | CR-02: server.on('error')→reject 在 listen resolve 后无效，运行期 error 被吞 | ⚠️ Warning | CI flaky 风险（accept 阶段 error 静默），本地未触发；建议改 once + 运行期 console.error |
| .github/workflows/build-smoke.yml + package.json | 28 / 13 | CR-03: rebuild:native `-w ssh2` 不递归到 cpu-features dependency | ⚠️ Warning（GHA 实跑才显现） | windows-latest 上 ssh2 真路径可能因 cpu-features ABI mismatch 崩；本地跑通（cpu-features 可能未 build 或 ssh2 fallback 纯 JS）；建议 rebuild 加 `-w cpu-features` 或全量 `-f` |
| 多个测试文件 | 多处 | WR-01~WR-07（7 Warning）：port:1 异常路径 flaky / handleIac 越界 / realDb hasColumn 字符串插值 / mockTelnet login 隐式契约 / arpCollector dead MK injection / db.real 二次迁移裸 SQL / handleLeak importActual 嵌套 | ℹ️ Info（quality debt） | 不阻塞 goal；建议交 /gsd:code-review --fix 批量处理 |

**Debt marker gate:** phase 12 全部新增/修改文件 grep TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER/placeholder/not yet implemented = 0 命中。无未引用债务标记。

### Human Verification Required

### 1. GHA windows-latest 实跑 build-smoke workflow（SC2 之 CI 侧）

**Test:** push 到 master 或开 PR（如 `verify/12-03-ci-electron-test`）触发 build-smoke workflow，在 GHA windows-latest runner 上观察 build-windows job 的 test:electron step
**Expected:** test:electron step 退出码 0（22 it 通过）；npm test（rebuild 前，L26）退出码 0（244 通过）；verify native binding step 绿；CI 总时长增量 +30~60s（vs 改前）
**Why human:** GHA workflow 需 push/PR 触发，本地无法直接跑 GitHub Actions（act 工具对 electron.exe 支持有限）。PLAN 12-03 明确将 GHA 实跑列为 defer 项（"本地无法触发 GHA workflow"），三方案 ASSUMED 项（xvfb 不需 / antivirus 误报 / CI 时长）只能在 push 后确认。orchestrator 已确认本地三绿全过 + CI-A YAML 静态验证通过（语法合法 + step 顺序正确 + cross-env 跨平台）。

### 2. ssh2 cpu-features ABI 在 GHA 上的实际行为（CR-03 风险）

**Test:** GHA 实跑时特别关注 test:electron step 是否出现 cpu-features 或 ssh2 native binding 加载错误
**Expected:** test:electron step 不出现 `NODE_MODULE_VERSION` / `was compiled against a different Node.js version` / cpu-features 加载错误
**Why human:** CR-03 指出 `electron-rebuild -f -w better-sqlite3 -w ssh2` 的 `-w ssh2` 不递归重建 ssh2 的可选 dependency `cpu-features`。本地 `npm run rebuild:native && npm run test:electron` 全绿（22 it），但本地环境 cpu-features 可能未 build（ssh2 fallback 纯 JS）或 ABI 恰好匹配，windows-latest runner 行为可能不同。verify step（L34-39）只验 better_sqlite3.node 不验 cpu-features，故 GHA 上 ssh2 真路径是否走真 native binding 只能实跑确认。

### 3. CR-01（handleLeakDetector baseline 跨 it 共享）的网兜有效性判定

**Test:** 评估当前 handleLeakDetector baseline 在 describe 顶层取一次（跨 it 共享）的设计是否满足 SC3「句柄泄漏有自动化网兜」的实际需求
**Expected:** 若未来引入跨多个 it 的真实累积泄漏场景，检测器仍能 fail；或采纳 code review 建议（baseline 移到 beforeEach 各 it 独立取）
**Why human:** 单 it 内泄漏检测（含 it4 单 it 内 5 次循环累积）经本地 22 it 全绿验证有效（leaked = after 中新增且不在 allowDefault 白名单且不在 baseline 的句柄）。CR-01 指出的跨 it 基线共享在当前用例集未触发误报/漏检（allowDefault 已含 vitest 内部漂移句柄类型）。属防御性质量缺陷，是否修复由人定。code review 已标 Critical，建议交 `/gsd:code-review --fix` 处理。

### Gaps Summary

**无 goal-level BLOCKER。** SC1-4 全部经本 verifier 独立实跑验证通过：

- 三绿门禁全绿（npm test 244 / test:electron 22 / build:electron-main 1.9mb），本 verifier 独立实跑确认
- SC4 红线（生产零改动）git diff electron/ exit 0，本 verifier 独立实跑确认
- 四条 cleanup 路径在生产代码中存在且被测试覆盖（TEST-02 核心）
- 真实协议库 import（ssh2/telnet-client 走真 binding 连 mock 对端，非 vi.mock）确认

**3 个 human_needed 项**（非 goal 阻塞，属 defer/质量判定）：
1. GHA windows-latest 实跑（SC2 之 CI 侧 defer，需 push 触发）
2. CR-03 cpu-features ABI 在 GHA 的实际行为（CR-03 风险，GHA 实跑才显现）
3. CR-01 handleLeakDetector baseline 跨 it 共享的网兜有效性判定（防御性质量缺陷，单 it 检测有效，跨 it 累积准确性存疑）

**code review 3 Critical + 7 Warning 是 quality debt（advisory）**，非 goal 未达成：CR-01/CR-02/CR-03 及 WR-01~07 均不阻塞 SC1-4 的达成（自动化通道跑通 + 句柄泄漏有网兜 + 生产零改动），属建议改进项，建议交 `/gsd:code-review --fix` 后续处理。

---

_Verified: 2026-08-08T05:25:00Z_
_Verifier: Claude (gsd-verifier)_
