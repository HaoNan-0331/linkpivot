---
phase: 11-ai-retrieval-reuse
plan: 02
subsystem: ai-retrieval
tags: [ai, retrieval, renderer, references, experience, session, modal]
requires:
  - "Plan 01 ai.ts chat() exp_answer 返回类型（references 含 kind:'experience' + expId/sourceSessionId/unsupported camelCase）"
  - "Phase 10 ExperienceDetailModal（经验详情 Modal 复用）"
  - "Phase 9 SessionMessagesModal（原始会话 Modal 复用）"
  - "preload.ts experience.get/getSessionMessages 已暴露（零改动）"
provides:
  - "ReferenceItem 联合类型（kb/experience/session）"
  - "ChatMsg.references 扩 ReferenceItem[]（向后兼容 KB 既有消费）"
  - "useAIChat exp_answer/kb_answer 双分支消费 + 联合类型 references 注入"
  - "ChatMessageList 末尾来源列表按 ref.kind 分流渲染 + 点击回查 Modal 触发"
affects:
  - "src/components/pages/ai/types.ts ChatMsg.references 联合化（下游消费者需 kind 分流）"
  - "src/components/pages/ai/useAIChat.ts handleSend 扩 exp_answer 分支"
  - "src/components/pages/ai/ChatMessageList.tsx references 渲染按 kind 分流 + 两个复用 Modal state"
tech-stack:
  added: []
  patterns:
    - "renderer 引用元数据联合类型分流（kind discriminator，与 KB 既有渲染共存）"
    - "点击拉详情 Modal 模式（experience.get + setState 触发，仿 ExperienceDetailModal 拉 devices useEffect）"
    - "零适配复用既有 Modal（sessionId 直传，内部自拉数据）"
    - "信任边界：references 只元数据，详情走既有 secure IPC + stripEncColumns"
key-files:
  created: []
  modified:
    - src/components/pages/ai/types.ts
    - src/components/pages/ai/useAIChat.ts
    - src/components/pages/ai/ChatMessageList.tsx
decisions:
  - "字段命名以 ai.ts:835 实际返回为准（camelCase expId/sourceSessionId），非 plan interfaces 文档笔误的 snake_case"
  - "exp_answer 消费时若 sourceSessionId 非空额外 push session 引用项（D-11-10 末尾列表含会话引用，ai.ts references 只返 experience 类型，session 在 renderer 拆出）"
  - "kb_answer 分支 map 补 kind:'kb'（ai.ts KB_SEARCH 返的 kbReferences 无 kind 字段，renderer 联合类型需显式 kind 类型安全）"
  - "ChatMessageList 用 renderRef 函数分流（kb/experience/else=session），session 走末尾 else 不写显式条件（注释标注），三分流完整"
  - "D-11-7 命令失支持用 antd Tag color='warning' 既有色枚举，不引自定义 hex 色（CONVENTIONS + UI-SPEC Color 锁定）"
  - "D-11-12 复用 Phase 10 ExperienceDetailModal + Phase 9 SessionMessagesModal 零新建，浏览只读场景不传 onEdit/onInvalidate 等回调"
metrics:
  duration: ~6min
  tasks: 2
  files: 3
  tests_added: 0
---

# Phase 11 Plan 02: 引用溯源 renderer 层 Summary

实现 Phase 11 引用溯源 renderer 层（RETRIEVE-03）：AI 回答末尾渲染来源列表（经验 + 会话引用），数据从 Plan 01 编排层 retrieveForAnswer.injected 记录拿（D-11-11 不需 AI 标记）。ChatMsg.references 扩 ReferenceItem 联合类型（kb/experience/session），ChatMessageList 按 ref.kind 分流渲染，经验引用点击复用 Phase 10 ExperienceDetailModal（window.api.experience.get 拉详情），会话引用点击复用 Phase 9 SessionMessagesModal（sessionId 直传零适配），命令失支持显「⚠ 命令已失支持」warning Tag（D-11-7）。

## What Was Built

