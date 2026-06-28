# Phase 4: Data / IPC Safety - Context

**Gathered:** 2026-06-28
**Status:** Ready for planning

<domain>
## Phase Boundary

让 4 个大数据 IPC 通道的主进程↔渲染层数据交换**有界**，不再一次性序列化/传输超大结果集。**纯数据安全层**——不改功能语义、不动 SQL schema、不改加密/迁移。覆盖 `network:getIPDetails` / `oui:getAll` / `anomaly:getChanges` / `export:arpTable` 四通道（DATA-01）。

**改造性质：**
- 给无界 list 通道（getIPDetails / oui:getAll）补「分页参数 + 默认上限 + 截断信封」
- 给已有上限但无翻页的通道（anomaly:getChanges，现有 `limit` 无 `offset`）补 `offset` 统一契约
- 给内存侧无界的 export 通道（export:arpTable）改「流式分块写 CSV」，消除一次性全量读+拼巨型字符串

**不在本阶段范围（属于其他 phase）：**
- 翻页 UI（分页器组件、加载更多交互）→ Phase 5 前端重构（本阶段仅暴露 limit/offset 参数 + 截断信封，渲染层适配信封字段）
- 前端 any→types / AIPage 拆分 / TopologyPage getState / ChunkContent AbortController → Phase 5
- 采集/发现句柄泄漏与静默吞错 → Phase 6
- ipInCIDR 下推 SQL（schema 层 IP 数值化）→ 若 ip_status 增长成真问题再评估（见 D-4-6 / Deferred）

</domain>

<decisions>
## Implementation Decisions

> **决策授权说明：** 用户在本阶段「分页模型选型」「默认上限与无回归」两项 gray area 亲自拍板（D-4-1~D-4-4）；「export 通道归属」「getIPDetails 边界策略」两项委托 Claude 按"项目最优解"决定（D-4-5/D-4-6），用户保留 `/gsd-plan-phase` 前审阅/修改权。委托模式与 Phase 2/3 一致。

### 分页契约（Pagination Contract）— 用户拍板

- **D-4-1 契约模型 = 上限默认 + 暴露 limit/offset 参数（hybrid）。**
  - **默认行为 = 防御性上限**（向后兼容：默认调用不传参时返回一个有界的结果集，而非历史全量无界）。
  - **IPC 签名暴露 `limit` + `offset` 参数**，使 Phase 5 可直接接翻页 UI（传 offset 翻页）**而无需再改 IPC 通道**。
  - **统一性**：3 个 list 通道（getIPDetails / oui:getAll / anomaly:getChanges）统一此契约。`anomaly:getChanges` 已有 `limit`（无 `offset`），补 `offset` 即对齐，不另起模型。
  - **理由**：DATA-01 success criteria 字面允许"分页参数 **或** 默认行数上限"——hybrid 同时满足两者，现在交付（默认有界）又不越界 Phase 5（翻页 UI 留给前端 phase）。最保守的真分页（本阶段连带改 4 个 Tab UI）会越界 Phase 5 且本阶段 `UI hint=no`，故不选。
- **D-4-2 截断信封 = 返回 `{ rows, total, truncated }`（list 通道）。**
  - list 通道返回值由裸数组 `any[]` 改为信封对象：`rows`（当前页/截断后的结果数组）、`total`（过滤后符合条件总数，未应用 limit 的口径）、`truncated`（本次 rows 是否被 cap 截断）。
  - **核心理由**：运维工具**不可静默藏数据**——若默认 cap 截断后只返回数组、调用方不知情，运维可能漏看 rogue 设备/IP，违背核心价值"拓扑准确呈现与设备安全可控"。信封明确告知截断，是安全语义而非可选体验。
  - **调用方适配**：4 个渲染层消费方改读 `.rows`（NetworkTab / OuiTab / AnomalyTab）——属 success criteria #3「现有调用方适配新签名，无回归」的既定适配工作。
  - **字段细节留给 planner**：信封是否回显 `limit`/`offset`、`total` 精确口径（应用 search 过滤后 vs 应用前）、类型定义放 `src/types` 还是 IPC 层——均为实现细节，由 planner 在不违背"明确告知截断"语义下裁量。

