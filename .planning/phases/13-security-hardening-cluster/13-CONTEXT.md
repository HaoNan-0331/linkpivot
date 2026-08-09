---
phase: 13
name: Security Hardening Cluster
milestone: v1.2
gathered: 2026-08-09
status: Ready for research+planning
---

# Phase 13 CONTEXT: Security Hardening Cluster

<domain>

## Task Boundary

收紧三条安全面，**加固不重写、三红线（IPC secure/safe 鉴权 / 字段加密 _enc / commandSafety.isCommandAllowed）不可回退**：

1. **SEC-03**：设备终端连接（`connection.ts` `connectSSH`）补现代 SSH 算法（curve25519 等），与 `sshConfig.ts` `SSH_ALGORITHMS` 对齐——修体检 §1.0 半残留（ai.ts/arpCollector 已走 SSH_ALGORITHMS，终端连接内联配置仍缺 curve25519，现代 Linux 连不上）
2. **SEC-04**：pre-release 5 项安全 hardening 收尾（L1 弱 SSH 算法 / L2 ai limit / L3 captcha / L4 Login / L6 authGuard，p9e `260726-p9e` 显式排除的发版后项），SC2 要求每项要么修要么显式 defer 并登记
3. **SEC-05**：`experience:list` IPC 入参校验防廉价 DoS（severity 枚举 + search 长度 + tags 数量上限，体检 WR-06）

**REQ:** SEC-03, SEC-04, SEC-05
**Domain 性质：** 安全加固，不加业务功能、不削弱既有鉴权。

</domain>

<decisions>

## Implementation Decisions（锁定约束，downstream 必须遵守）

### SEC-03：SSH 算法策略

- **D-13-1：只补现代算法，不删弱算法。** 补 curve25519-sha256 等现代算法（让现代 Linux 能连），保留所有老算法不动。L1（删 group1-sha1/group14-sha1/3des-cbc/blowfish-cbc/ssh-dss 等弱算法）**显式 defer**——理由：运维兼容性优先（CLAUDE.md「设备安全可控是最高优先级」+ `sshConfig.ts` 注释「宁可列宽不可漏连各种厂商/老型号设备」），删弱算法有连不上老设备风险。
- **D-13-2：connection.ts 复用 SSH_ALGORITHMS 常量消 drift。** `connectSSH` 删除内联 algorithms 表（`connection.ts:115-150`），改为 `import { SSH_ALGORITHMS } from '../utils/sshConfig'`。彻底消除两份表 drift 根源（这次终端缺 curve25519 正是 drift 导致）。`readyTimeout` 各路径语义不同，复用 algorithms 不强制复用 timeout（见 D-13-3 另决策）。
- **D-13-3：connectSSH readyTimeout 10s → 对齐 SSH_READY_TIMEOUT_MS(30s)。** 顺带治同类慢设备超时 drift（体检 `sshConfig.ts` 注释记载的历史 bug：AI 路径 10s / 自动发现 30s 不一致致慢设备超时；终端连接仍停 10s 是同 drift 未治完）。改动一行，风险极低（只会让慢设备更易连上）。

### SEC-04：hardening 五项范围

- **D-13-4：5 项全收闭环 + researcher 甄别退路。** L1 经 D-13-1 决策 defer（兼容性）。剩余 **L2 ai limit / L3 captcha / L4 Login / L6 authGuard 全部纳入本 phase 处置**（SC2 要求每项要么修要么显式 defer 登记，"全收"= 逐项给结论非"全修"）。researcher 先挖每项原始 finding（p9e 排除的 28 findings 中对应项 + `.planning/audits/2026-07-26-doc-code-audit.md`），planner 据此定改法；若甄别判定「已满足 / 改动伤三红线 / 成本远超收益」则**该项显式 defer 并登记理由**（学 Phase 14 FIX-02 甄别模式——不照单全收，也不静默跳过）。plan 偏重交 planner 拆多 plan。

### SEC-05：list 入参校验策略

