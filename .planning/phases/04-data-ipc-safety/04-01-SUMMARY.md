---
phase: 04-data-ipc-safety
plan: 01
subsystem: ipc-data-safety
tags: [pagination, ipc, security, data-safety, backwards-compat]
requires:
  - "Phase 3 PERF-01 OUIService.vendorMap 预载（getIPDetails 读路径 O(1)）"
provides:
  - "PaginatedResult<T> 信封类型（renderer+main 共用）"
  - "validateLimit/validateOffset 共享校验 helper（electron/utils/pagination.ts）"
  - "network:getIPDetails / oui:getAll / anomaly:getChanges 三通道 hybrid 分页契约"
affects:
  - "electron/preload.ts（三通道签名加 limit/offset）"
  - "Phase 5 前端重构（翻页 UI 接 limit/offset）"
  - "04-03 渲染层 Tab 适配信封（读 .rows）"
tech-stack:
  added: []
  patterns:
    - "IPC 网关层校验 limit/offset → service 层只接收安全值（不信 renderer）"
    - "list 通道返回 PaginatedResult 信封 { rows, total, truncated } 明确告知截断"
    - "SQL prepared statement 绑定 LIMIT ? OFFSET ?（防 SQL 注入）"
    - "JS 端 CIDR 过滤后数组分页（D-4-6 不下推 SQL）"
key-files:
  created:
    - src/types/pagination.ts
    - electron/utils/pagination.ts
    - tests/unit/pagination.test.ts
  modified:
    - electron/services/networkSegmentService.ts
    - electron/services/ouiService.ts
    - electron/services/anomalyService.ts
    - electron/ipc/networkIpc.ts
    - electron/ipc/ouiIpc.ts
    - electron/ipc/anomalyIpc.ts
    - electron/preload.ts
decisions:
  - "D-4-1 hybrid 契约：默认防御性 cap + 暴露 limit/offset 参数"
  - "D-4-2 信封 { rows, total, truncated }：运维不静默漏看 rogue 设备/IP"
  - "D-4-3 默认 cap 差异化：getIPDetails 2000 / oui 5000 / anomaly 100"
  - "D-4-4 硬上限：getIPDetails/oui 50000 / anomaly 10000，超界落回默认非钳制"
  - "D-4-6 getIPDetails 保留 JS 端 CIDR 过滤，分页在过滤后数组，不下推 SQL"
metrics:
  duration: ~7min
  completed: 2026-06-28
  tasks: 3
  files: 10
---

# Phase 4 Plan 01: 3 list 通道 hybrid 分页契约 Summary

为 `network:getIPDetails` / `oui:getAll` / `anomaly:getChanges` 三通道落地 hybrid 分页契约：IPC 网关层校验 limit/offset → service 层应用默认 cap + 硬上限 + 截断信封 `{ rows, total, truncated }`，preload 同步暴露 limit/offset 签名（向后兼容，旧调用零改动）。

## What Was Built

### 共享契约（Task 1，TDD RED→GREEN）
- **`src/types/pagination.ts`**：`PaginatedResult<T>` 信封类型（`rows` / `total` / `truncated`）。字段口径：`total` = 应用 search/filter 后、应用 limit 前的总数；`truncated` = `rows.length < total`。
- **`electron/utils/pagination.ts`**：`validateLimit(limit, defaultValue, maxCeiling)` + `validateOffset(offset)` 共享纯函数。校验模式复用 anomalyIpc.ts:7-11 既有先例：`Number.isInteger` + 范围校验 + **超界/非法落回默认值（非钳到 ceiling）**。
- **`tests/unit/pagination.test.ts`**：13 个单测覆盖全部 behavior 用例（默认值透传/合法透传/超硬上限/下溢/非整数/非数字/边界值）。

