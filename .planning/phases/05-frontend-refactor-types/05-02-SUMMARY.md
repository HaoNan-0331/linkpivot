---
phase: 05-frontend-refactor-types
plan: 02
subsystem: frontend-topology
tags: [react, stale-closure, ref-mirror, topology, fe-03]
requires:
  - "TopologyPage.tsx 现有 ref 先例（saveTimerRef/isLoadingRef，line 24-25）"
  - "src/types/topology.ts TopologyNode/TopologyEdge 类型（ref 类型标注用）"
provides:
  - "stale-closure-free TopologyPage（nodesRef/edgesRef ref-mirror 模式，回调注册稳定）"
affects:
  - "FE-03 Success Criteria #3（回调读最新拓扑值，无 stale closure）满足"
  - "未来 TopologyPage 回调扩展：新增读 nodes/edges 的回调按 ref-mirror 模式（读 ref.current + 去 deps）"
tech-stack:
  added: []
  patterns:
    - "ref-mirror：useEffect 同步 ref.current = state，注册一次但需读最新的回调在调用时读 ref.current（与既有 saveTimerRef/isLoadingRef 同模式）"
    - "stale closure 消除：useCallback deps 去 state，回调注册稳定；setTimeout 闭包读 ref.current 避免捕获过期快照"
key-files:
  created: []
  modified:
    - src/components/pages/TopologyPage.tsx
decisions:
  - "D-5-4 ref-mirror（nodesRef/edgesRef）而非迁 nodes/edges 到 zustand store —— React Flow useNodesState/useEdgesState 基于本地态，外迁触及核心价值「拓扑准确呈现」最高优先级面，风险不抵收益；SC#3「getState」由 ref 满足意图"
  - "handleEditSelectedNode 一并改读 ref.current（plan §8 未列出，但同属读 nodes 的 useCallback，模式一致性收敛）"
  - "函数式更新 setNodes(nds=>...) / setEdges(eds=>...) 不改 —— 本就读最新，无 stale 风险（handleConnect/handleAddDevices/handleDeleteSelected/handleEditConfirm/handleNew/handleDelete/handleImport）"
  - "拓扑持久化语义 byte-for-byte 不变 —— 仅读取路径从闭包变量改为 ref.current，保存触发时机/内容/API 全部不动"
metrics:
  duration: ~10min
  completed: 2026-07-02
  tasks: 2
---

# Phase 5 Plan 02: FE-03 TopologyPage stale closure ref-mirror Summary

TopologyPage 引入 nodesRef/edgesRef ref-mirror（紧邻既有 saveTimerRef/isLoadingRef 同模式），debouncedSave/saveTopology/handleDiscoveryConfirm/handleEditSelectedNode 改读 ref.current，useCallback deps 去裸 nodes/edges 使回调注册稳定——消除 D-5-4 定位的 stale closure 风险面。React Flow useNodesState/useEdgesState 契约不变（D-5-4 红线：未迁 store）。

## What Changed

**单文件改造：`src/components/pages/TopologyPage.tsx`**

1. **新增 ref 声明 + 同步 effect**（line 26-38）：`nodesRef`/`edgesRef` 标注 `TopologyNode[]`/`TopologyEdge[]`（与 useNodesState/useEdgesState 泛型一致），两个 useEffect `nodesRef.current = nodes` / `edgesRef.current = edges`（O(1) 赋值）

2. **saveTopology**（line 74-82）：`nodes.map`/`edges.map` → `nodesRef.current.map`/`edgesRef.current.map`；deps `[currentTopologyId, nodes, edges]` → `[currentTopologyId]`

3. **debouncedSave**（line 84-94）：setTimeout 闭包内同样改读 ref.current（消除 setTimeout 注册与触发间的 stale 快照风险）；deps `[currentTopologyId, nodes, edges]` → `[currentTopologyId]`

