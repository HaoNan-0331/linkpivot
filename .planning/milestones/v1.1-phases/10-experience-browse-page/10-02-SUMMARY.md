---
phase: 10-experience-browse-page
plan: 02
subsystem: renderer-form
tags: [refactor, renderer, form, quality-gate, public-component]
requires: [10-01]
provides: [ExperienceEditForm, validateDraft-single-source]
affects: [src/components/pages/ai/ReviewConfirmModal.tsx, src/components/pages/ai/ReviewConfirmEditForm.tsx]
tech_stack:
  added: []
  patterns: [公共组件抽取（D-10-1）, validateDraft 单一来源（消除双份漂移）, uncontrolled form useState]
key_files:
  created:
    - src/components/knowledge/ExperienceEditForm.tsx
  modified:
    - src/types/experience.ts
    - src/components/pages/ai/ReviewConfirmModal.tsx
decisions:
  - D-10-1 保守方案落地：仅共享 validateDraft 单一来源，ReviewConfirmEditForm 字段结构不动（保 Phase 9 零回归）
  - 红线③ 例外：手动新增直 status:'published'（人工录入非 AI 产出，不进 draft 闸口）
  - ExperienceInput DTO 扩 status? 对齐 service 层 createExperience 入参签名
metrics:
  duration: ~12min
  completed: 2026-08-05
  tasks: 2
  files_changed: 3
---

# Phase 10 Plan 02: 经验编辑公共组件抽取 + validateDraft 单一来源 Summary

从 Phase 9 ReviewConfirmEditForm + ReviewConfirmModal 抽出 ExperienceEditForm 公共组件 + validateDraft 质量门单一来源，Phase 9 改 import 复用，为 10-03 手动 CRUD Modal 备好表单组件（D-10-1）。

## 交付物

### Task 1：ExperienceEditForm 公共组件（commit `e2b1506`）

- **新建 `src/components/knowledge/ExperienceEditForm.tsx`**（257 行）：
  - 导出 `validateDraft(d, fields): string[]` 质量门单一来源（troubleshooting 检 severity/symptoms/resolution，其余检 title/content；错误串中文「缺 严重程度」/「缺 故障现象」/「缺 解决办法」/「缺 标题」/「缺 内容」与 UI-SPEC copy contract 逐字一致）
  - 导出 `CATEGORY_OPTIONS`（troubleshooting=故障排查 / best_practices=最佳实践 / product=产品 / env=环境）+ `SEVERITY_OPTIONS`（critical=致命 / high=高 / medium=中 / low=低 / info=提示），value 存英文不变（保历史数据兼容，09 cd87077 锁定）
  - ExperienceEditForm 组件 props：`initialValue?: Experience` / `onSubmit: (fields) => void` / `onCancel: () => void`
  - 字段结构复刻 ReviewConfirmEditForm：标题 Input / 分类 Select / 内容 TextArea / 标签 Select（mode="tags"）/ troubleshooting 类显 attrs 模板五字段（严重程度 + 故障现象 + 根本原因 + 解决办法 + 预防措施，分类切换动态呈现）/ 关联设备 Select（mode="multiple"，拉 device.list filter ssh/telnet，T-10-08 mitigation）
  - 状态由 form 内部 useState 持（uncontrolled，单条编辑，无 Phase 9 批量决策列表/decision patch 形态）
  - 编辑态预填：initialValue 反向填 form state + 内部 useEffect 调 `window.api.experience.listDevices(initialValue.id)` 取已关联设备 ids 预填
  - 实时质量门：每个 Form.Item `validateStatus`/`help` 根据 errs 标红；提交按钮 `disabled={errs.length > 0}`
  - **去除 Phase 9 专属 UI**：「查看原始会话」Button（详情 Modal 侧独立入口）+ UPDATE `supersedeOld` Checkbox（手动 CRUD 无 UPDATE 语义）
  - **手动新增直 published**（红线③ 例外）：新增态 onSubmit 传 `{...input, status: 'published'}`；编辑态传 update 白名单字段（CR-01 不收 status）——由 initialValue 是否存在判定
  - footer 主按钮文案「保存」（禁止「确认入库」/「发布并待审」等暗示 AI 闸口措辞，UI-SPEC copy 红线③）
  - 外层 Modal 由调用方（ExperienceTab）包裹（width 640，UI-SPEC §4），本组件只渲染 Form + footer Button
- **修改 `src/types/experience.ts`**：ExperienceInput DTO 扩 `status?: ExperienceStatus` 字段（对齐 service 层 `createExperience(input: ExperienceInput & { status?: ExperienceStatus })` 签名，默认 'draft' 保 Phase 7-9 AI 起草路径不变）

### Task 2：Phase 9 ReviewConfirmModal 改 import（commit `b95c44d`，保守方案）

- **修改 `src/components/pages/ai/ReviewConfirmModal.tsx`**：
  - 删除本地 `export function validateDraft(...)` 定义（原 L43-62 function + 注释块）
  - 新增 `import { validateDraft } from '../../knowledge/ExperienceEditForm'`（单一来源）
  - 保留 `export { validateDraft }` re-export——ReviewConfirmEditForm.tsx 的 `import { validateDraft, type DraftDecision } from './ReviewConfirmModal'` 路径不动（保守方案，零回归）
  - validateDraft 错误串硬编码全部迁出 ReviewConfirmModal.tsx（「缺 严重程度」等不再本地定义）