### getIPDetails 信封分页（Task 2，D-4-6）
- `networkSegmentService.getIPDetails` 签名加 `limit=2000, offset=0`，返回 `PaginatedResult<any>`。
- **D-4-6**：保持 SQL 全量读 + JS `ipInCIDR` 过滤 + searchIp/searchMac 过滤逻辑不变；分页在过滤后数组上 `slice(offset, offset+limit)`。
- **PERF-01 红线保留**：`mapped = rows.map(entry => OUIService.getVendor(entry.mac))` 读路径未退化为逐行查库（vendorMap 预载 O(1)）。
- `total` = mapped.length（过滤后总数），`truncated` = pageRows.length < total。

### oui:getAll SQL 下推分页（Task 2）
- `ouiService.getAll(limit=5000, offset=0)` 返回 `PaginatedResult<any>`。
- SQL `SELECT ... ORDER BY vendor_name, oui_prefix LIMIT ? OFFSET ?`（prepared statement 绑定，T-04-02 防 SQL 注入）。
- `total` 单独 `SELECT COUNT(*) as c FROM oui_database`（未应用 limit 全表计数）。

### anomaly:getChanges 补 offset + 信封（Task 3）
- `anomalyService.getChanges(unacknowledgedOnly=false, limit=100, offset=0)` 返回 `PaginatedResult<any>`。
- SQL 加 `OFFSET ?`：`ORDER BY detected_at DESC LIMIT ? OFFSET ?`（prepared statement 绑定）。
- `total` 单独 `COUNT(*)` 查询（带相同 `WHERE acknowledged = 0` 条件）。保留现有 `.map(row => ({ ...row, acknowledged: row.acknowledged === 1 }))`。

### IPC 网关校验 + preload 签名同步（Task 2/3）
- `networkIpc.ts`：`validateLimit(limit, 2000, 50000)` + `validateOffset(offset)` 网关校验后转发 service。
- `ouiIpc.ts`：`OUIService.getAll(validateLimit(limit, 5000, 50000), validateOffset(offset))`。
- `anomalyIpc.ts`：删除本地 `validateLimit`，改 import 共享 helper；handler `validateLimit(limit, 100, 10000)` + `validateOffset(offset)`（维持默认 100/硬上限 10000）。
- `preload.ts`：三通道签名加 `limit?/offset?` 可选参数（向后兼容，旧调用方零改动编译通过，默认 undefined → 网关层落回默认 cap）。

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| 超界落回默认而非钳到 ceiling | 与 anomalyIpc.ts:7-11 既有 validateLimit 先例行为统一；默认值本身已是安全有界值 |
| total = 过滤后应用 limit 前的总数 | 运维需知道"符合条件共多少"以判断是否需翻页，而非"全表多少"或"已返回多少" |
| preload 新参数可选（undefined） | STATE.md Risk Watch 红线：旧调用方默认行为不变，渲染层适配归 04-03 |

## Verification Results

| Check | Result |
|-------|--------|
| `npx tsc -p tsconfig.web.json --noEmit` | exit 0（严格 + noUnusedLocals 绿） |
| `npx esbuild electron/main.ts --bundle ...` | exit 0（electron main 打包绿） |
| `npx vitest run` | 4 files / 25 tests 全绿（含新增 13 个 pagination 单测） |
| getIPDetails 返回 PaginatedResult | grep 命中（networkSegmentService.ts:97） |
| ouiService `LIMIT ? OFFSET ?` | grep 命中（ouiService.ts:62） |
| networkIpc `validateLimit(limit, 2000, 50000)` | grep 命中（networkIpc.ts:41） |
| ouiIpc `validateLimit(limit, 5000, 50000)` | grep 命中（ouiIpc.ts:11） |
| OUIService.getVendor 保留（PERF-01 不回归） | grep 命中（networkSegmentService.ts:118） |
| anomalyService `OFFSET ?` | grep 命中（anomalyService.ts:157） |
| anomalyIpc 本地 validateLimit 已删 | grep -c 返回 0 |
| anomalyIpc 共享 import | grep 命中（anomalyIpc.ts:4） |
| preload offset 出现 ≥3 处 | grep -c 返回 4 |
| anomalyIpc `validateLimit(limit, 100, 10000)` | grep 命中（anomalyIpc.ts:17） |

