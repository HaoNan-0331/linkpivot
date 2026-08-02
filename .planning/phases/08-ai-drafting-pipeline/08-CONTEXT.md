# Phase 8: AI Drafting Pipeline - Context

**Gathered:** 2026-08-02
**Status:** Ready for planning

<domain>
## Phase Boundary

用户在 AI 对话窗点「经验总结」后，**后端异步 pipeline**：读该 sessionId 全部会话消息 + 关联设备 → PII 脱敏 → 查存量去重（AI 判 ADD/UPDATE/NOOP）→ 强 schema JSON 起草 1~N 条草稿（分类枚举锁死 + 分类模板 + 反幻觉 + 缺数据标 gap）→ 落 `experiences` 表 draft 态 → 通知前端。

**In scope：**
- 「经验总结」按钮入口（AI 对话窗）+ 异步起草 loading + 完成通知 + 无可总结内容提示
- 会话消息回顾（读 `chat_history` 按 sessionId）+ 关联设备收集
- PII 脱敏 util（送 LLM 前主进程做，分级：凭证严格 / IP·MAC 尾4）
- 查存量去重（`experienceService.listExperiences` 检索 + AI 判 ADD/UPDATE/NOOP + 标注命中 id）
- 强 schema LLM 起草（prompt 强约束 + 代码 JSON.parse + schema 校验 + 失败重试；分类枚举 + 分类模板）
- draft 落库（`experienceService.createExperience(status='draft')`，UPDATE 草稿填 `duplicate_of_exp_id`）
- source_session_id 幂等 + 重试退避 + 断点续传
- IPC 鉴权网关（延续 Phase 7 `secure` 基线）+ 批量上限

**Out of scope（属其他 phase）：**
- 人工确认弹窗 / 质量门硬校验 / 逐条编辑勾选 → **Phase 9**
- 经验板块页（浏览/筛选/搜索/手动 CRUD/标失效）→ **Phase 10**
- AI 检索复用（SQL 粗筛 + LLM 精排 + read-time 验证 + 引用溯源）→ **Phase 11**
- commandSafety 联动验证（Phase 11 read-time 才用，phase 8 不实现）
- embedding 向量召回 / 经验↔经验关联 / 消息段精锚 / 关联图可视化 → **二期**

</domain>

<decisions>
## Implementation Decisions

### LLM 结构化输出
- **D-01：prompt 强约束 + 代码 JSON.parse + schema 校验 + 解析失败重试。** 不改 `callAI()`（ai.ts:229 裸 HTTP fetch），不依赖 provider JSON mode（用户自配火山方舟/任意 OpenAI 兼容，json_object 支持不齐）。prompt 强制输出 JSON 数组（1~N 条草稿，每条含 category/title/content/tags/attrs/confidence/reasoning/duplication_verdict/duplicate_of_exp_id），代码层 JSON.parse + 分类枚举校验 + 分类模板 schema 校验（troubleshooting 必填 symptom/resolution/severity 等）+ gap 字段校验（缺数据字段值标 `"gap"` 或 `_gap:[]`，由 planner 定，不强填不瞎编），解析/校验失败重试 N 次（planner 定，建议 2~3）。
- **D-01a：schema 漂移 Drift Gate 在代码层**（design §6）—— LLM JSON 输出 vs 表契约校验，drift 即重试或丢弃该条。

### 查重判定
- **D-02：同分类 + 关联设备优先。** 草稿关联设备时查「同 category + 同 deviceId（任一）」的有效存量（status≠invalid，invalid_at IS NULL OR > now）；无设备关联时查「同 category 全库」。喂 AI 的存量形式 = 「标题 + 内容前 150 字摘要」列表（含 exp_id），AI 在起草 prompt 内一并判定每条草稿的 ADD（新增）/UPDATE（命中旧条目需更新）/NOOP（跳过），UPDATE/NOOP 在草稿上标注命中 `duplicate_of_exp_id`。**无硬相似度阈值**，信任 LLM 判定（红线③ 人工确认兜底）。

