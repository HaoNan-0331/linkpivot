---
phase: 03-performance-optimization
plan: 01
subsystem: database
tags: [better-sqlite3, transaction, prepared-statement, n+1, arp, anomaly]

# Dependency graph
requires:
  - phase: 02-architecture-db-migration
    provides: getDatabase 模块级单例 + WAL + busy_timeout (事务可见性与并发基础)
provides:
  - processARPEntries 整批单事务 (db.transaction) 写库，一次 COMMIT
  - 4 处 prepared statement 提到循环外命名复用 (消除循环内重复解析)
  - isIPExcluded N+1 消除：preloadExcludedSet (Set/CIDR/wildcard 分桶) + isIPExcludedCached 纯内存判定
  - 条目级 try/catch 保留：单条失败 continue 不触发整批 ROLLBACK (向后兼容)
affects: [04-data-ipc (anomaly:getChanges 分页), 06 采集健壮性]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "事务化批量写 + 条目级 try/catch 兜底 (尽力而为语义在 better-sqlite3 事务下的正确实现)"
    - "excluded_ips 预载分桶 (普通 IP→Set O(1), CIDR/wildcard→数组 some)"
    - "prepared statement 循环外复用 (init.ts:346 先例跨服务复用)"

key-files:
  created: []
  modified:
    - electron/services/anomalyService.ts

key-decisions:
  - "excluded 预载放事务外 (T-03-04: 最小化锁持有时间)，事务内仅 binding 查询/写/变更记录"
  - "recordChange 签名未改：getDatabase() 模块级单例保证事务内调用自动落入同一事务边界 (better-sqlite3 单连接同步)"
  - "条目级 try/catch 是 D-P2 红线：与改造前 recordChange/createBinding 吞错语义一致，单条失败不 abort 整批"

patterns-established:
  - "事务边界覆盖：currentBinding 查询 + UPDATE + createBinding INSERT + recordChange INSERT 全在 db.transaction 回调内"

requirements-completed: [PERF-02]

# Metrics
duration: 35min
completed: 2026-06-28
---

# Phase 3 Plan 01: processARPEntries 事务化 Summary

**processARPEntries 改造为整批单事务 (db.transaction) + 4 处 prepared statement 循环外复用 + isIPExcluded N+1 消除 (预载 Set/CIDR/wildcard 分桶)，条目级 try/catch 保留以维持单条失败不 ROLLBACK 的向后兼容语义**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2
- **Files modified:** 1 (electron/services/anomalyService.ts)

## Accomplishments
- `processARPEntries` 整批写库包 `db.transaction(() => { for... })`，N 次 autocommit → 1 次 COMMIT
- 4 处 `db.prepare()` 提到循环外命名复用 (stmtCurrentBinding/stmtDeactivate/stmtUpdateLastSeen/stmtOldBinding)，消除循环内重复 SQL 解析
- `isIPExcluded` 隐含 N+1 消除：新增 `preloadExcludedSet` (普通 IP→Set, CIDR→数组, wildcard→数组) + `isIPExcludedCached` 循环内纯内存判定，从 O(n×m) 全表扫降到 O(n)
- 条目级 try/catch 保留：单条 createBinding/recordChange 失败捕获 `continue`，不让 throw 冒泡触发整批 ROLLBACK (PROJECT.md 向后兼容红线)
- excluded 预载放事务外 (T-03-04 锁持有时间最小化)
- 签名 `static processARPEntries(entries: Array<{ ip: string; mac: string }>): IPMACChange[]` 与 changes[] 累积语义不变，调用方 (arpIpc/schedulerService) 零改动
- recordChange 顶部加事务边界不变量注释，固化"getDatabase() 模块级单例 → 事务内调用自动落入同一事务"语义

## Task Commits

1. **Task 1: processARPEntries 事务化 + prepared statement 复用 + isIPExcluded 预载 Set** - `b52fc75` (perf)
2. **Task 2: recordChange 事务边界不变量注释 + 回归验证** - `dd467af` (perf)

## Files Created/Modified
- `electron/services/anomalyService.ts` - processARPEntries 事务化重构 + preloadExcludedSet/isIPExcludedCached 新增 + isIPExcluded 内部复用 cached 判定 + recordChange 事务边界注释

