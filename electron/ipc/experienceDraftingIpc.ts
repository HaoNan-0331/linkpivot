import { ipcMain } from 'electron'
import { summarizeSessionForUi } from '../services/experienceDrafting'
import { secure } from '../utils/authGuard'

/**
 * Experience 起草 IPC 网关（Phase 8 Plan 03）。
 *
 * 安全红线（延续 Phase 7 SEC-01/02）：
 * - experience:summarizeSession 经 secure 鉴权 + 异常脱敏包装。起草属登录后特权操作
 *   （读 chat_history 明文 + 调 LLM + 落 draft），无登录前场景。
 * - 返回 DraftingResult 不含会话原文（仅含落库 draft 的 exp_id/title/category + NOOP 提示），
 *   会话原文回链交 Phase 9（renderer 永不收会话明文经此 channel）。
 * - 异常（未配 AI / LLM 限流 / 重试耗尽）经 secure sanitizeMessage 脱敏后透出 renderer。
 *
 * channel 命名遵循全仓 camelCase 事实约定（与 experience:list/listDevices 一致）。
 */

export function registerExperienceDraftingIpc() {
  ipcMain.handle('experience:summarizeSession', secure((_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('sessionId 无效')
    }
    return summarizeSessionForUi({ sessionId })
  }))
}
