# Phase 6: Robustness & Resource Safety - Context

**Gathered:** 2026-07-05
**Status:** Ready for planning

<domain>
## Phase Boundary

采集/发现路径的健壮性加固——SSH/Telnet 句柄 try/finally 化（杜绝泄漏）+ discovery JSON parse 错误上下文（杜绝定位盲区）+ createSystemLog 非致命包裹（杜绝日志写库失败中断主流程）。**纯加固**：不改功能语义、不改 IPC 签名、不动 SQL schema/迁移、不改加密。

**改造性质：**
- **ROBUST-01**：`arpCollector.executeSSH` / `arpCollector.executeTelnet` 句柄 try/finally 化（统一 `clearTimeout` + `end/destroy`），消除多个 early-return / error 路径的 stray timer 与连接泄漏
- **ROBUST-02-a**：`discovery` 两处 JSON parse（command parse line 142-144 / topology parse line 250-274）失败携带原始内容片段 + 解析位置，command parse 补 `createSystemLog` 与 topology parse 对齐
- **ROBUST-02-b**：`discovery` 5 处 `createSystemLog` 裸调用（line 116/126/240/258/266）改为 try/catch 非致命包裹，日志写库失败不中断发现主流程

**不在本阶段范围（属于其他 phase / milestone 外）：**
- BUG-3 `before-quit` 不等 in-flight backup（`main.ts:171` / `backupScheduler.ts:64`）→ **defer**（非 ROBUST-01/02 字面，是 backupScheduler/main.ts 备份退出健壮性；CONCERNS 标「P6」为建议非强制，REQUIREMENTS.md traceability 无对应 REQ ID）。见 Deferred
- 全局静默吞错收敛（FRAG-2：`KnowledgeBasePage.tsx:42/123` / `backupScheduler.ts:52,99,102` / `keyManager.ts:23` / `arpIpc.ts:17`）→ 非 ROBUST-02 字面（ROBUST-02 仅 discovery 的 createSystemLog），defer 到未来「全局日志/错误健壮性」debt
- `executeTelnet` `shellPrompt: /[>#]/` 正则过宽（FRAG-3，`arpCollector.ts:58`）→ 非 ROBUST 字面（句柄泄漏与 prompt 边界是不同 fragility），defer
- 后端 `any` 清理 + ai.ts/kbService 拆分（CONCERNS TD-1/TD-2）→ milestone 外（Phase 5 已界定）
- `ai_system_logs` schema 扩字段或 CHECK 调整 → 本阶段不改 schema（enriched errorMessage 复用现有 TEXT 字段，见 D-6-3）

</domain>

<decisions>
## Implementation Decisions

> **决策授权说明：** 用户在本阶段延续 P2/P3/P4/P5 既定委托模式（原话"你直接决定，不偏离项目预期即可"），全权委托 Claude 按"项目最优"拍板。下方 D-6-1~D-6-5 均为 Claude 基于「代码现状核实（arpCollector.ts / discovery.ts / ai.ts 活代码逐行确认）+ PROJECT.md 核心价值/约束 + 前期 carry-forward 决策（Phase 3 D-P4 可观测性 / Phase 5 委托模式 / DEP-1 限制）」得出，**用户保留 `/gsd-plan-phase` 前审阅/修改权**。每个决策附代码依据，researcher/planner 在不违背决策语义与 PROJECT.md 约束下对纯实现细节有自由度。

### ROBUST-01 改造范围 — D-6-1

- **D-6-1 范围 = arpCollector 两函数 + ai.executeCommandsOnDevice 一并 try/finally 化；executeTelnet 补自有 setTimeout。**
  - **为何扩到 `executeCommandsOnDevice`（超 SC#1 字面"arpCollector executeSSH/executeTelnet"）**：SC#4「反复触发采集/发现循环后无句柄泄漏」是硬验收点。`executeCommandsOnDevice`（`ai.ts:308-369`）是 **discovery 路径的 SSH 执行入口**（`discovery.ts:166` 调用），同为 `new Client()` + settled-flag 手动各路径 `clearTimeout`/`client.end()` 的非 try/finally 模式（CONCERNS FRAG-1 明示"P6 一并审视"）。不一并加固则 SC#4 仍有泄漏面，SC#4 与 SC#1 验收口径不一致。
  - **为何给 `executeTelnet` 补自有 setTimeout**：现状 `executeTelnet`（`arpCollector.ts:52-65`）无自有 timer，靠 telnet-client 的 `connect.timeout` / `execTimeout` 参数（line 55/59）。telnet-client 在网络层挂起时 callback 可能不 fire（库级超时不完全可靠），与 `executeSSH` 的外层 setTimeout 兜底模式不对齐。补自有 setTimeout 包整体 try/finally 是 SC#4 的真正兜底，使两协议同构。
  - **改造 3 函数 / 2 文件**：`arpCollector.ts`（executeSSH + executeTelnet）、`ai.ts`（executeCommandsOnDevice）。files_modified 与 ROBUST-02（`discovery.ts` 独占）零重叠，可同 wave 并行（planner 裁量 wave 划分）。

