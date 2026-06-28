import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import path from 'path'
import { initDatabase, closeDatabase, migrateAndSecure } from './database/connection'
import { createTables } from './database/init'
import { getOrCreateMasterKey } from './utils/keyManager'
import { hardenWindow } from './utils/webSecurity'
import { secure, setAuthenticated } from './utils/authGuard'
import { generateCaptcha, login, isFirstRun, initAdmin } from './services/auth'
import { setDeviceMasterKey, listDevices, createDevice, updateDevice, deleteDevice, getDeviceById } from './services/device'
import { setTopologyMasterKey, listTopologies, getTopologyById, createTopology, updateTopology, deleteTopology, exportTopology, importTopology } from './services/topology'
import { setConnectionMasterKey, openTerminal, openWebSafe, writeToSession, writeByWebContentsId, disconnectSession, testDeviceConnection } from './services/connection'
import { setAiMasterKey, chat, getAiConfigMasked, saveAiConfig, getCommandWhitelist, saveCommandWhitelist, getExecMode, setExecMode, confirmCommand, getAiLogs, getChatHistory, saveChatMessage as aiSaveChatMessage, clearChatHistory, createSession, listSessions, getSessionMessages, deleteSession, updateSessionTitle } from './services/ai'
import { discoverTopology } from './services/discovery'
import { getSystemLogs } from './services/systemLog'
import { setArpMasterKey } from './services/arpCollector'
import { SchedulerService } from './services/schedulerService'
import { BackupScheduler } from './services/backupScheduler'
import { OUIService } from './services/ouiService'
import { registerArpIpc } from './ipc/arpIpc'
import { registerNetworkIpc } from './ipc/networkIpc'
import { registerAnomalyIpc } from './ipc/anomalyIpc'
import { registerOuiIpc } from './ipc/ouiIpc'
import { registerExportIpc } from './ipc/exportIpc'
import { registerSchedulerIpc } from './ipc/schedulerIpc'
import { setKbMasterKey } from './services/knowledgeBaseService'
import { registerKbIpc } from './ipc/knowledgeBaseIpc'

