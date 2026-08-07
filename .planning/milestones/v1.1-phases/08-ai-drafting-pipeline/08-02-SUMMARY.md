---
phase: 08-ai-drafting-pipeline
plan: 02
subsystem: ai-drafting
tags: [llm-drafting, schema-gate, anti-hallucination, two-stage-verdict, tdd]
requires:
  - "ai.ts callAI (line 229, 不改签名) + getAiConfig"
  - "experienceService ExperienceCategory (4 枚举) + ExperienceAttrs 模板"
provides:
  - "draftSession（阶段 A 纯起草）→ DraftDraft[]"
  - "judgeVerdicts（阶段 B W-4 两阶段复判）→ 覆盖 verdict + dupId 的 DraftDraft[]"
  - "validateDrafts 代码层 schema Drift Gate（D-01）"
  - "buildDraftingPrompt / buildVerdictPrompt / validateVerdicts"
  - "DraftDraft / DraftSessionInput / JudgeVerdictsInput 类型契约"
affects:
  - "Plan 08-03 IPC 编排层（消费 draftSession + judgeVerdicts 串联，落库 createExperience + duplicateOfExpId）"
tech-stack:
  added: []
  patterns:
    - "W-4 两阶段起草（阶段 A 纯起草 + 阶段 B 按 category 窄查复判）防 4×1000 context 溢出"
    - "D-01 schema Drift Gate 在代码层（JSON.parse + 枚举锁死 + 模板字段校验），不依赖 provider JSON mode"
    - "D-04 反幻觉 prompt（禁 [CMD]/[KB_SEARCH] 执行标记 + 分类不超枚举 + 缺数据标 'gap'）"
    - "TDD RED→GREEN（23 测试含 W-2 confidence 边界 + judgeVerdicts 复判）"
key-files:
  created:
    - electron/services/draftingService.ts
    - electron/services/draftingService.test.ts
  modified: []
decisions:
  - "函数式 service 无 class 无 MK（不读写加密列，grep encrypt/decrypt=0），与 CONVENTIONS Pattern 1b 一致"
  - "callAI 签名零改动（grep response_format/json_object=0），D-01 红线落实"
  - "judgeVerdicts 短路优化：全分类无存量时不调 LLM 直接返全 ADD（降本 + 防无效调用）"
  - "LLM 未返某 draft_index → 该条保守保持阶段 A 的 ADD 初值（保守新增，信任红线③ 人工确认兜底）"
  - "W-2 confidence 边界统一收口：'85%'→0.85 / '0.9'→0.9 / 'high'→fail / 1.5→fail（parseFloat + 范围校验）"
metrics:
  duration: ~3.5min
  completed: 2026-08-02
  tasks: 1
  files: 2
  tests_added: 23
---

# Phase 8 Plan 02: draftingService（LLM 起草 service + W-4 两阶段复判）Summary

**One-liner:** 函数式 `draftingService` 落地——`draftSession` 阶段 A 纯起草（强约束 JSON prompt + 代码层 schema 校验 + 重试 3 次）+ `judgeVerdicts` 阶段 B 按 category 窄查复判（W-4 防 context 溢出），不改 `callAI` 签名（D-01），prompt 反幻觉禁 `[CMD]`（D-04），TDD RED→GREEN 23 测试全绿。

## 导出函数清单（draftingService.ts）

