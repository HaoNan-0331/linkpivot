---
phase: 07-experience-data-layer-security-baseline
reviewed: 2026-08-01T14:14:37Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - electron/database/init.ts
  - electron/database/migrations.ts
  - electron/services/experienceService.ts
  - electron/services/experienceService.test.ts
  - electron/ipc/experienceIpc.ts
  - electron/main.ts
  - electron/preload.ts
  - src/types/experience.ts
  - src/types/electron.d.ts
  - vitest.config.ts
findings:
  critical: 2
  warning: 5
  info: 4
  total: 11
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-08-01T14:14:37Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Phase 7 经验沉淀数据层（experiences + exp_device_rel 建表 / 函数式 service / 10 个 IPC channel / DTO + 类型桥接 / mock DB 单测）。整体落地质量较高：

- **IPC 安全红线达标**：10 个 `experience:*` channel 全部经 `secure(...)` 包装（鉴权 + 异常脱敏），无裸 `ipcMain.handle` 漏网；`experience:listDevices` 经 `stripEncColumns` 剥离 `_enc` 后缀列后才返 renderer（SEC-02 达标）。
- **SQL 全参数化**：bi-temporal 过滤、attrs 查询、设备反查 JOIN 均走 prepared statement + `?` 占位，无字符串拼接 SQL（无注入面）。
- **字段加密红线达标**：`attrs_enc` 只走 `encField`/`decField`，无裸 `encrypt`/`decrypt`；`rowToExperience` 解密回填后 `delete row.attrs_enc`，密文不外泄 renderer。
- **迁移幂等守卫可靠**：v8 用 `sqlite_master.sql` 含 `'attrs_enc'` 特征串判定，与 v5/v6/v7 同构；DDL 包 `db.transaction`，throw 即 ROLLBACK；fresh-install（init.ts）与遗留库（v8）两路径 schema 逐字一致。
- **Service 函数式形态合规**：`let MK` + 全 `export function`，无 `export class`，与 knowledgeBaseService.ts 同形态（CONVENTIONS Pattern 1a）。

但发现 **2 个 Critical** 与若干 Warning，集中在：

1. **审计/状态字段越权**：`experience:update` IPC 白名单暴露 `status`/`reuseCount`/`lastVerifiedAt`/`validAt`/`invalidAt`，renderer 可绕过 `invalidateExperience` 直改软失效状态、伪造复用次数 / 校验时间，破坏 bi-temporal 与 audit 语义。
2. **bi-temporal 失效比较的时区/格式陷阱**：`invalid_at > datetime('now','localtime')` 与列默认 `datetime('now','localtime')` 文本比较依赖严格的 `YYYY-MM-DD HH:MM:SS` 同格式可比性，任何带毫秒/偏移的写入会破坏比较；service 未对 `invalidAt` 入参做格式校验。
3. **`truncated` 语义错误（全仓既有，本 phase 沿用）**：`rows.length < total` 在 `offset>0` 第二页恒为 true，误报截断；真正的 MAX_BATCH 截断反而不可观测。
4. **mock DB 测试未如实复刻 bi-temporal `>` 分支**：`invalid_at > datetime(...)` 分支在 mock 中从未被实现，单测靠 `'NOW-MOCK'` 字符串 truthy + `!r.invalid_at` 碰巧通过，**未覆盖真实比较逻辑**——给出虚假安全感。

---

## Critical Issues

### CR-01: experience:update IPC 白名单暴露审计/状态字段，renderer 可越权伪造软失效与复用统计

**File:** `electron/ipc/experienceIpc.ts:61-62`、`electron/services/experienceService.ts:70-81`、`src/types/experience.ts:30-41`

**Issue:**
`ExperienceUpdateInput`（renderer 入参类型）白名单包含 `status` / `validAt` / `invalidAt` / `lastVerifiedAt` / `reuseCount` 五个字段，`updateExperience` 全部透传写库。这绕开了 service 提供的受控入口，破坏多条设计不变量：

- **绕过 `invalidateExperience` 软失效流程**：renderer 可直接 `update(id, { invalidAt: '2026-01-01' })` 把经验标失效，且 `invalidAt` 是任意字符串（CR-02 时区格式问题放大此风险），不经 service 的 `datetime('now','localtime')` 标准化。同理 `update(id, { status: 'invalid' })` 也可直达。
- **伪造 audit 字段**：`reuseCount`（复用次数）与 `lastVerifiedAt`（最后校验时间）是 Phase 11 复用追踪的审计数据，service 提供了专用自增接口 `incReuseCount` / `touchLastVerifiedAt`。允许 renderer 直写意味着可伪造"已校验 1000 次"的虚假可信度，运维误信过期经验。
- **`validAt` 任意回填**：可篡改经验的有效起始时间。

