---
phase: 02-architecture-db-migration
reviewed: 2026-06-28T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - electron/database/migrationHelpers.ts
  - electron/database/migrations.ts
  - electron/database/acl.ts
  - electron/database/connection.ts
  - electron/database/init.ts
  - electron/services/backupScheduler.ts
  - src/types/backup.ts
  - electron/main.ts
  - tests/unit/migrationHelpers.test.ts
findings:
  critical: 3
  warning: 7
  info: 6
  total: 16
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-06-28
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Phase 2 implements the versioned migration registry, cross-platform ACL helper, backup scheduler, and the `migrateAndSecure` integration. The architecture is generally sound: `hasColumn`/`sqlite_master` idempotency guards are correct, `execFileSync` uses `shell:false` (no command injection), `isRunning` is reset in a `finally` block, and `BackupScheduler.stop()` runs before `closeDatabase()` in the quit handler.

However, three **BLOCKER** defects undermine the phase's own safety goals:

1. The `ai_system_logs` schema's `CHECK` constraints reject every non-`discovery` log type and every non-`success`/`failed` status — so **all** ACL warnings, migration-failure logs, and backup-failure logs silently fail to persist (the failures are swallowed by the surrounding `try/catch`). The phase's D-08/D-13 audit trail is effectively non-existent.
2. `migrateAndSecure` reads `currentVersion` and gates the premigration backup **before** any baseline tables necessarily exist on a legacy upgrade, and `hasUserData` swallows all errors to `false` — meaning a legacy DB whose `topologies`/`devices` tables are intact but happen to be empty will skip the premigration backup and then have v5 rebuild `devices` with no safety net.
3. `PRAGMA user_version = N` inside a `db.transaction()` is **not** atomic with the DDL in the way the comments claim — `user_version` writes are not transactional in SQLite, so a crash between DDL commit and the (auto, non-transactional) `user_version` write leaves the DB in an indeterminate state on next start.

Additional warnings cover path-separator bugs on Windows, missing `await` in test, retention edge cases, and the `any` leaks the phase context flagged.

## Critical Issues

### CR-01: `ai_system_logs` CHECK constraints reject every type/status this phase logs — audit trail silently dropped

**File:** `electron/database/init.ts:86-87`, `electron/database/acl.ts:44,67`, `electron/database/migrations.ts:162`, `electron/database/connection.ts:57`, `electron/services/backupScheduler.ts:51,102`

**Issue:**
`init.ts` declares:
```sql
type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery')),
status TEXT NOT NULL CHECK(status IN ('success','failed')),
```
But every non-`discovery` caller of `createSystemLog` passes values that violate these constraints:
- `acl.ts`: `type:'acl'` (twice) — violates type CHECK
- `acl.ts`: `status:'warning'` — violates status CHECK
- `migrations.ts`: `type:'migration'` — violates type CHECK
- `connection.ts:57`: `type:'backup', status:'warning'` — violates both
- `backupScheduler.ts:51`: `type:'backup', status:'failed'` — violates type CHECK
- `backupScheduler.ts:102`: `type:'backup', status:'warning'` — violates both

Each `createSystemLog` call is wrapped in `try { ... } catch { /* 非致命 */ }`, so the `SQLITE_CONSTRAINT_CHECK` error is silently swallowed. Net effect: **none of the ACL/migration/backup warning or failure events this phase relies on (D-08 migration-failure audit, D-13 ACL-failure audit, backup-failure audit) ever reach the database.** The operator has no record that a migration failed or that ACL hardening failed. This directly defeats the phase's stated safety/audit goals and makes D-08's "写 system log" a no-op.

**Fix:**
Widen both CHECK constraints to admit the full enum actually used. In `init.ts`:
```sql
CREATE TABLE IF NOT EXISTS ai_system_logs (
  ...
  type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup','scheduler')),
  status TEXT NOT NULL CHECK(status IN ('success','failed','warning')),
  ...
```
Because this is a schema change to an existing table, ship it as a new migration step (v6) using the rebuild-with-CHECK pattern already used for `devices` in v5, rather than editing `createTables` alone (legacy DBs already have the narrow CHECK).

---

### CR-02: Premigration backup gate can skip the safety backup for a legacy DB that has data

**File:** `electron/database/connection.ts:51-60,76-89`

