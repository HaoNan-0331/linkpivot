# network_toplogy

## What This Is

network_toplogy 是面向运维人员的网络拓扑管理桌面工具（Electron + React + TypeScript + better-sqlite3）。运维人员用它可视化网络拓扑、远程连接并操控设备（SSH/Telnet/Web/RDP）、通过 AI 助手辅助分析与执行运维命令，并维护设备资料与运维知识库。

## Core Value

让运维人员在一个桌面工具内安全地掌握网络拓扑、远程操控设备并获得 AI 辅助分析——拓扑准确呈现与设备安全可控是最高优先级，其余皆可让步。

## Requirements

### Validated

<!-- 已实现并投入使用的能力，从现有代码推断 -->

- ✓ 设备管理 CRUD（凭证 AES-256-GCM 加密 + safeStorage 主密钥绑定机器）— 现有
- ✓ 网络拓扑可视化（React Flow）+ SSH 自动发现（AI 分析连接关系）— 现有
- ✓ 设备远程连接（SSH/Telnet/Web/RDP 独立终端窗口）— 现有
- ✓ AI 助手（对话 + Tool Use 远程执行 + 命令白名单/黑名单安全 + 执行日志）— 现有
- ✓ 知识库（PDF/文档解析 + 向量检索 + 多模态图片识别）— 现有
- ✓ IP/MAC 监控（ARP 采集 + 异常检测 + 网段管理 + OUI 厂商识别）— 现有
- ✓ 认证与安全（登录 + 验证码 + 口令策略 + IPC 鉴权网关 + CSP/sandbox）— 现有
- ✓ 定时调度（ARP 定时采集）— 现有
- ✓ 构建/依赖：原生依赖（better-sqlite3/ssh2/telnet-client）exact 版本锁定 + npm ci 可复现构建基线 — Validated in Phase 1: Build & Dependency Foundation
- ✓ 架构/迁移：迁移版本管理（PRAGMA user_version + hasColumn + 版本化注册表，散落 table_info 收敛）+ DB 文件 ACL 收紧（db/wal/shm/backups，跨平台 icacls/chmod）+ 定时 .backup() 双桶轮换 + 迁移前安全网 — Validated in Phase 2: Architecture & DB Migration（ARCH-01, ARCH-02）
- ✓ IPC/数据安全：大数据 IPC 分页/上限 + 截断信封（getIPDetails/oui:getAll/anomaly:getChanges 默认 cap + limit/offset + {rows,total,truncated}；export:arpTable 流式分块写 CSV 消除一次性全量读）— Validated in Phase 4: Data / IPC Safety（DATA-01）
- ✓ 前端重构与类型：AIPage 399→95 行拆 4 子组件（ChatSessionList/ChatMessageList/ChatInput/CommandConfirmModal）+ useAIChat 自定义 hook；前端 any→src/types（electron.d.ts 全建模 + ai/kb/oui DTO，6 REQ 组件+DevicesPage 清零）；TopologyPage ref-mirror（nodesRef/edgesRef）消 stale closure；ChunkContent 客户端 AbortController + 模块级 LRU + in-flight 去重图片缓存 — Validated in Phase 5: Frontend Refactor & Types（FE-01, FE-02, FE-03, FE-04）
- ✓ 健壮性/资源安全：arpCollector.executeSSH/executeTelnet + ai.executeCommandsOnDevice + execOne 句柄 try/finally 统一回收（cleanup 统一出口 clearTimeout+end，timeout 路径 destroy，executeTelnet 补自有 setTimeout，execOne 补 stream.on('error') 兜底）；discovery 两处 JSON parse enriched Error（原始片段 slice 0,200 + err.message）+ 5 处 createSystemLog 经 safeLog 非致命包裹（console.warn 兜底，line 258 嵌套陷阱切断）— Validated in Phase 6: Robustness & Resource Safety（ROBUST-01, ROBUST-02）
- ✓ 经验数据层与安全基线：experiences + exp_device_rel 两表（通用列 + attrs_enc 模板 JSON 区 + bi-temporal valid_at/invalid_at 软失效 + 预埋 status/source_session_id/last_verified_at/reuse_count/relation_type）+ v8 幂等迁移（sqlite_master.sql 特征串守卫）；ExperienceService 函数式（CRUD/设备多对多关联/bi-temporal 软失效/attrs 模板校验/AES-256-GCM attrs_enc 加密/MAX_BATCH）；10 个 experience:* IPC channel 全 secure 包装 + stripEncColumns/白名单正向投影边界脱敏 + main.ts setExperienceMasterKey 注入 — Validated in Phase 7: Experience Data Layer & Security Baseline（EXP-01, EXP-02, EXP-03, EXP-04, SEC-01, SEC-02）
- ✓ AI 经验起草管道：v9 迁移加 `duplicate_of_exp_id` 列 + piiMask 分级脱敏（凭证全脱敏 / IPv4 尾4 / MAC 尾4；CR-01 自然语言连接词绕过 + CR-02 key 词界 2 critical 修复）+ duplicateDetector 同分类+设备查重喂起草 LLM + draftingService 两阶段起草（阶段A `draftSession` 纯起草 + 阶段B `judgeVerdicts` W-4 窄化复判 + `validateDrafts` 强 schema 枚举锁/confidence 边界）+ experienceDrafting 两阶段编排 + `experience:summarizeSession` secure IPC + `createExperience({duplicateOfExpId})` 单语句原子（B-1 门面 + B-2 共存亡）+ AIPage「经验总结」按钮 — Validated in Phase 8: AI Drafting Pipeline（DRAFT-01, DRAFT-02, DRAFT-03, DRAFT-04）

