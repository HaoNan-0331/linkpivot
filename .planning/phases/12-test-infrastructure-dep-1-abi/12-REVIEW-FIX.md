---
phase: 12-test-infrastructure-dep-1-abi
fixed_at: 2026-08-08T06:05:00Z
review_path: .planning/phases/12-test-infrastructure-dep-1-abi/12-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 10
skipped: 0
status: all_fixed
---

# Phase 12: Code Review Fix Report

**Fixed at:** 2026-08-08T06:05:00Z
**Source review:** `.planning/phases/12-test-infrastructure-dep-1-abi/12-REVIEW.md`
**Iteration:** 1
**Fixer:** Claude (gsd-code-fixer)

**Summary:**
- Findings in scope: 10（3 Critical + 7 Warning，4 Info 按 fix_scope 跳过）
- Fixed: 10
- Skipped: 0

**三绿门禁（修复后实测）：**
- `npm run build:electron-main`: exit 0（esbuild main bundle 1.9mb Done in 992ms）
- `npm test`: 244/244 全绿（17 test files，plain node mock 套件无回归）
- `npm run test:electron`: 21/21 全绿（5 test files，原 22 删 WR-07 it3 = 21，符合设计）

**SC4 红线验证：** `git diff 507cb63..47d3d90 --stat -- electron/` 退出码 0，electron/ 零改动。

## Fixed Issues

### CR-01: handleLeakDetector baseline 移到 beforeEach 每 it 独立

**Files modified:** `tests/electron/_helpers/handleLeakDetector.ts`
**Commit:** `5d6793c`
**Applied fix:** baseline 从模块顶层（describe 执行期，跨多 it 共享一份基线）移到 `beforeEach`，每 it 紧贴执行前取独立基线。修复累积泄漏检测失效问题（Plan 12-03 it4 5 次循环无累积的核心断言）。import 从 `{ afterEach }` 改为 `{ beforeEach, afterEach }`，`baseline` 改为 `let` + beforeEach 闭包赋值。beforeAll 起 mock server 的 TCPServerWrap 已在 allowDefault，不污染基线。

### CR-02: mockSshServer/mockTelnetServer error handler 时序修正

**Files modified:** `tests/electron/_helpers/mockSshServer.ts`, `tests/electron/_helpers/mockTelnetServer.ts`
**Commit:** `d9afd50`
**Applied fix:** 两文件同模式修复。`server.on('error')→reject` 改为 `server.once('error', onListenError)` 处理 listen 阶段 error；listen 成功回调内 `server.off('error', onListenError)` 解绑后改挂运行期 error → `console.error('[mockSshServer/mockTelnetServer] runtime error:', err)`。修复运行期 accept/connection error 被 silent swallow 的问题（CI 上表现为测试间歇性静默挂起或断言失败但无 error 线索）。

### CR-03: rebuild:native 补 cpu-features + verify step 验产物

**Files modified:** `package.json`, `.github/workflows/build-smoke.yml`
**Commit:** `0375bc8`
**Applied fix:** 实跑确认 `cpu-features@0.0.10` 是 ssh2 1.17 的 optionalDependencies，实际产物 `node_modules/cpu-features/build/Release/cpufeatures.node`。`package.json` 的 `rebuild:native` 追加 `-w cpu-features`（保留 `-w ssh2` 不破坏 no-op，ssh2 1.17 纯 JS 无 .node）。`build-smoke.yml` verify step 追加 `test ! -d node_modules/cpu-features || test -f node_modules/cpu-features/build/Release/cpufeatures.node`（cpu-features 未装放行，装了强制验 electron-ABI 产物）。**status: fixed: requires human verification**（CI 配置，需 GHA windows-latest 实跑确认 -w cpu-features 触发 electron-ABI 重建）。

### WR-01: 异常路径用 RST server 替代 port:1 / port+1

**Files modified:** `tests/electron/arpCollector.real.test.ts`, `tests/electron/handleLeak.real.test.ts`, `tests/electron/ai.execCommands.real.test.ts`
**Commit:** `29b2501`
**Applied fix:** 三处异常路径 it（arpCollector it3 / handleLeak it5 / ai.execCommands 异常路径 it）统一改用一次性 RST server（accept 后立即 destroy）确定性触发 client 'error'（ECONNRESET / socket hang up），替代之前 `port: 1`（Windows 保留端口，可能 EACCES 而非 ECONNREFUSED）/ `sshHandle.port + 1`（随机端口 +1 可能被占用连上非预期 server）。rstServer 在 finally 内 close 释放避免句柄泄漏误报。arpCollector + ai.execCommands 顶部补 `import net from 'net'`。同 handleLeak it1 已有 RST server 模式同构。**status: fixed: requires human verification**（逻辑改动，需确认 ssh2 client 真实触发 error 路径）。

### WR-02: handleIac WILL/DO 加长度守卫防畸形输入

**Files modified:** `tests/electron/_helpers/mockTelnetServer.ts`
**Commit:** `410d168`
**Applied fix:** `handleIac` 的 WILL/DO 分支加 `if (i + 2 >= buf.length) break` 长度守卫，畸形 WILL/DO（末尾缺 option 字节）跳过不响应；移除 `buf[i + 2] ?? 0` 的 `?? 0` 兜底（之前在缺字节时发 option=0 Binary Transmission 的 DONT/WONT，语义错误）。主路径（telnet-client 发标准 3-byte WILL/DO/WONT/DONT）不变。**status: fixed: requires human verification**（IAC 协商行为需真路径回归确认）。

