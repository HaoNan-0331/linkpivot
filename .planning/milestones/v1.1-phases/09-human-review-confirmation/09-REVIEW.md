---
phase: 09-human-review-confirmation
reviewed: 2026-08-04T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - electron/ipc/experienceIpc.ts
  - electron/preload.ts
  - electron/services/ai.telnetRouting.test.ts
  - electron/services/ai.ts
  - electron/services/arpCollector.ts
  - electron/services/experienceService.test.ts
  - electron/services/experienceService.ts
  - electron/utils/telnetExec.ts
  - src/components/pages/ai/ChatInput.tsx
  - src/components/pages/ai/ReviewConfirmEditForm.tsx
  - src/components/pages/ai/ReviewConfirmModal.tsx
  - src/components/pages/ai/SessionMessagesModal.tsx
  - src/components/pages/ai/types.ts
  - src/components/pages/ai/useAIChat.ts
  - src/components/pages/AIPage.tsx
  - src/types/electron.d.ts
  - src/types/experience.ts
findings:
  critical: 0
  warning: 9
  info: 4
  total: 13
status: issues_found
---

# Phase 9: Code Review Report

**Reviewed:** 2026-08-04
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Phase 9 (Human Review & Confirmation) 三层（service / IPC / renderer）总体落地完整：`confirmDrafts/listDrafts/getSessionMessages` 三 secure channel + preload + DTO + electron.d.ts 三向一致；`confirmDrafts` 单事务原子 + service 层质量门兜底校验（troubleshooting 必填 severity/symptoms/resolution，轻结构类必填 title/content）已实现并有完整单测覆盖；renderer `ReviewConfirmModal` master-detail + 三层质量门纵深（renderer 实时标红 + service 兜底）结构正确。插曲 telnet 修复（ai.ts 按 connectionType 分流 ssh/telnet、telnetExec.ts 关分页+精确 shellPrompt、arpCollector 复用 telnetExec）逻辑正确，单测覆盖分流。

红线遵守情况良好：IPC 全 secure 包装、字段加密只走 encField/decField、`_enc` 列 IPC 边界剥离、`confirmDrafts` 单事务原子 + 循环外 prepare、命令执行经 isCommandAllowed。

未发现 BLOCKER 级安全/数据丢失/崩溃缺陷。发现 9 处 WARNING（正确性/鲁棒性退化风险）与 4 处 INFO（可维护性）。最值得关注的两处：**WR-01**（pendingDraftCount 角标初始化时漏拉，重启后用户看不到既有暂存草稿，D-9-7 入口形同虚设）；**WR-02**（telnet 单命令 timeout 用了批量累计 `overallTimeout`，单命令挂起可达数百秒，与 SSH 路径「单命令独立超时」语义不对齐）。

## Critical Issues

（无）

## Warnings

### WR-01: pendingDraftCount 角标未在初始化时拉取，重启/重进页面后既有暂存草稿角标为 0

**File:** `src/components/pages/ai/useAIChat.ts:36, 91-105, 206-213`
**Issue:** `pendingDraftCount` 状态初始值固定为 `0`，仅在两条路径下被改写：(1) `handleSummarize` 完成后置为本次 `draftIds.length`（行 196）；(2) `handleReviewSubmitted` 提交后重新拉 `listDrafts()` 同步（行 206-213）。但 `loadData`（应用初始化/AIPage 挂载）从未调 `listDrafts()` 同步角标。这违背 D-9-7「重开确认弹窗」入口的语义前提——用户在会话里点了「经验总结」生成 N 条草稿后未确认即关闭应用，下次打开 AIPage 时角标为 0、`待确认 N 条` 链接（`ChatInput.tsx:55` 的 `pendingDraftCount ?? 0 > 0` 守卫）不显示，用户无法经角标重开弹窗核对历史暂存草稿。D-9-7 角标重开入口在此场景完全失效。

