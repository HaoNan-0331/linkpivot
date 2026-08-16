import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, projectEncField } from '../utils/crypto'

/**
 * systemLog —— Phase 17 SEC-06 起加密型 service（函数式 + 模块级 MK，CONVENTIONS Pattern 1a）。
 *
 * prompt_text/ai_response 落 _enc 加密列（写侧 encField，truncate 在加密前——先裁 16000 再加密）；
 * 读侧经 projectEncField 列存在性 fallback（旧明文行对用户透明）+ D-03 坏密文哨兵占位。
 * masterKey 由 main.ts 启动时经 setSystemLogMasterKey() 注入（第 8 注入器），service 不直读 keyManager。
 * device_ids/device_names/parsed_result/error_message 四列不动（SEC-06 边界，Deferred）。
 */

let MK = ''
export function setSystemLogMasterKey(key: string) { MK = key }

// 默认走生产单例 db；测试经 _setSystemLogDbGetter 注入内存 mock（规避 DEP-1 native binding ABI 冲突）。
let dbGetter: () => Database.Database = getDatabase

/** @internal 测试专用：注入 db getter（生产不调用）。 */
export function _setSystemLogDbGetter(fn: () => Database.Database): void {
  dbGetter = fn
}

function db(): Database.Database {
  return dbGetter()
}

export interface SystemLog {
  id: string
  type: string
  status: string
  deviceIds: string
  deviceNames: string
  promptText: string
  aiResponse: string
  parsedResult: string
  errorMessage: string
  createdAt: string
}

export function createSystemLog(log: {
  type: string
  status: string
  deviceIds?: string
  deviceNames?: string
  promptText?: string
  aiResponse?: string
  parsedResult?: string
  errorMessage?: string
}): string {
  const id = uuidv4()
  db().prepare(
    `INSERT INTO ai_system_logs (id, type, status, device_ids, device_names, prompt_text_enc, ai_response_enc, parsed_result, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    log.type,
    log.status,
    truncate(log.deviceIds),
    truncate(log.deviceNames),
    encField(truncate(log.promptText), MK),
    encField(truncate(log.aiResponse), MK),
    truncate(log.parsedResult),
    truncate(log.errorMessage)
  )
  return id
}

const MAX_LOG_FIELD_LEN = 16000
function truncate(s: string | undefined): string {
  const v = s || ''
  return v.length > MAX_LOG_FIELD_LEN ? v.slice(0, MAX_LOG_FIELD_LEN) + '...[truncated]' : v
}

export function getSystemLogs(limit = 50): SystemLog[] {
  const rows = db()
    .prepare('SELECT * FROM ai_system_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    deviceIds: row.device_ids,
    deviceNames: row.device_names,
    promptText: projectEncField(row.prompt_text_enc, row.prompt_text, MK),
    aiResponse: projectEncField(row.ai_response_enc, row.ai_response, MK),
    parsedResult: row.parsed_result,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }))
}

// D-01（Phase 17 SEC-06）：启动即同步回填——明文存量行加密落 _enc + 旧列置 NULL（净化备份）。
// 统一判据「明文列 IS NOT NULL」（该列 _enc 已非空则保留原值只清旧列——矩阵 #2：回填前 append
// 已写全量 _enc 但明文残留）覆盖状态矩阵全格；每批一事务（LIMIT 500 保险丝，中断后已提交批不丢、
// 未跑批下次启动续跑）；幂等：跑完全库明文列均 NULL → 下次 0 行 no-op。
export function backfillSystemLogEnc(): { backfilled: number } {
  const BATCH = 500
  let backfilled = 0
  const selectStmt = db().prepare(
    `SELECT id, prompt_text, ai_response, prompt_text_enc, ai_response_enc FROM ai_system_logs
     WHERE prompt_text IS NOT NULL OR ai_response IS NOT NULL LIMIT ?`
  )
  const updateStmt = db().prepare(
    'UPDATE ai_system_logs SET prompt_text_enc = ?, ai_response_enc = ?, prompt_text = NULL, ai_response = NULL WHERE id = ?'
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
