# Phase 9: Human Review & Confirmation - Context

**Gathered:** 2026-08-03
**Status:** Ready for planning

<domain>
## Phase Boundary

用户在确认弹窗中对 Phase 8 起草的 `draft` 态草稿**逐条编辑/勾选/质量门校验后确认**——确认才转 `published`（session→permanent 的唯一人工闸口，红线③执行点），丢弃物理删除不留库，UPDATE 草稿逐条人工拍板命中旧条目命运，每条可一键回链产生它的原始会话溯源核对。未处理/未通过质量门的 draft 可暂存，AIPage「待确认 N 条」入口重开弹窗。

**In scope：**
- 确认弹窗（宽 Modal + master-detail）：逐条编辑（标题/分类/内容/attrs 模板字段/标签/关联设备）+ 勾选采纳/丢弃 + 标注置信度/ADD·UPDATE/疑似重复 + 质量门缺必填标红
- 质量门硬校验（拦在确认按钮前；troubleshooting 必填 symptoms/resolution/severity，其余轻结构）
- 原始会话溯源回链（只读模态叠层展示 `source_session_id` 会话明文，REVIEW-03）
- 确认提交（批量，单事务原子：采纳 draft→published + UPDATE 草稿按勾选 supersede 旧条目 + 丢弃 hard delete；SC4）
- AIPage「待确认 N 条」入口（暂存 draft 重开弹窗，防 draft 成孤儿）
- 新增受控接口：`confirmDrafts`（批量 draft→published + 可选 supersede）/ `listDrafts`（列暂存 draft）/ `getSessionMessages`（取会话原文）
- IPC 鉴权（延续 Phase 7 `secure` 基线）+ 批量上限 MAX_BATCH

**Out of scope（属其他 phase）：**
- 经验板块页（浏览/筛选/搜索/手动 CRUD/标失效）→ **Phase 10**
- AI 检索复用（SQL 粗筛 + LLM 精排 + read-time 验证 + 引用溯源）→ **Phase 11**
- commandSafety 联动验证 → **Phase 11**（read-time 才用）
- 消息段精锚（source_event_ids 高亮产生经验的具体消息段）→ **二期**
- 经验↔经验关联图可视化 → **二期**

</domain>

<decisions>
## Implementation Decisions

### 确认态语义与状态机
- **D-9-1：draft 确认即转 published（直接 draft→published），`confirmed` 态预留不用。** Phase 7 落地 4 态（draft/confirmed/published/invalid）中 `confirmed` 不触发。新增 `confirmDrafts` 受控接口转态，**不动 CR-01 收紧的 `updateExperience` 白名单**（status 仍不可经 update 改，沿用 Phase 7 受控接口模式：invalidate/incReuseCount/touchLastVerifiedAt 同类）。理由：红线③原文「人工确认才 published」；Phase 11 检索池=有效经验(status≠invalid)，published=对 AI 检索可见，语义最清晰。**解决 ROADMAP Goal「published」vs SC4「confirmed」矛盾**——SC4「confirmed」按口语化「已确认」理解，实际落 published。

### UPDATE 草稿的旧条目命运
- **D-9-2：UPDATE 草稿（带 `duplicate_of_exp_id` 命中旧条目）确认时逐条显式拍板。** 弹窗展示命中旧条目标题 + 「☐ 标失效旧条目 / ☐ 保留」复选，**默认不勾**（防 Phase 8 `judgeVerdicts` AI 误判 UPDATE 实为 ADD 时误删有效旧条目），用户主动勾选才 supersede（旧条目 `invalid_at` 落时间，复用 `invalidateExperience`）。符合红线③「全自动矛盾判定 YAGNI 不做，永远人工拍板」+ design §6「确认时 Similarity Check」。**Phase 8 D-03 把旧条目命运留 Phase 9 拍板，本决策落地。**

### 确认弹窗 UI 形态
- **D-9-3：宽 Modal（~80vw）+ master-detail 布局。** 左侧草稿列表（逐条勾选采纳/丢弃 + 标注置信度/ADD·UPDATE/疑似重复 + 质量门未过标红），右侧选中条目编辑表单（标题/分类/内容/attrs 模板字段/标签/关联设备）。**复用项目 Modal 组件惯例**（AddDeviceModal/CommandConfirmModal 等；项目无 Drawer 先例，按「代码读起来像周围代码」用 Modal）。

