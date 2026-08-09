---
phase: 14-defect-legacy-rollback-closure
plan: 01
subsystem: anomaly-detection
tags: [anomaly, new_ip, baseline, mock-db, migration, backward-compat]
requires:
  - Phase 12 test:electron 通道 + realDb helper（D-14-4 借回归网）
  - experienceService._setExperienceDbGetter 范式（D-7-8 mock 注入口 analog）
provides:
  - anomalyService.processARPEntries 全新 IP 分支 recordChange('new_ip')（hasBaseline 门控）
  - ip_mac_bindings.is_baseline 列（v12 迁移 + init.ts fresh-install 双路径）
  - _setAnomalyDbGetter mock 注入口（main 进程测试专用，生产零影响）
  - 首次基线机制（首次扫描建基线不报，基线后新增 IP 才报 new_ip）
  - 遗留库向后兼容（存量 IP 走 currentBinding 不误报 + 后置基线 UPDATE 纳入存量行）
affects:
  - 异常检测面板 AnomalyTab.tsx（newIp 数字 + 导出 CSV 不再恒零）
  - getStats().newIp 计数（修前恒零修后真实）
tech-stack:
  added: []
  patterns:
    - hasColumn 幂等守卫（v12 沿用 v1/v2 第一形式纯 ALTER ADD COLUMN）
    - mock DB 注入范式（_setAnomalyDbGetter 镜像 _setExperienceDbGetter）
    - 整批单事务 + 条目级 SAVEPOINT（entryTx 自动复用既有事务边界）
    - 首次基线机制（入口 hasBaseline 判定 + runBatch 后置 UPDATE）
key-files:
  created:
    - tests/electron/anomalyNewIp.real.test.ts
  modified:
    - electron/services/anomalyService.ts
    - electron/database/migrations.ts
    - electron/database/init.ts
    - electron/database/migrations.test.ts
decisions:
  - D-14-1 方案 A 落地（ip_mac_bindings 加 is_baseline 列 + 首次基线机制）
  - getStats 读取侧不动（D-14-1 锁定，本来就对）
  - _setAnomalyDbGetter 镜像 _setExperienceDbGetter 范式（D-14-4 借 Phase 12 回归网）
  - 遗留库后置基线 UPDATE 纳入存量行（CLAUDE.md 向后兼容硬约束，预期行为文档化）
metrics:
  duration: 6m33s
  completed: 2026-08-09
  tasks: 2
  files: 5
  tests-added: 6
---

# Phase 14 Plan 01: BUG-1 anomaly new_ip 恒零修复 Summary

修复 anomalyService.processARPEntries 全新 IP 分支漏写 new_ip 告警（v12 迁移加 ip_mac_bindings.is_baseline 基线列 + 双路径同步 + _setAnomalyDbGetter mock 注入口 + 首次基线机制 + 遗留库向后兼容后置 UPDATE，realDb 真路径 6 it 单测覆盖）。

## 改动明细

### Task 1：service + 迁移 + init 双路径 + mock 注入口（commit 5845f35）

**electron/services/anomalyService.ts（BUG-1 改动主体）：**
- 加模块级 `let dbGetter: () => Database.Database = getDatabase` + `export function _setAnomalyDbGetter(fn)`（@internal 测试专用，镜像 experienceService._setExperienceDbGetter D-7-8）。全方法 `getDatabase()` → `dbGetter()`（isIPExcluded / processARPEntries / recordChange / getChanges / acknowledgeChange / acknowledgeAll / deleteChange / deleteChanges / getStats / getBindingHistory / getExcludedIPs / addExcludedIP / deleteExcludedIP）。生产路径 dbGetter 默认 = getDatabase 单例，行为零变化。
- `processARPEntries` 入口加 `hasBaseline` 判定（库里有任意 is_baseline=1 行 = 基线已建，本次整批扫描期间基线状态不变）。
- `entryTx` else 分支（currentBinding 与 oldBinding 都不存在 = 全新 IP）补 `if (hasBaseline) { const change = this.recordChange(ip, null, mac, 'new_ip'); if (change) changes.push(change) }`（首次扫描 hasBaseline=false 跳过仅 createBinding，基线后 hasBaseline=true 报 new_ip）。**核心 BUG-1 修复点**。
- `runBatch` 整批事务结束后加后置基线 UPDATE：`if (!hasBaseline) { db.prepare('UPDATE ip_mac_bindings SET is_baseline = 1 WHERE is_baseline = 0').run() }`（首次扫描把当前所有现存 IP 含遗留存量纳入基线，预期行为）。
- 注释明示遗留库向后兼容语义（存量 IP 走 currentBinding 分支不误报 new_ip + 后置 UPDATE 纳入存量行，CLAUDE.md 硬约束）。
- `getStats` 读取侧 line 221 `newIp: COUNT(*) WHERE change_type = 'new_ip'` **不动**（D-14-1 锁定，本来就对，写入侧补齐后该数字反映真实新增数）。

