---
phase: 14-defect-legacy-rollback-closure
reviewed: 2026-08-10T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - electron/database/init.ts
  - electron/database/migrations.test.ts
  - electron/database/migrations.ts
  - electron/services/anomalyService.ts
  - src/components/pages/AIPage.tsx
  - src/components/pages/ai/CommandConfirmModal.tsx
  - src/components/pages/ai/types.ts
  - src/components/pages/ai/useAIChat.ts
  - tests/electron/anomalyNewIp.real.test.ts
findings:
  critical: 2
  warning: 4
  info: 3
  total: 9
status: issues_found
---

# Phase 14: Code Review Report

**Reviewed:** 2026-08-10
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Phase 14 包含两个独立工作单元:(1) BUG-1 修复 —— `anomalyService.processARPEntries` 全新 IP 分支补 `recordChange('new_ip')` + 首次基线机制(`is_baseline` 列 + `hasBaseline` 门控 + 后置基线 UPDATE);(2) FIX-02 #1 视觉锁 —— `confirmInFlight` prop 透传链路(useAIChat → AIPage → CommandConfirmModal)。

整体审查结论:
- **BUG-1 修复核心逻辑正确**:else 全新 IP 分支补 `recordChange('new_ip')` + `hasBaseline` 门控首次基线、`is_baseline` 列的 v12 迁移幂等守卫(`hasColumn`)与 init.ts fresh-install 双路径列定义一致,遗留库向后兼容语义(存量行经 currentBinding 分支不被误报、后置 UPDATE 纳入存量)有 Test 6 真路径覆盖。
- **三红线未削弱**:IPC `secure`/`safe` 鉴权未动、`_enc` 字段加密未动、`commandSafety`/`confirm_required` 闸口未动,`confirmCommand` main 进程"取后即删"防重入(line 577-579)仍生效。
- **`_setAnomalyDbGetter` 注入口安全**:模块级 `let dbGetter` 默认 = `getDatabase` 单例,生产路径行为零变化,无 IPC channel 暴露给 renderer,镜像 `experienceService._setExperienceDbGetter` 同范式。

但发现 **2 个 BLOCKER + 4 个 WARNING**:

- **CR-01(时区一致性 BLOCKER)**:`anomalyService.recordChange/acknowledgeChange/acknowledgeAll` 写 `detected_at`/`acknowledged_at` 用 `datetime('now')`(UTC),**全项目硬规约是 `datetime('now','localtime')`**(见 experienceService.ts:78-79 明确警告"字典序文本比较会失真")→ `getChanges` 的 `ORDER BY detected_at DESC` 字典序排序时间线错乱,且与表 DEFAULT 路径混时区。
- **CR-02(事务边界 BLOCKER)**:后置基线 UPDATE(`WHERE is_baseline=0`)在外层 `runBatch()` 事务 **COMMIT 之后** 执行;该 UPDATE 失败时基线状态丢失但本次 changes/binding 已落库,下次扫描 hasBaseline 仍 false → 基线化窗口期内任何新增 IP 被静默漏报 new_ip。
- **WR-01(confirmInFlight 竞态)**:`handleConfirm` 同一渲染周期内连点"确认执行"两次时,`!pendingConfirm` 守卫因闭包固定值不拦截,第二次 IPC 在 main 命中 `未找到待确认命令` throw → catch 弹误导性错误 toast;`confirmInFlight` 视觉锁未能拦住(状态未刷新前 Modal 仍在 DOM)。
- **WR-02(测试误绿)**:Test 3 line 159 `void wait(50)` 异步等待未 `await`,实际未等待;line 183 断言用 `>=` 弱化 → last_seen 更新验证可能误绿。
- **WR-03(后置 UPDATE 无事务守卫)**:processARPEntries 整批 throw 时 `runBatch` 已 ROLLBACK,但 hasBaseline 仍 false,后置 UPDATE 仍会跑(line 159 无条件分支),把可能已存在的非本次 binding 置 1。
- **WR-04(回归覆盖缺口)**:6 it 无"`hasBaseline=true` 但本批次含全新 IP + 已知 IP 混合"的混合批次断言,也无 `createBinding` UNIQUE fallback 路径(ip 与历史 inactive binding 同 mac)的回归。

