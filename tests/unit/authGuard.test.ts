import { describe, it, expect, beforeEach } from 'vitest'
import { secure, safe, setAuthenticated, isAuthenticated } from '../../electron/utils/authGuard'

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

  // —— SEC-04 L6 加固确认扩展（D-13-8）：safe 未登录不拒绝 + isAuthenticated 行为 + SQL 错误脱敏 ——

  it('safe does NOT reject when not authenticated (登录前 channel 不要求鉴权)', async () => {
    setAuthenticated(false)
    const wrapped = safe(() => 'ok')
    // safe 是登录前 channel（auth:getCaptcha/auth:login/auth:isFirstRun/auth:initAdmin 用），
    // 不强制鉴权——与 secure 区分。未登录态正常路径 resolves to 'ok'（非 reject）。
    await expect(wrapped({})).resolves.toBe('ok')
  })

  it('isAuthenticated returns current auth state (预留查询入口，0 caller 但保留)', () => {
    setAuthenticated(false)
    expect(isAuthenticated()).toBe(false)
    setAuthenticated(true)
    expect(isAuthenticated()).toBe(true)
  })

  it('secure sanitizes SQL fragment from error (no internal detail leak)', async () => {
    setAuthenticated(true)
    // SQLite 等库报告的错误常含部署路径（/app/db/...），与纯路径错误是复合场景。
    // sanitizeMessage 枚举根目录前缀（含 app 部署前缀），覆盖 /app/db/... 不泄露。
    const wrapped = secure(() => { throw new Error('SQLITE_CONSTRAINT: experiences.tags is not unique in /app/db/main.db') })
    try {
      await wrapped({})
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      const msg = (e as Error).message
      expect(msg).toContain('[路径]')
      expect(msg).not.toContain('/app/db/main.db')
    }
  })

  it('sanitizeMessage does NOT mangle URL/date/ratio (反向回归 CR-01：含斜杠的非路径内容保留)', async () => {
    setAuthenticated(true)
    // 13-02 曾把 Unix 正则放宽到 \/[^\s'"()<>]*，误吞 URL/日期/比例/路由；收紧后只匹配真实根目录前缀路径。
    // 含斜杠的非路径内容必须原样透出——运维排障关键信息（端点/时间戳）不可丢失。
    const cases = [
      '请求失败: http://api.example.com/v1 超时',
      '备份失败于 2024/01/15',
      '磁盘占用 3/4 超限',
      'GET /api/list 返回 500',
    ]
    for (const raw of cases) {
      const wrapped = secure(() => { throw new Error(raw) })
      try {
        await wrapped({})
        expect.unreachable('should have thrown')
      } catch (e: unknown) {
        expect((e as Error).message).not.toContain('[路径]')
      }
    }
  })
})
