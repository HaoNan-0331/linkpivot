import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'

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
  getDatabase().prepare(
    `INSERT INTO ai_system_logs (id, type, status, device_ids, device_names, prompt_text, ai_response, parsed_result, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    log.type,
    log.status,
    truncate(log.deviceIds),
    truncate(log.deviceNames),
    truncate(log.promptText),
    truncate(log.aiResponse),
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
  const rows = getDatabase()
    .prepare('SELECT * FROM ai_system_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    deviceIds: row.device_ids,
    deviceNames: row.device_names,
    promptText: row.prompt_text,
    aiResponse: row.ai_response,
    parsedResult: row.parsed_result,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }))
}
