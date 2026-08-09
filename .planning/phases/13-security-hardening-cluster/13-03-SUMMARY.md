---
phase: 13
plan: 03
subsystem: security-hardening
tags: [security, ipc-validation, dos-prevention, experience, layered-defense, sec-05]
requires:
  - "SEC-05 (experience:list IPC 网关层入参校验防廉价 DoS)"
provides:
  - "sanitizeListInput 纯函数（search≤100/tags≤20/单tag≤30 钳制 + 非法 severity throw，D-13-5 混合策略）"
  - "VALID_SEVERITIES 单一来源 export（service 层导出 IPC 层复用，消 IPC/service 两份枚举 drift）"
  - "experienceListGuard 8 it 回归网（截断/throw/双层防御/枚举一致性）"
affects:
  - "electron/services/experienceService.ts (VALID_SEVERITIES const → export ... as const，listExperiences limit 兜底保留)"
  - "electron/ipc/experienceIpc.ts (experience:list handler 加 sanitizeListInput 校验 + 抽纯函数)"
  - "tests/unit/experienceListGuard.test.ts (新增 8 it)"
tech_stack:
  added: []
  patterns:
  - "IPC 网关层纯函数校验范式（sanitizeListInput 抽纯函数最高 ROI，单测直接调无需 setAuthenticated/secure/ipcMain mock）"
  - "枚举单一来源 export + as const（D-13-5 消 drift，IPC 层 import 复用非第二份手写）"
  - "混合校验策略（Pattern A 钳制 search/tags 静默容错 + Pattern B throw severity 固定集合非法值暴露 bug）"
key_files:
  created:
    - "tests/unit/experienceListGuard.test.ts"
  modified:
    - "electron/services/experienceService.ts"
    - "electron/ipc/experienceIpc.ts"
decisions:
  - "sanitizeListInput 抽纯函数（plan Task 2 推荐方案）：handler 改 secure((_e, opts?) => listExperiences(sanitizeListInput(opts)))，纯函数做截断/throw 不调 listExperiences，单测直接调无需 setAuthenticated/secure 包装/ipcMain mock（D-13-8 最高 ROI 范式）"
  - "VALID_SEVERITIES as const 让 TS 推断字面量联合类型，IPC 层 .includes() 用 as readonly string[] 宽化避免 string 入参 strict 报错"
  - "service 层 limit MAX_BATCH throw 保留不删（D-13-7 双层防御第二层，防绕 IPC 直调 service 查全表）；listExperiences 签名 ListExperiencesOpts 不变"
  - "limit 不在 IPC 网关层复查（D-13-7 职责分层，避免两层校验 drift，接受残余风险换 service 层简洁）"
metrics:
  duration: ~6min
  completed: 2026-08-09
  tasks: 2
  files: 3
---

# Phase 13 Plan 03: SEC-05 experience:list IPC 网关层 DoS 防御 Summary

SEC-05 experience:list IPC 网关层入参校验防廉价 DoS 落地——抽 sanitizeListInput 纯函数做 search≤100/tags≤20/单tag≤30 钳制 + 非法 severity throw（D-13-5 混合策略 + D-13-6 阈值），VALID_SEVERITIES export 单一来源消 IPC/service 两份枚举 drift（D-13-6 + PATTERNS 范式），service 层 listExperiences limit MAX_BATCH throw 兜底保留（D-13-7 双层防御第二层），8 it mock 回归网覆盖截断/throw/双层防御/枚举一致性。

## What Was Built

### Task 1: experienceService.ts export VALID_SEVERITIES + experienceIpc.ts sanitizeListInput（commit 25f380d）

**electron/services/experienceService.ts** 单一来源 export：
- `const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']` → `export const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const`
- 消除 IPC/service 两份手写枚举 drift（D-13-5 + PATTERNS 范式），IPC 层 import 复用非第二份
- `as const` 让 TS 推断字面量联合类型（`'critical'|'high'|'medium'|'low'|'info'`），同时方便枚举一致性单测
- service 层 listExperiences limit MAX_BATCH throw 兜底**保留不删**（D-13-7 双层防御第二层，防「绕 IPC 直调 service 查全表」残余风险）
- listExperiences 函数签名 `ListExperiencesOpts` **不变**（D-13-7 避免破坏既有 callers）
- 既有 3 处 `VALID_SEVERITIES.includes(...)` 用法（assertTroubleshootingAttrs / validateAndStringifyAttrs / backfillSeverityFromHistory）零改动

