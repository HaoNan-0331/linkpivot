import { v4 as uuidv4 } from 'uuid'
import { Client } from 'ssh2'
import { decodeDeviceBuffer } from '../utils/textDecode'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { verifyPasswordSync } from '../utils/crypto'
import { SSH_READY_TIMEOUT_MS, buildSSHConnectConfig } from '../utils/sshConfig'
import { executeTelnetCommand, pickDisablePaginationCmd, pickShellPrompt } from '../utils/telnetExec'
import { isCommandAllowed } from './commandSafety'
import { createLog, updateLogStatus, appendLogAiResponse, getLogs, setAiExecLoggerMasterKey } from './aiExecLogger'
import { search as kbSearch } from './knowledgeBaseService'
import { retrieveForAnswer } from './experienceRetrieval'
import { PromptService } from './promptService'

let MK = ''
export function setAiMasterKey(key: string) {
  MK = key
  setAiExecLoggerMasterKey(key)
}

// ---------- Config ----------

export function getAiConfig(): Record<string, string> | null {
  const row = getDatabase()
    .prepare('SELECT * FROM ai_config LIMIT 1')
    .get() as any
  if (!row) return null
  const apiKey = decField(row.api_key_enc, MK)
  return {
    provider: decField(row.provider_enc, MK),
    apiKey,
    baseUrl: decField(row.base_url_enc, MK),
    modelName: decField(row.model_name_enc, MK),
    visionBaseUrl: decField(row.vision_base_url_enc, MK),
    visionApiKey: decField(row.vision_api_key_enc, MK),
    visionModel: decField(row.vision_model_enc, MK),
  }
}

/** Returns config with masked apiKey for renderer process */
export function getAiConfigMasked(): Record<string, string> | null {
  const config = getAiConfig()
  if (!config) return null
  return {
    provider: config.provider,
    apiKey: config.apiKey ? `****${config.apiKey.slice(-4)}` : '',
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    visionBaseUrl: config.visionBaseUrl,
    visionApiKey: config.visionApiKey ? `****${config.visionApiKey.slice(-4)}` : '',
    visionModel: config.visionModel,
  }
}

/**
 * H-3（v0.3.0 audit）：saveAiConfig 掩码守卫（纯函数）。
 *
 * 红线：设置页任意保存不会把 **** 掩码串落库覆盖真实 apiKey/visionApiKey。
 * 主进程侧兜住一切掩码回传（不限定键名、不依赖 renderer 行为，与 mock-api.ts DEV 守卫语义对齐）：
 * 值以 **** 开头的键直接剔除，merge 分支 `config.X ?? current.X` 自动保持现值；
 * INSERT 分支掩码串也不会落库。null/''/undefined 值不剔除（?? 语义交给 merge）。
 */
export function stripMaskedKeys(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.startsWith('****')) continue
    out[key] = value
  }
  return out
}

