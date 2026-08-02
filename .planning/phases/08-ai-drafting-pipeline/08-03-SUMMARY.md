---
phase: 08-ai-drafting-pipeline
plan: 03
subsystem: ai-drafting-pipeline
tags: [ai-drafting, ipc, ipc-gateway, experience, pii-masking, tdd]
requires:
  - 08-01 (piiMask.maskConversationText + duplicateDetector.findExistingForDraft + experienceService.createExperience 扩展 duplicateOfExpId)
  - 08-02 (draftingService.draftSession 阶段A + judgeVerdicts 阶段B + DraftDraft + JudgeVerdictsInput)
  - phase-07 (experienceService 门面 + relateDevice + secure IPC 基线 + ai.ts getChatHistory/getAiConfig)
provides:
  - experienceDrafting.summarizeSessionForUi（两阶段编排 service，串联读会话→脱敏→阶段A起草→阶段B窄查复判→门面落库→返 DraftingResult）
  - experience:summarizeSession IPC channel（secure 包装）
  - window.api.experience.summarizeSession（preload 第 11 个白名单方法）
  - DraftingResult DTO（src/types/experience.ts，renderer 不收会话原文）
  - AIPage「经验总结」按钮（ChatInput 区，会话有内容可点，loading/完成通知/无可总结提示）
  - useAIChat.handleSummarize + summarizing 状态 + canSummarize 守卫
affects:
  - electron/main.ts（注册 registerExperienceDraftingIpc）
  - electron/preload.ts（experience 块第 11 个方法）
  - src/types/electron.d.ts（experience.summarizeSession 类型声明）
  - src/components/pages/ai/ChatInput.tsx（追加经验总结 Button）
  - src/components/pages/ai/useAIChat.ts（追加 summarizing 状态 + handleSummarize + canSummarize）
  - src/components/pages/ai/types.ts（UseAIChatReturn 契约扩展）
  - src/components/pages/AIPage.tsx（ChatInput 调用面透传新 props）
tech-stack:
  added: []
  patterns:
    - W-4 两阶段编排（阶段A 纯起草 existingSummaries=[] + 阶段B distinct category 窄查 + judgeVerdicts 复判）
    - B-1/B-2 方案A 门面落库（createExperience duplicateOfExpId 单语句原子写 dup_id，不裸 SQL UPDATE，不 try/catch 吞错）
    - 函数式编排 service（无 class、无 MK，加密列由下游 service 处理）
    - secure IPC 包装（鉴权 + 异常脱敏，channel 命名 camelCase）
key-files:
  created:
    - electron/services/experienceDrafting.ts
    - electron/services/experienceDrafting.test.ts
    - electron/ipc/experienceDraftingIpc.ts
  modified:
    - electron/preload.ts
    - electron/main.ts
    - src/types/experience.ts
    - src/types/electron.d.ts
    - src/components/pages/ai/ChatInput.tsx
    - src/components/pages/ai/useAIChat.ts
    - src/components/pages/ai/types.ts
    - src/components/pages/AIPage.tsx
decisions:
  - W-4 两阶段编排落地阶段A draftSession(existingSummaries=[])+阶段B findExistingForDraft 按 distinct category 窄查(≤50条/分类截断)+judgeVerdicts 复判，避免单次起草 4×1000 context 溢出
  - B-1+B-2 方案A：UPDATE 经 createExperience({duplicateOfExpId}) 单语句原子写 dup_id，不裸 SQL UPDATE，不 try/catch 吞错（CREATE 失败即 throw 中断该条 draft，标注与 draft 行共存亡）；relateDevice 的 try/catch 保留因设备关联独立于 dup_id 原子单元
  - demoMode 判定下沉到编排层（getAiConfig null/apiKey 空 → empty+demoMode=true 不抛错，draftSession 内部重试逻辑保留作纵深防御）
  - DraftingResult DTO 不含会话原文（T-08-13），renderer 经 experience:summarizeSession 永不收 chat_history 明文，会话原文回链交 Phase 9
metrics:
  duration: ~7min
  completed: 2026-08-02
  tasks: 3
  files: 11（3 created + 8 modified）
  tests: 10 新增（experienceDrafting.test.ts W-3），136 全套全绿
  commits: 4（8cffc07 RED + d146de5 GREEN + e561a41 IPC + 3e13788 UI）
---

# Phase 8 Plan 03: IPC + 编排层串联（experienceDrafting 编排 + UI 入口）Summary

