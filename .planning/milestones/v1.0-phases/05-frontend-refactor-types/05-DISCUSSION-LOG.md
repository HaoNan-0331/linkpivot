# Phase 5: Frontend Refactor & Types - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-02
**Phase:** 5-Frontend Refactor & Types
**Areas discussed:** FE-01 AIPage 拆分策略 / FE-02 any 清理范围 / FE-03 TopologyPage stale closure 修法 / FE-04 ChunkContent 取消机制 / 回归安全网方法论（全部一次性委托）

---

## 委托决议（一次性覆盖全部领域）

本次 discuss 未走逐领域 AskUserQuestion 循环。在 `present_gray_areas` 呈现 4 个 gray area（multiSelect）后，用户选择「Other」并批示：

> **"你直接决定，不偏离项目预期即可"**

即全权委托 Claude 按"项目最优"对全部 4 个 FE 领域 + 方法论问题拍板，与 Phase 2/3/4 的委托模式一致（本次覆盖范围扩大至全部领域）。Claude 基于「代码现状核实 + PROJECT.md 核心价值/约束 + 前期 carry-forward」逐项决策，附代码依据，用户保留 `/gsd-plan-phase` 前审阅/修改权。

---

## FE-01 AIPage 拆分·状态策略

| Option | Description | Selected |
|--------|-------------|----------|
| prop drilling | AIPage 编排层向 4 子组件逐层传 state/handler | |
| **useAIChat 自定义 hook** | **抽 hook 持有全部 page-local state + handler，4 子组件经 typed contract 切片消费** | **✓（Claude 委托拍板）** |
| zustand aiChatStore | 迁 AI 会话态到全局 store，子组件经 selector 消费 | |

**Claude's choice:** useAIChat 自定义 hook
**Rationale:** AI 会话态为 page-local（仅 AI 子树消费），项目现有 store 边界是「跨组件全局态」（authStore app-wide、topologyToolbarStore TopologyPage+Sidebar），引入全局 aiChatStore 污染全局且无收益；prop drilling 的 10+ state 宽 prop 面使子组件难独立测试。hook 契约即类型边界，与 FE-02 协同（AIPage 4 处 any 在提取时顺带收敛）。

---

## FE-02 any 清理·范围与建模

| Option | Description | Selected |
|--------|-------------|----------|
| 仅 6 REQ 文件 | ArpTab/AnomalyTab/NetworkTab/OuiTab/SettingsPage/KnowledgeBasePage | |
| **6 REQ + electron.d.ts + AIPage/DevicesPage** | **electron.d.ts 26 处 Promise<any> 建模（一处修复多处受益，CONCERNS TD-1 优先级#1）+ AIPage（FE-01 顺带）+ DevicesPage** | **✓（Claude 委托拍板）** |
| 含后端 services | ai.ts/device.ts/kbService 等后端 any 一并收 | （显式 milestone 外，排除）|

**Claude's choice:** 6 REQ + electron.d.ts + AIPage + DevicesPage；electron.d.ts 复用 src/types 现有 DTO，缺 DTO 就近补 interface XxxRow
**Rationale:** 不收 electron.d.ts 则 FE-02 半成品（Tab 的 api:any 根因正是 electron.d.ts 未建模）。后端 any 显式 milestone 外（CONCERNS TD-1/TD-2）。验收 grep 基线限定 src/+electron.d.ts（不含后端）。

---

## FE-03 TopologyPage stale closure 修法

| Option | Description | Selected |
|--------|-------------|----------|
| **ref-mirror（nodesRef/edgesRef）** | **保留 useState+useNodesState（React Flow 契约不变），回调调用时读 ref.current** | **✓（Claude 委托拍板）** |
| 迁 zustand topologyStore + getState | nodes/edges 外迁 store，回调 getState 读 | （风险高，触及核心价值，否）|
| 仅修 useCallback 依赖 | 补全 deps | （不解决 setTimeout 闭包 stale，否）|