### Task 1: types.ts references 联合类型 + useAIChat exp_answer 消费（commit 987b9c4）
- **types.ts**：新增导出 `ReferenceItem` 联合类型（kb / experience / session 三种），`ChatMsg.references` 改为 `ReferenceItem[]`，保留 KB 既有字段不破坏（kb 分支字段与原 `{docTitle,chunkTitle,docId}` 一致）
- **useAIChat.ts handleSend**：
  - import ReferenceItem
  - kb_answer 分支：references 注入时 map 补 `kind:'kb'`（ai.ts KB_SEARCH 返的 kbReferences 无 kind 字段，联合类型需显式 kind 类型安全；运行时若已有 kind 直接透传）
  - **扩 exp_answer 分支**：消费 ai.ts:835 返回的 `{ kind:'experience', expId, title, sourceSessionId, unsupported }` camelCase 字段（非 plan interfaces 文档笔误的 snake_case），每条 experience 引用额外检查 `sourceSessionId` 非空时 push 一条 `{ kind:'session', sessionId, title:'原始会话' }`（D-11-10 末尾列表含会话引用）
  - 两分支统一 setMessages 注入类型安全 ReferenceItem[]

### Task 2: ChatMessageList 末尾来源列表渲染 + 点击回查 Modal 复用（commit b683b84）
- **imports 扩**：ExperienceDetailModal（Phase 10 复用）+ SessionMessagesModal（Phase 9 复用）+ Tag（antd）+ ReferenceItem / Experience 类型
- **state**：detailExp/detailOpen（ExperienceDetailModal）+ sessionModalId/sessionModalOpen（SessionMessagesModal）
- **点击处理**：
  - `openExperience(expId)`：window.api.experience.get(expId).then(setDetailExp) + setDetailOpen(true)（仿 ExperienceDetailModal 拉 devices useEffect 模式，改为点击触发）
  - `openSession(sessionId)`：setSessionModalId + setSessionModalOpen（SessionMessagesModal 零适配，内部自拉 getSessionMessages）
- **renderRef 分流**：
  - `kind==='kb'`：保持既有 BookOutlined + docTitle — chunkTitle 渲染（不动）
  - `kind==='experience'`：可点击行（cursor:pointer + onClick openExperience），显「📖 {title}」+ 若 unsupported 显 `<Tag color="warning">⚠ 命令已失支持</Tag>`（D-11-7，antd 既有 warning 色不引新色）；title 属性「点击查看经验详情」
  - `kind==='session'`（else 分支）：可点击行 onClick openSession，显「💬 {title}」；title 属性「点击查看原始会话」
- **JSX 末尾**：渲染 `<ExperienceDetailModal open={detailOpen} experience={detailExp} onClose=.../>` + `<SessionMessagesModal open={sessionModalOpen} sessionId={sessionModalId} onClose=.../>`（D-11-12 复用不新建，浏览只读场景不传 onEdit 等回调）
- useState 置组件顶部不在 map 内，React hooks 顺序合法

## Verification

四绿门禁全绿（沿用 Phase 7-10 模式）：
1. `npx tsc -p tsconfig.web.json` — 0 error（strict + noUnusedLocals，联合类型 + Modal props + map 类型安全）
2. `npm run build`（vite renderer + preload）— 成功，ChatMessageList 打包无解析错误
3. `npm run build:electron-main`（esbuild main）— 成功（本 plan 不改 main，跑全量门禁确认零回归）
4. `npx vitest run` — 230/230 全绿（既有用例零回归，本 plan 无新增单测——renderer UI 渲染靠 tsc + build + 人工 checkpoint 验证）

acceptance grep 断言全通过：
- types.ts：`ReferenceItem|kind:'kb'|kind:'experience'|kind:'session'` 5 命中
- useAIChat.ts：exp_answer 3 处 / kind:'kb' 1 处
- ChatMessageList.tsx：ExperienceDetailModal 5 处（import + state type + openExperience + JSX 2）/ SessionMessagesModal 4 处 / kind 三分流（line 45 kb + line 53 experience + else session）/ window.api.experience.get 1 处 / unsupported 1 处 / 自定义 hex 色 0 增量（warning 走 antd Tag color 枚举）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - 字段命名契约对齐] ai.ts 实际返回 camelCase，非 plan interfaces 文档笔误的 snake_case**
- **Found during:** Task 1 types.ts 设计阶段，核对 ai.ts:835 实际返回
- **Issue:** plan `<interfaces>` 节写 `references: Array<{ exp_id; title; source_session_id; unsupported }>`（snake_case），但 prior_wave_handoff 与 ai.ts:835 实际返回 `{ kind:'experience', expId, title, sourceSessionId, unsupported }`（camelCase）。若按 plan 字面 snake_case 实现，运行时 parsed.references.expId 为 undefined
- **Fix:** 以 ai.ts:835 实际契约为准（camelCase），useAIChat exp_answer 分支按 r.expId / r.sourceSessionId 取值；ReferenceItem experience 分支字段也是 camelCase（expId）。types.ts 注释明确标注「ai.ts:835 实际返回 camelCase，非 snake_case」防后续误改
- **Files modified:** src/components/pages/ai/types.ts（注释）/ useAIChat.ts（exp_answer 消费字段名）
- **Commit:** 987b9c4

