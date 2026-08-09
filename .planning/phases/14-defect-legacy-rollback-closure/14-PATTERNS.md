---
phase: 14
name: Defect & Legacy Rollback Closure
mapped: 2026-08-09
files_analyzed: 8
analogs_found: 8 / 8
---

# Phase 14: Defect & Legacy Rollback Closure - Pattern Map

**Mapped:** 2026-08-09
**Files analyzed:** 8（BUG-1 改动主体 1 + FIX-02 三处现状 3 + DEFER-LOG analog 1 + 迁移幂等守卫 1 + 测试 mock 范式 1 + 消费方面板 1）
**Analogs found:** 8 / 8（全文件均找到强匹配 analog）

> 本 phase 为**缺陷修复 + 旧规划项甄别收尾**，不加新功能、不改业务表 schema（除非 BUG-1 基线机制选定加表/列方案）。本文件聚焦 CONTEXT.md `<code_context>` 段**未覆盖的现状代码摘录**，供 planner `read_first` 与 executor 参考。CONTEXT 已给的 analog（`recordChange` helper / `_setExperienceDbGetter` mock 范式 / 甄别退路模式）此处不重复，仅补现状细节。

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `electron/services/anomalyService.ts` (BUG-1 修 `processARPEntries` 全新 IP 分支 + 首次基线机制) | service | CRUD (写入链 + 计数读取) | 自身既有 `entryTx` / `recordChange` / `getStats` 结构（service 静态类 facade 范例 `ouiService.ts`） | exact (改动落在既有结构内，零新代码路径) |
| `electron/services/ai.ts` (FIX-02 #2 `ai_exec_logs` 落库现状核对 / #3 会话标题位置核对) | service | request-response (AI 命令执行链) | 自身既有 `createLog` 调用链（`ai.ts:891-900`）+ renderer `useAIChat.ts:133-137` 标题更新 | exact (FIX-02 #2/#3 甄别结论倾向"已满足"，见下) |
| `src/components/pages/ai/CommandConfirmModal.tsx` (FIX-02 #1 confirm 防重复核对) | component | request-response (弹窗 → IPC) | `src/components/pages/ai/ChatInput.tsx` (loading+disabled 防重复 analog) + `useAIChat.handleConfirm` 既有 `setPendingConfirm(null)` 关窗锁 | role-match (按钮 loading+disabled 写法 analog) |
| `electron/database/migrations.ts` (BUG-1 基线机制若选"加列/加表"方案的幂等守卫 analog) | migration | DDL (幂等 ALTER/rebuild) | 自身 v1/v2 (`hasColumn`) + v5/v6/v11 (`sqlite_master` 特征串) | exact (双形式幂等守卫范例) |
| `electron/services/aiExecLogger.ts` (FIX-02 #2 落库现状核对佐证) | service | CRUD (INSERT/UPDATE) | 自身 `createLog` (line 8-34) | exact |
| `src/components/pages/ai/useAIChat.ts` (FIX-02 #1/#3 甄别佐证:关窗锁 + 标题位置) | hook | request-response (renderer IPC 编排) | 自身 `handleConfirm` (line 195-225) + `handleSend` (line 132-137) | exact |
| `src/components/ip-management/AnomalyTab.tsx` (BUG-1 消费方:面板统计 + 导出 CSV) | component | request-response (消费 `getStats`/`getChanges`) | 自身 (BUG-1 修复后 `newIp` 不再恒零的可见性入口) | exact (不改，仅验证可见性) |
| `.planning/phases/14-defect-legacy-rollback-closure/14-02-DEFER-LOG.md` (FIX-02 甄别登记产出) | config (规划产出文档) | transform (grep+核对 → FIXED/DEFER 结论) | `13-02-DEFER-LOG.md` | exact (结构 + 写法范例) |

---

## Pattern Assignments

### 1. `electron/services/anomalyService.ts` (service, CRUD) — BUG-1 改动主体

**Analog:** 自身既有 `entryTx` / `recordChange` / `getStats` 结构（零新代码路径，改动落在既有事务边界内）

#### 1.1 `processARPEntries` 整批单事务 + 条目级 SAVEPOINT（BUG-1 改动落点）

**Source:** `electron/services/anomalyService.ts:69-129`

```typescript
static processARPEntries(entries: Array<{ ip: string; mac: string }>): IPMACChange[] {
  const db = getDatabase()
  const changes: IPMACChange[] = []
  const now = new Date().toISOString()
  const excluded = this.preloadExcludedSet(db)
  // 4 个 prepared statement 提到循环外复用（消除循环内重复解析）
  const stmtCurrentBinding = db.prepare('SELECT id, mac FROM ip_mac_bindings WHERE ip = ? AND is_active = 1')
  const stmtDeactivate = db.prepare('UPDATE ip_mac_bindings SET is_active = 0 WHERE id = ?')
  const stmtUpdateLastSeen = db.prepare('UPDATE ip_mac_bindings SET last_seen = ? WHERE id = ?')
  const stmtOldBinding = db.prepare('SELECT mac FROM ip_mac_bindings WHERE ip = ? ORDER BY last_seen DESC LIMIT 1')

  // 嵌套事务（better-sqlite3 自动用 SAVEPOINT）包裹单条写逻辑
  const entryTx = db.transaction((entry: { ip: string; mac: string }) => {
    const { ip, mac } = entry
    if (this.isIPExcludedCached(ip, excluded)) return
    const currentBinding = stmtCurrentBinding.get(ip) as { id: number; mac: string } | undefined

    if (currentBinding) {
      if (currentBinding.mac !== mac) {
        const change = this.recordChange(ip, currentBinding.mac, mac, 'mac_changed')  // mac 变化 → recordChange('mac_changed')
        if (change) changes.push(change)
        stmtDeactivate.run(currentBinding.id)
        this.createBinding(db, ip, mac, now)
      } else {
        stmtUpdateLastSeen.run(now, currentBinding.id)
      }
    } else {
      const oldBinding = stmtOldBinding.get(ip) as { mac: string } | undefined
      if (oldBinding) {
        const change = this.recordChange(ip, null, mac, 'ip_reused')  // 历史复用 → recordChange('ip_reused')
        if (change) changes.push(change)
      }
      // ⚠️ BUG-1 根因：else 分支（currentBinding 与 oldBinding 都不存在 = 全新 IP）当前只 createBinding，
      //    缺 this.recordChange(ip, null, mac, 'new_ip')  ← FIX-01 补这一行（+ 首次基线判定：基线建立前跳过）
      this.createBinding(db, ip, mac, now)
    }
  })

  // 整批单事务：条目级 try/catch（单条失败 ROLLBACK TO savepoint 不影响整批）
  const runBatch = db.transaction(() => {
    for (const entry of entries) {
      try { entryTx(entry) }
      catch (e: any) { console.error('[anomaly] processARPEntries 条目处理失败:', entry.ip, e.message) }
    }
  })
  runBatch()
  return changes
}
```

**改动要点（D-14-1）：** 在 `entryTx` 的 else 分支（line 104-111 区间），`oldBinding` 不存在的子分支内，`createBinding` 之前/之后补 `this.recordChange(ip, null, mac, 'new_ip')`，并加**首次基线判定**（基线建立前跳过 `new_ip`，建立后新增 IP 才报）。改动自动复用既有 `entryTx` SAVEPOINT 事务边界 + `runBatch` 整批单事务 + 条目级 try/catch（单条失败不影响整批）。

#### 1.2 `recordChange` 写入 helper 签名 + SQL（CONTEXT 已点名，此处补完整源码供 executor 直接复用）

**Source:** `electron/services/anomalyService.ts:139-146`

```typescript
private static recordChange(ip: string, oldMac: string | null, newMac: string | null, changeType: ChangeType): IPMACChange | null {
  // 事务边界：getDatabase() 返回模块级单例 db，processARPEntries 事务内的调用自动落入同一事务（better-sqlite3 单连接同步）
  const db = getDatabase()
  try {
    const result = db.prepare(
      "INSERT INTO ip_mac_changes (ip, old_mac, new_mac, change_type, detected_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(ip, oldMac, newMac, changeType)
    return { id: result.lastInsertRowid as number, ip, oldMac, newMac, changeType, detectedAt: new Date().toISOString(), acknowledged: false, acknowledgedAt: null, notes: null }
  } catch (e: any) { console.error('[anomaly] recordChange 插入失败:', ip, e.message); return null }
}
```

**签名:** `recordChange(ip, oldMac: string | null, newMac: string | null, changeType: 'mac_changed' | 'new_ip' | 'ip_reused')`。BUG-1 全新 IP 分支调用 = `this.recordChange(ip, null, mac, 'new_ip')`（`oldMac=null` 表无历史 MAC）。返回 `IPMACChange | null`，调用方需 `if (change) changes.push(change)`（与既有 mac_changed/ip_reused 分支同款）。

#### 1.3 `createBinding` helper（全新 IP 分支已调用，BUG-1 不动）

**Source:** `electron/services/anomalyService.ts:131-137`

```typescript
private static createBinding(db: any, ip: string, mac: string, now: string): void {
  try {
    db.prepare('INSERT INTO ip_mac_bindings (ip, mac, first_seen, last_seen, is_active) VALUES (?, ?, ?, ?, 1)').run(ip, mac, now, now)
  } catch {
    db.prepare('UPDATE ip_mac_bindings SET last_seen = ?, is_active = 1 WHERE ip = ? AND mac = ?').run(now, ip, mac)
  }
}
```

#### 1.4 `getStats` 读取侧（CONTEXT 锁定不动，此处仅证其正确性）

**Source:** `electron/services/anomalyService.ts:180-189`

```typescript
static getStats(): { total: number; unacknowledged: number; macChanged: number; newIp: number; ipReused: number } {
  const db = getDatabase()
  return {
    total: (db.prepare('SELECT COUNT(*) as count FROM ip_mac_changes').get() as any).count,
    unacknowledged: (db.prepare('SELECT COUNT(*) as count FROM ip_mac_changes WHERE acknowledged = 0').get() as any).count,
    macChanged: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'mac_changed'").get() as any).count,
    newIp: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'new_ip'").get() as any).count,  // ← 读取侧正确：COUNT change_type='new_ip'，写入侧漏写致恒零
    ipReused: (db.prepare("SELECT COUNT(*) as count FROM ip_mac_changes WHERE change_type = 'ip_reused'").get() as any).count,
  }
}
```

**结论:** 读取侧本来就对（COUNT `change_type='new_ip'`），BUG-1 是纯写入侧漏写。D-14-1 Claude's Discretion 锁定 `getStats` 读取侧不重构。

#### 1.5 BUG-1 首次基线机制 — 三方案现状对照（researcher/planner 选定）

| 方案 | 改动形态 | 现状 analog | 幂等守卫 |
|------|----------|-------------|----------|
| A. `ip_mac_bindings` 加首次扫描标志位 | ALTER ADD COLUMN（`is_baseline` 或类似） | `migrations.ts:v1/v2/v3/v4/v9/v10`（hasColumn 第一形式） | `hasColumn(db, 'ip_mac_bindings', 'is_baseline')` |
| B. 独立 `anomaly_baseline` 表 | CREATE TABLE IF NOT EXISTS | `migrations.ts:v8`（experiences 建表）+ `init.ts:139-164`（anomaly 表 DDL） | `sqlite_master` 特征串（v8 第二形式） |
| C. `system_configs` 键值 | 复用现有键值表（若有） | 需 researcher grep 确认 `system_configs` 表是否存在 | 键存在判定 `SELECT value FROM system_configs WHERE key = ?` |

**基线语义（D-14-1 + Claude's Discretion 统一）：** 首次全量扫描只建 binding 不报 `new_ip`，基线建立后新增 IP 才报。具体实现：`processARPEntries` 入口先判定基线是否已建（方案 A/B/C 各自的判定），未建则本次扫描所有 IP 走 `createBinding` 不调 `recordChange('new_ip')`，并在结束时置"基线已建"标志；已建则正常报 `new_ip`。

---

### 2. `electron/services/ai.ts` + `aiExecLogger.ts` (service, request-response) — FIX-02 #2/#3 甄别

#### 2.1 FIX-02 #2 `ai_exec_logs` 完整记录 — 现状已满足（倾向 FIXED/作废登记）

**Source:** `electron/services/ai.ts:891-900`（chat() 主路径 createLog 调用，已传全 promptText + aiResponse）

```typescript
const logId = createLog({
  deviceId: targetDevice.id,
  deviceName: targetDevice.name,
  command: cmd,
  status: safety.allowed ? (execMode === 'auto' ? 'approved' : 'pending') : 'rejected',
  mode: execMode,
  aiReason: aiReply.substring(0, 500),
  promptText: JSON.stringify(fullMessages, null, 2),   // ✅ 完整 prompt（system + 全 messages）已落库
  aiResponse: aiReply,                                  // ✅ 完整 AI 首次回复已落库
})
```

**Source:** `electron/services/aiExecLogger.ts:8-34`（createLog 实现已写全 prompt_text + ai_response 列）

```typescript
export function createLog(entry: {
  deviceId: string; deviceName: string; command: string; status: string; mode: string
  aiReason: string; promptText?: string; aiResponse?: string
}): string {
  const id = uuidv4()
  getDatabase().prepare(`
    INSERT INTO ai_exec_logs (id, device_id, device_name_enc, command, status, mode, ai_reason, prompt_text, ai_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, entry.deviceId, encField(entry.deviceName, MK), entry.command, entry.status, entry.mode,
         entry.aiReason, entry.promptText || '', entry.aiResponse || '')  // ✅ 两字段均 INSERT
  return id
}
```

**Source:** `electron/services/aiExecLogger.ts:42-52`（confirmCommand 二次 AI 调用追加追加到同一 log，不丢二次 prompt/response）

```typescript
export function appendLogAiResponse(id: string, secondPrompt: string, secondResponse: string): void {
  getDatabase()
    .prepare('UPDATE ai_exec_logs SET prompt_text = prompt_text || ? || ?, ai_response = ai_response || ? || ? WHERE id = ?')
    .run('\n\n========== 命令执行后的第二次 AI 调用 ==========\n\n发送给 AI 的 Prompt:\n', secondPrompt,
         '\n\nAI 分析结果:\n', secondResponse, id)
}
```

**Source:** `electron/database/migrations.ts:38-49`（v2 迁移已加 prompt_text + ai_response 列，幂等 hasColumn 守卫）

```typescript
const v2 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_exec_logs', 'prompt_text')) {
      db.exec("ALTER TABLE ai_exec_logs ADD COLUMN prompt_text TEXT DEFAULT ''")
    }
    if (!hasColumn(db, 'ai_exec_logs', 'ai_response')) {
      db.exec("ALTER TABLE ai_exec_logs ADD COLUMN ai_response TEXT DEFAULT ''")
    }
    db.pragma('user_version = 2')
  })
  step()
}
```

**甄别结论倾向（researcher 最终判定）：** `createLog` 已 INSERT `prompt_text`（完整 `JSON.stringify(fullMessages)`）+ `ai_response`（完整 aiReply），schema（v2 迁移）已加列，confirmCommand 二次调用经 `appendLogAiResponse` 追加不覆盖。**三项全已就位 → FIXED（已满足），14-02-DEFER-LOG 登记"已满足，无需改"**。researcher 需 grep `createLog(` 全 caller 确认无遗漏入口（目前 chat() 主路径 line 891 唯一 caller）。

#### 2.2 FIX-02 #3 会话标题更新 early-return — 前提偏差，现状已满足（倾向 FIXED/作废登记）

**关键现状：** 会话标题更新**不在 `ai.ts`**，而在 renderer `useAIChat.ts:132-137`，且**已在 `confirm_required` 分支之前执行**：

**Source:** `src/components/pages/ai/useAIChat.ts:132-152`（handleSend 内，标题更新 line 133-137 在 confirm_required line 148 之前）

```typescript
const reply = await window.api.ai.chat(...)  // IPC 返回（含 confirm_required JSON）

// Auto title: update session title from first user message
if (messages.length === 0) {                                       // line 133 首条消息才更新标题
  const title = text.length > 20 ? text.substring(0, 20) + '...' : text
  void window.api.ai.updateSessionTitle(currentSessionId, title)   // line 135 标题更新（已执行）
  setSessions((prev) => prev.map((s) => s.id === currentSessionId ? { ...s, title } : s))
}

// Check if reply is a confirm_required / kb_answer / exp_answer response
try {
  const parsed = JSON.parse(reply) as ConfirmData & { type: string; ... }
  if (parsed.type === 'confirm_required') {                        // line 148 confirm_required 分支（在标题更新之后）
    setPendingConfirm(parsed)
    setLoading(false)
    return                                                         // early return（标题已在 line 135 更新完，不跳过）
  }
  ...
}
```

**甄别结论倾向（researcher 最终判定）：** 审计前提"`ai.ts` 会话标题更新逻辑在 `confirm_required` early return 之前"存在偏差——标题更新从未在 `ai.ts`（grep `updateSessionTitle` 全仓：`ai.ts:188` 仅定义函数 + `main.ts:208` IPC handler，零 caller 在 chat 流程内），实际在 renderer `useAIChat.handleSend` 且**已正确排在 `confirm_required` 分支之前**。需确认的会话（confirm_required）标题已在 line 135 落库，不被 early return 跳过。**→ FIXED（已满足），14-02-DEFER-LOG 登记"前提偏差 + 现状已在前"**。researcher 需核对审计原文意图（可能审计时该逻辑位置不同，后被移到 renderer）。

---

### 3. `src/components/pages/ai/CommandConfirmModal.tsx` (component, request-response) — FIX-02 #1 confirm 防重复

#### 3.1 CommandConfirmModal 现状（确认按钮**无** loading/disabled，但关窗锁在 hook 层）

**Source:** `src/components/pages/ai/CommandConfirmModal.tsx:1-55`

```tsx
import { Modal, Button, Tag } from 'antd'
import type { ConfirmData } from './types'

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
        // ⚠️ 两个 Button 均无 loading / disabled prop —— 视觉层无防重复点击反馈
      ]}
    >
      {/* ... 命令列表 + AI 说明 ... */}
    </Modal>
  )
}
```

#### 3.2 关窗锁现状（hook 层已防重复 IPC，倾向 FIXED）

**Source:** `src/components/pages/ai/useAIChat.ts:195-225`（handleConfirm）

```typescript
const handleConfirm = useCallback(async (approved: boolean) => {
  if (!pendingConfirm || !currentSessionId) return
  const confirmData = pendingConfirm
  setPendingConfirm(null) // ✅ 立即关闭弹窗，防止重复点击（line 198）—— Modal open={!!pendingConfirm} → false → 弹窗消失，第二次点击无处可点
  setLoading(true)
  try {
    const result = await window.api.ai.confirmCommand(confirmData.execId, approved)  // IPC 在途期间弹窗已关
    // ... 解析 result ...
  } catch (e: unknown) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  setLoading(false)
}, [pendingConfirm, currentSessionId])
```

**甄别结论倾向（researcher 最终判定）：** `useAIChat.handleConfirm` line 198 `setPendingConfirm(null)` 已在 IPC `confirmCommand` 调用前同步关窗（Modal `open` 绑 `!!pendingConfirm` → false → 弹窗消失），第二次"确认执行"按钮无处可点，**逻辑层防重复 IPC 已满足**。但**视觉层（按钮）无 loading/disabled 反馈**——若用户连点极快（同一 tick 内 React 尚未重渲染关窗），理论上可能两次进入 `handleConfirm`（第二次因 line 196 `if (!pendingConfirm)` 守卫 + line 198 已置 null → return，仍被拦）。**→ 核心防重复已满足（FIXED），可选增强（按钮 loading 视觉反馈）登记 DEFER**。researcher 需评估是否值得加按钮 `loading` prop（参考 ChatInput.tsx:34-42 analog）。

#### 3.3 「loading + disabled 防重复点击」按钮 analog（若判定需补视觉反馈）

**Source:** `src/components/pages/ai/ChatInput.tsx:34-42`（发送按钮，loading + disabled 双锁防重复）

```tsx
<Button
  type="primary"
  icon={<SendOutlined />}
  onClick={onSend}
  loading={loading}          // ✅ IPC 在途转圈
  disabled={!value.trim()}   // ✅ 空内容禁用
