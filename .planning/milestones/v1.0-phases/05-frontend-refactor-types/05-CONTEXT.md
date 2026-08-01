# Phase 5: Frontend Refactor & Types - Context

**Gathered:** 2026-07-02
**Status:** Ready for planning

<domain>
## Phase Boundary

**纯前端重构**——前端结构清晰（FE-01 AIPage 拆分）、类型严格（FE-02 `any`→`src/types`）、无 stale closure（FE-03 TopologyPage）、无在途请求泄漏（FE-04 ChunkContent 取消+缓存）。**无功能变更、无 IPC 签名变更、无 SQL/迁移改动、无加密改动。**

**改造性质：**
- FE-01：`AIPage.tsx`（399 行 / 16 符号 / 10+ 共享 state）拆分为 `ChatSessionList` / `ChatMessageList` / `ChatInput` / `CommandConfirmModal` 4 个独立子组件文件 + 抽 `useAIChat` 自定义 hook 持有共享态
- FE-02：前端 `any` 收敛为 `src/types` 强类型——6 个 REQ 文件（ArpTab/AnomalyTab/NetworkTab/OuiTab/SettingsPage/KnowledgeBasePage）+ `electron.d.ts`（26 处 `Promise<any>` 建模）+ AIPage（FE-01 顺带）+ DevicesPage
- FE-03：`TopologyPage` stale closure 修法——注册一次的回调（toolbar store 回调 / `debouncedSave` setTimeout 闭包 / React Flow `onConnect`）改读 ref 最新值
- FE-04：`ChunkContent` 图片加载加客户端 `AbortController` + 模块级 LRU 缓存 + in-flight 去重，卸载/切换取消在途请求

**不在本阶段范围（属于其他 phase / milestone 外）：**
- 后端 `any`（`electron/services/*.ts`：ai.ts 23 / device.ts 12 / topology.ts 12 / networkSegmentService.ts 13 / knowledgeBaseService.ts 33 / ouiService.ts 12）→ **显式不在本 milestone scope**（CONCERNS TD-1/TD-2 已界定）
- `src/mock-api.ts`（11 处 any）→ dev-only 浏览器预览模式，保留宽松
- 翻页 UI（分页器/加载更多交互）→ Phase 4 已暴露 limit/offset + 截断信封，翻页 UI 属未来前端增强
- `ai.ts` / `knowledgeBaseService.ts` 后端大文件拆分 → 后续 milestone debt（CONCERNS TD-2）
- 采集/发现句柄泄漏与静默吞错 → Phase 6（ROBUST-01/02）
- 前端组件测试基建（`@testing-library/react` + jsdom 组件测试）→ 见 FE-01 决策与 Deferred

</domain>

<decisions>
## Implementation Decisions

> **决策授权说明：** 用户在本阶段全权委托 Claude 按"项目最优"拍板（原话"你直接决定，不偏离项目预期即可"），与 Phase 2/3/4 的委托模式一致。下方 D-5-1~D-5-7 均为 Claude 基于「代码现状核实 + PROJECT.md 核心价值/约束 + 前期 carry-forward 决策」得出，**用户保留 `/gsd-plan-phase` 前审阅/修改权**。每个决策附代码依据，researcher/planner 在不违背决策语义与 PROJECT.md 约束下对纯实现细节有自由度。

### FE-01 AIPage 拆分·状态策略 — D-5-1

