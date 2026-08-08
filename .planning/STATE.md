---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: 安全与稳定性加固
status: executing
last_updated: "2026-08-08T03:25:00.000Z"
last_activity: 2026-08-08 -- Phase 12 Plan 02 complete（SSH/Telnet 真路径回归）
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 3
  completed_plans: 2
  percent: 22
---

# STATE: network_toplogy

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-01)

- **Core Value**: 让运维人员在一个桌面工具内安全地掌握网络拓扑、远程操控设备并获得 AI 辅助分析。拓扑准确呈现与设备安全可控为最高优先级。
- **Current Focus**: v1.2 安全与稳定性加固（Phases 12-14，7 REQ：TEST-01/02 + SEC-03/04/05 + FIX-01/02）。Phase 12 测试基础设施（DEP-1 ABI 缓解）→ Phase 13 安全加固 cluster（SSH 算法 + pre-release + IPC 校验）→ Phase 14 缺陷+旧规划回退闭环。ROADMAP.md 已重写为 v1.2，下一步 `/gsd:plan-phase 12`。
- **Mode**: Cluster Slices（按体检来源聚类分 phase：测试基础设施 → 安全加固 → 缺陷/回退闭环，续 v1.1 Phase 11 从 Phase 12 起 sequential naming）

## Current Position

Phase: 12 (test-infrastructure-dep-1-abi) — EXECUTING
Plan: 3 of 3（Plan 01 测试基础设施主干 + Plan 02 SSH/Telnet 真路径 complete，待 Plan 03 句柄泄漏专项 + CI 扩展）
Status: Plan 12-02 complete（SSH/Telnet 真路径回归 + A2/IAC 双 checkpoint PASS + TEST-02 四条 cleanup 路径泄漏检测全绿），三绿门禁全绿 + SC4 兜底通过
Last activity: 2026-08-08 -- Plan 12-02 complete（ai executeCommandsOnDevice/execOne + arpCollector executeSSH + telnetExec executeTelnetCommand 真路径 + handleLeakDetector 默认白名单反馈环）

## Performance Metrics

**v1.1 Velocity:**

- Phases completed: 0/5（Phase 7 执行完，待 verify 后计入）
- Plans executed: 2（07-01 + 07-02）
- REQ delivered: 0/20（SEC-01/02 + EXP-01/02/03 待 verify 后计入）

**v1.0（已归档，shipped 2026-07-05）:**

- Phases completed: 6/6
- Requirements delivered: 14/14（BUILD-01, ARCH-01/02, PERF-01~04, DATA-01, FE-01~04, ROBUST-01/02）
- Plans executed: 16/16（af12dc0 → d906cab）
- Velocity: Phase 6 两 plan ~7min + ~5min（串行，三绿门禁全绿）

## Accumulated Context

### Key Decisions

v1.1 roadmap 阶段（按 design 文档分层 + 目标倒推）：

- **Phase 编号继续**：v1.0 止于 Phase 6 → v1.1 从 Phase 7 起（未 reset，沿用 sequential naming）
- **SEC 横切需求落 Phase 7 而非散落**：SEC-01（IPC 鉴权）+ SEC-02（脱敏规范）是经验数据层/服务层/IPC 网关的地基，Phase 7 立此基线后下游 phase 复用；避免跨 phase 重复映射（每个 REQ 唯一 phase）。Phase 8 的 DRAFT-02（PII 脱敏前置）是 SEC-02 契约的*消费者*，但脱敏*契约*（所有经验 IPC 走 secure/safe）锚在 Phase 7
- **Phase 8 依赖 Phase 7**：draft 态草稿需 `experiences` 表 + experienceService + 鉴权基线才能落库
- **Phase 9 依赖 Phase 8**：人工确认弹窗需 draft 态草稿作输入（review 是 session→permanent 唯一闸口）
- **Phase 10 依赖 Phase 7（数据层）**：浏览页手动 CRUD/筛选/标失效主要落数据层；Phase 9 confirmed 经验充实列表但不阻塞页面本身
- **Phase 11 依赖 Phase 7 + 10**：检索需经验库（Phase 10 内容 + Phase 7 bi-temporal 过滤/commandSafety 联动基线）
- **三条红线贯穿**：不上向量库（FTS5+SQL 粗筛+LLM 精排）/ 不引图数据库（exp_device_rel 关联表复刻轻量图边）/ AI 产出永远先进 draft 人工确认才 published
- **REQ 计数更正**：REQUIREMENTS.md header 原写 "19 total"，实际 20（EXP4+DRAFT4+REVIEW3+BROWSE4+RETRIEVE3+SEC2=20）。Traceability 表 20 行佐证。roadmap 按 20 计，覆盖 20/20

Phase 7 执行期决策（07-01 落地）：

- [Phase 7]: 07-01 content 明文 / attrs_enc 加密分离 — content 支撑 Phase 11 FTS5 检索无法加密，敏感凭证只放 attrs 走 AES-256-GCM（威胁 T-07-04 accept 取舍）
- [Phase 7]: 07-01 4 态 status（draft/confirmed/published/invalid）+ source_session_id/last_verified_at/reuse_count 建表即预埋 — 避免 Phase 8-10 状态机/溯源/复用补迁移
- [Phase 7]: 07-01 experienceService 采用函数式形态（模块级 let MK + export function，无 class）— 与 knowledgeBaseService.ts 同属知识库域同读写加密列，形态一致便于维护
- [Phase 7]: 07-01 测试用内存 mock DB 规避 DEP-1 native binding ABI 冲突 — vitest 在 plain Node 运行无法加载 @electron/rebuild 重建的 better-sqlite3，service 经 _setExperienceDbGetter（@internal）注入 db getter，生产路径走 getDatabase() 单例不受影响

