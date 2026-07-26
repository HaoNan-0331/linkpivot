import { describe, it, expect } from 'vitest'
import { isCommandAllowed } from '../../electron/services/commandSafety'

// 安全核心回归网（审计 R5 / TEST-1）：commandSafety 是命令白名单执行层最后防线，
// 改一行可能放行 reboot 而无拦截。纯函数无 DB/electron 依赖，可纯 node 测。
const WL = ['display', 'show', 'ping', 'terminal', 'traceroute']

describe('commandSafety isCommandAllowed', () => {
  // —— 白名单首词严格相等匹配（非前缀子串）——
  it('allows whitelist first word exact match', () => {
    expect(isCommandAllowed('display version', WL).allowed).toBe(true)
    expect(isCommandAllowed('show interface', WL).allowed).toBe(true)
    expect(isCommandAllowed('ping 8.8.8.8', WL).allowed).toBe(true)
  })

  it('rejects prefix-only first word (strict equality, not substring)', () => {
    expect(isCommandAllowed('displayxyz version', WL).allowed).toBe(false)
    expect(isCommandAllowed('showmore', WL).allowed).toBe(false)
  })

  it('rejects first word not in whitelist', () => {
    expect(isCommandAllowed('telnet 10.0.0.1', WL).allowed).toBe(false)
  })

  // —— 多命令 / shell 注入分隔符 ——
  it('rejects newline injection', () => {
    expect(isCommandAllowed('display version\nreboot', WL).allowed).toBe(false)
  })

  it('rejects semicolon', () => {
    expect(isCommandAllowed('show int; reload', WL).allowed).toBe(false)
  })

  it('rejects && and ||', () => {
    expect(isCommandAllowed('show int && reboot', WL).allowed).toBe(false)
    expect(isCommandAllowed('show int || reboot', WL).allowed).toBe(false)
  })

  it('rejects backtick and $() command substitution', () => {
    expect(isCommandAllowed('show `reboot`', WL).allowed).toBe(false)
    expect(isCommandAllowed('show $(reboot)', WL).allowed).toBe(false)
  })

  it('rejects & background operator', () => {
    expect(isCommandAllowed('show int& reboot', WL).allowed).toBe(false)
  })

  // —— 管道豁免（华为/Cisco | include 只读过滤不误杀）——
  it('preserves single pipe for vendor CLI filtering (| include)', () => {
    expect(isCommandAllowed('display version | include Software', WL).allowed).toBe(true)
    expect(isCommandAllowed('show interface | include Ethernet', WL).allowed).toBe(true)
  })

  // —— 黑名单首词（优先于白名单）——
  it('rejects blocked first words (change/config-view commands)', () => {
    const blocked = ['reboot', 'reload', 'shutdown', 'configure', 'config', 'delete', 'erase', 'reset', 'system-view', 'system', 'interface', 'vlan', 'save', 'write', 'commit', 'undo', 'no']
    for (const w of blocked) {
      expect(isCommandAllowed(w, WL).allowed, `应拒绝黑名单首词: ${w}`).toBe(false)
    }
  })

  it('blocks "no" first word (disables interface)', () => {
    expect(isCommandAllowed('no shutdown', WL).allowed).toBe(false)
  })

  // —— 边界 ——
  it('rejects empty command', () => {
    expect(isCommandAllowed('', WL).allowed).toBe(false)
    expect(isCommandAllowed('   ', WL).allowed).toBe(false)
  })

  it('case insensitive and trims whitespace', () => {
    expect(isCommandAllowed('  DISPLAY  version  ', WL).allowed).toBe(true)
  })

  it('returns reason string', () => {
    expect(isCommandAllowed('reboot', WL).reason).toMatch(/变更命令|reboot/)
    expect(isCommandAllowed('display version', WL).reason).toContain('白名单')
  })
})