**Claude's choice:** ref-mirror 模式
**Rationale:** 核实活代码——toolbar store 持回调字段、debouncedSave setTimeout 闭包（TopologyPage.tsx:72-81）、onConnect（:264）为 stale closure 面。React Flow useNodesState 基于本地态，外迁 store 须重接 onNodesChange+订阅重渲染，风险高且触及「拓扑准确呈现」最高优先级，收益（语义等同 ref）不抵风险。SC「store getState」意图由 ref 满足。researcher 定位全部 stale closure 点，planner 套 ref-mirror。

---

## FE-04 ChunkContent 取消与缓存

| Option | Description | Selected |
|--------|-------------|----------|
| **客户端 AbortController + 模块级 LRU + in-flight 去重** | **不改 IPC，AbortController 作结构化取消标志 + 去重** | **✓（Claude 委托拍板）** |
| 让 getImageData 支持 AbortSignal | 跨 preload+main+ipcMain 改 | （同步读不可真中断+Phase4刚稳IPC，否）|

**缓存范围（子决策）：**

| Option | Description | Selected |
|--------|-------------|----------|
| per-instance ref | 每个 ChunkContent 自带缓存 | （随卸载失效，否）|
| **模块级 LRU** | **跨实例 + 存活卸载，keyed by file_path** | **✓** |

**Claude's choice:** 客户端 AbortController + 模块级 LRU + in-flight 去重，不改 IPC
**Rationale:** better-sqlite3 同步 blob 读不可真中断，跨层 IPC signal 改成本高收益低且 Phase 4 刚稳定 IPC 契约。ChunkContent 频繁 re-mount（搜索/编辑/拆分/合并），per-instance 缓存随卸载失效，故模块级 LRU。SC #4 grep 验收（AbortController+abort）由 controller.abort() 满足。

---

## 回归安全网·方法论

| Option | Description | Selected |
|--------|-------------|----------|
| **不引入前端组件测试基建，TEST-2 defer** | **FE-01 以 tsc 绿 + 人工 HV 兜底** | **✓（Claude 委托拍板）** |
| 补 AIPage 冒烟测试 | 引入 @testing-library/react + jsdom 组件测试 | （偏离纯逻辑.ts 单测模式+超scope，否）|

**Claude's choice:** 不引入前端组件测试基建；FE-01 不强制单测；TEST-2 defer
**Rationale:** 核实——jsdom+plugin-react 已装但 vitest env=node、include 仅.ts、未装 @testing-library/react；既有测试（crypto/auth/migrationHelpers/pagination）全是纯逻辑.ts。AIPage 逻辑高度耦合 window.api 异步、无可干净提取纯状态，引入组件测试基建偏离既有模式且超 scope。FE-01 以 tsc 绿 + 人工 HV 兜底，与 P2/P3 模式一致。例外：FE-01 若发现可干净分离纯函数，鼓励补.ts 纯单测（非强制）。

---

## Claude's Discretion

用户全权委托（"你直接决定，不偏离项目预期即可"）。D-5-1~D-5-7 全部为 Claude 委托拍板决策，下游 researcher/planner 在不违背决策语义与 PROJECT.md 约束下对纯实现细节有自由度（见 CONTEXT.md §Claude's Discretion）。

## Deferred Ideas

- 前端组件测试基建（TEST-2）——未来立项时 AIPage 4 子组件交互为首批冒烟候选
- 后端 any 清理 + ai.ts/kbService 拆分（CONCERNS TD-1/TD-2）——后续 milestone
- 翻页 UI（分页器/加载更多）——未来前端增强 phase
- ipInCIDR/ipToNumber 抽共享 util（CONCERNS TD-3）——非当前 scope
- FE-04 缓存 TTL / 进度回调 / 图片失败 fallback 占位——未来增强（fallback 占位 FE-04 可顺带，planner 裁量）