- **D-5-1 拆分结构 = 4 子组件文件 + 1 个 `useAIChat` 自定义 hook，AIPage 退化为薄编排层。**
  - **状态策略 = 自定义 hook（非 prop drilling、非 zustand 全局 store）。** AIPage 的 10+ state（devices/selectedDevices/sessions/currentSessionId/messages/input/loading/configLoading/hasConfig/pendingConfirm）+ 6 handler（loadData/loadSessions/handleNewSession/handleSelectSession/handleDeleteSession/handleSend/handleConfirm）全部为 **page-local**（仅 AI 子树消费，无其他页面/组件读 AI 会话态）。
  - **为何不用 zustand**：项目现有 store（`authStore` 登录态 app-wide、`topologyToolbarStore` TopologyPage+Sidebar 跨组件）的既定边界是「跨组件全局态」。AI 会话态非全局，引入 `aiChatStore` 全局单例无收益且污染全局命名空间，违背既有 store 边界。
  - **为何不用 prop drilling**：10+ state + 6 handler 的宽 prop 面使子组件难独立测试/复用，且 AIPage 编排层退化不彻底。
  - **hook 契约即类型边界**：`useAIChat()` 返回 typed contract（sessions/messages/input/pendingConfirm + handler），4 子组件经切片消费——与 FE-02 协同（hook 返回类型即子组件的强类型边界，AIPage 内 4 处 `any` 在提取时顺带收敛）。
  - **文件归属**：4 子组件 + hook 建议 colocate 于新子目录 `src/components/pages/ai/`（`ChatSessionList.tsx` / `ChatMessageList.tsx` / `ChatInput.tsx` / `CommandConfirmModal.tsx` / `useAIChat.ts`），AIPage.tsx 留在 `src/components/pages/` 作编排。具体目录结构由 planner 裁量，但**子组件须各自独立文件**（success criteria #1 验收点）。

### FE-02 any 清理·范围与建模 — D-5-2 / D-5-3

- **D-5-2 清理范围 = 6 REQ 文件 + `electron.d.ts` + AIPage（FE-01 顺带）+ DevicesPage。**
  - **`electron.d.ts` 必须纳入**：26 处 `Promise<any>` 是 `window.api` 类型契约，所有渲染层调用点的类型安全自此文件流出。CONCERNS TD-1 明示优先级「先收 electron.d.ts（一处修复多处受益）」。**不收 electron.d.ts 则 FE-02 半成品**——4 个 IP Tab 的 `api: any` props 根因正是 electron.d.ts 未建模，要彻底修 Tab props 必须先建模 electron.d.ts。
  - **AIPage（4 处）由 FE-01 拥有**：FE-01 抽 hook 时顺带收敛，FE-02 不重复触碰 AIPage.tsx（避免双 FE 编辑同一文件冲突）。
  - **DevicesPage（4 处）纳入**：electron.d.ts 建模后，DevicesPage 的 `api: any` 收敛变 trivial，顺带清。
  - **明确排除**：后端 `electron/services/*.ts` 的 any（milestone 外，CONCERNS TD-1/TD-2）+ `mock-api.ts`（dev-only）。
- **D-5-3 `electron.d.ts` 建模深度 = 复用 `src/types` 现有 DTO，缺 DTO 的 DB row 就近定义 `interface XxxRow`。**
  - **优先复用**：`src/types/` 已有 `device.ts`/`topology.ts`/`network.ts`/`arp.ts`/`anomaly.ts`/`oui.ts`/`pagination.ts`/`backup.ts`——electron.d.ts 的 handler 返回类型优先引用这些既有 DTO，**不重复发明类型**。
  - **Phase 4 已建 `src/types/pagination.ts`（`PaginatedResult<T>`）**：3 list 通道（getIPDetails/oui:getAll/anomaly:getChanges）已类型标注（04-03 落地），渲染层已读 `.rows`——FE-02 直接复用，Tab 组件的 `rows` 本身仍 `any` 待收（本阶段收）。
  - **缺 DTO 的 DB row**：在对应 `src/types/<domain>.ts` 就近补 `interface XxxRow`（如 kb 图片行、ai 会话/消息行），不在 electron.d.ts 内联。
  - **验收口径**：`tsc -p tsconfig.web.json` 绿（严格 + noUnusedLocals）+ `grep ": any|as any"` 在 **renderer `src/` + `electron.d.ts`** 范围显著收敛。**注意：grep 基线不含后端**（后端 any 不动），verifier 不得用全仓库 276 处总数对比。