**Fix:** 在 `loadData`（或 AIPage mount 完成后）异步拉一次 `listDrafts()` 同步角标：
```ts
const loadData = useCallback(async (hasConfig: boolean) => {
  try {
    const devs = await window.api.device.list()
    setDevices(...)
    if (hasConfig) {
      await loadSessions()
      // 同步既有暂存 draft 计数（D-9-7 角标初始化）
      try {
        const remaining = await window.api.experience.listDrafts()
        setPendingDraftCount(remaining.length)
      } catch { setPendingDraftCount(0) }
    }
  } catch { /* ignore */ }
}, [loadSessions])
```

### WR-02: telnet 单命令 timeout 用了批量累计 overallTimeout，单命令挂起可达数百秒

**File:** `electron/services/ai.ts:348, 369`
**Issue:** `overallTimeout = 30000 + checked.length * (SSH_READY_TIMEOUT_MS + 15000)`（行 348）是「整个命令批」的累计预算。SSH 路径下每条命令独立 `Client` 连接，单命令兜底超时也是 `overallTimeout`（行 400），但 SSH 路径额外有 `execOne` 内的 `perCmdTimeoutMs=15000` + `silenceMs=2000` 早触发（`ai.ts:444`），所以 SSH 实际单命令不会挂到 `overallTimeout`。但 telnet 分流路径（行 363-377）把 `overallTimeout` 直接传给 `executeTelnetCommand` 的 `options.timeout`，而 `telnetExec.ts` 内部 `connect + exec` 共用这一个 timeout，没有 per-command 早触发机制。当 `checked.length=5` 时 `overallTimeout ≈ 30+5*(15+15)=180s`，单条 telnet 命令挂起时最长 180s 才超时——与 SSH 路径「单命令 15s 静默/15s 兜底」语义严重不对齐，慢设备/不响应设备下 AI 命令批长时间卡死，影响用户感知。

**Fix:** telnet 分流路径传「单命令预算」而非整批累计：
```ts
const perCmdTimeout = 30000 + SSH_READY_TIMEOUT_MS + 15000 // 与 SSH 单命令预算对齐
...
executeTelnetCommand(
  device.ipAddress, tport,
  device.username || '', device.password || '',
  cmd,
  { timeout: perCmdTimeout, decodeGbk: true, stripAnsi: true,
    disablePaginationCmd: paginationCmd, shellPrompt }
)
```

### WR-03: arpCollector telnet 路径未关分页且用默认 shellPrompt /[>#]/，长 ARP 表 + 含 # 设备存在截断风险

**File:** `electron/services/arpCollector.ts:100`
**Issue:** `collectFromDevice` 调 `executeTelnetCommand(..., { timeout: this.timeout })`，未传 `disablePaginationCmd` 与 vendor-specific `shellPrompt`，落到 `telnetExec.ts` 默认值：`shellPrompt = /[>#]/`、不关分页。注释（行 77-78）说「arpCollector 走原始输出，由 ARPParser 自行解析」。但：(1) 华为/H3C `display arp all` 在 ARP 表很长时部分设备仍会 `---- More ----` 分页，telnet-client exec 不自动翻页 → 输出截断在第一屏，ARPParser 漏解析后半段；(2) 默认 `/[>#]/` 在 ARP 输出含裸 `#`（如某些设备接口名/注释带 `#`）时会在该处提前 resolve 截断。ai.ts telnet 分流路径已显式按 vendor 选关分页命令 + 精确 shellPrompt（`pickDisablePaginationCmd` / `pickShellPrompt`），arpCollector 走同 util 却不传这些选项，行为不一致，是该 util 抽取后未对齐的回归风险。

**Fix:** arpCollector 同样按 vendor 传关分页命令与精确 shellPrompt（可把 `pickDisablePaginationCmd`/`pickShellPrompt` 从 ai.ts 提到共用 util 复用）：
```ts
output = await executeTelnetCommand(
  device.ipAddress, device.port || 23, device.username, device.password, command,
  {
    timeout: this.timeout,
    disablePaginationCmd: pickDisablePaginationCmd(device.vendor),
    shellPrompt: pickShellPrompt(device.vendor),
  }
)
```

