---
phase: 03-performance-optimization
plan: 02
subsystem: database
tags: [performance, caching, sqlite, n-plus-1, cold-start]

requires:
  - phase: 02-architecture-db-migration
    provides: user_version 迁移机制 + getDatabase 单例 + oui_database seed（'00:01:02' 存储格式事实依据）
provides:
  - OUIService 模块级 vendorMap 内存缓存（启动 preload 全量载入，O(1) 查找消除 getIPDetails N+1）
  - 优雅降级回退路径修复（denormalizePrefix 匹配库内 '00:01:02' 存储格式）
  - 5 写方法增量同步 Map（零脏读窗口）
  - getIPDetails 双查 bug 修复（单次调用 + 局部缓存）
  - main.ts 启动序列 OUIService.preload() + performance.now() 冷启动计时日志
affects: [03-performance-optimization (PERF-04 cold-start 证据), 04-data-ipc, getIPDetails/oui:getVendor 调用方]

tech-stack:
  added: []
  patterns:
    - "模块级 static Map 懒加载 + write-through 增量同步（非失效重载，零脏读）"
    - "normalizeMac/denormalizePrefix 对称 helper（Map key 归一化 + 回退查询反归一化匹配存储格式）"
    - "优雅降级：preload 失败 Map=null → 回退查库路径功能不中断（性能优化不得破坏可用性）"

key-files:
  created: []
  modified:
    - electron/services/ouiService.ts
    - electron/services/networkSegmentService.ts
    - electron/main.ts

key-decisions:
  - "D-P1 全量预载内存 Map + 写操作增量同步（非失效重载）：getIPDetails 高频读路径必须零脏读，写点少且 set/delete O(1)"
  - "回退查询经 denormalizePrefix 反归一化匹配库内 '00:01:02' 存储格式（W3 修复 pre-existing bug，T-03-06 升级 mitigate）"
  - "Map 同步用可选链 this.vendorMap?.（Map null 时 no-op，不强制触发预载）"
  - "update 方法 prefix 变更时先取旧 prefix 再 UPDATE，DELETE 旧 Map key + set 新 key（避免脏键残留）"

patterns-established:
  - "Pattern: static service 模块级 Map 缓存 + write-through 增量同步 + 优雅降级回退（D-P1，可复用于其他高频读 service）"
  - "Pattern: 冷启动 performance.now() 计时 + grep 可验证日志行 '[startup] DB+OUI init Xms'（PERF-04 自动化证据范式）"

requirements-completed: [PERF-01]

duration: 12min
completed: 2026-06-28
---

# Phase 3 Plan 02: OUI vendorMap 内存缓存消除 N+1 Summary

**OUIService 增模块级 vendorMap 内存缓存（启动 preload 全量载入）+ getVendor 改读 Map（O(1)）+ 5 写方法增量同步 + 优雅降级回退查询修复（denormalizePrefix 匹配库内存储格式）+ getIPDetails 双查 bug 修复 + main.ts 冷启动 performance.now() 计时。**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- OUI 厂商查询从每次 `prepare().get()` 查库（N+1）降为 O(1) 内存 Map 查找；启动一次性预载
- 优雅降级回退路径 pre-existing bug 修复：`denormalizePrefix` 把归一化 `'000102'` 反归一化为库内 `'00:01:02'`，使 preload 失败时回退查库真正可用（D-P1 红线落实，T-03-06 mitigate）
- getIPDetails 双查 bug 修复（单次调用 + 局部缓存），N+1 不再翻倍（W1）
- 启动序列在 migrateAndSecure 之后、IPC 注册之前调 `OUIService.preload()`，首次 getIPDetails 时 Map 已就绪
- 冷启动 `performance.now()` 计量 initDatabase→migrateAndSecure→preload 耗时，输出 `[startup] DB+OUI init Xms` 日志行（phase goal "冷启动加速" 自动化证据）

## Task Commits

1. **Task 1: OUIService 增 vendorMap + preload + getVendor 读 Map 优雅降级 + 5 写方法增量同步** - `862adc2` (perf)
2. **Task 2: getIPDetails 双查修复 + main.ts 启动插 preload + 冷启动计时** - `70d25d0` (perf)

## Files Created/Modified
- `electron/services/ouiService.ts` — vendorMap 字段 + preload() + normalizeMac/denormalizePrefix helper + getVendor 读 Map 优雅降级 + 5 写方法增量同步
- `electron/services/networkSegmentService.ts` — getIPDetails 单查 getVendor + 局部缓存（双查修复）
- `electron/main.ts` — import OUIService + 启动序列插 OUIService.preload() + performance.now() 冷启动计时日志

## Decisions Made
- D-P1 严格忠实执行：全量预载 + 增量同步（非失效重载）；vendorMap null 时可选链 no-op
- `update` 实现：UPDATE 前取 oldRow（旧 prefix），UPDATE 后用 newRow set 新 key + 若 prefix 变更则 delete 旧 key（最简洁正确的脏键清理）
- `delete`/`deleteBatch`：删除前取 prefix，删除成功后同步 delete Map key

## Deviations from Plan

None - plan executed exactly as written（D-P1 + W1/W3 修订全部忠实落实）。

## Issues Encountered
None

## Self-Check
- tsc `npx tsc -p tsconfig.web.json --noEmit` exit 0 ✓
- esbuild `npm run build:electron-main` exit 0（dist-electron/main.js 1.8mb）✓
- Task 1 全部 8 项 grep checks 通过 ✓
- Task 2 全部 7 项 grep checks（seg 2 + main 5）通过 ✓

## Runtime Verification (Deferred)
better-sqlite3 native binding 编译给 electron ABI 145，plain node v24 ABI 137 不匹配——运行时测试 deferred 到 phase 末 Electron 运行时验证。本 plan 静态验证（tsc + esbuild + grep）为准：
- Map 路径命中正确性：preload 用 normalizeMac 归一化库内 '00:01:02'→'000102' 作 key，getVendor 主路径 normalizeMac(mac) 同样输出 '000102'——两端 key 逐字一致（T-03-07 mitigate）
- 回退路径命中正确性：denormalizePrefix('000102')→'00:01:02' 匹配库列存储格式（T-03-06 mitigate）

## Known Stubs
None — 所有路径均已接入真实数据源（库查询 / 内存 Map），无 placeholder。