### FE-03 TopologyPage stale closure 修法 — D-5-4

- **D-5-4 修法 = ref-mirror 模式（nodesRef/edgesRef），不迁移 nodes/edges 到 zustand。**
  - **stale closure 面已精确定位**（核实活代码）：
    - `topologyToolbarStore`（`src/stores/topologyToolbarStore.ts`）持有回调字段 `onSave/onNew/onDelete/onImport/onExport/onTopologyChange`；TopologyPage 经 effect（`TopologyPage.tsx:143-156`）注册，deps 含 `saveTopology/handleNew/...`（间接依赖 nodes/edges）→ 回调随 nodes/edges 变化重新注册，**但注册与调用间的窗口 + 任何「注册一次」的 handler 仍是 stale closure 风险面**。
    - `debouncedSave`（`TopologyPage.tsx:72-81`）的 `setTimeout` 闭包捕获 `nodes/edges`（当前靠 clearTimeout-on-recreate 维持正确，但模式脆弱、非自明）。
    - React Flow `onConnect={handleConnect}`（`TopologyPage.tsx:264`）等回调若 useCallback deps 不全则 stale。
  - **方案**：保留 `useState` + `useNodesState`/`useEdgesState`（React Flow 契约不变），新增 `nodesRef`/`edgesRef`（effect 同步最新值），所有「注册一次但需读最新拓扑」的回调在**调用时**读 `ref.current` 而非闭包捕获变量。
  - **为何不迁 zustand**：React Flow 的 `useNodesState`/`useEdgesState` 设计基于本地态，外迁 store 须重接 `onNodesChange` + 订阅重渲染，**风险高且触及核心价值「拓扑准确呈现」最高优先级面**，收益（语义等同 ref）不抵风险。SC 措辞「store getState」的**意图**（回调读最新值、非过期闭包）由 ref-mirror 满足。
  - **researcher 必做**：逐一定位 TopologyPage 全部 stale closure 点（toolbar 回调注册 / debouncedSave setTimeout / 全部 React Flow on* 回调 / 任何 `useCallback([…])` deps 不全处），在 RESEARCH.md 给出位点清单；planner 在这些位点套 ref-mirror。具体位点集 = planner 裁量，但**模式锁定为 ref-mirror，不做 store 迁移**。

### FE-04 ChunkContent 取消与缓存 — D-5-5 / D-5-6

- **D-5-5 取消语义 = 客户端 AbortController + 模块级 LRU 缓存 + in-flight 去重，不改 IPC `kb:getImageData` 签名。**
  - **为何不改 IPC**：`kb:getImageData` 主进程侧是 better-sqlite3 同步 blob 读 + base64，**同步调用无法真中断**；让其支持 AbortSignal 须跨 preload+main+ipcMain 改且不可真中断同步读，成本高、收益低，且 Phase 4 刚稳定 IPC 契约（`preload.ts`/`electron.d.ts` 不动）。
  - **AbortController 客户端落地**：每个 `ChunkContent` 的图片加载 effect 创建一个 `AbortController`，cleanup 调 `controller.abort()`（替代现状 `cancelled` 标志位 `KnowledgeBasePage.tsx:37/44`）——结构化取消语义，防卸载后 setState + 配合 in-flight Map 去重。SC #4「grep 到 AbortController + abort 调用」由此满足。
  - **in-flight 去重**：模块级 `Map<file_path, Promise<string>>`，同图并发请求复用同一 Promise（chunk 频繁 re-mount/搜索切换时去重）。