### Active

<!-- 本轮 milestone v1.2：安全与稳定性加固（详细 REQ-IDs 见 REQUIREMENTS.md） -->

- [ ] DEP-1 ABI 缓解：electron-vite + vitest 集成跑 Electron 内测试，补 SSH/Telnet/DB 真路径自动化回归 + 句柄泄漏自动化
- [ ] SSH 连通性加固：connection.ts 内联 algorithms 补 curve25519-sha256 等现代算法（与 sshConfig.ts 对齐）
- [ ] pre-release hardening 收尾（14 项，安全优先 L1/L4/L6）
- [ ] BUG-1 修复：anomalyService new_ip 计数恒零
- [ ] 旧规划回退甄别+修：confirm 防重复 / ai_exec_logs / 会话标题 / H3C LLDP 重评估

### Out of Scope

- 新功能开发 — 用户明确"新增功能后面再说"，本轮聚焦技术债
- IPv6 支持 — 现有 ipToNumber/CIDR 仅 IPv4，属未来扩展

## Context

- 项目已完成 Task 5-14 功能开发，代码成熟
- 刚完成代码安全审计（5 批 commit：0a6bfdf / 22622d7 / 09f878a / d3d05dc / 9ac5201），修复 1 critical + 8 high + 11 medium + ~35 low
- 本轮为审计延后的深度优化/大重构（low 级），通过 GSD 结构化分批处理
- 项目已有 CodeGraph 全符号索引（tree-sitter），结构查询优先用 `codegraph_*` 工具
- 技术栈：Electron 主进程（esbuild 打包）+ React 渲染层（Vite）+ TypeScript（严格模式 + noUnusedLocals）+ better-sqlite3（WAL）+ ssh2 + xterm.js + React Flow + Ant Design
- 加密：AES-256-GCM + 版本前缀 `v2:`（12 字节 IV）兼容历史 v1（16 字节 IV），零迁移
- **Phase 1 complete (2026-06-28)**：原生依赖 exact 锁定 + npm ci 可复现构建基线（BUILD-01，commit 940aa7c），为 Phase 2-6 重构提供稳定回归参照
- **Phase 2 complete (2026-06-28)**：架构/迁移层交付（ARCH-01/02）—— user_version + hasColumn + 版本化迁移注册表（v1-v6，含 ai_system_logs CHECK 放宽 v6）替换散落 table_info；DB 文件 ACL 跨平台收紧（db/wal/shm/backups，非致命）；BackupScheduler 定时 db.backup() 双桶轮换（周期 7/迁移 5）+ 迁移前备份安全网（dbPreExisted 门控）。3 plans / 验证 4/4 通过（CR-01/02/03 gap 已闭），4 项 Electron 运行时验证待人工
- **Phase 3 complete (2026-06-28)**：性能优化交付（PERF-01/02/03/04）—— OUI vendorMap 内存缓存消除 N+1 + getIPDetails 双查修复；processARPEntries 整批单事务 + prepared statement 复用 + isIPExcluded 预载 + WR-01 savepoint 条目级回滚；kb_chunks_au FTS trigger 加 WHEN（v7 迁移 HEAD=7）；init 幂等跳过可观测日志 + 冷启动 performance.now 计时。3 plans / 代码级验证 4/4 SC + code review 0 critical（4 warnings 已修）/ 5 项 Electron 运行时验证已人工 approved。另：codebase 全面审计 7 文档 + 修审计新发现 pdfjs-dist 缺失依赖 + BUG-2 retention clamp（quick 260628-trt）
- **Phase 4 complete (2026-06-28)**：数据/IPC 安全交付（DATA-01）—— 3 list 通道（getIPDetails/oui:getAll/anomaly:getChanges）hybrid 分页契约（默认 cap 2000/5000/100 + 硬上限 + validateLimit 钳制）+ 截断信封 {rows,total,truncated}（不静默藏数据）；export:arpTable 流式分块写 CSV（分批 LIMIT/OFFSET + append，内存峰值 O(单批) 非 O(全表)，签名/返回形态不变）。3 plans / 验证通过。
- **Phase 5 complete (2026-07-05)**：前端重构与类型交付（FE-01~04）—— AIPage 拆 4 子组件 + useAIChat 自定义 hook（D-5-1，非 zustand/prop drilling）；前端 any→src/types（electron.d.ts 26 处建模 + 新建 ai/kb DTO + oui OUIRow，6 REQ 组件+DevicesPage any 清零，D-5-2/3）；TopologyPage ref-mirror 消 stale closure（D-5-4，不迁 store）；ChunkContent 客户端 AbortController + 模块级 LRU + in-flight 去重（D-5-5/6，不改 IPC）。4 plans / 4 SC 静态全过 + 25 项 Electron 人工 HV approved / code review 1 blocker（CR-01 无限重渲染）已修 + 9 warning/4 info advisory 未修。Deferred：搜索 snippet `[图片N]` 文本呈现（预存 UX）、设备连接观测（Phase 6 范畴）。
- **Phase 6 complete (2026-07-05)**：健壮性/资源安全交付（ROBUST-01/02）—— arpCollector.executeSSH/executeTelnet + ai.executeCommandsOnDevice + execOne 全 try/finally 化（cleanup 统一出口 clearTimeout+end，timeout 路径 destroy，executeTelnet 补自有 setTimeout，execOne 补 stream.on('error') 兜底，D-6-1/D-6-2）；discovery safeLog helper（5 处 createSystemLog 非致命包裹 + console.warn 兜底，line 258 嵌套陷阱切断）+ enrichParseError（enriched Error 含原始片段 slice 0,200，D-6-3/D-6-4）。2 plans / 4 SC 静态全过 + code review 2 critical（句柄泄漏 CR-01 execOne stream error / CR-02 use-after-destroy race）+ 3 warning 全修复 / SC#4 句柄快照 4 项 HV defer（DEP-1 native binding 无法 plain node 实测，06-HUMAN-UAT.md）。**v1.0 milestone 全 6 phase / 14 REQ 交付完成。**
- **Phase 7 complete (2026-08-01)**：经验数据层与安全基线交付（EXP-01/02/03/04, SEC-01/02）— experiences + exp_device_rel 两表（v8 幂等迁移，DDL init.ts/migrations.ts 逐字一致）+ ExperienceService 函数式 service（CRUD/设备多对多/attrs 模板校验/AES-256-GCM attrs_enc 加密/bi-temporal 软失效/MAX_BATCH）+ 10 个 experience:* IPC channel 全 secure 包装 + stripEncColumns/WR-05 白名单正向投影边界脱敏 + main.ts setExperienceMasterKey 注入。2 plans / 验证 5/5 SC + 6 REQ passed / code review 2 critical（CR-01 update 越权 / CR-02 timestamp 格式）+ 1 runtime bug（IF-03 tags parse）+ 3 warning 全修复 / 三绿门禁 75 测试全过。
- **Phase 8 complete (2026-08-02)**：AI 起草管道交付（DRAFT-01/02/03/04）— v9 迁移加 `duplicate_of_exp_id` 列 + piiMask 分级脱敏 + duplicateDetector 同分类+设备查重 + draftingService 两阶段起草（`draftSession` 阶段A 纯起草 + `judgeVerdicts` W-4 阶段B 窄化复判 + `validateDrafts` 强 schema 枚举锁/W-2 confidence 边界/反幻觉 prompt）+ experienceDrafting 两阶段编排 + `experience:summarizeSession` secure IPC + `createExperience({duplicateOfExpId})` 单语句原子（B-1 门面 + B-2 共存亡）+ AIPage「经验总结」按钮。3 plans / 验证 5/5 SC + 4 REQ passed / code review 2 critical（CR-01 PII 自然语言连接词绕过 / CR-02 key 词界误匹配）+ 4 warning（WR-02/03/04/06）全修复 / 三绿门禁 146 测试全过 / 4 项 live LLM HV defer（08-HUMAN-UAT.md，/gsd-verify-work 8 后续补）。
- **Phase 9 complete (2026-08-05)**：人工确认闸口交付（REVIEW-01/02/03）— experienceService 扩 confirmDrafts 单事务原子（adopt draft→published + 可选 supersede 旧条目 invalidate + discard hard delete + 设备关联 diff）+ listDrafts/getSessionMessages + IPC 网关层 MAX_BATCH 双层防御 + preload bridge + renderer ReviewConfirmModal/SessionMessagesModal/ReviewConfirmEditForm 弹窗 + 待确认 Badge 角标。3 plans / 验证全 SC + 3 REQ passed / 三绿门禁 175 测试全过 / 人工 checkpoint approved。
- **Phase 10 complete (2026-08-06)**：经验浏览页交付（BROWSE-01/02/03/04）— severity v10 明文列迁移 + restoreExperience 受控接口 + listExperiences 多维筛选（search/severity/tags/deviceId 多选 IN 占位 OR-join + device_count 子查询零 N+1）+ ExperienceEditForm/validateDraft 抽出 + KnowledgeBasePage Tabs 文档|经验 + ExperienceTab 列表/手动 CRUD/标失效恢复软硬区分 + ExperienceDetailModal + gap closure（CR-01 restore 双层守卫 + CR-02 backfillSeverityFromHistory 幂等回填 + WR-01 tags LIKE ESCAPE + WR-02 setExperienceDevices 单事务原子）。4 plans / 三绿门禁 200 测试全过零回归 / 人工 checkpoint approved 信任门禁。
- **Phase 11 complete (2026-08-06)**：AI 检索复用交付（RETRIEVE-01/02/03）— experienceRerank.ts 精排 LLM 强 schema 评分（validateRerank exp_id 防编造 + score 边界归一化 + 3 次重试 + 反幻觉 prompt + RELEVANCE_THRESHOLD=0.6）+ experienceRetrieval.ts 编排 retrieveForAnswer（粗筛 status:'published' 双分支 → 精排 → 阈值 → read-time 两项验证 commandSafety+有效期 → 命中刷新 incReuseCount/touchLastVerifiedAt 不阻塞主路径）+ ai.ts chat() b 自动预取串联注入 + exp_answer references 联合返回 + renderer ReferenceItem 联合类型 + ChatMessageList 按 kind 分流渲染 + 点击回查复用 ExperienceDetailModal/SessionMessagesModal + 命令失支持 warning Tag。2 plans / 验证 10/10 truths VERIFIED + 3 REQ passed / code review 2 BLOCKER（CR-01 draft 泄漏检索池违反红线③ / CR-02 reuse_count 重复累加）+ 4 关键 WARNING（WR-01/03/06/07）全修复 / 四绿门禁 231 测试全过零回归 / 3 项 E2E UX 人工核实 defer（11-HUMAN-UAT.md，信任门禁 approved，/gsd-verify-work 11 后续补真机）。**v1.1 milestone 5 phase 全完成。**