- **D-13-5：处置混合策略。** 超长 `search` / 超量 `tags` **钳制**（截断/截取，用户输入场景静默容错）；非法 `severity` 枚举 **throw 拒绝**（固定集合，非法值说明调用方 bug 该暴露）。校验加在 IPC 网关层（`experienceIpc.ts`），SC4 + Risk 红线双层防御不可回退。
- **D-13-6：阈值采用推荐默认。** `search ≤ 100 字符` / `tags ≤ 20 个` / `单 tag ≤ 30 字符`（运维正常搜索如「华为交换机 DHCP 中继配置」~15 字、勾 3-5 标签筛完全无感；只截「粘整段故障描述」「勾 20+ 标签」非日常操作）。planner 落地按项目惯例微调（对齐其他 list 通道如 getIPDetails/oui:getAll/anomaly:getChanges 的 cap 风格）。
- **D-13-7：双层防御职责分明。** IPC 网关层（`experienceIpc.ts`）做完整入参校验（severity/search/tags/limit）；service 层 `listExperiences` **只保留现有 `limit` MAX_BATCH 兜底**（防"绕 IPC 直调 service 查全表"），severity/search/tags 不复查——接受残余风险换 service 层简洁、不改现有函数签名。沿用 Phase 9 `confirmDrafts` MAX_BATCH 双层范式但职责分层（非完全重复校验，避两层 drift）。

### 测试覆盖

- **D-13-8：每项尽量自动化（借 Phase 12 回归网）。** SEC-05 加 mock 单测（沿用 `_setExperienceDbGetter` 范式，传超长 search/超量 tags/非法 severity 验证截断/throw）；SEC-03 尽量扩展 Phase 12 `test:electron` 真路径套件覆盖 `connectSSH` 算法协商（**带 BrowserWindow/xterm，planner 评估自动化可行性，可能部分降级真机 HV**）；SEC-04 L6 authGuard 加单测（secure/safe 未登录拒绝）。

### Claude's Discretion

- SEC-04 五项中 L2/L3/L4/L6 各项具体改法 —— researcher 挖 28 findings 原始细节后 planner 定（用户授权"你来定"+ 甄别退路 D-13-4）
- SEC-03 `connectSSH` 自动化测试可行方案 —— planner 评估（BrowserWindow 在 Electron 测试通道的限制，可能降级真机 HV 连现代 Linux + 老设备各一台）
- `severity` 合法枚举值集合 —— 沿用 `src/types/experience.ts` `ExperienceSeverity` 类型，planner 核对
- D-13-6 阈值微调 —— planner 按项目惯例对齐其他 list 通道

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 规划与需求（红线约束来源）
- `.planning/ROADMAP.md` — Phase 13（SC1-4 + Risk/红线段：SSH algorithms 补集不替换 / hardening 不削弱 secure-safe 鉴权 / experience:list 双层防御）
- `.planning/REQUIREMENTS.md` — SEC-03 / SEC-04 / SEC-05

### 审计来源（SEC-04 关键，researcher 必读）
- `.planning/audits/2026-08-07-health-audit.md` — §1.0 SSH curve25519 半残留 + §1.2 WR-06 experience:list + §1.2 pre-release 14 项安全相关
- `.planning/quick/260726-p9e-pre-release-hardening-bump-0-1-2/260726-p9e-SUMMARY.md` — §发版后迭代 line 142（L1/L2/L3/L4/L6 排除项清单 + 已修的 H1/M1~M5/L5/L11/L13/L14）
- `.planning/audits/2026-07-26-doc-code-audit.md` — pre-release 原始 28 findings（researcher 挖 L1/L2/L3/L4/L6 具体改法细节来源）

### 依赖前置 phase（测试网）
- `.planning/phases/12-test-infrastructure-dep-1-abi/12-CONTEXT.md` — 测试网现状（electron.exe + ELECTRON_RUN_AS_NODE 真路径 + `_setExperienceDbGetter` mock 范式 + handleLeakDetector + test:electron 22 用例覆盖范围）

