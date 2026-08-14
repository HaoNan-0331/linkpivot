# Milestones

## v1.2 安全与稳定性加固 (Shipped: 2026-08-14)

**Phases completed:** 3 phases, 8 plans, 18 tasks
**Requirements delivered:** 7/7（TEST-01/02 + SEC-03/04/05 + FIX-01/02）
**Known deferred items at close:** 6（见 STATE.md §Deferred Items — Phase 14 confirm 视觉真机 HV + Phase 12 GHA 实跑/CR-01/CR-03 + 10 历史 quick task 归档）
**Git range:** Phase 12 plan → v1.2-MILESTONE-AUDIT.md，覆盖 3 phase / 8 plan

**Key accomplishments:**

1. **测试基础设施 / DEP-1 ABI 缓解（Phase 12, TEST-01/02）**：vitest 经 ELECTRON_RUN_AS_NODE=1 electron.exe 跑通加载 electron-ABI better-sqlite3（弃 electron-vite 不支持 vite 8，改 electron.exe + 双 vitest config 物理隔离，不迁生产构建）+ test:electron 真路径套件 32 it（DB + SSH executeCommandsOnDevice/execOne/executeSSH + Telnet executeTelnetCommand + 句柄泄漏）+ handleLeakDetector 句柄泄漏自动化（getActiveResourcesInfo + wtfnode，四条 try/finally cleanup 全覆盖）+ build-smoke.yml CI-A 扩展。零生产代码改动（SC4）。
2. **安全加固 cluster（Phase 13, SEC-03/04/05）**：connection.ts connectSSH/testSSHConnection 复用 SSH_ALGORITHMS 常量（补 curve25519-sha256 连通现代 Linux + readyTimeout 30s，全仓 3 SSH 路径零 drift）+ pre-release 5 项 hardening 甄别（13-02-DEFER-LOG：L1/L2 DEFER + L3/L4/L6 FIXED，sanitizeMessage CR-01 收紧枚举根前缀防过度脱敏）+ experience:list IPC 网关层 sanitizeListInput 纯函数（search≤100/tags filter string/单tag≤30 截断 + severity throw，W-1 audit 后补 filter）+ VALID_SEVERITIES 单一来源 + service MAX_BATCH 双层兜底。
3. **缺陷修复闭环（Phase 14, FIX-01/02）**：anomalyService.processARPEntries 全新 IP 分支补 recordChange('new_ip') + 首次基线机制（ip_mac_bindings is_baseline 列 v12 迁移 hasColumn 守卫 + hasBaseline 门控 + runBatch 事务内后置 UPDATE，CR-02 fix 事务边界）+ _setAnomalyDbGetter mock 注入口（realDb 8 it 含遗留库向后兼容 Test 6 + 混合批次 Test 7 + UNIQUE fallback Test 8）+ localNow localtime 统一（CR-01 fix）+ FIX-02 旧规划 4 项甄别（confirm 视觉层 confirmInFlight + useRef 同步锁 WR-01 / ai_exec_logs FIXED / 会话标题 FIXED / H3C LLDP DEFER）。

**验证：** 三绿门禁（tsc web strict + build:electron-main + vitest 256 mock + 32 真路径）全 phase 全绿零回归；milestone audit 7/7 REQ satisfied + 跨 phase wiring 11 连接 + 5 E2E 流通 + 三红线零回退；code review 2 Critical（CR-01 时区 / CR-02 事务边界）+ WR-01 useRef 锁全修复；W-1 sanitizeListInput tags filter + W-2 文档校正（audit 后修，三绿 257 全绿）。

---

## v1.1 AI 对话经验沉淀 (Shipped: 2026-08-06)

**Phases completed:** 5 phases, 14 plans, 20 tasks
**Requirements delivered:** 20/20（EXP-01/02/03/04 + DRAFT-01/02/03/04 + REVIEW-01/02/03 + BROWSE-01/02/03/04 + RETRIEVE-01/02/03 + SEC-01/02）
**Known deferred items at close:** 3（见 STATE.md §Deferred Items — Phase 8 live LLM HV 4 项 + verification human_needed + FOLLOWUP-1 confirmCommand 多轮 [CMD] 循环）
**Git range:** Phase 7 建表迁移 → 9476128（Phase 11 UAT passed），覆盖 5 phase / 14 plan

**Key accomplishments:**