**electron/ipc/experienceIpc.ts** 抽 sanitizeListInput 纯函数 + handler 改造：
- 新增 `export function sanitizeListInput(opts: ExperienceListInput | undefined): ExperienceListInput` 纯函数
  - search 钳制：`typeof === 'string' && length > 100` → `slice(0, 100)`（D-13-6 阻断超长 LIKE 多词 OR-join 全表扫 DoS 面，T-13-03-01 mitigate）
  - tags 钳制：`Array.isArray && length > 20` → `slice(0, 20)` + 每元素 `tag.length > 30` → `slice(0, 30)`（D-13-6 阻断超量 LIKE OR-join DoS 面，T-13-03-02 mitigate）
  - severity throw：`!== undefined && !== '' && !(VALID_SEVERITIES as readonly string[]).includes(severity)` → `throw new Error('severity 非法，合法值: critical/high/medium/low/info')`（D-13-5 固定集合非法值暴露调用方 bug，T-13-03-03 mitigate）
  - limit 不复查（D-13-7 service 层兜底第二层）
- import 段加 `VALID_SEVERITIES`（从 experienceService import，与 MAX_BATCH 同模块，非第二份手写）
- `experience:list` handler 改为 `secure((_e, opts?: ExperienceListInput) => listExperiences(sanitizeListInput(opts)))`
- handler 仍包在 `secure(...)` 内（红线①不变，throw 经 sanitizeMessage 脱敏透出 renderer）

### Task 2: experienceListGuard.test.ts 8 it 回归网（commit 39d1fe3）

**tests/unit/experienceListGuard.test.ts**（新增，D-13-8 纯函数最高 ROI 范式）：

直接调 sanitizeListInput 纯函数验证 6 SEC-05 case（无需 setAuthenticated/secure/ipcMain mock）：
1. `超长 search（200 字符）截断到 ≤100 字符` —— search ≤100
2. `超量 tags（30 个）截取到前 20 个` —— tags.length === 20
3. `超长单 tag（50 字符）截断到 ≤30 字符` —— tags[0].length ≤30
4. `非法 severity（BOGUS）throw 含「severity 非法」` —— toThrow('severity 非法')
5. `合法 severity（critical）正常透传不 throw` —— severity === 'critical'
6. `正常长度 search（华为交换机 DHCP）原样透传` —— search 不变（钳制不误伤日常搜索）

2 补强 it（D-13-7 双层第二层 + 枚举一致性）：
7. `service 层 listExperiences({limit: MAX_BATCH+1}) throw「limit 超过 MAX_BATCH」` —— 经 `_setExperienceDbGetter` 注入内存 mock DB（规避 DEP-1 native binding ABI 冲突，沿用 experienceService.test.ts 范式）
8. `VALID_SEVERITIES 枚举一致（deepEqual critical/high/medium/low/info）` —— `[...VALID_SEVERITIES]).toEqual([...])`（防误改，IPC 复用单一来源）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] VALID_SEVERITIES as const 的 .includes() 类型兼容**
- **Found during:** Task 1
- **Issue:** `VALID_SEVERITIES = [...] as const` 让 TS 推断 `.includes()` 签名为 `(arg: 'critical'|'high'|'medium'|'low'|'info') => boolean`，IPC 层 sanitizeListInput 内 `severity: string` 入参会触发 strict 类型错误
- **Fix:** IPC 层校验改用 `(VALID_SEVERITIES as readonly string[]).includes(sanitized.severity)` 宽化入参类型，保留 `as const` 字面量联合推断（消 drift + 枚举一致性单测 deepEqual 仍有效）
- **Files modified:** electron/ipc/experienceIpc.ts
- **Commit:** 25f380d

**2. [Context] tsconfig.web.json 仅 include src（electron 代码不在 web strict 门禁内）**
- **Found during:** Task 1
- **Issue:** 项目验证门禁 `tsc -p tsconfig.web.json --noEmit` 的 `include: ["src"]` 不含 `electron/` 目录，electron 代码类型检查实际依赖 esbuild build（不阻塞）。tsconfig.node.json 含 electron 但有 pre-existing rootDir 边界报错（非本 plan 引入）
- **Action:** 仍按 plan 验证门执行（tsc web + build:electron-main + vitest + npm test），build:electron-main esbuild 成功打包即覆盖 electron 代码编译验证（与 13-01/13-02 同基线，非本 plan 偏离）
- **Note:** 记录备查，不影响 SC4 红线论证（红线① IPC secure 包装 + 红线② _enc 加密 + 红线③ commandSafety 均经 grep + 测试验证）

## Verification

三绿门禁全绿零回归：