**Issue:**
`hasUserData()` returns `true` only if `topologies` or `devices` has > 0 rows. Any error inside (e.g. a transient SQLite error, or any `prepare().get()` throwing) is caught and returns `false`. The gate then concludes "fresh-install, skip backup" and proceeds directly into `runMigrations()`.

Two real failure paths:
1. A legacy DB being upgraded where the user has **only** IP-management data (`arp_entries`, `ip_mac_bindings`, `network_segments`, …) but no `topologies`/`devices` rows yet. `hasUserData()` returns `false` → no premigration backup → v5 then runs (`devices` rebuild) with no safety net. Data loss risk if v5's rebuild fails mid-way.
2. Any thrown error in `hasUserData` (e.g. `topologies` table unexpectedly missing on a partially-migrated DB) → `false` → backup skipped → migrations run unprotected.

The phase context explicitly requires: "legacy DB backed up". This gate does not honor that for empty-core-table legacy DBs.

**Fix:**
Gate on `user_version` and table existence, not row count. A DB that already has `MIGRATION_HEAD` schema is fresh-enough; everything else with `currentVersion < MIGRATION_HEAD` AND pre-existing tables should be backed up:
```ts
function hasUserData(): boolean {
  try {
    const conn = getDatabase()
    const tableCount = (conn.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { cnt: number }).cnt
    // Any application table at all (beyond what createTables just made) → treat as having data worth protecting.
    // Better: gate on currentVersion > 0 (a legacy DB that was already at some prior version).
    return tableCount > 0
  } catch {
    return false
  }
}
```
Or simplest and most correct: skip the backup **only** when `currentVersion === 0 && core tables are empty AND were just created by this start**. The cleanest signal is "did `topology.db` exist on disk before `initDatabase()` ran?" — capture that flag in `initDatabase()` and pass it through.

---

### CR-03: `PRAGMA user_version = N` is NOT transactional — DDL and version bump are not atomic as claimed

**File:** `electron/database/migrations.ts:24,32,45,58,74,124`

**Issue:**
The comments repeatedly assert "DDL 与 user_version 推进在同一事务内提交（D-07 原子）". This is incorrect. In SQLite, `PRAGMA user_version = N` writes to the database header page and is **not** rolled back by a transaction — `user_version` (and `application_id`) are specifically documented as not participating in the transaction mechanism the same way DDL does. better-sqlite3's `db.transaction()` will roll back the `ALTER TABLE`/`CREATE TABLE` DDL on throw, but the side effect of an earlier `db.pragma('user_version = N')` that already executed is not guaranteed to roll back.

More importantly: in v1–v4 each step does `ALTER...` then `pragma('user_version = N')` as the last statement. If the process is killed (power loss, OS crash, force-quit) **between** the DDL commit and the `user_version` write, on next launch `currentVersion` still reads the old value and the step re-runs. For v1–v4 the `hasColumn` guards make re-runs idempotent, so the practical damage is limited. But for **v5** the guard is `connTypeCheck.includes("'rdp'")` on the *post-rebuild* table — if v5's DDL committed (table already rebuilt with `'rdp'`) but `user_version=5` did not persist, next launch re-enters v5, the `includes("'rdp'")` guard returns early (correct), but the `user_version` is then bumped to 5. That path is saved by the idempotency guard. The real risk is the inverse: a crash after `DROP TABLE devices` but before `RENAME` completes inside the v5 transaction — better-sqlite3's transaction *will* roll back the DDL here (DDL is transactional in modern SQLite), so v5 is saved by the transaction. The lingering defect is the **false documentation**: future contributors will trust "atomic" and add a migration whose idempotency guard is weaker, creating real corruption.

**Fix:**
1. Correct the misleading comments — `user_version` writes are not transactional; idempotency is provided by the `hasColumn`/`sqlite_master` guards, not by the transaction.
2. Harden v5: after the rebuild transaction commits, re-read `user_version` is unnecessary, but ensure the step is genuinely re-runnable. It is (guard returns early if `'rdp'` present). Add a comment explicitly stating the transaction protects the DDL rollback and the sqlite_master guard protects re-runs — do **not** claim the version bump is atomic with the DDL.

---

## Warnings

### WR-01: `restrictDirPermissions` builds paths with `/` on Windows — works due to Node normalization but is inconsistent and fragile

**File:** `electron/database/acl.ts:77`

**Issue:**
`const fullPath = `${dirPath}/${entry}`` uses a forward slash. Node's `fs` APIs normalize this on Windows so it happens to work, but the same string is later passed to `restrictFilePermissions` which on Windows feeds `filePath` as a positional arg to `icacls` via `execFileSync`. `icacls` generally accepts forward slashes, but mixing `app.getPath('userData')` (backslashes) with appended forward slashes produces inconsistent path strings in `system log` error messages and is a latent portability hazard.

**Fix:**
```ts
const fullPath = path.join(dirPath, entry)
```
Import `path` at the top of `acl.ts`.

---

### WR-02: `pruneBackups` silently does nothing when `retention` is `0` or negative, and a user-set `0` disables all retention (deletes every backup)

**File:** `electron/services/backupScheduler.ts:89-104`, `electron/services/backupScheduler.ts:135-145`

**Issue:**
`updateConfig` accepts `periodicRetention` / `premigrationRetention` as bare numbers with no validation. If a user (or a future UI) sets retention to `0`, `files.slice(0)` returns **all** files → every existing backup in that bucket is deleted on the next backup run, including the one just created (it is in the same `readdirSync` listing). Setting `0` effectively means "keep nothing", and `negative` values (`slice(-3)`) slice from the end and delete the *newest* backups — exactly the opposite of intent. There is no guard that retention ≥ 1.

**Fix:**
Clamp in `updateConfig` and in `pruneBackups`:
```ts
private static pruneBackups(bucket, retention): void {
  if (!retention || retention < 1) return // never prune-to-zero; treat as "keep all"
  ...
}
```
And validate in `updateConfig` (reject `retention < 1` or clamp to 1).

---

### WR-03: `BackupScheduler.getConfig` uses `as any` and seeds the singleton inside a read — not concurrency-safe with `migrateAndSecure`'s premigration backup

**File:** `electron/services/backupScheduler.ts:114-125`

**Issue:**
`getConfig()` performs a `SELECT ... WHERE id = 1`; if absent it `INSERT`s. This is invoked from `createPremigrationBackup` (called synchronously from `migrateAndSecure` during app startup) and again from `BackupScheduler.start()` and from `executeTask`. While startup is single-threaded in main, the lazy-seed-on-read pattern is fragile: there is no `INSERT OR IGNORE` guard, so if two code paths race to call `getConfig` before the row exists (e.g. premigration backup path + an early IPC `getStatus`), the second `INSERT` throws `UNIQUE` violation. Also `row` is typed `as any`, an `any` leak the phase context asked to keep clean.

**Fix:**
Use `INSERT OR IGNORE` to seed idempotently, and type the row:
```ts
const row = db.prepare('SELECT * FROM backup_config WHERE id = 1').get() as
  | { id: number; enabled: number; interval_minutes: number; periodic_retention: number; premigration_retention: number; last_run: string|null; next_run: string|null }
  | undefined
