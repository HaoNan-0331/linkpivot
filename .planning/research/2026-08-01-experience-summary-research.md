# 运维会话经验沉淀与检索复用 — 调研报告

> **调研日期**：2026-08-01
> **调研方式**：Workflow 多角度并行（8 角度搜索 → 60 候选去重 → 55 深读 → 综合）
> **规模**：69 agents / 324 工具调用 / ~3.2M tokens / ~12 分钟
> **目的**：为 network_toplogy「AI 对话经验总结」功能找同类项目与可借鉴设计

---

## 1. 概述

调研覆盖 50+ 个项目/文献,核心命题是「对话/会话/事件 → 经验/知识沉淀 → 检索复用」。按落地形态可分四大范式:

| 范式 | 核心特征 | 代表项目 |
|------|---------|---------|
| **Agent 长期记忆框架** | 给 LLM/Agent 加持久记忆层,LLM 主动抽取/编辑事实,向量+图混合检索 | Mem0 / Letta(MemGPT) / Graphiti(Zep) / Cognee / Supermemory / MemMachine / ExpeL / Generative Agents |
| **工单/事件转 KB 文档** | 从已解决工单/事件抽取解决方案,聚类去重,AI 起草+人工门后入库 | Zendesk AI / Aisera / RunbookAI / Keep / Conversation Distiller / Dachshund |
| **对话转笔记/导出** | 多平台 AI 对话原样或半结构化导出成 Markdown,纯文件+frontmatter,检索外包 | chatgpt2obsidian / GPT Exporter / ChatArchive / VESTI / chatgpt-to-markdown |
| **运维 runbook/CMDB 平台** | 工程化的 runbook 自动化、IT 文档、资产 source-of-truth | Rundeck / NetBox / ITin1 / Ghost Protocol / Relay / M.O.S.S. |

**关键认知分野**:业界已成熟区分 **memory(随时间演化的事实/经验)** vs **RAG(静态文档块检索)**。运维会话经验天然属于 memory 范畴,而非文档检索。所有「AI 起草+人工确认」范式在 SRE/incident 领域已是行业默认正确路线(FireHydrant/incident.io/Zendesk/Aisera 全这么做),不存在路线争议。

---

## 2. 重点项目/方案清单(按范式归类)

### 范式一:Agent 长期记忆框架

| 项目 | 一句话 | 存储模型 | 检索模型 | 技术栈 | URL |
|------|--------|---------|---------|--------|-----|
| **Mem0** | 面向 Agent 的通用记忆层,Single-pass ADD-only 抽取 | SQL(事实)+Vector(embedding)+可选 Graph 三库分离 | Multi-signal 融合:语义向量+BM25关键词+实体匹配+时间感知 | Python+OpenAI+Qdrant,有 npm SDK | https://github.com/mem0ai/mem0 |
| **Letta(MemGPT)** | 有状态 Agent,OS 内存隐喻,Agent 自编辑记忆 blocks | 三级:Core Memory Blocks+Recall+Archival(dual-write SQL+向量) | Core 块 always-in-context;Archival 主动 tool-call 向量检索 | Python+PostgreSQL/pgvector+TS SDK | https://github.com/letta-ai/letta |
| **Graphiti(Zep)** | 时序知识图谱引擎,bi-temporal 双时间窗 | 属性图:EpisodicNode/EntityNode/EntityEdge(valid_at/invalid_at) | 三路混合:cosine+BM25+BFS 图遍历+cross-encoder 重排 | Python+Neo4j+MCP server | https://github.com/getzep/graphiti |
| **Cognee** | 开源记忆平台,三库分离 | Relational(SQLite)+Vector(LanceDB)+Graph(Kuzu) | recall 单入口,session 缓存→graph→auto-routing | Python+LiteLLM+SQLite | https://github.com/topoteretes/cognee |
| **Supermemory** | memory vs RAG 区分,用户画像双层 | Memory Graph(图+向量+语义边)+结构化行 | Hybrid vector+keyword,containerTag 作用域 | TypeScript+Remix+Drizzle+Postgres | https://github.com/supermemoryai/supermemory |
| **MemMachine** | Episodic+Profile 双层,Ground-truth-preserving | PostgreSQL+pgvector+Neo4j+SQLite | STM→LTM 向量→cluster contextualization→reranker | Python+PostgreSQL+Neo4j | https://github.com/MemMachine/MemMachine |
| **ExpeL**(AAAI 2024) | 经验式学习,从轨迹抽取见解 | 经验池(Faiss)+见解集(文本+重要度) | 轨迹 kNN few-shot;见解全量注入 | Python+Faiss | https://github.com/LeapLabTHU/ExpeL |
| **Generative Agents** | 三因子打分检索+Reflection 反思树 | Memory Stream(ConceptNode+embedding+evidence) | score=α·recency+α·importance+α·relevance | Python+Django | https://github.com/joonspk-research/generative_agents |

