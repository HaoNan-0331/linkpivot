/**
 * IPC 鉴权与异常脱敏中间件。
 * 单机桌面工具登录态：login 成功置 true，应用启动为 false（需重新登录）。
 */

let authenticated = false

export function setAuthenticated(v: boolean): void {
  authenticated = v
}

export function isAuthenticated(): boolean {
  return authenticated
}

/** 基本脱敏：移除绝对路径、截断超长 message，避免向渲染层泄露 SQL/路径等内部细节。
 *  Unix 路径用通用绝对路径匹配（不再枚举前缀），覆盖 SQLite 等库报告的 /app /data /root /private 等部署路径。 */
function sanitizeMessage(msg: string): string {
  if (!msg) return '操作失败'
  let s = msg
    .replace(/[A-Za-z]:\\[^\s'"()<>]*/g, '[路径]')
    .replace(/\/[^\s'"()<>]*/g, '[路径]')
  if (s.length > 200) s = s.slice(0, 200) + '...'
  return s
}

/**
 * 特权 IPC 安全包装：
 * - 未登录 → reject Error('未登录或会话已过期')（在 try 之外，不被脱敏覆盖）
 * - handler 抛错 → 记录完整 error 到日志，reject 脱敏 Error（不泄露内部细节，保留业务 message 可读性）
 */
export function secure(handler: (e: any, ...args: any[]) => any) {
  return async (e: any, ...args: any[]) => {
    if (!authenticated) throw new Error('未登录或会话已过期')
    try {
      return await handler(e, ...args)
    } catch (err: any) {
      console.error('[ipc] handler error:', err)
      throw new Error(sanitizeMessage(err?.message || '操作失败'))
    }
  }
}

/** 仅异常脱敏（不做鉴权），用于 auth:* 等登录前 handler。 */
export function safe(handler: (e: any, ...args: any[]) => any) {
  return async (e: any, ...args: any[]) => {
    try {
      return await handler(e, ...args)
    } catch (err: any) {
      console.error('[ipc] handler error:', err)
      throw new Error(sanitizeMessage(err?.message || '操作失败'))
    }
  }
}
