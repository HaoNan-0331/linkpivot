# Phase 11: AI Retrieval & Reuse - Context

**Gathered:** 2026-08-06
**Status:** Ready for planning

<domain>
## Phase Boundary

后续任意 AI 对话中，经验库被纳入检索池——每轮对话自动检索相关经验辅助回答（SQL 粗筛 + LLM 精排 + 相关度阈值过滤），复用前 read-time 即时验证（commandSafety 命令白名单 + 有效期），过期失效降权或剔除，回答末尾附可回查的引用来源（exp_id / sessionId）。检索默认只命中有效经验（invalid_at IS NULL OR > now，与浏览页一致）。刷新 last_verified_at 与 reuse_count。

**In scope（RETRIEVE-01/02/03）：**
- 每轮 AI 对话自动检索经验：SQL 粗筛（分类/标签/严重度/关联设备/有效期 + 关键词）→ LLM 精排（语义理解 + 相关度打分）→ 阈值过滤 → 注入正式回答
- read-time 即时验证：commandSafety 白名单（经验命令是否仍受支持）+ 有效期（invalid_at）；命令失支持降权标注，有效期失效剔除
- 引用溯源：AI 回答末尾来源列表（exp_id/sessionId），点击回查经验详情/原始会话
- reuse_count / last_verified_at 刷新

**Out of scope（属其他 phase / 二期）：**
- 设备状态实时验证 → **本 phase 去掉**（D-11-8，反逻辑；二期如需高精度再加）
- FTS5 全文索引 / embedding 向量召回 → **二期 FUTURE-01**（本 phase 用 LIKE + 精排够用，D-11-5）
- 经验↔经验关联图遍历检索 → 二期 FUTURE-02
- 消息段精锚（source_event_ids）→ 二期 FUTURE-03
- AI 起草/人工确认/浏览页 CRUD → Phase 8/9/10（已交付）

</domain>

<decisions>
## Implementation Decisions

### 检索触发与注入方式（RETRIEVE-01）
- **D-11-1：每轮自动预取（方案 b）。** 不靠 AI 自主标记（[EXP_SEARCH]），每轮对话后台自动检索，**必查不漏**。完整流程：用户问 → SQL 粗筛 → LLM 精排打分 → 相关度阈值过滤 → 够分注入 / 不够分干净不塞 → AI 正式回答。运维经验是高价值低频资产，"宁可自动确保用上"优于"省一次检索"。
- **D-11-2：粗筛窄查策略。** 有勾选设备 → 按「关联设备 + 同分类」窄查；没勾选设备 → 用问题原文全库宽匹配（title/content/tags/category）。覆盖不绑设备的通用经验（排查方法论/命令速查）。
- **D-11-3：精排承担理解（方案 Y，非独立提取关键词）。** 粗筛用问题原文宽匹配捞候选 → 精排 AI 语义理解问题 + 给候选打分 + 阈值过滤。每轮 **2 次 LLM**（精排 + 正式答）。**不单独加"AI 提取关键词"步骤**——精排 AI 本就要理解问题才能打分，独立提取冗余（方案 X 每轮 3 次 LLM 边际收益低）。
- **D-11-4：防噪声双层（相关度阈值 + 精排语义理解）。** 粗筛可能捞到不相关候选，但精排 AI 语义理解后给低分扔掉；阈值过滤保证"找不到/不相关都不影响 AI"（不够分干净不塞，AI 正常用自己知识答）。解决用户核心担忧（噪声污染）。

### 粗筛索引（RETRIEVE-01）
- **D-11-5：SQL LIKE + 精排兜底，不上 FTS5。** 复用 Phase 10 `listExperiences` 的 search（匹配 title/content，可扩 tags），相关性靠 LLM 精排兜底。**修订 design 红线①字面「FTS5」→ LIKE + 精排**，理由：(1) 精排已覆盖相关性排序（FTS5 最大卖点被削弱）；(2) SQLite FTS5 默认中文分词是"按字拆"（非真正中文分词），好的中文分词需 jieba tokenizer（C 扩展，better-sqlite3 环境麻烦）；(3) 单机桌面经验量级小，LIKE 全库扫够快。**零迁移**（不建 experience_fts 虚拟表）。漏召回风险用"经验标题/标签规范含关键词"缓解。

