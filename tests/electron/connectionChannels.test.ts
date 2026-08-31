import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 36（36-03，LOGIN-02/LOGIN-04）通道分流 / D-10 回退 / RDP 分辨率测试。
 *
 * 覆盖（36-03-PLAN Task 2）：
 * - resolveExecChannel 纯函数：默认 ssh/telnet 用之 / web 默认回退 ssh / ssh 缺回退 telnet /
 *   无命令行通道 null（D-10）
 * - openTerminal 分流：指定 telnet 走 connectTelnet（选 A 弹 A，T-36-03-03 锁死）、缺省走默认
 *   通道（D-07）、无效枚举 throw（T-36-03-02）、通道行不存在 throw、悬空默认回退（T-36-03-04）、
 *   web 也走 main（Q3 对称性）、webUrl 空 throw
 * - openRDP resolution：「整数x整数」严格匹配才写 desktopwidth/desktopheight（D-04 裁决补记，
 *   T-36-03-06 注入面封堵）；空值/格式不符零行为变化
 * - getDeviceByIdInternal D-10 平铺投影：web 默认 + ssh 已配 → connectionType 'ssh' +
 *   ssh 行凭证 + capabilities.hasSSH true；仅 web → 保持 'web' + 空凭证 + 全 false
 * - testDeviceConnection 零通道 → { success: false, message: '该设备未配置登录通道' }
 *
 * Mock 策略：进程边界（electron BrowserWindow——RUN_AS_NODE 下不可用）与协议连接终点
 * （ssh2 Client.connect / net.createConnection / child_process.execFile / openExternalSafe）
 * mock 记录调用；数据库经 vi.hoisted delegate 注入真 better-sqlite3 内存库（H.delegate 模式，
 * deviceChannels 组同款），device/aiExec 服务真实实现（真 encField 加密落库）。
 */

// ---- electron mock：BrowserWindow stub（记录实例 + webContents.on 注册，测试手动触发 did-finish-load） ----
const winState = vi.hoisted(() => ({ instances: [] as any[] }))
vi.mock('electron', () => {
  class BrowserWindowStub {
    webContents: { id: number; on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }
    constructor(_opts: unknown) {
      this.webContents = {
        id: Math.floor(Math.random() * 1_000_000_000),
        on: vi.fn(),
        send: vi.fn(),
      }
      winState.instances.push(this)
    }
    setMenu = vi.fn()
    isDestroyed = () => false
    on = vi.fn()
    loadURL = vi.fn()
    loadFile = vi.fn()
    close = vi.fn()
  }
  return { BrowserWindow: BrowserWindowStub }
})

// ---- ssh2 mock：Client stub 记录 connect 配置（SSH 分流断言：走 connectSSH 即 connect 被调） ----
const sshState = vi.hoisted(() => ({ connects: [] as any[] }))
vi.mock('ssh2', () => {
  class ClientStub {
    on(_ev: string, _cb: unknown) { return this }
    connect(cfg: unknown) { sshState.connects.push(cfg) }
    end() { /* stub */ }
    destroy() { /* stub */ }
  }
  return { Client: ClientStub }
})

// ---- net mock：createConnection 记录目标（telnet 分流断言）；default + named 双导出（CJS interop）；
//      'net' 与 'node:net' 双 specifier 注册（builtin 归一化差异兜底） ----
const netState = vi.hoisted(() => ({ connections: [] as any[] }))
const netFactory = vi.hoisted(() => async () => {
  const { EventEmitter } = await vi.importActual<any>('events')
  const createConnection = (opts: unknown) => {
    netState.connections.push(opts)
    const s = new EventEmitter() as any
    s.write = vi.fn()
    s.end = vi.fn()
    s.destroy = vi.fn()
    return s
  }
  return { default: { createConnection }, createConnection }
})
vi.mock('net', netFactory)
vi.mock('node:net', netFactory)

