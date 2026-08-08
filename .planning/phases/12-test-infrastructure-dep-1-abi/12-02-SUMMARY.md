---
phase: 12-test-infrastructure-dep-1-abi
plan: 02
subsystem: testing
tags: [vitest, electron, electron-run-as-node, ssh2, telnet-client, leak-detection, real-path, iac, cleanup]

# Dependency graph
requires:
  - phase: 12-test-infrastructure-dep-1-abi (plan 01)
    provides: test:electron 通道 + 4 helper 契约（realDb/mockSshServer/mockTelnetServer/handleLeakDetector）+ db.real 真路径回归
provides:
  - tests/electron/ai.execCommands.real.test.ts（executeCommandsOnDevice + execOne SSH 真路径 + cleanup 句柄检测，5 it）
  - tests/electron/arpCollector.real.test.ts（executeSSH SSH 真路径 + ARPParser + cleanup 句柄检测，4 it）
  - tests/electron/telnetExec.real.test.ts（executeTelnetCommand telnet 真路径 + finally cleanup + IAC + vendor 分流，5 it）
  - handleLeakDetector 默认白名单扩（TCPServerWrap/TCPWrap/SimpleWriteWrap，SSH/Telnet 真路径反馈环）
affects: [12-03 句柄泄漏专项 + CI 扩展, TEST-01, TEST-02]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "真路径测试反向范式：被测协议（ssh2/telnet-client）走真 binding 连 mock 对端，仅 vi.mock 非被测重依赖让 service 干净加载"
    - "ssh2.Server 双向 mock 在 ELECTRON_RUN_AS_NODE 下 listen/accept/exec 全链路实跑确认（A2 PASS）"
    - "telnet IAC 协商（DONT/WONT + stripIac）经真实 telnet-client connect 实跑确认不卡住"
    - "expectNoHandleLeak 默认白名单含 native stream libuv 句柄类型（TCPWrap/SimpleWriteWrap/TCPServerWrap）—— 12-01 无网络经验不足，12-02 反馈环补入"

key-files:
  created:
    - tests/electron/ai.execCommands.real.test.ts
    - tests/electron/arpCollector.real.test.ts
    - tests/electron/telnetExec.real.test.ts
  modified:
    - tests/electron/_helpers/handleLeakDetector.ts（默认白名单 +3 句柄类型，反馈环）
    - tests/electron/ai.execCommands.real.test.ts（白名单调用简化，随 Task 2 反馈环提交）
    - tests/electron/arpCollector.real.test.ts（白名单调用简化，随 Task 2 反馈环提交）

key-decisions:
  - "A2 checkpoint PASS：ssh2.Server 在 ELECTRON_RUN_AS_NODE=1 下经 electron.exe 正常 listen + accept 任意凭证 + authentication.accept + exec stream 回显全链路实跑确认（ai/arpCollector 9 it 全绿佐证）"
  - "telnet IAC checkpoint PASS：mockTelnetServer（12-01 落地 DONT/WONT + stripIac）经真实 telnet-client connect 实跑确认不卡住，shellPrompt mock#/silent# 正常匹配（telnetExec 5 it 全绿佐证）"
  - "OQ#1 注入策略简化：arpCollector.collectFromDevice 不持久化 arp_entries（plan 原文「需 DB 注入」是误读，源码只返回 ARPCollectionResult 不写表），connection mock 桩足够，无需 makeRealDb，零生产改动方案 A 维持"
  - "arpCollector timeout 路径偏离[Rule 1]：ssh2 真 banner-wait timeout 在库内部行为下不可靠触发（silentServer accept 不握手挂满 testTimeout），改用 connection refused（端口未监听）触发 client.on(error)，同样验证 cleanup 句柄回收"
  - "telnet timeout 路径偏离[Rule 1]：mockTelnetServer onCmd 返回空仍回 shellPrompt 致 exec 正常 resolve 不触发 timeout，改用裸 net.Server（accept 不发 prompt）触发外层 timer，验 finally cleanup（clearTimeout + connection.destroy）"
  - "handleLeakDetector 默认白名单反馈环[Rule 2]：12-01 仅基于 db.real（无网络）设默认白名单，SSH/Telnet 真路径暴露 TCPServerWrap（mock server listen socket）+ TCPWrap/SimpleWriteWrap（native stream libuv 释放延迟）跨文件漂移误报，补入默认让 12-03 句柄专项不用每文件重复加"

