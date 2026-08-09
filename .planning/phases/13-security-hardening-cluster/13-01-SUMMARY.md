---
phase: 13-security-hardening-cluster
plan: 01
subsystem: security
tags: [ssh, algorithms, electron-test, drift-elimination, curve25519]

# Dependency graph
requires:
  - phase: 12-test-infrastructure-dep-1-abi
    provides: test:electron 真路径通道（cross-env ELECTRON_RUN_AS_NODE=1 electron.exe vitest.mjs）+ mockSshServer/handleLeakDetector helper 契约 + ssh2.Server mock 对端范式
provides:
  - connection.ts connectSSH/testSSHConnection 100% 复用 SSH_ALGORITHMS + SSH_READY_TIMEOUT_MS 常量（全仓 SSH 算法表 drift 根源消除）
  - tests/electron/connectSSH.algorithms.real.test.ts 真路径回归守卫（curve25519-only 对端协商成功/失败双向断言）
  - 设备终端连接补 curve25519-sha256 现代算法（修体检 §1.0 半残留，现代 Linux 可连）
affects: [SEC-03, 设备终端连接, 设备测试连接, Phase 14 缺陷闭环]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - SSH 算法配置单一来源（SSH_ALGORITHMS 常量复用，全仓 4 处 SSH 路径零 drift）
    - 真路径测试用内联 ssh2.Server（algorithms 限制对端算法集）验证 KEX 协商契约（不调 startMockSshServer helper 因不支持自定义对端 algorithms）

key-files:
  created:
    - tests/electron/connectSSH.algorithms.real.test.ts
  modified:
    - electron/services/connection.ts

key-decisions:
  - "D-13-2: connectSSH 删内联 algorithms 表复用 SSH_ALGORITHMS 常量消 drift（补 curve25519 首项 + 全部老算法保留 D-13-1）"
  - "D-13-3: connectSSH readyTimeout 10s → SSH_READY_TIMEOUT_MS(30s) 治同类慢设备超时 drift"
  - "D-13-8: connectSSH 带 BrowserWindow 测试通道无法造真窗口，直接验核心契约 ssh2.Client + algorithms 协商路径（不调 connectSSH 全函数）"
  - "Rule 1 补：testSSHConnection 第二处内联 algorithms 表（plan must_haves 第4条「全仓无第二份算法表」+ 同源 drift 致测试连接现代 Linux 也失败）一并复用 SSH_ALGORITHMS，readyTimeout 8000 保留（测试连接语义不同，希望快速失败反馈）"
  - "Phase 12 既有真路径套件实际 21 it（plan 文档写「22 it」为计数偏差），本 plan +3 = 全套件 24 it 全绿"

patterns-established:
  - "SSH 算法协商真路径测试范式：内联 ssh2.Server({ hostKeys:[随机RSA], algorithms:{ kex:[单一算法] } }) 限制对端算法集 + new ssh2.Client connect + 'ready'/'error' 事件断言，验证 client 侧 algorithms 配置能否与对端协商（不调 startMockSshServer helper）"
  - "drift 危害反向回归守卫：把改造前内联旧表硬编码进测试作为 client.connect algorithms，断言与 curve25519-only 对端协商失败（error），防未来误删 SSH_ALGORITHMS 回退内联表"

requirements-completed: [SEC-03]

# Metrics
duration: 6min
completed: 2026-08-09
---

# Phase 13 Plan 01: SEC-03 SSH Algorithm Drift Elimination Summary

**connection.ts connectSSH/testSSHConnection 删内联 algorithms 表全量复用 SSH_ALGORITHMS 常量（补 curve25519-sha256 现代算法 + 全部老算法保留 D-13-1），readyTimeout 对齐 SSH_READY_TIMEOUT_MS(30s)；真路径回归守卫锁定 curve25519-only 对端协商成功/失败双向断言。**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-08-09T11:10:55Z
- **Completed:** 2026-08-09T11:16:32Z
- **Tasks:** 2
- **Files modified:** 1（connection.ts）+ 1 新增（connectSSH.algorithms.real.test.ts）

