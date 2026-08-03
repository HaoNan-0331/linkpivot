# Phase 9: Human Review & Confirmation - Pattern Map

**Mapped:** 2026-08-03
**Files analyzed:** 7 (4 new + 3 modify)
**Analogs found:** 7 / 7

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `electron/services/experienceService.ts` (modify — add `confirmDrafts` / `listDrafts` / `getSessionMessages`) | service | batch transaction + CRUD | itself (`invalidateExperience` / `updateExperience` 事务模式 + `deleteExperience`) | exact (same file) |
| `electron/ipc/experienceIpc.ts` (modify — add 3 channels) | IPC gateway | request-response | itself (existing 10 `experience:*` channels) | exact (same file) |
| `electron/preload.ts` (modify — expose 3 new APIs) | preload bridge | request-response | itself (`experience: { ... }` block lines 124-136) | exact (same file) |
| `src/types/experience.ts` (modify — add 3 DTOs) | types | - | itself (`DraftingResult` / `ExperienceUpdateInput`) | exact (same file) |
| `src/components/pages/ai/ReviewConfirmModal.tsx` (new) | React component | interactive form + batch submit | `src/components/pages/ai/CommandConfirmModal.tsx` + `src/components/topology/AddDeviceModal.tsx` | role-match (Modal 先例；master-detail 左右分栏新组合，无直接先例) |
| `src/components/pages/ai/SessionMessagesModal.tsx` (new — 只读子 Modal) | React component | read-only display | `src/components/pages/ai/CommandConfirmModal.tsx` (只读滚动 Modal) | role-match |
| `src/components/pages/AIPage.tsx` + `src/components/pages/ai/useAIChat.ts` (modify — 「待确认 N 条」角标入口 + 开 ReviewConfirmModal) | page + hook | UI orchestration | `useAIChat.ts` `handleSummarize` (lines 168-189) + `AIPage.tsx` Modal 挂载 (line 99) | exact (same integration point as Phase 8) |

> Master-detail 左右分栏 Modal（D-9-3）项目无直接先例（项目 Modal 均为单栏表单/列表），但复用 Modal + Ant Design `Row/Col` 或 flex 容器即可，无新依赖。planner 注意在 PLAN 中标注「新组合，复用 Modal 基础」。

---

## Pattern Assignments

### `electron/services/experienceService.ts` (service, batch transaction + CRUD)

**Analog:** itself — `invalidateExperience` / `updateExperience` / `deleteExperience` + `dbGetter` 测试钩子

#### 函数式 service + 模块级 MK（已就位，新增函数无需再建文件）

文件顶部已有（lines 26-44）：
```ts
let MK = ''
export function setExperienceMasterKey(key: string) { MK = key }
export const MAX_BATCH = 1000
let dbGetter: () => Database.Database = getDatabase
export function _setExperienceDbGetter(fn: () => Database.Database): void { dbGetter = fn }
function db(): Database.Database { return dbGetter() }
```
新增 `confirmDrafts`/`listDrafts`/`getSessionMessages` 直接加在同一文件（同函数式、同 MK 作用域、同 db getter），**无需新建 reviewService**（与 CONTEXT `<code_context>` Integration Points「扩 experienceService 或新 reviewService」一致，扩现有文件最小改动）。

#### `confirmDrafts` 受控状态接口模式（D-9-1，draft→published 单事务原子 D-9-4）

