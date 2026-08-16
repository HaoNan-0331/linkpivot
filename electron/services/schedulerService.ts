import { BrowserWindow } from 'electron'
import { getDatabase } from '../database/connection'
import { ARPCollector } from './arpCollector'
import { ArpIngestService } from './arpIngestService'
import { IPStatusService } from './ipStatusService'

/** arp_entries 保留清理单批删除行数（SC#4：巨型单条 DELETE 冻结主进程，分批 + 批间 yield 让 IPC 呼吸）。 */
const RETENTION_BATCH = 500

export class SchedulerService {
  private static intervalId: ReturnType<typeof setInterval> | null = null
  private static isRunning = false
  // 18-05（TXN-03）：retention 清理独立门控标志——与采集 isRunning 语义分离（清理可与采集并发，自身防重入）
  private static retentionRunning = false

  static start(): void {
    // 18-05（TXN-03）retention 启动钩子——位置钉死：必须位于 enabled 早退判断**之前**（Pitfall 9）。
    // 「scheduler 禁用（enabled=false）但手动采集仍在写 arp_entries」的用户，清理照常触发；
    // 若挂在 enabled 判断之后，该类用户的 retention 永不运行。非致命 fire-and-forget
    // （不 await 阻塞启动路径，参照 main.ts 编排区 try/catch + console 范式）。
    void this.runArpRetention().catch((e) => console.warn('[retention] startup hook failed:', e))
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

  /**
   * 18-05（TXN-03）：arp_entries 保留策略清理——删除「超过保留窗口且非该 IP 最新」的历史行。
   *
   * 删除谓词（P11 不可恢复操作核心守卫，禁 ROW_NUMBER 复刻）：
   *   EXISTS (SELECT 1 FROM arp_entries a2 WHERE a2.ip = a.ip AND a2.collected_at > a.collected_at)
   *   严格大于 ⇒ 每 IP collected_at 字典序最大行永不命中 + tie 行（相等）全存活——
   *   清理后网段视图/导出（rn=1 同序窗口）取值不变。
   * cutoff 由 JS new Date().toISOString() 生成（与 arpCollector 唯一写入点逐字同源；
   * 禁 SQLite 系统时间函数生成 cutoff——'YYYY-MM-DD HH:MM:SS' 与 ISO 串同日边界 ' ' < 'T' 字典序错位）。
   * 可观测走 console.log（系统日志表 CHECK 枚举无 'retention'，禁写日志表）。
   */
  static async runArpRetention(): Promise<{ deleted: number; batches: number }> {
    const retentionDays = this.getConfig().retentionDays ?? 90   // D-06：v13 列 DEFAULT 90 即事实默认
    if (!retentionDays || retentionDays <= 0) return { deleted: 0, batches: 0 }   // 0=永不删除特殊值直跳
    if (this.retentionRunning) return { deleted: 0, batches: 0 }   // 防重入门控
    this.retentionRunning = true
    try {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
      const db = getDatabase()
      const stmtCandidates = db.prepare(
        `SELECT a.id FROM arp_entries a
         WHERE a.collected_at < ? AND EXISTS (SELECT 1 FROM arp_entries a2 WHERE a2.ip = a.ip AND a2.collected_at > a.collected_at)
         LIMIT ?`
      )
      let deleted = 0, batches = 0
      console.log(`[retention] start: retentionDays=${retentionDays} cutoff=${cutoff}`)
      for (;;) {
        const ids = (stmtCandidates.all(cutoff, RETENTION_BATCH) as Array<{ id: number }>).map((r) => r.id)
        if (ids.length === 0) break
        // IN 占位符模板（anomalyService 先例）：'?,'.repeat(n-1)+'?' 生成占位符，参数化禁拼值
        const placeholders = '?,'.repeat(ids.length - 1) + '?'
        const info = db.prepare(`DELETE FROM arp_entries WHERE id IN (${placeholders})`).run(...ids)
        deleted += info.changes
        batches++
        console.log(`[retention] batch ${batches}: deleted ${info.changes} rows (cutoff ${cutoff})`)
        if (ids.length < RETENTION_BATCH) break   // 候选数 < 批大小即止
        // 批间 yield 让 IPC 呼吸（SC#4：不冻结主进程）
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (deleted > 0) {
        try {
          // 清理后收 checkpoint：WAL 归零主文件，避免 -wal 侧车随删除行数膨胀
          db.pragma('wal_checkpoint(TRUNCATE)')
        } catch (e) {
          console.warn('[retention] wal_checkpoint failed (non-blocking):', (e as Error).message)
        }
      }
      console.log(`[retention] done: deleted=${deleted} batches=${batches}`)
      return { deleted, batches }
    } finally {
      this.retentionRunning = false
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
          // 18-04（TXN-01）：内联 INSERT 副本删除，写库段换调 ArpIngestService 单设备单事务。
          // P8 审计（A4 采纳）：补 per-device try/catch 对齐 arpIpc.collectFromAll 既有语义——
          // 单设备事务失败整体回滚该设备写入后 continue，不再 throw 冒泡致整任务失败（已写设备保留半态）。
          try {
            const ingested = ArpIngestService.ingestDeviceResult(db, result, collectionTime)
            totalChanges += ingested.changes
          } catch (e: any) {
            console.error('[Scheduler] device ingest failed:', result.deviceId, e.message)
            continue
          }
        }
      }

      const deprecatedCount = IPStatusService.endCollection(collectionTime)
      this.notifyRenderer('task-completed', {
        devices: results.length, entries: totalEntries, changes: totalChanges,
        deprecated: deprecatedCount, timestamp: new Date().toISOString(),
      })
      // 18-05（TXN-03）retention 钩子二——executeTask 完成后清旧（采集写完新行随即清理超期历史）。
      // 非致命 fire-and-forget；executeTask 只在 scheduler 启用路径跑（runTask/runNow），位于 enabled 语境内天然成立。
      void this.runArpRetention().catch((e) => console.warn('[retention] post-collect hook failed:', e))
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
      // 18-05（D-06）：retention_days 由 v13 列 DEFAULT 90 兜底，零额外迁移
      return { id: 1, enabled: false, intervalMinutes: 60, retentionDays: 90, lastRun: null, nextRun: null }
    }
    return { id: row.id, enabled: Boolean(row.enabled), intervalMinutes: row.interval_minutes ?? 60, retentionDays: row.retention_days ?? 90, lastRun: row.last_run, nextRun: row.next_run }
  }

  static updateConfig(updates: { enabled?: boolean; intervalMinutes?: number; retentionDays?: number }): any {
    const db = getDatabase()
    const config = this.getConfig()
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (config.enabled ? 1 : 0)
    const intervalMinutes = updates.intervalMinutes ?? config.intervalMinutes ?? 60
    // 未传入时保持现值（与 enabled/interval 同款语义；retention 运行时由钩子读 getConfig() 取新值）
    const retentionDays = updates.retentionDays ?? config.retentionDays ?? 90
    db.prepare('UPDATE scheduler_config SET enabled = ?, interval_minutes = ?, retention_days = ? WHERE id = 1').run(enabled, intervalMinutes, retentionDays)
    // CR-01（18-REVIEW）纵深防御：仅 interval/enabled 变更需要重启调度周期；retentionDays 变更不重启——
    // restart()→start() 顶部挂 retention 启动钩子（不可恢复批量 DELETE），任何走 updateConfig 的提交
    // 若无差别 restart 都会以当前库值触发一次清理。retention 由启动钩子 + executeTask 尾钩在运行时
    // 读 getConfig() 自然生效，无需重启。
    if (updates.intervalMinutes !== undefined || updates.enabled !== undefined) {
      this.restart()
    }
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