## Accomplishments
- connection.ts connectSSH 删 36 行内联 algorithms 表，改 `algorithms: SSH_ALGORITHMS,` 单行复用（D-13-2），补 curve25519-sha256 首项（修体检 §1.0 半残留——终端连接现代 Linux 失败的根因），全部老算法经 SSH_ALGORITHMS 常量保留（D-13-1 兼容老设备）
- connection.ts connectSSH `readyTimeout: 10000` → `SSH_READY_TIMEOUT_MS`(30s)（D-13-3，治同类慢设备超时 drift：ai/arpCollector 已 30s，终端仍 10s 是同 drift 未治完）
- connection.ts testSSHConnection 第二处内联 algorithms 表一并复用 SSH_ALGORITHMS（Rule 1 补，同源 drift）
- 全仓 SSH 算法表 drift 根源消除：ai.ts buildSSHConfig / arpCollector.ts executeSSH / connection.ts connectSSH + testSSHConnection 四处生产路径全走 SSH_ALGORITHMS 常量，无第二份算法表
- 新增 tests/electron/connectSSH.algorithms.real.test.ts 真路径回归 3 it：常量首项断言 + curve25519-only 协商成功（SEC-03 修复守卫）+ 内联旧表协商失败（drift 危害反向回归守卫）
- 三绿门禁全绿：tsc web strict + build:electron-main + test:electron 24/24 + npm test 244/244 零回归

## Task Commits

1. **Task 1: connectSSH/testSSHConnection 删内联 algorithms 表复用 SSH_ALGORITHMS + readyTimeout 对齐** - `c19c9f1` (fix)
2. **Task 2: connectSSH 算法协商真路径回归测试** - `df0a0fc` (test)

## Files Created/Modified
- `electron/services/connection.ts` - connectSSH + testSSHConnection 删内联 algorithms 表复用 SSH_ALGORITHMS 常量；connectSSH readyTimeout 对齐 SSH_READY_TIMEOUT_MS(30s)；顶部 import SSH_ALGORITHMS/SSH_READY_TIMEOUT_MS；密钥/密码分支与 BrowserWindow 逻辑保留不动
- `tests/electron/connectSSH.algorithms.real.test.ts` - 新增真路径回归 3 it：SSH_ALGORITHMS kex 首项 curve25519 断言 + SSH_ALGORITHMS 协商成功 + 内联旧表协商失败；内联 ssh2.Server（curve25519-only 对端）不调 startMockSshServer helper；每 it expectNoHandleLeak()