### 确认提交粒度
- **D-9-4：批量一次性提交。** 用户在弹窗内编辑/勾选所有草稿后，点底部「确认采纳 N 条 + 丢弃 M 条」一次性提交；列表头提供「全选采纳/全选丢弃」快捷。IPC 批量 `experience:confirmDrafts`（draft→published + 可选 supersede 旧条目）+ 批量 discard（`experience:delete`），**单事务原子**（db.transaction，部分失败 ROLLBACK）。符合 master-detail 纵览后统一决策 + D-9-2 逐条拍板后批量生效。

### 原始会话溯源回链
- **D-9-5：只读模态叠层。** 确认弹窗内点「查看原始会话」叠一个只读子 Modal 展示该 `source_session_id` 会话原文（滚动），核对完关闭继续编辑，不离开确认上下文。**新增 secure IPC**（如 `experience:getSessionMessages`）取会话明文（复用 service 层 `getChatHistory` 解密 `chat_history`）。design D-04 定回链展示明文（用户核对自己对话，单机 safeStorage 绑机器，不做 PII 脱敏）。

### 丢弃处理
- **D-9-6：物理删除。** 丢弃 = `experience:delete`（hard `DELETE FROM experiences`，experienceService.ts:317，IPC 已暴露）。符合 SC4「丢弃的条目不留库」。draft 未发布，软失效 invalid 语义错（invalid 是「曾发布现失效」，draft 从未发布）；Phase 7 软失效原则针对已发布经验保留历史，draft 不在此列，不违背。

### 暂存与再访问
- **D-9-7：允许暂存。** 质量门未通过或用户暂不处理的 draft，关闭弹窗后保留（status='draft'）。AIPage「经验总结」按钮旁显示「待确认 N 条」角标入口，点击重开确认弹窗。**新增 IPC `experience:listDrafts`**（按 status='draft' 过滤，复用 `listExperiences` status 分支或窄化封装）。draft 不成孤儿，支撑「暂存后补」。

### Claude's Discretion
以下由 Claude 按 design 文档 + 项目约定自主决策：
- **IPC channel 命名与清单**（沿用 `experience:<action>` camelCase + `secure` 包装 + MAX_BATCH）—— 新增 `confirmDrafts`（批量确认）/ `listDrafts`（列暂存 draft）/ `getSessionMessages`（取会话原文）；复用 `experience:get/update/delete/relateDevice/unrelateDevice`。具体签名 planner 定。
- **质量门校验位置与规则** —— 三层纵深防御：renderer 编辑表单实时标红（troubleshooting 必填 symptoms/resolution/severity；best_practices/product/env 轻结构只 title/content）+ IPC 提交前校验 + service `confirmDrafts` 内校验兜底。必填规则按 design §3 + Phase 7 ExperienceAttrs 模板。
- **分类切换 attrs 模板字段动态呈现** —— 跟随 category 渲染对应表单（troubleshooting 显 symptoms/root_cause/resolution/prevention/severity，其余轻结构 title/content/tags）。
- **确认事务原子性** —— `confirmDrafts` 内 `db.transaction` 包：采纳的 draft→published + UPDATE 草稿按勾选 supersede 旧条目（invalidateExperience）+ 关联设备更新（relateDevice/unrelateDevice）+ 丢弃的 delete，单事务全成全败。
- **疑似重复提示** —— 复用 Phase 8 `judgeVerdicts` 的 verdict 标注（ADD/UPDATE/NOOP + duplicate_of_exp_id）在弹窗列表展示，不额外做 Similarity Check（design §6 描述由 Phase 8 verdict 承载）。
- **边界处理** —— `source_session_id` 指向 session 已删/不存在时回链提示「原会话已不可查」；会话原文长用滚动/虚拟列表；confidence/reasoning 展示样式。
- **UI 细节** —— 编辑表单字段顺序、校验提示样式、角标计数组件，复用 Ant Design 6 + 项目现有组件风格。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 功能设计（最高优先级，已锁定大部分决策）
- `.planning/designs/2026-08-01-experience-summary-design.md` — **主设计文档**：§1 已定决策汇总 + 三条红线 + §3 数据模型（attrs 模板 / status 枚举）+ §5 UI 交互（确认弹窗功能清单）+ §6 错误处理（质量门/Similarity Check）。phase 9 确认弹窗由此驱动。**注意 §3 原始 status 5 态（draft/confirmed/duplicate/superseded/deleted）与 Phase 7 落地 4 态不一致，以 D-9-1 落地 4 态为准。**
- `.planning/research/2026-08-01-experience-summary-research.md` — 55 同类项目调研（脱敏/去重/分类模板最佳实践），design 决策依据。

