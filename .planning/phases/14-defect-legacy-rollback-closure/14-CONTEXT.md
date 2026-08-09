---
phase: 14
name: Defect & Legacy Rollback Closure
milestone: v1.2
gathered: 2026-08-09
status: Ready for research+planning
---

# Phase 14 CONTEXT: Defect & Legacy Rollback Closure

<domain>

## Task Boundary

修 BUG-1（anomaly `new_ip` 计数恒零）+ 甄别旧规划回退项给明确结论（修或显式作废登记），**不加新功能、三红线（IPC `secure`/`safe` 鉴权 / 字段加密 `_enc` / `commandSafety.isCommandAllowed`）不可回退**：

1. **FIX-01 / BUG-1**：`anomalyService.processARPEntries` 全新 IP 漏写 `new_ip` 告警 → `getStats.newIp` 恒零（异常检测面板「新 IP」数字 + 导出 CSV 恒为 0）。**修写入侧 + 首次扫描建基线**（D-14-1）。
2. **FIX-02 / 旧规划回退项甄别**：3 项（confirm 防重复点击 / `ai_exec_logs` 完整记录 / 会话标题 early-return）researcher 全权甄别，每项 grep+代码核对判定「已满足→作废登记 / 需修→修」（D-14-2，沿用 SEC-04 D-13-4 甄别退路模式）。
3. **H3C LLDP 邻居发现**：**作废**——用户真机已验证当前版本（`discovery.ts` AI 驱动拓扑自动发现）对 H3C 正常工作、拓扑 edges 非空；旧 `vendor-commands.ts` 硬编码方向已正确删除（死代码）。无需甄别/实现（D-14-3）。

**REQ:** FIX-01, FIX-02
**Domain 性质：** 缺陷修复 + 历史规划项甄别收尾，不加业务功能、不削弱既有鉴权/加密/命令安全层。

**用户已确认的产品事实**：
- 异常检测面板用户**在用**（IP 管理 → 「异常检测」Tab，`IpManagementPage.tsx:17`），BUG-1 修复有真实消费方价值（面板统计 + 导出 CSV）
- H3C 拓扑自动发现用户**真机已验证**当前版本正常（edges 非空），H3C LLDP 项直接作废

</domain>

<decisions>

## Implementation Decisions（锁定约束，downstream 必须遵守）

### BUG-1 new_ip 修复（FIX-01）

- **D-14-1：修写入侧 + 首次扫描建基线。** `processARPEntries`（`anomalyService.ts:89-112` 的 `entryTx`）全新 IP 分支（`currentBinding` 与 `oldBinding` 都不存在 = 既无 active binding 也无历史 binding）当前只 `createBinding` 不 `recordChange`——补 `recordChange(ip, null, mac, 'new_ip')`。**首次全量扫描建基线**（首次扫描时库里无数据，所有 IP 都算"新"，会触发告警刷屏）：首次扫描只建 binding 不报 `new_ip`，基线建立后新增 IP 才报。基线机制具体形态（`ip_mac_bindings` 首次扫描标志位 / 独立 anomaly 基线表 / `system_configs` 键值）交 researcher+planner 评估选定（见 Claude's Discretion）。改 `getStats`（line 186 `newIp` COUNT）读取侧不动——它本来就对，只是写入侧漏了。
- **红线**：`processARPEntries` 改动属异常检测写入链，**不碰 IPC 鉴权**（`anomaly:getChanges`/`getStats`/`acknowledgeAll` 仍 secure 包装）、**不碰字段加密**（`ip_mac_changes` 表无 `_enc` 列）、**不碰 commandSafety**（异常检测非 AI 命令执行路径）。三红线改动后仍生效。

### 旧规划 3 项甄别（FIX-02，researcher 全权）

- **D-14-2：researcher 全权甄别，结论写 SUMMARY + 14-02-DEFER-LOG.md（学 SEC-04 D-13-4 模式），中途不问用户。** 三项逐条 grep+代码核对，每项给「FIXED（已满足）/ DEFER（作废登记 reason）/ FIX（需修补）」结论 + file:line 佐证：
  1. **confirm 防重复点击**：`CommandConfirmModal`（`src/components/pages/ai/CommandConfirmModal.tsx`）确认按钮是否有 loading/disabled 防连点保护，`onConfirm` 触发后是否锁住防重复 IPC 调用。判定：已满足→登记作废；未满足→修（按钮 disabled + in-flight 锁）。
  2. **`ai_exec_logs` 完整记录**：AI 命令执行链路（`ai.ts`）落库 `ai_exec_logs` 表是否记全 `prompt_text` + `ai_response`（非只记执行命令）。判定：记全→作废；漏字段→补 schema + 写入。
  3. **会话标题更新 early-return**：`ai.ts` 会话标题更新逻辑是否在 `confirm_required` early return 之前执行（需确认的会话标题不被 early return 跳过）。判定：已在前→作废；被跳过→调整执行顺序。