| 函数 | 阶段 | 职责 |
|------|------|------|
| `buildDraftingPrompt(input)` | A | 构建起草 system+user prompt（反幻觉红线 + 4 枚举锁死 + JSON 数组契约 + 判定规则） |
| `validateDrafts(raw)` | A | 代码层 schema Drift Gate：剥离 ```json 包裹 → JSON.parse → 逐条校验枚举/字段/confidence/dupId |
| `draftSession(input)` | A | 纯起草主流程：demoMode→[] / 未配 AI→throw / 重试 3 次 callAI+validateDrafts → 返 1~N 条或 [] |
| `buildVerdictPrompt(input)` | B | 构建复判 system+user prompt（drafts 摘要 + 按 category 分组同分类存量） |
| `validateVerdicts(raw, draftCount)` | B | 校验复判返回：draft_index 越界/重复/枚举/dupId 规则 |
| `judgeVerdicts(input)` | B | W-4 阶段 B 复判：全无存量短路 / demoMode 不调 LLM / 重试 3 次 / 回填 verdict+dupId / 未覆盖保守保持 ADD |

## 类型契约（供 Plan 03 落库映射）

### DraftDraft（1:1 LLM 输出字段，Plan 03 映射到 `createExperience ExperienceInput` + `duplicateOfExpId`）

```typescript
interface DraftDraft {
  category: ExperienceCategory          // → ExperienceInput.category
  title: string                          // → ExperienceInput.title
  content: string                        // → ExperienceInput.content
  tags: string[]                         // → ExperienceInput.tags
  attrs: ExperienceAttrs | {}            // → ExperienceInput.attrs
  confidence: number                     // UI 提示用（落库 attrs 或 review 用，非 createExperience 直字段）
  reasoning: string                      // UI 提示用
  duplication_verdict: 'ADD'|'UPDATE'|'NOOP'  // Plan 03 据此决定：ADD/UPDATE→createExperience(status='draft')，NOOP→过滤不落库
  duplicate_of_exp_id: string | null     // UPDATE/NOOP 时为命中 exp_id → ExperienceInput.duplicateOfExpId
}
```

### JudgeVerdictsInput（编排层填充）

```typescript
interface JudgeVerdictsInput {
  drafts: DraftDraft[]                                                    // 阶段 A 产出
  existingByCategory: Record<ExperienceCategory, ExistingExperienceSummary[]>  // 编排层按每条 draft.category 窄查（≤50 条/分类截断）
  demoMode?: boolean
}
```

Plan 03 编排层调 `findExistingForDraft(draft)` 按 draft.category 窄查后聚合填充 `existingByCategory`，再调 `judgeVerdicts`。

## SYSTEM_PROMPT 反幻觉要点（D-04 + DRAFT-04）

- **禁执行标记**：禁止输出 `[CMD]`、`[KB_SEARCH]` 等执行标记（grep 守卫 =1）
- **禁编造命令/字段**：缺数据字段值必须填字符串 `"gap"`，严禁瞎编或强填
- **分类固定枚举**：只允许 `troubleshooting、best_practices、product、env`（grep 守卫 =1）
- **分类模板字段**：troubleshooting 必含 severity（critical/high/medium/low/info），其他类 attrs 可空
- **判定规则**：ADD→dupId=null / UPDATE→dupId 填命中 / NOOP→dupId 填命中（不落库）
- **输出格式**：严格 JSON 数组，无额外文字；无可总结经验返 `[]`

## W-2 confidence 边界规则

LLM 返回 `confidence` 字段的合法形态：
- 数值 `[0,1]`：直接通过（如 `0.85`）
- 百分比字符串 `'85%'`：`parseFloat 去 %` / 100 = 0.85 通过
- 字符串数值 `'0.9'`：`parseFloat` = 0.9 通过
- 非数值非百分比字符串 `'high'`：`parseFloat` 得 NaN → fail（触发重试）
- 超界数值 `1.5`：fail（触发重试）

实现：`if (typeof confidence === 'string') confidence = confidence.endsWith('%') ? parseFloat/100 : parseFloat` → `isNaN / <0 / >1` 任一即 fail。

## 重试策略

- `MAX_DRAFT_RETRIES = 3`（draftSession + judgeVerdicts 共用）
- 校验失败（validateDrafts/validateVerdicts 返 `{ok:false,error}`）→ 记录 lastError → 进下次重试
- 3 次全 fail → throw `AI 起草/复判失败（已重试 3 次）：{lastError}`（IPC secure 脱敏透出 renderer）
- 无指数退避（避免叠加等待，T-08-10 mitigation）
- demoMode=true → draftSession 返 []；judgeVerdicts 返原 drafts（均不调 LLM，断点续传交 Plan 03 IPC）

## judgeVerdicts W-4 两阶段窄化（D-02 正确性 + 防 context 溢出）

- **为何两阶段**：单次起草若同时喂「4 枚举 × 设备全量预查」存量，最坏 4×1000 条摘要致 prompt context 溢出（T-08-20）
- **阶段 A** `draftSession`：`existingSummaries=[]`，LLM 纯起草，verdict 自然全 ADD（不喂存量）
- **阶段 B** `judgeVerdicts`：编排层按每条 `draft.category` 窄查同分类存量（≤50 条/分类），喂 LLM 复判 verdict + dupId 覆盖阶段 A 初值
- **短路优化**：`existingByCategory` 全分类无存量 → judgeVerdicts 不调 LLM 直接返全 ADD（降本）
- **保守新增**：LLM 未返某 `draft_index` → 该条保持阶段 A 的 ADD 初值（信任红线③ 人工确认兜底）

## Deviations from Plan

**1. [Rule 1 - Test bug] Test #2 wrapped JSON 字符串构建错误**
- **Found during:** GREEN 阶段首轮（test #2 fail）
- **Issue:** 原测试用 `JSON.stringify(troubDraft).slice(1,-1)` 拼 `[...]` 丢失对象 `{}` 边界，导致 JSON 非法
- **Fix:** 改为 `JSON.stringify([troubDraft])` 直接序列化整个数组，再包 ```json fence
- **Files modified:** electron/services/draftingService.test.ts（test #2）
- **Commit:** 2ec666e（合入 GREEN commit）

