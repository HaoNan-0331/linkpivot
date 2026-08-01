---
phase: 02-architecture-db-migration
plan: 02
subsystem: database-backup-acl
tags: [backup-config, acl, file-permissions, cross-platform, ARCH-02]
requires:
  - "Phase 1 BUILD-01 stable build baseline (tsc + esbuild green)"
  - "Plan 02-01 (user_version + hasColumn registry) for coherent phase ordering"
provides:
  - "src/types/backup.ts: BackupConfig / BackupStatus / UpdateBackupInput / DEFAULT_BACKUP_CONFIG 类型契约（供 Plan 02-03 BackupScheduler 消费）"
  - "electron/database/acl.ts: restrictFilePermissions(path, label) + restrictDirPermissions(dirPath) 跨平台 ACL 收紧 helper（供 Plan 02-03 connection.ts migrateAndSecure 调用）"
affects:
  - "Plan 02-03 (BackupScheduler + connection.ts migrateAndSecure + init.ts 散落块删除)：消费本 plan 的 BackupConfig 类型契约 + restrictFilePermissions/restrictDirPermissions helper"
tech-stack:
  added: []
  patterns:
    - "Cross-platform file ACL tightening: process.platform 分支 Windows icacls /inheritance:r /grant:r user:(F) via execFileSync(shell:false) / Unix chmod 0o600 (D-11)"
    - "Non-fatal defense-in-depth failure: icacls/chmod 失败 try/catch + createSystemLog(type='acl', status='warning') 后继续不抛异常——数据已 AES+safeStorage 加密，ACL 是第二层 (D-13)"
    - "Idempotent ACL application: 文件不存在静默跳过（WAL/SHM sidecar checkpoint 后可能缺失），每次启动幂等重收紧，无 sentinel (D-12)"
key-files:
  created:
    - src/types/backup.ts
    - electron/database/acl.ts
  modified: []
decisions:
  - "acl.ts createSystemLog 调用全部 try/catch 包裹（4 处）——镜像 Phase 6 ROBUST-02 intent：日志失败不阻塞受保护路径，避免 createSystemLog 自身故障级联"
  - "Windows icacls 用 execFileSync 同步执行 + shell:false——ACL 收紧必须在迁移/启动流程继续前完成避免竞态，参数数组传递不经 shell 解析防注入（T-2-07）"
  - "restrictDirPermissions 文件名拼接用正斜杠 `${dirPath}/${entry}`——Node fs API 在 Windows 下兼容正斜杠，避免反斜杠转义复杂度"
metrics:
  duration: 2min
  completed: 2026-06-28T04:46:10Z
  tasks: 2
  files: 2
---

# Phase 2 Plan 2: BackupConfig Type + Cross-Platform ACL Helper Summary

为 ARCH-02 落地两个无依赖叶模块：(1) `src/types/backup.ts` 的 `BackupConfig` 类型（对齐 `ScheduleConfig` + 扩展 D-02 双桶 retention，供 Plan 02-03 `BackupScheduler` 消费）；(2) `electron/database/acl.ts` 的跨平台 `restrictFilePermissions(path, label)` + `restrictDirPermissions(dirPath)` helper（Windows icacls / Unix chmod 0o600，失败非致命 D-13，文件不存在静默跳过）。两个叶模块先就位，与 Plan 01 并行，为 Plan 02-03 的 BackupScheduler + connection.ts `migrateAndSecure` 集成提供类型契约和 ACL 工具。

## What Was Built

### src/types/backup.ts (Task 1)
- `export interface BackupConfig`：对齐 `ScheduleConfig`（id/enabled/intervalMinutes/lastRun/nextRun）+ D-02 双桶 retention 字段（periodicRetention/premigrationRetention）
- `export interface BackupStatus`：镜像 `SchedulerStatus`（isRunning/isTaskRunning/config）
- `export interface UpdateBackupInput`：enabled/intervalMinutes/periodicRetention/premigrationRetention 均可选
- `export const DEFAULT_BACKUP_CONFIG`：`enabled: true`（D-01，与 scheduler_config 默认 false 不同——备份是数据安全核心价值默认开）/ `intervalMinutes: 1440`（D-01 24h）/ `periodicRetention: 7`（D-02）/ `premigrationRetention: 5`（D-02）

### electron/database/acl.ts (Task 2)
- `export function restrictFilePermissions(filePath: string, label: string): void`
  - Windows 分支：`execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', '${currentUser}:(F)'], {stdio:'ignore', shell:false, timeout:10000})`
    - `currentUser` 取值顺序：`process.env.USERNAME || os.userInfo().username`
    - `/inheritance:r` 剥离继承；`/grant:r` replace（非 append）显式 ACE，仅当前用户完全控制（D-11 逐字）
  - Unix/macOS 分支：`fs.chmodSync(filePath, 0o600)`
  - 文件不存在静默跳过（WAL/SHM sidecar checkpoint 后可能缺失）
  - 非致命（D-13）：失败 try/catch → `createSystemLog({type:'acl', status:'warning', errorMessage})` → 继续，不抛异常
- `export function restrictDirPermissions(dirPath: string): void`
  - D-10：批量收紧 `userData/backups/` 下所有文件（备份是敏感数据副本，同等保护）
  - 目录不存在/readdir 失败：try/catch + createSystemLog 警告后返回
  - 单文件失败委托 restrictFilePermissions 内部记录

## Deviations from Plan

None — plan executed exactly as written. 两文件实现与 02-02-PLAN.md `<action>` 逐字对齐，无额外文件、无逻辑偏离。

## Acceptance Criteria Verification