注：`secure(...)` 只做登录鉴权，**任何已登录用户**（单机工具语义下即任何能登录的本地账户）都能调用，无字段级权限隔离。

**Fix:**
将这 5 个字段移出 renderer 可写的白名单。`updateExperience` 拆分为两套入参：renderer 入参（仅业务字段 `title/category/content/tags/attrs`）与特权入参（含状态/审计字段，仅 main 进程内部 service 互调可用）。

```ts
// electron/services/experienceService.ts —— renderer-facing 入参收窄
export interface ExperienceUpdateFields {
  title?: string
  category?: ExperienceCategory
  content?: string
  tags?: string[]
  attrs?: ExperienceAttrs | null
}

// 状态/审计字段保留独立受控接口（已有 invalidateExperience/incReuseCount/touchLastVerifiedAt），
// validAt 若确需 renderer 改，另开专用 channel 并加格式校验。

// electron/ipc/experienceIpc.ts
import type { ExperienceInput, ExperienceUpdateInput, ExperienceListInput } from '...'
// ExperienceUpdateInput 同步收窄（src/types/experience.ts 删 status/validAt/invalidAt/lastVerifiedAt/reuseCount）
ipcMain.handle('experience:update', secure((_e, id: string, fields: ExperienceUpdateInput) =>
  updateExperience(id, fields)))
```

### CR-02: bi-temporal `invalid_at > datetime('now','localtime')` 文本比较缺乏格式契约，service 未校验 invalidAt 入参格式

**File:** `electron/services/experienceService.ts:175`、`electron/services/experienceService.ts:248`、`electron/database/init.ts:305-306`

**Issue:**
bi-temporal 过滤依赖 SQL 文本比较：
```sql
(e.invalid_at IS NULL OR e.invalid_at > datetime('now','localtime'))
```
`datetime('now','localtime')` 返回 `YYYY-MM-DD HH:MM:SS`（无毫秒、无时区偏移）。这要求 `experiences.invalid_at` 列**所有写入值必须是同格式**，文本字典序比较才等价于时间比较。

但当前 service 对 `invalid_at` 写入完全没有格式校验：
- `invalidateExperience`（service 内部）：用 `datetime('now','localtime')` 写入 —— 安全。
- `updateExperience`（CR-01 越权路径）：`fields.invalidAt` 是 `string | null`，renderer 可传入 `'2026-01-01T00:00:00.000Z'`（带 T/Z/毫秒）或 `'2026/01/01'` 等任意字符串，写库后 bi-temporal 比较结果不可预测：
  - `'2026-01-01T...'` 因 `T` (0x54) > 空格 (0x20)，字典序比较会错误判定为"更晚"；
  - 一旦混入两种格式，"列出所有有效经验"会漏判或误判，运维误信已失效经验 / 漏看有效经验 —— 违反核心价值"拓扑准确呈现"。

同理 `validAt` / `lastVerifiedAt` 也有此风险，但 `invalid_at` 直接进 bi-temporal 过滤，危害最大。

**Fix:**
1. service 层对 `validAt` / `invalidAt` / `lastVerifiedAt` 入参强制格式校验（白名单 `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`），非法 throw。
2. 配合 CR-01：禁止 renderer 直写这些字段，仅允许 service 内部用 `datetime('now','localtime')` 写入，从源头杜绝格式不一致。

```ts
// electron/services/experienceService.ts
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
function assertTimestamp(v: string, col: string) {
  if (!TS_RE.test(v)) throw new Error(`${col} 格式必须是 YYYY-MM-DD HH:MM:SS（localtime）`)
}
// updateExperience 内：
if (fields.validAt !== undefined) { assertTimestamp(fields.validAt, 'validAt'); ... }
if (fields.invalidAt !== undefined && fields.invalidAt !== null) {
  assertTimestamp(fields.invalidAt, 'invalidAt'); ...
}
```

---

## Warnings

### WR-01: `truncated` 语义错误（offset>0 第二页恒误报截断；MAX_BATCH 真截断不可观测）