**2. [Rule 1 - Test bug] Test #8 引用未导入的 callAI 标识符**
- **Found during:** GREEN 阶段首轮（test #8 fail：ReferenceError: callAI is not defined）
- **Issue:** 测试用 `expect(callAI).toBeDefined()` 但未 import callAI（已被 mock 替换）
- **Fix:** 删除该冗余断言，保留 `expect(callAIMock).toHaveBeenCalledTimes(0)` 验证 mock 未被调用
- **Files modified:** electron/services/draftingService.test.ts（test #8）
- **Commit:** 2ec666e（合入 GREEN commit）

两处均为**测试代码 bug**（非实现 bug），实现代码零调整即通过修正后测试。属 TDD RED 阶段正常的测试迭代，不影响 GREEN 实现质量。

## Verification Results

- `npx tsc -p tsconfig.web.json --noEmit` EXIT 0（noUnusedLocals 全绿）
- `npm run build:electron-main` EXIT 0（draftingService 经 esbuild bundle 进 dist-electron/main.js 1.8mb）
- `npx vitest run` 126/126 PASS（基线 103 + Plan 01 新增 + draftingService 23 新增，无回归）
- callAI 签名零改动（grep `response_format|json_object|raw.json` =0，反向守卫通过）
- 函数式无加密（grep `encrypt(|decrypt(` =0，反向守卫通过）

## Done Criteria Grep Guards（全过）

| 守卫 | 期望 | 实测 |
|------|------|------|
| `MAX_DRAFT_RETRIES = 3` | 1 | 1 |
| `export function buildDraftingPrompt` | 1 | 1 |
| `export function validateDrafts` | 1 | 1 |
| `export async function draftSession` | 1 | 1 |
| `export async function judgeVerdicts` | 1 | 1 |
| `export function buildVerdictPrompt` | 1 | 1 |
| `export function validateVerdicts` | 1 | 1 |
| `JudgeVerdictsInput` | ≥2 | 3 |
| `import callAI + getAiConfig from './ai'` | 1 | 1 |
| `禁止输出 [CMD]`（反幻觉） | 1 | 1 |
| `troubleshooting、best_practices、product、env`（枚举锁死） | 1 | 1 |
| `response_format/json_object/raw.json`（反向守卫） | 0 | 0 |
| `encrypt(/decrypt(`（反向守卫） | 0 | 0 |
| test `85%`（W-2 百分比边界） | ≥1 | 3 |
| test `'high'`（W-2 非法字符串边界） | ≥1 | 4 |

## Known Stubs

无。draftingService 为纯函数式可测 service，所有导出函数均有真实实现 + 单测覆盖，无 placeholder/mock 残留。

## Threat Flags

无新增安全面超出 plan 威胁模型。威胁登记 T-08-06~11 + T-08-20 全部按 disposition 落地（反幻觉 prompt + schema Gate + 重试 + 不落库 + 两阶段窄化）。

## Self-Check: PASSED

- FOUND: electron/services/draftingService.ts
- FOUND: electron/services/draftingService.test.ts
- FOUND: 253dda4 (test RED commit)
- FOUND: 2ec666e (feat GREEN commit)