### status 与 UPDATE/NOOP 落库
- **D-03：status 沿用 Phase 7 四态（draft/confirmed/published/invalid），不新增枚举值，不动 status 约束。**
  - ADD → 新条目 `status='draft'`
  - UPDATE → 新条目 `status='draft'` + `duplicate_of_exp_id` 填命中旧条目 id（Phase 9 确认时人工拍板旧条目命运：标 invalid 或保留；**phase 8 不自动改旧条目**，避免 AI 自动 supersede 破坏历史，严守红线③）
  - NOOP → **不落库**，只在起草返回结果里提示「命中存量 exp_id，跳过」
- **D-03a（Claude discretion，数据模型）：** phase 8 迁移加 `duplicate_of_exp_id TEXT` nullable 列（幂等 `hasColumn` 守卫，不动 status 枚举），支撑 UPDATE 命中关联 + 为二期经验↔经验关联预留。若 planner 评估更优方案（attrs 临时存 / 起草结果内存映射），可在 plan 阶段调整，但须保证 Phase 9 能据 draft 定位命中旧条目。

### PII 脱敏
- **D-04：分级脱敏，送 LLM 前主进程做，原始 `chat_history` 明文不动。**
  - **凭证严格全脱敏**：正则匹配 `password|passwd|pwd|secret|token|apiKey|api_key|key|密码|口令|凭证` 关键词后跟的值 → 替换为 `****`（不保留尾4，凭证最敏感）
  - **IPv4 保留尾4**：`(\d{1,3}\.){3}` 前三段 → `***.***.***.`，保留末段（如 `***.***.***.1`），LLM 可区分不同设备
  - **MAC 保留尾4**：前两段 → `**:**:**:`，保留后四段（如 `**:**:**:AA:BB:CC`）
  - 脱敏只针对**送 LLM 的会话正文副本**；原始 chat_history 明文保留（Phase 9「查看原始会话」回链用明文）

### Claude's Discretion
以下由 Claude 按 design 文档 + 项目约定自主决策（design 已定或属纯实现细节）：
- **触发入口 UI**：AI 对话窗「经验总结」按钮位置（design §5 定输入区/会话工具栏，会话有内容才可点，点击转 loading，异步起草完成弹通知）
- **重试策略**：重试次数（建议 2~3）/ 退避间隔 / source_session_id 幂等实现（design §6 重试退避 + 断点续传 + DEMO_MODE 降级）
- **无可总结内容判定**：AI 判定（返回空草稿数组）→ 提示「该会话无可总结经验」而非强产空条目（SC1）
- **异步起草进度反馈**：IPC 推进度 / 完成通知（design §5 loading + 通知）
- **会话「已总结」标记**：design §2 步骤5「标记 session 已总结」，标记存哪（chat_sessions 加列 / ai_system_logs 记录）由 planner 定；同 session 可多次总结（追加不覆盖，SC5），按 source_session_id + 总结批次区分
- **gap 字段格式**：缺数据字段值标 `"gap"` 或 `_gap:[]` 数组，planner 定（须 schema 校验识别）
- **多条草稿 JSON 数组结构**：planner 按强 schema 定义（每条含 confidence + reasoning + duplication_verdict + duplicate_of_exp_id）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 功能设计（最高优先级，已锁定大部分决策）
- `.planning/designs/2026-08-01-experience-summary-design.md` — **主设计文档**：§1 已定决策汇总（8 条）+ 三条红线 + §2 数据流 + §4 起草流程 + §6 错误处理 + §8 MVP 范围。phase 8 起草 pipeline 由此文档驱动。
- `.planning/research/2026-08-01-experience-summary-research.md` — 55 个同类项目调研支撑（脱敏/去重/分类模板最佳实践），design 决策的依据。

### Roadmap / Requirements / Project
- `.planning/ROADMAP.md` §Phase 8 — Goal + 5 Success Criteria + Depends on Phase 7
- `.planning/REQUIREMENTS.md` DRAFT-01/02/03/04 — 4 条需求逐字定义
- `.planning/PROJECT.md` §Current Milestone v1.1 — 三条红线（① 不上向量库 ② 不引图数据库 ③ AI 产出必先进 draft 人工确认才 published）+ Key context（复用 saveChatMessage / LLM 挑索引 / `****xxxx` 脱敏 / commandSafety）

