import { BrowserWindow } from 'electron'
import { getDatabase } from '../database/connection'
import { ARPCollector } from './arpCollector'
import { AnomalyService } from './anomalyService'
import { IPStatusService } from './ipStatusService'

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

  static async runNow(): Promise<{ success: boolean; message: string; stats?: any }> {
    if (this.isRunning) return { success: false, message: '任务正在运行中' }
    try {
      const result = await this.executeTask()
      return { success: true, message: '采集完成', stats: result }
    } catch (error) {
      return { success: false, message: `采集失败: ${(error as Error).message}` }
    }
  }

  private static async runTask(): Promise<void> {
    if (this.isRunning) return
    try {
      await this.executeTask()
      this.updateLastRun()
      const config = this.getConfig()
      this.updateNextRun(config.intervalMinutes)
    } catch (error) { console.error('[Scheduler] Task failed:', error) }
  }

  private static async executeTask(): Promise<{ devices: number; entries: number; changes: number }> {
    this.isRunning = true
    try {
      const collectionTime = IPStatusService.beginCollection()
      const results = await ARPCollector.collectFromAll()
      const db = getDatabase()
      let totalEntries = 0, totalChanges = 0

      for (const result of results) {
        if (result.error) continue
        if (result.entries.length > 0) {
          totalEntries += result.entries.length
          const stmt = db.prepare('INSERT INTO arp_entries (device_id, ip, mac, vlan, interface, collected_at) VALUES (?, ?, ?, ?, ?, ?)')
          for (const entry of result.entries) {
            try { stmt.run(result.deviceId, entry.ip, entry.mac, entry.vlan || null, entry.interface || null, result.collectedAt) } catch (e: any) { if (!/UNIQUE|CONSTRAINT/i.test(e.message)) console.error('[scheduler] arp insert failed:', e.message) }
          }
          IPStatusService.batchUpdateIPStatus(result.entries.map(e => ({ ip: e.ip, mac: e.mac })), collectionTime)
          const changes = AnomalyService.processARPEntries(result.entries)
          totalChanges += changes.length
        }
      }

      const deprecatedCount = IPStatusService.endCollection(collectionTime)
      this.notifyRenderer('task-completed', {
        devices: results.length, entries: totalEntries, changes: totalChanges,
        deprecated: deprecatedCount, timestamp: new Date().toISOString(),
      })
      return { devices: results.length, entries: totalEntries, changes: totalChanges }
    } finally { this.isRunning = false }
  }

  private static shouldRunNow(config: any): boolean {
    if (!config.lastRun) return true
    try {
      const elapsed = Date.now() - new Date(config.lastRun).getTime()
      return elapsed >= (config.intervalMinutes ?? 60) * 60 * 1000
    } catch { return true }
  }

  static getConfig(): any {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM scheduler_config WHERE id = 1').get() as any
    if (!row) {
      db.prepare('INSERT INTO scheduler_config (id, enabled, interval_minutes) VALUES (1, 0, 60)').run()
      return { id: 1, enabled: false, intervalMinutes: 60, lastRun: null, nextRun: null }
    }
    return { id: row.id, enabled: Boolean(row.enabled), intervalMinutes: row.interval_minutes ?? 60, lastRun: row.last_run, nextRun: row.next_run }
  }

  static updateConfig(updates: { enabled?: boolean; intervalMinutes?: number }): any {
    const db = getDatabase()
    const config = this.getConfig()
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (config.enabled ? 1 : 0)
    const intervalMinutes = updates.intervalMinutes ?? config.intervalMinutes ?? 60
    db.prepare('UPDATE scheduler_config SET enabled = ?, interval_minutes = ? WHERE id = 1').run(enabled, intervalMinutes)
    this.restart()
    return this.getConfig()
  }

  private static updateLastRun(): void {
    getDatabase().prepare("UPDATE scheduler_config SET last_run = datetime('now','localtime') WHERE id = 1").run()
  }

  private static updateNextRun(intervalMinutes: number): void {
    const nextRun = new Date(Date.now() + (intervalMinutes ?? 60) * 60 * 1000).toISOString()
    getDatabase().prepare('UPDATE scheduler_config SET next_run = ? WHERE id = 1').run(nextRun)
  }

  private static notifyRenderer(channel: string, data: any): void {
    for (const win of BrowserWindow.getAllWindows()) { win.webContents.send(channel, data) }
  }

  static getStatus(): { isRunning: boolean; isTaskRunning: boolean; config: any } {
    return { isRunning: this.intervalId !== null, isTaskRunning: this.isRunning, config: this.getConfig() }
  }
}
