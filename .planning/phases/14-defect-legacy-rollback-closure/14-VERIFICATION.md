---
phase: 14-defect-legacy-rollback-closure
verified: 2026-08-10T00:45:00Z
status: human_needed
score: 9/10 must-haves verified（1 项需真机 HV）
overrides_applied: 0
human_verification:
  - test: "FIX-02 #1 confirm 视觉层防重复 — 启动 electron:dev，AI 对话触发 confirm_required 弹窗，点「确认执行」按钮，观察两按钮（拒绝/确认）是否立即转圈 loading + disabled 禁用，IPC 完成后弹窗消失按钮恢复；随后连点「确认执行」两次，验只触发一次 confirmCommand IPC（main.ts:199 ai:confirmCommand → ai.ts:577-579 取后即删 throw 第二次）"
    expected: "按钮点击瞬间转圈禁用，IPC 在途期间不可二次点击；连点两次只发一次 IPC，无「未找到待确认命令」误导 toast"
    why_human: "renderer 组件渲染交互（按钮 loading/disabled 视觉态 + 同 tick 连点竞态时序），项目 @testing-library 未安装、0 renderer 组件测试先例；源断言 grep 已验（confirmInFlight prop 透传 + 按钮 loading={confirmInFlight} disabled={confirmInFlight} + useRef 同步锁 confirmInFlightRef），但按钮转圈/禁用真实渲染行为与连点时序必须真机确认"
---

# Phase 14: Defect & Legacy Rollback Closure 验证报告

**Phase Goal（ROADMAP）:** anomaly 告警 new_ip 计数正确不再恒零、旧规划回退的 4 项（confirm 防重复点击 / ai_exec_logs 完整记录 / 会话标题更新逻辑 / H3C LLDP 邻居发现路径）逐条甄别并修或显式作废
**Verified:** 2026-08-10T00:45:00Z
**Status:** human_needed
**Re-verification:** 否 — 初始验证（无前置 14-VERIFICATION.md）

## Goal Achievement