**File:** `electron/services/experienceService.ts:197`、`electron/services/experienceService.ts:210`
**Issue:**
`truncated: rows.length < total`。分页语义下，只要 `offset>0`（第二页及之后），`rows.length` 必然 `< total`（如 total=150，第二页 limit=100，offset=50 → rows.length=100 < 150 → truncated=true，**误报**）。同时真正的 MAX_BATCH 截断（service throw）反而被掩盖（直接抛错不返信封，`truncated` 字段无意义）。

`pagination.ts` 的注释明确："`truncated`: rows 是否被 cap 截断（rows.length < total）" —— 注释与实现一致，但语义本身错误：`rows.length < total` 是"还有更多数据"（hasMore），不是"本次被 cap 截断"（truncated）。

**说明：** 这是**全仓既有模式**（anomalyService.ts:160 / ouiService.ts:65 / networkSegmentService.ts:128 全部同款），非本 phase 引入。本 phase 沿用既有错误语义。鉴于全仓一致性，标 WARNING 而非 BLOCKER，但本 phase 是新代码，理应纠正而非传播错误。

**Fix:**
区分"分页 hasMore"与"cap 截断"两个语义。若 `truncated` 本意是 cap 截断，则只有当 `total > limit` 时为 true（不依赖 offset）：

```ts
// 仅在 total 超过本次 limit（真正被 cap 截断）时为 true
const truncated = total > limit
return { rows, total, truncated }
```

或与全仓对齐修一起（跨 phase 任务）。

### WR-02: mock DB 单测未复刻 bi-temporal `invalid_at > datetime(...)` 比较分支，测试通过是巧合

**File:** `electron/services/experienceService.test.ts:347-350`、`electron/services/experienceService.test.ts:383-385`、`electron/services/experienceService.test.ts:276-278`

**Issue:**
service 的 bi-temporal 过滤 SQL 是 `invalid_at IS NULL OR invalid_at > datetime('now','localtime')`，有两条分支。但 mock DB：

- SELECT 路径（line 348）：`if (/invalid_at\s+IS\s+NULL/i.test(sql)) rows = rows.filter((r) => !r.invalid_at)` —— **只实现了 IS NULL 分支，完全忽略 `> datetime(...)` 分支**。
- UPDATE/WHERE 路径（line 383）：同样 `if (/invalid_at\s+IS\s+NULL/i.test(whereClause)) return !row.invalid_at`。
- COUNT 路径（line 276）：同样。

`invalidateExperience` 在 mock 下写入 `'NOW-MOCK'`（line 215），该字符串 truthy，被 `!r.invalid_at` 过滤掉 —— 测试碰巧通过（line 488-496 `includeInvalid=false 默认过滤已失效`、line 498-504 `includeInvalid=true 包含失效`）。

**这意味着：真实 better-sqlite3 下的 `invalid_at > datetime('now','localtime')` 时间比较逻辑（含 CR-02 的格式陷阱）从未被任何测试覆盖。** 测试给出虚假安全感。配合 CR-02，bi-temporal 比较是本 phase 最高风险点却最缺覆盖。

**Fix:**
mock 应正确复刻 `>` 比较：用一个可解析的 mock 时间戳（如 ISO 数字串）写入 `invalid_at`，filter 时与"当前 mock 时间"做字符串/数值比较，覆盖两条分支（IS NULL 与 `> now`）。或改用 `vitest` 的真实 sqlite（如 `better-sqlite3` 在 vitest 下确有 ABI 冲突，可考虑 `sql.js` / 内存 sqlite 替代，至少覆盖 bi-temporal 比较）。

```ts
// 最小修复：invalidateExperience 写入可比的时间戳，mock filter 做真实比较
// mock 写入侧（UPDATE 分支）：
else if (typeof v === 'string' && v.toLowerCase().startsWith('datetime(')) {
  row[c] = new Date().toISOString().replace('T',' ').slice(0,19) // 真实时间戳
}
// mock 过滤侧：
const nowStr = new Date().toISOString().replace('T',' ').slice(0,19)
if (/invalid_at\s+IS\s+NULL/i.test(sql)) {
  rows = rows.filter((r) => !r.invalid_at || r.invalid_at > nowStr) // 复刻双分支
}
```

### WR-03: `_setExperienceDbGetter` 测试钩子在生产模块导出，无运行期守卫防误用

**File:** `electron/services/experienceService.ts:37-39`