照 `invalidateExperience`（lines 307-313）受控接口范式 — 不动 `updateExperience` 白名单（CR-01），新增专用接口改 status：
```ts
// 受控接口：invalidateExperience（lines 307-313）—— status 改变的同模式范例
export function invalidateExperience(id: string): any {
  const conn = db()
  conn.prepare(
    `UPDATE experiences SET invalid_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(id)
  return getExperience(id)
}
```

`confirmDrafts` 批量单事务（照 `updateExperience` lines 295-299 的 `conn.transaction(() => {...})()` 模式扩展为多写）：
```ts
// updateExperience 事务包裹范例（lines 295-299）
const conn = db()
const tx = conn.transaction(() => {
  conn.prepare(`UPDATE experiences SET ${sets.join(', ')} WHERE id = ?`).run(...params)
})
tx()
```
`confirmDrafts` 在单一 `db.transaction(() => { ... })()` 内逐条：
- 采纳的 draft：`UPDATE experiences SET status='published', updated_at=datetime('now','localtime') WHERE id=?`（prepared statement 循环外复用，CONVENTIONS Pattern 4）
- UPDATE 草稿 + 用户勾「标失效旧条目」：调 `invalidateExperience(duplicateOfExpId)`（D-9-2，复用现有函数）
- 丢弃：调 `deleteExperience(id)`（D-9-6，复用 lines 316-318 hard DELETE）
- 关联设备变更：调 `relateDevice`/`unrelateDevice`（lines 323-332）
- throw 即 ROLLBACK，全成全败（CONVENTIONS Pattern 5）

质量门 service 兜底校验：照 `validateAndStringifyAttrs`（lines 122-131）的 troubleshooting severity 强校验模式，`confirmDrafts` 入口对采纳的 troubleshooting 草稿二次校验 severity/symptoms/resolution。

批量上限守卫：照 `listExperiences` limit 守卫（lines 198-202）：
```ts
if (input.drafts.length > MAX_BATCH) throw new Error('批量上限超过 MAX_BATCH')
```

#### `listDrafts`（D-9-7）

直接复用 `listExperiences({ status: 'draft' })`（lines 196-254 已支持 status 过滤分支），或在 service 加窄化封装：
```ts
export function listDrafts(): any[] {
  return listExperiences({ status: 'draft', includeInvalid: true, limit: MAX_BATCH, offset: 0 }).rows
}
```
（draft 行 `invalid_at` 为 NULL，`includeInvalid` 取值不影响；保留语义清晰。）

#### `getSessionMessages`（D-9-5，复用 `getChatHistory`）

`getChatHistory` 已在 `electron/services/ai.ts:192-209` 解密返明文（`decField(row.content_enc, MK)`）。`experienceService.ts` 内直接 import 复用：
```ts
import { getChatHistory } from './ai'
export function getSessionMessages(sessionId: string): any[] {
  return getChatHistory(sessionId)  // 已 decField 解密，返 {id,role,content,deviceId,createdAt}[]
}
```
（信任边界：design D-04 明文回链，用户核对自己对话；single-machine safeStorage，不做 PII 脱敏。）

#### 函数签名建议（planner 终定）

```ts
export interface ConfirmDraftItem {
  expId: string
  action: 'adopt' | 'discard'
  // adopt 时携带用户编辑后的字段（同 ExperienceUpdateFields 形态 + 关联设备变更）
  fields?: ExperienceUpdateFields
  relateDevices?: string[]      // 全量期望关联 device_id 列表（diff 后调 relateDevice/unrelateDevice）
  // UPDATE 草稿（duplicate_of_exp_id 非空）+ 用户勾「标失效旧条目」
  supersedeOld?: boolean
}
export interface ConfirmDraftsInput { drafts: ConfirmDraftItem[] }
export function confirmDrafts(input: ConfirmDraftsInput): { adopted: number; discarded: number; superseded: number }
export function listDrafts(): any[]
export function getSessionMessages(sessionId: string): any[]
```

---

### `electron/ipc/experienceIpc.ts` (IPC gateway, request-response)

**Analog:** itself — existing 10 channels (lines 51-82)

#### 注册模式（lines 51-82）

```ts
export function registerExperienceIpc() {
  // 全 secure 包装（鉴权 + 异常脱敏）
  ipcMain.handle('experience:list', secure((_e, opts?: ExperienceListInput) =>
    listExperiences(opts || {})))
  // ...
  ipcMain.handle('experience:delete', secure((_e, id: string) =>
    deleteExperience(id)))
  ipcMain.handle('experience:listDevices', secure((_e, experienceId: string) =>
    stripEncColumns(listDevicesByExperience(experienceId))))
}
```

新增 3 channel 直接追加在 `registerExperienceIpc()` 内，**沿用 `secure` 包装 + 同文件 `stripEncColumns` 兜底**：
```ts
import { confirmDrafts, listDrafts, getSessionMessages } from '../services/experienceService'
// ...
ipcMain.handle('experience:confirmDrafts', secure((_e, input: ConfirmDraftsInput) => {
  if (!input || !Array.isArray(input.drafts) || input.drafts.length > MAX_BATCH)
    throw new Error(`批量上限 ${MAX_BATCH} 条`)
  return confirmDrafts(input)
}))
ipcMain.handle('experience:listDrafts', secure(() => listDrafts()))
ipcMain.handle('experience:getSessionMessages', secure((_e, sessionId: string) =>
  getSessionMessages(sessionId)))