### WR-04: confirmDrafts 服务层质量门校验 cur.attrs 但 updateExperience 内的 validateAndStringifyAttrs 重复校验且语义可能漂移

**File:** `electron/services/experienceService.ts:424-449, 142-151, 298-305`
**Issue:** `confirmDrafts` adopt 路径在 425-449 行已对 `finalCategory/finalAttrs/finalTitle/finalContent` 做了完整质量门校验（troubleshooting 必填 severity/symptoms/resolution）。随后行 451-453 调 `updateExperience(d.expId, d.fields)`，其内部 `validateAndStringifyAttrs(cat, fields.attrs)`（行 142-151）对 troubleshooting 又强制 severity 校验。两处校验规则现在一致，但属双份漂移隐患：未来若 service 层兜底校验扩展（如要求 prevention 必填、或新增 severity 枚举），需同步改两处，否则 `updateExperience` 内的校验比 `confirmDrafts` 更松会导致绕过、更严会导致 confirmDrafts 通过但 update 抛错（事务 ROLLBACK 整批失败，错误信息却指向 severity 而非业务字段）。renderer 第三层 `validateDraft`（`ReviewConfirmModal.tsx:49-62`）已导出复用为单一来源，service 层这两处却是手写两次。

**Fix:** 把 service 层 troubleshooting 质量门抽成单一函数，confirmDrafts 与 validateAndStringifyAttrs 共用：
```ts
function assertTroubleshootingAttrs(attrs: any, ctx: string): void {
  const sev = attrs?.severity
  if (!sev || !VALID_SEVERITIES.includes(sev)) throw new Error(`${ctx} 缺合法 severity`)
  if (!attrs?.symptoms || !String(attrs.symptoms).trim()) throw new Error(`${ctx} 缺 symptoms`)
  if (!attrs?.resolution || !String(attrs.resolution).trim()) throw new Error(`${ctx} 缺 resolution`)
}
```
confirmDrafts 内调 `assertTroubleshootingAttrs(finalAttrs, '草稿 ${id}')`，`validateAndStringifyAttrs` 内 troubleshooting 分支调 `assertTroubleshootingAttrs(attrs, '...')` 后再 stringify。

### WR-05: confirmDrafts relateDevices diff 用 listDevicesByExperience（每设备一次 getDeviceById），事务内 N+1 查询且涉及设备表

**File:** `electron/services/experienceService.ts:459-466, 363-370`
**Issue:** `confirmDrafts` adopt + `relateDevices.length>0` 分支调 `listDevicesByExperience(d.expId)`（行 460）取现有 device_id 集合做 diff。该函数（行 363-370）现已改走 `getDeviceById` 逐设备白名单投影（WR-05 安全升级），即每条 confirmDrafts adopt 都触发 N 次 `SELECT * FROM devices WHERE id=?` + N 次 rowToDevice 解密。本意只是取 device_id 集合做 diff，却把整张 device 行的密文都解密了一遍又丢弃。在单事务内对单条草稿这是浪费，对批量 adopt 多条草稿（每条都有 relateDevices）是显著的同步解密开销（每个 device 含 9 个 `_enc` 列，每个列 pbkdf2 派生 + AES-GCM 解密）。CLAUDE.md「DB 性能」红线没明确禁此模式，但「循环外 prepare 复用」精神被破坏——本可用一条 `SELECT device_id FROM exp_device_rel WHERE experience_id=?` 解决。

