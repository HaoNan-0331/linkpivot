import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * testDeviceConnection 集成测试（mock 段，npm test 跑）—— Phase 16 Plan 16-04 Task 1（TEST-04）。
 *
 * 测试靶子：connection.ts 集成串联 Phase 15 收敛产物（buildSSHConnectConfig / testTcpConnect /
 * mapSshProbeError / errnoToChinese）——四分流（SSH/Telnet/Web/RDP）+ 凭证优先级 + 错误中文映射。
 * 范围红线：buildSSHConnectConfig/mapSshProbeError/testTcpConnect/errnoToChinese 纯函数
 * 已有 tests/unit/ 单测，本文件不重复——聚焦 connection.ts 的分流与串联行为（D-09）。
 *
 * Mock 策略（ai.telnetRouting.test.ts:27-37 真 class 范式）：
 *   - ssh2 Client → 真 class（constructor 计数 + on/connect/end/destroy），SSH 分流可观测
 *   - ./device → getDeviceById 可控设备源（IO 边界）
 *   - net / sshConfig / tcpProbe / textDecode **不 mock** —— web/telnet/rdp 探活用本地一次性
 *     net.Server（listen(0,'127.0.0.1') loopback）+ 未监听随机端口测 ECONNREFUSED，
 *     SSH config 经真 buildSSHConnectConfig 输出断言（更接近 D-09 集成意图）
 *   - electron 顶层 import（BrowserWindow，仅 openTerminal 路径触）在 plain node 下为
 *     path 字符串具名导入，加载不报错，无需 vi.mock('electron')
 *
 * Phase 36（36-05 checkpoint 用户裁决，Q1 变更）：testDeviceConnection 改全通道并行探测——
 * 返回形态 `{ success, message, channels[] }`（channels 固定序逐通道结果）；既有用例断言
 * 已适配（改断言不删用例），多通道聚合行为见文末 describe 块。
 */

// ---- Mock：ssh2 Client（真 class，telnetRouting.ts:27-37 逐字范式） ----
const sshClientCtor = vi.fn()
const sshClientOn = vi.fn()
const sshClientConnect = vi.fn()
const sshClientEnd = vi.fn()
const sshClientDestroy = vi.fn()
vi.mock('ssh2', () => {
  // 必须用真 class（vitest mock 构造器要求 function/class）
  class Client {
    constructor() { sshClientCtor() }
    on = sshClientOn
    connect = sshClientConnect
    end = sshClientEnd
    destroy = sshClientDestroy
  }
  return { Client }
})

// ---- Mock：./device（getDeviceById 可控设备源 + setDeviceMasterKey 桩） ----
// Phase 36（36-03）：connection.ts 增导入 resolveExecChannel——npm test 轨无法 importActual
// （better-sqlite3 ABI 连锁），本文件 mock 设备恒带与 connectionType 同名通道行（缺省解析
// 走「默认通道在集合内」分支，resolveExecChannel 零调用），stub 仅为满足导入绑定；
// 真源 D-10 行为由 tests/electron/connectionChannels.test.ts 纯函数组锁死。
const getDeviceByIdMock = vi.fn()
vi.mock('./device', () => ({
  getDeviceById: (...args: unknown[]) => getDeviceByIdMock(...args),
  setDeviceMasterKey: vi.fn(),
  resolveExecChannel: vi.fn(() => null),
}))

import { testDeviceConnection } from './connection'

// ---- 本地 loopback server helper（真实 net，严格 127.0.0.1） ----
interface LoopbackHandle {
  port: number
  close: () => Promise<void>
}
const loopbackHandles: LoopbackHandle[] = []

function listenLoopback(port = 0): Promise<LoopbackHandle> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(() => { /* 探活只连不读，accept 即可 */ })
    const onListenError = (err: unknown) => reject(err)
    server.once('error', onListenError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onListenError)
      server.on('error', () => { /* 已过 listen 阶段，运行期错误不阻断测试 */ })
      const addr = server.address()
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        // close 等 server.close 回调（Pitfall 4：异步 close 防句柄泄漏）
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

/** 占一个随机端口再释放——用于 ECONNREFUSED（连未监听端口必拒绝） */
async function reserveFreePort(): Promise<number> {
  const h = await listenLoopback(0)
  const p = h.port
  await h.close()
  return p
}

