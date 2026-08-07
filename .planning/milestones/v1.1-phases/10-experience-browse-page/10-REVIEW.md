---
phase: 10-experience-browse-page
reviewed: 2026-08-05T00:00:00Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - electron/database/init.ts
  - electron/database/migrations.ts
  - electron/ipc/experienceIpc.ts
  - electron/preload.ts
  - electron/services/__tests__/experienceService.browse.test.ts
  - electron/services/experienceService.test.ts
  - electron/services/experienceService.ts
  - src/components/knowledge/ExperienceDetailModal.tsx
  - src/components/knowledge/ExperienceEditForm.tsx
  - src/components/knowledge/ExperienceTab.tsx
  - src/components/pages/ai/ReviewConfirmModal.tsx
  - src/components/pages/KnowledgeBasePage.tsx
  - src/types/electron.d.ts
  - src/types/experience.ts
findings:
  critical: 2
  warning: 9
  info: 4
  total: 15
status: issues_found
---

# Phase 10: Code Review Report

**Reviewed:** 2026-08-05
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

Phase 10「经验浏览页」14 文件评审。整体架构对齐项目红线（IPC 全 `secure(...)` 包装、SQL 参数化、字段加密走 `encField/decField`、迁移幂等守卫、受控接口绕 CR-01 白名单）落地基本到位。但发现 **2 个 BLOCKER**：

1. **`restoreExperience` 缺状态守卫** — 接口对任意 id（含 `status='draft'` 的草稿）强制写 `status='published'`，绕过 Phase 9 红线③ session→permanent 唯一人工闸口（confirmDrafts 质量门），可被 renderer 滥用让 draft 直接发布，破坏不变量。
2. **`listExperiences` severity 筛选对历史 fallback 数据漏筛** — 浏览页选「严重度=高」看不到 severity 列 NULL 但 `attrs.severity='high'` 的历史数据，与 UI-SPEC「保证历史数据可查」承诺矛盾（注释承认是已知限制，但用户无感知，属功能性缺陷）。

另发现 9 个 WARNING（tags LIKE 通配符未转义、关联设备 diff 非原子并发、`relateDevices.length >= 0` 永真条件、列表请求竞态、`formatTs` 对 ISO 时间戳显示异常、IPC 入参缺枚举校验等）与 4 个 INFO。建议至少修复 2 个 BLOCKER 后再合入。

---

## Critical Issues

### CR-01: `restoreExperience` 缺状态守卫，draft 可经 restore 绕过 confirmDrafts 质量门直接发布

**File:** `electron/services/experienceService.ts:421-427`，关联 `electron/ipc/experienceIpc.ts:82-83`

**Issue:**
`restoreExperience` 的 UPDATE 语句无条件强制 `status='published'`：

