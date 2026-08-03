---
phase: 09-human-review-confirmation
plan: 01
subsystem: experience-service
tags: [experience, review, draft, transaction, quality-gate]
requires:
  - "Phase 7 experiences 表 + ExperienceService 函数式基线（invalidateExperience/deleteExperience/relateDevice/listExperiences）"
  - "Phase 8 v9 迁移 experiences.duplicate_of_exp_id 列"
  - "ai.ts getChatHistory（decField 解密 chat_history.content_enc 返明文）"
provides:
  - "experienceService.confirmDrafts（批量 draft→published + supersede + discard + 设备 diff 单事务原子）"
  - "experienceService.listDrafts（status=draft 草稿列表）"
  - "experienceService.getSessionMessages（会话原文明文回链）"
  - "ConfirmDraftItem / ConfirmDraftsInput / ConfirmDraftsResult 接口（Plan 02 IPC + Plan 03 renderer 复用）"
affects:
  - "Plan 02 experienceIpc.ts（注册 experience:confirmDrafts/listDrafts/getSessionMessages secure channel）"
  - "Plan 03 ReviewConfirmModal.tsx（renderer 调 confirmDrafts 提交）"
tech-stack:
  added: []
  patterns:
    - "受控状态接口模式扩展（draft→published 专用接口，不动 CR-01 update 白名单）"
    - "db.transaction 单事务多写原子（adopt+supersede+discard+设备 diff 全成全败，throw ROLLBACK）"
    - "Prepared Statement 循环外复用（stmtPublish）"
    - "service 层兜底质量门（troubleshooting severity/symptoms/resolution + 轻结构 title/content）"
    - "设备关联 diff 防默认空数组静默拆关联（仅 length>0 显式数组触发）"
key-files:
  created: []
  modified:
    - "electron/services/experienceService.ts"
    - "electron/services/experienceService.test.ts"
decisions:
  - "扩现有 experienceService.ts 而非新建 reviewService（同函数式 + 同 MK 作用域 + 同 db getter，最小改动）"
  - "confirmDrafts 单事务原子包 adopt/supersede/discard/设备 diff（D-9-4），throw ROLLBACK 全成全败"
  - "relateDevices 语义：undefined 或空数组都视为不动现有关联，仅 length>0 显式数组触发 diff（防 renderer 默认值传播拆光所有现有关联）"
  - "supersedeOld 默认 false（防 Phase 8 AI 误判 UPDATE 实为 ADD 误删有效旧条目），用户主动勾选才 invalidateExperience 旧条目（D-9-2）"
  - "MemDb mock 增强：transaction 加 ROLLBACK 语义（snapshot/restore）+ UPDATE 分词括号感知 tokenizer"
metrics:
  duration: ~6min
  completed: 2026-08-03
  tasks: 2
  files: 2
  tests-added: 19
  tests-total: 165
---

# Phase 9 Plan 01: 服务层 confirmDrafts/listDrafts/getSessionMessages Summary

服务层落地 session→permanent 唯一人工闸口的 3 个函数式受控接口——`confirmDrafts`（批量 draft→published + 可选 supersede 旧条目 + discard hard delete + 设备关联 diff，单事务原子全成全败，service 层兜底质量门二次校验 severity/symptoms/resolution），`listDrafts`（列暂存 draft），`getSessionMessages`（复用 getChatHistory 明文回链）。不动 CR-01 收紧的 updateExperience 白名单——status 改变只走专用接口 draft→published。

## What Was Built

### `electron/services/experienceService.ts`（+138 行）

新增 3 个 export function + 3 个 TypeScript 接口：

- **`confirmDrafts(input: ConfirmDraftsInput): ConfirmDraftsResult`** —— 批量确认草稿，单事务原子：
  - 入参校验：`drafts` 必须为数组，`length > MAX_BATCH(1000)` throw
  - `action='adopt'`：service 层兜底质量门（troubleshooting 校验 severity/symptoms/resolution，轻结构校验 title/content）→ 若 `fields` 非空走 `updateExperience` 落编辑字段（CR-01 白名单，不含 status）→ `UPDATE experiences SET status='published'` 专用单语句（循环外 prepared statement 复用）→ 设备关联 diff（仅 `relateDevices.length>0` 显式数组触发，防默认空数组拆关联）→ 若 `supersedeOld=true` 且 `duplicate_of_exp_id` 非空调 `invalidateExperience` 旧条目软失效
  - `action='discard'`：调 `deleteExperience`（hard DELETE FROM，D-9-6）
  - 返回 `{ adopted, discarded, superseded }` 计数
  - `db.transaction(() => {...})()` 包裹全部多写，throw 即 ROLLBACK（全成全败，D-9-4）
- **`listDrafts(): any[]`** —— 复用 `listExperiences({ status:'draft', includeInvalid:true, limit:MAX_BATCH, offset:0 })` 的 `.rows`（D-9-7）
- **`getSessionMessages(sessionId): Array<{id,role,content,deviceId,createdAt}>`** —— sessionId 非法（空/非 string）throw，否则 `import { getChatHistory } from './ai'` 复用解密明文回链（D-9-5）
- **`ConfirmDraftItem` / `ConfirmDraftsInput` / `ConfirmDraftsResult`** 接口（Plan 02 IPC + Plan 03 renderer DTO 对齐）

新增 `import { getChatHistory } from './ai'`（key_links 验证）。

### `electron/services/experienceService.test.ts`（+301 / -4 行）

新增 3 个 describe 块共 19 测试：

