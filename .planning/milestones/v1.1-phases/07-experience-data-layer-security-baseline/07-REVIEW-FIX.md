---
phase: 07-experience-data-layer-security-baseline
fixed_at: 2026-08-01T14:47:00Z
review_path: .planning/phases/07-experience-data-layer-security-baseline/07-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 7: Code Review Fix Report

**Fixed at:** 2026-08-01T14:47:00Z
**Source review:** `.planning/phases/07-experience-data-layer-security-baseline/07-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (CR-01 / CR-02 / IF-03 / WR-02 / WR-04 / WR-05)
- Fixed: 6
- Skipped: 0

**三绿门禁（全部 EXIT 0）：**
- `npx tsc -p tsconfig.web.json` — 通过（noUnusedLocals 全绿）
- `npm run build:electron-main` — 通过（esbuild bundle 1.9mb）
- `npx vitest run` — 75 测试全过（原 73 + WR-02 新增 2 个 bi-temporal 三态/回归测试，含 IF-03/WR-04/WR-05 改造后的 20 个 experienceService 测试）

## Fixed Issues

### CR-01: experience:update IPC 白名单暴露审计/状态字段，renderer 可越权伪造软失效与复用统计

**Files modified:** `electron/services/experienceService.ts`, `src/types/experience.ts`
**Commit:** `144f96b`
**Applied fix:**
- `ExperienceUpdateFields`（service）/`ExperienceUpdateInput`（DTO）移除 `status` / `validAt` / `invalidAt` / `lastVerifiedAt` / `reuseCount` 五个审计/状态字段，只留 `title?` / `category?` / `content?` / `tags?` / `attrs?`。
- `updateExperience` 删除对应 5 个 SET 分支与 status 合法值校验分支。
- 状态/audit 字段只能经专用受控接口：`invalidateExperience`（软失效）、`incReuseCount`、`touchLastVerifiedAt`；`valid_at` 仅 create 时 DB 默认值生成。renderer 无法经 update 绕过。
- 副产物：`VALID_STATUSES` 常量已无引用（status 校验入口随 SET 分支删除），一并清理避免 noUnusedLocals；`ExperienceStatus` 类型仍保留（`ListExperiencesOpts.status` 过滤条件用）。

### CR-02: bi-temporal `invalid_at > datetime('now','localtime')` 文本比较缺乏格式契约，service 未校验 invalidAt 入参格式

**Files modified:** `electron/services/experienceService.ts`
**Commit:** `113e8d5`
**Applied fix:**
- 加 `CANONICAL_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/` 与 `export function assertCanonicalTimestamp(v, col)` 守卫，固化「valid_at/invalid_at/last_verified_at 列必须是 localtime YYYY-MM-DD HH:MM:SS」格式契约。
- 模块头注释列明三条合规写入路径（createExperience DB DEFAULT、invalidateExperience、incReuseCount/touchLastVerifiedAt 均用 `datetime('now','localtime')`，格式天然合规）；CR-01 已切断 renderer 直写路径，任何未来新增外部时间戳入口必须经此守卫。
- `invalidateExperience` 注释补充格式契约说明（用 `datetime('now','localtime')` 写入，无需校验）。

### IF-03: rowToExperience 未 JSON.parse(tags)，运行时 tags 是 JSON 字符串与 DTO 不符

**Files modified:** `electron/services/experienceService.ts`
**Commit:** `6542f9a`
**Applied fix:**
- `rowToExperience` 加 tags 解析：`if (row.tags != null && typeof row.tags === 'string') { try { row.tags = JSON.parse(row.tags) } catch { row.tags = [] } }`，并兜底 `!Array.isArray → []`、`null → []`。与 attrs parse 同降级模式（坏 JSON 不崩）。
- 运行时 `experience.tags` 现为 `string[]`，与 `Experience.tags: string[]` DTO 一致，renderer `.map`/`.includes` 不再崩溃。

### WR-02: mock DB 单测未复刻 bi-temporal `invalid_at > datetime(...)` 比较分支，测试通过是巧合

**Files modified:** `electron/services/experienceService.test.ts`
**Commit:** `dd7df84`
**Applied fix:**
- 加 `mockNow()` / `mockNowOffseted(offsetSec)` 辅助函数，产出真实可比的 localtime YYYY-MM-DD HH:MM:SS 时间戳。
- INSERT/UPDATE 中的 `datetime('now','localtime')` 写入从 `'NOW-MOCK'` 字符串改为 `mockNow()` 真实时间戳。
- 三处过滤侧（SELECT / COUNT / matchesWhere）从 `if (r.invalid_at) return false`（仅实现 IS NULL 分支）改为真实双分支比较 `!r.invalid_at || r.invalid_at > now`，复刻 `invalid_at IS NULL OR invalid_at > datetime(...)`。
- 新增 2 个回归测试：
  1. `bi-temporal 三态过滤（NULL 永有效 / 过去已失效 / 未来仍有效）`——seed 显式 NULL/过去/未来三态行，验证 `includeInvalid=false` 只返 NULL+未来、`includeInvalid=true` 返全部。
  2. `bi-temporal 过期行经 invalidateExperience 被过滤（回归）`——验证 invalidateExperience 写入后立即变过去被过滤（真实 sqlite 语义）。

### WR-04: validateAndStringifyAttrs 对 troubleshooting 类 attrs===null 显式清空时不校验 severity

**Files modified:** `electron/services/experienceService.ts`, `electron/services/experienceService.test.ts`
**Commit:** `4ee617b`
**Applied fix:**
- `validateAndStringifyAttrs` 调整校验顺序：troubleshooting 类**优先**校验 severity（attrs 清空/null 也强制），不进入下方空 attrs 早返分支。throw 文案改为「troubleshooting 类经验 attrs 必须含合法 severity」。
- 测试 `createExperience troubleshooting 类缺 severity 抛错` 扩展为 4 个 case：非空无 severity / 非法 severity / attrs 显式传空对象 `{}` / attrs 为 null，全部断言 throw。
- 既有 `updateExperience troubleshooting 改 attrs 缺 severity 抛错` 测试用 `.toThrow('severity')` 子串匹配，新文案仍含 'severity'，无需改。

### WR-05: experience:listDevices 用 `SELECT d.*` + 黑名单剥离，改白名单正向投影

**Files modified:** `electron/services/experienceService.ts`, `electron/services/experienceService.test.ts`, `electron/ipc/experienceIpc.ts`, `src/types/experience.ts`
**Commit:** `f84dc69`
**Applied fix:**
- service `listDevicesByExperience` 改为白名单正向投影：先 `SELECT r.device_id FROM exp_device_rel WHERE experience_id = ?` 查 id 列表，再逐个调 `deviceService.getDeviceById`（device 域既有的 `rowToDevice` 安全白名单映射，只返 Device DTO 明文字段，密文经 device MK 解密）。N+1 可接受（关联设备量小），安全优于单 SQL 黑名单剥离。
- `ExperienceRelatedDevice` 类型从开放索引签名 `[key: string]: unknown` 改为 `export type ExperienceRelatedDevice = Device`（复用 device 域显式字段 DTO）。
- IPC 层 `stripEncColumns` 保留作深度防御（Device DTO 已无 `_enc` 列，实际无操作），注释更新说明主防线已是 service 层白名单。
- 测试 mock：加 `vi.mock('./device', ...)` 拦截 `getDeviceById` 从 mock DB 读 device 行并返简化 Device DTO；mock DB 新增 `SELECT r.device_id AS device_id FROM exp_device_rel` 分支；`relateDevice 幂等去重` 测试 seed devices 表 'dev-1' 行使 getDeviceById 返非 null，并断言返回对象含 `name` 白名单字段（无 `_enc` 密文）。

---

_Fixed: 2026-08-01T14:47:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