**Fix:** confirmDrafts 内 diff 用轻量查询，不经 listDevicesByExperience：
```ts
// 循环外 prepare（与 stmtPublish 同级）
const stmtCurDev = conn.prepare(
  `SELECT device_id FROM exp_device_rel WHERE experience_id = ?`
)
...
if (d.relateDevices != null && d.relateDevices.length > 0) {
  const curDevices = (stmtCurDev.all(d.expId) as Array<{device_id: string}>).map(r => r.device_id)
  // ... diff 不变
}
```

### WR-06: confirmDrafts 丢弃路径走 deleteExperience 硬 DELETE，但渲染层文案是「丢弃」，与「物理删除」语义存在用户认知错位

**File:** `electron/services/experienceService.ts:416-419, 336-338`, `src/components/pages/ai/ReviewConfirmModal.tsx:187, 197`
**Issue:** `confirmDrafts` 的 `action: 'discard'` 分支调 `deleteExperience(d.expId)`（行 417），物理 DELETE experiences 行（exp_device_rel ON DELETE CASCADE 自动清理关联）。设计文档 D-9-6 标明 discard=hard DELETE，这是有意决策。但渲染层 UI 文案是「全选丢弃」「丢弃 N 条」（`ReviewConfirmModal.tsx:187, 197`），「丢弃」一词在中文语境下用户常理解为「暂存到一边/留待以后」，而非「永久删除」。AI 起草的经验草稿可能含用户认为有价值的雏形，用户点「丢弃」预期是「先放一边」，实际是不可恢复的物理删除。这是数据丢失风险——虽是设计决策，但 UI 文案与实际行为不一致构成可用性缺陷。

**Fix:** 二选一：(a) UI 文案改「删除」/「永久删除」明示后果；或 (b) discard 改为软失效（status='invalid' 或 status='archived'，保留可追溯）。建议 (a) 最低成本：
```tsx
<Button key="allDiscard" danger onClick={() => setAll('discard')}>
  全选删除
</Button>
...
确认采纳 {adoptCount} 条 + 删除 {discardCount} 条
```

### WR-07: telnetExec finally 块 await connection.end() 在 timedOut 已 destroy 路径后再执行，end() 行为依赖 telnet-client 内部幂等性

**File:** `electron/utils/telnetExec.ts:105-109`
**Issue:** `executeTelnetCommand` 的 timeout 兜底路径（行 78-83）已 `connection.destroy()` + `reject`。`.finally(async () => { ... await connection.end() ...; if (timedOut) { connection.destroy() } })`（行 105-109）在 reject 后仍会执行：先 `await connection.end()`（telnet-client end 是 async 发 EOF 包，但 socket 已 destroy 时 end 可能抛/无效），再因 `timedOut` 二次 `destroy()`。注释行 14-16 声称「destroy 之后再 end/destroy 无害」，依赖 telnet-client `end()`/`destroy()` 内部幂等。但 telnet-client 版本升级若 end() 在已 destroy 状态下抛非预期异常，finally 的 `try { await connection.end() } catch {}` 已兜底，所以不会冒泡；真正风险是 timeout 路径下 reject 与 finally 之间存在窗口——内部 IIFE 的 `await connection.exec(command)` 可能在 destroy 后才 resolve，调 `resolve(out)`（已被外层 Promise 忽略，OK）但不影响 reject 结果。逻辑上无 bug，但 timeout 与 finally 双重 destroy/end 的时序耦合脆弱，未来 telnet-client 升级是隐藏回归点。

**Fix:** finally 内对 timedOut 路径跳过 `await end()`（已 destroy 不需再发 EOF）：
```ts
}).finally(async () => {
  if (timer) clearTimeout(timer)
  if (!timedOut) {
    try { await connection.end() } catch { /* ignore */ }
  } else {
    try { connection.destroy() } catch { /* ignore */ }
  }
})
```

### WR-08: ReviewConfirmModal initialDraftIds 变更引用触发 effect 重拉，但每次 summarizeSession 返回新数组导致已编辑决策被重置