**electron/database/migrations.ts（v12 迁移）：**
- 新增 `v12` 函数：`hasColumn(db, 'ip_mac_bindings', 'is_baseline')` 守卫（沿用 v1/v2 第一形式幂等守卫）+ `ALTER TABLE ip_mac_bindings ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0` + `db.pragma('user_version = 12')`，包 db.transaction（throw 即 ROLLBACK）。
- 注释明示：ALTER ADD COLUMN 默认 0——遗留库存量 binding 行升级后 is_baseline=0（未基线），首次扫描后由后置 UPDATE 纳入基线（语义见上）。
- `MIGRATION_HEAD = 11` → `12`。
- MIGRATIONS 数组注册 `{ version: 12, name: 'ip_mac_bindings is_baseline (BUG-1 首次基线标志)', run: v12 }`。

**electron/database/init.ts（fresh-install 双路径同步）：**
- ip_mac_bindings CREATE TABLE 在 `is_active INTEGER NOT NULL DEFAULT 1,` 之后加 `is_baseline INTEGER NOT NULL DEFAULT 0,`（与 v12 迁移列定义逐字一致，双路径一致红线，fresh-install 与遗留库经 v12 迁移后 schema 完全一致）。

### Task 2：realDb 真路径单测 6 it + 静态守卫同步（commit 5cdddd6）

**tests/electron/anomalyNewIp.real.test.ts（新建，288 行）：**
- 借 Phase 12 realDb 真路径范式（D-14-4）+ _setAnomalyDbGetter 注入口。beforeEach makeRealDb() + 自建 ip_mac_bindings/ip_mac_changes/excluded_ips 三表（DDL 照 init.ts fresh-install 抄含 is_baseline 列），_setAnomalyDbGetter 注入。afterEach close + 还原 dbGetter 为 getDatabase 单例（防跨测试污染）。
- 6 it 覆盖 BUG-1 三条核心路径 + 既有逻辑不回归 + SC1 闭环 + 遗留库向后兼容硬约束：
  - **Test 1** 首次扫描建基线：空库喂 IP → ip_mac_changes 0 行 + binding is_baseline=1 + changes 空（防首次全量扫描刷屏）。
  - **Test 2** 基线后新增 IP 报 new_ip：Test 1 基线已建后喂新 IP → ip_mac_changes 1 行 change_type='new_ip' old_mac=null new_mac=新mac + changes 长度 1 + 新增 binding is_baseline=0（仅首次基线标 1）。
  - **Test 3** 基线内已知 IP 不报：基线已建后喂基线内 IP（mac 相同）→ ip_mac_changes 0 新行 + changes 空 + last_seen 更新 + is_baseline 保持 1。
  - **Test 4** mac_changed 不回归：基线后喂已知 IP 但 mac 变 → change_type='mac_changed'（既有逻辑不破坏，非 new_ip）。
  - **Test 5** getStats newIp 不恒零（SC1 闭环）：建基线 + 喂两个新 IP 后 getStats().newIp = 2（修前恒零，修后真实新增数）。
  - **Test 6** 遗留库场景（CLAUDE.md 向后兼容硬约束）：raw INSERT 预置存量 binding（is_baseline=0，模拟老库 user_version≤11 经 v12 升级后状态）→ 喂该存量 IP（mac 不变）→ (a) ip_mac_changes 无 new_ip 新行（存量 IP 走 currentBinding 分支不误报，核心向后兼容不变量）+ (b) 存量行 last_seen 更新 + (c) 后置基线 UPDATE 把存量行置 is_baseline=1（首次扫描把现存 IP 含遗留存量纳入基线，预期行为）。

