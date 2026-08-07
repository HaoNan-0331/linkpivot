---
phase: quick
plan: 260807-gfk
subsystem: security-hardening
tags: [security, hardening, migration, anti-hallucination]
requires:
  - ai_system_logs 表（v1-v10 迁移基线）
  - draftingService.validateDrafts（Phase 8 08-02）
provides:
  - v11 ai_system_logs.type CHECK widen security 迁移（双路径一致）
  - validateDrafts FORBIDDEN_MARKERS 反幻觉标记扫描守卫（WR-01 代码层强制）
  - migrations.test.ts（v11 迁移测试范式）
affects:
  - main.ts setDecryptFailureHandler（type:'security' 日志不再被 CHECK 吞）
  - experienceDrafting.ts relateDevice 失败告警（同上）
  - draftSession 重试循环（消费 validateDrafts ok:false 续轮）
tech-stack:
  added: []
  patterns:
    - sqlite_master sql-content 特征串幂等守卫（第二形式，与 v5/v6/v7 同构，不靠 user_version）
    - db.transaction 包裹 DDL（throw 即 ROLLBACK）
    - 双路径 DDL 逐字一致（fresh-install init.ts + 迁移重建 migrations.ts）
    - mock-DB 桩规避 DEP-1 native binding ABI 冲突（与 experienceService.test.ts 范式一致）
    - String.includes 固定字面量扫描（不引入正则，标记是常量）
key-files:
  created:
    - electron/database/migrations.test.ts
  modified:
    - electron/database/migrations.ts
    - electron/database/init.ts
    - electron/services/draftingService.ts
    - electron/services/draftingService.test.ts
    - CHANGELOG.md
decisions:
  - v11 迁移抄 v6 rebuild 范式（CREATE _new + INSERT…SELECT + DROP + RENAME）非 ALTER，因 SQLite 不能直接改 CHECK 约束
  - 幂等守卫用 sqlite_master sql 含 'security' 判定（第二形式），不靠 user_version（CONVENTIONS 红线）
  - validateDrafts 扫 title/content/reasoning 三字段不扫 attrs/tags（attrs.command[] 二期结构化字段避免误伤）
  - 双路径 DDL 一致性测试用 fs.readFileSync 抽源码字符串做特征 includes 双断言（不动 init.ts 函数契约，避免 Rule 4 架构变更）
  - extractV11CreateNewDdl 从 'export const v11' 起搜（migrations.ts 内 v6/v11 两个 ai_system_logs_new CREATE 块，避免误抽 v6）
metrics:
  duration: ~6min
  completed: 2026-08-07
  tasks: 3/3
  files: 6
---

# Phase quick Plan 260807-gfk: 安全 hardening B（validateDrafts 标记门禁 + ai_system_logs CHECK widen security）Summary

把体检报告 §1.1 真 high 第 4 项（WR-01 反幻觉红线 prompt→代码层强制）+ 第 5 项（ai_system_logs.type CHECK 不含 security 致告警日志落空）两个安全根因代码层闭环。三红线（IPC 鉴权 / 字段加密 / commandSafety）零触碰。

## What Was Built

### #5 ai_system_logs.type CHECK widen security（v11 迁移双路径一致）

- **根因**：`ai_system_logs.type` CHECK 在 fresh-install（init.ts:87）+ v6 重建（migrations.ts:143）两处均 `('discovery','acl','migration','backup')`，不含 `'security'`。但 `main.ts:96-102 setDecryptFailureHandler`（R2 字段解密失败告警）+ `experienceDrafting.ts:130-145 relateDevice` 失败告警（WR-02 fix）写 `type:'security'` 撞 `SQLITE_CONSTRAINT_CHECK` 被外层 try/catch 吞 → 解密失败告警 + 经验关联失败告警**全部落空**（无声数据丢失，审计盲区）。
- **v11 迁移**（migrations.ts:296-336）：抄 v6 rebuild 范式——`DROP _new → CREATE _new`（CHECK widen 含 `'security'`，其余 10 列 + status CHECK + DEFAULT + created_at 与 init.ts fresh-install DDL 逐字一致）`→ INSERT…SELECT` copy 全 10 列 `→ DROP old → RENAME`，全包 `db.transaction`（throw ROLLBACK）。幂等守卫：`SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_system_logs'`，sql 含 `'security'` 则 no-op 早返（与 v5 查 'rdp'、v6 查 'warning'、v7 查 'WHEN' 同构第二形式，不靠 user_version）。`db.pragma('user_version = 11')`。
- **init.ts:87 fresh-install DDL**：CHECK 同步加 `'security'`（双路径逐字一致，CONVENTIONS 红线）。
- **注册完整性**：`MIGRATION_HEAD` 10→11；MIGRATIONS 注册表加 `{ version: 11, name: 'ai_system_logs CHECK widen security (R2 decrypt-failure + exp relate-failure log)', run: v11 }`。
- **export**：v11 加 `export const v11` 关键字（与现有 const 风格一致，最小侵入），供测试 import。
- **caveat**：迁移在 MK 注入前跑（migrateAndSecure 早于 setXxxMasterKey），不解密（本迁移也不碰加密列，只改 CHECK 约束）。