**File:** `src/components/pages/ai/ReviewConfirmModal.tsx:80-113`, `src/components/pages/ai/useAIChat.ts:191`
**Issue:** `ReviewConfirmModal` 的 `useEffect` 依赖 `[open, initialDraftIds]`（行 113）。`handleSummarize`（useAIChat.ts:188-192）每次成功后调 `setReviewInitialDraftIds(draftIds)`，`draftIds` 是每次新建的数组引用（`[...result.created, ...result.updated].map(...)`）。流程上 summarize 后 setReviewOpen(true) 开弹窗，effect 触发拉 drafts → 用户编辑决策。若用户在弹窗开着时再次点「经验总结」（同会话幂等，SC5），handleSummarize 会再 setReviewInitialDraftIds（新数组引用）+ setReviewOpen(true)，effect 重跑 → `setDrafts(list)` + `setDecisions(init)` 把用户已编辑的 fields/decision 全部重置回默认（默认全 adopt、supersedeOld=false、fields=草稿原值）。用户编辑了一半的标尺（如把多条改 discard、把 troubleshooting severity 改高）被无声清空。虽然 `summarizing` 期间按钮 disabled（ChatInput.tsx:49），但总结完成后弹窗内并无 disabled 阻止再次总结（总结按钮在主 ChatInput 不在弹窗内），用户可在弹窗开着时点总结。即使不点总结，从角标入口 `openReviewFromBadge`（useAIChat.ts:216）调 `setReviewInitialDraftIds([])` 也是新数组引用，重开即触发 effect → 重置已有 edits。

**Fix:** effect 依赖收紧为 `[open]`，initialDraftIds 通过 ref 或显式 session 序号区分；或重开时保留已有 decisions（按 expId 复用，仅对新增 draft 初始化）：
```ts
// 简化方案：仅 open 由 true→true 跳过重拉（除非显式 forceRefresh）
const draftIdsKey = (initialDraftIds ?? []).join(',')
useEffect(() => {
  if (!open) return
  // 用 draftIdsKey 而非 initialDraftIds 引用作依赖，避免新数组引用重置
  ...
}, [open, draftIdsKey])
```

### WR-09: SessionMessagesModal 无分页/限长，超大历史会话全量明文渲染，DOM 节点数与 XSS-like 渲染压力

**File:** `src/components/pages/ai/SessionMessagesModal.tsx:32-72`, `electron/services/experienceService.ts:492-503`
**Issue:** `getSessionMessages(sessionId)` 透传 `getChatHistory(sessionId)`（experienceService.ts:502 → ai.ts:193-210），后者无 limit，`SELECT * FROM chat_history WHERE session_id = ? ORDER BY created_at ASC` 全量返回该会话所有消息。`SessionMessagesModal` 直接 `messages.map` 渲染每条（含 `whiteSpace: pre-wrap` 的整条 content）。长会话（数百条 + 每条几千字）会一次性渲染数百个 DOM 节点 + 全量明文 IPC 传输。trust 边界 OK（design D-04 用户看自己对话），但缺任何上界——CAP 之类不至于，但卡顿/IPC 大包是真实退化。commandSafety/IPC 已 secure，无注入面，但「无界 list」违反 CONVENTIONS「批量上限 MAX_BATCH=1000」红线精神（experience:list / confirmDrafts 都守 MAX_BATCH，getSessionMessages 漏守）。

**Fix:** getSessionMessages 加 limit 参数（默认如 200 条最近），IPC 与 service 同步校验：
```ts
// experienceService.ts
export function getSessionMessages(sessionId: string, limit = 200): Array<...> {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId 无效')
  if (limit > MAX_BATCH) throw new Error('limit 超过 MAX_BATCH')
  // ai.ts getChatHistory 需同步支持 limit（... LIMIT ?）
}
```

## Info

### IN-01: experienceIpc.ts 注释自相矛盾（行 39-40 称「不 import MAX_BATCH」，实际行 17/92 已 import 并使用）