>
  发送
</Button>
```

**Source:** `src/components/pages/ai/ChatInput.tsx:45-53`（经验总结按钮，三条件 disabled）

```tsx
<Button
  icon={<ThunderboltOutlined />}
  onClick={onSummarize}
  loading={summarizing}      // ✅ 异步 loading 防重复点击（注释 line 228-229 明示）
  disabled={!canSummarize || loading || summarizing}  // ✅ 多条件锁
>
  经验总结
</Button>
```

**应用方式（若 FIX-02 #1 判定需补视觉反馈）：** `CommandConfirmModal` 两个 footer Button 加 `loading={confirmInFlight}` prop（需 hook 暴露 in-flight 状态，或 Modal 内部 `useState`），与 ChatInput 同款 antd Button loading 语义。

---

### 4. `electron/database/migrations.ts` (migration, DDL) — BUG-1 基线机制幂等守卫 analog

**Analog:** 自身既有双形式幂等守卫（hasColumn 第一形式 + sqlite_master 特征串第二形式），BUG-1 基线机制若选方案 A/B 沿用。

#### 4.1 第一形式：hasColumn 守卫（纯 ALTER ADD COLUMN，方案 A 沿用）

**Source:** `electron/database/migrations.ts:28-49`（v1/v2 范例）

```typescript
const v1 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'chat_history', 'session_id')) {           // ✅ 幂等守卫：列不存在才 ADD
      db.exec('ALTER TABLE chat_history ADD COLUMN session_id TEXT')
    }
    db.pragma('user_version = 1')
  })
  step()
}