```

注意 `MAX_BATCH` 在 service 文件已 `export const MAX_BATCH = 1000`（experienceService.ts:32），IPC 层 import 复用（与 ouiIpc.ts 模式一致），避免双常量漂移。

channel 命名 `experience:confirmDrafts` / `experience:listDrafts` / `experience:getSessionMessages` — camelCase 复合 action，与既有 `relateDevice`/`unrelateDevice`/`listByDevice`/`listDevices` 一致（experienceIpc.ts:28-31 注释明示）。

---

### `electron/preload.ts` (preload bridge, request-response)

**Analog:** itself — `experience: { ... }` block (lines 124-136)

```ts
experience: {
  list: (opts?: unknown) => ipcRenderer.invoke('experience:list', opts),
  get: (id: string) => ipcRenderer.invoke('experience:get', id),
  // ...
  summarizeSession: (sessionId: string) => ipcRenderer.invoke('experience:summarizeSession', sessionId),
},
```

追加 3 行同形态（`unknown` 入参类型保留与现有一致）：
```ts
confirmDrafts: (input: unknown) => ipcRenderer.invoke('experience:confirmDrafts', input),
listDrafts: () => ipcRenderer.invoke('experience:listDrafts'),
getSessionMessages: (sessionId: string) => ipcRenderer.invoke('experience:getSessionMessages', sessionId),
```

---

### `src/types/experience.ts` (types, modify)

**Analog:** itself — `DraftingResult` (lines 90-96) + `ExperienceUpdateInput` (lines 35-41)

```ts
export interface DraftingResult {
  empty: boolean
  demoMode: boolean
  created: Array<{ exp_id: string; title: string; category: ExperienceCategory }>
  updated: Array<{ exp_id: string; title: string; category: ExperienceCategory; duplicate_of_exp_id: string }>
  noop: Array<{ duplicate_of_exp_id: string; reasoning: string }>
}
```

新增 3 DTO（与 service `ConfirmDraftItem`/`ConfirmDraftsInput` 对齐，renderer 侧类型）：
```ts
export interface ConfirmDraftItem {
  expId: string
  action: 'adopt' | 'discard'
  fields?: ExperienceUpdateInput   // 复用现有 DTO
  relateDevices?: string[]
  supersedeOld?: boolean
}
export interface ConfirmDraftsInput { drafts: ConfirmDraftItem[] }
export interface ConfirmDraftsResult { adopted: number; discarded: number; superseded: number }
export type DraftSummary = Experience   // listDrafts 返 Experience[]，复用现有 DTO
export interface SessionMessage {
  id: string
  role: string
  content: string
  deviceId: string | null
  createdAt: string
}
```
（DTO 字段命名遵循文件既有约定：renderer 入参 camelCase，DB 行返原生 snake_case 保留 — 见文件头注释 lines 1-3。）

---

### `src/components/pages/ai/ReviewConfirmModal.tsx` (React component, interactive form + batch submit)

**Analog:** `CommandConfirmModal.tsx` (Modal 结构 + footer 按钮 + open/onCancel) + `AddDeviceModal.tsx` (Modal + 列表勾选 + Table + handleOk 校验提交)

#### Modal 基础结构（CommandConfirmModal.tsx lines 9-23）

```tsx
interface CommandConfirmModalProps {
  pendingConfirm: ConfirmData | null
  onConfirm: (approved: boolean) => void
}
export default function CommandConfirmModal({ pendingConfirm, onConfirm }: CommandConfirmModalProps) {
  return (
    <Modal
      open={!!pendingConfirm}
      title={`命令执行确认（${pendingConfirm?.commands?.length || 0} 条命令）`}
      onCancel={() => onConfirm(false)}
      footer={[
        <Button key="reject" danger onClick={() => onConfirm(false)}>拒绝执行</Button>,
        <Button key="approve" type="primary" onClick={() => onConfirm(true)}>确认执行</Button>,
      ]}
    >
      {/* body */}
    </Modal>
  )
}
```

#### Modal + 列表勾选 + 提交校验（AddDeviceModal.tsx lines 23-86）

```tsx
const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
const [loading, setLoading] = useState(false)
useEffect(() => {
  if (open) {
    setLoading(true)
    window.api.device.list().then((list) => setDevices(list)).finally(() => setLoading(false))
    setSelectedRowKeys([])
  }
}, [open])
const handleOk = () => {
  if (selectedRowKeys.length === 0) { message.warning('请选择至少一个设备'); return }
  // ... 组装提交
  onConfirm(newNodes)
  setSelectedRowKeys([])
}
```
AntD `<Modal>` + `<Table rowSelection>` + `message.warning` 校验 + `window.api.*` 异步调用 + `loading` 防重复，全部可直接照搬到 ReviewConfirmModal。

#### D-9-3 master-detail 左右分栏（新组合，复用 Modal + AntD flex）

宽 Modal ~80vw（`<Modal width="80vw">`），body 内 flex 左右分栏：
- 左：`<Table>` 或列表渲染 draft（每行 Checkbox 采纳/丢弃 + Tag 标注 ADD/UPDATE/置信度 + 质量门未过标红），列表头「全选采纳/全选丢弃」
- 右：选中条目编辑 `<Form>`（标题/分类/内容/attrs 模板字段/标签/关联设备），分类切换动态渲染 attrs（troubleshooting 显 symptoms/root_cause/resolution/prevention/severity，其余 title/content/tags）

项目无 Drawer 先例（CONTEXT D-9-3），用 Modal 是「代码读起来像周围代码」的硬约束。

#### Props 签名建议

```tsx
interface ReviewConfirmModalProps {
  open: boolean
  onClose: () => void
  initialDraftIds?: string[]   // Phase 8 summarizeSession 完成后传入 created/updated exp_id 列表
}
```
组件内 `useEffect(open)` 调 `window.api.experience.listDrafts()` 或按 `initialDraftIds` 批量 `experience.get`，再 `experience.confirmDrafts` 提交。

---

### `src/components/pages/ai/SessionMessagesModal.tsx` (React component, read-only display)

**Analog:** `CommandConfirmModal.tsx` 只读滚动 body (lines 24-52)

```tsx
<div style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, marginTop: 12 }}>
  <strong>AI 说明:</strong>
  <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', fontSize: 13 }}>
    {pendingConfirm.aiExplanation}
  </div>
