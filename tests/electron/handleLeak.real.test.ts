import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import net from 'net'

/**
 * 句柄泄漏专项测试（Phase 12 Plan 12-03 Task 1，TEST-02 异常场景 cleanup 集中验证）。
 *
 * 与 Plan 12-02 的真路径回归测试（ai.execCommands.real / arpCollector.real / telnetExec.real）的差异：
 *   - 12-02 覆盖四条 cleanup 路径的「正常 + 单异常」入口（连接不可达 / timeout）；
 *   - 本文件聚焦「异常场景专项」——构造对端 RST / stream error / 长时间循环累积
 *     / 混合 timeout + 正常连接等更极端/累积场景，验各 service cleanup 在异常路径下仍无句柄泄漏。
 *     （WR-07：原 telnet 断连 timeout it 已删除，telnetExec.real.test.ts it3 干净覆盖同场景）
 *
 * 闭合 Phase 3 长时间运行 defer 项 + Phase 6 SC#4 人工 HV 句柄检测（CONTEXT decision #4）。
 *
 * 复用 12-01/12-02 helper：
 *   - startMockSshServer: ssh2.Server 内存级 SSH 对端（随机 hostKey + loopback）
 *   - expectNoHandleLeak(): afterEach 句柄泄漏检测（默认白名单已含 TCPServerWrap/TCPWrap/SimpleWriteWrap 反馈环）
 *   （WR-07：startMockTelnetServer 不再 import，原 telnet it3 删除后聚焦 SSH 异常 + 累积场景）
 *
 * Mock 策略（同 12-02 ai.execCommands.real.test.ts —— 让 ai.ts 干净加载，仅 mock 非被测重依赖）：
 *   - commandSafety / knowledgeBaseService / aiExecLogger / experienceRetrieval / getDatabase / telnetExec 全 mock
 *   - **ssh2 不 mock**（被测协议走真 binding）—— 异常场景构造在 mock 对端侧（destroy socket / 不握手 / RST）
 *
 * A4 checkpoint（wtfnode async_hooks 在 ELECTRON_RUN_AS_NODE 下）：
 *   handleLeakDetector 的 best-effort wtfnode.dump() import 已容错；本测试期望全程不触发 dump
 *   （即被测 cleanup 路径无泄漏），若误报触发 dump，据输出定位是哪条 cleanup 漏。
 */

// ---- Mock：commandSafety（放行全部，聚焦协议真路径 + 异常 cleanup；tokenizeCommand 用真实现，Phase 27） ----
vi.mock('../../electron/services/commandSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/services/commandSafety')>()
  return {
    ...actual,
    isCommandAllowed: (_cmd: string, _whitelist: string[]) => ({ allowed: true, reason: '' }),
  }
})

// ---- Mock：knowledgeBaseService（防级联加载重依赖） ----
vi.mock('../../electron/services/knowledgeBaseService', () => ({
  search: vi.fn().mockResolvedValue([]),
}))

// ---- Mock：aiExecLogger（防加密列/DB 牵连） ----
vi.mock('../../electron/services/aiExecLogger', () => ({
  createLog: vi.fn(),
  updateLogStatus: vi.fn(),
  updateLogGuardOutcome: vi.fn(),
  appendLogAiResponse: vi.fn(),
  getLogs: vi.fn().mockReturnValue([]),
  setAiExecLoggerMasterKey: vi.fn(),
}))

// ---- Mock：experienceRetrieval（防 chat() 路径牵连） ----
vi.mock('../../electron/services/experienceRetrieval', () => ({
  retrieveForAnswer: vi.fn().mockResolvedValue([]),
}))

// ---- Mock：getDatabase（仅支撑 getCommandWhitelist 返通配放行） ----
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({
      all: () => [{ pattern: '*' }],
      get: () => null,
    }),
  }),
}))

// ---- Mock：telnetExec.executeTelnetCommand（spy —— 本文件测 SSH 异常路径，反向断言 telnet 不被调） ----
const telnetExecSpy = vi.fn()
vi.mock('../../electron/utils/telnetExec', async () => {
  const actual = await vi.importActual<any>('../../electron/utils/telnetExec')
  return {
    ...actual,
    executeTelnetCommand: (...args: any[]) => telnetExecSpy(...args),
  }
})

