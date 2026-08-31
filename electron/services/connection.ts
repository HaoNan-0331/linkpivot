import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import path from 'path'
import fs from 'fs'
import net from 'net'
import iconv from 'iconv-lite'
import { Client, type ClientChannel } from 'ssh2'
import { getDeviceById, setDeviceMasterKey, resolveExecChannel } from './device'
import { hardenWindow, openExternalSafe } from '../utils/webSecurity'
import { buildSSHConnectConfig, mapSshProbeError } from '../utils/sshConfig'
import { decodeDeviceBuffer } from '../utils/textDecode'
import { testTcpConnect } from '../utils/tcpProbe'

interface DeviceInfo {
  id: string
  name: string
  ipAddress: string
  connectionType: string
  port: number | null
  username: string
  password: string
  sshKeyPath: string
  sshKeyContent: string
  webUrl: string
  /** Phase 36（D-04 裁决补记）：RDP 分辨率明文字段（'1920x1080' 形态），36-03 openRDP 消费 */
  resolution?: string | null
}

interface ActiveSession {
  id: string
  client: Client | net.Socket
  window: BrowserWindow
  stream: { write: (data: string | Buffer) => void; end: () => void } | null
}

const sessions = new Map<string, ActiveSession>()
const windowSessionMap = new Map<number, string>() // webContents.id -> sessionId
let sessionCounter = 0

export function setConnectionMasterKey(key: string) {
  setDeviceMasterKey(key)
}

/**
 * Phase 36（36-03，LOGIN-02）：通道解析 + 平铺视图——取代 36-02 loadDeviceInfo 过渡桥。
 * 指定通道：先枚举校验（'ssh'|'telnet'|'web'|'rdp' 之外 throw，V5/T-36-03-02 服务层与
 * DB CHECK 双层），再 (device_id, channel) UNIQUE 行级定位（选 A 取 A 行凭证，T-36-03-03），
 * 行不存在 throw。缺省：devices.connection_type 默认通道（D-07 DB 单一真源）优先；为空/悬空
 * （不在通道集合）时按 resolveExecChannel 回退（兜底老库悬空默认，T-36-03-04）；无可用通道
 * → error: 'no-channel'（openTerminal throw / testDeviceConnection 失败文案，由调用方定形）。
 * 平铺视图：凭证与 resolution 取自目标通道行，connectSSH / connectTelnet / openRDP 消费链零改动。
 */
const CHANNELS = ['ssh', 'telnet', 'web', 'rdp'] as const

type ChannelViewResult = { view: DeviceInfo } | { error: 'no-device' } | { error: 'no-channel' }

function resolveChannelView(deviceId: string, channel?: string): ChannelViewResult {
  if (channel !== undefined && !(CHANNELS as readonly string[]).includes(channel)) {
    throw new Error('无效通道')
  }
  const device = getDeviceById(deviceId) as any
  if (!device) return { error: 'no-device' }
  const channels: any[] = Array.isArray(device.channels) ? device.channels : []
  const channelNames = channels.map((c) => c.channel as string)
  let resolved: string | null
  if (channel !== undefined) {
    resolved = channel
  } else if (device.connectionType && channelNames.includes(device.connectionType)) {
    resolved = device.connectionType
  } else {
    resolved = resolveExecChannel(device.connectionType ?? null, channelNames)
  }
  if (!resolved) return { error: 'no-channel' }
  const row = channels.find((c) => c.channel === resolved)
  if (!row) throw new Error(`该设备未配置${resolved}通道`)
  return {
    view: {
      ...device,
      connectionType: resolved,
      port: row.port ?? null,
      username: row.username ?? '',
      password: row.password ?? '',
      sshKeyPath: row.sshKeyPath ?? '',
      sshKeyContent: row.sshKeyContent ?? '',
      webUrl: row.webUrl ?? '',
      resolution: row.resolution ?? null,
    } as DeviceInfo,
  }
}