### ROBUST-01 SSH/Telnet 清理模式 — D-6-2

- **D-6-2 模式 = try/finally 块统一 `clearTimeout(timer)` + `try { client.end() } catch {}`；timeout fire 路径额外 `destroy()` 强制销毁 socket。**
  - **为何 finally 而非 settled-flag**：现状（executeSSH line 24-50）多个 resolve/reject 路径（stream close line 36 / stream error line 37 / exec err line 32）**均不清 timeout**，留下 stray timer（timer fire 后 `client.destroy()` + 二次 reject 无害但模式不洁）。finally 保证任意路径都清 timer + end，是 SC#1「try/finally + end/destroy + clearTimeout」字面的忠实落地，消除"漏清路径"类问题。
  - **end() 优先于 destroy()**：ssh2 `end()` 是优雅关闭（发 EOF，对端可响应），`destroy()` 是强制销毁 underlying socket。正常/错误路径用 `end()`（优雅，与现状一致），**仅 timeout 兜底路径**先 `end()` 再 `destroy()`（超时场景对端可能不响应 EOF，需强制销毁回收 socket）。finally 里 `try { client.end() } catch {}`——client 已 end/destroy 后再 end 可能抛，catch ignore 无害。
  - **重构形态委托 planner**：ssh2 是事件驱动（`client.on('ready')` 回调），不能简单同步 try 包。planner 在两种形态间裁量：(a) Promise executor 内用 try/finally 包所有 resolve/reject 路径的统一出口；(b) 把 connect/ready 事件包成 async/await + 外层 try/finally。**模式锁定为 finally 块清 timer + end**，形态不限。
  - **executeTelnet finally**：telnet-client 的 `end()`/`destroy()` 是 async，finally 里调即可（planner 裁量是否 `await`——finally 在 async 函数末尾可 await，但不强 await 也能触发回收）。模式：`try { ... } finally { clearTimeout(timer); try { await connection.end() } catch {}; try { connection.destroy() } catch {} }`。

### ROBUST-02 JSON parse 错误上下文 — D-6-3

- **D-6-3 错误对象 = enriched Error 含原始片段 slice(0,200) + err.message（自带 position）；command parse 补 createSystemLog 与 topology parse 对齐。**
  - **错误信息结构**：discovery 内部 throw 的 Error message 形如 `AI 命令结果解析失败: ${err.message} | 原始片段: ${raw.slice(0,200)}`。JSON.parse 抛的 SyntaxError 自带 position（"Unexpected token ... in JSON at position N"），但不含原始内容——补 slice(0,200) 让运维定位是 AI 漂移（返回解释文本/截断）还是转义错误，满足 SC#2「原始内容片段 + 位置」。
  - **command parse（line 142-144）补 createSystemLog**：当前直接 throw 无 log。补 `status:'failed'` 的 log（含 `promptText: commandPromptText` + `aiResponse: commandAiResponse` + `errorMessage`），与 topology parse（line 266-272）对齐——两处 parse 失败均落审计日志，运维可追溯。
  - **topology parse（line 266-272）现状已部分达标**：已有 createSystemLog + aiResponse，但 errorMessage 仅 `${err.message}`（无原始片段）——D-6-3 同步加 slice(0,200)。
  - **是否抽 `enrichParseError(raw, err)` helper**：discovery 两处 parse 同模式（trim → 去 codeblock → JSON.parse → catch enrich），抽局部 helper 合理。**委托 planner 裁量**（抽 helper vs 两处内联），但 helper 局限于 discovery.ts 内（不跨模块）。
  - **不扩 createSystemLog schema**：enriched errorMessage 装入 `ai_system_logs.errorMessage` 现有 TEXT 字段（批4a 已加 systemLog 截断），无需 v8 迁移。researcher 核实截断阈值（slice 200 + err.message 通常 < 500 字符，远低于截断线）。

