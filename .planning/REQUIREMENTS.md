# Requirements: network_toplogy

**Defined:** 2026-08-01
**Core Value:** 让运维人员在一个桌面工具内安全地掌握网络拓扑、远程操控设备并获得 AI 辅助分析——拓扑准确呈现与设备安全可控是最高优先级。
**Milestone:** v1.1 AI 对话经验沉淀

## v1.1 Requirements

把一次性的 AI 运维对话沉淀为可检索、可溯源、防过期、防泄密的长期经验资产。三条红线：不上向量库 / 不引图数据库 / AI 产出必经人工确认。

### 经验数据层 (EXP)

- [ ] **EXP-01**: 用户可查看/管理持久化经验条目（标题/分类/内容/标签/来源会话）
- [ ] **EXP-02**: 经验可关联一台或多台设备（可选）
- [ ] **EXP-03**: 经验带 bi-temporal 有效期（valid_at/invalid_at），过期软失效保留历史、不进有效检索
- [ ] **EXP-04**: 经验按分类区分字段深度（troubleshooting 类带症状/根因/处置/预防/严重度模板，其他类轻结构）

### AI 起草 (DRAFT)

- [ ] **DRAFT-01**: 用户点「经验总结」后，AI 回顾整段会话产出 1~N 条经验草稿（draft 态）
- [ ] **DRAFT-02**: 会话中 IP/MAC/账号密码等 PII 送 AI 总结前自动脱敏（复用现有 ****xxxx 机制）
- [ ] **DRAFT-03**: AI 起草前查存量，判定 ADD/UPDATE/NOOP，提示疑似重复
- [ ] **DRAFT-04**: AI 按固定枚举分类 + 分类模板强制结构化 JSON 输出（不乱造分类/字段）

### 人工确认 (REVIEW)

- [ ] **REVIEW-01**: AI 起草后弹窗逐条编辑（标题/分类/内容/模板字段/标签/关联设备）+ 勾选采纳/丢弃
- [ ] **REVIEW-02**: 必填项缺失（如 troubleshooting 缺症状/处置）该条标红阻止确认（质量门）
- [ ] **REVIEW-03**: 每条草稿可一键回链产生它的原始会话（溯源）

### 经验板块页 (BROWSE)

- [ ] **BROWSE-01**: 知识库页新增「经验」Tab，展示经验列表
- [ ] **BROWSE-02**: 按分类/标签/关联设备/严重度/有效期/状态多维筛选 + 关键词搜索
- [ ] **BROWSE-03**: 用户可手动新增/编辑经验（不只靠 AI 总结）
- [ ] **BROWSE-04**: 用户可将经验标记为失效（invalid_at）

### AI 检索复用 (RETRIEVE)

- [ ] **RETRIEVE-01**: 后续 AI 对话自动检索相关经验并引用辅助回答（SQL 粗筛 + LLM 精排，复用现有 LLM 挑索引机制）
- [ ] **RETRIEVE-02**: AI 复用经验前即时验证（设备状态/commandSafety 白名单/有效期），过期失效降权或剔除
- [ ] **RETRIEVE-03**: AI 回答附引用来源（哪条经验/哪次会话），可回查

### 安全 (SEC)

- [ ] **SEC-01**: 所有经验相关 IPC 经 secure/safe 鉴权包装 + 异常脱敏
- [ ] **SEC-02**: 经验数据访问遵循现有脱敏规范（凭证不外泄）

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

roadmap 创建时填充（每个 REQ 映射到唯一 phase）。

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXP-01 | — | Pending |
| EXP-02 | — | Pending |
| EXP-03 | — | Pending |
| EXP-04 | — | Pending |
| DRAFT-01 | — | Pending |
| DRAFT-02 | — | Pending |
| DRAFT-03 | — | Pending |
| DRAFT-04 | — | Pending |
| REVIEW-01 | — | Pending |
| REVIEW-02 | — | Pending |
| REVIEW-03 | — | Pending |
| BROWSE-01 | — | Pending |
| BROWSE-02 | — | Pending |
| BROWSE-03 | — | Pending |
| BROWSE-04 | — | Pending |
| RETRIEVE-01 | — | Pending |
| RETRIEVE-02 | — | Pending |
| RETRIEVE-03 | — | Pending |
| SEC-01 | — | Pending |
| SEC-02 | — | Pending |

**Coverage:**
- v1.1 requirements: 19 total
- Mapped to phases: 0（待 roadmap）
- Unmapped: 19 ⚠️

---
*Requirements defined: 2026-08-01*
*Last updated: 2026-08-01 after v1.1 milestone requirements definition*