### 上限与无回归（Caps & No-Regression）— 用户拍板

- **D-4-3 默认 cap = 按数据尺度差异化**（兼顾「无回归」与「payload 有界」）：
  - **`getIPDetails` 默认 2000** —— 单网段主机数，覆盖到 /22（≈1022 主机），远超典型 /24（≈254）。本用户拓扑可视化场景单网段极少超 /24。
  - **`oui:getAll` 默认 5000** —— 本用户 OUI 通常数百（150 seed + 自定义）。全量 IEEE OUI 表（~40000）非本通道默认场景，由既有 `oui:search` + 分页覆盖。
  - **`anomaly:getChanges` 维持默认 100** —— 现有值合理，仅补 `offset`。
  - **「无回归」由信封保障**：即便某通道默认 cap 被触发，`truncated=true` + `total` 明确告知，调用方/Phase 5 UI 可经 `offset` 取回剩余，非静默回归。
- **D-4-4 硬性上限（validateLimit ceiling）= 每通道硬上限：**
  - **`getIPDetails` / `oui:getAll` 硬上限 50000**（caller 传 `limit` 超出则校验拒绝或钳制到 50000）。
  - **`anomaly:getChanges` 维持 10000**（现状）。
  - **复用既有先例**：`anomalyIpc.ts:7-11` 的 `validateLimit(limit)`（`Number.isInteger` + `[1,10000]` 钳制，非法回落 100）——本阶段把此 helper 提取/镜像到 getIPDetails、oui:getAll 的 IPC 校验，模式一致。
  - **理由**：若仅设默认 cap 而 caller 传参无硬上限，调用方可传 `limit=千万` 绕过，重新引入无界 payload——违背 DATA-01 本意。硬上限是"payload 有界"的强制闸门。

### 通道级实现策略（Per-Channel Strategy）— Claude 委托拍板

- **D-4-5 `export:arpTable` = 纳入 DATA-01，但改造点在主进程内存侧（流式分块写 CSV），非 IPC 签名/返回形态。**
  - **payload 分析**：`export:arpTable` 的 IPC payload 是 CSV **文件路径**（`ExportService.saveCSV` 写文件后返 path），**本身极小**，不存在"超大 IPC 传输"。`ArpTab.tsx:57` 拿 path 打开。
  - **真问题在内存侧**：`exportService.ts:28` `exportARPTable` 一次性 `SELECT DISTINCT ... FROM arp_entries GROUP BY ip,mac`（全量）载入内存 + `rows.map(...).join('\n')` 拼成**单个巨型字符串**再写文件。criteria #2「>10000 行 ARP 表不再一次性序列化全量」正指此。
  - **方案**：改**流式分块写 CSV**——分批 `SELECT ... LIMIT ? OFFSET ?`（或游标）逐批读、追加写文件（header 一次 + 每批 append 行），内存峰值恒定（单批大小），消除一次性全量读 + 巨型字符串。
  - **语义不变**：导出语义=导出全部 ARP 数据，**不引入 limit/offset 给调用方**（导出不是 list 查询），返回形态（文件 path）不变。即 export 的"有界"是内存有界，非 payload/语义有界。
