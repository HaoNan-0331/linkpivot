# 项目体检报告 2026-08-07

> 来源：workflow `wf_ba2c34ba-431`（11 agent：4 扫延后项 + 4 扫 dead code + 2 对照文档 drift + 1 汇总）
> 主 agent 已对关键疑点做代码层甄别（见 §1.0 / §2 注释）
> 范围：network_toplogy 全项目（v1.1 shipped 后）

## 摘要

| 维度 | 总数 | 关键 |
|------|------|------|
| 延后处理项 | 45（43 新 + 2 已知）| 甄别后真 high 4 条 |
| Dead code | 14 | 5 条可立即删 |
| 代码地图 drift | 27（12 high）| 8 文档全滞后于 v1.1 |

---

## §1 延后处理项（45）

### §1.0 ⚠️ 甄别纠正：旧规划回退项（源自 `docs/plans/2026-05-09` 的 2026-05-12 回退批次）

workflow 读文档原话未验证代码，主 agent 已补验。这 6 条是 v1.0 前的回退待办，**需对照当前代码逐条甄别，不可照单全收**：

| 回退项 | 甄别结果 |
|--------|----------|
| 自动发现每命令单独建 SSH 连接，未改批量 `executeCommandsOnDevice` | ✅ **已修** — `discovery.ts:202` 已批量 `executeCommandsOnDevice(device, safeCommands)`，此条误报，剔除 |
| SSH 缺 curve25519-sha256 致现代 Linux 连接失败 | ⚠️ **部分残留** — `sshConfig.ts:13` 已有 curve25519（ai.ts:312/arpCollector.ts:68 走 SSH_ALGORITHMS 已 OK），但 `connection.ts:115/312` 设备终端连接的内联 kex 配置仍不含 curve25519。残留 1 处需补 |
| H3C LLDP 采集 AI 自造华为命令，未用 vendor-commands 命令集 | ⚠️ **方向过时** — vendor-commands.ts 全项目 0 import（已成死代码，见 §2），discovery.ts 重写已走新方案。此条「应走 vendor-commands」建议作废，需重新评估 H3C 邻居发现的正确路径 |
| confirm 弹窗需点两次，handleConfirm 缺防重复点击保护 | ❓ 待甄别（未验证） |
| ai_exec_logs 未记录完整 prompt 与 AI 响应 | ❓ 待甄别（未验证） |
| AI 会话标题不更新（标题更新逻辑在 confirm_required early return 之后） | ❓ 待甄别（未验证） |

### §1.1 真 High（4，已剔除上述误报/部分残留）

1. **[test] exec-cmd-concat 真机 HV 未闭环** — 命令粘连修复（每命令独立 SSH 连接）的根因消除待真实 H3C 设备实测确认。`action`: H3C 上跑自动发现，核对 collectionText 第 2 条起回显干净、topology edges 非空。`.planning/debug/resolved/exec-cmd-concat.md:82,92`
2. **[test] 加密核心 R2/R3 运行时 HV 未做** — 真实 safeStorage 翻转 + 解密失败告警落 system_log 并在系统日志页展示未人工验证。`action`: 真实 Electron 翻转 safeStorage 触发解密失败，确认 system_log 落 type=security 且日志页可见。`.planning/quick/260726-upa-.../SUMMARY.md:31`
3. **[process] DEP-1 native binding ABI 冲突缓解方案延后** — SSH/Telnet/DB 真实路径无法自动化回归、句柄泄漏只能人工 HV。`action`: 立项推进 @electron/rebuild + electron-vite 集成 vitest 跑 Electron 内测试。`.planning/PROJECT.md:97`
4. **[security] Phase 8 反幻觉红线仅 prompt 提示，validateDrafts 未做代码层标记扫描（WR-01）** — `action`: validateDrafts schema 门加 [CMD]/[KB_SEARCH] 标记正则扫描，含执行标记的草稿拒绝落库。`.planning/phases/08-.../08-REVIEW.md:111`

### §1.2 Medium（15）

