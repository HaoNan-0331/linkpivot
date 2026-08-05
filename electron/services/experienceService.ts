import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { getDeviceById } from './device'
import { getChatHistory } from './ai'
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
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/**
 * WR-04：troubleshooting 类 attrs 质量门单一来源。
 * confirmDrafts（service 层兜底校验）与 validateAndStringifyAttrs（update/create 入口校验）共用，
 * 避免双份手写校验未来漂移（一处改 severity 枚举/必填字段而另一处漏改）。
 * ctx 用于错误信息标注来源（如「草稿 {id}」），便于排错定位。
 */
function assertTroubleshootingAttrs(attrs: any, ctx: string): void {
  const sev = attrs?.severity
  if (!sev || !VALID_SEVERITIES.includes(sev)) {
    throw new Error(`${ctx} 缺合法 severity`)
  }
  if (!attrs?.symptoms || !String(attrs.symptoms).trim()) {
    throw new Error(`${ctx} 缺 symptoms`)
  }
  if (!attrs?.resolution || !String(attrs.resolution).trim()) {
    throw new Error(`${ctx} 缺 resolution`)
  }
}

// CR-02 bi-temporal 文本比较格式契约：
// experiences.valid_at / invalid_at / last_verified_at 三列所有写入必须是
// `YYYY-MM-DD HH:MM:SS`（localtime，无毫秒/无时区偏移）格式，否则与
// `datetime('now','localtime')` 的字典序文本比较会失真（如 'T'(0x54) > 空格(0x20)
// 误判更晚），导致 listExperiences 的 `invalid_at > datetime('now','localtime')`
// 漏判/误判有效态。当前写入路径：
// - createExperience：valid_at 走 DB DEFAULT datetime('now','localtime')（合规）
// - invalidateExperience：invalid_at 走 datetime('now','localtime')（合规）
// - incReuseCount/touchLastVerifiedAt：last_verified_at 走 datetime('now','localtime')（合规）
// CR-01 已切断 renderer 经 update 直写三列的路径。任何未来新增的「外部时间戳入参」入口
// （如 Phase 11 允许回填校验时间）必须经此守卫校验。
const CANONICAL_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** 校验外部时间戳入参符合 bi-temporal 列格式契约（YYYY-MM-DD HH:MM:SS localtime）。 */
export function assertCanonicalTimestamp(v: string, col: string): void {
  if (!CANONICAL_TS_RE.test(v)) {
    throw new Error(`${col} 格式必须是 YYYY-MM-DD HH:MM:SS（localtime），收到: ${v}`)
  }
}

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
  /** Phase 8 D-03a：UPDATE 草稿标注命中的旧 exp_id。不传/传 null → 写 NULL（向后兼容 Phase 7）。 */
  duplicateOfExpId?: string | null
}

// CR-01 收紧：renderer 入参仅业务字段。
// status / validAt / invalidAt / lastVerifiedAt / reuseCount 五个审计/状态字段移出白名单，
// 只能经专用受控接口修改：invalidateExperience（软失效→invalid_at）、incReuseCount
// （reuse_count++）、touchLastVerifiedAt（last_verified_at）。valid_at 仅 create 时由
// datetime('now','localtime') 默认值生成，无后续修改入口。renderer 无法经 update 绕过。
export interface ExperienceUpdateFields {
  title?: string
  category?: ExperienceCategory
  content?: string
  tags?: string[]
  attrs?: ExperienceAttrs | null
}

export interface ListExperiencesOpts {
  category?: ExperienceCategory
  status?: ExperienceStatus
  /** Phase 10 D-10-2：接受单值（向后兼容 Phase 7-9）或多选数组（UI-SPEC §3 设备多选 IN 占位 OR-join）。 */
  deviceId?: string | string[]
  includeInvalid?: boolean
  limit?: number
  offset?: number
  /** Phase 10 D-10-2：关键词搜索（SQL LIKE title/content，参数化防注入）。 */
  search?: string
  /** Phase 10 D-10-2：severity 明文列直筛（WHERE e.severity = ?）。 */
  severity?: string
  /** Phase 10 D-10-2：标签多选命中任一（tags JSON 列 LIKE，参数化 OR-join）。 */
  tags?: string[]
}

