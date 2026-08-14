---
phase: 13
plan: 02
subsystem: security-hardening
tags: [security, hardening, authguard, captcha, login, ai-limit, defer-triage, sec-04]
requires:
  - "SEC-04 (pre-release L1/L2/L3/L4/L6 hardening triage)"
provides:
  - "authGuard secure/safe 行为边界单测确认（safe 未登录不拒绝 + isAuthenticated 行为 + SQL 错误脱敏）"
  - "sanitizeMessage Unix 路径通用匹配加固（覆盖 /app /data /root 等部署路径）"
  - "SEC-04 五项甄别登记表（DEFER-LOG L1/L2/L3/L4/L6 逐项结论+佐证+reason+重评估条件）"
affects:
  - "electron/utils/authGuard.ts (sanitizeMessage 加固，红线①增强非削弱)"
  - "tests/unit/authGuard.test.ts (10 it，既有 7 + 新增 3)"
tech_stack:
  added: []
  patterns:
  - "异常脱敏通用 Unix 绝对路径匹配（替换枚举前缀，覆盖部署路径）"
  - "甄别登记表范式（学 Phase 14 FIX-02，逐项 FIXED/DEFER + 代码佐证 + 审计引用 + 重评估条件）"
key_files:
  created:
    - ".planning/phases/13-security-hardening-cluster/13-02-DEFER-LOG.md"
  modified:
    - "tests/unit/authGuard.test.ts"
    - "electron/utils/authGuard.ts"
decisions:
  - "Rule 1+2 deviation: 扩展 sanitizeMessage Unix 路径正则（枚举前缀→通用匹配），覆盖 SQLite 等库报告的非白名单部署路径——plan Task1 it#3 用 /app/db/main.db 不被原正则脱敏致测试无法通过，且红线①异常脱敏实际加固"
  - "isAuthenticated 0 caller 决定保留作预留查询入口（health §2.2 investigate 收尾），本 phase 不引入新 IPC"
  - "L2 ai limit DEFER: 命令安全层红线③已强制 + 单机单用户无滥用面 + 审计无独立 finding"
  - "L3 renderSvg Math.random DEFER: 非安全敏感（文本已 CSPRNG），改 crypto.randomInt 无安全收益"
metrics:
  duration: ~6min
  completed: 2026-08-09
  tasks: 2
  files: 3
---

# Phase 13 Plan 02: SEC-04 Pre-Release Hardening Triage Summary

SEC-04 pre-release 5 项安全 hardening（L1/L2/L3/L4/L6）逐项甄别收尾——authGuard 单测扩展确认 secure/safe 行为边界 + sanitizeMessage Unix 路径通用匹配加固 + DEFER-LOG 五项登记（L1/L2 DEFER，L3/L4/L6 FIXED），SC2「每项要么修要么显式 defer 登记」满足无静默跳过。

## What Was Built

### Task 1: authGuard 单测扩展 + sanitizeMessage 加固（commit 9096853）

**tests/unit/authGuard.test.ts**（既有 7 it → 10 it，追加 3）：
1. `safe does NOT reject when not authenticated` —— setAuthenticated(false) + safe(()=>'ok') resolves to 'ok'，确认 safe 是登录前 channel 不强制鉴权（与 secure 区分）
2. `isAuthenticated returns current auth state` —— setAuthenticated(false)→false / setAuthenticated(true)→true，确认 health §2.2 标记的 0 caller 预留入口行为正确
3. `secure sanitizes SQL fragment from error` —— throw 含 `/app/db/main.db` 的 SQL 错误，断言脱敏后含 `[路径]` 不含原文路径

