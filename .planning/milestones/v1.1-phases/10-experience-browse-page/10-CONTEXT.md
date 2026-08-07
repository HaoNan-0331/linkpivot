# Phase 10: Experience Browse Page - Context

**Gathered:** 2026-08-05
**Status:** Ready for planning

<domain>
## Phase Boundary

用户在知识库页「经验」Tab 内独立浏览/多维筛选/关键词搜索/手动 CRUD/标失效经验——把 Phase 7-9 沉淀的经验资产变成可人工主动管理的列表，不依赖 AI 总结流程（BROWSE-01/02/03/04）。Phase 9 confirmed（实际 published）经验充实列表，但浏览页本身在 Phase 7 数据层就绪后即独立可用。

**In scope：**
- 知识库页改造为 Tabs（文档 | 经验），新增「经验」Tab（SC1，非独立一级菜单）
- 经验列表（Table）+ 多维筛选（分类/标签/关联设备/严重度/有效期/状态）+ 关键词搜索（title/content）（SC2）
- 手动新增/编辑经验（表单复用 Phase 9 公共组件，走同一分类模板与质量门）（SC3）
- 标记失效（invalid_at）+ 撤销恢复 + 物理删除（三能力）（SC4）
- 经验详情 Modal（来源会话回链/关联设备/复用次数/最后验证时间/有效期/严重度/标签/分类）（SC5）
- service/IPC 层扩展：listExperiences opts 加 search/severity/tags；新增 restoreExperience 受控接口；severity 独立明文列迁移

**Out of scope（属其他 phase）：**
- AI 检索复用（SQL 粗筛 + LLM 精排 + read-time 验证 + 引用溯源）→ **Phase 11**
- commandSafety 联动验证 → **Phase 11**（read-time 才用）
- AI 起草/人工确认弹窗 → **Phase 8/9**（浏览页只消费 published/invalid 经验，不动 draft 闸口）
- FTS5 全文索引 → **Phase 11**（本 phase 用 SQL LIKE，不上 FTS5）
- 消息段精锚 / 经验↔经验关联图可视化 → **二期**

</domain>

<decisions>
## Implementation Decisions

### CRUD 表单复用
- **D-10-1：复用 Phase 9 ReviewConfirmModal 的编辑表单，抽成公共组件。** Phase 9 已实现完整经验编辑表单（标题/分类/内容/attrs 模板字段动态呈现/标签/关联设备 + 必填质量门校验）。抽成公共组件（如 `ExperienceEditForm`），Phase 9 确认弹窗与 Phase 10 手动 CRUD 共用，永远一致。**抽组件时一并抽出质量门校验逻辑**（troubleshooting 必填 symptom/resolution/severity，其余轻结构只 title/content），手动新增/编辑同走质量门。符合用户「优先可扩展性」偏好 + 「代码读起来像周围代码」。

### 搜索与多维筛选实现
- **D-10-2：SQL LIKE + severity 加独立明文列 + tags json_extract。**
  - **关键词搜索**：SQL `LIKE` 匹配 title + content（单机桌面经验量级小，LIKE 够用；FTS5 留 Phase 11 一并建，本 phase 不引入）。
  - **severity 筛选**：从加密 attrs 拆出，**新增 `severity TEXT` 独立明文列**（幂等迁移 `hasColumn` 守卫，troubleshooting 类填 critical/high/medium/low/info，其他类 NULL），SQL `WHERE severity = ?` 直筛 + 排序。**attrs.severity 保留向后兼容**（Phase 7-9 已落库的 attrs.severity 不动，create/update 时双写 severity 列 + attrs.severity；planner 可评估是否去重，但须保证历史数据可查）。
  - **tags 筛选**：tags 明文 JSON 列，SQL `json_extract` 或 `tags LIKE` 匹配（多选标签命中任一）。
  - **有效期/状态筛选**：valid_at/invalid_at 独立明文列（Phase 7 已有），SQL 直筛（`invalid_at IS NULL OR invalid_at > now` = 有效）。
  - **扩 listExperiences opts**：加 `search?: string` / `severity?: string` / `tags?: string[]`（单入口，避免新增 experience:search 双 API）；service 层 SQL 拼接（参数化，防注入）。IPC `experience:list` 透传扩展 opts。