/**
 * Phase 9 D-9-1/D-9-4：confirmDrafts 受控接口入参（draft→published + 可选 supersede 旧条目 + 丢弃）。
 * fields 复用 ExperienceUpdateFields（CR-01 白名单，不含 status）——采纳时若用户在弹窗编辑过字段则一并落库。
 * relateDevices：全量期望关联 device_id 列表（confirmDrafts 内 diff 现有关联后调 relateDevice/unrelateDevice）。
 *   语义：undefined 或空数组 [] 都视为「不动现有关联」（diff 跳过）；只有 length>0 的显式数组才触发 diff。
 *   空数组语义已废弃，防 renderer 默认值传播静默拆关联。
 * supersedeOld：D-9-2，UPDATE 草稿（duplicate_of_exp_id 非空）专用，默认 false（防 Phase 8 AI 误判
 *   UPDATE 实为 ADD 误删有效旧条目），true 时旧条目经 invalidateExperience 软失效（invalid_at 落时间）。
 */
export interface ConfirmDraftItem {
  expId: string
  action: 'adopt' | 'discard'
  fields?: ExperienceUpdateFields
  relateDevices?: string[]
  supersedeOld?: boolean
}
export interface ConfirmDraftsInput { drafts: ConfirmDraftItem[] }
export interface ConfirmDraftsResult { adopted: number; discarded: number; superseded: number }

/**
 * attrs 模板校验 + JSON 序列化。
 * - 非 troubleshooting 类 attrs 为空对象/null/undefined → 返 null（不加密空 attrs）
 * - WR-04：troubleshooting 类 severity 必填且必须是 5 枚举之一（即便 attrs 显式传空也强制），
 *   与「troubleshooting 必填 severity」契约一致，避免 Phase 8 详情页遇 attrs=null 无法
 *   severity 筛选/排序
 * - 返回 JSON 字符串待 encField 加密
 */
function validateAndStringifyAttrs(category: ExperienceCategory, attrs: ExperienceAttrs | null | undefined): string | null {
  if (category === 'troubleshooting') {
    // WR-04：troubleshooting 优先校验 severity（attrs 清空也强制），不进入下方空 attrs 早返分支
    if (!attrs || !attrs.severity || !VALID_SEVERITIES.includes(attrs.severity)) {
      throw new Error('troubleshooting 类经验 attrs 必须含合法 severity')
    }
  }
  if (!attrs || Object.keys(attrs).length === 0) return null
  return JSON.stringify(attrs)
}

/** 行映射：解密 attrs_enc 回填 attrs 字段，delete 密文列（不外泄给调用方）。
 * IF-03：tags 列以 JSON 字符串存储（createExperience 用 JSON.stringify），读出时
 * JSON.parse 回 string[]，与 Experience.tags: string[] DTO 一致，避免 renderer
 * 直接 .map/.includes 崩溃。坏 JSON 降级空数组（与 attrs parse 同模式）。 */
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
  // IF-03 tags JSON 字符串 → string[]（运行时匹配 DTO，坏 JSON 降级空数组）
  if (row.tags != null && typeof row.tags === 'string') {
    try {
      row.tags = JSON.parse(row.tags)
    } catch {
      row.tags = []
    }
    if (!Array.isArray(row.tags)) row.tags = []
  } else if (row.tags == null) {
    row.tags = []
  }
  // Phase 10 D-10-2：severity 列 NULL 时 fallback 读 attrs.severity（向后兼容历史数据）。
  // 顺序关键：必须在 attrs 回填之后（row.attrs.severity 可读）、delete attrs_enc 之前。
  // 迁移在 MK 注入前跑，无法在 v10 内解密回填 severity 明文列——历史数据 severity 仍只在 attrs_enc，
  // service 层此 fallback 保证历史数据可读（D-10-2「保证历史数据可查」核心承诺）。
  if (row.severity == null && row.attrs && row.attrs.severity) {
    row.severity = row.attrs.severity
  }
  delete row.attrs_enc
  return row
}

