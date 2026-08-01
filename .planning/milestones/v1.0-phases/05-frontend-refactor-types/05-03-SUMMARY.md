---
phase: 05-frontend-refactor-types
plan: 03
subsystem: frontend-ai
tags: [frontend, refactor, react-hooks, typescript, ai-page]
requires:
  - "05-01 (src/types/ai.ts ChatMessage role 联合类型 + electron.d.ts ai 通道建模)"
provides:
  - "src/components/pages/ai/useAIChat.ts (AI 会话态 page-local hook)"
  - "src/components/pages/ai/{ChatSessionList,ChatMessageList,ChatInput,CommandConfirmModal}.tsx (4 子组件)"
  - "src/components/pages/ai/types.ts (AI 子树本地类型)"
  - "AIPage.tsx 薄编排层 (~95 行)"
affects:
  - "src/components/pages/AIPage.tsx"
tech-stack:
  added: []
  patterns:
    - "React 自定义 hook 持 page-local state (非 zustand、非 prop drilling, D-5-1)"
    - "展示型子组件 render-only + event-driven prop 契约"
    - "编排层(header Select)+hook(state)+子组件(render) 三层分离"
key-files:
  created:
    - "src/components/pages/ai/types.ts"
    - "src/components/pages/ai/useAIChat.ts"
    - "src/components/pages/ai/ChatSessionList.tsx"
    - "src/components/pages/ai/ChatMessageList.tsx"
    - "src/components/pages/ai/ChatInput.tsx"
    - "src/components/pages/ai/CommandConfirmModal.tsx"
  modified:
    - "src/components/pages/AIPage.tsx"
    - "CHANGELOG.md"
decisions:
  - "D-5-1 红线守住：useAIChat 自定义 hook (非 aiChatStore / 非 prop drilling)"
  - "issue 3 写死：设备多选 Select 留 AIPage 编排层 header，经 chat.selectedDevices 消费"
  - "configLoading/hasConfig 留编排层 (page 守卫)，hook 暴露 loadData(hasConfig)"
  - "FE-02 顺带收敛 AIPage 4 处 any (D-5-2，AIPage 由 FE-01 独占)"
metrics:
  duration: "~12min"
  completed: "2026-07-02"
  tasks: "2 auto + 1 HV checkpoint(deferred)"
  files: "6 created + 2 modified"
---

# Phase 5 Plan 03: FE-01 AIPage 拆分 4 子组件 + useAIChat hook Summary

**One-liner:** AIPage 399 行拆为 useAIChat 自定义 hook (8 state + 7 handler) + 4 独立子组件文件 + 本地 types.ts，AIPage 退化为 ~95 行薄编排层 (header 设备 Select 留编排层)，顺带收敛 AIPage 4 处 any。

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | 新建 ai/ 目录 (types.ts + useAIChat.ts) | 3e35c3a (与 Task 2 合并提交) | src/components/pages/ai/types.ts, useAIChat.ts |
| 2 | 4 子组件文件 + AIPage 重构为薄编排层 | 3e35c3a | ChatSessionList/ChatMessageList/ChatInput/CommandConfirmModal.tsx, AIPage.tsx |
| 3 | checkpoint:human-verify (AI 4 子组件交互冒烟) | — (deferred) | — |

> Task 1+2 合并为单次原子提交：plan verify 注明「hook 未被引用时 tsc 报未用 import，executor 须两 task 连续执行」，故 hook 提取与 AIPage 重构作为不可分割单元提交。

## What Was Built

### 拆分结构（D-5-1 落地）