const v2 = (db: Database.Database): void => {                     // ✅ ai_exec_logs 加 prompt_text/ai_response（FIX-02 #2 已就位佐证）
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_exec_logs', 'prompt_text')) {
      db.exec("ALTER TABLE ai_exec_logs ADD COLUMN prompt_text TEXT DEFAULT ''")
    }
    if (!hasColumn(db, 'ai_exec_logs', 'ai_response')) {
      db.exec("ALTER TABLE ai_exec_logs ADD COLUMN ai_response TEXT DEFAULT ''")
    }
    db.pragma('user_version = 2')
  })
  step()
}
```

#### 4.2 第二形式：sqlite_master 特征串守卫（建表/重建表，方案 B 沿用）

**Source:** `electron/database/migrations.ts:193-247`（v8 experiences 建表范例）

```typescript
const v8 = (db: Database.Database): void => {
  const expSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='experiences'"
  ).get() as { sql?: string } | undefined)?.sql || ''
  if (expSchema.includes('attrs_enc')) {                           // ✅ 幂等守卫：特征串命中即 no-op 早返
    return
  }
  const step = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS experiences (...)`)
    db.pragma('user_version = 8')
  })
  step()
}
```

**Source:** `electron/database/migrations.ts:303-334`（v11 CHECK widen rebuild 范例，sqlite_master 守卫 + DROP/CREATE/INSERT…SELECT/RENAME 重建）

