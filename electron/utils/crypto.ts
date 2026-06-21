import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const V1_IV_LEN = 16   // 历史密文 IV 长度
const V2_IV_LEN = 12   // 新密文 IV 长度（GCM 推荐 96 位）
const SALT_LEN = 64
const TAG_LEN = 16
const ITERATIONS = 100000
const V2_PREFIX = 'v2:'

// 派生密钥 LRU 缓存：同一 (masterKey, salt) 不重复执行 pbkdf2Sync（10 万次），
// 显著降低列表场景（listDevices 等多行多字段解密）的主进程同步阻塞。
const derivedKeyCache = new Map<string, Buffer>()
const DERIVED_CACHE_MAX = 2048

function deriveKey(password: string, salt: Buffer): Buffer {
  const cacheKey = `${password}:${salt.toString('base64')}`
  const cached = derivedKeyCache.get(cacheKey)
  if (cached) return cached
  const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha512')
  if (derivedKeyCache.size >= DERIVED_CACHE_MAX) {
    const firstKey = derivedKeyCache.keys().next().value
    if (firstKey) derivedKeyCache.delete(firstKey)
  }
  derivedKeyCache.set(cacheKey, key)
  return key
}

// 字段加密：新密文用 v2: 前缀 + 12 字节 IV（GCM 推荐值）。
export function encrypt(plaintext: string, masterKey: string): string {
  const salt = crypto.randomBytes(SALT_LEN)
  const iv = crypto.randomBytes(V2_IV_LEN)
  const key = deriveKey(masterKey, salt)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return V2_PREFIX + Buffer.concat([salt, iv, tag, enc]).toString('base64')
}

// 兼容历史密文：v2: 前缀用 12 字节 IV，无前缀的历史密文用 16 字节 IV。
export function decrypt(ciphertext: string, masterKey: string): string {
  const isV2 = ciphertext.startsWith(V2_PREFIX)
  const payload = isV2 ? ciphertext.slice(V2_PREFIX.length) : ciphertext
  const ivLen = isV2 ? V2_IV_LEN : V1_IV_LEN
  const buf = Buffer.from(payload, 'base64')
  const salt = buf.subarray(0, SALT_LEN)
  const iv = buf.subarray(SALT_LEN, SALT_LEN + ivLen)
  const tag = buf.subarray(SALT_LEN + ivLen, SALT_LEN + ivLen + TAG_LEN)
  const enc = buf.subarray(SALT_LEN + ivLen + TAG_LEN)
  const key = deriveKey(masterKey, salt)
  const dec = crypto.createDecipheriv(ALGORITHM, key, iv)
  dec.setAuthTag(tag)
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8')
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN)
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, ITERATIONS, 64, 'sha512', (err, dk) => {
      if (err) reject(err)
      resolve(`${salt.toString('base64')}:${dk.toString('base64')}`)
    })
  })
}

// 密码校验：结构防御 + 输入长度上限（防 pbkdf2 超长输入 DoS）+ timingSafeEqual 等长保护。
export function verifyPasswordSync(password: string, storedHash: string): boolean {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false
  if (password.length > 1024) return false
  const parts = storedHash.split(':')
  if (parts.length !== 2) return false
  try {
    const salt = Buffer.from(parts[0], 'base64')
    const stored = Buffer.from(parts[1], 'base64')
    if (salt.length === 0 || stored.length === 0) return false
    const derived = crypto.pbkdf2Sync(password, salt, ITERATIONS, 64, 'sha512')
    if (stored.length !== derived.length) return false
    return crypto.timingSafeEqual(stored, derived)
  } catch {
    return false
  }
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return verifyPasswordSync(password, storedHash)
}

export function encField(val: string | null | undefined, key: string): string | null {
  if (!val) return null
  return encrypt(val, key)
}

export function decField(val: string | null | undefined, key: string): string {
  if (!val) return ''
  return decrypt(val, key)
}
