import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { verifyPasswordSync } from '../utils/crypto'
import { setAiExecLoggerMasterKey } from './aiExecLogger'
import { setAiSessionMasterKey } from './aiSession'
import { setAiExecMasterKey } from './aiExec'
import { setAiMcpMasterKey } from './aiMcp'

/**
 * aiConfig —— AI 配置域（ai_config CRUD + 掩码 + exec mode + 命令白名单）。
 *
 * Phase 32（D-01/D-05，P1）：机械搬移自 ai.ts:31-190（getAiConfig/getAiConfigMasked/
 * stripMaskedKeys/saveAiConfig + ExecMode/EXEC_MODES/getExecMode/setExecMode/
 * getCommandWhitelist/saveCommandWhitelist），函数体逐字零改动，保持源函数式形态
 * 不转静态类（32-PATTERNS Shared Pattern 1）。
 *
 * MK 注入链（Phase 32 P4 终态）：setAiMasterKey 本体落此文件（吸收原 ai.ts 过渡
 * orchestrator）——MK = key 赋值本域 + 链式注入 aiExecLogger/aiSession/aiExec/aiMcp
 * 四域（main.ts:139 经 ai.ts barrel 调用零改动）；service 不直接读 keyManager
 * （红线）。已知 aiConfig↔aiExec 模块环（本文件 setAiExecMasterKey × aiExec
 * getCommandWhitelist）为运行时函数级使用，CJS bundle 无害（Shared Pattern 6 先例）。
 * 掩码守卫红线：**** 掩码串不得落库（stripMaskedKeys）。
 */

let MK = ''
export function setAiMasterKey(key: string) {
  MK = key
  setAiExecLoggerMasterKey(key)
  setAiSessionMasterKey(key)
  setAiExecMasterKey(key)
  setAiMcpMasterKey(key)
}

// ---------- Config ----------

export function getAiConfig(): Record<string, string> | null {
  const row = getDatabase()
    .prepare('SELECT * FROM ai_config LIMIT 1')
    .get() as any
  if (!row) return null
  const apiKey = decField(row.api_key_enc, MK)
  return {
    provider: decField(row.provider_enc, MK),
    apiKey,
    baseUrl: decField(row.base_url_enc, MK),
    modelName: decField(row.model_name_enc, MK),
    visionBaseUrl: decField(row.vision_base_url_enc, MK),
    visionApiKey: decField(row.vision_api_key_enc, MK),
    visionModel: decField(row.vision_model_enc, MK),
  }
}

/** Returns config with masked apiKey for renderer process */
export function getAiConfigMasked(): Record<string, string> | null {
  const config = getAiConfig()
  if (!config) return null
  return {
    provider: config.provider,
    apiKey: config.apiKey ? `****${config.apiKey.slice(-4)}` : '',
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    visionBaseUrl: config.visionBaseUrl,
    visionApiKey: config.visionApiKey ? `****${config.visionApiKey.slice(-4)}` : '',
    visionModel: config.visionModel,
  }
}

/**
 * H-3（v0.3.0 audit）：saveAiConfig 掩码守卫（纯函数）。
 *
 * 红线：设置页任意保存不会把 **** 掩码串落库覆盖真实 apiKey/visionApiKey。
 * 主进程侧兜住一切掩码回传（不限定键名、不依赖 renderer 行为）：
 * 值以 **** 开头的键直接剔除，merge 分支 `config.X ?? current.X` 自动保持现值；
 * INSERT 分支掩码串也不会落库。null/''/undefined 值不剔除（?? 语义交给 merge）。
 */
export function stripMaskedKeys(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.startsWith('****')) continue
    out[key] = value
  }
  return out
}

export function saveAiConfig(rawConfig: Record<string, string>): void {
  const config = stripMaskedKeys(rawConfig)
  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM ai_config LIMIT 1').get() as any

  if (existing) {
    // Merge: only overwrite fields that are explicitly provided
    const current = getAiConfig() || {}
    const merged = {
      provider: config.provider ?? current.provider ?? '',
      apiKey: config.apiKey ?? current.apiKey ?? '',
      baseUrl: config.baseUrl ?? current.baseUrl ?? '',
      modelName: config.modelName ?? current.modelName ?? '',
      visionBaseUrl: config.visionBaseUrl ?? current.visionBaseUrl ?? '',
      visionApiKey: config.visionApiKey ?? current.visionApiKey ?? '',
      visionModel: config.visionModel ?? current.visionModel ?? '',
    }
    db.prepare(
      `UPDATE ai_config SET provider_enc=?, api_key_enc=?, base_url_enc=?, model_name_enc=?, vision_base_url_enc=?, vision_api_key_enc=?, vision_model_enc=? WHERE id=?`
    ).run(
      encField(merged.provider, MK),
      encField(merged.apiKey, MK),
      encField(merged.baseUrl, MK),
      encField(merged.modelName, MK),
      encField(merged.visionBaseUrl, MK),
      encField(merged.visionApiKey, MK),
      encField(merged.visionModel, MK),
      existing.id
    )
  } else {
    const id = uuidv4()
    db.prepare(
      `INSERT INTO ai_config (id, provider_enc, api_key_enc, base_url_enc, model_name_enc, vision_base_url_enc, vision_api_key_enc, vision_model_enc) VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      id,
      encField(config.provider ?? '', MK),
      encField(config.apiKey ?? '', MK),
      encField(config.baseUrl ?? '', MK),
      encField(config.modelName ?? '', MK),
      encField(config.visionBaseUrl ?? '', MK),
      encField(config.visionApiKey ?? '', MK),
      encField(config.visionModel ?? '', MK)
    )
  }
}

// ---------- Exec mode ----------

/** 执行模式三档（Phase 22 D-01）：confirm=每次确认（最严，默认）/ smart=智能 / auto=全自动（需管理员密码门槛） */
export type ExecMode = 'confirm' | 'smart' | 'auto'

/** 白名单：三值之外全部拒绝（T-22-05） */
const EXEC_MODES: ExecMode[] = ['confirm', 'smart', 'auto']

export function getExecMode(): string {
  const row = getDatabase()
    .prepare('SELECT exec_mode FROM ai_config LIMIT 1')
    .get() as any
  return row?.exec_mode || 'confirm'
}

export function setExecMode(mode: string, password: string): { success: boolean; error?: string } {
  if (!EXEC_MODES.includes(mode as ExecMode)) {
    return { success: false, error: '无效的执行模式' }
  }
  // 仅切「全自动」过管理员密码门槛（提权面 T-22-05）；smart/confirm 免门槛
  if (mode === 'auto') {
    const user = getDatabase()
      .prepare('SELECT password_hash FROM users LIMIT 1')
      .get() as any
    if (!user || !verifyPasswordSync(password, user.password_hash)) {
      return { success: false, error: '密码验证失败' }
    }
  }
  getDatabase()
    .prepare('UPDATE ai_config SET exec_mode = ?')
    .run(mode)
  return { success: true }
}

// ---------- Command whitelist ----------

export function getCommandWhitelist(): string[] {
  const rows = getDatabase()
    .prepare('SELECT pattern FROM command_whitelist ORDER BY pattern')
    .all() as any[]
  return rows.map((r) => r.pattern)
}

export function saveCommandWhitelist(list: string[]): void {
  const db = getDatabase()
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM command_whitelist').run()
    const stmt = db.prepare('INSERT INTO command_whitelist (id, pattern) VALUES (?, ?)')
    for (const pattern of list) {
      stmt.run(uuidv4(), pattern)
    }
  })
  transaction()
}
