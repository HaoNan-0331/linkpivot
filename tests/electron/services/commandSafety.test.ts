import { describe, it, expect, vi } from 'vitest'

/**
 * Phase 23（23-03 复验反馈）：服务器类设备命令适配 —— 白名单扩域回归。
 *
 * 覆盖：
 * - 服务器只读第一批命令全放行（uname/hostnamectl/uptime/df/free/ps/ip/netstat/ss/ifconfig）
 * - 危险与注入仍拒：reboot 黑名单、分隔符注入、sudo 前缀、排除项（cat/top/systemctl）
 * - init.ts 默认白名单种子含服务器命令（INSERT OR IGNORE 新 id 对存量库可增量补种）
 * - promptRegistry 命令风格指引条目存在（ai.chat.cmdStyle）
 */

import { isCommandAllowed } from '../../../electron/services/commandSafety'

// init 种子测试用 mock：模块级变量（vi.mock 工厂闭包不能引用局部 let）
import Database from 'better-sqlite3'
const initDb = new Database(':memory:')
vi.mock('../../../electron/database/connection', () => ({ getDatabase: () => initDb }))
vi.mock('../../../electron/services/systemLog', () => ({ createSystemLog: vi.fn() }))

const SERVER_WL = [
  'uname', 'hostnamectl', 'uptime', 'df', 'free', 'ps', 'ip', 'netstat', 'ss', 'ifconfig',
]

describe('commandSafety 服务器只读命令扩域（Phase 23 23-03 复验反馈）', () => {
  it('服务器只读命令全放行（含常见参数形态）', () => {
    const cases = [
      'uname -a', 'uname -r', 'hostnamectl', 'uptime', 'df -h', 'df',
      'free -m', 'free', 'ps aux', 'ps -ef', 'ip addr', 'ip route',
      'netstat -an', 'ss -tlnp', 'ifconfig',
    ]
    for (const c of cases) {
      expect(isCommandAllowed(c, SERVER_WL), c).toEqual(
        expect.objectContaining({ allowed: true })
      )
    }
  })

  it('大小写不敏感：UNAME / HostnameCtl 同样放行', () => {
    expect(isCommandAllowed('UNAME -A', SERVER_WL).allowed).toBe(true)
    expect(isCommandAllowed('HostnameCtl', SERVER_WL).allowed).toBe(true)
  })

  it('危险首词仍黑名单：reboot / reload 拒绝', () => {
    expect(isCommandAllowed('reboot', SERVER_WL).allowed).toBe(false)
    expect(isCommandAllowed('reload', SERVER_WL).allowed).toBe(false)
  })

  it('分隔符注入仍拦：uname; reboot / df && rm -rf / uname $(reboot)', () => {
    for (const c of ['uname; reboot', 'df && rm -rf /', 'uname $(reboot)', 'uptime\nreboot', 'free `reboot`', 'ss ; reboot']) {
      expect(isCommandAllowed(c, SERVER_WL).allowed, c).toBe(false)
    }
  })

  it('sudo 前缀拒绝（首词 sudo 不在白名单）', () => {
    expect(isCommandAllowed('sudo uname -a', SERVER_WL).allowed).toBe(false)
    expect(isCommandAllowed('sudo reboot', SERVER_WL).allowed).toBe(false)
  })

  it('排除项不放行：cat（任意文件读）/ top（交互式）/ systemctl（首词连带变更子命令）', () => {
    for (const c of ['cat /etc/shadow', 'top', 'vi /etc/passwd', 'less /etc/hosts', 'systemctl status nginx']) {
      expect(isCommandAllowed(c, SERVER_WL).allowed, c).toBe(false)
    }
  })

  it('网络设备白名单语义零回归：show/display 放行、system-view 仍拒', () => {
    const netWl = ['display', 'show', 'ping', 'traceroute']
    expect(isCommandAllowed('show version', netWl).allowed).toBe(true)
    expect(isCommandAllowed('display version', netWl).allowed).toBe(true)
    expect(isCommandAllowed('system-view', netWl).allowed).toBe(false)
  })

  it('扩域默认种子：init.ts createTables 后 command_whitelist 含服务器命令', async () => {
    const { createTables } = await import('../../../electron/database/init')
    createTables()
    const rows = initDb.prepare('SELECT pattern FROM command_whitelist').all() as any[]
    const patterns = rows.map((r) => r.pattern)
    for (const p of SERVER_WL) {
      expect(patterns, p).toContain(p)
    }
    // 既有网络设备种子不回退
    for (const p of ['display', 'show', 'ping', 'traceroute']) {
      expect(patterns, p).toContain(p)
    }
  })

  it('命令风格指引条目存在：ai.chat.cmdStyle 覆盖服务器/网络设备双风格', async () => {
    const { PROMPT_REGISTRY } = await import('../../../electron/services/promptRegistry')
    const entry = PROMPT_REGISTRY.find((e) => e.id === 'ai.chat.cmdStyle')
    expect(entry).toBeDefined()
    expect(entry!.content).toMatch(/服务器/)
    expect(entry!.content).toMatch(/uname|hostnamectl/)
    expect(entry!.content).toMatch(/show|display/)
  })
})