```typescript
export function restoreExperience(id: string): any {
  const conn = db()
  conn.prepare(
    `UPDATE experiences SET invalid_at = NULL, status = 'published', updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(id)
  return getExperience(id)
}
```

`WHERE` 子句只有 `id = ?`，没有 `AND status = 'invalid'`（或 `invalid_at IS NOT NULL`）守卫。renderer（或任何调用 `experience:restore` IPC 的代码）传入一个 `status='draft'` 且 `invalid_at=NULL` 的草稿 id 时，草稿会被直接改成 `published`，**绕过 Phase 9 红线③「session→permanent 唯一人工闸口 = confirmDrafts」**与 `assertTroubleshootingAttrs` 质量门。注释（419 行）声称「T-10-03 mitigate：status 直回 'published' 不接受 renderer 入参（无 status 参数），无法被滥用改其他状态」——这只挡了"改成 draft/invalid"，没挡"从 draft 改成 published"。受控接口的"受控"语义被破坏。

设计意图（与 `invalidateExperience` 对称）只在「失效→恢复」场景。但代码实现对所有状态生效。

**Fix:**
加状态守卫，仅对已失效（`invalid_at IS NOT NULL`）的经验生效；并对草稿/不存在 id 抛错（与 confirmDrafts 的「草稿不存在 throw」语义对齐），避免静默越权：

```typescript
export function restoreExperience(id: string): any {
  const conn = db()
  const cur = conn.prepare(
    'SELECT status, invalid_at FROM experiences WHERE id = ?'
  ).get(id) as { status: string; invalid_at: string | null } | undefined
  if (!cur) throw new Error(`经验不存在: ${id}`)
  if (cur.status === 'draft') {
    throw new Error('草稿不可经 restore 发布，请走 confirmDrafts 质量门')
  }
  if (!cur.invalid_at) {
    throw new Error('经验当前有效，无需恢复')
  }
  conn.prepare(
    `UPDATE experiences SET invalid_at = NULL, status = 'published', updated_at = datetime('now','localtime')
     WHERE id = ? AND invalid_at IS NOT NULL`
  ).run(id)
  return getExperience(id)
}
```

单测 `experienceService.browse.test.ts` 同步补一条「draft 调 restore 抛错」用例。

---

### CR-02: severity 直筛漏掉历史 fallback 数据，浏览页「严重度」筛选结果不一致

**File:** `electron/services/experienceService.ts:283-286`，消费方 `src/components/knowledge/ExperienceTab.tsx:99`（severity Select）

**Issue:**
`listExperiences` 的 severity 过滤：

```typescript
if (opts.severity) {
  conditions.push('e.severity = ?')
  params.push(opts.severity)
}
```

只筛明文 `severity` 列。但 `rowToExperience` 的 severity fallback（211-213 行）保证「读」时历史数据（severity 列 NULL、`attrs.severity` 有值）能显示 severity；**「筛」时这些历史行被漏掉**。结果：用户在浏览页看到一条历史经验 severity Tag 显「高」，但用 severity 筛选器选「高」却查不到这条——UI 显示与筛选行为矛盾。

注释（281-282 行）承认这是"已知限制"，并将 D-10-2「保证历史数据可查」自我解释为"指 fallback 读而非 fallback 筛"。但从产品视角，浏览页核心场景「按严重度排查故障」对历史 troubleshooting 经验失效，且 UI 不会向用户提示"此筛选不含历史数据"，属功能性数据完整性问题，不是可接受的"已知限制"。Phase 11 检索也会复用此列。

**Fix:**
两选一（推荐方案 A）：

方案 A（治本，扩 WHERE 覆盖 fallback）：severity 列已建索引但 attrs_enc 加密无法 SQL 直筛。改用写入时一次性回填（迁移补丁）或在 create/update 时双写后异步回填历史行：

```typescript
// 一次性回填脚本（启动时或迁移 v11 内执行，幂等）
const backfill = conn.prepare(
  `UPDATE experiences
   SET severity = json_extract(
     -- attrs_enc 需在 MK 注入后解密；此回填须放 setExperienceMasterKey 之后
     ..., 'severity')
   WHERE severity IS NULL AND ...`
)
```
（受限于迁移在 MK 注入前跑的 caveat，需另起 post-MK 启动钩子执行回填。）

方案 B（治标，扩筛选条件）：双分支 OR——明文列匹配 OR（severity 列 NULL AND attrs 解析后命中）。但 attrs_enc 加密无法 SQL 解析，须先解密回填或拉到 service 层后过滤（牺牲 SQL 分页 total 准确性）。

最低限度：UI 在 severity 筛选器旁加提示「仅含明文 severity 列数据，历史经验需先编辑保存以回填」。但这是 UI 兜底，非治本。

建议优先方案 A 的"create/update 双写已落地，补一次性回填"路径。

---

## Warnings

### WR-01: tags LIKE 多选拼接未转义 `%`/`_` 通配符 + 含 `"` 标签匹配失败

**File:** `electron/services/experienceService.ts:288-292`

**Issue:**
```typescript
if (opts.tags && opts.tags.length > 0) {
  const ors = opts.tags.map(() => 'e.tags LIKE ?')
  conditions.push(`(${ors.join(' OR ')})`)
  opts.tags.forEach((t) => params.push(`%"${t}"%`))
}
```
两个问题：
1. **通配符未转义**：tag 值原样拼到模式串。tag=`100%` → 模式 `%"100%"%`，`%` 被当 LIKE 通配符，匹配几乎所有含 `"100` 的 tags 列，返回错误结果集。tag=`a_b` 同理把 `_` 当单字符通配。
2. **含 `"` 的 tag 匹配失败**：tag=`a"b` → 模式 `%"a"b"%`，JSON 字符串里的 `"a"b"` 找不到此模式，漏筛。

参数化已挡住 SQL 注入（T-10-01 mitigate 生效），但语义正确性破坏。

