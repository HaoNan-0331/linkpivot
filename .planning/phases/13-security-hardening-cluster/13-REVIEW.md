---
phase: 13-security-hardening-cluster
reviewed: 2026-08-09T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - electron/ipc/experienceIpc.ts
  - electron/services/connection.ts
  - electron/services/experienceService.ts
  - electron/utils/authGuard.ts
  - tests/electron/connectSSH.algorithms.real.test.ts
  - tests/unit/authGuard.test.ts
  - tests/unit/experienceListGuard.test.ts
findings:
  critical: 1
  warning: 3
  info: 4
  total: 8
status: issues_found
---

# Phase 13: Code Review Report

**Reviewed:** 2026-08-09
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Phase 13（SEC-03/04/05）三处加固方向正确，但 SEC-04 的 `sanitizeMessage` Unix 正则放宽引入**过度脱敏**缺陷（CR-01），会把含 `/` 的非路径内容（URL、日期、版本号、a/b/c 标识符、分数比例）一并替换成 `[路径]`，污染全 app 所有 IPC 错误透出路径（secure/safe 包装）。SEC-03 的 readyTimeout 统一目标只完成了一半——`testSSHConnection` 仍硬编码 8s 与外部 10s（WR-01）。SEC-05 的 `sanitizeListInput` 实现正确（浅拷贝 + 新数组赋值不污染调用方入参），但测试遗漏了不可变性契约与混合类型 tags 用例。SEC-03 的真路径回归测试质量高（含反向 drift 守卫）。

## Critical Issues

### CR-01: `sanitizeMessage` Unix 正则放宽过度脱敏，污染全 app IPC 错误透出

**File:** `electron/utils/authGuard.ts:22`
**Issue:**

SEC-04 将 Unix 路径正则从枚举前缀 `(?:usr|home|Users|tmp|var|opt)` 放宽为通用绝对路径 `/\/[^\s'"()<>]*/g`。此正则会匹配**任意**以 `/` 开头、后跟非空白非引号非括号字符的子串，远远超出"绝对路径"语义，对以下非路径内容产生误报（全部被替换成 `[路径]`，丢失业务可读性）：

1. **URL**：`'请求失败 http://api.example.com/v1/devices'` → `[路径]`（整段 URL 被吞，运维排障看不到出错的端点）
2. **日期/时间**：`'同步失败 2024/01/15 12:30'` → `[路径]`（运维日志关键时间戳丢失）
3. **版本号/路径式标识**：`'不兼容 v3/4 协议'`、`'模块 net/ip/ssh 加载失败'`（Node 内部模块路径常以 `a/b/c` 形式报错）
4. **分数/比例**：`'quota 3/4 已满'`、`'CPU 95/100'`
5. **正则/路由片段**：`'非法正则 \\d+/\\d+'`、`'路由 GET /api/list 不存在'`（路由路径是业务信息，非文件系统路径，本应透出给运维定位）
6. **文件名相对引用**：`'导入 ./config 失败'`（`./` 也被匹配，虽然语义上是相对路径但本属正常排障信息）

由于 `sanitizeMessage` 经 `secure(...)`/`safe(...)` 包装用于**全 app 所有 IPC handler 的异常透出路径**（authGuard.ts:39/51，且 `experienceDraftingIpc.ts:13`/`experienceIpc.ts:81` 注释都依赖此行为），单点放宽即放大到全 IPC 面——任何 throw 出来的 message 含 `/` 都被破坏。

对比 Windows 路径正则 `/[A-Za-z]:\\[^\s'"()<>]*/g`：要求 `盘符:\\` 前缀，是强信号、几乎无误报。放宽后的 Unix 正则把 `/` 单字符当强信号，误报率数量级上升，破坏了"截断超长 + 移除路径"原本克制的脱敏语义。

phase_context 明确要求评估此风险——结论：**会** mangle 非路径内容，**会**破坏用户需要的合法错误信息（URL/日期/路由是最常见的 IPC 错误可读性载体）。

**Fix:**

收紧正则，要求"绝对路径"应有的特征——以 `/` 开头且后跟至少一个路径段（`/word`），或限定常见根前缀，或要求含 `/` + 路径分隔的连续段（如至少两段 `/X/Y`）：

```ts
function sanitizeMessage(msg: string): string {
  if (!msg) return '操作失败'
  let s = msg
    // Windows 绝对路径：盘符:\... （不变）
    .replace(/[A-Za-z]:\\[^\s'"()<>]*/g, '[路径]')
    // Unix 绝对路径：/ 后跟至少一段路径（/word[/word]*），过滤掉孤立的 / 分隔符
    // 如 /app/db/main.db /home/x/y 命中；URL 的 //api、日期 2024/01、比例 3/4 不命中
    .replace(/\/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g, '[路径]')
  if (s.length > 200) s = s.slice(0, 200) + '...'
  return s
}
```

或保留枚举前缀但补全部署路径（保守方案，零误报）：