export function openTerminal(deviceId: string, channel?: string): { sessionId: string } {
  const r = resolveChannelView(deviceId, channel)
  if ('error' in r) {
    if (r.error === 'no-device') throw new Error('设备不存在')
    throw new Error('该设备未配置登录通道')
  }
  const device = r.view

  if (device.connectionType === 'web') {
    if (!device.webUrl) throw new Error('该设备未配置 Web 地址')
    openWebSafe(device.webUrl)
    return { sessionId: '' }
  }

  if (device.connectionType === 'rdp') {
    openRDP(device)
    return { sessionId: '' }
  }

  const sessionId = `session_${++sessionCounter}_${Date.now()}`

  const termWin = new BrowserWindow({
    width: 900,
    height: 600,
    title: `终端 - ${device.name} (${device.ipAddress})`,
    webPreferences: {
      preload: path.join(__dirname, 'terminal-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  termWin.setMenu(null)
  hardenWindow(termWin)

  const webContentsId = termWin.webContents.id
  windowSessionMap.set(webContentsId, sessionId)

  termWin.on('closed', () => {
    windowSessionMap.delete(webContentsId)
    disconnectSession(sessionId)
  })

  // Wait for window to finish loading before starting connection
  termWin.webContents.on('did-finish-load', () => {
    if (device.connectionType === 'ssh') {
      connectSSH(sessionId, device, termWin)
    } else if (device.connectionType === 'telnet') {
      connectTelnet(sessionId, device, termWin)
    }
  })

  if (process.env.NODE_ENV === 'development') {
    termWin.loadURL('http://localhost:5173/terminal.html')
  } else {
    termWin.loadFile(path.join(__dirname, '../dist/terminal.html'))
  }

  return { sessionId }
}

export function openWebSafe(url: string) {
  openExternalSafe(url)
}

function connectSSH(sessionId: string, device: DeviceInfo, termWin: BrowserWindow) {
  const client = new Client()

  // 建会话路径：readyTimeout 默认 30s（SSH_READY_TIMEOUT_MS，慢设备建会话可等）
  const config = buildSSHConnectConfig(device)

  client.on('ready', () => {
    client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        if (!termWin.isDestroyed()) {
          termWin.webContents.send('terminal:data', `\r\nSSH错误: ${err.message}\r\n`)
        }
        client.end()
        return
      }

      sessions.set(sessionId, { id: sessionId, client, window: termWin, stream })

      if (!termWin.isDestroyed()) {
        termWin.webContents.send('terminal:data', `已连接到 ${device.name} (${device.ipAddress})\r\n`)
      }

      stream.on('data', (data: Buffer) => {
        if (!termWin.isDestroyed()) {
          termWin.webContents.send('terminal:data', decodeDeviceBuffer(data))
        }
      })
      stream.stderr.on('data', (data: Buffer) => {
        if (!termWin.isDestroyed()) {
          termWin.webContents.send('terminal:data', decodeDeviceBuffer(data))
        }
      })
      stream.on('close', () => {
        if (!termWin.isDestroyed()) {
          termWin.webContents.send('terminal:data', '\r\n连接已关闭\r\n')
        }
        client.end()
      })
    })
  })

  client.on('error', (err: Error) => {
    if (!termWin.isDestroyed()) {
      termWin.webContents.send('terminal:data', `\r\n连接错误: ${err.message}\r\n`)
    }
    client.end()
  })

  client.connect(config)
}

function connectTelnet(sessionId: string, device: DeviceInfo, termWin: BrowserWindow) {
  const socket = net.createConnection({
    host: device.ipAddress,
    port: device.port || 23,
  })

  socket.on('connect', () => {
    sessions.set(sessionId, { id: sessionId, client: socket, window: termWin, stream: socket })
    if (!termWin.isDestroyed()) {
      termWin.webContents.send('terminal:data', `已连接到 ${device.name} (${device.ipAddress})\r\n`)
    }
  })

  socket.on('data', (data: Buffer) => {
    if (!termWin.isDestroyed()) {
      termWin.webContents.send('terminal:data', iconv.decode(data, 'gbk'))
    }
  })

  socket.on('error', (err: Error) => {
    if (!termWin.isDestroyed()) {
      termWin.webContents.send('terminal:data', `\r\n连接错误: ${err.message}\r\n`)
    }
  })

  socket.on('close', () => {
    if (!termWin.isDestroyed()) {
      termWin.webContents.send('terminal:data', '\r\n连接已关闭\r\n')
    }
  })
}

export function writeToSession(sessionId: string, data: string) {
  const session = sessions.get(sessionId)
  if (!session || !session.stream) return
  session.stream.write(data)
}

export function writeByWebContentsId(webContentsId: number, data: string) {
  const sessionId = windowSessionMap.get(webContentsId)
  if (!sessionId) return
  writeToSession(sessionId, data)
}

export function disconnectSession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  if (session.stream) {
    try { session.stream.end() } catch (_e) { /* ignore */ }
  }
  if (session.client instanceof Client) {
    try { session.client.end() } catch (_e) { /* ignore */ }
  } else {
    try { (session.client as net.Socket).destroy() } catch (_e) { /* ignore */ }
  }
  if (!session.window.isDestroyed()) {
    session.window.close()
  }
  sessions.delete(sessionId)
}