### 代码现状（scout 已验，行号锚点）
- `electron/services/connection.ts` — `connectSSH:107` 内联 `algorithms:115-150`（kex 缺 curve25519，cipher 缺 gcm 短名，serverHostKey 顺序异于 SSH_ALGORITHMS）+ `readyTimeout:114`(10s)
- `electron/utils/sshConfig.ts` — `SSH_ALGORITHMS:11`（ai.ts:312/arpCollector.ts:68 已用，kex 首项 curve25519）+ `SSH_READY_TIMEOUT_MS:7`(30s)
- `electron/services/experienceService.ts` — `listExperiences:258`（已有 `limit` MAX_BATCH 守卫 + search 参数化 LIKE 转义 + 多词拆分，**缺** severity 枚举/search 长度/tags 数量上限）+ `ListExperiencesOpts:125`
- `electron/ipc/experienceIpc.ts` — `experience:list` handler（SEC-05 校验加入点，researcher 确认现有校验）
- `electron/utils/authGuard.ts` — `secure`/`safe` 包装（SEC-04 L6 加固对象，三红线之一不可削弱）
- `src/types/experience.ts` — `ExperienceSeverity` 类型（D-13-5 severity throw 判据来源）

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets
- **`SSH_ALGORITHMS` 常量**（`sshConfig.ts:11`）+ **`SSH_READY_TIMEOUT_MS`**（`sshConfig.ts:7`）— SEC-03 `connection.ts` 直接复用，消 drift（D-13-2/D-13-3）
- **`_setExperienceDbGetter` mock DB 注入钩子**（experienceService 测试范式）— SEC-05 mock 单测接入点
- **Phase 12 `test:electron` 真路径套件**（`ssh2.Server`/`net.Server` mock 对端回显）— SEC-03 `connectSSH` 测试可参考；但 `connectSSH` 带 BrowserWindow/xterm，planner 评估能否复用（D-13-8）
- **`handleLeakDetector`**（Phase 12 句柄泄漏检测）— 若 `connectSSH` 测试涉及句柄可借

### Established Patterns
- **双层防御范式**（Phase 9 `confirmDrafts` MAX_BATCH：IPC 网关层 + service 层）— SEC-05 沿用，职责分明（D-13-7）
- **IPC `secure`/`safe` 鉴权包装**（authGuard，三红线之一）— SEC-04 L6 加固不可削弱
- **字段加密 `_enc` + `encField`/`decField`**（三红线之一）— 本 phase 不动但不可回退
- **`commandSafety.isCommandAllowed`**（三红线之一，AI 命令执行层）— SEC-04 L2 ai limit 若涉 AI 执行链不可绕过此层
- **list 通道 hybrid 分页契约**（Phase 4 DATA-01：getIPDetails/oui:getAll/anomaly:getChanges cap + limit/offset + 截断信封）— D-13-6 阈值风格对齐参照

### Integration Points
- `connection.ts` `connectSSH:107` — SEC-03 改 `algorithms` 复用 `SSH_ALGORITHMS` + `readyTimeout` 复用 `SSH_READY_TIMEOUT_MS`
- `experienceIpc.ts` `experience:list` handler — SEC-05 IPC 层校验加入点（service 层 `listExperiences` 兜底 `limit` 保留不删）
- `authGuard.ts` `secure`/`safe` — SEC-04 L6 加固对象
- `src/types/experience.ts` `ExperienceSeverity` — severity 合法枚举来源

</code_context>

<specifics>

## Specific Ideas

- 用户明确：SSH 算法「宁可列宽不可漏连老设备」（与 `sshConfig.ts` 注释设计意图一致）—— L1 删弱算法 defer 的核心理由
- 用户明确：阈值（search≤100/tags≤20）按「运维正常搜索/筛选无感」定，不为极端长输入留余量；粘整段故障描述被截断可接受
- 用户沟通偏好（非 phase 决策，但 researcher/planner 若向用户确认应遵循）：选项须通俗解释英文术语 + 带使用场景与体验影响

</specifics>

<deferred>

## Deferred Ideas

- **L1 删弱算法**（group1-sha1/group14-sha1/3des-cbc/blowfish-cbc/ssh-dss 等）— 运维兼容性优先，删了有连不上老设备风险；SEC-04 甄别环节显式登记 defer 理由（D-13-1）。未来若设备清单确认无老算法依赖可重评估
- **SEC-04 五项中经 researcher 甄别判定「已满足/伤三红线/成本远超收益」的子项** — 各自显式 defer 登记（D-13-4 甄别退路）
- **pre-release 非安全 hardening 项**（M6/M7 渲染层 any / L7 db any / L10 复杂度 / L15 xterm / L16 ssh2 license）— 技术债 milestone（REQUIREMENTS.md Future 已登记）

</deferred>

---
*Phase: 13-Security Hardening Cluster*
*Context gathered: 2026-08-09*