### 删除/失效/撤销语义
- **D-10-3：三能力全要（用户组合选项）。**
  - **物理删除**：复用 `experience:delete`（hard DELETE，experienceService.ts:316）。已发布经验可物理删，UI 走 Popconfirm 二次确认 + 强提示「彻底删除不可恢复」。
  - **标失效**：复用 `experience:invalidate`（软失效，落 invalid_at）。契合 EXP-03 保留历史语义。
  - **撤销恢复**：**新增 `restoreExperience(id)` 受控接口**（清 invalid_at + status 回 published，绕 CR-01 update 白名单，沿用 invalidate/incReuseCount/touchLastVerifiedAt 同模式），IPC `experience:restore` secure 包装。
  - **默认视图**：有效经验（published 且 invalid_at IS NULL OR > now）；顶部「显示已失效」开关打开后才见失效经验（includeInvalid 透传）。**draft 不进浏览页**（Phase 9「待确认草稿」专属，避免职责重叠）。

### 列表与详情形态
- **D-10-4：Table 列表 + Modal 详情。** 与 KnowledgeBasePage（文档库）现有 Table + Modal 范式一致（项目惯例）。经验 Tab 用 Table 列分类/标题/严重度/标签/关联设备/状态/有效期/操作；点行打开详情 Modal 展示元数据（来源会话回链 source_session_id + 「查看会话」入口、关联设备 listDevices、复用次数 reuse_count、最后验证 last_verified_at、有效期 valid_at/invalid_at、严重度、标签、分类、attrs 模板字段）。

### Claude's Discretion
以下由 Claude 按项目约定 + design 文档自主决策：
- **Tab 嵌入实现**：KnowledgeBasePage 改造为 `<Tabs>`（items: 文档 | 经验），现有文档内容移入「文档」Tab pane，新增「经验」Tab pane（ExperienceTab 独立组件，建议 `src/components/knowledge/ExperienceTab.tsx` 或就近放 pages 同级）。路由/侧边栏不动（仍在 KnowledgeBasePage 一级菜单下）。
- **severity 列迁移细节**：新增迁移步骤（hasColumn 守卫 + db.transaction + bump MIGRATION_HEAD），createExperience/updateExperience 双写 severity 列 + attrs.severity；planner 按 Phase 7 迁移规范定迁移版本号（v10? 接 Phase 8 v9 / Phase 9 之后）。
- **撤销恢复接口语义对称**：restoreExperience = invalidateExperience 的逆（清 invalid_at + status 回 published），planner 按 Phase 7 invalidate 实现对称设计（先确认 invalidate 是否动 status，restore 对称恢复）。
- **手动新增 status**：手动新增经验是用户主动录入（非 AI 产出），红线③「AI 产出必先进 draft」不约束人工录入 → createExperience 入参倾向直 `status='published'`（避免人工录入还要走确认弹窗）。planner 按「人工录入 vs AI 起草」语义定。
- **筛选 UI 交互**：多维筛选用 Ant Design Select（分类/严重度/状态/设备多选）+ Tags 选择器 + 关键词 Input（onPressEnter + 防抖）；「显示已失效」Switch。
- **来源会话回链**：详情 Modal 显示 source_session_id + 「查看原始会话」按钮（复用 Phase 9 experience:getSessionMessages 取会话原文，叠只读子 Modal；planner 定，优先复用 Phase 9 已有 IPC 与 SessionMessagesModal 组件）。
- **空状态/数据量**：单机桌面经验量级小，列表分页 pageSize 20（与文档库一致）；空状态用 Ant Design Empty + 引导（「AI 对话后点经验总结」/「手动新增」）。
- **列表操作按钮**：行操作 = 编辑 / 标失效（有效时）或 恢复有效（失效时） / 物理删除（Popconfirm）。
- **新增入口**：经验 Tab 顶部「新增经验」按钮 → 打开复用编辑表单（空表单，无 source_session_id/draft 字段）。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 功能设计（最高优先级）
- `.planning/designs/2026-08-01-experience-summary-design.md` — 主设计文档：§1 决策汇总 + 三条红线 + §3 数据模型（attrs 模板 / status 枚举 / bi-temporal）+ §5 UI 交互。Phase 10 浏览页由此驱动（注意 §3 原始 5 态以 Phase 7 落地 4 态为准）。
- `.planning/research/2026-08-01-experience-summary-research.md` — 55 同类项目调研，分类模板/筛选最佳实践。