**Issue:**
`_setExperienceDbGetter` 是测试专用 db getter 注入钩子，但作为 `export function` 暴露在生产 bundle 里，**任何能 import 该模块的代码（含 renderer 经 preload 漏洞、或未来恶意 IPC）都能调用**以替换 db getter，让生产 service 读到伪造 DB（数据完整性 / 凭证泄露风险）。

注释 `@internal 测试专用：注入 db getter（生产不调用）` 只是约定，无强制力。对比 `knowledgeBaseService.ts` 直接用 `getDatabase`，无此钩子——本 phase 新引入的测试便利增加了攻击面。

**Fix:**
1. 用 vitest 的模块隔离（`vi.mock('../database/connection', ...)`）替代显式 setter，避免在生产模块暴露可变状态。
2. 或加运行期守卫：仅当 `process.env.NODE_ENV === 'test'` 或 `!app.isPackaged` 时允许注入，否则 throw。

```ts
export function _setExperienceDbGetter(fn: () => Database.Database): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setExperienceDbGetter 仅测试可用')
  }
  dbGetter = fn
}
```

### WR-04: `validateAndStringifyAttrs` 对 troubleshooting 类 `attrs === null` 显式清空时不校验 severity，存在绕过校验路径

**File:** `electron/services/experienceService.ts:98-106`

**Issue:**
校验逻辑：
```ts
if (!attrs || Object.keys(attrs).length === 0) return null  // 空 attrs 直接返 null，不校验
if (category === 'troubleshooting') {
  if (!attrs.severity || !VALID_SEVERITIES.includes(attrs.severity)) throw ...
}
```
对 troubleshooting 类：
- `attrs = {}` 或 `null` 或 `undefined` → 返 null，**不强制 severity**（设计意图：允许 troubleshooting 经验暂不填 severity）。
- `attrs = { symptoms: 'x' }`（非空但无 severity）→ throw。

设计意图本身合理（attrs 可空），但 CLAUDE.md / CONVENTIONS 要求 "troubleshooting 必填 severity/症状/处置"。当前实现允许 troubleshooting 经验**永远不带 severity**（create 时 `attrs` 不传即可），与"必填"契约不符。Phase 8+ 落地 troubleshooting 详情页时，会有大量 `attrs=null` 的 troubleshooting 经验无法被 severity 筛选/排序。

**Fix:**
明确 troubleshooting 的 severity 必填时机：若 Phase 7 数据层就要强制，create/update 时 troubleshooting 类的 attrs 必须非空且含合法 severity。若延后到 Phase 8，在 `experience.ts` DTO 与 service 注释中明确"Phase 7 允许空，Phase 8 强制"，避免规则漂移。

```ts
// 若 Phase 7 即强制：
function validateAndStringifyAttrs(category, attrs) {
  if (category === 'troubleshooting') {
    if (!attrs || !attrs.severity || !VALID_SEVERITIES.includes(attrs.severity)) {
      throw new Error('troubleshooting 类经验 attrs 必须含合法 severity')
    }
    // 可选：同时强制 symptoms / resolution
  }
  if (!attrs || Object.keys(attrs).length === 0) return null
  return JSON.stringify(attrs)
}
```

### WR-05: `experience:listDevices` 的 `ExperienceRelatedDevice` 用开放索引签名 `[key: string]: unknown`，剥离 `_enc` 后仍可能泄露非 `_enc` 后缀的敏感字段

**File:** `electron/ipc/experienceIpc.ts:40-48`、`src/types/experience.ts:79-83`

**Issue:**
`stripEncColumns` 只删 `*_enc` 后缀的 key。当前 `devices` 表敏感列全为 `_enc` 后缀（`password_enc` / `ssh_key_content_enc` / `web_url_enc` 等），剥离后 renderer 不见密文 —— 现状安全。

但 `ExperienceRelatedDevice` 类型用了开放索引签名 `[key: string]: unknown`，等于声明"剥离后剩下什么字段都接受"。这是**防御性脆弱**：未来若 `devices` 表新增非 `_enc` 后缀的敏感列（如 `raw_secret` / `token` / 明文 `notes`），`stripEncColumns` 不会剥，索引签名也不报错，**renderer 会静默拿到新敏感列明文**。

`device:list` 通道（deviceService.rowToDevice）走的是显式字段映射（只挑白名单字段返 renderer），更安全。`experience:listDevices` 用 `SELECT d.*` + 黑名单剥离，是更弱的反向过滤。

**Fix:**
改用白名单正向投影（只返 renderer 确需的设备字段），而非 `SELECT d.*` + 黑名单剥离：