- **`describe('confirmDrafts')` 15 测试**：adopt 转 published / troubleshooting 缺 severity throw / 缺 symptoms throw / 缺 resolution throw / 轻结构缺 title throw / 缺 content throw / discard hard DELETE / supersedeOld=true 旧条目 invalidate / supersedeOld=false 默认旧条目保留 / 单事务原子 ROLLBACK（第一条 throw 回滚不落 published）/ MAX_BATCH throw / fields 编辑落库 / relateDevices diff（dev1→dev2）/ relateDevices 空数组不动关联 / relateDevices undefined 不动关联
- **`describe('listDrafts')` 1 测试**：返回 status=draft 全部草稿（过滤 published）
- **`describe('getSessionMessages')` 3 测试**：明文数组回链 / sessionId 不存在返空 / 非法 sessionId（空/null）throw

**MemDb mock 增强**（支撑新测试，非新业务）：
- `transaction` 加 ROLLBACK 语义：fn throw 时 snapshot/restore 回滚所有表行（复刻 better-sqlite3 真实行为，支撑单事务原子性测试）
- UPDATE SET 分词改用括号/引号感知 `tokenizeValues`（处理 `status='published', updated_at=datetime('now','localtime')` 内含逗号不被误分），并处理 `'literal'` 字符串字面量去引号

### Test Results

- 本 plan：43/43 pass（24 既有 + 19 新增）
- 全套：165/165 pass（既有 146 + 新 19，零回归）
- 三绿门禁：tsc（tsconfig.web.json strict + noUnusedLocals）exit 0 / esbuild main bundle 1.9mb / vitest 165 全过

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MemDb mock transaction 无 ROLLBACK 语义 + UPDATE 分词不处理内含逗号的字面量**

- **Found during:** Task 2（运行测试时单事务原子用例 + supersede 用例失败）
- **Issue:** 既有 `MemDb.transaction` 是 `() => fn()`——fn throw 时突变不回滚，无法验证 `confirmDrafts` 单事务原子的 ROLLBACK 语义；既有 UPDATE SET 分词用 `setClause.split(',')`——遇到 `datetime('now','localtime')` 内含逗号被误分为多段，导致 `UPDATE experiences SET status='published', updated_at=datetime('now','localtime')` 解析错乱
- **Fix:**
  - `transaction` 改 snapshot（深拷贝所有表行 + autoindex + userVersion）→ fn() → throw 时 restore，复刻 better-sqlite3 ROLLBACK
  - UPDATE SET 分词改用既有 `tokenizeValues`（括号/引号感知分词器），新增 `'literal'` 字符串字面量去引号分支
- **Files modified:** `electron/services/experienceService.test.ts`
- **Commit:** d307b75

**2. [Rule 1 - Bug] createExperience 不写 invalid_at 列，mock 行缺该字段 → supersedeOld=false 用例断言 null 失败**

- **Found during:** Task 2（supersedeOld=false 旧条目 invalid_at 断言失败，收到 undefined 期望 null）
- **Issue:** `createExperience` INSERT 列不含 `invalid_at`，真实 SQLite DEFAULT NULL 兜底，但 mock 行无该字段 → `getExperience` 返回无 invalid_at key（undefined）
- **Fix:** 断言改 `toBeFalsy()`（falsy 涵盖 null + undefined，语义等价于「未失效」），测试名同步改「invalid_at 仍 falsy」
- **Files modified:** `electron/services/experienceService.test.ts`
- **Commit:** d307b75

**3. [Rule 3 - Blocking] `require('../utils/crypto')` 在 vitest ESM 环境下模块解析失败**

- **Found during:** Task 2（缺 symptoms/resolution 用例需造 severity 合法但缺其他字段的 attrs_enc 密文）
- **Issue:** 测试内 `const { encField } = require('../utils/crypto')` 在 vitest 转译后路径解析失败（Cannot find module）
- **Fix:** 改为文件顶部 `import { encField } from '../utils/crypto'`（ESM 顶层 import），移除两处内联 require
- **Files modified:** `electron/services/experienceService.test.ts`
- **Commit:** d307b75

## Known Stubs

无。所有接口完整落地，无占位/TODO/FIXME。

## Threat Flags

无新增威胁面（与 plan `<threat_model>` 一致）：

- T-09-01 mitigate 落地：`confirmDrafts` 入参 MAX_BATCH throw + service 层兜底质量门（15 测试覆盖全部 throw 分支）
- T-09-02 accept：单事务原子 ROLLBACK（snapshot/restore mock 测试覆盖）+ updated_at 自动落时间审计
- T-09-03 accept：`getSessionMessages` 明文回链（design D-04 设计意图，单机 safeStorage，3 测试覆盖边界）
- T-09-04 mitigate 落地：`confirmDrafts` 不复活 updateExperience 的 status 字段，status 改变只走专用 `UPDATE experiences SET status='published'` 单语句（与 invalidateExperience 同受控接口模式）

## Self-Check: PASSED

- 文件存在性：
  - `electron/services/experienceService.ts` FOUND
  - `electron/services/experienceService.test.ts` FOUND
  - `.planning/phases/09-human-review-confirmation/09-01-SUMMARY.md` FOUND
- Commit 存在性：
  - 455721d（feat 实现）FOUND
  - d307b75（test 单测）FOUND
- 验收门禁：tsc exit 0 / esbuild 1.9mb / vitest 165 全过（既有零回归）/ acceptance_criteria grep 全 1
