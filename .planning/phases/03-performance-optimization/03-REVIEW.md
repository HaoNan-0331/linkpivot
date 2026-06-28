---
phase: 03-performance-optimization
reviewed: 2026-06-28T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - electron/services/anomalyService.ts
  - electron/services/ouiService.ts
  - electron/services/networkSegmentService.ts
  - electron/main.ts
  - electron/database/init.ts
  - electron/database/migrations.ts
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-06-28
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Phase 3 性能优化覆盖：`processARPEntries` 整批事务 + prepared statement 复用 + excluded_ips 预载；`OUIService` 模块级 vendorMap 缓存 + 5 写方法增量同步 + denormalizePrefix 回退修复；`getIPDetails` 双查 getVendor bug 修复；启动序列插 preload + 冷启动计时；`kb_chunks_au` UPDATE trigger 加 WHEN；v7 迁移 DROP+CREATE trigger 带幂等守卫。

事务边界、缓存一致性、迁移幂等守卫的核心设计成立：v7 的 sqlite_master `WHEN` 守卫正确区分 fresh-install（init.ts 建带 WHEN，no-op）vs 遗留库（DROP+CREATE），与 v5/v6 同构；init.ts 与 migrations.ts 的 trigger DDL 语义逐字一致；vendorMap 增量同步 5 方法（add/addBatch/update/delete/deleteBatch）覆盖 set/delete 对称操作；preload 失败回退路径经 denormalizePrefix 修复后真正可用；启动序列 createTables→migrateAndSecure→preload 顺序正确。

未发现 BLOCKER/Critical 缺陷。发现 4 个 WARNING（其中 2 个是 Phase 3 新代码引入的现实缺陷，2 个是预存缺陷在 Phase 3 代码路径上放大可见度）和 4 个 INFO。

## Warnings

### WR-01: processARPEntries 条目级 try/catch 在事务内导致部分写入提交（partial commit）

**File:** `electron/services/anomalyService.ts:74-107`
**Issue:** 整批 `db.transaction(() => {...})` 包裹循环，循环内每条 try/catch 捕获异常后 `continue`。当同一 entry 的多步操作中途抛错时（例：`stmtDeactivate.run(currentBinding.id)` 已执行，随后 `createBinding` INSERT 因 UNIQUE(ip,mac) 冲突且 fallback UPDATE 又失败而抛错），deactivate 已经写入事务缓冲，try/catch 吞错后 continue 到下一条，最终整批 COMMIT 会把这条半成品（IP 被 deactivate 但无新 binding）持久化。

phase_context 声称条目级 try/catch "不让 throw 冒泡触发整批 ROLLBACK" 是 true，但其代价是**单条部分写入被静默提交**——这是数据完整性问题：MAC 变更场景下，旧 binding 被 is_active=0 但新 binding 未建，该 IP 在后续扫描会一直走 "oldBinding 存在→ip_reused" 路径持续误报。

正确做法应使用 better-sqlite3 的 savepoint 包裹每条 entry，使单条失败回滚到该条起点而非保留半成品。

**Fix:**
```typescript
const runBatch = db.transaction(() => {
  for (const entry of entries) {
    const { ip, mac } = entry
    // savepoint 让单条部分写入在失败时回滚到本条起点，避免半成品被整批 COMMIT
    const savepoint = db.transaction(() => {
      if (this.isIPExcludedCached(ip, excluded)) return
      const currentBinding = stmtCurrentBinding.get(ip) as { id: number; mac: string } | undefined
      if (currentBinding) {
        if (currentBinding.mac !== mac) {
          const change = this.recordChange(ip, currentBinding.mac, mac, 'mac_changed')
          if (change) changes.push(change)
          stmtDeactivate.run(currentBinding.id)
          this.createBinding(db, ip, mac, now)
        } else {
          stmtUpdateLastSeen.run(now, currentBinding.id)
        }
      } else {
        const oldBinding = stmtOldBinding.get(ip) as { mac: string } | undefined
        if (oldBinding) {
          const change = this.recordChange(ip, null, mac, 'ip_reused')
          if (change) changes.push(change)
        }
        this.createBinding(db, ip, mac, now)
      }
    })
    try {
      savepoint.immediate()   // 嵌套事务（savepoint），失败自动回滚该条
    } catch (e: any) {
      console.error('[anomaly] processARPEntries 条目处理失败:', ip, e.message)
      // savepoint 已回滚该条全部写入，整批继续
    }
  }
})
```