```

---

### WR-04: `before-quit` handler is not async and does not await `BackupScheduler.stop()` / pending backup — a backup can still be in-flight when `closeDatabase()` runs

**File:** `electron/main.ts:160`, `electron/services/backupScheduler.ts:41-54,58-71`

**Issue:**
`app.on('before-quit', () => { BackupScheduler.stop(); closeDatabase() })`. `stop()` clears the interval but does **not** await an in-flight `executeTask()` (`isRunning === true`). If a periodic backup is mid-`db.backup()` when the user quits, `closeDatabase()` runs immediately after, closing the handle out from under the running backup. `db.backup()` on a closed handle will throw or produce a corrupt backup file. The `isRunning` flag exists but is never awaited on shutdown.

**Fix:**
```ts
let shuttingDown = false
app.on('before-quit', (e) => {
  if (BackupScheduler.getStatus().isTaskRunning && !shuttingDown) {
    e.preventDefault()
    shuttingDown = true
    // wait for in-flight backup, then quit
    const check = setInterval(() => {
      if (!BackupScheduler.getStatus().isTaskRunning) {
        clearInterval(check)
        BackupScheduler.stop()
        closeDatabase()
        app.quit()
      }
    }, 100)
  } else {
    BackupScheduler.stop()
    closeDatabase()
  }
})
```
Or expose an async `BackupScheduler.shutdown()` that waits on `isRunning`.

---

### WR-05: v5 migration drops & rebuilds `devices` while `foreign_keys = ON` and `arp_entries` references it — risk of FK violation or cascade during rebuild

**File:** `electron/database/migrations.ts:86-124`, `electron/database/init.ts:118`

**Issue:**
`init.ts:118` declares `arp_entries.device_id ... REFERENCES devices(id) ON DELETE CASCADE`. `connection.ts:20` sets `foreign_keys = ON`. During v5, the sequence `CREATE TABLE devices_new ... ; INSERT ... ; DROP TABLE devices; ALTER TABLE devices_new RENAME TO devices;` runs inside a transaction. `DROP TABLE devices` with FKs enabled does not cascade to `arp_entries` (DROP TABLE itself doesn't fire FK actions on a parent drop in SQLite — it's permitted), but the subsequent `foreign_key_check` will report any orphaned `arp_entries` rows whose `device_id` is not in the rebuilt `devices`. Since the rebuild copies all rows by id, this should be clean — **but** if any `arp_entries.device_id` references a `devices.id` that exists today, it survives. The risk appears contained, however `foreign_key_check` is run inside the same transaction that did the DROP/RENAME; if it throws, the transaction rolls back the RENAME and the user is left with `devices_new` cleaned up by rollback. That is correct. The remaining concern is purely the no-op-but-scary DROP of a parent table with active child FKs — worth a comment, and worth confirming `legacy_alter_table` is OFF (the default) so the RENAME auto-rewrites the child FK reference to the new table name.

**Fix:**
Add an explicit guard / comment, and verify `legacy_alter_table`:
```ts
// Confirm FK references are auto-rewritten by the RENAME (legacy_alter_table OFF, the default).
// foreign_key_check below asserts no orphans after rebuild.
```
No code change required if `legacy_alter_table` is at its default (OFF); if any other code sets `legacy_alter_table=ON`, the child FK would break. Document the dependency.

---

### WR-06: `createPremigrationBackup` is a public static method on `BackupScheduler`, but the periodic `start()`/interval logic could fire concurrently with the premigration backup during startup

**File:** `electron/services/backupScheduler.ts:78-86`, `electron/main.ts:79-92`

**Issue:**
`main.ts` calls `migrateAndSecure()` (which may call `createPremigrationBackup` → `getDatabase().backup(...)`) at line 81, **before** `BackupScheduler.start()` at line 92. So in practice they don't overlap today. But `createPremigrationBackup` shares the `isRunning` guard semantics with nothing — it does not set `isRunning`, so if `start()` ordering ever changes (or `restart()` is invoked during migration), two `db.backup()` calls can run simultaneously against the same handle. better-sqlite3's `backup()` is not concurrency-safe with itself.

**Fix:**
Either (a) gate `createPremigrationBackup` on `!this.isRunning` and set/reset it in a finally, or (b) document and enforce via an assertion that `createPremigrationBackup` may only be called before `start()`.

---

### WR-07: `restrictFilePermissions` Windows branch depends on `process.env.USERNAME` which is **not** the correct identity for per-user ACLs in all contexts

**File:** `electron/database/acl.ts:25-30`

**Issue:**
`process.env.USERNAME` is the legacy DOS-style username (e.g. `wanghaonan`), not necessarily the fully-qualified identity `icacls` prefers (`DOMAIN\user` or `COMPUTER\user`). On a machine where the user is a domain account, `icacls "<path>" /grant:r "USERNAME:(F)"` may resolve to a different SID than the running process, leaving the actual process identity without access on subsequent reads — or fail to resolve. The robust form is to use `os.userInfo().username` combined with the computer/domain, or better, the well-known SID `*S-1-5-32-544` (Administrators) plus the current user via `whoami /upn`, or simplest: grant to `%USERNAME%` but **also** verify the current process can still read the file. The current code's fallback comment claims AES/safeStorage is the primary defense, which mitigates severity — hence Warning not Critical.

**Fix:**
Prefer the UPN or a SID-based grant; or at minimum test that the grantee matches the running identity:
```ts
// Build "DOMAIN\user" form for robusty icacls resolution
const whoami = execFileSync('whoami', [], { encoding: 'utf8', shell: false }).trim()
execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${whoami}:(F)`], {...})
```