- **[defect] pre-release 审计 14 项发版后迭代项被显式排除**（M6/M7 渲染层 any、L7 db any、L10 复杂度、L1 弱 SSH 算法、L2 ai limit、L3 captcha、L4 Login、L6 authGuard、L8/L9 渲染层、L12 rebuild 锁定、L15 xterm、L16 ssh2 license）。优先安全相关 L1/L4/L6。`260726-p9e-SUMMARY.md:142`
- **[test] kb-db-malformed 修复用户 HV 未执行**（kb:deleteChunk / kb:editChunk）。`debug/resolved/kb-db-malformed.md:28`
- **[defect] Phase 10 ExperienceTab loadExperiences 无请求竞态保护（WR-04）** — 快速切换筛选可能显示过期列表。加 reqIdRef/AbortController。`10-REVIEW.md:242`
- **[security] Phase 10 experience:list IPC 入参 severity/tags/search 未校验类型长度（WR-06）** — untrusted renderer 可廉价 DoS。加枚举校验 + 长度/数组上限。`10-REVIEW.md:300`
- **[defect] Phase 11 experienceRerank extractJsonArray 用首末括号截取（WR-02）** — LLM 前置文字含括号会截错致检索静默失效。改优先按 ```json fence 提取。`11-REVIEW.md:140`
- **[defect] Phase 11 renderer parsed.references 类型断言把 kind/sourceSessionId 当已存在字段读（WR-04）** — main 改字段名不报错。补进 TS 类型声明。`11-REVIEW.md:189`
- **[defect] Phase 11 rerank 循环内 await callAI 网络异常直接冒泡不进 retry（IN-04）** — 与注释语义不符致检索静默降级。try/catch 包住纳入重试。`11-REVIEW.md:340`
- **[feature] Phase 11 经验结构化 command 字段（attrs.command[]）二期补（D-11-7）** — 当前靠正则扫描正文，二期结构化提升命令验证精度。`11-CONTEXT.md:147`
- **[feature] IPv6 支持列为后续 milestone 候选**（现有 ipToNumber/CIDR 仅 IPv4）。`PROJECT.md:96`
- **[defect] FRAG-2/3 + TD-1/TD-2 后端 cleanup 未在 v1.0/v1.1 清偿**。`PROJECT.md:98`
- **[defect] FRAG-2 静默吞错收敛模式（safeLog/enrichParseError）仅 discovery 局部，推广全局被 defer**。`RETROSPECTIVE.md:33`
- **[defect] handleConfirm 缺防重复点击保护**（旧规划，§1.0 待甄别）。`docs/plans/...:1233`
- **[defect] ai_exec_logs 未记录完整 prompt/AI 响应**（旧规划，§1.0 待甄别）。`docs/plans/...:1236`
- **[test] better-sqlite3 DB 层单测因 DEP-1 无法补运行时测试，DB 层回归网缺失**。`260726-vcu-SUMMARY.md:36`
- **[process] 审计 P1：CI 冒烟 job 不打 installer，native ABI 静默失配防护未完整闭环**（w67 仅 rebuild 双包）。扩展 CI 打 installer 并校验 asarUnpack 含 .node。`audits/2026-07-26-doc-code-audit.md:129`
- **[feature] Phase 10 UAT 1b：AI 助手聊天设备勾选范围放开**（非 ssh/telnet 设备可勾选，只聊天+查资料库+总结经验，不连接）。`10-UAT.md:128` —— 与本次会话已确认的 #3 设备过滤是同一项

### §1.3 Low（23，精选）

- **[process] Phase 8 summarizeSessionForUi 内 getAiConfig 调 3 次重复解密（WR-05）**。`08-REVIEW.md:151`
- **[process] Phase 8 B-1 红线「不裸 SQL UPDATE duplicate_of_exp_id」无自动化校验（IN-03）**。`08-REVIEW.md:188`
- **[defect] Phase 8 createExperience 不校验 duplicateOfExpId 指向存在性（IN-04）** — LLM 可能产 hallucinated exp_id。`08-REVIEW.md:195`
- **[defect] Phase 10 invalid_at 时间判定逻辑三处重复实现（WR-07）** — service SQL/DetailModal/Tab 漂移风险，抽 isValid/isInvalid util。`10-REVIEW.md:326`
- **[test] Phase 10 两测试文件重复 ~400 行 MemDb mock（WR-08）** — 抽公共 fixture。`10-REVIEW.md:348`
- **[defect] Phase 10 stripEncColumns 在 WR-05 修复后已成死代码（WR-09）**。`10-REVIEW.md:360`
- **[defect] Phase 11 useAIChat JSON.parse(reply) 未覆盖纯文本巧合是合法 JSON（WR-05）** — 用户可能看到带引号原始 JSON。补自然语言 fallback。`11-REVIEW.md:214`
- **[defect] Phase 11 experienceRetrieval 同分并列取前 N 不稳定（WR-08）** — reuse_count 排名漂移，加 tiebreaker。`11-REVIEW.md:283`
- **[defect] Phase 11 ChatMessageList 引用用 div onClick 无 a11y（IN-03）** — 改 role=button/tabIndex/onKeyDown。`11-REVIEW.md:331`
- **[test] Phase 11 experienceRetrieval.test.ts 用例 23 用 toISOString() 与生产 localtime 时区偏移（IN-02）**。`11-REVIEW.md:319`
- **[process] Phase 11 rerank 与 RELEVANCE_THRESHOLD 拆两条 import 应合并（IN-01）**。`11-REVIEW.md:306`
- **[feature] Phase 11 检索不验证设备实时状态（D-11-8）** — 高精度在线判断二期。`11-CONTEXT.md:146`
- **[defect] Phase 9 ChatInput pendingDraftCount Badge 未设 overflowCount（IN-02）** — count>99 挤压按钮。`09-REVIEW-FIX.md:104`
- **[test] Phase 9 telnet perCmdTimeout 预算值需现网慢设备实测（~75s）**。`09-REVIEW-FIX.md:40`
- **[test] Phase 9 confirmDrafts 分层校验决策需人工确认符合起草语义**。`09-REVIEW-FIX.md:54`
- **[test] 前端组件自动化测试覆盖率为 0**。`260726-vcu-SUMMARY.md:35`
- **[doc] BUG-3 before-quit 不等 in-flight backup 评级高估暂缓，CONCERNS 标注动作未落地**。`260726-upa-PLAN.md:18`
- **[defect] BUG-1 anomalyService new_ip 计数恒为 0 未修复** — getStats/AnomalyTab/exportService 暴露恒零字段误导。`audits/2026-07-26:70,133`
- **[defect] 审计 P3 技术债清单未处理** — 后端 any 收口、移除 @types/uuid 与 jsdom 死依赖、收窄 .gitignore *.png、reactflow@11/xterm@5 legacy 迁移、强制 npm ci、前端测试通道。`audits/2026-07-26:132`
- **[feature] 研究提出多跳 ReAct 检索** — STATE FUTURE 表未显式登记（已登记 FUTURE-2 图遍历）。`research/2026-08-01:217`（already_known）
- **[feature] 预留 embedding 字位二期（对应 FUTURE-1）**。`research/2026-08-01:120`（already_known）
- **[defect] Phase 5 前端重构遗留** — 搜索 snippet [图片N] 占位呈现 UX 未做，9 warning/4 info advisory 未修。`PROJECT.md:58`
- **[process] map-codebase 阶段 domain research 因外部搜索工具不可用被跳过至今未补**。`PROJECT.md:113`
- **[feature] Phase 10 UAT ExperienceEditForm 标签 Select mode='tags' 未传 options** — 每次纯新建无法复用已有标签（用户明确讨论后再做）。`10-UAT.md:140`

---

## §2 Dead Code（14）

### §2.1 可立即删（5，全 low risk / remove）

- **@types/uuid（依赖）** — uuid v14+ 自带类型，旁路 @types 包零引用冗余。
- **`vendor-commands.ts` 三 export：`Vendor`(type) / `detectVendor`(fn) / `getDiscoveryCommands`(fn)** — codegraph_callers 全 0，全项目 0 import。CHANGELOG:239 记载 discovery.ts 重写已移除该依赖。**整文件可删**（与 §1.0 H3C LLDP 项关联：vendor-commands 方向已废弃）。
- **`ai.ts:516 executeCommandOnDevice`（单数）** — callers=0，discovery.ts import 的是复数 `executeCommandsOnDevice`，单数为历史预留 wrapper。

### §2.2 待确认（investigate / verify_then_remove）

- **jsdom（依赖，medium）** — vitest.config.ts environment='node' 非 jsdom，零激活。唯一引用在 package.json 与文档。verify 后可移。
- **`knowledgeBaseService.ts:770 ragQuery`（medium）** — callers=0，ai.ts 走 kbSearch 而非 ragQuery。verify 后可移。
- **`authGuard.ts:12 isAuthenticated`（medium）** — callers=0，main.ts import 的是 secure/safe/setAuthenticated。疑有意预留查询入口，investigate。
- **`src/mock-api.ts`（high/investigate）** — import grep 零命中，但 index.html 动态注入 `s.src='/src/mock-api.ts'`（dev-only 浏览器预览）。**动态引用，保留**。
- **`experienceService.ts:86 assertCanonicalTimestamp`（low/keep）** — 07-VERIFICATION 明确为 Phase 11 入口预留的前瞻守卫（CR-02 preplant），有意保留。
- **`scripts/build-electron.cjs`（low/keep）** — package.json build:electron 调用，DOMMatrix polyfill 注入工具，非临时。
- **终端弹窗四件套（low/keep）** — terminal-main.tsx / terminal-preload.ts / terminal.html / TerminalWindow.tsx 被 connection.ts loadFile 引用，非孤立。

---

## §3 代码地图 drift（27，12 high）

**整体结论**：`.planning/codebase/` 8 文档落盘于 2026-07-26，v1.1（Phases 7-11，8 月）改动未更新。**全部滞后，需整体重刷**（`/gsd:map-codebase` 或 doc-updater agent）。

### High（12，按文档）

- **ARCHITECTURE.md** [missing] 缺 Phase 7-11 经验子系统：preload experience 命名空间 17 方法、experienceIpc/experienceDraftingIpc、6 个新 service、setExperienceMasterKey 注入、experiences+exp_device_rel 表与加密列。
- **ARCHITECTURE.md** [outdated] MIGRATION_HEAD 7→10，缺 v8/v9/v10 迁移说明。
- **STRUCTURE.md** [outdated] services 20→26、ipc 7→9、database MIGRATION_HEAD 7→10、缺 src/components/knowledge 与 src/types/experience.ts。
- **TESTING.md** [outdated] 测试规模 7 文件/55 tests → 16 文件/232 tests，缺 v1.1 新增 9 co-located 测试清单。
- **TESTING.md** [incorrect] vitest.config.ts include 仍写 `tests/**/*.test.ts`，实际含 `electron/**/*.test.ts`；测试布局说明应改为 co-located 与 tests/unit 并存。
- **CONVENTIONS.md** [missing] 模式 1a 函数式 service 范例缺 experienceService；masterKey 注入清单缺 experience；模式 6 MIGRATION_HEAD 7→10。
- **CONCERNS.md** [incorrect] safe() 当前零 caller 断言错（现有 4 caller：auth:* 全改 safe）；IPC 文件 7→9。
- **INTEGRATIONS.md** [incorrect] 未检测到 CI — 实际有 `.github/workflows/build-smoke.yml` + rebuild:native。
- **INTEGRATIONS.md** [missing] Data Storage Schema 缺 experiences/exp_device_rel 两表及 bi-temporal/复用计数/severity 字段。
- **INTEGRATIONS.md** [missing] APIs 缺 v1.1 经验两阶段编排/精排/检索/引用溯源/PII 分级脱敏等 LLM 集成点。
- **CONVENTIONS.md** [missing] 缺 v1.1 五条新约定：co-located 测试、强 schema LLM 输出、PII 分级脱敏纯字符串 transform、bi-temporal 软失效 + assertCanonicalTimestamp、experience IPC 全 secure + 白名单正向投影。

### Medium（9）/ Low（6）

- STACK.md [missing medium] 缺经验沉淀能力栈（experienceRetrieval/Rerank/drafting）。
- ARCHITECTURE.md [outdated medium] 迁移注册表 v1-v7→v1-v10；启动序列 setXxxMasterKey 6→7 + backfillSeverityFromHistory 钩子。
- CONVENTIONS.md [outdated medium] Logging type 枚举缺 security。
- CONCERNS.md [outdated medium] TD-1 any 计数 204/30 → 243/36（v1.1 新 service 大量 any）。
- CONCERNS.md [outdated medium] FRAG-2 静默吞错点 KnowledgeBasePage.tsx:42/:123 行引用过时（已重构为 Tabs）。
- TESTING.md [outdated medium] "service 层 0 测试"断言对 experience 域不成立。
- STRUCTURE.md [outdated medium] pages 下经验功能嵌 knowledge/，无独立 ExperiencePage。
- STRUCTURE.md [missing medium] 缺 src/types/experience.ts。
- 其余 6 条 low：ARCHITECTURE/STRUCTURE/INTEGRATIONS 行号漂移与示例时态修正。

---

## §4 处置建议（分 4 类）

| 类 | 内容 | 工作量 | 建议 |
|----|------|--------|------|
| A. 清理 dead code | §2.1 五项（@types/uuid + vendor-commands 整文件 + ai.ts 单数 wrapper） | 小/低风险 | **先做**，/gsd-quick 一次清 |
| B. 修真 high 缺陷 | §1.1 四项，其中 Phase 8 validateDrafts 标记扫描（安全）最值得代码层闭环 | 中 | 进 milestone 或 /gsd-quick 逐项 |
| C. 重刷代码地图 | §3 全部 27 drift | 中（doc-updater agent） | **值得做**，消 12 high drift，新人/onboarding 受益 |
| D. 甄别剩余 deferred | §1.0 旧规划 4 待甄别 + §1.2/1.3 medium/low | 大 | 进下个 milestone `/gsd:new-milestone` 规划排期 |

附：本次会话已单独梳理的 5 条用户优化点（设备过滤/FOLLOWUP-1 等）与本报告 §1 有重叠（如设备过滤 = §1.2 Phase 10 UAT 1b），合并处置。

---

## §5 验证收尾（2026-08-07 真机 HV）

体检处置（A/B/C）落地后启动 electron:dev 真机验证，4 项 HV 全过：

| HV | 项 | 结果 |
|----|----|------|
| HV-1 | kb-db-malformed 章节删改 | ✓ verified（资料库章节删/改保存，FTS5 无 malformed）|
| HV-2 | Phase 08 live LLM 起草 + #4 反幻觉 | ✓ verified（2 阶段起草 + 入库经验无 `[CMD]`/`[KB_SEARCH]` 标记）→ STATE.md Phase 08 Deferred 转 passed |
| HV-3 | 加密 R2/R3 告警（B #5 修复后）| ✓ verified（删 master.key → 系统日志页 type=security warning 可见 → 还原恢复；master.key mtime 5月9日确认原版还原）|
| HV-4 | exec-cmd-concat 命令粘连 | ✓ verified（真 H3C 自动发现，topology edges 非空）|

**§1.1 真 high 4 项状态更新：**
- #1 exec-cmd-concat → ✓ verified（HV-4）
- #2 加密 R2/R3 → ✓ verified（HV-3，依赖 B #5 v11 迁移修复告警落库）
- #3 DEP-1 ABI 缓解 → 仍 defer（大工程，进下个 milestone）
- #4 validateDrafts 标记扫描 → B 类代码层闭环（commit `8af620b`）+ HV-2 间接验证（起草正常不被误拒）

**A/B/C 改动回归全绿**：1.1 v11 迁移（user_version=11 + CHECK 含 security 实测）+ 1.2 dead code 删除（功能 + grep 双证）+ 1.3 validateDrafts（HV-2 起草正常）。

**剩余 defer**：#3 DEP-1 ABI 缓解（milestone 级）+ §1.2 medium 15 + §1.3 low 23 + Phase 03/06 真机 HV（本次未做）+ 旧规划回退 4 项甄别。进 `/gsd:new-milestone` 排期。
