# CHANGELOG

## 2026-08-07 chore: dead code 清理（quick 260807-fzd）

体检报告 §2.1 标记的三项零引用死代码清理（codegraph_callers=0 + grep 双验证零引用，planner 又独立甄别过）。纯删除，不引入新代码，三红线（IPC 鉴权 / 字段加密 / commandSafety）零触碰。

- **删除 `electron/services/vendor-commands.ts` 整文件**（47 行，3 export：`Vendor` type / `detectVendor` / `getDiscoveryCommands`）— v1.0 discovery.ts 重写已走 AI 动态生成命令的新方案，全项目 0 import。CHANGELOG:239 已记载移除依赖。与体检报告 §1.0「H3C LLDP 走 vendor-commands 命令集」方向过时项关联。
- **删除 `ai.ts:516 executeCommandOnDevice`（单数 wrapper）** — codegraph_callers=0，discovery.ts:2 实际 import 的是复数 `executeCommandsOnDevice`，单数为历史预留。复数 `executeCommandsOnDevice`（ai.ts:324）及 613/964 调用点 + telnetRouting.test.ts 零改动保留。
- **删除 `package.json` devDependencies `@types/uuid ^10.0.0`** — uuid v14+ 自带 TypeScript 类型，旁路 @types 包冗余，全项目 0 处 `from '@types/uuid'`。运行时依赖 `dependencies.uuid ^14.0.0`（10 处 `from 'uuid'` import）保留，类型解析走 uuid 包内自带类型。
- **四绿门禁全绿零回归**：`tsc -p tsconfig.web.json`（strict + noUnusedLocals）/ `npx vitest run`（232/232）/ `npm run build:electron-main`（esbuild main bundle 1.9mb）/ `npx vite build`（renderer）。三处删除无一处影响测试（零 caller）。
- **证据**：`.planning/audits/2026-08-07-health-audit.md` §2.1。

## 0.2.0 (2026-08-06) v1.1 milestone — AI 对话经验沉淀

5 phase / 14 plan / 20 REQ 全交付（EXP/DRAFT/REVIEW/BROWSE/RETRIEVE/SEC）。把一次性的 AI 运维对话沉淀为可检索、可溯源、防过期、防泄密的长期经验资产：经验数据层 → AI 起草 → 人工确认 → 浏览页 → AI 检索复用 全链路贯通。三红线（不上向量库 / 不引图库 / AI 产出必经人工确认）全程未破。四绿门禁 vitest 232 全绿。Phase 11 真机 UAT 3/3 通过。

- **Phase 7 经验数据层 + 安全基线（EXP + SEC）**：experiences + exp_device_rel 两表（v8 幂等迁移）+ ExperienceService 函数式（CRUD/设备多对多/bi-temporal 软失效/AES-256-GCM attrs_enc 加密）+ 10 channel experience:* IPC 全 secure 包装 + stripEncColumns 边界脱敏。
- **Phase 8 AI 起草管道（DRAFT）**：piiMask 分级脱敏（凭证/IP/MAC）+ draftingService 两阶段起草（draftSession 纯起草 + judgeVerdicts W-4 窄化复判 + validateDrafts 强 schema/反幻觉 + 3 次重试）+ experience:summarizeSession IPC + AIPage「经验总结」按钮。
- **Phase 9 人工确认闸口（REVIEW）**：confirmDrafts 单事务原子（draft→published 唯一受控接口 + supersede/discard/设备 diff）+ ReviewConfirmModal/SessionMessagesModal 弹窗 + 待确认 Badge 角标。
- **Phase 10 经验浏览页（BROWSE）**：severity v10 明文列迁移 + listExperiences 多维筛选（search/severity/tags/deviceId 多选 IN 占位 + device_count 零 N+1）+ KnowledgeBasePage Tabs 文档|经验 + 手动 CRUD/标失效恢复 + gap closure（CR-01/02 + WR-01~05）。
- **Phase 11 AI 检索复用（RETRIEVE）**：experienceRerank 精排强 schema LLM 评分 + experienceRetrieval 编排（粗筛 status:'published' 分词 OR 召回 → 精排 → 阈值 → read-time 两项验证 commandSafety+有效期 → 命中刷新计数）+ ai.ts chat() b 自动预取注入 + exp_answer references 联合返回（命令路径也返）+ renderer 按 kind 分流渲染 + 点击回查复用 Modal + 命令失支持 warning Tag。UAT 真机发现 2 gap（search 整句 LIKE 召回 0 + 命令路径丢 references）当场修复。
- **预 push 安全清理**：test fixture 真实私网 IP 占位化 + `.planning/debug/` 移出 git（过程笔记不公开）。

## 2026-08-05 fix(ai): saveChatMessage 空内容守卫防 NOT NULL 崩溃（quick）

- **根因（debug: chat_history.content_enc NOT NULL）**：用户问「关于公司的经验」时 AI 首回纯 `[KB_SEARCH]` 标签，`chat()` KB 分支 follow-up callAI 撞 deepseek 连接超时 → catch（ai.ts:776-778）把标签剥光成 `''` → `saveChatMessage('assistant','')` → `encField('')` 返回 null → 撞 `chat_history.content_enc NOT NULL`。错误信息「数据库约束失败」完全误导（真因是网络超时）。与 Phase 9 fix 无关，Phase 9 之前即存在的潜在 bug，被网络抖动 + KB_SEARCH 路径触发。
- **修复**：`saveChatMessage`（ai.ts:233-243）入口加空内容守卫——`content` trim 后为空（空串/纯空格/null/undefined）则抛清晰错误 `'无法保存空消息内容（AI 可能未返回有效回复，请检查网络后重试）'`，不进 INSERT。这是所有 chat 保存的总闸（10+ 调用点），一处守卫护全部。写入用 `trimmed`（与判空一致，消息首尾空格无业务语义）。
- **测试**：新增 `electron/services/ai.saveChatMessage.test.ts`（5 cases）——空串/纯空格/null/undefined 抛错且不调 prepare、正常消息控制组进 INSERT。三绿门禁 vitest 182 PASS（原 177 + 新 5，无回归）。
- **关联**：网络超时本身是环境问题（deepseek TCP 偶发超时，需用户稳网络）；本守卫把崩溃降级为清晰错误提示，不改变功能行为。

## 2026-08-04 fix(09): AI executeCommandsOnDevice 按 connectionType 分流 telnet/ssh

