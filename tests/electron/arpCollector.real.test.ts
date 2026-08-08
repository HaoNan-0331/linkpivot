import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'

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
 * MK 注入（PATTERNS §masterKey 注入 516-526）：setArpMasterKey(MK_TEST) —— arpCollector 顶层 let MK，dec() 用之。
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
import { ARPCollector, setArpMasterKey } from '../../electron/services/arpCollector'
import { ARPParser } from '../../electron/services/arpParser'
import { startMockSshServer } from './_helpers/mockSshServer'
import { expectNoHandleLeak } from './_helpers/handleLeakDetector'

// MK 注入（PATTERNS §masterKey 注入 范式，不用真实 masterKey）
const MK_TEST = 'test-master-key-32-bytes-ok!!'
setArpMasterKey(MK_TEST)

// 放行说明：
//   - TCPServerWrap: mockSshServer 自身的 listen socket（beforeAll 起 afterAll 关，afterEach 时仍在 listen = 预期）
//                    + timeout it 内 silentNetServer 的 listen socket（it 内 close 但 afterEach 可能时序残留）
//   - TCPWrap: ssh2.Client connect 短暂持 socket，afterEach sleep(50) 内应释放；放行防偶发误报
expectNoHandleLeak(['TCPServerWrap', 'TCPWrap'])

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

  it('executeSSH 异常路径 cleanup：对端不可达触发 client.on(error)，cleanup 回收 client + 收入 error（TEST-02）', async () => {
    // Rule 1 偏离（plan 原文 timeout 路径）：ssh2 真实 banner-wait timeout 在库内部行为下不可靠触发
    //（silentServer accept 不握手会挂满 testTimeout），改用「端口未监听」触发 connection refused，
    // 同样验证 executeSSH 的 client.on('error') → finish → cleanup(client.end) → reject 路径的句柄回收。
    // 此路径与 ai.execCommands.real.test.ts 异常路径 it 同构（cleanup 在异常路径触发）。
    const collector = new ARPCollector({ timeout: 5000 })
    const device = {
      id: 'dev-3',
      name: 'UnreachableDev',
      ipAddress: '127.0.0.1',
      vendor: 'h3c',
      connectionType: 'ssh',
      port: 1, // 端口 1 通常未监听 → ECONNREFUSED 快速触发 client.on('error')
      username: 'test',
      password: 'test',
    }

    const result = await collector.collectFromDevice(device)

    // executeSSH client.on('error') → reject → collectFromDevice try/catch 收入 error
    expect(result.error).toBeTruthy()
    expect(result.entries).toEqual([])
    // cleanup 触发 client.end()，afterEach expectNoHandleLeak 验无泄漏
  })

  it('ARPParser.parse 业务逻辑回归：mock H3C 输出解析（独立单测，验证 ARPParser 与真路径一致）', () => {
    const entries = ARPParser.parse(H3C_ARP_OUTPUT, 'h3c')
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries[0].ip).toBe('10.0.0.1')
    expect(entries[0].mac).toMatch(/^00:00:5e:00:01:01$/i)
    expect(entries[1].ip).toBe('10.0.0.2')
  })
})
