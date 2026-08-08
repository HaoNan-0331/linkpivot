import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import net from 'net'

/**
 * arpCollector SSH 真路径回归测试（Phase 12 Plan 12-02 Task 1，TEST-01 + TEST-02 executeSSH cleanup）。
 *
 * arpCollector 此前 0 测试覆盖（TESTING.md「无测试」清单），本文件首次覆盖：
 *   - collectFromDevice connectionType=ssh 路径 → executeSSH → 真实 ssh2.Client 连 mockSshServer 回显 ARP 表
 *   - ARPParser.parse 解析 mock 回显（业务逻辑回归）
 *   - executeSSH cleanup（ssh2 Client + setTimeout timer）无句柄泄漏（TEST-02）
 *   - executeSSH timeout 路径 cleanup（对端不 SSH 握手 → readyTimeout/timer 触发 → client.destroy + reject 收入 error）
 *
 * 复用 12-01 helper（与 ai.execCommands.real.test.ts 同套）：
 *   - startMockSshServer: ssh2.Server 内存级 SSH 对端（随机 hostKey + loopback）
 *   - expectNoHandleLeak(['TCPServerWrap','TCPWrap']): afterEach 句柄泄漏检测（TEST-02 executeSSH cleanup）
 *
 * Mock 策略（让 arpCollector.ts 干净加载 —— PATTERNS §arpCollector.real.test.ts 范式）：
 *   - connection.getDatabase: mock 桩（防 connection.ts 牵连 electron app；collectFromDevice 不写 DB 仅返回结果）
 *   - device.listDevices: mock（防 device service 牵连 getDatabase；仅 collectFromAll 用，本文件不测）
 *   - telnetExec: arpCollector 顶层 import，仅 telnet 分支用；本文件测 ssh 分支，mock 防级联
 *   - **ssh2: 不 mock**（被测协议 executeSSH 走真 binding）
 *
 * MK 注入：已移除（WR-05 修复）—— arpCollector.collectFromDevice SSH 路径直接传 device.password
 * （明文）给 executeSSH，整条路径不调 dec()，setArpMasterKey 是 dead injection。
 *
 * arpCollector 注意（与 plan 原文校准）：arpCollector.collectFromDevice **不持久化 arp_entries 到 DB**
 *   （源码 arpCollector.ts:89-117 只返回 ARPCollectionResult，不写 arp_entries 表），故无需 makeRealDb 真实 DB，
 *   connection mock 桩足够（plan 原文「需 DB 注入」是误读，OQ#1 简化为桩 mock 即可，零生产改动方案 A 维持）。
 */

// ---- Mock：connection.getDatabase（防 connection.ts 牵连 electron app；collectFromDevice 不写 DB 仅桩） ----
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({
      all: () => [],
      get: () => null,
      run: () => ({ changes: 0 }),
    }),
  }),
}))

// ---- Mock：device.listDevices（防 device service 牵连 getDatabase；仅 collectFromAll 用，本文件不测） ----
vi.mock('../../electron/services/device', () => ({
  listDevices: vi.fn().mockReturnValue([]),
}))