Phase 7 执行期决策（07-02 落地）：

- [Phase 7]: 07-02 experience IPC 10 channel 全 secure 包装（无 safe）— 经验数据属登录后特权操作（涉敏感 attrs/凭证片段），无登录前场景，未登录 throw '未登录或会话已过期'（SEC-01 落地）
- [Phase 7]: 07-02 experience:listDevices 经 IPC 边界 stripEncColumns 剥离 _enc 列 — service 不解密设备名（不越域调 device 通道），IPC 边界统一删 _enc 后缀 key，renderer 永不收设备密文（SEC-02 落地）
- [Phase 7]: 07-02 IPC 层不 import MAX_BATCH — 透传 opts.limit 不二次校验，service 层 listExperiences 内 MAX_BATCH=1000 throw 已强制，避免双层校验逻辑漂移与 noUnusedLocals 触发
- [Phase 7]: 07-02 channel 命名遵循全仓 camelCase 事实约定 — 复合词 action 用 camelCase（relateDevice/unrelateDevice/listByDevice/listDevices），与 kb:listDocuments/anomaly:acknowledgeAll 等一致；ipc↔preload 三向逐字一致（diff exit 0）

Phase 8 执行期决策（08-01 落地）：

- [Phase 8]: 08-01 v9 迁移加 experiences.duplicate_of_exp_id TEXT nullable 列 — hasColumn 幂等守卫 + db.transaction（throw ROLLBACK），支撑 Plan 03 起草标注命中旧条目 + 二期经验↔经验关联预留；fresh-install DDL 与迁移两路径逐字一致
- [Phase 8]: 08-01 PII 脱敏分级（凭证全脱敏 **** + IPv4 尾4 + MAC 前3掩码后3保留）— 送 LLM 前主进程串联（凭证→IP→MAC，避免凭证值被 IP/MAC 正则误伤），原始 chat_history 明文不动；MAC 以 D-04 范例为准（前三段掩码），plan 注释「前两段掩码后四段保留」与范例矛盾时以范例为准
- [Phase 8]: 08-01 duplicateDetector 函数式查重（同分类+设备优先/无设备全库）— 喂前150字摘要列表无硬阈值（信任 LLM + 红线③人工确认兜底），复用 Phase 7 listExperiences，无 class/MK 持有
- [Phase 8]: 08-01 createExperience 扩展接受可选 duplicateOfExpId — 单语句原子 INSERT 含 duplicate_of_exp_id 列（B-1 Service 封装 + B-2 共存亡方案 A），CREATE 失败 throw 整条不落库；编排层不裸 SQL UPDATE（grep 反向守卫=0）；不校验 FK 存在性（experiences 无 self-FK，信任 Plan 03 + Phase 9 兜底）

Phase 8 执行期决策（08-02 落地）：

- [Phase 8]: 08-02 draftingService 函数式无 class 无 MK（不读写加密列，grep encrypt/decrypt=0 反向守卫）— 与 CONVENTIONS Pattern 1b（无加密列 service）一致；callAI 签名零改动（D-01 红线，grep response_format/json_object/raw.json=0），代码层 JSON.parse + schema 校验作 schema Drift Gate
- [Phase 8]: 08-02 W-4 两阶段复判窄化语义落地 — 阶段 A draftSession 纯起草 existingSummaries=[]（不喂存量全标 ADD），阶段 B judgeVerdicts 编排层按每条 draft.category 窄查喂同分类存量（≤50 条截断）复判覆盖 verdict+dupId，防单次起草 4×1000 context 溢出；judgeVerdicts 短路（全分类无存量不调 LLM）+ LLM 未返 draft_index 保守保持 ADD 初值（信任红线③ 人工确认兜底）
- [Phase 8]: 08-02 W-2 confidence 边界统一收口 — '85%'→0.85 / '0.9'→0.9 / 'high'→NaN fail / 1.5→超界 fail（typeof string 先 parseFloat/百分比转换 + 范围校验），任一 fail 整体重试 MAX_DRAFT_RETRIES=3 次（D-01 schema Drift Gate）

Phase 8 执行期决策（08-03 落地）：

- [Phase 8]: 08-03 W-4 两阶段编排落地（阶段A draftSession existingSummaries=[] 纯起草 + 阶段B findExistingForDraft 按 distinct category 窄查 ≤50 条/分类截断 + judgeVerdicts 复判覆盖 verdict+dupId），避免单次起草 4×1000 context 溢出，复用 08-01 findExistingForDraft 窄化检索粒度（D-02 同 category+同 deviceId）
- [Phase 8]: 08-03 B-1+B-2 方案A 门面落库（UPDATE 经 createExperience duplicateOfExpId 单语句原子写 dup_id，不裸 SQL UPDATE，不 try/catch 吞错；CREATE 失败即 throw 中断该条 draft 落库，标注与 draft 行共存亡）；relateDevice 的 try/catch 保留因设备关联独立于 dup_id 原子单元（关联缺失可 Phase 10 浏览页手动补）；DraftingResult DTO 不含会话原文（T-08-13 边界脱敏，renderer 经 experience:summarizeSession 永不收 chat_history 明文）

Phase 9 执行期决策（09-01 落地）：