### Observable Truths（SC1-5 + 三红线，goal-backward 逐条对实际代码）

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| SC1 | anomalyService new_ip 计数正确不再恒零（processARPEntries 首次见 IP 写 change_type='new_ip'，getStats/面板/CSV 反映真实新增） | ✓ VERIFIED | `anomalyService.ts:133-136` else 全新 IP 分支补 `if (hasBaseline) { recordChange(ip, null, mac, 'new_ip') }`（BUG-1 写入侧根因修复）；`:98` hasBaseline 判定 + `:157-159` 后置基线 UPDATE 纳入 runBatch 事务体（CR-02 fix）；`:235` getStats newIp COUNT 读取侧 `WHERE change_type='new_ip'` 不变（D-14-1 锁定，本来就对）。anomalyNewIp.real.test.ts Test 2（报 new_ip）+ Test 5（getStats().newIp=2 修前恒零修后真实）+ Test 7（混合批次）8/8 PASS 佐证 |
| SC2 | confirm 防重复点击生效（连点不触发重复 IPC/命令执行） | ⚠️ 部分验证（核心+源断言 VERIFIED，真机交互待 HV） | 核心关窗锁 `useAIChat.ts:209 setPendingConfirm(null) // 立即关闭弹窗，防止重复点击`（IPC 前同步关窗）保留；WR-01 fix `useAIChat.ts:39 confirmInFlightRef=useRef(false)` + `:206-207 if(confirmInFlightRef.current) return; confirmInFlightRef.current=true`（同步锁根治同 tick 连点竞态）；视觉层 `CommandConfirmModal.tsx:18/21 两 Button loading={confirmInFlight} disabled={confirmInFlight}` + `AIPage.tsx:102 confirmInFlight={chat.confirmInFlight}` 透传 + `types.ts:60 confirmInFlight:boolean`；main 兜底 `ai.ts:577-579` confirmCommand 取后即删 throw 防重入。源断言全验，真机按钮转圈/连点时序需 HV |
| SC3 | ai_exec_logs 完整记录 prompt_text + ai_response（甄别判定 FIXED 已满足） | ✓ VERIFIED | `ai.ts:891-900` chat 主路径 createLog 传 `promptText: JSON.stringify(fullMessages,null,2)` + `aiResponse: aiReply`；`aiExecLogger.ts:20` INSERT 含 prompt_text+ai_response 列；`:44 appendLogAiResponse` UPDATE 追加（`prompt_text = prompt_text \|\| ? \|\| ?` 不覆盖）；`migrations.ts:40/43` v2 hasColumn 守卫 ALTER ADD COLUMN 两列（幂等）；`ai.ts:657` appendLogAiResponse 二次唯一 caller。甄别结论正确，零代码改动合理 |
| SC4 | AI 会话标题更新在 confirm_required early return 之前（甄别判定 FIXED 前提偏差） | ✓ VERIFIED | `useAIChat.ts:141-145` 标题更新（`if (messages.length===0)` 首条才更 + `:143 updateSessionTitle` IPC + `:144 setSessions`）**在** `:156-160 confirm_required early return`（setPendingConfirm+setLoading(false)+return）**之前**。审计前提偏差确认（updateSessionTitle 在 ai.ts:188 仅函数定义，零 chat 流程 caller，标题实际在 renderer）。甄别结论正确 |
| SC5 | H3C LLDP 邻居发现路径重新评估（甄别判定 DEFER 作废） | ✓ VERIFIED | `discovery.ts:102` prompt 内联 H3C `display lldp neighbor-information list`；`discovery.ts:101/103` 华为/Cisco LLDP 命令齐全；`vendor-commands.ts` 确认 NOT present（已删死代码，commit 0bd4dbd 体检 §2.1）；DEFER-LOG 登记「重评估的是正确路径非复活旧 vendor-commands 硬编码方案」。作废结论符合 ROADMAP Risk 红线（不可回退已废弃命令集） |
| 红线① | IPC secure/safe 鉴权不回退 | ✓ VERIFIED | anomalyIpc.ts 全 channel `secure(...)` 包装（getChanges/acknowledge/acknowledgeAll/deleteChange/deleteChanges/getStats/getBindingHistory/getExcludedIPs/addExcludedIP 共 9+ 处）；main.ts:192 `ai:chat` + :199 `ai:confirmCommand` 仍 secure 包装。Phase 14 改动（service 层 + 迁移 + init + renderer 视觉层）零触及 IPC 网关 secure 包装 |
| 红线② | _enc 字段加密不回退 | ✓ VERIFIED | anomalyService.ts grep encField/decField/commandSafety = 0（异常检测非加密链）；ai_exec_logs `device_name_enc`（init.ts:61）+ aiExecLogger.ts:25 加密不变；ip_mac_changes 无 _enc 列（本 phase 不碰加密）。Phase 14 零改动加密路径 |
| 红线③ | commandSafety.isCommandAllowed + confirm_required 闸口不回退 | ✓ VERIFIED | anomalyService 是 ARP 异常检测写入链不经 AI 命令执行层（grep commandSafety=0）；FIX-02 #2/#3/H3C 甄别零代码改动；commandSafety 在 ai.ts:334/890 双守卫 + confirm_required 二次确认闸口（ai.ts:890）不变 |
| 向后兼容 | 遗留库（升级前已有 binding）经 v12 迁移后存量 IP 不误报 new_ip（CLAUDE.md 硬约束） | ✓ VERIFIED | migrations.ts:354-359 v12 hasColumn 守卫 `ALTER TABLE ip_mac_bindings ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0`（存量行默认 0）+ MIGRATION_HEAD=12；init.ts:146 fresh-install DDL 同步含 is_baseline 列（双路径一致）；anomalyService.ts:112-120 存量 IP 走 currentBinding 分支只 update last_seen 不进 else 不误报；:157-159 后置 UPDATE WHERE is_baseline=0 把存量行纳入基线。anomalyNewIp Test 6（预置存量 is_baseline=0 → 喂该 IP 不误报 + last_seen 更新 + 后置 UPDATE 置 1）PASS 佐证 |
| 三绿门禁 | tsc/build/test 全绿零回归 | ✓ VERIFIED | 实测 `npx tsc -p tsconfig.web.json` EXIT=0；`npm run test:electron` 7 files/32 tests PASS（含 anomalyNewIp.real.test.ts 1 file/8 it）；`npm test` 18 files/256 tests PASS 零回归 |

