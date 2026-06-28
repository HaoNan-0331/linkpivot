import { ipcMain } from 'electron'
import { AnomalyService } from '../services/anomalyService'
import { secure } from '../utils/authGuard'
import { validateLimit, validateOffset } from '../utils/pagination'

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

function validateId(id: any): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new Error('id 非法')
  return n
}

export function registerAnomalyIpc() {
  ipcMain.handle('anomaly:getChanges', secure((_e, unacknowledgedOnly?: boolean, limit?: number, offset?: number) =>
    // DATA-01 / D-4-3/D-4-4：维持默认 100、硬上限 10000。复用共享 validateLimit/validateOffset（D-4-1 补 offset）。
    AnomalyService.getChanges(unacknowledgedOnly, validateLimit(limit, 100, 10000), validateOffset(offset))))
  ipcMain.handle('anomaly:acknowledge', secure((_e, id: number, notes?: string) => {
    validateId(id); return AnomalyService.acknowledgeChange(id, notes)
  }))
  ipcMain.handle('anomaly:acknowledgeAll', secure(() => AnomalyService.acknowledgeAll()))
  ipcMain.handle('anomaly:deleteChange', secure((_e, id: number) => { validateId(id); return AnomalyService.deleteChange(id) }))
  ipcMain.handle('anomaly:deleteChanges', secure((_e, ids: number[]) => {
    if (!Array.isArray(ids) || ids.length > 10000) throw new Error('ids 非法或超限')
    ids.forEach(validateId)
    return AnomalyService.deleteChanges(ids)
  }))
  ipcMain.handle('anomaly:getStats', secure(() => AnomalyService.getStats()))
  ipcMain.handle('anomaly:getBindingHistory', secure((_e, ip: string) => {
    if (!ip || !IPV4_RE.test(ip)) throw new Error('IP 格式非法')
    return AnomalyService.getBindingHistory(ip)
  }))
  ipcMain.handle('anomaly:getExcludedIPs', secure(() => AnomalyService.getExcludedIPs()))
  ipcMain.handle('anomaly:addExcludedIP', secure((_e, data: any) => {
    if (!data || typeof data.ipOrCidr !== 'string' || data.ipOrCidr.trim() === '') throw new Error('排除规则不能为空')
    return AnomalyService.addExcludedIP(data)
  }))
  ipcMain.handle('anomaly:deleteExcludedIP', secure((_e, id: number) => { validateId(id); return AnomalyService.deleteExcludedIP(id) }))
}
