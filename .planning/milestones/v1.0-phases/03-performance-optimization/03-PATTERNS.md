# Phase 3: Performance Optimization - Pattern Map

**Mapped:** 2026-06-28
**Files analyzed:** 6 (5 modified in place, 0 net-new files; v7 is a new step inside an existing registry file)
**Analogs found:** 6 / 6 (every change has a real codebase precedent — no net-new patterns)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `electron/services/ouiService.ts` (MOD — PERF-01) | service | request-response (read cache + write-through) | self (`ouiService.ts`) — getVendor 现状 + 写方法现状；模块级 Map 先例 = `networkSegmentService.ts:58,49` `Set`/`Map` 内存结构 | exact (modify in place) |
| `electron/services/networkSegmentService.ts` (MOD — PERF-01 顺带 bug) | service | request-response (N+1 read path) | self (`networkSegmentService.ts:104-108`) — `getIPDetails` 的 `rows.map` 块 | exact (modify in place, 2 lines) |
| `electron/services/anomalyService.ts` (MOD — PERF-02) | service | batch (loop write) | `electron/database/init.ts:346-351` `initDefaultOUIData` 的 `db.transaction(() => { for... stmt.run() })` 批量写先例 | role-match (事务+prepared 复用是同一模式跨文件) |
| `electron/database/init.ts` (MOD — PERF-03 DDL + PERF-04 日志) | config/bootstrap | batch (DDL exec) | self — §252-280 FTS trigger DDL（PERF-03 加 WHEN）、§293-352 `initDefaultOUIData`（PERF-04 日志点）、§3 `createTables`（PERF-04 幂等日志点） | exact (modify in place) |
| `electron/database/migrations.ts` (MOD — PERF-03 v7) | service (migration registry) | batch (versioned step) | self — `v5`/`v6` (`migrations.ts:80-162`) sqlite_master sql-content 守卫 + DROP+CREATE 重建 + `db.pragma('user_version = N')`；`MIGRATIONS` 注册表 §164 | exact (add step to existing registry) |
| `electron/main.ts` (MOD — PERF-04 启动序列插入 `OUIService.preload()`) | config/bootstrap | event-driven (app lifecycle) | self — `main.ts:79-81` `initDatabase → createTables → migrateAndSecure` 序列 | exact (extend in place) |

> **无新增文件。** PERF-01/02/03/04 全部是对现有 service / DB / migration / main 文件的就地改造。`OUIService.preload()` 与 `vendorMap` 是 `ouiService.ts` 内新增的 static 成员，不构成新文件。v7 是 `migrations.ts` 既有 `MIGRATIONS` 注册表的第 7 项。

---

## Pattern Assignments

### `electron/services/ouiService.ts` (MOD — PERF-01, service, request-response + write-through)

**Analog:** self + `networkSegmentService.ts` 内存结构先例。改造目标 = 现状 `getVendor` 每次查库（行 4-11）改为读模块级 Map，5 个写方法（add/addBatch/update/delete/deleteBatch）写库后增量同步 Map。

**现状 imports** (`ouiService.ts:1`) — 改造后保持：
```typescript
import { getDatabase } from '../database/connection'
```

**getVendor 现状（改造对象）** (`ouiService.ts:4-11`)：
```typescript
static getVendor(mac: string): string {
  if (!mac) return 'Unknown'
  const db = getDatabase()
  const normalizedMac = mac.replace(/[:\-\.]/g, '').toUpperCase()
  const oui = normalizedMac.substring(0, 6)
  const row = db.prepare('SELECT vendor_name FROM oui_database WHERE oui_prefix = ?').get(oui) as { vendor_name: string } | undefined
  return row?.vendor_name || 'Unknown'
}
```
> 改造：模块级 `private static vendorMap: Map<string, string> | null = null`；`preload()` 全量 `SELECT oui_prefix, vendor_name FROM oui_database` 载入；`getVendor` 复用现有 `replace(/[:\-\.]/g, '').toUpperCase().substring(0,6)`（行 7-8）作 Map key 归一化，`map.get(oui)` miss 返回 `'Unknown'`。Map 为 `null` 时回退原 `prepare().get()` 查库路径（D-P1 优雅降级）。

