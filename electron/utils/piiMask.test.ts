import { describe, it, expect } from 'vitest'
import {
  maskConversationText,
  maskCredentials,
  maskIpv4,
  maskMac,
} from './piiMask'

/**
 * PII 脱敏 util 单测（Phase 8 D-04）。
 * 纯字符串 transform，无 DB / 无加密依赖，直接断言输入→输出。
 */

describe('maskCredentials（凭证全脱敏）', () => {
  it('password: admin123 → password: ****', () => {
    expect(maskCredentials('password: admin123')).toBe('password: ****')
  })

  it('密码=Abc!23 → 密码=****（中文关键词 + 等号分隔）', () => {
    expect(maskCredentials('密码=Abc!23')).toBe('密码=****')
  })

  it('api_key: sk-xxx → api_key: ****（含下划线关键词）', () => {
    expect(maskCredentials('api_key: sk-xxx')).toBe('api_key: ****')
  })

  it('username admin password p@ss → 仅 password 值脱敏，username 不误伤', () => {
    expect(maskCredentials('username admin password p@ss')).toBe('username admin password ****')
  })

  it('引号包裹的值整体脱敏：token: "abc def"', () => {
    expect(maskCredentials('token: "abc def"')).toBe('token: ****')
  })

  it('无凭证关键词原样返回', () => {
    expect(maskCredentials('hello world')).toBe('hello world')
  })
})

describe('maskIpv4（保留尾4）', () => {
  it('192.168.1.1 → ***.***.***.1', () => {
    expect(maskIpv4('192.168.1.1')).toBe('***.***.***.1')
  })

  it('10.20.30.40 → ***.***.***.40（尾段多数字正确保留）', () => {
    expect(maskIpv4('10.20.30.40')).toBe('***.***.***.40')
  })

  it('100.50.25.233 → ***.***.***.233（尾段三位保留）', () => {
    expect(maskIpv4('100.50.25.233')).toBe('***.***.***.233')
  })

  it('无 IPv4 原样返回', () => {
    expect(maskIpv4('no ip here')).toBe('no ip here')
  })
})

describe('maskMac（前两段掩码，后四段保留）', () => {
  it('AA:BB:CC:DD:EE:FF → **:**:**:DD:EE:FF', () => {
    expect(maskMac('AA:BB:CC:DD:EE:FF')).toBe('**:**:**:DD:EE:FF')
  })

  it('00:1a:2b:3c:4d:5e → **:**:**:3c:4d:5e（大小写混合正确）', () => {
    expect(maskMac('00:1a:2b:3c:4d:5e')).toBe('**:**:**:3c:4d:5e')
  })

  it('无 MAC 原样返回', () => {
    expect(maskMac('no mac here')).toBe('no mac here')
  })
})

describe('maskConversationText（串联三步）', () => {
  it('混合文本：密码+IP+MAC 三者全脱敏', () => {
    const input = '登录设备 192.168.1.100 (MAC AA:BB:CC:DD:EE:FF)，密码 admin@123'
    const out = maskConversationText(input)
    // 凭证先脱敏为 ****，IP/MAC 各保留尾4
    expect(out).toContain('密码 ****')
    expect(out).toContain('***.***.***.100')
    expect(out).toContain('**:**:**:DD:EE:FF')
    // 不应残留明文凭证值或 IP 前三段
    expect(out).not.toContain('admin@123')
    expect(out).not.toContain('192.168.1')
  })

  it('纯 IP 不被凭证误吞', () => {
    expect(maskConversationText('connect to 192.168.0.5')).toBe('connect to ***.***.***.5')
  })

  it('纯 MAC 不被 IP 误吞', () => {
    expect(maskConversationText('mac is 11:22:33:44:55:66')).toBe('mac is **:**:**:44:55:66')
  })

  it('空字符串原样返回', () => {
    expect(maskConversationText('')).toBe('')
  })

  it('纯空白原样返回', () => {
    expect(maskConversationText('   ')).toBe('   ')
  })

  it('无 PII 文本原样返回（不影响 AI 阅读）', () => {
    const txt = '检查 OSPF 邻居状态，确认 area 0 无异常'
    expect(maskConversationText(txt)).toBe(txt)
  })
})
