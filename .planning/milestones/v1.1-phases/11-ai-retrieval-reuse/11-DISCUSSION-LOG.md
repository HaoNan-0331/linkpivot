# Phase 11: AI Retrieval & Reuse - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-06
**Phase:** 11-AI Retrieval & Reuse
**Areas discussed:** 检索触发方式, 粗筛索引(FTS5 vs LIKE), read-time 验证深度与降级, 引用溯源呈现

---

## 议题 A：检索触发方式（AI 何时去翻经验库）

### A-Q1：触发方式架构

| Option | Description | Selected |
|--------|-------------|----------|
| a. AI 自主标记 | 复用 [KB_SEARCH] 文本协议加 [EXP_SEARCH]，AI 自己决定何时查，与 KB 一致 | |
| b. 每轮自动预取 | 每句话后台自动粗筛+精排注入，AI 必见经验不漏，但每轮多一次检索 | |
| c. 混合 | 每轮轻量 SQL 注入 + AI 可 [EXP_SEARCH] 深挖，覆盖全但最复杂 | |

**User's choice:** b + 阈值防御（每轮自动预取 → 粗筛 → LLM 精排 → 阈值过滤 → 够分注入/不够分干净不塞）
**Notes:** 用户初次提问时主动澄清：担忧"找不到相关经验会不会影响 AI / 不相关经验塞进去会不会误导 AI"（噪声污染）。解释"相关度阈值 + 精排语义理解"双层防御（找不到就干净不塞、不相关被阈值挡）后，用户确认选 b+阈值。澄清了"防噪声不是 a vs b 的区别，两种都要精排+阈值，区别只在触发时机"。

### A-Q2：用户没勾选设备时的粗筛策略

| Option | Description | Selected |
|--------|-------------|----------|
| i. 全库关键词 | 用问题关键词全库匹配 title/content/tags/分类，覆盖通用经验 | |
| ii. 没设备就不查 | 没勾设备这轮跳过，简单但漏通用经验 | |
| iii. AI 提取关键词 | 让 AI 先从问题提取关键词再查，精准但多一次 LLM | |

**User's choice:** iii. AI 提取关键词（语义）
**Notes:** 用户重视精准，不想无脑全库 SQL 匹配。但进一步澄清实现成本后（见 A-Q3）改为 Y（精排承担理解）。

### A-Q3：「AI 提取关键词」的实现方式

| Option | Description | Selected |
|--------|-------------|----------|
| Y. 精排承担理解 | 粗筛用问题原文宽匹配捞候选 → 精排 AI 语义理解+挑相关+阈值。每轮 2 次 LLM | ✓ |
| X. 独立提取两步 | 先 AI 提取关键词 → 粗筛 → 精排 → 答。每轮 3 次 LLM，最贵 | |

**User's choice:** Y. 精排承担理解
**Notes:** 澄清"精排 AI 本就要理解问题才能打分"，独立提取步骤冗余。Y 已满足"精准"诉求（精排语义理解 + 阈值），且每轮省一次 LLM。用户的"AI 提取关键词"本意 = 让 AI 语义理解后再查，Y 天然实现。

---

## 议题 B：FTS5 vs SQL LIKE（粗筛索引）

### B-Q1：粗筛用 LIKE 还是 FTS5

| Option | Description | Selected |
|--------|-------------|----------|
| 1. LIKE + 精排 | 复用 Phase 10 search，相关性靠精排兜底。零迁移 | ✓ |
| 2. 上 FTS5 | 建 experience_fts 虚拟表+trigger，分词召回更全，但需迁移+SQLite 中文分词坑 | |
| 3. 二期再说 | MVP 用 LIKE，数据量上来后连同向量召回一起升级 | |

**User's choice:** 1. LIKE + 精排
**Notes:** 关键洞察——议题 A 已定 LLM 精排兜底相关性，粗筛的"排序"不重要了，FTS5 最大卖点（相关性排序）被削弱。叠加 SQLite FTS5 默认中文分词按字拆（要 jieba 需 C 扩展，better-sqlite3 麻烦）+ 经验量级小 LIKE 够快。**修订 design 红线①字面「FTS5」→ LIKE + 精排**，理由记入 CONTEXT。

---

## 议题 C：read-time 验证深度与降级（AI 复用经验前怎么"当场验货"）