**Fix:**
转义 `%`/`_`/`\` 三类 LIKE 元字符（SQLite ESCAPE 子句），并改用更稳健的 JSON 模式匹配（如 `json_each` 或 `exists` 子查询）：

```typescript
if (opts.tags && opts.tags.length > 0) {
  const ors = opts.tags.map(() => "e.tags LIKE ? ESCAPE '\\'")
  conditions.push(`(${ors.join(' OR ')})`)
  opts.tags.forEach((t) => {
    const esc = t.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    params.push(`%"${esc}"%`)
  })
}
```
（含 `"` 的 tag 仍需额外处理，建议长期改用 `EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)` 子查询彻底解决。）

---

### WR-02: `syncRelateDevices` 用 `Promise.all` 并发执行 relate/unrelate IPC，非原子，部分失败留半成品状态

**File:** `src/components/knowledge/ExperienceTab.tsx:177-191`，调用点 `handleSubmitEdit:201-207`

**Issue:**
```typescript
await Promise.all([
  ...toAdd.map((id) => window.api.experience.relateDevice(expId, id)),
  ...toRemove.map((id) => window.api.experience.unrelateDevice(expId, id)),
])
```
关联设备 diff 用 N 条独立 IPC 并发，每条独立走 `secure` 鉴权 + 独立 `INSERT OR IGNORE`/`DELETE`。任一 IPC 失败（网络抖动、权限降级、DB 锁）→ Promise.all reject，但已成功的 IPC 不可回滚，留下「加了 2 个、删了 1 个、剩 3 个没删」的半成品关联状态。renderer 的 `message.error('保存失败')` 误导用户以为整体未改，但实际关联已被部分修改。

且 `handleSubmitEdit` 先 `experience.update(...)` 再 `syncRelateDevices`：update 成功、sync 失败时，字段已落库但关联错乱，状态不一致。

对比 Phase 9 `confirmDrafts` 用单事务包 relateDevices diff（service 层 `conn.transaction`）——Phase 10 路径却丢了原子性。

**Fix:**
新增一个 service 层受控接口 `setExperienceDevices(expId, expectIds[])`，在单事务内 diff + INSERT/DELETE，IPC 单次调用：

```typescript
export function setExperienceDevices(expId: string, expectIds: string[]): void {
  const conn = db()
  const tx = conn.transaction(() => {
    const cur = conn.prepare(
      'SELECT device_id FROM exp_device_rel WHERE experience_id = ?'
    ).all(expId).map((r: any) => r.device_id)
    const expect = new Set(expectIds)
    for (const id of expectIds.filter((x) => !cur.includes(x))) relateDevice(expId, id)
    for (const id of cur.filter((x) => !expect.has(x))) unrelateDevice(expId, id)
  })
  tx()
}
```
渲染层改为单次 `window.api.experience.setDevices(expId, nextIds)`。

---

### WR-03: `relateDevices.length >= 0` 是永真条件，编辑态每次提交都触发关联同步

**File:** `src/components/knowledge/ExperienceTab.tsx:205`

**Issue:**
```typescript
if (relateDevices && relateDevices.length >= 0) {
  await syncRelateDevices(editingExp.id, relateDevices)
}
```
`Array.length >= 0` 恒为 `true`（数组长度不可能为负）。条件等价于 `if (relateDevices)`，但代码意图（与新增态 `length > 0` 对照）应是"编辑态总是全量覆盖关联"。可读性陷阱：后续维护者会误以为有"length===0 不触发"的语义。

更深层问题：`ExperienceEditForm` 编辑态预填了现有关联设备（`useEffect` 调 `listDevices` 回填 `relateDevices`），用户未动关联就保存 → 触发 syncRelateDevices，虽然 diff 为空集（无 IPC 实际效果），但多一次 `listDevices` 往返。

**Fix:**
明确语义为"全量覆盖"，去掉永真条件：

```typescript
if (relateDevices) {
  await syncRelateDevices(editingExp.id, relateDevices)
}
```
或保留 length 检查但改为显式 `relateDevices.length > 0 || editingExp !== null`。

---

### WR-04: `loadExperiences` 无请求竞态保护，快速切换筛选可能显示过期列表

**File:** `src/components/knowledge/ExperienceTab.tsx:121-143, 146-155`

**Issue:**
防抖 300ms 触发 `loadExperiences`，但未取消上一个 in-flight 的 `window.api.experience.list`。连续切换筛选时多个 Promise 并发，后发先至（旧请求晚返回）会让 `setList(res.rows)` 覆盖为新数据后再被旧数据覆盖，UI 显示与筛选条件不一致。

**Fix:**
引入请求序号或 AbortController 守卫：