## Critical Issues

### CR-01: detected_at / acknowledged_at 写入用 UTC `datetime('now')`,违反项目 localtime 一致性规约,排序错乱

**File:** `electron/services/anomalyService.ts:179, 200, 204`
**Issue:**
`recordChange` line 179、`acknowledgeChange` line 200、`acknowledgeAll` line 204 三处对时间列写入统一用 `datetime('now')`(UTC,无 `'localtime'` 修饰符)。但:
- `init.ts:159` 表 DDL `detected_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))` 与 `acknowledged_at`(无 DEFAULT,但全项目时间列约定 localtime)走 localtime。
- `experienceService.ts:78-79` 注释明确警告:"`datetime('now','localtime')` 的字典序文本比较会失真(如 `'T'(0x54) > 空格(0x20)` 误判更晚)"——这正是项目硬性规避的点。
- 全项目 grep `datetime('now'` 结果:**所有 30+ 处一律 `datetime('now','localtime')`**,唯独 anomalyService 这 3 处用裸 `datetime('now')`(UTC)。

后果:
1. `ip_mac_changes.detected_at` 列在 recordChange 写入路径产 UTC 串(如 `2026-08-10 02:30:00` 实际是北京时间 10:30:00),与其他路径(表 DEFAULT)的 localtime 串混存。
2. `getChanges`(line 187)与 `getStats` 等读侧 `ORDER BY detected_at DESC` 字典序排序——UTC 串与 localtime 串混排导致 **时间线错乱**:运维面板"IP/MAC 变更记录"列表顺序错乱,CSV 导出时间戳时区不一致。
3. BUG-1 修复后 new_ip 终于落库,但面板排序错乱直接掩盖修复成果,用户体感"修了等于没修"。

**Fix:** 三处统一改回 localtime,与项目规约对齐:

```typescript
// line 179 recordChange
const result = db.prepare(
  "INSERT INTO ip_mac_changes (ip, old_mac, new_mac, change_type, detected_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))"
).run(ip, oldMac, newMac, changeType)

// line 200 acknowledgeChange
dbGetter().prepare(
  "UPDATE ip_mac_changes SET acknowledged = 1, acknowledged_at = datetime('now','localtime'), notes = ? WHERE id = ?"
).run(notes || null, id)

// line 204 acknowledgeAll
return dbGetter().prepare(
  "UPDATE ip_mac_changes SET acknowledged = 1, acknowledged_at = datetime('now','localtime') WHERE acknowledged = 0"
).run().changes
```

注意:`recordChange` 返回值 line 180 的 `detectedAt: new Date().toISOString()`(JS Date,UTC ISO 串)与 DB 列 localtime 串格式不同,建议同步改为 `new Date().toLocaleString()` 或直接读回 DB 行,保证 `IPMACChange` 接口与 DB 一致。

---

### CR-02: 后置基线 UPDATE 在外层事务 COMMIT 之后,失败导致基线状态丢失 + new_ip 静默漏报窗口

**File:** `electron/services/anomalyService.ts:141-161`
**Issue:**
执行序:
```
line 141: runBatch = db.transaction(() => { for entry: entryTx(entry) })  ← 外层事务
line 153: runBatch()                                                       ← COMMIT(本次 changes + binding 落库)
line 159: if (!hasBaseline) db.prepare('UPDATE ... SET is_baseline=1 WHERE is_baseline=0').run()  ← 事务外!
```