把 Plan 01（piiMask + duplicateDetector + createExperience 扩展）+ Plan 02（draftingService 两阶段 draftSession/judgeVerdicts）+ Phase 7（createExperience 门面 + secure IPC 基线 + ai.ts getChatHistory）串成端到端 pipeline，并暴露给 renderer：用户点「经验总结」按钮即可端到端跑通（读会话→脱敏→两阶段起草→门面落库），产出 draft 态草稿入库供 Phase 9 人工确认。

## 关键决策落地

### W-4 两阶段编排（experienceDrafting.summarizeSessionForUi）

- **阶段 A**：`draftSession({ maskedConversation, deviceIds, existingSummaries: [] })` 纯起草 → drafts[]（verdict 全 ADD 初值）。existingSummaries=[] 是 W-4 的关键——阶段 A 不喂存量，避免单次起草「4 枚举 category × 设备全量预查」context 溢出（最坏 4000 条摘要）。
- **阶段 B**：对 drafts[] 涉及的 `distinct categories` 逐个调 `findExistingForDraft({ category, deviceIds })` 窄查同分类+设备存量，`MAX_EXISTING_PER_CATEGORY = 50` 截断（≤50 条/分类），组装 `existingByCategory: Record<category, summaries>` 映射，调 `judgeVerdicts({ drafts, existingByCategory })` 复判覆盖 verdict + dupId。
- judgeVerdicts 内部短路（全分类无存量时不调 LLM 直接返原 drafts），未返的 draft_index 保守保持 ADD 初值。

### B-1 + B-2 方案 A 门面落库

- ADD → `createExperience({ title, category, content, tags, sourceSessionId, attrs, duplicateOfExpId: null })`
- UPDATE → `createExperience({ ..., duplicateOfExpId: d.duplicate_of_exp_id })` 单语句原子写 dup_id（v9 新列 `duplicate_of_exp_id` 与 draft 行同 INSERT 写入）
- **不裸 SQL UPDATE duplicate_of_exp_id**（B-1 门面红线，grep 反向守卫 `UPDATE experiences SET duplicate_of_exp_id` = 0 + `getDatabase().prepare` = 0）
- **不 try/catch 吞错**（B-2 共存亡——CREATE 失败即 throw 中断该条 draft 落库，标注与 draft 行同生死）
- NOOP → 跳过不调 createExperience，noop[] 记提示
- relateDevice 的 try/catch 保留——设备关联独立于 dup_id 原子单元，关联失败不阻塞 draft 入库（关联缺失可 Phase 10 浏览页手动补）

### DraftingResult 契约（T-08-13 边界脱敏）

```typescript
interface DraftingResult {
  empty: boolean                // SC1：无可总结内容（draftSession 返 [] 或 demoMode）
  demoMode: boolean             // 是否走了 demoMode 降级（未配 AI）
  created: Array<{ exp_id; title; category }>      // ADD 落库
  updated: Array<{ exp_id; title; category; duplicate_of_exp_id }>  // UPDATE 落库
  noop: Array<{ duplicate_of_exp_id; reasoning }>                       // NOOP 跳过提示
}
```

renderer 经 `experience:summarizeSession` channel **永不收会话原文**（仅含落库 draft 的 exp_id/title/category + NOOP 提示），会话原文回链交 Phase 9（renderer 经独立 channel 按需读明文）。

### IPC channel 清单（experience 块第 11 个）

```
experience:list / get / create / update / delete / invalidate
experience:relateDevice / unrelateDevice / listByDevice / listDevices
experience:summarizeSession  ← Phase 8 Plan 03 新增（secure 包装）
```

ipc↔preload channel 三向逐字一致（grep + sort -u 校验通过）。

### AIPage 按钮交互（SC1/SC5 + UX）

- 「经验总结」Button（ThunderboltOutlined 图标）位于 ChatInput 区，`onSummarize` 可选渲染
- `canSummarize = messages.length > 0`（空会话按钮 disabled，SC1 强约束）
- `summarizing` 状态控制 loading + disabled，防重复点击
- demoMode → `message.warning` 提示去配置（不崩溃）
- empty → `message.info`「该会话无可总结经验」（不强产空条目）
- 完成 → `message.success` 汇总 created/updated/noop 计数 +「草稿待确认」（Phase 9 入口）
- SC5：source_session_id 幂等，同 session 多次总结生独立行（追加不覆盖），可重复点击重跑（draftSession/judgeVerdicts 内部各重试 3 次防 LLM 限流/超时）