### Roadmap / Requirements / Project
- `.planning/ROADMAP.md` §Phase 9 — Goal + 4 Success Criteria + Depends on Phase 8。**注意 Goal「published」vs SC4「confirmed」矛盾，D-9-1 统一为 published。**
- `.planning/REQUIREMENTS.md` REVIEW-01/02/03 — 3 条需求逐字定义。
- `.planning/PROJECT.md` §Current Milestone v1.1 — 三条红线（① 不上向量库 ② 不引图数据库 ③ AI 产出必先进 draft 人工确认才 published）+ Key context。

### Phase 8 直接前驱（强依赖，draft 输入）
- `.planning/phases/08-ai-drafting-pipeline/08-CONTEXT.md` — Phase 8 决策：D-01 强 schema 起草 / D-02 查重 ADD·UPDATE·NOOP / **D-03 status 四态 + UPDATE 不动旧条目留 Phase 9** / D-04 PII 脱敏前置原始明文不动。phase 9 消费 draft + 落地 D-03 旧条目命运（D-9-2）。
- `electron/services/experienceDrafting.ts` — `summarizeSessionForUi`（:70）起草入口，返回 `DraftingResult`（created/updated/noop，仅 exp_id/title/category，**不含会话原文** T-08-13 边界脱敏）。phase 9 弹窗消费 DraftingResult + 按 exp_id 取 draft 详情。

### Phase 7 数据层基线（强依赖）
- `electron/services/experienceService.ts` — service 函数式清单：`createExperience` / `listExperiences`（支持 status 过滤）/ `updateExperience`（**CR-01 白名单移除 status**）/ `deleteExperience`（:316 hard DELETE）/ `invalidateExperience`（软失效）/ `relateDevice` / `unrelateDevice` / `listDevicesByExperience`。phase 9 复用 delete/invalidate/relateDevice，**新增 confirmDrafts 受控接口（draft→published，不动 update 白名单）**。
- `electron/ipc/experienceIpc.ts` — 现有 10 channel（list/get/create/update/delete/invalidate/relateDevice/unrelateDevice/listByDevice/listDevices）全 `secure` 包装 + `stripEncColumns`。phase 9 新增 confirmDrafts/listDrafts/getSessionMessages 沿用 secure。
- `src/types/experience.ts` — Experience / ExperienceInput / ExperienceUpdateInput / ExperienceAttrs / DraftingResult DTO。phase 9 新增 confirm/listDrafts/sessionMessages DTO 对齐。
- `.planning/phases/07-experience-data-layer-security-baseline/07-REVIEW-FIX.md` — **CR-01 ExperienceUpdateInput 白名单收紧**（status/validAt/invalidAt 移出），phase 9 确认转态必须新接口不能复用 update。

### 项目规范 / 集成契约
- `./CLAUDE.md` — Constraints（安全两层语义）/ Conventions（Service 函数式 / IPC secure / 字段加密 / 迁移幂等 / MAX_BATCH）/ Architecture。
- `.planning/codebase/CONVENTIONS.md` — Service 函数式 / IPC 鉴权红线 / 字段加密 / 迁移幂等。
- `.planning/codebase/ARCHITECTURE.md` — 三进程分层、信任边界（main 持 masterKey，renderer 永不收明文凭证）。
- `.planning/codebase/INTEGRATIONS.md` §LLM — `callAI` 契约（**phase 9 不调 LLM，确认是纯人工闸口**）。

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`experienceService.deleteExperience(id)`（experienceService.ts:316）** — hard `DELETE FROM`，丢弃草稿直接复用（D-9-6）。
- **`experienceService.invalidateExperience(id)`**（软失效 invalid_at）— UPDATE 草稿 supersede 旧条目复用（D-9-2）。
- **`experienceService.relateDevice / unrelateDevice`** — 确认时更新关联设备复用。
- **`experienceService.listExperiences({status:'draft'})`**（支持 status 过滤）— `listDrafts` 可复用 status 分支，或新增窄化封装（D-9-7）。
- **`getChatHistory(sessionId)`（ai.ts:192，experienceDrafting.ts:75 已用）** — 会话回链取原文，phase 9 经新 IPC 暴露给 renderer（D-9-5）。
- **`summarizeSessionForUi` 返回的 `DraftingResult`（experienceDrafting.ts:70）** — 弹窗初始 draft 列表来源（created/updated + exp_id）。
- **Ant Design Modal / Form / Checkbox / Badge / Table** — 弹窗 master-detail + 角标入口组件（项目已大量用 Modal）。
- **`secure()` IPC 包装（authGuard.ts）** — 新 channel 沿用。

