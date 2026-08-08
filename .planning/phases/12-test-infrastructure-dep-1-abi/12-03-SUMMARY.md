---
phase: 12-test-infrastructure-dep-1-abi
plan: 03
subsystem: testing
tags: [vitest, electron, electron-run-as-node, ssh2, telnet-client, leak-detection, github-actions, ci, handle-leak, exception-cleanup]

# Dependency graph
requires:
  - phase: 12-test-infrastructure-dep-1-abi (plan 01)
    provides: test:electron 通道 + handleLeakDetector（默认白名单含 native stream 句柄类型）+ mockSshServer/mockTelnetServer 契约
  - phase: 12-test-infrastructure-dep-1-abi (plan 02)
    provides: SSH/Telnet 真路径回归 + handleLeakDetector 默认白名单反馈环（TCPServerWrap/TCPWrap/SimpleWriteWrap）
provides:
  - tests/electron/handleLeak.real.test.ts（句柄泄漏专项异常场景 5 it：SSH RST / exec stream error / telnet 断连 / 长时间循环累积 / 混合 timeout+正常）
  - .github/workflows/build-smoke.yml CI-A 重排（mock 套件移 rebuild 前 + test:electron 挂 rebuild 后）
affects: [TEST-02, Phase 6 SC#4, Phase 3 长时间运行 defer, Phase 12 SC1-4 全闭合]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CI-A 分段方案：mock 套件（plain node）放 rebuild:native 之前避免 ABI 崩，真路径套件（electron.exe）放 rebuild 之后，CI 锁两条回归网"
    - "ELECTRON_RUN_AS_NODE 在 GHA windows-latest 跑 electron.exe（RUN_AS_NODE 模式不走 Chromium 故不需 xvfb/--no-sandbox，语义推断 GHA 实跑 defer）"
    - "句柄泄漏专项异常场景构造：mock 对端 stream.destroy()/socket.end() 模拟 RST/EOF + 裸 net.Server 模拟 timeout + 循环 N 次验累积泄漏（Phase 3 长时间运行 defer 闭合）"

key-files:
  created:
    - tests/electron/handleLeak.real.test.ts
  modified:
    - .github/workflows/build-smoke.yml

key-decisions:
  - "CI 方案最终选择 CI-A（mock 与真路径分段）—— 用户 plan review 决策，RESEARCH 推荐：mock 套件保留 plain node 秒级 + 真路径套件进 CI 锁回归，时长代价 +30-60s 可接受"
  - "CI-A step 重排：npm ci → npm test（移前，plain node mock 244）→ rebuild:native → build → test:electron（新增，electron.exe 真路径 22 it）→ verify native binding —— npm test 必须在 rebuild 前（否则 plain node 跑 electron-ABI binding ABI 崩 DEP-1），test:electron 必须在 rebuild 后（需 electron-ABI binding）"
  - "GHA windows-latest 实跑 defer —— 本地无法触发 GHA workflow，静态验证（YAML 语法 + step 顺序逻辑 + cross-env 跨平台）通过，RESEARCH 三个 ASSUMED（xvfb 不需 / antivirus 误报 / CI 时长增量）记 defer 项待 push 实跑确认"
  - "A4 wtfnode.dump 未触发 —— handleLeak.real.test 5 it 全绿无泄漏，wtfnode dump 路径未执行（A4 best-effort 容错 .catch(() => null) 维持，dump 调用栈定位限制仍存但不影响主检测 getActiveResourcesInfo snapshot 对比）"
  - "句柄专项覆盖 Phase 3 长时间运行 defer —— it 4 循环 N=5 次连 mockSshServer 验累积 TCPWrap 不泄漏，闭合 Phase 3 长时间运行场景的人工 HV defer 项"

requirements-completed: [TEST-02]

# Metrics
duration: ~95s（本 continuation 仅 Task 3 CI-A 落地；Task 1 句柄专项 ~见 12-03-PLAN 已提交 d8a8d34）
completed: 2026-08-08
---

# Phase 12 Plan 03: 句柄泄漏专项 + CI 扩展 Summary

**句柄泄漏专项测试落地 5 个异常场景（SSH RST / exec stream error / telnet 断连 / 长时间循环累积 5 次 / 混合 timeout+正常，闭合 Phase 3 长时间运行 defer + Phase 6 SC#4）+ build-smoke.yml CI 扩展按用户选定 CI-A 方案落地（mock 套件移 rebuild 前 + test:electron 挂 rebuild 后，CI 锁两条回归网），零生产代码改动（SC4）**

## Performance

- **Duration:** 本 continuation ~95s（Task 3 CI-A 落地）；Task 1（句柄专项）+ Task 2（CI 决策 checkpoint）由前置 wave 完成
- **Started:** 2026-08-08T04:31:44Z（本 continuation）
- **Completed:** 2026-08-08T04:39:59Z
- **Tasks:** 3（Task 1 句柄专项 auto + Task 2 CI 决策 checkpoint + Task 3 CI-A 落地 auto）
- **Files modified:** 1（本 continuation：build-smoke.yml）；Task 1 新增 1（handleLeak.real.test.ts）

## Accomplishments

- **TEST-02 句柄泄漏专项覆盖异常场景**：handleLeak.real.test.ts 5 it 全绿，覆盖四类异常 + 长时间运行 defer：
  - it 1（对端 RST —— SSH）：mockSshServer onExec 调 stream.destroy() 模拟 RST，验 executeCommandsOnDevice cleanup（client.end + clearTimeout perCmdTimer）
  - it 2（stream error —— execOne）：mockSshServer 触发 stream 'error' 事件，验 execOne cleanup（stream.close + stream.destroy + clearTimeout timer/silenceTimer）
  - it 3（telnet 对端 EOF / 断连）：mockTelnetServer socket.end() 模拟断连，验 executeTelnetCommand finally cleanup（connection.end/destroy）
  - it 4（长时间运行循环累积）：循环 N=5 次连 mockSshServer 跑短命令，验每次 cleanup 后无累积 TCPWrap（Phase 3 长时间运行 defer 闭合）
  - it 5（混合 timeout + 正常）：先跑短 timeout 触发 cleanup 再跑正常连接，验 timeout 路径 destroy 不影响后续连接句柄干净
- **Phase 6 SC#4 + Phase 3 长时间运行 defer 项闭合**：句柄泄漏专项自动化检测替代人工 HV（CONTEXT decision #4），可标 resolved
- **CI-A 落地**：build-smoke.yml 重排 step 顺序 + 新增 test:electron step，CI 锁两条回归网（mock 套件 plain node + 真路径套件 electron.exe），SC2「CI/本地绿」精神达成
- **SC4 兜底达成**：`git diff --exit-code electron/` 退出码 0（CI 配置改动非生产代码）
- **三绿门禁全绿**（前置 wave + 本 continuation 验证）：test:electron 22/22（db.real 3 + ai 5 + arpCollector 4 + telnetExec 5 + handleLeak.real 5）+ npm test 244/244 + build:electron-main esbuild OK
- **GHA 静态验证通过**：YAML 语法合法（python yaml.safe_load 解析 OK，8 steps）+ step 顺序逻辑正确（npm test 行 26 < rebuild:native 行 28 < test:electron 行 33）+ cross-env ELECTRON_RUN_AS_NODE 跨平台兼容

## Task Commits

每个 task 原子提交：

1. **Task 1: 句柄泄漏专项测试（异常场景 cleanup 集中验证）** - `d8a8d34` (feat) [前置 wave]
2. **Task 2: CI 扩展方案决策 checkpoint** - STATE 同步 `bbdbe6d` (docs) [前置 wave]，用户 plan review 选定 **CI-A**
3. **Task 3: build-smoke.yml CI-A 落地（mock 移 rebuild 前 + test:electron 挂 rebuild 后）** - `98d8aca` (feat) [本 continuation]

## Files Created/Modified

- `tests/electron/handleLeak.real.test.ts`（新增，Task 1）— 句柄泄漏专项 5 it（SSH RST + exec stream error + telnet 断连 + 循环累积 + 混合 timeout），复用 12-01/12-02 helper 契约（mockSshServer/mockTelnetServer/handleLeakDetector），vi.mock 非被测重依赖让 service 干净加载
- `.github/workflows/build-smoke.yml`（修改，Task 3）— CI-A 重排：npm test 移 rebuild:native 之前（L24-26）+ 新增 npm run test:electron step 挂 rebuild + build 之后（L30-33），含注释说明 CI-A 分段语义 + DEP-1 隐患规避

## Decisions Made

- **CI 方案 CI-A 选定（用户 plan review）**：三方案（CI-A 推荐 / CI-B 全量 electron.exe / CI-C 只本地跑）用户选 CI-A。mock 套件保留 plain node 秒级（244 用例不改变运行环境），真路径套件进 CI 锁回归，时长代价 +30-60s 可接受。CI-B 改变 mock 套件运行环境（潜在 vi.mock 行为差异）+ CI-C 违背 SC2「CI/本地绿」精神均否决。
- **CI-A step 重排逻辑**：`npm ci → npm test（移前）→ rebuild:native → build → test:electron（新增）→ verify native binding`。关键约束：npm test 必须在 rebuild:native **之前**（plain node 跑 mock 套件不碰 native binding，避免 rebuild 后 ABI 崩 DEP-1 隐患，RESEARCH Pitfall）；test:electron 必须在 rebuild:native + build **之后**（需 electron-ABI native binding + dist-electron/main.js 产物）。
- **GHA windows-latest 可行性语义推断**：ELECTRON_RUN_AS_NODE=1 让 electron.exe 当 Node 跑不起 BrowserWindow，故不需 xvfb（Linux 才需 X server 跑 GUI）+ 不需 --no-sandbox（Chromium 概念，RUN_AS_NODE 不走 Chromium）。cross-env 已在 package.json devDep 跨平台设 ELECTRON_RUN_AS_NODE=1，windows-latest runner 跑 electron.exe 直接可用。
- **A4 wtfnode.dump 未触发**：handleLeak.real.test 5 it 全绿无句柄泄漏，wtfnode dump 路径未执行。A4 best-effort 容错（.catch(() => null)）维持。12-02 SUMMARY 记录的 wtfnode callsite 定位限制（vitest 进程内动态 import 报 `Unable to determine callsite`）仍存，但不影响主检测逻辑（getActiveResourcesInfo snapshot 对比）。

## Deviations from Plan

### Auto-fixed Issues

无（本 continuation Task 3 落地零偏差，CI-A 重排严格按 plan action + RESEARCH 推荐挂法执行）。

---

**Total deviations:** 0（Task 3 CI-A 落地零偏差；Task 1 偏差见 d8a8d34 commit 前置 wave）

## GHA 实跑 Deferral（关键 defer 项）

本 plan 改完 build-smoke.yml 后，GHA windows-latest 实跑需 push 到 master 分支或 PR 触发 workflow（本地无法直接跑 GHA）。本 continuation 完成的本地静态验证：

1. **YAML 语法验证通过**：`python -c "import yaml; yaml.safe_load(open('.github/workflows/build-smoke.yml'))"` 解析 OK，8 steps 结构合法
2. **step 顺序逻辑 review**：npm test（L26）在 rebuild:native（L28）之前 ✓ / test:electron（L33）在 rebuild（L28）+ build（L29-）之后 ✓
3. **cross-env ELECTRON_RUN_AS_NODE 跨平台兼容性**：package.json test:electron script 已用 cross-env（devDep 已装），windows-latest runner 兼容性静态判断 OK

**ASSUMED 项（GHA 实跑才能确认，记 defer）：**

| Assumption | 来源 | 语义推断 | GHA 实跑验证方式 |
|------------|------|----------|------------------|
| ELECTRON_RUN_AS_NODE 不需 xvfb/--no-sandbox | RESEARCH §CI 扩展 + Assumptions Log | RUN_AS_NODE 模式不走 Chromium 故不需 | push 后看 test:electron step 是否退出码 0 |
| CI 时长增量 +30-60s | RESEARCH §CI 扩展 | 真路径套件 22 it 网络操作（mock 对端 loopback） | push 后对比改前改后 CI 总时长 |
| antivirus 误报 electron.exe | RESEARCH §CI 扩展 + T-12-09 | GHA runner 已知案例 | push 后观察 test:electron step 是否被 Defender 拦截，若拦截加 Set-ExecutionPolicy 或路径白名单 |

**用户 push 指引（下次 push 到 master 或开 PR 时触发 GHA 实跑）：**

```bash
# push 到 master 触发 build-smoke workflow
git push origin master

# 或开 PR 触发（推荐，先验 GHA 再合）
git checkout -b verify/12-03-ci-electron-test
git push -u origin verify/12-03-ci-electron-test
# 在 GitHub 开 PR，观察 build-smoke / build-windows job 的 test:electron step
```

**若 GHA 实跑失败的处理路径（PLAN acceptance_criteria 已预判）：**

- 若 `test:electron` step 报 xvfb/Chromium 相关错误 → 检查 ELECTRON_RUN_AS_NODE 是否正确设置（cross-env 在 windows-latest 的行为），可能需调 script 或加 env 显式注入
- 若 antivirus 拦截 electron.exe → 加 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` 或路径白名单（RESEARCH T-12-09 已识别）
- 若 mock 套件 step（npm test）在 rebuild 前仍报 ABI 崩 → 说明 12-01 Pitfall 6 物理隔离（vitest.config.ts exclude tests/electron/**）在 GHA 环境下未生效，回查 vitest config 采集范围
- 若以上均无法解决 → 回 Task 2 重新决策退 CI-C（test:electron 只本地跑，CI 暂不挂，记 SUMMARY 暴露 GHA 局限）

## Checkpoint 结论汇总

- **Task 2 CI 决策 checkpoint**：**RESOLVED** — 用户 plan review 选定 **CI-A**（mock 与真路径分段，RESEARCH 推荐），Task 3 据此落地
- **A4（wtfnode 在 ELECTRON_RUN_AS_NODE 下 async_hooks）**：本 plan 未触发 dump 路径（5 it 全绿无泄漏），A4 best-effort 容错维持，dump 调用栈定位限制（vitest 进程内 callsite）仍存但不影响主检测 —— **可标 partial-resolved**（容错生效 + 主检测可靠，dump 精确诊断待未来需要时评估 wtfnode top-level require）
- **GHA windows-latest 可行性（RESEARCH §CI 扩展 ASSUMED）**：本地静态验证通过（YAML 语法 + step 逻辑 + cross-env 兼容），实跑 defer 到下次 push（见上节 GHA 实跑 Deferral）

## Issues Encountered

- **GHA 本地不可跑**：GitHub Actions workflow 需 push/PR 触发，本地无 `act` 工具模拟（act 对 electron.exe 支持有限）。本 plan 通过静态验证（YAML 语法 + step 顺序逻辑 + 跨平台语义）+ 明确记 defer 项给用户 push 实跑确认，未假装 GHA 实跑。

## User Setup Required

None — 无外部服务配置（CI workflow 改动自包含，test:electron 通道 12-01 已落地）。GHA 实跑属 push 触发项，用户下次 push 到 master 或开 PR 时自动触发验证。

## Next Phase Readiness

- **Phase 12 全部 SC + REQ 覆盖完毕**：
  - SC1（test:electron 通道加载 electron-ABI native binding）— 12-01 落地
  - SC2（CI/本地绿）— 12-01 DB 真路径 + 12-02 SSH/Telnet 真路径 + 12-03 句柄专项 + CI-A 扩展，三绿门禁全绿
  - SC3（句柄泄漏自动化替代 Phase 6 SC#4 + Phase 3 defer 人工 HV）— 12-02 四条 cleanup 路径 + 12-03 异常场景专项
  - SC4（生产代码零改动）— 三 plan 全程 git diff electron/ exit 0
  - TEST-01（DB 真路径）— 12-01 覆盖
  - TEST-02（句柄泄漏检测）— 12-02 + 12-03 覆盖
- **Phase 6 SC#4 + Phase 3 长时间运行 defer 项可标 resolved**（CONTEXT decision #4 闭合）
- **GHA 真路径回归网进 CI**（CI-A 落地，待 push 实跑确认 ASSUMED 项）
- **无阻塞**：三绿门禁全绿，SC4 兜底通过，零生产代码改动，零回归

## Phase 12 三 Plan 全貌

| Plan | 主题 | Commits | 关键产出 |
|------|------|---------|----------|
| 12-01 | 测试基础设施主干（DEP-1 ABI 缓解） | aea9154 / 3022350 / dae9f18 | test:electron 通道 + 双 vitest config + 4 helper 契约 + db.real 真路径 + wtfnode devDep |
| 12-02 | SSH/Telnet 真路径回归 | 37f5cca / 40f13e5 | ai/arpCollector/telnetExec 真路径 14 it + A2/telnet IAC checkpoint PASS + handleLeakDetector 默认白名单反馈环 |
| 12-03 | 句柄泄漏专项 + CI 扩展 | d8a8d34 / bbdbe6d / 98d8aca | handleLeak.real 异常场景 5 it + CI-A 重排 build-smoke.yml |

---
*Phase: 12-test-infrastructure-dep-1-abi*
*Plan: 03*
*Completed: 2026-08-08*

## Self-Check: PASSED

**Files exist:**
- FOUND: .planning/phases/12-test-infrastructure-dep-1-abi/12-03-SUMMARY.md
- FOUND: tests/electron/handleLeak.real.test.ts
- FOUND: .github/workflows/build-smoke.yml

**Commits exist:**
- FOUND: d8a8d34（Task 1 句柄专项）
- FOUND: bbdbe6d（Task 2 STATE 同步 checkpoint）
- FOUND: 98d8aca（Task 3 CI-A 落地）