## SC1~SC5 全覆盖证据

| SC | 描述 | 落地证据 |
|----|------|----------|
| SC1 | 产出/无可总结提示 | `messages.length===0`（空会话）或 `draftsA.length===0`（LLM 判无可总结）→ `empty=true`；UI `message.info`「该会话无可总结经验」不强产空条目 |
| SC2 | PII 脱敏前置（送 LLM 前） | `maskConversationText` 在调 draftSession（送 LLM）前执行，原始 messages 不动（grep `maskConversationText` = 2：import + 调用点） |
| SC3 | 查重 ADD/UPDATE/NOOP 经两阶段复判 | 阶段 B `judgeVerdicts` 复判覆盖 verdict + dupId，落库按 ADD/UPDATE 经 createExperience 门面、NOOP 跳过 |
| SC4 | Plan 02 强 schema 起草 | draftSession/judgeVerdicts 内部 validateDrafts/validateVerdicts 代码层 schema Gate + 重试 MAX_DRAFT_RETRIES=3 |
| SC5 | source_session_id 幂等追加不覆盖 | `createExperience({ sourceSessionId: sessionId })`（grep = 1），同 sessionId 两次总结各生独立 uuid（单测 (a) 验证 exp-A ≠ exp-B） |

## TDD 执行（W-3 编排单测）

RED（8cffc07）→ GREEN（d146de5）双 commit。

**experienceDrafting.test.ts 10 case**（vitest mock 三层依赖 ai/draftingService/duplicateDetector/experienceService + piiMask 透传）：

1. (e) demoMode：getAiConfig null → 不调 draftSession，返 empty + demoMode=true
2. 空会话（messages.length===0）→ empty，不调 draftSession
3. (c) NOOP：createExperience 调用 0 次 + result.noop.length===1
4. (b) sourceSessionId 透传：createExperience 入参含 sourceSessionId==='s1'
5. (d) UPDATE 透传 dup_id：createExperience 入参含 duplicateOfExpId='exp-old-1'
6. (a) SC5 追加不覆盖：两次 summarize 各生 exp-A/exp-B（不同 uuid）
7. 阶段B：distinct categories 逐个调 findExistingForDraft（best_practices + env 各一次）
8. SC1：draftSession 返 [] → empty=true，不调 judgeVerdicts/createExperience
9. maskConversationText 在 draftSession 前执行（D-04 脱敏前置）
10. relateDevice 按 deviceIds 关联（exp-x 关联 dev-1，relation='primary'）

## 三绿门禁

- `npx tsc -p tsconfig.web.json --noEmit` EXIT 0（renderer + DTO 全绿，noUnusedLocals 通过）
- `npm run build:electron-main` EXIT 0（experienceDrafting + experienceDraftingIpc + main.ts 经 esbuild bundle）
- `npx vitest run` 12 files / 136 tests 全 PASS（既有基线 126 + experienceDrafting 10 新增，无回归）

## 反向守卫验证（B-1/红线③）

```
grep -cE "UPDATE experiences SET duplicate_of_exp_id" electron/services/experienceDrafting.ts = 0  (B-1)
grep -cE "getDatabase\(\)\.prepare"                electron/services/experienceDrafting.ts = 0  (B-1)
grep -cE "updateExperience\("                       electron/services/experienceDrafting.ts = 0  (红线③)
grep -cE "\b(encrypt|decrypt)\("                    electron/services/experienceDrafting.ts = 0  (不裸调加密)
```

## Deviations from Plan

None - plan executed exactly as written.

## TDD Gate Compliance

- RED gate: `test(08-03)` commit 8cffc07 exists（10 failing cases）
- GREEN gate: `feat(08-03)` commit d146de5 exists after RED（implementation passes all 10）
- 反幻觉 fail-fast：RED 阶段如预期失败（module not found），未跳过 RED 直接 GREEN

## Self-Check: PASSED

**Files exist:**
- FOUND: electron/services/experienceDrafting.ts
- FOUND: electron/services/experienceDrafting.test.ts
- FOUND: electron/ipc/experienceDraftingIpc.ts

**Commits exist:**
- FOUND: 8cffc07 (test RED)
- FOUND: d146de5 (feat GREEN)
- FOUND: e561a41 (feat IPC + preload + main + DTO)
- FOUND: 3e13788 (feat UI button + handler)
