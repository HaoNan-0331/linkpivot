import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import type { PaginatedResult } from '../../src/types/pagination'

/**
 * ExperienceService —— Phase 7 经验沉淀数据层 service。
 *
 * 形态决策（CONVENTIONS Pattern 1a）：函数式 + 模块级 masterKey。
 * 与 knowledgeBaseService.ts 同属知识库域、同读写加密列（attrs_enc），统一采用函数式形态
 * （非静态类）。masterKey 由 main.ts 启动时经 setExperienceMasterKey() 注入，service 不直接
 * 读 keyManager（解耦 + 可测试）。
 *
 * 字段加密红线：attrs_enc 列只走 encField/decField（自带 null/降级处理），禁止裸调 encrypt/decrypt。
 *
 * attrs 模板校验：troubleshooting 类强制 severity（critical/high/medium/low/info 之一），缺/非法 throw。
 *
 * bi-temporal 软失效：失效经验不物理删除（保留可追溯历史），listExperiences 默认过滤
 * `invalid_at IS NULL OR invalid_at > datetime('now','localtime')`。
 *
 * 批量上限：MAX_BATCH=1000 防 list 越权拉全表。
 */

let MK = ''

export function setExperienceMasterKey(key: string) {
  MK = key
}

export const MAX_BATCH = 1000

// 默认走生产单例 db；测试经 _setExperienceDbGetter 注入内存 mock（规避 DEP-1 native binding ABI 冲突）。
let dbGetter: () => Database.Database = getDatabase

/** @internal 测试专用：注入 db getter（生产不调用）。 */
export function _setExperienceDbGetter(fn: () => Database.Database): void {
  dbGetter = fn
}

function db(): Database.Database {
  return dbGetter()
}

export type ExperienceCategory = 'troubleshooting' | 'best_practices' | 'product' | 'env'
export type ExperienceStatus = 'draft' | 'confirmed' | 'published' | 'invalid'

const VALID_CATEGORIES: ExperienceCategory[] = ['troubleshooting', 'best_practices', 'product', 'env']
const VALID_STATUSES: ExperienceStatus[] = ['draft', 'confirmed', 'published', 'invalid']
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

export interface ExperienceAttrs {
  // troubleshooting 深字段（其他类轻结构，attrs 可为空）
  symptoms?: string
  root_cause?: string
  resolution?: string
  prevention?: string
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'
}

export interface ExperienceInput {
  title: string
  category: ExperienceCategory
  content: string
  tags?: string[]
  sourceSessionId?: string | null
  attrs?: ExperienceAttrs | null
}

export interface ExperienceUpdateFields {
  title?: string
  category?: ExperienceCategory
  content?: string
  tags?: string[]
  status?: ExperienceStatus
  attrs?: ExperienceAttrs | null
  validAt?: string
  invalidAt?: string | null
  lastVerifiedAt?: string
  reuseCount?: number
}

export interface ListExperiencesOpts {
  category?: ExperienceCategory
  status?: ExperienceStatus
  deviceId?: string
  includeInvalid?: boolean
  limit?: number
  offset?: number
}

/**
 * attrs 模板校验 + JSON 序列化。
 * - troubleshooting 类若 attrs 非空，强制 severity 必须是 5 枚举之一（缺/非法 throw）
 * - attrs 为空对象/null → 返 null（不加密空 attrs）
 * - 返回 JSON 字符串待 encField 加密
 */
function validateAndStringifyAttrs(category: ExperienceCategory, attrs: ExperienceAttrs | null | undefined): string | null {
  if (!attrs || Object.keys(attrs).length === 0) return null
  if (category === 'troubleshooting') {
    if (!attrs.severity || !VALID_SEVERITIES.includes(attrs.severity)) {
      throw new Error('troubleshooting 类经验 attrs 缺少合法 severity')
    }
  }
  return JSON.stringify(attrs)
}

/** 行映射：解密 attrs_enc 回填 attrs 字段，delete 密文列（不外泄给调用方）。 */
function rowToExperience(row: any): any {
  if (!row) return null
  if (row.attrs_enc) {
    const dec = decField(row.attrs_enc, MK)
    try {
      row.attrs = dec ? JSON.parse(dec) : {}
    } catch {
      // decField 降级返 ''，JSON.parse('') 异常 → attrs 空对象（坏密文不崩）
      row.attrs = {}
    }
  } else {
    row.attrs = null
  }
  delete row.attrs_enc
  return row
}