### read-time 验证（RETRIEVE-02）
- **D-11-6：两项验证（commandSafety 白名单 + 有效期），去掉设备状态。** SC2 原三项（设备状态/commandSafety/有效期）→ **两项**。理由见 D-11-8。
- **D-11-7：分类降级策略。**
  - **命令失支持**（经验里命令被移出 commandSafety 白名单）→ **降权 + 标注**「⚠ 命令已失支持」。诊断思路仍有效，AI 回答时提示用户手动执行或更新白名单。
  - **有效期失效**（invalid_at，人工标 invalid）→ **剔除**。人工已判定不该再用，与浏览页软失效语义一致。
- **D-11-8：不验设备状态（原设计过度，做减法）。** 设备状态是**瞬时外部环境**，经验是**长期知识资产**，因果对不上。且**反逻辑**：用户问"core-sw-01 突然离线怎么办"时，经验关联 core-sw-01（状态=离线）→ 若降权/剔除 → AI 反而拿不到最相关的排查经验。设备在不在线不改变经验（方法论）是否成立。
- **D-11-9：不阻塞主路径。** 验证失败只降权/剔除，不报错中断检索（RETRIEVE-02 + STATE Risk Watch 锁定）。

### 引用溯源（RETRIEVE-03）
- **D-11-10：末尾来源列表。** AI 正文正常写，末尾附「本回答参考：① [经验] 标题 ② [会话] 时间/摘要」，每条可点击回查。运维回答综合多条经验得出，逐句标脚注不现实；末尾列表干净 + 可点回查足够。
- **D-11-11：引用数据从精排注入记录拿（不需 AI 标记）。** 因 D-11-1 选 b（后台自动预取），service 层已知本次注入了哪几条经验（精排结果有 exp_id/sessionId 记录），renderer 直接用这份记录渲染末尾列表，比 `[KB_SEARCH]` AI 自主标记更简单。**列本次注入的全部**（标注"本次参考池"），不区分 AI 实际用到几条（多列无害）。
- **D-11-12：点击回查复用现有组件（不新建）。** 经验引用 → Phase 10 **ExperienceDetailModal**；会话引用 → Phase 9 **SessionMessagesModal**（经 experience:getSessionMessages IPC 取原文）。

### Claude's Discretion
以下由 Claude 按 design 文档 + 项目约定自主决策（技术细节）：
- **注入条数上限 / context 预算**：参考 Phase 8 W-4 ≤50 条/分类截断（防单次 4×1000 context 溢出），planner 定具体 N（粗筛 top-N 喂精排 + 精排后注入 top-M）。
- **相关度阈值具体值**：planner 定（如 0.6），可配置。
- **精排 prompt 设计**：强 schema JSON 输出（每条候选返 exp_id + score + reason）+ 相关度评分 + 反幻觉，复用 Phase 8 draftingService 强 schema 模式（validateDrafts schema Gate + 重试）。
- **命令提取范围**：经验 attrs 模板（Phase 7 troubleshooting: symptoms/root_cause/resolution/prevention/severity）**无结构化 command 字段**，命令散落 resolution/content 正文。read-time 验证靠**正文扫描提取类命令文本**逐条 `isCommandAllowed`。风险：正则提取可能漏/误——二期可加 `attrs.command[]` 结构化字段提升精度（记 deferred）。
- **reuse_count / last_verified_at 刷新时机**：建议精排命中（注入）即 `incReuseCount` + `touchLastVerifiedAt`，planner 定。
- **检索节流 / 缓存**：同会话连续类似问题是否重复检索——MVP 可不做（开销可接受），planner 评估。
- **空经验库短路**：库空时跳过检索不每轮空转，planner 加守卫。
- **IPC 通道设计**：倾向**编排层串联不新增 IPC**（复用 experience:list + callAI + commandSafety），或视需新增 `experience:retrieve` 编排入口；planner 定。
- **降权标注对 AI 的 prompt 处理**：注入时附「⚠ 此条命令已失支持」元信息，让 AI 回答时主动提示用户。
- **验证执行位置**：service 层（commandSafety.isCommandAllowed + 有效期判断），编排层串联调用。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 功能设计（最高优先级）
- `.planning/designs/2026-08-01-experience-summary-design.md` — 主设计：§1 决策汇总 + 三条红线 + §2 数据流 + §8 MVP 范围（read-time 即时验证）。**注意 §1 红线①「FTS5」经 D-11-5 修订为 LIKE+精排**。
- `.planning/research/2026-08-01-experience-summary-research.md` — 55 同类项目调研，检索/精排/降权最佳实践。

