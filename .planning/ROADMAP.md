# Roadmap: network_toplogy

## Milestones

- ✅ **v1.0 技术债优化** — Phases 1-6（shipped 2026-07-05，14 REQ 全交付，归档于 `milestones/v1.0-ROADMAP.md`）
- 🚧 **v1.1 AI 对话经验沉淀** — Phases 7-11（in planning，20 REQ）

## Phases

**Phase Numbering:**
- Integer phases (1-6): v1.0 已交付（归档）
- Integer phases (7-11): v1.1 本 milestone 计划工作（继续编号，未 reset）
- Decimal phases (e.g. 7.1): 紧急插入（INSERTED），按数值序执行

<details>
<summary>✅ v1.0 技术债优化 (Phases 1-6) — SHIPPED 2026-07-05</summary>

- [x] Phase 1: Build & Dependency Foundation (1/1 plans) — completed 2026-06-28
- [x] Phase 2: Architecture & DB Migration (3/3 plans) — completed 2026-06-28
- [x] Phase 3: Performance Optimization (3/3 plans) — completed 2026-06-28
- [x] Phase 4: Data / IPC Safety (3/3 plans) — completed 2026-06-28
- [x] Phase 5: Frontend Refactor & Types (4/4 plans) — completed 2026-07-05
- [x] Phase 6: Robustness & Resource Safety (2/2 plans) — completed 2026-07-05

完整 phase details 见 `.planning/milestones/v1.0-ROADMAP.md`。

</details>

### 🚧 v1.1 AI 对话经验沉淀 (Phases 7-11)

- [ ] **Phase 7: Experience Data Layer & Security Baseline** - 经验主表+设备关联表+bi-temporal+attrs 模板+幂等迁移，立 IPC 鉴权/脱敏基线
- [ ] **Phase 8: AI Drafting Pipeline** - 会话回顾→PII 脱敏→查存量去重→强 schema JSON 起草→draft 态
- [x] **Phase 9: Human Review & Confirmation** - 弹窗逐条编辑/勾选 + 质量门硬校验 + 疑似重复提示 + 原始会话溯源回链
- [ ] **Phase 10: Experience Browse Page** - 知识库「经验」Tab + 多维筛选 + 关键词搜索 + 手动 CRUD + 标失效
- [ ] **Phase 11: AI Retrieval & Reuse** - SQL 粗筛 + LLM 精排 + read-time 即时验证 + 引用溯源

## Phase Details

### Phase 7: Experience Data Layer & Security Baseline
**Goal**: 用户的数据有了持久化经验条目的承载（结构化表 + 设备关联 + 时效软失效 + 模板字段），且所有经验 IPC 自始即走鉴权/脱敏网关——为后续起草/确认/浏览/检索铺好安全且可演进的地基。
**Depends on**: Phase 1-6（v1.0 已交付的迁移注册表 + IPC 鉴权 + 加密 + commandSafety 基线）
**Requirements**: EXP-01, EXP-02, EXP-03, EXP-04, SEC-01, SEC-02
**Success Criteria** (what must be TRUE):
  1. 经验条目可被创建/读取，持久化到独立于 kb_* 文档表的 `experiences` 表，含通用列（标题/分类/内容/标签/状态/来源会话）与 `attrs` 模板 JSON 区（troubleshooting 类挂症状/根因/处置/预防/严重度）
  2. 一条经验可关联 0~N 台设备（`exp_device_rel` 多对多），且可按设备反查关联经验
  3. 经验带 bi-temporal 有效期（valid_at/invalid_at），过期软失效（invalid_at 落时间）后不进「有效检索」但保留历史，不物理删除
  4. 所有经验相关 IPC channel 经 `secure`/`safe` 包装（鉴权 + 异常脱敏），凭证/敏感列按现有规范脱敏（renderer 永不收明文凭证），channel 命名 `<domain>:<action>`
  5. 迁移幂等可重跑（`sqlite_master.sql` 特征串守卫，不靠 user_version），多写包 `db.transaction`，throw 即 ROLLBACK，历史数据向后兼容
**Plans**: 2 plans

Plans:
**Wave 1**
- [x] 07-01-PLAN.md — experiences + exp_device_rel 建表迁移（v8 幂等）+ ExperienceService 静态类（CRUD/设备关联/bi-temporal 软失效/attrs 模板校验/字段加密）

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 07-02-PLAN.md — experienceIpc.ts 10 channel 全 secure 包装 + main.ts 注入注册 + preload 暴露 + experience.ts DTO/electron.d.ts 类型