## Current State

**Shipped:** v1.1 AI 对话经验沉淀（2026-08-06，feature-complete，待人工 UAT 收尾）— 5 phases / 14 plans / 20 REQ（EXP/DRAFT/REVIEW/BROWSE/RETRIEVE/SEC）全交付。一次性的 AI 运维对话现已沉淀为可检索、可溯源、防过期、防泄密的长期经验资产：经验数据层（Phase 7）→ AI 起草（Phase 8）→ 人工确认（Phase 9）→ 浏览页（Phase 10）→ AI 检索复用（Phase 11）全链路贯通。三条红线（不上向量库 / 不引图库 / AI 产出必经人工确认）全程未破。四绿门禁（tsc + vite build + electron-main build + vitest 231）全绿零回归。剩余 3 项 Phase 11 E2E UX 人工核实（11-HUMAN-UAT.md）+ Phase 8 4 项 live LLM HV（08-HUMAN-UAT.md）defer 到 `/gsd-verify-work` 真机补。

**Shipped:** v1.0 技术债优化（2026-07-05）— 6 phases / 16 plans / 14 REQ 全交付。
代码审计延后的深度优化技术债全部清偿：构建基线（Phase 1）+ 架构/迁移（Phase 2）+ 性能（Phase 3）+ 数据/IPC 安全（Phase 4）+ 前端重构（Phase 5）+ 健壮性（Phase 6）。三绿门禁（tsc + esbuild + vitest 25）全绿，6 phase code review 全 Critical 修复。