- **D-4-6 `getIPDetails` = 保持 JS 端 CIDR 过滤，分页在过滤后数组上做；不把 ipInCIDR 下推 SQL。**
  - **现状**：`networkSegmentService.ts:88` `getIPDetails` 取全量 `ip_status` LEFT JOIN `arp_entries`，再在 JS 端 `.filter(r => ipInCIDR(r.ip, cidr))` 过滤网段，再 `.filter` search 条件，最后 `.map` 拼 vendor。
  - **为何不下推 SQL**：直接给 SQL 加 `LIMIT/OFFSET` 会**截断到 CIDR 过滤之前**（结果错误，分页跨不过滤边界）。正确下推需把 `ipToNumber`/`ipInCIDR` 转为 SQL 表达式或引入数值列——涉及 schema/查询大改 + WR-04 已固化的畸形 CIDR 健壮语义对齐，**风险高、收益低**。
  - **方案**：保持 JS 端过滤；分页/上限应用在**过滤后的结果数组**上（filter → 排序 → `slice(offset, offset+limit)` 或等价）→ 信封包裹（D-4-2）。DB 全量读受 `ip_status` 表真实行数约束（见下）。
  - **⚠️ Researcher 必查（D-4-6 关键前提）**：`ip_status` 表**是否有 TTL / 清理 / 归档机制**？若无界增长（活跃 IP 持续累积从不清理），则 getIPDetails 的"DB 全量读 ip_status 表"成为真问题（全表读随时间膨胀），D-4-6 的"DB 读有界于数据现实"前提不成立，需重新评估（可能需下推 SQL 或加 ip_status 清理，后者越界 → 触发 scope 讨论）。researcher 必须核实并在 RESEARCH.md 给出 ip_status 增长语义结论。

### Claude's Discretion

D-4-5 / D-4-6 为用户委托的 gray area，Claude 按"项目最优"拍板。**下游 researcher/planner 在不违背上述决策与 PROJECT.md 约束的前提下，对纯实现细节有自由度**：
- 信封对象的具体字段集与类型定义位置（`src/types` 新增 `PaginatedResult<T>` 还是各通道内联）
- `validateLimit` 是提取为共享 helper（如 `electron/utils/pagination.ts`）还是各 IPC 文件内镜像——planner 判断重复度
- getIPDetails 过滤后分页的具体实现（slice vs 二次查询 vs 内存裁剪）
- export 流式写 CSV 的分批大小、是否用 better-sqlite3 游标/迭代器、append 写的 fs API 选择
- D-4-6 的 ip_status 增长语义核实后，若需调整方案的回退路径

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 定义与需求
- `.planning/ROADMAP.md` §Phase 4 — 阶段 Goal（大数据 IPC 不再一次性传超大结果集，主进程↔渲染层数据交换有界）/ Depends on Phase 3 / 3 条 Success Criteria（4 通道支持分页参数或上限、>10000 行不再全量序列化、调用方适配无回归）
- `.planning/REQUIREMENTS.md` §Data — **DATA-01**（4 通道大数据 IPC 加分页/默认上限，避免一次性传超大结果集）

### 项目约束（红线）
- `.planning/PROJECT.md` §Constraints — 向后兼容（分页/上限默认值保证旧调用行为不变；加密/迁移兼容历史数据）、Tech stack 不可换核心栈、Build（tsconfig.web.json 严格 + noUnusedLocals 全绿）
- `.planning/PROJECT.md` §Context — 核心价值"拓扑准确呈现与设备安全可控为最高优先级"（D-4-2 不静默藏数据 / D-4-5 export 安全的直接依据）
- `.planning/STATE.md` §Risk Watch — "IPC 分页签名变更需保证旧调用方默认行为不变"（D-4-1 默认向后兼容的红线来源）

### Phase 3 先例（机制复用）
- `.planning/phases/03-performance-optimization/03-CONTEXT.md` — **PERF-01** OUIService.vendorMap 预载已完成（getIPDetails 读路径已 O(1)，本阶段不再动 getVendor）；03-CONTEXT 明确把 `oui:getAll` 分页 defer 到 Phase 4
- `.planning/phases/03-performance-optimization/03-01-SUMMARY.md` / `03-02-SUMMARY.md` — processARPEntries 事务化、getIPDetails 双查修复（本阶段改 getIPDetails 返回信封时不得破坏 PERF-01 的 vendorMap 读路径）