let mainWindow: BrowserWindow | null = null
let masterKey: string

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1024, minHeight: 768,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  })
  hardenWindow(mainWindow)

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  // 注入严格 CSP（渲染层 XSS 第二道防线）；AI API 由主进程 fetch，不受此限制
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // dev 模式：vite + @vitejs/plugin-react 注入 inline HMR preamble，严格 CSP 'script-src self' 会阻止 → 白屏。
    // dev 跳过 CSP 注入以兼容 HMR；production 保持严格 CSP（渲染层 XSS 第二道防线）。
    if (process.env.NODE_ENV === 'development') {
      callback({})
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:",
        ],
      },
    })
  })
  // 全局兜底：所有新建 webContents 的弹窗（target=_blank / window.open）交给系统浏览器
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  })

  masterKey = getOrCreateMasterKey()
  setDeviceMasterKey(masterKey)
  setTopologyMasterKey(masterKey)
  setConnectionMasterKey(masterKey)
  setAiMasterKey(masterKey)
  setArpMasterKey(masterKey)
  setKbMasterKey(masterKey)
  const __startupT0 = performance.now()   // PERF-04 (W1)：冷启动 DB+OUI init 计时起点
  initDatabase()
  createTables()
  migrateAndSecure()   // 迁移前备份(gated on 非空库) + runMigrations + ACL 收紧 db/wal/shm（D-06/D-12a）
  // PERF-01 (D-P1)：启动预载 Map<macPrefix,vendor>，确保首次 getIPDetails 时 Map 就绪（消除 N+1）
  OUIService.preload()
  console.log('[startup] DB+OUI init', (performance.now() - __startupT0).toFixed(0), 'ms')   // PERF-04：冷启动耗时，供 before/after 证据 grep 验证

  // IP Management IPC
  registerArpIpc()
  registerNetworkIpc()
  registerAnomalyIpc()
  registerOuiIpc()
  registerExportIpc()
  registerSchedulerIpc()
  registerKbIpc()
  SchedulerService.start()
  BackupScheduler.start()

  // Auth IPC（登录前可用，不做鉴权；login 成功置登录态）
  ipcMain.handle('auth:getCaptcha', () => { const r = generateCaptcha(); return { svg: r.svg, key: r.key } })
  ipcMain.handle('auth:login', async (_e, u, p, ck, ci) => {
    const r = await login(u, p, ck, ci)
    if (r.success) setAuthenticated(true)
    return r
  })
  ipcMain.handle('auth:isFirstRun', () => isFirstRun())
  ipcMain.handle('auth:initAdmin', (_e, u, p) => initAdmin(u, p))

  // Device IPC（secure = 登录鉴权 + 异常脱敏）
  ipcMain.handle('device:list', secure(() => listDevices()))
  ipcMain.handle('device:create', secure((_e, data) => createDevice(data)))
  ipcMain.handle('device:update', secure((_e, id, data) => updateDevice(id, data)))
  ipcMain.handle('device:delete', secure((_e, id) => deleteDevice(id)))
  ipcMain.handle('device:getById', secure((_e, id) => getDeviceById(id)))

  // Topology IPC
  ipcMain.handle('topology:list', secure(() => listTopologies()))
  ipcMain.handle('topology:getById', secure((_e, id) => getTopologyById(id)))
  ipcMain.handle('topology:create', secure((_e, data) => createTopology(data)))
  ipcMain.handle('topology:update', secure((_e, id, data) => updateTopology(id, data)))
  ipcMain.handle('topology:delete', secure((_e, id) => deleteTopology(id)))
  ipcMain.handle('topology:exportJson', secure((_e, id) => exportTopology(id)))
  ipcMain.handle('topology:importJson', secure((_e, data) => importTopology(data)))

  // Connection IPC
  ipcMain.handle('connection:ssh', secure((_e, deviceId) => openTerminal(deviceId)))
  ipcMain.handle('connection:telnet', secure((_e, deviceId) => openTerminal(deviceId)))
  ipcMain.handle('connection:rdp', secure((_e, deviceId) => openTerminal(deviceId)))
  ipcMain.handle('connection:openWeb', secure((_e, url) => openWebSafe(url)))
  ipcMain.handle('connection:disconnect', secure((_e, sessionId) => disconnectSession(sessionId)))
  ipcMain.handle('connection:write', secure((_e, sessionId, data) => writeToSession(sessionId, data)))
  ipcMain.handle('connection:test', secure((_e, deviceId) => testDeviceConnection(deviceId)))

  // Terminal window IPC：writeByWebContentsId 经 windowSessionMap 查 sessionId，
  // 只有终端窗口 webContents id 在 map 中，主窗口无法注入（sender 隔离）
  ipcMain.handle('terminal:write', secure((e, data) => writeByWebContentsId(e.sender.id, data)))

  // AI IPC
  ipcMain.handle('ai:chat', secure((_e, messages, deviceIds, sessionId) => chat(messages, deviceIds, sessionId)))
  ipcMain.handle('ai:getConfig', secure(() => getAiConfigMasked()))
  ipcMain.handle('ai:saveConfig', secure((_e, config) => saveAiConfig(config)))
  ipcMain.handle('ai:getCommandWhitelist', secure(() => getCommandWhitelist()))
  ipcMain.handle('ai:saveCommandWhitelist', secure((_e, list) => saveCommandWhitelist(list)))
  ipcMain.handle('ai:getExecMode', secure(() => getExecMode()))
  ipcMain.handle('ai:setExecMode', secure((_e, mode, password) => setExecMode(mode, password)))
  ipcMain.handle('ai:confirmCommand', secure((_e, execId, approved) => confirmCommand(execId, approved)))
  ipcMain.handle('ai:getLogs', secure((_e, limit) => getAiLogs(limit)))
  ipcMain.handle('ai:getChatHistory', secure(() => getChatHistory()))
  ipcMain.handle('ai:saveMessage', secure((_e, role, content, deviceId, sessionId) => aiSaveChatMessage(role, content, deviceId, sessionId)))
  ipcMain.handle('ai:clearHistory', secure(() => clearChatHistory()))
  ipcMain.handle('ai:createSession', secure((_e, title, deviceId) => createSession(title, deviceId)))
  ipcMain.handle('ai:listSessions', secure(() => listSessions()))
  ipcMain.handle('ai:getSessionMessages', secure((_e, sessionId) => getSessionMessages(sessionId)))
  ipcMain.handle('ai:deleteSession', secure((_e, sessionId) => deleteSession(sessionId)))
  ipcMain.handle('ai:updateSessionTitle', secure((_e, sessionId, title) => updateSessionTitle(sessionId, title)))
  ipcMain.handle('ai:discoverTopology', secure((_e, deviceIds) => discoverTopology(deviceIds)))
  ipcMain.handle('ai:getSystemLogs', secure((_e, limit) => getSystemLogs(limit)))

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

app.on('before-quit', () => { BackupScheduler.stop(); closeDatabase() })
