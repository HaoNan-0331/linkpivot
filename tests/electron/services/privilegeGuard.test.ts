import { describe, it, expect } from 'vitest'

/**
 * Phase 27（27-01）privilegeGuard 越权检测层 —— RED 攻击矩阵 + 白例矩阵（GUARD-06/SC5）。
 *
 * 覆盖 RESEARCH §RED 矩阵 R3~R17/R19 与白例矩阵（防确认疲劳，同等强制）。
 * 纯函数测试：零 DB 零 MK，设备清单入参注入（Pitfall 7）。
 * token 化经 tokenizeCommand（单一来源，T-27-04）——测试输入直接用原始命令文本。
 */

import {
  checkCommand,
  checkMcpArgs,
  JUMP_FIRST_WORDS,
  PROBE_EXEMPT,
  type GuardDeviceRef,
} from '../../../electron/services/privilegeGuard'
import { tokenizeCommand } from '../../../electron/services/commandSafety'

const A: GuardDeviceRef = { id: 'a', name: 'access-sw-a', ipAddress: '10.1.1.1' }
const B: GuardDeviceRef = { id: 'b', name: 'Core-SW1', ipAddress: '10.1.1.5' }
const SET: GuardDeviceRef[] = [A, B]

function guard(command: string, current: GuardDeviceRef = A, set: GuardDeviceRef[] = SET) {
  const tokens = tokenizeCommand(command)
  return checkCommand({ firstWord: tokens[0] ?? '', tokens, currentDevice: current, conversationSet: set })
}

describe('D-02：硬编码清单常量（无设置页可配入口）', () => {
  it('JUMP_FIRST_WORDS 含 ssh/telnet/ftp/sftp/scp/slogin/rlogin/rsh，不含 console', () => {
    for (const w of ['ssh', 'telnet', 'ftp', 'sftp', 'scp', 'slogin', 'rlogin', 'rsh']) {
      expect(JUMP_FIRST_WORDS.has(w), w).toBe(true)
    }
    expect(JUMP_FIRST_WORDS.has('console')).toBe(false)
  })

  it('PROBE_EXEMPT 含 ping/tracert/traceroute（arp/nslookup 冗余无害）', () => {
    for (const w of ['ping', 'tracert', 'traceroute']) {
      expect(PROBE_EXEMPT.has(w), w).toBe(true)
    }
  })
})