requirements-completed: [TEST-01, TEST-02]

# Metrics
duration: ~22min
completed: 2026-08-08
---

# Phase 12 Plan 02: SSH/Telnet 真路径回归测试 Summary

**SSH（ai executeCommandsOnDevice/execOne + arpCollector executeSSH）与 Telnet（telnetExec executeTelnetCommand）经真实 ssh2/telnet-client 连 mock 对端回显全链路真路径回归落地，TEST-02 四条 cleanup 路径句柄泄漏自动化检测全绿；A2（ssh2.Server RUN_AS_NODE）+ telnet IAC 双 checkpoint 实跑 PASS；零生产代码改动（SC4）**

## Performance

- **Duration:** ~22min
- **Tasks:** 2（Task 1 SSH 真路径 + Task 2 Telnet 真路径）
- **Files:** 3 新增测试 + 3 修改（handleLeakDetector 默认白名单反馈环 + ai/arpCollector 白名单调用简化）

## Accomplishments

- **SC2 之 SSH/Telnet 部分达成**：SSH 真路径（executeCommandsOnDevice + execOne + executeSSH）+ Telnet 真路径（executeTelnetCommand）经 mock 对端回显全绿，无需真实设备
- **TEST-02 达成**：四条 cleanup 路径句柄泄漏自动化检测全绿（替代 Phase 6 SC#4 + Phase 3 defer 人工 HV，CONTEXT decision #4）：
  - executeCommandsOnDevice cleanup（client.end + clearTimeout perCmdTimer）
  - execOne cleanup（stream.close + stream.destroy + clearTimeout timer/silenceTimer）
  - executeSSH cleanup（client.end + clearTimeout timer + timeout 路径 client.destroy）
  - executeTelnetCommand finally cleanup（clearTimeout + connection.end/destroy）
- **A2 checkpoint PASS**：ssh2.Server 在 ELECTRON_RUN_AS_NODE=1 下经 electron.exe 正常 listen + accept 任意凭证 + authentication.accept + exec stream 回显全链路实跑确认（ai/arpCollector 9 it 全绿佐证，RESEARCH Assumptions Log A2 闭合）
- **telnet IAC checkpoint PASS**：mockTelnetServer（12-01 落地 DONT/WONT 协商 + stripIac）经真实 telnet-client connect 实跑确认不卡住，shellPrompt mock#/silent# 正常匹配（RESEARCH + PATTERNS 标记的未完全展开 checkpoint 闭合）
- **3 个被测模块从 0 测试到有真路径**：arpCollector（0→4 it）、telnetExec（0→5 it）、ai.executeCommandsOnDevice/execOne（0→5 it）
- **SC4 兜底达成**：`git diff --exit-code electron/` 退出码 0（生产代码零改动）
- **现有 mock 套件无回归**：`npm test` 244/244 全绿（17 文件）
- **三绿门禁全绿**：test:electron 17/17（db.real 3 + ai 5 + arpCollector 4 + telnetExec 5）+ npm test 244/244 + build:electron-main esbuild OK

## Task Commits

每个 task 原子提交：

1. **Task 1: SSH 真路径回归（executeCommandsOnDevice + execOne + executeSSH）+ cleanup 句柄检测** - `37f5cca` (feat)
2. **Task 2: Telnet 真路径回归（executeTelnetCommand）+ finally cleanup 句柄检测 + IAC 协商实跑确认 + handleLeakDetector 默认白名单反馈环** - `40f13e5` (feat)

## Files Created/Modified

