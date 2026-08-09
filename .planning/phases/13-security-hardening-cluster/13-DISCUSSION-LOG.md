# Phase 13: Security Hardening Cluster - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-09
**Phase:** 13-Security Hardening Cluster
**Areas discussed:** SSH 算法取舍, hardening 五项范围, list 入参校验策略, 测试覆盖范围

---

## SSH 算法取舍（SEC-03 + L1 耦合）

### Q1: SEC-03 补现代算法 与 L1 删弱算法 怎么组合？

| Option | Description | Selected |
|--------|-------------|----------|
| 只补现代算法（推荐） | 补 curve25519 等现代算法让现代 Linux 能连，保留所有老算法不动。最稳，不破坏任何老设备连接，弱算法仍在。符合 CLAUDE.md 设备安全可控最高优先级 + 运维要连老设备 | ✓ |
| 补现代+删最弱几项 | 补 curve25519，同时只删最危险 2-3 项（group1-sha1 有公开攻击 / ssh-dss 现代设备早不用）。折中 | |
| 补现代+全删弱算法 | 最激进最安全，但 group14-sha1/3des-cbc 等可能仍有极老旧设备依赖 | |
| 你来定 | Claude 按项目约束给推荐 | |

**User's choice:** 只补现代算法（推荐）
**Notes:** L1 删弱算法显式 defer，理由运维兼容性优先（D-13-1）。

### Q2: connection.ts 算法表怎么与 SSH_ALGORITHMS 常量对齐？

| Option | Description | Selected |
|--------|-------------|----------|
| 复用常量消 drift（推荐） | connection.ts 删内联算法表 import SSH_ALGORITHMS。彻底消 drift（这次终端缺 curve25519 就是两份表长歪导致），以后加算法只改一处 | ✓ |
| 抄补一份（最小改动） | 内联表原地加 curve2558，不动 import 结构。改动隔离但 drift 根源未消 | |
| 你来定 | Claude 按「防漂移」设计意图给推荐 | |

**User's choice:** 复用常量消 drift（推荐）
**Notes:** D-13-2。readyTimeout 各路径保留各自语义（另见 Q3）。

### Q3: connectSSH readyTimeout(10s) 要否顺带对齐 30s？

| Option | Description | Selected |
|--------|-------------|----------|
| 顺带对齐 30s（推荐） | 既然改 connectSSH 配置块且消 drift，顺手对齐 SSH_READY_TIMEOUT_MS。治同类慢设备超时 bug，改动一行风险极低 | ✓ |
| 不动，只改 algorithms | 严守 SEC-03 SC 范围，readyTimeout 另行登记 | |
| 你来定 | Claude 判断是否该顺带改 | |

**User's choice:** 顺带对齐 30s（推荐）
**Notes:** 用户中途要求"再聊一下超时对齐"，详细解释 readyTimeout 10s vs 30s 体感（慢设备超时 vs 真不通多等 20s）+ 体检记载历史 bug 后，用户确认"已明白，保持 30s"。D-13-3。

---

## hardening 五项范围（SEC-04）

### Q1: SEC-04 剩余 4 项（L2/L3/L4/L6）本 phase 怎么收？

| Option | Description | Selected |
|--------|-------------|----------|
| 4 项全收闭环（推荐） | 全部纳入本 phase 处置（researcher 挖 finding，能改改、改不了显式 defer 理由）。SC2 完整闭环。缺点跨 4 域 plan 偏重 | ✓（Claude 推荐，用户选"你来定"） |
| 只收鉴权核心 L6+L4 | 只收与鉴权直接相关，L2/L3 defer。范围专注但 L2/L3 推后 | |
| 4 项全 defer | 全 defer 到下个 milestone，SEC-04 形同跳过 | |
| 你来定 | Claude 按安全最高优先级 + 发版后不紧急权衡给推荐 | ✓（用户先选） |

**User's choice:** 你来定 → Claude 推荐「4 项全收闭环 + researcher 甄别退路」
**Notes:** D-13-4。用户选"你来定"并说"继续"，Claude 给推荐：SC2 本就要求逐项给结论（"全收"非"全修"）+ v1.2 是安全加固 milestone SEC-04 是核心 REQ 不能全 defer + 安全是最高优先级。加甄别退路（学 Phase 14 FIX-02：已满足/伤三红线/成本远超收益 则显式 defer 登记）。

---

## list 入参校验策略（SEC-05）

### Q1: 非法入参（超长 search / 超量 tags / 非法 severity）怎么处置？

