# Phase 13: Security Hardening Cluster - Pattern Map

**Mapped:** 2026-08-09
**Files analyzed:** 6 个生产改动锚点 + 3 个测试新增锚点（SEC-04 L2/L3/L4 子项文件待 researcher/planner 据审计 finalize，见下表注脚）
**Analogs found:** 全部命中（含 1 项 exact：SEC-03 `connectSSH` 的 sibling `buildSSHConfig` 已是同改法的成品）

> **本 phase 性质：加固不重写。** 三红线（IPC `secure`/`safe` 鉴权 / 字段加密 `_enc` / `commandSafety.isCommandAllowed`）不可回退。改动以「复用既有常量 / IPC 网关层补校验 / 兑现已有 safe 包装」为主，新增业务逻辑极少。下表 analog 多为本仓既有「同改法成品」或「同域近邻」，planner 可直接照抄范式。

---

## File Classification

| 新增/修改文件 | SEC 项 | 角色 | 数据流 | 最接近的 analog | 匹配质量 |
|---------------|--------|------|--------|-----------------|----------|
| `electron/services/connection.ts` `connectSSH:107-205` | SEC-03 | service | request-response（SSH 握手 + 流） | `electron/services/ai.ts:306-322 buildSSHConfig`（已复用 `SSH_ALGORITHMS`+`SSH_READY_TIMEOUT_MS` 的 sibling 成品） | **exact**（同改法：内联 algorithms 表 → 常量，SEC-03 就是把 `connectSSH` 拉齐 `buildSSHConfig`） |
| `electron/utils/sshConfig.ts`（只读参照，不改） | SEC-03 | config（常量） | — | — | — |
| `electron/ipc/experienceIpc.ts` `experience:list` handler:64-65 | SEC-05 | middleware（IPC 网关层校验） | request-response | `electron/ipc/ouiIpc.ts:9-11`（`validateLimit` 网关层校验）+ `electron/ipc/experienceIpc.ts:107-112`（confirmDrafts IPC 层 `length > MAX_BATCH` throw 双层防御）+ `electron/ipc/anomalyIpc.ts:24`（`ids.length > 10000` throw） | **role-match**（同「IPC 网关层入参校验 throw/钳制」范式，三处先例合并参照） |
| `electron/services/experienceService.ts` `listExperiences:258` | SEC-05（不动/可能微调注释） | service | CRUD | 自身既有 `listExperiences:258-264` limit 守卫（MAX_BATCH 兜底，D-13-7 保留不删） | exact（自身，仅保留现有兜底） |
| `electron/utils/authGuard.ts` `secure`/`safe` | SEC-04 L6 | middleware（IPC 鉴权网关） | request-response | 自身既有 `secure`/`safe`/`sanitizeMessage`（加固对象，三红线之一不可削弱） | exact（自身加固，参照既有未登录 reject 行为） |
| `electron/services/auth.ts` + `electron/main.ts:152-160` auth:* IPC | SEC-04 L4 Login（待 researcher finalize） | service + IPC 注册 | request-response | 自身既有 `login`/`failedAttempts` 锁定 + `auth:*` 已 `safe` 包装 | exact（自身加固，参照既有锁定/口令强度范式） |
| `electron/services/auth.ts` captcha（`generateCaptcha`/`verifyCaptcha`） | SEC-04 L3 captcha（待 researcher finalize） | service | request-response | 自身既有 captcha 逻辑（CSPRNG + 5min 过期 + 一次一删） | exact（自身，参照既有 CSPRNG 范式） |
| `electron/services/ai.ts` + `electron/main.ts:192` `ai:chat` | SEC-04 L2 ai limit（待 researcher finalize） | service + IPC 注册 | event-driven（流式 AI） | 自身既有 `ai:chat` secure 包装 + `commandSafety.isCommandAllowed`（红线③，不可绕过） | exact（自身，限流若涉执行链不可绕 commandSafety） |
| `src/components/Login.tsx` | SEC-04 L4（renderer 侧，待 finalize） | component | request-response | 自身既有 Login 组件 | exact（自身） |
| `tests/unit/experienceService.listGuard.test.ts`（新增，名暂定） | SEC-05 测试（D-13-8） | test | CRUD（mock DB） | `electron/services/__tests__/experienceService.browse.test.ts` + `electron/services/experienceService.test.ts:39 _setExperienceDbGetter`（内存 mock DB 注入钩子） | **role-match**（无现成 list 入参校验单测，但 `_setExperienceDbGetter` mock + `MAX_BATCH` throw 断言范式可循） |
| `tests/unit/authGuard.test.ts`（扩展） | SEC-04 L6 测试（D-13-8） | test | request-response | 自身既有 `authGuard.test.ts:10-19`（未登录 reject / 已登录返结果） | exact（自身扩展，加未登录拒绝 case） |
| `tests/electron/connectSSH.real.test.ts`（新增，D-13-8 planner 评估可行性） | SEC-03 测试 | test | request-response（SSH 真路径） | `tests/electron/arpCollector.real.test.ts`（`ssh2.Server` mock 对端 + 真路径）+ Phase 12 `mockSshServer.ts` | role-match（`connectSSH` 带 BrowserWindow/xterm，planner 评估能否复用 Phase 12 真路径套件，可能降级真机 HV） |

