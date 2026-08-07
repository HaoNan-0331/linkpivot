---
phase: 09-human-review-confirmation
fixed_at: 2026-08-05T00:00:00Z
review_path: .planning/phases/09-human-review-confirmation/09-REVIEW.md
iteration: 1
findings_in_scope: 13
fixed: 12
skipped: 1
status: partial
---

# Phase 9: Code Review Fix Report

**Fixed at:** 2026-08-05
**Source review:** `.planning/phases/09-human-review-confirmation/09-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 13（9 Warning + 4 Info）
- Fixed: 12（9 WR + IN-01/IN-03/IN-04；WR-03 拆 3 step，WR-07 与 IN-03 同 commit）
- Skipped: 1（IN-02 cosmetic，按指引默认 99+ 足够）

**三绿门禁（fixed 后自证无回归）：**
1. `npx tsc -p tsconfig.web.json --noEmit` → exit 0
2. `npm run build:electron-main`（esbuild main + preload）→ exit 0
3. `npx vitest run` → 13 files / 177 passed（基线 175 + WR-09 新增 2 case）

## Fixed Issues

### WR-01: pendingDraftCount 角标未在初始化时拉取

**Files modified:** `src/components/pages/ai/useAIChat.ts`
**Commit:** `db19fd5`
**Applied fix:** `loadData` 的 `hasConfig` 分支内补一次 `window.api.experience.listDrafts()` 同步 `pendingDraftCount`（自有 try/catch 兜底置 0），保留 `loadSessions` 调用顺序与 `useCallback` deps 不变。重启 / 重进 AIPage 后既有暂存 draft 角标正确（D-9-7 入口生效）。

### WR-02: telnet 单命令 timeout 用了整批 overallTimeout

**Files modified:** `electron/services/ai.ts`
**Commit:** `f752b6d`
**Applied fix:** telnet 分流路径新增 `const perCmdTimeout = 30000 + SSH_READY_TIMEOUT_MS + 15000`（与 SSH 单命令预算对齐，约 75s），传给 `executeTelnetCommand` 的 `options.timeout`。`overallTimeout` 仍保留用于 SSH 路径的 per-command 兜底 timer（语义不变）。telnet 单命令挂起上限由整批累计（N=5 时 180s）收紧到单命令预算。
**Status:** fixed: requires human verification（逻辑取舍：单命令预算值需人工确认与现网慢设备实测匹配）。

### WR-03: arpCollector telnet 路径未关分页 + 默认 shellPrompt

**Files modified:** `electron/utils/telnetExec.ts`, `electron/services/ai.ts`, `electron/services/arpCollector.ts`, `electron/services/ai.telnetRouting.test.ts`
**Commits:** `ec0f4b8`（step1 抽 helper）→ `abbd989`（step2 arpCollector 调用点）→ `c1c3910`（step3 测试 mock 透传）
**Applied fix:** `pickDisablePaginationCmd` / `pickShellPrompt` 从 ai.ts 抽到 `electron/utils/telnetExec.ts` 导出（实现一字不变），ai.ts 改 import，arpCollector `collectFromDevice` telnet 分支调 `executeTelnetCommand` 时传 `disablePaginationCmd: pickDisablePaginationCmd(device.vendor)` + `shellPrompt: pickShellPrompt(device.vendor)`。`ai.telnetRouting.test.ts` 的 `vi.mock('../utils/telnetExec')` 改用 `importActual` 透传真实 picker（测试断言依赖 picker 真实行为）。

### WR-04: confirmDrafts 与 validateAndStringifyAttrs 双份 troubleshooting 校验

**Files modified:** `electron/services/experienceService.ts`
**Commit:** `34d25d9`
**Applied fix:** 抽 `assertTroubleshootingAttrs(attrs, ctx)`（severity 合法枚举 + symptoms/resolution 非空，复用既有 `VALID_SEVERITIES` 常量），`confirmDrafts` adopt 路径调用它替换原内联三段校验。**注意设计分层（与 REVIEW 注解不同）：** `validateAndStringifyAttrs`（create/update 入口）保持仅强制 severity 的宽松契约——Phase 8 AI 起草允许缺 symptoms/resolution 的不完整 draft 落库，confirmDrafts adopt 是「发布前最后一道闸口」强制三字段必填，两处契约有意分层；severity 枚举共用 `VALID_SEVERITIES` 消除漂移。43 个 experienceService 单测全绿（错误信息 substring 匹配 `severity`/`symptoms`/`resolution` 保持兼容）。
**Status:** fixed: requires human verification（未完全照搬 REVIEW「共用」建议——保留 create/update 宽松契约，需人工确认分层决策符合 Phase 8 起草语义）。

### WR-05: confirmDrafts relateDevices diff N+1 查询

**Files modified:** `electron/services/experienceService.ts`, `electron/services/experienceService.test.ts`
**Commit:** `d78fd8b`
**Applied fix:** confirmDrafts 事务内、循环外新增 `stmtCurDev = conn.prepare('SELECT device_id FROM exp_device_rel WHERE experience_id = ?')`，relateDevices diff 用 `(stmtCurDev.all(d.expId) as Array<{device_id:string}>).map(r => r.device_id)` 替换 `listDevicesByExperience(d.expId).map(dev => dev.id)`。`listDevicesByExperience` 自身不动（其他通道在用，安全语义独立）。mock DB 增补新 SELECT 模式分支以支撑单测。

### WR-06: 「丢弃」文案与 hard DELETE 语义错位

**Files modified:** `src/components/pages/ai/ReviewConfirmModal.tsx`
**Commit:** `4518a80`
**Applied fix:** 采用方案 (a)——footer「全选丢弃」→「全选删除」、提交按钮「确认采纳 N 条 + 丢弃 M 条」→「... + 删除 M 条」、提交后 toast「已采纳 X 条，丢弃 Y 条」→「... 删除 Y 条」同步改。「取消（暂存，稍后从角标重开）」保留（语义对）。`discard` = hard DELETE 的 D-9-6 决策不变。

### WR-07: telnetExec finally 块 timedOut 路径再 await end()

**Files modified:** `electron/utils/telnetExec.ts`
**Commit:** `778ce6f`（与 IN-03 同 commit）
**Applied fix:** `.finally` 内对 `timedOut` 路径跳过 `await connection.end()`（已 destroy 不需再发 EOF），改为幂等 `connection.destroy()`；非 timedOut 路径保持 `await connection.end()` 优雅发 EOF。模块头注释同步更新。

### WR-08: ReviewConfirmModal initialDraftIds 数组引用触发 effect 重置 decisions

**Files modified:** `src/components/pages/ai/ReviewConfirmModal.tsx`
**Commit:** `d1683f1`
**Applied fix:** 新增 `const draftIdsKey = (initialDraftIds ?? []).slice().sort().join(',')`，effect 依赖从 `[open, initialDraftIds]` 收紧为 `[open, draftIdsKey]`。同一批 draft id（即使父层新建数组引用）不再触发 effect 重置用户已编辑 decisions；新增 draft id 才重拉。`.sort()` 保证 id 顺序无关（虽 summarizeSession 返回顺序稳定，sort 兜底）。

### WR-09: SessionMessagesModal 无分页 / 限长

**Files modified:** `electron/services/ai.ts`, `electron/services/experienceService.ts`, `electron/ipc/experienceIpc.ts`, `electron/preload.ts`, `src/types/electron.d.ts`, `electron/services/experienceService.test.ts`
**Commit:** `0d70fba`
**Applied fix:** `ai.ts getChatHistory` 新增第二参数 `limit?: number`（取最近 N 条：子查询 ORDER BY ASC LIMIT ? 外层再 ASC），不传 = 全量（向后兼容 ai 域自用）。`experienceService.getSessionMessages(sessionId, limit=200)` 新增 limit 参数 + 守 `MAX_BATCH` throw + 透传 getChatHistory。IPC handler 收 `limit?: number`（默认 200），preload 签名同步加 `limit?`，`electron.d.ts` 三向一致。新增 2 个 WR-09 单测（limit 透传取最近 N 条 / limit > MAX_BATCH throw）。177 全绿。

### IN-01: experienceIpc.ts 头注释自相矛盾

**Files modified:** `electron/ipc/experienceIpc.ts`
**Commit:** `d22319a`
**Applied fix:** 文件头注释更新为「MAX_BATCH 由 service 层导出，IPC 层 confirmDrafts 二次校验 drafts.length 上限（双层防御 T-09-06）；其余 list/get/update 透传 opts.limit，service 层 listExperiences MAX_BATCH throw；getSessionMessages（WR-09）limit 默认 200 守 MAX_BATCH」。

### IN-03: telnetExec 双 reject 路径安全注释

**Files modified:** `electron/utils/telnetExec.ts`
**Commit:** `778ce6f`（与 WR-07 同 commit）
**Applied fix:** IIFE 上方加注释说明 timer reject 与 IIFE catch reject 双路径，Promise settled 后二次调 reject/resolve 被 Promise 规范忽略，无双重结算风险。

### IN-04: REVIEW-02 / REVIEW-03 编号无交叉表

**Files modified:** `src/components/pages/ai/ReviewConfirmModal.tsx`, `src/components/pages/ai/SessionMessagesModal.tsx`
**Commit:** `9ad8046`
**Applied fix:** REVIEW-02 → D-9-4（质量门三层纵深），REVIEW-03 → D-9-5（溯源回链）。已 grep 确认 D-9-4/D-9-5 在 `09-PATTERNS.md` / `09-DISCUSSION-LOG.md` 实际存在。

## Skipped Issues

### IN-02: ChatInput Badge 无 overflowCount

**File:** `src/components/pages/ai/ChatInput.tsx:44`
**Reason:** cosmetic, default 99+ sufficient —— REVIEW 自身标「低优先级 / 按产品预期选择」，本应用单次 summarizeSession 产 N 条草稿（个位到十位），角标累计达 99+ 极罕见；antd Badge 默认 `overflowCount=99` 显示 `99+` 足够，不为极边角 case 加配置。按 `finding_specific_guidance` 指引 SKIP。
**Original issue:** `<Badge count={pendingDraftCount ?? 0} ...>` 未设 `overflowCount`，pendingDraftCount>99 显示三位数挤压按钮。

---

_Fixed: 2026-08-05_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