</div>
```
子 Modal 套同款 `overflowY: 'auto'` 滚动容器渲染 `SessionMessage[]`（role: content 每行，照 experienceDrafting.ts:54 `buildConversationText` 同格式）。`source_session_id` 不存在时回链提示「原会话已不可查」（CONTEXT Claude's Discretion 边界处理）。

Props：
```tsx
interface SessionMessagesModalProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
}
```
组件内调 `window.api.experience.getSessionMessages(sessionId)`。

---

### `src/components/pages/AIPage.tsx` + `src/components/pages/ai/useAIChat.ts` (page + hook, modify)

**Analog:** itself — Phase 8 `handleSummarize` + Modal 挂载

#### 角标入口（AntD `Badge`，新组件，无既有先例但 AntD 6 标准用法）

`AIPage.tsx`「经验总结」按钮旁（ChatInput.tsx:42-50）加 `<Badge count={pendingCount}>`，count 来自 `listDrafts().length`。

#### 开 ReviewConfirmModal（照 AIPage.tsx:99 挂 CommandConfirmModal 模式）

```tsx
// AIPage.tsx:99 现有
<CommandConfirmModal pendingConfirm={chat.pendingConfirm} onConfirm={chat.handleConfirm} />
// 新增同款
<ReviewConfirmModal open={reviewOpen} onClose={() => setReviewOpen(false)} initialDraftIds={...} />
```

#### hook 状态扩展（照 useAIChat.ts:31 `const [summarizing, setSummarizing] = useState(false)` + lines 168-189 `handleSummarize`）

`handleSummarize` 完成后（useAIChat.ts:182 `message.success` 后）改为：开 ReviewConfirmModal + 传入 `result.created`/`result.updated` 的 `exp_id` 列表（D-9-4 纵览后统一确认）。

---

## Shared Patterns

### IPC 鉴权（红线，不可回退）
**Source:** `electron/utils/authGuard.ts` via `electron/ipc/experienceIpc.ts:15` `import { secure } from '../utils/authGuard'`
**Apply to:** 全部 3 个新 channel
```ts
ipcMain.handle('experience:confirmDrafts', secure((_e, input) => { ... }))
```
全 `secure` 包装（鉴权 + 异常脱敏），无 `safe` 登录前通道（经验属特权操作）。

### db.transaction 原子多写（CONVENTIONS Pattern 5）
**Source:** `experienceService.ts:295-299` (`updateExperience` 事务)
**Apply to:** `confirmDrafts`（采纳 + supersede + discard 单事务全成全败）
```ts
const tx = conn.transaction(() => { /* 全部多写 */ })
tx()   // throw ROLLBACK
```

### Prepared Statement 循环外复用（CONVENTIONS Pattern 4）
**Source:** `experienceService.ts:180-183` (createExperience prepare) / `experienceService.ts:359-361` (incReuseCount)
**Apply to:** `confirmDrafts` 批量循环内
```ts
const stmtPublish = conn.prepare(`UPDATE experiences SET status='published', updated_at=datetime('now','localtime') WHERE id = ?`)
for (const d of drafts) { if (d.action === 'adopt') stmtPublish.run(d.expId) }
```

### 受控状态接口模式（不改 update 白名单，CR-01）
**Source:** `experienceService.ts:307-313` (`invalidateExperience`) + `experienceService.ts:359-365` (`incReuseCount`/`touchLastVerifiedAt`)
**Apply to:** `confirmDrafts`（draft→published 同模式新增专用接口，不复活 `updateExperience` 的 status 字段）

### 字段加密只走 encField/decField
**Source:** `experienceService.ts:4` `import { encField, decField } from '../utils/crypto'` + `rowToExperience` lines 137-163
**Apply to:** Phase 9 新接口不读写新加密列（attrs_enc 已由 create/update 处理；confirmDrafts 只改 status + 调 invalidate/delete/relate，复用现有加密路径）。`getSessionMessages` 经 `getChatHistory` 间接用 `decField`（ai.ts:205）。

### 批量上限 MAX_BATCH
**Source:** `experienceService.ts:32` `export const MAX_BATCH = 1000` + IPC 层 import
**Apply to:** `experience:confirmDrafts`（IPC 层校验 `input.drafts.length > MAX_BATCH` throw）

### 异常脱敏 + console.error
**Source:** authGuard `secure` 内 `console.error('[ipc] handler error:', err)` + `throw new Error(sanitizeMessage(...))`
**Apply to:** 全新 channel 自动获得（经 `secure` 包装）

### React 组件 Modal 惯例
**Source:** `CommandConfirmModal.tsx` (open/title/onCancel/footer 模式) + `AddDeviceModal.tsx` (Table 勾选 + handleOk 校验)
**Apply to:** ReviewConfirmModal / SessionMessagesModal（项目无 Drawer，全用 Modal）

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| (none — 全部文件有 exact/role-match analog) | - | - | Master-detail 左右分栏虽无直接先例，但复用 Modal + AntD flex 即可，无需新依赖；planner 在 PLAN 中标注「新组合」即可。 |

---

## Metadata

**Analog search scope:**
- `electron/services/experienceService.ts` / `experienceDrafting.ts` / `ai.ts`
- `electron/ipc/experienceIpc.ts`
- `electron/preload.ts`
- `src/types/experience.ts`
- `src/components/pages/ai/CommandConfirmModal.tsx` / `useAIChat.ts` / `ChatInput.tsx`
- `src/components/pages/AIPage.tsx`
- `src/components/topology/AddDeviceModal.tsx`
- `electron/main.ts`（IPC 注册 + MK 注入挂载点核实）

**Files scanned:** 11
**Pattern extraction date:** 2026-08-03