```typescript
export const v11 = (db: Database.Database): void => {
  const logSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_system_logs'"
  ).get() as { sql?: string } | undefined)?.sql || ''
  if (logSchema.includes("'security'")) {                          // ✅ 特征串守卫
    return
  }
  const step = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS ai_system_logs_new")
    db.exec(`CREATE TABLE ai_system_logs_new (...)`)               // 新 CHECK
    db.exec(`INSERT INTO ai_system_logs_new SELECT ... FROM ai_system_logs`)  // 数据迁移
    db.exec('DROP TABLE ai_system_logs')
    db.exec('ALTER TABLE ai_system_logs_new RENAME TO ai_system_logs')
    db.pragma('user_version = 11')
  })
  step()
}
```

**MIGRATION_HEAD 现状:** `migrations.ts:16` `export const MIGRATION_HEAD = 11`。BUG-1 若需加迁移步骤 → 新增 `v12`（方案 A 加列 / 方案 B 建表）+ `MIGRATIONS` 数组注册 + `MIGRATION_HEAD = 12`。**注意（init.ts 双路径一致红线）：** 新表/新列 DDL 必须在 `init.ts` fresh-install 块同步加（与 v7/v8 注释明示的"DDL 必须与 init.ts 逐字一致"同款），否则 fresh-install 与遗留库 schema 漂移。