```typescript
const reqIdRef = useRef(0)
const loadExperiences = async () => {
  const reqId = ++reqIdRef.current
  setLoading(true)
  try {
    const res = await window.api.experience.list(opts)
    if (reqId !== reqIdRef.current) return // 旧请求，丢弃
    setList(res.rows.filter((r) => r.status !== 'draft'))
  } catch (err) {
    if (reqId !== reqIdRef.current) return
    message.error(...)
  } finally {
    if (reqId === reqIdRef.current) setLoading(false)
  }
}
```

---

### WR-05: `formatTs` 对 ISO 时间戳（含 `T`/`Z`）显示异常

**File:** `src/components/knowledge/ExperienceDetailModal.tsx:42-46`，`src/components/knowledge/ExperienceTab.tsx:79-82`

**Issue:**
```typescript
function formatTs(ts?: string | null): string {
  if (!ts) return ''
  return ts.length >= 16 ? ts.slice(0, 16) : ts
}
```
假设输入是 `'YYYY-MM-DD HH:MM:SS'`（空格分隔），slice(0,16) 得 `'YYYY-MM-DD HH:MM'`。但若上层（或其他写入路径）传入 ISO `'2026-08-05T12:00:00.000Z'`，slice(0,16) 得 `'2026-08-05T12:00'`，**含字面 `T` 分隔符直接渲染给用户**，且不转本地时区。虽然 service 层当前所有写入都走 `datetime('now','localtime')`（合规），但 `formatTs` 作为 UI 兜底没有鲁棒性——未来某条路径混入 ISO 时间戳会直接显示乱码。

**Fix:**
显式 parse + 本地化格式化（容忍两种输入）：

```typescript
function formatTs(ts?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
```

---

### WR-06: IPC 入参 `severity`/`tags`/`search` 未在 service 或 IPC 层校验类型与长度

**File:** `electron/ipc/experienceIpc.ts:62-63`，`electron/services/experienceService.ts:275-292`

**Issue:**
`experience:list` 经 `secure((_e, opts?: ExperienceListInput) => listExperiences(opts || {}))` 透传。`opts.severity` 不校验是否在 `VALID_SEVERITIES` 枚举内（renderer 可传 `severity: ' FoO '` 或超长字符串）；`opts.search` 不限长度（renderer 可传 100KB 字符串做 LIKE 模式，DB 仍执行但 CPU 浪费）；`opts.tags` 数组不校验元素类型/上限。

虽然 SQL 参数化挡住了注入，但缺类型校验让 untrusted renderer 可发起廉价 DoS（超长 search LIKE 全表扫描）。CLAUDE.md「批量上限模块常量 MAX_BATCH=1000」红线对 list 已守 limit，但对 search/tags 输入维度未守。

**Fix:**
service 层 `listExperiences` 入口加轻量校验：

```typescript
if (opts.severity && !VALID_SEVERITIES.includes(opts.severity as any)) {
  throw new Error(`非法 severity: ${opts.severity}`)
}
if (opts.search && opts.search.length > 200) {
  throw new Error('search 关键词过长（上限 200 字符）')
}
if (opts.tags && opts.tags.length > 50) {
  throw new Error('tags 筛选上限 50 个')
}
```

---

### WR-07: `isValid`/`isInvalid` 时间判定函数在 DetailModal 与 Tab 各自定义且语义分散

**File:** `src/components/knowledge/ExperienceDetailModal.tsx:48-53`，`src/components/knowledge/ExperienceTab.tsx:84-89`

**Issue:**
两处独立实现 `invalid_at` 时间判定逻辑（`> Date.now()` vs `<= Date.now()`），逻辑互补但代码重复，且都依赖 `new Date(ts.replace(' ', 'T')).getTime()` 的浏览器时区解释。service 层已有 `listExperiences` 的 `invalid_at > datetime('now','localtime')` 服务端过滤（CR-02 格式契约），但 renderer 又各自重新实现一遍客户端判定，存在三方（service SQL / DetailModal / Tab）漂移风险。一旦某处改判定规则（如引入时区偏移容忍），另两处不会同步。

**Fix:**
抽公共 util `src/utils/experienceValid.ts`，单一来源：

```typescript
export function isExperienceInvalid(exp: { invalid_at?: string | null }): boolean {
  if (!exp.invalid_at) return false
  const t = new Date(exp.invalid_at.replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return false
  return t <= Date.now()
}
```
DetailModal 与 Tab 都 import 此函数。

