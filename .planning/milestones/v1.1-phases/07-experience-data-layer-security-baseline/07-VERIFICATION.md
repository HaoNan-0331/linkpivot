---
phase: 07-experience-data-layer-security-baseline
verified: 2026-08-01T22:57:00Z
status: passed
score: 5/5 must-haves verified
requirements_covered: [EXP-01, EXP-02, EXP-03, EXP-04, SEC-01, SEC-02]
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: N/A
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 7: Experience Data Layer & Security Baseline 验证报告

**Phase Goal:** 用户的数据有了持久化经验条目的承载（结构化表 + 设备关联 + 时效软失效 + 模板字段），且所有经验 IPC 自始即走鉴权/脱敏网关——为后续起草/确认/浏览/检索铺好安全且可演进的地基。
**Verified:** 2026-08-01T22:57:00Z
**Status:** passed
**Re-verification:** No — initial verification

## 验证方法论

goal-backward 验证：对照 ROADMAP.md Phase 7 的 5 条 Success Criteria，逐条在实际源码（init.ts / migrations.ts / experienceService.ts / experienceIpc.ts / main.ts / preload.ts / experience.ts DTO）中找实证，不依赖 SUMMARY 声明。辅以三绿门禁实测（tsc strict / vitest 75 测试全过）+ code review 6 fix（CR-01/CR-02/IF-03/WR-02/WR-04/WR-05）落地确认。

## Goal Achievement — Observable Truths（对照 5 Success Criteria）

| # | Truth (Success Criterion) | Status | 实证证据 |
|---|---------------------------|--------|----------|
| 1 | 经验条目可被创建/读取，持久化到独立于 `kb_*` 的 `experiences` 表，含通用列（标题/分类/内容/标签/状态/来源会话）+ `attrs` 模板 JSON 区（troubleshooting 挂症状/根因/处置/预防/严重度） | VERIFIED | init.ts:294-312 DDL：`title/category/content/tags/status/source_session_id/attrs_enc` 通用列齐全 + `valid_at/invalid_at/last_verified_at/reuse_count` 预埋；service `createExperience`/`getExperience`（experienceService.ts:165-184）走参数化 INSERT+SELECT；`validateAndStringifyAttrs`（line 120-129）troubleshooting 强制 severity；`ExperienceAttrs`（line 72-79）含 symptoms/root_cause/resolution/prevention/severity 模板字段；表名 `experiences` 独立于 `kb_documents/kb_chunks` |
| 2 | 一条经验可关联 0~N 台设备（`exp_device_rel` 多对多），且可按设备反查关联经验 | VERIFIED | init.ts:319-330 DDL：`UNIQUE(experience_id, device_id)` 去重 + 双向 `FK CASCADE` + 双向索引；service `relateDevice`（INSERT OR IGNORE 幂等，line 317-321）、`listExperiencesByDevice`（line 347-349 复用 listExperiences deviceId JOIN 分支）、`listDevicesByExperience`（line 337-344 WR-05 白名单正向投影经 getDeviceById）三函数实证；IPC `experience:relateDevice`/`unrelateDevice`/`listByDevice`/`listDevices` 四 channel 注册 |
| 3 | bi-temporal 有效期（valid_at/invalid_at），过期软失效后不进有效检索但保留历史，不物理删除 | VERIFIED | listExperiences line 211-213 默认过滤 `(e.invalid_at IS NULL OR e.invalid_at > datetime('now','localtime'))`；`invalidateExperience`（line 301-307）是 UPDATE 设 invalid_at（非 DELETE，软失效保留历史）；`deleteExperience`（line 310-312）物理删仅 Phase 10 浏览页手动调，不进软失效路径；WR-02 单测（test.ts:575-600 三态 NULL/过去/未来 + line 602-609 invalidate 回归）实证覆盖 |
| 4 | 所有经验相关 IPC channel 经 secure/safe 包装（鉴权+异常脱敏），凭证/敏感列按规范脱敏，channel 命名 `<domain>:<action>` | VERIFIED | experienceIpc.ts：`secure(` × 10 / `safe(` × 0（实测 grep）/ `ipcMain.handle('experience:` × 10；10 channel 全 camelCase action（list/get/create/update/delete/invalidate/relateDevice/unrelateDevice/listByDevice/listDevices，去重精确 10）；service 层 `rowToExperience` decField 回填 attrs + `delete row.attrs_enc`（line 137-159，密文不外泄）；IPC `experience:listDevices` 经 `stripEncColumns` 剥 `_enc` 列 + service 白名单正向投影（WR-05）；main.ts:94 `setExperienceMasterKey(masterKey)` + main.ts:136 `registerExperienceIpc()` 注入注册；preload.ts:124-135 暴露 10 方法白名单 |
| 5 | 迁移幂等可重跑（`sqlite_master.sql` 特征串守卫，不靠 user_version），多写包 `db.transaction`，throw 即 ROLLBACK，历史数据向后兼容 | VERIFIED | migrations.ts:193-247 v8：`sqlite_master.sql` 查 `attrs_enc` 特征串命中即 no-op 早返（line 197-202）+ `db.transaction(() => {...})()` 包裹 DDL（line 203-246）+ `db.pragma('user_version = 8')`；DDL 与 init.ts:294-330 fresh-install 块逐字一致（含所有列/CHECK/索引/FK）；experiences/exp_device_rel 是全新表，不动 kb_*/devices 既有表（历史数据零影响）；MIGRATION_HEAD=8（line 16） |