- **ReviewConfirmEditForm.tsx 不动**：字段结构 + UPDATE supersedeOld Checkbox + 查看原始会话 Button 全保留（Phase 9 专属 UI 语义红线）

## 验证

- **三绿门禁全绿**：
  - `npx tsc -p tsconfig.web.json --noEmit` exit 0（strict + noUnusedLocals）
  - `npx vite build` exit 0
  - `npm run build:electron-main` exit 0（Task 2 加测，因未动 main 进程但确认无回归）
  - `npx vitest run` exit 0 — **191/191 测试全绿**（含 ai.telnetRouting 9 case + service 19 case，Phase 9 表单行为零回归）
- **acceptance criteria 全达成**：
  - ExperienceEditForm.tsx 存在 + validateDraft / ExperienceEditForm 双导出 ✓
  - CATEGORY_OPTIONS 中文化（故障排查）+ SEVERITY_OPTIONS 中文化（致命）✓
  - validateDraft 错误串「缺 严重程度」≥1 ✓
  - initialValue 使用 ≥2 ✓
  - `status: 'published'` ≥1 ✓
  - 提交按钮 `disabled={errs.length > 0}` ✓
  - footer 文案「保存」✓
  - supersedeOld / 查看原始会话 仅在注释中说明「去除」（UI 元素 0）✓
  - 关联设备 Select mode="multiple" + 标签 Select mode="tags" ✓
  - listDevices 编辑态预填关联设备 ✓
  - ReviewConfirmModal 改 import 新源 + 删除本地定义 + 保留 re-export ✓
  - ReviewConfirmEditForm 仍含 supersedeOld(3 处) + 查看原始会话(2 处)（Phase 9 专属 UI 不丢）✓
  - ReviewConfirmModal 内「缺 严重程度」硬编码 0（已迁出）✓

## 威胁模型

| Threat ID | 处置 | 落地 |
|-----------|------|------|
| T-10-07（手动新增直 published 绕 AI draft 闸口）| mitigate | 红线③ 例外设计意图：createExperience status? 默认 'draft'，仅手动新增显式传 'published'；AI 起草路径（Phase 8）零改动仍走 draft |
| T-10-08（关联设备 Select）| mitigate | 复用 ReviewConfirmEditForm 既有 device.list + filter ssh/telnet 范式；renderer 只收 Device DTO 明文字段（IPC stripEncColumns 已剥离 _enc）|
| T-10-09（initialValue 预填 attrs 解密值）| accept | Experience DTO 的 attrs 已由 service rowToExperience 解密回填 + delete attrs_enc；renderer 收明文 attrs 是设计意图（编辑需展示），不含凭证字段 |
| T-10-10（validateDraft 漂移导致质量门绕过）| mitigate | 单一来源：validateDraft 迁入 ExperienceEditForm 导出，Phase 9 改 import 消除双份；service 层 assertTroubleshootingAttrs 兜底（第三层纵深，不动）|

## 已知限制（由 10-03 调用方解决）

- **relateDevices 未传 onSubmit**：当前 ExperienceEditForm 内部 useState 持 relateDevices（关联设备 Select 的 value），但 onSubmit 签名 `(fields: ExperienceInput | ExperienceUpdateInput) => void` 只回传表单字段（title/category/content/tags/attrs），未含 relateDevices ids。这是 plan 接口契约（onSubmit 只回 fields）的有意保留——10-03 ExperienceTab 调用方需通过以下方式之一获取 relateDevices：
  1. 扩 onSubmit 签名为 `(fields, relateDevices?) => void`（推荐，最小改动）
  2. 用 React ref 暴露内部 state
  3. 提升 relateDevices 到调用方受控
- 本 plan 不强制解决此限制（acceptance criteria 未列），10-03 在接线 ExperienceEditForm 时定夺。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ExperienceInput DTO 扩 status? 字段**
- **Found during:** Task 1 tsc 验证
- **Issue:** service 层 `createExperience(input: ExperienceInput & { status?: ExperienceStatus })` 已在 10-01 扩了 status? 入参，但 renderer 的 ExperienceInput DTO（src/types/experience.ts）未同步扩 status? 字段。组件内 `onSubmit({ ...input, status: 'published' })` 触发 TS2353「'status' does not exist in type 'ExperienceInput | ExperienceUpdateInput'」
- **Fix:** 在 src/types/experience.ts ExperienceInput 接口加 `status?: ExperienceStatus` 字段（默认 'draft'，与 service 层签名逐字一致，保 Phase 7-9 AI 起草路径不变）
- **Files modified:** src/types/experience.ts
- **Commit:** e2b1506

## Self-Check: PASSED

**Files created/modified verified:**
- FOUND: src/components/knowledge/ExperienceEditForm.tsx
- FOUND: src/types/experience.ts (modified)
- FOUND: src/components/pages/ai/ReviewConfirmModal.tsx (modified)

**Commits verified:**
- FOUND: e2b1506 (feat 10-02 Task 1)
- FOUND: b95c44d (refactor 10-02 Task 2)