```ts
.replace(/\/(?:usr|home|Users|tmp|var|opt|app|data|root|private|etc|srv|mnt|media|run|proc|sys)(?:\/[^\s'"()<>]*)?/g, '[路径]')
```

并在 `tests/unit/authGuard.test.ts` 补反向回归：URL/日期/路由/分数等含 `/` 的非路径内容**不被**替换成 `[路径]`（当前测试只验证 `/app/db/main.db` 命中，缺反向覆盖，是本缺陷漏检的根因）。

## Warnings

### WR-01: SEC-03 readyTimeout 统一目标只完成一半——`testSSHConnection` 仍硬编码 8s

**File:** `electron/services/connection.ts:277`
**Issue:**

phase_context 与 sshConfig.ts:3-6 注释声明 SEC-03 把 `readyTimeout` 10s→`SSH_READY_TIMEOUT_MS`(30s) 以"防两路径数值漂移"。但 diff 显示只改了 `connectSSH`（line 115），`testSSHConnection` 仍 `readyTimeout: 8000`（line 277，硬编码魔术数字，无注释解释为何不统一），且其外部兜底 `setTimeout(..., 10000)`（line 252-255）也仍硬编码 10s。

后果：
- sshConfig.ts 注释里"慢设备 10-30s 区间握手触发 readyTimeout"的 bug 在 **测试连接** 路径依然存在——`testSSHConnection` 的 8s readyTimeout 比正式 `connectSSH` 的 30s 更短，用户点"测试连接"对慢设备返回"连接超时"但点"连接"反而成功，行为不一致。
- "防两路径数值漂移"的承诺未兑现：现在仓库里有 30s / 8s / 10s / arpCollector 的外部 `timeout` 共 4 个 readyTimeout 语义值。

**Fix:**

要么把 `testSSHConnection` 的 `readyTimeout` 也统一到 `SSH_READY_TIMEOUT_MS`（如果测试连接也允许慢设备），要么在 line 277 加显式注释说明"测试通道故意短超时快速失败，外部 setTimeout 10s 是 readyTimeout+余量"并抽取测试专用常量：

```ts
// 测试通道故意短超时（快速失败给用户即时反馈），非复用 SSH_READY_TIMEOUT_MS
const TEST_SSH_READY_TIMEOUT_MS = 8000
// ... 外部兜底 = readyTimeout + 余量
const timer = setTimeout(() => { ... }, TEST_SSH_READY_TIMEOUT_MS + 2000)
```

并在 SEC-03 计划文档里如实记录"测试通道豁免统一"决策（当前 phase 描述未提及此豁免，与代码不符）。

### WR-02: SEC-04 测试缺反向回归——未验证放宽正则不误伤含 `/` 的非路径内容

**File:** `tests/unit/authGuard.test.ts:100-113`
**Issue:**

新增的 SQL 错误脱敏测试（line 100）只验证 `/app/db/main.db` 被 sanitize 成 `[路径]`（正向命中），完全没有反向 case 验证"含 `/` 但非路径的内容（URL/日期/路由/比例）保持原样"。正是这个测试盲区让 CR-01 的过度脱敏漏检。

`secure sanitizes Unix absolute path from error`（line 36）同样只验证 `/home/operator/config/key.pem` 命中。

**Fix:**

补反向回归（在 sanitizeMessage 行为修复后）：

```ts
it('secure preserves URL / date / ratio content (非路径的 / 不被误吞)', async () => {
  setAuthenticated(true)
  const wrapped = secure(() => { throw new Error('请求 https://api.example.com/v1 失败，2024/01/15 同步异常，quota 3/4') })
  try {
    await wrapped({})
    expect.unreachable('should have thrown')
  } catch (e: unknown) {
    const msg = (e as Error).message
    // 修复后正则不应吞 URL/日期/比例
    expect(msg).toContain('api.example.com')
    expect(msg).toContain('2024/01/15')
    expect(msg).toContain('3/4')
  }
})
```

### WR-03: `sanitizeListInput` tags 处理不验证非 string 元素，且测试缺不可变性 + 混合类型用例

**File:** `electron/ipc/experienceIpc.ts:91-96` + `tests/unit/experienceListGuard.test.ts`
**Issue:**

`sanitizeListInput` 的 tags map（line 93-95）对每个元素用 `typeof tag === 'string'` 守卫后才 slice，**非 string 元素（数字/null/对象）原样透传**。下游 `listExperiences`（experienceService.ts:317-320）对每个 tag 做 `t.replace(/\\/g, ...)`——若 tag 是非 string（如 number 或 null），`.replace` 会 throw `t.replace is not a function`，整个 list 请求崩溃。untrusted renderer 可传 `tags: [123, null]` 触发。

即 IPC 层钳制未保证"tags 是 string[]"不变量，把崩溃面下沉到 service 层的 `.replace`。

另：测试未覆盖
- (a) **不可变性契约**——验证调用方原始 `opts.tags` / `opts.search` 不被 mutate（实现靠浅拷贝 + 新数组赋值达成，但无测试锁定）；
- (b) **混合类型 tags**（`[123, 'normal', null]`）的行为；
- (c) **`tags` 为非数组**（如 string `"a,b"`）时不进入钳制分支正常透传（当前 `Array.isArray` 守卫了，但无测试）。

