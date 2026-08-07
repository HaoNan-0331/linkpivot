# Phase 8 Discussion Log

**Date:** 2026-08-02
**Phase:** 8 — AI Drafting Pipeline
**Mode:** default (interactive)
**Areas discussed:** 4（LLM 结构化输出 / 查重判定 / status 落库 / PII 脱敏）

## Carry Forward（design 文档已定，未讨论）

`.planning/designs/2026-08-01-experience-summary-design.md` §1 已定 8 条决策 + 三条红线（见 08-CONTEXT.md `<specifics>`），本次讨论不重复。

## Area 1: LLM 结构化输出方式

**Q:** LLM 强 schema JSON 输出（分类枚举 + 模板字段 + gap + confidence + 多条数组）怎么实现？
- **prompt+代码校验重试（推荐）** — prompt 强约束 JSON + 代码 JSON.parse + schema 校验 + 解析失败重试；不改 callAI，不依赖 provider JSON mode，兼容所有 OpenAI 兼容端点
- **扩展 callAI 加 response_format** — callAI 加 response_format:json_object 走 provider JSON mode；依赖用户 provider 支持 json_object（火山方舟等不一定），失败需回退
- **You decide**

**Selected:** prompt+代码校验重试

## Area 2: 查重判定逻辑

**Q:** 查重范围与喂 AI 的存量形式？（design 定 AI 判，代码负责检索存量喂 LLM）
- **同分类+关联设备优先（推荐）** — 草稿关联设备时查同分类+同设备存量；无设备关联时同分类全库；喂「标题+内容前 150 字摘要」列表；AI 判 ADD/UPDATE/NOOP，标注命中 id
- **同分类全库** — 始终不限设备（运维经验多跨设备通用），防跨设备重复但设备特定经验可能误判
- **You decide**

**Selected:** 同分类+关联设备优先

## Area 3: status 与 UPDATE/NOOP 落库

**Q:** design 5 态（duplicate/superseded/deleted）vs Phase 7 实际 4 态（draft/confirmed/published/invalid），UPDATE/NOOP 如何落？
- **沿用 4 态+标注命中（推荐）** — ADD→新 draft；UPDATE→新 draft + duplicate_of_exp_id 标注命中旧条目（确认时人工拍板旧条目，phase 8 不自动改）；NOOP→不落库只提示；不新增 status，不动 status 约束
- **扩展 status 加 superseded/duplicate** — UPDATE 确认后旧条目自动 superseded；NOOP 落 duplicate 态；需改 Phase 7 表 + 代码，自动 supersede 破坏历史风险
- **You decide**

**Selected:** 沿用 4 态+标注命中

**Claude discretion 注记（D-03a）：** phase 8 迁移加 `duplicate_of_exp_id TEXT` nullable 列（幂等 hasColumn 守卫，不动 status 枚举）支撑 UPDATE 命中关联，为二期经验↔经验关联预留。

## Area 4: PII 脱敏粒度

**Q:** 会话正文 PII（IP/MAC/账号密码）送 LLM 前的脱敏粒度？（现有 ****xxxx 仅 apiKey 脱敏，会话正文 PII 是新需求）
- **分级：凭证严格+IP/MAC 尾4（推荐）** — 凭证（password/secret/token/key/密码/口令 后值）全脱敏 ****；IPv4 保留尾4（***.***.***.1）；MAC 保留尾4（**:**:**:AA:BB:CC）；LLM 可区分设备不见全貌
- **严格全脱敏** — IP/MAC/凭证全 ****尾4，贴红线字面但 LLM 难区分设备
- **IP/MAC 保留，仅凭证脱敏** — 运维 IP 是设备标识非个人 PII，LLM 理解最佳但 IP 暴露给 provider
- **You decide**

**Selected:** 分级：凭证严格+IP/MAC 尾4

## Claude Discretion（design 已定或纯实现细节）

触发入口 UI（design §5 输入区/会话工具栏）/ 重试策略（design §6 退避+source_session_id 幂等+DEMO_MODE）/ 无可总结内容判定（AI 判提示不强产）/ 异步起草 loading+通知 / gap 字段格式 / 多条 JSON 数组结构 / 会话「已总结」标记位置。

## Conclusion

Ready for context → `08-CONTEXT.md` 已写。4 核心 area 决策锁定（D-01~04），剩余 Claude discretion 按 design + 项目约定。下一步 `/gsd-plan-phase 8`。