### ROBUST-02 createSystemLog 非致命包裹 — D-6-4

- **D-6-4 策略 = 5 处全部 try/catch 包裹 + 抽 discovery 局部 safeLog helper（console.warn 兜底）。**
  - **5 处全包**（line 116/126/240/258/266）：满足 SC#3「createSystemLog 调用被 try/catch 包裹，日志写库失败不影响主流程」字面。line 258 虽在 try 内（line 251-264），但其自身抛会触发外层 catch（line 265）→ line 266 又调 createSystemLog（catch 内二次调用，自身也可能抛则中断）——故每处独立 try/catch，彻底切断"日志写库失败中断发现主流程"链。
  - **抽局部 safeLog helper**：`function safeLog(entry) { try { createSystemLog(entry) } catch (e) { console.warn('[safeLog] discovery 日志写库失败', e?.message) } }`，discovery 内 5 处替换。helper 局限于 `discovery.ts`（模块内复用，5 处去重）。
  - **为何不抽全局 safeLog util**：FRAG-2 显示静默吞错散落多模块（backupScheduler/keyManager/arpIpc），但那些非 ROBUST-02 字面（ROBUST-02 仅 discovery 的 createSystemLog）。跨模块统一 safeLog 是更大重构 → defer。本阶段仅在 discovery 内局部收敛。
  - **console.warn 兜底而非纯静默**：日志写库失败必须可观测（PROJECT.md 核心价值"设备/数据安全可控"+ Phase 3 D-P4"可观测性"原则）。console.warn 进主进程 stderr，运维可查；非完全静默。
  - **helper 签名/字段细节委托 planner**：safeLog 是否接受 Partial<SystemLogEntry>、console.warn 的格式、是否区分 type 字段——纯实现细节。

### SC#4 验收方式 — D-6-5

- **D-6-5 验收 = 静态 grep（try/finally + clearTimeout + end/destroy 模式存在）+ Electron 人工 HV（连真实设备反复采集，句柄快照对比）。**
  - **为何不自动化**：DEP-1 限制下 SSH/Telnet client 无法在 plain node/vitest 实测（better-sqlite3 ABI 冲突外，ssh2/telnet-client 连真实设备需 Electron 运行时 + 真实网络设备）。mock client 的句柄计数无意义（mock 不持有真实 socket）。与 Phase 3 HV-1~5、Phase 5 FE-01/03/04 人工 HV 同模式。
  - **静态 grep 验收点**（verifier 可 grep，满足 SC#1 字面）：
    - `arpCollector.ts`：executeSSH / executeTelnet 各含 `try`/`finally` + `clearTimeout` + `client.end`/`connection.end`
    - `ai.ts`：executeCommandsOnDevice 含 `finally` + `clearTimeout` + `client.end`
  - **人工 HV**（写入 `06-HUMAN-UAT.md`）：
    1. 连 1-2 台真实 SSH 设备 + 1 台 Telnet 设备，触发 5+ 轮 `ARPCollector.collectFromAll()`，每轮后 `process._getActiveHandles().length` 快照——句柄数稳定不单调增长
    2. 触发 1-2 轮 discovery，对比前后句柄数
    3. **error 路径兜底 HV**：用错误凭证 / 不可达 IP / 超时设备触发采集，验证 finally 兜底（连接不残留）
    4. discovery JSON parse 失败 HV：mock AI 返回非 JSON，验证 errorMessage 含原始片段 + createSystemLog 落库 + 主流程不被 createSystemLog 失败中断
  - **不加自动化句柄计数脚本到 vitest**：DEP-1 下跑不了真实 client。HV 人工足够（与既有 HV 系列一致）。

### Claude's Discretion