后置基线 UPDATE(line 159-161)**位于 `runBatch()` 事务 COMMIT 之后**,是独立的 autocommit 写。若该 UPDATE 因磁盘满 / IO 错误 / WAL checkpoint 冲突抛错:
- 本次 `runBatch()` 已 COMMIT:changes 表已有 mac_changed/ip_reused 行,binding 表已有新增行。
- 但 `is_baseline` 仍是 0(UPDATE 失败)。
- 下次 processARPEntries 入口 line 98 `hasBaseline = SELECT ... WHERE is_baseline=1 LIMIT 1` 仍返 false → 再次走"首次基线"路径 → **基线化窗口期内任何新增 IP 都被 `if (hasBaseline)` 门控跳过 recordChange('new_ip')**(line 133),静默漏报。
- 且外层 arpIpc.ts:37/59 调用方无 try/catch 包裹 processARPEntries(arpIpc:31-41 的 try/finally 只保护 IPStatusService 配对),后置 UPDATE 抛错会冒泡到 IPC handler,被 `secure()` 包装器脱敏后返给 renderer,但基线丢失状态不可恢复。

此外(line 159 无幂等守卫,见 WR-03):后置 UPDATE 在 processARPEntries 整批 throw 时 `runBatch` 已 ROLLBACK,但 line 159 仍会无条件执行,把可能已存在的非本次 binding 置 1。

**Fix:** 把后置基线 UPDATE 纳入外层事务,与 runBatch 共用同一 COMMIT/ROLLBACK 边界。这样:
- 整批 + 基线化是原子:任一失败 → 整批 ROLLBACK → hasBaseline 仍 false,下次重试整个流程(无半持久化状态)。
- 消除"已落 changes 但基线丢失"的中间态。

```typescript
const runBatch = db.transaction(() => {
  for (const entry of entries) {
    try {
      entryTx(entry)
    } catch (e: any) {
      console.error('[anomaly] processARPEntries 条目处理失败:', entry.ip, e.message)
    }
  }
  // 后置基线 UPDATE 纳入同一事务(CR-02 fix):与本次 changes/binding 原子提交
  if (!hasBaseline) {
    db.prepare('UPDATE ip_mac_bindings SET is_baseline = 1 WHERE is_baseline = 0').run()
  }
})
runBatch()
return changes
```

## Warnings

### WR-01: handleConfirm 同渲染周期连点两次发起重复 IPC,catch 弹误导性错误

**File:** `src/components/pages/ai/useAIChat.ts:199-231`
**Issue:**
`handleConfirm` 是 `useCallback([pendingConfirm, currentSessionId])`。用户在 Modal 上快速连点"确认执行"两次时:
- 两次 onClick 在同一事件循环 tick 内触发,React 未重渲染,两次回调共享同一 `pendingConfirm` 闭包值(truthy)。
- 第一次:line 200 守卫 `!pendingConfirm` false → 进入;line 202 `setPendingConfirm(null)`;line 204 `setConfirmInFlight(true)`;line 206 发起 IPC `confirmCommand(execId, true)`。
- 第二次(同步紧随):`pendingConfirm` 闭包值仍是 truthy,**守卫不拦**;line 201 `confirmData = pendingConfirm`(原值);line 202 `setPendingConfirm(null)`(no-op);line 204 `setConfirmInFlight(true)`(no-op);line 206 **再次发起 IPC `confirmCommand(execId, true)`**。
- 第二次 IPC 在 main 进程(`ai.ts:577-579`)命中 `pendingBatches.get(batchId)` → undefined → `throw new Error('未找到待确认命令')`(main 有"取后即删"防重入,命令不会重复执行)。
- 异常冒到 useAIChat line 226 catch,line 227 `message.error(e.message)` → 用户看到"未找到待确认命令"的误导性 toast(实际第一次 IPC 已成功执行)。

`confirmInFlight` 视觉锁(line 18/21 CommandConfirmModal 按钮 `disabled={confirmInFlight}`)**未能拦住**:第二次点击发生时 React 状态尚未刷新,按钮仍可点。