**Score:** 9/10 truths verified（SC2 真机交互部分待 HV，源断言+核心锁已 VERIFIED）

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `electron/services/anomalyService.ts` | processARPEntries 补 recordChange('new_ip') + 首次基线（hasBaseline 门控 + 后置 UPDATE 纳入事务 CR-02 fix）+ _setAnomalyDbGetter mock 注入口 + CR-01 localtime 统一 | ✓ VERIFIED | :11-16 dbGetter + _setAnomalyDbGetter；:98 hasBaseline；:133-136 recordChange('new_ip') hasBaseline 门控；:157-159 后置 UPDATE 移入 runBatch 事务（CR-02 fix）；:170-174 localNow() localtime 统一（CR-01 fix）；:189/211/216 recordChange/acknowledgeChange/acknowledgeAll 三处用 ts 参数绑定 localtime。L1 存在+L2 实质（非 stub）+L3 wired（processARPEntries 被 arpIpc 调）+L4 数据流（realDb 真路径测试验真实写入） |
| `electron/database/migrations.ts` | v12 迁移加 is_baseline 列（hasColumn 幂等）+ MIGRATION_HEAD=12 + 注册 MIGRATIONS 数组 | ✓ VERIFIED | :16 MIGRATION_HEAD=12；:354-359 v12 函数 hasColumn 守卫 + ALTER ADD COLUMN + pragma user_version=12，包 db.transaction；:376 注册 MIGRATIONS。L1+L2+L3（runMigrations 调用链） |
| `electron/database/init.ts` | fresh-install ip_mac_bindings DDL 同步加 is_baseline 列（双路径一致） | ✓ VERIFIED | :146 `is_baseline INTEGER NOT NULL DEFAULT 0`（与 v12 迁移列定义逐字一致） |
| `tests/electron/anomalyNewIp.real.test.ts` | realDb 真路径单测（首基线/新增报/已知不报/mac_changed 不回归/getStats 不恒零/遗留库/混合批次/UNIQUE fallback） | ✓ VERIFIED | 8 it（实测 8/8 PASS）；用 _setAnomalyDbGetter 注入 realDb；Test 5 验 getStats().newIp=2 不恒零；Test 6 验遗留库向后兼容三断言；Test 7 混合批次；Test 8 UNIQUE fallback（WR-04 补覆盖） |
| `.planning/phases/14-defect-legacy-rollback-closure/14-02-DEFER-LOG.md` | FIX-02 三项 + H3C 共 4 项甄别登记（结论+file:line 佐证+reason+重评估条件+三红线确认段） | ✓ VERIFIED | 4 项段（#1 confirm FIXED+FIX / #2 ai_exec_logs FIXED / #3 会话标题 FIXED 前提偏差 / #4 H3C DEFER 作废）+ 甄别汇总表 + 三红线改动后仍生效确认段；每项 file:line 佐证经本验证逐条核对与实际代码一致 |
| `src/components/pages/ai/useAIChat.ts` | confirmInFlight 状态 + handleConfirm 在途锁 + WR-01 useRef 同步锁 + 核心关窗锁保留 | ✓ VERIFIED | :35 confirmInFlight useState；:39 confirmInFlightRef useRef（WR-01 fix）；:206-207 ref 同步守卫+置 true；:209 setPendingConfirm(null) 关窗锁保留；:211 setConfirmInFlight(true)；:236-237 ref+state 释放；:301 return 暴露 |
| `src/components/pages/ai/CommandConfirmModal.tsx` | confirmInFlight prop + 两 Button loading+disabled | ✓ VERIFIED | :8 confirmInFlight: boolean interface；:11 解构；:18 拒绝按钮 + :21 确认按钮 均 loading={confirmInFlight} disabled={confirmInFlight} |
| `src/components/pages/ai/types.ts` | UseAIChatReturn 加 confirmInFlight | ✓ VERIFIED | :60 confirmInFlight: boolean |
| `src/components/pages/AIPage.tsx` | 透传 confirmInFlight prop | ✓ VERIFIED | :102 confirmInFlight={chat.confirmInFlight} |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| anomalyService.processARPEntries else 分支 | ip_mac_changes 表 | recordChange(ip, null, mac, 'new_ip') INSERT | ✓ WIRED | :134 调 recordChange + :190 INSERT 落 ip_mac_changes；Test 2/5/7 验行数变化 |
| migrations.ts v12 | ip_mac_bindings 表 | hasColumn + ALTER ADD COLUMN is_baseline | ✓ WIRED | :356 hasColumn 守卫 + :357 ALTER；runMigrations 链调用 |
| init.ts fresh-install DDL | ip_mac_bindings 表 | CREATE TABLE 含 is_baseline | ✓ WIRED | :146 DDL 含列；与 v12 列定义逐字一致 |
| useAIChat handleConfirm | setConfirmInFlight + useRef | IPC 在途前置 true / finally false | ✓ WIRED | :207 ref true + :211 state true + :236-237 ref+state false（finally 块外但 try/catch 后必达） |
| CommandConfirmModal 两 Button | confirmInFlight prop | loading={confirmInFlight} disabled={confirmInFlight} | ✓ WIRED | :18 + :21 双按钮双 prop；AIPage.tsx:102 透传链完整 |
| DEFER-LOG | SC2-SC5 甄别闭环 | 4 项结论 + file:line + 三红线确认段 | ✓ WIRED | 4 项段 + 汇总表 + 三红线段；file:line 经核对一致 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| anomalyService.processARPEntries | changes: IPMACChange[] | recordChange INSERT 返回 + createBinding | 是（realDb 真路径 INSERT lastInsertRowid） | ✓ FLOWING |
| getStats().newIp | COUNT(*) | ip_mac_changes WHERE change_type='new_ip' | 是（Test 5 验=2 真实新增，修前恒零） | ✓ FLOWING |
| CommandConfirmModal 按钮 loading/disabled | confirmInFlight prop | useAIChat useState + useRef | 是（ref 同步 + state 异步双源驱动按钮态） | ✓ FLOWING（真机交互待 HV） |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| tsc web strict + noUnusedLocals | `npx tsc -p tsconfig.web.json` | EXIT=0 | ✓ PASS |
| anomalyNewIp 真路径单测 | `npm run test:electron -- tests/electron/anomalyNewIp.real.test.ts` | 1 file/8 it PASS（1.36s） | ✓ PASS |
| 全 test:electron 套件 | `npm run test:electron` | 7 files/32 tests PASS | ✓ PASS |
| plain node npm test 零回归 | `npm test` | 18 files/256 tests PASS | ✓ PASS |