1. **经验数据层 + 安全基线（Phase 7, EXP + SEC）**：experiences + exp_device_rel 两表（v8 幂等迁移，DDL/init 双路径逐字一致）+ ExperienceService 函数式（CRUD/设备多对多/bi-temporal 软失效/AES-256-GCM attrs_enc 加密/MAX_BATCH）+ 10 channel experience:* IPC 全 secure 包装 + stripEncColumns 边界脱敏（renderer 永不收 _enc 列，SEC-02）。
2. **AI 起草管道（Phase 8, DRAFT）**：piiMask 分级脱敏（凭证 ****/IPv4 尾4/MAC 前3）+ draftingService 两阶段起草（draftSession 阶段A 纯起草 + judgeVerdicts W-4 阶段B 窄化复判 + validateDrafts 强 schema 枚举锁/confidence 边界归一化/反幻觉 prompt + 3 次重试）+ experienceDrafting 编排 + experience:summarizeSession IPC + AIPage「经验总结」按钮。三红线②③落地。
3. **人工确认闸口（Phase 9, REVIEW）**：confirmDrafts 单事务原子（adopt draft→published + 可选 supersede + discard + 设备关联 diff 全成全败）+ IPC MAX_BATCH 双层防御 + ReviewConfirmModal/SessionMessagesModal/ReviewConfirmEditForm 弹窗 + 待确认 Badge 角标。三红线③唯一闸口（draft→published 只走 confirmDrafts 受控接口，不动 CR-01 update 白名单）。
4. **经验浏览页（Phase 10, BROWSE）**：severity v10 明文列迁移（幂等 + backfillSeverityFromHistory 回填钩子）+ restoreExperience 受控接口 + listExperiences 多维筛选（search/severity/tags/deviceId 多选 IN 占位 OR-join + device_count 子查询零 N+1）+ KnowledgeBasePage Tabs 文档|经验 + ExperienceTab 手动 CRUD/标失效恢复软硬区分 + gap closure（CR-01/02 + WR-01~05）。
5. **AI 检索复用（Phase 11, RETRIEVE）**：experienceRerank 精排强 schema LLM 评分 + experienceRetrieval 编排（粗筛 status:'published' 分词 OR 召回 → 精排 → 阈值 → read-time 两项验证 commandSafety+有效期 → incReuseCount/touchLastVerifiedAt 刷新不阻塞主路径）+ ai.ts chat() b 自动预取注入 + exp_answer references 联合返回（命令执行路径也返）+ renderer ReferenceItem 按 kind 分流渲染 + 点击回查复用 Modal + 命令失支持 warning Tag。UAT 真机发现 2 gap（search 整句 LIKE 召回 0 + 命令路径丢 references）当场修复闭环。

**验证：** 四绿门禁（tsc + vite build + build:electron-main + vitest 232）全 phase 全绿零回归；Phase 11 code review 2 BLOCKER（CR-01 draft 泄漏检索池违反红线③ / CR-02 reuse_count 重复累加）+ 4 关键 WARNING 全修复；Phase 11 真机 UAT 3/3 通过。三红线（不上向量库 / 不引图数据库 / AI 产出必经人工确认）全程未破。

---

## v1.0 技术债优化 (Shipped: 2026-07-05)

**Phases completed:** 6 phases, 16 plans, 20 tasks
**Requirements delivered:** 14/14（BUILD-01, ARCH-01/02, PERF-01~04, DATA-01, FE-01~04, ROBUST-01/02）
**Known deferred items at close:** 7（见 STATE.md §Deferred Items — DEP-1 native binding 限制下的人工 HV/验证项 + 1 quick_task artifact 残留）
**Git range:** af12dc0（Phase 1 plan）→ d906cab（Phase 6 PROJECT），163 commits

**Key accomplishments:**

1. **构建基线（Phase 1, BUILD-01）**：原生依赖 better-sqlite3/ssh2/telnet-client exact 版本锁定（12.9.0/1.17.0/2.2.13）+ npm ci 可复现构建，为后续 5 phase 重构提供稳定回归参照。
2. **架构/迁移层（Phase 2, ARCH-01/02）**：user_version + hasColumn + 版本化迁移注册表（v1-v7）替换散落 table_info；DB 文件 ACL 跨平台收紧（db/wal/shm/backups，icacls/chmod 0600，非致命）；BackupScheduler 定时 .backup() 双桶轮换（周期 7/迁移 5）+ 迁移前安全网。
3. **性能优化（Phase 3, PERF-01~04）**：OUI vendorMap 内存缓存消除 N+1 + getIPDetails 双查修复；processARPEntries 整批单事务 + prepared statement 复用 + isIPExcluded 预载 Set；kb_chunks_au FTS trigger 加 WHEN（v7 迁移 HEAD=7）；init 幂等跳过可观测日志 + 冷启动 performance.now() 计时。
4. **数据/IPC 安全（Phase 4, DATA-01）**：3 list 通道（getIPDetails/oui:getAll/anomaly:getChanges）hybrid 分页契约（默认 cap 2000/5000/100 + 硬上限 + validateLimit 钳制）+ 截断信封 {rows,total,truncated}；export:arpTable 流式分块写 CSV（分批 LIMIT/OFFSET + append，内存峰值 O(单批) 非 O(全表)）。
5. **前端重构与类型（Phase 5, FE-01~04）**：AIPage 399→95 行拆 4 子组件（ChatSessionList/ChatMessageList/ChatInput/CommandConfirmModal）+ useAIChat 自定义 hook；前端 any→src/types（electron.d.ts 26 处建模 + ai/kb DTO + oui OUIRow，6 REQ 组件 + DevicesPage 清零）；TopologyPage ref-mirror 消 stale closure；ChunkContent AbortController + 模块级 LRU + in-flight 去重图片缓存。
6. **健壮性/资源安全（Phase 6, ROBUST-01/02）**：arpCollector.executeSSH/executeTelnet + ai.executeCommandsOnDevice + execOne 全 try/finally 化（cleanup 统一出口 clearTimeout+end，timeout 路径 destroy，executeTelnet 补自有 setTimeout，execOne 补 stream.on('error')，code review 2 Critical 句柄泄漏 CR-01/CR-02 修复）；discovery safeLog helper（5 处 createSystemLog 非致命包裹 + console.warn 兜底，line 258 嵌套陷阱切断）+ enrichParseError enriched Error（原始片段 slice 0,200）。

**验证：** 三绿门禁（tsc -p tsconfig.web.json + esbuild + vitest 25）全 phase 全绿；6 phase code review 全 Critical 修复（Phase 5 CR-01 无限重渲染 / Phase 6 CR-01 execOne stream + CR-02 use-after-destroy）；4 项 SC#4 句柄快照 HV defer（DEP-1）。

---