### Task 1 (src/types/backup.ts)
- [x] 文件存在
- [x] `grep "export interface BackupConfig"` 命中
- [x] `grep "periodicRetention: number"` 命中（D-02）
- [x] `grep "premigrationRetention: number"` 命中（D-02）
- [x] `grep "intervalMinutes: number"` 命中（对齐 ScheduleConfig）
- [x] `grep "DEFAULT_BACKUP_CONFIG"` 命中
- [x] `grep "intervalMinutes: 1440"` 命中（D-01 默认 24h）
- [x] `grep "enabled: true"` 命中（默认启用）
- [x] `grep "periodicRetention: 7"` 命中（D-02）
- [x] `grep "premigrationRetention: 5"` 命中（D-02）
- [x] `npx tsc -p tsconfig.web.json --noEmit` exit 0

### Task 2 (electron/database/acl.ts)
- [x] 文件存在
- [x] `grep "export function restrictFilePermissions(filePath: string, label: string)"` 命中
- [x] `grep "export function restrictDirPermissions(dirPath: string)"` 命中（D-10 备份目录批量）
- [x] `grep "icacls"` 命中（D-11 Windows 分支）
- [x] `grep "/inheritance:r"` 命中（D-11 剥离继承）
- [x] `grep "/grant:r"` 命中（D-11 replace 显式项）
- [x] `grep "0o600"` 命中（D-11 Unix chmod）
- [x] `grep "execFileSync"` 命中（同步执行避免竞态）
- [x] `grep "os.userInfo().username"` 命中（D-11 当前用户）
- [x] `grep "import { createSystemLog } from '../services/systemLog'"` 命中（D-13 失败日志）
- [x] `grep "type: 'acl'"` 命中（日志类型）
- [x] `grep -c "createSystemLog"` = 4（>= 2：restrictFilePermissions 1 + restrictDirPermissions readdir 失败 1 + 2 处 try/catch 包裹语法节点）
- [x] `npx tsc -p tsconfig.web.json --noEmit` exit 0
- [x] `npm run build:electron-main` exit 0

### Plan-level verification
- [x] `npx tsc -p tsconfig.web.json --noEmit` exit 0
- [x] `npm run build:electron-main` exit 0（dist-electron/main.js 1.8mb，child_process/fs/os 由 main bundle 解析）
- [x] Phase 1 构建基线不破坏：tsc web=0 + esbuild electron-main=0 双绿
- [x] 越界检查：`git diff --name-only` 仅 `src/types/backup.ts` + `electron/database/acl.ts`，connection.ts/init.ts/main.ts/backupScheduler.ts 零改动（Plan 02-03 单一编辑权）

## Success Criteria Status

- **ARCH-02 类型契约（BackupConfig）就位**：对齐 ScheduleConfig + D-02 双桶 retention，供 Plan 02-03 BackupScheduler 消费
- **ARCH-02 ACL 工具就位**：restrictFilePermissions/restrictDirPermissions 跨平台 + 非致命 + 幂等，供 Plan 02-03 connection.ts migrateAndSecure 调用
- **D-02 双桶 retention 字段落地**：periodicRetention=7 / premigrationRetention=5
- **D-11 跨平台命令落地**：Windows icacls /inheritance:r /grant:r user:(F) + Unix chmod 0o600
- **D-13 非致命失败落地**：失败 try/catch + createSystemLog warning 后继续，不抛异常
- **Phase 1 构建基线不破坏**：tsc + esbuild 双绿

## Commits

| Task | Commit | Type | Message |
|------|--------|------|---------|
| 1 | c123ce1 | feat | feat(02-02): add BackupConfig type (ARCH-02, D-02/D-05) |
| 2 | 2e0886d | feat | feat(02-02): add cross-platform restrictFilePermissions ACL helper (ARCH-02, D-10/D-11/D-12/D-13) |

## Known Stubs

无。BackupConfig 是纯类型定义（无运行时数据流）；acl.ts 是完整实现（非 mock/占位）。两个 helper 的调用点（connection.ts migrateAndSecure + BackupScheduler）由 Plan 02-03 接入——这是明确的职责边界（本 plan 产出契约+工具，Plan 03 产出调用点），非 stub。

## Threat Flags

无新增威胁面超出本 plan 的 threat_model。T-2-06/T-2-07/T-2-08/T-2-09 缓解措施全部在 acl.ts 实现中体现：
- T-2-06 (Information Disclosure 默认宽松权限)：mitigate ✓ — restrictFilePermissions Win 剥离继承+仅当前用户(F) / Unix 0o600
- T-2-07 (Elevation of Privilege icacls 参数注入)：mitigate ✓ — execFileSync + shell:false 参数数组传递，filePath/label 仅来自受控代码（app.getPath + 固定文件名），currentUser 来自 env/os 内建 API
- T-2-08 (Denial of Service ACL 失败崩溃)：mitigate ✓ — 失败 try/catch + createSystemLog(type='acl', status='warning') 后继续，不抛异常
- T-2-09 (Tampering 同机用户篡改)：mitigate ✓ — Win 仅当前用户(F) 无他人写位 / Unix 0o600 仅 owner rw，启动幂等重收紧修正历史宽松权限

## Self-Check: PASSED

**Files exist:**
- FOUND: src/types/backup.ts
- FOUND: electron/database/acl.ts

**Commits exist:**
- FOUND: c123ce1 (feat BackupConfig)
- FOUND: 2e0886d (feat acl helper)

**Out-of-scope files untouched:** CONFIRMED（`git diff --name-only c123ce1~1 HEAD` 仅本 plan 两文件，connection.ts/init.ts/main.ts/backupScheduler.ts 为空）

**Build green:** CONFIRMED (tsc -p tsconfig.web.json = 0, npm run build:electron-main = 0)