## Decisions Made
- **D-13-2 落地**：connectSSH 删内联 algorithms 表（kex 首项 ecdh-sha2-nistp256 缺 curve25519 + serverHostKey 顺序异于 SSH_ALGORITHMS）改 SSH_ALGORITHMS 单行，彻底消除两份表 drift 根源（这次终端缺 curve25519 正是 drift 导致）
- **D-13-3 落地**：connectSSH readyTimeout 10s → SSH_READY_TIMEOUT_MS(30s)，顺带治同类慢设备超时 drift（ai/arpCollector 已 30s，终端仍 10s）
- **D-13-1 落地**：SSH_ALGORITHMS 常量保留全部兼容算法（group1-sha1/group14-sha1/3des-cbc/blowfish-cbc/ssh-dss 等），connectSSH 复用即同时拿到 curve25519（补）+ 全部老算法（保留），L1 删弱算法显式 defer（threat_model T-13-01-02 accept）
- **D-13-8 落地**：connectSSH 带 BrowserWindow 参数，测试通道（ELECTRON_RUN_AS_NODE Electron app 未 ready）无法造真 BrowserWindow，故不调 connectSSH 全函数，直接验核心契约——new ssh2.Client 用 { algorithms: SSH_ALGORITHMS } 与 curve25519-only 对端协商触发 'ready'，绕开 BrowserWindow 同时 100% 覆盖算法协商路径
- **测试不调 startMockSshServer helper**：helper 不支持自定义对端 algorithms，本测试需对端仅暴露 curve25519-sha256，故直接内联 `new Server({ hostKeys, algorithms: { kex: ['curve25519-sha256'] } })`（照抄 mockSshServer.ts:34-52 结构 + algorithms 限制）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] testSSHConnection 第二处内联 algorithms 表同源 drift 未消**
- **Found during:** Task 1（grep 验证发现 connection.ts:278-282 还有第二处内联 algorithms 表）
- **Issue:** plan 只点名 connectSSH:115-150 的内联表，但 connection.ts 第 249-292 行的 `testSSHConnection`（设备添加/编辑前的「测试连接」功能）也用同一份内联 algorithms 表（kex 同样首项 ecdh-sha2-nistp256 缺 curve25519）。这是 plan must_haves 第 4 条「全仓 3 处 SSH 路径无第二份算法表」与 acceptance_criteria「全仓 SSH 算法表 drift 消除」未覆盖到的第 4 处。功能影响：用户测试连接现代 Linux 设备时同样会因缺 curve25519 而 KEX 失败（与 connectSSH 同根因），不修则 SEC-03「设备终端连接补现代算法」目标在测试连接路径上仍有漏洞。
- **Fix:** testSSHConnection 内联 algorithms 表同样替换为 `algorithms: SSH_ALGORITHMS,` 单行。`readyTimeout: 8000` 保留不动——测试连接语义不同于终端会话（测试希望快速失败给用户反馈，8s 是合理的短超时），仅 algorithms 复用消 drift，不强制复用 timeout（呼应 D-13-2/D-13-3 的「algorithms 与 timeout 各自决策」原则）。
- **Files modified:** electron/services/connection.ts（testSSHConnection:278-282）
- **Verification:** grep `algorithms:\s*\{[\s\S]*?kex:` 全仓 connection.ts 命中 0；`algorithms:\s+SSH_ALGORITHMS,` 命中 2（connectSSH + testSSHConnection）；tsc web + build:electron-main + test:electron + npm test 全绿
- **Committed in:** c19c9f1（Task 1 同一 commit）

---

**Total deviations:** 1 auto-fixed（1 Rule 1 bug）
**Impact on plan:** 补修同源 drift 让 SEC-03「设备连接补现代算法」目标在终端 + 测试连接两条路径上完整闭环。无 scope creep——testSSHConnection 改动是 plan 显式目标（must_haves 第 4 条「全仓无第二份算法表」）的必要延伸，非新增功能。

## Issues Encountered
- **plan 文档「Phase 12 既有 22 it」与实际 21 it 计数偏差**：plan acceptance_criteria 写「Phase 12 既有 22 it + 本 plan 3 it = 25 it」，但本地实跑 test:electron 全套件为 24 it（Phase 12 既有 21 + 本 plan 3）。原因是 plan 撰写时基于某个中间计数，不影响 SEC-03 目标达成——24/24 全绿零回归，本 plan 新增 3 it 全绿。SUMMARY 如实记录为 24 it。

## User Setup Required
None - 无外部服务配置需求。

## Next Phase Readiness
- SEC-03 完整闭环：connection.ts 终端 + 测试连接两条 SSH 路径全走 SSH_ALGORITHMS 常量，drift 根源消除，现代 Linux 可连
- 三绿门禁全绿（tsc web + build:electron-main + test:electron 24/24 + npm test 244/244），SC4 三红线（IPC secure/safe / 字段加密 _enc / commandSafety）改动后仍生效（SEC-03 仅改算法常量复用，不碰鉴权/加密/命令安全层）
- Phase 13 后续 plan（13-02 SEC-04 / 13-03 SEC-05）可独立并行（depends_on: []）

---
*Phase: 13-security-hardening-cluster*
*Plan: 01 (SEC-03)*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: electron/services/connection.ts（Task 1 改动）
- FOUND: tests/electron/connectSSH.algorithms.real.test.ts（Task 2 新增）
- FOUND: .planning/phases/13-security-hardening-cluster/13-01-SUMMARY.md
- FOUND: c19c9f1（Task 1 commit）
- FOUND: df0a0fc（Task 2 commit）
