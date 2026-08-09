---
phase: 13-security-hardening-cluster
verified: 2026-08-09T20:45:00Z
status: passed
score: 6/6 truths verified
overrides_applied: 0
re_verification:
  previous_status: none
notes:
  - "初始验证（无前置 VERIFICATION.md）"
  - "三绿门禁由 verifier 独立复跑确认：tsc web exit 0 / build:electron-main exit 0 / SEC-03 test:electron 3/3 / SEC-04+05 unit 19/19 / npm test 256/256"
  - "KNOWN DEVIATION 1（13-02 触碰 authGuard.ts 生产代码）经评估为可接受的增强：CR-01 过度脱敏回归已在 adf3981 修复（正则收紧为枚举根前缀+部署路径）+ 反向回归 it 覆盖 URL/日期/比例，最终态为红线①增强非削弱"
  - "KNOWN DEVIATION 2（testSSHConnection readyTimeout 8000 未对齐）为 plan truth #3 范围外的代码一致性 gap，13-01-SUMMARY 显式记录决策（测试通道短超时快速失败），非 must-have truth 失败"
---

# Phase 13: Security Hardening Cluster 验证报告

**Phase Goal:** SSH 终端连接可用现代算法连通现代 Linux、pre-release 安全相关 hardening 项收尾、untrusted renderer 无法用 experience:list 入参廉价触发全表 LIKE DoS
**Verified:** 2026-08-09T20:45:00Z
**Status:** passed
**Re-verification:** 否 — 初始验证

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | connection.ts connectSSH 的 SSH 握手算法与 sshConfig.ts SSH_ALGORITHMS 常量逐字一致（零 drift） | ✓ VERIFIED | `connection.ts:116` `algorithms: SSH_ALGORITHMS,`（删除了原内联表）；import 在 `connection.ts:10`；sshConfig.ts:13 `kex[0]='curve25519-sha256'` |
| 2 | 仅支持 curve25519-sha256 kex 的现代 Linux 对端，client.connect 用 SSH_ALGORITHMS 能协商成功（触发 'ready' 事件） | ✓ VERIFIED | `tests/electron/connectSSH.algorithms.real.test.ts` it#2（line 150-157）真路径协商 'ready' PASS（verifier 独立复跑 test:electron 3/3 绿） |
| 3 | connectSSH readyTimeout 对齐 SSH_READY_TIMEOUT_MS(30s)，慢设备 10-30s 区间不再触发 readyTimeout | ✓ VERIFIED | `connection.ts:115` `readyTimeout: SSH_READY_TIMEOUT_MS,`；sshConfig.ts:7 `SSH_READY_TIMEOUT_MS = 30000`；原字面量 `readyTimeout: 10000` 已删（grep 全文件命中 0） |
| 4 | 全仓 3 处 SSH 路径（ai.ts / arpCollector.ts / connection.ts）走同一 algorithms 常量，无第二份算法表 | ✓ VERIFIED | grep `algorithms: SSH_ALGORITHMS` 命中 4 处：`connection.ts:116`(connectSSH) + `connection.ts:278`(testSSHConnection) + `ai.ts:312` + `arpCollector.ts:68`；grep `algorithms:\s*\{` 在 electron/ 生产代码命中 0（唯一内联表在测试文件作为反向回归快照） |
| 5 | pre-release 安全 hardening 5 项（L1/L2/L3/L4/L6）逐项有明确结论——要么修要么显式 defer 登记 reason（SC2 要求，不可静默跳过） | ✓ VERIFIED | `13-02-DEFER-LOG.md` 五节齐全（L1/L2/L3/L4/L6），每节含 结论+佐证(file:line)+审计引用+reason+重评估条件；L1 DEFER / L2 DEFER / L3 FIXED+renderSvg DEFER / L4 FIXED / L6 FIXED |
| 6 | untrusted renderer 调 experience:list 传超长 search / 超量 tags / 非法 severity 被 IPC 网关层截断/拒绝，不传给 service 层 LIKE 全表扫 | ✓ VERIFIED | `experienceIpc.ts:84-107` sanitizeListInput 纯函数：search slice(0,100) + tags slice(0,20) + 单 tag slice(0,30) + severity throw；handler `experienceIpc.ts:114-115` 包在 secure(...) 内调 listExperiences(sanitizeListInput(opts))；experienceListGuard.test.ts 8 it 全绿（verifier 独立复跑 19/19 含本文件 8 it） |

**Score:** 6/6 truths verified

**补充验证项（plan must_haves 第 5/6/7 条 + SC4 三红线）：**

