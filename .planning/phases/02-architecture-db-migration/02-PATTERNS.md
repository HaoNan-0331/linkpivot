# Phase 2: Architecture & DB Migration - Pattern Map

**Mapped:** 2026-06-28
**Files analyzed:** 7 (3 new, 4 modified)
**Analogs found:** 7 / 7 (all have a real codebase analog)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `electron/services/backupScheduler.ts` (NEW) | service | event-driven (interval tick) | `electron/services/schedulerService.ts` | exact (mirror) |
| `src/types/backup.ts` (NEW) | model/type | config | `src/types/oui.ts` (ScheduleConfig/SchedulerStatus) | exact (mirror) |
| `electron/database/migrations.ts` (NEW) | service (migration registry) | batch (versioned steps) | `electron/database/init.ts` §310-356 (devices rebuild transaction) | role-match (no registry yet) |
| `electron/database/migrationHelpers.ts` (NEW) | utility | request-response | `electron/database/init.ts` §275-308 (PRAGMA table_info checks) + `connection.ts` getDatabase | exact (consolidation of existing inline pattern) |
| `electron/database/acl.ts` (NEW, or fold into connection.ts) | utility | file-I/O | none in repo (net-new cross-platform shell helper); config precedent in `connection.ts` PRAGMA block | no analog (file ACL new) |
| `electron/database/connection.ts` (MOD) | config/bootstrap | request-response | `electron/database/connection.ts` (self — initDatabase is the hook point) | exact (modify in place) |
| `electron/database/init.ts` (MOD) | config/bootstrap | batch | `electron/database/init.ts` §273-356 (self — the block being refactored) | exact (refactor in place) |
| `electron/main.ts` (MOD) | config/bootstrap | event-driven (app lifecycle) | `electron/main.ts` §54-89 (whenReady) + §157 (before-quit) | exact (extend in place) |

> Planner note on naming: file names above (`migrations.ts`, `migrationHelpers.ts`, `acl.ts`) are suggestions per CONTEXT §Claude's Discretion. The planner may keep `hasColumn`+`migrations` in one file or split — both are within discretion. The `restrictFilePermissions` ACL helper may live in its own file or in `connection.ts` near the DB path.

## Pattern Assignments

### `electron/services/backupScheduler.ts` (NEW — service, event-driven)

**Analog:** `electron/services/schedulerService.ts` — **mirror its structure exactly** (per D-05). Difference: `runTask` calls `db.backup()` + bucket rotation instead of ARP collection.

**Imports pattern** (`schedulerService.ts:1-5`) — project convention (relative paths, `getDatabase` from connection):
```typescript
import { BrowserWindow } from 'electron'
import { getDatabase } from '../database/connection'
import { ARPCollector } from './arpCollector'   // BackupScheduler replaces with backup/rotation helpers
```

**Static-class skeleton + interval + restart** (`schedulerService.ts:7-25`) — copy verbatim, rename to `BackupScheduler`:
```typescript
export class SchedulerService {
  private static intervalId: ReturnType<typeof setInterval> | null = null
  private static isRunning = false

  static start(): void {
    if (this.intervalId) return
    const config = this.getConfig()
    if (!config.enabled) return
    const intervalMinutes = config.intervalMinutes ?? 60
    this.updateNextRun(intervalMinutes)
    this.intervalId = setInterval(() => { this.runTask().catch((e) => console.error('[Scheduler] interval run failed:', e)) }, intervalMinutes * 60 * 1000)
    if (this.shouldRunNow(config)) this.runTask().catch((e) => console.error('[Scheduler] initial run failed:', e))
  }

  static stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null }
  }

  static restart(): void { this.stop(); this.start() }
```
> BackupScheduler uses default `intervalMinutes = 1440` (D-01, 24h) instead of 60.

**shouldRunNow (启动补跑模式 — D-01 requires BackupScheduler to reuse this)** (`schedulerService.ts:78-84`):
```typescript
private static shouldRunNow(config: any): boolean {
  if (!config.lastRun) return true
  try {
    const elapsed = Date.now() - new Date(config.lastRun).getTime()
    return elapsed >= (config.intervalMinutes ?? 60) * 60 * 1000
  } catch { return true }
}
```

