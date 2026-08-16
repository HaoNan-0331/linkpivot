import type Database from 'better-sqlite3'
import { IPStatusService } from './ipStatusService'
import { AnomalyService } from './anomalyService'

// ARP 采集落库单一来源（18-04 / TXN-01）：收编 arpIpc.insertArpEntries helper 与
// schedulerService.executeTask 内联 INSERT 两份副本——arp_entries 插入语句全仓唯一所在。
//
// 单设备单同步事务：INSERT arp_entries + IPStatusService.batchUpdateIPStatus +
// AnomalyService.processARPEntries 同一 db.transaction 体内执行，中途失败整体 ROLLBACK
// 无半写状态（T-18-11）。两嵌套 service 自带 db.transaction，在外层事务内调用自动降级
// SAVEPOINT，行级容错语义全保留（anomalyService entryTx 先例）。
//
// 容错边界（P8 审计归位）：
//   行级（事务体内）：per-entry UNIQUE|CONSTRAINT catch 忽略、其余 console.error——单条失败不废整设备事务
//   设备级（事务体外）：调用方 per-device catch（arpIpc.collectFromAll 既有 + schedulerService 18-04 补齐）
//
// db 经参数传入（镜像原 insertArpEntries(db, ...) 形态，调用方 arpIpc/schedulerService 均已持有
// getDatabase() 单例；两嵌套 service 内部 getDatabase() 返回同一单例，故嵌套 SAVEPOINT 落在同一连接）。
export class ArpIngestService {
  /**
   * 单设备采集结果落库（单事务原子）。
   * @param db 数据库实例（与 IPStatusService/AnomalyService 内部 getDatabase() 同一连接时嵌套自动 SAVEPOINT）
   * @param result 设备采集结果（deviceId + entries + collectedAt——INSERT 用每设备自身采集时间）
   * @param collectionTime 本轮采集窗口时间（beginCollection 生成，batchUpdateIPStatus 用窗口时间）
   * @returns inserted=成功插入 arp_entries 条数（UNIQUE 冲突行不计），changes=anomaly 变更条数
   */
  static ingestDeviceResult(
    db: Database.Database,
    result: {
      deviceId: string
      entries: Array<{ ip: string; mac: string; vlan?: string | null; interface?: string | null }>
      collectedAt: string
    },
    collectionTime: string
  ): { inserted: number; changes: number } {
    let inserted = 0
    let changes = 0
    const stmt = db.prepare('INSERT INTO arp_entries (device_id, ip, mac, vlan, interface, collected_at) VALUES (?, ?, ?, ?, ?, ?)')
    const ingest = db.transaction(() => {
      for (const entry of result.entries) {
        // 行级容错（P8 保留）：仅忽略 UNIQUE/CONSTRAINT 冲突，其他错误记录日志不静默吞
        try {
          stmt.run(result.deviceId, entry.ip, entry.mac, entry.vlan || null, entry.interface || null, result.collectedAt)
          inserted++
        } catch (e: any) {
          if (!/UNIQUE|CONSTRAINT/i.test(e.message)) console.error('[arpIngest] insert failed:', e.message)
        }
      }
      IPStatusService.batchUpdateIPStatus(result.entries.map(e => ({ ip: e.ip, mac: e.mac })), collectionTime)
      changes = AnomalyService.processARPEntries(result.entries).length
    })
    ingest()
    return { inserted, changes }
  }
}
