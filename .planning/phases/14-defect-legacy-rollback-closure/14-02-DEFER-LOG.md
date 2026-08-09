# FIX-02 旧规划回退项 + H3C LLDP 甄别登记表（confirm / ai_exec_logs / 会话标题 / H3C）

**Phase:** 14 (defect-legacy-rollback-closure) / **Plan:** 14-02 (FIX-02)
**登记日期:** 2026-08-10
**甄别依据:** D-14-2（researcher/planner 全权 grep+代码核对，判定「已满足→FIXED / 前提偏差→FIXED / 需修→FIX / 作废→DEFER」每项含 file:line 佐证 + reason + 重评估条件，不照单全修不静默跳过，沿用 Phase 13 SEC-04 D-13-4 甄别退路模式）+ D-14-3（H3C 作废锁定，无需甄别直接登记）+ D-14-4（测试方式 discretion）。
**SC2-SC5 硬要求:** 4 项无静默跳过，每项要么 FIXED 要么 FIX 要么 DEFER 含 reason + 重评估条件。

原始来源：体检 `.planning/audits/2026-08-07-health-audit.md` §1.0 旧规划回退 4 项（confirm 防重复点击 / ai_exec_logs 完整记录 / 会话标题 early-return / H3C LLDP 邻居发现路径）+ §2.1 vendor-commands.ts 死代码（H3C 作废佐证）。

---

## #1 confirm 防重复点击

**CommandConfirmModal 确认/拒绝按钮防连点保护 + onConfirm 后防重复 confirmCommand IPC**

- **结论：FIXED（核心关窗锁）+ FIX（视觉层 Task 1 落地）**
- **佐证：**
  - 核心关窗锁：`src/components/pages/ai/useAIChat.ts:196` `handleConfirm` 入口守卫 `if (!pendingConfirm || !currentSessionId) return` + `useAIChat.ts:198` `setPendingConfirm(null) // 立即关闭弹窗，防止重复点击`（在 `window.api.ai.confirmCommand` IPC 调用前同步关窗）—— Modal `open={!!pendingConfirm}`（`CommandConfirmModal.tsx:12`）→ false → 弹窗消失，第二次「确认执行」按钮无处可点
  - 视觉层 Task 1 落地：`useAIChat.ts:35` `const [confirmInFlight, setConfirmInFlight] = useState(false)` + `useAIChat.ts:204` `setConfirmInFlight(true)`（IPC 前置）+ `useAIChat.ts:229` `setConfirmInFlight(false)`（IPC 完成/异常释放）+ `useAIChat.ts:293` return 暴露 `confirmInFlight` + `CommandConfirmModal.tsx:16` 拒绝按钮 `loading={confirmInFlight} disabled={confirmInFlight}` + `CommandConfirmModal.tsx:19` 确认按钮 `loading={confirmInFlight} disabled={confirmInFlight}` + `AIPage.tsx:102` 透传 `confirmInFlight={chat.confirmInFlight}` + `types.ts:60` `UseAIChatReturn.confirmInFlight: boolean`
  - analog：`ChatInput.tsx:38-39` 发送按钮 `loading={loading} disabled={!value.trim()}` 双锁；`ChatInput.tsx:48-49` 经验总结按钮 `loading={summarizing} disabled={!canSummarize || loading || summarizing}` 多条件锁
- **审计引用：** 体检 §1.0 旧规划回退「confirm 防重复点击」
- **reason：**
  - **核心关窗锁已满足（FIXED）：** `setPendingConfirm(null)` 在 IPC `confirmCommand` 调用前同步关窗，弹窗 open 绑 `!!pendingConfirm` → false → 弹窗消失，第二次按钮无处可点，逻辑层防重复 IPC 已满足
  - **视觉层 Task 1 补强（FIX）：** 给用户 IPC 在途视觉反馈（按钮转圈 + 禁用）+ 防「同 tick 极快连点」理论间隙（虽被 line 196 守卫 + line 198 已置 null 拦截，视觉无反馈则用户感知不到已触发）—— confirmInFlight 是视觉层补充双保险，核心关窗锁红线不变
- **测试通道说明（D-14-4 测试方式 discretion，无摇摆）：**
  - `confirmInFlight` 关窗锁逻辑紧耦合 React hook `useState` 闭包（`pendingConfirm` / `currentSessionId`）+ React setter + `window.api.ai.confirmCommand` IPC 副作用，**无纯函数边界可提取**（非 reducer / 非纯状态转移 / 非可独立测的校验逻辑）→ 不在 `tests/unit/` 写纯函数单测（无可独立测对象）
  - 按钮 `loading+disabled` 视觉反馈属 renderer 组件渲染交互测试范畴，项目 `@testing-library/*` 未安装 + 0 renderer 组件测试先例 → **真机 HV defer**
  - 源断言 grep（confirmInFlight prop 透传 + setConfirmInFlight true/false + loading/disabled prop 落地）+ 真机 HV 验「confirm 点击后按钮转圈禁用 + IPC 完成恢复 + 连点只触发一次 confirmCommand IPC」记 SUMMARY
