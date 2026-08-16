import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, decField, projectEncField } from '../utils/crypto'

/**
 * aiExecLogger —— Phase 17 SEC-06 起 prompt_text/ai_response 落 _enc 加密列。
 *
 * 写侧 encField（空串自动 null，无需 `|| ''`）；读侧 projectEncField 列存在性 fallback
 * （旧明文行对用户透明）+ D-03 坏密文哨兵占位。appendLogAiResponse 由 SQL `||` 拼接重写为
 * JS 读-解-拼-加密-UPDATE 单事务（P2：`||` 作用在密文上解密必失败，第二次 AI 调用无声丢失）。
 */

let MK = ''
export function setAiExecLoggerMasterKey(key: string) { MK = key }

// 默认走生产单例 db；测试经 _setAiExecLoggerDbGetter 注入内存 mock（规避 DEP-1 native binding ABI 冲突）。
let dbGetter: () => Database.Database = getDatabase

/** @internal 测试专用：注入 db getter（生产不调用）。 */
export function _setAiExecLoggerDbGetter(fn: () => Database.Database): void {
  dbGetter = fn
}

function db(): Database.Database {
  return dbGetter()
}

export function createLog(entry: {
  deviceId: string
  deviceName: string
  command: string
  status: string
  mode: string
  aiReason: string
  promptText?: string
  aiResponse?: string
}): string {
  const id = uuidv4()
  db().prepare(`
    INSERT INTO ai_exec_logs (id, device_id, device_name_enc, command, status, mode, ai_reason, prompt_text_enc, ai_response_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entry.deviceId,
    encField(entry.deviceName, MK),
    entry.command,
    entry.status,
    entry.mode,
    entry.aiReason,
    encField(entry.promptText, MK),
    encField(entry.aiResponse, MK)
  )
  return id
}

export function updateLogStatus(id: string, status: string): void {
  db()
    .prepare('UPDATE ai_exec_logs SET status = ? WHERE id = ?')
    .run(status, id)
}

// P2（Phase 17 SEC-06）：读-解-拼-加密-UPDATE 单同步事务——SQL `||` 拼接在密文列直接坏死。
// 分隔符字面量与旧 SQL `||` 拼接产出逐字等价（逐字保留）。
export function appendLogAiResponse(id: string, secondPrompt: string, secondResponse: string): void {
  const run = db().transaction(() => {
    const row = db()
      .prepare('SELECT prompt_text, ai_response, prompt_text_enc, ai_response_enc FROM ai_exec_logs WHERE id = ?')
      .get(id) as {
        prompt_text: string | null
        ai_response: string | null
        prompt_text_enc: string | null
        ai_response_enc: string | null
      } | undefined
    if (!row) return
    // 列存在性 fallback（禁试解密，零裸 decrypt）：旧行明文 / 新行密文两态；
    // decField 失败降级 '' 永不 throw（自带 console.error + R2 限流上报，可观测不依赖本地 catch）
    const prevPrompt = row.prompt_text_enc != null ? decField(row.prompt_text_enc, MK) : (row.prompt_text || '')
    const prevResponse = row.ai_response_enc != null ? decField(row.ai_response_enc, MK) : (row.ai_response || '')
    // 解密失败判别器（与 projectEncField 同源）：非空 _enc 且 decField 返 '' ⟺ 解密失败
    // （encField('') === null——非空 _enc 不可能来自合法空明文）。跳写保住 _enc 原文：
    // 对降级 '' 继续拼接再重加密覆盖会不可逆摧毁首次调用记录（T-17-07）。
    if ((row.prompt_text_enc != null && prevPrompt === '') || (row.ai_response_enc != null && prevResponse === '')) {
      console.error('[aiExecLogger] appendLogAiResponse 跳过：旧行解密失败 id=', id)
      return
    }
    const nextPrompt = prevPrompt + '\n\n========== 命令执行后的第二次 AI 调用 ==========\n\n发送给 AI 的 Prompt:\n' + secondPrompt
    const nextResponse = prevResponse + '\n\nAI 分析结果:\n' + secondResponse
    // 同事务清旧明文列（矩阵 #2：append 写全量 _enc 后明文前缀必须即刻清除，否则回填判据外永不净化）
    db()
      .prepare('UPDATE ai_exec_logs SET prompt_text_enc = ?, ai_response_enc = ?, prompt_text = NULL, ai_response = NULL WHERE id = ?')
      .run(encField(nextPrompt, MK), encField(nextResponse, MK), id)
  })
  run()
}

export function getLogs(limit = 100): Array<{
  id: string
  deviceId: string
  deviceName: string
  command: string
  status: string
  mode: string
  aiReason: string
  promptText: string
  aiResponse: string
  createdAt: string
}> {
  const rows = db()
    .prepare('SELECT * FROM ai_exec_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    deviceName: decField(row.device_name_enc, MK),
    command: row.command,
    status: row.status,
    mode: row.mode,
    aiReason: row.ai_reason,
    promptText: projectEncField(row.prompt_text_enc, row.prompt_text, MK),
    aiResponse: projectEncField(row.ai_response_enc, row.ai_response, MK),
    createdAt: row.created_at,
  }))
}

// D-01（Phase 17 SEC-06）：启动即同步回填——明文存量行加密落 _enc + 旧列置 NULL（净化备份）。
// 与 backfillSystemLogEnc 完全同构（表 ai_exec_logs）：统一判据「明文列 IS NOT NULL」
// （该列 _enc 已非空则保留原值只清旧列——矩阵 #2）覆盖状态矩阵全格；每批一事务（LIMIT 500 保险丝）；
// 幂等：跑完全库明文列均 NULL → 下次 0 行 no-op。
export function backfillAiExecLogEnc(): { backfilled: number } {
  const BATCH = 500
  let backfilled = 0
  const selectStmt = db().prepare(
    `SELECT id, prompt_text, ai_response, prompt_text_enc, ai_response_enc FROM ai_exec_logs
     WHERE prompt_text IS NOT NULL OR ai_response IS NOT NULL LIMIT ?`
  )
  const updateStmt = db().prepare(
    'UPDATE ai_exec_logs SET prompt_text_enc = ?, ai_response_enc = ?, prompt_text = NULL, ai_response = NULL WHERE id = ?'
  )
  for (;;) {
    const rows = selectStmt.all(BATCH) as Array<{
      id: string
      prompt_text: string | null
      ai_response: string | null
      prompt_text_enc: string | null
      ai_response_enc: string | null
    }>
    if (rows.length === 0) break
    db().transaction(() => {
      for (const r of rows) {
        updateStmt.run(
          r.prompt_text_enc != null ? r.prompt_text_enc : encField(r.prompt_text, MK),
          r.ai_response_enc != null ? r.ai_response_enc : encField(r.ai_response, MK),
          r.id
        )
        backfilled++
      }
    })()
  }
  return { backfilled }
}
