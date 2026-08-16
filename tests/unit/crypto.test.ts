import { describe, it, expect, afterEach } from 'vitest'
import crypto from 'crypto'
import {
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
  decField,
  encField,
  projectEncField,
  DECRYPT_FAIL_PLACEHOLDER,
  setDecryptFailureHandler,
} from '../../electron/utils/crypto'

describe('crypto', () => {
  const key = 'test-key-32-bytes-long-enough!!'

  it('encrypt and decrypt correctly', () => {
    const enc = encrypt('hello world', key)
    expect(decrypt(enc, key)).toBe('hello world')
  })

  it('different ciphertext each time', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key))
  })

  it('password hash and verify', async () => {
    const hash = await hashPassword('Pass123!')
    expect(await verifyPassword('Pass123!', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('wrong key fails to decrypt', () => {
    const enc = encrypt('secret', key)
    expect(() => decrypt(enc, 'wrong-key-00000000000000000')).toThrow()
  })

  // R5: v1/v2 IV 兼容（历史密文 16 字节 IV 无前缀；新密文 v2: 前缀 12 字节 IV）
  it('decrypt legacy v1 ciphertext (16-byte IV, no v2: prefix)', () => {
    const salt = crypto.randomBytes(64)
    const iv = crypto.randomBytes(16) // v1: 16 字节 IV
    const derived = crypto.pbkdf2Sync(key, salt, 100000, 32, 'sha512')
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv)
    const enc = Buffer.concat([cipher.update('legacy-data', 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const v1 = Buffer.concat([salt, iv, tag, enc]).toString('base64') // 无 v2: 前缀
    expect(decrypt(v1, key)).toBe('legacy-data')
  })

  it('decrypt v2 ciphertext (v2: prefix, 12-byte IV)', () => {
    const enc = encrypt('v2-data', key)
    expect(enc.startsWith('v2:')).toBe(true)
    expect(decrypt(enc, key)).toBe('v2-data')
  })

  // R2: decField 单条坏密文降级返回 ''（不阻断 list 加载）
  it('decField returns "" on bad ciphertext (single bad row degrades, not crash)', () => {
    expect(decField('not-valid-ciphertext', key)).toBe('')
    expect(decField(null, key)).toBe('')
    expect(decField(undefined, key)).toBe('')
  })

  it('decField preserves valid roundtrip', () => {
    const enc = encrypt('设备密码', key)
    expect(decField(enc, key)).toBe('设备密码')
  })

  // R2: 解密失败可观测层（注入 handler）+ 限流去重（防 list 多行刷屏）
  afterEach(() => setDecryptFailureHandler(null))

  it('decField failure triggers injected handler (observability)', () => {
    const calls: unknown[] = []
    setDecryptFailureHandler((e) => calls.push(e))
    decField('bad-ciphertext', key)
    expect(calls.length).toBe(1)
  })

  it('decField handler dedupes within rate-limit window (no log spam on failed list)', () => {
    const calls: unknown[] = []
    setDecryptFailureHandler((e) => calls.push(e))
    for (let i = 0; i < 10; i++) decField('bad', key) // 模拟 list 10 行全失败
    expect(calls.length).toBe(1) // 窗口内只告警 1 次
  })

  // Phase 17 SEC-06（D-03）：读侧列存在性投影 + 坏密文哨兵占位（纯函数直调，无需 mock）
  describe('projectEncField', () => {
    it('enc null + plain non-null returns plain (column-existence fallback, no trial-decrypt)', () => {
      expect(projectEncField(null, 'legacy-plaintext', key)).toBe('legacy-plaintext')
    })

    it('enc null + plain null returns empty string', () => {
      expect(projectEncField(null, null, key)).toBe('')
      expect(projectEncField(undefined, undefined, key)).toBe('')
    })

    it('valid ciphertext decrypts back to plaintext (ignores stale plain column)', () => {
      const enc = encrypt('roundtrip-content', key)
      expect(projectEncField(enc, null, key)).toBe('roundtrip-content')
    })

    it('garbage ciphertext returns DECRYPT_FAIL_PLACEHOLDER (D-03 sentinel literal)', () => {
      // 'v2:AAAA' 非 base64 完整结构（GCM tag/IV 长度不足），解密必抛 → decField 降级 '' → 哨兵占位
      expect(projectEncField('v2:AAAA', null, key)).toBe('[内容无法解密（密钥不匹配）]')
      expect(DECRYPT_FAIL_PLACEHOLDER).toBe('[内容无法解密（密钥不匹配）]')
    })

    it('encField("") === null — discriminator foundation (non-empty _enc cannot come from legal empty plaintext)', () => {
      // 「非空 _enc 且 decField 返 ''」⟺ 解密失败 的判别器根基：空明文不产生非空 _enc
      expect(encField('', key)).toBeNull()
      expect(encField(null, key)).toBeNull()
      expect(encField(undefined, key)).toBeNull()
    })
  })
})