- [Phase 9]: 09-01 扩现有 experienceService.ts 而非新建 reviewService（同函数式 + 同模块级 MK 作用域 + 同 dbGetter 测试钩子，最小改动；与 PATTERNS.md Integration Points「扩 experienceService 或新 reviewService」一致选最小改动）
- [Phase 9]: 09-01 confirmDrafts 单事务原子（adopt draft→published + 可选 supersede 旧条目 invalidateExperience + discard hard delete + 设备关联 diff 全成全败，throw ROLLBACK，D-9-4）；循环外 prepared statement 复用 stmtPublish（CONVENTIONS Pattern 4）
- [Phase 9]: 09-01 不动 CR-01 收紧的 updateExperience 白名单——status 改变只走新增专用接口 confirmDrafts 内的 `UPDATE experiences SET status='published'` 单语句（与 invalidateExperience 同受控接口模式，T-09-04 mitigate）
- [Phase 9]: 09-01 relateDevices 语义：undefined 或空数组都视为「不动现有关联」（diff 跳过），仅 length>0 显式数组触发 toAdd/toRemove diff（防 renderer 默认空数组静默拆光所有现有关联）
- [Phase 9]: 09-01 supersedeOld 默认 false（D-9-2，防 Phase 8 AI 误判 UPDATE 实为 ADD 误删有效旧条目），用户主动勾选才 invalidateExperience 旧条目；service 层兜底质量门（troubleshooting severity/symptoms/resolution + 轻结构 title/content 必填，与 renderer 标红三层纵深，T-09-01 mitigate）
- [Phase 9]: 09-01 MemDb mock 增强（非业务，测试支撑）：transaction 加 ROLLBACK 语义（snapshot/restore 复刻 better-sqlite3 真实行为）+ UPDATE SET 分词改用括号/引号感知 tokenizer（处理 datetime('now','localtime') 内含逗号 + 'literal' 字符串字面量去引号）

Phase 9 执行期决策（09-02 落地）：

- [Phase 9]: 09-02 IPC 层 import MAX_BATCH（与 07-02 不同）——07-02 experience:list 透传 opts.limit 不二次校验（service 兜底），但 09-02 confirmDrafts 是写操作 + untrusted renderer 直接入参 drafts 数组，IPC 层加 MAX_BATCH 校验作双层防御（T-09-06），故 import MAX_BATCH 避免 noUnusedLocals 触发；两决策各自成立

Phase 10 执行期决策（10-01 落地）：

- [Phase 10]: 10-01 severity 明文列迁移 v10（hasColumn 守卫 + db.transaction + bump user_version=10 + MIGRATION_HEAD=10）—— attrs.severity 保留向后兼容（双写），v10 内不解密回填（迁移在 MK 注入前跑），service 层 rowToExperience severity fallback 兜底（明文列 NULL 读 attrs.severity，D-10-2 历史数据兼容核心承诺）
- [Phase 10]: 10-01 restoreExperience 受控接口（清 invalid_at + status 显式回 published）—— 绕 CR-01 update 白名单（不复活 status 字段），与 invalidate/incReuseCount/touchLastVerifiedAt 同模式；status 直回 published 不接受 renderer 入参（T-10-03 mitigate，无法被滥用改其他状态）；invalidate 不动 status 故 restore 须显式回（对称恢复有效态）
- [Phase 10]: 10-01 listExperiences opts 扩 search/severity/tags 参数化筛选 + deviceId 多选 IN 占位 OR-join（normalize string|string[]）—— 全 ? 占位 + params.push（无字符串拼接用户输入，T-10-01 mitigate SQL 注入）；两分支 rowsSql 带 device_count 子查询（共享常量 deviceCountSub 注入，零 N+1）；多选分支 GROUP BY e.id + COUNT(DISTINCT e.id) total 去重（一条经验关联多选中设备只算 1 条）
- [Phase 10]: 10-01 createExperience 入参扩 status?（默认 draft 保 Phase 7-9 AI 起草调用方零改动）+ severity 明文列双写（troubleshooting 类填 critical/high/medium/low/info，其他 null）—— 手动新增传 published 是红线③ 例外（人工录入非 AI 产出，D-10-1 discretion）
- [Phase 10]: 10-01 multi-device total 用 COUNT(DISTINCT e.id) 单层去重（替代双层嵌套子查询，sqlite 原生支持 + mock 更简洁）—— 偏离 plan §action 描述但语义等价，记录于 10-01-SUMMARY deviations
- [Phase 9]: 09-02 IPC 入参类型用 renderer DTO ConfirmDraftsInput（与现有 ExperienceInput import 同模式），service 内部接受同构 ExperienceUpdateFields，TS 结构化类型兼容无运行时开销；fields 复用 ExperienceUpdateInput（CR-01 白名单，不含 status）
- [Phase 9]: 09-02 DraftSummary = Experience type alias（复用现有 DTO 不重复定义，与 Phase 7 ExperienceRelatedDevice = Device 同模式）
- [Phase 9]: 09-02 三向一致 channel 名逐字相等（experienceIpc ↔ preload ↔ electron.d.ts），ai.getSessionMessages 与 experience.getSessionMessages namespace 隔离各占 1，grep 验证全 = 1

Phase 11 执行期决策（11-01 落地）：

