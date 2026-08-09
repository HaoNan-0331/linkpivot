# Phase 14: Defect & Legacy Rollback Closure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-09
**Phase:** 14-Defect & Legacy Rollback Closure
**Areas discussed:** BUG-1 new_ip 修复路径, 旧规划 3 项甄别授权, H3C LLDP 重评估深度, 测试覆盖标准

---

## BUG-1 new_ip 修复路径

| Option | Description | Selected |
|--------|-------------|----------|
| 修写入侧 + 首次基线 | `processARPEntries` 全新 IP 写 `new_ip`，首次全量扫描只建 binding 不报（建基线），基线后新增 IP 才报。运维真正看到新设备入网，不被首次刷屏 | ✓ |
| 修写入侧 不设基线 | 全新 IP 一律写 `new_ip`，首次扫描全量报（运维 acknowledgeAll 清一次）。实现最简但首次体验差 | |
| 移除恒零字段 | `getStats`/`AnomalyTab`/`exportService` 三处删 `newIp`，承认能力从未实现。消除误导但损失告警能力 | |

**User's choice:** 修写入侧 + 首次基线
**Notes:** 用户先问"这个监控面板是什么功能/为什么没用过/在哪里"。codegraph+grep 查清面板入口（`IpManagementPage.tsx:17` 异常检测 Tab，侧边栏「IP 管理」→ 第 3 个 Tab）。用户确认**用过异常检测面板**，BUG-1 修复有真实消费方价值（面板统计 + 导出 CSV），故选修而非移除。根因已定位：`anomalyService.ts:104-111` `entryTx` 全新 IP 分支（`currentBinding` 与 `oldBinding` 都不存在）只 `createBinding` 漏 `recordChange('new_ip')`，`getStats:186` 读取侧正确。

---

## 旧规划 3 项甄别授权

| Option | Description | Selected |
|--------|-------------|----------|
| researcher 全权甄别 | 每项 grep+代码核对判定「已满足→作废 / 需修→修」，结论写 SUMMARY+DEFER-LOG，中途不问用户（类 SEC-04 D-13-4） | ✓ |
| 先报现状 我逐条拍板 | researcher 先 grep 出每项代码现状报告，用户看后逐条决定。多轮交互 | |
| 我已知状态 补充告知 | 用户直接告知哪项已满足/需修，researcher 验证后落结论 | |

**User's choice:** researcher 全权甄别
**Notes:** 3 项 = confirm 防重复点击 / `ai_exec_logs` 完整记录 / 会话标题 early-return。用户不记得这几项历史状态，信任 researcher 代码核对结论，授权全权甄别（沿用 SEC-04 D-13-4 模式）。结论必写 DEFER-LOG，不可静默跳过。

---

## H3C LLDP 重评估深度

| Option | Description | Selected |
|--------|-------------|----------|
| 本 phase 实现（若需） | researcher 甄别 H3C edges 现状 + 正确命令，空→本 phase 实现，非空→作废 | ✓（初选） |
| 仅甄别 实现defer下期 | researcher 只查现状给结论，需新实现则登记 defer 下期，本 phase 不写 H3C 代码 | |

**User's choice:** 初选「本 phase 实现（若需）」→ **澄清后改为：作废**
**Notes:** 用户问"14-3 是什么情况"。codegraph+git+grep 查清来龙去脉：旧 `vendor-commands.ts`（硬编码厂商命令表 `getDiscoveryCommands`，华为/H3C/Cisco 各自的 LLDP 邻居命令）已于 2026-08-07（commit `0bd4dbd`）当死代码删除（3 export 零调用，v1.0 `discovery.ts` 重写 dropped the dep）。删除后 H3C LLDP 能力**没丢**——`discovery.ts:101-104` prompt 内联了 H3C 的 `display lldp neighbor-information list` 等命令，`:275` AI 据 LLDP/CDP 邻居推断连接关系，换成了 AI 驱动路径（commit `53447da`）。**用户明确：H3C 真机已跑过拓扑自动发现，当前版本没问题（edges 非空）**。故 D-14-3 直接作废，DEFER-LOG 登记"用户真机验证 + discovery.ts 已覆盖"，无需 researcher 甄别/本 phase 写代码。

---

## 测试覆盖标准

| Option | Description | Selected |
|--------|-------------|----------|
| 借回归网最大化自动化 | BUG-1 用 `_setExperienceDbGetter` mock 单测（全新 IP→验 new_ip 写入 + 首次基线不报）；旧规划项修则按性质补测 | ✓ |
| 最小覆盖 | 只 BUG-1 必测，旧规划项按需补测，confirm/H3C 偏真机 HV defer | |
| 交 Claude 裁量 | researcher/planner 按改动性质定测试方式，不预设统一标准 | |

**User's choice:** 借回归网最大化自动化
**Notes:** 沿用 Phase 13 D-13-8 范式。BUG-1 是核心 fix 必测（mock 单测验全新 IP→new_ip 写入 + 首次基线不报）；旧规划 3 项甄别后若需修按改动性质补测（confirm renderer 交互/ai_exec_logs service mock/会话标题 ai.ts 单元）；H3C 作废不占测试。

---

## Claude's Discretion

- BUG-1 首次基线机制具体形态（`ip_mac_bindings` 首次标志位 / 独立 `anomaly_baseline` 表 / `system_configs` 键值）— researcher 评估三方案选定最简且向后兼容，planner 落地
- 旧规划 3 项甄别后具体改法 — researcher 甄别挖现状后 planner 定（D-14-2 全权授权）
- 测试具体方式 — researcher/planner 按改动性质定（核心 fix mock 单测 / 交互真机 HV defer / 现状核对 grep 断言）
- `getStats` 读取侧不动（它本来就正确，只改写入侧）

## Deferred Ideas

- H3C LLDP 实现 — 作废（用户真机已验证 discovery.ts AI 驱动对 H3C 正常）
- BUG-1 手动重置基线（用户主动重标记当前为正常态的 UI 入口）— 首次基线落地后若运维有需求，下期加
- 旧规划 3 项甄别后判定"需修但改动大"的子项 — 各自显式 defer 登记（D-14-2 甄别退路），下期立项
- pre-release 非安全 hardening 项 + 渲染层 any 清理（M6/M7/L7/L10/L15/L16）— 技术债 milestone，非本 phase