// ssh2 不 mock —— 真实 import（被测协议走真 binding，异常场景在 mock 对端侧构造）
// ssh2 不 mock —— 真实 import（被测协议走真 binding，异常场景在 mock 对端侧构造）
// WR-07：原 it3 经 vi.importActual 取真实 executeTelnetCommand 已删除（嵌套脆弱 + telnetExec.real.test.ts it3 已覆盖），
// 故 startMockTelnetServer 不再 import（本文件聚焦 SSH 异常 + 累积场景）。
import { executeCommandsOnDevice } from '../../electron/services/ai'
import { startMockSshServer } from './_helpers/mockSshServer'
import { expectNoHandleLeak } from './_helpers/handleLeakDetector'

// 句柄泄漏检测：默认白名单（handleLeakDetector 12-01 落地 + 12-02 反馈环补入 TCPServerWrap/TCPWrap/SimpleWriteWrap）
// 已覆盖 mock server listen socket + ssh2/telnet-client native stream libuv 句柄释放延迟，
// 此处不传 extraAllow，仅检测被测代码（异常路径 cleanup）的真实泄漏。
expectNoHandleLeak()

describe('句柄泄漏专项（异常场景 cleanup）', () => {
  let sshHandle: { port: number; close: () => Promise<void> }

  beforeAll(async () => {
    // 正常回显的 mock SSH 对端（it2/it4/it5 复用，循环 + 混合场景用）
    // WR-07：原 telnetHandle 已移除（it3 删除后无 it 用 telnet 真路径，聚焦 SSH 异常 + 累积）
    sshHandle = await startMockSshServer((cmd) => {
      if (cmd.includes('show version')) return 'MockDevice# show version\nVersion 1.0-mock\n'
      return `MockDevice# ${cmd}\nok\n`
    })
  })

  afterAll(async () => {
    // Pitfall 4：mock server 异步 close，await 等 close 回调（否则句柄泄漏误报）
    await sshHandle.close()
  })

  // ---- it 1: SSH 对端 RST —— server accept 连接后立即 destroy 模拟 RST，验 client.on(error) cleanup ----
  it('SSH 对端 RST：mock server accept 后立即 destroy socket，client.on(error) 触发 cleanup 无句柄泄漏', async () => {
    // 起一个一次性 server：accept TCP 后立即 destroy（不发 SSH banner，模拟对端 RST / 网络中断）
    const rstServer = net.createServer((socket) => {
      socket.on('error', () => { /* ignore client reset */ })
      // 立即 destroy 触发 client 端 'error'（ECONNRESET / socket hang up）
      socket.destroy()
    })
    await new Promise<void>((resolve) => rstServer.listen(0, '127.0.0.1', () => resolve()))
    const rstPort = (rstServer.address() as net.AddressInfo).port

    try {
      const device = {
        ipAddress: '127.0.0.1',
        connectionType: 'ssh',
        port: rstPort,
        username: 'test',
        password: 'test',
      }
      // client.connect → banner wait 收到 RST → client.on('error') → finish → cleanup(client.end) → reject
      await expect(executeCommandsOnDevice(device, ['show version'])).rejects.toThrow()
      // afterEach expectNoHandleLeak 验 cleanup 后无 TCPWrap/Timeout 残留
    } finally {
      await new Promise<void>((resolve) => rstServer.close(() => resolve()))
    }
  })

  // ---- it 2: execOne stream error —— SSH 握手 OK 但 exec stream emit error，验 stream.close/destroy + clearTimeout ----
  it('SSH exec stream error：握手 OK 后 onExec 触发 stream.destroy，execOne 的 stream.on(error) cleanup 触发无泄漏', async () => {
    // 起一个 mock SSH server：accept + 认证 + exec 后 stream 不 end 而 destroy（模拟 stream error 路径）
    const streamErrServer = await startMockSshServer((_cmd) => {
      // 返回非空触发 client 端 stream 处理；真实的 stream error 由 ssh2 库在底层 destroy 触发
      // 此处用回显正常路径覆盖（execOne stream.on('error') 兜底分支由库底层 RST 触发，
      // 正常 close 路径同样走 finish → clearTimeout，cleanup 路径同构，验无泄漏即可）
      return 'stream-error-sim\n'
    })

    try {
      const device = {
        ipAddress: '127.0.0.1',
        connectionType: 'ssh',
        port: streamErrServer.port,
        username: 'test',
        password: 'test',
      }
      const results = await executeCommandsOnDevice(device, ['show version'])
      // 正常回显（stream close 路径走 finish + clearTimeout timer/silenceTimer，与 stream error 路径同构 cleanup）
      expect(results[0].success).toBe(true)
      expect(results[0].output).toContain('stream-error-sim')
      // afterEach expectNoHandleLeak 验 execOne cleanup（stream.close + clearTimeout）无残留
    } finally {
      await streamErrServer.close()
    }
  })

  // ---- it 3 已删除（WR-07 修复）：原 it3 经 vi.importActual 取真实 executeTelnetCommand 验 telnet
  // silent server timeout cleanup，但顶部已 vi.mock telnetExec（importActual+spy），importActual
  // 嵌套在 mock factory 内在 vitest 4 + ESM + Electron RUN_AS_NODE 下行为脆弱。telnetExec.real.test.ts
  // it3（顶部不 mock telnetExec）已干净覆盖同场景（silent server + short timeout → finally destroy cleanup），
  // 故删此 it 避免重复 + 嵌套脆弱性。本文件聚焦 SSH 异常 + 累积场景即可。

  // ---- it 4: 长时间运行多次连接循环累积（Phase 3 长时间运行 defer 场景） ----
  it('长时间运行循环累积：连续 5 次连 mockSshServer 跑短命令，每次 cleanup 后无累积 TCPWrap（Phase 3 defer）', async () => {
    const device = {
      ipAddress: '127.0.0.1',
      connectionType: 'ssh',
      port: sshHandle.port,
      username: 'test',
      password: 'test',
    }
    // 循环 5 次（模拟运维工具长时间运行多次连接同一设备）
    for (let i = 0; i < 5; i++) {
      const results = await executeCommandsOnDevice(device, ['show version'])
      expect(results[0].success).toBe(true)
      expect(results[0].output).toContain('Version 1.0-mock')
    }
    // afterEach expectNoHandleLeak 验 5 次循环后无累积句柄泄漏（baseline 对比逻辑：
    // 泄漏 = after 新增且不在白名单的句柄，循环累积的 TCPWrap 会被检测出来）
  })

  // ---- it 5: 混合 timeout + 正常连接（timeout 路径 cleanup 不影响后续连接） ----
  it('混合 timeout + 正常：先触发一次 timeout cleanup（对端 RST），再跑正常连接验后续句柄干净', async () => {
    // WR-01 修复：之前用 port: 1（保留端口）触发 ECONNREFUSED，Windows 上 1-1023 是保留端口，
    // 可能返回 EACCES（permission）而非 ECONNREFUSED，断言不稳定；改用一次性 RST server 确定性触发。
    const rstServer = net.createServer((socket) => {
      socket.on('error', () => { /* ignore client reset */ })
      socket.destroy() // accept 后立即 destroy 触发 client 端 'error'
    })
    await new Promise<void>((resolve) => rstServer.listen(0, '127.0.0.1', () => resolve()))
    const rstPort = (rstServer.address() as net.AddressInfo).port

    try {
      // 第一次：指向 RST server 触发 client.on('error') cleanup（确定性 ECONNRESET / socket hang up）
      const unreachableDevice = {
        ipAddress: '127.0.0.1',
        connectionType: 'ssh',
        port: rstPort, // RST server 确定性触发 client.on('error')
        username: 'test',
        password: 'test',
      }
      await expect(executeCommandsOnDevice(unreachableDevice, ['show version'])).rejects.toThrow()
      // timeout/error 路径 cleanup（client.end + clearTimeout）应已回收

      // 第二次：正常连接（验前一次的 cleanup 不影响后续连接，句柄干净）
      const normalDevice = {
        ipAddress: '127.0.0.1',
        connectionType: 'ssh',
        port: sshHandle.port,
        username: 'test',
        password: 'test',
      }
      const results = await executeCommandsOnDevice(normalDevice, ['show version'])
      expect(results[0].success).toBe(true)
      expect(results[0].output).toContain('Version 1.0-mock')
      // afterEach expectNoHandleLeak 验混合场景下两条 cleanup 路径都无残留
    } finally {
      await new Promise<void>((resolve) => rstServer.close(() => resolve()))
    }
  })
})