**Config persistence pattern (DB row, id=1 singleton)** (`schedulerService.ts:86-113`) — BackupScheduler mirrors this against its own config table/row (e.g. `backup_config`), extending with retention fields. Note the `getConfig` lazy-seed-on-missing-row pattern:
```typescript
static getConfig(): any {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM scheduler_config WHERE id = 1').get() as any
  if (!row) {
    db.prepare('INSERT INTO scheduler_config (id, enabled, interval_minutes) VALUES (1, 0, 60)').run()
    return { id: 1, enabled: false, intervalMinutes: 60, lastRun: null, nextRun: null }
  }
  return { id: row.id, enabled: Boolean(row.enabled), intervalMinutes: row.interval_minutes ?? 60, lastRun: row.last_run, nextRun: row.next_run }
}
```
> BackupScheduler `runTask` difference (D-04): replace ARP loop with `getDatabase().backup(path.join(backupsDir, filename))` then per-bucket FIFO rotation (D-02: periodic=7, premigration=5, trim by mtime after each successful backup).

**Schema for config singleton** (`init.ts:192-198`) — BackupScheduler's `backup_config` table should mirror this `id PRIMARY KEY CHECK (id = 1)` singleton shape, adding retention columns:
```sql
CREATE TABLE IF NOT EXISTS scheduler_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_run TEXT,
  next_run TEXT
);
```

**notifyRenderer pattern** (`schedulerService.ts:115-117`) — reuse for backup-completed events:
```typescript
private static notifyRenderer(channel: string, data: any): void {
  for (const win of BrowserWindow.getAllWindows()) { win.webContents.send(channel, data) }
}
```

---

### `src/types/backup.ts` (NEW — type, config)

**Analog:** `src/types/oui.ts:27-44` — **copy ScheduleConfig/SchedulerStatus/UpdateScheduleInput and extend with retention** (per D-05).

```typescript
export interface ScheduleConfig {
  id: number
  enabled: boolean
  intervalMinutes: number
  lastRun: string | null
  nextRun: string | null
}

export interface SchedulerStatus {
  isRunning: boolean
  isTaskRunning: boolean
  config: ScheduleConfig
}

export interface UpdateScheduleInput {
  enabled?: boolean
  intervalMinutes?: number
}
```
> BackupConfig extends ScheduleConfig with retention: `periodicRetention: number` (default 7), `premigrationRetention: number` (default 5) per D-02.

---

### `electron/database/migrations.ts` (NEW — migration registry, batch)

**Analog (transaction-wrapped atomic step):** `electron/database/init.ts:316-356` — the devices table rebuild is the **established precedent for transactional schema migration** (D-07 requires every version step follow this). Extract and generalize into a version→step registry.

**Atomic version step pattern** (`init.ts:312-356`) — note: `db.transaction(() => { DDL...; })` is the unit; D-07 wraps `db.pragma('user_version = N')` **inside the same transaction** so DDL + version commit atomically:
```typescript
// Migrate: expand connection_type CHECK constraint to include 'rdp'
// SQLite doesn't support ALTER CHECK, so recreate the table
const connTypeCheck = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get() as any)?.sql || ''
if (!connTypeCheck.includes("'rdp'")) {
  // 重建表（SQLite 不支持 ALTER CHECK），整段包事务保证原子：
  const rebuildDevices = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS devices_new")
    db.exec(`CREATE TABLE devices_new ( ... );`)
    db.exec(`INSERT INTO devices_new SELECT ... FROM devices;`)
    db.exec(`DROP TABLE devices;`)
    db.exec(`ALTER TABLE devices_new RENAME TO devices;`)
    const fkErrors = db.pragma('foreign_key_check') as any[]   // post-step integrity check — KEEP this pattern
    if (fkErrors.length > 0) {
      throw new Error('devices 重建后外键完整性校验失败: ' + JSON.stringify(fkErrors))
    }
  })
  rebuildDevices()
}
```
> For D-07 each step becomes: `db.transaction(() => { ...DDL (guarded by hasColumn/sqlite_master check per D-14)...; db.pragma(\`user_version = ${target}\`) })()`. The `foreign_key_check` post-step assertion is the established safety pattern — keep for any table-rebuild step.