### 现有实现（待改造/复用的活代码 — IPC 网关层）
- `electron/ipc/networkIpc.ts:38-39` — `network:getIPDetails` handler（当前签名 `networkId, searchIp?, searchMac?, sortBy?, sortOrder?`，**无 limit/offset**），D-4-1/D-4-3/D-4-4 改造点
- `electron/ipc/ouiIpc.ts:8` — `oui:getAll` handler（`secure(() => OUIService.getAll())`，**无任何参数**），改造点；同文件 `MAX_BATCH=1000`（写侧 cap）+ `oui:search`(line 9)（读侧分页/过滤已有替代通道）
- `electron/ipc/anomalyIpc.ts:7-11` — **`validateLimit(limit)` 先例**（D-4-4 复用/镜像对象：`Number.isInteger` + `[1,10000]` 钳制，非法回落 100）；`:20-21` `anomaly:getChanges` handler（已有 `limit`，补 `offset`）
- `electron/ipc/exportIpc.ts:6` — `export:arpTable` handler（D-4-5，签名不变，改造在 service 层）

### 现有实现（业务层）
- `electron/services/networkSegmentService.ts:88` — `getIPDetails`（JS 端 CIDR 过滤 + search filter + vendor map，D-4-6 改造对象：过滤后数组分页 + 信封包裹；不得破坏 PERF-01 `OUIService.getVendor` 调用）
- `electron/services/ouiService.ts:57-60` — `getAll`（`SELECT ... FROM oui_database ORDER BY ...` 全量无 limit，D-4-3 默认 5000 + limit/offset + 信封改造对象）
- `electron/services/anomalyService.ts:147-153` — `getChanges(unacknowledgedOnly, limit=100)`（已有 `LIMIT ?`，**无 offset**，D-4-1 补 offset + 信封包裹）
- `electron/services/exportService.ts:28` — `exportARPTable`（全量读 + 拼巨型字符串 + `saveCSV`，D-4-5 流式分块写改造对象）；`:73` `saveCSV`（文件写入 helper，流式 append 可能需扩展）

### 渲染层消费方（信封适配点 — success criteria #3）
- `electron/preload.ts:71-72` — `getIPDetails` 暴露签名（须同步加 limit/offset 参数）
- `electron/preload.ts:75` — `anomaly.getChanges` 暴露签名（须同步加 offset）
- `electron/preload.ts:87` — `oui.getAll` 暴露签名（须同步加 limit/offset）
- `src/components/ip-management/NetworkTab.tsx:31,43` — `api.network.getIPDetails(...)` 消费方（改读 `.rows`）
- `src/components/ip-management/OuiTab.tsx:22` — `api.oui.getAll()` 消费方（改读 `.rows`，配合 `getStats`）
- `src/components/ip-management/AnomalyTab.tsx:29` — `api.anomaly.getChanges()` 消费方（改读 `.rows`）
- `src/components/ip-management/ArpTab.tsx:57` — `api.export.arpTable()` 消费方（D-4-5 签名不变，无需改）

### 架构/集成参照
- `.planning/codebase/ARCHITECTURE.md` — IPC 网关层（`secure(fn)` 鉴权+脱敏）→ 业务 service → 数据层；所有 handler 必须经 `secure()`
- `.planning/codebase/INTEGRATIONS.md` — better-sqlite3 同步 API（`prepare().all/run`）、无 worker thread（D-4-5 流式写在主线程同步进行）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`validateLimit(limit)`**（`anomalyIpc.ts:7-11`）：分页参数校验先例——`Number.isInteger` 判定 + `[min,max]` 钳制 + 非法回落默认值。D-4-4 直接复用或提取为共享 helper，保持 4 通道校验模式一致。
- **`secure(handler)` 中间件**（`electron/utils/authGuard.ts`）：所有 IPC handler 强制经鉴权+脱敏。新增 limit/offset 参数不改变 `secure()` 包装方式。
- **`OUIService.vendorMap`**（PERF-01 已交付）：`getIPDetails` 的 vendor 读路径已是 O(1) 内存 Map。本阶段改 getIPDetails 返回信封时**必须保留** `entry.mac ? getVendor(entry.mac) : 'Unknown'` 逻辑（不得回退到逐行查库）。
- **`getDatabase()` + better-sqlite3 prepared statement**：所有 service DB 访问统一入口；分页 `LIMIT ? OFFSET ?` 直接用 prepared statement 绑定。
- **`oui:search` 通道**（`ouiIpc.ts:9`）：OUI 的过滤/检索已有专用通道，支撑 D-4-3「全量 IEEE 40k 走 search+分页」决策——oui:getAll 默认 5000 不覆盖全量场景由 search 兜底。