#### 4.3 BUG-1 基线机制三方案迁移落地形态对照

| 方案 | 迁移步骤 | 守卫形式 | init.ts 同步 |
|------|----------|----------|--------------|
| A. `ip_mac_bindings.is_baseline` 标志位 | `v12` ALTER ADD COLUMN | `hasColumn` (第一形式) | `init.ts:139-148` ip_mac_bindings DDL 加列 |
| B. 独立 `anomaly_baseline` 表 | `v12` CREATE TABLE | `sqlite_master` 特征串 (第二形式) | `init.ts:152` 后加 fresh-install 建表 DDL |
| C. `system_configs` 键值 | 零迁移（复用现有表，需 researcher 确认表存在） | 键存在判定（非迁移） | 零改动（若表已存在） |

**researcher 选定建议（Claude's Discretion 留白）：** 方案 C 最简（零迁移零 schema 改）但需确认 `system_configs` 表存在；方案 A 次简（一条 ALTER + hasColumn）；方案 B 最重（建表 + 双路径 DDL）。若 `system_configs` 不存在或语义不符，推荐方案 A（与 v1/v2/v3/v9/v10 同款纯 ALTER，幂等性最稳）。

---

### 5. `.planning/phases/14-defect-legacy-rollback-closure/14-02-DEFER-LOG.md` (config, transform) — FIX-02 甄别登记产出 analog