### Phase 8: AI Drafting Pipeline
**Goal**: 用户在与 AI 对话完成后点「经验总结」，AI 自动回顾整段会话、脱敏、查重、按固定分类模板结构化起草 1~N 条 draft 态草稿——不污染存量、不泄密、不乱造分类。
**Depends on**: Phase 7（落 draft 态需 `experiences` 表 + 服务层 + 鉴权基线）
**Requirements**: DRAFT-01, DRAFT-02, DRAFT-03, DRAFT-04
**Success Criteria** (what must be TRUE):
  1. 用户在 AI 对话窗点「经验总结」后，AI 回顾该 sessionId 全部消息，产出 1~N 条 draft 态草稿；AI 判定无可总结内容时提示而非强产空条目
  2. 送 LLM 总结前的会话正文里，IP/MAC/账号密码等 PII 已自动脱敏（复用现有 `****xxxx` 机制），LLM 永不收到明文凭证/IP
  3. 起草前先按设备/分类查存量，AI 对每条草稿判定 ADD（新增）/UPDATE（更新旧条目）/NOOP（跳过），UPDATE/疑似重复在草稿上标注命中条目
  4. AI 输出按固定枚举分类（troubleshooting/best_practices/product/env）+ 分类专属模板强制 JSON schema，分类不超出枚举、字段不瞎编、缺数据标 gap 不强填
  5. 同一 session 可多次总结（追加不覆盖），LLM 限流/失败可重试不丢总结（断点续传以 source_session_id 幂等）
**Plans**: 3 plans

Plans:
**Wave 1**
- [x] 08-01-PLAN.md — v9 迁移加 experiences.duplicate_of_exp_id 列（幂等）+ PII 脱敏 util（D-04 凭证/IPv4/MAC 分级）+ 查重 service（D-02 同分类+设备）+ 扩展 createExperience 接受 duplicateOfExpId（B-1/B-2 方案 A 单语句原子门面写入）

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 08-02-PLAN.md — draftingService 函数式：draftSession 阶段A纯起草 + judgeVerdicts 阶段B按分类窄查复判（W-4 两阶段，D-01 强 schema JSON + 代码校验 + 重试 3 次，反幻觉禁止 [CMD]，W-2 confidence 边界）
- [x] 08-03-PLAN.md — experienceDrafting 两阶段编排 service（读会话→脱敏→阶段A起草→阶段B窄查复判→门面落库不裸 SQL/不吞错）+ experience:summarizeSession IPC secure + AIPage「经验总结」按钮 + W-3 编排单测（SC5 追加不覆盖/NOOP 不落库）

### Phase 9: Human Review & Confirmation
**Goal**: 用户对 AI 起草的每条草稿逐条编辑/勾选/校验后采纳，确认才转 published——人工是 session→permanent 的唯一闸口，质量门阻止残缺条目入库，且每条都能回溯到产生它的原始会话。
**Depends on**: Phase 8（需 draft 态草稿作为输入）
**Requirements**: REVIEW-01, REVIEW-02, REVIEW-03
**Success Criteria** (what must be TRUE):
  1. AI 起草完成后弹窗逐条展示草稿，用户可编辑标题/分类/内容/模板字段/标签/关联设备，并逐条勾选「采纳/丢弃」
  2. 必填项缺失的草稿（如 troubleshooting 缺症状/处置、未选 severity）标红且无法确认入库——质量门硬校验拦在确认按钮前
  3. 每条草稿可一键回链产生它的原始会话（source_session_id 溯源），用户能在确认前查会话原文核对
  4. 确认后条目转 confirmed 态入库，丢弃的条目不留库；UPDATE 判定的草稿确认后落为对存量条目的更新
**Plans**: 3 plans

Plans:
**Wave 1**
- [x] 09-01-PLAN.md — experienceService 新增 confirmDrafts/listDrafts/getSessionMessages（受控接口 + 单事务原子 + service 层质量门兜底）+ 内存 mock DB 单测

**Wave 2** *(blocked on Wave 1)*
- [x] 09-02-PLAN.md — experienceIpc 追加 3 secure channel（experience:confirmDrafts/listDrafts/getSessionMessages）+ preload + DTO + electron.d.ts 三向一致