- **红线**：`ai.ts` 改动属 AI 命令执行链，**不可破坏 `commandSafety.isCommandAllowed` 安全层 + `confirm_required` 二次确认闸口**。甄别/修补只动记录与标题更新逻辑，不动命令安全校验。

### H3C LLDP 邻居发现（作废）

- **D-14-3：作废——用户真机已验证。** 当前版本 `discovery.ts` AI 驱动拓扑自动发现（commit `53447da`，SSH 采集 + AI 分析连接关系，prompt 内联华为/H3C/Cisco 的 LLDP 邻居命令，`discovery.ts:101-104` + `:275`）对 H3C 设备**真机验证正常、拓扑 edges 非空**。旧 `vendor-commands.ts`（硬编码厂商命令表 `getDiscoveryCommands`，3 个 export 零调用）已于 2026-08-07（commit `0bd4dbd`）当死代码正确删除。体检 §1.0 标的"方向过时"指旧 vendor-commands 硬编码方向，该方向已废弃且新路径已覆盖。**无需 researcher 甄别、无需本 phase 写 H3C 代码**，DEFER-LOG 直接登记作废（佐证：用户真机验证 + `discovery.ts:101-275` 已含 H3C LLDP 命令）。

### 测试覆盖

- **D-14-4：借 Phase 12 回归网最大化自动化（沿用 D-13-8）。** BUG-1 用 `_setExperienceDbGetter` mock DB 注入范式写 mock 单测（`processARPEntries` 喂全新 IP → 验 `ip_mac_changes` 写入 `change_type='new_ip'` + 首次扫描基线不报）；旧规划项甄别后若判定需修，按改动性质补测（confirm 防重复偏 renderer 交互单测/真机 HV；`ai_exec_logs` 偏 service mock 单测；会话标题偏 ai.ts 单元）。三绿门禁（tsc web strict + build:electron-main + vitest）全绿零回归。

### Claude's Discretion

- **BUG-1 首次基线机制具体形态** —— researcher 评估三方案（`ip_mac_bindings` 加首次扫描标志位 / 独立 `anomaly_baseline` 表记录基线建立的 IP 集合 / `system_configs` 键值存"已建基线"标志 + 首次扫描跳过 new_ip）选定最简且向后兼容的，planner 落地。基线语义：首次全量扫描只建 binding 不报 new_ip，之后新增 IP 才报。
- **旧规划 3 项具体改法** —— researcher 甄别挖出每项代码现状后 planner 定（用户授权 D-14-2 全权甄别）。
- **测试具体方式** —— researcher/planner 按改动性质定（核心 fix mock 单测 / 交互真机 HV defer / 现状核对 grep 断言）。
- **`getStats` 读取侧不动** —— 它本来就正确查 `change_type='new_ip'`，只是写入侧漏写；不重构读取侧。

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 规划与需求（红线约束来源）
- `.planning/ROADMAP.md` — Phase 14（SC1-5 + Risk/红线段：ai_exec_logs/会话标题改 ai.ts 不破坏 commandSafety+confirm_required / H3C 不复活 vendor-commands / anomaly new_ip 若移除字段三处消费方同步 / 旧规划项作废必须显式登记）
- `.planning/REQUIREMENTS.md` — FIX-01 / FIX-02

### 审计来源（BUG-1 + 旧规划项 + H3C 甄别佐证，researcher 必读）
- `.planning/audits/2026-08-07-health-audit.md` — §1.0 BUG-1 anomaly new_ip 恒零 + 旧规划 4 项待甄别（confirm/ai_exec_logs/会话标题/H3C LLDP）+ §2.1 vendor-commands.ts 死代码（H3C 作废佐证）
- `.planning/quick/260807-fzd-dead-code-types-uuid-vendor-commands-ts-/` (commit `0bd4dbd`) — vendor-commands.ts 删除证据（3 export 零调用 + CHANGELOG:239 记录 v1.0 discovery.ts 重写 dropped the dep）

### 依赖前置 phase（甄别模式 + 测试网）
- `.planning/phases/13-security-hardening-cluster/13-CONTEXT.md` — D-13-4 甄别退路模式（FIX-02 旧规划项沿用）+ D-13-8 测试借回归网范式 + 测试网现状
- `.planning/phases/13-security-hardening-cluster/13-02-DEFER-LOG.md` — SEC-04 五项甄别登记范例（FIX-02 DEFER-LOG 写法参照）