### Phase 7 数据层基线（强依赖）
- `.planning/phases/07-experience-data-layer-security-baseline/07-01-SUMMARY.md` — `experiences` + `exp_device_rel` 表结构 + `experienceService` 函数式 service 导出函数清单（createExperience/listExperiences/listByDevice/listDevicesByExperience 等签名，phase 8 查重/落库复用）
- `.planning/phases/07-experience-data-layer-security-baseline/07-02-SUMMARY.md` — experience:* IPC channel 清单（10 个 secure 包装）+ main.ts setExperienceMasterKey 注入点
- `.planning/phases/07-experience-data-layer-security-baseline/07-VERIFICATION.md` — Phase 7 验证（5 SC + 6 REQ passed），表结构实证（init.ts:294-312 DDL / migrations.ts v8）
- `.planning/phases/07-experience-data-layer-security-baseline/07-REVIEW-FIX.md` — CR-01 收紧后 ExperienceUpdateInput 白名单（update 不可改 status/audit/有效期，phase 8 起草只走 createExperience 落 draft）

### 项目规范 / 集成契约
- `./CLAUDE.md` — Constraints（安全两层语义）/ Conventions（Service 函数式 / IPC secure / 字段加密 encField-decField / 迁移幂等）/ Architecture
- `.planning/codebase/INTEGRATIONS.md` §LLM — `callAI()` 契约（ai.ts:229 裸 fetch，`{model, messages}` 非 streaming，无 response_format；ai_config 全字段加密；自定义文本协议 [CMD]/[KB_SEARCH] 非标准 function-calling）
- `.planning/codebase/CONVENTIONS.md` — Service 函数式 / IPC 鉴权红线 / 字段加密 / 迁移幂等 / MAX_BATCH=1000
- `.planning/codebase/ARCHITECTURE.md` — 三进程分层、信任边界（main 持 masterKey，renderer 永不收明文凭证）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`callAI(messages, opts?)`（ai.ts:229）**：LLM 调用入口，OpenAI 兼容 chat/completions，主进程裸 fetch。phase 8 起草 LLM 调用复用此函数（D-01 不改其签名，prompt 层强约束 JSON）。配置经 `getAiConfig()` 解密（MK 注入）。
- **`saveChatMessage` + `chat_history` 表（ai.ts）**：会话消息已按 sessionId 持久化（content_enc 加密）。phase 8 「回顾会话」= 按 sessionId 读取 chat_history 全部消息（解密得明文，脱敏后送 LLM）。
- **`experienceService.listExperiences({category, deviceId, status})`（Phase 7）**：查重检索入口，支持按分类/设备/状态过滤有效存量（已含 bi-temporal 过滤 invalid_at IS NULL OR > now）。
- **`experienceService.createExperience({status:'draft', ...})`（Phase 7）**：draft 落库入口，source_session_id 已预埋。
- **`****xxxx` 脱敏模式（ai.ts:38-44 getAiConfigForRenderer）**：现有 apiKey 脱敏给 renderer 的模式参考；**会话正文 PII 脱敏是新需求**（D-04），需新建独立 mask util（凭证正则 / IPv4·MAC 尾4），不复用 apiKey 脱敏代码（场景不同）。
- **`secure()` IPC 包装（authGuard.ts，Phase 7 基线）**：phase 8 新增 experience:draft 等 channel 沿用 secure 包装。
- **`commandSafety.isCommandAllowed`（commandSafety.ts）**：**phase 8 不联动**（Phase 11 read-time 验证才用），但 design 已要求起草 prompt 不输出执行命令（反幻觉）。