**Migration runner shape (new — planner defines data structure per D-16):** a `Map<number, (db) => void>` with HEAD constant. Iterate from `current+1` to HEAD, run each step. D-06 inserts a premigration backup before step 1 if `current < HEAD`. D-08: step throws → better-sqlite3 auto-rolls-back the transaction → re-throw with `{stepName, sql, message}` + write system log + abort startup.

---

### `electron/database/migrationHelpers.ts` (NEW — utility, `hasColumn`)

**Analog (the exact pattern being consolidated):** `electron/database/init.ts:275-308` — **4 occurrences** of the same idempotent `PRAGMA table_info(X).some(c => c.name === Y)` check. `hasColumn` collapses these into one helper (D-09 / ARCH-01).

**Current scattered pattern (the thing hasColumn replaces)** (`init.ts:275-278`, repeated at 281, 290, 299):
```typescript
const db = getDatabase()
const cols = db.prepare("PRAGMA table_info(chat_history)").all() as any[]
if (!cols.some((c) => c.name === 'session_id')) {
  db.exec('ALTER TABLE chat_history ADD COLUMN session_id TEXT')
}
```
**Target helper signature** (uses `getDatabase` from `connection.ts:7-10`):
```typescript
import { getDatabase } from './connection'
export function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[]
  return cols.some((c) => c.name === col)
}
```
> Pass `db` in (don't call getDatabase inside) so it stays testable and composes inside the transaction scope of migration steps.

---

### `electron/database/acl.ts` (NEW — utility, file-I/O, cross-platform ACL)

**Analog:** **none in codebase** — net-new helper. Closest project conventions to follow: `connection.ts:12-19` (single `dbPath` resolution via `app.getPath('userData')`) for the file path source, and `systemLog.ts` (below) for failure handling.

**DB path source** (`connection.ts:13`) — ACL targets resolve from the same root:
```typescript
const dbPath = path.join(app.getPath('userData'), 'topology.db')  // + '-wal' / '-shm' sidecars + '/backups/'
```

**Required branch logic (D-10, D-11):**
```typescript
// Windows: icacls "<path>" /inheritance:r /grant:r "<currentUser>:(F)"
// Unix/macOS: fs.chmod(path, 0o600)
// currentUser via os.userInfo().username / process.env.USERNAME
```
**Targets (D-10):** `topology.db` + `topology.db-wal` + `topology.db-shm` + every file under `userData/backups/`.

---

### `electron/database/connection.ts` (MOD — config/bootstrap)

**Analog:** self (`connection.ts:1-24`). `initDatabase` is the **single hook point** for migration run + ACL tightening (CONTEXT §Integration Points).

**Current initDatabase** (`connection.ts:12-20`) — where migration call + ACL tightening are inserted:
```typescript
export function initDatabase(): Database.Database {
  const dbPath = path.join(app.getPath('userData'), 'topology.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 1000')
  return db   // <-- after this: ensure userData/backups/ exists, run migrations (D-06 premigration backup first), then ACL tighten db/wal/shm (D-12a)
}
```
> Ordering per CONTEXT §Integration Points (D-06 decides): ensure backups dir → premigration backup if pending migrations → run migrations (abort on failure, D-08) → ACL tighten active db files (D-12a, idempotent, non-fatal D-13). `closeDatabase` (`connection.ts:22-24`) is unchanged but main.ts will call BackupScheduler.stop() before it.

---

### `electron/database/init.ts` (MOD — refactor §273-356 into versioned registry)

**Analog:** self (`init.ts:273-356`). The 4 scattered `table_info` checks + devices rebuild are moved into `migrations.ts` registry entries, guarded by `hasColumn` (D-09, D-14).

**Lines to refactor (the migration block)** (`init.ts:273-356`):
- `chat_history.session_id` (273-278)
- `ai_exec_logs.prompt_text` / `.ai_response` (280-287)
- `devices.status` / `.last_checked` (289-296)
- `ai_config.vision_*` (298-308)
- devices CHECK-rebuild with 'rdp' (310-356) — the transactional precedent for D-07

Each becomes a registry step; the inline `table_info(...).some(...)` checks become `if (!hasColumn(db, table, col)) db.exec('ALTER ...')` (idempotent re-run per D-14/D-15). The devices rebuild step keeps its `sqlite_master` sql-content guard (already idempotent, D-14 second form) and its `foreign_key_check` assertion.

---

### `electron/main.ts` (MOD — register BackupScheduler on ready, stop on quit)

**Analog:** self — the `SchedulerService.start()` registration and `before-quit` cleanup are the **exact template** for BackupScheduler wiring (D-05).

**Ready handler registration** (`main.ts:54, 78-89`) — add `BackupScheduler.start()` alongside `SchedulerService.start()`:
```typescript
app.whenReady().then(() => {
  ...
  initDatabase()
  createTables()
  ...
  SchedulerService.start()
  BackupScheduler.start()   // <-- add, after SchedulerService.start()
  ...
})
```

**Quit cleanup** (`main.ts:157`) — add `BackupScheduler.stop()` **before** `closeDatabase()`:
```typescript
app.on('before-quit', () => closeDatabase())
// becomes:
app.on('before-quit', () => { BackupScheduler.stop(); closeDatabase() })
```

---

## Shared Patterns

### Atomic transactional migration step
**Source:** `electron/database/init.ts:316-356`
**Apply to:** every entry in `migrations.ts` registry (D-07)
```typescript
const step = db.transaction(() => {
  // ...DDL guarded by hasColumn / sqlite_master sql check (idempotent, D-14)...
  const fkErrors = db.pragma('foreign_key_check') as any[]   // post-step integrity assert (table-rebuild steps)
  if (fkErrors.length > 0) throw new Error('FK check failed: ' + JSON.stringify(fkErrors))
  db.pragma(`user_version = ${target}`)   // D-07: version bump INSIDE same txn = atomic commit
})
step()   // better-sqlite3 auto-rollback on throw = D-08 safety
```

### getDatabase singleton accessor
**Source:** `electron/database/connection.ts:7-10`
**Apply to:** all new DB-touching code (BackupScheduler, hasColumn, migration steps, ACL is file-only so excluded)
```typescript
export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}
```

### System log (non-fatal warning / event recording)
**Source:** `electron/services/systemLog.ts:17-43` (signature + usage at `discovery.ts:116-122`)
**Apply to:** ACL tightening failures (D-13, non-fatal), migration step failures (D-08), backup events
```typescript
import { createSystemLog } from '../services/systemLog'
createSystemLog({
  type: 'acl' | 'migration' | 'backup',   // planner defines concrete type strings
  status: 'failed' | 'success' | 'warning',
  errorMessage: (err as Error).message,
  // ...optional fields
})
```
> Wrap createSystemLog calls in try/catch at the call site (mirrors Phase 6 ROBUST-02 intent — don't let logging failure break the guarded path). Fields are truncated to 16000 chars (`systemLog.ts:45-49`).

### Static-class scheduler lifecycle
**Source:** `electron/services/schedulerService.ts:7-25, 78-84`
**Apply to:** `BackupScheduler` (exact mirror per D-05) — start/stop/restart/setInterval + shouldRunNow startup-catchup + id=1 singleton config row.

### DB path + userData root
**Source:** `electron/database/connection.ts:13`
**Apply to:** ACL targets, backups dir, premigration backup filenames
```typescript
const dbPath = path.join(app.getPath('userData'), 'topology.db')
// backups: path.join(app.getPath('userData'), 'backups')
// sidecars: dbPath + '-wal', dbPath + '-shm'
```

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `electron/database/acl.ts` (restrictFilePermissions) | utility | file-I/O | No cross-platform shell/chmod ACL code exists yet. Planner implements per D-11 (`icacls` / `chmod 0o600`) using node `child_process` + `fs`; follow `getDatabase` accessor convention + `createSystemLog` non-fatal failure handling (D-13). |

All other files have an exact or role-match analog in the existing codebase.

## Metadata

**Analog search scope:** `electron/services/`, `electron/database/`, `electron/main.ts`, `src/types/oui.ts`, `electron-builder.yml`
**Files scanned:** schedulerService.ts, connection.ts, init.ts (§1-30, §192-198, §265-356, §358-393), systemLog.ts, discovery.ts (§116 grep), main.ts (§1-19, §54-89, §155-157 grep), oui.ts (§27-44), electron-builder.yml (§6,12 grep)
**Pattern extraction date:** 2026-06-28