- [Phase 11]: 11-01 D-11-1 b 自动预取——chat() 入口先调 retrieveForAnswer（编排层 service 间互调不经 IPC），不靠 AI 自主标记（[EXP_SEARCH] 协议不抄），每轮必查不漏；retrieveForAnswer 整体 try/catch 隔离，异常 expReferences=[] 继续正常答（D-11-9 不阻塞主路径）
- [Phase 11]: 11-01 精排/编排 service 函数式无 class 无 MK（Pattern 1b，grep encField/decField/MK 实际用法=0，仅 docstring 字面提及与 draftingService.ts header 同格式）——候选经 listExperiences 已解密 attrs 明文传入，本层不碰密文
- [Phase 11]: 11-01 D-11-5 零迁移零新表——复用 Phase 10 listExperiences 的 search（LIKE title/content 参数化）+ deviceId 多选 IN 占位做粗筛，不上 FTS5（精排覆盖相关性排序 + SQLite 中文分词坑 + 量级小）
- [Phase 11]: 11-01 D-11-3 方案 Y 精排承担理解——每轮 2 次 LLM（精排 rerank + 正式答 callAI），不单独加关键词提取步骤（独立提取冗余）；D-11-4 RELEVANCE_THRESHOLD=0.6 硬编码模块常量防噪声
- [Phase 11]: 11-01 read-time 两项验证（D-11-6）——有效期失效剔除（粗筛 includeInvalid=false 已过滤，二次确认防窗口跨天）+ 命令白名单 cmds.some 失支持标 unsupported=true 降权不剔除（保守宁可多标）；不验设备状态（D-11-8 反逻辑）；CMD_EXTRACT_RE 限定只读首词不提取变更类（T-11-02 mitigate）
- [Phase 11]: 11-01 信任边界——精排 prompt 只送 exp_id+title+content 前150字（不送 attrs 凭证字段）；references 回 renderer 只含 exp_id/title/source_session_id/unsupported（D-11-11 从注入记录拿不需 AI 标记）；INJECT_LIMIT=5/MAX_CANDIDATES=20 经验注入要精不要多防 context 溢出

Phase 11 执行期决策（11-02 落地）：

- [Phase 11]: 11-02 字段命名以 ai.ts:835 实际返回为准（camelCase expId/sourceSessionId），非 plan interfaces 文档笔误的 snake_case——prior_wave_handoff 与源码核对后对齐，避免运行时 parsed.references.expId 为 undefined
- [Phase 11]: 11-02 session 引用在 renderer 拆出——ai.ts:835 exp_answer references 只返 experience 类型，useAIChat 消费时每条 experience 检查 sourceSessionId 非空则额外 push session 引用项（D-11-10 末尾列表含会话引用），不重复落库 ai.ts 不动避免回归
- [Phase 11]: 11-02 kb_answer 分支 map 补 kind:'kb'——ai.ts KB_SEARCH 返的 kbReferences 无 kind 字段，ReferenceItem 联合类型需显式 kind 类型安全（运行时已有 kind 直接透传）
- [Phase 11]: 11-02 ChatMessageList renderRef 按 ref.kind 分流（kb 保持既有 BookOutlined / experience 可点开 ExperienceDetailModal / session 可点开 SessionMessagesModal），session 走末尾 else 不写显式条件；D-11-7 命令失支持用 antd Tag color='warning' 既有色枚举不引 hex 新色；D-11-12 复用 Phase 10/9 既有 Modal 零新建浏览只读场景不传 onEdit 等回调

Phase 12 执行期决策（12-01 落地）：