### Established Patterns
- **Service 函数式 + 模块级 MK**：phase 8 若新建 draftingService / piiMask util，沿用 knowledgeBaseService / experienceService 函数式形态（无 class），加密列走 encField/decField。
- **IPC `<domain>:<action>` camelCase + secure 包装 + MAX_BATCH**：phase 8 新 channel（如 `experience:summarizeSession`）遵循。
- **迁移幂等（hasColumn / sqlite_master.sql 特征串守卫）**：phase 8 若加 `duplicate_of_exp_id` 列（D-03a），用 hasColumn 守卫 + db.transaction，不动 status 枚举。
- **自定义文本协议 vs JSON**：现有 AI 工具调用是自定义文本协议（[CMD]/[KB_SEARCH]），但 phase 8 起草是**结构化 JSON 输出**（D-01 prompt 强约束），不复用文本协议解析。

### Integration Points
- **main 进程**：起草 pipeline 在 main 异步执行（读会话→脱敏→查重→LLM 起草→落库），masterKey 在 main 可用（解密 chat_history / experienceService 加密）。
- **IPC**：`experience:summarizeSession(sessionId)` 触发起草（secure 包装，异步），返回 draft 列表 + 命中映射；进度/完成通知经 IPC 推 renderer。
- **renderer（AI 对话窗）**：「经验总结」按钮 + loading + 通知；draft 列表展示交 Phase 9 确认弹窗。

</code_context>

<specifics>
## Specific Ideas

**design 文档已定决策汇总（§1，carry forward，不再讨论）：**
1. 结构化表 + 独立浏览页 + AI 检索复用（不上向量库，FTS5+LLM 精排）
2. AI 起草（可拆多条）→ 弹窗逐条编辑/勾选 → 确认入库
3. 分类固定枚举 troubleshooting/best_practices/product/env + 自由标签
4. 设备关联可选（多对多）
5. 字段深度按分类区分（troubleshooting 重模板，其他轻结构）
6. bi-temporal 双时间窗（valid_at/invalid_at 软失效）
7. MVP 即做 read-time 即时验证（Phase 11，phase 8 不实现）
8. 起草前查存量 AI 判 ADD/UPDATE/NOOP
- 直接纳入：PII 脱敏前置 / status 状态机 / provenance 溯源

**三条红线（design §1，不可回退）：**
① 不上向量库；② 不引图数据库；③ AI 产出永远先进 draft，人工确认才 published。

**起草数据流（design §4，phase 8 核心）：**
读会话全部消息+关联设备 → PII 脱敏 → 查存量去重 → 强 schema 起草（分类锁枚举/反幻觉/缺数据标 gap/可拆 1~N 条/每条 confidence+reasoning）→ 落 draft 态 → 通知（弹窗确认交 Phase 9）。

**Phase 7 已建基线（phase 8 直接用）：**
- `experiences` 表：通用列 + attrs_enc（JSON 模板）+ bi-temporal + 预埋列（status 4 态 / source_session_id / last_verified_at / reuse_count / relation_type）
- `experienceService` 函数式：createExperience / listExperiences / listByDevice / listDevicesByExperience / invalidateExperience / incReuseCount 等
- 10 个 experience:* IPC channel 全 secure 包装 + main.ts setExperienceMasterKey 注入

</specifics>

<deferred>
## Deferred Ideas

- **embedding 向量召回**（design §8 二期）：二期在「粗筛」平滑叠一路（Phase 11 检索），不动 phase 8 起草。
- **经验↔经验关联（exp_exp_rel）+ 图遍历 + 关联图可视化（React Flow）**（design §8 二期）：D-03a 的 `duplicate_of_exp_id` 列为此预留雏形。
- **消息段精锚（source_event_ids）**（design §3 二期）：精确锚定产生经验的具体消息段，phase 8 只用 source_session_id 整会话溯源。
- **全自动矛盾判定**（design §8 YAGNI 不做）：永远人工拍板（Phase 9）。
- **commandSafety 联动**（Phase 11）：phase 8 起草 prompt 反幻觉不输出执行命令，但不做白名单联动验证。

</deferred>

---

*Phase: 8-AI Drafting Pipeline*
*Context gathered: 2026-08-02*