**Analog:** `13-02-DEFER-LOG.md`（SEC-04 五项甄别登记范例，FIX-02 沿用结构与写法）

#### 5.1 DEFER-LOG 结构 analog（每项 FIXED/DEFER 结论 + file:line + reason + 重评估条件）

**Source:** `.planning/phases/13-security-hardening-cluster/13-02-DEFER-LOG.md:12-23`（单项范例：L1）

```markdown
## L1

**删弱 SSH 算法**（group1-sha1 / group14-sha1 / ...）

- **结论：DEFER**
- **佐证：**
  - `electron/utils/sshConfig.ts:11-39` `SSH_ALGORITHMS` 全保留弱算法...
  - 全仓 4 处 SSH 路径全量复用此常量零 drift：`electron/services/ai.ts:306-322 buildSSHConfig` ...
- **审计引用：** `260726-p9e-SUMMARY.md:142`「L1 弱 SSH 算法」排除清单
- **reason：** D-13-1 锁定——运维兼容性优先...
- **重评估条件：** 未来设备清单确认无老算法依赖时可重评估...
```

**Source:** `13-02-DEFER-LOG.md:103-118`（甄别汇总表 + 三红线不可回退确认）

```markdown
## 甄别汇总

| 项 | 结论 | 核心理由 |
|----|------|----------|
| L1 删弱 SSH 算法 | DEFER | D-13-1 运维兼容性优先（连老设备） |
| L2 ai limit | DEFER | 命令安全层红线③已强制 + 单机单用户无滥用面 |
| L3 captcha | FIXED（核心）+ renderSvg Math.random DEFER | 文本已 CSPRNG + 防重放；renderSvg 非安全敏感 |
| ...

**SC2 满足确认：** 5 项逐项有明确结论（FIXED 或 DEFER）+ 代码层佐证（file:line）+ 审计引用 + reason（DEFER 项含重评估条件），无静默跳过。

**三红线（IPC secure/safe 鉴权 / 字段加密 _enc / commandSafety.isCommandAllowed）改动后仍生效确认：**
- 红线① IPC 鉴权：...
- 红线② 字段加密：...
- 红线③ commandSafety：...
```

