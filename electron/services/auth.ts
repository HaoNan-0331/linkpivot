import crypto from 'crypto'
import { getDatabase } from '../database/connection'
import { hashPassword, verifyPasswordSync } from '../utils/crypto'

const captchaStore = new Map<string, { text: string; expires: number }>()

// 登录失败计数与锁定（内存态，单机单用户场景足够）
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>()
const MAX_ATTEMPTS = 5
const LOCK_MS = 5 * 60 * 1000

export function generateCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let text = ''
  // 验证码文本用 CSPRNG（crypto.randomInt），而非 Math.random
  for (let i = 0; i < 4; i++) text += chars[crypto.randomInt(0, chars.length)]
  const key = crypto.randomUUID()
  captchaStore.set(key, { text, expires: Date.now() + 5 * 60 * 1000 })
  return { svg: renderSvg(text), key, text }
}

export function verifyCaptcha(key: string, input: string): boolean {
  const s = captchaStore.get(key)
  if (!s) return false
  if (Date.now() > s.expires) { captchaStore.delete(key); return false }
  captchaStore.delete(key)
  return s.text.toUpperCase() === input.toUpperCase()
}

/** 口令强度策略：最少 10 位且需同时含字母与数字。 */
export function validatePasswordStrength(password: string): { ok: boolean; error?: string } {
  if (!password || password.length < 10) return { ok: false, error: '密码至少 10 位' }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return { ok: false, error: '密码需同时包含字母和数字' }
  return { ok: true }
}

export function login(username: string, password: string, captchaKey: string, captchaInput: string) {
  if (!verifyCaptcha(captchaKey, captchaInput)) return { success: false, error: '验证码错误' }

  const rec = failedAttempts.get(username)
  if (rec && rec.lockedUntil > Date.now()) {
    return { success: false, error: '登录失败次数过多，请 5 分钟后再试' }
  }

  const db = getDatabase()
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any
  if (!user || !verifyPasswordSync(password, user.password_hash)) {
    const count = (rec?.count || 0) + 1
    failedAttempts.set(username, {
      count,
      lockedUntil: count >= MAX_ATTEMPTS ? Date.now() + LOCK_MS : 0,
    })
    return { success: false, error: '用户名或密码错误' }
  }

  failedAttempts.delete(username)
  return { success: true, token: crypto.randomUUID() }
}

export function isFirstRun(): boolean {
  return (getDatabase().prepare('SELECT COUNT(*) as c FROM users').get() as any).c === 0
}

export async function initAdmin(username: string, password: string) {
  const pwdCheck = validatePasswordStrength(password)
  if (!pwdCheck.ok) return { success: false, error: pwdCheck.error }
  const db = getDatabase()
  try {
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(crypto.randomUUID(), username, await hashPassword(password))
    return { success: true }
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return { success: false, error: '用户名已存在' }
    return { success: false, error: '创建失败' }
  }
}

function renderSvg(text: string): string {
  let chars = '', noise = ''
  for (let i = 0; i < text.length; i++) {
    const x = 15 + i * 25, y = 28 + Math.random() * 6 - 3
    chars += `<text x="${x}" y="${y}" font-size="28" fill="rgb(${~~(Math.random()*100)},${~~(Math.random()*100)},${~~(Math.random()*100)})" transform="rotate(${Math.random()*30-15},${x},${y})" font-family="monospace">${text[i]}</text>`
  }
  for (let i = 0; i < 4; i++) noise += `<line x1="${Math.random()*120}" y1="${Math.random()*40}" x2="${Math.random()*120}" y2="${Math.random()*40}" stroke="#aaa" stroke-width="1"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="100%" height="100%" fill="#f0f0f0"/>${noise}${chars}</svg>`
}
