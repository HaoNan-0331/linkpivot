import { ipcMain } from 'electron'
import { NetworkSegmentService } from '../services/networkSegmentService'
import { secure } from '../utils/authGuard'

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/** 校验子网掩码：4 段合法 + 二进制连续（^1*0*$）。 */
function isValidMask(mask: string): boolean {
  if (!IPV4_RE.test(mask)) return false
  const bits = mask.split('.').map((p) => parseInt(p, 10).toString(2).padStart(8, '0')).join('')
  return /^1*0*$/.test(bits)
}

function validateSegmentInput(input: any, partial: boolean): string | null {
  if (!input || typeof input !== 'object') return '参数无效'
  if ((!partial || input.name !== undefined) && (typeof input.name !== 'string' || input.name.trim() === '')) return '名称不能为空'
  if ((!partial || input.network !== undefined) && (!input.network || !IPV4_RE.test(input.network))) return '网段地址非法'
  if ((!partial || input.mask !== undefined) && (!input.mask || !isValidMask(input.mask))) return '子网掩码非法或非连续'
  return null
}

export function registerNetworkIpc() {
  ipcMain.handle('network:getAll', secure(() => NetworkSegmentService.getAll()))
  ipcMain.handle('network:getById', secure((_e, id: number) => NetworkSegmentService.getById(id)))
  ipcMain.handle('network:create', secure((_e, data: any) => {
    const err = validateSegmentInput(data, false)
    if (err) throw new Error(err)
    return NetworkSegmentService.create(data)
  }))
  ipcMain.handle('network:update', secure((_e, data: any) => {
    const err = validateSegmentInput(data, true)
    if (err) throw new Error(err)
    return NetworkSegmentService.update(data)
  }))
  ipcMain.handle('network:delete', secure((_e, id: number) => NetworkSegmentService.delete(id)))
  ipcMain.handle('network:autoDiscover', secure(() => NetworkSegmentService.autoDiscover()))
  ipcMain.handle('network:getIPUsage', secure((_e, networkId: number) => NetworkSegmentService.getIPUsage(networkId)))
  ipcMain.handle('network:getIPDetails', secure((_e, networkId: number, searchIp?: string, searchMac?: string, sortBy?: string, sortOrder?: string) =>
    NetworkSegmentService.getIPDetails(networkId, searchIp, searchMac, sortBy, sortOrder)))
}