> **SEC-04 文件 finalize 约束：** L1 经 D-13-1 显式 defer（不删弱算法，运维兼容性优先）。L2/L3/L4/L6 子项「具体改什么文件」需 researcher 先挖 28 findings 原始细节（`.planning/audits/2026-07-26-doc-code-audit.md` + `260726-p9e-SUMMARY.md:142`），planner 据此定（CONTEXT.md `<decisions>` D-13-4 + Claude's Discretion 已授权）。上表 auth.ts/ai.ts/Login.tsx 是据 audit finding 6（`auth:*` 异常脱敏，注：finding 6 已部分由 p9e 修，main.ts:153-160 现已全 `safe` 包装）+ R5（安全核心零回归）推断的锚点，非锁定。

---

## Pattern Assignments

### `electron/services/connection.ts` `connectSSH`（SEC-03，service，request-response）

**Analog:** `electron/services/ai.ts:306-322 buildSSHConfig`（exact —— 同库 ssh2、同 ConnectConfig 形态、已复用 SSH_ALGORITHMS+SSH_READY_TIMEOUT_MS 的 sibling 成品）

**Imports pattern**（参照 `ai.ts:8`，连接文件顶部 import）：
```typescript
// ai.ts:8（analog 的 import 行）
import { SSH_READY_TIMEOUT_MS, SSH_ALGORITHMS } from '../utils/sshConfig'
```

**Core「复用常量消 drift」pattern**（参照 `ai.ts:306-322`，整段照抄结构）：
```typescript
// ai.ts:306-322（analog 全文 —— connectSSH 改造的目标形态）
function buildSSHConfig(device: any): ConnectConfig {
  const cfg: ConnectConfig = {
    host: device.ipAddress,
    port: device.port || 22,
    username: device.username || 'root',
    readyTimeout: SSH_READY_TIMEOUT_MS,   // ← D-13-3：connectSSH 现内联 10000 → 改 SSH_READY_TIMEOUT_MS(30s)
    algorithms: SSH_ALGORITHMS,           // ← D-13-2：connectSSH 现内联 algorithms 表(115-150) → 改 SSH_ALGORITHMS
  }
  if (device.sshKeyContent) {
    cfg.privateKey = Buffer.from(device.sshKeyContent)
  } else if (device.sshKeyPath) {
    cfg.privateKey = fs.readFileSync(device.sshKeyPath)
  } else {
    cfg.password = device.password
  }
  return cfg
}
```

**待改现状**（`connection.ts:107-151`，对照锚点）：
```typescript
// connection.ts:110-151（待删内联表，drift 根源 —— 缺 curve25519）
const config: ConnectConfig = {
  host: device.ipAddress,
  port: device.port || 22,
  username: device.username || 'root',
  readyTimeout: 10000,        // ← 删，换 SSH_READY_TIMEOUT_MS
  algorithms: {               // ← 整块(115-150)删，换 algorithms: SSH_ALGORITHMS
    kex: [ /* 缺 curve25519-sha256 首项 ... */ ],
    cipher: [ /* 缺 aes128-gcm/aes256-gcm 短名 ... */ ],
    serverHostKey: [ /* 顺序异于 SSH_ALGORITHMS（ssh-rsa 在前 vs ssh-ed25519 在前）*/ ],
  },
}
// 密钥/密码分支(154-160)与 analog 同形，保留不动
```