- [Phase 12]: 12-01 test:electron 通道落地——cross-env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run --config vitest.electron.config.ts（直连 electron.exe 路径非 CLI，Pitfall 2）；A1 checkpoint 实跑确认 vitest/4.1.5 经此入口可调起（Node v24.14.0 内嵌，NODE_MODULE_VERSION 与 @electron/rebuild 重建后一致）；不装 electron-vite/electron-vitest（vite 8 peer 不兼容 + alpha 死包，RESEARCH 已否决）
- [Phase 12]: 12-01 双 vitest config 物理隔离（Pitfall 6）——plain vitest.config.ts 加 exclude tests/electron/**（Rule 3 阻塞性修复：原 include tests/**/*.test.ts 会采集 db.real.test.ts 致 plain node npm test 加载 electron-ABI better-sqlite3 触发 NODE_MODULE_VERSION 145≠137 ABI 崩 DEP-1），新 vitest.electron.config.ts include 仅 tests/electron/**；此修改非 SC4 触发（vitest.config.ts 是 root 测试配置非 electron/ 生产代码，git diff electron/ 退出 0）
- [Phase 12]: 12-01 OQ#1 注入策略方案 A（零生产改动）——DB 真路径测试直持 makeRealDb() 返回的真实 better-sqlite3 实例跑 CRUD/迁移，不调 getDatabase() 单例（connection.ts import electron app/backupScheduler 重依赖 vi.mock 牵连过广）；realDb 不 import 生产 init.ts/migrations.ts（createTables/runMigrations 用 getDatabase() 单例无 db 参数），runMigrations 选项跑独立幂等 DDL（hasColumn 守卫模式验证，Rule 2 关键功能 fallback）；Plan 12-02 service 真路径测试用 vi.mock 注入 realDb 实例
- [Phase 12]: 12-01 四 helper 接口契约落地（Plan 12-02/12-03 复用）——realDb { db, dbPath, close }（os.tmpdir 唯一名 + pragma WAL/foreign_keys/busy_timeout/wal_autocheckpoint + close 严格删主文件/-wal/-shm try/catch ENOENT）/ mockSshServer { port, close }（ssh2.Server + crypto.generateKeyPairSync 随机 hostKey T-12-01 + listen(0,'127.0.0.1') loopback T-12-02 + close 返回 Promise Pitfall 4）/ mockTelnetServer { port, close }（net.Server + IAC 协商 checkpoint：识别 0xFF 回 DONT/WONT + stripIac）/ handleLeakDetector expectNoHandleLeak(extraAllow?)（getActiveResourcesInfo snapshot + afterEach sleep(50) Pitfall 4 + 默认放行 Timeout/GetAddrInfoReqWrap Pitfall 5 + wtfnode.dump best-effort A4）
- [Phase 12]: 12-01 wtfnode@0.10.1 装入 devDep（不进生产打包）——npm_config_proxy="" npm_config_https_proxy="" --registry=npmjs.org --userconfig=/dev/null 四件套绕开 ~/.npmrc 配的 npmmirror proxy 127.0.0.1:10809 ECONNREFUSED（Rule 3 阻塞性，proxy 配置覆盖 registry 单 --registry flag 不够）
Phase 12 执行期决策（12-02 落地）：

- [Phase 12]: 12-02 A2 checkpoint PASS——ssh2.Server 在 ELECTRON_RUN_AS_NODE=1 下经 electron.exe 正常 listen + accept 任意凭证 + authentication.accept + exec stream 回显全链路实跑确认（ai.execCommands.real 5 it + arpCollector.real 4 it 全绿佐证，RESEARCH Assumptions Log A2 闭合）
- [Phase 12]: 12-02 telnet IAC checkpoint PASS——mockTelnetServer（12-01 落地 DONT/WONT + stripIac）经真实 telnet-client connect 实跑确认不卡住，shellPrompt mock#/silent# 正常匹配（telnetExec.real 5 it 全绿佐证，RESEARCH+PATTERNS 标记的未完全展开 checkpoint 闭合）
- [Phase 12]: 12-02 vi.mock 反向范式确立——真路径测试对被测协议（ssh2/telnet-client）走真 binding 连 mock 对端，仅 vi.mock 非被测重依赖（commandSafety 让 service 干净加载 + connection 防 electron app 牵连 + device/telnetExec spy 防级联），与 ai.telnetRouting.test.ts 的 vi.mock('ssh2') 形成正向/反向对照
- [Phase 12]: 12-02 OQ#1 注入策略简化——arpCollector.collectFromDevice 实读源码不持久化 arp_entries（只返回 ARPCollectionResult），plan 原文「需 DB 注入 makeRealDb」是误读，connection mock 桩足够（防 connection.ts 牵连 electron app），零生产改动方案 A 维持无需退方案 B 加 _setDbGetter
- [Phase 12]: 12-02 handleLeakDetector 默认白名单反馈环（Rule 2 关键功能）——12-01 仅基于 db.real（无网络）设默认白名单 [Timeout,GetAddrInfoReqWrap]，SSH/Telnet 真路径暴露 TCPServerWrap（mock server listen socket）+ TCPWrap/SimpleWriteWrap（ssh2/telnet-client native stream libuv 释放延迟）跨文件漂移误报，补入默认白名单让 12-03 句柄专项不用每文件重复加；三个测试 expectNoHandleLeak() 调用同步简化不传 extraAllow
- [Phase 12]: 12-02 TEST-02 四条 cleanup 路径全覆盖——executeCommandsOnDevice cleanup（client.end + clearTimeout perCmdTimer）+ execOne cleanup（stream.close/destroy + clearTimeout timer/silenceTimer）+ executeSSH cleanup（client.end + timeout 路径 client.destroy）+ executeTelnetCommand finally cleanup（clearTimeout + connection.end/destroy）句柄泄漏自动化检测全绿（替代 Phase 6 SC#4 + Phase 3 defer 人工 HV，CONTEXT decision #4）；3 被测模块从 0 测试到有真路径（arpCollector 0→4 / telnetExec 0→5 / ai.executeCommandsOnDevice+execOne 0→5）
- [Phase 12]: 12-02 timeout 场景偏离（Rule 1 bug）——arpCollector executeSSH timeout 改用 connection refused（端口未监听，ssh2 banner-wait timeout 在库内部行为下不可靠触发挂满 testTimeout），telnet timeout 改用裸 net.Server（accept 不发 prompt，mockTelnetServer onCmd 返空仍回 shellPrompt 不触发 timeout），两处均同样验证 cleanup 句柄回收路径

v1.0 carry-over（归档前的关键决策，仍约束本 milestone）：

- 加密/迁移改动必须向后兼容历史数据（v1/v2 IV 兼容、迁移幂等守卫靠 sqlite_master 特征串不靠 user_version、throw 即 ROLLBACK）
- IPC 鉴权网关（secure/safe）+ 字段加密（_enc/encField/decField）+ commandSafety.isCommandAllowed 不可回退
- 复用现有能力：`saveChatMessage`（消息已按 sessionId 持久化）、LLM 挑索引检索（`knowledgeBaseService.search` 无 embedding）、`****xxxx` 脱敏、`commandSafety` 安全层

### Pending Todos

- [x] `/gsd-execute-phase 7` — Experience Data Layer & Security Baseline（EXP-01/02/03, SEC-01/02）07-01 + 07-02 全部落地，待 verify
- [x] 08-01-PLAN.md — AI 起草地基层（v9 迁移 + piiMask + duplicateDetector + createExperience 扩展，4 commits a3d8d9e/958c7b3/538c6ad/b76cfa0，三绿门禁全绿 103 测试）
- [x] 08-02-PLAN.md — LLM 起草 service（draftSession 阶段A 纯起草 + judgeVerdicts 阶段B W-4 两阶段复判 + validateDrafts schema Gate + buildDraftingPrompt 反幻觉 + W-2 confidence 边界，TDD RED→GREEN 23 测试全绿，2 commits 253dda4/2ec666e，三绿门禁全绿 126 测试）
- [x] 08-03-PLAN.md — IPC + 编排层串联（experienceDrafting.summarizeSessionForUi W-4 两阶段编排 + experience:summarizeSession secure IPC + preload/main/DTO/类型 + AIPage「经验总结」按钮 + useAIChat.handleSummarize，TDD RED→GREEN 10 测试全绿，4 commits 8cffc07/d146de5/e561a41/3e13788，三绿门禁全绿 136 测试）
- [x] 09-01-PLAN.md — Phase 9 服务层 confirmDrafts/listDrafts/getSessionMessages 落地（扩 experienceService.ts 不新建 reviewService + 单事务原子 adopt/supersede/discard/设备 diff + service 层兜底质量门 troubleshooting severity/symptoms/resolution + 不动 CR-01 update 白名单 status 改变只走专用接口 + 复用 ai.ts getChatHistory 明文回链 D-9-5 + relateDevices 空/undefined 不动关联防默认值传播拆关联，2 commits 455721d/d307b75，19 新测试，三绿门禁全绿 165 测试全 PASS）
- [x] 09-02-PLAN.md — Phase 9 IPC 网关层 + preload bridge + renderer DTO 落地（experienceIpc.ts 注册 experience:confirmDrafts/listDrafts/getSessionMessages 3 个 secure channel + IPC 层 MAX_BATCH 双层防御 + preload 暴露 window.api.experience.* 3 API + src/types/experience.ts 5 renderer DTO ConfirmDraftItem/ConfirmDraftsInput/ConfirmDraftsResult/DraftSummary/SessionMessage + electron.d.ts 3 方法签名 + 三向一致 IPC↔preload↔d.ts channel 名逐字相等 + main.ts 无需改 registerExperienceIpc 已注册，2 feat commits f168ef1/9172476 + 1 docs commit 9b8baec，三绿门禁 tsc+build:electron-main+vitest 165/165 全绿，无回归）
- [x] 09-03-PLAN.md — Phase 9 renderer 层弹窗（ReviewConfirmModal 宽 80vw master-detail 主壳 + 左侧列表勾选/标红 + 底部批量提交 confirmDrafts + validateDraft 导出 + SessionMessagesModal 只读会话回链子 Modal 叠层 + ReviewConfirmEditForm 编辑表单 attrs 模板 + 关联设备 Select + UPDATE supersedeOld D-9-2 默认不勾 + useAIChat/AIPage/ChatInput 串联 handleSummarize 开弹窗 + 待确认 Badge 角标入口 D-9-7 + 表单中文化 label/severity/错误提示，5 commits 458d828/b64e00d/6c43aad/7665bb1/cd87077，三绿门禁 tsc+vite build+electron-main build+vitest 175 全绿，人工 checkpoint approved 全链路无问题）
- [x] 10-01-PLAN.md — Phase 10 数据/服务/IPC 基线（severity v10 列迁移 hasColumn 守卫 + restoreExperience 受控接口 + listExperiences opts 扩 search/severity/tags + deviceId 多选 IN 占位 OR-join + device_count 子查询零 N+1 + createExperience status? 默认 draft + severity 双写 + rowToExperience fallback + experience:restore IPC secure + preload + DTO 三向契约 + Experience 加 severity/device_count，3 commits 2a86fc9/84c4ea5/a1c0ba1，TDD RED→GREEN 9 新 vitest 用例，三绿门禁 191/191 全绿零回归）
- [x] 10-02-PLAN.md — Phase 10 公共组件抽取（ExperienceEditForm 抽出 + validateDraft 单一来源 troubleshooting severity/symptoms/resolution 标红 + ExperienceInput DTO 扩 status? 红线③ 例外手动新增直 published + 复用 09-03 ReviewConfirmEditForm 既有 attrs 模板/关联设备 Select 逻辑，2 commits e2b1506/b95c44d，三绿门禁 191/191 全绿零回归 Phase 9 表单不回归）
- [x] 10-03-PLAN.md — Phase 10 UI 层（KnowledgeBasePage 改 Tabs 文档|经验 + ExperienceTab 列表/多维筛选含设备多选 mode multiple/Table 9 列含第 5 列「N 台/全局」用 record.device_count 渲染零 N+1/手动 CRUD 新增直 published/三能力标失效+恢复+物理删除按状态切换 Popconfirm 软硬区分/draft 前端 filter 兜底 + ExperienceDetailModal width 900 footer null 元数据+SessionMessagesModal 叠层+severity 语义色 Tag + ExperienceEditForm.onSubmit 扩 relateDevices 解决 10-02 遗留，3 feat commits 23ad8a5/e2f4be8/b525dcd + 1 docs commit，三绿门禁 tsc+vite build+electron-main build+vitest 191/191 全绿零回归，人工 checkpoint approved 信任门禁收尾——三绿门禁全绿 + UI-SPEC 关键渲染 grep 验证全命中跳过实机，BROWSE-01/02/03/04 UI 层全落地 Phase 10 完成）
- [x] 10-04-PLAN.md — Phase 10 gap closure（5 项必修：CR-01 restoreExperience 双层守卫 service+SQL + CR-02 backfillSeverityFromHistory 幂等回填钩子 main.ts post-MK 调用 + WR-01 tags LIKE ESCAPE 转义 + WR-02 setExperienceDevices 单事务原子 IPC 三向一致 + 问题 2 状态 Select 联动 includeInvalid + invalidOnly service 路径 + 问题 1a ExperienceEditForm 设备 filter 放开全类型 + WR-05 两处 formatTs 兼容 ISO + WR-03 顺手清，2 fix commits 29021cc/411b8e5，9 新 vitest 用例 CR-01 4+CR-02 2+WR-01 1+WR-02 2，三绿门禁 tsc+vite build+electron-main+vitest 200/200 全绿零回归，IPC experience:setDevices 三向一致，5 gap grep 全断言通过）
- [x] 11-01-PLAN.md — Phase 11 main 进程 service 层（experienceRerank.ts 精排强 schema LLM 评分 exp_id 防编造 + score 边界归一化 + 3 次重试 + 反幻觉 prompt + experienceRetrieval.ts 编排 retrieveForAnswer 粗筛窄查/宽匹配双分支 + 阈值过滤 + read-time 两项验证有效期剔除/命令失支持降权 + 命中刷新计数不阻塞 + ai.ts chat() b 自动预取串联 retrieveForAnswer + 经验正文注入 systemPrompt + exp_answer 返回类型 references 联合，2 commits e4c0809/8653f90，30 新 vitest 用例，三绿门禁 tsc+build+build:electron-main+vitest 230/230 全绿零回归，零迁移零新表零加密列触碰，renderer 永不收 attrs 密文）
- [x] 11-02-PLAN.md — Phase 11 renderer 层引用溯源（types.ts ReferenceItem 联合类型 kb/experience/session + ChatMsg.references 扩联合 + useAIChat exp_answer 消费 camelCase 字段对齐 ai.ts:835 实际契约非 plan 文档笔误 snake_case + kb_answer 分支 map 补 kind:'kb' + session 引用从 experience.sourceSessionId 拆出 D-11-10 + ChatMessageList renderRef 按 kind 分流渲染 + 复用 Phase 10 ExperienceDetailModal/Phase 9 SessionMessagesModal 零新建 D-11-12 + 命令失支持 antd Tag color=warning 既有色 D-11-7，2 commits 987b9c4/b683b84，四绿门禁 tsc+vite build+build:electron-main+vitest 230/230 全绿零回归，acceptance grep 全断言通过，RETRIEVE-03 UI 层全落地）
- [x] 12-01-PLAN.md — Phase 12 测试基础设施主干（DEP-1 ABI 缓解：test:electron 通道 cross-env ELECTRON_RUN_AS_NODE=1 electron.exe vitest.mjs + 双 vitest config 物理隔离 Pitfall 6 + wtfnode@0.10.1 devDep + 4 helper 契约 realDb/mockSshServer/mockTelnetServer/handleLeakDetector + db.real.test.ts 真路径 CRUD/迁移幂等/WAL，3 commits aea9154/3022350/dae9f18，A1 实跑确认 vitest/4.1.5，OQ#1 方案 A 零生产改动，4 deviations 全 auto-fixed（2 Rule 3 阻塞性 + 2 Rule 2 关键功能），三绿门禁 test:electron 3/3 + npm test 244/244 + build:electron-main 全绿零回归，SC4 git diff electron/ 退出 0）
- [x] 12-02-PLAN.md — Phase 12 SSH/Telnet 真路径回归（ai executeCommandsOnDevice/execOne + arpCollector executeSSH + telnetExec executeTelnetCommand 真路径，复用 12-01 mockSshServer/mockTelnetServer/handleLeakDetector 契约，vi.mock 反向范式被测协议走真 binding 仅 mock 非被测重依赖，2 commits 37f5cca/40f13e5，A2 checkpoint PASS + telnet IAC checkpoint PASS，TEST-02 四条 cleanup 路径泄漏检测全绿，handleLeakDetector 默认白名单反馈环，5 deviations 全 auto-fixed，三绿门禁 test:electron 17/17 + npm test 244/244 全绿零回归，SC4 git diff electron/ 退出 0）

### Blockers/Concerns

- 无

### Quick Tasks Completed（v1.0 close 后）

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260726-p9e | pre-release hardening（H1+M1-M5+L5/L11/L13/L14）→ bump 0.1.2 | 2026-07-26 | b6a689b/490c20f | quick/260726-p9e-pre-release-hardening-bump-0-1-2/ |
| 260726-udg | doc-code 一致性审计报告（14 维度/121 发现/0 误报） | 2026-07-26 | fc80c7f | quick/260726-udg-doc-code-audit/ |
| 260726-upa | R2/R3 加密核心加固（decField 可观测 + keyManager 翻转抛错） | 2026-07-26 | 0613832 | quick/260726-upa-crypto-key-hardening/ |
| 260726-vcu | R5 收尾——commandSafety + authGuard 单测（55/55） | 2026-07-26 | 815ae87 | quick/260726-vcu-command-safety-authguard-tests/ |
| 260726-voh | 文档同步——workflow 刷新 13 文档消 85 条 drift | 2026-07-26 | 224b56b | quick/260726-voh-doc-sync/ |
| 260726-w67 | P1 加固——auth safe 包装 + app.isPackaged + native rebuild/CI 冒烟 | 2026-07-26 | 998d1cf | quick/260726-w67-p1-hardening/ |
| 260805-scm | saveChatMessage 空内容守卫防 chat_history.content_enc NOT NULL 崩溃（debug 收尾，网络超时降级为清晰错误） | 2026-08-05 | 5dd120c | -（fast inline） |
| Phase 07 P07-01 | 7m24s | 2 tasks | 5 files |
| Phase 07 P07-02 | 5m56s | 2 tasks | 5 files |
| Phase 07 P07-02 | 5m56s | 2 tasks | 5 files |
| Phase 08 P01 | 12m | 4 tasks | 8 files |
| Phase 08 P02 | ~3.5min | 1 task (TDD) | 2 files |
| Phase 8 P02 | ~3.5min | 1 tasks | 2 files |
| Phase 08 P03 | ~7min | 3 tasks | 11 files |
| Phase 09 P01 | ~6min | 2 tasks | 2 files |
| Phase 09 P02 | ~7min | 2 tasks | 4 files |
| 260804-t2q | fix telnet 长输出截断（分页 + shellPrompt 精确化） | 2026-08-04 | 534fdc9/913aade | [260804-t2q-fix-telnet-long-output-pagination-trunca](./quick/260804-t2q-fix-telnet-long-output-pagination-trunca/) |
| Phase 10 P01 | ~13min | 3 tasks | 9 files |
| Phase 10 P02 | 12min | 2 tasks | 3 files |
| Phase 10 P03 | ~14min | 4 tasks (3 auto + 1 checkpoint approved) | 4 files |
| Phase 10 P04 | ~14min | 3 tasks (2 tdd + 1 验证) | 10 files |
| Phase 11 P01 | ~12min | 2 tasks (tdd) | 4 files |
| Phase 11 P02 | ~6min | 2 tasks | 3 files |
| 260807-fzd | 清理 dead code：删 @types/uuid + vendor-commands.ts + ai.ts 单数 wrapper | 2026-08-07 | 0bd4dbd/287e26c/d3f5e08 | [260807-fzd-dead-code-types-uuid-vendor-commands-ts-](./quick/260807-fzd-dead-code-types-uuid-vendor-commands-ts-/) |
| 260807-gfk | 安全 hardening B：validateDrafts 标记扫描 + ai_system_logs CHECK 扩 security v11 | 2026-08-07 | 5a824cd/8af620b/11f8f57 | [260807-gfk-hardening-b-validatedrafts-cmd-kb-search](./quick/260807-gfk-hardening-b-validatedrafts-cmd-kb-search/) |
| Phase 12 P01 | ~76min | 3 tasks | 10 files |

### Risk Watch

- 三条红线（向量库/图库/全自动确认）任何 phase 不得突破
- 迁移幂等性（sqlite_master 特征串守卫 + db.transaction，throw 即 ROLLBACK），与 v1.0 Phase 2 ARCH-01 基线一致
- PII 脱敏必须在「送 LLM 前」完成，不可在 LLM 返回后才脱敏（DRAFT-02 红线）
- AI 输出强 schema JSON，分类锁死固定枚举，反幻觉约束写进 prompt（DRAFT-04）
- read-time 即时验证不阻塞检索主路径（降权/剔除而非报错中断，RETRIEVE-02）

## Deferred Items

v1.0 milestone close 时 acknowledged（2026-07-05），DEP-1 native binding 限制下的人工 HV/验证项 + 1 quick artifact 残留：

| Category | Item | Status |
|----------|------|--------|
| uat_gap | Phase 03-HUMAN-UAT.md | partial（3/5 pass：#1/#2/#4；#3/#5 defer，2026-07-26） |
| uat_gap | Phase 05-HUMAN-UAT.md | passed（用户 approved，25 scenarios） |
| uat_gap | Phase 06-HUMAN-UAT.md | partial（HV-1/2/3 pass 句柄不泄漏；HV-4a/b/c defer） |
| verification_gap | Phase 03-VERIFICATION.md | partial（HV #1/#2/#4 回填 pass，#3/#5 defer） |
| verification_gap | Phase 05-VERIFICATION.md | passed（re-verify 2026-07-26） |
| verification_gap | Phase 06-VERIFICATION.md | partial（HV-1/2/3 pass，HV-4a/b/c defer） |
| quick_task | 260628-trt-pdfjs-dist-backupscheduler-retention-0 | resolved（已归档） |

v1.1 milestone close 时 acknowledged（2026-08-06），Phase 8 live LLM HV 真机联调 defer：

| Category | Item | Status |
|----------|------|--------|
| uat_gap | Phase 08-HUMAN-UAT.md | passed（2026-08-07 真机 HV-2：AI Key + 真实会话经验总结，2 阶段起草 + #4 反幻觉 + 入库全绿） |
| verification_gap | Phase 08-VERIFICATION.md | passed（2026-08-07 HV-2 闭环） |
| followup | FOLLOWUP-1 confirmCommand 多轮 [CMD] 循环 | Phase 5 既有设计，记 11-HUMAN-UAT.md Gaps，下期立项 |

v1.1 明确 defer 到二期（4 FUTURE，不进 roadmap）：

| FUTURE | 内容 | 触发条件 |
|--------|------|----------|
| FUTURE-01 | 经验正文 embedding 字位补语义向量召回 | 数据量上来后 |
| FUTURE-02 | 经验↔经验关联（caused-by/resolved-by/similar）+ 图遍历检索 | 数据量上来后 |
| FUTURE-03 | 经验精确到会话内消息段锚点（source_event_ids） | 数据量上来后 |
| FUTURE-04 | 经验关联图可视化（复用 React Flow） | 数据量上来后 |

## Session Continuity

- **Last action**: Phase 12 Plan 02 complete（SSH/Telnet 真路径回归：ai executeCommandsOnDevice/execOne + arpCollector executeSSH + telnetExec executeTelnetCommand 真路径 + handleLeakDetector 默认白名单反馈环；A2/telnet IAC 双 checkpoint PASS；TEST-02 四条 cleanup 路径泄漏检测全绿；三绿门禁全绿 + SC4 兜底通过）
- **Next action**: 继续 Phase 12 Plan 03（句柄泄漏专项 + CI 扩展，handleLeakDetector 默认白名单已含 native stream 句柄类型可直接复用，CI-A/B/C 三方案 RESEARCH 推荐 CI-A mock 套件放 rebuild 前真路径放 rebuild 后；A4 wtfnode dump 调用栈定位待评估是否需 top-level require）
- **Resume command**: `/gsd-status`

## Phase → Requirement Map

| Phase | Requirements |
|-------|--------------|
| 7. Experience Data Layer & Security Baseline | EXP-01, EXP-02, EXP-03, EXP-04, SEC-01, SEC-02 |
| 8. AI Drafting Pipeline | DRAFT-01, DRAFT-02, DRAFT-03, DRAFT-04 |
| 9. Human Review & Confirmation | REVIEW-01, REVIEW-02, REVIEW-03 |
| 10. Experience Browse Page | BROWSE-01, BROWSE-02, BROWSE-03, BROWSE-04 |
| 11. AI Retrieval & Reuse | RETRIEVE-01, RETRIEVE-02, RETRIEVE-03 |
| 12. Test Infrastructure (DEP-1 ABI 缓解) | TEST-01, TEST-02 |
| 13. Security Hardening Cluster | SEC-03, SEC-04, SEC-05 |
| 14. Defect & Legacy Rollback Closure | FIX-01, FIX-02 |

## Operator Next Steps

- `/gsd:plan-phase 12`（v1.2 第一个 phase：Test Infrastructure — DEP-1 ABI 缓解）
