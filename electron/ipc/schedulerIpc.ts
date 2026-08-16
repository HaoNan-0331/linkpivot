import { ipcMain } from 'electron'
import { SchedulerService } from '../services/schedulerService'
import { secure } from '../utils/authGuard'

export function registerSchedulerIpc() {
  ipcMain.handle('scheduler:getConfig', secure(() => SchedulerService.getConfig()))
  ipcMain.handle('scheduler:updateConfig', secure((_e, data: any) => {
    if (!data || typeof data !== 'object') throw new Error('参数无效')
    // 18-05（Pitfall #6 死验证修正）：renderer SettingsPage 实发 camelCase intervalMinutes，
    // 原 snake_case 字段名校验从不触发属 bug，随 retentionDays 同函数顺带修正
    if (data.intervalMinutes !== undefined) {
      const v = Number(data.intervalMinutes)
      if (!Number.isInteger(v) || v < 1 || v > 10080) throw new Error('间隔分钟数非法（1-10080）')
    }
    // 18-05（D-07）：ARP 保留天数校验——camelCase 与 renderer 实发字段对齐；0=永不删除合法特殊值
    if (data.retentionDays !== undefined) {
      const v = Number(data.retentionDays)
      if (!Number.isInteger(v) || v < 0 || v > 3650) throw new Error('保留天数非法（0-3650，0=永不删除）')
    }
    if (data.enabled !== undefined && ![0, 1, true, false].includes(data.enabled)) {
      throw new Error('enabled 取值非法')
    }
    return SchedulerService.updateConfig(data)
  }))
  ipcMain.handle('scheduler:runNow', secure(() => SchedulerService.runNow()))
  ipcMain.handle('scheduler:getStatus', secure(() => SchedulerService.getStatus()))
}