**注（planner 关注）：** `connectSSH` 不返回 config 而是直接 `client.connect(config)`（`connection.ts:204`），无需像 `buildSSHConfig` 那样 return；改造只需替换内联表 + readyTimeout 两处。`SSH_ALGORITHMS` 已含 curve25519（`sshConfig.ts:13` 首项）+ gcm 短名（`sshConfig.ts:21-22`），复用即修好现代 Linux 连不上问题。`arpCollector.ts:68` 也是同范式第三处参照（`algorithms: SSH_ALGORITHMS` 单行）。

---

### `electron/ipc/experienceIpc.ts` `experience:list` handler（SEC-05，IPC 网关层校验，request-response）

**Analog 三合并：** `ouiIpc.ts:9-11`（`validateLimit` 网关校验，钳制风格）+ `experienceIpc.ts:107-112`（confirmDrafts，throw 风格，双层防御）+ `anomalyIpc.ts:24`（`ids.length > N` throw）

**Pattern A —— 钳制（cap to default，用于 search/tags，D-13-5 静默容错）：**
```typescript
// electron/utils/pagination.ts:19-23（validateLimit —— 钳制先例，非法/超界落回 defaultValue）
export function validateLimit(limit: unknown, defaultValue: number, maxCeiling: number): number {
  const n = Number(limit)
  if (!Number.isInteger(n) || n < 1 || n > maxCeiling) return defaultValue  // 落回默认，非 throw
  return n
}
// ouiIpc.ts:9-11（消费 validateLimit 的范式）
ipcMain.handle('oui:getAll', secure((_e, limit?: number, offset?: number) =>
  OUIService.getAll(validateLimit(limit, 5000, 50000), validateOffset(offset))))
```
> planner 落地 search≤100 / tags≤20 / 单 tag≤30（D-13-6）时，参照此「落回默认/截断」钳制风格（**非 throw**），与 oui:getAll 网关层校验统一。具体截断实现（`slice(0, N)` for tags / `slice(0, N)` for search）由 planner 定。

**Pattern B —— throw 拒绝（用于 severity 枚举非法，D-13-5 暴露调用方 bug）：**
```typescript
// experienceIpc.ts:107-112（confirmDrafts —— throw + 双层防御先例）
ipcMain.handle('experience:confirmDrafts', secure((_e, input: ConfirmDraftsInput) => {
  if (!input || !Array.isArray(input.drafts) || input.drafts.length > MAX_BATCH) {
    throw new Error(`批量上限 ${MAX_BATCH} 条（或入参无效）`)
  }
  return confirmDrafts(input)
}))
// anomalyIpc.ts:23-27（ids 数组上限 throw 先例）
ipcMain.handle('anomaly:deleteChanges', secure((_e, ids: number[]) => {
  if (!Array.isArray(ids) || ids.length > 10000) throw new Error('ids 非法或超限')
  // ...
}))
```

**severity 合法枚举来源**（D-13-5 判据，参照 service 层既有 `VALID_SEVERITIES`）：
```typescript
// experienceService.ts:51（service 层已有枚举，SEC-05 IPC 层校验复用同一集合避免 drift）
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
// src/types/experience.ts:17（类型侧同集合，作为 severity?: 'critical'|'high'|'medium'|'low'|'info'）
```
> planner 建议：IPC 层校验 severity 时复用 service 层导出的 `VALID_SEVERITIES`（若未导出则 export，避免 IPC/service 两份枚举 drift，呼应 service 层 `assertTroubleshootingAttrs` 已有校验）。

**Error handling pattern：** 全程包在 `secure(...)` 内（`experienceIpc.ts:64` 现状），throw 经 `secure` `sanitizeMessage` 脱敏透出 renderer（`authGuard.ts:38`），无需额外 try/catch。

---

### `electron/services/experienceService.ts` `listExperiences`（SEC-05，service，CRUD）

**Analog:** 自身（D-13-7 明确：service 层只保留现有 limit MAX_BATCH 兜底，不复查 severity/search/tags）