### Probe Execution

Phase 14 PLAN/SUMMARY 未声明 probe-*.sh 脚本，非 migration/tooling phase（goal 是 bug 修复 + 甄别登记，测试经 vitest 套件非 shell probe）。Step 7c: SKIPPED（无 probe 脚本）。

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| FIX-01 | 14-01 | anomaly new_ip 计数正确（processARPEntries 首次见 IP 写 new_ip，或移除恒零字段） | ✓ SATISFIED | 选「写入侧补 recordChange('new_ip')」路径（非移除字段，避免三处消费方半残）：anomalyService.ts:133-136 + hasBaseline 门控 + v12 is_baseline 列 + 8 it 单测（Test 2/5/7 闭环） |
| FIX-02 | 14-02 | 旧规划回退 4 项甄别修复（confirm/ai_exec_logs/会话标题/H3C LLDP） | ✓ SATISFIED（SC2 真机 HV 部分 defer） | 14-02-DEFER-LOG 4 项逐条结论 + file:line 佐证：#1 confirm FIXED(核心)+FIX(视觉层 Task1) + WR-01 useRef 锁；#2 ai_exec_logs FIXED 已满足；#3 会话标题 FIXED 前提偏差；#4 H3C DEFER 作废。SC2 视觉交互真机 HV 已登记 |

REQUIREMENTS.md 无 orphaned ID（FIX-01/FIX-02 均映射 Phase 14 且被 plan 认领）。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| anomalyService.ts | 176 | `createBinding(db: any, ...)` 参数 any（IN-01） | ℹ️ Info | 与 Service 静态类强类型风格不符，应 `Database.Database`；纯类型优化，无功能影响，REVIEW 标 Info 级未强制 |
| CommandConfirmModal.tsx | 30/40 | `key={i}` 数组索引作 React key（IN-03） | ℹ️ Info | 命令列表 confirm 触发时不可变快照，实际无渲染 bug；纯风格优化，REVIEW 标 Info 级未强制 |
| recordChange 返回值 detectedAt | 189 | 已改 localtime 字符串（CR-01 fix 后与 DB 一致） | ✓ 已修 | 原 IN-02 ISO 串与 DB 不一致问题，CR-01 fix 后 :189 ts 同时用于 INSERT 参数和返回值，逐字一致 |