- **D-5-6 缓存范围 = 模块级 LRU（非 per-instance）。**
  - **为何模块级**：ChunkContent 随 chunk 搜索/编辑/拆分/合并频繁 re-mount，per-instance 缓存随卸载失效 → 必然重拉。模块级 LRU（keyed by `file_path`，按 count 或 bytes 有界）跨所有 ChunkContent 实例 + 存活卸载。
  - **落地位置**：新建 `src/components/pages/kb/imageCache.ts`（或 `src/utils/`，planner 裁量），导出 `getImage(path, signal)` 封装「缓存命中 → in-flight 复用 → 否则调 `window.api.kb.getImageData` 并入缓存」。
  - **类型协同**：`ChunkContent` 的 `images: any[]`（`KnowledgeBasePage.tsx:31`）由 FE-02 收为 `KbImage[]`（在 `src/types/` 补 DTO），FE-04 缓存以此类型为 key/value。**FE-02 的 KB 页类型建模须先于/同期于 FE-04**（同文件 KnowledgeBasePage.tsx，planner 须分 wave 避免编辑冲突，见 Integration Points）。

### 回归安全网·方法论 — D-5-7

- **D-5-7 不引入前端组件测试基建；FE-01 不强制补单测；TEST-2 defer。**
  - **核实**：`jsdom`+`@vitejs/plugin-react` 已装，但 `vitest.config.ts` `environment: 'node'`、`include: ['tests/**/*.test.ts']`（仅 .ts）、**未装 `@testing-library/react`**。既有测试（crypto/auth/migrationHelpers/pagination）全是**纯逻辑 .ts**（node env）。
  - **AIPage 逻辑高度耦合 `window.api.ai.*` 异步**，无可干净提取的纯状态逻辑（session/message 增删均直接由 IPC 结果驱动）→ 抽 reducer 单测收益低；引入 `@testing-library/react`+jsdom 组件测试基建**偏离既有「纯逻辑 .ts 单测」模式且超重构 scope**。
  - **结论**：FE-01 拆分以 **`tsc -p tsconfig.web.json` 绿（hook 契约类型正确）+ 人工 HV（AIPage 4 子组件交互冒烟：新建/切换/删除会话、发消息、命令确认）** 为回归网，与 Phase 2/3「DB 逻辑用 typed mock 单测 + 运行时人工 HV」模式一致。TEST-2（CONCERNS 建议补前端冒烟测试）登记 Deferred（见下）。
  - **例外**：若 researcher/planner 在 FE-01 hook 提取中发现**可干净分离的纯函数**（如 pendingConfirm 状态机、消息格式化），鼓励补 `.ts` 纯单测（零基建侵入，与 pagination.test 同模式）——非强制。

### Claude's Discretion

D-5-1~D-5-7 均为用户全权委托的决策。**下游 researcher/planner 在不违背上述决策语义与 PROJECT.md 约束的前提下，对纯实现细节有自由度：**
- FE-01：子组件目录结构（`src/components/pages/ai/` vs 平铺）、hook 内部状态组织（单一 hook vs 拆 useSessions/useMessages）、prop 切片粒度
- FE-02：`interface XxxRow` 的字段精确度、electron.d.ts 是否补 JSDoc、`catch (e: any)` 改 `unknown` 还是具体 Error 型
- FE-03：ref-mirror 的具体实现（单 ref 对象 vs 双 ref）、React Flow 回调 deps 补全清单
- FE-04：LRU 容量阈值（count vs bytes）、缓存失效策略（仅 LRU 淘汰 vs 加 TTL）、`getImage` 的 API 形态
- 文件归属与 wave 划分（见 Integration Points 的共享文件约束）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 定义与需求
- `.planning/ROADMAP.md` §Phase 5 — 阶段 Goal（前端结构清晰、类型严格、无 stale closure 与在途请求泄漏）/ Depends on Phase 4（DATA-01 分页签名稳定后前端按新类型对接）/ 4 条 Success Criteria（AIPage 拆 4 子组件、any→types 收敛、TopologyPage getState 无 stale closure、ChunkContent AbortController+ref 缓存）/ `UI hint: yes`
- `.planning/REQUIREMENTS.md` §Frontend — **FE-01**（AIPage 拆 4 子组件）/ **FE-02**（前端 any→src/types，6 文件）/ **FE-03**（TopologyPage store 回调 getState 消除 stale closure）/ **FE-04**（ChunkContent AbortController + ref 缓存）