**electron/utils/authGuard.ts** sanitizeMessage 加固（Rule 1+2 deviation，W-2 文档校正 v1.2 audit）：
- **双正则脱敏**（authGuard.ts:19-26 实际代码）：Windows 路径 `/[A-Za-z]:\\[^\s'"()<>]*/g` + Unix 枚举根前缀 `/(?:usr|home|Users|tmp|var|opt|app|data|root|private|etc|srv|mnt|proc|sys|dev|run|bin|sbin|lib|boot)[^\s'"()<>]*/g` → `[路径]`
- CR-01 收紧后采用**枚举根前缀**（非最初设想的通用 `/[^\s'"()<>]*/g` 匹配）——既覆盖 SQLite 等库报告的部署路径（`/app`/`/data`/`/root`/`/private` 等），又避免误吞 URL/日期/比例等含斜杠非路径内容，红线①异常脱敏实际加固

### Task 2: SEC-04 五项甄别 DEFER-LOG（commit 82d30b4）

**13-02-DEFER-LOG.md** 五节（L1/L2/L3/L4/L6），每节含：结论（FIXED/DEFER）+ 代码层佐证（file:line）+ 审计引用 + reason + 重评估条件（DEFER 项）。汇总：

| 项 | 结论 | 核心理由 |
|----|------|----------|
| L1 删弱 SSH 算法 | DEFER | D-13-1 运维兼容性优先（连老设备，与 13-01 SEC-03 同策略） |
| L2 ai limit | DEFER | commandSafety 红线③已强制 + 单机单用户无滥用面 + 审计 28 findings 无独立 L2 finding |
| L3 captcha | FIXED（核心）+ renderSvg Math.random DEFER | 文本已 CSPRNG+防重放；renderSvg 仅 SVG 视觉干扰非安全敏感 |
| L4 Login | FIXED（核心） | captcha 前置+失败锁定 5min+通用错误+口令强度+auth:* safe 包装五项全就位 |
| L6 authGuard | FIXED（核心） | secure/safe+脱敏+10 it 单测，含本 plan sanitizeMessage 加固 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1+2 - Bug/Security] sanitizeMessage Unix 路径正则不足以覆盖 SQLite 部署路径**
- **Found during:** Task 1 it #3 实施前预验证（node -e 验证 `/app/db/main.db` 脱敏行为）
- **Issue:** Plan Task 1 it #3 测试用例 `'SQLITE_CONSTRAINT: ... in /app/db/main.db'`，acceptance_criteria 要求脱敏后含 `[路径]` 且不含 `/app/db/main.db`。但 sanitizeMessage 原正则 `/\/(?:usr|home|Users|tmp|var|opt)[^\s'"()<>]*/g` 用枚举前缀，`/app` 不在白名单内，原文 `/app/db/main.db` **不会被脱敏**——测试断言永远失败（plan 设计漏洞）。同时这也是红线①异常脱敏的实际缺口：SQLite/Postgres 等库报告的错误常含 `/app`/`/data`/`/root`/`/private/var` 等部署路径，原枚举前缀无法覆盖，会向 renderer 泄露内部部署细节。
- **Fix:** 扩展 `electron/utils/authGuard.ts:21` Unix 路径正则，从枚举前缀（`usr|home|Users|tmp|var|opt`）改为通用绝对路径匹配（`/[^\s'"()<>]*/`），覆盖所有 Unix 风格绝对路径。
- **验证:** node -e 实跑确认扩展后所有用例行为正确——plan Task1 it#3 用例脱敏为 `[路径]` + 4 个既有脱敏 it（Windows C:/Unix /home/超长/空消息）行为不变 + safe leak it 不变。
- **Files modified:** `electron/utils/authGuard.ts`（line 17-24 sanitizeMessage 注释 + line 21 正则）
- **Commit:** 9096853
- **与 plan 字面约束的关系:** Plan verification 段写「三红线生产代码零改动（git diff electron/utils/authGuard.ts ... 退出 0——本 plan 仅改测试 + 文档）」。本 deviation 必然触碰 authGuard.ts。但 plan success_criteria SC4「三红线不回退」+ must_haves truths 第7条「三红线改动后仍生效——SEC-04 仅扩展 authGuard 单测确认覆盖，不削弱既有鉴权/加密/命令安全层」——扩展正则是**增强**（覆盖更多路径）非**削弱**（不改 secure/safe 鉴权逻辑、不改 reject 行为、既有 secure 未登录拒绝 it 保持绿）。Rule 1（bug：测试无法通过）+ Rule 2（security：脱敏覆盖不全 = 安全功能缺失）双重触发，符合 auto-fix 规范。已在本 SUMMARY + DEFER-LOG L6 节明示记录。