---

## Info

### IN-01: `hasColumn` interpolates the table name into SQL — SQL-injection-shaped, currently safe only because callers pass literals

**File:** `electron/database/migrationHelpers.ts:9`

**Issue:**
`db.prepare(`PRAGMA table_info(${table})`)`. All current callers pass string literals, so this is not exploitable today, but PRAGMA does not support parameter binding for its argument, and a future caller passing user-derived input would introduce injection.

**Fix:**
Validate against an allow-list of known table names, or at least assert `/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)`.

---

### IN-02: `initDefaultOUIData` uses `db: any` — `any` leak the phase was supposed to keep clean

**File:** `electron/database/init.ts:293-294`

**Issue:**
`function initDefaultOUIData(db: any)` and `( ... ).get() as any`. Project context asks this phase to be `any`-clean.

**Fix:**
Type as `Database.Database` and `as { cnt: number }`.

---

### IN-03: Test file is adequate for `hasColumn` but does not exercise the SQL-interpolation path or any v1–v5 migration

**File:** `tests/unit/migrationHelpers.test.ts`

**Issue:**
Only `hasColumn` is tested. No tests for `runMigrations`, idempotent re-run, v5 rebuild, `pruneBackups` retention boundaries, or `restrictFilePermissions`. Given this phase is explicitly "data-safety CRITICAL", the coverage is thin. The comment explains the better-sqlite3 avoidance, which is reasonable, but the migration registry itself is untested.