注：若不改，至少应在注释中明确承认 "单条部分写入会被提交" 这一语义偏差，并评估与改造前逐条 autocommit 行为是否真的一致（改造前同样会半提交，但仅影响该条；改造后事务内半成品会和整批一同 COMMIT，对外可见窗口可能更长）。

### WR-02: excluded_ips 通配符规则在 RegExp 构造时未转义，用户输入可致抛错或非预期匹配

**File:** `electron/services/anomalyService.ts:38-41`
**Issue:** 通配符判定把用户可控的 `excluded_ips.ip_or_cidr`（`addExcludedIP` 接受任意字符串）直接拼入 `new RegExp('^' + w.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')`。仅转义了 `.` 和 `*`，其他正则元字符（`+`, `?`, `(`, `)`, `[`, `]`, `{`, `}`, `|`, `\`, `^`, `$`）原样进入 RegExp 构造。

后果两类：
1. **抛错**：含 `(` 无配对 `)` 的规则会让 `new RegExp(...)` throw SyntaxError → 被 entry 级 try/catch 吞掉 → 该 IP 处理被静默跳过（数据丢失：本应排除的 IP 反而被处理进 binding）。
2. **非预期匹配**：含 `[` 的规则可能匹配字符集，语义偏离用户意图。

属功能性 + 轻量健壮性缺陷（非 RCE，因 RegExp 不执行代码），但影响排除规则的可靠性。

**Fix:**
```typescript
for (const w of this.wildcards) {
  // 先转义全部正则元字符，再把通配符 '*' 还原为 '.*'
  const escaped = w.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const regex = new RegExp('^' + escaped + '$')
  if (regex.test(ip)) return true
}
```
预编译缓存（规则→RegExp）可顺带避免循环内每行重建（性能收益，本 review 不强求）。

### WR-03: OUIService.update 在 prefix 未变仅 vendorName 变时，旧 vendor 不会从 Map 清除（语义 OK 但 set 空 vendor_name 有隐患）

**File:** `electron/services/ouiService.ts:115-120`
**Issue:** update 同步逻辑：`this.vendorMap?.set(this.normalizeMac(newRow.oui_prefix ?? ''), newRow.vendor_name ?? '')`。若 newRow.vendor_name 实际为 null/undefined（不应发生，因为表 NOT NULL，但 TS 类型上是 string|undefined），会把 `''` 写入 Map，导致后续 `getVendor` 返回空串而非 'Unknown'，且 `|| 'Unknown'` 在 getVendor 中只对 falsy 兜底——空串 falsy 也会兜底，所以实际仍返 'Unknown'，但 Map 中残留一个 `''` 脏值。

更实质的隐患：update 先 `getById(input.id)` 取 oldRow，再 UPDATE，再 getById 取 newRow。若并发（Electron 主进程单线程同步 SQL 一般无并发，但 IPC 重入场景理论存在），oldRow/newRow 可能错配。实际风险低（better-sqlite3 同步、主进程单线程），降为 WARNING 提示而非 BLOCKER。

建议加 newRow/vendor_name 存在性断言，避免脏值入 Map：
**Fix:**
```typescript
if (newRow && newRow.vendor_name != null) {
  this.vendorMap?.set(this.normalizeMac(newRow.oui_prefix ?? ''), newRow.vendor_name)
  if (oldRow?.oui_prefix && oldRow.oui_prefix !== newRow.oui_prefix) {
    this.vendorMap?.delete(this.normalizeMac(oldRow.oui_prefix))
  }
}
```

### WR-04: anomalyService.ipInCIDR / ipToNumber 无输入校验，畸形 CIDR/IP 规则静默失效

**File:** `electron/services/anomalyService.ts:45-57`
**Issue:** `ipInCIDR(ip, cidr)` 与 `networkSegmentService.ipInCIDR`（line 123-131）实现不一致：后者对非法 IP/prefix 显式返回 false，前者完全无校验——`ipToNumber` 对 'abc' 返回 NaN（`Number('a')`=NaN，位运算 NaN→0），`prefix = parseInt(undefined, 10)`=NaN，`mask = (0xFFFFFFFF << (32-NaN)) >>> 0` = 0xFFFFFFFF（`<<` 对 NaN shift 视为 0）→ 比较退化为 `(0 & 0xFFFFFFFF) === (0 & 0xFFFFFFFF)` → **恒为 true**，意味着一条畸形 CIDR 规则会把所有 IP 误判为"已排除"，使 processARPEntries 对所有 IP 全部 continue（ ARP 处理整体失效）。

虽然 excluded_ips 通常由用户经 UI 录入合法值，但 addExcludedIP 无格式校验（line 175-178 直接 INSERT 任意字符串），畸形 cidr（如 `192.168.1.0/` 或 `notacidr/8`）会落入 cidrs 数组触发本 bug。

**Fix:** 修复 anomalyService.ipInCIDR 使其与 networkSegmentService 版本一致（已有健壮实现可镜像）：
```typescript
private static ipInCIDR(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr ?? '', 10)
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false
  const ipNum = this.ipToNumber(ip)
  const networkNum = this.ipToNumber(network)
  if (ipNum === null || networkNum === null) return false
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
  return (ipNum & mask) === (networkNum & mask)
}
```
配套把 `ipToNumber` 改为返回 `number | null` 并校验 4 段 + 0-255 范围（镜像 networkSegmentService.ipToNumber line 116-120）。

## Info

### IN-01: getStats 的 'new_ip' 计数永远为 0（change_type 'new_ip' 无任何代码路径写入）

**File:** `electron/services/anomalyService.ts:161`
**Issue:** `processARPEntries` 仅产出 `'mac_changed'`（line 86）与 `'ip_reused'`（line 96）两种 changeType，从不产出 `'new_ip'`。`getStats` 返回的 `newIp` 字段（line 161）恒为 0，`exportService.ts:46` 的标签映射 `{ new_ip: '新IP' }` 也对应不到任何数据。预存缺陷，Phase 3 未触碰但 getStats 在本次 review 文件内。建议要么在 processARPEntries 的 "无 oldBinding 且无 currentBinding" 分支补发 'new_ip'，要么从 getStats/exportService 移除该字段，避免误导前端。

### IN-02: anomalyService.ipInCIDR 与 networkSegmentService.ipInCIDR 实现重复且行为不一致

**File:** `electron/services/anomalyService.ts:45-52` vs `electron/services/networkSegmentService.ts:123-131`
**Issue:** 两份 CIDR 判定逻辑、两份 ipToNumber。建议抽到共享 util（如 `electron/utils/ip.ts`），单一真相，避免 WR-04 这类"一处健壮一处不健壮"的偏差。Phase 3 引入了 preload 路径使 anomalyService 这份被频繁调用，统一收益提升。

### IN-03: OUIService 多处 `as any` 返回类型，丢失类型约束

**File:** `electron/services/ouiService.ts:57,62,68,79`（及多处 `as any`/`any[]`）
**Issue:** `getAll`/`search`/`getById`/`add` 等返回 `any[]`/`any`，调用方（含 networkSegmentService.getIPDetails）拿到无类型对象。预存模式，Phase 3 未恶化但 update/delete 的增量同步逻辑因 `as { oui_prefix?: string } | undefined` 这类宽松断言掩盖了潜在 null 路径（见 WR-03）。建议定义 `OuiRow`/`OuiEntry` interface 替代 any。

### IN-04: getIPUsage 的 total 计算 Math.pow(2, 32-cidr) 对 /0 网段产生 ~4.29B（语义无意义但数值安全）

**File:** `electron/services/networkSegmentService.ts:78`
**Issue:** `Math.pow(2, 32 - segment.cidr) - 2`。cidr=0 → 4,294,967,294，未超 Number.MAX_SAFE_INTEGER（2^53），数值无精度损失；但 /0 网段无运维语义，usagePercent 几乎恒为 0。可在 cidr 过小时返回 0 或限定 cidr≥8。非缺陷，仅提示。Phase 3 未改动此函数（仅 getIPDetails），列出供参考。

---

_Reviewed: 2026-06-28_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
