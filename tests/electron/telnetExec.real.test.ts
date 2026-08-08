import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import net from 'net'

/**
 * Telnet 真路径回归测试（Phase 12 Plan 12-02 Task 2，TEST-01 telnet 部分 + TEST-02 finally cleanup）。
 *
 * telnetExec 此前 0 测试覆盖（TESTING.md「无测试」清单），本文件首次覆盖：
 *   - executeTelnetCommand 正常路径：真实 telnet-client 连 mockTelnetServer echo 回显
 *   - finally cleanup 无句柄泄漏（TEST-02 第四条 cleanup 路径：clearTimeout + connection.end/destroy）
 *   - timeout 路径 cleanup（对端不响应 → finally destroy + reject Telnet timeout）
 *   - pickDisablePaginationCmd / pickShellPrompt vendor 分流（业务逻辑回归）
 *
 * 与 ai.telnetRouting.test.ts 的关键差异（PATTERNS §telnetExec.real.test.ts 反向范式）：
 *   - ai.telnetRouting.test.ts: vi.mock('../utils/telnetExec', importActual+spy)，测 ai 分流逻辑
 *   - 本文件（真路径）: **不 vi.mock telnetExec**（测 telnetExec 本体），也不 vi.mock telnet-client
 *     （用真实 Telnet 连 mockTelnetServer，覆盖 connect+exec+finally cleanup 全链路真实回显）
 *
 * 复用 12-01 helper：
 *   - startMockTelnetServer: net.Server telnet echo + IAC 协商响应（识别 0xFF 回 DONT/WONT）
 *   - expectNoHandleLeak(['TCPServerWrap','TCPWrap']): afterEach 句柄泄漏检测（TEST-02 finally cleanup）
 *
 * telnet IAC checkpoint（RESEARCH + PATTERNS + 12-01 SUMMARY 标记未完全展开）：
 *   本文件连真实 telnet-client 实跑，验证 mockTelnetServer 的 IAC 协商响应（DONT/WONT）+ login/password 提示流程
 *   是否能让 telnet-client connect 不卡住。若 connect 卡住超 testTimeout，回 12-01 修 mockTelnetServer IAC/login 流程。
 *
 * telnet-client connect 配置（telnetExec.ts:129-135）需 mockTelnetServer 配合：
 *   - loginPrompt: /Username:|login:/i —— server 须发 "Username:" 提示
 *   - passwordPrompt: /Password:/i —— server 须发 "Password:" 提示
 *   - shellPrompt: /[>#]/ 或 vendor picker —— server 须发 shell prompt
 *   当前 12-01 mockTelnetServer 只发 shellPrompt + 命令回显，不发 login/password 提示 ——
 *   本 task 实跑暴露此 gap，若卡住回 12-01 修 mockTelnetServer（反馈环，加 login/password 状态机）。
 */

import { executeTelnetCommand, pickDisablePaginationCmd, pickShellPrompt } from '../../electron/utils/telnetExec'
import { startMockTelnetServer } from './_helpers/mockTelnetServer'
import { expectNoHandleLeak } from './_helpers/handleLeakDetector'

// 句柄泄漏检测：默认白名单（handleLeakDetector 12-01 落地 + 12-02 反馈环补入 TCPServerWrap/TCPWrap/SimpleWriteWrap）
// 已覆盖 mock server listen socket + ssh2/telnet-client native stream libuv 句柄释放延迟，
// 此处不传 extraAllow，仅检测被测代码（executeTelnetCommand finally cleanup）的真实泄漏。
expectNoHandleLeak()