**已知技术债（defer 到下一 milestone）：**
- DEP-1 native binding 限制下的人工 HV 项（Phase 3/5/6 句柄/性能/前端 HV，需真实设备）— 见 STATE.md §Deferred Items
- FRAG-2 全局静默吞错收敛（KnowledgeBasePage/backupScheduler/keyManager/arpIpc）— 跨模块 safeLog util 重构
- FRAG-3 telnet shellPrompt 正则过宽（`/[>#]/`）— 厂商特定 prompt
- 后端 any 清理 + ai.ts/kbService 拆分（TD-1/TD-2）
- BUG-3 before-quit 不等 in-flight backup（backupScheduler/main.ts 备份退出健壮性）

## Current Milestone: v1.2 安全与稳定性加固

**Goal:** 补齐测试基础设施（DEP-1 ABI 缓解解锁自动化回归）+ 收紧安全（SSH 算法 / IPC 入参 / 告警链）+ 清偿旧规划技术债，让 network_toplogy 在真机路径上可自动化验证、安全无盲点。

**Target features:**
- DEP-1 ABI 缓解：electron-vite + vitest 集成跑 Electron 内测试，补 SSH/Telnet/DB 真路径自动化回归 + 句柄泄漏自动化（告别人工 HV）
- SSH 连通性加固：connection.ts 内联 algorithms 补 curve25519-sha256 等现代算法（与 sshConfig.ts SSH_ALGORITHMS 对齐）
- pre-release hardening 收尾（14 项，安全优先）：L1 弱 SSH 算法 / L4 Login / L6 authGuard / L2 ai limit / L3 captcha 等
- BUG-1 修复：anomalyService new_ip 计数恒零（processARPEntries 首次见 IP 写 new_ip 或移除字段）
- 旧规划回退甄别+修：confirm 防重复点击 / ai_exec_logs 完整记录 / 会话标题更新 / H3C LLDP（vendor-commands 已删，重评估邻居发现路径）

