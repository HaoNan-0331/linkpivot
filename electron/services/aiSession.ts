import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'

/**
 * aiSession —— AI 会话域（chat_sessions / chat_history CRUD + _enc 加密读写）。
 *
 * Phase 32（D-01/D-05，P1）：机械搬移自 ai.ts:191-333（createSession/listSessions/
 * getSessionMessages/deleteSession/updateSessionTitle/getChatHistory/parseChatMeta（内部）/
 * saveChatMessage），函数体逐字零改动——含 31-05 FIX-02 的 saveChatMessage trim 空内容守卫，
 * 保持源函数式形态不转静态类（32-PATTERNS Shared Pattern 1）。
 *
 * MK 注入链（过渡形态）：本文件持模块级 MK，由 ai.ts setAiMasterKey 链式调用
 * setAiSessionMasterKey 注入；_enc 读写只走 encField/decField、service 不直接读
 * keyManager（红线）。
 */

let MK = ''
export function setAiSessionMasterKey(key: string) { MK = key }

// ---------- Chat sessions ----------

export function createSession(title: string, deviceId?: string): { id: string; title: string; deviceId: string | null; createdAt: string } {
  const id = uuidv4()
  getDatabase().prepare(
    'INSERT INTO chat_sessions (id, title, device_id) VALUES (?, ?, ?)'
  ).run(id, title, deviceId || null)
  return { id, title, deviceId: deviceId || null, createdAt: new Date().toISOString() }
}

export function listSessions(): Array<{ id: string; title: string; deviceId: string | null; createdAt: string }> {
  const rows = getDatabase()
    .prepare('SELECT * FROM chat_sessions ORDER BY created_at DESC')
    .all() as any[]
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    deviceId: row.device_id,
    createdAt: row.created_at,
  }))
}

export function getSessionMessages(sessionId: string): Array<{
  id: string; role: string; content: string; deviceId: string | null; createdAt: string
  /** 28-06 R2 缺陷⑥：agent 轨迹 meta（历史/异常行降级 undefined）——renderer 历史恢复
   * 步骤卡/来源徽章/分档标签的数据源，此前该通道整体缺失（落库了但读侧丢弃） */
  meta?: Record<string, unknown>
}> {
  const rows = getDatabase()
    .prepare('SELECT * FROM chat_history WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as any[]
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: decField(row.content_enc, MK),
    deviceId: row.device_id,
    createdAt: row.created_at,
    meta: parseChatMeta(decField(row.meta_enc, MK)),
  }))
}

export function deleteSession(sessionId: string): void {
  const db = getDatabase()
  // TXN-01（18-02）：两条 DELETE 包同一同步事务——chat_history 删成、chat_sessions 删除失败
  // 会留空会话壳（中途失败整体回滚，范式 deleteDocument）。
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM chat_history WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId)
  })
  tx()
}

export function updateSessionTitle(sessionId: string, title: string): void {
  getDatabase().prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, sessionId)
}

// ---------- Chat history ----------

export function getChatHistory(sessionId?: string, limit?: number): Array<{
  id: string
  role: string
  content: string
  deviceId: string | null
  createdAt: string
  /** 28-04：agent 轨迹 meta（历史/异常行降级 undefined） */
  meta?: Record<string, unknown>
}> {
  // WR-09：limit 截断（取最近 N 条）防超大历史会话全量返回。默认不传 = 全量（向后兼容 ai 域自用）。
  // WR-02（18-REVIEW）：子查询 ORDER BY created_at DESC LIMIT ? 取最近 limit 条，外层 ASC 复原时间
  // 正序——旧实现子查询即 ASC（实取最旧 N 条），注释声明的「外层逆取」从未实现，>limit 条会话的
  // 溯源消费方（experienceService.getSessionMessages 默认 200）看到的是会话开头而非最近对话。
  if (limit != null && limit > 0) {
    const sql = sessionId
      ? `SELECT * FROM (
           SELECT * FROM chat_history WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
         ) sub ORDER BY created_at ASC`
      : `SELECT * FROM (
           SELECT * FROM chat_history ORDER BY created_at DESC LIMIT ?
         ) sub ORDER BY created_at ASC`
    const rows = sessionId
      ? (getDatabase().prepare(sql).all(sessionId, limit) as any[])
      : (getDatabase().prepare(sql).all(limit) as any[])
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: decField(row.content_enc, MK),
      deviceId: row.device_id,
      createdAt: row.created_at,
      meta: parseChatMeta(decField(row.meta_enc, MK)),
    }))
  }
  const rows = sessionId
    ? getDatabase().prepare('SELECT * FROM chat_history WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[]
    : getDatabase().prepare('SELECT * FROM chat_history ORDER BY created_at ASC').all() as any[]
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: decField(row.content_enc, MK),
    deviceId: row.device_id,
    createdAt: row.created_at,
    meta: parseChatMeta(decField(row.meta_enc, MK)),
  }))
}

/**
 * Phase 28（28-04，D-07）：chat_history.meta_enc 解析（agent 轨迹回看）。
 * 历史/异常行降级 undefined 零报错（decField null / JSON 解析失败均吞掉）。
 */
function parseChatMeta(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function saveChatMessage(
  role: string,
  content: string,
  deviceId: string | null,
  sessionId?: string | null,
  /** Phase 28（28-04，D-07）：agent 轨迹 meta（sources/steps/tier/noRealtimeData/hardStop），encField 加密落 meta_enc */
  meta?: Record<string, unknown> | null
): void {
  // 空内容守卫：trim 后为空则抛清晰错误，不进 INSERT。
  // 防 chat() KB_SEARCH catch 把纯标签 reply 剥成空串 / LLM 超时返回空 content 时
  // encField('') 返回 null 撞 chat_history.content_enc NOT NULL，把「网络超时」伪装成「DB 约束错误」。
  const trimmed = (content ?? '').trim()
  if (!trimmed) {
    throw new Error('无法保存空消息内容（AI 可能未返回有效回复，请检查网络后重试）')
  }
  const id = uuidv4()
  getDatabase().prepare(
    'INSERT INTO chat_history (id, role, content_enc, device_id, session_id) VALUES (?, ?, ?, ?, ?)'
  ).run(id, role, encField(trimmed, MK), deviceId || null, sessionId || null)
  // 28-04：meta 经 encField 写 meta_enc 列（红线：加密列只走 encField，禁裸调 encrypt）
  if (meta) {
    getDatabase().prepare('UPDATE chat_history SET meta_enc = ? WHERE id = ?')
      .run(encField(JSON.stringify(meta), MK), id)
  }
}