// ---------- CRUD ----------

export function createExperience(input: ExperienceInput): any {
  if (!VALID_CATEGORIES.includes(input.category)) {
    throw new Error(`非法 category: ${input.category}`)
  }
  const id = uuidv4()
  const attrsStr = validateAndStringifyAttrs(input.category, input.attrs)
  const attrsEnc = attrsStr ? encField(attrsStr, MK) : null
  const tags = JSON.stringify(input.tags ?? [])
  const conn = db()
  conn.prepare(
    `INSERT INTO experiences (id, title, category, content, tags, status, source_session_id, attrs_enc, valid_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, datetime('now','localtime'))`
  ).run(id, input.title, input.category, input.content, tags, input.sourceSessionId ?? null, attrsEnc)
  return getExperience(id)
}

export function getExperience(id: string): any | null {
  const row = db().prepare('SELECT * FROM experiences WHERE id = ?').get(id) as any
  return rowToExperience(row)
}

/**
 * 列表查询（bi-temporal 软失效过滤 + 多维筛选 + 分页信封）。
 * limit 守卫：null/0/负 → 默认 100；> MAX_BATCH → throw。
 */
export function listExperiences(opts: ListExperiencesOpts): PaginatedResult<any> {
  // limit 守卫
  let limit = opts.limit
  if (limit == null || limit <= 0) limit = 100
  if (limit > MAX_BATCH) {
    throw new Error('limit 超过 MAX_BATCH 上限')
  }
  const offset = opts.offset ?? 0

  const conditions: string[] = []
  const params: any[] = []

  if (opts.category) {
    conditions.push('e.category = ?')
    params.push(opts.category)
  }
  if (opts.status) {
    conditions.push('e.status = ?')
    params.push(opts.status)
  }
  // bi-temporal 默认过滤已失效（includeInvalid=false）
  if (!opts.includeInvalid) {
    conditions.push("(e.invalid_at IS NULL OR e.invalid_at > datetime('now','localtime'))")
  }

  const conn = db()
  let rowsSql: string
  if (opts.deviceId) {
    // JOIN exp_device_rel 反查
    rowsSql =
      `SELECT e.* FROM experiences e ` +
      `JOIN exp_device_rel r ON e.id = r.experience_id ` +
      `WHERE r.device_id = ?` +
      (conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '') +
      ` ORDER BY e.created_at DESC`
    rowsSql = injectLimitOffset(rowsSql)
    const rowsParams = [opts.deviceId, ...params, limit, offset]
    const rows = (conn.prepare(rowsSql).all(...rowsParams) as any[]).map(rowToExperience)
    const totalSql =
      `SELECT COUNT(*) AS cnt FROM experiences e ` +
      `JOIN exp_device_rel r ON e.id = r.experience_id ` +
      `WHERE r.device_id = ?` +
      (conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '')
    const total = (conn.prepare(totalSql).get(opts.deviceId, ...params) as any).cnt
    return { rows, total, truncated: rows.length < total }
  }

  rowsSql =
    `SELECT e.* FROM experiences e` +
    (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '') +
    ` ORDER BY e.created_at DESC`
  rowsSql = injectLimitOffset(rowsSql)
  const rows = (conn.prepare(rowsSql).all(...params, limit, offset) as any[]).map(rowToExperience)
  const totalSql =
    `SELECT COUNT(*) AS cnt FROM experiences e` +
    (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '')
  const total = (conn.prepare(totalSql).get(...params) as any).cnt
  return { rows, total, truncated: rows.length < total }
}

/** 注入 LIMIT/OFFSET（参数化，已在末尾追加 limit/offset 到 params）。 */
function injectLimitOffset(sql: string): string {
  return sql + ' LIMIT ? OFFSET ?'
}

/**
 * 更新单条经验（动态拼 SET，仅允许白名单列）。
 * - attrs 非空时校验 + 重新加密
 * - updated_at 恒更新
 * - 多字段单语句原子；包 transaction 防御（若未来扩展为同时改关联则原子）
 */