- **根因（debug: ai-telnet-exec-routing）**：`electron/services/ai.ts` `executeCommandsOnDevice` 历史无条件 `buildSSHConfig` 走 SSH（端口 22），无视 `device.connectionType`，对 telnet 设备 `ECONNREFUSED`。telnet 自动化 exec 能力已存在于 `arpCollector.executeTelnet`（telnet-client），AI 执行层漏接。
- **修复**：`runOne` 按 `device.connectionType` 分流——telnet（大小写不敏感）走共用 util `executeTelnetCommand`，ssh（含默认/缺省）保留原 `buildSSHConfig + client.exec + execOne` 路径不动（密钥/密码 + stream silence/retry/H3C 粘连语义全保留）。
- **共用 util 抽取（消除重复）**：新增 `electron/utils/telnetExec.ts`（telnet-client connect `loginPrompt/PasswordPrompt/shellPrompt` + exec + 自有 timeout 兜底 + finally cleanup + 可选 gbk 解码/ANSI 剥离）；`arpCollector.executeTelnet` 改薄壳调 util，消除 arpCollector/ai.ts 双份。
- **安全**：`checked` 安全层数组（`isCommandAllowed`）两路径共用，无新增注入面；telnet 输出后处理 `decodeGbk + stripAnsi` 与 SSH 路径 `decodeDeviceBuffer + stripAnsi` 对齐。
- **测试**：新增 `electron/services/ai.telnetRouting.test.ts`（7 cases）——mock telnet-client（经共用 util spy）+ ssh2 Client（真 class），断言 telnet 分流不实例化 ssh2 Client / ssh 分流不调 telnet / 端口缺省回退 23 / 大小写不敏感 / 空命令短路 / telnet 抛错首条 reject 整批。
- **三绿门禁**：`tsc -p tsconfig.web.json --noEmit` exit 0 / `npm run build:electron-main` exit 0（dist-electron/main.js 1.9mb）/ `npx vitest run` 172 PASS（原 165 + 新增 7，无回归）。

## 2026-08-04 fix(ai): telnet 长输出 exec 前关闭分页防截断（quick 260804-t2q）

- **根因**：`display current-configuration`（华为长输出）只返回第一屏，接口/VLAN/路由全丢。`telnetExec executeTelnetCommand` 无分页处理，华为 `---- More ----` 分页时 telnet-client exec 不自动翻页 → 第一屏静默 → exec 误判命令结束 → 截断。arpCollector 短命令未暴露。
- **修复**：exec 真命令前先发关闭分页命令（运维自动化标准做法）。`telnetExec.ts` 加 `disablePaginationCmd` 选项（connect 后 try exec 该命令忽略输出/错误）；`ai.ts` 加 `pickDisablePaginationCmd(vendor)`（cisco/锐捷 → `terminal length 0`，华为/H3C/默认 → `screen-length 0 temporary`），telnet 分支传入；arpCollector 不传（短输出）。
- **安全**：`screen-length 0 temporary` / `terminal length 0` 是只读会话级配置命令（仅本 telnet 会话关分页，退出恢复），util 内部发不经 AI 命令白名单。
- **测试**：`ai.telnetRouting.test.ts` 补 2 case（华为/思科 vendor 选对分页命令），三绿门禁 vitest 174 PASS（原 172 + 新 2，无回归）。
- **延续**：ai-telnet-exec-routing debug（commit 8df4166 修连接路由）的输出完整性延续修复。

## 2026-08-04 fix(ai): telnet shellPrompt 精确化（截断真因）+ 去 newlineReplace bug（quick 260804-t2q 第二轮）

- **真因（源码锁定）**：telnet-client `index.js:394` exec 在累积 buffer `search(shellPrompt)`，`/[>#]/` 在华为配置裸 `#` 段落分隔处 `promptIndex>=0` → 提前 resolve 跳过 pageSeparator 自动翻页 → 截断第一屏。**不是分页**（screen-length + pageSeparator 翻页均正常，hasMore=false）。叠加 `newlineReplace: true` bug（`response.join(true)` 把布尔转 `"true"` 当分隔符，`index.js:232`）。
- **修复**：① shellPrompt 按 vendor 精确化——华为/H3C `/(<[^>]+>|\[[^\]]+\])/` 只匹配 `<host>`/`[host]` 不匹配裸 `#`；思科/锐捷 `/\S[>#]/`；**未知 vendor 通用兜底**覆盖所有主流 prompt 格式（换设备/换厂商自动适配）。② 去掉 `newlineReplace: true`（fallback `'\n'`）。③ `telnetExec` 加 `shellPrompt` 选项；`ai.ts` `pickShellPrompt` helper。
- **取证方法**：第一轮分页修复实测仍截断 → 加临时诊断日志 → `hasMore=false` 推翻分页假设 → 源码取证找到 shellPrompt 真因（systematic-debugging root cause first）。
- **测试**：补华为/思科/default 通用 shellPrompt 行为断言，vitest 175 全绿；用户实机验证 `display current-configuration` 完整返回。
- **两轮关系**：第一轮 `534fdc9` disablePaginationCmd（关分页优化，保留）+ 第二轮 `913aade` shellPrompt 精确化（截断真因，必装）。

## Phase 8（v1.1 开发）- AI Drafting Pipeline（DRAFT-01~04）

### 端到端经验总结 pipeline（08-01/02/03 + code review fix）

- **数据层（08-01）**：v9 迁移加 `experiences.duplicate_of_exp_id TEXT` 列（hasColumn 幂等）；`piiMask` util 分级脱敏（凭证全脱敏 / IPv4 尾4 / MAC 尾4，D-04）；`duplicateDetector.findExistingForDraft` 同分类+设备查重喂起草 LLM；`experienceService.createExperience` 扩展 `duplicateOfExpId` 单语句原子写入（B-1 门面 + B-2 共存亡）。
- **起草引擎（08-02）**：`draftingService` 函数式——`draftSession`（阶段A纯起草）+ `judgeVerdicts`（W-4 两阶段复判，按 category 窄化防 context 溢出）+ `validateDrafts`（强 schema：分类枚举锁 / troubleshooting severity / duplication_verdict / W-2 confidence 边界）+ 反幻觉 prompt（禁 [CMD]）。callAI 签名零改动（D-01）。
- **端到端（08-03）**：`experienceDrafting.summarizeSessionForUi` 两阶段编排（读会话→PII 脱敏→阶段A 起草→阶段B 窄查复判→门面落库）+ `experience:summarizeSession` IPC（secure 包装）+ preload/main 注入 + DraftingResult DTO + AIPage「经验总结」按钮（loading/通知/无可总结提示/demoMode）。红线全落地：secure 包装 / status='draft' 不经 update / 脱敏前置 / 不裸 SQL 写 dup_id（grep 反向守卫=0）。
- **code review fix（CR-01/02 + WR-02/03/04/06）**：CR-01 piiMask 补自然语言连接词脱敏（`password is hunter2` / `token 为 xxx`）+ 捕获组重组防回调 `\S+$` 跨越中文/[:=] 吞前缀；CR-02 key 关键词加双向词界（ASCII lookbehind `(?<![A-Za-z0-9_])` + `key(?![a-z])` 后置）排除 monkey/keyboard，用 lookbehind 替代 `\b` 兼容中文关键词边界；WR-02 relateDevice catch 加 `createSystemLog` 可观测日志 + console.warn 二阶兜底；WR-03 judgeVerdicts 未覆盖 draft + 其 category 有同分类存量 → 保守判 NOOP（宁漏勿重）；WR-04 AIPage `connectionType.toUpperCase` 加空值守护；WR-06 补回归单测。

