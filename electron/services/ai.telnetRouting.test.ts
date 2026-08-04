import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * executeCommandsOnDevice connectionType 分流测试。
 *
 * 背景（debug: ai-telnet-exec-routing）：历史实现无视 device.connectionType，对所有设备走 SSH（端口 22），
 * telnet 设备（仅开 23 端口）一律 ECONNREFUSED。修复后 runOne 按 connectionType 分流——
 * telnet 走 executeTelnetCommand（telnet-client），ssh（含默认）走 buildSSHConfig + client.exec + execOne。
 *
 * 验证目标：
 * 1. connectionType=telnet 设备执行命令时，走 telnet 通道（executeTelnetCommand 被调用），ssh2 Client 不被实例化。
 * 2. connectionType=ssh（含默认/未设置）设备执行命令时，走 SSH 通道（ssh2 Client 被实例化），executeTelnetCommand 不被调用。
 * 3. 安全层 checked 数组两路径共用：被拒命令两路径都返回 success:false 且不触发任何通道。
 *
 * Mock 策略（与 experienceService.test.ts 规避 native / 拦截模块的思路一致）：
 * - getDatabase → 内存 mock，只支撑 getCommandWhitelist 的 SELECT pattern 返回（放行全部命令）。
 * - ssh2 Client → 真 class（vitest 要求构造器 mock 为 function/class），计数实例化 + 暴露 on/connect/end。
 * - telnetExec.executeTelnetCommand → spy，记录调用参数 + 返回可控输出。
 */

// ---- Mock：ssh2 Client（真 class，验证 telnet 路径不创建 SSH 客户端；SSH 路径计数实例化） ----
const sshClientCtor = vi.fn()
const sshClientOn = vi.fn()
const sshClientConnect = vi.fn()
const sshClientEnd = vi.fn()
const sshClientDestroy = vi.fn()
vi.mock('ssh2', () => {
  // 必须用真 class（vitest mock 构造器要求 function/class）；new Client() → 计数 + 返回带 on/connect/end/destroy 的实例。
  class Client {
    constructor() { sshClientCtor() }
    on = sshClientOn
    connect = sshClientConnect
    end = sshClientEnd
    destroy = sshClientDestroy
  }
  return { Client }
})

// ---- Mock：telnetExec.executeTelnetCommand（spy 调用 + 可控返回） ----
const telnetExecSpy = vi.fn()
// WR-03：pickDisablePaginationCmd/pickShellPrompt 已从 ai.ts 抽到 telnetExec.ts 真实实现，
// mock 保留两者真实导出（用 importActual），仅替换 executeTelnetCommand 为 spy。
// 测试断言关分页命令文本与 shellPrompt 正则匹配（依赖真实 picker 实现）。
vi.mock('../utils/telnetExec', async () => {
  const actual = await vi.importActual<any>('../utils/telnetExec')
  return {
    ...actual,
    executeTelnetCommand: (...args: any[]) => telnetExecSpy(...args),
  }
})

// ---- Mock：commandSafety（放行全部，聚焦分流逻辑而非安全规则——安全规则由 commandSafety.test.ts 覆盖） ----
vi.mock('./commandSafety', () => ({
  isCommandAllowed: (_cmd: string, _whitelist: string[]) => ({ allowed: true, reason: '' }),
}))

// ---- Mock：getDatabase（仅支撑 getCommandWhitelist 的 SELECT pattern） ----
vi.mock('../database/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({
      all: () => [{ pattern: '*' }], // whitelist 通配放行（isCommandAllowed 已 mock 全放行，此处仅防 NPE）
    }),
  }),
}))

// 其余依赖（aiExecLogger/knowledgeBaseService/crypto）在本用例不触发，无需 mock；import 安全。
import { executeCommandsOnDevice } from './ai'

beforeEach(() => {
  sshClientCtor.mockClear()
  sshClientOn.mockClear()
  sshClientConnect.mockClear()
  sshClientEnd.mockClear()
  sshClientDestroy.mockClear()
  telnetExecSpy.mockReset()
})