### #4 validateDrafts [CMD]/[KB_SEARCH] 标记扫描（WR-01 反幻觉红线代码层强制）

- **根因**：`validateDrafts`（schema Gate）原只在 system prompt 文字禁止 `[CMD]`/`[KB_SEARCH]` 标记（draftingService.ts:61），校验函数本身不扫。LLM 不遵守提示时含执行标记的草稿静默落库 → Phase 9 浏览页 / 未来执行层可能误执行。
- **修复**（draftingService.ts:27-35 + 152-160）：模块顶加 `FORBIDDEN_MARKERS = ['[CMD]', '[KB_SEARCH]']`；`validateDrafts` 在 confidence 校验后、`drafts.push` 前扫 `title/content/reasoning` 三字段拼接（`String.includes` 固定字面量，不引入正则），命中返 `{ ok:false, error: '第 N 条含禁止标记 X（反幻觉红线）' }` 进 `draftSession` MAX_DRAFT_RETRIES 重试。
- **不扫 attrs/tags**：attrs.command[] 二期结构化字段可能含合法命令，tags 数组元素亦可能含字面量，避免误伤。
- **prompt 文字禁止保留**：SYSTEM_PROMPT 第 61 行「禁止输出 [CMD]、[KB_SEARCH] 等执行标记」不动，作双保险。
- **draftSession 重试循环零改动**：已消费 validateDrafts 的 ok:false 进 lastError 续轮。

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | ai_system_logs.type CHECK 扩 security（v11 迁移 + 双路径一致） | 5a824cd | migrations.ts / init.ts |
| 2 | validateDrafts 加 [CMD]/[KB_SEARCH] 标记扫描（WR-01） | 8af620b | draftingService.ts |
| 3 | 新增测试（v11 + validateDrafts 标记）+ 四绿门禁 + CHANGELOG | 11f8f57 | migrations.test.ts(new) / draftingService.test.ts / CHANGELOG.md |

## Deviations from Plan

### 偏离 1：TDD gate 顺序（PLAN task 编排冲突）

- **plan 描述**：Task 1/2 标 `tdd="true"`（应 RED→GREEN），但 Task 1/2 的 `<verify>` 指向 `migrations.test.ts`（Task 3 才创建）；PLAN 实际把所有测试集中在 Task 3。
- **执行**：照 PLAN 显式编排执行——Task 1/2 先实现代码（GREEN），Task 3 集中写测试（含 Task 1/2 覆盖）。这是 PLAN 的显式 task 划分，非执行器自作主张。
- **TDD gate 合规性**：本 plan `type: execute` 非 `type: tdd`（plan-level TDD gate 不强制）；gate 序列在 git log 体现为 `fix(...)` 两 commit（实现）后 `test(...)` 一 commit（测试），与标准 RED→GREEN 序相反，但 PLAN 显式编排如此。记录此偏离供 verifier 知晓。

### 偏离 2：双路径 DDL 一致性测试实现方式（避免 Rule 4）

- **plan 描述**：用例 3「v11 CREATE _new DDL 双路径一致」建议「从 migrations.ts 抽出 v11 的 CREATE _new DDL 字符串与 init.ts:87 fresh-install ai_system_logs DDL 字符串做关键特征比对」，并提到「可用字符串常量提取或直接 .includes 双断言」。
- **plan 备选**：「import 路径 `import { v11 } from './migrations'`——但 v11 当前是模块内 const 非 export…改 migrations.ts 把 v11 加入 export」（v11 export 我已落实）；plan 还提到「或导出一个内部测试入口 `export const __test_v11 = v11`」。
- **执行选择**：v11 已 export（plan 优先选项）；init.ts DDL 提取**未**走「改 init.ts export createTablesSource 常量」方案（会改 init.ts 函数契约 + 引入仅测试消费的 export，属 Rule 4 架构变更范围），改用 `fs.readFileSync` 读 init.ts 源码字符串抽 `CREATE TABLE IF NOT EXISTS ai_system_logs ( ... );` 块（与 migrations.ts 抽取同范式，零改 init.ts）。
- **额外坑**：migrations.ts 内有 v6/v11 **两个** `CREATE TABLE ai_system_logs_new (` 块，`indexOf` 取第一个会误抽 v6（不含 security）。`extractV11CreateNewDdl` 从 `'export const v11'` 起搜定位 v11 函数体，避免误抽。此坑在第一次跑测试时暴露（用例 3 红），修复后绿。

### 偏离 3：新增 MIGRATION_HEAD=11 静态守卫用例（plan 之外）