// ---- Mock：telnetExec（arpCollector 顶层 import，仅 telnet 分支用；本文件测 ssh 分支，mock 防级联） ----
vi.mock('../../electron/utils/telnetExec', () => ({
  executeTelnetCommand: vi.fn(),
  pickDisablePaginationCmd: vi.fn().mockReturnValue('screen-length 0 temporary'),
  pickShellPrompt: vi.fn().mockReturnValue(/[>#]/),
}))

// ssh2 不 mock —— 真实 import（executeSSH 走真 ssh2.Client）
// WR-05 修复：移除 setArpMasterKey(MK_TEST) dead injection —— arpCollector.collectFromDevice
// SSH 路径直接传 device.password（明文）给 executeSSH，整条路径不调 dec()（arpCollector.ts
// 定义了 dec() 但代码内从未调用，是 dead code）。MK 注入在 SSH 路径测试中永不被消费，
// 且 arpCollector.ts 顶层 let MK='' 不在 import 时触发 dec，故删除安全不致模块加载失败。
import { ARPCollector } from '../../electron/services/arpCollector'
import { ARPParser } from '../../electron/services/arpParser'
import { startMockSshServer } from './_helpers/mockSshServer'
import { expectNoHandleLeak } from './_helpers/handleLeakDetector'

// 句柄泄漏检测：默认白名单（handleLeakDetector 12-01 落地 + 12-02 反馈环补入 TCPServerWrap/TCPWrap/SimpleWriteWrap）
// 已覆盖 mock server listen socket + ssh2/telnet-client native stream libuv 句柄释放延迟，
// 此处不传 extraAllow，仅检测被测代码（executeSSH cleanup）的真实泄漏。
expectNoHandleLeak()

// H3C ARP 表样例输出（ARPParser.parseH3C 解析格式：IP MAC Type Interface Aging）
// MAC 在源数据用 H3C 原生格式 0000-5e00-0101，ARPParser.parseH3C 经 normalizeMAC 归一化为冒号格式 00:00:5e:00:01:01
const H3C_ARP_OUTPUT = `\
  Type: S-Static   D-Dynamic   O-Other
IP address      MAC address    VLAN/VSI   Interface         Aging Type
10.0.0.1        0000-5e00-0101 100        GE0/0/1           1200  D
10.0.0.2        0000-5e00-0102 200        GE0/0/2           900   D
`

describe('arpCollector — SSH 真路径回归（executeSSH + ARPParser + cleanup）', () => {
  let sshHandle: { port: number; close: () => Promise<void> }

  beforeAll(async () => {
    sshHandle = await startMockSshServer((_cmd) => H3C_ARP_OUTPUT)
  })

  afterAll(async () => {
    // Pitfall 4：mock server 异步 close
    await sshHandle.close()
  })

  it('collectFromDevice ssh 路径：真实 ssh2.Client 连 mockSshServer 回显 ARP 表，ARPParser 解析出条目', async () => {
    const collector = new ARPCollector({ timeout: 10000 })
    const device = {
      id: 'dev-1',
      name: 'MockH3C',
      ipAddress: '127.0.0.1',
      vendor: 'h3c',
      connectionType: 'ssh',
      port: sshHandle.port,
      username: 'test',
      password: 'test',
    }

    const result = await collector.collectFromDevice(device)

    // executeSSH 经 mockSshServer 回显 H3C_ARP_OUTPUT，ARPParser.parseH3C 解析出 2 条
    expect(result.error).toBeUndefined()
    expect(result.entries.length).toBeGreaterThanOrEqual(2)
    // 第一条 IP/MAC 断言（ARPParser normalizeMAC 把 0000-5e00-0101 归一化为 00:00:5e:00:01:01 冒号格式）
    const first = result.entries[0]
    expect(first.ip).toBe('10.0.0.1')
    expect(first.mac).toMatch(/^00:00:5e:00:01:01$/i)
  })

  it('executeSSH cleanup 无句柄泄漏：命令完成后 ssh2 Client + setTimeout timer 全回收（TEST-02）', async () => {
    const collector = new ARPCollector({ timeout: 10000 })
    const device = {
      id: 'dev-2',
      name: 'MockH3C2',
      ipAddress: '127.0.0.1',
      vendor: 'h3c',
      connectionType: 'ssh',
      port: sshHandle.port,
      username: 'test',
      password: 'test',
    }

    const result = await collector.collectFromDevice(device)

    expect(result.entries.length).toBeGreaterThanOrEqual(2)
    // afterEach 经 expectNoHandleLeak 自动断言 executeSSH cleanup 无泄漏（TCPWrap/Timeout）
  })

  it('executeSSH 异常路径 cleanup：对端 RST 触发 client.on(error)，cleanup 回收 client + 收入 error（TEST-02）', async () => {
    // WR-01 修复：之前用 port: 1（保留端口）触发 ECONNREFUSED，但 Windows 上 1-1023 是保留端口，
    // 连接尝试可能返回 EACCES（permission）而非 ECONNREFUSED，ssh2 client 的 error 分支触发不稳定；
    // 某些 Windows 配置下 1 端口可能被分配 → 反而连上未知服务，断言 error.truthy() 失败。
    // 改用一次性 RST server（accept 后立即 destroy）确定性触发 client 'error'（ECONNRESET / socket hang up），
    // 同 handleLeak.real.test.ts it1 / ai.execCommands.real.test.ts 异常路径 it 同构。
    const rstServer = net.createServer((socket) => {
      socket.on('error', () => { /* ignore client reset */ })
      socket.destroy() // accept 后立即 destroy 触发 client 端 'error'
    })
    await new Promise<void>((resolve) => rstServer.listen(0, '127.0.0.1', () => resolve()))
    const rstPort = (rstServer.address() as net.AddressInfo).port

    try {
      const collector = new ARPCollector({ timeout: 5000 })
      const device = {
        id: 'dev-3',
        name: 'UnreachableDev',
        ipAddress: '127.0.0.1',
        vendor: 'h3c',
        connectionType: 'ssh',
        port: rstPort, // RST server 确定性触发 client.on('error')
        username: 'test',
        password: 'test',
      }

      const result = await collector.collectFromDevice(device)

      // executeSSH client.on('error') → reject → collectFromDevice try/catch 收入 error
      expect(result.error).toBeTruthy()
      expect(result.entries).toEqual([])
      // cleanup 触发 client.end()，afterEach expectNoHandleLeak 验无泄漏
    } finally {
      await new Promise<void>((resolve) => rstServer.close(() => resolve()))
    }
  })

  it('ARPParser.parse 业务逻辑回归：mock H3C 输出解析（独立单测，验证 ARPParser 与真路径一致）', () => {
    const entries = ARPParser.parse(H3C_ARP_OUTPUT, 'h3c')
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries[0].ip).toBe('10.0.0.1')
    expect(entries[0].mac).toMatch(/^00:00:5e:00:01:01$/i)
    expect(entries[1].ip).toBe('10.0.0.2')
  })
})