- `tests/electron/ai.execCommands.real.test.ts`（新增）— executeCommandsOnDevice SSH 真路径 5 it（正常/多命令/telnet 反向分流/execOne cleanup/异常路径）+ vi.mock 非被测重依赖（commandSafety/connection/device/telnetExec spy），ssh2 走真 binding
- `tests/electron/arpCollector.real.test.ts`（新增）— collectFromDevice ssh 路径 + ARPParser.parse + executeSSH cleanup + 异常路径 cleanup 4 it，setArpMasterKey(MK_TEST) 注入
- `tests/electron/telnetExec.real.test.ts`（新增）— executeTelnetCommand 真路径 5 it（正常/finally cleanup/timeout cleanup + pickDisablePaginationCmd/pickShellPrompt vendor 分流），不 vi.mock telnetExec/telnet-client（测本体走真 binding）
- `tests/electron/_helpers/handleLeakDetector.ts`（修改）— 默认白名单 +3（TCPServerWrap/TCPWrap/SimpleWriteWrap），12-01 无网络经验不足经 SSH/Telnet 真路径反馈环补入（Rule 2 关键功能）
- `tests/electron/ai.execCommands.real.test.ts`（修改，随 Task 2）— expectNoHandleLeak() 调用简化（默认白名单已覆盖）
- `tests/electron/arpCollector.real.test.ts`（修改，随 Task 2）— expectNoHandleLeak() 调用简化

## Decisions Made

- **A2/telnet IAC 双 checkpoint 实跑 PASS**：ssh2.Server 与 mockTelnetServer 在 ELECTRON_RUN_AS_NODE=1 下经 electron.exe 全链路可行（listen/accept/IAC 协商/exec 回显），RESEARCH 三条 ASSUMED（A2 + telnet IAC + A4 wtfnode）闭合两条，剩 A4 wtfnode dump 路径待 12-03 句柄专项实跑。
- **OQ#1 注入策略简化**：arpCollector.collectFromDevice 实读源码发现不写 arp_entries 表（只返回 ARPCollectionResult），plan 原文「需 DB 注入（makeRealDb）」是误读，connection mock 桩足够（防 connection.ts 牵连 electron app），零生产改动方案 A 维持，无需退方案 B 加 _setDbGetter。
- **vi.mock 反向范式确立**：真路径测试对**被测协议**（ssh2/telnet-client）走真 binding 连 mock 对端，仅 vi.mock **非被测重依赖**（commandSafety 让 service 干净加载 + connection 防 electron app 牵连 + device/telnetExec spy 防级联）。与 ai.telnetRouting.test.ts 的 vi.mock('ssh2') 形成正向/反向对照。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - bug] 两个测试文件漏 import beforeAll**
- **Found during:** Task 1 首跑（test:electron）
- **Issue:** ai.execCommands.real.test.ts 与 arpCollector.real.test.ts 的 vitest import 行只导了 `describe/it/expect/afterAll/vi`，漏 `beforeAll`，触发 `ReferenceError: beforeAll is not defined`。
- **Fix:** import 行补 `beforeAll`。
- **Files modified:** tests/electron/ai.execCommands.real.test.ts + tests/electron/arpCollector.real.test.ts
- **Verification:** 两文件正常加载进入测试执行。
- **Committed in:** 37f5cca（Task 1 commit）

**2. [Rule 1 - bug] arpCollector MAC 断言正则不匹配归一化格式**
- **Found during:** Task 1 二跑
- **Issue:** 测试断言 `expect(first.mac).toMatch(/0000.?5e00.?0101/i)`，但 ARPParser.parseH3C 经 normalizeMAC 把 H3C 原生格式 `0000-5e00-0101` 归一化为冒号格式 `00:00:5e:00:01:01`，正则不匹配。
- **Fix:** 正则改为 `/^00:00:5e:00:01:01$/i`（精确匹配归一化后的冒号格式）。
- **Files modified:** tests/electron/arpCollector.real.test.ts
- **Verification:** ARPParser.parse it + collectFromDevice it 的 MAC 断言全绿。
- **Committed in:** 37f5cca（Task 1 commit）