**配套论文/综述**:Mem0 论文 arXiv:2504.19413(ADD/UPDATE/DELETE/NOOP 四操作);Zep/Graphiti arXiv:2501.13956(bi-temporal);清华 Awesome-Memory-for-Agents https://github.com/TsinghuaC3I/Awesome-Memory-for-Agents ;Agent Memory Techniques https://github.com/NirDiamant/Agent_Memory_Techniques ;GitHub Copilot agentic memory(citation 真相锚点 + read-time 验证 + 自我愈合)https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/

### 范式二:工单/事件转 KB 文档

| 项目 | 一句话 | 存储模型 | 检索模型 | URL |
|------|--------|---------|---------|-----|
| **Conversation Distiller** | 对话蒸馏成 7 段式 wiki+10 道质量门 | Markdown wiki+Wikilinks,无 DB/向量 | 写时归类(LLM 挑索引)+Wikilink 跳转 | https://github.com/CS-Faith/conversation-distiller |
| **RunbookAI** | SRE 假设驱动六阶段+会话学习闭环 | KnowledgeChunk 五分类+frontmatter 强 schema+ServiceGraph | 混合:向量+BM25+结构化过滤 | https://github.com/Runbook-Agent/RunbookAI |
| **Keep** | AIOps 告警聚合,fingerprint 去重 | 关系库,alert+incident | 结构化过滤+AI 喂全量上下文 | https://github.com/keephq/keep |
| **Zendesk AI** | 工单+生成式 AI 自动建帮助中心 | 文档式(草稿→审核→发布) | 文档+分类(无 embedding) | https://support.zendesk.com/hc/en-us/articles/9409324793498 |
| **Aisera** | 工单评论→KB,8 步流水线+Similarity Check | KB 文档+tags+Status+Similar 计数 | Similarity Check 比对 committed 库 | https://docs.aisera.com/aisera-platform/content-generation-from-tickets |
| **Support KB 博客** | 工单→KB 是去重/选优,双层 KB+canonical 打分 | Postgres 单宽表+content_hash+dup_cluster_id+embedding | curated vs ticket 同库不同 flag+recency 衰减 | https://muhammadamal.my.id/blog/building-a-support-knowledge-base-from-zendesk-and-jira/ |
| **Dachshund** | 工单集群→文档缺口→draft PR,JSON state 解耦 | per-topic JSON state+Confluence+draft PR | 纯 LLM 挑索引读 state,无向量 | https://github.com/HassData/dd-claude-skills |
| **incident.io 综述** | 三代演进 Static→Scripted→Intelligent | 可查询索引+Service Catalog 关系图 | "Have we seen similar issues before?" 相似匹配 | https://incident.io/blog/runbook-automation-tools-2026-the-complete-guide |

### 范式三:对话转笔记/导出

| 项目 | 一句话 | 存储模型 | 检索模型 | URL |
|------|--------|---------|---------|-----|
| **VESTI(心迹)** | Local-First AI 对话中台,决策链可观测 | IndexedDB+768 维向量列+6 外键表 | 本地向量 RAG+全文+图谱+溯源 | https://github.com/imxiaotaoya/VESTI |
| **WeLoom** | 多平台 IM→报告压缩+人格蒸馏 | SQLite+FTS5+trigram+LIKE 三层降级,无向量 | 多路融合+`--show-trace` 可审计 | https://github.com/clearyss/weloom |
| **ChatArchive** | AI 对话存档点扩展 | chrome.storage 结构化+7 预设分类+#tag | 全文+标签云(无 embedding) | https://github.com/yz-jun/ChatArchive |
| **chatgpt2obsidian** | ChatGPT 导出→Obsidian MD,主线抽取 | Markdown+YAML frontmatter,幂等 | 外包 Obsidian 全文 | https://github.com/knu/chatgpt2obsidian |
| **chatgpt-to-markdown** | 导出→静态托管 MD,DAG 线性化+SHA-256 去重 | MD 文件树+frontmatter+index.md | 外包静态站点 | https://github.com/difegam/chatgpt-to-markdown |