三绿门禁：tsc strict EXIT 0 / electron-main build / vitest 146 PASS（基线 + piiMask 28 / duplicateDetector 5 / draftingService 24 / experienceDrafting 10）。

## [0.1.2] - 2026-07-26

### pre-release hardening（GO-WITH-FIXES 发版前必修 10 项）

本次发版纳入 pre-release-audit（5 维度 28 findings：0 critical / 1 high / 7 medium / 16 low，verdict GO-WITH-FIXES）发版前必修项 + 历史已落地修复归并：

- **[H1 high·安全] shell.openExternal 协议白名单**：抽 `electron/utils/webSecurity.ts:openExternalSafe` 共享函数（http/https 白名单，其余 deny），`hardenWindow` setWindowOpenHandler / `main.ts` 全局 web-contents-created handler / `connection.ts:openWebSafe` 三处复用，杜绝 file:/javascript:/custom-protocol 等危险协议经外链入口逃逸。
- **[M1 medium·安全] 生产 CSP 收紧**：connect-src `'self'`（去 https: 通配，渲染层无合法外联，AI/Vision 调用全在主进程 fetch）；追加 `object-src 'none'; base-uri 'self'; frame-ancestors 'none'`（禁插件 embed / 防 base 注入 / 防 clickjacking）。dev 模式跳过 CSP 注入不影响 vite HMR。
- **[M2 medium·健壮] 启动期异常不卡渲染层**：`app.whenReady().then(...)` 末尾加 `.catch` → `dialog.showErrorBox('启动失败', err.message)` + `app.quit()`，启动期 DB/migrate/IPC register 任意 throw 不再吞错卡 loading。
- **[M4 medium·打包正确性] telnet-client asarUnpack**：`electron-builder.yml` asarUnpack 追加 `node_modules/telnet-client/**/*`，与 better-sqlite3/ssh2 同标准（原生编译依赖必须 unpack），修正 BUILD-01 决策与打包配置不一致。
- **[M5 medium·安全] openRDP 去 shell 拼接**：`connection.ts:openRDP` 由 `exec(\`mstsc "${tmpPath}"\`)`（exec+shell 拼接）改 `execFile('mstsc', [tmpPath], { shell: false })`，与同文件 acl.ts:30 execFileSync(shell:false) 风格统一，消除 shell 注入面（device.id 为 UUID 零行为变化）。
- **[L5 low·健壮] before-quit closeDatabase try/catch**：`main.ts` before-quit 的 `closeDatabase()` 包 try/catch + `console.error('[before-quit] closeDatabase failed')`，保证退出路径平稳不中断 WAL checkpoint。
- **[L11 low·一致性] package-lock.json 根版本刷 0.1.2**：`npm install --package-lock-only` 同步 lockfile version，与 package.json 对齐。
- **[L13 low·元数据] package.json author**：`""` → `"wanghaonan"`。
- **[L14 low·安全防御] .gitignore 兜底**：追加 `master.key / *.pem / *.pfx / *.p12 / *.key`，防误提交密钥/证书。

历史已落地修复归并本次发版（详见对应日期条目）：
- **[kb-db-malformed] 资料库 FTS5 shadow 损坏**：事务化（updateChunk/deleteChunk/mergeChunks/splitChunk/deleteDocument 显式 db.transaction）+ 启动自愈（main.ts integrity-check → rebuild → 不阻塞 init）。
- **[exec-cmd-concat] H3C 多命令 exec 字符串粘连**：`ai.ts:executeCommandsOnDevice` 重构为每命令独立 SSH 连接，物理隔离杜绝 vty 命令粘连，discovery 素材完整。
- **[Phase 5 FE-01~04] KB 类型化与 ChunkContent 图片渲染**：src/types/kb.ts 强类型 + imageCache LRU + ChunkContent [图片N] → 图片渲染（260705-sj1 quick 闭环）。
- **[v1.0 milestone] 6 phase / 16 plan / 14 REQ 全交付**：BUILD-01 / ARCH-01/02 / PERF-01~04 / DATA-01 / FE-01~04 / ROBUST-01/02。

发版后迭代（本 quick 显式排除，归下一 milestone / 后续 quick）：
M6/M7 渲染层 any（electron 服务层）、L7 db any、L10 复杂度、L1 弱 SSH 算法、L2 ai limit、L3 captcha、L4 Login、L6 authGuard、L8/L9 渲染层、L12 rebuild 锁定、L15 xterm、L16 ssh2 license。

验证：tsc web strict + noUnusedLocals 全绿；esbuild 主进程打包全绿；vitest 25/25 全绿。

## 2026-07-25

### debug kb-db-malformed · 资料库 FTS5 shadow 损坏致 malformed（事务化 + shadow 重灌 + 启动自愈）

- **症状**：资料库文档详情删除章节 `kb:deleteChunk` / 编辑保存 `kb:editChunk` 报 `database disk image is malformed`（SQLite SQLITE_CORRUPT/26）。
- **根因**：FTS5 虚拟表 `kb_chunks_fts` 的影子表（shadow tables）损坏——主库 `topology.db` 本身完好（`PRAGMA integrity_check`=ok，`kb_chunks` 193 行可读）。证据：`kb_chunks_fts_docsize`=0 行（与 193 行主表不一致），shadow 上任何 `DELETE`/`UPDATE` 触发器路径（`kb_chunks_ad`/`_au`）抛 malformed，而 `MATCH` 读路径正常；历史多次 `taskkill //F`/`Stop-Process -Force`（=SIGKILL）不触发 Electron `before-quit`→`closeDatabase()`，better-sqlite3 句柄被强杀、WAL 未 checkpoint，FTS5 多行触发器（_ad/_au 含 1 delete + 1 insert + GROUP_CONCAT 子查询）半途中断写入累积在 WAL → shadow（尤其 docsize）落不一致状态。better-sqlite3 对 FTS5 shadow 损坏统一抛 `database disk image is malformed`（误导性措辞，非主库坏）。
- **修复（数据层）**：停应用 → 备份当前 `topology.db`(+wal/+shm) 到 `backups/topology-pre-rebuild-20260725-143933.db.bak*` → DROP+CREATE `kb_chunks_fts` + 按触发器计算逻辑（`image_desc`=GROUP_CONCAT(`kb_images.description`)）从 kb_chunks 193 行重灌 shadow → 重建 `kb_chunks_ai/_ad/_au` 触发器 → `wal_checkpoint(TRUNCATE)`。结果：`_docsize` 0→193、MATCH 命中正常（配置=13 hits）、integrity_check=ok、三触发器路径全绿。
- **关键决策**：标准 `INSERT INTO kb_chunks_fts VALUES('rebuild')` 因 FTS5 external-content 含计算列 `image_desc`（不在 content 表 kb_chunks 内）抛 `no such column: T.image_desc`，故改用 DROP+重灌；11:13 干净备份经核对与当前库 kb_chunks 完全同字节（shadow 同为坏状态），证实"shadow 自 11:13 起即坏"，整库替换无价值。
- **修复（代码层）**：`electron/services/knowledgeBaseService.ts` 的 `updateChunk`/`deleteChunk`/`mergeChunks`/`splitChunk`/`deleteDocument` 多语句显式包进 `db.transaction()` 保证原子（防 FTS shadow 半途中断写入）；`deleteChunk` 的文件 unlink 移事务外（避免 DB 回滚后文件已删不一致）；`updateChunk` 的 FTS sync 仍 try/catch 不回滚主数据。
- **修复（自愈）**：`electron/main.ts` 启动序列（`migrateAndSecure` 之后）新增 FTS5 `integrity-check` → 失败即 `rebuild` → 仍失败仅 `console.warn` 不阻塞 init（与 safeLog/启动日志惯例一致），把"被动 malformed"转"主动自愈"。
- **改动范围**：`electron/services/knowledgeBaseService.ts`（5 函数事务化）、`electron/main.ts`（启动自愈块 + getDatabase 导入）。不改表结构/触发器语义/IPC 契约。
- 验证：tsc -p tsconfig.web.json(strict+noUnusedLocals) 全绿；esbuild main+preload 全绿；vitest 25/25 全绿；DB 级 readonly 复检 integrity_check=ok、shadow 健康、三触发器路径全绿。备份：11:13 periodic + 14:39 pre-rebuild 双备份在 `backups/`，可回滚。应用当前已停，待人工 HV（资料库文档详情删章节/编辑保存不再报 malformed）。