describe('executeTelnetCommand — telnet 真路径回归（finally cleanup + IAC 协商）', () => {
  let telnetHandle: { port: number; close: () => Promise<void> }

  beforeAll(async () => {
    telnetHandle = await startMockTelnetServer((cmd) => {
      if (cmd.includes('show version')) return 'Version 1.0-mock'
      if (cmd.includes('show clock')) return '2026-08-08 10:00:00'
      return `unknown: ${cmd}`
    }, 'mock#')
  })

  afterAll(async () => {
    // Pitfall 4：mock server 异步 close
    await telnetHandle.close()
  })

  it('telnet 正常路径：真实 telnet-client 连 mockTelnetServer echo 回显命令输出', async () => {
    const output = await executeTelnetCommand(
      '127.0.0.1', telnetHandle.port,
      'test', 'test',
      'show version',
      { timeout: 8000, shellPrompt: /mock#/ }
    )

    // telnet-client connect（IAC 协商 + login/password/shellPrompt）+ exec 回显
    expect(output).toContain('Version 1.0-mock')
  })

  it('finally cleanup 无句柄泄漏：命令完成后 telnet-client Telnet 实例 + setTimeout timer 全回收（TEST-02）', async () => {
    const output = await executeTelnetCommand(
      '127.0.0.1', telnetHandle.port,
      'test', 'test',
      'show clock',
      { timeout: 8000, shellPrompt: /mock#/ }
    )

    expect(output).toContain('2026-08-08 10:00:00')
    // afterEach 经 expectNoHandleLeak 自动断言 finally cleanup（clearTimer + connection.end）无泄漏
  })

  it('timeout 路径 cleanup：对端不发 shellPrompt + 短 timeout 触发 finally connection.destroy + reject Telnet timeout', async () => {
    // 起一个裸 net.Server：accept TCP 但不发任何数据（不发 shellPrompt/loginPrompt），
    // telnet-client connect 等不到 shellPrompt → executeTelnetCommand 外层 setTimeout(500) 兜底触发 reject。
    // 验证 finally cleanup（clearTimeout + connection.destroy）句柄回收（TEST-02 第四条 cleanup 路径）。
    const silentServer = net.createServer((socket) => {
      // 故意不写任何数据，socket 保持打开但不发 prompt
      socket.on('error', () => { /* ignore client reset on destroy */ })
    })
    await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', () => resolve()))
    const silentPort = (silentServer.address() as net.AddressInfo).port

    try {
      await expect(
        executeTelnetCommand(
          '127.0.0.1', silentPort,
          'test', 'test',
          'show version',
          { timeout: 500, shellPrompt: /silent#/ }
        )
      ).rejects.toThrow(/timeout/i)
      // finally cleanup: clearTimeout + connection.destroy，afterEach expectNoHandleLeak 验无泄漏
    } finally {
      await new Promise<void>((resolve) => silentServer.close(() => resolve()))
    }
  })

  it('pickDisablePaginationCmd vendor 分流：cisco/锐捷 → terminal length 0，华为/H3C/默认 → screen-length 0 temporary', () => {
    expect(pickDisablePaginationCmd('cisco')).toBe('terminal length 0')
    expect(pickDisablePaginationCmd('Cisco')).toBe('terminal length 0')
    expect(pickDisablePaginationCmd('ruijie')).toBe('terminal length 0')
    expect(pickDisablePaginationCmd('huawei')).toBe('screen-length 0 temporary')
    expect(pickDisablePaginationCmd('h3c')).toBe('screen-length 0 temporary')
    expect(pickDisablePaginationCmd(undefined)).toBe('screen-length 0 temporary')
    expect(pickDisablePaginationCmd(null)).toBe('screen-length 0 temporary')
  })

  it('pickShellPrompt vendor 分流：华为/H3C 匹配 <host>/[host] 不匹配裸 #，思科匹配 hostname#', () => {
    const huaweiPrompt = pickShellPrompt('huawei')
    expect(huaweiPrompt.test('<Core>')).toBe(true)
    expect(huaweiPrompt.test('[Core]')).toBe(true)
    expect(huaweiPrompt.test('#')).toBe(false)

    const ciscoPrompt = pickShellPrompt('cisco')
    expect(ciscoPrompt.test('Core#')).toBe(true)
    expect(ciscoPrompt.test('#')).toBe(false)

    const defaultPrompt = pickShellPrompt(undefined)
    expect(defaultPrompt.test('<Core>')).toBe(true)
    expect(defaultPrompt.test('Core#')).toBe(true)
  })
})