**模块级 static 字段先例**（`networkSegmentService.ts:49`）— 项目已用模块内 `Map`/`Set` 内存结构，本次 `vendorMap` 与架构一致：
```typescript
const segments = new Map<string, { ips: string[]; count: number }>()
// ... const existingNetworks = new Set(this.getAll().map((s: any) => s.network))  // 行 58
```

**5 个写方法（增量同步 Map 的 hook 点）**：
- `add` (`ouiService.ts:28-34`) — `INSERT` 成功后 `map?.set(normalizedPrefix, input.vendorName)`
- `addBatch` (`ouiService.ts:36-45`) — 循环内 `INSERT OR REPLACE` 后对每条 `map?.set(normalizedPrefix, vendorName)`
- `update` (`ouiService.ts:47-61`) — `UPDATE` 后若 vendorName/ouiPrefix 变更，`map?.set(newPrefix, vendorName)`（prefix 变更还需 `map?.delete(oldPrefix)`）
- `delete` (`ouiService.ts:63-66`) — 删除前先 `getById` 取 prefix（或在 SQL 内 RETURNING），成功后 `map?.delete(prefix)`
- `deleteBatch` (`ouiService.ts:68-72`) — 同上批量

> 关键：`map?.set/delete` 用可选链——Map 未预载（`null`）时 no-op，不强制触发预载。Map 已预载则即时同步，零脏读窗口（D-P1 选增量而非失效重载的理由）。

---

### `electron/services/networkSegmentService.ts` (MOD — PERF-01 顺带 bug, service, N+1 read path)

**Analog:** self — `getIPDetails` 的 `rows.map` 块（`networkSegmentService.ts:104-108`）。仅改行 107 的双查为单查 + 局部缓存。

**现状双查 bug** (`networkSegmentService.ts:104-108`)：
```typescript
return rows.map((entry) => ({
  ip: entry.ip, mac: entry.mac, status: entry.status, lastSeen: entry.collectedAt,
  interface: entry.interface, deviceName: entry.deviceName || undefined,
  macVendor: entry.mac ? (OUIService.getVendor(entry.mac) === 'Unknown' ? undefined : OUIService.getVendor(entry.mac)) : undefined,
}))
```
> 行 107 对同一 mac 调用 **两次** `getVendor`（三元表达式两次求值）。改造为单次调用 + 局部变量：
```typescript
// 目标形态（planner 可调命名）：
macVendor: entry.mac ? (() => { const v = OUIService.getVendor(entry.mac); return v === 'Unknown' ? undefined : v })() : undefined
```
> getVendor 改读 Map 后本身已是 O(1)，但单查修复仍必要（消除冗余调用 + Map miss 时的回退查库 N+1 翻倍）。

---

### `electron/services/anomalyService.ts` (MOD — PERF-02, service, batch loop-write)

**Analog:** `electron/database/init.ts:346-351` `initDefaultOUIData` 的 `db.transaction(() => { for... stmt.run() })` — 项目既有"整批单事务 + prepared statement 复用"先例（CONTEXT §code_context 明示）。

**事务化批量写先例** (`init.ts:346-351`) — PERF-02 的 `processARPEntries` 直接镜像此模式：
```typescript
const stmt = db.prepare('INSERT OR IGNORE INTO oui_database (oui_prefix, vendor_name) VALUES (?, ?)')  // prepared 提到循环外
// ... entries 定义 ...
const insertMany = db.transaction(() => {
  for (const [prefix, vendor] of entries) {
    stmt.run(prefix, vendor)   // 循环内复用 prepared
  }
})
insertMany()   // 一次 COMMIT
```