**File:** `electron/ipc/experienceIpc.ts:17, 39-40, 92`
**Issue:** 文件头注释（行 39-40）写「不 import ExperienceService class、不 import MAX_BATCH（IPC 透传 opts.limit 不二次校验…避免 noUnusedLocals 触发）」，但行 17 实际 `import { ..., MAX_BATCH } from '../services/experienceService'`，行 92 的 `experience:confirmDrafts` handler 用 `input.drafts.length > MAX_BATCH` 做了二次校验。注释是 Phase 7 旧文（confirmDrafts 之前的描述），Phase 9 追加 confirmDrafts 时没同步更新注释，自相矛盾。下游维护者读注释会误判 IPC 层不守 MAX_BATCH。

**Fix:** 更新文件头注释为：「IPC 层 confirmDrafts 二次校验 drafts.length 上限 MAX_BATCH（与 service 层兜底形成双层防御 T-09-06 mitigate）；其余 list/get/update 透传，service 层 MAX_BATCH 截断。」

### IN-02: ChatInput Badge count 用 color="#faad14"（橙色）但无 overflow 处理，pendingDraftCount>99 显示三位数挤压按钮

**File:** `src/components/pages/ai/ChatInput.tsx:44`
**Issue:** `<Badge count={pendingDraftCount ?? 0} offset={[-4, 4]} color="#faad14">` 未设 `overflowCount`，antd Badge 默认 `overflowCount=99`，超过显示 `99+`。本应用单次 summarizeSession 产 N 条草稿（通常个位到十位），但角标累计未确认 draft 在 listDrafts 全量下理论上可达上百（用户多次总结不确认）。视觉小问题，不影响功能。

**Fix:** 显式 `overflowCount={999}` 或保持默认，按产品预期选择。低优先级。

### IN-03: executeTelnetCommand 内部 IIFE 未捕获的 reject 路径仅在 connect/exec 抛错时触发，timeout 拒绝与 IIFE reject 可能同时触发但 Promise 已 settled 无害

**File:** `electron/utils/telnetExec.ts:85-104`
**Issue:** 行 85 的 `(async () => { try {...} catch (err) { reject(err) } })()` 与行 78 的 timer reject 是两条独立 reject 路径。Promise 规范保证只有首次 reject 生效，第二次调 reject 无害。但若 timer 先触发 reject + destroy，IIFE 内的 `await connection.exec(command)` 可能抛「socket destroyed」错误 → catch → 再 reject（被忽略）。逻辑正确，仅注释未显式说明「双 reject 安全」，未来维护者可能误改。

**Fix:** 注释加一行说明：「timer reject 与 IIFE reject 双路径，Promise settled 后二次调 reject/resolve 被规范忽略，无双重结算风险」。

### IN-04: 09-REVIEW 引用「REVIEW-02/REVIEW-03」编号但本仓 phase 9 文档无对应交叉表

**File:** `src/components/pages/ai/ReviewConfirmModal.tsx:13, 20`, `src/components/pages/ai/SessionMessagesModal.tsx:6`
**Issue:** 两个组件注释分别引用「REVIEW-02 renderer 第一层质量门」「REVIEW-03 / D-9-5 溯源回链」。grep 本仓 `.planning/` 未见 REVIEW-02/REVIEW-03 编号定义文件，仅 D-9-x 系列在 09-PATTERNS.md / 09-DISCUSSION-LOG.md。可能是 discuss 阶段的临时编号未沉淀到文档，或编号已被弃用但注释残留。下游维护者无法追溯 REVIEW-02/03 的完整设计上下文。

**Fix:** 把 REVIEW-02/REVIEW-03 替换为 09-PATTERNS.md / 09-DISCUSSION-LOG.md 中实际存在的编号（如 D-9-4 质量门三层纵深 / D-9-5 溯源回链），或在 09-PATTERNS.md 补 REVIEW-02/03 条目。

---

_Reviewed: 2026-08-04_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
