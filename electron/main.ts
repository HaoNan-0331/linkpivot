import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import path from 'path'
import { initDatabase, closeDatabase, migrateAndSecure, getDatabase } from './database/connection'
import { createTables } from './database/init'
import { getOrCreateMasterKey } from './utils/keyManager'
import { migrateLegacyUserData, TARGET_DIR_NAME, type MigrationResult } from './utils/dataDirMigration'
import { setDecryptFailureHandler } from './utils/crypto'
import { hardenWindow, openExternalSafe } from './utils/webSecurity'
import { secure, safe, setAuthenticated } from './utils/authGuard'
import { generateCaptcha, login, isFirstRun, initAdmin } from './services/auth'
import { setDeviceMasterKey, listDevices, createDevice, updateDevice, deleteDevice, getDeviceById, maskDeviceSecrets, checkDeviceName, listDuplicateGroups, backfillNameHash, ensureNameUniqueIndex } from './services/device'
import { setTopologyMasterKey, listTopologies, getTopologyById, createTopology, updateTopology, deleteTopology, exportTopology, importTopology } from './services/topology'
import { setConnectionMasterKey, openTerminal, openWebSafe, writeToSession, writeByWebContentsId, disconnectSession, testDeviceConnection } from './services/connection'
import { setAiMasterKey, chat, getAiConfigMasked, saveAiConfig, getCommandWhitelist, saveCommandWhitelist, getExecMode, setExecMode, confirmCommand, getAgentMaxRounds, setAgentMaxRounds, getAgentBurnoutCount, setAgentBurnoutCount, getAgentCooldownSecs, setAgentCooldownSecs, getAiLogs, getChatHistory, saveChatMessage as aiSaveChatMessage, createSession, listSessions, getSessionMessages, deleteSession, updateSessionTitle, reconcileGuardLogs, ChatInterruptedError, registerChatCancel, finishChatCancel, cancelChatForWebContents } from './services/ai'
import { discoverTopology } from './services/discovery'
import { getSystemLogs, createSystemLog, setSystemLogMasterKey, backfillSystemLogEnc } from './services/systemLog'
import { backfillAiExecLogEnc } from './services/aiExecLogger'
import { setArpMasterKey } from './services/arpCollector'
import { SchedulerService } from './services/schedulerService'
import { BackupScheduler, BACKUP_QUIT_WAIT_TIMEOUT_MS } from './services/backupScheduler'
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
import { McpDeviceEnvMigration } from './services/mcpDeviceEnvMigration'
import { DeviceCredentialMigration } from './services/deviceCredentialMigration'
import { setIntegrityHandler } from './services/mcpClient'
import { McpPackageService } from './services/mcpPackageService'
import { McpProcessRegistry } from './services/mcpProcessRegistry'
import { registerMcpIpc } from './ipc/mcpIpc'
import { registerMcpPackageIpc } from './ipc/mcpPackageIpc'
import { registerUpdateIpc } from './ipc/updateIpc'
import { UpdateService } from './services/updateService'

// WR-03（30-06，单实例锁）：根治迁移 check-then-rename 的 TOCTOU 竞态——双开（双击两次/
// 安装器「完成后运行」+手动启动）时第二实例不再触碰 userData 目录。锁必须先于下方迁移逻辑；
// 未拿到锁的实例：app.quit() + 跳过一切模块级启动副作用（迁移 ternary 门控 + whenReady 回调
// early-return），仅 before-quit 兜底链照常可达（BackupScheduler.stop/closeDatabase 均幂等安全）。
// 拿到锁的实例注册 second-instance：再次启动尝试聚焦已有窗口。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// 30.1-02（改名数据连续性红线）：productName 改「灵枢」后 Electron 默认 userData 会漂移到
// %APPDATA%\灵枢——0.4.0 老用户 DB/masterKey/kb_files/backups 全部「消失」。
// 在一切 userData 消费（keyManager/connection/backupScheduler/kb 均为惰性求值）之前：
//   1) 一次性原子迁移 %APPDATA%\网络拓扑管理工具 → LinkPivot（永不覆盖既有目录；rename 失败
//      （旧应用占用等）回退继续用旧目录，数据可用性优先，应用启动永不因迁移炸死）；
//   2) app.setPath 显式钉定 userData=LinkPivot，与 productName 解耦（未来显示名再改不再迁移数据）。
// WR-03：第二实例（未拿到锁、退出中）不执行迁移（竞态源）；setPath 仅设值无文件系统副作用。
const dataDirMigration: MigrationResult = gotTheLock
  ? migrateLegacyUserData(app.getPath('appData'))
  : { status: 'none' }