**Key context:** 三红线（IPC 鉴权 / 字段加密 / commandSafety）不可回退；迁移幂等（sqlite_master 特征串）；DEP-1 缓解后 Phase 03/06 真机 HV 可转自动化补回归。体检来源见 `.planning/audits/2026-08-07-health-audit.md`。package.json 发布版本独立（v1.2 milestone → 打包 0.3.0）。

## Deferred Milestone Goals

后续 milestone 候选：
- IPv6 支持（现有 ipToNumber/CIDR 仅 IPv4）
- DEP-1 缓解（@electron/rebuild + electron-vite 集成 vitest 跑 Electron 内测试，补句柄回归测试自动化）
- FRAG-2/3 + TD-1/TD-2 后端 cleanup

## Constraints

- **Tech stack**: Electron + React + TS + better-sqlite3 — 不更换核心栈
- **Compatibility**: 加密/迁移改动必须向后兼容历史数据
- **Security**: SSH 密钥认证、命令白名单执行层强制校验、IPC 鉴权网关 — 不可回退
- **Build**: tsconfig.web.json 严格模式 + noUnusedLocals 必须全绿；electron main 用 esbuild 打包
- **Packaging**: 禁止打包用户数据/账号/DB 进安装包（electron-builder.yml 排除规则）

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 采用 GSD 流程管理技术债优化 | CLAUDE.md 规范要求中大型项目用 /gsd；技术债需结构化分批 | — Pending |
| map-codebase 后续已补执行 + 跳过 domain research | map-codebase 初轮以「已有 CodeGraph 索引 + 84-agent 全量审计」为由跳过，但后续已补执行（commit 64a28fb），产出 `.planning/codebase/` 7 文档（ARCHITECTURE/CONCERNS/CONVENTIONS/INTEGRATIONS/STACK/STRUCTURE/TESTING）并随 phase 演进持续维护；domain research 因外部搜索工具不可用仍跳过 | — map-codebase 已交付 / domain research 跳过 |
| 本轮仅技术债，不含新功能 | 用户明确延后新功能 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-07 — v1.1 milestone shipped（含真机 HV-1/2/3/4 闭环），启动 v1.2 安全与稳定性加固 milestone*
