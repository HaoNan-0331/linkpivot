import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { Client } from 'ssh2'
import net from 'net'

/**
 * SSH 真路径回归测试（Phase 12 Plan 12-02 Task 1，TEST-01 SSH 部分 + TEST-02 cleanup）。
 *
 * 与 ai.telnetRouting.test.ts 的关键差异（PATTERNS §ai.execCommands.real.test.ts 反向范式）：
 *   - ai.telnetRouting.test.ts: vi.mock('ssh2')（mock 协议），聚焦 connectionType 分流逻辑
 *   - 本文件（真路径）: **不 vi.mock ssh2**（grep `vi.mock('ssh2'` == 0），用真实 ssh2.Client 连 mockSshServer（ssh2.Server），
 *     覆盖 executeCommandsOnDevice SSH 路径的 client.connect → ready → client.exec → stream.on('data') → cleanup 全链路真实回显。
 *
 * 复用 12-01 helper：
 *   - startMockSshServer: ssh2.Server 内存级 SSH 对端（crypto.generateKeyPairSync 随机 hostKey + listen(0,'127.0.0.1')）
 *   - expectNoHandleLeak(['TCPWrap']): afterEach 句柄泄漏检测（TEST-02 executeCommandsOnDevice + execOne cleanup 路径）
 *
 * Mock 策略（让 ai.ts 干净加载，仅 mock 非被测重依赖 —— PATTERNS §vi.mock 让 service 干净加载 528-537）：
 *   - commandSafety: isCommandAllowed 全放行（聚焦协议真路径，安全规则由 commandSafety.test.ts 覆盖）
 *   - knowledgeBaseService / aiExecLogger / experienceRetrieval: import 时不触发，但 mock 防级联加载重依赖
 *   - connection.getDatabase: mock 桩（getCommandWhitelist SELECT pattern 返通配放行，同 ai.telnetRouting.test.ts:58-64 范式）
 *   - telnetExec.executeTelnetCommand: spy（本文件测 SSH 路径，telnet 分流反向断言它不被调）
 *   - **ssh2: 不 mock**（被测协议走真 binding）
 *
 * A2 checkpoint（RESEARCH Assumptions Log A2）：本文件连真实 ssh2.Client 经 mockSshServer（ssh2.Server）实跑，
 *   验证 ssh2.Server 在 ELECTRON_RUN_AS_NODE 下 listen + accept + authentication.accept + exec stream 回显可行。
 */

// ---- Mock：commandSafety（放行全部，聚焦协议真路径） ----
vi.mock('../../electron/services/commandSafety', () => ({
  isCommandAllowed: (_cmd: string, _whitelist: string[]) => ({ allowed: true, reason: '' }),
}))

// ---- Mock：knowledgeBaseService（防级联加载重依赖） ----
vi.mock('../../electron/services/knowledgeBaseService', () => ({
  search: vi.fn().mockResolvedValue([]),
}))

// ---- Mock：aiExecLogger（防加密列/DB 牵连） ----
vi.mock('../../electron/services/aiExecLogger', () => ({
  createLog: vi.fn(),
  updateLogStatus: vi.fn(),
  appendLogAiResponse: vi.fn(),
  getLogs: vi.fn().mockReturnValue([]),
  setAiExecLoggerMasterKey: vi.fn(),
}))

// ---- Mock：experienceRetrieval（防 chat() 路径牵连，本文件不测 chat） ----
vi.mock('../../electron/services/experienceRetrieval', () => ({
  retrieveForAnswer: vi.fn().mockResolvedValue([]),
}))

// ---- Mock：getDatabase（仅支撑 getCommandWhitelist 的 SELECT pattern 返通配放行，同 ai.telnetRouting.test.ts:58-64 范式） ----
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({
      all: () => [{ pattern: '*' }],
      get: () => null,
    }),
  }),
}))

