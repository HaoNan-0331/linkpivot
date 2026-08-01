---
phase: 05-frontend-refactor-types
plan: 01
subsystem: frontend-types
tags: [types, electron.d.ts, refactor, strict-mode]
requires:
  - "Phase 4 pagination.ts PaginatedResult<T>（DATA-01 信封）"
provides:
  - "ElectronAPI 强类型契约（device/topology/ai/network/anomaly/oui/arp/export/scheduler 通道全建模，kb 待 05-04）"
  - "src/types/ai.ts（ChatMessage role 联合类型 / ChatSession / DiscoverResult）"
  - "src/types/oui.ts OUIRow（snake_case DB 行，对齐 ouiService 真实返回）"
  - "electron.d.ts scheduler/arp/export 通道（preload 已暴露但旧契约漏标）"
affects:
  - "FE-01（AIPage）：ChatMessage 联合类型可被 Wave 2 引用"
  - "FE-04（KB）：kb.* 通道建模与 KB DTO 归 05-04"
tech-stack:
  added: []
  patterns:
    - "catch (e:unknown) + instanceof Error 窄化（统一错误处理，全仓库标准）"
    - "缺 DTO 就近补 interface XxxRow 到 src/types/<domain>.ts（D-5-3，不内联 electron.d.ts）"
key-files:
  created:
    - src/types/ai.ts
  modified:
    - src/types/electron.d.ts
    - src/types/oui.ts
    - src/components/ip-management/ArpTab.tsx
    - src/components/ip-management/AnomalyTab.tsx
    - src/components/ip-management/NetworkTab.tsx
    - src/components/ip-management/OuiTab.tsx
    - src/components/pages/SettingsPage.tsx
    - src/components/pages/DevicesPage.tsx
decisions:
  - "OUI IPC 用 OUIRow（snake_case）而非 OUIEntry（camelCase）—— ouiService 未做行映射，旧 OUIEntry 与真实返回不符（Rule 1 bug 修复）"
  - "DiscoverResult.nodes/edges 复用 TopologyNode/TopologyEdge —— DiscoveryPanel.tsx 消费面读为这两个类型，比 plan 原 Record<string,unknown> 更准且不破坏编译"
  - "electron.d.ts re-export ChatMessage/ChatSession —— 维持 AIPage 既有 import 不中断（FE-01 Wave 2 迁移），不触碰 AIPage.tsx"
metrics:
  duration: ~30min
  completed: 2026-07-02
  tasks: 2
  files: 9
---

# Phase 5 Plan 01: FE-02 类型契约 foundation Summary

以 `src/types/electron.d.ts` 建模为锚，复用/补全 src/types DTO，收敛 4 个 IP Tab + SettingsPage + DevicesPage 的 `any`；为 FE-01（AIPage）/FE-04（KB）类型前置依赖奠基。

## What Was Built

### Task 1: electron.d.ts 全建模 + src/types/ai.ts + scheduler/arp/export 通道

- **重写 electron.d.ts**：23 处 `any`/`Promise<any>` 中，除 kb.* 通道（4 处，归 05-04）外全部替换为 src/types 既有 DTO
- **新建 src/types/ai.ts**：`ChatMessage`（role 收 `'user'|'assistant'`）/ `ChatSession` / `DiscoverResult`（nodes/edges 复用 TopologyNode/TopologyEdge）
- **src/types/oui.ts 补 OUIRow**：snake_case DB 行（`oui_prefix`/`vendor_name`/`is_custom`/`created_at`/`updated_at`），对齐 ouiService 真实返回
- **新增 scheduler 通道**：`getConfig`/`updateConfig`/`runNow`/`getStatus`，签名严格对齐 preload.ts:104-109 + schedulerIpc.ts:6-19（无臆造 saveConfig/start/stop）
- **补 arp/export 通道**：preload.ts:59-62/99-103 已暴露但旧 electron.d.ts 漏标，致 ArpTab/NetworkTab/AnomalyTab 旧用 `api:any` 绕过
- **re-export ChatMessage/ChatSession**：维持 AIPage.tsx 既有 `import { ChatMessage } from '@/types/electron'` 不中断

### Task 2: 6 文件 any 清零（issue 4 绝对值验收）

- **4 IP Tab**：`api:any` → `ElectronAPI`；`useState<any*>` → 真实 DTO（ARPEntry/IPMACChange/NetworkSegment/OUIRow/Device/IPMACBinding/ExcludedIP）；Table render `_:any,record:any` → `unknown` + 行 DTO
- **SettingsPage**：删 `(window as any).api` 绕过；scheduler 4 调用改 `window.api.scheduler.*`；`schedulerConfig/Status` 收为 `ScheduleConfig`/`SchedulerStatus`
- **DevicesPage**：4 处 `catch (e:any)` → `catch (e:unknown)` + 窄化
- **统一错误处理**：全仓库 catch 统一 `e instanceof Error ? e.message : String(e)`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] OUI DTO 与 IPC 返回不符：补 OUIRow**
- **Found during:** Task 1
- **Issue:** plan 要求 oui 通道泛型用 `OUIEntry`（camelCase：ouiPrefix/vendorName/isCustom），但 ouiService.getAll/search/getById 直接 SELECT 返回 snake_case 原始 DB 行（ouiService.ts:62/70/75），未做 camelCase 映射。OuiTab.tsx 实读 `record.oui_prefix`/`record.is_custom`。强行用 OUIEntry 会致类型与运行时不符。
- **Fix:** 在 src/types/oui.ts 就近补 `OUIRow`（snake_case），electron.d.ts 的 oui 通道泛型/返回类型改用 OUIRow（D-5-3「缺 DTO 就近补」）。OUIEntry camelCase 保留（domain 概念，未删）。
- **Files:** src/types/oui.ts, src/types/electron.d.ts, src/components/ip-management/OuiTab.tsx
- **Commit:** 8b1430d