export function testDeviceConnection(deviceId: string): Promise<{ success: boolean; message: string }> {
  // Phase 36（36-03，Q1 裁决）：测默认通道——解析同 openTerminal 缺省逻辑；零通道/行不存在 →
  // 失败文案（UI-SPEC §九），不 throw。
  const r = resolveChannelView(deviceId)
  if ('error' in r) {
    if (r.error === 'no-device') return Promise.resolve({ success: false, message: '设备不存在' })
    return Promise.resolve({ success: false, message: '该设备未配置登录通道' })
  }
  const device = r.view

  if (device.connectionType === 'web') {
    return testWebConnection(device.webUrl)
  } else if (device.connectionType === 'telnet') {
    return testTelnetConnection(device.ipAddress, device.port || 23)
  } else if (device.connectionType === 'rdp') {
    return testRDPConnection(device.ipAddress, device.port || 3389)
  } else {
    return testSSHConnection(device)
  }
}

function testSSHConnection(device: DeviceInfo): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const client = new Client()
    const timer = setTimeout(() => {
      client.end()
      resolve({ success: false, message: `连接超时 (${device.ipAddress}:${device.port || 22})` })
    }, 10000)

    client.on('ready', () => {
      clearTimeout(timer)
      client.end()
      resolve({ success: true, message: `SSH 连接成功 (${device.ipAddress}:${device.port || 22})` })
    })
    client.on('error', (err: Error) => {
      clearTimeout(timer)
      // SSH 特有 AUTH 分支 + errno 基础映射的组合单一来源（优先级保持原实现，15-REVIEW WR-01 fix）
      resolve({ success: false, message: mapSshProbeError(err) })
    })

    // 探活快测语义 8s：与连接路径 30s 的差异是设计意图（探活要快速失败反馈，慢设备建会话可等 30s）——P10 禁抹平
    const config = buildSSHConnectConfig(device, 8000)
    client.connect(config)
  })
}

function testTelnetConnection(host: string, port: number): Promise<{ success: boolean; message: string }> {
  return testTcpConnect(host, port, { successLabel: 'Telnet 连接成功' })
}

async function testWebConnection(url: string): Promise<{ success: boolean; message: string }> {
  try {
    if (!url) return { success: false, message: '未配置 Web URL' }
    const parsed = new URL(url)
    const port = parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    // Test TCP connectivity only — skip SSL verification (devices use self-signed certs)
    // 注（行为超集，研究 ARCHITECTURE §2.1.3 统一映射）：error 路径原为裸 `连接失败: msg`，收敛后网络错误场景获得 errnoToChinese 中文文案
    return await testTcpConnect(parsed.hostname, port, { successLabel: 'Web 端口可达' })
  } catch {
    return { success: false, message: '无效的 URL' }
  }
}

export function openRDP(device: DeviceInfo) {
  const host = device.ipAddress
  const port = device.port || 3389
  let rdpFile = `full address:s:${host}:${port}\n`
  if (device.username) {
    rdpFile += `username:s:${device.username}\n`
  }
  // Phase 36（36-03，D-04 裁决补记 2026-08-31）：RDP 分辨率经通道行 resolution 下发——
  // 「整数x整数」形态（如 1920x1080）严格匹配才在 username 行之后追加 desktopwidth/
  // desktopheight 两行（T-36-03-06：\d+ 捕获纯数字，无换行/键值注入面）；空值/格式不符
  // 零行为变化（不写分辨率行，mstsc 用默认）。username/password 消费关系不变（A4）。
  const resMatch = typeof device.resolution === 'string' ? /^(\d+)x(\d+)$/.exec(device.resolution.trim()) : null
  if (resMatch) {
    rdpFile += `desktopwidth:i:${resMatch[1]}\ndesktopheight:i:${resMatch[2]}\n`
  }
  // mstsc on Windows accepts an .rdp file path as argument
  const tmpPath = path.join(require('os').tmpdir(), `rdp_${device.id || Date.now()}.rdp`)
  try {
    fs.writeFileSync(tmpPath, rdpFile, 'utf-8')
  } catch (e) {
    removeTempRdpFile(tmpPath) // 写入半途失败也不残留半写文件
    throw e
  }
  execFile('mstsc', [tmpPath], { shell: false }, (err) => {
    // F-02: mstsc 进程退出（含启动失败）后清理临时文件——回调触发时文件已被消费，成功路径行为不变
    removeTempRdpFile(tmpPath)
    if (err) throw new Error(`启动 RDP 失败: ${err.message}`)
  })
}

function removeTempRdpFile(tmpPath: string) {
  try {
    fs.unlinkSync(tmpPath)
  } catch {
    /* 文件不存在/被占用：清理失败不掩盖原始结果 */
  }
}

function testRDPConnection(host: string, port: number): Promise<{ success: boolean; message: string }> {
  return testTcpConnect(host, port, { successLabel: 'RDP 端口可达' })
}