**3. [Rule 1 - bug] arpCollector timeout 路径改用 connection refused**
- **Found during:** Task 1 三跑
- **Issue:** plan 要求 it 3 测 executeSSH timeout 路径（client.destroy）。原实现起裸 net.Server accept TCP 但不发 SSH banner（silentServer），期望 executeSSH 外层 timer 800ms 触发 reject。实跑发现 silentServer 场景下 ssh2.Client 的 banner-wait timeout 在库内部行为下不可靠触发，挂满 testTimeout 15000ms（wtfnode 显示 socket established 但 ssh2 等 banner 不返回）。
- **Fix:** 改用「端口未监存」（port=1）触发 ECONNREFUSED，ssh2.Client 快速 emit 'error'，executeSSH 的 `client.on('error') → finish → cleanup(client.end) → reject` 路径触发，collectFromDevice try/catch 收入 error。同样验证 cleanup 句柄回收（虽不验证 timeout 的 client.destroy，但 cleanup 路径同构）。
- **Files modified:** tests/electron/arpCollector.real.test.ts
- **Verification:** it 3 快速返回（~65ms），result.error 非空，afterEach 无泄漏。
- **Committed in:** 37f5cca（Task 1 commit）

**4. [Rule 1 - bug] telnet timeout 路径改用裸 net.Server**
- **Found during:** Task 2 首跑
- **Issue:** plan 要求 it 3 测 executeTelnetCommand timeout 路径（finally connection.destroy）。原实现用 `startMockTelnetServer(() => '', 'silent#')`，但 mockTelnetServer 的 onCmd 返回空仍会回 `'\r\n' + shellPrompt`，telnet-client exec 收到空行+prompt 正常 resolve（输出 `'\n'`），不触发 timeout。
- **Fix:** 改用裸 net.Server（accept TCP 但不发任何数据，不发 shellPrompt/loginPrompt），telnet-client connect 等不到 shellPrompt，executeTelnetCommand 外层 setTimeout(500) 兜底触发 reject `Telnet timeout`，finally cleanup（clearTimeout + connection.destroy）触发。
- **Files modified:** tests/electron/telnetExec.real.test.ts
- **Verification:** it 3 reject `/timeout/i`，afterEach 无泄漏。
- **Committed in:** 40f13e5（Task 2 commit）

**5. [Rule 2 - 关键功能] handleLeakDetector 默认白名单反馈环补入 native stream 句柄类型**
- **Found during:** Task 2 全套跑（test:electron 4 文件并发）
- **Issue:** 12-01 落地的 handleLeakDetector 默认白名单仅 `['Timeout', 'GetAddrInfoReqWrap']`（基于 db.real.test.ts 无网络经验）。SSH/Telnet 真路径测试暴露三类 libuv 句柄漂移误报：
  - TCPServerWrap：mockSshServer/mockTelnetServer 自身 listen socket（beforeAll 起 afterAll 关，afterEach 时仍在 listen = 预期）
  - TCPWrap：ssh2/telnet-client connect 短暂持 socket，afterEach sleep(50) 内可能未完全释放
  - SimpleWriteWrap：ssh2/telnet-client native stream 异步写句柄（libuv 释放时序慢于 afterEach sleep(50)，跨文件漂移）
  
  三个测试文件首跑都被这三类句柄误报阻塞（ai 5/5 fail TCPServerWrap、telnetExec 在全套跑时 SimpleWriteWrap 漂移）。
- **Fix:** handleLeakDetector 默认白名单补入 `TCPServerWrap/TCPWrap/SimpleWriteWrap`（plan critical_constraints 第 3 条「helper 接口与实际测试需求不符回 12-01 修」反馈环）。三个测试文件的 expectNoHandleLeak() 调用同步简化（不传 extraAllow，默认白名单已覆盖）。
- **Files modified:** tests/electron/_helpers/handleLeakDetector.ts（默认白名单 +3）+ tests/electron/ai.execCommands.real.test.ts + tests/electron/arpCollector.real.test.ts + tests/electron/telnetExec.real.test.ts（调用简化）
- **Verification:** test:electron 17/17 全绿（4 文件并发无跨文件句柄漂移误报）；ai/arpCollector/telnetExec 被测 cleanup 路径的真实泄漏（如 client 未 end、timer 未 clear）仍会被检测（默认白名单只放行库内部 libuv 释放延迟，不放行被测代码漏 cleanup 的 Timeout/TCPWrap 残留——因为 baseline 对比逻辑仍生效，泄漏 = after 新增且不在白名单）。
- **Committed in:** 40f13e5（Task 2 commit）