D-6-1~D-6-5 均为用户全权委托的决策。**下游 researcher/planner 在不违背上述决策语义与 PROJECT.md 约束的前提下，对纯实现细节有自由度：**
- ROBUST-01：try/finally 的具体重构形态（Promise executor 内 try/finally vs async/await 包装）、`end()` vs `destroy()` 在 timeout 路径的具体调用顺序、executeTelnet 自有 setTimeout 的位置（包 connect+exec 整体 vs 仅 exec）
- ROBUST-02：`enrichParseError` helper 是否抽取及签名、`safeLog` helper 签名与 console.warn 格式、createSystemLog 字段精确填充
- 验收：`06-HUMAN-UAT.md` 的具体步骤排版、句柄快照的获取方式（`process._getActiveHandles` vs `--inspect` Heap snapshot）
- 文件归属与 wave 划分（见 Integration Points 的共享文件约束）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 定义与需求
- `.planning/ROADMAP.md` §Phase 6 — 阶段 Goal（采集/发现路径无句柄泄漏、无静默吞错，错误可追踪）/ Depends on Phase 5 / 4 条 Success Criteria（arpCollector try/finally + clearTimeout、discovery JSON parse 错误上下文、createSystemLog try/catch、反复触发无句柄泄漏）
- `.planning/REQUIREMENTS.md` §Robustness — **ROBUST-01**（arpCollector executeSSH/executeTelnet try/finally + client.end/destroy + error 路径 clearTimeout）/ **ROBUST-02**（discovery JSON parse 错误上下文 + createSystemLog try/catch）

### 项目约束（红线）
- `.planning/PROJECT.md` §Constraints — 向后兼容（不改功能语义/IPC/SQL/加密）、Tech stack 不可换核心栈、Build（tsconfig.web.json 严格 + noUnusedLocals 全绿 + esbuild）
- `.planning/PROJECT.md` §Context — 核心价值"拓扑准确呈现与设备安全可控为最高优先级"（D-6-1 扩到 executeCommandsOnDevice、D-6-4 console.warn 兜底的直接依据）
- `.planning/STATE.md` §Risk Watch — "加密/迁移改动必须向后兼容"（本阶段无 schema/加密改动，纯加固）

### Codebase 审计（ROBUST-01/02 debt 来源 — 必读）
- `.planning/codebase/CONCERNS.md` §FRAG-1 — arpCollector executeSSH/executeTelnet 句柄泄漏（line 24-50 / 52-65 逐路径分析 + ai.executeCommandsOnDevice「P6 一并审视」建议）— **D-6-1 范围 / D-6-2 模式的直接依据**
- `.planning/codebase/CONCERNS.md` §BUG-4 — discovery JSON parse 失败错误上下文不足（line 136-144 / 250-274）— **D-6-3 直接依据**
- `.planning/codebase/CONCERNS.md` §BUG-5 — discovery createSystemLog 调用未 try/catch（line 116/126/240/258/266）— **D-6-4 直接依据**
- `.planning/codebase/CONCERNS.md` §FRAG-2 — 静默吞错散落多处（仅参考，非本阶段 scope，D-6-4 defer 依据）
- `.planning/codebase/CONCERNS.md` §BUG-3 — before-quit 不等 in-flight backup（**defer 决策依据**，非本阶段）
- `.planning/codebase/CONCERNS.md` §DEP-1 — better-sqlite3/ssh2 native binding ABI 限制（**D-6-5 不自动化、人工 HV 的直接依据**）

### 前期 Phase 先例（机制复用）
- `.planning/phases/05-frontend-refactor-types/05-CONTEXT.md` — §Deferred 明示"采集/发现句柄泄漏与静默吞错 → Phase 6（ROBUST-01/02）"；委托模式 + 决策授权说明（D-6-1~D-6-5 沿用同机制）
- `.planning/phases/03-performance-optimization/03-CONTEXT.md` — **D-P4** init 跳过可观测日志（D-6-4 console.warn 兜底遵循同"可观测性"原则）；HV-1~5 人工验证模式（D-6-5 同模式参照）；03-CONTEXT §无 worker thread 决策（本阶段不改架构，纯函数级加固）

### 现有实现（待加固的活代码 — ROBUST-01）
- `electron/services/arpCollector.ts:24-50` — `executeSSH`（timeoutId line 27 仅 ready/error 清除；stream close line 36 / stream error line 37 / exec err line 32 三路径不清 timeout；ready 回调内 exec 同步异常 client 可能不 end）— D-6-1/D-6-2 改造对象
- `electron/services/arpCollector.ts:52-65` — `executeTelnet`（end/destroy 在 try 之外，exec 抛错连接泄漏；无自有 setTimeout）— D-6-1 补 timer + D-6-2 try/finally 改造对象
- `electron/services/ai.ts:308-369` — `executeCommandsOnDevice`（settled-flag 非 try/finally 模式；client.on('error') line 363-366 清 timer 不 end；overallTimer fire line 329-335 end 但模式脆弱）— D-6-1 扩展范围改造对象
- `electron/services/ai.ts:373-386` — `execOne`（单命令 exec，被 executeCommandsOnDevice 调用，本阶段不改但 researcher 审视其 stream 句柄是否需兜底）