// ---- 通用 ----
function makeDevice(over: Record<string, unknown> = {}) {
  const base = {
    id: 'dev-1',
    name: 'mock-device',
    ipAddress: '127.0.0.1',
    connectionType: 'ssh',
    port: null as number | null,
    username: 'admin',
    password: 'pw',
    sshKeyPath: '',
    sshKeyContent: '',
    webUrl: '',
    ...over,
  }
  // Phase 36（36-03）：getDeviceById 现形态为 channels 子表投影——resolveChannelView 从
  // 目标通道行取凭证/resolution，mock 设备同步携带同名通道行（凭证与顶层字段同值）。
  // Phase 36（36-05 Q1 变更）：over.channels 显式给定（多通道/零通道用例）时直用，
  // 否则按 base.connectionType 合成单通道行（既有单通道用例行为不变）。
  const channels = Array.isArray(over.channels)
    ? (over.channels as unknown[])
    : [{
        channel: base.connectionType,
        port: base.port,
        username: base.username,
        password: base.password,
        sshKeyPath: base.sshKeyPath,
        sshKeyContent: base.sshKeyContent,
        webUrl: base.webUrl,
        resolution: null,
      }]
  return { ...base, channels }
}

/** ssh mock client 已注册的事件回调（testDeviceConnection 同步注册 on('ready')/on('error')） */
let handlers: Record<string, (...args: unknown[]) => void> = {}

beforeEach(() => {
  vi.clearAllMocks()
  handlers = {}
  sshClientOn.mockImplementation((event: string, cb: (...a: unknown[]) => void) => {
    handlers[event] = cb
  })
})

afterEach(async () => {
  vi.useRealTimers()
  while (loopbackHandles.length > 0) {
    await loopbackHandles.pop()!.close()
  }
})