// ---- Mock：telnetExec.executeTelnetCommand（spy —— 本文件测 SSH 路径，反向断言 telnet 不被调；pickDisablePaginationCmd/pickShellPrompt 走真实 importActual） ----
const telnetExecSpy = vi.fn()
vi.mock('../../electron/utils/telnetExec', async () => {
  const actual = await vi.importActual<any>('../../electron/utils/telnetExec')
  return {
    ...actual,
    executeTelnetCommand: (...args: any[]) => telnetExecSpy(...args),
  }
})

// ssh2 不 mock —— 真实 import（acceptance: grep "from 'ssh2'" == 1，grep "vi.mock('ssh2'" == 0）

// 其余依赖（crypto/uuid/iconv/fs/sshConfig）在 SSH 真路径用例不触发重逻辑，import 安全
import { executeCommandsOnDevice } from '../../electron/services/ai'
import { startMockSshServer } from './_helpers/mockSshServer'
import { expectNoHandleLeak } from './_helpers/handleLeakDetector'

// 句柄泄漏检测：默认白名单（handleLeakDetector 12-01 落地 + 12-02 反馈环补入 TCPServerWrap/TCPWrap/SimpleWriteWrap）
// 已覆盖 mock server listen socket + ssh2/telnet-client native stream libuv 句柄释放延迟，
// 此处不传 extraAllow，仅检测被测代码（executeCommandsOnDevice + execOne cleanup）的真实泄漏。
expectNoHandleLeak()