### 代码现状（scout 已验，行号锚点）
- `electron/services/anomalyService.ts` — `processARPEntries:89-112`（`entryTx` 全新 IP 分支 line 104-111 漏 `recordChange('new_ip')` 是 BUG-1 根因）+ `recordChange:139-146`（写入 helper）+ `getStats:180-189`（line 186 `newIp` COUNT 读取侧正确）+ `createBinding:131-137`
- `electron/services/ai.ts` — confirm 防重复 / `ai_exec_logs` 落库 / 会话标题更新 / `confirm_required` early return（FIX-02 三项甄别锚点，researcher grep 定位）
- `src/components/pages/ai/CommandConfirmModal.tsx` — confirm 弹窗（防重复点击甄别点，`onConfirm`/`pendingConfirm` props）
- `electron/services/discovery.ts` — `:101-104`（prompt 内联华为/H3C/Cisco LLDP 邻居命令）+ `:275`（AI 据 LLDP/CDP 邻居推断连接关系）= H3C LLDP 已覆盖佐证（D-14-3 作废依据）
- `src/components/pages/IpManagementPage.tsx:17` — 异常检测 Tab 入口（BUG-1 面板消费方，`AnomalyTab`）
- `src/components/ip-management/AnomalyTab.tsx` — 异常检测面板（`getStats`/`getChanges`/`acknowledgeAll` 消费方，BUG-1 可见性）

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets
- **`_setExperienceDbGetter` mock DB 注入范式**（experienceService 测试，Phase 7）— BUG-1 `processARPEntries` mock 单测接入点（注入内存 mock DB 验全新 IP 写入 `new_ip`，规避 DEP-1 native binding ABI 冲突）
- **Phase 12 `test:electron` 真路径套件** + **`handleLeakDetector`** — 若 BUG-1/旧规划项测试涉及句柄/真路径可借
- **`recordChange(ip, oldMac, newMac, changeType)` 写入 helper**（`anomalyService.ts:139`）— BUG-1 修只需在全新 IP 分支调 `recordChange(ip, null, mac, 'new_ip')`，复用现有 helper，零新代码路径

### Established Patterns
- **甄别退路模式**（Phase 13 D-13-4 / SEC-04 DEFER-LOG）— FIX-02 旧规划 3 项 + H3C 直接复用：每项 grep+代码核对给 FIXED/DEFER/FIX 结论 + file:line 佐证 + reason，不照单全修不静默跳过
- **静态类 service facade**（`AnomalyService` 全 static 方法 + `getDatabase()` 单例，CONVENTIONS）— BUG-1 改 `processARPEntries` 沿用，不引入实例状态（基线标志若挂类用 `private static`）
- **整批单事务 + 条目级 SAVEPOINT**（`processARPEntries:114-126` `runBatch` + `entryTx`）— BUG-1 加 `recordChange('new_ip')` 落在 `entryTx` 内，自动复用现有事务边界（条目级失败 ROLLBACK TO savepoint 不影响整批）
- **三红线**（IPC `secure`/`safe` + `_enc` 字段加密 + `commandSafety.isCommandAllowed`）— 本 phase 不动但不可回退
- **首次基线/初始化幂等**（迁移用 `hasColumn`/`sqlite_master` 特征串守卫，不靠 `user_version`）— BUG-1 基线机制若加表/列沿用幂等守卫

### Integration Points
- `anomalyService.ts:104-111` `entryTx` 全新 IP else 分支 — BUG-1 `recordChange('new_ip')` 加入点（+ 首次基线判定，基线建立前跳过 new_ip）
- `ai.ts` AI 命令执行链（confirm / `ai_exec_logs` insert / 会话标题 update / `confirm_required` early return）— FIX-02 三项甄别点，researcher grep 定位
- `discovery.ts:101-275` — H3C LLDP 已覆盖佐证（D-14-3 作废，无需改）

</code_context>

<specifics>

## Specific Ideas

- 用户明确：异常检测面板**在用**（IP 管理 → 异常检测 Tab），BUG-1 修有真实价值（面板统计 + 导出 CSV 都受影响），不是修一个没人看的面板
- 用户明确：H3C 拓扑自动发现**真机已验证**当前版本正常（edges 非空），H3C LLDP 项作废——researcher 不需甄别，DEFER-LOG 直接登记"用户真机验证 + discovery.ts 已覆盖"
- 用户明确：BUG-1 修写入侧 + 首次基线（不选"移除恒零字段"也不选"不设基线全报"）—— 要让 new_ip 真正工作但首次扫描不刷屏
- 用户沟通偏好（非 phase 决策，沿 Phase 13）：选项须通俗解释英文术语（LLDP/ai_exec_logs/new_ip 等）+ 带使用场景与体验影响，不只抛数字/抽象利弊

</specifics>

<deferred>

## Deferred Ideas

- **H3C LLDP 邻居发现实现** — 作废（用户真机已验证 `discovery.ts` AI 驱动对 H3C 正常）。未来若 AI 驱动发现对某 H3C 型号失效可重评估加显式 LLDP 命令解析
- **BUG-1 手动重置基线**（用户主动"重新标记当前为正常态"按钮，重新建基线）— 首次基线机制落地后若运维有此需求，下期可加 UI 入口
- **旧规划 3 项甄别后判定"需修但改动大"的子项** — 各自显式 defer 登记（D-14-2 甄别退路），下期立项
- **pre-release 非安全 hardening 项 + 渲染层 any 清理**（M6/M7/L7/L10/L15/L16）— 技术债 milestone（REQUIREMENTS.md Future 已登记，非本 phase）

</deferred>

---
*Phase: 14-Defect & Legacy Rollback Closure*
*Context gathered: 2026-08-09*
