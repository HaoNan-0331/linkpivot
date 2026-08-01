# AI 对话经验总结功能 — 设计文档

> **日期**：2026-08-01
> **项目**：network_toplogy
> **状态**：设计完成，待进入 GSD 计划阶段
> **调研支撑**：`.planning/research/2026-08-01-experience-summary-research.md`（55 个同类项目深读）

---

## 0. 功能目标

每个 AI 对话窗新增「经验总结」入口。用户与 AI 对话完成后点击，AI 回顾整段会话，针对产品/环境总结出结构化经验，经人工逐条确认后存入知识库的「经验板块」（新增），并供后续对话 AI 检索复用。

**核心价值**：把一次性的运维对话沉淀为可检索、可溯源、防过期、防泄密的长期经验资产。

---

## 1. 已定决策汇总

| # | 决策 | 选定 |
|---|------|------|
| 1 | 经验存储与用途 | 结构化表 + 独立浏览页 + AI 检索复用（不上向量库，FTS5+LLM 精排） |
| 2 | 产出与确认 | AI 起草（可拆多条）→ 弹窗逐条编辑/勾选 → 确认入库 |
| 3 | 分类体系 | 固定枚举分类（troubleshooting/best_practices/product/env）+ 自由标签 |
| 4 | 设备关联 | 可选关联（多对多） |
| 5 | 字段深度 | 按分类区分：troubleshooting 用重模板，其他轻结构 |
| 6 | 时效管理 | bi-temporal 双时间窗（valid_at / invalid_at 软失效） |
| 7 | 复用验证 | MVP 即做 read-time 即时验证（设备状态 + commandSafety 白名单 + 有效期） |
| 8 | 去重判定 | 起草前查存量，AI 判定 ADD/UPDATE/NOOP |
| — | 直接纳入（无争议） | PII 脱敏前置、status 状态机、provenance 溯源 |

**三条红线**：① 不上向量库；② 不引图数据库；③ AI 产出永远先进 draft，人工确认才 published。

---

## 2. 架构与数据流

**关键事实**（已 codegraph 核实）：
- AI 对话消息已持久化（`ai.ts` 的 `saveChatMessage` 按 `sessionId` 落库）——「回顾会话」数据源现成。
- 现有知识库是 LLM 挑索引式检索（`knowledgeBaseService.search()`），**无 embedding**——经验检索复用这套，不新建向量索引。

**数据流**：
1. 对话完成 → 点「经验总结」
2. main 读该 `sessionId` 全部消息 + 关联 `deviceIds`
3. PII 脱敏 → 查存量去重 → AI 强 schema 起草 1~N 条草稿
4. 弹窗逐条编辑/勾选/质量门校验 → 确认
5. 写 `experiences` 表 + 标记 session「已总结」
6. 后续任意对话，`chat` 检索时把经验纳入检索池，AI 自动引用

**边界**：同一 session 可多次总结（追加不覆盖）；AI 判定无可总结内容时提示而非强产。

---

## 3. 数据模型（为可扩展性设计）

**一张经验主表 + 一张设备关联表**，独立于现有 `kb_*` 文档表（memory vs RAG 物理分库）。

```sql
-- 经验主表 experiences
-- A. 通用必填（数据库列：高频过滤/排序）
exp_id            TEXT PRIMARY KEY     -- 主键，格式 plan 阶段对齐项目 id 规范
category          TEXT NOT NULL        -- 固定枚举：troubleshooting/best_practices/product/env
title             TEXT NOT NULL
content           TEXT NOT NULL        -- 正文 Markdown（轻结构分类仅此字段承载内容）
status            TEXT NOT NULL        -- draft/confirmed/duplicate/superseded/deleted
created_at        TEXT NOT NULL
-- B. 轻结构
tags              TEXT                 -- 自由标签 JSON 数组
-- C. 专属模板区（可扩展核心）
attrs             TEXT                 -- 分类专属结构化字段 JSON，按 category 挂不同模板
                                       -- troubleshooting: {symptom,root_cause,resolution,prevention,severity}
                                       -- 未来加分类/字段只改模板定义，不动表结构
-- D. 元数据/审计/provenance/时效
source_session_id TEXT                 -- provenance：回链产生它的会话
valid_at          TEXT                 -- 事实发生时间（bi-temporal）
invalid_at        TEXT                 -- 失效时间（null=有效，软失效不删）
created_by        TEXT                 -- 系统托管，AI 草稿不可覆盖
modified_by       TEXT
modified_at       TEXT
confidence        REAL                 -- AI 起草置信度
reuse_count       INTEGER DEFAULT 0    -- 被检索复用次数
last_verified_at  TEXT                 -- read-time 验证时间戳
accuracy_feedback TEXT                 -- 准确/部分准确/不准确

-- 设备关联表（轻量图边）
exp_device_rel(exp_id, device_id)      -- 多对多，可选关联
```