### Established Patterns
- **IPC 网关层参数校验**：`networkIpc.ts` 的 `validateSegmentInput`、`anomalyIpc.ts` 的 `validateLimit`/`validateId` 均在 handler 内校验后转发 service——分页参数校验同此模式（网关层校验，service 层用安全值）。
- **静态类 service + `getDatabase()`**：NetworkSegmentService/OUIService/AnomalyService/ExportService 均静态方法，分页改造保持此架构。
- **better-sqlite3 LIMIT/OFFSET**：anomalyService.getChanges 已用 `ORDER BY ... LIMIT ?`——补 `OFFSET ?` 是同模式扩展。
- **Phase 2/3 决策委托 + planner 实现自由度**：本项目既定模式，D-4-5/D-4-6 委托决策 + 实现细节留 planner 裁量与此一致。

### Integration Points
- **`preload.ts` window.api 暴露层**：4 个通道的 renderer 入口签名须同步更新（加 limit/offset 参数），是 IPC 契约的对外窗口。
- **4 个渲染层 Tab 消费方**：信封适配（改读 `.rows`）——本阶段最小适配（让现有渲染不崩 + 读到数据），完整翻页 UI 留 Phase 5。
- **`exportService.saveCSV`**（`exportService.ts:73`）：D-4-5 流式写可能需扩展此 helper 支持 append 模式（或新增流式写函数），保留单次写兼容。

</code_context>

<specifics>
## Specific Ideas

- **D-4-2 信封是安全语义不是体验**：运维工具截断后必须告知（`truncated` + `total`），否则漏看 rogue 设备/IP 违背核心价值。这是本阶段区别于"普通列表分页"的关键——信封不可省。
- **D-4-3 数字的依据**：getIPDetails=2000（/22 覆盖）、oui:getAll=5000（本用户规模）、anomaly=100（现状）——三值均基于"本用户实际数据尺度 + 信封兜底"，非拍脑袋。
- **D-4-5 export 的"有界"在内存不在 payload**：export:arpTable 返 path（payload 极小），问题在主进程一次性全量读+拼巨型字符串。流式分块写把内存峰值从 O(全表) 降到 O(单批)。
- **D-4-6 的隐藏风险 = ip_status 增长**：getIPDetails 全量读 ip_status 表，若该表无清理则随时间膨胀——这是本阶段唯一的"DB 读无界"真隐患，researcher 必查并给结论。
- **anomaly 是半成品基准**：anomaly:getChanges 已有 limit/validateLimit，是本阶段 4 通道中唯一"已部分实现 DATA-01"的，其余 3 个从零补；统一契约以 anomaly 现有模式为基准扩展。

</specifics>

<deferred>
## Deferred Ideas

- **翻页 UI（分页器/加载更多交互）**：本阶段仅暴露 limit/offset 参数 + 截断信封，渲染层做最小适配（读 `.rows`）。完整翻页 UI 属 Phase 5 前端重构。
- **ipInCIDR 下推 SQL / ip_status 数值列**：D-4-6 判定风险高收益低不做。若 researcher 核实 ip_status 无界增长成真问题，再评估（可能触发"ip_status 清理"新需求 → 独立 phase）。
- **cap 用户可配置（设置页暴露）**：D-4-3 option 3 被否（引入配置持久化/UI 复杂度，超 DATA-01 数据安全层 scope）。记入 backlog，未来若有差异化需求再开放。
- **oui:getAll 全量 IEEE 40k 专用优化**：本阶段靠默认 5000 + 既有 `oui:search` + 分页覆盖；若用户实际导入全量 IEEE 并需高频全量浏览，再评估专用通道/虚拟滚动。
- **export 流式写的进度回调**：D-4-5 流式写 CSV 可选加进度通知（大表导出时 UI 反馈），本阶段不做（export 返 path 后由系统打开，无进度需求），留待未来。

</deferred>

---

*Phase: 4-Data / IPC Safety*
*Context gathered: 2026-06-28*