`setPendingConfirm(null)` 关窗锁也是异步 setState,在第二次 onClick 触发时同样未生效。

**Fix:** 守卫改为依赖 `confirmInFlight`(同步可读 ref)或使用函数式 setState 防重入:

```typescript
const handleConfirm = useCallback(async (approved: boolean) => {
  if (!pendingConfirm || !currentSessionId || confirmInFlight) return  // 加 confirmInFlight 守卫
  const confirmData = pendingConfirm
  setPendingConfirm(null)
  setConfirmInFlight(true)  // 先上锁再 setLoading,缩短竞态窗口
  setLoading(true)
  try {
    // ...
  } finally {
    setConfirmInFlight(false)
    setLoading(false)
  }
}, [pendingConfirm, currentSessionId, confirmInFlight])
```

注:即便加了 `confirmInFlight` 守卫,同一渲染周期内 `confirmInFlight` 闭包值仍固定为 false(初始),守卫仍不拦。根治需用 `useRef` 同步标志:

```typescript
const confirmInFlightRef = useRef(false)
const handleConfirm = useCallback(async (approved: boolean) => {
  if (!pendingConfirm || !currentSessionId || confirmInFlightRef.current) return
  confirmInFlightRef.current = true
  setConfirmInFlight(true)  // 视觉层
  // ... IPC ...
  confirmInFlightRef.current = false
  setConfirmInFlight(false)
}, [pendingConfirm, currentSessionId])
```

---

### WR-02: Test 3 异步等待 `void wait(50)` 未 await,断言用 `>=` 弱化,可能误绿

**File:** `tests/electron/anomalyNewIp.real.test.ts:158-159, 183`
**Issue:**
Test 3 验证"已知 IP mac 不变 → 走 currentBinding 分支只 update last_seen"。关键断言是 last_seen 时间戳"已更新":

```typescript
// line 158-159
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
void wait(50)   // ← 未 await!Promise 被 void 丢弃,实际未等待

// line 162 紧接着第二次扫描
const changes = AnomalyService.processARPEntries([...])

// line 183
expect(afterLastSeen >= beforeLastSeen).toBe(true)  // ← 用 >= 而非 >
```

问题:
1. `void wait(50)` 未 `await`,测试主线程不等待 50ms 就执行 line 162 的第二次扫描。两次 processARPEntries 调用间隔几乎为 0。
2. `processARPEntries` line 83 `now = new Date().toISOString()`,JS Date 精度为毫秒,但两次调用间隔 < 1ms 时 `now` 可能完全相同。
3. 即便 last_seen 实际未更新(两次相同),line 183 `>=` 断言仍通过(自比较 `>=` 恒真)。
4. 断言本意是"验证走了 update last_seen 分支(line 119 `stmtUpdateLastSeen.run(now, currentBinding.id)`)",但 `>=` 弱化使该断言退化为"last_seen 没倒退",**未真正验证 UPDATE 发生**,可能误绿。

**Fix:** `await wait(50)` + 严格 `>` 断言;或更稳健地用 spy 验证 `stmtUpdateLastSeen.run` 被调用:

```typescript
it('Test 3：基线内已知 IP 不报(仅 update last_seen)', async () => {
  AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])
  const beforeLastSeen = (handle!.db.prepare("SELECT last_seen as l FROM ip_mac_bindings WHERE ip = '10.0.0.1'").get() as { l: string }).l

  await new Promise((r) => setTimeout(r, 50))  // ← await 真等待

  const changes = AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])
  expect(changes).toHaveLength(0)

  const afterLastSeen = (handle!.db.prepare("SELECT last_seen as l FROM ip_mac_bindings WHERE ip = '10.0.0.1'").get() as { l: string }).l
  expect(afterLastSeen > beforeLastSeen).toBe(true)  // ← 严格 >,真验证 UPDATE
})
```

---

### WR-03: 后置基线 UPDATE 无条件执行,整批 throw 时仍会跑(可能置非本次 binding 为 1)