// ---- child_process mock：execFile 同步读取 .rdp 临时文件内容（openRDP 在 execFile 前已写盘） ----
const rdpState = vi.hoisted(() => ({ files: [] as string[] }))
vi.mock('child_process', async () => {
  const fs = await vi.importActual<any>('fs')
  return {
    execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: unknown) => void) => {
      rdpState.files.push(fs.readFileSync(args[0], 'utf-8'))
      cb(null)
    },
  }
})

// ---- webSecurity mock：openExternalSafe 记录 URL（web 分支也走 main 断言） ----
const webState = vi.hoisted(() => ({ opened: [] as string[] }))
vi.mock('../../electron/utils/webSecurity', () => ({
  hardenWindow: vi.fn(),
  openExternalSafe: (url: string) => { webState.opened.push(url) },
}))

// ---- database/connection mock：内存库（device.capabilities/deviceChannels 组同款 H.delegate 模式） ----
const H = vi.hoisted(() => ({ delegate: null as Database.Database | null }))
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => H.delegate,
}))

import { openTerminal, testDeviceConnection, openRDP, setConnectionMasterKey } from '../../electron/services/connection'
import { createDevice, setDeviceMasterKey, resolveExecChannel } from '../../electron/services/device'
import { getDeviceByIdInternal, setAiExecMasterKey } from '../../electron/services/aiExec'