- **重评估条件：** 无（FIX 已落地，核心 + 视觉双闭环）

---

## #2 ai_exec_logs 完整记录

**AI 命令执行链路落库 ai_exec_logs 表是否记全 prompt_text + ai_response（非只记执行命令）**

- **结论：FIXED（已满足，无需改）**
- **佐证：**
  - `electron/services/ai.ts:891-900` chat() 主路径 `createLog({ ... promptText: JSON.stringify(fullMessages, null, 2), aiResponse: aiReply })` 已传全两字段（promptText = 完整 system + 全 messages JSON，aiResponse = 完整 AI 首次回复）
  - `electron/services/aiExecLogger.ts:8-34` `createLog` INSERT 含 `prompt_text` + `ai_response` 列（`entry.promptText || ''` / `entry.aiResponse || ''` 兜底空串，line 25 加密 `device_name_enc`，红线②字段加密不变）
  - `electron/services/aiExecLogger.ts:42-52` `appendLogAiResponse` UPDATE `prompt_text = prompt_text || sep || secondPrompt` + `ai_response = ai_response || sep || secondResponse`（追加不覆盖，confirmCommand 二次 AI 调用的 prompt + response 完整保留）
  - `electron/database/migrations.ts:38-49` v2 `hasColumn` 守卫 `ALTER TABLE ai_exec_logs ADD COLUMN prompt_text TEXT DEFAULT ''` + `ai_response TEXT DEFAULT ''`（幂等已加列）
  - `electron/services/ai.ts:657` `appendLogAiResponse(cmd.logId, secondPrompt, finalReply)` 二次调用唯一 caller（confirmCommand 流程内）；`ai.ts:891` `createLog(` 唯一 caller（chat 主路径内）
- **审计引用：** 体检 §1.0 旧规划回退「ai_exec_logs 完整记录」
- **reason：** 审计时点可能 schema 未加列（v2 迁移未跑）或 createLog 漏字段（旧版本仅记命令不记 prompt/response）。现状三项全就位——v2 迁移加列（hasColumn 守卫幂等）+ createLog INSERT 全字段（prompt_text + ai_response 双传）+ appendLogAiResponse 追加二次调用（不覆盖首次），prompt_text + ai_response 完整落库可审计（事后能从日志还原完整 prompt 与 AI 响应，含二次确认调用）
- **重评估条件：** 若未来 AI 命令执行链新增 caller（非 chat 主路径 + confirmCommand 二次）调 `createLog` 漏传 `promptText`/`aiResponse`，重评估补字段（grep `createLog(` 全仓核对新 caller 是否传全两字段）

---

## #3 会话标题 early-return

**会话标题更新逻辑是否在 confirm_required early return 之前执行（需确认会话标题不被 early return 跳过）**

- **结论：FIXED（前提偏差，现状已在前）**
- **佐证：**
  - 审计前提偏差：标题更新**不在 `ai.ts`**。`grep updateSessionTitle` 全仓：`ai.ts:188` 仅函数定义 `export function updateSessionTitle(sessionId: string, title: string): void`，零 caller 在 ai.ts chat 流程内（IPC handler 在 `main.ts`，由 renderer 触发）
  - 实际位置：`src/components/pages/ai/useAIChat.ts:132-137` `handleSend` 内（line 133 `if (messages.length === 0)` 首条消息才更新 + line 134 `const title = text.length > 20 ? text.substring(0, 20) + '...' : text` + line 135 `void window.api.ai.updateSessionTitle(currentSessionId, title)` IPC + line 136 `setSessions` 更新本地态）
  - 执行顺序：标题更新 line 132-137 **在** `confirm_required` 分支 line 148 `if (parsed.type === 'confirm_required') { setPendingConfirm(parsed); setLoading(false); return }` 之**前**（line 139-185 try 块内 confirm_required 在标题更新之后）→ 需确认会话（confirm_required）的标题已在 line 135 落库，不被 early return 跳过
- **审计引用：** 体检 §1.0 旧规划回退「会话标题更新逻辑移出 confirm_required early return」
- **reason：** 审计时点可能标题更新逻辑位置不同（曾被放在 ai.ts 或 confirm_required 分支之后），后被移到 renderer `useAIChat.handleSend` 且**已正确排在 confirm_required 分支之前**。现状（line 132-137 标题更新 → line 148 confirm_required early return）执行顺序正确，需确认会话标题正常更新不被跳过
- **重评估条件：** 若未来标题更新逻辑移回 `ai.ts` 或调整 `handleSend` 内执行顺序（标题更新放到 confirm_required 分支之后），重评估

---