- **plan 用例数**：v11 迁移测试 ≥3 用例（幂等 no-op + 执行 DDL 序 + 双路径一致）。
- **执行**：加了第 4 用例 `MIGRATION_HEAD=11（注册完整性静态守卫，防 bump 漏改）`。Rule 2（auto-add missing critical functionality）——MIGRATION_HEAD 漏 bump 是迁移类改动的高频回归源，静态守卫低成本高价值。共 4 用例（plan ≥3 满足）。

### 偏离 4：validateDrafts 标记测试用例数（plan 之外）

- **plan 用例数**：validateDrafts 标记 ≥4 用例（[CMD]/[KB_SEARCH] 三字段覆盖 + 控制组）。
- **执行**：加 8 用例——[CMD] 三字段（content/title/reasoning）+ [KB_SEARCH] 两字段（title/reasoning）+ 控制组（正常 troubDraft/prodDraft 不回归）+ attrs/tags 含标记字面量不误伤（验证「不扫 attrs/tags」语义）+ draftSession 集成（连续 3 次返含标记草稿重试后 throw）。覆盖度高于 plan 最小要求，验证守卫边界更完整。共 8 用例（plan ≥4 满足）。

## Verification Results

### 四绿门禁（零回归硬门禁，全绿）

| 门禁 | 命令 | 结果 |
| ---- | ---- | ---- |
| tsc strict + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 |
| vitest 全量 | `npx vitest run` | **244/244 PASS**（原 232 + v11 新 4 + validateDrafts 新 8） |
| electron-main bundle | `npm run build:electron-main` | exit 0（dist-electron/main.js 1.9mb） |
| vite build renderer | `npx vite build` | exit 0 |

### Plan `<verification>` grep 断言全通过

- `grep -c "FORBIDDEN_MARKERS" electron/services/draftingService.ts` = **2**（≥1 ✓）
- `grep -c "'security'" electron/database/init.ts` = **1**（≥1 ✓，双路径之一）
- `grep -c "'security'" electron/database/migrations.ts` = **5**（≥1 ✓，v11 CREATE _new DDL + 守卫 + 注释）
- `grep "MIGRATION_HEAD = 11" electron/database/migrations.ts` 命中 ✓
- `grep "version: 11" electron/database/migrations.ts` 命中（注册表项）✓
- 双路径 `CHECK(type IN ('discovery','acl','migration','backup','security'))` 串逐字相等 ✓（测试用例 3 静态守卫）
- 三红线零触碰：本任务 3 commit 精确改动 6 文件（migrations.ts/init.ts/draftingService.ts + migrations.test.ts/draftingService.test.ts + CHANGELOG.md），`electron/ipc/` / `electron/utils/crypto.ts` / `electron/utils/keyManager.ts` / `electron/utils/commandSafety.ts` / `electron/utils/authGuard.ts` 零改动 ✓

## Decisions Made

详见 frontmatter `decisions` 字段。核心：

1. **v11 用 rebuild 范式非 ALTER**：SQLite 不支持直接改现有列的 CHECK 约束，必须重建表（与 v6 同款）。
2. **幂等守卫第二形式（sqlite_master sql 特征串）**：与 v5/v6/v7 同构，不靠 user_version（CONVENTIONS 红线 + D-14）。
3. **validateDrafts 扫三正文字段不扫 attrs/tags**：attrs.command[] 二期结构化字段含合法命令，避免误伤；标记是固定字面量用 String.includes 不引入正则。
4. **双路径一致性测试用 fs 抽源码字符串**：不动 init.ts 函数契约（避免 Rule 4 架构变更）。
5. **extractV11CreateNewDdl 从 'export const v11' 起搜**：migrations.ts 内 v6/v11 两个 ai_system_logs_new CREATE 块，避免误抽 v6。

## Self-Check: PASSED

### 创建文件存在

- `electron/database/migrations.test.ts` — FOUND ✓

### 修改文件存在

- `electron/database/migrations.ts` — FOUND ✓（MIGRATION_HEAD=11 + v11 export + 注册表项）
- `electron/database/init.ts` — FOUND ✓（fresh-install DDL CHECK 含 'security'）
- `electron/services/draftingService.ts` — FOUND ✓（FORBIDDEN_MARKERS + validateDrafts 守卫）
- `electron/services/draftingService.test.ts` — FOUND ✓（+8 用例）
- `CHANGELOG.md` — FOUND ✓（顶部新条目）

### Commits 存在

- `5a824cd` — FOUND ✓（fix(security): ai_system_logs.type CHECK widen security v11 迁移）
- `8af620b` — FOUND ✓（fix(security): validateDrafts 加 [CMD]/[KB_SEARCH] 反幻觉标记扫描）
- `11f8f57` — FOUND ✓（test(security): v11 迁移 + validateDrafts 标记测试 + CHANGELOG）

### 测试结果

- migrations.test.ts: 4/4 PASS
- draftingService.test.ts: 32/32 PASS（原 24 + 新 8）
- 全量 vitest: 244/244 PASS（零回归）

## Known Stubs

无。本任务是安全 hardening（迁移 + 守卫 + 测试），无未接线数据流。