### debug exec-cmd-concat · H3C 多命令 exec 字符串粘连修复（每命令独立 SSH 连接）

- **根因（DB 日志铁证）**：discovery Phase 3 `executeCommandsOnDevice` 在【单个 SSH 连接（同一 client）上串行 `client.exec` 多条命令】。H3C SSH server 把 exec request 的命令通过 vty 逐字符注入 console，前一条命令字符串尾部字符尚未被设备 console 消费完毕，下一条 exec 即追加注入，致命令字符串粘连（`display arp` → `display arpp neighbor-information list`）。叠加 `execOne` silence 2s 提前 resolve（H3C exec 不主动 close channel），下一条发送过快加剧粘连。仅第 1 条 LLDP 有数据，ARP/version/routing/interface 全报 `% Unrecognized/Wrong command` → AI 拓扑分析素材残缺 → `edges: []`。
- **修复（方案 A）**：`electron/services/ai.ts` `executeCommandsOnDevice` 重构为【每条命令独立 SSH 连接】—— `runOne(idx)` 内 `new Client → connect(buildSSHConfig) → ready 后 execOne → end 回收`。不同 SSH session = 不同 vty，物理隔离彻底杜绝粘连。仍用 exec（非 PTY），不引入注入面，不改白名单 / 安全模型；复用 `sshConfig.ts` 的 `SSH_READY_TIMEOUT_MS` / `SSH_ALGORITHMS`；`execOne` 签名 / stream silence / retry / timeout 逻辑完全不变。
- **对外契约零改**：`executeCommandsOnDevice(device, commands[]): Promise<结果[]>` 签名不变；结果数组与 `commands` 同序同长（`results[i]` ↔ `cmds[i]`）；首条命令连接失败 reject 整批（与旧 `client.on('error')` 同语义，discovery `catch` 按连接失败跳过设备）；后续命令连接失败填 `success:false` 不中断（保结果同长同序）。
- **代价**：握手次数 = 命令数（单设备 5 条约 10s，远好于历史卡顿，可接受）。
- **改动范围**：仅 `electron/services/ai.ts` `executeCommandsOnDevice`（line 291-386），`execOne`/`buildSSHConfig`/`executeCommandOnDevice` 不动。
- 验证：tsc web strict + noUnusedLocals 全绿；esbuild 主进程打包不回归；vitest 25/25 全绿；待人工 HV（对 H3C 设备跑自动发现，查 `ai_system_logs` collectionText 确认第 2 条起命令回显干净、edges 非空）。

## 2026-07-02

### Phase 5 Plan 04 · FE-02 KB 类型化 + FE-04 ChunkContent 取消与缓存（D-5-2/D-5-3/D-5-5/D-5-6）
- **新建 `src/types/kb.ts`**：KbDocument / KbChunk / KbImage / KbStatus / KbSearchResult，字段**严格反推自 KnowledgeBasePage.tsx 真实消费面**（issue 1 修正：`file_name` 非 filename、`images` 图片对象数组非 image_ids 字符串、`document?: { title: string }` 嵌套非 docId/docTitle；DB 行原生下划线 `device_id`/`error_message`/`created_at`/`chunk_index`/`char_count` 保留）
- **`src/types/electron.d.ts` kb.* 通道收类型**（05-01 保留 Promise<any>，本 plan 接力）：listDocuments→`Promise<KbDocument[]>`、getDocument→`Promise<KbDocument|null>`、getStatus→`Promise<KbStatus>`、search→`Promise<KbSearchResult[]>`、uploadBuffer/reprocess→`Promise<{id:string}>`
- **`KnowledgeBasePage.tsx` 17 处 any 全收敛**：ChunkContent `images: any[]` → `KbImage[]`、`img: any` → `KbImage`；documents/devices/searchResults/detailDoc 状态用 DTO；Table 列 render（file_name/status/操作）+ Select options（upload/filter）+ chunk map 全用强类型；nullable 字段窄化（`file_type??''`、`content?.length??0`、`status??''`、`chunks?.length??0`、handleMerge 前置 null 守卫、`chunks!` 断言）
- **新建 `src/components/pages/kb/imageCache.ts`**：模块级 LRU 缓存 Map（`CACHE_MAX_ENTRIES=100`，按 count 有界，Map 插入顺序淘汰最老，O(1)）+ in-flight 去重 Map（同 file_path 并发复用 Promise，finally 清除允许重试）+ `getImage(path, signal)` 封装「缓存命中 → in-flight 复用 → 否则 IPC 并入缓存」+ `clearImageCache()` 手动清
- **`ChunkContent` effect 改造**：`let cancelled = false` → `AbortController`（cleanup 调 `controller.abort()`，D-5-5 结构化取消）；`window.api.kb.getImageData` 直调 → `getImage(file_path, signal)` 走缓存层；FRAG-2 顺带：图片失败 `console.warn('[kb] 图片加载失败')` 提供反馈（不再完全静默，UI 不崩）
- **D-5-5 红线守住**：`kb.getImageData` IPC 通道签名不动（preload.ts 未改）—— better-sqlite3 同步读不可真中断，AbortController 落地为「结构化取消标志 + 卸载防 setState + 配合 in-flight 去重」客户端语义，非真中断主进程 IO
- **D-5-6 红线守住**：缓存**模块级**（非 per-instance，ChunkContent 频繁 re-mount 跨实例复用、存活卸载）
- FE-02 类型化先于 FE-04 缓存（同文件串行，Task1 → Task2，FE-04 用 FE-02 的 KbImage 类型）
- 验证：tsc web strict + noUnusedLocals 全绿；vitest 25 测试不回归；esbuild 主进程打包不回归；KB any after 绝对值 = 0（grep `:\s*any|as any|<any>` = 0）；preload.ts 无 kb 通道改动
- 待人工 HV（DEP-1 限制无前端自动化运行时测试，推迟 phase 末批量 HV）