**File:** `electron/services/anomalyService.ts:141-161`
**Issue:**
`runBatch()`(line 141-152)的 for 循环内 `entryTx(entry)` 被 try/catch 包裹,**单条失败不冒泡**(line 147-149),所以 `runBatch()` 本身不会因条目失败而 throw → ROLLBACK。但若 `entryTx` 之外的代码(如 line 86 `preloadExcludedSet` 在事务内复用、或外层 transaction 包装器的 better-sqlite3 内部错误)抛错,`runBatch()` 会 ROLLBACK。

更关键的是 line 159-161 的后置 UPDATE **无条件执行**(只判 `!hasBaseline`,不判 runBatch 是否成功)。考虑场景:
- 遗留库首次扫描,hasBaseline=false。
- runBatch 内部某条目抛出未被 entryTx 内部消化的异常(理论上 entryTx try/catch 已消化,但 better-sqlite3 SAVEPOINT 在嵌套事务异常时的事务状态机行为复杂),runBatch 整批 ROLLBACK。
- 但 line 159 `if (!hasBaseline)` 仍为 true → 后置 UPDATE 执行 → 把**库中可能已存在的非本次 binding 行**(其他并发 ARP 采集批次写入的、或更早遗留的)置 is_baseline=1。

这虽然概率低(better-sqlite3 同步单连接,事务状态机可预测),但事务边界语义不清是维护隐患。结合 CR-02 的修复(后置 UPDATE 纳入 runBatch 事务)可一并消除。

**Fix:** 与 CR-02 同一修复——后置 UPDATE 移入 `runBatch` 事务体,与本次写操作共用 COMMIT/ROLLBACK。

---

### WR-04: 6 it 缺混合批次 + createBinding UNIQUE fallback 路径回归覆盖

**File:** `tests/electron/anomalyNewIp.real.test.ts`
**Issue:**
6 个 it 覆盖了 BUG-1 核心不变量,但两个回归缺口:

1. **混合批次缺口**:所有 it 的批次要么全基线内(Test 3)、要么全新增(Test 2/5)、要么全新 IP + 已知 IP 在不同批次。无"`hasBaseline=true` 单批次内同时含已知 IP(走 currentBinding update last_seen) + 全新 IP(走 else 报 new_ip)"的混合批次断言。该路径覆盖 else 分支与 if 分支在同一 runBatch 事务内的协同(line 110-138),是 processARPEntries 最常见生产场景(一次 ARP 采集既有已知设备也有新设备)。

2. **createBinding UNIQUE fallback 缺口**:`createBinding`(line 166-172)的 catch 分支——INSERT 因 `UNIQUE(ip, mac)` 冲突(同 ip 同 mac 的历史 inactive binding 存在)失败时,fallback UPDATE 把该 inactive 行重激活。此路径与 BUG-1 基线机制交互(后置 UPDATE 是否把 fallback 重激活的行置 1)无测试覆盖。生产场景:某 IP 之前 mac=A 后变更,旧 binding inactive,某次又变回 mac=A → INSERT 冲突 → fallback UPDATE 重激活 → 该行 is_baseline 状态如何?

**Fix:** 补两个 it:

```typescript
it('Test 7：混合批次(基线后单批次含已知 IP + 全新 IP)', () => {
  AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])  // 建基线
  const changes = AnomalyService.processARPEntries([
    { ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' },  // 已知 IP,update last_seen
    { ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:02' },  // 全新 IP,报 new_ip
  ])
  expect(changes).toHaveLength(1)
  expect(changes[0].changeType).toBe('new_ip')
  expect(changes[0].ip).toBe('10.0.0.2')
})

it('Test 8：createBinding UNIQUE fallback 重激活历史 inactive 行,后置基线 UPDATE 行为', () => {
  AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])  // 建基线,is_baseline=1
  AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:99' }])  // mac 变更,旧 binding inactive
  // mac 变回原值 → createBinding INSERT UNIQUE 冲突 → fallback UPDATE 重激活
  const changes = AnomalyService.processARPEntries([{ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:01' }])
  // 断言:重激活的 AA:BB:CC:DD:EE:01 行 is_active=1,且 is_baseline 保持 1(后置 UPDATE WHERE is_baseline=0 不动它)
  const row = handle!.db.prepare("SELECT is_active as a, is_baseline as b FROM ip_mac_bindings WHERE ip='10.0.0.1' AND mac='AA:BB:CC:DD:EE:01'").get() as { a: number; b: number }
  expect(row.a).toBe(1)
  expect(row.b).toBe(1)
})
```