### Established Patterns
- **Service 函数式 + 模块级 MK** — phase 9 若扩 experienceService 加 `confirmDrafts`，沿用函数式（无 class），加密列走 encField/decField。confirmDrafts 不读写新加密列（attrs 已加密，update/delete/invalidate 复用现有）。
- **IPC `<domain>:<action>` camelCase + secure + MAX_BATCH** — 新 channel（experience:confirmDrafts/listDrafts/getSessionMessages）遵循。
- **`db.transaction` 原子多写** — `confirmDrafts` 批量（published + supersede + delete）单事务，throw ROLLBACK（D-9-4）。
- **受控状态接口模式** — Phase 7 已有 `invalidateExperience`/`incReuseCount`/`touchLastVerifiedAt` 专用接口绕 update 白名单改审计字段；`confirmDrafts`（draft→published）同模式新增（D-9-1）。
- **Master-detail Modal** — 项目 Modal 惯例（AddDeviceModal 等），phase 9 宽 Modal + 左右分栏是新组合但复用 Modal 基础（D-9-3）。

### Integration Points
- **main 进程**：`confirmDrafts`/`listDrafts`/`getSessionMessages` 在 service 层实现（扩 experienceService 或新 reviewService），main.ts 注册 IPC，masterKey 在 main 可用。
- **IPC**：experienceIpc.ts 新增 3 channel secure 包装。
- **preload**：contextBridge 暴露 `experience.confirmDrafts/listDrafts/getSessionMessages`。
- **renderer（AIPage）**：「经验总结」按钮（Phase 8）触发起草 → DraftingResult → 打开确认弹窗（Phase 9 新建 ReviewConfirmModal）；「待确认 N 条」角标入口（Phase 9 新建）→ listDrafts → 重开弹窗。
- **信任边界**：`getSessionMessages` 返会话明文给 renderer（用户核对自己对话，design D-04 明文）；draft 详情经 `experience:get` 已脱敏（stripEncColumns）。

</code_context>

<specifics>
## Specific Ideas

- **design §5 确认弹窗功能清单已锁**（逐条编辑 + 勾选采纳/丢弃 + 标注置信度/ADD·UPDATE/疑似重复 + 查看原始会话 + 质量门标红），phase 9 落地。
- **三条红线③「AI 产出永远先进 draft，人工确认才 published」** —— phase 9 是这条红线的执行闸口（session→permanent 唯一人工闸口），不可全自动确认。
- **status 状态机澄清**：Phase 7 落地 4 态（draft/confirmed/published/invalid），`confirmed` 预留不用（D-9-1），实际状态流转 `draft→published`（确认）/ `draft→物理删`（丢弃）。design §3 原始 5 态的 duplicate/superseded/deleted 不落地——`duplicate_of_exp_id` 列承载关联，supersede 经 invalidate 旧条目 invalid_at，delete 经 hard DELETE。
- **红线③ + design §8「全自动矛盾判定 YAGNI 不做」** → UPDATE 旧条目命运必须人工逐条拍板（D-9-2），不自动 supersede。

</specifics>

<deferred>
## Deferred Ideas

- **经验板块页**（浏览/筛选/搜索/手动 CRUD/标失效）→ **Phase 10**（BROWSE-01/02/03/04）。phase 9 published 经验充实列表，但浏览页本身独立。
- **AI 检索复用**（SQL 粗筛 + LLM 精排 + read-time 验证 + 引用溯源）→ **Phase 11**（RETRIEVE-01/02/03）。phase 9 published 经验进检索池。
- **commandSafety 联动验证** → **Phase 11** read-time 才用。
- **消息段精锚**（source_event_ids 高亮产生经验的具体消息段）→ **二期**（FUTURE-03）。phase 9 只整会话溯源。
- **经验↔经验关联图可视化** → **二期**（FUTURE-04）。
- **确认后 published 经验的手动编辑/标失效** → **Phase 10** 浏览页（phase 9 只管 draft→published 闸口，不动已 published 经验）。

</deferred>

---

*Phase: 9-Human Review & Confirmation*
*Context gathered: 2026-08-03*
