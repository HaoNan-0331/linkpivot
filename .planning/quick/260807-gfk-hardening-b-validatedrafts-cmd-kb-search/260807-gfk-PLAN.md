---
phase: quick
plan: 260807-gfk
type: execute
wave: 1
depends_on: []
files_modified:
  - electron/database/migrations.ts
  - electron/database/init.ts
  - electron/services/draftingService.ts
  - electron/services/draftingService.test.ts
  - electron/database/migrations.test.ts
  - CHANGELOG.md
autonomous: true
requirements: [WR-01, AUDIT-#4, AUDIT-#5]
tags: [security, hardening, migration, anti-hallucination]

must_haves:
  truths:
    - "validateDrafts 对 title/content/reasoning 含 [CMD] 或 [KB_SEARCH] 标记的草稿返回 ok:false（反幻觉红线代码层强制）"
    - "含执行标记的草稿触发 draftSession 3 次重试后 throw，绝不静默落库"
    - "ai_system_logs.type CHECK 约束接受 'security' 值（遗留库经 v11 迁移 + fresh-install 两路径都接受）"
    - "main.ts:99 setDecryptFailureHandler 与 experienceDrafting.ts:136 写 type:'security' 日志真正落库（不再被 SQLITE_CONSTRAINT_CHECK 吞）"
    - "v11 迁移幂等可重跑（sqlite_master sql 含 'security' 即 no-op）"
  artifacts:
    - path: "electron/database/migrations.ts"
      provides: "v11 ai_system_logs CHECK widen security 迁移 + 注册表项 + MIGRATION_HEAD=11"
      contains: "v11"
    - path: "electron/database/init.ts"
      provides: "fresh-install ai_system_logs DDL CHECK 含 'security'"
      contains: "security"
    - path: "electron/services/draftingService.ts"
      provides: "validateDrafts 反幻觉标记扫描守卫"
      contains: "FORBIDDEN_MARKERS"
    - path: "electron/services/draftingService.test.ts"
      provides: "validateDrafts 标记拒绝测试（[CMD] / [KB_SEARCH] 各覆盖 title/content/reasoning 三字段）"
      contains: "FORBIDDEN_MARKERS"
    - path: "electron/database/migrations.test.ts"
      provides: "v11 迁移幂等 + CHECK 放开测试（mock sqlite_master 双次重跑 no-op + INSERT security 成功）"
      contains: "v11"
  key_links:
    - from: "electron/services/draftingService.ts validateDrafts"
      to: "draftSession 重试循环"
      via: "返回 ok:false 进 lastError 续轮"
      pattern: "FORBIDDEN_MARKERS"
    - from: "electron/main.ts setDecryptFailureHandler"
      to: "ai_system_logs.type='security'"
      via: "createSystemLog INSERT 不再撞 CHECK"
      pattern: "type: 'security'"
    - from: "electron/database/migrations.ts v11"
      to: "MIGRATIONS 注册表"
      via: "version: 11 注册表项 + MIGRATION_HEAD=11"
      pattern: "version: 11"
---

<objective>
体检报告 §1.1 真 high 第 4 项（Phase 8 反幻觉红线仅 prompt 提示）+ #5（ai_system_logs.type CHECK 不含 security 致告警日志落空）的安全 hardening B 闭环。

两个根因已由主 agent 在体检报告与 08-REVIEW.md:111-126 确认：
1. `draftingService.validateDrafts`（schema Gate）只在 system prompt 文字禁止 [CMD]/[KB_SEARCH] 标记（draftingService.ts:61），校验函数本身不扫这些标记。LLM 不遵守提示时含执行标记的草稿静默落库，Phase 9 浏览页 / 未来执行层可能误执行。
2. `ai_system_logs.type` 的 CHECK 约束在 fresh-install（init.ts:87）与 v6 重建（migrations.ts:143）两处均为 `('discovery','acl','migration','backup')`，不含 `'security'`。但 main.ts:99-101 setDecryptFailureHandler 与 experienceDrafting.ts:136 写 `type:'security'`，被 SQLITE_CONSTRAINT_CHECK 阻断 → 解密失败告警 + 经验关联失败告警**全部落空**（被外层 try/catch 吞），无声数据丢失。

Purpose: 把反幻觉红线从「prompt 文字提示」升级为「代码层强制门禁」；让所有 `type:'security'` 系统日志真正落库可观测。
Output: v11 迁移（双路径 CHECK widen）+ validateDrafts 标记扫描守卫 + 两份新增测试 + CHANGELOG。
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/audits/2026-08-07-health-audit.md
@.planning/phases/08-ai-drafting-pipeline/08-REVIEW.md
@CLAUDE.md

<interfaces>
<!-- 迁移注册表 / 幂等守卫 / 双路径一致 / validateDrafts 签名 —— executor 直接用，无需探查 -->

From electron/database/migrations.ts（MIGRATION_HEAD + 注册表 + v6 rebuild 范式）:
```typescript
export const MIGRATION_HEAD = 10  // → 本任务 bump 11

const v6 = (db: Database.Database): void => {
  // 幂等守卫：sqlite_master sql-content（已含 'warning' 则 no-op）
  const logSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_system_logs'"
  ).get() as { sql?: string } | undefined)?.sql || ''
  if (logSchema.includes("'warning'")) return
  const step = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS ai_system_logs_new")
    db.exec(`
      CREATE TABLE ai_system_logs_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup')),
        status TEXT NOT NULL CHECK(status IN ('success','failed','warning')),
        ...9 列照旧...
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO ai_system_logs_new
        SELECT id, type, status, device_ids, device_names, prompt_text, ai_response, parsed_result, error_message, created_at
        FROM ai_system_logs;
      DROP TABLE ai_system_logs;
      ALTER TABLE ai_system_logs_new RENAME TO ai_system_logs;
    `)
    db.pragma('user_version = 6')
  })
  step()
}

const MIGRATIONS: MigrationStep[] = [
  ...,
  { version: 6, name: 'ai_system_logs CHECK widen (acl/migration/backup + warning)', run: v6 },
  ...,
]
```

From electron/database/init.ts:85-96（fresh-install ai_system_logs DDL）:
```sql
CREATE TABLE IF NOT EXISTS ai_system_logs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup')),
  status TEXT NOT NULL CHECK(status IN ('success','failed','warning')),
  device_ids TEXT,
  device_names TEXT,
  prompt_text TEXT,
  ai_response TEXT,
  parsed_result TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
```

From electron/services/draftingService.ts（validateDrafts 现状 + draftSession 重试循环）:
```typescript
export const MAX_DRAFT_RETRIES = 3

export function validateDrafts(raw: string):
  | { ok: true; drafts: DraftDraft[] }
  | { ok: false; error: string } {
  // ... JSON.parse + per-draft category/title/content/severity/verdict/confidence 校验 ...
  // WR-01 缺口：无 [CMD]/[KB_SEARCH] 标记扫描
}

export async function draftSession(input: DraftSessionInput): Promise<DraftDraft[]> {
  // ...
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= MAX_DRAFT_RETRIES; attempt++) {
    const raw = await callAI(config, messages)
    const result = validateDrafts(raw)
    if (result.ok) return result.drafts
    lastError = result.error   // validateDrafts 返 ok:false 续轮重试
  }
  throw new Error(`AI 起草失败（已重试 ${MAX_DRAFT_RETRIES} 次）：${lastError}`)
}
```

From electron/services/draftingService.ts:59-73（SYSTEM_PROMPT 反幻觉文字 —— 仅提示，无强制）:
```
'【反幻觉红线】禁止输出 [CMD]、[KB_SEARCH] 等执行标记；禁止编造命令；...'
```

From electron/services/systemLog.ts（createSystemLog —— 写 ai_system_logs）:
```typescript
export function createSystemLog(log: { type: string; status: string; ... }): string
```

From electron/main.ts:96-102（type:'security' 被吞点 1）+ electron/services/experienceDrafting.ts:130-145（type:'security' 被吞点 2，已包 try/catch）:
```typescript
// main.ts
setDecryptFailureHandler(() => {
  try {
    createSystemLog({ type: 'security', status: 'warning', errorMessage: '字段解密失败...' })
  } catch { /* 日志写库失败非致命 */ }
})
```

测试 mock 范式（draftingService.test.ts 与 migrationHelpers.test.ts）:
- draftingService.test.ts: `vi.mock('./ai')` mock callAI/getAiConfig，调 validateDrafts 串 JSON 断言 ok:false。
- migrationHelpers.test.ts: `makeDb(colNames)` 桩 `{ prepare: () => ({ all }) }`，不实例化 better-sqlite3（规避 native ABI 冲突，DEP-1）。
- v11 迁移测试沿用 migrationHelpers 范式：mock `db.prepare().get()` 返 `{ sql: '...已含 security...' }` 验证 no-op 早返；mock 返 sql 不含 'security' + 桩 `db.exec/db.pragma` 验证 CREATE _new/INSERT…SELECT/DROP/RENAME 四步 DDL + user_version=11。
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: ai_system_logs.type CHECK 扩 security（v11 迁移 + 双路径一致）</name>
  <files>electron/database/migrations.ts, electron/database/init.ts</files>
  <behavior>
    - v11 迁移幂等守卫：sqlite_master sql 含 "'security'" → no-op 早返（重跑不重建表）
    - v11 迁移执行：DROP _new → CREATE _new 含 CHECK(type IN ('discovery','acl','migration','backup','security')) → INSERT…SELECT copy 全 10 列 → DROP old → RENAME，全包 db.transaction（throw ROLLBACK）
    - v11 迁移执行后：user_version=11
    - v11 迁移保留 status CHECK 不变（'success','failed','warning'）
    - init.ts:87 fresh-install DDL CHECK 改为 ('discovery','acl','migration','backup','security')，与 v11 重建表 DDL 逐字一致
    - MIGRATIONS 注册表加 v11 项，MIGRATION_HEAD bump 10→11
    - 写 type='security' 日志 INSERT 不再撞 CHECK
  </behavior>
  <action>
抄 v6 rebuild 范式（migrations.ts:130-162）落 v11：

1. **init.ts:87 fresh-install DDL**：把 ai_system_logs 的 type CHECK 改为
   `CHECK(type IN ('discovery','acl','migration','backup','security'))`（仅加 `'security'`，其余列 / status CHECK / DEFAULT 全不动）。

2. **migrations.ts v11 函数**（紧跟 v10 之后，MIGRATIONS 注册表加项前定义）：
   - 注释说明根因：v6 当年仅放开 acl/migration/backup + warning status，未含 security；main.ts:99-101 setDecryptFailureHandler + experienceDrafting.ts:134-137 写 type:'security' 撞 CHECK 被外层 try/catch 吞 → R2 解密失败告警 + 经验关联失败告警落空。
   - caveat 同 v10：迁移在 MK 注入前跑，不解密（本迁移也不碰加密列，只改 CHECK 约束）。
   - 幂等守卫：`SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_system_logs'`，sql 含 `'security'` 则 no-op 早返（与 v6 查 `'warning'`、v5查 `'rdp'` 同构第二形式幂等守卫，不靠 user_version）。
   - 执行体包 `db.transaction(() => {...})()`：
     - `DROP TABLE IF EXISTS ai_system_logs_new`
     - `CREATE TABLE ai_system_logs_new (...)` —— CHECK 改为含 `'security'`，**其余 10 列定义 + status CHECK + DEFAULT + created_at 与 init.ts fresh-install DDL 逐字一致**（双路径一致是项目红线，CONVENTIONS）。
     - `INSERT INTO ai_system_logs_new SELECT id, type, status, device_ids, device_names, prompt_text, ai_response, parsed_result, error_message, created_at FROM ai_system_logs`（列顺序与 _new 表定义对齐）。
     - `DROP TABLE ai_system_logs`
     - `ALTER TABLE ai_system_logs_new RENAME TO ai_system_logs`
     - `db.pragma('user_version = 11')`

3. **MIGRATIONS 注册表**（migrations.ts:283-294）末尾加：
   `{ version: 11, name: 'ai_system_logs CHECK widen security (R2 decrypt-failure + exp relate-failure log)', run: v11 }`

4. **MIGRATION_HEAD**（migrations.ts:16）bump `10` → `11`。

注意：`createSystemLog`（systemLog.ts:28-41）入参 `type: string` 无运行时枚举校验，DB CHECK 是唯一闸 —— v11 迁移后 INSERT 'security' 即放行，无需改 service/IPC 层。三红线（IPC 鉴权 / 字段加密 / commandSafety）零触碰。
  </action>
  <verify>
    <automated>npx vitest run electron/database/migrations.test.ts</automated>
  </verify>
  <done>
    - init.ts:87 与 migrations.ts v11 CREATE _new DDL 的 type CHECK 均为 ('discovery','acl','migration','backup','security')，diff 两文件确认逐字一致
    - MIGRATION_HEAD=11，MIGRATIONS 注册表 11 项含 v11
    - v11 迁移幂等（mock sql 含 'security' 时 no-op 不重建表）+ 单跑执行 4 步 DDL + user_version=11
    - 写 type='security' 日志（INSERT）mock 不撞 CHECK
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: validateDrafts 加 [CMD]/[KB_SEARCH] 标记扫描（WR-01 反幻觉红线代码层强制）</name>
  <files>electron/services/draftingService.ts</files>
  <behavior>
    - validateDrafts 对单条 draft 的 title/content/reasoning 三字段拼接后含 '[CMD]' → 返 { ok:false, error: '第 N 条含禁止标记 [CMD]（反幻觉红线）' }
    - 同上含 '[KB_SEARCH]' → 返 { ok:false, error: '第 N 条含禁止标记 [KB_SEARCH]（反幻觉红线）' }
    - 标记在 title / content / reasoning 任一字段命中均拒绝（覆盖三字段）
    - 标记出现在其他字段（如 tags 数组元素 / attrs 子串）不触发拒绝（仅三正文字段）
    - 不含标记的正常草稿不受影响（happy path 仍返 ok:true）
    - draftSession 内 LLM 连续返含标记草稿 → 3 次重试后 throw 'AI 起草失败（已重试 3 次）：第 N 条含禁止标记 [CMD]...'
  </behavior>
  <action>
在 draftingService.ts validateDrafts 函数内，紧接每条 draft 的 confidence 校验之后（drafts.push 之前）加守卫。直接采用 08-REVIEW.md:116-126 给出的方案：

模块顶部（VALID_VERDICTS 同款常量区）加：
```ts
const FORBIDDEN_MARKERS = ['[CMD]', '[KB_SEARCH]']
```

在 validateDrafts 循环内 confidence 校验通过之后、drafts.push 之前加：
```ts
// WR-01：反幻觉红线代码层强制——[CMD]/[KB_SEARCH] 是 AI 对话层的执行/检索标记，
// 经验草稿正文绝不应含（prompt 已文字禁止，此处为强 schema 门兜底）。
// LLM 不遵守提示时含执行标记的草稿拒绝落库，纳入 MAX_DRAFT_RETRIES 重试。
const markerHaystack = `${d.title}\n${d.content}\n${d.reasoning}`
for (const mk of FORBIDDEN_MARKERS) {
  if (markerHaystack.includes(mk)) {
    return { ok: false, error: `第 ${i + 1} 条含禁止标记 ${mk}（反幻觉红线）` }
  }
}
```

不引入正则（标记是固定字面量，String.includes 足矣，与 08-REVIEW.md 给定方案一致）。不改 SYSTEM_PROMPT（文字提示保留作双保险）。draftSession 重试循环已消费 validateDrafts 的 ok:false 进 lastError 续轮，零改动。attrs/tags 字段不扫（命令可能合法出现在 attrs.command[] 二期结构化字段，且当前 DRAFT-04 attrs 是对象不展开扫，避免误伤）。
  </action>
  <verify>
    <automated>npx vitest run electron/services/draftingService.test.ts</automated>
  </verify>
  <done>
    - validateDrafts 含 FORBIDDEN_MARKERS 守卫，title/content/reasoning 任一含 [CMD] 或 [KB_SEARCH] 返 ok:false
    - draftSession mock 连续返含标记草稿 → 重试 3 次后 throw，错误信息含「禁止标记」
    - 不含标记的正常 troubDraft/prodDraft 控制组仍 happy path（已有测试用例不回归）
  </done>
</task>

<task type="auto">
  <name>Task 3: 新增测试（v11 迁移幂等 + validateDrafts 标记拒绝）+ 四绿门禁 + CHANGELOG</name>
  <files>electron/database/migrations.test.ts, electron/services/draftingService.test.ts, CHANGELOG.md</files>
  <action>
**A. 新建 electron/database/migrations.test.ts**（新文件，沿用 migrationHelpers.test.ts 的 mock-DB 范式，规避 DEP-1 native ABI 冲突）：

用 `makeDb(opts)` 工厂桩 `db.prepare` / `db.exec` / `db.pragma` / `db.transaction`：
- `prepare(sql)` 按 sql 内容分流返桩 stmt：
  - 含 `sqlite_master` + `ai_system_logs` → `{ get: () => ({ sql: opts.logSchemaSql }) }`（用于幂等守卫查询）
  - 其他 → spy 收集 exec/pragma 调用
- `exec(sql)` spy 收集调用顺序
- `pragma(cmd)` spy 收集（含 `user_version = 11`）
- `transaction(fn)` 返 `() => fn()`（直跑，无 ROLLBACK 语义需求，本测只验幂等 + DDL 序）

测试用例（至少 3）：
1. **v11 幂等 no-op**：logSchemaSql 含 `'security'`（如 `CREATE TABLE ai_system_logs (... CHECK(type IN ('discovery','acl','migration','backup','security')) ...)`）→ 调 v11(db) → 断言 `exec` 调用次数为 0（早返不重建），`pragma('user_version = 11')` 未调用。
2. **v11 执行 4 步 DDL + user_version=11**：logSchemaSql 不含 `'security'`（如 `CHECK(type IN ('discovery','acl','migration','backup'))`，模拟遗留 v6 后状态）→ 调 v11(db) → 断言 exec 调用序列含 `DROP TABLE IF EXISTS ai_system_logs_new` / `CREATE TABLE ai_system_logs_new`（且 CREATE DDL 字符串含 `'security'`）/ `INSERT INTO ai_system_logs_new` / `DROP TABLE ai_system_logs` / `ALTER TABLE ai_system_logs_new RENAME TO ai_system_logs`，pragma 含 `user_version = 11`，CREATE _new DDL 含 `'security'` 但 status CHECK 仍含 `'warning'` 不变。
3. **v11 CREATE _new DDL 双路径一致**（静态守卫）：从 migrations.ts 抽出 v11 的 CREATE _new DDL 字符串 与 init.ts:87 fresh-install ai_system_logs DDL 字符串做关键特征比对 —— 均含 `CHECK(type IN ('discovery','acl','migration','backup','security'))` 且均含 `CHECK(status IN ('success','failed','warning'))`。可用字符串常量提取或直接 `.includes` 双断言。

import 路径：`import { v11 } from './migrations'` —— 但 v11 当前是模块内 const 非 export。**改 migrations.ts 把 v11 加入 export**（与 v1-v10 同款，目前都未 export；本任务最小动作 = 在 v11 定义前加 `export`，或导出一个内部测试入口 `export const __test_v11 = v11`）。优先选 `export const v11 = ...`（与现有 const 风格一致，加 export 关键字最小侵入）。

**B. 扩 electron/services/draftingService.test.ts**（在现有「validateDrafts」describe 块或新增 describe 加用例）：

至少 4 用例（直接调 validateDrafts，无需 mock callAI —— validateDrafts 是纯函数）：
1. **content 含 [CMD] → ok:false**：构造 `[ { ...troubDraft, content: '执行 [CMD]display version[/CMD] 解决' } ]` → 断言 `result.ok === false` 且 `result.error` 含 '[CMD]' 且含 '反幻觉红线'。
2. **title 含 [KB_SEARCH] → ok:false**：title 改 `'经验 [KB_SEARCH] 检索'` → 断言 ok:false 且 error 含 '[KB_SEARCH]'。
3. **reasoning 含 [CMD] → ok:false**：reasoning 改含 '[CMD]' → 断言 ok:false。
4. **不含标记控制组 → ok:true**：原 troubDraft/prodDraft 不动 → 断言 ok:true（防误伤回归）。
5.（可选）**draftSession 集成**：callAIMock 连续 3 次返含 [CMD] 草稿 → `await expect(draftSession(...)).rejects.toThrow(/AI 起草失败（已重试 3 次）.*\[CMD\]/)`，断言 callAI 调 3 次。

**C. 四绿门禁**：
- `npx tsc -p tsconfig.web.json`（strict + noUnusedLocals，exit 0）
- `npx vitest run`（含新增 v11 迁移测试 + validateDrafts 标记测试，无回归，总数应 ≥ 232 + 新增）
- `npm run build:electron-main`（esbuild main bundle，exit 0）
- `npx vite build`（renderer，exit 0）

**D. CHANGELOG.md**：顶部加新条目（格式仿 2026-08-07 dead code 条目），记：
- 标题：`## 2026-08-07 fix(security): validateDrafts 加 [CMD]/[KB_SEARCH] 标记门禁 + ai_system_logs.type CHECK 扩 security（quick 260807-gfk）`
- 体检报告 §1.1 #4（WR-01 反幻觉红线 prompt→代码层强制）+ #5（type CHECK widen security，v11 迁移双路径一致）
- 根因、修复点（v11 迁移 + init.ts DDL + validateDrafts FORBIDDEN_MARKERS 守卫）、新增测试、四绿门禁结果、证据链接 `.planning/audits/2026-08-07-health-audit.md` §1.1 + `08-REVIEW.md` WR-01。
  </action>
  <verify>
    <automated>npx tsc -p tsconfig.web.json && npx vitest run && npm run build:electron-main && npx vite build</automated>
  </verify>
  <done>
    - electron/database/migrations.test.ts 新建，≥3 用例全绿（v11 幂等 no-op + v11 执行 DDL 序 + 双路径 DDL 一致）
    - draftingService.test.ts 新增 ≥4 用例全绿（[CMD]/[KB_SEARCH] 三字段覆盖 + 控制组不回归）
    - 四绿门禁全绿：tsc strict / vitest（≥236 全 PASS，无回归）/ build:electron-main / vite build
    - CHANGELOG.md 顶部新增本条目
  </done>
</task>

</tasks>

<verification>
- **反幻觉门禁**（#4）：`grep -c "FORBIDDEN_MARKERS" electron/services/draftingService.ts` ≥ 1；validateDrafts 标记拒绝测试全绿。
- **日志 CHECK 放开**（#5）：`grep -c "'security'" electron/database/init.ts` ≥ 1 且 `grep -c "'security'" electron/database/migrations.ts` ≥ 1（双路径）；v11 迁移测试全绿。
- **迁移注册完整性**：`grep "MIGRATION_HEAD = 11" electron/database/migrations.ts` 命中；`grep "version: 11" electron/database/migrations.ts` 命中（注册表项）。
- **双路径 DDL 一致**：init.ts:87 fresh DDL 与 migrations.ts v11 CREATE _new DDL 的 `CHECK(type IN ...)` 串逐字相等。
- **三红线零触碰**：`grep -rn "secure\|safe" electron/ipc/` IPC 鉴权未改；`grep -rn "encField\|decField" electron/services/` 字段加密未改；commandSafety 文件未改（本任务 grep diff 应只在 migrations.ts / init.ts / draftingService.ts / 两测试 / CHANGELOG）。
- **四绿门禁全绿**：tsc strict + vitest + build:electron-main + vite build 四者 exit 0。
</verification>

<success_criteria>
- validateDrafts 对含 [CMD]/[KB_SEARCH] 标记的草稿返 ok:false，draftSession 3 次重试后 throw，反幻觉红线从 prompt 提示升级为代码层强制门禁（WR-01 闭环）
- ai_system_logs.type CHECK 两路径（fresh-install + v11 迁移）均含 'security'，type='security' 日志（R2 解密失败告警 + 经验关联失败告警）真正落库不再被吞
- v11 迁移幂等可重跑（sqlite_master 'security' 特征串守卫），throw 即 ROLLBACK（db.transaction），与 v6 rebuild 范式同构
- MIGRATION_HEAD=11，注册表 11 项，fresh-install DDL 与 v11 重建表 DDL 逐字一致（双路径一致红线）
- 新增 ≥7 测试（v11 迁移 ≥3 + validateDrafts 标记 ≥4）全绿，无回归
- 四绿门禁全绿，CHANGELOG 更新
- 三红线（IPC 鉴权 / 字段加密 / commandSafety）零触碰
- masterKey 值永不变（v11 不解密、不碰加密列，仅改 CHECK 约束）
</success_criteria>

<output>
Create `.planning/quick/260807-gfk-hardening-b-validatedrafts-cmd-kb-search/260807-gfk-SUMMARY.md` when done
</output>