#### 5.2 14-02-DEFER-LOG 应含项（FIX-02 三项 + H3C 一项）

| 项 | 预期结论（据本 PATTERNS 现状摘录，researcher 最终判定） | 关键佐证 file:line |
|----|----------|---------------------|
| confirm 防重复点击 | 核心已满足（FIXED，hook 层 `setPendingConfirm(null)` 关窗锁 line 198）+ 视觉层 loading 反馈可选 DEFER | `useAIChat.ts:195-225` + `CommandConfirmModal.tsx:15-22` |
| `ai_exec_logs` 完整记录 | FIXED（已满足，createLog 已 INSERT prompt_text + ai_response + v2 迁移加列） | `ai.ts:891-900` + `aiExecLogger.ts:8-34` + `migrations.ts:38-49` |
| 会话标题 early-return | FIXED（前提偏差，标题更新在 renderer 且已在 confirm_required 之前） | `useAIChat.ts:132-152` |
| H3C LLDP 邻居发现 | DEFER（作废，用户真机已验证 + discovery.ts 已覆盖） | `discovery.ts:101-275`（D-14-3 锁定，无需 researcher 甄别） |

---

## Shared Patterns

### A. 静态类 service facade（BUG-1 改 `AnomalyService` 沿用，零实例状态）

**Source:** `electron/services/anomalyService.ts:16` + CONVENTIONS

```typescript
export class AnomalyService {
  private static isIPExcluded(ip: string): boolean { ... }     // 全方法 static
  static processARPEntries(...): IPMACChange[] { ... }          // public static
  private static createBinding(db, ip, mac, now): void { ... }  // private static
  private static recordChange(...): IPMACChange | null { ... }  // private static
  static getStats(): { ... } { ... }
  // 内部调 getDatabase() 单例，不持实例状态（缓存例外挂 private static）
}
```

**Apply to:** BUG-1 改动（`processARPEntries` 补 `recordChange('new_ip')` + 首次基线判定）沿用静态方法，基线标志若挂类用 `private static`（D-14-1 Claude's Discretion）。不引入 `new AnomalyService()` 实例化。

### B. 整批单事务 + 条目级 SAVEPOINT（BUG-1 改动自动复用事务边界）

**Source:** `electron/services/anomalyService.ts:89-126`（见 1.1 节完整摘录）

**Apply to:** BUG-1 `recordChange('new_ip')` 落在 `entryTx` 内 → 自动复用 SAVEPOINT（单条失败 ROLLBACK TO savepoint 不影响整批）+ `runBatch` 整批单事务（一次 COMMIT）。无需手动加事务。

### C. 三红线（本 phase 不动，不可回退，仅作"改动后仍生效"参照）

**Apply to:** 全部 BUG-1 + FIX-02 改动，DEFER-LOG 须含"三红线改动后仍生效确认"段（学 13-02-DEFER-LOG:115-118）。

| 红线 | 现状（本 phase 不碰，证其仍生效） | 现状佐证 |
|------|-----------------------------------|----------|
| ① IPC `secure`/`safe` 鉴权 | anomaly:* / ai:* 全 secure 包装 | `main.ts:192` `ai:chat` secure + `main.ts:199` `ai:confirmCommand` secure + anomaly:getChanges/getStats/acknowledgeAll（IPC 注册处） |
| ② `_enc` 字段加密 | anomaly 表无 `_enc` 列（ip_mac_changes 明文）；ai_exec_logs 仅 `device_name_enc` 加密 | `anomalyService.ts:143`（INSERT ip_mac_changes 无 _enc）+ `aiExecLogger.ts:25`（device_name_enc） |
| ③ `commandSafety.isCommandAllowed` | AI 命令执行链两处强制 | `ai.ts:334`（executeCommandsOnDevice 执行层）+ `ai.ts:890`（chat 主路径安全校验） |