**Fix:**

IPC 层钳制时过滤非 string 或强制 `String(tag)`：

```ts
if (Array.isArray(sanitized.tags)) {
  const capped = sanitized.tags.length > 20 ? sanitized.tags.slice(0, 20) : sanitized.tags
  sanitized.tags = capped
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => (tag.length > 30 ? tag.slice(0, 30) : tag))
}
```

测试补：

```ts
it('调用方原始 opts 不被 mutate（不可变性契约）', () => {
  const input = { tags: Array.from({ length: 30 }, (_, i) => `t${i}`), search: 'x'.repeat(200) }
  const snapshot = { tags: [...input.tags], search: input.search }
  sanitizeListInput(input)
  expect(input.tags.length).toBe(snapshot.tags.length) // 原数组未被截断
  expect(input.search).toBe(snapshot.search)            // 原字符串未被 slice
})

it('混合类型 tags 过滤非 string 后透传 string[]', () => {
  const out = sanitizeListInput({ tags: [123, 'ok', null, 'good'] as any })
  expect(out.tags).toEqual(['ok', 'good']) // 或按修复语义显式断言
})
```

## Info

### IN-01: `testSSHConnection` 内联算法常量虽已替换为 `SSH_ALGORITHMS`，但 `readyTimeout: 8000` 与 SEC-03 统一目标矛盾（与 WR-01 同根，独立计为一致性 info）

**File:** `electron/services/connection.ts:273-279`
**Issue:** 同 WR-01，作为代码可读性维度补充：line 277 的魔术数字 `8000` 与外部 `setTimeout(..., 10000)`（line 254）的魔术数字 `10000` 应抽常量，避免"为何是 8s 不是 30s"在代码里无答案。
**Fix:** 见 WR-01。

### IN-02: `VALID_SEVERITIES as readonly string[]` 类型断言冗余

**File:** `electron/ipc/experienceIpc.ts:102`
**Issue:** `VALID_SEVERITIES` 已 `as const` 导出（experienceService.ts:54），类型是 `readonly ['critical', 'high', ...]`。`.includes(sanitized.severity)` 直接调用在严格 TS 下因 `readonly string[]` 的 `.includes` 形参为字面量联合会有类型窄化报错，故用 `as readonly string[]` 绕开——合理，但 service 层内部多处（assertTroubleshootingAttrs line 64、validateAndStringifyAttrs line 178、backfillSeverityFromHistory line 503）直接 `.includes(sev)` 未做此断言却编译通过，说明 `attrs?.severity` 是 `any`（无类型约束）。两处风格不一致。

非 bug（运行时正确），仅信息项：建议要么 export 一个 typed helper `isValidSeverity(v: unknown): v is Severity` 收口类型断言，要么把 service 内部几处也补类型守卫统一风格。

**Fix:**

```ts
// experienceService.ts
export function isValidSeverity(v: unknown): v is typeof VALID_SEVERITIES[number] {
  return typeof v === 'string' && (VALID_SEVERITIES as readonly string[]).includes(v)
}
// experienceIpc.ts 与 service 内部统一调 isValidSeverity(sanitized.severity)
```

### IN-03: `sanitizeListInput` severity throw 对非 string 类型（number/object）行为未测试

**File:** `electron/ipc/experienceIpc.ts:99-105` + `tests/unit/experienceListGuard.test.ts:79-81`
**Issue:** 当 `sanitized.severity` 是数字或对象时，`.includes()` 返回 false → throw `'severity 非法'`（运行时正确，防御有效），但测试只覆盖 `'BOGUS'` 字符串非法值，未验证非 string 类型也走 throw 分支。
**Fix:** 补一例 `sanitizeListInput({ severity: 123 as any })` 应 throw。

### IN-04: `connectSSH.algorithms.real.test.ts` 反向回归用硬编码 legacy 表，与 SSH_ALGORITHMS 漂移

**File:** `tests/electron/connectSSH.algorithms.real.test.ts:163-198`
**Issue:** 反向回归 `it`（line 159）把改造前的内联算法表整段硬编码进测试，作为"drift 危害锁定"。这是合理的测试设计（验证"缺 curve25519 必失败"），但 legacy 表是**测试内独立维护的副本**——未来 SSH_ALGORITHMS 演进时，这个 legacy 表不会跟着变，反向 case 的语义会与生产现实脱节（如 SSH_ALGORITHMS 删了 curve25519，legacy 表仍是旧表，反向 case 仍 pass 但已不能代表"生产回退"的危害）。

非 bug，信息项：建议在 legacy 表上方注释显式标注"此表为 connection.ts 改造前 git 快照（commit XXX），永不动；仅作 KEX 失败反向锚点，不代表当前生产算法集"，避免后续维护者误改。

**Fix:** 注释加固（已部分有，line 160-162 可补 git commit hash 引用锚定快照版本）。

---

_Reviewed: 2026-08-09_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