---

### WR-08: `experienceService.browse.test.ts` 与 `experienceService.test.ts` 重复 ~400 行 MemDb mock

**File:** `electron/services/__tests__/experienceService.browse.test.ts:53-484`，`electron/services/experienceService.test.ts:86-530`

**Issue:**
两个测试文件各自维护一份 `MemDb` 类（tokenizeValues / INSERT/UPDATE/DELETE/SELECT/COUNT 模拟逻辑），browse 版本扩展了 `applyConditions` 支持新筛选条件。两份代码 ~80% 重叠。任一 service 查询语句形态变化（如改 LIMIT/OFFSET 注入位置）需同步改两个文件，维护负担高。browse 版本（630 行）几乎是主版本（1122 行）的子集 + 扩展，未复用。

**Fix:**
抽 `electron/services/__tests__/__mocks__/memDb.ts` 共享 MemDb 类，两个测试文件 import 并按需扩展（browse 测试通过子类或 options 注入额外条件匹配规则）。

---

### WR-09: `stripEncColumns` 在 WR-05 修复后已是死代码（IPC 层冗余兜底）

**File:** `electron/ipc/experienceIpc.ts:50-58, 94-95`

**Issue:**
注释（47-49 行）说明：`listDevicesByExperience` 已改走 `deviceService.getDeviceById`（rowToDevice 白名单投影），返回的 Device DTO 不含 `_enc` 列。`stripEncColumns` 在此场景"实际无操作"。代码保留作"深度防御"，但 `listDevices` 是唯一调用点，且调用点的输入已确保无 `_enc` 列——这是真正的死代码（永远不会剥离任何 key）。

如果未来 device 域 rowToDevice 误返密文残留，正确做法是修 rowToDevice 而非在 experience IPC 层加一层兜底黑名单（黑名单只能挡 `_enc` 后缀，挡不住未来 device 域新增的非 `_enc` 敏感列——这正是 WR-05 想避免的反模式）。

**Fix:**
删除 `stripEncColumns`，`experience:listDevices` 直接返 `listDevicesByExperience(experienceId)`：

```typescript
ipcMain.handle('experience:listDevices', secure((_e, experienceId: string) =>
  listDevicesByExperience(experienceId)))
```

---

## Info

### IN-01: `confirmDrafts` service 校验 + IPC 校验双层 `MAX_BATCH` 重复但一致

**File:** `electron/services/experienceService.ts:497-499`，`electron/ipc/experienceIpc.ts:100-105`

双层防御（IPC 层 `> MAX_BATCH` throw + service 层 `> MAX_BATCH` throw）符合 T-09-06 mitigate 设计意图，非冗余 bug。但 IPC 层错误信息「批量上限 ${MAX_BATCH} 条（或入参无效）」与 service 层「批量上限超过 MAX_BATCH（${MAX_BATCH}）」文案不一致，建议统一。Info 级。

---

### IN-02: `ExperienceEditForm.useEffect` 拉设备候选缺 AbortController，组件卸载后 setState 无害但欠规范

**File:** `src/components/knowledge/ExperienceEditForm.tsx:103-111, 114-126`

React 18 已不再 warn「setState on unmounted」，但项目其他模块（KnowledgeBasePage.tsx:42-56）用 AbortController 取消在途请求是既定范式。建议统一。Info 级。

---

### IN-03: `KnowledgeBasePage` Tabs 切回 docs 不卸载 ExperienceTab，长时间会话占用内存

**File:** `src/components/pages/KnowledgeBasePage.tsx:480-485`

`expTabLoaded` 一旦 true 不再回退，ExperienceTab 挂载后即使切回 docs Tab 也保持挂载（保留 state/list）。符合懒加载语义，但若用户希望"切走即释放"，可加 `destroyInactiveTabPane`。属设计取舍，Info 级。

---

### IN-04: `migrations.ts` v10 注释解释「迁移在 MK 注入前跑，无法回填 severity」与 CR-02 修复路径相关

**File:** `electron/database/migrations.ts:263-281`

v10 注释准确说明了"为何不在迁移内回填 severity"的技术约束（MK 未注入）。但此约束直接导致 CR-02（severity 筛选漏历史数据）。建议 v10 注释末尾加一句「历史 severity 回填由 post-MK 启动钩子负责（见 CR-02 修复）」，建立迁移 → 回填的追溯链。Info 级。

---

_Reviewed: 2026-08-05_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