无 TBD/FIXME/XXX 未引用 debt marker。无 stub/placeholder/console.log-only 实现。

### Human Verification Required

### 1. FIX-02 #1 confirm 视觉层防重复点击（真机交互）

**Test:** 启动 electron:dev → AI 对话触发 confirm_required 命令确认弹窗 → 点「确认执行」按钮 → 观察两按钮（拒绝执行/确认执行）是否立即转圈 loading + disabled 禁用，IPC 完成后弹窗消失按钮恢复 → 随后连点「确认执行」两次快速点击 → 验只触发一次 confirmCommand IPC（main.ts:199 → ai.ts:577-579 取后即删 throw 第二次）→ 验无「未找到待确认命令」误导 toast 弹出

**Expected:** 按钮点击瞬间转圈禁用（confirmInFlight=true 期间），IPC 在途期间不可二次点击；连点两次只发一次 IPC（confirmInFlightRef 同步锁 + setPendingConfirm(null) 关窗锁 + main 取后即删三保险）；无误导 toast

**Why human:** renderer 组件渲染交互（按钮 loading/disabled 视觉态 + 同 tick 连点竞态时序）。项目 `@testing-library/*` 未安装、0 renderer 组件测试先例（vitest 仅 electron/ main 真路径 + unit/ plain 纯单元）。源断言 grep 已验（confirmInFlight prop 透传链 useAIChat→AIPage→CommandConfirmModal 完整 + 两按钮 loading/disabled={confirmInFlight} + useRef 同步锁 confirmInFlightRef + 核心关窗锁 setPendingConfirm(null) 保留），但按钮转圈/禁用真实渲染行为与同 tick 连点竞态时序必须真机确认。D-14-4 测试方式 discretion 明确交互项偏真机 HV，SUMMARY 自己也标「真机 HV 待执行」。

### Gaps Summary

无 BLOCKER gap。Phase 14 goal 全部 SC1-5 在实际代码层 VERIFIED：

- **SC1（核心 BUG-1）已彻底修复**：anomalyService.ts else 全新 IP 分支补 recordChange('new_ip') 被 hasBaseline 门控，写入侧根因闭合；getStats().newIp COUNT 读取侧本就对，修后反映真实新增（Test 5 = 2 佐证，修前恒零）。首次基线机制（v12 is_baseline 列 + hasBaseline 判定 + 后置 UPDATE）防首次全量扫描刷屏 + 遗留库向后兼容（Test 6 闭环 CLAUDE.md 硬约束）。
- **code review 三 BLOCKER/WARNING 全修复**：CR-01（anomalyService 三处 datetime→localNow localtime 统一，:170-174 + :189/211/216）+ CR-02（后置基线 UPDATE 移入 runBatch 事务体 :157-159，消 WR-03 无事务守卫）+ WR-01（useAIChat useRef 同步锁根治连点 :39/206-207/236）—— 三处 fix 在代码 + 测试验证，commit 链 fix(14) 系列。
- **三红线不回退**：anomalyIpc.ts 全 secure 包装 + main.ts:192/199 ai:chat/confirmCommand secure 包装不变；anomalyService 零 encField/commandSafety；ai_exec_logs device_name_enc + commandSafety + confirm_required 闸口不动。
- **FIX-02 甄别 4 项结论与实际代码逐条核对一致**：#2 ai_exec_logs（ai.ts:891-900 createLog + aiExecLogger.ts:20/44 + migrations v2）确实已满足；#3 会话标题（useAIChat.ts:141-145 在 confirm_required :156 之前）确实前提偏差已在前；#4 H3C（discovery.ts:102 + vendor-commands.ts 已删）确实作废合理。甄别非静默跳过，每项 file:line 佐证经核真实。

唯一 human_needed 项：FIX-02 #1 confirm 视觉层（按钮 loading+disabled 真机交互 + 连点时序）需真机 HV —— 这是 renderer 交互项的固有约束（无 @testing-library），源断言+核心锁+main 兜底全已 VERIFIED，仅按钮转圈/禁用真实渲染行为与连点时序待人工确认。按 Step 9 决策树（Step 8 产 1 项 human item）→ status=human_needed。

---

_Verified: 2026-08-10T00:45:00Z_
_Verifier: Claude (gsd-verifier)_
