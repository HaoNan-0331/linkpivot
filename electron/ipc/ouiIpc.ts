import { ipcMain } from 'electron'
import { OUIService } from '../services/ouiService'
import { secure } from '../utils/authGuard'
import { validateLimit, validateOffset } from '../utils/pagination'

const MAX_BATCH = 1000

export function registerOuiIpc() {
  ipcMain.handle('oui:getAll', secure((_e, limit?: number, offset?: number) =>
    // DATA-01 / D-4-3/D-4-4：默认 5000、硬上限 50000。网关层校验后下推 SQL LIMIT/OFFSET。
    OUIService.getAll(validateLimit(limit, 5000, 50000), validateOffset(offset))))
  ipcMain.handle('oui:search', secure((_e, keyword: string) => OUIService.search(keyword)))
  ipcMain.handle('oui:getById', secure((_e, id: number) => OUIService.getById(id)))
  ipcMain.handle('oui:add', secure((_e, data: any) => {
    if (!data || typeof data !== 'object') throw new Error('参数无效')
    return OUIService.add(data)
  }))
  ipcMain.handle('oui:addBatch', secure((_e, entries: any[]) => {
    if (!Array.isArray(entries) || entries.length > MAX_BATCH) throw new Error(`批量上限 ${MAX_BATCH} 条`)
    if (entries.some((e) => !e || typeof e !== 'object')) throw new Error('条目格式非法')
    return OUIService.addBatch(entries)
  }))
  ipcMain.handle('oui:update', secure((_e, data: any) => {
    if (!data || typeof data !== 'object') throw new Error('参数无效')
    return OUIService.update(data)
  }))
  ipcMain.handle('oui:delete', secure((_e, id: number) => OUIService.delete(id)))
  ipcMain.handle('oui:deleteBatch', secure((_e, ids: number[]) => {
    if (!Array.isArray(ids) || ids.length > MAX_BATCH) throw new Error(`批量上限 ${MAX_BATCH} 条`)
    return OUIService.deleteBatch(ids)
  }))
  ipcMain.handle('oui:getVendor', secure((_e, mac: string) => OUIService.getVendor(mac)))
  ipcMain.handle('oui:getAllVendors', secure(() => OUIService.getAllVendors()))
  ipcMain.handle('oui:getStats', secure(() => OUIService.getStats()))
}