4. **handleDiscoveryConfirm**（line 185-210）：合并去重读 `nodesRef.current`/`edgesRef.current`；deps `[nodes, edges, setNodes, setEdges]` → `[setNodes, setEdges]`

5. **handleEditSelectedNode**（line 241-249）：`nodes.find` → `nodesRef.current.find`；deps `[selectedNodeIds, nodes]` → `[selectedNodeIds]`

## 不动的部分（重要）

- `useNodesState`/`useEdgesState` 声明（line 16-17）—— React Flow 契约不变（D-5-4 红线）
- 函数式更新 `setNodes(nds => ...)` / `setEdges(eds => ...)` 的回调（handleConnect/handleAddDevices/handleDeleteSelected/handleEditConfirm/handleNew/handleDelete/handleImport）—— 本就读最新，无 stale 风险
- debouncedSave 触发 effect（line 96-104）仍依赖 nodes/edges 触发自动保存——保存触发时机不变
- `saveTimerRef`/`isLoadingRef`（既有 ref 不动）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] handleEditSelectedNode 一并收敛到 ref-mirror**
- **Found during:** Task 1 改造审查
- **Issue:** plan §8(d) 列出的 deps 含 nodes/edges 的 useCallback 清单（line 70/81/141/198/228/237）遗漏 line 230-237 handleEditSelectedNode（读 `nodes.find`）——同属「读 nodes 的 useCallback」stale 风险面
- **Fix:** 一并改读 `nodesRef.current.find` + deps 去 nodes，保持模式一致性（避免遗漏点成为新 stale 源）
- **Files modified:** src/components/pages/TopologyPage.tsx
- **Commit:** 48c0663

无其他偏差——plan 执行逐字符合（ref 声明位置、同步 effect、改造点、deps 收敛、D-5-4 红线）。

## 验证（三绿 + grep 验收）

- `npx tsc -p tsconfig.web.json --noEmit` exit 0（strict + noUnusedLocals 全绿）
- `npx vitest run` exit 0（4 文件 / 25 测试全过，无回归）
- `npm run build:electron-main` esbuild 不回归（dist-electron/main.js 1.8mb）
- `grep -c "nodesRef\|edgesRef" src/components/pages/TopologyPage.tsx` = **11**（≥6 ✓）
- `grep "nodesRef.current = nodes"` / `"edgesRef.current = edges"` 命中（同步 effect）
- `grep "nodesRef.current.map"` 命中 4 处（saveTopology + debouncedSave 各 2）
- `grep "nodesRef.current.find"` 命中（handleEditSelectedNode）
- 所有 useCallback deps 无裸 nodes/edges（函数式更新除外）
- `useNodesState`/`useEdgesState` 保留（D-5-4 红线：未迁 store）

## 人工 HV（待办 — Task 2 checkpoint:human-verify）

DEP-1 native binding 限制无前端自动化运行时测试（D-5-7），需 Electron 实测。6 项验证（详见 05-02-PLAN.md Task 2）：

1. 拖拽节点后保存（debouncedSave 触发）→ 刷新位置保持
2. 连线后保存 → edge 保持
3. 批量快速拖拽 → 最终位置正确（clearTimeout + ref 协同）
4. 拓扑发现 confirm → 发现结果合并正确（读最新 nodes/edges）
5. toolbar 侧边栏 New/Save/Delete/Import/Export → 读最新拓扑
6. DevTools Console 无 React 警告/报错

**状态：awaiting human-verify**（resume-signal: "approved" 6 项全过，或描述失败项）

## Commits

- `48c0663`: fix(05-02): TopologyPage ref-mirror 消除 stale closure (FE-03)

## Self-Check: PASSED

- FOUND: src/components/pages/TopologyPage.tsx
- FOUND: commit 48c0663 (git log)
- tsc/vitest/esbuild 三绿全过
- ref-mirror 命中 11（≥6 验收线）
- D-5-4 红线守住（useNodesState/useEdgesState 保留，无新 topology data store）