| 验证项 | Status | Evidence |
| --- | --- | --- |
| SEC-05 VALID_SEVERITIES 单一来源（service 导出 IPC 复用，无两份枚举 drift） | ✓ VERIFIED | `experienceService.ts:54` `export const VALID_SEVERITIES = [...] as const`；`experienceIpc.ts:24` import 复用（非第二份手写）；experienceListGuard.test.ts it#8 deepEqual 校验枚举一致 |
| SEC-05 service 层 listExperiences limit MAX_BATCH 兜底保留（双层防御第二层） | ✓ VERIFIED | `experienceService.ts:265-266` `if (limit > MAX_BATCH) throw new Error('limit 超过 MAX_BATCH 上限')` 保留；experienceListGuard.test.ts it#7 用 _setExperienceDbGetter 注入 mock DB 验证 throw 仍生效 |
| SC4 红线① IPC secure/safe 鉴权 | ✓ VERIFIED | experience:list handler 仍 `secure(...)` 包装（experienceIpc.ts:114）；authGuard.ts:33-43 secure 未登录 reject 在 try 之外不被脱敏；authGuard.test.ts:10-13 既有拒绝 it 保持绿 |
| SC4 红线② 字段加密 _enc | ✓ VERIFIED | 三 plan 均未触碰 encField/decField/attrs_enc 路径（grep 确认无改动） |
| SC4 红线③ commandSafety.isCommandAllowed | ✓ VERIFIED | ai.ts:334 + ai.ts:890 两处 isCommandAllowed 守卫保留；三 plan 均未改 commandSafety.ts |
| SEC-04 L6 authGuard 单测扩展（safe 未登录不拒绝 + isAuthenticated + SQL 错误脱敏） | ✓ VERIFIED | authGuard.test.ts 既有 7 it + 新增 3 it（line 85-113）+ CR-01 反向回归 1 it（line 115-134）= 11 it，verifier 独立复跑 11/11 绿 |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `electron/services/connection.ts` | connectSSH/testSSHConnection 复用 SSH_ALGORITHMS + SSH_READY_TIMEOUT_MS | ✓ VERIFIED | line 115-116 connectSSH；line 277-278 testSSHConnection（readyTimeout 8000 系测试通道故意短超时，13-01-SUMMARY Rule 1 显式记录） |
| `tests/electron/connectSSH.algorithms.real.test.ts` | curve25519-only 对端协商回归 | ✓ VERIFIED | 206 行，3 it（首项断言 + 协商成功 + 内联旧表协商失败反向回归），verifier 复跑 3/3 绿 |
| `tests/unit/authGuard.test.ts` | L6 单测扩展（safe 未登录 + isAuthenticated + SQL 脱敏） | ✓ VERIFIED | 11 it（既有 7 + 新增 3 + CR-01 反向 1），verifier 复跑 11/11 绿 |
| `13-02-DEFER-LOG.md` | SEC-04 五项甄别登记表 | ✓ VERIFIED | 123 行，L1/L2/L3/L4/L6 五节齐全，每节含结论+佐证+审计引用+reason+重评估条件 |
| `electron/ipc/experienceIpc.ts` | experience:list 加 sanitizeListInput + VALID_SEVERITIES import | ✓ VERIFIED | line 84-107 sanitizeListInput 纯函数；line 24 VALID_SEVERITIES import；line 114-115 handler 改造 |
| `electron/services/experienceService.ts` | export VALID_SEVERITIES + listExperiences limit 兜底保留 | ✓ VERIFIED | line 54 export const VALID_SEVERITIES as const；line 265-266 limit MAX_BATCH throw 保留；line 261 listExperiences 签名不变 |
| `tests/unit/experienceListGuard.test.ts` | SEC-05 mock 单测 8 it | ✓ VERIFIED | 107 行 8 it，verifier 复跑 8/8 绿 |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| connection.ts | sshConfig.ts | `import { SSH_ALGORITHMS, SSH_READY_TIMEOUT_MS }` | ✓ WIRED | connection.ts:10 import；line 115/116 引用两常量 |
| connectSSH.algorithms.real.test.ts | sshConfig.ts SSH_ALGORITHMS | 真路径 ssh2.Client.connect 验证协商 | ✓ WIRED | test line 30 import SSH_ALGORITHMS；line 153 用 SSH_ALGORITHMS 协商成功 |
| authGuard.test.ts | authGuard.ts | secure/safe 单测覆盖未登录拒绝 + 异常脱敏 | ✓ WIRED | test line 2 import secure/safe/setAuthenticated/isAuthenticated；11 it 全覆盖 |
| 13-02-DEFER-LOG.md | SC2 pre-release 5 项 | 逐项结论 + 代码佐证 + 审计引用 | ✓ WIRED | L1/L2/L3/L4/L6 五节，每节佐证含 file:line |
| experienceIpc.ts | experienceService.ts VALID_SEVERITIES | import 复用枚举（非第二份手写） | ✓ WIRED | experienceIpc.ts:24 import VALID_SEVERITIES；sanitizeListInput line 102 复用 |
| experienceListGuard.test.ts | experienceIpc.ts sanitizeListInput | 直接调纯函数验证截断/throw | ✓ WIRED | test line 15 import sanitizeListInput；8 it 直接调验 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| connectSSH | config.algorithms | SSH_ALGORITHMS 常量（sshConfig.ts:11-33） | 是（curve25519 首项 + 全兼容算法） | ✓ FLOWING |
| sanitizeListInput | sanitized.search/tags/severity | opts 入参（renderer 传） | 是（钳制后透传 service） | ✓ FLOWING |
| experience:list handler | listExperiences(sanitizeListInput(opts)) | sanitizeListInput 返回值 | 是（真实 opts 经校验后入 service） | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| SEC-03 SSH_ALGORITHMS 含 curve25519 与对端协商成功 | `npx cross-env ELECTRON_RUN_AS_NODE=1 electron.exe vitest.mjs run connectSSH.algorithms` | 3/3 PASS（含 ready 协商成功 it） | ✓ PASS |
| SEC-04 authGuard secure/safe 行为边界 | `npx vitest run tests/unit/authGuard.test.ts` | 11/11 PASS（含 CR-01 反向回归） | ✓ PASS |
| SEC-05 sanitizeListInput 截断/throw | `npx vitest run tests/unit/experienceListGuard.test.ts` | 8/8 PASS | ✓ PASS |
| tsc web strict + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 | ✓ PASS |
| esbuild electron-main 打包 | `npm run build:electron-main` | exit 0（dist-electron/main.js 1.9mb） | ✓ PASS |
| plain node 全套件零回归 | `npm test` | 256/256 PASS | ✓ PASS |