**processARPEntries 现状（改造对象）** (`anomalyService.ts:41-71`) — 循环内 4 处 `db.prepare(...)`（行 50, 56, 59, 62）+ 每行 `isIPExcluded` 全表扫（行 48）：
```typescript
static processARPEntries(entries: Array<{ ip: string; mac: string }>): IPMACChange[] {
  const db = getDatabase()
  const changes: IPMACChange[] = []
  const now = new Date().toISOString()

  for (const entry of entries) {
    const { ip, mac } = entry
    if (this.isIPExcluded(ip)) continue                                          // ← 行 48：每行查 excluded_ips（隐含 N+1）

    const currentBinding = db.prepare('SELECT id, mac FROM ip_mac_bindings WHERE ip = ? AND is_active = 1').get(ip) as ...  // ← 行 50
    if (currentBinding) {
      if (currentBinding.mac !== mac) {
        const change = this.recordChange(ip, currentBinding.mac, mac, 'mac_changed')
        if (change) changes.push(change)
        db.prepare('UPDATE ip_mac_bindings SET is_active = 0 WHERE id = ?').run(currentBinding.id)   // ← 行 56
        this.createBinding(db, ip, mac, now)
      } else {
        db.prepare('UPDATE ip_mac_bindings SET last_seen = ? WHERE id = ?').run(now, currentBinding.id)  // ← 行 59
      }
    } else {
      const oldBinding = db.prepare('SELECT mac FROM ip_mac_bindings WHERE ip = ? ORDER BY last_seen DESC LIMIT 1').get(ip) as ...  // ← 行 62
      ...
    }
  }
  return changes
}
```
> 改造（D-P2）：(a) 整个 `for` 包进 `db.transaction(() => { ... })`，一次 COMMIT；(b) 4 处 `db.prepare(...)` 提到事务/循环外 prepare 一次、循环内 `.get/.run` 复用；(c) `isIPExcluded` 改为事务前一次性预载 `excluded_ips` 为内存 `Set`（普通 IP）+ 规则数组（CIDR/通配），循环内纯内存判定（复用现有 `ipInCIDR` 行 27-34 + 通配 regex 行 18-21 逻辑）；(d) 条目级 try/catch **保留**（见 createBinding/recordChange 现状），捕获后 `continue`——不让 throw 冒泡触发整批 ROLLBACK（D-P2 "尽力而为"语义不变，PROJECT.md 向后兼容红线）。

**条目级 try/catch 现状（事务化后必须保留）** (`anomalyService.ts:73-87`)：
```typescript
private static createBinding(db: any, ip: string, mac: string, now: string): void {
  try {
    db.prepare('INSERT INTO ip_mac_bindings ...').run(ip, mac, now, now)
  } catch {
    db.prepare('UPDATE ip_mac_bindings SET last_seen = ?, is_active = 1 WHERE ip = ? AND mac = ?').run(now, ip, mac)
  }
}
private static recordChange(...): IPMACChange | null {
  const db = getDatabase()
  try {
    const result = db.prepare('INSERT INTO ip_mac_changes ...').run(...)
    return { ... }
  } catch (e: any) { console.error('[anomaly] recordChange 插入失败:', ip, e.message); return null }
}
```
> 注意：`createBinding` 已接收 `db` 参数（行 73）——事务内复用同一 db 句柄即可，无需改签名。`recordChange` 现自行 `getDatabase()`（行 82），事务内调用仍落入同一连接（better-sqlite3 单连接同步），事务边界覆盖正确。

---

### `electron/database/init.ts` (MOD — PERF-03 DDL 加 WHEN + PERF-04 幂等跳过日志)

**Analog:** self — §252-280 FTS trigger 块（PERF-03）、§3 `createTables`/§293 `initDefaultOUIData`（PERF-04 日志点）。