describe('executeCommandsOnDevice — SSH 真路径回归（executeCommandsOnDevice + execOne + executeSSH cleanup）', () => {
  let sshHandle: { port: number; close: () => Promise<void> }

  beforeAll(async () => {
    // A2 checkpoint 实跑：mockSshServer（ssh2.Server）listen + accept 任意凭证 + exec 回显
    sshHandle = await startMockSshServer((cmd) => {
      if (cmd.includes('show version')) return 'MockDevice# show version\nVersion 1.0-mock\n'
      if (cmd.includes('show clock')) return 'MockDevice# show clock\n2026-08-08 10:00:00\n'
      return `MockDevice# ${cmd}\nunknown command\n`
    })
  })

  afterAll(async () => {
    // Pitfall 4：mock server 异步 close，await 等 close 回调（否则句柄泄漏误报）
    await sshHandle.close()
  })

  it('SSH 正常路径：executeCommandsOnDevice 经真实 ssh2.Client 连 mockSshServer 回显，输出含预期版本', async () => {
    const device = {
      ipAddress: '127.0.0.1',
      connectionType: 'ssh',
      port: sshHandle.port,
      username: 'test',
      password: 'test',
      vendor: 'cisco',
    }

    const results = await executeCommandsOnDevice(device, ['show version'])

    // 入参透传断言（参考 ai.telnetRouting.test.ts:94-106 analog）—— SSH 路径走真 ssh2.Client，不走 telnet
    expect(telnetExecSpy).not.toHaveBeenCalled()

    // 结果断言：mock server 回显 "Version 1.0-mock"
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].command).toBe('show version')
    expect(results[0].output).toContain('Version 1.0-mock')
  })

  it('SSH 多命令批量：每命令独立连接（runOne 内 new Client），各回显独立', async () => {
    const device = {
      ipAddress: '127.0.0.1',
      connectionType: 'ssh',
      port: sshHandle.port,
      username: 'test',
      password: 'test',
    }

    const results = await executeCommandsOnDevice(device, ['show version', 'show clock'])

    expect(results).toHaveLength(2)
    expect(results[0].success).toBe(true)
    expect(results[0].output).toContain('Version 1.0-mock')
    expect(results[1].success).toBe(true)
    expect(results[1].output).toContain('2026-08-08 10:00:00')
  })

  it('telnet 分流反向断言：connectionType=telnet 时走 executeTelnetCommand（spy），ssh2.Client 不被真实连接', async () => {
    telnetExecSpy.mockResolvedValue('telnet-mock-output')

    const device = {
      ipAddress: '127.0.0.1',
      connectionType: 'telnet',
      port: sshHandle.port, // 注意：telnet 路径不会连 sshHandle（SSH server），仅验证 spy 被调
      username: 'test',
      password: 'test',
      vendor: 'huawei',
    }

    const results = await executeCommandsOnDevice(device, ['display version'])

    // 反向断言：telnet 路径调 executeTelnetCommand spy，真实 ssh2.Client 不参与（不会连 mockSshServer）
    expect(telnetExecSpy).toHaveBeenCalledTimes(1)
    const args = telnetExecSpy.mock.calls[0]
    // 入参透传（host/port/username/password/command）
    expect(args[0]).toBe('127.0.0.1')
    expect(args[2]).toBe('test')
    expect(args[3]).toBe('test')
    expect(args[4]).toBe('display version')
    expect(args[5]).toMatchObject({ decodeGbk: true, stripAnsi: true })

    // 结果走 spy 的 mockResolvedValue
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].output).toBe('telnet-mock-output')

    telnetExecSpy.mockReset()
  })

  it('execOne stream cleanup 无句柄泄漏：命令完成后 ssh2 Client + perCmdTimer/stream 全回收（TEST-02）', async () => {
    // 此 it 不新增逻辑，仅复用 SSH 正常路径执行 + expectNoHandleLeak afterEach 自动检测句柄泄漏。
    // 验证目标：executeCommandsOnDevice SSH 路径的 cleanup（client.end + clearTimeout perCmdTimer）
    // + execOne cleanup（stream.close + stream.destroy + clearTimeout timer/silenceTimer）无 TCPWrap/Timeout 残留。
    const device = {
      ipAddress: '127.0.0.1',
      connectionType: 'ssh',
      port: sshHandle.port,
      username: 'test',
      password: 'test',
    }

    const results = await executeCommandsOnDevice(device, ['show version'])

    expect(results[0].success).toBe(true)
    expect(results[0].output).toContain('Version 1.0-mock')
    // afterEach 经 expectNoHandleLeak 自动断言无句柄泄漏（若泄漏会 throw `句柄泄漏: [...]`）
  })

  it('异常路径 cleanup：对端 RST 触发 client.on(error) reject，cleanup 仍回收 client（首条 reject 整批）', async () => {
    // WR-01 修复：之前用 sshHandle.port + 1（随机端口 +1）假定无监听，但 +1 端口在 CI runner 共享环境
    // 可能被其他进程占用 → 偶发连上非预期 server → banner 等待 → timeout 而非立即 reject，testTimeout 内可能挂满。
    // 改用一次性 RST server（accept 后立即 destroy）确定性触发 client 'error'（ECONNRESET / socket hang up），
    // 同 handleLeak.real.test.ts it1 / arpCollector.real.test.ts 异常路径 it 同构。
    const rstServer = net.createServer((socket) => {
      socket.on('error', () => { /* ignore client reset */ })
      socket.destroy() // accept 后立即 destroy 触发 client 端 'error'
    })
    await new Promise<void>((resolve) => rstServer.listen(0, '127.0.0.1', () => resolve()))
    const rstPort = (rstServer.address() as net.AddressInfo).port

    try {
      const device = {
        ipAddress: '127.0.0.1',
        connectionType: 'ssh',
        port: rstPort, // RST server 确定性触发 client.on('error')
        username: 'test',
        password: 'test',
      }

      // 首条命令连接失败 → reject 整批（ai.ts:437-439 语义）
      await expect(executeCommandsOnDevice(device, ['show version'])).rejects.toThrow()

      // cleanup 仍触发：client.end() 回收 socket，afterEach expectNoHandleLeak 验无泄漏
    } finally {
      await new Promise<void>((resolve) => rstServer.close(() => resolve()))
    }
  })
})