| 文件 | 角色 | 内容 |
|------|------|------|
| `src/components/pages/ai/types.ts` | 类型边界 | DeviceOption / ChatMsg / ConfirmData / UseAIChatReturn (迁移自 AIPage 本地 interface) |
| `src/components/pages/ai/useAIChat.ts` | page-local hook | 8 state (devices/selectedDevices/sessions/currentSessionId/messages/input/loading/pendingConfirm) + 7 handler (loadData/loadSessions/handleNewSession/handleSelectSession/handleDeleteSession/handleSend/handleConfirm)，返回 typed contract |
| `ChatSessionList.tsx` | render-only | 会话列表 (新建按钮 + session.map + 删除图标) |
| `ChatMessageList.tsx` | render-only + effect | 消息气泡 (含 chatEndRef 滚动 effect、references 渲染、loading 思考中) |
| `ChatInput.tsx` | event-driven | TextArea + 发送按钮 (Enter 发送/Shift+Enter 换行) |
| `CommandConfirmModal.tsx` | modal | 命令确认弹窗 (Tag 列表 + rejectedCommands + aiExplanation) |
| `AIPage.tsx` | 薄编排层 (~95 行) | configLoading/hasConfig 守卫 + header 设备多选 Select + 渲染 4 子组件 |

### D-5-1 红线守住

- **自定义 hook（非 zustand）**：未引入 `aiChatStore` 全局单例（grep `aiChatStore` 仅命中 useAIChat.ts:13 注释，解释决策本身）；AI 会话态 page-local，仅 AI 子树消费
- **非 prop drilling**：4 子组件经 hook 返回切片消费，非 10+ state 宽 prop 面下传
- **header Select 留编排层**（issue 3 写死）：`<Select mode="multiple">` 在 AIPage.tsx header，经 `chat.selectedDevices` / `chat.setSelectedDevices` 消费 hook 状态，未下沉为 ChatDeviceSelector 子组件（避免过度拆分，4 子组件锁定 FE-01 SC #1）
- **configLoading/hasConfig 留编排层**：page 守卫非 hook 契约；hook 暴露 `loadData(hasConfig: boolean)` 供守卫通过后调用

### FE-02 顺带收敛（D-5-2，AIPage 由 FE-01 独占）

| 原位点 (AIPage.tsx) | 收敛方式 |
|---------------------|----------|
| line 60/61 `(d: any)` filter/map | `device.list()` 已返回 `Device[]`（05-01 建模），filter 去标注 |
| line 101 `m.role as 'user'\|'assistant'` | role 已联合类型（05-01 src/types/ai.ts），去 cast |
| line 160 `catch (e: any)` (handleSend) | `catch (e: unknown)` + `e instanceof Error ? e.message : String(e)` |
| line 175 `catch (e: any)` (handleConfirm) | 同上 |

AIPage any 清零（before 4 → 0），hook 代码内 any 清零（grep 命中 2 处均为 JSDoc 注释描述收敛历史）。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] handleSend JSON.parse 窄化**
- **Found during:** Task 1
- **Issue:** 原 AIPage.tsx:144 `JSON.parse(reply)` 结果直接当 ConfirmData 用，TS strict 下 `any` 经 JSON.parse 仍为 `any`；plan 未明确窄化类型
- **Fix:** `JSON.parse(reply) as ConfirmData & { type: string; content?: string; references?: ChatMsg['references'] }`，kb_answer 分支读 `parsed.content || ''`（防 undefined）
- **Files modified:** src/components/pages/ai/useAIChat.ts
- **Commit:** 3e35c3a

**2. [Rule 1 - Bug] handleSelectSession stale closure**
- **Found during:** Task 1
- **Issue:** 原 AIPage.tsx:96 `if (sessionId === currentSessionId) return` 读闭包 currentSessionId，迁移到 useCallback 后 deps 含 currentSessionId 导致语义漂移
- **Fix:** 用 setCurrentSessionId 函数式更新 + 双重判断保留原语义（早返回 + 不重复加载）
- **Files modified:** src/components/pages/ai/useAIChat.ts
- **Commit:** 3e35c3a