### Probe Execution

| Probe | Command | Result | Status |
| --- | --- | --- | --- |
| SEC-03 真路径 SSH 协商 | `bash` 内调 `npx cross-env ELECTRON_RUN_AS_NODE=1 ... vitest.mjs run connectSSH.algorithms` | exit 0，3/3 PASS | ✓ PASS |
| SEC-04 unit 回归 | `npx vitest run tests/unit/authGuard.test.ts` | exit 0，11/11 PASS | ✓ PASS |
| SEC-05 unit 回归 | `npx vitest run tests/unit/experienceListGuard.test.ts` | exit 0，8/8 PASS | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| SEC-03 | 13-01 | connection.ts 内联 algorithms 补 curve25519-sha256（与 SSH_ALGORITHMS 对齐） | ✓ SATISFIED | connection.ts:116/278 全 SSH 路径走 SSH_ALGORITHMS；sshConfig.ts:13 kex 首项 curve25519；真路径 test 3/3 绿 |
| SEC-04 | 13-02 | pre-release 安全 hardening L1/L2/L3/L4/L6 收尾（每项修或显式 defer） | ✓ SATISFIED | DEFER-LOG 五节齐全：L1 DEFER(D-13-1) / L2 DEFER(命令安全层已强制) / L3 FIXED+renderSvg DEFER / L4 FIXED / L6 FIXED；authGuard 单测 11 it 绿；CR-01 修复落地 |
| SEC-05 | 13-03 | experience:list severity 枚举 + search 长度 + tags 上限防廉价 DoS | ✓ SATISFIED | sanitizeListInput search≤100/tags≤20/单tag≤30 钳制 + severity throw；VALID_SEVERITIES 单一来源 export；service limit MAX_BATCH 兜底保留；8 it 绿 |

无 ORPHANED 需求（REQUIREMENTS.md Phase 13 仅映射 SEC-03/04/05，三 plan 全覆盖）。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| electron/services/connection.ts | 277 | testSSHConnection readyTimeout: 8000 魔术数字（未抽常量） | ℹ️ Info | WR-01/IN-01 已知一致性 gap，13-01-SUMMARY Rule 1 显式记录决策（测试通道故意短超时快速失败），非 must-have truth 范围 |
| electron/ipc/experienceIpc.ts | 93-95 | sanitizeListInput tags map 对非 string 元素 typeof 守卫后原样透传 | ⚠️ Warning | WR-03 已知残余 gap：下游 listExperiences 对 tag 做 .replace，若 renderer 传非 string tags（如 [123, null]）会 throw；当前校验只保证 string 元素截断，非 string 透传。throw 经 secure sanitizeMessage 脱敏，不致命但崩溃面下沉到 service 层。建议后续在 IPC 层加 `.filter((tag): tag is string => typeof tag === 'string')` |
| tests/electron/connectSSH.algorithms.real.test.ts | 163-198 | 反向回归用硬编码 legacy 算法表（与 SSH_ALGORITHMS 漂移） | ℹ️ Info | IN-04 已知：legacy 表是 connection.ts 改造前 git 快照，永不动仅作 KEX 失败反向锚点；建议补 git commit hash 注释锚定版本 |