### 项目约束（红线）
- `.planning/PROJECT.md` §Constraints — Tech stack 不可换核心栈、Build（`tsconfig.web.json` 严格 + noUnusedLocals 全绿，FE-01/02 验收门禁）
- `.planning/PROJECT.md` §Context — 核心价值「拓扑准确呈现与设备安全可控为最高优先级」（D-5-4 不迁 TopologyPage 到 store、D-5-5 不改 IPC 的直接依据）
- `.planning/STATE.md` §Risk Watch — 「前端 `any` 替换需保证 `tsconfig.web.json` 严格模式 + noUnusedLocals 全绿」（D-5-2/D-5-3 验收红线）

### Phase 4 先例（类型契约复用 — 强相关）
- `.planning/phases/04-data-ipc-safety/04-CONTEXT.md` — **D-4-2 信封 `{rows,total,truncated}`** + Phase 4 已建 `src/types/pagination.ts`（`PaginatedResult<T>`），3 list 通道已类型标注、渲染层已读 `.rows`。FE-02 直接复用此类型；Tab 组件 rows 本身仍 any 待本阶段收
- `.planning/phases/04-data-ipc-safety/04-03-SUMMARY.md` — 渲染层 3 Tab 适配信封（读 .rows）+ electron.d.ts 3 通道类型标注现状（FE-02 建模的起点）

### Codebase 审计（FE-01~04 debt 来源 — 必读）
- `.planning/codebase/CONCERNS.md` §TD-1 — `any` 类型大面积泄漏（276 处 / 37 文件），前端热点文件 + 计数 + fix approach（D-5-2/D-5-3 范围与建模深度的直接依据）
- `.planning/codebase/CONCERNS.md` §TD-2 — AIPage/KnowledgeBasePage/ai.ts/kbService 超大单文件（FE-01 拆分对象 + 后端拆分 milestone 外的界定）
- `.planning/codebase/CONCERNS.md` §TEST-2 — 前端零测试（D-5-7 defer 决策依据）
- `.planning/codebase/CONCERNS.md` §FRAG-2 — `KnowledgeBasePage.tsx:42` 图片加载失败静默（FE-04 顺带改善：缓存层加 fallback 占位）

### 编码规范（前端红线）
- `.planning/codebase/CONVENTIONS.md` §TypeScript Strictness — `tsconfig.web.json` 严格项 + 构建门禁（FE-01/02 必须全绿）；§State Management — Zustand store 既定模式（D-5-1 不用 store 的边界依据）；§Naming/Exports — 组件 PascalCase default 导出、类型 `src/types/<domain>.ts`
- `.planning/codebase/STRUCTURE.md` §Where to Add New Code — 新 React 页面/组件/共享类型/单测路径（FE-01 子组件 + hook、FE-04 缓存模块、FE-02 DTO 的落点）

### 现有实现（待重构的活代码 — 前端）
- `src/components/pages/AIPage.tsx` — FE-01 拆分对象（399 行 / 16 符号，10+ state + 6 handler；line 31 `AIPage`、line 52 `loadData`、line 73 `loadSessions`、line 87 `handleNewSession`、line 96 `handleSelectSession`、line 104 `handleDeleteSession`、line 118 `handleSend`、line 60/61 `(d: any)` 过滤 ssh/telnet 设备）
- `src/components/pages/TopologyPage.tsx` — FE-03 stale closure 修法对象（line 14 `useState<any[]>` topologies、line 16/17 `useNodesState`/`useEdgesState`、line 24/25 `saveTimerRef`/`isLoadingRef`、line 62 `saveTopology`、line 72-81 `debouncedSave` setTimeout 闭包、line 143-156 toolbar 注册 effect、line 264 `onConnect`）
- `src/stores/topologyToolbarStore.ts` — FE-03 toolbar 回调契约（`onSave/onNew/onDelete/onImport/onExport/onTopologyChange` 字段，TopologyPage 注册、Sidebar 消费）
- `src/components/pages/KnowledgeBasePage.tsx` — FE-02（17 处 any）+ FE-04（line 31-86 `ChunkContent`，line 37 `cancelled` 标志位、line 38 `(img: any)`、line 40 `getImageData`、line 42 catch 静默、line 515 渲染）同文件共享
- `src/components/ip-management/{ArpTab,AnomalyTab,NetworkTab,OuiTab}.tsx` — FE-02（any 计数 12/5/8/8，props `api: any`，Phase 4 后读 `.rows`）
- `src/components/pages/SettingsPage.tsx` / `src/components/pages/DevicesPage.tsx` — FE-02（any 8/4）
- `src/types/electron.d.ts` — FE-02 建模对象（26 处 `Promise<any>`，Phase 4 已标 3 list 通道为 PaginatedResult）
- `src/types/{device,topology,network,arp,anomaly,oui,pagination,backup}.ts` — FE-02 复用 DTO 源（缺 DTO 的就近补 `interface XxxRow`）