### Roadmap / Requirements / Project
- `.planning/ROADMAP.md` §Phase 11 — Goal + 4 Success Criteria + Depends on Phase 7（bi-temporal/commandSafety 基线）+ Phase 10（经验库）。**SC2 三项经 D-11-6 修订为两项（去设备状态）**。
- `.planning/REQUIREMENTS.md` RETRIEVE-01/02/03 — 3 条需求逐字定义。
- `.planning/PROJECT.md` §Current Milestone v1.1 — 三条红线（① 不上向量库 ② 不引图库 ③ AI 产出必先进 draft）+ Key context（复用挑索引/`****xxxx` 脱敏/commandSafety）。

### Phase 10 直接前驱（检索池 + 粗筛复用）
- `.planning/phases/10-experience-browse-page/10-CONTEXT.md` — D-10-2 listExperiences opts（search/severity/tags/category/deviceId/includeInvalid/invalidOnly）Phase 11 粗筛直接复用；severity 明文列；FTS5 defer 到 11（D-11-5 评估后仍用 LIKE）。
- `electron/services/experienceService.ts` — `listExperiences(opts)` 粗筛入口（全参数已就绪）；`incReuseCount` / `touchLastVerifiedAt` 刷新复用计数/验证时间（Phase 7 预埋）；`invalidateExperience` 软失效语义参考。
- `electron/ipc/experienceIpc.ts` — 现有 experience:* channel 全 secure 包装。Phase 11 倾向编排层串联不新增 IPC（D-11 discretion）。

### Phase 9 / 10 引用回查复用（RETRIEVE-03）
- `src/components/knowledge/ExperienceDetailModal.tsx`（Phase 10）— 经验引用点击回查复用。
- `src/components/ai/SessionMessagesModal.tsx`（Phase 9，planner 从 09-03-SUMMARY.md 定位实际路径）— 会话引用点击回查复用。
- `experience:getSessionMessages` IPC（Phase 9）— 会话原文取回。

### Phase 8 LLM 精排参考（RETRIEVE-01 精排）
- `electron/services/experienceDrafting.ts` — 两阶段编排（draftSession/judgeVerdicts），Phase 11 精排 LLM 调用 + 编排模式参考。
- `electron/services/draftingService.ts` — `validateDrafts` 强 schema Gate + confidence 边界 + 重试，Phase 11 精排评分 schema 参考。

### 项目规范 / 集成契约
- `./CLAUDE.md` — Constraints（安全两层语义）/ Conventions（Service 函数式 / IPC secure 红线 / 字段加密 encField-decField / 迁移幂等 hasColumn / MAX_BATCH=1000）/ Architecture。
- `.planning/codebase/INTEGRATIONS.md` §LLM — `callAI()` 契约（ai.ts:229 裸 fetch，`{model,messages}` 非 streaming，无 response_format）+ `[KB_SEARCH]` 注入机制（ai.ts:731-785，AI 自主标记→kbSearch→二轮 LLM 注入）—— Phase 11 经验注入的参考模式（但 D-11-1 选 b 自动预取，不抄 AI 自主标记）。
- `.planning/codebase/CONVENTIONS.md` — Service 函数式 / IPC 鉴权红线 / 字段加密 / 迁移幂等。
- `.planning/codebase/ARCHITECTURE.md` — 三进程分层、信任边界（main 持 masterKey，renderer 永不收明文凭证/attrs 密文）。
- `electron/services/commandSafety.ts` — `isCommandAllowed` read-time 命令白名单验证（D-11-6/7）。
- `electron/services/knowledgeBaseService.ts` — `search` 挑索引机制（FTS5 kb_chunks_fts + LLM rerank，无 embedding），Phase 11 精排 rerank 参考。

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`experienceService.listExperiences(opts)`** — 粗筛直接复用（search/severity/tags/category/deviceId/includeInvalid/invalidOnly + bi-temporal 过滤全就绪，Phase 10 落地）。
- **`experienceService.incReuseCount` / `touchLastVerifiedAt`** — 复用计数/验证时间刷新（Phase 7 预埋，SC2 刷新复用）。
- **`callAI(messages, opts?)`（ai.ts:229）** — 精排 LLM 调用复用（不改签名，prompt 层强 schema JSON）。
- **`ai.ts:731-785 [KB_SEARCH]` 注入机制** — 经验注入参考（二轮 LLM 注入检索结果到 context 的模式；但触发方式用 b 自动预取而非 AI 自主标记）。
- **`knowledgeBaseService.search`** — 挑索引 LLM rerank 参考。
- **`commandSafety.isCommandAllowed`** — read-time 命令白名单验证。
- **`ExperienceDetailModal`（Phase 10）/ `SessionMessagesModal`（Phase 9）** — 引用回查复用，不新建。
- **`experience:getSessionMessages` IPC（Phase 9）** — 会话原文取回。
- **`secure()` + MAX_BATCH（authGuard.ts）** — 若新增 IPC 沿用。