**Fix:**
Add at minimum: (a) a unit test for `pruneBackups` retention/FIFO/off-by-one using a temp dir, (b) a test asserting `MIGRATIONS` versions are contiguous 1..HEAD.

---

### IN-04: `ai_system_logs.type` default of `'discovery'` is misleading once CR-01 widens the enum

**File:** `electron/database/init.ts:86`

**Issue:**
After widening the CHECK per CR-01, the `DEFAULT 'discovery'` becomes an arbitrary pick. Callers always pass `type` explicitly, so the default is dead — but if kept, document why.

**Fix:**
Drop the default (column is `NOT NULL` and always supplied) or keep `'discovery'` with a comment.

---

### IN-05: `notifyRenderer` and `runTask` error logging use `console.error` rather than `createSystemLog`

**File:** `electron/services/backupScheduler.ts:29,30,49`

**Issue:**
Interval/initial run failures and the `Task failed` path log to `console.error` only; in a packaged Electron app console output is not visible to the operator. Only the inner `executeTask` failures reach `createSystemLog` (and even those are blocked by CR-01).

**Fix:**
Route through `createSystemLog` (after CR-01 fix) so operators see scheduler-level failures.

---

### IN-06: `BackupScheduler.restart()` calls `stop()` then `start()`; if `start()` finds `config.enabled === false` it silently no-ops, which may surprise callers expecting a restart

**File:** `electron/services/backupScheduler.ts:37`

**Issue:**
`updateConfig` calls `restart()`. If the user disables backups (`enabled:false`), `restart` → `stop` → `start` → `start` returns early with no interval. Behavior is correct, but the `intervalId` is now `null` while `getStatus().isRunning` returns `false`, which is fine — just worth a comment that `restart` honours `enabled`.

**Fix:**
Comment-only: note that `restart()` honours the current `enabled` flag.

---

## Notes on Out-of-Scope Items Verified Clean

- **Command injection in `acl.ts`**: `execFileSync('icacls', [filePath, '/inheritance:r', ...], { shell: false })` — arguments are passed as an argv array, not a shell string. No injection. The `filePath` and `currentUser` values are not user-controlled at this call site. Verified clean.
- **Lifecycle ordering in `main.ts`**: `BackupScheduler.stop()` runs before `closeDatabase()` in `before-quit` — interval is cleared before the handle closes. (See WR-04 for the in-flight caveat.)
- **Packaging red-line**: `electron-builder.yml` `files:` excludes `electron/**` and `src/**` and uses `asar: true`; `userData/backups` is a runtime path, never bundled. Verified clean.
- **v5 idempotency on fresh install**: `createTables` already creates `devices` with `'rdp'` in the CHECK, so `connTypeCheck.includes("'rdp'")` returns early — v5 is a no-op on fresh install. Verified correct.
- **WAL/SHM ACL**: `migrateAndSecure` applies `restrictFilePermissions` to `topology.db`, `-wal`, and `-shm`. The helper silently skips non-existent sidecar files. Verified correct.

---

_Reviewed: 2026-06-28_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