// ---------- CRUD ----------

export function createExperience(input: ExperienceInput & { status?: ExperienceStatus }): any {
  if (!VALID_CATEGORIES.includes(input.category)) {
    throw new Error(`非法 category: ${input.category}`)
  }
  const id = uuidv4()
  const attrsStr = validateAndStringifyAttrs(input.category, input.attrs)
  const attrsEnc = attrsStr ? encField(attrsStr, MK) : null
  const tags = JSON.stringify(input.tags ?? [])
  // Phase 8 B-1/B-2 方案 A：duplicate_of_exp_id 与 draft 行同 INSERT 单语句原子写入。
  // CREATE 成功即标注同写入，失败 throw → 整条不落库（标注与 draft 行共存亡）。
  // 不校验指向 exp_id 存在性（信任 Plan 03 编排层传入 LLM 判定 + Phase 9 人工确认兜底；experiences 表无 self-FK）。
  const dupId = input.duplicateOfExpId ?? null
  // Phase 10 D-10-1：status 默认 'draft'（保 Phase 7-9 AI 起草调用方零改动），手动新增传 'published'
  // （红线③ 例外：人工录入非 AI 产出，不进 draft 闸口，见 CONTEXT specifics）。
  const statusVal: ExperienceStatus = input.status ?? 'draft'
  // Phase 10 D-10-2：severity 明文列双写（troubleshooting 类从 attrs.severity 取，其他类 null）。
  const severityVal = input.category === 'troubleshooting' ? (input.attrs?.severity ?? null) : null
  const conn = db()
  conn.prepare(
    `INSERT INTO experiences (id, title, category, content, tags, status, source_session_id, attrs_enc, valid_at, duplicate_of_exp_id, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?)`
  ).run(id, input.title, input.category, input.content, tags, statusVal, input.sourceSessionId ?? null, attrsEnc, dupId, severityVal)
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
  // Phase 10 D-10-2：search 关键词 LIKE（title/content，参数化防注入 T-10-01 mitigate）
  if (opts.search) {
    conditions.push('(e.title LIKE ? OR e.content LIKE ?)')
    const kw = `%${opts.search}%`
    params.push(kw, kw)
  }
  // Phase 10 D-10-2：severity 明文列直筛（WHERE e.severity = ?）。
  // 历史数据 severity 列 NULL 但 attrs.severity 有值时此 WHERE 筛不到（已知限制，
  // D-10-2「保证历史数据可查」指 fallback 读而非 fallback 筛）。
  if (opts.severity) {
    conditions.push('e.severity = ?')
    params.push(opts.severity)
  }
  // Phase 10 D-10-2：tags 多选命中任一（tags 明文 JSON 列 LIKE，参数化 OR-join）
  if (opts.tags && opts.tags.length > 0) {
    const ors = opts.tags.map(() => 'e.tags LIKE ?')
    conditions.push(`(${ors.join(' OR ')})`)
    opts.tags.forEach((t) => params.push(`%"${t}"%`))
  }
  // bi-temporal 默认过滤已失效（includeInvalid=false）
  if (!opts.includeInvalid) {
    conditions.push("(e.invalid_at IS NULL OR e.invalid_at > datetime('now','localtime'))")
  }

  // Phase 10 D-10-2：deviceId 单值/数组 normalize（向后兼容 string，UI 多选用 string[]）
  const deviceIds: string[] = opts.deviceId
    ? (Array.isArray(opts.deviceId) ? opts.deviceId : [opts.deviceId])
    : []

  // device_count 子查询（零 N+1）：两分支都带，单次 SQL 带出每行关联设备计数。
  const deviceCountSub = `(SELECT COUNT(*) FROM exp_device_rel r2 WHERE r2.experience_id = e.id) AS device_count`

  const conn = db()
  let rowsSql: string
  if (deviceIds.length > 0) {
    // JOIN exp_device_rel 反查，多选 IN 占位（参数化，非拼接值 T-10-01 mitigate）。
    // GROUP BY e.id 去重：一条经验关联多个选中设备时 JOIN 产生多行，去重后恰返 1 次（Test 5 守护）。
    const inPlaceholders = deviceIds.map(() => '?').join(',')
    rowsSql =
      `SELECT e.*, ${deviceCountSub} FROM experiences e ` +
      `JOIN exp_device_rel r ON e.id = r.experience_id ` +
      `WHERE r.device_id IN (${inPlaceholders})` +
      (conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '') +
      ` GROUP BY e.id ORDER BY e.created_at DESC`
    rowsSql = injectLimitOffset(rowsSql)
    const rowsParams = [...deviceIds, ...params, limit, offset]
    const rows = (conn.prepare(rowsSql).all(...rowsParams) as any[]).map(rowToExperience)
    // total 用 COUNT(DISTINCT e.id) 去重计数（一条经验关联多选中设备只算 1 条）。
    const totalSql =
      `SELECT COUNT(DISTINCT e.id) AS cnt FROM experiences e ` +
      `JOIN exp_device_rel r ON e.id = r.experience_id ` +
      `WHERE r.device_id IN (${inPlaceholders})` +
      (conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '')
    const total = (conn.prepare(totalSql).get(...deviceIds, ...params) as any).cnt
    return { rows, total, truncated: rows.length < total }
  }

  rowsSql =
    `SELECT e.*, ${deviceCountSub} FROM experiences e` +
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
  if (fields.attrs !== undefined) {
    // category 用于校验：若同时改 category 则用新 category，否则查现有
    const cat = fields.category ?? (getExperience(id) as any)?.category
    if (!cat) throw new Error('经验不存在，无法更新 attrs')
    const attrsStr = validateAndStringifyAttrs(cat, fields.attrs)
    const attrsEnc = attrsStr ? encField(attrsStr, MK) : null
    sets.push('attrs_enc = ?'); params.push(attrsEnc)
    // Phase 10 D-10-2：severity 明文列双写（与 attrs.severity 保持一致）。
    // troubleshooting 类从 attrs.severity 取；其他类清空 severity 列（category 跨边界时复位）。
    sets.push('severity = ?')
    params.push(cat === 'troubleshooting' ? (fields.attrs?.severity ?? null) : null)
  } else if (fields.category !== undefined) {
    // 仅改 category（未传 attrs）：跨 troubleshooting 边界时需重算 severity 列。
    // category 非 troubleshooting → severity 列清 null；category 改 troubleshooting 但无 attrs 不强行塞 severity（保 null，service 入口 validateAndStringifyAttrs 不在 update 路径触发）。
    const newCat = fields.category
    const cur = getExperience(id) as any
    const curSev = newCat === 'troubleshooting' ? (cur?.attrs?.severity ?? null) : null
    sets.push('severity = ?'); params.push(curSev)
  }

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

/** 软失效：设 invalid_at（不物理删除，保留可追溯历史）。
 * CR-02 格式契约：invalid_at 用 datetime('now','localtime') 写入，天然产出
 * YYYY-MM-DD HH:MM:SS（localtime），与 listExperiences 的 `invalid_at > datetime(...)`
 * 文本比较格式一致，无需 assertCanonicalTimestamp 校验。 */
export function invalidateExperience(id: string): any {
  const conn = db()
  conn.prepare(
    `UPDATE experiences SET invalid_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(id)
  return getExperience(id)
}

/**
 * Phase 10 D-10-3：撤销恢复（受控接口，与 invalidateExperience 对称）。
 * 清 invalid_at + 显式 status 回 'published'（invalidate 不动 status，restore 须显式回有效态）。
 * 绕 CR-01 update 白名单（不复活 status 字段），与 invalidate/incReuseCount/touchLastVerifiedAt 同模式
 * （受控状态接口改审计/状态字段，不经 update 白名单）。T-10-03 mitigate：status 直回 'published'
 * 不接受 renderer 入参（无 status 参数），无法被滥用改其他状态。
 */
export function restoreExperience(id: string): any {
  const conn = db()
  conn.prepare(
    `UPDATE experiences SET invalid_at = NULL, status = 'published', updated_at = datetime('now','localtime') WHERE id = ?`
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

/**
 * 经验→关联设备（WR-05 白名单正向投影）。
 * 旧实现 `SELECT d.*` 返 devices 原始行（含所有 `_enc` 密文列），靠 IPC 层 stripEncColumns
 * 黑名单剥离——未来 devices 新增非 `_enc` 后缀敏感列会静默泄露 renderer。
 * 改为：先查关联 device_id 列表，再逐个调 deviceService.getDeviceById（device 域既有的
 * rowToDevice 安全白名单映射，只返 Device DTO 明文字段，密文经 device MK 解密）。
 * 关联设备量小（单经验几台），N+1 可接受；安全优于单 SQL 黑名单剥离。IPC 层 stripEncColumns
 * 保留作深度防御（Device DTO 已无 `_enc` 列，实际无操作）。
 */
export function listDevicesByExperience(experienceId: string): any[] {
  const rows = db().prepare(
    `SELECT r.device_id AS device_id FROM exp_device_rel r WHERE r.experience_id = ?`
  ).all(experienceId) as Array<{ device_id: string }>
  return rows
    .map((r) => getDeviceById(r.device_id))
    .filter((d): d is NonNullable<typeof d> => d !== null)
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

// ---------- Phase 9 人工确认闸口（session→permanent 唯一人工闸口，红线③执行点） ----------

/**
 * Phase 9 D-9-1/D-9-4：批量确认草稿。
 * 单事务原子（throw ROLLBACK，全成全败）：
 * - action='adopt'：UPDATE status='draft'→'published' + 若 fields 非空则 updateExperience 落编辑字段 + diff relateDevices
 * - action='adopt' + supersedeOld=true 且 draft.duplicate_of_exp_id 非空：invalidateExperience(旧条目) 软失效（D-9-2）
 * - action='discard'：deleteExperience（hard DELETE，D-9-6）
 * 质量门 service 层兜底：adopt 的 troubleshooting 草稿二次校验 severity/symptoms/resolution，
 * 轻结构类校验 title/content 必填（与 renderer 标红三层纵深）。
 * 不动 CR-01 收紧的 updateExperience 白名单——status 改变只走本接口（draft→published），不复活 update 的 status 字段。
 */
export function confirmDrafts(input: ConfirmDraftsInput): ConfirmDraftsResult {
  if (!input || !Array.isArray(input.drafts)) {
    throw new Error('confirmDrafts 入参无效：drafts 必须为数组')
  }
  if (input.drafts.length > MAX_BATCH) {
    throw new Error(`批量上限超过 MAX_BATCH（${MAX_BATCH}）`)
  }
  let adopted = 0
  let discarded = 0
  let superseded = 0
  const conn = db()
  const tx = conn.transaction(() => {
    // 循环外 prepare 复用（CONVENTIONS Pattern 4）
    const stmtPublish = conn.prepare(
      `UPDATE experiences SET status = 'published', updated_at = datetime('now','localtime') WHERE id = ?`
    )
    // WR-05：relateDevices diff 用轻量查询（只取 device_id 列表），不经 listDevicesByExperience
    // （后者每设备走 getDeviceById 白名单投影 + 解密 9 个 _enc 列再丢弃——本场景只需 id 集合 diff，
    // 同事务内批量 adopt 多条草稿时是显著的同步解密浪费）。listDevicesByExperience 自身不变（其他通道在用）。
    const stmtCurDev = conn.prepare(
      `SELECT device_id FROM exp_device_rel WHERE experience_id = ?`
    )
    for (const d of input.drafts) {
      if (d.action === 'discard') {
        deleteExperience(d.expId)
        discarded++
        continue
      }
      // action === 'adopt'
      const cur = getExperience(d.expId) as any
      if (!cur) throw new Error(`草稿不存在: ${d.expId}`)
      // 质量门 service 层兜底：adopt 时若用户编辑过 fields 则用 fields，否则用现有 cur 字段
      const finalCategory = d.fields?.category ?? cur.category
      const finalAttrs = d.fields?.attrs !== undefined ? d.fields.attrs : cur.attrs
      const finalTitle = d.fields?.title ?? cur.title
      const finalContent = d.fields?.content ?? cur.content
      // troubleshooting 必填校验（severity/symptoms/resolution）
      // WR-04：抽 assertTroubleshootingAttrs 单一来源，避免与 validateAndStringifyAttrs 漂移。
      // 注意：validateAndStringifyAttrs（create/update 入口）仅强制 severity（Phase 8 AI 起草允许
      // 缺 symptoms/resolution 的不完整 draft 落库），confirmDrafts adopt 是「发布前最后一道闸口」
      // 强制三字段必填——两处契约有意分层，severity 枚举共用 VALID_SEVERITIES 常量消除漂移。
      if (finalCategory === 'troubleshooting') {
        assertTroubleshootingAttrs(finalAttrs, `草稿 ${d.expId} troubleshooting`)
      } else {
        // 轻结构类：title/content 必填
        if (!finalTitle || !String(finalTitle).trim()) {
          throw new Error(`草稿 ${d.expId} 缺 title，无法确认`)
        }
        if (!finalContent || !String(finalContent).trim()) {
          throw new Error(`草稿 ${d.expId} 缺 content，无法确认`)
        }
      }
      // 落编辑字段（若有）——走 updateExperience（CR-01 白名单，不含 status）
      if (d.fields && Object.keys(d.fields).length > 0) {
        updateExperience(d.expId, d.fields)
      }
      // draft→published（专用接口，不复活 update 白名单）
      stmtPublish.run(d.expId)
      adopted++
      // 设备关联 diff：仅当 relateDevices 为 length>0 的显式数组才触发（undefined/空数组都视为
      // 不动现有关联，防 renderer 默认空数组静默拆光所有现有关联）
      if (d.relateDevices != null && d.relateDevices.length > 0) {
        const curDevices = (stmtCurDev.all(d.expId) as Array<{ device_id: string }>).map((r) => r.device_id)
        const expectSet = new Set(d.relateDevices)
        const toAdd = d.relateDevices.filter((id) => !curDevices.includes(id))
        const toRemove = curDevices.filter((id) => !expectSet.has(id))
        for (const did of toAdd) relateDevice(d.expId, did)
        for (const did of toRemove) unrelateDevice(d.expId, did)
      }
      // D-9-2：UPDATE 草稿（duplicate_of_exp_id 非空）+ supersedeOld=true → 旧条目软失效
      if (d.supersedeOld && cur.duplicate_of_exp_id) {
        invalidateExperience(cur.duplicate_of_exp_id)
        superseded++
      }
    }
  })
  tx()
  return { adopted, discarded, superseded }
}

/**
 * Phase 9 D-9-7：列暂存 draft（AIPage 待确认角标入口用，重开确认弹窗）。
 * 复用 listExperiences 的 status='draft' 过滤分支；draft 行 invalid_at 恒 NULL，includeInvalid 取值不影响。
 */
export function listDrafts(): any[] {
  return listExperiences({ status: 'draft', includeInvalid: true, limit: MAX_BATCH, offset: 0 }).rows
}

/**
 * Phase 9 D-9-5：取原始会话原文（用户在确认弹窗内点「查看原始会话」溯源核对）。
 * 复用 ai.ts getChatHistory（已 decField 解密 chat_history.content_enc 返明文）。
 * 信任边界（design D-04）：返明文给 renderer——用户核对自己对话，单机 safeStorage 绑机器，不做 PII 脱敏。
 * sessionId 指向已删/不存在时 getChatHistory 返空数组，由 renderer 提示「原会话已不可查」。
 */
export function getSessionMessages(sessionId: string, limit: number = 200): Array<{
  id: string
  role: string
  content: string
  deviceId: string | null
  createdAt: string
}> {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId 无效')
  }
  // WR-09：守 MAX_BATCH 上限（与 list/confirmDrafts 同红线），防超大历史会话无界返回。
  if (limit > MAX_BATCH) {
    throw new Error(`limit 超过 MAX_BATCH 上限（${MAX_BATCH}）`)
  }
  return getChatHistory(sessionId, limit)
}