### 范式四:运维 runbook/CMDB 平台(技术栈同构对照组)

| 项目 | 一句话 | URL |
|------|--------|-----|
| **Rundeck** | runbook 自动化,Job 模板+审计四字段+Job Reference | https://github.com/rundeck/rundeck |
| **NetBox** | 网络基础设施 source-of-truth,JournalEntry 任意挂对象+Change Logging | https://github.com/netbox-community/netbox |
| **Ghost Protocol** | **Electron+React+better-sqlite3** IT Helpdesk(栈与本项目几乎一致) | https://github.com/moner-dev/ghost-protocol-helpdesk |
| **Relay** | Electron 运维指挥中心,实体级 notes+tagged notes+Zod IPC 校验+限流 | https://github.com/CrimsonSoul/Relay |
| **M.O.S.S.** | IT 资产+文档平台,关系优先+故障排查标准链路模板 | https://github.com/christag/moss |
| **ITin1** | 资产/凭证/IPAM/文档四合一,IT Change Log | https://github.com/chrisnicholldev/ITin1 |

---

## 3. 关键设计模式提炼(跨项目共性)

### 3.1 总结触发方式
- **写时归类**:Conversation Distiller/kb-generator 写入时 LLM 把新会话匹配到已有集群——与本项目「LLM 挑索引无 embedding」同源。
- **累计阈值触发**:Generative Agents 累计 importance 超阈值触发 Reflection。
- **会话结束钩子**:RunbookAI `learn <session-id>`、ChatArchive「保存存档点」按钮。

### 3.2 人工确认 vs 自动(业界共识:全人工门)
所有生产级方案坚持 **AI 起草 + 人工确认**(draft/published 双状态):Zendesk 草稿落库→admin 审核才发布;Aisera 无重复才自动 approve;incident.io 即便能自动起草 PR 也坚持人工 confirm;RunbookAI knowledge-suggestions 带 confidence/reasoning。

### 3.3 结构化 vs 向量(无 embedding 也能跑通)
- **结构化硬过滤 + LLM 精排** 与现状最契合:Graphiti SearchFilters、Cognee auto-routing、Dachshund 纯 LLM 读 JSON state,均证明「不上向量库也能跑」。
- **混合检索(语义+BM25+实体+时间)** 是目标形态,但 WeLoom 的 FTS5→trigram→LIKE 三层降级证明纯 SQL 倒排也能达到可用精度。