**FTS trigger 现状（PERF-03 改造对象）** (`init.ts:261-280`) — 三个 trigger，`_au`（行 273）缺 WHEN：
```sql
CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
    VALUES (new.rowid, new.title, new.content,
      (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = new.id));
END;

CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
    VALUES ('delete', old.rowid, old.title, old.content,
      (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = old.id));
END;

CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN   -- ← 行 273：缺 WHEN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
    VALUES ('delete', old.rowid, old.title, old.content,
      (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = old.id));
  INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
    VALUES (new.rowid, new.title, new.content,
      (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = new.id));
END;
```
> 改造（D-P3）：`_au` 加 WHEN（覆盖 FTS 索引全部来源字段）：
```sql
CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks
WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids
BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
    VALUES ('delete', old.rowid, old.title, old.content,
      (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = old.id));
  INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
    VALUES (new.rowid, new.title, new.content,
      (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = new.id));
END;
```
> 新装库直接建带 WHEN 的版本。现有库由 v7 迁移 DROP+CREATE（见下）。注意 `CREATE TRIGGER IF NOT EXISTS` 对"已存在但定义不同"的 trigger **不会替换**——故现有库必须 v7 先 DROP 再 CREATE（IF NOT EXISTS 仅防 fresh-install 重复）。`_ai`/`_ad` 不变（INSERT/DELETE 无 WHEN 概念）。

**PERF-04 幂等跳过日志点** — 三个既有跳过机制：
- `createTables()` 整体 `CREATE TABLE IF NOT EXISTS`（`init.ts:3-4`）— SQLite 快速跳过已存在表
- `initDefaultOUIData` 的 `count > 0 return` 守卫（`init.ts:294-295`）：
```typescript
function initDefaultOUIData(db: any) {
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM oui_database').get() as any).cnt
  if (count > 0) return   // ← 行 295：PERF-04 日志点
  ...
}
```
- `runMigrations` 的 `if (current >= MIGRATION_HEAD) return`（`migrations.ts:187`）— 见下节

> 改造（D-P4）：在三个跳过早返回点加可观测日志（`createSystemLog` type=`migration` 复用，或启动早期 system_logs 表未就绪时回退 `console.log`）。注意 `ai_system_logs.type` CHECK 现仅 `discovery/acl/migration/backup`（`init.ts:86` + `migrations.ts:143` v6 已 widen）——若用新 type 需 v8 迁移扩 CHECK（CONTEXT §discretion：planner 判断是否值得，或直接复用 `migration` type 避免 v8）。

---

### `electron/database/migrations.ts` (MOD — PERF-03 v7, migration registry, batch)

**Analog:** self — `v5` (`migrations.ts:80-128`) 与 `v6` (`migrations.ts:130-162`) 是 **trigger/表重建 + sqlite_master sql-content 幂等守卫 + DROP+CREATE** 的直接先例。v7 镜像此模式处理 trigger。

**trigger 重建 + 幂等守卫先例（v6, 最贴近 v7）** (`migrations.ts:130-162`) — v7 对 trigger 的 DROP+CREATE 与 v6 对表的 DROP+CREATE 结构同构：
```typescript
const v6 = (db: Database.Database): void => {
  // 幂等守卫：sqlite_master sql-content（已含目标特征则 no-op，D-14）
  const logSchema = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_system_logs'").get() as { sql?: string } | undefined)?.sql || ''
  if (logSchema.includes("'warning'")) {
    return // CHECK 已放开，no-op（幂等重跑 D-14）
  }
  const step = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS ai_system_logs_new")
    db.exec(`CREATE TABLE ai_system_logs_new ( ... );`)
    db.exec(`INSERT INTO ai_system_logs_new SELECT ... FROM ai_system_logs;`)
    db.exec(`DROP TABLE ai_system_logs;`)
    db.exec(`ALTER TABLE ai_system_logs_new RENAME TO ai_system_logs;`)
    db.pragma('user_version = 6')
  })
  step()
}
```
> **v7 target 形态（planner 填具体 DDL 字符串）**：
```typescript
const v7 = (db: Database.Database): void => {
  // 幂等守卫：检查 kb_chunks_au 现有 sql 是否已含 WHEN（D-14 sqlite_master sql-content 第二形式）
  const triggerSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='kb_chunks_au'"
  ).get() as { sql?: string } | undefined)?.sql || ''
  if (triggerSql.includes('WHEN')) {
    return // trigger 已带 WHEN，no-op（幂等重跑 D-14）
  }
  const step = db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS kb_chunks_au')
    db.exec(`CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks
WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids
BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
    VALUES ('delete', old.rowid, old.title, old.content,
      (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = old.id));
  INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
    VALUES (new.rowid, new.title, new.content,
      (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = new.id));
END`)
    db.pragma('user_version = 7')
  })
  step()
}
```
> v7 不需要 `foreign_key_check`（trigger 改动不涉表数据完整性，区别于 v5/v6 表重建）。守卫用 `type='trigger' AND name='kb_chunks_au'` 查 sql 是否含 `WHEN`，与 v5 查 `'rdp'`、v6 查 `'warning'` 同模式。

**注册表 + HEAD 推进** (`migrations.ts:16, 164-171`)：
```typescript
export const MIGRATION_HEAD = 6   // ← 改为 7

const MIGRATIONS: MigrationStep[] = [
  { version: 1, name: 'chat_history.session_id', run: v1 },
  { version: 2, name: 'ai_exec_logs.prompt_text+ai_response', run: v2 },
  { version: 3, name: 'devices.status+last_checked', run: v3 },
  { version: 4, name: 'ai_config.vision_*', run: v4 },
  { version: 5, name: 'devices.connection_type CHECK rdp rebuild', run: v5 },
  { version: 6, name: 'ai_system_logs CHECK widen (acl/migration/backup + warning)', run: v6 },
  { version: 7, name: 'kb_chunks_au FTS UPDATE trigger add WHEN (skip non-FTS-field updates)', run: v7 },  // ← 新增
]
```

**runMigrations version 跳过早返回（PERF-04 日志点之一）** (`migrations.ts:182-187`)：
```typescript
export function runMigrations(): void {
  const db = getDatabase()
  const currentRow = db.pragma('user_version') as Array<{ user_version: number }>
  const current = currentRow[0]?.user_version ?? 0

  if (current >= MIGRATION_HEAD) return   // ← 行 187：PERF-04 "迁移已最新跳过"日志点
  ...
}
```

---

### `electron/main.ts` (MOD — PERF-04 启动序列插入 OUIService.preload)

**Analog:** self — `main.ts:79-81` 启动序列。`OUIService.preload()` 插入在 `migrateAndSecure()` 之后、IPC 注册之前（D-P1 确保首次 `getIPDetails` 时 Map 就绪）。

**现状启动序列** (`main.ts:79-92`)：
```typescript
  initDatabase()
  createTables()
  migrateAndSecure()   // 迁移前备份(gated on 非空库) + runMigrations + ACL 收紧 db/wal/shm（D-06/D-12a）

  // IP Management IPC
  registerArpIpc()
  registerNetworkIpc()
  registerAnomalyIpc()
  registerOuiIpc()
  ...
```
> 改造：在 `migrateAndSecure()` 之后、`registerArpIpc()` 之前插入：
```typescript
  initDatabase()
  createTables()
  migrateAndSecure()
  OUIService.preload()   // ← 新增：启动预载 Map<macPrefix,vendor>（PERF-01，D-P1 时机）

  // IP Management IPC
  registerArpIpc()
  ...
```
> `preload()` 失败不抛（D-P1 优雅降级：Map 保持 null，getVendor 回退查库）——故此处无需 try/catch；若 planner 想记录预载失败可包 try/catch + `console.error`（启动早期 system_logs 表已就绪，亦可 `createSystemLog` type=`migration`）。需新增 import `import { OUIService } from './services/ouiService'`（main.ts 现未 import OUIService）。

---

## Shared Patterns