describe('testDeviceConnection — 四分流 + 优先级 + 错误映射集成（mock 段）', () => {
  it('分流入口：getDeviceById 返 null → 设备不存在', async () => {
    getDeviceByIdMock.mockReturnValue(null)
    await expect(testDeviceConnection('missing')).resolves.toEqual({
      success: false,
      message: '设备不存在',
      channels: [],
    })
  })

  it('web 分流：URL 端口可达 → Web 端口可达（经真 testTcpConnect 连本地 loopback）', async () => {
    const srv = await listenLoopback(0)
    loopbackHandles.push(srv)
    getDeviceByIdMock.mockReturnValue(
      makeDevice({ connectionType: 'web', webUrl: `http://127.0.0.1:${srv.port}/` })
    )
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: true,
      message: `Web 端口可达 (127.0.0.1:${srv.port})`,
      channels: [{ channel: 'web', success: true, message: `Web 端口可达 (127.0.0.1:${srv.port})` }],
    })
  })

  it('web 分流：webUrl 为空 → 未配置 Web URL', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({ connectionType: 'web', webUrl: '' }))
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: false,
      message: '未配置 Web URL',
      channels: [{ channel: 'web', success: false, message: '未配置 Web URL' }],
    })
  })

  it('web 分流：URL 解析失败（catch 分支）→ 无效的 URL', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({ connectionType: 'web', webUrl: ':::bad' }))
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: false,
      message: '无效的 URL',
      channels: [{ channel: 'web', success: false, message: '无效的 URL' }],
    })
    // 取舍说明：https 无端口默认 443 逻辑不强测真连（环境相关——本机 443 可能被占/被防火墙拦），
    // 以 http 显式端口覆盖为主；默认端口分支由 tests/unit/ 纯函数单测覆盖。
  })

  it('telnet 分流：port 缺省透传 23 默认值（真 testTcpConnect 连 127.0.0.1:23）', async () => {
    // 23 若被系统 telnet 服务占用：占用者同样 accept TCP，断言消息不变（不破坏确定性）
    const srv = await listenLoopback(23).catch(() => null)
    if (srv) loopbackHandles.push(srv)
    getDeviceByIdMock.mockReturnValue(makeDevice({ connectionType: 'telnet', port: null }))
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: true,
      message: 'Telnet 连接成功 (127.0.0.1:23)',
      channels: [{ channel: 'telnet', success: true, message: 'Telnet 连接成功 (127.0.0.1:23)' }],
    })
  })

  it('telnet 分流：port 显式 → 透传本地 server 端口 + Telnet 连接成功', async () => {
    const srv = await listenLoopback(0)
    loopbackHandles.push(srv)
    getDeviceByIdMock.mockReturnValue(makeDevice({ connectionType: 'telnet', port: srv.port }))
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: true,
      message: `Telnet 连接成功 (127.0.0.1:${srv.port})`,
      channels: [{ channel: 'telnet', success: true, message: `Telnet 连接成功 (127.0.0.1:${srv.port})` }],
    })
  })

  it('rdp 分流：port||3389 → RDP 端口可达（经真 testTcpConnect）', async () => {
    const srv = await listenLoopback(0)
    loopbackHandles.push(srv)
    getDeviceByIdMock.mockReturnValue(makeDevice({ connectionType: 'rdp', port: srv.port }))
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: true,
      message: `RDP 端口可达 (127.0.0.1:${srv.port})`,
      channels: [{ channel: 'rdp', success: true, message: `RDP 端口可达 (127.0.0.1:${srv.port})` }],
    })
  })

  it('ECONNREFUSED：连未监听随机端口 → tcpProbe.errnoToChinese 文案逐字一致', async () => {
    const freePort = await reserveFreePort()
    getDeviceByIdMock.mockReturnValue(makeDevice({ connectionType: 'telnet', port: freePort }))
    // 文案逐字对齐 electron/utils/tcpProbe.ts errnoToChinese ECONNREFUSED 分支
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: false,
      message: '连接被拒绝',
      channels: [{ channel: 'telnet', success: false, message: '连接被拒绝' }],
    })
  })

  it('枚举外通道行（DB CHECK 外值，防御）：serial 行滤除 → 零有效通道统一「该设备未配置登录通道」，不触发任何探活客户端', async () => {
    // 36-05 Q1 变更：旧「else 走 SSH 兜底」随全通道探测消亡——DB CHECK(channel IN (...))
    // 保证枚举外行不可能落库，此处锁防御语义：滤除后零有效通道 = 未配置登录通道
    getDeviceByIdMock.mockReturnValue(makeDevice({ connectionType: 'serial' }))
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: false,
      message: '该设备未配置登录通道',
      channels: [],
    })
    expect(sshClientCtor).not.toHaveBeenCalled()
  })

  it('ssh 优先级：sshKeyContent 最先 —— privateKey 为 Buffer（真 buildSSHConnectConfig 输出）且无 password；探活 readyTimeout 8000（P10 禁抹平）', async () => {
    getDeviceByIdMock.mockReturnValue(
      makeDevice({ sshKeyContent: 'test-key-content', password: 'pw-should-not-be-used' })
    )
    const p = testDeviceConnection('dev-1')
    const cfg = sshClientConnect.mock.calls[0][0] as Record<string, unknown>
    expect(cfg.privateKey).toBeInstanceOf(Buffer)
    expect((cfg.privateKey as Buffer).equals(Buffer.from('test-key-content'))).toBe(true)
    expect(cfg.password).toBeUndefined()
    // P10 探活语义（禁抹平）：testSSHConnection 显式传 8000 快速失败（connection.ts:250），
    // 与建会话路径 30s（SSH_READY_TIMEOUT_MS）的差异是设计意图
    expect(cfg.readyTimeout).toBe(8000)
    handlers.error(new Error('stop'))
    await p
  })

  it('ssh 优先级：sshKeyPath 次之 —— privateKey 读密钥文件字节', async () => {
    const keyFile = path.join(os.tmpdir(), `nt-conn-mock-key-${Date.now()}`)
    const keyBytes = Buffer.from('FAKE OPENSSH PRIVATE KEY BYTES')
    fs.writeFileSync(keyFile, keyBytes)
    try {
      getDeviceByIdMock.mockReturnValue(makeDevice({ sshKeyPath: keyFile, password: 'pw' }))
      const p = testDeviceConnection('dev-1')
      const cfg = sshClientConnect.mock.calls[0][0] as Record<string, unknown>
      expect(cfg.privateKey).toBeInstanceOf(Buffer)
      expect((cfg.privateKey as Buffer).equals(keyBytes)).toBe(true)
      expect(cfg.password).toBeUndefined()
      handlers.error(new Error('stop'))
      await p
    } finally {
      fs.rmSync(keyFile, { force: true })
    }
  })

  it('ssh 优先级：仅密码 → password 字段；host/port/username 透传', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({ port: 2222, username: 'admin' }))
    const p = testDeviceConnection('dev-1')
    const cfg = sshClientConnect.mock.calls[0][0] as Record<string, unknown>
    expect(cfg.password).toBe('pw')
    expect(cfg.privateKey).toBeUndefined()
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.port).toBe(2222)
    expect(cfg.username).toBe('admin')
    handlers.error(new Error('stop'))
    await p
  })

  it('ssh 透传：port 缺省 22 / username 缺省 root（buildSSHConnectConfig 默认）', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({ port: null, username: '' }))
    const p = testDeviceConnection('dev-1')
    const cfg = sshClientConnect.mock.calls[0][0] as Record<string, unknown>
    expect(cfg.port).toBe(22)
    expect(cfg.username).toBe('root')
    handlers.error(new Error('stop'))
    await p
  })

  it('ssh ready：resolve 成功 + client.end 被调 + 成功消息含 ip:port', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({ port: 2222 }))
    const p = testDeviceConnection('dev-1')
    handlers.ready()
    await expect(p).resolves.toEqual({
      success: true,
      message: 'SSH 连接成功 (127.0.0.1:2222)',
      channels: [{ channel: 'ssh', success: true, message: 'SSH 连接成功 (127.0.0.1:2222)' }],
    })
    expect(sshClientEnd).toHaveBeenCalledTimes(1)
  })

  it('ssh error AUTH：All configured authentication methods failed → 认证失败(用户名/密码/密钥错误)（真 mapSshProbeError）', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({}))
    const p = testDeviceConnection('dev-1')
    handlers.error(new Error('All configured authentication methods failed'))
    // 文案逐字对齐 electron/utils/sshConfig.ts mapSshProbeError AUTH 分支（D-10 用户提示）
    await expect(p).resolves.toEqual({
      success: false,
      message: '认证失败(用户名/密码/密钥错误)',
      channels: [{ channel: 'ssh', success: false, message: '认证失败(用户名/密码/密钥错误)' }],
    })
  })

  it('ssh error errno：ECONNREFUSED → errnoToChinese 文案', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({ port: 2222 }))
    const p = testDeviceConnection('dev-1')
    handlers.error(new Error('connect ECONNREFUSED 127.0.0.1:2222'))
    await expect(p).resolves.toEqual({ success: false, message: '连接被拒绝', channels: [{ channel: 'ssh', success: false, message: '连接被拒绝' }] })
  })

  it('ssh error 双关键词（errno 词 + All configured）：errno 先判怪癖 —— 认证阶段网络中断的包装错误仍报网络错误（characterization，15-REVIEW WR-01 优先级）', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({}))
    const p = testDeviceConnection('dev-1')
    // 怪癖注释标记：mapSshProbeError 实际顺序 errno 词先判——双关键词消息不会把「主机不可达」误读为「密码错误」
    handlers.error(new Error('connect EHOSTUNREACH during All configured authentication methods'))
    await expect(p).resolves.toEqual({ success: false, message: '主机不可达', channels: [{ channel: 'ssh', success: false, message: '主机不可达' }] })
  })

  it('ssh 超时：10s timer 兜底 → 连接超时 (ip:port) + client.end 被调', async () => {
    vi.useFakeTimers()
    getDeviceByIdMock.mockReturnValue(makeDevice({ port: 2222 }))
    const p = testDeviceConnection('dev-1')
    vi.advanceTimersByTime(10000)
    await expect(p).resolves.toEqual({
      success: false,
      message: '连接超时 (127.0.0.1:2222)',
      channels: [{ channel: 'ssh', success: false, message: '连接超时 (127.0.0.1:2222)' }],
    })
    expect(sshClientEnd).toHaveBeenCalledTimes(1)
  })
})