### Roadmap / Requirements / Project
- `.planning/ROADMAP.md` §Phase 10 — Goal + 5 Success Criteria + Depends on Phase 7（+Phase 9 充实列表但不阻塞）。
- `.planning/REQUIREMENTS.md` BROWSE-01/02/03/04 — 4 条需求逐字定义。
- `.planning/PROJECT.md` §Current Milestone v1.1 — 三条红线（① 不上向量库 ② 不引图库 ③ AI 产出必先进 draft 人工确认才 published）。

### Phase 9 直接前驱（表单复用强依赖）
- `.planning/phases/09-human-review-confirmation/09-CONTEXT.md` — D-9-3 ReviewConfirmModal master-detail + 编辑表单；D-9-1 status 四态 confirmed 不用；D-9-6 丢弃 hard DELETE（针对 draft）。
- `src/components/.../ReviewConfirmModal`（Phase 9 渲染层，09-03 落地）— 经验编辑表单 + 质量门校验源，Phase 10 抽公共组件复用。**planner 需从 09-03-SUMMARY.md 定位实际文件路径**。
- `.planning/phases/09-human-review-confirmation/09-03-SUMMARY.md` — Phase 9 渲染层实际文件清单（ReviewConfirmModal / SessionMessagesModal 位置）。

### Phase 7 数据层基线（强依赖）
- `electron/services/experienceService.ts` — service 函数式清单：listExperiences（opts: category/status/deviceId/includeInvalid/limit/offset）/ createExperience / updateExperience（CR-01 白名单移除 status/validAt/invalidAt）/ deleteExperience（hard DELETE :316）/ invalidateExperience / relateDevice / unrelateDevice / listDevicesByExperience / listExperiencesByDevice。Phase 10 扩 listExperiences opts（search/severity/tags）+ 新增 restoreExperience。
- `electron/ipc/experienceIpc.ts` — 现有 13 channel 全 secure 包装（含 Phase 9 confirmDrafts/listDrafts/getSessionMessages）。Phase 10 扩 experience:list opts 透传 + 新增 experience:restore。
- `src/types/experience.ts` — Experience / ExperienceInput / ExperienceUpdateInput / ExperienceAttrs / ExperienceListInput DTO。Phase 10 扩 ExperienceListInput（search/severity/tags）+ Experience 加 severity 字段。
- `electron/database/init.ts` + `electron/database/migrations.ts` — experiences 表 DDL + 迁移注册表。Phase 10 加 severity 列迁移（hasColumn 守卫 + bump MIGRATION_HEAD）。
- `.planning/phases/07-experience-data-layer-security-baseline/07-REVIEW-FIX.md` — CR-01 ExperienceUpdateInput 白名单收紧，**restoreExperience 必须新接口不能复用 update**。

### 项目规范 / 集成契约
- `./CLAUDE.md` — Constraints（安全两层语义）/ Conventions（Service 函数式 / IPC secure 红线 / 字段加密 encField-decField / 迁移幂等 hasColumn / MAX_BATCH=1000 / 受控接口模式）/ Architecture。
- `.planning/codebase/CONVENTIONS.md` — Service 函数式 / IPC 鉴权红线 / 字段加密 / 迁移幂等。
- `.planning/codebase/STRUCTURE.md` — KnowledgeBasePage.tsx 现状（无 Tabs，两 Card：资料库列表 + 检索测试）+ 「新 React 页面/组件」约定。
- `.planning/codebase/ARCHITECTURE.md` — 三进程分层、信任边界（renderer 永不收明文凭证，IPC stripEncColumns）。

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`KnowledgeBasePage.tsx`（src/components/pages/）** — 文档库现有 Table + 筛选 Select + 搜索 Input + Modal 详情范式。Phase 10 经验 Tab 直接参考其交互模式（Table columns / 筛选 Space / 搜索 onPressEnter / 详情 Modal）。改造时把现内容包进 Tabs「文档」pane。
- **Phase 9 ReviewConfirmModal 编辑表单 + 质量门**（09-03 渲染层）— 经验编辑表单（标题/分类/内容/attrs 模板动态呈现/标签/关联设备 + 必填校验）。**抽成 ExperienceEditForm 公共组件**，Phase 9 确认弹窗 + Phase 10 手动 CRUD 共用（D-10-1）。
- **`experienceService.listExperiences(opts)`** — 已支持 category/status/deviceId/includeInvalid/limit/offset + bi-temporal 过滤。Phase 10 扩 search/severity/tags（D-10-2）。
- **`experienceService.deleteExperience` / `invalidateExperience` / `relateDevice` / `unrelateDevice` / `listDevicesByExperience`** — 物理删除/标失效/关联设备复用。
- **`experience:getSessionMessages` IPC（Phase 9）+ SessionMessagesModal** — 来源会话回链取原文，Phase 10 详情 Modal 复用。
- **Ant Design Table / Tabs / Modal / Form / Select / Switch / Tag / Popconfirm / Empty** — 全项目已大量使用。
- **`secure()` IPC 包装 + MAX_BATCH**（authGuard.ts）— 新 experience:restore 沿用。

