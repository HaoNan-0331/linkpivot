import { ipcMain } from 'electron'
import { UpdateService } from '../services/updateService'
import { secure } from '../utils/authGuard'

/**
 * Phase 30（30-03，UPD-01/02）—— update:* 八通道注册。
 *
 * 登录后域红线：全部经 secure 包装（升级操作只发生在登录后主界面，无一条 safe——
 * RESEARCH Anti-Patterns 裁决）；renderer 永不触 autoUpdater/setFeedURL（feed 由构建时
 * app-update.yml 固化，T-30-07），仅经 preload 白名单收状态/发指令。
 * setSnooze 档位枚举在网关层 throw 拦截（schedulerIpc :11-14 校验形态），
 * setSkipVersion 格式校验单源在 service 层（成功/拒绝都显式回错）。
 */
export function registerUpdateIpc() {
  ipcMain.handle('update:getStatus', secure(() => UpdateService.getStatus()))
  ipcMain.handle('update:checkNow', secure(() => UpdateService.checkNow()))
  ipcMain.handle('update:download', secure(() => UpdateService.startDownload()))
  ipcMain.handle('update:cancel', secure(() => UpdateService.cancelDownload()))
  ipcMain.handle('update:install', secure(() => UpdateService.quitAndInstall()))
  ipcMain.handle('update:setSnooze', secure((_e, mode: string) => {
    if (mode !== '30d' && mode !== '180d' && mode !== 'forever') throw new Error('档位取值非法')
    const r = UpdateService.setSnooze(mode)
    if (!r.success) throw new Error(r.error ?? '设置失败')
    return r
  }))
  ipcMain.handle('update:setSkipVersion', secure((_e, v: string) => {
    const r = UpdateService.setSkipVersion(v)
    if (!r.success) throw new Error(r.error ?? '设置失败')
    return r
  }))
  ipcMain.handle('update:getVersion', secure(() => UpdateService.getVersion()))
}
