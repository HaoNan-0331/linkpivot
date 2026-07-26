import { BrowserWindow, shell } from 'electron'

/**
 * 统一的外链打开安全门：仅放行 http/https，其余协议 deny。
 * 三处入口（hardenWindow setWindowOpenHandler / 全局 web-contents-created handler / openWebSafe）共用，
 * 杜绝 shell.openExternal 直接吞 file:/javascript:/data:/custom-protocol 等危险协议。
 * throws：协议非法（URL 解析失败或非 http/https）抛 Error，由调用方决定如何处理（deny / IPC 报错）。
 */
export function openExternalSafe(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('无效的 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的协议: ${parsed.protocol}`)
  }
  shell.openExternal(url)
}

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
    try { openExternalSafe(url) } catch (e) {
      console.warn('[hardenWindow] blocked openExternal:', (e as Error).message)
    }
    return { action: 'deny' }
  })
}