**electron/database/migrations.test.ts（Rule 1+3 deviation，既有静态守卫同步）：**
- v11 静态守卫 `MIGRATION_HEAD=11` → `12`（v12 是本 plan 合法 bump，既有契约随 schema 变更同步，防 npm test 阻塞）。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1+3 - 既有契约随 schema 变更同步] migrations.test.ts MIGRATION_HEAD 静态守卫同步**
- **Found during:** Task 2 verify 阶段 `npm test`
- **Issue:** Phase 13 写的 v11 静态守卫断言 `MIGRATION_HEAD=11`，本 plan bump 到 12 后该断言失败（`expected 12 to be 11`），阻塞 npm test 全绿。
- **Fix:** 既有契约随 schema 变更同步——守卫断言从 11 改 12，加注释明示 v12 是本 plan 合法 bump。这不是新增断言，是既有守卫跟随 v12 注册的合法更新（v11 4 个 it 全部保留验证迁移本身正确）。
- **Files modified:** electron/database/migrations.test.ts
- **Commit:** 5cdddd6

## Verification

三绿门禁全绿零回归：

| 门禁 | 命令 | 结果 |
|------|------|------|
| tsc web strict + noUnusedLocals | `npx tsc -p tsconfig.web.json` | EXIT=0 全绿 |
| esbuild main 打包 | `npm run build:electron-main` | EXIT=0 全绿（dist-electron/main.js 1.9mb） |
| test:electron 真路径 | `npm run test:electron -- tests/electron/anomalyNewIp.real.test.ts` | 6/6 it 全绿（2.16s） |
| plain node npm test | `npm test` | 256/256 全绿零回归（18 test files） |

acceptance grep 全断言通过：

| 断言 | 期望 | 实测 |
|------|------|------|
| `_setAnomalyDbGetter\|let dbGetter` (anomalyService.ts) | ≥ 2 | 4 |
| `recordChange(ip, null, mac, 'new_ip')` (anomalyService.ts) | = 1 | 1 |
| `UPDATE ip_mac_bindings SET is_baseline = 1 WHERE is_baseline = 0` (anomalyService.ts) | = 1 | 1 |
| `getDatabase()` 调用 (anomalyService.ts) | = 0（仅 line 2 import） | 0 |
| `MIGRATION_HEAD = 12\|hasColumn(db, 'ip_mac_bindings', 'is_baseline')` (migrations.ts) | ≥ 2 | 2 |
| `is_baseline INTEGER NOT NULL DEFAULT 0` (init.ts) | = 1 | 1 |
| `WHERE change_type = 'new_ip'` (anomalyService.ts，仅 getStats) | = 1 | 1 |
| 遗留库/向后兼容/存量 注释 (anomalyService.ts) | ≥ 1 | 6 |
| `it(` (anomalyNewIp.real.test.ts) | ≥ 6 | 7（含 describe 内字面量） |
| `_setAnomalyDbGetter` (anomalyNewIp.real.test.ts) | ≥ 1 | 4 |
| 遗留库/存量 (anomalyNewIp.real.test.ts) | ≥ 1 | 10 |

## SC1 闭环（FIX-01 / BUG-1）

修前：anomalyService.processARPEntries 全新 IP 分支（currentBinding 与 oldBinding 都不存在）只 createBinding 缺 recordChange('new_ip')，致 `getStats().newIp` COUNT 读取侧（line 221 本来就对）恒零——异常检测面板 AnomalyTab.tsx 的「新 IP」数字 + 导出 CSV 恒为 0。