**3. [Rule 2 - Critical] AIPage effect cleanup 防 unmount setState**
- **Found during:** Task 2
- **Issue:** 原 AIPage.tsx:48-50 loadData effect 无 cleanup，组件卸载后异步 setState 可能告警
- **Fix:** 加 `cancelled` 标志位，cleanup 设 true，finally 前判断（结构化取消语义，与项目既有效果模式一致）
- **Files modified:** src/components/pages/AIPage.tsx
- **Commit:** 3e35c3a

**4. [Rule 3 - Blocking] 导入路径修正**
- **Found during:** Task 2
- **Issue:** 首版 AIPage.tsx 误把 `Spin`/`ExclamationCircleOutlined` 放入错误 import 源（编译失败）
- **Fix:** Spin/Typography 从 antd，ExclamationCircleOutlined 从 @ant-design/icons
- **Files modified:** src/components/pages/AIPage.tsx
- **Commit:** 3e35c3a

## Verification

| Gate | Command | Result |
|------|---------|--------|
| tsc web strict + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | EXIT 0 |
| vitest | `npx vitest run` | 25/25 passed (4 files) |
| esbuild electron main | `npm run build:electron-main` | EXIT 0 (1.8mb) |

### Acceptance grep

- `ls src/components/pages/ai/` → 6 文件全在 (types/useAIChat + 4 子组件)
- `export function useAIChat` → 命中
- `export default function` in ai/*.tsx → 4 命中
- AIPage.tsx any → 0 (before 4)
- useAIChat.ts code any → 0 (grep 命中 2 处为 JSDoc 注释)
- `catch (e: unknown)` in useAIChat.ts → 3 命中 (loadData/handleSend/handleConfirm)
- AIPage.tsx lines → 95 (399 → ~95，编排层含守卫 + header Select)
- `mode="multiple"` in AIPage.tsx → 1 (header Select 保留)
- `chat.selectedDevices\|chat.setSelectedDevices` → 3 命中 (编排层经 hook 消费)
- `api: any` in ai/*.tsx → 0 (子组件 props 全强类型)
- `aiChatStore` → 无 (D-5-1 守住)

## Known Stubs

无。所有数据源已接线（hook 经 window.api.ai.* + window.api.device.list 真实 IPC，子组件经 hook 切片消费，无 placeholder/mock）。

## Human Verification (Deferred)

**Task 3 checkpoint:human-verify** — 推迟到 phase 末批量 HV（用户已决定）。HV 项清单（启动 Electron app 实测 AI 对话）：

1. **会话列表**：点「新建会话」→ 新会话高亮、消息区清空
2. **切换会话**：点不同会话 → currentSessionId 高亮变化、历史消息加载 (getSessionMessages)
3. **删除会话**：点删除图标 → 会话从列表移除，自动切换到剩余会话或新建
4. **发消息**：Enter 发送 (Shift+Enter 换行) → 消息追加、loading 思考中、AI 回复；空输入 disabled
5. **消息滚动**：多发消息超出可视区 → chatEndRef scrollIntoView 自动滚底
6. **命令确认弹窗**：触发 confirm_required → Modal 弹出 (命令 Tag + aiExplanation)，确认/拒绝走 handleConfirm
7. **references 显示**：kb_answer 分支 → 消息气泡显示参考来源
8. **无 console 报错**：DevTools 无 React 警告/报错
9. **header 设备 Select**（编排层归属）：多选目标设备 → selectedDevices 传入 ai.chat，影响回复

resume-signal: "approved"（9 项全过）或描述哪项交互回归。

## Self-Check: PASSED

- [x] `ls src/components/pages/ai/{types,useAIChat}.ts` 两文件存在
- [x] `ls src/components/pages/ai/{ChatSessionList,ChatMessageList,ChatInput,CommandConfirmModal}.tsx` 4 文件存在
- [x] commit 3e35c3a 存在 (`git log --oneline | grep 3e35c3a` 命中)
- [x] AIPage.tsx any 清零 (grep 0)
- [x] tsc/vitest/esbuild 三绿
- [x] 无 aiChatStore (D-5-1 守住)