### D. 测试 mock DB 注入范式（BUG-1 mock 单测接入点，CONTEXT 已点 `_setExperienceDbGetter`）

**Source:** `electron/services/experienceService.ts:35-41`（db getter 注入范式）

```typescript
// 默认走生产单例 db；测试经 _setExperienceDbGetter 注入内存 mock（规避 DEP-1 native binding ABI 冲突）。
let dbGetter: () => Database.Database = getDatabase

/** @internal 测试专用：注入 db getter（生产不调用）。 */
export function _setExperienceDbGetter(fn: () => Database.Database): void {
  dbGetter = fn
}
```

**Source:** `electron/services/experienceService.test.ts:547-553`（beforeEach 注入内存 mock DB）

```typescript
beforeEach(() => {
  setExperienceMasterKey(MK_TEST_KEY)
  const db = seedDb()
  _setExperienceDbGetter(() => db as unknown as Database.Database)  // ✅ 注入 mock DB
  mockDbRef.current = db
})
```

**Apply to:** BUG-1 `processARPEntries` mock 单测。**注意：** `anomalyService.ts` 当前用 `getDatabase()` 直接调（line 2 import + 各方法内调），**无 `_setAnomalyDbGetter` 注入口**。若 BUG-1 测试要走 mock 路径，需先在 `anomalyService.ts` 加 `_setAnomalyDbGetter`（镜像 experienceService 范式）+ 各方法 `getDatabase()` 改 `dbGetter()`，或用 `vi.mock('../database/connection')` 整体 mock `getDatabase`（researcher/planner 选定测试方式，D-14-4 Claude's Discretion）。测试喂全新 IP → 验 `ip_mac_changes` 写入 `change_type='new_ip'` + 首次扫描基线不报。

### E. 甄别退路模式（FIX-02 三项 + H3C 复用，CONTEXT 已点）

**Apply to:** FIX-02 三项逐条 grep+代码核对给 FIXED/DEFER/FIX 结论 + file:line 佐证 + reason（DEFER 含重评估条件），H3C 直接 DEFER（用户真机验证 + discovery.ts:101-275 已覆盖，D-14-3 锁定无需甄别）。产出 `14-02-DEFER-LOG.md`（结构见第 5 节 analog）。

---

## No Analog Found

**无。** 本 phase 全部 8 个分析文件均找到强匹配 analog（多为自身既有结构，因 phase 性质为缺陷修复 + 甄别，非新建功能）。

---

## Metadata

**Analog search scope:**
- `electron/services/`（anomalyService.ts / ai.ts / aiExecLogger.ts / experienceService.ts + .test.ts）
- `electron/database/`（migrations.ts / init.ts）
- `electron/main.ts` + `electron/preload.ts`（IPC 鉴权现状 + 会话标题 IPC）
- `src/components/pages/ai/`（CommandConfirmModal.tsx / useAIChat.ts / ChatInput.tsx）
- `src/components/ip-management/`（AnomalyTab.tsx — BUG-1 消费方）
- `.planning/phases/13-security-hardening-cluster/13-02-DEFER-LOG.md`（DEFER-LOG 结构 analog）
- `.planning/REQUIREMENTS.md`（FIX-01 / FIX-02 需求来源）

**Files scanned:** 11（含 grep 范围内的辅助核对文件）

**Pattern extraction date:** 2026-08-09

**关键甄别预判（供 researcher 参考，非锁定）：**
- FIX-02 #2（ai_exec_logs 完整记录）：**倾向 FIXED**——`createLog` 已 INSERT prompt_text + ai_response，v2 迁移加列，appendLogAiResponse 追加二次调用。三项全就位。
- FIX-02 #3（会话标题 early-return）：**倾向 FIXED**——审计前提偏差（标题更新在 renderer `useAIChat.ts:133-137`，不在 `ai.ts`），且已在 `confirm_required` 分支（line 148）之前执行。
- FIX-02 #1（confirm 防重复）：**核心 FIXED + 视觉层可选 DEFER**——hook 层 `setPendingConfirm(null)` 关窗锁（line 198）已防重复 IPC；按钮无 loading 视觉反馈（CommandConfirmModal.tsx:15-22），可选增强（参考 ChatInput.tsx:34-42）。
- H3C LLDP：**DEFER（作废，D-14-3 锁定）**——用户真机验证 + discovery.ts:101-275 已覆盖。