### 现有实现（待加固的活代码 — ROBUST-02）
- `electron/services/discovery.ts:136-144` — command JSON parse（catch line 142-144 直接 throw 无上下文无 createSystemLog）— D-6-3 改造对象
- `electron/services/discovery.ts:250-274` — topology JSON parse（catch line 265-274 有 createSystemLog line 266-272 但 errorMessage 无原始片段）— D-6-3 改造对象
- `electron/services/discovery.ts:116,126,240,258,266` — 5 处 createSystemLog 裸调用 — D-6-4 safeLog 包裹对象
- `electron/services/systemLog.ts` — `createSystemLog`（被调用方，本阶段不改其实现，仅 discovery 侧包 safeLog）

### 调用方 / 集成点（验证回归不破）
- `electron/services/discovery.ts:166` — `executeCommandsOnDevice` 调用点（D-6-1 扩展范围后，discovery 调用语义不变）
- `electron/services/schedulerService.ts:64` / `electron/ipc/arpIpc.ts:37,59` — `processARPEntries` / ARP 采集调度调用链（executeSSH/executeTelnet 经 collectFromDevice 调用，try/finally 化对调用方透明，`ARPCollectionResult.error` 字段语义不变）

### 架构参照
- `.planning/codebase/ARCHITECTURE.md` — IPC 网关层（secure 鉴权）→ 业务 service → 数据层；arpCollector/discovery 均为业务 service，本阶段改动不越层
- `.planning/codebase/INTEGRATIONS.md` — ssh2 / telnet-client 事件驱动 API 特性（D-6-2 try/finally 重构形态依据）；better-sqlite3 同步 API（createSystemLog 同步调用，D-6-4 try/catch 包裹语义）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`createSystemLog`**（`electron/services/systemLog.ts`）：discovery 5 处调用的统一日志入口。D-6-4 在 discovery 内包 safeLog helper，不改 createSystemLog 自身（保持其他调用方语义）。
- **`ai.executeCommandsOnDevice` settled-flag 模式**（`ai.ts:326`）：相对健壮（各路径 clearTimeout + end），D-6-1 重构为 try/finally 时可参照其 timeout 计算（`overallTimeout = 30000 + commands.length * 15000`，line 328）与错误分类逻辑（line 349-351 单命令失败不阻断整批）。
- **`ARPCollectionResult.error` 字段**（`arpCollector.ts:14,91`）：executeSSH/executeTelnet 的错误经 `collectFromDevice` try/catch（line 81-93）落 result.error，不抛到调用方。try/finally 化后此语义不变（finally 只清资源，不改 reject/throw 行为）。

### Established Patterns
- **静态验证三绿门禁**：`tsc -p tsconfig.web.json` + electron main esbuild + `vitest run`——ROBUST-01/02 全部以此为代码级验收（与 Phase 2/3/4/5 一致）。
- **委托决策 + planner 实现自由度**：本项目既定模式（P2/P3/P4/P5），D-6-1~D-6-5 全委托与此一致。
- **DEP-1 限制下的验证策略**：SSH/Telnet/DB 无法 plain node 实测 → 静态验证 + Electron 人工 HV（D-6-5 与 Phase 3 HV-1~5 / Phase 5 FE-HV 同模式）。
- **可观测性优先**（Phase 3 D-P4）：错误/跳过事件必须可观测日志——D-6-4 safeLog 的 console.warn 兜底遵循此原则，非纯静默。

### Integration Points
- **共享文件（planner 须按文件归属分 wave，零编辑冲突）：**
  - `electron/services/arpCollector.ts` ← **ROBUST-01 独占**（executeSSH + executeTelnet + 可能补的自有 setTimeout，同函数族）
  - `electron/services/ai.ts` ← **ROBUST-01 独占**（executeCommandsOnDevice）；ROBUST-02 不触碰 ai.ts
  - `electron/services/discovery.ts` ← **ROBUST-02 独占**（两处 JSON parse + 5 处 createSystemLog + safeLog helper）；ROBUST-01 不触碰 discovery.ts