### 3.4 分类体系(固定 + 自由双轨)
**固定枚举分类 + 自由标签** 是行业标配:ChatArchive(7 预设+#tag)、MemMachine(tag→feature→value)、M.O.S.S.(16 对象×分类)。分类内嵌内容(Memos #tag 写正文即抽取)降低录入摩擦。强制约束在固定分类内(Cognee ontology)避免 LLM 发明分类。

### 3.5 与实体关联(关系是一等公民)
- **provenance/溯源** 是质量命脉:Graphiti Episode 双向索引、MemMachine citations、Copilot citation file:line、RunbookAI source_id。
- **可选关联设备 = 轻量图边**:Graphiti group_ids、NetBox GenericRelation,映射到 better-sqlite3 一张关联表即可,无需图数据库。

### 3.6 时效性与防过期(运维场景刚需)
- **bi-temporal 双时间窗**(Graphiti):valid_at/invalid_at,事实失效不删除保留历史。
- **软失效而非覆盖**(Mem0 additive):新值进来旧值标记 invalid。
- **read-time 即时验证**(Copilot):复用前回查证据是否仍成立,矛盾则修正。
- **staleness 衰减**:陈旧经验引用废弃命令是高危负债,自动降权。

### 3.7 抗噪去重(防经验库膨胀)
多级去重:Support KB(SHA-256+MinHash LSH)、Graphiti(精确→LSH→LLM 裁决)、Aisera(Similarity Check)。指纹去重(Keep FINGERPRINT_FIELDS)。投票收敛(ExpeL ADD/EDIT/UPVOTE/DOWNVOTE 归零删除)。

### 3.8 抽取范式(原子事实 vs 整段摘要)
- **原子事实型**(Mem0、MemMachine profile fact):一条=一个可复用知识点,最适合「AI 起草+人工逐条确认」。
- **结构化模板型**(Conversation Distiller 7 段、incident-postmortem 8 段):强制 schema 输出。
- **双轨**(ExpeL 轨迹+见解、Generative Agents 观察+Reflection):具体案例 + 抽象法则分层。

---

## 4. 对 network_toplogy 的落地启发(核心)

### 4.1 落地总原则

基于已定方向(Electron+React+better-sqlite3 / AI 对话已持久化消息带 sessionId / 现有知识库 LLM 挑索引无 embedding / 经验=结构化表+独立浏览页+AI 检索复用 / 固定枚举分类+自由标签 / 可选关联设备 / AI 起草+人工逐条确认),确立三条红线:
1. **不上向量库**(LLM 挑索引 + SQL 结构化过滤 + 可选 FTS5 即可达可用精度,WeLoom/Dachshund/NetBox 已验证);预留 embedding 字段位供二期。
2. **不引入图数据库**(关联设备用一张多对多关联表复刻 Graphiti group_ids / NetBox GenericRelation)。
3. **AI 产出永远先进 draft 态,人工确认才转 published**。

### 4.2 经验条目数据模型(SQLite 表设计)

综合 Rundeck 审计四字段 + Graphiti bi-temporal + Conversation Distiller 7 段模板 + MemMachine citations + RunbookAI schema:

```
exp_id            TEXT PK        (EXP-YYYYMMDD-NNN)
category          TEXT NOT NULL  (固定枚举:troubleshooting/best_practices/commands/templates,
                                  对齐现有 experience_knowlegdge 四子目录)
tags              TEXT           (自由标签,JSON 数组,#tag 风格)
title             TEXT NOT NULL
symptom           TEXT           (症状/现象——Conversation Distiller「症状→原因→修复」)
root_cause        TEXT           (根因一句话——incident-postmortem direct cause)
resolution        TEXT           (处置步骤/命令——Markdown 正文)
prevention        TEXT           (复发预防/action item)
severity          TEXT           (S0-S3)
source_session_id TEXT           (provenance:回链到产生它的会话)
source_event_ids  TEXT           (会话内关键交互段锚点)
status            TEXT           (draft/confirmed/duplicate/superseded/deleted)
valid_at          TEXT           (事实发生时间——Graphiti valid_at)
invalid_at        TEXT           (失效时间——Graphiti 软失效)
created_by        TEXT           (系统托管不可手改——Rundeck 审计)
created_at        TEXT
modified_by       TEXT
modified_at       TEXT
confidence        REAL           (AI 起草置信度)
reuse_count       INTEGER        (被检索复用次数)
last_verified_at  TEXT           (Copilot read-time 验证时间戳)
accuracy_feedback TEXT           (准确/部分准确/不准确)
```

关联表(轻量图):`exp_device_rel(exp_id, device_id)` 多对多;`exp_exp_rel(exp_id, exp_id, rel_type)` 经验↔经验(caused-by/resolved-by/similar)。

**关键设计依据**:bi-temporal 软失效解决运维知识易过时;provenance 强制挂 source_session_id 可一键回溯(契合 IPC 鉴权+强审计基因);审计四字段系统托管不可被 AI 覆盖;已确认经验可置只读(Letta read_only)防 AI 改写。

### 4.3 AI 起草工作流(三阶段解耦)

借鉴 RunbookAI「会话事件落地 → 异步 learn 跑总结」+ ExpeL 三阶段:

- **阶段一 采集(已有)**:消息已持久化带 sessionId。会话结束/人工触发「总结经验」时写入待总结候选池,带设备上下文+命令执行结果。
- **阶段二 起草(AI 异步)**:LLM 输出**强制 JSON** 一次性产出 `{category, tags, title, symptom, root_cause, resolution, prevention, severity, suggested_device_ids, confidence, reasoning}`;分类强制约束在固定枚举内;关联设备自动建议(从会话识别设备名/IP/MAC 规范化对齐 device_id);**起草前 context lookup 去重**(按设备/分类查已有经验);**状态机四操作**(ADD/UPDATE/DELETE/NOOP,人工只 review 这四类建议)。产出落 `status=draft`。
- **阶段三 确认(人工逐条)**:**质量门硬校验**(症状非空、有可执行 action、关联设备已填、severity 已选);**Similarity Check** 显示疑似重复命中条目;**证据回查**按钮一键跳回原始会话;**反幻觉约束**写进 prompt(缺数据标 gap 不瞎编、冲突两条都记并标 review)。确认后 `status=confirmed`。

### 4.4 检索复用设计(双通道)

**人工浏览通道(主)**:独立浏览页(分类目录树+标签云+severity 多维筛选);Shortcuts 固化常用过滤(Memos);**关联反查**(设备详情页反查关联经验,NetBox 关系面板);关联图可视化(项目已有 React Flow 替代 ECharts)。

**AI 检索复用通道(辅,query-aware + 结构化过滤)**:
1. **结构化硬过滤粗筛**(SQL where):category/tags/severity/关联设备/valid_at 时间窗 + FTS5 关键词召回(WeLoom 三层降级,纯 SQLite 无新依赖)。
2. **LLM 在候选集精排**(现状 LLM 挑索引)。
3. **可选图遍历增强**(Graphiti BFS):以当前设备为种子沿 exp_device_rel+exp_exp_rel n-hop 扩散。
4. **检索结果带 source 标签**(分类/标签/关联设备/置信度)。
5. **引用溯源防幻觉**(VESTI Epistemologically Honest RAG):AI 输出附引用哪条经验/哪次会话。

### 4.5 复用时的 read-time 即时验证(Copilot 范式,强烈建议)

运维经验强时效,**复用前必须验证证据是否仍成立**:AI 复用经验前对每条候选即时验证——核对 source_session_id 关联设备当前状态、命令是否仍受 `commandSafety.isCommandAllowed` 白名单支持、valid_at 是否仍在有效期内。三结局:矛盾→存修正版标 superseded;有效→刷新 last_verified_at 和 reuse_count;失效→降权。与项目已有 commandSafety 安全层天然契合(可把「该经验对应命令风险等级」作为经验字段,检索复用时作执行护栏)。

### 4.6 双层记忆模型(session vs permanent)

照搬 Cognee/MemMachine 双层:**session 层**(AI 对话原始消息,已持久化,ground-truth 不可变,作经验可追溯来源)+ **permanent 层**(确认后的经验条目)。两层物理分离,人工确认是唯一从 session→permanent 的闸口。

### 4.7 工程韧性(批量沉淀场景)

- **断点续传**(source_session_id 作幂等键,重跑安全)。
- **会话预处理清洗**(去 ANSI 控制字符、mojibake 修复、过滤低价值片段)。
- **源头准入门槛**(只入库「问题真正解决」的会话,排除失败/未解决)。
- **PII 脱敏前置**(运维会话含 IP/MAC/账号密码,送 LLM 前强制脱敏,复用项目已有 `****xxxx` 脱敏/`encField` 解密后再脱敏)。
- **供应商抽象层**(起草流水线不被某一 LLM 锁死)。
- **DEMO_MODE**(无 LLM Key 也能跑通全流程的离线演示态)。
- **限流重试**(批量调 LLM 时缓存 key+限流抖动+重试退避)。

### 4.8 schema 演进守护

**Drift Gate**(VESTI):LLM 结构化输出与 SQLite 表契约间做漂移检测。state schema 当一等公民(Dachshund):经验条目 schema 版本化与迁移,沿用项目迁移规范(幂等守卫 + sqlite_master.sql 特征串判定,不靠 user_version)。

### 4.9 不做清单(明确边界)

- 不照搬 embedding 向量栈(与现状冲突)。
- 不照搬 Neo4j/FalkorDB 图数据库(单机桌面过重,关联表足够)。
- 不照搬 Notion AI 检索外包(运维数据安全合规,坚持本地检索主权)。
- 不照搬纯转换无提炼(只搬运不总结,本项目必须补 LLM 提炼+人工确认)。
- 不照搬纯人工录入(Ghost Protocol/M.O.S.S. 无 AI 抽取,「AI 起草+人工确认」是超越它们的增量价值)。
- 不照搬全自动 LLM 矛盾判定(矛盾判定应「AI 给失效建议、人工拍板」)。

### 4.10 落地优先级建议(MVP → 演进)

**MVP(必做)**:
1. 经验表+关联表(bi-temporal+provenance+审计四字段)。
2. AI 起草三阶段工作流(采集→JSON 强 schema 起草→draft 态)。
3. 人工确认界面(质量门硬校验+Similarity Check+证据回查)。
4. 双通道检索(人工浏览多维筛选+AI 检索 FTS5 粗筛+LLM 精排+引用溯源)。
5. read-time 即时验证(复用前核对设备状态+commandSafety 白名单)。

**二期(数据量上来后)**:6. embedding 字位补语义向量召回;7. 图遍历检索;8. 多跳 ReAct 检索。

**长期(可选)**:9. 知识图谱三元组;10. Reflection 反思树。

---

## 5. 参考链接

### 范式一:Agent 长期记忆框架
- https://github.com/mem0ai/mem0
- https://docs.mem0.ai/core-concepts/how-it-works
- https://arxiv.org/html/2504.19413v1
- https://github.com/letta-ai/letta
- https://github.com/getzep/graphiti
- https://arxiv.org/abs/2501.13956
- https://github.com/topoteretes/cognee
- https://github.com/supermemoryai/supermemory
- https://github.com/MemMachine/MemMachine
- https://github.com/LeapLabTHU/ExpeL
- https://github.com/joonspk-research/generative_agents
- https://github.com/NirDiamant/Agent_Memory_Techniques
- https://github.com/TsinghuaC3I/Awesome-Memory-for-Agents
- https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/

### 范式二:工单/事件转 KB
- https://github.com/CS-Faith/conversation-distiller
- https://github.com/Runbook-Agent/RunbookAI
- https://github.com/keephq/keep
- https://support.zendesk.com/hc/en-us/articles/9409324793498
- https://docs.aisera.com/aisera-platform/content-generation-from-tickets
- https://muhammadamal.my.id/blog/building-a-support-knowledge-base-from-zendesk-and-jira/
- https://github.com/HassData/dd-claude-skills
- https://incident.io/blog/runbook-automation-tools-2026-the-complete-guide
- https://github.com/PSavvateev/kb-generator
- https://github.com/Pls-1q43/ChatGPT-Chat-History-To-Notion
- https://github.com/abhayjoshi201/AWS-RAG-Support-Engine
- https://github.com/bigdatavik/databricks-ai-ticket-vectorsearch
- https://arxiv.org/html/2607.00003v1
- https://www.akkodis.com/en/blog/articles/how-knowledge-graphs-power-agentic-it-operations
- https://github.com/agamm/awesome-ai-sre
- https://python.langchain.com/docs/versions/migrating_memory/chat_history/

### 范式三:对话转笔记/导出
- https://github.com/imxiaotaoya/VESTI
- https://github.com/clearyss/weloom
- https://github.com/yz-jun/ChatArchive
- https://github.com/Duang777/GPT-Voyager
- https://github.com/knu/chatgpt2obsidian
- https://github.com/difegam/chatgpt-to-markdown
- https://github.com/cs224/chatgpt-conversation-extractor
- https://github.com/WebDevBooster/gpt-exporter
- https://github.com/adamlporter/obsidian-AI-exporter

### 范式四:运维 runbook/CMDB 平台
- https://github.com/rundeck/rundeck
- https://github.com/netbox-community/netbox
- https://github.com/moner-dev/ghost-protocol-helpdesk
- https://github.com/CrimsonSoul/Relay
- https://github.com/christag/moss
- https://github.com/chrisnicholldev/ITin1
- https://github.com/usememos/memos