| Option | Description | Selected |
|--------|-------------|----------|
| 混合：超长钳制+枚举拒绝（推荐） | search 超长截断、tags 超量截取（静默容错）；severity 非法枚举 throw 拒绝（固定集合非法值该暴露） | ✓ |
| 全部 throw 拒绝 | 最严格，但用户粘长文本搜索会被拒体验差 | |
| 全部钳制 | 最平滑，但掩盖调用方 bug | |
| 你来定 | Claude 按「前端输入 vs API 契约」性质区别给推荐 | |

**User's choice:** 混合：超长钳制+枚举拒绝（推荐）
**Notes:** D-13-5。

### Q2: search 长度 / tags 数量上限定多严？

| Option | Description | Selected |
|--------|-------------|----------|
| 推荐默认 search≤100/tags≤20/单tag≤30（推荐） | 运维正常搜索（~15字）勾 3-5 标签完全无感，只截非日常操作。AI 检索链路正常不受影响 | ✓ |
| 更严 search≤50/tags≤10 | 更敏感，粘较长故障描述（>50字）会被截，搜索召回可能变少 | |
| 更松 search≤500/tags≤50 | 几乎不截正常输入，但前端被攻破时 DoS 防护面更宽 | |
| 你来定 | Claude 定具体数字 | |

**User's choice:** 推荐默认（推荐）
**Notes:** D-13-6。首问被用户拒绝并提反馈"选项要带场景+体验影响"，重新组织（补 SEC-05 保护的 3 个使用入口 + 每选项场景后果）后用户选推荐默认。planner 落地按项目惯例微调。

### Q3: service 层 listExperiences 兜底到什么程度？

| Option | Description | Selected |
|--------|-------------|----------|
| service 只留 limit 兜底（推荐） | IPC 层完整校验；service 层保留现有 limit MAX_BATCH 兜底防绕 IPC 查全表，severity/search/tags 不复查。接受残余风险换简洁 | ✓ |
| service 全复查（纵深最深） | service 与 IPC 完全重复校验。纵深最深但两层重复代码改阈值要改两处（可能 drift） | |
| 你来定 | Claude 定兜底范围 | |

**User's choice:** service 只留 limit 兜底（推荐）
**Notes:** D-13-7。沿用 Phase 9 confirmDrafts 双层范式但职责分层（非完全重复，避 drift）。

---

## 测试覆盖范围（跨 SEC-03/04/05）

### Q1: Phase 13 三个改动点测试投入多深？

| Option | Description | Selected |
|--------|-------------|----------|
| 每项尽量自动化（推荐） | SEC-05 mock 单测 + SEC-03 尽量扩展 12-02 真路径覆盖 connectSSH（带 UI 难度高 planner 评估）+ SEC-04 L6 authGuard 单测。最大化 CI 防回归（Phase 12 告别人工 HV 初衷） | ✓ |
| 只测纯逻辑+其余真机 HV | 只加 SEC-05 + SEC-04 L6 单测，SEC-03 全靠真机 HV。避开 connectSSH 自动化难点 | |
| 最小测试 | 仅加 SEC-05，其余发版前人工验。最快但回归防护最弱 | |
| 你来定 | Claude 定范围 | |

**User's choice:** 每项尽量自动化（推荐）
**Notes:** D-13-8。connectSSH 自动化可行性（BrowserWindow/xterm 在 Electron 测试通道限制）交 planner 评估，可能降级真机 HV。

---

## Claude's Discretion

- **SEC-04 五项范围（B1/D-13-4）**：用户选"你来定"，Claude 推荐「4 项全收闭环 + researcher 甄别退路」。
- **SEC-04 L2/L3/L4/L6 各项具体改法**：researcher 挖 28 findings 原始细节后 planner 定。
- **SEC-03 connectSSH 自动化测试方案**：planner 评估 BrowserWindow 测试可行性。
- **severity 合法枚举值集合**：沿用 src/types/experience.ts ExperienceSeverity 类型。
- **D-13-6 阈值微调**：planner 按项目惯例对齐其他 list 通道。

## Deferred Ideas

- **L1 删弱算法**（group1-sha1/group14-sha1/3des-cbc/blowfish-cbc/ssh-dss 等）— 运维兼容性优先，有连不上老设备风险；SEC-04 甄别环节显式登记 defer 理由。未来设备清单确认无老算法依赖可重评估。
- **SEC-04 五项中经甄别判定「已满足/伤三红线/成本远超收益」的子项** — 各自显式 defer 登记。
- **pre-release 非安全 hardening 项**（M6/M7/L7/L10/L15/L16）— 技术债 milestone。