- **三文件零重叠**：ROBUST-01（arpCollector.ts + ai.ts）与 ROBUST-02（discovery.ts）可同 wave 并行。planner 亦可按 REQ 分两 plan（06-01 ROBUST-01 / 06-02 ROBUST-02）串行或并行，files_modified 零冲突。
- **调用方零改**：executeSSH/executeTelnet/executeCommandsOnDevice 三函数签名与返回/抛错语义不变（finally 只加资源清理），schedulerService / arpIpc / discovery 调用方零改。

</code_context>

<specifics>
## Specific Ideas

- **D-6-1 扩到 executeCommandsOnDevice 的关键依据 = SC#4**：SC#1 字面只点名 arpCollector，但 SC#4「反复触发采集/发现循环后无句柄泄漏」覆盖 discovery 路径，而 discovery 的 SSH 执行入口正是 executeCommandsOnDevice。两 SC 验收口径必须一致——只改 arpCollector 则 SC#4 在 discovery 循环下仍可能泄漏。这是"不偏离项目预期"的体现（验收点闭环）。
- **D-6-2 timeout 路径 end+destroy 双调用**：ssh2 超时场景下对端可能不响应 EOF，单 end() 可能不回收 socket。timeout fire 时 `try { client.end() } catch {} 然后 client.destroy()` 兜底。finally 的通用 end() 是正常路径语义。
- **D-6-3 command parse 补 createSystemLog 是对齐而非新需求**：topology parse（line 266-272）已有 createSystemLog，command parse（line 142-144）缺失是遗漏。两处 parse 失败均应落审计日志（运维追溯 AI 漂移/截断），非扩 scope。
- **D-6-4 line 258 的嵌套陷阱**：line 258 createSystemLog 在 line 251-264 try 内，若其抛被 line 265 catch → line 266 又调 createSystemLog（catch 内二次调用，自身也可能抛则中断主流程）。故每处独立 try/catch 是切断此嵌套链的必要条件，非过度工程。
- **D-6-5 句柄快照用 `process._getActiveHandles()`**：Node 私有 API 但在 Electron 主进程可用，返回 active handles（socket/timer/stream）。HV 时在每轮采集后 invoke 对比长度，直观验证 SC#4。无需引入 inspector 复杂度。
- **enriched errorMessage 不超 systemLog 截断阈值**：批4a systemLog 截断（CONCERNS 已修），slice(0,200) + err.message 通常 < 500 字符，远低于截断线。researcher 核实阈值确认无信息丢失。

</specifics>

<deferred>
## Deferred Ideas

- **BUG-3 before-quit 不等 in-flight backup**（`main.ts:171` / `backupScheduler.ts:64`）：CONCERNS 标「P6」为建议，但非 ROBUST-01/02 字面（是 backupScheduler/main.ts 备份退出健壮性，非采集/发现路径），REQUIREMENTS.md traceability 无对应 REQ ID。纳入 = 扩 ROBUST 字面 scope。**defer**：独立 hotfix 或后续「备份健壮性」phase。CONCERNS 已记录不丢失。
- **全局静默吞错收敛（FRAG-2）**：`KnowledgeBasePage.tsx:42/123`（前端图片/device.list 静默）/ `backupScheduler.ts:52,99,102` / `keyManager.ts:23`（safeStorage 回退）/ `arpIpc.ts:17`（非 UNIQUE/CONSTRAINT 静默）。非 ROBUST-02 字面（ROBUST-02 仅 discovery 的 createSystemLog）。D-6-4 safeLog 局限于 discovery.ts，不跨模块。**defer** 到未来「全局日志/错误健壮性」debt。
- **`executeTelnet` shellPrompt 正则过宽（FRAG-3）**：`/[>#]/`（line 58）匹配任意含 `>`/`#` 输出，设备 banner/MOTD 含这些字符会误判 prompt 边界。与句柄泄漏是不同 fragility，非 ROBUST 字面。**defer**。
- **全局 safeLog util**：D-6-4 抽 discovery 局部 helper。跨模块统一 safeLog（backupScheduler/keyManager/arpIpc 复用）是更大重构，**defer**。
- **SSH/Telnet 句柄自动化测试**：DEP-1 限制下无法 plain node 实测真实 client。未来若引入 `@electron/rebuild` + electron-vite 集成 vitest 跑 Electron 内测试（CONCERNS DEP-1 migration plan），可补句柄回归测试。**defer**。
- **后端 `any` 清理 + ai.ts/kbService 拆分（TD-1/TD-2）**：milestone 外（Phase 5 已界定）。

</deferred>

---

*Phase: 6-Robustness & Resource Safety*
*Context gathered: 2026-07-05*