const TEST_MK = 'test-mk-36-03'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE topologies (
      id TEXT PRIMARY KEY,
      name_enc TEXT NOT NULL,
      data_enc TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      topology_id TEXT,
      name_enc TEXT NOT NULL,
      vendor_enc TEXT,
      model_enc TEXT,
      version_enc TEXT,
      ip_enc TEXT,
      device_type TEXT DEFAULT 'generic' CHECK(device_type IN ('router','switch','firewall','server','generic')),
      connection_type TEXT CHECK(connection_type IN ('ssh','telnet','web','rdp')),
      name_hash TEXT,
      status TEXT DEFAULT 'unknown',
      last_checked TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (topology_id) REFERENCES topologies(id) ON DELETE SET NULL
    );
    CREATE TABLE device_credentials (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('ssh','telnet','web','rdp')),
      port_enc TEXT,
      username_enc TEXT,
      password_enc TEXT,
      ssh_key_path_enc TEXT,
      ssh_key_content_enc TEXT,
      web_url_enc TEXT,
      resolution TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(device_id, channel),
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_device_credentials_device ON device_credentials(device_id);
    CREATE TABLE mcp_device_rel (
      mcp_config_id TEXT NOT NULL,
      device_id TEXT NOT NULL UNIQUE
    );
  `)
  return db
}

/** 触发最近一个窗口的 did-finish-load（openTerminal 在窗口加载完成后才发起连接）。 */
function fireDidFinishLoad(): void {
  const win = winState.instances[winState.instances.length - 1]
  const calls = (win.webContents.on as ReturnType<typeof vi.fn>).mock.calls
  const handler = calls.find((c) => c[0] === 'did-finish-load')?.[1] as () => void
  expect(handler).toBeTypeOf('function')
  handler()
}

/** 直改 devices.connection_type（制造悬空默认——绕过服务层 D-09 滑落守卫）。 */
function forceConnectionType(deviceId: string, value: string | null): void {
  ;(H.delegate as Database.Database)
    .prepare('UPDATE devices SET connection_type = ? WHERE id = ?')
    .run(value, deviceId)
}

/** 进程/协议 mock 记录态复位（每个 it 独立断言）。 */
beforeEach(() => {
  winState.instances.length = 0
  sshState.connects.length = 0
  netState.connections.length = 0
  webState.opened.length = 0
  rdpState.files.length = 0
})

describe('resolveExecChannel 纯函数（D-10）', () => {
  it('默认通道 ssh 且已配 → 用之', () => {
    expect(resolveExecChannel('ssh', ['ssh', 'web'])).toBe('ssh')
  })

  it('默认通道 telnet 且已配 → 用之', () => {
    expect(resolveExecChannel('telnet', ['telnet', 'ssh'])).toBe('telnet')
  })

  it('默认 web → 回退已配 ssh', () => {
    expect(resolveExecChannel('web', ['ssh', 'web'])).toBe('ssh')
  })

  it('ssh 缺（仅 telnet 已配）→ 回退 telnet', () => {
    expect(resolveExecChannel('web', ['telnet', 'web', 'rdp'])).toBe('telnet')
    expect(resolveExecChannel('ssh', ['telnet'])).toBe('telnet') // 默认悬空（不在集合）同样回退
  })

  it('无命令行通道（仅 web/rdp）→ null（fail-closed 消费方派生 false）', () => {
    expect(resolveExecChannel('web', ['web', 'rdp'])).toBeNull()
    expect(resolveExecChannel(null, ['rdp'])).toBeNull()
    expect(resolveExecChannel('rdp', [])).toBeNull()
  })
})

describe('openTerminal 通道分流（LOGIN-02）', () => {
  beforeEach(() => {
    H.delegate = makeDb()
    setDeviceMasterKey(TEST_MK)
    setConnectionMasterKey(TEST_MK)
  })

  afterEach(() => {
    H.delegate?.close()
    H.delegate = null
    setDeviceMasterKey('')
    setConnectionMasterKey('')
  })

  it('指定 telnet 通道（ssh+telnet 双通道、默认 ssh）→ 走 connectTelnet 且用 telnet 行端口；SSH 分支零调用（选 A 不弹 B，T-36-03-03）', () => {
    const dev: any = createDevice({
      name: 'Dual-SW', ipAddress: '10.0.0.1', connectionType: 'ssh',
      channels: [
        { channel: 'ssh', enabled: true, port: 2222, username: 'u-ssh', password: 'pw-ssh' },
        { channel: 'telnet', enabled: true, port: 2323, username: 'u-tel', password: 'pw-tel' },
      ],
    })
    openTerminal(dev.id, 'telnet')
    fireDidFinishLoad()
    expect(netState.connections).toHaveLength(1)
    expect(netState.connections[0]).toEqual({ host: '10.0.0.1', port: 2323 })
    expect(sshState.connects).toHaveLength(0)
  })

  it('channel 缺省 → 默认通道（D-07）：connection_type=ssh → connectSSH 用 ssh 行凭证', () => {
    const dev: any = createDevice({
      name: 'Default-SSH', ipAddress: '10.0.0.2', connectionType: 'ssh',
      channels: [
        { channel: 'ssh', enabled: true, port: 2222, username: 'u-ssh', password: 'pw-ssh' },
        { channel: 'telnet', enabled: true, port: 2323, username: 'u-tel', password: 'pw-tel' },
      ],
    })
    openTerminal(dev.id)
    fireDidFinishLoad()
    expect(sshState.connects).toHaveLength(1)
    expect(netState.connections).toHaveLength(0)
    const cfg = sshState.connects[0]
    expect(cfg.host).toBe('10.0.0.2')
    expect(cfg.port).toBe(2222)
    expect(cfg.username).toBe('u-ssh')
    expect(cfg.password).toBe('pw-ssh') // buildSSHConnectConfig password 分支消费平铺凭证
  })

  it('channel 非四枚举值 → throw 无效通道（V5/T-36-03-02），不建窗口', () => {
    const dev: any = createDevice({
      name: 'Enum-FW', ipAddress: '10.0.0.3', connectionType: 'ssh',
      channels: [{ channel: 'ssh', enabled: true, username: 'u' }],
    })
    expect(() => openTerminal(dev.id, 'ftp')).toThrow('无效通道')
    expect(winState.instances).toHaveLength(0)
  })

  it('指定通道行不存在 → throw 该设备未配置{通道}通道', () => {
    const dev: any = createDevice({
      name: 'NoRDP-SW', ipAddress: '10.0.0.4', connectionType: 'ssh',
      channels: [{ channel: 'ssh', enabled: true, username: 'u' }],
    })
    expect(() => openTerminal(dev.id, 'rdp')).toThrow('该设备未配置rdp通道')
  })

  it('悬空默认（connection_type=web 但 web 行已删）→ 缺省按 resolveExecChannel 回退 telnet（T-36-03-04）', () => {
    const dev: any = createDevice({
      name: 'Dangling-R', ipAddress: '10.0.0.5', connectionType: 'telnet',
      channels: [{ channel: 'telnet', enabled: true, port: 2323, username: 'u-tel', password: 'pw-tel' }],
    })
    forceConnectionType(dev.id, 'web')
    openTerminal(dev.id)
    fireDidFinishLoad()
    expect(netState.connections).toHaveLength(1)
    expect(netState.connections[0]).toEqual({ host: '10.0.0.5', port: 2323 })
  })

  it('web 通道也走 main：openTerminal(dev, "web") → openExternalSafe(子表 webUrl)（Q3 对称性），不建终端窗口', () => {
    const dev: any = createDevice({
      name: 'Web-FW', ipAddress: '10.0.0.6', connectionType: 'web',
      channels: [{ channel: 'web', enabled: true, webUrl: 'https://10.0.0.6:8443' }],
    })
    const r = openTerminal(dev.id, 'web')
    expect(r).toEqual({ sessionId: '' })
    expect(webState.opened).toEqual(['https://10.0.0.6:8443'])
    expect(winState.instances).toHaveLength(0)
  })

  it('web 通道行 webUrl 空 → throw 该设备未配置 Web 地址', () => {
    const dev: any = createDevice({
      name: 'WebEmpty', ipAddress: '10.0.0.7', connectionType: 'web',
      channels: [{ channel: 'web', enabled: true }],
    })
    expect(() => openTerminal(dev.id, 'web')).toThrow('该设备未配置 Web 地址')
  })

  it('testDeviceConnection 零通道设备 → { success: false, message: "该设备未配置登录通道" }（UI-SPEC §九）', async () => {
    const dev: any = createDevice({
      name: 'Zero-Ch', ipAddress: '10.0.0.8', connectionType: 'ssh',
      channels: [{ channel: 'ssh', enabled: false }],
    })
    const r = await testDeviceConnection(dev.id)
    expect(r).toEqual({ success: false, message: '该设备未配置登录通道' })
  })
})

describe('openRDP resolution 消费（D-04 裁决补记，T-36-03-06）', () => {
  it('resolution「整数x整数」→ username 行之后追加 desktopwidth/desktopheight 两行', () => {
    openRDP({ id: 'rdp-1', name: 'n', ipAddress: '10.0.1.1', connectionType: 'rdp', port: 33890, username: 'r-user', password: '', sshKeyPath: '', sshKeyContent: '', webUrl: '', resolution: '1920x1080' })
    const file = rdpState.files[rdpState.files.length - 1]
    expect(file).toContain('username:s:r-user\n')
    expect(file).toContain('desktopwidth:i:1920\n')
    expect(file).toContain('desktopheight:i:1080\n')
    // 追加位置在 username 行之后（plan 验收：username 行之后追加）
    expect(file.indexOf('desktopwidth:i:1920')).toBeGreaterThan(file.indexOf('username:s:r-user'))
  })

  it('resolution 空/null → 零行为变化：不写分辨率行（mstsc 用默认）', () => {
    const base = { id: 'rdp-2', name: 'n', ipAddress: '10.0.1.2', connectionType: 'rdp', port: 3389, username: 'r-user', password: '', sshKeyPath: '', sshKeyContent: '', webUrl: '' }
    openRDP({ ...base, resolution: null })
    openRDP({ ...base, resolution: undefined })
    for (const file of rdpState.files.slice(-2)) {
      expect(file).not.toContain('desktopwidth')
      expect(file).not.toContain('desktopheight')
    }
  })

  it('resolution 格式不符（非纯整数x整数）→ 忽略零行为变化（注入面封堵）', () => {
    const base = { id: 'rdp-3', name: 'n', ipAddress: '10.0.1.3', connectionType: 'rdp', port: 3389, username: 'u', password: '', sshKeyPath: '', sshKeyContent: '', webUrl: '' }
    openRDP({ ...base, resolution: '1920×1080' })     // 全角 ×
    openRDP({ ...base, resolution: '1920x1080x32' })  // 三段
    openRDP({ ...base, resolution: 'ax1080' })        // 非数字
    openRDP({ ...base, resolution: '1920x' })         // 缺高
    for (const file of rdpState.files.slice(-4)) {
      expect(file).not.toContain('desktopwidth')
      expect(file).not.toContain('desktopheight')
    }
  })
})

describe('getDeviceByIdInternal D-10 平铺投影（LOGIN-04）', () => {
  beforeEach(() => {
    H.delegate = makeDb()
    setDeviceMasterKey(TEST_MK)
    setAiExecMasterKey(TEST_MK)
  })

  afterEach(() => {
    H.delegate?.close()
    H.delegate = null
    setDeviceMasterKey('')
    setAiExecMasterKey('')
  })

  it('web 默认 + ssh 已配 → connectionType "ssh"（D-10 回退）+ ssh 行凭证平铺 + capabilities.hasSSH true', () => {
    const dev: any = createDevice({
      name: 'WebDefault', ipAddress: '10.0.2.1', connectionType: 'web',
      channels: [
        { channel: 'ssh', enabled: true, port: 2222, username: 'u-ssh', password: 'pw-ssh' },
        { channel: 'web', enabled: true, webUrl: 'https://10.0.2.1' },
      ],
    })
    const p = getDeviceByIdInternal(dev.id)
    expect(p.connectionType).toBe('ssh') // 不是 web——回退到有效命令通道
    expect(p.port).toBe(2222)
    expect(p.username).toBe('u-ssh')
    expect(p.password).toBe('pw-ssh')
    expect(p.capabilities).toEqual({ hasSSH: true, hasTelnet: false, hasMcp: false })
  })

  it('仅 web 通道（无命令行）→ connectionType 保持 "web" + 凭证空值 + capabilities 全 false（fail-closed）', () => {
    const dev: any = createDevice({
      name: 'WebOnly', ipAddress: '10.0.2.2', connectionType: 'web',
      channels: [{ channel: 'web', enabled: true, webUrl: 'https://10.0.2.2' }],
    })
    const p = getDeviceByIdInternal(dev.id)
    expect(p.connectionType).toBe('web')
    expect(p.port).toBeNull()
    expect(p.username).toBe('')
    expect(p.password).toBe('')
    expect(p.capabilities).toEqual({ hasSSH: false, hasTelnet: false, hasMcp: false })
  })

  it('默认 telnet → 直接平铺 telnet 行凭证（不回退）', () => {
    const dev: any = createDevice({
      name: 'TelDefault', ipAddress: '10.0.2.3', connectionType: 'telnet',
      channels: [
        { channel: 'telnet', enabled: true, port: 2323, username: 'u-tel', password: 'pw-tel' },
        { channel: 'ssh', enabled: true, port: 2222, username: 'u-ssh', password: 'pw-ssh' },
      ],
    })
    const p = getDeviceByIdInternal(dev.id)
    expect(p.connectionType).toBe('telnet')
    expect(p.port).toBe(2323)
    expect(p.username).toBe('u-tel')
    expect(p.password).toBe('pw-tel')
    expect(p.capabilities.hasTelnet).toBe(true)
    expect(p.capabilities.hasSSH).toBe(true) // 可同真（D-05）
  })
})