**Score:** 5/5 truths verified

## Required Artifacts（三级核验：exists / substantive / wired）

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `electron/database/init.ts` | experiences + exp_device_rel fresh-install DDL | VERIFIED | exists + line 294-330 含完整 DDL（attrs_enc/bi-temporal 索引/FK CASCADE/4 态 status）+ 被 initDatabase 调用（wired） |
| `electron/database/migrations.ts` | v8 幂等迁移 | VERIFIED | exists + line 193-247 含 sqlite_master 守卫 + transaction + MIGRATION_HEAD=8 + MIGRATIONS 数组注册 v8（wired） |
| `electron/services/experienceService.ts` | 函数式 service（CRUD/关联/bi-temporal/模板校验/字段加密/MAX_BATCH） | VERIFIED | exists + 360 行实质实现 + 函数式（`let MK` + export function，`export class`=0）+ 7 处 encField/decField 无裸 encrypt/decrypt + 13 个 export function 全导出 + 被 IPC/main.ts import（wired） |
| `electron/services/experienceService.test.ts` | 单测（含 WR-02 bi-temporal 三态） | VERIFIED | exists + 20 测试全过（vitest 实测）+ WR-02 三态过滤测试 + WR-04 severity 4 case + WR-05 getDeviceById mock |
| `electron/ipc/experienceIpc.ts` | 10 channel 全 secure 包装 + listDevices 边界脱敏 | VERIFIED | exists + 82 行 + secure × 10 + stripEncColumns + registerExperienceIpc 导出 + 被 main.ts 调用（wired） |
| `electron/main.ts` | setExperienceMasterKey 注入 + registerExperienceIpc 注册 | VERIFIED | import line 28-29 + 注入 line 94（紧跟 setKbMasterKey）+ 注册 line 136（紧跟 registerKbIpc） |
| `electron/preload.ts` | window.api.experience.* 10 方法白名单 | VERIFIED | line 124-135 experience 块 10 方法，channel 与 ipcMain.handle 逐字一致 |
| `src/types/experience.ts` | Experience/ExperienceInput/ExperienceUpdateInput/DTO | VERIFIED | exists + 含 6 interface/type + CR-01 收紧后的 ExperienceUpdateInput（仅业务字段）+ ExperienceRelatedDevice=Device（WR-05） |

## Key Link Verification（wiring）

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| experienceIpc.ts | experienceService.ts | 具名函数 import + 调用 | WIRED | line 3-13 import 10 函数，每 channel handler 调对应 service 函数 |
| experienceIpc.ts | authGuard.ts | secure() 包装每 handler | WIRED | line 15 import secure，10 channel 全 secure(...) 包装 |
| main.ts | experienceService.ts | setExperienceMasterKey(masterKey) | WIRED | main.ts:28 import + line 94 注入 |
| main.ts | experienceIpc.ts | registerExperienceIpc() | WIRED | main.ts:29 import + line 136 调用 |
| preload.ts | IPC channels | ipcRenderer.invoke('experience:*') | WIRED | 10 invoke 第一参与 ipcMain.handle 第一参逐字一致 |
| experienceService.ts | experiences/exp_device_rel | getDatabase().prepare() 参数化 | WIRED | 13 函数全 prepared statement + `?` 绑定 |
| experienceService.ts | crypto.ts | encField/decField 读写 attrs_enc | WIRED | line 4 import + 7 处调用，无裸 encrypt/decrypt |
| experienceService.ts | device.ts (WR-05) | getDeviceById 白名单投影 | WIRED | line 5 import + line 342 调用（listDevicesByExperience） |