### C-Q1：验证失败时降权还是剔除

| Option | Description | Selected |
|--------|-------------|----------|
| 1. 分类降级 | 设备异常/命令失支持→降权标注；有效期失效→剔除 | ✓ |
| 2. 统一降权 | 所有失败都降权标注不剔除，最大化信息但过期经验可能误导 | |
| 3. 严格剔除 | 任一项失败就剔除，最安全但设备临时离线就丢经验太激进 | |

**User's choice:** 1. 分类降级
**Notes:** 运维场景设备临时离线常见，不能因此丢弃有价值的排查经验；但有效期失效（人工标 invalid）该剔除。

### C-Q2（修订）：经验检索要挂钩设备实时状态吗？

| Option | Description | Selected |
|--------|-------------|----------|
| α. 去掉设备状态 | read-time 只验 commandSafety + 有效期两项，不验设备状态 | ✓ |
| β. 改为纯信息标注 | 仍查设备状态但只作上下文告诉 AI，不影响检索/排序 | |
| γ. 维持原设计 | 仍验设备状态 + 降权 | |

**User's choice:** α. 去掉设备状态
**Notes:** **关键澄清转折**——用户质疑"经验为什么要和设备实时状态挂钩"。分析后发现原设计反逻辑：(1) 设备状态是瞬时外部环境，经验是长期知识资产，因果对不上；(2) **反逻辑案例**：用户问"core-sw-01 突然离线怎么办"→ 经验关联 core-sw-01（离线）→ 若降权/剔除 → AI 反而拿不到最相关的排查经验。结论：设备在不在线不改变经验（方法论）是否成立。**SC2 原三项 → 两项**（commandSafety + 有效期）。做减法，去过度设计。

---

## 议题 D：引用溯源呈现（AI 回答怎么标"参考自哪里"）

### D-Q1：引用标注形式

| Option | Description | Selected |
|--------|-------------|----------|
| 1. 末尾来源列表 | AI 正文正常写，末尾附来源列表，每条可点回查 | ✓ |
| 2. 脚注式 [1][2] | 正文标 [1][2]，文末按编号列来源，对应清晰但 prompt 复杂 | |
| 3. 行内可点卡片 | 引用嵌正文，点开弹详情，最直观但实现最复杂 | |

**User's choice:** 1. 末尾来源列表
**Notes:** 运维回答综合多条经验得出，逐句标脚注不现实；末尾列表干净 + 可点回查足够。

### D-Q2：末尾来源列表列哪些经验？

| Option | Description | Selected |
|--------|-------------|----------|
| i. 注入全部 | 列本次精排注入的全部，从注入记录拿，不需 AI 标记 | ✓ |
| ii. AI 标实际用到 | AI 回答时标注实际引用了哪几条，精确但复杂 | |

**User's choice:** i. 注入全部
**Notes:** b 方案关键简化——后台自动预取 = service 已知注入哪些经验，引用直接复用注入记录，不需 AI 标记（比 [KB_SEARCH] 简单）。多列一两条 AI 没用到的无害。点击回查复用 Phase 10 ExperienceDetailModal + Phase 9 SessionMessagesModal（不新建）。

---

## Claude's Discretion

- 注入条数上限 / context 预算（参考 Phase 8 W-4 ≤50 防溢出）
- 相关度阈值具体值
- 精排 prompt 设计（强 schema JSON + 评分 + 反幻觉，复用 draftingService 模式）
- 命令提取范围（经验无结构化 command 字段，正文扫描，风险标注）
- reuse_count / last_verified_at 刷新时机
- 检索节流 / 缓存（MVP 可不做）
- 空经验库短路
- IPC 通道设计（倾向编排层串联不新增 IPC）
- 降权标注对 AI 的 prompt 处理
- 验证执行位置

## Deferred Ideas

- FTS5 / embedding 向量召回 → 二期 FUTURE-01
- 设备状态实时验证 / 实时探测 → 二期
- 经验结构化 command 字段（attrs.command[]）→ 二期
- 检索节流 / 缓存 → 可选
- AI 标实际引用（脚注式精确逐句）→ 未来

---

*Discussion conducted: 2026-08-06*
*Two key clarify turns: (1) noise pollution concern → b+阈值双层防御; (2) "why hook device status" → removed device status (reverse-logic finding), SC2 three→two items.*
