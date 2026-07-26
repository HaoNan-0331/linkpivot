import { describe, it, expect, beforeEach } from 'vitest'
import { secure, safe, setAuthenticated } from '../../electron/utils/authGuard'

// 安全核心回归网（审计 R5 / TEST-1）：authGuard.secure/sanitizeMessage 是 IPC 鉴权 + 异常脱敏防线。
// sanitizeMessage 未 export，通过 secure() 包装的行为间接验证脱敏效果（攻击面在 reject 的 message）。
describe('authGuard', () => {
  beforeEach(() => setAuthenticated(false))

  // —— 鉴权 ——
  it('secure rejects when not authenticated (before try, not masked by sanitize)', async () => {
    const wrapped = secure(() => 'should not reach')
    await expect(wrapped({})).rejects.toThrow('未登录或会话已过期')
  })

  it('secure returns handler result when authenticated', async () => {
    setAuthenticated(true)
    const wrapped = secure(() => 'ok')
    await expect(wrapped({})).resolves.toBe('ok')
  })

  // —— 异常脱敏：sanitizeMessage 通过 secure 间接验证 ——
  it('secure sanitizes Windows absolute path from error (no leak to renderer)', async () => {
    setAuthenticated(true)
    const wrapped = secure(() => { throw new Error('failed to open C:\\Users\\admin\\secret.db') })
    try {
      await wrapped({})
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      const msg = (e as Error).message
      expect(msg).toContain('[路径]')
      expect(msg).not.toContain('C:\\Users\\admin')
      expect(msg).not.toContain('secret.db')
    }
  })

  it('secure sanitizes Unix absolute path from error', async () => {
    setAuthenticated(true)
    const wrapped = secure(() => { throw new Error('cannot read /home/operator/config/key.pem') })
    try {
      await wrapped({})
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      const msg = (e as Error).message
      expect(msg).toContain('[路径]')
      expect(msg).not.toContain('/home/operator')
      expect(msg).not.toContain('key.pem')
    }
  })

  it('secure truncates over-long error message (<=200 + ellipsis)', async () => {
    setAuthenticated(true)
    const longMsg = 'X'.repeat(500)
    const wrapped = secure(() => { throw new Error(longMsg) })
    try {
      await wrapped({})
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      const msg = (e as Error).message
      expect(msg.length).toBeLessThanOrEqual(203) // 200 + '...'
      expect(msg.endsWith('...')).toBe(true)
    }
  })

  it('secure falls back to 操作失败 when error message empty', async () => {
    setAuthenticated(true)
    const wrapped = secure(() => { throw new Error('') })
    await expect(wrapped({})).rejects.toThrow('操作失败')
  })

  // —— safe() 包装器（仅脱敏不鉴权，供 auth:* 登录前 handler 用）——
  it('safe does not require auth but still sanitizes', async () => {
    const wrapped = safe(() => { throw new Error('leak C:\\Users\\x\\y') })
    try {
      await wrapped({})
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      const msg = (e as Error).message
      expect(msg).toContain('[路径]')
      expect(msg).not.toContain('C:\\Users')
    }
  })
})