### Established Patterns
- **Service 函数式 + 模块级 MK** — restoreExperience / listExperiences 扩展沿用函数式（无 class），加密列走 encField/decField。
- **IPC `<domain>:<action>` camelCase + secure + MAX_BATCH** — experience:restore / 扩展的 experience:list 遵循。
- **受控状态接口模式** — Phase 7 已有 invalidate/incReuseCount/touchLastVerifiedAt 绕 update 白名单改审计/状态字段；restoreExperience（清 invalid_at + status 回 published）同模式新增（D-10-3）。
- **迁移幂等（hasColumn / sqlite_master.sql 特征串守卫）** — severity 列迁移用 hasColumn 守卫 + db.transaction，不动 status 枚举（D-10-2）。
- **KnowledgeBasePage 筛选范式** — Select 筛设备/分类 + 搜索 Input + Table，Phase 10 经验 Tab 复用同范式（D-10-4）。

### Integration Points
- **renderer（KnowledgeBasePage）**：改造为 Tabs，新增「经验」Tab → ExperienceTab 组件 → 调 `window.api.experience.list`（扩展 opts）+ create/update/delete/invalidate/restore + listDevices/getSessionMessages。
- **IPC**：experienceIpc.ts 扩 experience:list 透传 search/severity/tags + 新增 experience:restore secure 包装。
- **preload**：contextBridge experience.restore 暴露 + experience.list opts 类型扩展。
- **service**：experienceService.ts listExperiences opts 扩展 + 新增 restoreExperience + create/update 双写 severity 列。
- **DB**：migrations.ts 加 severity 列迁移步骤（hasColumn 守卫 + bump MIGRATION_HEAD）。
- **类型**：src/types/experience.ts ExperienceListInput 扩 + Experience 加 severity + electron.d.ts 同步。
- **信任边界**：renderer 永不收 attrs 密文（service rowToExperience 已 decField 回填 attrs + delete attrs_enc；severity 拆明文列后直接返）。

</code_context>

<specifics>
## Specific Ideas

- **三条红线③「AI 产出永远先进 draft，人工确认才 published」** —— 浏览页只管已 published/invalid 经验的手动维护（编辑/标失效/恢复/物理删），红线③针对 AI 产出；**人工手动录入非 AI 产出，不在此列**（D-10-1 discretion：手动新增直 published，避免人工录入还要走确认弹窗）。
- **design §5 浏览页功能清单**（多维筛选 + 关键词搜索 + 手动 CRUD + 标失效 + 详情元数据）phase 10 落地。
- **severity 加列是数据模型变更**（D-10-2）—— 为支撑 SQL 筛选/排序 + Phase 11 检索复用，从加密 attrs 拆明文列；attrs.severity 保留向后兼容（双写）。

</specifics>

<deferred>
## Deferred Ideas

- **FTS5 全文索引** → Phase 11（检索增强，phase 10 用 SQL LIKE 够用）。
- **AI 检索复用**（SQL 粗筛 + LLM 精排 + read-time 验证 + 引用溯源）→ Phase 11（RETRIEVE-01/02/03）。
- **commandSafety 联动验证** → Phase 11 read-time 才用。
- **经验↔经验关联图可视化 / 消息段精锚** → 二期（FUTURE-03/04）。
- **标签管理页**（标签合并/重命名/批量打标）→ 未来（phase 10 只做标签筛选，不做标签管理 CRUD）。
- **经验版本历史**（每次编辑留版本快照）→ 未来（phase 10 编辑直接 update，不留版本）。

</deferred>

---
*Phase: 10-Experience Browse Page*
*Context gathered: 2026-08-05*