export function updateExperience(id: string, fields: ExperienceUpdateFields): any {
  const sets: string[] = []
  const params: any[] = []

  if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title) }
  if (fields.category !== undefined) {
    if (!VALID_CATEGORIES.includes(fields.category)) throw new Error(`非法 category: ${fields.category}`)
    sets.push('category = ?'); params.push(fields.category)
  }
  if (fields.content !== undefined) { sets.push('content = ?'); params.push(fields.content) }
  if (fields.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(fields.tags)) }
  if (fields.status !== undefined) {
    if (!VALID_STATUSES.includes(fields.status)) throw new Error(`非法 status: ${fields.status}`)
    sets.push('status = ?'); params.push(fields.status)
  }
  if (fields.attrs !== undefined) {
    // category 用于校验：若同时改 category 则用新 category，否则查现有
    const cat = fields.category ?? (getExperience(id) as any)?.category
    if (!cat) throw new Error('经验不存在，无法更新 attrs')
    const attrsStr = validateAndStringifyAttrs(cat, fields.attrs)
    const attrsEnc = attrsStr ? encField(attrsStr, MK) : null
    sets.push('attrs_enc = ?'); params.push(attrsEnc)
  }
  if (fields.validAt !== undefined) { sets.push('valid_at = ?'); params.push(fields.validAt) }
  if (fields.invalidAt !== undefined) { sets.push('invalid_at = ?'); params.push(fields.invalidAt) }
  if (fields.lastVerifiedAt !== undefined) { sets.push('last_verified_at = ?'); params.push(fields.lastVerifiedAt) }
  if (fields.reuseCount !== undefined) { sets.push('reuse_count = ?'); params.push(fields.reuseCount) }

  if (sets.length === 0) {
    // 无可更新字段，直接返回当前行
    return getExperience(id)
  }

  sets.push("updated_at = datetime('now','localtime')")
  params.push(id)

  const conn = db()
  const tx = conn.transaction(() => {
    conn.prepare(`UPDATE experiences SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  })
  tx()
  return getExperience(id)
}

/** 软失效：设 invalid_at（不物理删除，保留可追溯历史）。 */
export function invalidateExperience(id: string): any {
  const conn = db()
  conn.prepare(
    `UPDATE experiences SET invalid_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(id)
  return getExperience(id)
}

/** 物理删除（exp_device_rel 因 ON DELETE CASCADE 自动清理；仅 Phase 10 浏览页手动删除调用）。 */
export function deleteExperience(id: string): void {
  db().prepare('DELETE FROM experiences WHERE id = ?').run(id)
}

// ---------- 设备关联 ----------

/** 关联设备（INSERT OR IGNORE 幂等去重，UNIQUE(experience_id, device_id) 守卫）。 */
export function relateDevice(experienceId: string, deviceId: string, relationType: string = 'primary'): void {
  db().prepare(
    `INSERT OR IGNORE INTO exp_device_rel (id, experience_id, device_id, relation_type) VALUES (?, ?, ?, ?)`
  ).run(uuidv4(), experienceId, deviceId, relationType)
}

/** 取消关联（删单条）。 */
export function unrelateDevice(experienceId: string, deviceId: string): void {
  db().prepare('DELETE FROM exp_device_rel WHERE experience_id = ? AND device_id = ?').run(experienceId, deviceId)
}

/** 经验→关联设备基本信息（name_enc 等密文列原样，脱敏由 IPC 层处理）。 */
export function listDevicesByExperience(experienceId: string): any[] {
  return db().prepare(
    `SELECT d.* FROM devices d JOIN exp_device_rel r ON d.id = r.device_id WHERE r.experience_id = ?`
  ).all(experienceId) as any[]
}

/** 设备→关联经验（反查，复用 listExperiences 的 deviceId 分支；无分页，返全部有效关联经验）。 */
export function listExperiencesByDevice(deviceId: string, includeInvalid: boolean = false): any[] {
  return listExperiences({ deviceId, includeInvalid, limit: MAX_BATCH, offset: 0 }).rows
}

// ---------- Phase 11 复用接口预埋（本 phase 实现，Phase 11 消费） ----------

export function incReuseCount(id: string): void {
  db().prepare('UPDATE experiences SET reuse_count = reuse_count + 1 WHERE id = ?').run(id)
}

export function touchLastVerifiedAt(id: string): void {
  db().prepare("UPDATE experiences SET last_verified_at = datetime('now','localtime') WHERE id = ?").run(id)
}