**现有 limit 兜底（保留不删，双层防御第二层）：**
```typescript
// experienceService.ts:258-264（现状，保留）
export function listExperiences(opts: ListExperiencesOpts): PaginatedResult<any> {
  let limit = opts.limit
  if (limit == null || limit <= 0) limit = 100
  if (limit > MAX_BATCH) {
    throw new Error('limit 超过 MAX_BATCH 上限')   // ← 防「绕 IPC 直调 service 查全表」残余风险
  }
  // severity/search/tags 不在此复查（D-13-7 接受残余风险换简洁）
```

**职责分层范式（D-13-7，沿用 Phase 9 confirmDrafts MAX_BATCH 双层但分层）：**
- IPC 网关层（`experienceIpc.ts`）：完整入参校验（severity/search/tags/limit）—— **新增**
- service 层（`experienceService.ts`）：仅 limit MAX_BATCH 兜底 —— **现有保留**
- 参照 Phase 9 confirmDrafts 双层：`experienceIpc.ts:108`（IPC 层 `drafts.length > MAX_BATCH` throw）+ service 层 `drafts.length > MAX_BATCH` throw（experienceService 内）

> planner 注意：service 层 `listExperiences` 函数签名 `ListExperiencesOpts` **不改**（D-13-7 显式约束，避免破坏既有 callers）。

---

### `electron/utils/authGuard.ts` `secure`/`safe`（SEC-04 L6，IPC 鉴权网关，request-response）

**Analog:** 自身（三红线之一，加固不可削弱）

**现有鉴权 + 脱敏 pattern（加固基线，不可回退）：**
```typescript
// authGuard.ts:31-41（secure —— 未登录 reject 在 try 之外不被脱敏覆盖）
export function secure(handler: (e: any, ...args: any[]) => any) {
  return async (e: any, ...args: any[]) => {
    if (!authenticated) throw new Error('未登录或会话已过期')   // ← L6 加固锚点：必须保持未登录拒绝
    try {
      return await handler(e, ...args)
    } catch (err: any) {
      console.error('[ipc] handler error:', err)
      throw new Error(sanitizeMessage(err?.message || '操作失败'))   // ← 异常脱敏红线
    }
  }
}
// authGuard.ts:17-24（sanitizeMessage —— 路径/长度脱敏）
function sanitizeMessage(msg: string): string {
  if (!msg) return '操作失败'
  let s = msg
    .replace(/[A-Za-z]:\\[^\s'"()<>]*/g, '[路径]')
    .replace(/\/(?:usr|home|Users|tmp|var|opt)[^\s'"()<>]*/g, '[路径]')
  if (s.length > 200) s = s.slice(0, 200) + '...'
  return s
}
```

> L6 具体加固点（audit finding 10 + R5）待 researcher 挖：候选包括「`isAuthenticated` callers=0 疑预留入口 investigate」（health-audit §2 medium）、「补单测覆盖 secure/safe 未登录拒绝」（D-13-8 显式要求 L6 加单测）。**红线：** 加固只能增强未登录拒绝/脱敏强度，不可削弱（如不可把 reject 改成放行）。

---

### `electron/services/auth.ts` + `electron/main.ts` auth:* IPC（SEC-04 L4 Login，待 finalize）

**Analog:** 自身（login 已有锁定 + 口令强度范式）

**现有登录锁定 pattern（L4 加固参照基线）：**
```typescript
// auth.ts:7-10,37-58（失败计数 + 锁定 + captcha 前置）
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>()
const MAX_ATTEMPTS = 5
const LOCK_MS = 5 * 60 * 1000

export function login(username: string, password: string, captchaKey: string, captchaInput: string) {
  if (!verifyCaptcha(captchaKey, captchaInput)) return { success: false, error: '验证码错误' }
  const rec = failedAttempts.get(username)
  if (rec && rec.lockedUntil > Date.now()) {
    return { success: false, error: '登录失败次数过多，请 5 分钟后再试' }
  }
  // ... verifyPasswordSync，失败 count++，count >= MAX_ATTEMPTS 置 lockedUntil
}

// auth.ts:30-35（口令强度策略 —— initAdmin 用，L4 可能扩展到 login 改密场景）
export function validatePasswordStrength(password: string): { ok: boolean; error?: string } {
  if (!password || password.length < 10) return { ok: false, error: '密码至少 10 位' }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return { ok: false, error: '密码需同时包含字母和数字' }
  return { ok: true }
}
```