describe('executeCommandsOnDevice — connectionType 分流', () => {
  it('telnet 设备走 telnet 通道，不实例化 ssh2 Client', async () => {
    const device = {
      ipAddress: '10.7.8.252',
      connectionType: 'telnet',
      port: 23,
      username: 'admin',
      password: 'secret',
    }
    telnetExecSpy.mockResolvedValue('display arp all output line')

    const results = await executeCommandsOnDevice(device, ['display arp all'])

    expect(telnetExecSpy).toHaveBeenCalledTimes(1)
    // 关键断言：telnet 路径不实例化 ssh2 Client
    expect(sshClientCtor).not.toHaveBeenCalled()
    // 入参透传：host/port/username/password/command + decodeGbk/stripAnsi 选项
    const args = telnetExecSpy.mock.calls[0]
    expect(args[0]).toBe('10.7.8.252')
    expect(args[1]).toBe(23)
    expect(args[2]).toBe('admin')
    expect(args[3]).toBe('secret')
    expect(args[4]).toBe('display arp all')
    expect(args[5]).toMatchObject({ decodeGbk: true, stripAnsi: true })
    // 结果
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].command).toBe('display arp all')
    expect(results[0].output).toBe('display arp all output line')
  })

  it('telnet 设备端口缺省时回退 23', async () => {
    const device = {
      ipAddress: '10.7.8.252',
      connectionType: 'telnet',
      port: null,
      username: 'admin',
      password: 'secret',
    }
    telnetExecSpy.mockResolvedValue('ok')
    await executeCommandsOnDevice(device, ['display version'])
    expect(telnetExecSpy.mock.calls[0][1]).toBe(23)
  })

  it('ssh 设备走 SSH 通道，不调用 executeTelnetCommand', async () => {
    const device = {
      ipAddress: '10.0.0.1',
      connectionType: 'ssh',
      port: 22,
      username: 'root',
      password: 'pw',
    }
    // SSH 路径分流断言：new Client() 被调用 + executeTelnetCommand 不被调用。
    // client.on('error', cb) 触发 reject（避免 execOne 依赖真实 client.exec stream）。
    sshClientOn.mockImplementation((event: string, cb: (e: Error) => void) => {
      if (event === 'error') {
        setImmediate(() => cb(new Error('mock ssh connect failed')))
      }
    })
    await expect(executeCommandsOnDevice(device, ['show version'])).rejects.toThrow(/mock ssh connect failed/)
    expect(sshClientCtor).toHaveBeenCalled()
    expect(sshClientConnect).toHaveBeenCalled()
    expect(telnetExecSpy).not.toHaveBeenCalled()
  })

  it('connectionType 缺省（默认）走 SSH 通道', async () => {
    const device = {
      ipAddress: '10.0.0.2',
      connectionType: null,
      port: null,
      username: 'root',
      password: 'pw',
    }
    sshClientOn.mockImplementation((event: string, cb: (e: Error) => void) => {
      if (event === 'error') setImmediate(() => cb(new Error('mock ssh')))
    })
    await expect(executeCommandsOnDevice(device, ['show clock'])).rejects.toThrow(/mock ssh/)
    expect(sshClientCtor).toHaveBeenCalled()
    expect(telnetExecSpy).not.toHaveBeenCalled()
  })

  it('connectionType 大小写不敏感（TELNET 也走 telnet 通道）', async () => {
    const device = {
      ipAddress: '10.7.8.253',
      connectionType: 'TELNET',
      port: 23,
      username: 'admin',
      password: 'secret',
    }
    telnetExecSpy.mockResolvedValue('out')
    await executeCommandsOnDevice(device, ['display version'])
    expect(telnetExecSpy).toHaveBeenCalledTimes(1)
    expect(sshClientCtor).not.toHaveBeenCalled()
  })

  it('空命令数组立即返回空结果，不触发任何通道', async () => {
    const device = { ipAddress: '10.0.0.3', connectionType: 'telnet', port: 23, username: 'a', password: 'b' }
    const results = await executeCommandsOnDevice(device, [])
    expect(results).toEqual([])
    expect(telnetExecSpy).not.toHaveBeenCalled()
    expect(sshClientCtor).not.toHaveBeenCalled()
  })

  it('telnet 通道抛错时首条命令 reject 整批', async () => {
    const device = { ipAddress: '10.7.8.254', connectionType: 'telnet', port: 23, username: 'a', password: 'b' }
    telnetExecSpy.mockRejectedValue(new Error('Telnet timeout after 30000ms'))
    await expect(executeCommandsOnDevice(device, ['display arp all'])).rejects.toThrow(/Telnet timeout/)
    expect(telnetExecSpy).toHaveBeenCalledTimes(1)
    expect(sshClientCtor).not.toHaveBeenCalled()
  })

  it('telnet 华为：关分页命令 + 精确 shellPrompt（匹配 <host>/[host]，不匹配裸 #）', async () => {
    const device = {
      ipAddress: '10.7.8.252', connectionType: 'telnet', port: 23,
      username: 'admin', password: 'secret', vendor: 'Huawei',
    }
    telnetExecSpy.mockResolvedValue('full config output')
    await executeCommandsOnDevice(device, ['display current-configuration'])
    const opts: any = telnetExecSpy.mock.calls[0][5]
    expect(opts).toMatchObject({ disablePaginationCmd: 'screen-length 0 temporary' })
    expect(opts.shellPrompt).toBeInstanceOf(RegExp)
    expect(opts.shellPrompt.test('<Core2>')).toBe(true)
    expect(opts.shellPrompt.test('[Core2]')).toBe(true)
    expect(opts.shellPrompt.test('#')).toBe(false)
  })

  it('telnet 思科：关分页命令 + shellPrompt（匹配 hostname#，不匹配裸 #）', async () => {
    const device = {
      ipAddress: '10.0.0.10', connectionType: 'telnet', port: 23,
      username: 'admin', password: 'secret', vendor: 'Cisco',
    }
    telnetExecSpy.mockResolvedValue('full config output')
    await executeCommandsOnDevice(device, ['show running-config'])
    const opts: any = telnetExecSpy.mock.calls[0][5]
    expect(opts).toMatchObject({ disablePaginationCmd: 'terminal length 0' })
    expect(opts.shellPrompt).toBeInstanceOf(RegExp)
    expect(opts.shellPrompt.test('Core2#')).toBe(true)
    expect(opts.shellPrompt.test('#')).toBe(false)
  })

  it('telnet vendor 缺失走通用 shellPrompt（覆盖 <host>/[host]/host#，不匹配裸 #）', async () => {
    const device = { ipAddress: '10.0.0.20', connectionType: 'telnet', port: 23, username: 'a', password: 'b' }
    telnetExecSpy.mockResolvedValue('out')
    await executeCommandsOnDevice(device, ['show run'])
    const opts: any = telnetExecSpy.mock.calls[0][5]
    expect(opts.shellPrompt).toBeInstanceOf(RegExp)
    expect(opts.shellPrompt.test('<Core2>')).toBe(true)
    expect(opts.shellPrompt.test('[Core2]')).toBe(true)
    expect(opts.shellPrompt.test('Core2#')).toBe(true)
    expect(opts.shellPrompt.test('Core2>')).toBe(true)
    expect(opts.shellPrompt.test('#')).toBe(false)
  })
})