## TDD Gate Compliance

Task 1 为 `tdd="true"`，gate 序列验证通过：
1. **RED**：`test(04-01)` commit `2c3963f`（failing test，模块未创建，vitest 报 Cannot find module）
2. **GREEN**：`feat(04-01)` commit `7b02d7d`（实现共享类型 + helper，13 单测全转绿）

RED 未出现"测试意外通过"（fail-fast 规则遵守），GREEN 后无 REFACTOR 必要。

## Deviations from Plan

None — plan executed exactly as written. D-4-1~D-4-4 + D-4-6 全部按 CONTEXT.md 锁定决策逐字落地，未 re-litigate。

## ip_status 无物理 purge 的 trade-off（T-04-04，accept）

**已核实**：`ipStatusService.ts` endCollection 仅有软标记 `status='deprecated'`（last_seen 过期行），**无物理 DELETE/purge**，故 `ip_status` 表随活跃 IP 累积**单调增长**。

**对 D-4-6 的影响**：
- D-4-6 的 JS 过滤 + slice 限定了 **IPC payload**（信封有界，单次 ≤50000 行硬上限，默认 ≤2000）—— DATA-01 的核心目标达成。
- 但**未限定 DB 全表读**：`getIPDetails` 仍 `SELECT ... FROM ip_status ips LEFT JOIN arp_entries ...` 全量读后 JS 过滤。随 ip_status 表随时间膨胀，该全表读的内存/CPU 成本会随之增长。

**处置 = accept（T-04-04）**：
- 物理清理 ip_status 属独立需求，**越界 DATA-01 数据安全层 scope**（属"数据生命周期管理"，非"IPC payload 有界"）。
- 本 plan 不静默假设 ip_status 有界——此 trade-off 显式记录，未来若 ip_status 增长成真性能问题，再评估独立 phase（物理清理 / ipInCIDR 下推 SQL + ip_status 数值列）。

**这是已知接受的 trade-off，非 bug，非遗漏。**

## Known Stubs

无。三通道返回真实数据（信封包裹真实查询结果），无占位/TODO/空数据流。

## Threat Flags

无新增威胁面超出 plan threat_model（T-04-01~T-04-04 已在 plan 登记并按 disposition 处置）。SQL LIMIT/OFFSET 全部用 prepared statement `?` 绑定（T-04-02 mitigate），limit/offset 全部经网关层校验（T-04-01 mitigate），信封明确告知截断（T-04-03 mitigate），ip_status 全表读膨胀已 accept 并记录（T-04-04 accept）。

## Success Criteria Mapping

- **DATA-01 SC #1（部分）**：`network:getIPDetails` / `oui:getAll` / `anomaly:getChanges` 三通道均可 grep 到 limit/offset 参数。第 4 通道 `export:arpTable` 归 04-02（payload 是文件 path，改造在内存侧流式写）。
- **DATA-01 SC #3（部分）**：preload 签名变更向后兼容（新参数可选，旧调用编译通过 + 默认行为有界）。渲染层读 `.rows` 适配归 04-03。
- **D-4-1~D-4-4 + D-4-6 全部落地**：见 Verification Results。

---

*Plan executed: 2026-06-28*
*TDD: Task 1 RED→GREEN gate 合规*
*Verification: tsc + esbuild + vitest 三绿*

## Self-Check: PASSED

- 所有 10 个 key-files（created/modified）+ SUMMARY.md 均存在（FOUND）
- 4 个 per-task commit（2c3963f RED / 7b02d7d GREEN / 8fd1b04 / 6371820）均存在于 git log（FOUND）
