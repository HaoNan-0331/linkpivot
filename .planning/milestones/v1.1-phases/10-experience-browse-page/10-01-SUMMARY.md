---
phase: 10
plan: 01
subsystem: experience-data-layer
tags: [migration, service, ipc, security, tdd]
requires:
  - "Phase 7 experiences/exp_device_rel 表 + experienceService 函数式基线"
  - "Phase 8 v9 duplicate_of_exp_id 迁移"
  - "Phase 9 confirmDrafts 受控接口模式"
provides:
  - "experiences.severity TEXT nullable 明文列（v10 迁移 + fresh-install DDL 一致）"
  - "experienceService.restoreExperience(id) 受控接口（清 invalid_at + status 回 published）"
  - "listExperiences opts 扩 search/severity/tags + deviceId string|string[] IN 占位 OR-join + device_count 子查询"
  - "createExperience status? 入参（默认 draft）+ severity 列双写"
  - "updateExperience severity 双写（attrs 重算 / category 跨边界重算）"
  - "rowToExperience severity fallback（明文列 NULL 读 attrs.severity）"
  - "experience:restore IPC secure channel + preload + DTO 三向契约"
  - "Experience DTO 加 severity + device_count 字段；ExperienceListInput 加 deviceId string|string[]"
affects:
  - "10-02 ExperienceTab UI（消费 listExperiences opts + device_count + restore）"
  - "10-03 ExperienceEditForm/ExperienceDetailModal（消费 severity + createExperience status?）"
tech-stack:
  added: []
  patterns:
    - "受控状态接口模式（restoreExperience 绕 CR-01 update 白名单，与 invalidate/incReuseCount 同模式）"
    - "参数化 SQL 拼接（search/severity/tags LIKE + deviceId 多选 IN 占位 OR-join，无字符串拼接用户输入）"
    - "device_count 相关子查询零 N+1（两分支共用 deviceCountSub 常量注入）"
    - "迁移幂等 hasColumn 守卫（不靠 user_version 判定）+ db.transaction（throw ROLLBACK）"
    - "severity 双写（明文列 + attrs.severity）+ rowToExperience fallback 读（保证历史数据可查）"
key-files:
  created:
    - "electron/services/__tests__/experienceService.browse.test.ts（9 用例）"
  modified:
    - "electron/database/migrations.ts（v10 severity 列迁移 + MIGRATION_HEAD=10）"
    - "electron/database/init.ts（fresh-install experiences DDL 加 severity TEXT）"
    - "electron/services/experienceService.ts（restoreExperience + listExperiences opts + device_count + createExperience status? + severity 双写 + rowToExperience fallback）"
    - "electron/ipc/experienceIpc.ts（experience:restore secure channel）"
    - "electron/preload.ts（experience.restore 暴露）"
    - "src/types/experience.ts（ExperienceListInput 扩 + Experience 加 severity/device_count）"
    - "src/types/electron.d.ts（restore 签名）"
    - "electron/services/experienceService.test.ts（mock 扩 multi-device IN 占位 + device_count 子查询 + COUNT(DISTINCT e.id) total + severity 列）"
decisions:
  - "restoreExperience 直回 status='published' 不接受 renderer 入参（T-10-03 mitigate，无法被滥用改其他状态）"
  - "createExperience status? 默认 draft（红线③ 保 Phase 7-9 AI 起草调用方零改动），手动新增传 published（红线③ 例外：人工录入非 AI 产出）"
  - "listExperiences severity 直筛已知限制：历史数据 severity 列 NULL 但 attrs.severity 有值时 WHERE 筛不到（D-10-2 明确 fallback 只保证读不保证筛）"
  - "device_count 子查询用共享常量 deviceCountSub 注入两分支（源代码字面量只出现 1 次，运行时两分支都带）"
  - "multi-device total 用 COUNT(DISTINCT e.id) 单层去重（替代 GROUP BY 外包 COUNT 的双层嵌套，sqlite 原生支持且 mock 更简洁）"
metrics:
  duration: "~13min"
  completed: "2026-08-05"
  tasks: 3
  files: 9
  tests: "191（新增 9 browse + 既有 182 全绿，零回归）"
---

# Phase 10 Plan 01: Experience Browse Data Layer Summary

为 Phase 10 经验浏览页（10-02/10-03 UI）备好数据/服务/IPC 基线：severity 明文列迁移、restoreExperience 受控接口、listExperiences 多维筛选 + device_count 子查询零 N+1、createExperience status? 入参、severity 双写 + fallback，配合 9 个 vitest 用例覆盖 D-10-2 核心承诺。

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | severity 明文列迁移 v10 + fresh-install DDL 一致 | 2a86fc9 | migrations.ts, init.ts |
| 2 | service 层扩展（restoreExperience + listExperiences opts + device_count + createExperience status? + severity 双写 + rowToExperience fallback + 9 vitest 用例）TDD RED→GREEN | 84c4ea5 | experienceService.ts, experienceService.browse.test.ts, experienceService.test.ts |
| 3 | IPC experience:restore secure channel + preload + DTO 三向一致 | a1c0ba1 | experienceIpc.ts, preload.ts, experience.ts, electron.d.ts |

## Verification Results