### Established Patterns
- **Service 函数式 + 模块级 MK** — 检索/编排 service 若新建，沿用函数式（无 class），加密列走 encField/decField。精排 service 不读写加密列（attrs 已解密回填）则函数式无 MK（参考 draftingService Pattern 1b）。
- **IPC `<domain>:<action>` camelCase + secure + MAX_BATCH** — 新 channel（若有）遵循。
- **强 schema JSON LLM 输出（Phase 8 draftingService）** — 精排评分 schema 参考（每条候选返 exp_id + score + reason，schema Drift Gate + 重试）。
- **信任边界**：检索/精排/read-time 验证全在 main 进程（masterKey/commandSafety 可用），renderer 只收最终回答 + 引用元数据（exp_id/title/sessionId，不含 attrs 密文）。

### Integration Points
- **main 进程编排层**：用户问 → 粗筛 `listExperiences` → 精排 `callAI`（强 schema）→ 阈值过滤 → read-time 验证（`isCommandAllowed` + 有效期）→ 命中 `incReuseCount`/`touchLastVerifiedAt` → 注入正式 `callAI` → 末尾来源列表随回答返 renderer。
- **IPC**：倾向编排层串联不新增 IPC（复用 experience:list + callAI），或新增 `experience:retrieve` 编排入口；planner 定。
- **renderer（AIPage / ChatMessageList）**：AI 回答末尾渲染来源列表（从精排注入记录）+ 点击回查 Modal（复用 ExperienceDetailModal / SessionMessagesModal）。
- **信任边界**：精排注入走 service 解密 attrs 后明文 + commandSafety 验证后标注，renderer 永不收密文。

</code_context>

<specifics>
## Specific Ideas

- **用户明确重视检索质量（防噪声）**：讨论中用户主动追问"找不到/不相关经验会不会误导 AI"，促使确认 D-11-4 双层防噪声（阈值 + 精排语义理解），且接受每轮多一次精排 LLM 换相关性。
- **用户质疑推动做减法**：用户问"经验为什么要和设备实时状态挂钩"→ 分析发现反逻辑（设备离线时正需要排查经验）→ D-11-8 去掉设备状态，SC2 三项→两项。这是讨论阶段对 SC 的合理修订。
- **design 红线① FTS5 经评估修订为 LIKE + 精排**（D-11-5）：精排覆盖相关性排序 + SQLite 中文分词坑 + 量级小。记录修订理由供后续 milestone 审视（数据量上来后连同 FUTURE-01 向量召回一起升级）。
- **b 方案的关键简化（D-11-11）**：后台自动预取 = service 已知注入哪些经验 → 引用直接复用注入记录，不需 AI 标记（比 [KB_SEARCH] 简单）。

</specifics>

<deferred>
## Deferred Ideas

- **FTS5 全文索引 / embedding 向量召回** → 二期 FUTURE-01（数据量上来后连同向量召回一起升级检索，Phase 11 用 LIKE + 精排够用）。
- **设备状态实时验证 / 实时探测** → 二期（如需高精度设备在线判断；Phase 11 不验设备状态 D-11-8，或二期用静态 last_seen）。
- **经验结构化 command 字段**（`attrs.command[]`）→ 二期（Phase 11 命令靠正文扫描提取，风险=正则漏/误；二期加结构化字段提升 read-time 命令验证精度）。
- **检索节流 / 缓存**（同会话连续类似问题不重复检索）→ 可选，MVP 可不做。
- **AI 标实际引用（脚注式精确逐句引用）** → 未来（末尾列表够用，精确逐句引用复杂度高）。

</deferred>

---

*Phase: 11-AI Retrieval & Reuse*
*Context gathered: 2026-08-06*