### 测试基建现状（D-5-7 依据）
- `vitest.config.ts` — `environment: 'node'`、`include: ['tests/**/*.test.ts']`（仅 .ts）
- `package.json` — `jsdom@^29` + `@vitejs/plugin-react@^6` 已装（devDeps），**未装 `@testing-library/react`**
- `tests/unit/{crypto,auth,migrationHelpers,pagination}.test.ts` — 既有纯逻辑 .ts 单测模式（node env）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/types/pagination.ts` `PaginatedResult<T>`**（Phase 4 交付）：FE-02 收 IP Tab 的 list 调用时直接引用，不必新建类型。
- **`src/types/<domain>.ts` 既有 DTO**（device/topology/network/arp/anomaly/oui/backup）：FE-02 建 electron.d.ts 时优先复用，避免重复发明。
- **`src/stores/` Zustand 模式**（`authStore.ts`/`topologyToolbarStore.ts`）：FE-01 决策**不**复用（AI 态 page-local），但 FE-03 ref-mirror 与 toolbar store 的回调注册机制协同（callbacks 读 ref.current）。
- **`tests/unit/pagination.test.ts`**（Phase 4 新增）：FE-01 若抽纯函数单测的范式参照（typed mock window.api、node env、.ts）。

### Established Patterns
- **静态验证三绿门禁**：`tsc -p tsconfig.web.json` + electron main esbuild + `vitest run`——FE-01/02/03/04 全部以此为代码级验收（与 Phase 2/3/4 一致）。
- **委托决策 + planner 实现自由度**：本项目既定模式（P2/P3/P4），D-5-1~D-5-7 全委托与此一致。
- **DEP-1 限制下的验证策略**：前端无自动化运行时测试 → 静态验证 + Electron 人工 HV（FE-01 AIPage 交互、FE-03 拓扑保存/编辑、FE-04 图片加载/切换回填 HV）。
- **组件命名/导出**：PascalCase + default 导出；类型 `src/types/<domain>.ts`；新共享 util 优先 `src/utils/`（当前未建，FE-04 缓存可触发新建或 colocate）。

### Integration Points
- **共享文件（双 FE 共享，planner 须按文件归属分 wave，零编辑冲突）：**
  - `src/components/pages/AIPage.tsx` ← **FE-01 拥有**（拆分 + 收 4 处 any）；FE-02 **不触碰** AIPage（D-5-2：AIPage any 由 FE-01 顺带收）
  - `src/components/pages/KnowledgeBasePage.tsx` ← **FE-02（17 处 any 类型化，含 ChunkContent `images: any[]` → KbImage[]）+ FE-04（ChunkContent 加 AbortController+缓存）同文件**。须同一 plan 串行或严格分 wave（FE-02 类型化先，FE-04 缓存用其类型后），**禁止并行**
- **`electron.d.ts` 为 FE-02 独占 foundation**：建议最先做（类型流出后所有 call site 受益），与 FE-03（TopologyPage 独占文件）、FE-04（KB 独占 ChunkContent）无文件冲突，可同 wave 并行（FE-01 依赖 electron.d.ts 的 ai 通道类型，宜在 electron.d.ts 之后或同期）。
- **新文件落点**：FE-01 → `src/components/pages/ai/`（4 子组件 + `useAIChat.ts`）；FE-04 → `src/components/pages/kb/imageCache.ts` 或 `src/utils/imageCache.ts`。

</code_context>

<specifics>
## Specific Ideas

- **D-5-1 hook 契约 = 类型边界**：FE-01 抽 `useAIChat` 与 FE-02 收 AIPage any 是同一动作的两面——hook 返回 typed contract 后，4 子组件 props 即强类型，AIPage 内 `(d: any)` 等顺带消失。researcher/planner 应把 FE-01 的拆分与 FE-02 的 AIPage 部分作为**一个连贯工作单元**，而非两次独立改 AIPage.tsx。
- **D-5-2 grep 基线不含后端**：CONCERNS TD-1 全仓库 276 处 any 含大量后端；本阶段不动后端，故验收 grep 须限定 `src/` + `src/types/electron.d.ts`，verifier 不得用 276 总数对比。
- **D-5-4 SC 措辞与现状不符**：SC #3 字面「store getState」，但 TopologyPage 现用 `useState`+`useNodesState`（非 store），仅 toolbar 用 zustand。ref-mirror 是对 SC **意图**（回调读最新值）的忠实实现；若 researcher 发现 SC 字面意图实指「toolbar store 回调改读 store.getState()」，则 FE-03 额外含 toolbar store 的 getState 读路径——planner 在不违背「不迁 nodes/edges 到 store」红线下裁量。
- **D-5-5「AbortController」客户端语义**：better-sqlite3 同步读不可真中断，故 AbortController 在本阶段落地为「结构化取消标志 + in-flight 去重 + 卸载防 setState」，非「真中断主进程 IO」。SC #4 grep 验收点（AbortController + abort 调用）由客户端 controller.abort() 满足。
- **D-5-7 与项目预期对齐**：既有测试全是纯逻辑 .ts（node env），FE-01 无可干净提取的纯逻辑 → 不强制单测、defer TEST-2 是「不偏离项目预期」的体现，非偷懒。

</specifics>

<deferred>
## Deferred Ideas

- **前端组件测试基建（TEST-2）**：CONCERNS 建议补 AIPage 冒烟测试（vitest + @testing-library/react）。本阶段不引入（偏离纯逻辑 .ts 单测模式 + 超 scope，D-5-7）。FE-01 以 tsc 绿 + 人工 HV 兜底。未来若立项前端测试基建，AIPage 4 子组件交互（新建/切换/删除会话、发消息、命令确认）为首批冒烟候选。
- **后端 `any` 清理 + ai.ts/kbService 拆分**：CONCERNS TD-1 后端热点（ai.ts 23 / device.ts 12 / topology.ts 12 / networkSegmentService.ts 13 / kbService 33 / ouiService 12）+ TD-2 ai.ts 拆 `ai/config.ts`/`ai/executor.ts`/`ai/chat.ts`、kbService 拆分。显式 milestone 外，后续 milestone 处理。
- **翻页 UI**：Phase 4 已暴露 limit/offset + 截断信封，完整翻页 UI（分页器/加载更多）属未来前端增强 phase。
- **`ipInCIDR`/`ipToNumber` 重复两份抽 `electron/utils/ipMath.ts`**（CONCERNS TD-3）：非当前 scope。
- **FE-04 缓存 TTL / 进度回调 / 图片失败 fallback 占位**：FRAG-2 建议 KB 图片失败显示占位符——FE-04 实现时可顺带（planner 裁量），TTL 与进度回调属未来增强。

</deferred>

---

*Phase: 5-Frontend Refactor & Types*
*Context gathered: 2026-07-02*
</content>
</invoke>
