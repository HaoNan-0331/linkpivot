---
phase: 03-performance-optimization
fixed_at: 2026-06-28T00:00:00Z
review_path: .planning/phases/03-performance-optimization/03-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 3: Code Review Fix Report

**Fixed at:** 2026-06-28
**Source review:** `.planning/phases/03-performance-optimization/03-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (WR-01 ~ WR-04)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### WR-01: processARPEntries 条目级 try/catch 在事务内导致部分写入提交（partial commit）

**Files modified:** `electron/services/anomalyService.ts`
**Applied fix:** 每条目写逻辑用 better-sqlite3 嵌套事务（= SAVEPOINT）包裹：抽出 `entryTx = db.transaction((entry) => {...})`，外层 `runBatch` 循环内 `try { entryTx(entry) } catch { continue }`。单条目中途失败（例：UPDATE is_active=0 已执行但 createBinding 失败）→ entryTx 自动 ROLLBACK TO savepoint 回滚该条全部写入 → 被 try/catch 捕获 → continue。修正"单条部分写入被整批 COMMIT 静默持久化"的数据完整性 bug。条目级 try/catch 保留（D-P2 红线：单条失败不 ROLLBACK 整批）。这是 D-P2 的正确实现。
**Status:** fixed: requires human verification（属事务/失败语义逻辑改动，Tier 1+2 仅验证语法/结构；建议人工或集成测试确认 savepoint 回滚行为符合预期）

### WR-02: excluded_ips 通配符规则在 RegExp 构造时未转义

**Files modified:** `electron/services/anomalyService.ts`
**Applied fix:** `isIPExcludedCached` 通配分支改为先转义全部正则元字符再还原 `*` → `.*`：`w.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')`。对合法通配规则（仅含 `.`/`*`）匹配语义不变；含 `(`/`[`/`+` 等元字符的规则不再抛 SyntaxError 或静默误配。

### WR-03: OUIService.update 在 vendorName 为空时向 Map 注入空串脏值

**Files modified:** `electron/services/ouiService.ts`
**Applied fix:** `update` 方法的 Map 同步加存在性守卫——仅当 `newRow.vendor_name` 为 truthy（非 null/undefined/空串）时执行 `vendorMap.set`；空值跳过 Map 更新（与 DB 层 vendor_name NOT NULL 行为对齐）。prefix 变更的旧 key delete 逻辑保持不变。

### WR-04: anomalyService.ipInCIDR / ipToNumber 无输入校验

**Files modified:** `electron/services/anomalyService.ts`
**Applied fix:** 镜像 `networkSegmentService.ts`（line 116-131）的健壮实现：`ipToNumber` 校验 4 段 + 各段 0-255 整数，非法返回 `null`；`ipInCIDR` 检查 `ipNum/networkNum === null` + prefix 合法（0-32），非法返回 `false`。消除畸形 cidr（如 `192.168.1.0/`）导致 `(NaN & mask)===(NaN & mask)` 恒为 true → 误判所有 IP 已排除 → ARP 处理整体失效的 bug。`ipInCIDR`/`ipToNumber` 是 private static，签名对外不变（仅返回类型 number→number|null，调用方均在 class 内）。

## Verification

三命令在隔离 worktree 内（复用 main tree node_modules via symlink）跑通，无新增 error：

- `npx tsc -p tsconfig.web.json --noEmit` → EXIT 0（与基线一致）
- `npm run build:electron-main`（esbuild） → EXIT 0（dist-electron/main.js 1.8mb）
- `npx vitest run` → 3 files / 12 tests passed（与基线一致）

## LOCKED 决策合规

- **D-P1**：未触碰 vendorMap 预载/优雅降级/getVendor 双查修复——WR-03 仅加固 update 的 Map 同步守卫，不影响预载语义。
- **D-P2**：WR-01 是 D-P2 的正确实现——条目级 try/catch 保留（单条失败不 ROLLBACK 整批），额外用 savepoint 修正"部分写入提交"语义偏差。
- **D-P3/D-P4**：未触碰 FTS trigger WHEN / init 启动序列。

## 签名/向后兼容

- `processARPEntries` / `isIPExcludedCached` / `preloadExcludedSet` / `OUIService.update` / `getVendor` 对外签名与行为不变。
- excluded_ips 匹配语义对合法规则（仅 `.`/`*`）不变。
- 条目级 try/catch（"尽力而为"语义）保留。

---

_Fixed: 2026-06-28_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
