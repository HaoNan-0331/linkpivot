import { BrowserWindow, shell } from 'electron'

/**
 * 统一加固 BrowserWindow 的 webContents：
 * - will-navigate：禁止导航到非当前页 URL（防渲染层被注入后跳转远程 / file://）
 * - setWindowOpenHandler：新窗口（target=_blank / window.open）交给系统浏览器，Electron 内不打开
 * 主窗口与终端窗口均应调用。
 */
export function hardenWindow(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}