## Data-Flow Trace（Level 4）

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|----|
| createExperience → getExperience | `row.attrs` | decField(attrs_enc) + JSON.parse | 真实加密 attrs 解密回填 | FLOWING |
| listExperiences | `rows[].attrs` / `rows[].tags` | rowToExperience 解密 attrs + JSON.parse tags（IF-03） | 真实（非 hardcoded） | FLOWING |
| listDevicesByExperience | Device[] | deviceService.getDeviceById（device DB 查询，rowToDevice 白名单） | 真实 device 行（WR-05） | FLOWING |
| bi-temporal 过滤 | `invalid_at` | invalidateExperience 写 `datetime('now','localtime')` | 真实 localtime 时间戳（CR-02 格式契约） | FLOWING |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| tsc strict 类型门禁 | `npx tsc -p tsconfig.web.json --noEmit` | EXIT 0（无错误） | PASS |
| experienceService 单测 | `npx vitest run electron/services/experienceService.test.ts` | 20/20 passed | PASS |
| 全量 vitest | `npx vitest run` | 8 files / 75 tests passed | PASS |
| IPC 安全计数 | `grep -c secure(` / `safe(` / `ipcMain.handle('experience:` | 10 / 0 / 10 | PASS |
| 函数式形态守卫 | `grep -c "export class " experienceService.ts` | 0 | PASS |
| 字段加密红线 | `grep -E "\b(encrypt\|decrypt)\("` 排除 encField/decField | 0 命中 | PASS |
| channel 命名 camelCase | 10 unique `'experience:[a-zA-Z]+'` | 10 全 camelCase | PASS |

## Code Review Fix 落地确认（CR/WR/IF）

| Fix | 描述 | 落地实证 | Status |
|-----|------|----------|--------|
| CR-01 | ExperienceUpdateInput 收紧移除 status/validAt/invalidAt/lastVerifiedAt/reuseCount | service `ExperienceUpdateFields`（line 95-101）+ DTO `ExperienceUpdateInput`（experience.ts:35-41）均仅 title/category/content/tags/attrs；updateExperience SET 分支无 status/audit 字段（line 261-279） | LANDED |
| CR-02 | assertCanonicalTimestamp 守卫固化 bi-temporal 格式契约 | service line 63-70 守卫定义 + 注释列明三条合规写入路径；CR-01 已切断 renderer 直写路径，守卫为未来入口预埋 | LANDED（前瞻预埋，当前无外部入参调用点） |
| IF-03 | rowToExperience 加 JSON.parse(tags) | service line 148-158 tags 解析 + 坏 JSON 降级 [] + null 降级 [] | LANDED |
| WR-02 | 单测覆盖 bi-temporal NULL/过去/未来三态 | test.ts:575-600 三态测试 + line 602-609 invalidate 回归 + mock 双分支真实比较（line 312-314/386-388/422-424） | LANDED |
| WR-04 | troubleshooting attrs 清空也校验 severity | service validateAndStringifyAttrs line 121-126 severity 优先校验（attrs 清空/null 也强制）+ test.ts:504-522 四 case（非空无 severity/非法 severity/`{}`/null 全断言 throw） | LANDED |
| WR-05 | listDevicesByExperience 改白名单正向投影 | service line 337-344 查 device_id 列表 + 逐个 getDeviceById；ExperienceRelatedDevice=Device（experience.ts:81-82）；IPC stripEncColumns 保留作深度防御 | LANDED |

## Requirements Coverage