**Debt marker gate:** electron/ 生产代码扫描无 TBD/FIXME/XXX 未引用标记（grep 命中均为 placeholders/SQL 占位/is-连接词等误报）。

### Human Verification Required

无。本 phase 三 must-have goal（SSH 现代算法连通 / pre-release hardening 甄别 / experience:list DoS 防御）均经自动化真路径 + 单测验证，无视觉/实时/外部服务需人工确认项。

注：SSH 终端连接对真机现代 Linux 的实际连通属"真机 HV"范畴，但本 phase 已用内联 ssh2.Server（curve25519-only 对端）真路径回归锁定协商契约（test:electron 3/3 绿），等价覆盖核心目标，无需额外人工真机验证。

### Gaps Summary

无 BLOCKER。三 must-have goal 全部达成：

1. **SEC-03 SSH 现代算法连通**：connection.ts 全 SSH 路径（connectSSH + testSSHConnection）复用 SSH_ALGORITHMS 常量（含 curve25519-sha256 首项），drift 根源消除；真路径回归 3/3 绿验证 curve25519-only 对端协商成功。
2. **SEC-04 pre-release hardening 收尾**：L1/L2/L3/L4/L6 五项逐项甄别登记（DEFER-LOG），无静默跳过；authGuard 单测扩展至 11 it 含 CR-01 反向回归。
3. **SEC-05 experience:list DoS 防御**：sanitizeListInput 纯函数钳制 search/tags + throw 非法 severity；VALID_SEVERITIES 单一来源；service limit MAX_BATCH 双层兜底保留；8 it 回归网。

**已知 WARNING（非 blocker，不阻断下一 phase）：**

- **13-02 deviation（触碰 authGuard.ts 生产代码）**：plan verification 段声明「git diff electron/utils/authGuard.ts 退出 0」未满足——executor 在 9096853 修改了 sanitizeMessage Unix 路径正则。该修改引入 CR-01 过度脱敏回归（误吞 URL/日期/比例），但**已在 adf3981 修复**（正则收紧为枚举 Unix 根前缀 `usr|home|Users|tmp|var|opt` + 部署路径 `app|data|root|private|etc|srv|mnt|proc|sys|dev|run|bin|sbin|lib|boot`，既覆盖 `/app/db/main.db` 等 SQLite 部署路径，又排除 URL/日期/比例）+ 补反向回归 it（authGuard.test.ts:115-134 验证 4 case 不被替换为 [路径]）。最终态为红线①**增强**（异常脱敏覆盖更广）非削弱（secure/safe 鉴权逻辑零改动，既有 secure 未登录拒绝 it 保持绿）。verifier 复跑 authGuard 11/11 + npm test 256/256 零回归确认。**评估结论：可接受**——plan 字面 verification line 被违反，但最终代码正确、增强安全、有反向回归网兜底，且 deviation 在 SUMMARY + DEFER-LOG L6 + CR-01 fix commit 完整记录可审计。

- **WR-03（tags 非 string 透传）**：sanitizeListInput 对非 string tag 元素原样透传，下游 listExperiences `.replace` 会 throw。当前校验满足 must-have truth（超量 tags 截取 + 单 tag 截断）但未保证 tags 是 string[] 不变量。建议 Phase 14 或后续 hardening 在 IPC 层加 `.filter((tag): tag is string => typeof tag === 'string')`。非本 phase goal 失败。

**三红线（IPC secure/safe / 字段加密 _enc / commandSafety.isCommandAllowed）改动后仍生效确认：**
- 红线① IPC 鉴权：experience:list handler 仍 secure 包装（experienceIpc.ts:114）；authGuard.ts secure/safe 鉴权逻辑零改动（仅 sanitizeMessage 正则增强）；authGuard.test.ts secure 未登录拒绝 it 保持绿
- 红线② 字段加密：三 plan 均未触碰 _enc/encField/decField 路径
- 红线③ commandSafety：ai.ts:334 + ai.ts:890 两处 isCommandAllowed 守卫保留，三 plan 均未改 commandSafety.ts

**ROADMAP/REQUIREMENTS 预标 complete 复核**：verifier 独立核对代码与测试，SEC-03/04/05 三需求实现与测试证据齐备，pre-marked "Complete" 状态**确认无误**。

---

_Verified: 2026-08-09T20:45:00Z_
_Verifier: Claude (gsd-verifier)_
