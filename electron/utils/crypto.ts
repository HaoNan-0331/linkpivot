import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LEN = 16
const SALT_LEN = 64
const TAG_LEN = 16
const ITERATIONS = 100000

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

export function encrypt(plaintext: string, masterKey: string): string {
  const salt = crypto.randomBytes(SALT_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const key = deriveKey(masterKey, salt)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([salt, iv, tag, enc]).toString('base64')
}

export function decrypt(ciphertext: string, masterKey: string): string {
  const buf = Buffer.from(ciphertext, 'base64')
  const salt = buf.subarray(0, SALT_LEN)
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN)
  const enc = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN)
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

export function verifyPasswordSync(password: string, storedHash: string): boolean {
  const [saltB64, hashB64] = storedHash.split(':')
  const salt = Buffer.from(saltB64, 'base64')
  const stored = Buffer.from(hashB64, 'base64')
  const derived = crypto.pbkdf2Sync(password, salt, ITERATIONS, 64, 'sha512')
  return crypto.timingSafeEqual(stored, derived)
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