## #4 H3C LLDP 邻居发现

**H3C 设备拓扑自动发现是否需补显式 LLDP 邻居命令解析**

- **结论：DEFER（作废，D-14-3 锁定，无需甄别/无需写 H3C 代码）**
- **佐证：**
  - `electron/services/discovery.ts:101-104` prompt 内联华为/H3C/Cisco 三厂商 LLDP 邻居命令：line 101 华为 `display lldp neighbor brief` + line 102 H3C `display lldp neighbor-information list` + line 104 其他厂商「LLDP 邻居、ARP 表、路由表」
  - `electron/services/discovery.ts:275` AI 据 LLDP/CDP 邻居信息推断设备间连接关系（edges）
  - 用户真机已验证当前版本（commit `53447da` discovery.ts AI 驱动拓扑自动发现）对 H3C 设备**真机验证正常、拓扑 edges 非空**（D-14-3 锁定依据）
  - 旧 `vendor-commands.ts`（硬编码厂商命令表 `getDiscoveryCommands`，3 export 零调用）已于 2026-08-07 commit `0bd4dbd` 当死代码正确删除（`ls electron/services/vendor-commands.ts` 确认 NOT present，体检 §2.1 佐证）
- **审计引用：** 体检 §1.0 旧规划回退「H3C LLDP 邻居发现路径」+ §2.1 vendor-commands.ts 死代码
- **reason：** 体检 §1.0 标的「方向过时」指旧 `vendor-commands.ts` 硬编码厂商命令表方向——该方向已废弃（commit `0bd4dbd` 删除死代码）且新路径（discovery.ts AI 驱动，prompt 内联 H3C LLDP 命令）已覆盖 H3C（用户真机验证 edges 非空 + line 102 内联 H3C `display lldp neighbor-information list`）。**重评估的是「正确路径」非「复活旧 vendor-commands 硬编码方案」**——本 phase 零写 H3C 代码，不复活硬编码命令集（红线，T-14-02-06）
- **重评估条件：** 未来若 AI 驱动发现对某 H3C 型号失效（edges 空 / 邻居采集漏），重评估加显式 LLDP 命令解析（如 parser 增强，非复活 vendor-commands 硬编码方向）

---

## 甄别汇总

| 项 | 结论 | 核心理由 |
|----|------|----------|
| #1 confirm 防重复点击 | FIXED（核心关窗锁）+ FIX（视觉层 Task 1） | setPendingConfirm(null) 关窗锁防重复 IPC 主防线（不变）+ confirmInFlight 按钮 loading+disabled 视觉双保险（Task 1 落地） |
| #2 ai_exec_logs 完整记录 | FIXED（已满足） | createLog INSERT prompt_text+ai_response + appendLogAiResponse 追加二次 + v2 迁移加列三项全就位 |
| #3 会话标题 early-return | FIXED（前提偏差） | 标题更新在 renderer useAIChat.ts:132-137 且已正确排在 confirm_required 分支 line 148 之前 |
| #4 H3C LLDP 邻居发现 | DEFER（作废） | 用户真机验证 + discovery.ts:101-275 已覆盖 H3C + 旧 vendor-commands.ts 已删（D-14-3） |

**SC2-SC5 满足确认：** 4 项逐项有明确结论（FIXED / FIXED+FIX / FIXED / DEFER）+ 代码层佐证（file:line）+ 审计引用 + reason（FIX/DEFER 项含重评估条件），无静默跳过。

## 三红线改动后仍生效确认

**三红线（IPC `secure`/`safe` 鉴权 / 字段加密 `_enc` / `commandSafety.isCommandAllowed`）改动后仍生效确认：**
- **红线① IPC 鉴权：** 本 plan Task 1 仅改 renderer 组件 `CommandConfirmModal` + hook `useAIChat` + `types.ts` + `AIPage.tsx`（视觉层 loading+disabled），零改动 `ai:chat` / `ai:confirmCommand` IPC secure 包装（`main.ts:192/199` 仍 secure，红线①不回退）；FIX-02 #2/#3/H3C 甄别零代码改动
- **红线② 字段加密：** 本 plan 零改动 `_enc` / `encField` / `decField` 路径（ai_exec_logs 仅 `device_name_enc` 加密不变，甄别判定已满足零代码改动；confirm 视觉增强不碰加密；红线②不涉及）
- **红线③ commandSafety：** 本 plan 甄别只动记录（ai_exec_logs 已满足零改）+ 标题（前提偏差零改）+ renderer 视觉（confirm 按钮），零改动 `commandSafety.isCommandAllowed`（`ai.ts:334` executeCommandsOnDevice 执行层 + `ai.ts:890` chat 主路径安全校验双守卫不变）；`confirm_required` 二次确认闸口（ai.ts:890）不动，红线③不回退

---

*Generated: 2026-08-10 by Plan 14-02 executor*
