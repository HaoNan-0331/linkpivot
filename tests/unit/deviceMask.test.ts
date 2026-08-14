import { describe, it, expect, vi } from 'vitest'

// H-1（v0.3.0 audit）：设备凭证 IPC 边界脱敏回归网。
//
// 红线：renderer 任何 IPC 返回值中不含设备明文 password/sshKeyContent（只可能收到 ****尾4位）。
// maskDeviceSecrets 是纯函数（浅拷贝投影），直接调用验证，无需 DB/IPC mock。
// 与 ai.ts getAiConfigMasked 的 `****${v.slice(-4)}` 格式一致。

vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => { throw new Error('deviceMask 测试不应触达 DB') },
}))

import { maskDeviceSecrets } from '../../electron/services/device'

describe('H-1 maskDeviceSecrets（设备凭证脱敏投影）', () => {
  it('password/sshKeyContent 非空字符串替换为 ****+尾4位（与 getAiConfigMasked 同格式）', () => {
    const out = maskDeviceSecrets({
      id: 'd1', name: 'core-sw', ipAddress: '192.168.1.1', username: 'admin',
      password: 'MySecretPass', sshKeyContent: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc1234',
    })
    expect(out.password).toBe('****Pass')
    expect(out.sshKeyContent).toBe('****1234')
  })

  it('password/sshKeyContent 为 null/空串/undefined 时原样返回（不变成掩码串）', () => {
    const out = maskDeviceSecrets({
      password: null, sshKeyContent: '', name: 'dev',
    })
    expect(out.password).toBeNull()
    expect(out.sshKeyContent).toBe('')
    const out2 = maskDeviceSecrets({ name: 'dev2' })
    expect(out2.password).toBeUndefined()
    expect(out2.sshKeyContent).toBeUndefined()
  })

  it('非敏感字段逐字透传，输入对象不被原地修改', () => {
    const input = {
      id: 'd1', name: 'core-sw', vendor: '华为', model: 'S5735', ipAddress: '10.0.0.1',
      deviceType: 'switch', connectionType: 'ssh', port: 22, username: 'netops',
      webUrl: 'https://10.0.0.1', status: 'unknown', password: 'PlainSecret99',
    }
    const out = maskDeviceSecrets(input)
    expect(out.id).toBe('d1')
    expect(out.name).toBe('core-sw')
    expect(out.vendor).toBe('华为')
    expect(out.model).toBe('S5735')
    expect(out.ipAddress).toBe('10.0.0.1')
    expect(out.deviceType).toBe('switch')
    expect(out.connectionType).toBe('ssh')
    expect(out.port).toBe(22)
    expect(out.username).toBe('netops')
    expect(out.webUrl).toBe('https://10.0.0.1')
    expect(out.status).toBe('unknown')
    // 原对象不被修改（service 内部主进程路径仍需明文）
    expect(input.password).toBe('PlainSecret99')
    expect(out).not.toBe(input)
  })
})