### Phase 5 Plan 03 · FE-01 AIPage 拆分 4 子组件 + useAIChat hook（D-5-1/D-5-2）
- **拆分结构落地**：`src/components/pages/AIPage.tsx`（399 行）拆为 4 独立子组件文件 + 1 个 useAIChat 自定义 hook + 本地 types.ts，AIPage 退化为 ~95 行薄编排层
- **新建 `src/components/pages/ai/` 目录**（6 文件）：
  - `types.ts`：DeviceOption/ChatMsg/ConfirmData/UseAIChatReturn（迁移自 AIPage 本地 interface）
  - `useAIChat.ts`：page-local 会话态自定义 hook（8 state + 7 handler，typed contract 返回）
  - `ChatSessionList.tsx`：会话列表子组件（render-only）
  - `ChatMessageList.tsx`：消息列表子组件（含 chatEndRef 滚动 effect）
  - `ChatInput.tsx`：输入框子组件（event-driven）
  - `CommandConfirmModal.tsx`：命令确认弹窗子组件
- **D-5-1 红线守住**：useAIChat 是**自定义 hook**（非 zustand store、非 prop drilling）；设备多选 `<Select mode="multiple">` **留 AIPage 编排层 header**（经 `chat.selectedDevices/setSelectedDevices` 消费，非子组件职责）；未引入 `aiChatStore` 全局单例
- **FE-02 顺带收敛（D-5-2，AIPage 由 FE-01 独占）**：原 line 60/61 `(d: any)` → Device[] 强类型 filter 去标注；原 line 101 `m.role as 'user'|'assistant'` → role 已联合类型去 cast；原 line 160/175 `catch (e: any)` → `catch (e: unknown)` + `instanceof Error` 窄化。AIPage any 清零（before 4 → 0）
- **configLoading/hasConfig 留编排层**（page 守卫，非 hook 契约）；hook 暴露 `loadData(hasConfig)` 供守卫通过后调用
- **导入路径迁移**：`@/types/electron` → `@/types/ai`（ChatMessage/ChatSession）；electron.d.ts 的 re-export 兼容层保留（无回退需求，但保留不阻塞）
- 验证：tsc web strict + noUnusedLocals 全绿；vitest 25 测试不回归；esbuild 主进程打包不回归；AIPage 4 处 any 清零；header Select 多选保留；待人工 HV（DEP-1 无前端自动化运行时测试，推迟 phase 末批量 HV）

### Phase 5 Plan 02 · FE-03 TopologyPage stale closure ref-mirror（D-5-4）
- **`src/components/pages/TopologyPage.tsx` ref-mirror 落地**：新增 `nodesRef`/`edgesRef`（紧邻既有 `saveTimerRef`/`isLoadingRef` 同模式），两个同步 effect `nodesRef.current = nodes` / `edgesRef.current = edges`（O(1) 赋值，无性能影响）
- **全 stale closure 点改读 ref.current**：`saveTopology`、`debouncedSave`（setTimeout 闭包）、`handleDiscoveryConfirm`、`handleEditSelectedNode` —— 体内读 `nodesRef.current`/`edgesRef.current` 取最新拓扑，`useCallback` deps 去掉裸 `nodes`/`edges`，回调注册稳定（消除「注册与调用间窗口」stale 风险，D-5-4 意图）
- **拓扑持久化语义 byte-for-byte 不变**：保存触发时机（debouncedSave effect 仍依赖 nodes/edges 触发）、保存内容（nodes/edges 浅拷贝）、保存 API（topology.update）全部不动；仅读取路径从闭包变量改为 ref.current
- **D-5-4 红线守住**：`useNodesState`/`useEdgesState` 契约不变，**未迁 nodes/edges 到 zustand store**（外迁触及核心价值「拓扑准确呈现」最高优先级面，风险不抵收益）
- 函数式更新 `setNodes(nds => ...)` / `setEdges(eds => ...)` 本就读最新，无 stale 风险，不改（handleConnect/handleAddDevices/handleDeleteSelected/handleEditConfirm/handleNew/handleDelete/handleImport）
- 验证：tsc web strict + noUnusedLocals 全绿；vitest 25 测试不回归；esbuild 主进程打包不回归；grep `nodesRef\|edgesRef` 命中 11；待人工 HV（DEP-1 限制无前端自动化运行时测试）

### Phase 5 Plan 01 · FE-02 类型契约 foundation（D-5-2/D-5-3）
- **重写 `src/types/electron.d.ts`**：非 kb 通道全部 `any` 替换为 src/types DTO（Device/Topology/NetworkSegment/IPDetail/IPMACChange/IPMACBinding/ExcludedIP/ChangeStats 等）；`PaginatedResult<any>` 泛型收为 IPDetail/IPMACChange/OUIRow；3 list 通道（network/anomaly/oui）信封类型化
- **新建 `src/types/ai.ts`**：ChatMessage（role 收 `'user'|'assistant'`）/ ChatSession / DiscoverResult（复用 TopologyNode/TopologyEdge）
- **`src/types/oui.ts` 补 `OUIRow`**：snake_case DB 行（ouiService 未做 camelCase 映射，旧 OUIEntry camelCase 与 IPC 真实返回不符，D-5-3 缺 DTO 就近补，Rule 1 bug 修复）
- **`electron.d.ts` 新增通道**：`scheduler`（getConfig/updateConfig/runNow/getStatus，对齐 preload.ts:104-109 + schedulerIpc.ts 真实签名，无臆造 saveConfig/start/stop）、`arp`（collectFromDevice/collectFromAll）、`export`（arpTable/changes/networkUsage）—— 三组 preload 已暴露但旧 electron.d.ts 漏标
- **`electron.d.ts` re-export ChatMessage/ChatSession**：维持 AIPage.tsx 既有 import 不中断（FE-01 Wave 2 迁移导入路径）
- **4 个 IP Tab + SettingsPage + DevicesPage 清 any**（6 文件 any after 全 0，issue 4 绝对值验收）：
  - props `api:any` → `ElectronAPI`；useState `any` → 真实 DTO（ARPEntry/IPMACChange/NetworkSegment/OUIRow/Device）
  - SettingsPage 删 `(window as any).api` 绕过，scheduler 走 `window.api.scheduler.*`；schedulerConfig/Status 收为 `ScheduleConfig`/`SchedulerStatus`
  - 全部 `catch (e:any)` → `catch (e:unknown)` + `instanceof Error` 窄化（统一错误处理模式）
  - Phase 4 信封 `.rows` 读路径保留无回退
