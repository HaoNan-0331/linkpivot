import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import path from 'path'
import { initDatabase, closeDatabase, migrateAndSecure, getDatabase } from './database/connection'
import { createTables } from './database/init'
import { getOrCreateMasterKey } from './utils/keyManager'
import { setDecryptFailureHandler } from './utils/crypto'
import { hardenWindow, openExternalSafe } from './utils/webSecurity'
import { secure, safe, setAuthenticated } from './utils/authGuard'
import { generateCaptcha, login, isFirstRun, initAdmin } from './services/auth'
import { setDeviceMasterKey, listDevices, createDevice, updateDevice, deleteDevice, getDeviceById, maskDeviceSecrets, checkDeviceName, createBatchDevices, listDuplicateGroups, backfillNameHash } from './services/device'
import { setTopologyMasterKey, listTopologies, getTopologyById, createTopology, updateTopology, deleteTopology, exportTopology, importTopology } from './services/topology'
import { setConnectionMasterKey, openTerminal, openWebSafe, writeToSession, writeByWebContentsId, disconnectSession, testDeviceConnection } from './services/connection'
import { setAiMasterKey, chat, getAiConfigMasked, saveAiConfig, getCommandWhitelist, saveCommandWhitelist, getExecMode, setExecMode, getMcpMaxRounds, setMcpMaxRounds, confirmCommand, getAiLogs, getChatHistory, saveChatMessage as aiSaveChatMessage, createSession, listSessions, getSessionMessages, deleteSession, updateSessionTitle } from './services/ai'
import { discoverTopology } from './services/discovery'
import { getSystemLogs, createSystemLog, setSystemLogMasterKey, backfillSystemLogEnc } from './services/systemLog'
import { backfillAiExecLogEnc } from './services/aiExecLogger'
import { setArpMasterKey } from './services/arpCollector'
import { SchedulerService } from './services/schedulerService'
import { BackupScheduler } from './services/backupScheduler'
import { OUIService } from './services/ouiService'
import { registerArpIpc } from './ipc/arpIpc'
import { registerNetworkIpc } from './ipc/networkIpc'
import { registerAnomalyIpc } from './ipc/anomalyIpc'
import { registerOuiIpc } from './ipc/ouiIpc'
import { PromptService } from './services/promptService'
import { registerPromptIpc } from './ipc/promptIpc'
import { registerExportIpc } from './ipc/exportIpc'
import { registerSchedulerIpc } from './ipc/schedulerIpc'
import { setKbMasterKey } from './services/knowledgeBaseService'
import { registerKbIpc } from './ipc/knowledgeBaseIpc'
import { setExperienceMasterKey, backfillSeverityFromHistory } from './services/experienceService'
import { registerExperienceIpc } from './ipc/experienceIpc'
import { registerExperienceDraftingIpc } from './ipc/experienceDraftingIpc'
import { McpService } from './services/mcpService'
import { McpProcessRegistry } from './services/mcpProcessRegistry'
import { registerMcpIpc } from './ipc/mcpIpc'

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

  if (!app.isPackaged) {
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
    if (!app.isPackaged) {
      callback({})
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        ],
      },
    })
  })
  // 全局兜底：所有新建 webContents 的弹窗（target=_blank / window.open）交给系统浏览器
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      try { openExternalSafe(url) } catch (e) {
        console.warn('[global] blocked openExternal:', (e as Error).message)
      }
      return { action: 'deny' }
    })
  })

  masterKey = getOrCreateMasterKey()
  setDeviceMasterKey(masterKey)
  setTopologyMasterKey(masterKey)
  setConnectionMasterKey(masterKey)
  setAiMasterKey(masterKey)
  setArpMasterKey(masterKey)
  setKbMasterKey(masterKey)
  setExperienceMasterKey(masterKey)
  // 第 8 直接注入器（SEC-06）：systemLog 持模块级 MK 加密 prompt_text_enc/ai_response_enc；
  // aiExecLogger 已由 setAiMasterKey 内部链式注入（ai.ts），不重复。service 不直读 keyManager 红线。
  setSystemLogMasterKey(masterKey)
  // 第 9 直接注入器（Phase 21）：mcpService 持 private static MK 加密 env_json_enc/credential_enc。
  McpService.setMcpMasterKey(masterKey)
  // R2: decField 解密失败可观测——masterKey 不匹配 / safeStorage 翻转时写 system_log 告警，避免无声数据丢失。
  // handler 在此注入（解耦：crypto.ts 不依赖 services/DB，保持纯函数可单测）。
  setDecryptFailureHandler(() => {
    try {
      createSystemLog({ type: 'security', status: 'warning', errorMessage: '字段解密失败（可能 masterKey 不匹配或数据损坏，请检查 master.key / 系统账户是否变更）' })
    } catch { /* 日志写库失败非致命 */ }
  })
  const __startupT0 = performance.now()   // PERF-04 (W1)：冷启动 DB+OUI init 计时起点
  initDatabase()
  createTables()
  migrateAndSecure()   // 迁移前备份(gated on 非空库) + runMigrations + ACL 收紧 db/wal/shm（D-06/D-12a）
  // Phase 10 Plan 04 CR-02：post-MK 历史 severity 回填（治本 D-10-2 筛层兑现）。
  // 迁移在 MK 注入前跑，v10 内无法解密 attrs_enc 回填 severity 明文列——此钩子在 MK 注入 + 迁移后跑，
  // 解密 attrs_enc.severity 回填，使历史数据 severity 筛选/排序对称可用。幂等（severity IS NULL 守卫），
  // 失败仅 warn 不阻塞启动（severity 筛选对历史数据降级，不致命，与 FTS5 自愈同范式）。
  try {
    const r = backfillSeverityFromHistory()
    if (r.backfilled > 0) console.log('[startup] backfill severity from history:', r.backfilled)
  } catch (e) {
    console.warn('[startup] backfill severity failed (non-blocking):', (e as Error).message)
  }
  // Phase 25（25-03，ASSET-04/v23）：post-MK name_hash 回填——迁移在 MK 注入前跑（v23 仅版本锚点），
  // 此钩子在 MK 注入 + 迁移后解密 name_enc 回填存量行，并统计重名组（供 D-09 重名处理页）。
  // 幂等（WHERE name_hash IS NULL 守卫），失败仅 warn 不阻塞启动（T-25-11，与 severity 回填同范式）。
  try {
    const r = backfillNameHash()
    if (r.backfilled > 0) console.log('[startup] backfill name_hash:', r.backfilled)
    if (r.duplicateGroups > 0) console.log('[startup] 存量设备重名组:', r.duplicateGroups)
  } catch (e) {
    console.warn('[startup] backfill name_hash failed (non-blocking):', (e as Error).message)
  }
  // Phase 17 SEC-06（D-01）：日志加密列启动即同步回填——明文存量行加密落 _enc + 旧列置 NULL（净化备份）。
  // 双钩子独立 try/catch 隔离故障（一个失败不挡另一个）；幂等可重试（中断后下次启动续跑），失败仅 warn 不阻塞启动。
  let logEncBackfilled = 0
  try {
    const r = backfillAiExecLogEnc()
    if (r.backfilled > 0) console.log('[startup] backfill log enc (ai_exec_logs):', r.backfilled)
    logEncBackfilled += r.backfilled
  } catch (e) {
    const msg = (e as Error).message
    console.warn('[startup] backfill ai_exec_logs enc failed (non-blocking):', msg)
    try {
      createSystemLog({ type: 'security', status: 'warning', errorMessage: '日志加密列回填失败（下次启动重试）：' + msg })
    } catch { /* 日志失败非致命 */ }
  }
  try {
    const r = backfillSystemLogEnc()
    if (r.backfilled > 0) console.log('[startup] backfill log enc (ai_system_logs):', r.backfilled)
    logEncBackfilled += r.backfilled
  } catch (e) {
    const msg = (e as Error).message
    console.warn('[startup] backfill ai_system_logs enc failed (non-blocking):', msg)
    try {
      createSystemLog({ type: 'security', status: 'warning', errorMessage: '日志加密列回填失败（下次启动重试）：' + msg })
    } catch { /* 日志失败非致命 */ }
  }
  // 置 NULL ≠ 字节净化：明文字节仍留库文件 freelist 页，db.backup() 整页拷贝会带出（17-RESEARCH Pitfall 7 实证）——
  // SC#4「备份净化」必须 VACUUM 才成立。非致命包裹（百度云锁 DB 文件 EBUSY 前科），不重试不阻塞启动。
  if (logEncBackfilled > 0) {
    try {
      getDatabase().exec('VACUUM')
      console.log('[startup] VACUUM after log enc backfill: OK')
    } catch (e) {
      console.warn('[startup] VACUUM after log enc backfill failed (non-blocking):', (e as Error).message)
      try {
        createSystemLog({ type: 'security', status: 'warning', errorMessage: '日志回填后 VACUUM 失败（明文残留可能在库文件延续）：' + (e as Error).message })
      } catch { /* 日志失败非致命 */ }
    }
  }
  // kb-db-malformed：启动 FTS5 自愈——把"被动 malformed"转成"主动自愈"。
  // taskkill/Stop-Process -Force = SIGKILL 不触发 before-quit → closeDatabase，WAL 未 checkpoint 可致
  // FTS5 shadow（docsize/data/idx）半途中断写入不一致 → 用户态报 database disk image is malformed。
  // 启动早期表已就绪：先 integrity-check（OK 即过），失败即 rebuild（从 kb_chunks 重建 shadow，保留主库数据）。
  // try/catch + 日志兜底，不阻塞 init 主流程（与 discovery safeLog / 启动日志惯例一致）。
  try {
    getDatabase().prepare("INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('integrity-check')").run()
    console.log('[startup] kb_chunks_fts integrity-check: OK')
  } catch (e1) {
    console.warn('[startup] kb_chunks_fts integrity-check failed, attempting rebuild:', (e1 instanceof Error ? e1.message : String(e1)))
    try {
      getDatabase().prepare("INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('rebuild')").run()
      console.log('[startup] kb_chunks_fts rebuild: OK (FTS shadow 重建完成)')
    } catch (e2) {
      // rebuild 仍失败不阻塞启动（主库未坏，搜索功能降级；用户可手动从 backups 恢复）
      console.warn('[startup] kb_chunks_fts rebuild failed (search may be degraded):', (e2 instanceof Error ? e2.message : String(e2)))
    }
  }
  // PERF-01 (D-P1)：启动预载 Map<macPrefix,vendor>，确保首次 getIPDetails 时 Map 就绪（消除 N+1）
  OUIService.preload()
  // Phase 20：prompt override 缓存预热（对齐 OUIService.preload 调用点；失败回退逐条查库）
  PromptService.preload()
  console.log('[startup] DB+OUI init', (performance.now() - __startupT0).toFixed(0), 'ms')   // PERF-04：冷启动耗时，供 before/after 证据 grep 验证

  // IP Management IPC
  registerArpIpc()
  registerNetworkIpc()
  registerAnomalyIpc()
  registerOuiIpc()
  registerPromptIpc()
  registerExportIpc()
  registerSchedulerIpc()
  registerKbIpc()
  registerExperienceIpc()
  registerExperienceDraftingIpc()
  registerMcpIpc()
  SchedulerService.start()
  BackupScheduler.start()

  // Auth IPC（登录前可用，不做鉴权；login 成功置登录态）
  ipcMain.handle('auth:getCaptcha', safe(() => { const r = generateCaptcha(); return { svg: r.svg, key: r.key } }))
  ipcMain.handle('auth:login', safe(async (_e, u, p, ck, ci) => {
    const r = await login(u, p, ck, ci)
    if (r.success) setAuthenticated(true)
    return r
  }))
  ipcMain.handle('auth:isFirstRun', safe(() => isFirstRun()))
  // H-2：双层门控（audit 整改建议）——handler 层先判首启，服务层 initAdmin 内再判一次。
  ipcMain.handle('auth:initAdmin', safe((_e, u, p) => {
    if (!isFirstRun()) return { success: false, error: '管理员已初始化' }
    return initAdmin(u, p)
  }))

  // Device IPC（secure = 登录鉴权 + 异常脱敏）
  // H-1：IPC 返回值经 maskDeviceSecrets 脱敏投影——renderer 只收 ****尾4位，永不收明文凭证
  ipcMain.handle('device:list', secure(() => listDevices().map(maskDeviceSecrets)))
  ipcMain.handle('device:create', secure((_e, data) => createDevice(data)))
  ipcMain.handle('device:update', secure((_e, id, data) => updateDevice(id, data)))
  ipcMain.handle('device:delete', secure((_e, id) => deleteDevice(id)))
  ipcMain.handle('device:getById', secure((_e, id) => {
    const d = getDeviceById(id)
    return d ? maskDeviceSecrets(d) : null
  }))
  // Phase 25（25-03，ASSET-02/ASSET-04）：设备名查重 / 批量创建 / 存量重名分组三通道（secure 红线，T-25-09）。
  ipcMain.handle('device:checkName', secure((_e, name: string, excludeId?: string) => checkDeviceName(name, excludeId)))
  ipcMain.handle('device:createBatch', secure((_e, items: unknown[]) => {
    // D-07 网关校验（照 ouiIpc MAX_BATCH 模式，T-25-08）：数组形状 + 上限 50，超限拒绝进 service。
    const MAX_BATCH_DEVICES = 50
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH_DEVICES) {
      throw new Error(`批量创建失败：需提供 1-${MAX_BATCH_DEVICES} 台设备`)
    }
    createBatchDevices(items)
  }))
  ipcMain.handle('device:listDuplicates', secure(() => listDuplicateGroups()))

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
  ipcMain.handle('ai:chat', secure((e, messages, deviceIds, sessionId) =>
    // Phase 22（22-03，D-03）：每次 MCP 工具调用完成后经 ai:toolResult 推送结构化载荷
    // （22-05 ToolResultCard 唯一数据来源）。renderer 失活时 send 抛错不阻塞对话流。
    chat(messages, deviceIds, sessionId, (p) => {
      try { e.sender.send('ai:toolResult', p) } catch { /* window closed */ }
    })
  ))
  ipcMain.handle('ai:getConfig', secure(() => getAiConfigMasked()))
  ipcMain.handle('ai:saveConfig', secure((_e, config) => saveAiConfig(config)))
  ipcMain.handle('ai:getCommandWhitelist', secure(() => getCommandWhitelist()))
  ipcMain.handle('ai:saveCommandWhitelist', secure((_e, list) => saveCommandWhitelist(list)))
  ipcMain.handle('ai:getExecMode', secure(() => getExecMode()))
  ipcMain.handle('ai:setExecMode', secure((_e, mode, password) => setExecMode(mode, password)))
  // 22-05 checkpoint：MCP 连续调用轮次上限系统设置可调（读侧 fail-safe，写侧 1-20 校验）
  ipcMain.handle('ai:getMcpMaxRounds', secure(() => getMcpMaxRounds()))
  ipcMain.handle('ai:setMcpMaxRounds', secure((_e, rounds) => setMcpMaxRounds(rounds)))
  ipcMain.handle('ai:confirmCommand', secure((_e, execId, approved) => confirmCommand(execId, approved)))
  ipcMain.handle('ai:getLogs', secure((_e, limit) => getAiLogs(limit)))
  ipcMain.handle('ai:getChatHistory', secure(() => getChatHistory()))
  ipcMain.handle('ai:saveMessage', secure((_e, role, content, deviceId, sessionId) => aiSaveChatMessage(role, content, deviceId, sessionId)))
  ipcMain.handle('ai:createSession', secure((_e, title, deviceId) => createSession(title, deviceId)))
  ipcMain.handle('ai:listSessions', secure(() => listSessions()))
  ipcMain.handle('ai:getSessionMessages', secure((_e, sessionId) => getSessionMessages(sessionId)))
  ipcMain.handle('ai:deleteSession', secure((_e, sessionId) => deleteSession(sessionId)))
  ipcMain.handle('ai:updateSessionTitle', secure((_e, sessionId, title) => updateSessionTitle(sessionId, title)))
  ipcMain.handle('ai:discoverTopology', secure((_e, deviceIds) => discoverTopology(deviceIds)))
  ipcMain.handle('ai:getSystemLogs', secure((_e, limit) => getSystemLogs(limit)))

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch((err: unknown) => {
  const msg = (err && (err as Error).message) ? (err as Error).message : String(err)
  console.error('[startup] fatal:', err)
  try { dialog.showErrorBox('启动失败', msg) } catch (_e) { /* dialog 不可用时降级 */ }
  app.quit()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

app.on('before-quit', () => {
  BackupScheduler.stop()
  // 21-03：MCP stdio 子进程树杀（3s 预算，closeDatabase 之前，同步快路径不新增 async 阻塞）
  try { McpProcessRegistry.cleanupAll() }
  catch (e) { console.error('[before-quit] mcp cleanupAll failed:', (e && (e as Error).message) || e) }
  try { closeDatabase() }
  catch (e) { console.error('[before-quit] closeDatabase failed:', (e && (e as Error).message) || e) }
})