修后：写入侧补齐 `recordChange(ip, null, mac, 'new_ip')` 被 `if (hasBaseline)` 门控。首次扫描建基线（is_baseline=1）不报 new_ip（防首次全量扫描刷屏），基线后新增 IP 才报 new_ip 落 ip_mac_changes。Test 2 + Test 5 佐证：建基线后喂新 IP → ip_mac_changes 写入 new_ip + getStats().newIp = 2（修前恒零修后真实）。

## 遗留库向后兼容（CLAUDE.md「迁移改动必须向后兼容历史数据」硬约束）

遗留库 = 升级前已有历史 binding 行的老库（user_version≤11，ip_mac_bindings 已有存量行）。v12 迁移加 is_baseline 列默认 0，存量行升级后 is_baseline=0（未基线）。本 plan 首次基线机制对遗留库的预期行为（Test 6 全程佐证）：

1. **存量 IP 不误报为 new_ip**：遗留库首次扫描喂某存量 IP（mac 不变）→ 走 entryTx 的 currentBinding 分支（存量 active binding 命中）→ 只 update last_seen，**不进 else 分支**，不调 recordChange('new_ip')，不落 ip_mac_changes（Test 6 (a) 佐证）。
2. **后置基线 UPDATE 纳入存量行**：runBatch 整批事务结束后，processARPEntries 入口读到 hasBaseline=false（首次扫描），执行 `UPDATE ip_mac_bindings SET is_baseline = 1 WHERE is_baseline = 0`——此 UPDATE 把遗留库所有现存存量 binding 行（含本次未喂的存量 inactive 行）全置 is_baseline=1（Test 6 (c) 佐证）。语义：首次扫描把当前所有现存 IP（含遗留存量）纳入基线，之后新增 IP 才报 new_ip。预期行为，老库升级第一次扫描即确立基线，避免老库升级刷屏报全量 IP 为 new_ip。
3. **遗留库首次后报新增 IP**：基线建立（含存量行被置 1）后，第二次扫描喂全新 IP（库里无任何 binding）→ 走 else 分支 + hasBaseline=true → 报 new_ip（与 fresh-install 库一致，向后兼容）。

## 三红线不回退（SC4）

| 红线 | 本 plan 处理 | 佐证 |
|------|--------------|------|
| ① IPC `secure`/`safe` 鉴权 | anomaly:* IPC 注册处零改动（service 层 + 迁移 + init DDL 改动不碰 IPC 网关层 anomalyIpc.ts 的 secure 包装） | grep `secure(` anomalyIpc.ts 不变 |
| ② `_enc` 字段加密 | ip_mac_changes 表无 _enc 列（init.ts:152-162 明文列），本 plan 零 encField/decField 调用新增 | grep encField/decField anomalyService.ts = 0 |
| ③ `commandSafety.isCommandAllowed` | anomalyService 是 ARP 异常检测写入链，不经 AI 命令执行层（commandSafety 在 ai.ts:334/890），本 plan 零改动 ai.ts | grep commandSafety anomalyService.ts = 0 |

## 迁移幂等（CLAUDE.md 红线）

- v12 `hasColumn(db, 'ip_mac_bindings', 'is_baseline')` 守卫（沿用 v1/v2 第一形式），重跑安全（遗留库第二次启动 no-op）。
- init.ts fresh-install ip_mac_bindings DDL 与 v12 迁移列定义逐字一致（双路径无漂移）。
- v12 包 db.transaction（throw 即 ROLLBACK）。

## Self-Check: PASSED

**Created/modified files exist:**
- FOUND: electron/services/anomalyService.ts
- FOUND: electron/database/migrations.ts
- FOUND: electron/database/init.ts
- FOUND: tests/electron/anomalyNewIp.real.test.ts
- FOUND: electron/database/migrations.test.ts
- FOUND: .planning/phases/14-defect-legacy-rollback-closure/14-01-SUMMARY.md

**Commits exist:**
- FOUND: 5845f35 (fix(14-01): 修 BUG-1 anomaly new_ip 恒零)
- FOUND: 5cdddd6 (test(14-01): BUG-1 mock 单测 6 it + 同步 MIGRATION_HEAD 静态守卫)