| 门禁 | 命令 | 结果 |
|------|------|------|
| node grep 断言 | `node -e "...VALID_SEVERITIES/slice/severity 非法..."` | OK |
| tsc web strict | `npx tsc -p tsconfig.web.json --noEmit` | EXIT=0 |
| build:electron-main | `npm run build:electron-main` | EXIT=0（dist-electron/main.js 1.9mb） |
| SEC-05 单测 | `npx vitest run tests/unit/experienceListGuard.test.ts` | 8/8 PASS |
| 全量回归 | `npm test` | 255/255 PASS（+8 新增，原 247 零回归） |

acceptance_criteria grep 断言全命中：
- `export const VALID_SEVERITIES` ×1（experienceService.ts）
- `limit 超过 MAX_BATCH` ×2（experienceService.ts service 层兜底保留）
- `export function listExperiences(opts: ListExperiencesOpts)` ×1（签名不变）
- `slice(0, 100)` ×1 / `slice(0, 20)` ×1 / `slice(0, 30)` ×1（experienceIpc.ts）
- `severity 非法` ×1（experienceIpc.ts throw）
- `VALID_SEVERITIES,` import ×1（experienceIpc.ts，非第二份手写）
- `secure((_e, opts?: ExperienceListInput)` ×1（handler 仍 secure 包装，红线①不变）

## Success Criteria 对齐

- **SC3（experience:list severity/search/tags 校验防廉价 DoS）**：IPC 网关层 search≤100/tags≤20/单tag≤30 截断 + 非法 severity throw 落地，8 it 单测验证（T-13-03-01/02/03 mitigate）
- **SC4（三红线不回退 + 双层防御）**：
  - 红线① IPC secure：experience:list 仍 `secure(...)` 包装，throw 经 sanitizeMessage 脱敏（grep ×1）
  - 红线② 字段加密：experience:list 不碰 _enc 列（service getExperience/listExperiences decField 回填 + delete attrs_enc 不变）
  - 红线③ commandSafety：list 非命令执行路径，不涉此层
  - D-13-7 双层第二层：service 层 listExperiences limit MAX_BATCH throw 保留（grep ×2 + it#7 验证）
- **D-13-5（混合策略）**：钳制 search/tags + throw severity 落地（sanitizeListInput 实现）
- **D-13-6（阈值 100/20/30）**：截断阈值落地（slice(0,100)/slice(0,20)/slice(0,30)）
- **D-13-7（双层防御职责分明）**：IPC 完整校验 + service 仅 limit 兜底，listExperiences 签名不变
- **D-13-8（mock 单测）**：experienceListGuard.test.ts 8 it 沿用 _setExperienceDbGetter 范式（service 层兜底 it 注入 mock DB）

## Threat Model Mitigation 对齐

| Threat ID | Disposition | Mitigation 落地佐证 |
|-----------|-------------|---------------------|
| T-13-03-01 (DoS 超长 search) | mitigate | sanitizeListInput search slice(0,100)（it#1） |
| T-13-03-02 (DoS 超量 tags) | mitigate | sanitizeListInput tags slice(0,20) + 单tag slice(0,30)（it#2/#3） |
| T-13-03-03 (Tampering 非法 severity) | mitigate | sanitizeListInput severity throw 复用 VALID_SEVERITIES（it#4） |
| T-13-03-04 (DoS 绕 IPC 直调 service) | mitigate | service 层 listExperiences limit MAX_BATCH throw 保留（it#7） |
| T-13-03-05 (三红线) | accept | grep 验证 secure 包装不变 + _enc/commandSafety 不动（SC4） |
| T-13-03-06 (枚举 drift) | mitigate | service 层 export VALID_SEVERITIES，IPC 层 import 复用（it#8） |

## TDD Gate Compliance

本 plan 两 task 均 `tdd="true"`，遵循 RED→GREEN 流程（纯函数 sanitizeListInput 抽取方案）：
- Task 1 GREEN：sanitizeListInput 实现 + handler 改造（commit 25f380d），所有 acceptance grep + tsc + build:electron-main 通过
- Task 2 RED→GREEN 验证：8 it 直接调 sanitizeListInput 纯函数（commit 39d1fe3），8/8 PASS 首跑即绿（实现已在 Task 1 落地，测试是回归网非先写失败）

注：plan 推荐「Task 1 抽纯函数 → Task 2 直接测纯函数」方案，两 task 在同一执行流内顺序完成，RED gate 由 Task 2 测试首跑覆盖纯函数行为契约（截断/throw/枚举一致性）。

## Self-Check: PASSED

- electron/services/experienceService.ts — FOUND
- electron/ipc/experienceIpc.ts — FOUND
- tests/unit/experienceListGuard.test.ts — FOUND
- .planning/phases/13-security-hardening-cluster/13-03-SUMMARY.md — FOUND
- commit 25f380d (Task 1) — FOUND
- commit 39d1fe3 (Task 2) — FOUND