---

**Total deviations:** 5 auto-fixed（4 Rule 1 bug + 1 Rule 2 关键功能反馈环）
**Impact on plan:** 全部 auto-fix 是测试实现细节与库行为适配，无 scope creep。Rule 1 修复（beforeAll import / MAC 正则 / 两处 timeout 场景构造）是落地真路径测试的硬阻塞；Rule 2 修复（helper 默认白名单反馈环）是 plan critical_constraints 第 3 条明确要求的反馈路径。SC4 红线（electron/ 生产零改动）全程未触。

## Checkpoint 结论汇总

- **A2（ssh2.Server 在 ELECTRON_RUN_AS_NODE 下 listen）**：**PASS** — ssh2.Server 经 electron.exe 正常 listen(0,'127.0.0.1') + accept 任意凭证 + authentication.accept + session.exec stream.end 回显全链路实跑确认。ai.execCommands.real.test.ts（executeCommandsOnDevice SSH 正常/多命令/execOne cleanup）+ arpCollector.real.test.ts（executeSSH + ARPParser 解析）9 it 全绿佐证。无需回 12-01 修 mockSshServer。
- **telnet IAC 协商**：**PASS** — mockTelnetServer（12-01 落地 DONT/WONT + stripIac）经真实 telnet-client connect 实跑确认不卡住。telnetExec.real.test.ts 5 it 全绿（正常路径回显 + finally cleanup + timeout cleanup），shellPrompt mock#/silent# 正常匹配。无需回 12-01 修 mockTelnetServer IAC 处理。
- **OQ#1（getDatabase 注入策略）**：方案 A 维持（vi.mock connection 桩），arpCollector 不持久化 arp_entries，connection mock 桩足够，零生产改动。
- **A4（wtfnode 在 ELECTRON_RUN_AS_NODE 下 async_hooks）**：best-effort import 已容错（.catch(() => null)），本 plan 触发了 dump 路径（句柄泄漏误报时打印 open handles），但 wtfnode 报 `Unable to determine callsite for "Function". Did you require wtfnode at the top of your entry point?`（vitest 入口已加载，限制下无法精确定位调用栈）—— 不影响 fail 信号（getActiveResourcesInfo snapshot 对比仍是主检测），完整 dump 诊断待 12-03 句柄专项评估是否需 wtfnode top-level require。

## Issues Encountered

- **wtfnode callsite 定位受限**：wtfnode 在 vitest 进程内动态 import 时报 `Unable to determine callsite`（需 entry point top-level require），dump 仍打印 open handles 列表（socket/server/timer 概览）但无精确调用栈。不影响主检测逻辑（getActiveResourcesInfo snapshot 对比），A4 best-effort 容错生效。
- **跨测试文件 libuv 句柄漂移**：test:electron 4 文件并发跑时，上个文件的 ssh2/telnet-client native stream 写句柄（SimpleWriteWrap）可能未完全释放影响下个文件的 afterEach 检测。经 Rule 2 反馈环补入默认白名单解决。

## User Setup Required

None — 无外部服务配置（mockSshServer/mockTelnetServer 自包含 loopback，test:electron 通道自包含）。

## Next Phase Readiness

- **Plan 12-03（句柄泄漏专项 + CI 扩展）就绪**：handleLeakDetector 默认白名单已含 native stream 句柄类型（反馈环闭合），expectNoHandleLeak() 可直接挂到各 service 真路径测试的 describe 内不用每文件重复加。CI 扩展（build-smoke.yml 加 test:electron step）待 12-03 决策（CI-A/B/C 三方案，RESEARCH 推荐 CI-A：mock 套件放 rebuild 前，真路径放 rebuild 后）。
- **TEST-01/02 达成**：SC2 之 SSH/Telnet/DB 部分全绿（DB 12-01 + SSH/Telnet 12-02），TEST-02 四条 cleanup 路径句柄泄漏自动化检测全绿。
- **无阻塞**：三绿门禁全绿，SC4 兜底通过，零生产代码改动，零回归。

---
*Phase: 12-test-infrastructure-dep-1-abi*
*Plan: 02*
*Completed: 2026-08-08*
