import { BrowserWindow, app } from 'electron'
import path from 'path'
import fs from 'fs'
import { getDatabase } from '../database/connection'
import { restrictFilePermissions } from '../database/acl'
import { createSystemLog } from './systemLog'
import type { BackupConfig } from '../../src/types/backup'
import { DEFAULT_BACKUP_CONFIG } from '../../src/types/backup'

const BACKUPS_DIR = (): string => path.join(app.getPath('userData'), 'backups')

function timestampStr(): string {
  // YYYYMMDD-HHmmss 本地时间
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export class BackupScheduler {
  private static intervalId: ReturnType<typeof setInterval> | null = null
  private static isRunning = false

  static start(): void {
    if (this.intervalId) return
    const config = this.getConfig()
    if (!config.enabled) return
    const intervalMinutes = config.intervalMinutes ?? DEFAULT_BACKUP_CONFIG.intervalMinutes
    this.updateNextRun(intervalMinutes)
    this.intervalId = setInterval(() => { this.runTask().catch((e) => console.error('[BackupScheduler] interval run failed:', e)) }, intervalMinutes * 60 * 1000)
    if (this.shouldRunNow(config)) this.runTask().catch((e) => console.error('[BackupScheduler] initial run failed:', e))
  }

  static stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null }
  }

  static restart(): void { this.stop(); this.start() }

  // 镜像 SchedulerService.runTask（schedulerService.ts:37-45）：isRunning guard 在 runTask，
  // 实际工作隔离到 executeTask（isRunning 在 executeTask finally 重置）—— 不静默丢弃并发备份。
  private static async runTask(): Promise<void> {
    if (this.isRunning) return
    try {
      await this.executeTask()
      this.updateLastRun()
      const config = this.getConfig()
      this.updateNextRun(config.intervalMinutes)
    } catch (error) {
      console.error('[BackupScheduler] Task failed:', error)
      try {
        createSystemLog({ type: 'backup', status: 'failed', errorMessage: `周期备份失败: ${(error as Error).message}` })
      } catch { /* 日志失败不影响调度 */ }
    }
  }

  // 镜像 SchedulerService.executeTask（schedulerService.ts:47-76）：isRunning=true 在入口、finally 重置。
  // 备份工作（db.backup + ACL + 裁剪 + notify）隔离在此，与 SchedulerService 拆分结构完全对齐（D-05）。
  private static async executeTask(): Promise<void> {
    this.isRunning = true
    try {
      const filename = `topology-periodic-${timestampStr()}.db.bak`
      const backupPath = path.join(BACKUPS_DIR(), filename)
      ensureBackupsDir()
      getDatabase().backup(backupPath) // D-04：在线一致性备份，单文件输出
      restrictFilePermissions(backupPath, filename) // D-12b：备份创建即收紧 ACL
      this.pruneBackups('periodic', this.getConfig().periodicRetention)
      this.notifyRenderer('backup-completed', { type: 'periodic', filename, timestamp: new Date().toISOString() })
    } finally {
      this.isRunning = false
    }
  }

  /**
   * 迁移前即时备份（D-06，强制安全网）。由 connection.ts migrateAndSecure() 在
   * createTables() 之后、runMigrations() 之前调用（捕获 post-基线表 schema+数据，非空库快照）。
   * 命名带 from→to 版本，独立迁移桶（premigrationRetention=5），不混入周期桶裁剪（D-02）。
   */
  static createPremigrationBackup(fromVersion: number, toVersion: number): string {
    const filename = `topology-premigration-v${fromVersion}-to-v${toVersion}-${timestampStr()}.db.bak`
    const backupPath = path.join(BACKUPS_DIR(), filename)
    ensureBackupsDir()
    getDatabase().backup(backupPath)
    restrictFilePermissions(backupPath, filename) // D-12b
    this.pruneBackups('premigration', this.getConfig().premigrationRetention)
    return backupPath
  }

  /** 双桶 FIFO 裁剪（D-02）：周期桶/迁移桶各自按 mtime 滚动保留 N 份，互不干扰 */
  private static pruneBackups(bucket: 'periodic' | 'premigration', retention: number): void {
    try {
      const dir = BACKUPS_DIR()
      const prefix = bucket === 'periodic' ? 'topology-periodic-' : 'topology-premigration-'
      const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.db.bak'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime) // 新→旧
      const toDelete = files.slice(retention) // 超出 retention 的旧文件
      for (const f of toDelete) {
        try { fs.unlinkSync(path.join(dir, f.name)) } catch { /* 单文件删除失败跳过 */ }
      }
    } catch (error) {
      try { createSystemLog({ type: 'backup', status: 'warning', errorMessage: `备份裁剪失败 (${bucket}): ${(error as Error).message}` }) } catch { /* 非致命 */ }
    }
  }

  private static shouldRunNow(config: BackupConfig): boolean {
    if (!config.lastRun) return true
    try {
      const elapsed = Date.now() - new Date(config.lastRun).getTime()
      return elapsed >= (config.intervalMinutes ?? DEFAULT_BACKUP_CONFIG.intervalMinutes) * 60 * 1000
    } catch { return true }
  }

  static getConfig(): BackupConfig {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM backup_config WHERE id = 1').get() as any
    if (!row) {
      db.prepare('INSERT INTO backup_config (id, enabled, interval_minutes, periodic_retention, premigration_retention) VALUES (1, ?, ?, ?, ?)').run(
        DEFAULT_BACKUP_CONFIG.enabled ? 1 : 0,
        DEFAULT_BACKUP_CONFIG.intervalMinutes,
        DEFAULT_BACKUP_CONFIG.periodicRetention,
        DEFAULT_BACKUP_CONFIG.premigrationRetention,
      )
      return { id: 1, enabled: DEFAULT_BACKUP_CONFIG.enabled, intervalMinutes: DEFAULT_BACKUP_CONFIG.intervalMinutes, lastRun: null, nextRun: null, periodicRetention: DEFAULT_BACKUP_CONFIG.periodicRetention, premigrationRetention: DEFAULT_BACKUP_CONFIG.premigrationRetention }
    }
    return {
      id: row.id, enabled: Boolean(row.enabled),
      intervalMinutes: row.interval_minutes ?? DEFAULT_BACKUP_CONFIG.intervalMinutes,
      lastRun: row.last_run, nextRun: row.next_run,
      periodicRetention: row.periodic_retention ?? DEFAULT_BACKUP_CONFIG.periodicRetention,
      premigrationRetention: row.premigration_retention ?? DEFAULT_BACKUP_CONFIG.premigrationRetention,
    }
  }

  static updateConfig(updates: { enabled?: boolean; intervalMinutes?: number; periodicRetention?: number; premigrationRetention?: number }): BackupConfig {
    const db = getDatabase()
    const config = this.getConfig()
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (config.enabled ? 1 : 0)
    const intervalMinutes = updates.intervalMinutes ?? config.intervalMinutes
    const periodicRetention = updates.periodicRetention ?? config.periodicRetention
    const premigrationRetention = updates.premigrationRetention ?? config.premigrationRetention
    db.prepare('UPDATE backup_config SET enabled = ?, interval_minutes = ?, periodic_retention = ?, premigration_retention = ? WHERE id = 1').run(enabled, intervalMinutes, periodicRetention, premigrationRetention)
    this.restart()
    return this.getConfig()
  }

  private static updateLastRun(): void {
    getDatabase().prepare("UPDATE backup_config SET last_run = datetime('now','localtime') WHERE id = 1").run()
  }

  private static updateNextRun(intervalMinutes: number): void {
    const nextRun = new Date(Date.now() + (intervalMinutes ?? DEFAULT_BACKUP_CONFIG.intervalMinutes) * 60 * 1000).toISOString()
    getDatabase().prepare('UPDATE backup_config SET next_run = ? WHERE id = 1').run(nextRun)
  }

  private static notifyRenderer(channel: string, data: any): void {
    for (const win of BrowserWindow.getAllWindows()) { win.webContents.send(channel, data) }
  }

  static getStatus(): { isRunning: boolean; isTaskRunning: boolean; config: BackupConfig } {
    return { isRunning: this.intervalId !== null, isTaskRunning: this.isRunning, config: this.getConfig() }
  }
}

/** 确保 userData/backups/ 存在（premigration 备份 + 周期备份前调用）。导出供 connection.ts 复用。 */
export function ensureBackupsDir(): string {
  const dir = BACKUPS_DIR()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}
