import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildSSHConnectConfig,
  SSH_ALGORITHMS,
  SSH_READY_TIMEOUT_MS,
} from '../../electron/utils/sshConfig'

describe('sshConfig.buildSSHConnectConfig', () => {
  it('applies defaults: port 22, username root, readyTimeout 30000, SSH_ALGORITHMS', () => {
    const cfg = buildSSHConnectConfig({ ipAddress: '1.2.3.4' })
    expect(cfg.host).toBe('1.2.3.4')
    expect(cfg.port).toBe(22)
    expect(cfg.username).toBe('root')
    expect(cfg.readyTimeout).toBe(30000)
    expect(cfg.readyTimeout).toBe(SSH_READY_TIMEOUT_MS)
    expect(cfg.algorithms).toBe(SSH_ALGORITHMS)
    expect(cfg.privateKey).toBeUndefined()
    expect(cfg.password).toBeUndefined()
  })

  it('parameterizes readyTimeoutMs=8000 for probe fast-fail (rest unchanged)', () => {
    const cfg = buildSSHConnectConfig({ ipAddress: '1.2.3.4' }, 8000)
    expect(cfg.readyTimeout).toBe(8000)
    expect(cfg.host).toBe('1.2.3.4')
    expect(cfg.port).toBe(22)
    expect(cfg.algorithms).toBe(SSH_ALGORITHMS)
  })

  it('device.port=2222 and device.username=admin override defaults', () => {
    const cfg = buildSSHConnectConfig({ ipAddress: '1.2.3.4', port: 2222, username: 'admin' })
    expect(cfg.port).toBe(2222)
    expect(cfg.username).toBe('admin')
  })

  it('sshKeyContent branch: privateKey is Buffer of content, no password', () => {
    const cfg = buildSSHConnectConfig({ ipAddress: '1.2.3.4', sshKeyContent: 'KEY-MATERIAL' })
    expect(cfg.privateKey).toBeInstanceOf(Buffer)
    expect((cfg.privateKey as Buffer).toString('utf-8')).toBe('KEY-MATERIAL')
    expect(cfg.password).toBeUndefined()
  })

  it('sshKeyPath branch: privateKey equals file bytes', () => {
    const tmp = path.join(os.tmpdir(), `gsd-15-01-key-${Date.now()}.pem`)
    fs.writeFileSync(tmp, 'FILE-KEY-BYTES', 'utf-8')
    try {
      const cfg = buildSSHConnectConfig({ ipAddress: '1.2.3.4', sshKeyPath: tmp })
      expect((cfg.privateKey as Buffer).equals(fs.readFileSync(tmp))).toBe(true)
      expect(cfg.password).toBeUndefined()
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('no key material: falls through to password', () => {
    const cfg = buildSSHConnectConfig({ ipAddress: '1.2.3.4', password: 'secret' })
    expect(cfg.password).toBe('secret')
    expect(cfg.privateKey).toBeUndefined()
  })

  it('key content takes priority over key path (branch order verbatim from ai.ts)', () => {
    const cfg = buildSSHConnectConfig({ ipAddress: '1.2.3.4', sshKeyContent: 'INLINE', sshKeyPath: 'whatever', password: 'secret' })
    expect((cfg.privateKey as Buffer).toString('utf-8')).toBe('INLINE')
    expect(cfg.password).toBeUndefined()
  })
})
