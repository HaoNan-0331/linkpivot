# Phase 10: Experience Browse Page - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-05
**Phase:** 10-experience-browse-page
**Areas discussed:** CRUD 表单复用 / 搜索与筛选实现 / 删除失效撤销语义 / 列表详情形态

---

## CRUD 表单复用

| Option | Description | Selected |
|--------|-------------|----------|
| 复用 Phase 9 表单（抽公共组件） | Phase 9 ReviewConfirmModal 已实现完整经验编辑表单（标题/分类/内容/attrs 模板/标签/关联设备+校验）。抽成公共组件两处共用，永远一致。代价：先重构 Phase 9 抽组件。 | ✓ |
| 浏览页新写编辑弹窗 | 浏览页独立写 ExperienceEditModal。快，但与 Phase 9 表单字段重复维护，易长歪。 | |

**User's choice:** 复用 Phase 9 表单（抽公共组件）
**Notes:** 符合用户「优先可扩展性」偏好 + 「代码读起来像周围代码」。抽组件时一并抽出质量门校验逻辑，手动 CRUD 同走质量门。

---

## 搜索与多维筛选实现

| Option | Description | Selected |
|--------|-------------|----------|
| SQL LIKE + 严重度加独立明文列 | 关键词 SQL LIKE（量小够用）；severity 从加密 attrs 拆出加独立明文列（迁移），SQL 直筛 + Phase 11 复用排序；tags json_extract。 | ✓ |
| SQL LIKE + 严重度内存过滤 | 不改表，severity 由 service 解密 attrs 后内存过滤。改动最小但量大慢，Phase 11 还要再处理。 | |
| 提前建 FTS5 + 严重度加列 | Phase 10 即建 FTS5（Phase 11 反正要用）+ severity 加列。最一劳永逸但迁移最重，over-engineering 风险。 | |

**User's choice:** SQL LIKE + 严重度加独立明文列
**Notes:** severity 列支撑 SQL 筛选/排序 + Phase 11 检索复用；attrs.severity 保留向后兼容（双写）。FTS5 明确推迟到 Phase 11。

---

## 删除/失效/撤销语义

| Option | Description | Selected |
|--------|-------------|----------|
| 只标失效不物理删 + 支持撤销恢复 | 已发布经验「删除」= 标失效（软删除保留历史）；新增「恢复有效」接口支持撤销。最安全。 | |
| 允许物理删除 + 标失效可撤销 | 既支持物理 hard DELETE 又支持标失效 + 撤销。能力全，物理删有误删风险。 | ✓ |
| 只标失效 + 不可撤销 | 最简单向失效。但误标失效无法恢复。 | |

**User's choice:** 允许物理删除 + 也可以标失效 + 支持撤销恢复（三能力全要）
**Notes:** 用户选了比 Recommended 更全的组合——物理删除（hard DELETE，Popconfirm 二次确认）+ 标失效（invalid_at 软失效）+ 撤销恢复（新增 restoreExperience 受控接口清 invalid_at）。三能力并存，UI 用二次确认防物理删误操作。

---

## 列表与详情形态

| Option | Description | Selected |
|--------|-------------|----------|
| Table 列表 + Modal 详情 | 与文档库 KnowledgeBasePage 完全一致的 Table+Modal 范式（项目惯例）。详情 Modal 展示来源会话回链/关联设备/复用次数/最后验证时间。 | ✓ |
| Card 列表 + Drawer 详情 | 每条经验一张卡片（attrs 模板字段更舒展），详情用侧抽屉（边看边操作）。更现代但偏离项目现有 Table 惯例。 | |
| Table 列表 + Drawer 详情 | 紧凑 Table + 抽屉详情（详情多时抽屉比 Modal 宽展）。 | |

**User's choice:** Table 列表 + Modal 详情
**Notes:** 与文档库范式一致。显示范围（无争议，Claude 自定）：默认有效经验（published 且未失效）+ 「显示已失效」开关；draft 不进浏览页（Phase 9「待确认草稿」专属，避免职责重叠）。

---

## Claude's Discretion

用户授权 Claude 按项目约定 + design 文档自主决策的子点：
- Tab 嵌入实现（KnowledgeBasePage 改 `<Tabs>`，新增 ExperienceTab 组件，路由/侧边栏不动）
- severity 列迁移细节（hasColumn 守卫 + bump MIGRATION_HEAD，create/update 双写）
- restoreExperience 语义对称（= invalidate 逆操作，planner 按 Phase 7 实现对称设计）
- 手动新增 status（人工录入非 AI 产出，倾向直 published，绕红线③仅约束 AI）
- 筛选 UI 交互（Select 多选 + Tags 选择器 + 关键词 Input 防抖 + 显示已失效 Switch）
- 来源会话回链（复用 Phase 9 getSessionMessages + SessionMessagesModal）
- 空状态/分页（pageSize 20 + Empty 引导）
- 列表操作按钮（编辑/标失效·恢复有效/物理删除 Popconfirm）
- 新增入口（Tab 顶部「新增经验」按钮）

## Deferred Ideas

- FTS5 全文索引 → Phase 11
- AI 检索复用（SQL 粗筛 + LLM 精排 + read-time 验证 + 引用溯源）→ Phase 11
- commandSafety 联动验证 → Phase 11
- 经验↔经验关联图可视化 / 消息段精锚 → 二期
- 标签管理页（合并/重命名/批量打标）→ 未来
- 经验版本历史（编辑留版本快照）→ 未来
