# Requirements: network_toplogy

**Defined:** 2026-08-01
**Core Value:** 让运维人员在一个桌面工具内安全地掌握网络拓扑、远程操控设备并获得 AI 辅助分析——拓扑准确呈现与设备安全可控是最高优先级。
**Milestone:** v1.1 AI 对话经验沉淀

## v1.1 Requirements

把一次性的 AI 运维对话沉淀为可检索、可溯源、防过期、防泄密的长期经验资产。三条红线：不上向量库 / 不引图数据库 / AI 产出必经人工确认。

### 经验数据层 (EXP)

- [x] **EXP-01**: 用户可查看/管理持久化经验条目（标题/分类/内容/标签/来源会话）— Phase 7
- [x] **EXP-02**: 经验可关联一台或多台设备（可选）— Phase 7
- [x] **EXP-03**: 经验带 bi-temporal 有效期（valid_at/invalid_at），过期软失效保留历史、不进有效检索 — Phase 7
- [x] **EXP-04**: 经验按分类区分字段深度（troubleshooting 类带症状/根因/处置/预防/严重度模板，其他类轻结构）— Phase 7

### AI 起草 (DRAFT)

- [ ] **DRAFT-01**: 用户点「经验总结」后，AI 回顾整段会话产出 1~N 条经验草稿（draft 态）— Phase 8
- [ ] **DRAFT-02**: 会话中 IP/MAC/账号密码等 PII 送 AI 总结前自动脱敏（复用现有 ****xxxx 机制）— Phase 8
- [ ] **DRAFT-03**: AI 起草前查存量，判定 ADD/UPDATE/NOOP，提示疑似重复 — Phase 8
- [ ] **DRAFT-04**: AI 按固定枚举分类 + 分类模板强制结构化 JSON 输出（不乱造分类/字段）— Phase 8

### 人工确认 (REVIEW)

- [ ] **REVIEW-01**: AI 起草后弹窗逐条编辑（标题/分类/内容/模板字段/标签/关联设备）+ 勾选采纳/丢弃 — Phase 9
- [ ] **REVIEW-02**: 必填项缺失（如 troubleshooting 缺症状/处置）该条标红阻止确认（质量门）— Phase 9
- [ ] **REVIEW-03**: 每条草稿可一键回链产生它的原始会话（溯源）— Phase 9

### 经验板块页 (BROWSE)

- [ ] **BROWSE-01**: 知识库页新增「经验」Tab，展示经验列表 — Phase 10
- [ ] **BROWSE-02**: 按分类/标签/关联设备/严重度/有效期/状态多维筛选 + 关键词搜索 — Phase 10
- [ ] **BROWSE-03**: 用户可手动新增/编辑经验（不只靠 AI 总结）— Phase 10
- [ ] **BROWSE-04**: 用户可将经验标记为失效（invalid_at）— Phase 10

### AI 检索复用 (RETRIEVE)

- [ ] **RETRIEVE-01**: 后续 AI 对话自动检索相关经验并引用辅助回答（SQL 粗筛 + LLM 精排，复用现有 LLM 挑索引机制）— Phase 11
- [ ] **RETRIEVE-02**: AI 复用经验前即时验证（设备状态/commandSafety 白名单/有效期），过期失效降权或剔除 — Phase 11
- [ ] **RETRIEVE-03**: AI 回答附引用来源（哪条经验/哪次会话），可回查 — Phase 11

### 安全 (SEC)

- [x] **SEC-01**: 所有经验相关 IPC 经 secure/safe 鉴权包装 + 异常脱敏 — Phase 7
- [x] **SEC-02**: 经验数据访问遵循现有脱敏规范（凭证不外泄）— Phase 7

## v2 Requirements（二期）

数据量上来后再做，MVP 不阻塞。

### 经验检索增强

- **FUTURE-01**: 经验正文加 embedding 字位，补语义向量召回（Mem0 Multi-signal 融合目标形态：语义+BM25+实体+时间）
- **FUTURE-02**: 经验↔经验关联（caused-by/resolved-by/similar）+ 图遍历检索（沿 exp_device_rel/exp_exp_rel n-hop 扩散）
- **FUTURE-03**: 经验精确到会话内消息段的溯源锚点（source_event_ids）
- **FUTURE-04**: 经验关联图可视化（复用项目 React Flow）

## Out of Scope

明确排除，防止 scope creep。

| Feature | Reason |
|---------|--------|
| 向量库（embedding 基础设施） | 不引入，FTS5 + SQL 结构化过滤 + LLM 精排已达可用精度（design 红线，二期仅加向量列不引独立向量库） |
| 图数据库（Neo4j/FalkorDB） | 关联表足够复刻轻量图边，单机桌面过重（design 红线） |
| 全自动矛盾判定/失效 | 永远人工拍板，AI 仅给失效/合并建议 |
| 对话转笔记式纯导出 | 必须有 LLM 提炼 + 人工确认，不做无总结的搬运 |
| 纯人工录入（无 AI 起草） | AI 起草+人工确认是核心增量价值，不被人工-only 模型带偏 |

## Traceability

每个 v1.1 REQ 映射到唯一 phase（roadmap 创建于 2026-08-01，Phases 7-11）。SEC 横切需求锚定 Phase 7（数据层/服务层/IPC 网关地基），下游 phase 复用其鉴权/脱敏契约。

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXP-01 | Phase 7 | Complete |
| EXP-02 | Phase 7 | Complete |
| EXP-03 | Phase 7 | Complete |
| EXP-04 | Phase 7 | Complete |
| DRAFT-01 | Phase 8 | Pending |
| DRAFT-02 | Phase 8 | Pending |
| DRAFT-03 | Phase 8 | Pending |
| DRAFT-04 | Phase 8 | Pending |
| REVIEW-01 | Phase 9 | Pending |
| REVIEW-02 | Phase 9 | Pending |
| REVIEW-03 | Phase 9 | Pending |
| BROWSE-01 | Phase 10 | Pending |
| BROWSE-02 | Phase 10 | Pending |
| BROWSE-03 | Phase 10 | Pending |
| BROWSE-04 | Phase 10 | Pending |
| RETRIEVE-01 | Phase 11 | Pending |
| RETRIEVE-02 | Phase 11 | Pending |
| RETRIEVE-03 | Phase 11 | Pending |
| SEC-01 | Phase 7 | Complete |
| SEC-02 | Phase 7 | Complete |

**Coverage:**
- v1.1 requirements: 20 total（EXP 4 + DRAFT 4 + REVIEW 3 + BROWSE 4 + RETRIEVE 3 + SEC 2；原文 header 误写 19，traceability 表 20 行佐证为 20）
- Mapped to phases: 20/20 ✓
- Unmapped: 0 ✓

**Phase 分布:**
- Phase 7 (Experience Data Layer & Security Baseline): EXP-01/02/03/04, SEC-01/02 (6)
- Phase 8 (AI Drafting Pipeline): DRAFT-01/02/03/04 (4)
- Phase 9 (Human Review & Confirmation): REVIEW-01/02/03 (3)
- Phase 10 (Experience Browse Page): BROWSE-01/02/03/04 (4)
- Phase 11 (AI Retrieval & Reuse): RETRIEVE-01/02/03 (3)

---
*Requirements defined: 2026-08-01*
*Last updated: 2026-08-01 — Traceability 表回填（roadmap 创建，20/20 REQ 映射 Phases 7-11）*