### WR-03: realDb hasColumn 补 PRAGMA 不可参数化边界说明

**Files modified:** `tests/electron/_helpers/realDb.ts`
**Commit:** `91873d9`
**Applied fix:** `hasColumn` 函数 JSDoc 补充边界说明：PRAGMA 不支持参数绑定（SQLite 限制，非约定偏离），table 必须为代码常量；本 helper table 仅传字面量 `'experiences'`，无注入风险；生产 `migrationHelpers.ts` 同模式；照抄者注意 table 不可来自用户输入或动态拼接。纯注释补充，无逻辑改动。

### WR-04: mockTelnetServer 固化 telnet-client 隐式契约注释

**Files modified:** `tests/electron/_helpers/mockTelnetServer.ts`
**Commit:** `47cbf00`
**Applied fix:** 文件顶部补 WR-04 隐式契约说明：明确 mockTelnetServer 不发 login/password prompt 依赖 telnet-client@2.2.13 的 getprompt 状态机在 shellPrompt 优先匹配时跳过 login/password 的契约；package.json 已 pin 2.2.13；若库升级改状态机顺序需补 login/password prompt 状态机（参考 `telnet-client/lib/index.js:356`）。纯注释补充，无逻辑改动。

### WR-05: 移除 arpCollector setArpMasterKey dead injection

**Files modified:** `tests/electron/arpCollector.real.test.ts`
**Commit:** `16eb737`
**Applied fix:** 读 `arpCollector.ts` 确认 `dec()` 函数定义但代码内从未调用（dead code），`collectFromDevice` SSH 路径直接传 `device.password`（明文）给 `executeSSH`，整条路径不调 `dec()`；`arpCollector.ts` 顶层 `let MK = ''` 不在 import 时触发 dec。故 `setArpMasterKey(MK_TEST)` 是 dead injection，删除安全不致模块加载失败。移除 `setArpMasterKey` import（保留 `ARPCollector`）+ `MK_TEST` 常量 + 文件顶部 docstring 同步更新。**status: fixed: requires human verification**（删注入后真路径回归需确认 arpCollector 模块仍干净加载）。

### WR-06: 二次迁移改真调 runStandaloneMigrations 验幂等

**Files modified:** `tests/electron/_helpers/realDb.ts`, `tests/electron/db.real.test.ts`
**Commit:** `8bc4c78`
**Applied fix:** `realDb.ts` 导出 `runStandaloneMigrations`（之前私有函数）。`db.real.test.ts` 的「二次迁移 no-op」it 改用 `expect(() => runStandaloneMigrations(db)).not.toThrow()` 真二次调用 helper，替代之前手写裸 SQL 内联（CREATE IF NOT EXISTS + 手写 hasColumn 查询，没真验 helper 守卫逻辑）。it 标题更新为「runStandaloneMigrations 真二次调用 no-op（hasColumn 守卫，WR-06）」。若 helper 的 hasColumn 守卫写错（如 `!hasColumn` 误为 `hasColumn` 致重复 ALTER 抛 duplicate column），现在能测出。**status: fixed: requires human verification**（迁移逻辑真二次调用需确认）。

### WR-07: 删 handleLeak it3 telnet importActual 嵌套路径

**Files modified:** `tests/electron/handleLeak.real.test.ts`
**Commit:** `47d3d90`
**Applied fix:** 删除 it3（telnet silent server timeout cleanup）—— 原 it3 经 `vi.importActual` 取真实 `executeTelnetCommand`，但顶部已 `vi.mock telnetExec`（importActual+spy），importActual 嵌套在 mock factory 内在 vitest 4 + ESM + Electron RUN_AS_NODE 下行为脆弱（importActual 在已被 mock 的模块上调用的语义 + spy 状态跨 it 残留风险）。`telnetExec.real.test.ts` it3（顶部不 mock telnetExec）已干净覆盖同场景（silent server + short timeout → finally destroy cleanup）。同步移除 `startMockTelnetServer` import + `telnetHandle`（it3 删除后无 it 用 telnet 真路径，本文件聚焦 SSH 异常 + 累积场景）+ 文件顶部 docstring 与 it 注释标注 WR-07 删除原因。test:electron 用例数 22→21 符合设计。**status: fixed: requires human verification**（删 it 后剩余 4 it 真路径回归需确认）。

## Skipped Issues

无（10 个 in-scope findings 全部 fixed；4 个 Info 按 fix_scope=critical_warning 跳过，未计入 in-scope）。

## Info Findings（未修，记录备查）

- **IN-01**: handleLeakDetector `await sleep(50)` 魔法数 —— 未提常量，CI 慢机器可能 flaky。
- **IN-02**: ai.execCommands.real.test.ts device vendor 字段不一致 —— 无工厂函数。
- **IN-03**: mockSshServer `server.address()` port=null 兜底 -1 不 fail —— 报错信息不直观。
- **IN-04**: handleLeak.real.test.ts it2 注释承认用回显正常路径覆盖 stream error 路径 —— it 名误导。

---

_Fixed: 2026-08-08T06:05:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
