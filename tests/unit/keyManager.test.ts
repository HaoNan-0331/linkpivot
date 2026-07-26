import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import crypto from 'crypto'

// R3 测试：keyManager 依赖 electron safeStorage + fs。用 mem store + 可控 safeStorage mock，
// 验证「safeStorage 翻转 + master.key 无法解读」时抛错（而非静默返回错误 masterKey 致无声数据丢失）。
const memStore = new Map<string, Buffer>()
vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => memStore.has(p),
    readFileSync: (p: string) => {
      const v = memStore.get(p)
      if (!v) throw new Error('ENOENT')
      return v
    },
    writeFileSync: (p: string, data: Buffer | string) => {
      memStore.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
    },
  },
}))

let safeStorageAvailable = false
let safeStorageDecryptThrow = false
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/fake-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageAvailable,
    decryptString: (buf: Buffer) => {
      if (safeStorageDecryptThrow) throw new Error('safeStorage decrypt failed (account changed)')
      return buf.toString('utf8')
    },
    encryptString: (s: string) => Buffer.from('ENC:' + s),
  },
}))

// eslint-disable-next-line import/first
import { getOrCreateMasterKey } from '../../electron/utils/keyManager'

const KEY_PATH = path.join('/tmp/fake-userdata', 'master.key')

describe('keyManager', () => {
  beforeEach(() => {
    memStore.clear()
    safeStorageAvailable = false
    safeStorageDecryptThrow = false
  })

  it('creates new masterKey (32-byte base64) when none exists', () => {
    const key = getOrCreateMasterKey()
    expect(Buffer.from(key, 'base64').length).toBe(32)
  })

  it('reuses existing plaintext base64 masterKey (legacy plaintext fallback)', () => {
    const existing = crypto.randomBytes(32).toString('base64')
    memStore.set(KEY_PATH, Buffer.from(existing, 'utf8'))
    safeStorageAvailable = false // headless：明文落盘的合法历史
    expect(getOrCreateMasterKey()).toBe(existing)
  })

  // R3 核心：safeStorage 翻转（换账户/换机）+ master.key 是无法解读的 blob → 必须抛错，
  // 不能把 DPAPI blob 当 UTF-8 trim 出错误 masterKey（与 decField 静默吞错叠加为破坏性数据丢失）。
  it('throws when safeStorage flipped and master.key is undecodable blob (no silent wrong key)', () => {
    const dpapiBlob = Buffer.from([0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0xde, 0xad, 0xbe, 0xef])
    memStore.set(KEY_PATH, dpapiBlob)
    safeStorageAvailable = true
    safeStorageDecryptThrow = true // 账户变更，decryptString 抛错
    expect(() => getOrCreateMasterKey()).toThrow(/无法解读|safeStorage|backups|master\.key/)
  })
})