- **kb.* 通道保留 `Promise<any>`**：归 05-04 建模（KB DTO 下沉 05-04 就近定义，避免跨 wave 依赖）
- **不在本 plan**：AIPage（FE-01 独占）、KnowledgeBasePage（05-04）、后端 services any（milestone 外）、mock-api.ts（dev-only）
- 验证：tsc web strict + noUnusedLocals 全绿；vitest 25 测试不回归；esbuild 主进程打包不回归

## 2026-06-28

### Phase 4 Plan 01 · DATA-01 三 list 通道 hybrid 分页契约（D-4-1~D-4-4, D-4-6）
- **新增 `src/types/pagination.ts`**：`PaginatedResult<T>` 信封类型（rows/total/truncated），renderer+main 共用
- **新增 `electron/utils/pagination.ts`**：共享 `validateLimit`/`validateOffset` helper（Number.isInteger + 范围校验，超界落回默认非钳制，复用 anomalyIpc 先例）
- **新增 `tests/unit/pagination.test.ts`**：13 个单测覆盖校验 behavior
- **`networkSegmentService.getIPDetails`**：加 `limit=2000, offset=0`，返回信封；JS CIDR 过滤后 slice 分页（D-4-6 不下推 SQL）；保留 PERF-01 `OUIService.getVendor` 读路径不退化为逐行查库
- **`ouiService.getAll`**：加 `limit=5000, offset=0`，SQL 下推 `LIMIT ? OFFSET ?`（prepared statement 防 SQL 注入）+ COUNT(*) total + 信封
- **`anomalyService.getChanges`**：补 `offset=0` + `OFFSET ?` + COUNT(*) total + 信封（维持默认 100/硬上限 10000）
- **3 个 IPC handler**：网关层 `validateLimit/validateOffset` 校验后转发 service（不信 renderer）；`anomalyIpc` 删本地 validateLimit 改 import 共享
- **`preload.ts`**：三通道签名加可选 `limit?/offset?`（向后兼容，旧调用零改动）
- **trade-off（T-04-04 accept）**：ip_status 无物理 purge 单调增长，D-4-6 限定 IPC payload 不限 DB 全表读；物理清理越界 DATA-01（独立 phase）
- 验证：tsc + esbuild + vitest(25) 三绿；Task1 TDD RED→GREEN 合规

## 2026-06-28

### 项目文件审计与清理
- **磁盘清理（.gitignore 覆盖，不入 git）**：`.playwright-mcp/`（playwright MCP 老日志，90 文件 530K）、`login-page.png`/`topology-page.png`（dev 参考截图）、`tsconfig.node.tsbuildinfo`（TS 增量缓存，tsc 自动重生）
- **`.gitignore`**：补全 `.codegraph/`（CodeGraph 索引，local to machine，不应提交）
- **资源跟踪**：`git add src/assets/icons/*.svg`（5 个设备图标 router/switch/firewall/server/equipment，DeviceNode.tsx 引用，之前漏跟踪）
- **mock-api.ts**：经核实为浏览器 dev 预览模式必要文件（index.html `!window.api` 时动态注入），保留；曾误判为死代码已纠正并恢复

## 2026-06-21

### 代码审计批4b · 前端 low 清理（死代码 / 类型 / 静默失败）
- **ArpTab.tsx**：删除 collectSelected 中恒为 0 的 totalChanges/totalDeprecated 死代码（曾误导运维"无异常"），stats 仅设 entries，变更/弃用项显示 '-'
- **AnomalyTab.tsx**：删除未使用的 _notesModal/_notes 死状态
- **App.tsx**：checkFirstRun 补 .catch（失败不再静默卡 loading）+ useEffect 依赖补全
- **DeviceNode.tsx**：删除未使用的 import React（react-jsx 无需）
- **electron.d.ts**：connection 补 rdpConnect 声明（消除 TopologyPage 类型错误，web 端 tsc 全绿）

### 代码审计批4a · 后端 low 清理（错误处理 / 数据校验 / 性能 / 依赖）
- **crypto.ts**：`decField` try/catch，单条坏密文不再让整个列表加载失败
- **device.ts**：update/delete 拓扑解析 try/catch，跳过坏拓扑不中断整批
- **topology.ts**：importTopology 节点上限 5000，防超大 JSON 撑大库
- **systemLog.ts**：createSystemLog 字段截断（16000），防大 prompt/aiResponse 撑库
- **networkSegmentService.ts**：maskToCIDR 校验掩码格式与二进制连续性，拒绝 255.0.255.0 类非法掩码
- **connection.ts**：`busy_timeout=5000` + `wal_autocheckpoint=1000`，降低并发锁冲突
- **schedulerService.ts**：`runTask().catch` 防 unhandled rejection；ARP insert catch 区分 UNIQUE 记日志
- **package.json**：移除未使用依赖 pdf-parse(21MB) + @types/pdf-parse + build 脚本 external 残留
- **vite.config.ts**：代理 target 抽环境变量 `VITE_AI_PROXY_TARGET`
- **exportService.ts**：csvEscape RFC4180 转义，修复逗号/引号/换行破坏 CSV 列
- **anomalyService.ts**：recordChange catch 加日志，避免静默吞掉插入失败

