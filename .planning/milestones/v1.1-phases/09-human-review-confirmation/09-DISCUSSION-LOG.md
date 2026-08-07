# Phase 9: Human Review & Confirmation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-03
**Phase:** 9-Human Review & Confirmation
**Areas discussed:** 确认态+旧条目命运, 确认弹窗 UI 形态, 原始会话溯源回链, 丢弃处理+质量门暂存

---

## 灰区 1：确认态语义 + UPDATE 旧条目命运

### Q1 — draft 确认后落到哪个态？

| Option | Description | Selected |
|--------|-------------|----------|
| 确认即 published | draft→published 直接转，confirmed 态不用(预留)；新增 confirmExperience 受控接口(不动 CR-01 update 白名单) | ✓ |
| 转 confirmed | draft→confirmed，published 预埋未来「团队共享」语义暂不用；Phase 11 检索命中 confirmed | |
| 两态分离+发布 | 确认=confirmed(已审)，再单独「发布」才 published(对 AI 可见)；多一步操作 | |

**User's choice:** 确认即 published
**Notes:** 解决 ROADMAP Goal「published」vs SC4「confirmed」矛盾——SC4「confirmed」按口语化「已确认」理解，实际落 published。红线③原文「人工确认才 published」语义最强。

### Q2 — UPDATE 草稿确认后旧条目命运？

| Option | Description | Selected |
|--------|-------------|----------|
| 逐条显式拍板 | 弹窗展示命中旧条目标题 + ☐标失效/☐保留，默认不勾(防 AI 误判误删)，主动勾才 supersede | ✓ |
| 默认 supersede | UPDATE 确认即自动标旧条目 invalid；最防重复但 AI 误判 UPDATE(实为 ADD)时误失效有效旧条目 | |
| 保留并存 | 新条目入库，旧条目完全不动，duplicate_of_exp_id 仅作关联；清理交 Phase 10 | |

**User's choice:** 逐条显式拍板
**Notes:** Phase 8 D-03 把旧条目命运留 Phase 9 拍板。命中 id 是 AI judgeVerdicts 判定（无硬阈值）有误判风险，默认不勾防误删。符合红线③「全自动矛盾判定 YAGNI 不做」。

---

## 灰区 2：确认弹窗 UI 形态与逐条编辑交互

### Q1 — 弹窗形态+布局？

| Option | Description | Selected |
|--------|-------------|----------|
| 宽Modal+master-detail | 复用项目 Modal 惯例，宽 Modal(~80vw) 左列表(勾选+标注)+右编辑表单 | ✓ |
| Drawer+master-detail | 右侧抽屉横向空间足，但项目无 Drawer 先例，引入新模式 | |
| Modal+手风琴/翻页 | 逐条折叠或单条翻页，聚焦但草稿多时繁琐、无法纵览 | |

**User's choice:** 宽 Modal+master-detail
**Notes:** codegraph/grep 核实项目组件命名全是 Modal（AddDeviceModal/EditNodeModal/ConnectionModal/CommandConfirmModal），无 Drawer 先例。按「代码读起来像周围代码」复用 Modal。

### Q2 — 确认提交粒度？

| Option | Description | Selected |
|--------|-------------|----------|
| 批量一次性提交 | 底部「采纳 N + 丢弃 M」单事务原子 + 全选快捷；IPC 批量 confirm+discard | ✓ |
| 逐条即时确认 | 每条编辑完立即落库，可中途离开；IPC 频繁、无原子性 | |
| 混合 | 批量勾选提交 + 单条即时确认两套路径 | |

**User's choice:** 批量一次性提交
**Notes:** 符合 master-detail 纵览后统一决策 + D-9-2 逐条拍板后批量生效。IPC 批量 + db.transaction 单事务原子。

---

## 灰区 3：原始会话溯源回链（REVIEW-03 / SC3）

### Q1 — 点「查看原始会话」后交互形态？

| Option | Description | Selected |
|--------|-------------|----------|
| 只读模态叠层 | 确认弹窗内叠只读子 Modal 展示会话原文(滚动)，不离开上下文；新增 secure IPC 取明文 | ✓ |
| 跳转AI对话窗 | 关闭确认弹窗切 AIPage 定位 session；打断确认流程、体验割裂 | |
| 两者都支持 | 默认只读叠层 + 「在对话窗打开」链接；两套路径 | |

**User's choice:** 只读模态叠层
**Notes:** design D-04 定回链展示明文（用户核对自己对话，单机 safeStorage 绑机器，不做 PII 脱敏）。getChatHistory 现为 service 函数未暴露 IPC，需新增 secure IPC。

---

## 灰区 4：丢弃处理 + 质量门暂存

### Q1 — 丢弃的 draft 怎么处理？

| Option | Description | Selected |
|--------|-------------|----------|
| 物理删除 | experience:delete(hard DELETE FROM)；符合 SC4「不留库」；复用现有 IPC | ✓ |
| 软标 invalid | status='invalid'；违背 SC4 且 invalid 语义错(draft 未发布谈不上失效) | |
| 新增 discarded 态 | status 加枚举 + 改 CHECK 约束 + 迁移；过度设计 | |

**User's choice:** 物理删除
**Notes:** codegraph 核实 deleteExperience（experienceService.ts:317）= `DELETE FROM experiences` hard delete，experience:delete IPC 已暴露。Phase 7 软失效原则针对已发布经验保留历史，draft 不在此列，物理删不违背。

### Q2 — 未处理/未通过质量门的 draft 关闭弹窗后怎么再访问？

| Option | Description | Selected |
|--------|-------------|----------|
| AIPage待确认入口 | 允许暂存(status=draft)；「经验总结」旁「待确认 N 条」角标重开弹窗；新 IPC listDrafts | ✓ |
| 强制处理完 | 关闭弹窗前必须确认/丢弃所有；简单但强迫当下决策 | |
| 暂存交Phase10 | draft 留库，再访问交 Phase 10 浏览页；Phase 10 未做前是孤儿 | |

**User's choice:** AIPage 待确认入口
**Notes:** 防 draft 成孤儿，Phase 9 自洽，支撑「暂存后补」。新增 experience:listDrafts（按 status='draft'）。

---

## Claude's Discretion

用户未显式说「you decide」，但以下在讨论中明确归 Claude 按项目约定自主（写入 CONTEXT.md `<decisions>` Claude's Discretion 节）：
- IPC channel 命名与清单（confirmDrafts/listDrafts/getSessionMessages + 复用 get/update/delete/relateDevice）
- 质量门校验位置（renderer 标红 + IPC + service 三层纵深防御）与必填规则
- 分类切换 attrs 模板动态呈现
- 确认事务原子性（confirmDrafts 单 transaction）
- 疑似重复提示（复用 Phase 8 verdict 标注，不额外 Similarity Check）
- 边界处理（session 不存在提示、原文滚动、confidence 展示样式）
- UI 细节（表单字段顺序、校验提示样式、角标组件）

## Deferred Ideas

- 经验板块页（浏览/筛选/搜索/手动 CRUD/标失效）→ Phase 10
- AI 检索复用 + read-time 验证 + 引用溯源 → Phase 11
- commandSafety 联动验证 → Phase 11
- 消息段精锚（source_event_ids）→ 二期 FUTURE-03
- 经验↔经验关联图可视化 → 二期 FUTURE-04
- 确认后 published 经验手动编辑/标失效 → Phase 10 浏览页