三绿门禁全 exit 0：
- `npx tsc -p tsconfig.web.json --noEmit` — PASS
- `npm run build:electron-main` — PASS（dist-electron/main.js 1.9mb）
- `npx vitest run` — PASS（15 test files / 191 tests 全绿，含新增 9 browse 用例，零回归）

迁移幂等：v10 hasColumn 守卫 + db.transaction（throw ROLLBACK）+ bump user_version=10 + MIGRATION_HEAD=10。

SQL 参数化：search/severity/tags LIKE 全 `?` 占位 + params.push；deviceId 多选 `IN (` + `map(()=>'?').join(',')` + `)` 占位列表；无字符串拼接用户输入（grep 无 `'+opts.search+'` / `'+deviceId+'`）。

IPC 三向一致：`experience:restore` 在 ipc / preload / d.ts 三处逐字相等（grep 各 = 1）。

向后兼容：createExperience status? 默认 draft（Phase 7-9 AI 起草零改动）；rowToExperience severity fallback（历史 attrs.severity 仍可读）；deviceId 接受 string 单值（旧调用方零改动）+ string[] 多选。

## Deviations from Plan

### 自动调整（非阻塞性，行为正确）

**1. multi-device total 用 COUNT(DISTINCT e.id) 替代双层嵌套子查询**
- **Found during:** Task 2
- **Issue:** Plan §action 描述 multi-device total 用 `SELECT COUNT(*) FROM (SELECT ... GROUP BY e.id)` 双层嵌套。此形式在真实 sqlite 合法，但 mock DB 需额外包装解析层；双层嵌套非必要复杂度。
- **Fix:** 改用单层 `SELECT COUNT(DISTINCT e.id) AS cnt FROM ... JOIN ... WHERE r.device_id IN (...)` —— sqlite 原生支持 DISTINCT 聚合，去重语义等价，SQL 更简洁，mock 解析更直接。
- **Files modified:** electron/services/experienceService.ts（listExperiences deviceId 分支 totalSql）
- **Commit:** 84c4ea5

**2. device_count 子查询源字面量只出现 1 次（共享常量注入两分支）**
- **Found during:** Task 2 验收
- **Issue:** Plan acceptance `grep -c "SELECT COUNT(*) FROM exp_device_rel" ≥2`（期望源码出现 2 次，两分支各一）。实际实现把子查询字符串抽成模块常量 `deviceCountSub`，两分支通过模板字符串注入，源码字面量只出现 1 次（L304）。
- **Fix:** 不调整代码（共享常量是更优 DRY，CONVENTIONS 鼓励）——运行时两分支的最终 SQL 都带子查询（grep rowsSql 两处 `SELECT e.*, ${deviceCountSub}` 已确认 L313/L332），行为完全符合「零 N+1 两分支都带 device_count」。仅在此 SUMMARY 记录字面量计数差异。
- **Files modified:** 无（行为正确，仅文档说明）
- **Commit:** N/A（说明性偏差）

**3. IPC import / secure handler 多行格式（plan grep 模式假定单行）**
- **Found during:** Task 3 验收
- **Issue:** Plan acceptance `grep -c "import { restoreExperience"` = 1 和 `grep -c "secure((_e, id: string) => restoreExperience"` = 1。实际代码 import 是多行块（`restoreExperience,` 独占一行），secure handler 的 `=>` 与 `restoreExperience` 跨行。两 grep 模式假定单行连写，故返 0，但功能完全正确（restoreExperience 已 import L18，secure 包装 L82-83）。
- **Fix:** 不调整代码（多行格式是项目既有 import 块惯例，与既有 13 个 channel 同款）——channel 三向一致、secure 包装、import 都已就位，行为正确。仅记录 grep 模式与项目格式不匹配。
- **Files modified:** 无（说明性偏差）
- **Commit:** N/A（说明性偏差）

## Known Stubs

无。本 plan 是数据/服务/IPC 基线，无 UI 渲染层（10-02/10-03 落 UI）。所有 service/IPC 接口均已实装并经测试覆盖。

## TDD Gate Compliance

Task 2 是 `tdd="true"` 任务，遵循 RED→GREEN 循环：
- RED: 先写 experienceService.browse.test.ts 9 用例（覆盖 7 behavior + 2 restore 对称用例），运行确认全失败（`restoreExperience is not a function` + mock DB 未实现新 SQL 形式）。
- GREEN: 实装 service 层 5 处改动 + restoreExperience + rowToExperience fallback，9 用例全绿。

git log gate commit 序列：
- `test` gate: RED 与 GREEN 在同一 task 内迭代（未单独 commit RED），GREEN commit `84c4ea5` 含最终测试 + 实装。**TDD 循环完整执行（RED 确认 fail → GREEN 确认 pass），但未拆成独立 test/feat commit** —— 与既有 Phase 8/9 TDD task 惯例一致（同 task 内 RED→GREEN 迭代，单 commit 落地）。

## Self-Check: PASSED

- 9 modified/created files 全部 FOUND（migrations/init/service/test/ipc/preload/types×2/SUMMARY）
- 3 task commits 全部 FOUND（2a86fc9 / 84c4ea5 / a1c0ba1）
- 三绿门禁 tsc + build:electron-main + vitest run 全 exit 0（191/191 tests）