app.setPath('userData', gotTheLock && dataDirMigration.status === 'fallback' && dataDirMigration.from
  ? dataDirMigration.from
  : path.join(app.getPath('appData'), TARGET_DIR_NAME))

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

app.whenReady().then(async () => {
  // WR-03（30-06）：未拿到单实例锁的第二实例（quit 退出中）——ready 前后仍可能触发本回调，
  // early-return 跳过全部启动副作用（masterKey/DB 初始化/IPC 注册/窗口创建）。
  if (!gotTheLock) return
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
  // aiExecLogger/aiSession/aiExec/aiMcp 已由 setAiMasterKey（aiConfig.ts）内部链式注入，不重复。service 不直读 keyManager 红线。
  setSystemLogMasterKey(masterKey)
  // 第 9 直接注入器（Phase 21）：mcpService 持 private static MK 加密 env_json_enc/credential_enc。
  McpService.setMcpMasterKey(masterKey)
  // 第 10 直接注入器（Phase 29）：设备级 env 回填 service 持 private static MK（29-02）。
  McpDeviceEnvMigration.setMcpDeviceEnvMasterKey(masterKey)
  // 第 11 直接注入器（Phase 29）：包生命周期 service 持 private static MK
  // （confirmOverwrite 的 rel 行 env_json_enc 键剔除，29-03）。
  McpPackageService.setMcpPackageMasterKey(masterKey)
  // 第 12 直接注入器（Phase 36）：多通道凭证回填 service 持 private static MK
  // （36-01，LOGIN-03——devices 行内凭证迁 device_credentials 子表，回填须 post-MK）。
  DeviceCredentialMigration.setDeviceCredentialMasterKey(masterKey)
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
  // 30.1-02 审计留痕（T-30.1-09）：迁移结果写 system_log（type='migration'，v6 起 CHECK 白名单合法）。
  // 仅 status!=='none' 时记录；写库失败非致命（极老库 CHECK 拒绝等不炸启动，T-30.1-07 同语义）。
  if (dataDirMigration.status !== 'none') {
    try {
      createSystemLog({
        type: 'migration',
        status: 'success',
        errorMessage: `用户数据目录迁移：${dataDirMigration.from ?? 'legacy 目录'} → ${app.getPath('userData')}（${dataDirMigration.status}）`,
      })
    } catch { /* 审计写库失败非致命 */ }
  }
  await migrateAndSecure()   // 迁移前备份(gated on 非空库) + runMigrations + ACL 收紧 db/wal/shm（D-06/D-12a）；BUG-3 修复：premigration 备份完整 await 后才跑 runMigrations

  // 0.5.0 线上回归修复（debug mcp-pkg-legacy-path）：mcp_packages.dir_path 启动自愈——
  // 30.1 userData 目录整体迁移后，DB 内持久化的旧绝对路径漂移（spawn ENOENT + 删除沙箱拒绝
  // 死锁 + ENOENT 假阳性误禁用）。规范位置（userData/mcp-packages/{name}）指纹复验通过才
  // 重写并清误禁用；幂等、失败非致命（fail-closed 保留原路径由既有拒绝链兜底，T-30.1-07 同语义）。
  try {
    const mcpHeal = McpPackageService.healPackagePaths()
    if (mcpHeal.healed > 0) {
      console.log('[startup] mcp package dir_path healed:', mcpHeal.healed)
      try {
        createSystemLog({
          type: 'migration',
          status: 'success',
          errorMessage: `MCP 包路径自愈：${mcpHeal.healed} 个包的 dir_path 由旧 userData 绝对路径重写至 ${app.getPath('userData')}\\mcp-packages 并清除迁移期误禁用（TOCTOU 全树指纹复验通过）`,
        })
      } catch { /* 审计写库失败非致命（与上方迁移审计同语义） */ }
    }
  } catch (e) {
    console.warn('[startup] mcp package dir_path heal failed (non-blocking):', (e as Error).message)
  }
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
  // Phase 25（25-05）：回填后立即按新清零判定（NULL=0 且无重名组）补评估唯一索引——
  // 回填路径已自愈 DROP 无效索引；此处对回填后真正清零的库当场重建，对仍有重名的库
  // 保持跳过（等重命名清零路径补建）。失败仅 warn 不阻塞启动。
  try {
    if (ensureNameUniqueIndex()) console.log('[startup] devices.name_hash 唯一索引已启用')
  } catch (e) {
    console.warn('[startup] ensureNameUniqueIndex failed (non-blocking):', (e as Error).message)
  }
  // Phase 29（29-02，D-17）：post-MK 存量共享 env 复制到每台绑定设备行（设备级 env 模型）。
  // v27 迁移只加列；加密回填必须在 MK 注入后（25-05 教训）。幂等（env_json_enc IS NULL 守卫；
  // CR-01：NULL 单义=未回填——用户清空写 '{}' 密文，不再被回填复活），
  // 坏密文/空 env 行跳过保持 NULL（T-29-02-02），失败仅 warn 不阻塞启动（name_hash 回填同范式）。
  try {
    const r = McpDeviceEnvMigration.backfillDeviceEnv()
    if (r.backfilled > 0) console.log('[startup] backfill mcp device env:', r.backfilled)
    if (r.skipped > 0) console.warn('[startup] mcp device env 回填跳过（空/坏密文）:', r.skipped)
  } catch (e) {
    console.warn('[startup] backfillDeviceEnv failed (non-blocking):', (e as Error).message)
  }
  // Phase 36（36-01，LOGIN-03/D-08）：post-MK 设备凭证子表回填 + 行内六列物理清理。
  // v32 迁移只建表；加密回填必须在 MK 注入后（25-05 教训）。幂等（password_enc 根守卫 +
  // INSERT OR IGNORE），坏密文/跨通道残留行跳过不清列（保数据，坏密文待重试/残留待人工
  // 处置——CR-01 残留不猜通道语义跨迁），失败仅 warn 不阻塞启动。
  try {
    const r = DeviceCredentialMigration.backfillDeviceCredentials()
    if (r.backfilled > 0) console.log('[startup] backfill device credentials:', r.backfilled)
    if (r.skipped > 0) console.warn('[startup] device credentials 回填跳过（坏密文/不可映射/跨通道残留，保留旧列）:', r.skipped)
    if (r.residueSkipped > 0) {
      console.warn('[startup] 检出跨通道残留历史凭证', r.residueSkipped, '行（曾切换连接方式的旧通道密文）——devices 行内凭证列保留不清理（D-08 门控关闭，数据零丢失优先），请人工确认处置后下次启动收敛')
    }
    if (r.droppedColumns) console.log('[startup] devices 行内凭证六列已物理清理（D-08）')
  } catch (e) {
    console.warn('[startup] backfillDeviceCredentials failed (non-blocking):', (e as Error).message)
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
  // Phase 27 checkpoint（用户语义定案）：启动时越权未决残留全量订正为取消——
  // 关应用/崩溃导致的弹窗未决（批次内存必然空），未点「确认执行」= 取消（fail-closed）。
  try {
    const n = reconcileGuardLogs()
    if (n > 0) console.log('[startup] guard 未决残留订正为取消:', n)
  } catch (e) {
    console.warn('[startup] reconcile guard logs failed (non-blocking):', (e as Error).message)
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
  registerMcpPackageIpc()
  // Phase 30（30-03）：update:* 八通道（全 secure 登录后域，UPD-01/02 执行面）
  registerUpdateIpc()
  // Phase 29（29-04，D-26）：TOCTOU 检出副作用链路——spawn 前指纹重验失败时 mcpClient 经
  // 注入回调触发：包 disabled=1（直到重新导入走完整校验链）+ ai_system_logs security 行。
  // mcpClient 零 DB 依赖，service 侧落库在此接线；两步各自 try/catch 隔离（禁用失败仍尝试留痕）。
  setIntegrityHandler(({ packageId, dirPath, detail }) => {
    try {
      getDatabase().prepare(
        "UPDATE mcp_packages SET disabled = 1, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(packageId)
    } catch (e) {
      console.error('[startup] TOCTOU disable package failed:', (e as Error).message)
    }
    try {
      createSystemLog({
        type: 'security',
        status: 'warning',
        errorMessage: `MCP 包 TOCTOU 指纹重验失败，已禁用包 #${packageId}（${dirPath}）：${detail}——请重新导入校验后再使用`
      })
    } catch { /* 日志失败非致命 */ }
  })
  SchedulerService.start()
  BackupScheduler.start()
  // Phase 30（30-03，UPD-01）：启动静默检测——init 内部 dev 门控（!app.isPackaged 直接 return，
  // Pitfall 7）+ SC 红线默认值覆写；checkForUpdatesAuto fire-and-forget 不 await（内部自 catch
  // 静默，启动链不被网络阻塞，D-03）。
  UpdateService.init()
  UpdateService.checkForUpdatesAuto()

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
  ipcMain.handle('device:create', secure((_e, data) => maskDeviceSecrets(createDevice(data))))
  ipcMain.handle('device:update', secure((_e, id, data) => maskDeviceSecrets(updateDevice(id, data))))
  ipcMain.handle('device:delete', secure((_e, id) => deleteDevice(id)))
  ipcMain.handle('device:getById', secure((_e, id) => {
    const d = getDeviceById(id)
    return d ? maskDeviceSecrets(d) : null
  }))
  // Phase 25（25-03，ASSET-04；25-05 用户决策移除批量创建）：设备名查重 / 存量重名分组通道（secure 红线，T-25-09）。
  ipcMain.handle('device:checkName', secure((_e, name: string, excludeId?: string) => checkDeviceName(name, excludeId)))
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
  // Phase 36（36-03，LOGIN-02）：统一入口 connection:open(deviceId, channel)——web 也走 main
  //（webUrl 为子表凭证列，凭证不出 main 对称性，Q3 裁决）；三别名透传自身语义通道
  //（修正原三 handler 全调 openTerminal(deviceId) 忽略通道名的名存实亡，Pitfall 11）。
  ipcMain.handle('connection:open', secure((_e, deviceId: string, channel?: string) => openTerminal(deviceId, channel)))
  ipcMain.handle('connection:ssh', secure((_e, deviceId) => openTerminal(deviceId, 'ssh')))
  ipcMain.handle('connection:telnet', secure((_e, deviceId) => openTerminal(deviceId, 'telnet')))
  ipcMain.handle('connection:rdp', secure((_e, deviceId) => openTerminal(deviceId, 'rdp')))
  ipcMain.handle('connection:openWeb', secure((_e, url) => openWebSafe(url)))
  ipcMain.handle('connection:disconnect', secure((_e, sessionId) => disconnectSession(sessionId)))
  ipcMain.handle('connection:write', secure((_e, sessionId, data) => writeToSession(sessionId, data)))
  // Phase 36（36-05 checkpoint 用户裁决，Q1 变更）：connection:test 返回全通道并行探测聚合
  //（channels 固定序逐通道结果 + 聚合 success；零通道保持「该设备未配置登录通道」契约）
  ipcMain.handle('connection:test', secure((_e, deviceId) => testDeviceConnection(deviceId)))

  // Terminal window IPC：writeByWebContentsId 经 windowSessionMap 查 sessionId，
  // 只有终端窗口 webContents id 在 map 中，主窗口无法注入（sender 隔离）
  ipcMain.handle('terminal:write', secure((e, data) => writeByWebContentsId(e.sender.id, data)))

  // AI IPC
  ipcMain.handle('ai:chat', secure(async (e, messages, deviceIds, sessionId) =>
    // Phase 22（22-03，D-03）：每次 MCP 工具调用完成后经 ai:toolResult 推送结构化载荷
    // （22-05 ToolResultCard 唯一数据来源）。renderer 失活时 send 抛错不阻塞对话流。
    // Phase 28（28-04，AGENT-05/D-06）：注册 AbortController（ai:cancelChat 消费），
    // finally 清理防泄漏（T-28-04-05）；首答阶段中断（尚无轨迹）优雅回文不抛错。
    {
      const controller = registerChatCancel(e.sender.id)
      try {
        return await chat(messages, deviceIds, sessionId, (p) => {
          try { e.sender.send('ai:toolResult', p) } catch { /* window closed */ }
        }, controller.signal)
      } catch (err) {
        if (err instanceof ChatInterruptedError) {
          return '（用户已停止：本次 AI 对话已中断，未执行的部分不再继续。）'
        }
        // 28-06 缺陷②：AbortError 兜底——中止落在非 callAI 路径（如流式 body 消费后的
        // 异步回调）时原生 AbortError 逃逸，renderer 误报「发送失败」。signal 已 abort
        // 即用户停止意图，按中断优雅回文不向上 throw（与 ChatInterruptedError 同构）。
        if ((err as { name?: string })?.name === 'AbortError') {
          return '（用户已停止：本次 AI 对话已中断，未执行的部分不再继续。）'
        }
        throw err
      } finally {
        finishChatCancel(e.sender.id, controller)
      }
    }
  ))
  // Phase 28（28-04，AGENT-05）：用户停止通道——secure 鉴权（T-28-04-01）+ 按
  // sender.webContentsId 定位（只取消自己窗口的对话，他人窗口不可误取消）。
  ipcMain.handle('ai:cancelChat', secure((e) => cancelChatForWebContents(e.sender.id)))
  ipcMain.handle('ai:getConfig', secure(() => getAiConfigMasked()))
  ipcMain.handle('ai:saveConfig', secure((_e, config) => saveAiConfig(config)))
  ipcMain.handle('ai:getCommandWhitelist', secure(() => getCommandWhitelist()))
  ipcMain.handle('ai:saveCommandWhitelist', secure((_e, list) => saveCommandWhitelist(list)))
  ipcMain.handle('ai:getExecMode', secure(() => getExecMode()))
  ipcMain.handle('ai:setExecMode', secure((_e, mode, password) => setExecMode(mode, password)))
  // 28-06 缺陷④：ai:getMcpMaxRounds / ai:setMcpMaxRounds IPC 退役（MCP 调用并入
  // agent_max_rounds 步数硬顶，ai_config.mcp_max_rounds 列保留不读——向后兼容）
  // Phase 28（AGENT-04，D-04）：agent 循环硬顶三参数系统设置可调
  //（读侧 fail-safe 回退默认 12/2/60，写侧 1-30/1-5/10-600 校验拒绝落库）
  ipcMain.handle('ai:getAgentMaxRounds', secure(() => getAgentMaxRounds()))
  ipcMain.handle('ai:setAgentMaxRounds', secure((_e, rounds) => setAgentMaxRounds(rounds)))
  ipcMain.handle('ai:getAgentBurnoutCount', secure(() => getAgentBurnoutCount()))
  ipcMain.handle('ai:setAgentBurnoutCount', secure((_e, count) => setAgentBurnoutCount(count)))
  ipcMain.handle('ai:getAgentCooldownSecs', secure(() => getAgentCooldownSecs()))
  ipcMain.handle('ai:setAgentCooldownSecs', secure((_e, secs) => setAgentCooldownSecs(secs)))
  // 28-06 R2 缺陷③：confirm 续跑阶段注册 AbortController（与 ai:chat 同构）——chat 弹
  // 确认框返回时原控制器已 finally 注销，本 handler 续跑期间不注册则 ai:cancelChat 查
  // 注册表为空报「当前窗口没有进行中的 AI 对话」，用户无法停止确认后的续跑。
  ipcMain.handle('ai:confirmCommand', secure(async (e, execId, approved) => {
    const controller = registerChatCancel(e.sender.id)
    try {
      return await confirmCommand(execId, approved, controller.signal)
    } catch (err) {
      if (err instanceof ChatInterruptedError || (err as { name?: string })?.name === 'AbortError') {
        return '（用户已停止：本次 AI 对话已中断，未执行的部分不再继续。）'
      }
      throw err
    } finally {
      finishChatCancel(e.sender.id, controller)
    }
  }))
  // Phase 27 checkpoint：getLogs 前对账孤儿批次（TTL 过期/renderer 刷新丢失的弹窗批次），
  // 未点「确认执行」的越权记录订正取消——审计视图永不出现「未决」终态。
  ipcMain.handle('ai:getLogs', secure((_e, limit) => { reconcileGuardLogs(); return getAiLogs(limit) }))
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

// BUG-3 修复（Phase 30-01）：在途 better-sqlite3 backup 是 setImmediate 分页传输（首 transfer 在下一
// tick），同步 before-quit 链会在备份一次 transfer 都没跑完时 closeDatabase → backups 目录残留撕裂
// .bak 冒充有效备份。guard 形态：有在途备份时 preventDefault + 等待（≤BACKUP_QUIT_WAIT_TIMEOUT_MS，
// 超时放行保证退出永不卡死）后重放 app.quit()；30-03 quitAndInstall 触发的 app.quit() 走同一 guard
// 天然兼容。快路径（无在途）与重放路径（quitReplayGuard=true）均落穿到下方既有三步链——
// 禁止改写 early-return 双分支形态（会使 cleanupAll/closeDatabase 不可达）。
let quitReplayGuard = false
app.on('before-quit', (e: Electron.Event) => {
  // 单一入口判定（全函数唯一 return 在其内部）：仅「非重放且有在途备份」进等待分支
  if (!quitReplayGuard && BackupScheduler.hasInFlightBackup()) {
    e.preventDefault()
    quitReplayGuard = true
    BackupScheduler.stop() // 防等待期间 interval 再起新备份（stop 幂等，与下方落穿首步重复调用无害——intervalId 空值守卫）
    BackupScheduler.waitIdle(BACKUP_QUIT_WAIT_TIMEOUT_MS).catch(() => {}).finally(() => app.quit())
    return
  }
  BackupScheduler.stop()
  // 21-03：MCP stdio 子进程树杀（3s 预算，closeDatabase 之前，同步快路径不新增 async 阻塞）
  try { McpProcessRegistry.cleanupAll() }
  catch (e) { console.error('[before-quit] mcp cleanupAll failed:', (e && (e as Error).message) || e) }
  try { closeDatabase() }
  catch (e) { console.error('[before-quit] closeDatabase failed:', (e && (e as Error).message) || e) }
})