### 事务化批量写（整批单 COMMIT + prepared statement 复用）
**Source:** `electron/database/init.ts:346-351` (`initDefaultOUIData`)
**Apply to:** PERF-02 `processARPEntries`（`anomalyService.ts:41-71`）—— `db.transaction(() => { for... })` 包循环 + 循环外 prepare、循环内 `.run/.get` 复用。better-sqlite3 同步事务，一次 COMMIT 替代 N 次 autocommit。

### 迁移步骤：原子步骤 + sqlite_master sql-content 幂等守卫
**Source:** `electron/database/migrations.ts:80-162`（v5/v6）
**Apply to:** PERF-03 v7 迁移（`migrations.ts` 新增第 7 项）—— `db.transaction(() => { DROP ...; CREATE ...; db.pragma('user_version = N') })`；守卫用 `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='kb_chunks_au'` 检查是否已含 `WHEN`，已含则 no-op（D-14 第二形式，与 v5 查 `'rdp'`、v6 查 `'warning'` 同构）。

### getDatabase 单例访问器
**Source:** `electron/database/connection.ts:16-19`
**Apply to:** 全部新增 DB 访问（OUIService.preload、anomalyService 事务内复用、PERF-04 日志）：
```typescript
export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}
```

### hasColumn helper（列存在检查，v1-v4 用）
**Source:** `electron/database/migrationHelpers.ts:8-11`
**Apply to:** v7 不直接需要（trigger 无列概念，用 sqlite_master trigger sql 守卫），但保持知晓——v7 守卫走 `sqlite_master` 而非 `hasColumn`（与 v5/v6 表/CHECK 重建同）：
```typescript
export function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === col)
}
```

### createSystemLog（启动跳过事件 / 非致命事件记录）
**Source:** `electron/services/systemLog.ts:17-43`（用法先例：`connection.ts:71-73` fresh-install 跳过备份 warning + `migrations.ts:196-202` 迁移失败 log）
**Apply to:** PERF-04 三个幂等跳过点的可观测日志（createTables / initDefaultOUIData count>0 / runMigrations version≥HEAD）。type 复用 `migration`（CHECK 已含，无需 v8）；调用点 try/catch 包裹（启动早期若 system_logs 表未就绪则回退 `console.log`）：
```typescript
try {
  createSystemLog({ type: 'migration', status: 'success', errorMessage: '[startup] ... 跳过（已幂等）' })
} catch { console.log('[startup] ... 跳过（已幂等，system_logs 未就绪回退）') }
```
> 字段截断 16000 字符（`systemLog.ts:45-49`）。

### mac 归一化（Map key 规范化复用）
**Source:** `electron/services/ouiService.ts:7-8`
**Apply to:** PERF-01 `vendorMap` 的 key 必须与 `getVendor` 现有归一化逻辑一致（同函数复用，避免 key 不匹配 miss）：
```typescript
const normalizedMac = mac.replace(/[:\-\.]/g, '').toUpperCase()
const oui = normalizedMac.substring(0, 6)   // ← Map key
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| _(无)_ | — | — | 本阶段全部改动均落在已有文件，每一项都有 codebase 内直接先例（事务批量写 / sqlite_master 守卫迁移 / getDatabase / createSystemLog / 模块级 Map）。无 net-new 模式。 |

## Metadata

**Analog search scope:** `electron/services/`（ouiService, anomalyService, networkSegmentService, systemLog）、`electron/database/`（init, migrations, connection, migrationHelpers）、`electron/main.ts`、`electron/ipc/ouiIpc.ts`
**Files scanned:** ouiService.ts（全文 86 行）、anomalyService.ts（全文 146 行）、networkSegmentService.ts（全文 136 行，聚焦 §88-108）、init.ts（全文 352 行，聚焦 §3/§84-95/§252-280/§293-352）、migrations.ts（全文 210 行）、connection.ts（全文 85 行）、migrationHelpers.ts（全文 11 行）、systemLog.ts（全文 67 行）、main.ts（聚焦 §1-26/§55-92/§158-160）、ouiIpc.ts（全文 32 行）
**Pattern extraction date:** 2026-06-28