**2. [Rule 2 - 关键功能补全] session 引用在 renderer 拆出（ai.ts references 只返 experience 类型）**
- **Found during:** Task 1 exp_answer 消费设计
- **Issue:** ai.ts:835 exp_answer references 数组只含 `{kind:'experience', ...}`，未单独 push session 项；但 D-11-10 要求末尾列表含会话引用（点击回查原始会话）
- **Fix:** useAIChat exp_answer 分支消费时，每条 experience 引用检查 `sourceSessionId` 非空则额外 push 一条 `{kind:'session', sessionId, title:'原始会话'}` 引用项。session 引用从 experience 引用的 sourceSessionId 派生，不重复落库（ai.ts 不动避免回归，Plan 01 已稳定）
- **Files modified:** src/components/pages/ai/useAIChat.ts（exp_answer 分支）
- **Commit:** 987b9c4

**3. [Plan 拆分粒度] Task 1 单独 tsc 无法全绿（ChatMessageList 未改引用联合类型前的字段）**
- **Found during:** Task 1 验证
- **Issue:** plan 把 types.ts/useAIChat.ts（Task 1）与 ChatMessageList.tsx（Task 2）拆两 task，但 tsc 是全项目级别——Task 1 改完联合类型后，ChatMessageList.tsx:67 的 `ref.docTitle` 立即报 TS2339（ReferenceItem 联合无 docTitle），Task 1 单独 commit 时 tsc 必红
- **Fix:** Task 1 commit 中间状态（types.ts/useAIChat.ts 自身零 error，下游 ChatMessageList 待 Task 2 适配），Task 2 立即修 ChatMessageList 后四绿全绿。两 commit 都在 plan 范围内，最终 SUMMARY 自检全绿。属 plan 拆分粒度的必然中间态，非代码缺陷
- **Commit:** Task 1（987b9c4）+ Task 2（b683b84）合并后 tsc=0

## TDD Gate Compliance

Plan frontmatter `type: execute`，两 task 均 `type="auto"`（非 tdd）。本 plan 是 renderer UI 渲染层（types 联合扩展 + ChatMessageList JSX 分流 + Modal 接线），无独立可单测的纯逻辑单元（UI 渲染 + 点击触发 IPC + Modal state 靠 tsc + vite build + 人工 checkpoint 验证，与 Phase 9 03 / Phase 10 03 renderer 层同模式）。无 RED/GREEN gate 缺失警告。

## Self-Check: PASSED

文件存在性 + commit 存在性验证：
- FOUND: src/components/pages/ai/types.ts（ReferenceItem 联合类型）
- FOUND: src/components/pages/ai/useAIChat.ts（exp_answer 分支 + kb kind 补全）
- FOUND: src/components/pages/ai/ChatMessageList.tsx（renderRef 分流 + 两 Modal 复用）
- FOUND: commit 987b9c4（git log）
- FOUND: commit b683b84（git log）
- 四绿门禁：tsc=0 / vite build=0 / electron-main=0 / vitest 230/230

## Notes for Phase 11 Close

- RETRIEVE-03（引用溯源 + 可回查）renderer 层全落地：来源列表渲染（kb/experience/session 三类）+ 点击回查复用既有 Modal（零新建）
- 与 Plan 01 main 进程串联闭环：chat() exp_answer → useAIChat 消费 references 联合 → ChatMessageList 分流渲染 → 点击 experience.get/getSessionMessages 拉详情
- 信任边界红线守住：references 只含元数据（expId/title/sessionId/unsupported），renderer 永不收 attrs 密文；详情走既有 secure IPC + stripEncColumns（Phase 7/10 已防）
- 人工验证（end-of-phase checkpoint）：与 Phase 10 published 经验对话提问 → AI 回答末尾显来源列表 → 点击经验引用开 ExperienceDetailModal → 点击会话引用开 SessionMessagesModal → 命令失支持经验显 warning Tag