export function saveAiConfig(rawConfig: Record<string, string>): void {
  const config = stripMaskedKeys(rawConfig)
  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM ai_config LIMIT 1').get() as any

  if (existing) {
    // Merge: only overwrite fields that are explicitly provided
    const current = getAiConfig() || {}
    const merged = {
      provider: config.provider ?? current.provider ?? '',
      apiKey: config.apiKey ?? current.apiKey ?? '',
      baseUrl: config.baseUrl ?? current.baseUrl ?? '',
      modelName: config.modelName ?? current.modelName ?? '',
      visionBaseUrl: config.visionBaseUrl ?? current.visionBaseUrl ?? '',
      visionApiKey: config.visionApiKey ?? current.visionApiKey ?? '',
      visionModel: config.visionModel ?? current.visionModel ?? '',
    }
    db.prepare(
      `UPDATE ai_config SET provider_enc=?, api_key_enc=?, base_url_enc=?, model_name_enc=?, vision_base_url_enc=?, vision_api_key_enc=?, vision_model_enc=? WHERE id=?`
    ).run(
      encField(merged.provider, MK),
      encField(merged.apiKey, MK),
      encField(merged.baseUrl, MK),
      encField(merged.modelName, MK),
      encField(merged.visionBaseUrl, MK),
      encField(merged.visionApiKey, MK),
      encField(merged.visionModel, MK),
      existing.id
    )
  } else {
    const id = uuidv4()
    db.prepare(
      `INSERT INTO ai_config (id, provider_enc, api_key_enc, base_url_enc, model_name_enc, vision_base_url_enc, vision_api_key_enc, vision_model_enc) VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      id,
      encField(config.provider ?? '', MK),
      encField(config.apiKey ?? '', MK),
      encField(config.baseUrl ?? '', MK),
      encField(config.modelName ?? '', MK),
      encField(config.visionBaseUrl ?? '', MK),
      encField(config.visionApiKey ?? '', MK),
      encField(config.visionModel ?? '', MK)
    )
  }
}

// ---------- Exec mode ----------

export function getExecMode(): string {
  const row = getDatabase()
    .prepare('SELECT exec_mode FROM ai_config LIMIT 1')
    .get() as any
  return row?.exec_mode || 'confirm'
}

export function setExecMode(mode: string, password: string): { success: boolean; error?: string } {
  if (!['confirm', 'auto'].includes(mode)) {
    return { success: false, error: '无效的执行模式' }
  }
  const user = getDatabase()
    .prepare('SELECT password_hash FROM users LIMIT 1')
    .get() as any
  if (!user || !verifyPasswordSync(password, user.password_hash)) {
    return { success: false, error: '密码验证失败' }
  }
  getDatabase()
    .prepare('UPDATE ai_config SET exec_mode = ?')
    .run(mode)
  return { success: true }
}

// ---------- Command whitelist ----------

export function getCommandWhitelist(): string[] {
  const rows = getDatabase()
    .prepare('SELECT pattern FROM command_whitelist ORDER BY pattern')
    .all() as any[]
  return rows.map((r) => r.pattern)
}

export function saveCommandWhitelist(list: string[]): void {
  const db = getDatabase()
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM command_whitelist').run()
    const stmt = db.prepare('INSERT INTO command_whitelist (id, pattern) VALUES (?, ?)')
    for (const pattern of list) {
      stmt.run(uuidv4(), pattern)
    }
  })
  transaction()
}

// ---------- Chat sessions ----------

export function createSession(title: string, deviceId?: string): { id: string; title: string; deviceId: string | null; createdAt: string } {
  const id = uuidv4()
  getDatabase().prepare(
    'INSERT INTO chat_sessions (id, title, device_id) VALUES (?, ?, ?)'
  ).run(id, title, deviceId || null)
  return { id, title, deviceId: deviceId || null, createdAt: new Date().toISOString() }
}

export function listSessions(): Array<{ id: string; title: string; deviceId: string | null; createdAt: string }> {
  const rows = getDatabase()
    .prepare('SELECT * FROM chat_sessions ORDER BY created_at DESC')
    .all() as any[]
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    deviceId: row.device_id,
    createdAt: row.created_at,
  }))
}

export function getSessionMessages(sessionId: string): Array<{
  id: string; role: string; content: string; deviceId: string | null; createdAt: string
}> {
  const rows = getDatabase()
    .prepare('SELECT * FROM chat_history WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as any[]
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: decField(row.content_enc, MK),
    deviceId: row.device_id,
    createdAt: row.created_at,
  }))
}

export function deleteSession(sessionId: string): void {
  const db = getDatabase()
  // TXN-01（18-02）：两条 DELETE 包同一同步事务——chat_history 删成、chat_sessions 删除失败
  // 会留空会话壳（中途失败整体回滚，范式 deleteDocument）。
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM chat_history WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId)
  })
  tx()
}

export function updateSessionTitle(sessionId: string, title: string): void {
  getDatabase().prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, sessionId)
}

// ---------- Chat history ----------

export function getChatHistory(sessionId?: string, limit?: number): Array<{
  id: string
  role: string
  content: string
  deviceId: string | null
  createdAt: string
}> {
  // WR-09：limit 截断（取最近 N 条）防超大历史会话全量返回。默认不传 = 全量（向后兼容 ai 域自用）。
  // WR-02（18-REVIEW）：子查询 ORDER BY created_at DESC LIMIT ? 取最近 limit 条，外层 ASC 复原时间
  // 正序——旧实现子查询即 ASC（实取最旧 N 条），注释声明的「外层逆取」从未实现，>limit 条会话的
  // 溯源消费方（experienceService.getSessionMessages 默认 200）看到的是会话开头而非最近对话。
  if (limit != null && limit > 0) {
    const sql = sessionId
      ? `SELECT * FROM (
           SELECT * FROM chat_history WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
         ) sub ORDER BY created_at ASC`
      : `SELECT * FROM (
           SELECT * FROM chat_history ORDER BY created_at DESC LIMIT ?
         ) sub ORDER BY created_at ASC`
    const rows = sessionId
      ? (getDatabase().prepare(sql).all(sessionId, limit) as any[])
      : (getDatabase().prepare(sql).all(limit) as any[])
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: decField(row.content_enc, MK),
      deviceId: row.device_id,
      createdAt: row.created_at,
    }))
  }
  const rows = sessionId
    ? getDatabase().prepare('SELECT * FROM chat_history WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[]
    : getDatabase().prepare('SELECT * FROM chat_history ORDER BY created_at ASC').all() as any[]
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: decField(row.content_enc, MK),
    deviceId: row.device_id,
    createdAt: row.created_at,
  }))
}

export function saveChatMessage(
  role: string,
  content: string,
  deviceId: string | null,
  sessionId?: string | null
): void {
  // 空内容守卫：trim 后为空则抛清晰错误，不进 INSERT。
  // 防 chat() KB_SEARCH catch 把纯标签 reply 剥成空串 / LLM 超时返回空 content 时
  // encField('') 返回 null 撞 chat_history.content_enc NOT NULL，把「网络超时」伪装成「DB 约束错误」。
  const trimmed = (content ?? '').trim()
  if (!trimmed) {
    throw new Error('无法保存空消息内容（AI 可能未返回有效回复，请检查网络后重试）')
  }
  const id = uuidv4()
  getDatabase().prepare(
    'INSERT INTO chat_history (id, role, content_enc, device_id, session_id) VALUES (?, ?, ?, ?, ?)'
  ).run(id, role, encField(trimmed, MK), deviceId || null, sessionId || null)
}

// ---------- AI API call ----------

export async function callAI(
  config: Record<string, string>,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.modelName,
      messages,
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`AI API 错误 (${response.status}): ${text}`)
  }
  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

// ---------- SSH execution (shell mode) ----------

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
}

// （已移除交互式 shell 的 prompt 检测/输出提取函数）
// 命令执行改为 client.exec 非交互模式，不再需要 isPromptLine / detectPrompt / extractCommandOutput。
//
// WR-03：telnet 关分页命令 (pickDisablePaginationCmd) 与 shellPrompt (pickShellPrompt) 已抽到
// electron/utils/telnetExec.ts 共用——ai.ts telnet 分流 与 arpCollector collectFromDevice 同 util，
// 关分页/精确 prompt 统一来源（导入见顶部 import），避免两处实现漂移。

// SSH 配置构造已收敛 utils/sshConfig.ts buildSSHConnectConfig

export function executeCommandsOnDevice(
  device: any,
  commands: string[]
): Promise<Array<{ command: string; output: string; success: boolean }>> {
  if (commands.length === 0) return Promise.resolve([])

  // 执行层强制安全校验（最后一道防线）：不依赖调用方（chat/confirmCommand/auto）是否已校验，
  // 任何未经 isCommandAllowed 通过的命令在此直接拒绝，杜绝新增入口漏检。
  const whitelist = getCommandWhitelist()
  const checked = commands.map((cmd) => {
    const safety = isCommandAllowed(cmd, whitelist)
    return { cmd, allowed: safety.allowed, reason: safety.reason }
  })

  // connectionType 分流：ssh（含默认）走 buildSSHConfig + client.exec + execOne（密钥/密码、stream silence/retry/H3C 粘连全保留）；
  // telnet 走 executeTelnetCommand（共用 util，telnet-client connect loginPrompt/PasswordPrompt/shellPrompt + exec + gbk + ANSI + 超时兜底）。
  // 安全层 checked 数组两路径共用，无新增注入面。
  const isTelnet = String(device.connectionType || '').toLowerCase() === 'telnet'
  // telnet 长输出（display current-configuration 等）默认 ---- More ---- 分页，telnet-client exec 不自动翻页会截断第一屏。
  // exec 真命令前先发关闭分页命令（按 vendor 选），由 executeTelnetCommand 内部 connect 后发出。
  const paginationCmd = isTelnet ? pickDisablePaginationCmd(device.vendor) : undefined
  const shellPrompt = isTelnet ? pickShellPrompt(device.vendor) : undefined

  // SSH-only config（telnet 路径不用）
  const cfg = buildSSHConnectConfig(device)
  const overallTimeout = 30000 + checked.length * (SSH_READY_TIMEOUT_MS + 15000)

  // runOne：按 connectionType 分流单命令执行。
  // SSH 路径：单命令独立连接 —— new Client → connect → ready 后 execOne → end 回收。
  // Telnet 路径：每命令独立 Telnet 实例（executeTelnetCommand 内 connect+exec+cleanup），与 SSH「每命令独立连接」同构。
  // 返回该命令结果；连接失败/超时抛出由调用方决定（首条抛出 → reject 整批；后续抛出 → 填充 success:false 不中断）。
  const runOne = (idx: number): Promise<{ command: string; output: string; success: boolean }> => {
    return new Promise((resolve, reject) => {
      const { cmd, allowed, reason } = checked[idx]
      if (!allowed) {
        resolve({ command: cmd, output: `命令被安全策略拒绝: ${reason}`, success: false })
        return
      }

      // ---- Telnet 分流：复用共用 util，输出 gbk 解码 + ANSI 剥离（与 SSH 路径 execOne 内 decodeDeviceBuffer + stripAnsi 对齐） ----
      if (isTelnet) {
        const tport = device.port || 23
        // WR-02：telnet 单命令用「单命令预算」而非整批 overallTimeout。
        // overallTimeout 是整批累计（30s + N*(ready+15)），telnet util 内部 connect+exec 共用单一 timeout
        // 无 per-command 早触发，N=5 时 overallTimeout≈180s，单命令挂起会卡死整批。
        // 改传与 SSH 单命令对齐的预算（30s ready + 15s exec silence/兜底），慢设备超时早触发。
        const perCmdTimeout = 30000 + SSH_READY_TIMEOUT_MS + 15000
        executeTelnetCommand(
          device.ipAddress, tport,
          device.username || '', device.password || '',
          cmd,
          { timeout: perCmdTimeout, decodeGbk: true, stripAnsi: true, disablePaginationCmd: paginationCmd, shellPrompt }
        ).then((output) => {
          resolve({ command: cmd, output: output.trim(), success: true })
        }).catch((err: any) => {
          // telnet 连接/执行失败：抛出由外层决定（首条 reject 整批，后续填 success:false）—— 与 SSH 路径 client.on('error') 同语义
          reject(err instanceof Error ? err : new Error(String(err)))
        })
        return
      }

      // ---- SSH 路径（默认） ----
      const client = new Client()
      let settled = false
      let perCmdTimer: NodeJS.Timeout | undefined

      const cleanup = (): void => {
        if (perCmdTimer) { clearTimeout(perCmdTimer); perCmdTimer = undefined }
        // client.end() 优雅发 EOF；已 end/destroy 后再 end 可能抛，幂等忽略（与 Phase 6 cleanup 同构）
        try { client.end() } catch { /* ignore */ }
      }
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }

      // 单命令兜底超时 = readyTimeout + exec silence/timeout 余量
      perCmdTimer = setTimeout(() => {
        finish(() => {
          try { client.destroy() } catch { /* ignore */ }
          reject(new Error(`命令执行超时 (${cmd}, ${Math.round(overallTimeout / 1000)}s)`))
        })
      }, overallTimeout)

      try {
        client.on('ready', async () => {
          try {
            const output = await execOne(client, cmd)
            finish(() => resolve({ command: cmd, output, success: true }))
          } catch (err: any) {
            // execOne 失败（stream timeout/error 等）：按索引填 success:false，不 reject 整批（保结果同长）
            finish(() => resolve({ command: cmd, output: `执行失败: ${err.message}`, success: false }))
          }
        })
        client.on('error', (err) => {
          // 连接失败抛出 —— 首条命令触发外层 reject（语义同旧 ready 不达 → 设备不可达 → discovery 跳过）
          finish(() => reject(err))
        })
        client.connect(cfg)
      } catch (err) {
        // 同步异常兜底（client.connect 同步抛等罕见场景）
        finish(() => reject(err))
      }
    })
  }

  return (async () => {
    const results: Array<{ command: string; output: string; success: boolean }> = new Array(checked.length)
    for (let i = 0; i < checked.length; i++) {
      try {
        results[i] = await runOne(i)
      } catch (err: any) {
        // 首条命令连接失败 → reject 整批（与旧实现 client.on('error') reject 同语义，调用方按连接失败处理）
        if (i === 0) throw err
        // 后续命令连接失败：填充 success:false（设备中途抖动），保持结果数组同长同序
        results[i] = { command: checked[i].cmd, output: `执行失败: ${err.message}`, success: false }
      }
    }
    return results
  })()
}

// 单命令非交互执行（client.exec）：不分配 PTY，设备不触发分页，
// 天然杜绝交互式 shell 的换行/分号注入与 prompt 误判。
function execOne(client: Client, command: string, perCmdTimeoutMs = 15000, silenceMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stream: any
    let timer: NodeJS.Timeout | undefined
    let silenceTimer: NodeJS.Timeout | undefined
    let settled = false
    let retried = false
    let buf = ''
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = undefined }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = undefined }
      fn()
    }
    // A: 静默检测——设备输出完不 close channel（H3C display version 行为）时，data 静默 silenceMs 后
    // 主动 resolve + close，快速释放 channel 避免后续命令撞 MaxSessions（比 perCmdTimeout 更早触发）。
    const triggerSilence = (): void => {
      if (silenceTimer) clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => {
        finish(() => {
          try { stream?.close() } catch { /* ignore */ }
          resolve(stripAnsi(buf).trim())
        })
      }, silenceMs)
    }
    // per-command 兜底：极端情况（持续有 data 但永不静默 + 不 close）的最终超时
    timer = setTimeout(() => {
      finish(() => {
        try { stream?.close() } catch { /* ignore */ }
        try { stream?.destroy() } catch { /* ignore */ }
        reject(new Error(`命令执行无响应 (${perCmdTimeoutMs}ms 未收到 stream close)`))
      })
    }, perCmdTimeoutMs)
    const doExec = (): void => {
      client.exec(command, (err, s) => {
        if (err) {
          // C: channel open failure 重试一次（前序 channel session 释放延迟致 open 被拒）
          if (/channel open failure|open failed/i.test(err.message) && !retried) {
            retried = true
            setTimeout(doExec, 500)
            return
          }
          finish(() => reject(err))
          return
        }
        stream = s
        s.on('data', (data: Buffer) => { buf += decodeDeviceBuffer(data); triggerSilence() })
        const stderr = (s as any).stderr
        if (stderr && typeof stderr.on === 'function') {
          stderr.on('data', () => { /* 忽略 stderr */ })
        }
        // CR-01: stream error 兜底——对端 RST / 网络中断 / ssh2 channel 失败时 stream emit 'error'
        s.on('error', (e: Error) => {
          finish(() => reject(e))
        })
        s.on('close', () => {
          finish(() => resolve(stripAnsi(buf).trim()))
        })
        triggerSilence() // 启动初始静默计时（无 data 也计时，避免空输出卡满 timeout）
      })
    }
    doExec()
  })
}

// ---------- Device query helper ----------

export function getDeviceByIdInternal(id: string): any {
  const row = getDatabase()
    .prepare('SELECT * FROM devices WHERE id = ?')
    .get(id) as any
  if (!row) return null
  return {
    id: row.id,
    name: decField(row.name_enc, MK),
    vendor: decField(row.vendor_enc, MK),
    model: decField(row.model_enc, MK),
    version: decField(row.version_enc, MK),
    ipAddress: decField(row.ip_enc, MK),
    // H-4：补 deviceType 投影（与 device.ts rowToDevice 同语义兜底）——修复 discovery.ts
    // `dev?.deviceType` 恒 undefined 导致节点图标/EditNodeModal 预填/nodes JSON 落库错型。
    deviceType: row.device_type || 'generic',
    connectionType: row.connection_type,
    port: decField(row.port_enc, MK) ? parseInt(decField(row.port_enc, MK)) : null,
    username: decField(row.username_enc, MK),
    password: decField(row.password_enc, MK),
    sshKeyPath: decField(row.ssh_key_path_enc, MK),
    sshKeyContent: decField(row.ssh_key_content_enc, MK),
  }
}

// ---------- Pending command store (for confirm mode) ----------

const pendingBatches = new Map<
  string,
  {
    commands: Array<{
      logId: string
      deviceId: string
      deviceName: string
      command: string
    }>
    rejectedCommands: Array<{
      deviceName: string
      cmd: string
      reason: string
    }>
    fullMessages: Array<{ role: string; content: string }>
    aiReply: string
    config: Record<string, string>
    deviceNames: string[]
    sessionId: string | null
    createdAt: number
    // C-M3（v0.3.0 audit）：chat() 写入（pendingBatches.set 传 expReferences）/ confirmCommand
    // 读取（batch.expReferences）此前类型声明缺失，属真实类型漂移——与 :750 局部变量同构。
    expReferences?: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
  }
>()

// 定期清理过期待确认批次（默认 10 分钟），避免 pendingBatches 无限累积
const PENDING_TTL_MS = 10 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [id, batch] of pendingBatches) {
    if (now - batch.createdAt > PENDING_TTL_MS) pendingBatches.delete(id)
  }
}, 60000)

export async function confirmCommand(
  batchId: string,
  approved: boolean
): Promise<string> {
  const batch = pendingBatches.get(batchId)
  if (!batch) throw new Error('未找到待确认命令')
  pendingBatches.delete(batchId)

  if (!approved) {
    for (const cmd of batch.commands) {
      updateLogStatus(cmd.logId, 'rejected')
    }
    const msg = '用户拒绝了所有命令的执行。'
    saveChatMessage('assistant', msg, null, batch.sessionId)
    return msg
  }

  // T-20-04 fail-closed 空命令批次（回复解析失败回落的人工确认）：无命令可执行，
  // 直接返回说明，不构造空结果集触发 LLM 追问（既有 approved 路径对此类批次无意义）。
  if (batch.commands.length === 0) {
    const msg = '本轮回复命令结构解析失败（fail-closed），未执行任何命令。请检查提示词配置后重试。'
    saveChatMessage('assistant', msg, null, batch.sessionId)
    return msg
  }

  // Execute all approved commands — group by device for batch execution
  const cmdResults: Array<{ deviceName: string; cmd: string; output: string; status: string }> = []

  for (const cmd of batch.commands) {
    updateLogStatus(cmd.logId, 'approved')
  }

  const deviceGroups = new Map<string, Array<{ logId: string; deviceName: string; command: string }>>()
  for (const cmd of batch.commands) {
    if (!deviceGroups.has(cmd.deviceId)) deviceGroups.set(cmd.deviceId, [])
    deviceGroups.get(cmd.deviceId)!.push(cmd)
  }

  for (const [deviceId, cmds] of deviceGroups) {
    const device = getDeviceByIdInternal(deviceId)
    if (!device) {
      for (const cmd of cmds) {
        updateLogStatus(cmd.logId, 'failed')
        cmdResults.push({ deviceName: cmd.deviceName, cmd: cmd.command, output: '设备不存在', status: 'failed' })
      }
      continue
    }
    try {
      const execResults = await executeCommandsOnDevice(device, cmds.map(c => c.command))
      for (let i = 0; i < cmds.length; i++) {
        const r = execResults[i]
        if (r && r.success) {
          updateLogStatus(cmds[i].logId, 'executed')
          cmdResults.push({ deviceName: cmds[i].deviceName, cmd: r.command, output: r.output, status: 'executed' })
        } else {
          updateLogStatus(cmds[i].logId, 'failed')
          cmdResults.push({ deviceName: cmds[i].deviceName, cmd: cmds[i].command, output: r?.output || '执行失败', status: 'failed' })
        }
      }
    } catch (err: any) {
      for (const cmd of cmds) {
        updateLogStatus(cmd.logId, 'failed')
        cmdResults.push({ deviceName: cmd.deviceName, cmd: cmd.command, output: `执行失败: ${err.message}`, status: 'failed' })
      }
    }
  }

  // Add previously rejected commands
  for (const r of batch.rejectedCommands) {
    cmdResults.push({ deviceName: r.deviceName, cmd: r.cmd, output: `命令被拒绝: ${r.reason}`, status: 'rejected' })
  }

  // Send results to AI for analysis
  const resultsText = cmdResults
    .map((r) => `设备: ${r.deviceName}\n命令: ${r.cmd}\n状态: ${r.status}\n输出:\n${r.output}`)
    .join('\n\n')

  const deviceNamesStr = batch.deviceNames.join(', ')
  const followUpMessages: Array<{ role: string; content: string }> = [
    ...batch.fullMessages,
    { role: 'assistant', content: batch.aiReply },
    {
      role: 'user',
      content: `以下是在设备 ${deviceNamesStr} 上执行命令的结果，请分析并给出总结：\n\n${resultsText}`,
    },
  ]

  const finalReply = await callAI(batch.config, followUpMessages)

  // Append second AI interaction to all related logs
  const secondPrompt = JSON.stringify(followUpMessages, null, 2)
  for (const cmd of batch.commands) {
    appendLogAiResponse(cmd.logId, secondPrompt, finalReply)
  }

  saveChatMessage('assistant', finalReply, null, batch.sessionId)

  // Phase 11 UAT fix：confirmCommand 最终回复也返经验引用（命令确认执行场景不丢来源列表）
  if (batch.expReferences && batch.expReferences.length > 0) {
    return buildExpAnswerPayload(finalReply, batch.expReferences)
  }
  return finalReply
}

// ---------- Phase 11 experience references helpers ----------
// UAT fix：经验引用 references 映射——chat()/confirmCommand 所有返回路径（无命令 exp_answer /
// 有命令 confirm+auto / confirmCommand finalReply）统一用它，确保命令执行场景也返来源列表。

/** expReferences → exp_answer references 数组（统一 camelCase + kind:'experience'）。 */
function mapExpRefs(
  expRefs: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
) {
  return expRefs.map((e) => ({
    kind: 'experience' as const,
    expId: e.exp_id,
    title: e.title,
    sourceSessionId: e.source_session_id,
    unsupported: e.unsupported,
  }))
}

/** 把最终回复包装成 exp_answer JSON（renderer useAIChat 解析 references 渲染来源列表）。 */
function buildExpAnswerPayload(
  content: string,
  expRefs: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
): string {
  return JSON.stringify({ type: 'exp_answer', content, references: mapExpRefs(expRefs) })
}

// ---------- Main chat ----------

/**
 * T-20-04 fail-closed 判定：AI 回复命令结构解析失败。
 * 判定规则：回复含 [CMD(:name)?] 开标签但提取不到任何完整命令块（标签未闭合），
 * 或提取出的命令体为空串——两类都视为「改坏提示词导致的畸形回复」。
 */
export function isMalformedCommandReply(
  reply: string,
  commands: Array<{ deviceName: string; cmd: string }>
): boolean {
  const hasOpenTag = /\[CMD(?::[^\]]+)?\]/.test(reply)
  return (hasOpenTag && commands.length === 0) || commands.some((c) => !c.cmd)
}

export async function chat(
  messages: Array<{ role: string; content: string }>,
  deviceIds?: string[],
  sessionId?: string
): Promise<string> {
  const config = getAiConfig()
  if (!config || !config.apiKey) {
    throw new Error('请先配置 AI 服务（API Key 未设置）')
  }

  const whitelist = getCommandWhitelist()
  const execMode = getExecMode()

  // Load target devices（动态注入段先行构造，值与拼接顺序与收敛前完全一致——PMT-01 零回归）
  // 前导 \n\n 由变量值带入（registry 占位符契约，见 promptRegistry.ts ai.chat.systemPrompt 注释）
  let deviceInfo = ''
  const targetDevices: any[] = []
  if (deviceIds && deviceIds.length > 0) {
    for (const did of deviceIds) {
      const dev = getDeviceByIdInternal(did)
      if (dev) targetDevices.push(dev)
    }
    if (targetDevices.length === 1) {
      const d = targetDevices[0]
      deviceInfo = `\n\n当前目标设备信息：\n- 名称: ${d.name}\n- IP: ${d.ipAddress}\n- 厂商: ${d.vendor || '未知'}\n- 型号: ${d.model || '未知'}\n- 版本: ${d.version || '未知'}`
    } else if (targetDevices.length > 1) {
      let multi = '\n\n当前目标设备（多台）：'
      for (const d of targetDevices) {
        multi += `\n---\n- 名称: ${d.name}\n- IP: ${d.ipAddress}\n- 厂商: ${d.vendor || '未知'}\n- 型号: ${d.model || '未知'}\n- 版本: ${d.version || '未知'}`
      }
      multi += '\n\n你可以在不同设备上执行不同命令，请用 [CMD:设备名] 格式指定在哪台设备上执行。'
      deviceInfo = multi
    }
  }

  // Phase 11 D-11-1 b 自动预取：每轮对话自动检索经验库（不靠 AI 自主标记）。
  // retrieveForAnswer 内部整体 try/catch，异常时 expReferences=[] 继续正常答（D-11-9 不阻塞主路径）。
  const userMessage = messages[messages.length - 1]?.content || ''
  let expReferences: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }> = []
  let experienceContext = ''
  try {
    const retrieval = await retrieveForAnswer({ userMessage, deviceIds })
    if (retrieval.injected.length > 0) {
      const expContext = retrieval.injected.map((e, i) =>
        `[经验${i + 1}: ${e.title}${e.unsupported ? '（⚠ 此条经验命令已失支持，请提示用户手动执行或更新白名单）' : ''}]\n${e.content}`
      ).join('\n\n')
      experienceContext = `\n\n以下是经验库中检索到的相关经验（仅供参考，回答末尾无需标注来源）：\n${expContext}`
      expReferences = retrieval.injected.map((e) => ({
        exp_id: e.exp_id,
        title: e.title,
        source_session_id: e.source_session_id ?? null,
        unsupported: e.unsupported,
      }))
    }
  } catch (err) {
    console.warn('[ai.chat] experience retrieval failed, continue without injection:', (err as Error).message)
  }

  // Phase 20 PMT-01：systemPrompt 静态头收敛到 promptRegistry（用户可 override），
  // 动态注入段（deviceInfo/experienceContext）按 registry 占位符填入，值与收敛前逐字一致。
  const systemPrompt = PromptService.getPrompt('ai.chat.systemPrompt')
    .replace('{{deviceInfo}}', () => deviceInfo)
    .replace('{{experienceContext}}', () => experienceContext)

  const fullMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ]

  const aiReply = await callAI(config, fullMessages)

  // Check for KB_SEARCH tool call
  const kbSearchMatch = aiReply.match(/\[KB_SEARCH\](.*?)\[\/KB_SEARCH\]/s)
  let kbReferences: Array<{ docTitle: string; chunkTitle: string; docId: string }> = []
  let finalAiReply = aiReply

  if (kbSearchMatch) {
    const searchQuery = kbSearchMatch[1].trim()
    try {
      const searchResults = (await kbSearch(searchQuery, deviceIds, 5)).rows
      if (searchResults.length > 0) {
        // Build context from search results, replacing [图片N] with descriptions
        const kbContext = searchResults.map((r: any, i: number) => {
          let content = r.content || ''
          if (r.images?.length > 0) {
            const imgMarkers = [...content.matchAll(/\[图片(\d+)\]/g)]
            for (const m of imgMarkers) {
              const num = parseInt(m[1], 10)
              const img = r.images[num - 1]
              if (img?.description) {
                content = content.replace(m[0], `[图片${num}: ${img.description}]`)
              }
            }
          }
          return `[文档${i + 1}: ${r.document?.title || '未知'} / 章节: ${r.title || '无标题'}]\n${content}`
        }).join('\n\n')

        // Collect references
        kbReferences = searchResults.map((r: any) => ({
          docTitle: r.document?.title || '未知',
          chunkTitle: r.title || '无标题',
          docId: r.document_id,
        }))

        // Feed results back to AI for final answer
        const followUpMessages = [
          ...fullMessages,
          { role: 'assistant', content: aiReply },
          {
            role: 'user',
            content: `以下是资料库检索到的相关文档片段（关键词: "${searchQuery}"）：\n\n${kbContext}\n\n请基于以上文档内容回答用户的问题。如果文档中没有相关信息，请说明。回答中不要包含 [KB_SEARCH] 标记。`,
          },
        ]
        finalAiReply = await callAI(config, followUpMessages)
      } else {
        // No results found — let AI know
        const followUpMessages = [
          ...fullMessages,
          { role: 'assistant', content: aiReply },
          { role: 'user', content: `资料库中未找到与"${searchQuery}"相关的文档。请基于你已有的知识回答，并说明资料库中暂无相关文档。回答中不要包含 [KB_SEARCH] 标记。` },
        ]
        finalAiReply = await callAI(config, followUpMessages)
      }
    } catch {
      // KB search failed — strip the tag and use original reply
      finalAiReply = aiReply.replace(/\[KB_SEARCH\].*?\[\/KB_SEARCH\]/gs, '').trim()
    }
  }

  // Extract [CMD:device]...[/CMD] or [CMD]...[/CMD] blocks
  const cmdRegex = /\[CMD(?::([^\]]+))?\](.*?)\[\/CMD\]/g
  const commands: Array<{ deviceName: string; cmd: string }> = []
  let match: RegExpExecArray | null
  while ((match = cmdRegex.exec(finalAiReply)) !== null) {
    const deviceName = (match[1] || '').trim()
    const cmd = match[2].trim()
    commands.push({ deviceName, cmd })
  }

  // T-20-04 fail-closed（Phase 20 PMT-04 / Success Criteria 5）：
  // 用户改坏 ai.chat.systemPrompt（override）可能导致 AI 输出畸形命令结构（未闭合 [CMD] 标签 /
  // 空命令体）。confirm 模式下解析失败不进入执行路径、也不静默当作"无命令"处理，而是回落输出
  // 与下方 confirm_required 同型的人工确认结构（携带原始回复供 UI 展示）——
  // 宁可多一次人工确认，绝不因解析失败漏确认或误执行。auto 模式维持既有行为不变。
  if (targetDevices.length > 0 && execMode === 'confirm' && isMalformedCommandReply(finalAiReply, commands)) {
    const batchId = uuidv4()
    // 注册空命令批次：确认/拒绝均无害（confirmCommand 空命令守卫直接返回说明，不触发 LLM 追问）
    pendingBatches.set(batchId, {
      commands: [],
      rejectedCommands: [],
      fullMessages,
      aiReply: finalAiReply,
      config,
      deviceNames: targetDevices.map((d) => d.name),
      sessionId: sessionId || null,
      createdAt: Date.now(),
      expReferences,
    })
    const failClosedResponse = JSON.stringify({
      type: 'confirm_required',
      execId: batchId,
      commands: [],
      rejectedCommands: [
        { command: '（回复命令结构解析失败）', reason: 'AI 回复命令标记解析失败（fail-closed），未提取到可执行命令；请检查提示词配置后重试' },
      ],
      aiExplanation: finalAiReply,
    })
    saveChatMessage('user', messages[messages.length - 1]?.content || '', null, sessionId)
    saveChatMessage('assistant', '回复命令结构解析失败（fail-closed），等待人工确认...', null, sessionId)
    return failClosedResponse
  }

  // No commands or no devices — just return the reply
  if (commands.length === 0 || targetDevices.length === 0) {
    saveChatMessage('user', messages[messages.length - 1]?.content || '', null, sessionId)
    saveChatMessage('assistant', finalAiReply, null, sessionId)
    // Phase 11 WR-01 fix：KB 与经验同时命中时合并 references（type 'exp_answer' 含 kb+experience 联合），
    // 避免既有 kb_answer 早 return 丢弃经验 references（功能断流）。renderer exp_answer handler 按 r.kind 分流消费。
    if (kbReferences.length > 0 && expReferences.length > 0) {
      const refs = [
        ...kbReferences.map((r: any) => ({ kind: 'kb', docTitle: r.docTitle, chunkTitle: r.chunkTitle, docId: r.docId })),
        ...mapExpRefs(expReferences),
      ]
      return JSON.stringify({ type: 'exp_answer', content: finalAiReply, references: refs })
    }
    if (kbReferences.length > 0) {
      return JSON.stringify({ type: 'kb_answer', content: finalAiReply, references: kbReferences })
    }
    // Phase 11 D-11-1/D-11-11：经验注入命中 → 返 exp_answer（references 从注入记录拿，不需 AI 标记）。
    if (expReferences.length > 0) {
      return buildExpAnswerPayload(finalAiReply, expReferences)
    }
    return finalAiReply
  }

  // Collect all commands with safety check
  const allowedCommands: Array<{
    logId: string
    deviceId: string
    deviceName: string
    command: string
  }> = []
  const rejectedCommands: Array<{ deviceName: string; cmd: string; reason: string }> = []

  for (const { deviceName, cmd } of commands) {
    // 指定设备名必须精确匹配（忽略大小写/trim），未匹配则拒绝而非回退默认设备；未指定时用默认设备
    let targetDevice: any
    if (deviceName) {
      const trimmed = deviceName.trim().toLowerCase()
      targetDevice = targetDevices.find((d) => d.name.trim().toLowerCase() === trimmed)
      if (!targetDevice) {
        rejectedCommands.push({ deviceName, cmd, reason: `未找到指定设备: ${deviceName}` })
        continue
      }
    } else {
      targetDevice = targetDevices[0]
    }

    const safety = isCommandAllowed(cmd, whitelist)
    const logId = createLog({
      deviceId: targetDevice.id,
      deviceName: targetDevice.name,
      command: cmd,
      status: safety.allowed ? (execMode === 'auto' ? 'approved' : 'pending') : 'rejected',
      mode: execMode,
      aiReason: aiReply.substring(0, 500),
      promptText: JSON.stringify(fullMessages, null, 2),
      aiResponse: aiReply,
    })

    if (!safety.allowed) {
      rejectedCommands.push({ deviceName: targetDevice.name, cmd, reason: safety.reason })
      continue
    }

    allowedCommands.push({
      logId,
      deviceId: targetDevice.id,
      deviceName: targetDevice.name,
      command: cmd,
    })
  }

  // No allowed commands — return AI reply + rejection notices
  if (allowedCommands.length === 0) {
    const rejectionText = rejectedCommands.map((r) => `命令 [${r.deviceName}] ${r.cmd} 被拒绝: ${r.reason}`).join('\n')
    const fullReply = aiReply + '\n\n' + rejectionText
    saveChatMessage('user', messages[messages.length - 1]?.content || '', null, sessionId)
    saveChatMessage('assistant', fullReply, null, sessionId)
    return fullReply
  }

  // Confirm mode: store batch and wait for approval
  if (execMode === 'confirm') {
    const batchId = uuidv4()
    pendingBatches.set(batchId, {
      commands: allowedCommands,
      rejectedCommands,
      fullMessages,
      aiReply,
      config,
      deviceNames: targetDevices.map((d) => d.name),
      sessionId: sessionId || null,
      createdAt: Date.now(),
      expReferences,
    })

    const confirmResponse = JSON.stringify({
      type: 'confirm_required',
      execId: batchId,
      commands: allowedCommands.map((c) => ({ deviceName: c.deviceName, command: c.command })),
      rejectedCommands: rejectedCommands.map((r) => ({ command: r.cmd, reason: r.reason })),
      aiExplanation: aiReply,
    })
    saveChatMessage('user', messages[messages.length - 1]?.content || '', null, sessionId)
    saveChatMessage('assistant', `等待确认 ${allowedCommands.length} 条命令...`, null, sessionId)
    return confirmResponse
  }

  // Auto mode: execute all commands — group by device for batch execution
  const cmdResults: Array<{ deviceName: string; cmd: string; output: string; status: string }> = []

  const autoGroups = new Map<string, Array<{ logId: string; deviceName: string; command: string }>>()
  for (const cmd of allowedCommands) {
    if (!autoGroups.has(cmd.deviceId)) autoGroups.set(cmd.deviceId, [])
    autoGroups.get(cmd.deviceId)!.push({ logId: cmd.logId, deviceName: cmd.deviceName, command: cmd.command })
  }

  for (const [deviceId, cmds] of autoGroups) {
    const device = getDeviceByIdInternal(deviceId)
    if (!device) continue
    try {
      const execResults = await executeCommandsOnDevice(device, cmds.map(c => c.command))
      for (let i = 0; i < cmds.length; i++) {
        const r = execResults[i]
        if (r && r.success) {
          updateLogStatus(cmds[i].logId, 'executed')
          cmdResults.push({ deviceName: cmds[i].deviceName, cmd: r.command, output: r.output, status: 'executed' })
        } else {
          updateLogStatus(cmds[i].logId, 'failed')
          cmdResults.push({ deviceName: cmds[i].deviceName, cmd: cmds[i].command, output: r?.output || '执行失败', status: 'failed' })
        }
      }
    } catch (err: any) {
      for (const cmd of cmds) {
        updateLogStatus(cmd.logId, 'failed')
        cmdResults.push({ deviceName: cmd.deviceName, cmd: cmd.command, output: `执行失败: ${err.message}`, status: 'failed' })
      }
    }
  }

  // Add rejected commands to results
  for (const r of rejectedCommands) {
    cmdResults.push({ deviceName: r.deviceName, cmd: r.cmd, output: `命令被拒绝: ${r.reason}`, status: 'rejected' })
  }

  // Send results back to AI for final analysis
  const resultsText = cmdResults
    .map((r) => `设备: ${r.deviceName}\n命令: ${r.cmd}\n状态: ${r.status}\n输出:\n${r.output}`)
    .join('\n\n')

  const deviceNamesStr = targetDevices.map((d) => d.name).join(', ')
  const followUpMessages: Array<{ role: string; content: string }> = [
    ...fullMessages,
    { role: 'assistant', content: aiReply },
    {
      role: 'user',
      content: `以下是在设备 ${deviceNamesStr} 上执行命令的结果，请分析并给出总结：\n\n${resultsText}`,
    },
  ]

  const finalReply = await callAI(config, followUpMessages)

  saveChatMessage('user', messages[messages.length - 1]?.content || '', null, sessionId)
  saveChatMessage('assistant', finalReply, null, sessionId)

  // Phase 11 UAT fix：auto 命令路径也返经验引用（避免命令执行场景丢来源列表）
  if (expReferences.length > 0) return buildExpAnswerPayload(finalReply, expReferences)
  return finalReply
}

// ---------- Re-export getLogs ----------

export { getLogs as getAiLogs }