describe('testDeviceConnection 全通道并行探测（36-05 checkpoint 用户裁决，Q1 变更）', () => {
  it('四通道全配：并行探测全过 → 固定序 ssh/telnet/web/rdp + 聚合 success + 4/4 文案', async () => {
    const tel = await listenLoopback(0); loopbackHandles.push(tel)
    const web = await listenLoopback(0); loopbackHandles.push(web)
    const rdp = await listenLoopback(0); loopbackHandles.push(rdp)
    // 设备行乱序（rdp/ssh/web/telnet）——输出必须固定序（UI 一屏呈现稳定序）
    getDeviceByIdMock.mockReturnValue(makeDevice({
      channels: [
        { channel: 'rdp', port: rdp.port },
        { channel: 'ssh', port: 2222 },
        { channel: 'web', webUrl: `http://127.0.0.1:${web.port}/` },
        { channel: 'telnet', port: tel.port },
      ],
    }))
    const p = testDeviceConnection('dev-1')
    // 并行启动：async 函数体首个 await 前同步注册 SSH 探活（无需先 await）
    expect(sshClientCtor).toHaveBeenCalledTimes(1)
    handlers.ready()
    const r = await p
    expect(r.success).toBe(true)
    expect(r.message).toBe('4/4 通道连接成功')
    expect(r.channels.map((c) => c.channel)).toEqual(['ssh', 'telnet', 'web', 'rdp'])
    expect(r.channels[0]).toEqual({ channel: 'ssh', success: true, message: 'SSH 连接成功 (127.0.0.1:2222)' })
    expect(r.channels[1]).toEqual({ channel: 'telnet', success: true, message: `Telnet 连接成功 (127.0.0.1:${tel.port})` })
    expect(r.channels[2]).toEqual({ channel: 'web', success: true, message: `Web 端口可达 (127.0.0.1:${web.port})` })
    expect(r.channels[3]).toEqual({ channel: 'rdp', success: true, message: `RDP 端口可达 (127.0.0.1:${rdp.port})` })
  })

  it('部分失败：telnet 可达 + web 未监听 → 聚合 success:false + 1/2 文案 + 逐通道结果', async () => {
    const tel = await listenLoopback(0); loopbackHandles.push(tel)
    const freePort = await reserveFreePort()
    getDeviceByIdMock.mockReturnValue(makeDevice({
      channels: [
        { channel: 'web', webUrl: `http://127.0.0.1:${freePort}/` },
        { channel: 'telnet', port: tel.port },
      ],
    }))
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: false,
      message: '1/2 通道连接成功',
      channels: [
        { channel: 'telnet', success: true, message: `Telnet 连接成功 (127.0.0.1:${tel.port})` },
        { channel: 'web', success: false, message: '连接被拒绝' },
      ],
    })
  })

  it('probe 异常隔离：ssh 通道 sshKeyPath 指向不存在文件（buildSSHConnectConfig fs throw）→ 该通道「探测失败」不拖垮 telnet 结果', async () => {
    // Rule 2：旧形态整单 reject（UI 走 catch 分支）——多通道下会吞掉其余通道结果，必须按通道隔离
    const tel = await listenLoopback(0); loopbackHandles.push(tel)
    getDeviceByIdMock.mockReturnValue(makeDevice({
      channels: [
        { channel: 'ssh', sshKeyPath: path.join(os.tmpdir(), `nt-not-exist-key-${Date.now()}`) },
        { channel: 'telnet', port: tel.port },
      ],
    }))
    const r = await testDeviceConnection('dev-1')
    expect(r.success).toBe(false)
    expect(r.message).toBe('1/2 通道连接成功')
    expect(r.channels[0].channel).toBe('ssh')
    expect(r.channels[0].success).toBe(false)
    expect(r.channels[0].message).toContain('探测失败')
    expect(r.channels[1]).toEqual({ channel: 'telnet', success: true, message: `Telnet 连接成功 (127.0.0.1:${tel.port})` })
  })

  it('零通道：channels 空数组 → 保持单一失败契约「该设备未配置登录通道」+ channels: []（UI-SPEC §九）', async () => {
    getDeviceByIdMock.mockReturnValue(makeDevice({ channels: [] }))
    await expect(testDeviceConnection('dev-1')).resolves.toEqual({
      success: false,
      message: '该设备未配置登录通道',
      channels: [],
    })
  })

  it('单通道聚合 message = 该通道文案（UX 等价旧版——DevicesPage 单通道仍走 message 形态的服务层前提）', async () => {
    const srv = await listenLoopback(0); loopbackHandles.push(srv)
    getDeviceByIdMock.mockReturnValue(makeDevice({
      channels: [{ channel: 'telnet', port: srv.port }],
    }))
    const r = await testDeviceConnection('dev-1')
    expect(r.message).toBe(`Telnet 连接成功 (127.0.0.1:${srv.port})`)
    expect(r.message).toBe(r.channels[0].message)
  })
})