**IPC 注册 pattern（main.ts:153-160，登录前 channel 全 `safe` 包装 —— audit finding 6 已修）：**
```typescript
// main.ts:152-160（auth:* 已全 safe 包装，L4 在此基线上加固）
ipcMain.handle('auth:getCaptcha', safe(() => { const r = generateCaptcha(); return { svg: r.svg, key: r.key } }))
ipcMain.handle('auth:login', safe(async (_e, u, p, ck, ci) => {
  const r = await login(u, p, ck, ci)
  if (r.success) setAuthenticated(true)   // ← 登录态置位入口
  return r
}))
```

---

### `electron/services/auth.ts` captcha（SEC-04 L3，待 finalize）

**Analog:** 自身（`generateCaptcha`/`verifyCaptcha` 已用 CSPRNG + 过期 + 一次一删）

**现有 captcha pattern（L3 加固参照基线，已较稳）：**
```typescript
// auth.ts:12-28（CSPRNG 生成 + 5min 过期 + 一次一删）
export function generateCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // 已去歧义字符（无 0/O/1/I）
  let text = ''
  for (let i = 0; i < 4; i++) text += chars[crypto.randomInt(0, chars.length)]  // CSPRNG，非 Math.random
  const key = crypto.randomUUID()
  captchaStore.set(key, { text, expires: Date.now() + 5 * 60 * 1000 })   // 5min TTL
  return { svg: renderSvg(text), key, text }
}
export function verifyCaptcha(key: string, input: string): boolean {
  const s = captchaStore.get(key)
  if (!s) return false
  if (Date.now() > s.expires) { captchaStore.delete(key); return false }
  captchaStore.delete(key)   // 一次一删（防重放）
  return s.text.toUpperCase() === input.toUpperCase()
}
```
> L3 具体加固点待 researcher 挖（audit 28 findings 中 L3 原始描述）。候选：captcha 长度/字符集/噪声强度/renderSvg 用 Math.random 做噪声坐标（非安全敏感，但 audit 可能提）。

---

### `electron/services/ai.ts` + `electron/main.ts:192` `ai:chat`（SEC-04 L2 ai limit，待 finalize）

**Analog:** 自身 `ai:chat` secure 包装 + `commandSafety.isCommandAllowed` 执行层红线

**现有 AI IPC + 命令安全层 pattern（L2 限流不可绕过的红线）：**
```typescript
// main.ts:192（ai:chat 已 secure 包装 —— 登录后特权）
ipcMain.handle('ai:chat', secure((_e, messages, deviceIds, sessionId) => chat(messages, deviceIds, sessionId)))

// ai.ts:330-336（执行层强制安全校验 —— 红线③，L2 限流若涉执行链不可绕过此层）
const whitelist = getCommandWhitelist()
const checked = commands.map((cmd) => {
  const safety = isCommandAllowed(cmd, whitelist)   // commandSafety.isCommandAllowed —— 三红线之一
  return { cmd, allowed: safety.allowed, reason: safety.reason }
})
```
> L2 ai limit 具体形态（消息频率/ token 上限/并发上限）待 researcher 挖 28 findings。**红线：** 限流逻辑加在 IPC 网关层或 service 入口，**不可绕过** `commandSafety.isCommandAllowed`（若限流路径涉命令执行）。

---

### `tests/unit/experienceService.listGuard.test.ts`（SEC-05 测试，D-13-8，test，CRUD mock）

**Analog:** `electron/services/experienceService.test.ts`（`_setExperienceDbGetter` mock DB 注入）+ `__tests__/experienceService.browse.test.ts`

**Mock DB 注入 pattern（规避 DEP-1 native binding ABI 冲突，沿用 Phase 12 mock 范式）：**
```typescript
// experienceService.test.ts:36-45（_setExperienceDbGetter 注入钩子 —— SEC-05 测试接入点）
let dbGetter: () => Database.Database = getDatabase
export function _setExperienceDbGetter(fn: () => Database.Database): void { dbGetter = fn }
function db(): Database.Database { return dbGetter() }

// experienceService.test.ts:41-59（测试侧 import + beforeEach 注入 mock DB）
import { _setExperienceDbGetter, MAX_BATCH } from './experienceService'
// beforeEach: _setExperienceDbGetter(() => mockDb)  ← 注入内存 mock
```