```ts
// service 层
export function listDevicesByExperience(experienceId: string): any[] {
  return db().prepare(
    `SELECT d.id, d.device_type, d.connection_type, d.created_at
     FROM devices d JOIN exp_device_rel r ON d.id = r.device_id
     WHERE r.experience_id = ?`
  ).all(experienceId) as any[]
  // 仅返 renderer 确需字段（设备名经 dec 后再加，避免返密文）
}

// IPC 层去掉 stripEncColumns（白名单已无密文），ExperienceRelatedDevice 收为显式字段 interface
export interface ExperienceRelatedDevice {
  id: string
  device_type?: string
  connection_type?: string
  created_at?: string
}
```

---

## Info

### IF-01: `vitest.config.ts` 的 `server.deps.inline: ['../../electron']` 路径指向仓库外，疑似无效配置

**File:** `vitest.config.ts:10`

**Issue:**
`inline: ['../../electron']` 从项目根 `E:\knowlegdge_base\claude\network_toplogy` 解析为 `E:\knowlegdge_base\electron`（仓库外目录），字面无效。本 phase 把 `electron/**/*.test.ts` 纳入 `include` 后该配置会被实际激活；实测 18 个 experienceService 测试全过（vitest 对 inline 失败降级，不阻塞），但配置本身是 dead config，易误导后人。

**Fix:**
改为 `inline: ['electron']` 或 `'./electron'`（相对项目根），或彻底删除（vitest 默认能解析 `electron/` 下 TS）。

### IF-02: `incReuseCount` / `touchLastVerifiedAt` 为 Phase 11 预埋接口，但无 IPC channel 暴露

**File:** `electron/services/experienceService.ts:310-316`

**Issue:**
两个预埋接口在 service 层导出且有单测覆盖，但 `experienceIpc.ts` 与 `preload.ts` 均未暴露对应 channel。Phase 11 消费时需补 IPC + preload + DTO。当前不算缺陷（预埋意图明确），仅提示后续 phase 不要漏补。

**Fix:**
Phase 11 落地时补 `experience:incReuseCount` / `experience:touchLastVerifiedAt` IPC + preload，且这两个 channel 必须经 `secure(...)` 包装（审计字段写入属特权操作）。

### IF-03: `experienceService.ts` 返回类型全 `any`，DTO 类型断言全在调用侧

**File:** `electron/services/experienceService.ts:128`、`144`、`153`、`224`、`269`、`297`、`304`

**Issue:**
`createExperience(...): any`、`getExperience(...): any | null`、`listExperiences(...): PaginatedResult<any>` 等。`src/types/experience.ts` 定义了 `Experience` / `ExperienceListResult` 等 DTO，但 service 不引用，IPC 层也不做类型桥接（IPC handler 返回 `any`，preload 用 `unknown`）。renderer 侧的类型安全完全依赖 `electron.d.ts` 的声明，与 service 实际返回脱节（如 service 返 `tags: string`（JSON 字符串），DTO 声明 `tags: string[]` —— 类型与运行时不一致）。

注：`tags` 列存 JSON 字符串，`rowToExperience` **未 JSON.parse**，返给 renderer 的是字符串，但 `Experience.tags: string[]` 声明为数组。renderer 直接 `.map` / `.includes` 会崩。

**Fix:**
1. `rowToExperience` 内 `row.tags = JSON.parse(row.tags || '[]')`（与 `attrs` 同处理），让运行时匹配 DTO。
2. service 返回类型用 DTO（`Experience` / `PaginatedResult<Experience>`），或在 IPC 层做 `as Experience` 桥接。

### IF-04: `experience:create` 的 `sourceSessionId` 不校验存在性，依赖 DB FK 约束

**File:** `electron/services/experienceService.ts:140`

**Issue:**
`source_session_id` 插入时不校验是否存在于 `chat_sessions`。`connection.ts:26` 已 `pragma('foreign_keys = ON')`，DB 层 FK 会拦截不存在的 session id 并 throw（被 IPC `secure` 脱敏为"操作失败"）。功能上安全，但错误信息不友好（renderer 收到脱敏后的"操作失败"，不知是 session 不存在）。

**Fix:**
可选：service 层先 `SELECT 1 FROM chat_sessions WHERE id = ?` 校验，throw 业务清晰的"source session 不存在"。或保持现状（FK 拦截足够），仅作 info。

---

_Reviewed: 2026-08-01T14:14:37Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
