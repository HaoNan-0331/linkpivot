---
phase: 04-data-ipc-safety
plan: 02
subsystem: data-ipc-safety
tags: [export, csv, streaming, memory, arp]
requires:
  - "Phase 1 BUILD-01 可复现构建基线"
  - "better-sqlite3 同步 prepared statement API"
provides:
  - "流式分块写 CSV 的 exportARPTable（内存峰值 O(单批 1000 行) 非 O(全表)）"
  - "DATA-01 success criteria #2：>10000 行 ARP 表不再一次性序列化全量"
affects:
  - "electron/services/exportService.ts（exportARPTable 重写；saveCSV 保留不动）"
tech-stack:
  added: []
  patterns:
    - "流式分块写：header+BOM 一次 writeFile + 循环 LIMIT/OFFSET 分批 SELECT + appendFile"
    - "导出语义有界在内存侧（O(单批)）非 IPC payload/语义侧"
key-files:
  created: []
  modified:
    - electron/services/exportService.ts
decisions:
  - "D-4-5 落地：exportARPTable 流式分块写，IPC 签名/返回形态（文件 path）不变，不暴露 limit/offset 给调用方"
  - "ARP_BATCH_SIZE=1000：单批字符串几十 KB，内存峰值恒定"
  - "复用既有 dialog 询问路径（内联于本方法）+ 既有 csvEscape + 既有 UTF-8 BOM 字面量，保证 CSV 内容逐行等价"
  - "saveCSV 保留不动（exportChanges/exportNetworkUsage 仍用单次写路径，不在本 plan scope）"
metrics:
  duration: "~2min"
  tasks: 1
  files: 1
  completed: "2026-06-28"
---

# Phase 4 Plan 02: exportARPTable 流式分块写 CSV Summary

将 `ExportService.exportARPTable` 从「一次性全量 SELECT + join 单巨型字符串 + 一次 writeFile」重构为「先问保存路径 → header+BOM 写一次 → 分批 `SELECT DISTINCT ... GROUP BY ip,mac ORDER BY ip LIMIT ? OFFSET ?` 逐批 append」，主进程内存峰值从 O(全表) 降到 O(单批 1000 行)。

## What Was Built

**`electron/services/exportService.ts`（exportARPTable 重写，单文件改造）：**

1. 新增 `import { appendFile, writeFile }` from `fs/promises`（原仅 writeFile）。
2. 新增常量 `ARP_BATCH_SIZE = 1000`（文件顶部）。
3. `exportARPTable` 改为流式分块写：
   - **空表检查**：`SELECT COUNT(*) as c FROM arp_entries`，`c === 0` 抛 `'没有 ARP 数据可导出'`（保持原错误语义）。
   - **先问路径**：内联 `dialog.showSaveDialog`（与 `saveCSV` 同 title/defaultPath 模式/filters），canceled 返回 null。
   - **写 header 一次**：`writeFile(filePath, '﻿' + 'IP地址,MAC地址,VLAN,接口,最后采集时间' + '\n', 'utf-8')`——BOM 字面量与原 `saveCSV` line 80 完全一致（Excel 正确识别中文表头）。
   - **分批流式读 + append**：prepared statement `SELECT DISTINCT ip, mac, vlan, interface, MAX(collected_at) as collected_at FROM arp_entries GROUP BY ip, mac ORDER BY ip LIMIT ? OFFSET ?`，循环 `stmt.all(ARP_BATCH_SIZE, offset)`，每批 `batch.map(row => [...].map(csvEscape).join(',')).join('\n') + '\n'` → `appendFile`，`offset += ARP_BATCH_SIZE`，直到批为空。
   - **返回** filePath（形态不变）。
4. `csvEscape`（line 22-25）原样复用——每行字段转义逻辑不变，CSV 内容等价。
5. `saveCSV`（line 73）**保留不动**——exportChanges/exportNetworkUsage 仍用单次写路径，不在本 plan scope。

## Key Decisions

- **D-4-5 落地**：export 的「有界」在主进程内存侧（O(单批 1000 行) 非 O(全表)），非 IPC payload/语义侧。payload 本身是文件 path（极小），真问题是内存侧一次性全量读 + 拼巨型字符串。
- **导出语义不变**：导出全部 ARP 数据，不引入 limit/offset 给调用方（导出不是 list 查询），返回形态（文件 path）不变。`export:arpTable` IPC handler + `exportARPTable()` 签名零改动，`ArpTab.tsx:57` 零改动。
- **ARP_BATCH_SIZE=1000**：单批字符串 ~几十 KB，内存峰值恒定，满足 ROADMAP criteria #2「>10000 行不再一次性序列化全量」。
- **SQL 等价性**：分批查询用与原全量**完全相同的 SELECT/GROUP BY/ORDER BY** + `LIMIT ? OFFSET ?`，保证分批拼接后结果集逐行等价（OFFSET 跨批边界正确）。每批 chunk 末尾 + header 都加 `\n`，行分隔符一致。

## Verification

- `npx tsc -p tsconfig.web.json --noEmit` → **TSC_OK**（严格 + noUnusedLocals 绿）
- `npx esbuild electron/main.ts --bundle --platform=node --format=cjs ...` → **ESBUILD_OK**（electron main 打包绿）
- `npx vitest run` → **4 files / 25 tests passed**（无回归）
- `grep -n "appendFile" exportService.ts` → 命中（line 2/59）
- `grep -n "LIMIT ? OFFSET ?" exportService.ts` → 命中（line 53）
- `grep -n "ARP_BATCH_SIZE" exportService.ts` → 命中（line 6/56/60）
- 旧全量 join 模式已移出 exportARPTable（仍仅存于 saveCSV 内部，供 exportChanges/exportNetworkUsage）
- exportIpc.ts / ArpTab.tsx 未修改（签名/返回形态不变）

## Deviations from Plan

None - plan executed exactly as written.

## Threat Model

- **T-04-05 (DoS - 一次性全量读+巨型字符串致主进程内存爆)** — **mitigate 已落地**：分批 LIMIT/OFFSET + append 写，内存峰值 O(单批 1000 行) 非 O(全表)。
- **T-04-06 (Tampering - path traversal)** — **accept**：filePath 由 `dialog.showSaveDialog` 用户交互选定（沿用既有 saveCSV 安全语义），非 renderer/caller 直接传入，本 plan 不引入新路径来源。
- **T-04-07 (Tampering - CSV formula injection)** — **accept**：沿用既有 csvEscape（RFC4180 转义），本 plan 不改变转义语义；CSV 注入属桌面工具本地导出低风险面，不在 DATA-01 scope 扩展。

## Known Stubs

无。

## Self-Check: PASSED

- `electron/services/exportService.ts` — FOUND（修改后文件存在）
- `.planning/phases/04-data-ipc-safety/04-02-SUMMARY.md` — FOUND
- commit `db1d61d` — FOUND（`git log` 确认）