**SEC-05 测试应覆盖（D-13-8）：**
- search 超长（>100）→ 验证截断（mock DB 收到截断后 search，不爆）
- tags 超量（>20）→ 验证截断（mock DB 收到截断后 tags）
- severity 非法（如 `'xxx'`）→ 验证 throw（断言 reject 带 severity 相关 message）
- 注：severity/search/tags 校验加在 IPC 网关层，单测若测 service 层需经 IPC mock 或直接测网关层函数（planner 据校验落点位定）。

**throw 断言范式（参照既有 `MAX_BATCH` throw 测试）：**
```typescript
// 参照 experienceService.test.ts 既有 MAX_BATCH throw 断言风格
await expect(listExperiences({ limit: MAX_BATCH + 1 })).rejects.toThrow('limit 超过 MAX_BATCH 上限')
```

---

### `tests/unit/authGuard.test.ts` 扩展（SEC-04 L6 测试，D-13-8，test）

**Analog:** 自身既有 `authGuard.test.ts`

**现有未登录拒绝测试（已覆盖，L6 加固后须保持绿）：**
```typescript
// authGuard.test.ts:10-19（现有 —— L6 加固不可破坏此 case）
it('secure rejects when not authenticated (before try, not masked by sanitize)', async () => {
  const wrapped = secure(() => 'should not reach')
  await expect(wrapped({})).rejects.toThrow('未登录或会话已过期')
})
it('secure returns handler result when authenticated', async () => {
  setAuthenticated(true)
  const wrapped = secure(() => 'ok')
  await expect(wrapped({})).resolves.toBe('ok')
})
```
> L6 加固后扩展新 case（据 researcher finalize 的加固点加），但上述既有 case 必须保持绿（不可削弱红线）。

---

### `tests/electron/connectSSH.real.test.ts`（SEC-03 测试，D-13-8 planner 评估，test，SSH 真路径）

**Analog:** `tests/electron/arpCollector.real.test.ts`（Phase 12 `ssh2.Server` mock 对端真路径）+ Phase 12 `tests/electron/_helpers/mockSshServer.ts`

**可行性约束（D-13-8 planner 评估）：** `connectSSH` 带 `BrowserWindow` + `xterm`（`connection.ts:107` 签名含 `termWin: BrowserWindow`），与 Phase 12 `arpCollector`（纯 `client.exec`，无窗口）不同。planner 评估：
- 能否在 Electron 测试通道内 mock `BrowserWindow.webContents.send`（验证算法协商成功即 `'ready'` 事件触发）
- 若 BrowserWindow 限制不可绕，降级真机 HV（连现代 Linux + 老设备各一台，核对终端能开 shell）

**SSH_ALGORITHMS 协商验证范式（参照 arpCollector.real.test.ts mock server）：**
```typescript
// 参照 Phase 12 mockSshServer.ts —— ssh2.Server 对端可声明支持的算法集，
// 验证 client.connect 用 SSH_ALGORITHMS 协商成功（ready 触发）。
// SEC-03 重点：mock server 只暴露 curve25519-sha256（现代 Linux 典型），
// 验证 connectSSH 复用 SSH_ALGORITHMS 后能协商成功（改造前会因缺 curve25519 失败）。
```

---

## Shared Patterns

### IPC 鉴权包装（红线①，全 phase 不可回退）
**Source:** `electron/utils/authGuard.ts:31-53`
**Apply to:** 所有 IPC handler（SEC-05 experience:list / SEC-04 L4 auth:* / L2 ai:chat 均已包，新增/加固不可裸 handler）
```typescript
// 特权通道（登录后）：secure = 鉴权 + 异常脱敏
ipcMain.handle('experience:list', secure((_e, opts) => ...))
// 登录前通道：safe = 仅异常脱敏（auth:getCaptcha / auth:login / auth:isFirstRun / auth:initAdmin）
ipcMain.handle('auth:login', safe(async (_e, ...) => ...))
```