### 代码审计批3 · 鉴权机制 + IPC 网关 + 入参校验（架构加固）
- **authGuard.ts（新）**：`secure` 高阶函数 = 登录鉴权（未登录 reject「未登录或会话已过期」）+ 异常脱敏（`sanitizeMessage` 移除绝对路径/截断超长，不向渲染层泄露 SQL/路径等内部细节）；单机登录态 `authenticated`
- **main.ts**：`auth:login` 成功置 `authenticated=true`；除 `auth:*` 外所有特权 handler（device/topology/connection/terminal/ai）用 `secure` 包装
- **ipc/*.ts（7 文件）**：所有 handler `secure` 包装（鉴权 + 异常脱敏）
- **入参校验**：network create/update（IPv4 正则 + 掩码二进制连续性）、oui addBatch/deleteBatch（上限 1000）、scheduler updateConfig（interval 1-10080、enabled 0/1/布尔）、anomaly getChanges（limit 范围）/acknowledge/deleteChange（id 正整数）/getBindingHistory（IP 正则）/addExcludedIP（非空）

### 代码审计批2 · Medium 安全/正确性修复（11 项）
- **crypto.ts**：字段加密新增 `v2:` 版本前缀 + 12 字节 IV（GCM 推荐值），decrypt 兼容历史 16 字节 IV 密文（零迁移）；`verifyPasswordSync` 加结构校验/长度上限/等长保护/try-catch
- **auth.ts**：验证码文本改用 `crypto.randomInt`（CSPRNG）；登录失败 5 次锁定 5 分钟；`initAdmin` 增加口令强度策略（≥10 位 + 字母数字）
- **webSecurity.ts（新）+ main.ts + connection.ts**：统一 `hardenWindow` 加固（will-navigate 阻止外链跳转 + setWindowOpenHandler 转系统浏览器）；主窗口与终端窗口 `sandbox:true`；注入严格 CSP；全局 `web-contents-created` 兜底
- **ai.ts**：pendingBatches 增加 TTL（10 分钟自动清理）与 createdAt；batchId 改独立 uuid（与 logId 解耦）；设备名匹配改为指定名未匹配则拒绝、不再回退默认设备
- **networkSegmentService.ts + exportService.ts**：getIPUsage/getIPDetails/exportNetworkUsage 改用真实 CIDR 数值匹配（新增 ipToNumber/ipInCIDR），修正 /16 等非 /24 网段的前 3 段 LIKE 跨段误计

### 代码审计批1 · 安全核心修复（8 项，覆盖 critical + high）
- **keyManager.ts**：主加密密钥改用 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密落盘，绑定机器与用户；兼容历史明文回退，masterKey 值不变不影响历史数据解密
- **knowledgeBaseIpc.ts / knowledgeBaseService.ts**：`kb:getImageData` 修复路径遍历——imagePath 限定在 `imgDir()` 目录白名单内，MIME 改按文件头魔数探测，防止扩展名伪造
- **commandSafety.ts**：重构命令安全校验——拒绝多命令分隔符（\r \n ; & ` $() && ||）、白名单改首词严格相等匹配、黑名单补 system-view/interface/vlan/acl/aaa 等进配置视图命令；保留 `|` 管道过滤不误杀
- **ai.ts**：`executeCommandsOnDevice` 由交互式 `client.shell` 改为非交互 `client.exec`，杜绝换行/分号注入与 prompt 误判；函数内部强制 `isCommandAllowed` 作为执行层最后防线
- **init.ts**：devices 表 CHECK 约束重建（DROP/CREATE/INSERT/RENAME）整段包入 `db.transaction` 并加 `foreign_key_check`，避免中途失败致表丢失/外键悬空
- **crypto.ts**：`deriveKey` 增加 LRU 缓存，避免列表场景重复执行 pbkdf2Sync（10 万次）阻塞主进程
- **ErrorBoundary.tsx / main.tsx**：新增全局错误边界，根渲染包裹，避免运行时异常白屏
- **arpIpc.ts**：ARP 采集异常隔离——try/finally 保证 endCollection 配对、逐设备 try/catch 不中断整体、返回结构增加 failures 统计

## 2026-06-04

### 修复：资产列表修改后拓扑未同步更新
- **device.ts**：`updateDevice()` 新增级联同步逻辑——更新 `devices` 表后遍历所有拓扑，将拓扑节点中嵌入的设备信息（name、deviceType、connectionType、ipAddress、vendor、model）同步更新，与 `deleteDevice()` 的级联策略保持一致

### 修复：知识库 AI 助手无法识别图片
- **knowledgeBaseService.ts**：PDF 解析新增图片提取——使用 pdfjs-dist 从 PDF 页面 operator list 中提取图片对象，编码为 PNG 后调用视觉模型生成描述
- **knowledgeBaseService.ts**：搜索索引新增图片数量标记——AI 从索引中可识别哪些章节包含图片，提升图片相关问题的检索精度
- **ai.ts**：图片描述为空时提示用户检查多模态模型配置，而非静默忽略

## 2026-05-12

### 拓扑自动发现模块重写：AI 判断厂商并生成命令
- **discovery.ts**：重写 `discoverTopologyInner()` 为四阶段流程——(1) 收集设备信息 (2) AI 根据厂商/型号判断厂商并生成采集命令 (3) SSH 执行命令 (4) AI 分析输出生成拓扑。移除对 `vendor-commands.ts` 的 `detectVendor`/`getDiscoveryCommands` 依赖
- **ai.ts**：`executeCommandOnDevice()` SSH 连接成功后增加 2 秒延迟等待设备 banner/MOTD 输出完毕，超时时间从 30s 调整为 35s
- **DeviceForm.tsx**：厂商字段改为必填（`required: true`）

### AI 助手执行日志增加完整对话记录
- **数据库迁移**：`ai_exec_logs` 表新增 `prompt_text`、`ai_response` 两列，使用 PRAGMA 检查后 ALTER TABLE（避免 try-catch 静默吞掉错误）
- **aiExecLogger**：`createLog()` 增加 `promptText`/`aiResponse` 参数，`getLogs()` 返回映射增加这两个字段
- **ai.ts**：`chat()` 调用 `createLog()` 时写入完整 messages JSON 和 AI 原始响应
- **类型定义**：`AIExecLog` 接口增加 `promptText`/`aiResponse` 字段
- **日志审计页面**：`AIExecLogTab` 增加"操作"列和详情弹窗，可查看发送给 AI 的 Prompt 和 AI 原始响应

## 2026-05-10

### 布局重构：工具栏移入侧边栏
- **TopologyToolbar 移入侧边栏**：将顶部水平工具栏改为垂直布局，集成到左侧菜单栏下方（通过 zustand store 桥接状态）
- **新增 `topologyToolbarStore.ts`**：zustand store 跨组件共享拓扑工具栏状态
- **MainLayout**：Content 移除 padding（改为各页面自行管理），侧边栏增加 `overflow: auto`
- **TopologyPage**：移除顶部 TopologyToolbar 渲染，画布直接占满内容区
- **Sidebar**：在导航菜单下方渲染拓扑操作面板（选择拓扑/新建/保存/删除/导入/导出）
- **Electron 窗口**：`autoHideMenuBar: true` 隐藏菜单栏，DevTools 改为 `mode: 'detach'` 独立窗口
- **其他页面**：DevicesPage/AIPage/SettingsPage 各自添加 `padding: 16`

### 拓扑画布 UX 改进
- **选中工具栏**：`SelectionToolbar.tsx` 选中节点显示"编辑属性"+"删除"按钮，选中连线仅显示"删除"按钮，使用 React Flow `useStore` 计算视口定位
- **编辑节点属性**：`EditNodeModal.tsx` 弹窗支持编辑 deviceName/ipAddress/deviceType/vendor/model
- **连线标签中点显示**：`EdgeWithInterfaces.tsx` 使用 `getBezierPath` 的 `labelX`/`labelY` 在连线中点显示接口标签（格式：`源接口 — 目标接口`）
- **TopologyNodeData 扩展**：新增 `vendor?` 和 `model?` 字段
- **AddDeviceModal**：创建节点时携带 vendor/model 字段
- **TopologyCanvas**：集成 `onSelectionChange` 选中追踪和 SelectionToolbar
- **TopologyPage**：添加删除选中、编辑节点属性、选中状态同步

### 增强
- **Mock AI 调用真实接口**：`mock-api.ts` 的 `ai.chat` 直接调用 AI API，通过 Vite proxy 解决 CORS
- **Vite 代理配置**：`vite.config.ts` 添加 `/proxy/ai` 代理，浏览器模式可正常使用 AI 功能
- **修复 antd 废弃 API**：`destroyOnClose` → `destroyOnHidden`（DeviceForm/ConnectionModal/DiscoveryPanel）

### Bug 修复
- **AI助手不能用**：`ai.ts` `saveAiConfig` 使用 nullish coalescing 合并现有配置，避免部分字段更新时清空其他字段；`mock-api.ts` 同步修复
- **拓扑不能连线**：`DeviceNode.tsx` Handle 组件添加 `id` 属性（top/bottom/left/right），React Flow 需要 handleId 匹配才能建立连接
- **拓扑发现面板显示异常**：`DiscoveryPanel.tsx` 使用 `nodeNameMap` 将节点 ID 映射为设备名称，边列表正确显示 "设备A → 设备B" 而非 UUID

## 2026-05-09

### Task 14: 拓扑自动发现（SSH采集+AI分析）
- 新增 `electron/services/vendor-commands.ts`：厂商命令集（Huawei/Cisco/H3C 厂商检测 + 对应发现命令）
- 新增 `electron/services/discovery.ts`：拓扑发现服务（SSH 采集设备信息 + AI 分析连接关系，返回节点/边/失败设备）
- 新增 `src/components/topology/DiscoveryPanel.tsx`：发现面板 UI（设备多选、采集进度、结果展示、失败设备列表、确认导入）
- 修改 `electron/services/ai.ts`：导出 `callAI`、`executeCommandOnDevice`、`getDeviceByIdInternal` 供 discovery 复用
- 修改 `electron/main.ts`：注册 `ai:discoverTopology` IPC 处理器
- 修改 `src/types/electron.d.ts`：补全 `discoverTopology` 返回类型（含 `failedDevices`）
- 修改 `src/components/pages/TopologyPage.tsx`：添加拓扑发现按钮（FAB 区域）和 DiscoveryPanel 集成（去重合并）

### Task 13: 系统设置页面（AI配置+白名单编辑器+执行模式切换+日志查看器+退出登录）
- 新增 `src/components/settings/CommandWhitelistEditor.tsx`：命令白名单编辑器（标签列表+添加/删除+保存）
- 新增 `src/components/settings/AIExecLogViewer.tsx`：AI 执行日志表格查看器（分页、状态彩色标签、刷新）
- 新增 `src/components/settings/ExecModeSwitch.tsx`：执行模式切换（确认/自动，切换自动需密码验证弹窗）
- 替换 `src/components/pages/SettingsPage.tsx`：完整设置页（AI模型配置表单、白名单、执行模式、日志查看、退出登录）

### Task 12: AI 服务（配置+对话+设备查询+命令安全+日志）
- 新增 `electron/services/commandSafety.ts`：命令白名单安全检查（白名单前缀匹配+黑名单正则双重防护）
- 新增 `electron/services/aiExecLogger.ts`：AI 执行日志记录（创建/更新状态/查询，设备名加密存储）
- 新增 `electron/services/ai.ts`：AI 服务核心（配置管理、OpenAI兼容API调用、设备SSH命令执行、确认/自动模式、聊天历史持久化）
- 修改 `electron/main.ts`：注册 AI IPC 处理器（chat/getConfig/saveConfig/whitelist/execMode/confirm/logs/history）
- 替换 `src/components/pages/AIPage.tsx`：完整AI聊天界面（设备选择、消息气泡、确认弹窗、未配置提示）

### Task 11: 设备连接（独立弹窗终端+SSH Key）
- 新增 `electron/services/connection.ts`：连接服务（SSH/Telnet连接管理、终端窗口创建、SSH Key认证优先）
- 新增 `electron/terminal-preload.ts`：终端弹窗预加载脚本（terminalApi 桥接）
- 新增 `terminal.html`：终端弹窗 HTML 入口
- 新增 `src/terminal-main.tsx`：终端窗口独立 React 入口
- 新增 `src/components/TerminalWindow.tsx`：xterm.js 终端组件
- 修改 `electron/main.ts`：注册连接 IPC 处理器和终端窗口 IPC
- 修改 `src/types/topology.ts`：TopologyNodeData 增加 connectionType 字段
- 修改 `src/types/electron.d.ts`：增加 TerminalAPI 类型声明
- 修改 `src/components/topology/TopologyCanvas.tsx`：增加 onNodeDoubleClick 属性
- 修改 `src/components/topology/AddDeviceModal.tsx`：节点数据包含 connectionType
- 修改 `src/components/pages/TopologyPage.tsx`：双击设备节点触发连接（SSH/Telnet/Web）

### Task 10: 拓扑管理页面（含导入导出）
- 新增 `electron/services/topology.ts`：拓扑 CRUD 服务（名称/数据加密，导入导出）
- 新增 `src/components/topology/TopologyToolbar.tsx`：工具栏（选择拓扑/新建/保存/删除/导入/导出）
- 新增 `src/components/topology/AddDeviceModal.tsx`：设备选择弹窗（从设备列表添加到画布）
- 替换 `src/components/pages/TopologyPage.tsx`：完整拓扑管理（IPC CRUD、自动保存、导入导出）
- 修改 `electron/main.ts`：注册拓扑 IPC 处理器，共享 masterKey

### Task 9: React Flow 拓扑画布
- 新增 `src/types/topology.ts`：TopologyNodeData/TopologyEdgeData/Topology 类型定义
- 新增 `src/components/topology/DeviceNode.tsx`：自定义设备节点（router/switch/firewall/server/generic 图标，设备名悬浮在图标上方）
- 新增 `src/components/topology/EdgeWithInterfaces.tsx`：自定义连线，靠近源/目标节点显示接口标签
- 新增 `src/components/topology/ConnectionModal.tsx`：Ant Design 弹窗，连接时输入源/目标接口名称
- 新增 `src/components/topology/TopologyCanvas.tsx`：React Flow 画布主组件（Controls/MiniMap/Background）
- 替换 `src/components/pages/TopologyPage.tsx`：拓扑管理页面（本地状态管理，Task 10 接入 IPC）
- 新增 `src/vite-env.d.ts`：CSS 模块声明
- 修改 `src/main.tsx`：全局引入 reactflow/dist/style.css

### Task 8: 设备管理 CRUD
- 新增 `src/types/device.ts`：Device/CreateDeviceDTO/UpdateDeviceDTO 类型定义
- 新增 `electron/services/device.ts`：设备 CRUD 服务（全字段加密、级联删除拓扑节点）
- 新增 `src/components/DeviceForm.tsx`：设备表单（设备类型选择、连接方式联动、SSH Key 支持）
- 替换 `src/components/pages/DevicesPage.tsx`：设备管理页面（列表/添加/编辑/删除）
- 修改 `electron/main.ts`：引入 device 服务、masterKey 共享、注册设备 IPC 处理器

### Task 5: 认证服务
- 新增 `electron/services/auth.ts`：验证码生成/验证、登录、首次运行检测、管理员初始化
- 修改 `electron/main.ts`：集成数据库初始化、密钥管理器、认证 IPC 处理器
- 新增 `tests/unit/auth.test.ts`：验证码相关单元测试（4 cases 全部通过）

## 2026-07-02 Phase 5 执行
- fix(05): AIPage useEffect dep `[chat]`→`[]` 修无限重渲染回归（code review CR-01，FE-01 拆分引入；useAIChat 每渲染返回新对象致 IPC 风暴）