**Wave 3** *(blocked on Wave 2)*
- [x] 09-03-PLAN.md — ReviewConfirmModal（宽 Modal master-detail + 质量门标红 + 批量提交）+ SessionMessagesModal（只读溯源叠层）+ useAIChat/AIPage/ChatInput 串联（待确认 Badge 角标入口）

### Phase 10: Experience Browse Page
**Goal**: 用户可在知识库的「经验」板块独立浏览、筛选、搜索、手动维护经验，并不只依赖 AI 总结——经验资产可被人工主动管理（新增/编辑/标失效）。
**Depends on**: Phase 7（数据层）+ Phase 9（confirmed 经验充实列表，但页面本身可在数据层就绪后独立可用）
**Requirements**: BROWSE-01, BROWSE-02, BROWSE-03, BROWSE-04
**Success Criteria** (what must be TRUE):
  1. 知识库页顶部新增「经验」Tab，切换后展示经验列表（与「文档」并列，非独立一级菜单）
  2. 用户可按分类/标签/关联设备/严重度/有效期/状态多维筛选，并按关键词搜索经验正文/标题
  3. 用户可在该页手动新增/编辑经验（字段与 AI 起草走同一模板，不依赖 AI 总结流程）
  4. 用户可对经验标记失效（置 invalid_at），失效后从默认有效视图剔除但仍可查（与 EXP-03 软失效一致）
  5. 经验详情页展示来源会话回链、关联设备、复用次数、最后验证时间等元数据
**Plans**: TBD

Plans:
- [ ] 10-01: TBD

**UI hint**: yes

### Phase 11: AI Retrieval & Reuse
**Goal**: 后续任意 AI 对话中，AI 自动检索并引用相关经验辅助回答，且复用前即时验证证据（设备状态/命令白名单/有效期）仍成立、过期/失效自动降权剔除，回答附可回查的引用来源。
**Depends on**: Phase 10（有经验库可供检索）+ Phase 7（bi-temporal 过滤、commandSafety 联动基线）
**Requirements**: RETRIEVE-01, RETRIEVE-02, RETRIEVE-03
**Success Criteria** (what must be TRUE):
  1. 后续 AI 对话检索时，经验库被纳入检索池：SQL 结构化粗筛（分类/标签/严重度/关联设备/有效期）+ 关键词召回，候选集喂 LLM 精排（复用现有 LLM 挑索引机制），AI 自动引用相关经验辅助回答
  2. AI 复用经验前对每条候选即时验证：关联设备当前状态、命令是否仍受 `commandSafety.isCommandAllowed` 白名单支持、valid_at 是否仍在有效期；过期/失效/命令失支持的降权或剔除，刷新 last_verified_at 与 reuse_count
  3. AI 回答附引用来源（哪条经验 exp_id / 哪次会话 sessionId），用户可一键回查经验详情或原始会话
  4. 检索默认只命中有效经验（invalid_at IS NULL OR invalid_at > now），与浏览页软失效语义一致
**Plans**: TBD

Plans:
- [ ] 11-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 7 → 8 → 9 → 10 → 11（v1.0 Phases 1-6 已归档）

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Build & Dependency Foundation | v1.0 | 1/1 | Complete | 2026-06-28 |
| 2. Architecture & DB Migration | v1.0 | 3/3 | Complete | 2026-06-28 |
| 3. Performance Optimization | v1.0 | 3/3 | Complete | 2026-06-28 |
| 4. Data / IPC Safety | v1.0 | 3/3 | Complete | 2026-06-28 |
| 5. Frontend Refactor & Types | v1.0 | 4/4 | Complete | 2026-07-05 |
| 6. Robustness & Resource Safety | v1.0 | 2/2 | Complete | 2026-07-05 |
| 7. Experience Data Layer & Security Baseline | v1.1 | 0/TBD | Not started | - |
| 8. AI Drafting Pipeline | v1.1 | 2/3 | In Progress|  |
| 9. Human Review & Confirmation | v1.1 | 0/TBD | Not started | - |
| 10. Experience Browse Page | v1.1 | 0/TBD | Not started | - |
| 11. AI Retrieval & Reuse | v1.1 | 0/TBD | Not started | - |

---
*Roadmap created: 2026-06-22*
*Last updated: 2026-08-01 — v1.1 milestone roadmap 创建（Phases 7-11，20 REQ 全映射，标准粒度，目标倒推成功标准）*