describe('RED 攻击矩阵 R3~R17/R19', () => {
  it('R3：裸变量 fail-closed —— ssh $TARGET 红 / ping ${h} / ping %srv% 黄', () => {
    const h1 = guard('ssh $TARGET')
    expect(h1).toHaveLength(1)
    expect(h1[0].ruleId).toBe('GUARD-02')
    expect(h1[0].level).toBe('red')

    const h2 = guard('ping ${h}')
    expect(h2).toHaveLength(1)
    expect(h2[0].ruleId).toBe('GUARD-01')
    expect(h2[0].level).toBe('yellow')

    const h3 = guard('ping %srv%')
    expect(h3).toHaveLength(1)
    expect(h3[0].ruleId).toBe('GUARD-01')
    expect(h3[0].level).toBe('yellow')
  })

  it('R4：十进制 IP 还原 —— ssh 16843009（=1.1.1.1）红；ping 100 不还原（阈值防假阳性）', () => {
    const h1 = guard('ssh 16843009')
    expect(h1[0].ruleId).toBe('GUARD-02')
    expect(h1[0].level).toBe('red')
    expect(h1[0].explanation).toContain('1.1.1.1')

    expect(guard('ping 100')).toEqual([])
  })

  it('R5：十六进制 IP —— ssh 0x0A010105 还原 10.1.1.5 红', () => {
    const h = guard('ssh 0x0A010105')
    expect(h[0].ruleId).toBe('GUARD-02')
    expect(h[0].level).toBe('red')
    // 还原为 10.1.1.5（恰为 B 的 IP → 文案按库内设备名给出，两者任一）
    expect(h[0].explanation).toMatch(/10\.1\.1\.5|Core-SW1/)
  })

  it('R6：前导 0 段按八进制还原 —— ping 010.001.001.005 → 8.1.1.5 黄（行为断言锁定）', () => {
    const h = guard('ping 010.001.001.005')
    expect(h).toHaveLength(1)
    expect(h[0].ruleId).toBe('GUARD-01')
    expect(h[0].level).toBe('yellow')
    expect(h[0].explanation).toContain('8.1.1.5')
  })

  it('R7：大小写主机名 —— SSH Core-SW1 归一化后匹配已知设备 B 红', () => {
    const h = guard('SSH Core-SW1')
    expect(h[0].ruleId).toBe('GUARD-02')
    expect(h[0].level).toBe('red')
    expect(h[0].explanation).toContain('Core-SW1')
  })

  it('R8：Unicode 同形 —— ssh Ｃore‑sw1（全角Ｃ + U+2011）仍红（fail-closed）', () => {
    const h = guard('ssh Ｃore‑sw1')
    expect(h).toHaveLength(1)
    expect(h[0].ruleId).toBe('GUARD-02')
    expect(h[0].level).toBe('red')
  })

  it('R9：user@host —— ssh admin@10.1.1.5 拆 @ 取 host 红', () => {
    const h = guard('ssh admin@10.1.1.5')
    expect(h[0].ruleId).toBe('GUARD-02')
    expect(h[0].level).toBe('red')
  })

  it('R10：host:port / URI —— telnet 10.1.1.5:23 与 ssh://x@y 均红', () => {
    const h1 = guard('telnet 10.1.1.5:23')
    expect(h1[0].ruleId).toBe('GUARD-02')
    expect(h1[0].level).toBe('red')

    const h2 = guard('ssh://x@y')
    expect(h2).toHaveLength(1)
    expect(h2[0].ruleId).toBe('GUARD-02')
    expect(h2[0].level).toBe('red')
  })

  it('R11：词界逃逸 —— ping 10.1.1.5x 整 token 不匹配 10.1.1.5；ping 10.1.1.50 不误命中 B', () => {
    const h1 = guard('ping 10.1.1.5x')
    expect(h1).toHaveLength(1)
    expect(h1[0].ruleId).toBe('GUARD-01')
    // 整 token 匹配：不得把 10.1.1.5x 当作 B（10.1.1.5）豁免放行，也不得红级误判跳转
    expect(h1[0].explanation).not.toContain('Core-SW1')

    const h2 = guard('ping 10.1.1.50')
    expect(h2).toHaveLength(1)
    expect(h2[0].ruleId).toBe('GUARD-01')
    expect(h2[0].level).toBe('yellow')
  })

  it('R12：IPv6 —— ssh fe80::1 含 : → unresolvable → 红 fail-closed', () => {
    const h = guard('ssh fe80::1')
    expect(h[0].ruleId).toBe('GUARD-02')
    expect(h[0].level).toBe('red')
  })

  it('R13：集内但非当前（跳转）—— 对话集 {A,B}，在 A 上 ssh B 红（无集内豁免，SC2）', () => {
    expect(guard('ssh 10.1.1.5')[0].ruleId).toBe('GUARD-02')
    expect(guard('ssh core-sw1')[0].level).toBe('red')
  })

  it('R14：集内探测豁免 —— 在 A 上 ping B（IP/名）返回空数组放行', () => {
    expect(guard('ping 10.1.1.5')).toEqual([])
    expect(guard('ping Core-SW1')).toEqual([])
  })

  it('R15：公网探测 —— ping baidu.com / ping 8.8.8.8 黄 GUARD-01（确认即执行）', () => {
    for (const c of ['ping baidu.com', 'ping 8.8.8.8']) {
      const h = guard(c)
      expect(h, c).toHaveLength(1)
      expect(h[0].ruleId).toBe('GUARD-01')
      expect(h[0].level).toBe('yellow')
    }
    // 公网文案差异（内网/公网人话解释）
    expect(guard('ping 8.8.8.8')[0].explanation).toContain('公网')
  })

  it('R16：MCP args 夹带 —— {"target":"10.1.1.5"} 绑定 A → 红 GUARD-03', () => {
    const hits = checkMcpArgs({ target: '10.1.1.5' }, A, SET)
    expect(hits).toHaveLength(1)
    expect(hits[0].ruleId).toBe('GUARD-03')
    expect(hits[0].level).toBe('red')
  })

  it('R17：MCP args 变量 —— {"target":"$other"} → 黄 GUARD-03 fail-closed', () => {
    const hits = checkMcpArgs({ target: '$other' }, A, SET)
    expect(hits).toHaveLength(1)
    expect(hits[0].ruleId).toBe('GUARD-03')
    expect(hits[0].level).toBe('yellow')
  })

  it('R19：hosts 别名 —— ssh core-sw 无匹配 → 红 fail-closed（保守正确）', () => {
    const h = guard('ssh core-sw')
    expect(h).toHaveLength(1)
    expect(h[0].ruleId).toBe('GUARD-02')
    expect(h[0].level).toBe('red')
  })

  it('选项参数跳过：ssh -l admin 10.1.1.5 仍取 10.1.1.5 为目标 → 红', () => {
    const h = guard('ssh -l admin 10.1.1.5')
    expect(h).toHaveLength(1)
    expect(h[0].ruleId).toBe('GUARD-02')
    expect(h[0].level).toBe('red')
  })

  it('跳转到当前执行设备自身（IP/名）放行（决策表第 1 行）', () => {
    expect(guard('ssh 10.1.1.1')).toEqual([])
    expect(guard('ssh Access-SW-A')).toEqual([])
  })
})

describe('白例矩阵（零弹窗，防确认疲劳——同等强制）', () => {
  it('常见只读运维命令零命中', () => {
    for (const c of [
      'display version',
      'display interface brief',
      'show ip route',
      'ps aux',
      'df -h',
      'uname -a',
    ]) {
      expect(guard(c), c).toEqual([])
    }
  })

  it('在 A 上 ping A 自身 IP 放行', () => {
    expect(guard('ping 10.1.1.1')).toEqual([])
  })

  it('MCP 只读工具正常 args 零命中（含嵌套结构）', () => {
    expect(checkMcpArgs({ iface: 'eth0', count: '4' }, A, SET)).toEqual([])
    expect(
      checkMcpArgs({ path: '/etc/hosts', opts: { verbose: 'true', timeout: '30' } }, A, SET)
    ).toEqual([])
    expect(checkMcpArgs({ list: ['eth0', '10'] }, A, SET)).toEqual([])
  })

  it('MCP args 词界：10.1.1.50 不误命中绑定外判定（非精确整 token 匹配）', () => {
    // 10.1.1.50 不精确命中任何已知设备（B=10.1.1.5），且非 unresolvable → 零命中
    expect(checkMcpArgs({ target: '10.1.1.50' }, A, SET)).toEqual([])
  })
})
