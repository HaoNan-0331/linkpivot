import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'path'
import { initDatabase, closeDatabase } from './database/connection'
import { createTables } from './database/init'
import { getOrCreateMasterKey } from './utils/keyManager'
import { generateCaptcha, login, isFirstRun, initAdmin } from './services/auth'
import { setDeviceMasterKey, listDevices, createDevice, updateDevice, deleteDevice, getDeviceById } from './services/device'
import { setTopologyMasterKey, listTopologies, getTopologyById, createTopology, updateTopology, deleteTopology, exportTopology, importTopology } from './services/topology'
import { setConnectionMasterKey, openTerminal, openWebSafe, writeToSession, writeByWebContentsId, disconnectSession, testDeviceConnection } from './services/connection'
import { setAiMasterKey, chat, getAiConfigMasked, saveAiConfig, getCommandWhitelist, saveCommandWhitelist, getExecMode, setExecMode, confirmCommand, getAiLogs, getChatHistory, saveChatMessage as aiSaveChatMessage, clearChatHistory, createSession, listSessions, getSessionMessages, deleteSession, updateSessionTitle } from './services/ai'
import { discoverTopology } from './services/discovery'
import { getSystemLogs } from './services/systemLog'
import { setArpMasterKey } from './services/arpCollector'
import { SchedulerService } from './services/schedulerService'
import { registerArpIpc } from './ipc/arpIpc'
import { registerNetworkIpc } from './ipc/networkIpc'
import { registerAnomalyIpc } from './ipc/anomalyIpc'
import { registerOuiIpc } from './ipc/ouiIpc'
import { registerExportIpc } from './ipc/exportIpc'
import { registerSchedulerIpc } from './ipc/schedulerIpc'

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
      sandbox: false,
    },
    show: false,
  })

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
  masterKey = getOrCreateMasterKey()
  setDeviceMasterKey(masterKey)
  setTopologyMasterKey(masterKey)
  setConnectionMasterKey(masterKey)
  setAiMasterKey(masterKey)
  setArpMasterKey(masterKey)
  initDatabase()
  createTables()

  // IP Management IPC
  registerArpIpc()
  registerNetworkIpc()
  registerAnomalyIpc()
  registerOuiIpc()
  registerExportIpc()
  registerSchedulerIpc()
  SchedulerService.start()

  // Auth IPC
  ipcMain.handle('auth:getCaptcha', () => { const r = generateCaptcha(); return { svg: r.svg, key: r.key } })
  ipcMain.handle('auth:login', (_e, u, p, ck, ci) => login(u, p, ck, ci))
  ipcMain.handle('auth:isFirstRun', () => isFirstRun())
  ipcMain.handle('auth:initAdmin', (_e, u, p) => initAdmin(u, p))

  // Device IPC
  ipcMain.handle('device:list', () => listDevices())
  ipcMain.handle('device:create', (_e, data) => createDevice(data))
  ipcMain.handle('device:update', (_e, id, data) => updateDevice(id, data))
  ipcMain.handle('device:delete', (_e, id) => deleteDevice(id))
  ipcMain.handle('device:getById', (_e, id) => getDeviceById(id))

  // Topology IPC
  ipcMain.handle('topology:list', () => listTopologies())
  ipcMain.handle('topology:getById', (_e, id) => getTopologyById(id))
  ipcMain.handle('topology:create', (_e, data) => createTopology(data))
  ipcMain.handle('topology:update', (_e, id, data) => updateTopology(id, data))
  ipcMain.handle('topology:delete', (_e, id) => deleteTopology(id))
  ipcMain.handle('topology:exportJson', (_e, id) => exportTopology(id))
  ipcMain.handle('topology:importJson', (_e, data) => importTopology(data))

  // Connection IPC
  ipcMain.handle('connection:ssh', (_e, deviceId) => openTerminal(deviceId))
  ipcMain.handle('connection:telnet', (_e, deviceId) => openTerminal(deviceId))
  ipcMain.handle('connection:rdp', (_e, deviceId) => openTerminal(deviceId))
  ipcMain.handle('connection:openWeb', (_e, url) => openWebSafe(url))
  ipcMain.handle('connection:disconnect', (_e, sessionId) => disconnectSession(sessionId))
  ipcMain.handle('connection:write', (_e, sessionId, data) => writeToSession(sessionId, data))
  ipcMain.handle('connection:test', (_e, deviceId) => testDeviceConnection(deviceId))

  // Terminal window IPC (from popup terminal windows)
  ipcMain.handle('terminal:write', (e, data) => writeByWebContentsId(e.sender.id, data))

  // AI IPC
  ipcMain.handle('ai:chat', (_e, messages, deviceIds, sessionId) => chat(messages, deviceIds, sessionId))
  ipcMain.handle('ai:getConfig', () => getAiConfigMasked())
  ipcMain.handle('ai:saveConfig', (_e, config) => saveAiConfig(config))
  ipcMain.handle('ai:getCommandWhitelist', () => getCommandWhitelist())
  ipcMain.handle('ai:saveCommandWhitelist', (_e, list) => saveCommandWhitelist(list))
  ipcMain.handle('ai:getExecMode', () => getExecMode())
  ipcMain.handle('ai:setExecMode', (_e, mode, password) => setExecMode(mode, password))
  ipcMain.handle('ai:confirmCommand', (_e, execId, approved) => confirmCommand(execId, approved))
  ipcMain.handle('ai:getLogs', (_e, limit) => getAiLogs(limit))
  ipcMain.handle('ai:getChatHistory', () => getChatHistory())
  ipcMain.handle('ai:saveMessage', (_e, role, content, deviceId, sessionId) => aiSaveChatMessage(role, content, deviceId, sessionId))
  ipcMain.handle('ai:clearHistory', () => clearChatHistory())
  ipcMain.handle('ai:createSession', (_e, title, deviceId) => createSession(title, deviceId))
  ipcMain.handle('ai:listSessions', () => listSessions())
  ipcMain.handle('ai:getSessionMessages', (_e, sessionId) => getSessionMessages(sessionId))
  ipcMain.handle('ai:deleteSession', (_e, sessionId) => deleteSession(sessionId))
  ipcMain.handle('ai:updateSessionTitle', (_e, sessionId, title) => updateSessionTitle(sessionId, title))
  ipcMain.handle('ai:discoverTopology', (_e, deviceIds) => discoverTopology(deviceIds))
  ipcMain.handle('ai:getSystemLogs', (_e, limit) => getSystemLogs(limit))

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

app.on('before-quit', () => closeDatabase())