### IPC 网关层入参校验（双层防御第一层）
**Source:** `electron/ipc/ouiIpc.ts:9-11`（钳制）+ `electron/ipc/experienceIpc.ts:107-112`（throw）+ `electron/ipc/anomalyIpc.ts:23-27`（数组上限 throw）
**Apply to:** SEC-05 experience:list（severity throw / search·tags 钳制）
```typescript
// 钳制（落回默认，用户输入静默容错）：参照 validateLimit / oui:getAll
// throw（固定集合非法值，暴露调用方 bug）：参照 confirmDrafts MAX_BATCH / anomaly deleteChanges ids
```

### 异常脱敏（红线①配套，防内部细节泄露 renderer）
**Source:** `electron/utils/authGuard.ts:17-24 sanitizeMessage`
**Apply to:** 全 IPC handler 的 throw 路径（SEC-05 throw / SEC-04 L4/L6 加固后的 throw 均经 secure·safe 脱敏）
```typescript
// 路径脱敏（Windows 盘符 / Unix 路径）+ 长度截断 200 + '...' + 空消息落 '操作失败'
// 经 secure/safe 自动包装，handler 内裸 throw 即可，无需手动 try/catch 脱敏。
```

### SSH 配置常量复用（消 drift，SEC-03 核心）
**Source:** `electron/utils/sshConfig.ts:7,11`（`SSH_READY_TIMEOUT_MS` / `SSH_ALGORITHMS`）
**Apply to:** SEC-03 `connection.ts connectSSH`（改完后全仓 3 处 SSH 路径——ai.ts buildSSHConfig / arpCollector executeSSH / connection.ts connectSSH——全走同一常量，零 drift）
```typescript
import { SSH_READY_TIMEOUT_MS, SSH_ALGORITHMS } from '../utils/sshConfig'
readyTimeout: SSH_READY_TIMEOUT_MS,
algorithms: SSH_ALGORITHMS,
```

### 命令执行安全层（红线③，SEC-04 L2 若涉执行链不可绕）
**Source:** `electron/services/ai.ts:330-336` + `electron/utils/commandSafety.ts isCommandAllowed`
**Apply to:** SEC-04 L2 ai limit（限流逻辑加在 IPC/service 入口，不可绕过 `isCommandAllowed` 执行层校验）

### Mock DB 单测范式（规避 DEP-1 native binding）
**Source:** `electron/services/experienceService.test.ts:36-45 _setExperienceDbGetter`
**Apply to:** SEC-05 list 入参校验单测（D-13-8）

---

## No Analog Found

| 文件 | 角色 | 数据流 | 原因 |
|------|------|--------|------|
| 无 | — | — | 本 phase 全部改动锚点均有本仓自身 sibling/近邻可循（SEC-03 有 `buildSSHConfig` exact sibling；SEC-05 三处 IPC 校验先例合并；SEC-04 五项均为自身既有模块加固）。**0 无 analog。** |

> SEC-04 L2/L3/L4 子项的「具体改法」无 analog 不是因为代码缺失，而是因为 audit finding 原始细节待 researcher 挖（CONTEXT.md D-13-4 授权）。挖到后若判定「已满足/伤三红线/成本远超收益」则显式 defer 登记（学 Phase 14 FIX-02 甄别模式），planner 不照单全修。

---

## Metadata

**Analog 搜索范围：** `electron/services/`（ai.ts/auth.ts/connection.ts/experienceService.ts/arpCollector.ts）、`electron/utils/`（sshConfig.ts/authGuard.ts/pagination.ts）、`electron/ipc/`（experienceIpc.ts/ouiIpc.ts/anomalyIpc.ts）、`electron/main.ts`、`src/types/experience.ts`、`src/components/Login.tsx`、`tests/unit/`（authGuard.test.ts）、`electron/services/*.test.ts`、`tests/electron/`（Phase 12 真路径套件）、`.planning/audits/`（两份审计 finding 源）、`.planning/quick/260726-p9e-*/`（p9e 排除项清单）
**Files scanned:** 16 源文件 + 3 测试 + 3 审计/规划文档
**Pattern extraction date:** 2026-08-09