**2. [Rule 1 - Bug] DiscoverResult.nodes/edges 类型致 DiscoveryPanel 编译失败**
- **Found during:** Task 1
- **Issue:** plan 指定 DiscoverResult.nodes 为 `Array<Record<string, unknown>>`，但 DiscoveryPanel.tsx:98-99 将其赋给 `TopologyNode[]`/`TopologyEdge[]` state，类型不兼容致编译失败。
- **Fix:** DiscoverResult.nodes/edges 改为复用 src/types/topology 的 `TopologyNode[]`/`TopologyEdge[]`（discovery 主进程侧虽 any[]，但 renderer 消费面 DiscoveryPanel 已视为结构化节点）。比 plan 原方案更准且不破坏 DiscoveryPanel 编译。
- **Files:** src/types/ai.ts
- **Commit:** 8b1430d

**3. [Rule 3 - Blocking] ChatMessage/ChatSession 迁移致 AIPage import 断裂**
- **Found during:** Task 1
- **Issue:** 将 ChatMessage/ChatSession 从 electron.d.ts 迁到 ai.ts 后，AIPage.tsx:4 `import { ChatSession, ChatMessage } from '@/types/electron'` 编译失败。但 AIPage 归 FE-01（plan 红线：FE-02 不触碰 AIPage）。
- **Fix:** electron.d.ts 加 `export type { ChatMessage, ChatSession }` re-export，维持既有 import 不中断；FE-01 Wave 2 迁移导入路径至 @/types/ai。最小侵入、不碰 AIPage.tsx。
- **Files:** src/types/electron.d.ts
- **Commit:** 8b1430d

**4. [Rule 1 - Bug] electron.d.ts 漏标 arp/export 通道**
- **Found during:** Task 2
- **Issue:** ArpTab/NetworkTab/AnomalyTab 用 `api.arp.*`/`api.export.*`，但旧 electron.d.ts 无此二通道（仅 device/topology/ai/kb/network/anomaly/oui/connection/auth）。改 props 为 ElectronAPI 后这些调用编译失败。
- **Fix:** electron.d.ts 补 arp（collectFromDevice/collectFromAll，返回 ARPCollectionResult/ARPBatchResult）+ export（arpTable/changes/networkUsage）通道，对齐 preload.ts:59-62/99-103。同步补 ARPBatchStats/ARPBatchResult/SchedulerRunResult 辅助 interface。
- **Files:** src/types/electron.d.ts
- **Commit:** 8b1430d

**5. [Rule 1 - Bug] oui.getAllVendors 返回 string[]（非 plan 假设的对象数组）**
- **Found during:** Task 1
- **Issue:** plan 注释称 getAllVendors 返回 `Array<{ouiPrefix,vendorName}>`，实际 ouiService.ts:155-156 返回 `string[]`（DISTINCT vendor_name）。
- **Fix:** electron.d.ts getAllVendors 签名收为 `Promise<string[]>`。
- **Files:** src/types/electron.d.ts
- **Commit:** 8b1430d

## Verification

- `npx tsc -p tsconfig.web.json --noEmit` → exit 0（strict + noUnusedLocals + noUnusedParameters 全绿）
- `npx vitest run` → 25/25 测试通过（不回归）
- `npm run build:electron-main` → esbuild 主进程打包成功（1.8mb，不回归）
- electron.d.ts grep `: any|Promise<any>` 残留 = 4，全部在 kb.* 通道块（05-04 接力清零，符合 plan）
- 6 文件 any after 全 0（grep 绝对值，issue 4 验收）
- SettingsPage `(window as any)` = 0；`window.api.scheduler` = 4；`catch (e:unknown)` = 5
- DevicesPage `catch (e:unknown)` = 4

## Known Stubs

无。kb.* 通道 `Promise<any>` 占位是有意为之（归 05-04 建模，非 stub 阻塞本 plan 目标）。

## Self-Check: PASSED

- 9 文件全部 FOUND（src/types/electron.d.ts, src/types/ai.ts, src/types/oui.ts, 4 IP Tab, SettingsPage, DevicesPage）
- 2 commits 全部 FOUND（8b1430d Task1, 5ebfb3a Task2）
- src/types/kb.ts 不存在（正确，KB DTO 归 05-04）

## TDD Gate Compliance

本 plan `type: execute`（非 tdd plan），无 RED/GREEN/REFACTOR 强制门禁。Task 均为 type="auto"，按 verify 块的 tsc+vitest+esbuild 三绿门禁验收，全通过。
