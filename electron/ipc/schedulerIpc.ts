import { ipcMain } from 'electron'
import { SchedulerService } from '../services/schedulerService'
import { secure } from '../utils/authGuard'

export function registerSchedulerIpc() {
  ipcMain.handle('scheduler:getConfig', secure(() => SchedulerService.getConfig()))
  ipcMain.handle('scheduler:updateConfig', secure((_e, data: any) => {
    if (!data || typeof data !== 'object') throw new Error('参数无效')
    if (data.interval_minutes !== undefined) {
      const v = Number(data.interval_minutes)
      if (!Number.isInteger(v) || v < 1 || v > 10080) throw new Error('间隔分钟数非法（1-10080）')
    }
    if (data.enabled !== undefined && ![0, 1, true, false].includes(data.enabled)) {
      throw new Error('enabled 取值非法')
    }
    return SchedulerService.updateConfig(data)
  }))
  ipcMain.handle('scheduler:runNow', secure(() => SchedulerService.runNow()))
  ipcMain.handle('scheduler:getStatus', secure(() => SchedulerService.getStatus()))
}
