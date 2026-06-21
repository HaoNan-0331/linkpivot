import { ipcMain } from 'electron'
import { ARPCollector } from '../services/arpCollector'
import { IPStatusService } from '../services/ipStatusService'
import { AnomalyService } from '../services/anomalyService'
import { getDatabase } from '../database/connection'

// 写入 ARP 条目：仅忽略主键/唯一冲突，其他错误记录日志，避免静默吞掉真实写库失败。
function insertArpEntries(db: any, deviceId: string, entries: any[], collectedAt: string): number {
  const stmt = db.prepare('INSERT INTO arp_entries (device_id, ip, mac, vlan, interface, collected_at) VALUES (?, ?, ?, ?, ?, ?)')
  let inserted = 0
  for (const entry of entries) {
    try {
      stmt.run(deviceId, entry.ip, entry.mac, entry.vlan || null, entry.interface || null, collectedAt)
      inserted++
    } catch (e: any) {
      if (!/UNIQUE|CONSTRAINT/i.test(e.message)) console.error('[arp] insert failed:', e.message)
    }
  }
  return inserted
}

export function registerArpIpc() {
  ipcMain.handle('arp:collectFromDevice', async (_e, deviceId: string) => {
    const { getDeviceById } = await import('../services/device')
    const device = getDeviceById(deviceId)
    if (!device) throw new Error('设备不存在')
    const collector = new ARPCollector()
    const result = await collector.collectFromDevice(device)

    if (result.entries.length > 0) {
      const db = getDatabase()
      const collectionTime = IPStatusService.beginCollection()
      try {
        insertArpEntries(db, result.deviceId, result.entries, result.collectedAt)
        IPStatusService.batchUpdateIPStatus(result.entries.map((e: any) => ({ ip: e.ip, mac: e.mac })), collectionTime)
        AnomalyService.processARPEntries(result.entries)
      } finally {
        IPStatusService.endCollection(collectionTime)
      }
    }
    return result
  })

  ipcMain.handle('arp:collectFromAll', async () => {
    const results = await ARPCollector.collectFromAll()
    const db = getDatabase()
    const collectionTime = IPStatusService.beginCollection()
    const stats = { entries: 0, changes: 0, failures: 0, deprecated: 0 }
    const okResults: any[] = []

    try {
      for (const result of results) {
        if (result.error) { stats.failures++; okResults.push(result); continue }
        if (!result.entries || result.entries.length === 0) { okResults.push(result); continue }
        try {
          stats.entries += insertArpEntries(db, result.deviceId, result.entries, result.collectedAt)
          IPStatusService.batchUpdateIPStatus(result.entries.map((e: any) => ({ ip: e.ip, mac: e.mac })), collectionTime)
          stats.changes += AnomalyService.processARPEntries(result.entries).length
          okResults.push(result)
        } catch (e: any) {
          stats.failures++
          console.error('[arp] device collect failed:', result.deviceId, e.message)
          okResults.push({ ...result, error: e.message })
        }
      }
    } finally {
      stats.deprecated = IPStatusService.endCollection(collectionTime)
    }
    return { results: okResults, stats }
  })
}