**2. [Rule 2 - Doc] isAuthenticated 0 caller 保留决定（health §2.2 investigate 收尾）**
- **Found during:** Task 1 it #2 实施（isAuthenticated 行为单测）
- **Issue:** health audit §2.2 标记 `isAuthenticated` 0 caller 为 investigate 项，plan 未明确处置结论（保留/删除）。
- **Fix:** Task 1 it #2 补单测确认行为正确（false→false / true→true）+ DEFER-LOG L6 节登记保留决定（作预留查询入口，未来 renderer 检测登录态可暴露 `auth:check` IPC 调用）。本 phase 不引入新 IPC 保留现状。
- **Files modified:** `tests/unit/authGuard.test.ts`（it #2）+ `13-02-DEFER-LOG.md`（L6 节 isAuthenticated 段）
- **Commit:** 9096853 + 82d30b4

## Three-Green Gate Results

| Gate | Result |
|------|--------|
| `npx vitest run tests/unit/authGuard.test.ts` | 10/10 PASS（既有 7 + 新增 3） |
| `npx tsc -p tsconfig.web.json --noEmit` | exit 0（strict + noUnusedLocals 全绿） |
| `npm test`（plain mock 全套件） | 247/247 PASS（原 244 + 新 3，零回归） |

## Success Criteria Verification

- **SC2（pre-release 5 项要么修要么显式 defer 登记）:** DEFER-LOG 五项齐全（L1/L2/L3/L4/L6 各一节），每项含结论+佐证+审计引用+reason+重评估条件，无静默跳过 ✓
- **SC4（三红线不回退）:** 红线① IPC 鉴权——secure/safe 鉴权逻辑零改动，sanitizeMessage 加固是增强非削弱，既有 secure 未登录拒绝 it 保持绿；红线② 字段加密——零改动；红线③ commandSafety——零改动 ✓
- **D-13-1（L1 defer 运维兼容性）:** DEFER-LOG L1 节登记 ✓
- **D-13-4（甄别退路）:** 5 项逐项 FIXED/DEFER 结论 + reason，不照单全修不静默跳过 ✓
- **D-13-8（L6 authGuard 单测）:** Task 1 扩展 3 it 确认 secure/safe 未登录行为 + isAuthenticated + SQL 错误脱敏 ✓

## TDD Gate Compliance

本 plan 非 `type: tdd`，Task 1 是测试扩展（既有 7 it + 新增 3 it 确认既有行为），Task 2 是文档登记，无 RED/GREEN/REFACTOR 循环。N/A。

## Known Stubs

无。本 plan 仅扩展单测 + 加固脱敏正则 + 写甄别文档，无 UI 渲染/数据源/占位符相关 stub。

## Threat Flags

无新增安全相关表面超出 plan threat_model 范围。Task 1 deviation（sanitizeMessage 加固）是**减少**威胁表面（异常脱敏覆盖更广），非新增。

## Self-Check

- [x] `tests/unit/authGuard.test.ts` 存在（既有文件，已扩展 3 it）
- [x] `electron/utils/authGuard.ts` 存在（既有文件，sanitizeMessage 已加固）
- [x] `.planning/phases/13-security-hardening-cluster/13-02-DEFER-LOG.md` 存在（Task 2 新建）
- [x] commit `9096853` 存在（Task 1: test + sanitizeMessage 加固）
- [x] commit `82d30b4` 存在（Task 2: DEFER-LOG）

## Self-Check: PASSED

---

*Generated: 2026-08-09 by Plan 13-02 executor (sequential, main working tree)*
