import { ipcMain } from 'electron'
import { ARPCollector } from '../services/arpCollector'
import { IPStatusService } from '../services/ipStatusService'
import { ArpIngestService } from '../services/arpIngestService'
import { getDatabase } from '../database/connection'
import { secure } from '../utils/authGuard'

export function registerArpIpc() {
  ipcMain.handle('arp:collectFromDevice', secure(async (_e, deviceId: string) => {
    const { getDeviceById } = await import('../services/device')
    const device = getDeviceById(deviceId)
    if (!device) throw new Error('设备不存在')
    const collector = new ARPCollector()
    const result = await collector.collectFromDevice(device)

    if (result.entries.length > 0) {
      const db = getDatabase()
      const collectionTime = IPStatusService.beginCollection()
      try {
        // 18-04（TXN-01）：写库段下沉 ArpIngestService——单设备单事务（INSERT + ip_status + anomaly 原子）
        ArpIngestService.ingestDeviceResult(db, result, collectionTime)
      } finally {
        IPStatusService.endCollection(collectionTime)
      }
    }
    return result
  }))

  ipcMain.handle('arp:collectFromAll', secure(async () => {
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
          // 18-04（TXN-01）：单设备单事务落库；per-device catch 保留在事务外（P8 设备级容错）
          const ingested = ArpIngestService.ingestDeviceResult(db, result, collectionTime)
          stats.entries += ingested.inserted
          stats.changes += ingested.changes
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
  }))
}