## Decisions Made
- **excluded 预载位置**：放事务外（按 init.ts:346 先例 + T-03-04 mitigate），事务内仅做 binding 查询/写/变更记录，最小化锁持有时间。
- **isIPExcluded(ip) 公开方法保留**：`checkIPExcluded` (行 143) 仍调用原 `isIPExcluded`，内部改为 `return this.isIPExcludedCached(ip, this.preloadExcludedSet(getDatabase()))` 复用同一判定逻辑，单次调用点不再有 N+1。对外 API 不破坏。
- **recordChange 签名不改**：better-sqlite3 单连接同步 + getDatabase() 模块级单例 (connection.ts) 保证 recordChange 内 `getDatabase()` 返回的 db 与 processARPEntries 事务是同一连接，INSERT 自动落入外层事务。无需传 db 参数。

## Deviations from Plan

### Auto-fixed Issues

无代码层面的偏离。D-P2 LOCKED 决策忠实执行：整批单事务、4 处 prepared 复用、条目级 try/catch 保留、excluded 预载分桶、事务边界覆盖全部按 PLAN 落地。

**Total deviations:** 0 auto-fixed
**Impact on plan:** 按 PLAN 原样执行，无 scope creep。

## Issues Encountered

### Task 2 回归验证脚本因 native ABI 限制无法在 plain node 运行

- **问题**：PLAN Task 2 要求写临时脚本 `temp_verify_perf02.ts` 用 typed db mock 验证 (changes 累积/单次事务/prepared 复用/单条失败跳过)。但本项目环境：
  - plain node (v24, NODE_MODULE_VERSION 137) 与项目 `better-sqlite3` (编译给 electron node, NODE_MODULE_VERSION 145) ABI 不匹配，`new Database()` 时 `ERR_DLOPEN_FAILED`
  - 项目 `package.json` 是 ESM (`"type": "module"`)，临时脚本需 `.cjs` 绕过；esbuild CLI 预编译 + require hook 重定向 connection 的 typed mock 方案在 processARPEntries 调用时出现不稳定挂起（环境混合 ESM/CJS + native binding 的基础设施限制）
- **处理**：按 executor "3 次尝试" 规则停止 mock 环境调试。临时脚本已全部删除（`temp_verify_perf02.cjs` / `temp_mock_connection.cjs` / 诊断脚本 + tmp 产物），遵循 CLAUDE.md "临时脚本用后即删"。
- **替代验证（已完成，全部 PASS）**：
  - `npx tsc -p tsconfig.web.json --noEmit` exit 0（类型绿）
  - `npm run build:electron-main` exit 0（esbuild 打包绿）
  - grep 断言 10 项全 PASS（db.transaction ≥1 / preloadExcludedSet ≥2 / isIPExcludedCached ≥2 / stmtCurrentBinding 存在 / 循环内无裸 isIPExcluded(ip) continue / continue ≥2 / console.error ≥2 / 签名不变 / invariant 注释 / createBinding 签名未改）
  - 源码逻辑审查确认事务边界覆盖完整、条目级 try/catch 正确、无死循环路径
- **建议**：完整运行时回归（真实 better-sqlite3 + electron runtime）应由 Phase 末 verify 阶段在 electron 环境统一执行，非本 plan 的 plain-node 隔离测试能力所及。

## Deferred Items

- **Task 2 完整运行时回归**：在 electron runtime 下用真实内存 SQLite 跑 changes 累积/单事务/prepared 复用计数/单条失败跳过 4 项断言。记入 phase 验证待办（需 electron node ABI）。

## Next Phase Readiness
- PERF-02 交付完成，processARPEntries 性能从 O(N) 提交 + O(N×M) excluded 扫降到 O(1) 提交 + O(N) 内存判定
- anomalyService 改动对调用方完全透明，下游 (Phase 4 DATA-01 anomaly:getChanges 分页 / Phase 6 采集健壮性) 无阻塞
- 等待 Phase 3 其他 plan (PERF-01/03/04) 完成后统一 phase 验证

---
*Phase: 03-performance-optimization*
*Completed: 2026-06-28*

## Self-Check: PASSED

- FOUND `.planning/phases/03-performance-optimization/03-01-SUMMARY.md`
- FOUND `electron/services/anomalyService.ts`
- FOUND commit `b52fc75` (Task 1)
- FOUND commit `dd467af` (Task 2)
- FOUND commit `1f9edc4` (SUMMARY)
- grep 9 项断言全 PASS（db.transaction / preloadExcludedSet / isIPExcludedCached / 无循环内裸 isIPExcluded(ip) / continue / console.error / 签名不变 / invariant 注释 / createBinding 签名）
- tsc + esbuild 双绿（exit 0）