| Requirement | Source Plan | 描述（REQUIREMENTS.md） | Status | Evidence |
|-------------|-------------|-------------------------|--------|----------|
| EXP-01 | 07-01 | 持久化经验条目（标题/分类/内容/标签/来源会话） | SATISFIED | experiences 表通用列 + createExperience/getExperience CRUD |
| EXP-02 | 07-01 | 经验关联一台或多台设备 | SATISFIED | exp_device_rel 多对多 + relateDevice/listDevicesByExperience/listExperiencesByDevice |
| EXP-03 | 07-01 | bi-temporal 有效期，过期软失效保留历史不进有效检索 | SATISFIED | valid_at/invalid_at + listExperiences 默认过滤 + invalidateExperience UPDATE 不 DELETE |
| EXP-04 | 07-01 | 经验按分类区分字段深度（troubleshooting 模板，其他轻结构） | SATISFIED | validateAndStringifyAttrs troubleshooting 强制 severity + ExperienceAttrs 模板（symptoms/root_cause/resolution/prevention/severity） |
| SEC-01 | 07-02 | 所有经验 IPC 经 secure/safe 鉴权 + 异常脱敏 | SATISFIED | 10 channel 全 secure 包装（secure=10/safe=0）+ authGuard secure 鉴权 |
| SEC-02 | 07-01, 07-02 | 经验数据访问遵循脱敏规范（凭证不外泄） | SATISFIED | attrs_enc AES-256-GCM 加密 + rowToExperience delete 密文列 + stripEncColumns 边界剥离 + WR-05 白名单投影 |

**Orphaned Requirements:** 无。REQUIREMENTS.md Phase 分布行（line 105）确认 Phase 7 仅映射 EXP-01/02/03/04 + SEC-01/02 共 6 条，全部在 PLAN frontmatter `requirements:` 字段中出现，无遗漏未认领 ID。

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| experienceService.ts | 38-40 | `_setExperienceDbGetter` 测试钩子 export 无运行期守卫（WR-03 未修） | Warning | 攻击面增量极小（renderer 经 contextIsolation 拿不到 main 进程模块，preload/IPC 均未暴露此钩子，实测 grep preload/ipc 无引用）；仅 main 进程内可调，属低风险 |
| experienceService.ts | 234, 247 | `truncated: rows.length < total` 语义错误（WR-01 未修） | Info | 全仓既有模式（anomalyService:160/ouiService:65 同款），非本 phase 引入；offset>0 第二页误报截断，跨 phase 修正任务 |
| experienceService.ts | 66 | `assertCanonicalTimestamp` export 但当前无调用点（CR-02 前瞻预埋） | Info | CR-01 已切断 renderer 时间戳直写路径，守卫为未来 Phase 11 入口预留；导出不触发 noUnusedLocals（tsc 绿） |
| vitest.config.ts | 10 | `inline: ['../../electron']` 路径指向仓库外（IF-01 未修） | Info | dead config，vitest 降级不阻塞（75 测试全过） |

## Human Verification Required

无。Phase 7 是纯数据层 + IPC 网关层，无可视/UI/外部服务行为需人工核验。所有 truths 均经源码 + grep + 三绿门禁实证。Phase 8-11 才有 UI/LLM/检索行为需人工。

## Gaps Summary

无阻塞性 gap。5 条 Success Criteria 全部 VERIFIED，6 条 requirement 全部 SATISFIED，6 个 code review fix 全部 LANDED，三绿门禁全过（tsc EXIT 0 / vitest 75 passed）。

**保留的非阻塞观察项（不阻 phase 目标）：**
1. WR-01 `truncated` 语义——全仓既有模式，建议跨 phase 统一修（非 Phase 7 引入，非本 phase 阻塞项）
2. WR-03 `_setExperienceDbGetter` 无运行期守卫——攻击面增量极小（contextIsolation + 未暴露 renderer），可在后续安全加固 phase 处理
3. `assertCanonicalTimestamp` 当前无调用点——CR-01 已堵 renderer 直写路径，守卫为未来 Phase 11 入口预留（前瞻预埋，非缺陷）

**结论：** Phase 7 goal 已达成——经验条目持久化承载（结构化表 + 设备关联 + bi-temporal 软失效 + attrs 模板）+ 所有经验 IPC 自始即走 secure 鉴权/脱敏网关双地基落地，为 Phase 8-11（起草/确认/浏览/检索）铺好安全且可演进的地基。可推进下一 phase。

---

_Verified: 2026-08-01T22:57:00Z_
_Verifier: Claude (gsd-verifier)_
_Methodology: goal-backward（对照 ROADMAP 5 Success Criteria + REQUIREMENTS 6 ID + 实际源码实证，非 SUMMARY 声明）_