## Info

### IN-01: createBinding 参数 `db: any` 放宽类型,与 Service 静态类强类型风格不符

**File:** `electron/services/anomalyService.ts:166`
**Issue:**
`createBinding(db: any, ip: string, mac: string, now: string)` 第一个参数用 `any`,而同文件其他方法(processARPEntries line 81)用 `dbGetter()` 拿强类型 `Database.Database`。`init.ts:346` `initDefaultOUIData(db: any)` 也是同款放松,但本项目 CONVENTIONS 鼓励 Service 静态类强类型风格。`createBinding` 接收外部传入 db 是为了复用事务内的同一连接,但应保留强类型。

**Fix:** `private static createBinding(db: Database.Database, ip: string, mac: string, now: string): void`

---

### IN-02: recordChange 返回值 detectedAt 用 JS ISO 串,与 DB 列 localtime 串格式不一致

**File:** `electron/services/anomalyService.ts:180`
**Issue:**
`recordChange` 返回的 `IPMACChange.detectedAt` 用 `new Date().toISOString()`(JS Date,UTC ISO 串,如 `2026-08-10T02:30:00.000Z`),而 DB 列 `detected_at` 走 SQLite `datetime('now')`(见 CR-01)或修复后的 localtime,格式如 `2026-08-10 10:30:00`。返回值与 DB 列值**不一致**:
- 调用方(processARPEntries line 134-135)把该返回值 push 进 `changes` 数组返给 IPC 调用方(arpIpc.ts:37 `AnomalyService.processARPEntries(...)` 返回值用于 stats.changes 计数,字段值未直接消费;但接口契约上 detectedAt 与 DB 不一致是潜在陷阱)。
- 后续若有调用方依赖 `IPMACChange.detectedAt` 与 `getChanges` 返回的 `detectedAt` 字典序可比,会踩坑。

**Fix:** recordChange 改为 INSERT 后读回 `detected_at` 列值,或统一用同一时间源:

```typescript
const detectedAt = new Date().toLocaleString('sv-SE').replace('T', ' ')  // 与 localtime 格式对齐
const result = db.prepare('INSERT ...').run(...)
return { ..., detectedAt, ... }
```

或更稳健地 INSERT 后 `SELECT detected_at FROM ip_mac_changes WHERE id = ?` 读回。

---

### IN-03: CommandConfirmModal 用 `key={i}` 数组索引作 React key,命令列表变动时潜在渲染问题

**File:** `src/components/pages/ai/CommandConfirmModal.tsx:30, 40`
**Issue:**
`pendingConfirm.commands.map((cmd, i) => <div key={i} ...>)` 与 `rejectedCommands.map((r, i) => <div key={i} ...>)` 用数组索引 `i` 作 React key。因 `pendingConfirm` 是 confirm_required 触发时的不可变快照,命令列表不会在 Modal 打开期间被重新排序/插入/删除(整个 Modal 随 setPendingConfirm(null) 关闭重建),实际无渲染 bug。但与 React 最佳实践(用稳定唯一 key,如 `${cmd.deviceName}:${cmd.command}`)不符。

**Fix:** 改用稳定 key:`key={`${cmd.deviceName}:${cmd.command}`}` / `key={r.command}`。优先级低,纯风格优化。

---

_Reviewed: 2026-08-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