**可扩展性**：
- 加新分类 / 给分类加字段 = 改代码层 JSON Schema 模板，不动数据库，老数据兼容。
- 配套 `attrs` 的 JSON Schema 约束（代码层）：AI 起草强制按 schema 输出，质量门按 category 校验（troubleshooting 类要求 symptom/resolution/severity 非空）。
- 检索时 bi-temporal 过滤 `invalid_at IS NULL OR invalid_at > now`。
- 二期平滑接：embedding 向量列/表、`exp_exp_rel` 经验↔经验关联、`source_event_ids` 消息段精锚——都不冲击现有结构。

**迁移**：幂等守卫（`sqlite_master.sql` 特征串判定，不靠 `user_version`），多写包 `db.transaction`，throw 即 ROLLBACK。

---

## 4. AI 起草与检索复用流程

### 起草（点「经验总结」后后台异步）
1. 读会话全部消息 + 关联设备
2. **PII 脱敏**：IP/MAC/账号密码送 LLM 前先脱敏（复用 `****xxxx`）
3. **查存量去重**：按设备/分类查已有经验，AI 判定 ADD（新增）/ UPDATE（更新旧条目）/ NOOP（跳过）
4. **强 schema 起草**：AI 按分类模板强制 JSON 输出，分类锁死固定枚举，反幻觉约束（缺数据标 gap）；可拆 1~N 条，每条带 confidence + reasoning
5. 落 `draft` 态 → 弹窗确认

### 检索复用（后续任意对话，AI 自动）
1. **粗筛**：分类/标签/严重度/关联设备/有效期 SQL 过滤 + FTS5 关键词召回（纯 SQLite）
2. **精排**：候选集喂 LLM 挑相关（复用现有 LLM 挑索引机制）
3. **read-time 即时验证**：复用前核对设备状态 + `commandSafety.isCommandAllowed` 白名单 + 有效期；过期/失效降权或剔除
4. **引用溯源**：AI 回答附引用来源（哪条经验/哪次会话），可一键回查

**可扩展性预留**：LLM 调用走供应商抽象层（不锁死单一模型）；二期向量召回只在「粗筛」平滑叠一路，不动其他环节。

---

## 5. UI 交互

**三个入口**：
1. **AI 对话窗「经验总结」按钮**：输入区/会话工具栏；会话有内容才可点；点击转 loading，异步起草，完成弹通知。
2. **知识库页「经验」Tab**：`KnowledgeBasePage` 顶部 Tab 切换「文档 / 经验」——经验作为知识库下板块，非独立一级菜单。
3. **设备/拓扑节点「关联经验」反查**：设备详情页入口，按设备看运维经验。

**确认弹窗**：草稿列表逐条编辑（标题/分类/内容/模板字段/标签/关联设备）+ 勾选采纳/丢弃；标注置信度、ADD/UPDATE、疑似重复提示；「查看原始会话」回链；质量门缺必填标红；确认后入库 + 标记会话已总结。

**经验板块页**：分类目录树 + 标签云 + 多维筛选（分类/标签/设备/严重度/有效期/状态）+ 关键词搜索 + 经验详情（来源回链/关联设备/复用次数/最后验证时间）+ 手动新增/编辑/标失效。

**状态反馈**：起草 loading；空会话/无可总结提示不强产；LLM 失败可重试不丢总结。

---

## 6. 错误处理

| 风险 | 对策 |
|------|------|
| LLM 幻觉/瞎编命令 | 反幻觉 prompt + 强制 JSON schema + 人工确认闸 + read-time 验证兜底 |
| LLM 限流/超时 | 重试退避 + 断点续传（source_session_id 幂等）+ DEMO_MODE 降级 |
| PII 泄露 | 送 LLM 前强制脱敏（复用 ****xxxx）【红线】 |
| 经验库膨胀/重复 | 起草前查存量 ADD/UPDATE/NOOP + 确认时 Similarity Check |
| 过期经验误导 | bi-temporal 软失效 + read-time 验证 + commandSafety 白名单联动 |
| schema 漂移 | LLM JSON vs 表契约 Drift Gate 校验 |
| 迁移原子性 | throw 即 ROLLBACK + 幂等守卫 |

---

## 7. 测试策略（Vitest）

- `experienceService`：CRUD / ADD-UPDATE-NOOP 判定 / bi-temporal 过滤 / 去重 / 质量门 / `attrs` JSON schema 校验
- AI 起草：mock LLM 验证 prompt 构造、PII 脱敏、JSON 解析、schema 强制
- 检索复用：mock LLM 精排，验证 SQL 粗筛 + read-time 验证 + 引用溯源
- IPC：`secure`/`safe` 鉴权 + 脱敏；迁移幂等性

---

## 8. MVP 范围

**MVP 必做**：经验表+关联表+迁移 / AI 起草三阶段 / 确认弹窗 / 经验板块页（筛选+搜索+手动 CRUD+标失效）/ AI 检索复用（粗筛+精排+read-time 验证+溯源）/ IPC 鉴权+脱敏。

**二期**：embedding 向量召回 / 经验↔经验关联 + 图遍历 / 消息段精锚 / 关联图可视化（React Flow）。

**不做（YAGNI）**：向量库、图数据库（关联表足够）、全自动矛盾判定（永远人工拍板）。

---

## 9. 后续

设计完成。下一步进入 GSD 流程：把这个功能立为一个 phase，产出 SPEC.md / PLAN.md 后再执行。
