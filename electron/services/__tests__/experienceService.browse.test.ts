import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { encField } from '../../utils/crypto'

/**
 * Phase 10 Plan 01：浏览页数据层 browse 单测（severity fallback / device_count / deviceId 多选 OR-join / search / severity 筛选）。
 *
 * D-10-2 核心承诺的测试兜底：
 * - Test 1/2：severity fallback（明文列 NULL 时读 attrs.severity，向后兼容历史数据）
 * - Test 3/4：device_count 回填（子查询带出，零 N+1）
 * - Test 5：deviceId 多选 OR-join（IN 占位）+ 单值向后兼容
 * - Test 6：search LIKE 命中（title/content）
 * - Test 7：severity 直筛（明文列）
 *
 * 复用 experienceService.test.ts 同款内存 mock DB 范式（DEP-1 native binding ABI 规避）。
 */

// mock device 模块（listDevicesByExperience 经 getDeviceById，本测试虽不直接用但 import 链需要）
const mockDbRef: { current: any } = { current: null }
vi.mock('../device', () => ({
  getDeviceById: (id: string) => {
    const db = mockDbRef.current
    if (!db) return null
    const t = db.tables.get('devices')
    if (!t) return null
    const row = t.rows.get(id)
    if (!row) return null
    return { id: row.id, name: row.name ?? `device-${row.id}` }
  },
}))

vi.mock('../ai', () => ({
  getChatHistory: () => [],
}))

import {
  createExperience,
  listExperiences,
  restoreExperience,
  invalidateExperience,
  setExperienceMasterKey,
  _setExperienceDbGetter,
} from '../experienceService'

const MK_TEST_KEY = 'test-master-key-32-bytes-ok!!'

function mockNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// ---------- 内存 mock DB（复刻 experienceService.test.ts 子集，扩 severity/device_count/IN 占位/LIKE 支持） ----------

interface Row { [col: string]: any }
interface MockTable {
  rows: Map<string, Row>
  autoindex: number
  columns: string[]
  uniqueKeys: string[][]
}

function tokenizeValues(s: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let depth = 0
  let inStr: "'" | '"' | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      cur += ch
      if (ch === inStr && s[i - 1] !== '\\') inStr = null
      continue
    }
    if (ch === "'" || ch === '"') { inStr = ch as any; cur += ch; continue }
    if (ch === '(') { depth++; cur += ch; continue }
    if (ch === ')') { depth--; cur += ch; continue }
    if (ch === ',' && depth === 0) { tokens.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) tokens.push(cur.trim())
  return tokens
}

class MemDb {
  tables: Map<string, MockTable> = new Map()
  userVersion = 0

  ensureTable(name: string, columns: string[], uniqueKeys: string[][] = []) {
    if (!this.tables.has(name)) {
      this.tables.set(name, { rows: new Map(), autoindex: 1, columns, uniqueKeys })
    }
  }

  exec(sql: string): void {
    const norm = sql.trim()
    const createMatch = norm.match(/CREATE\s+(VIRTUAL\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)/i)
    if (createMatch) {
      this.ensureTable(createMatch[3], [])
      return
    }
    if (/CREATE\s+INDEX/i.test(norm)) return
    const pragmaMatch = norm.match(/PRAGMA\s+user_version\s*=\s*(\d+)/i)
    if (pragmaMatch) {
      this.userVersion = parseInt(pragmaMatch[1], 10)
      return
    }
  }

  prepare(sql: string) {
    const norm = sql.trim().replace(/\s+/g, ' ')
    return this.buildStatement(norm)
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      const snapshot = this.snapshot()
      try {
        return fn()
      } catch (err) {
        this.restore(snapshot)
        throw err
      }
    }
  }

  private snapshot() {
    const tables = new Map<string, MockTable>()
    for (const [name, t] of this.tables) {
      const rowsCopy = new Map<string, Row>()
      for (const [id, row] of t.rows) rowsCopy.set(id, { ...row })
      tables.set(name, { rows: rowsCopy, autoindex: t.autoindex, columns: [...t.columns], uniqueKeys: t.uniqueKeys.map((k) => [...k]) })
    }
    return { tables, userVersion: this.userVersion }
  }

  private restore(snap: { tables: Map<string, MockTable>; userVersion: number }) {
    this.tables = snap.tables
    this.userVersion = snap.userVersion
  }

  pragma(stmt: string): any {
    const m = stmt.match(/user_version\s*=\s*(\d+)/i)
    if (m) {
      this.userVersion = parseInt(m[1], 10)
      return
    }
    if (/^user_version$/i.test(stmt.trim())) return [{ user_version: this.userVersion }]
    return []
  }

  private buildStatement(sql: string): any {
    if (/FROM\s+sqlite_master/i.test(sql)) {
      return {
        get: () => {
          if (/name='experiences'/i.test(sql)) {
            const t = this.tables.get('experiences')
            return t && t.columns.includes('attrs_enc')
              ? { sql: 'CREATE TABLE experiences (... attrs_enc ...)' }
              : undefined
          }
          return undefined
        },
      }
    }

    // INSERT
    const insertHead = sql.match(/^INSERT\s+(OR\s+IGNORE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(/i)
    if (insertHead) {
      const orIgnore = !!insertHead[1]
      const table = insertHead[2]
      const cols = insertHead[3].split(',').map((s) => s.trim())
      const valuesContent = sql.slice(insertHead[0].length).replace(/\)\s*;?\s*$/, '')
      const placeholders = tokenizeValues(valuesContent)
      return {
        run: (...vals: any[]) => {
          const t = this.tables.get(table)
          if (!t) throw new Error(`no table ${table}`)
          const row: Row = {}
          let valIdx = 0
          cols.forEach((c, i) => {
            const ph = placeholders[i]
            if (ph === '?') {
              row[c] = vals[valIdx++]
            } else {
              const litStr = ph.match(/^'(.*)'$/)
              if (litStr) row[c] = litStr[1]
              else if (/^datetime\(/i.test(ph)) row[c] = mockNow()
              else if (/^NULL$/i.test(ph)) row[c] = null
              else row[c] = undefined
            }
          })
          if (orIgnore && t.uniqueKeys.length > 0) {
            for (const keyCols of t.uniqueKeys) {
              const dup = Array.from(t.rows.values()).some((existing) =>
                keyCols.every((kc) => existing[kc] === row[kc])
              )
              if (dup) return { changes: 0 }
            }
          }
          const idVal = row.id
          if (idVal === undefined || idVal === null) {
            t.rows.set(String(t.autoindex), { ...row, id: String(t.autoindex) })
            t.autoindex++
          } else {
            t.rows.set(idVal, row)
          }
          return { changes: 1 }
        },
      }
    }

    // UPDATE
    const updateMatch = sql.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)(\s+WHERE\s+(.+))?$/i)
    if (updateMatch) {
      const table = updateMatch[1]
      const setClause = updateMatch[2]
      const whereClause = updateMatch[4]
      return {
        run: (...vals: any[]) => {
          const t = this.tables.get(table)
          if (!t) throw new Error(`no table ${table}`)
          const assignments = tokenizeValues(setClause)
          const setCols: string[] = []
          let valIdx = 0
          const setValues: any[] = []
          for (const a of assignments) {
            const m = a.match(/^(\w+)\s*=\s*(\?|.+)$/)
            if (!m) continue
            setCols.push(m[1])
            if (m[2] === '?') {
              setValues.push(vals[valIdx++])
            } else {
              setValues.push(m[2])
            }
          }
          let changed = 0
          for (const row of t.rows.values()) {
            if (this.matchesWhere(row, whereClause, vals.slice(valIdx))) {
              setCols.forEach((c, i) => {
                const v = setValues[i]
                if (typeof v === 'string' && v.includes('reuse_count + 1')) {
                  row[c] = (Number(row[c]) || 0) + 1
                } else if (typeof v === 'string' && v.toLowerCase().startsWith('datetime(')) {
                  row[c] = mockNow()
                } else if (typeof v === 'string') {
                  const litStr = v.match(/^'(.*)'$/)
                  row[c] = litStr ? litStr[1] : (v === 'NULL' ? null : v)
                } else {
                  row[c] = v
                }
              })
              changed++
            }
          }
          return { changes: changed }
        },
      }
    }

    // SELECT COUNT(DISTINCT e.id) AS cnt —— multi-device total 去重计数
    const distinctCountMatch = sql.match(/^SELECT\s+COUNT\(DISTINCT\s+e\.id\)\s+AS\s+(\w+)\s+FROM\s+experiences\s+e\s+JOIN\s+exp_device_rel\s+r\s+ON\s+e\.id\s*=\s*r\.experience_id\s+WHERE\s+r\.device_id\s+IN\s*\(([^)]+)\)(\s+AND\s+(.+))?$/i)
    if (distinctCountMatch) {
      const alias = distinctCountMatch[1]
      const placeholderCount = distinctCountMatch[2].split(',').filter((s) => s.trim() === '?').length
      return {
        get: (...vals: any[]) => {
          const t = this.tables.get('experiences')
          if (!t) return { [alias]: 0 }
          const deviceIds = vals.slice(0, placeholderCount)
          let remaining = vals.slice(placeholderCount)
          const rel = this.tables.get('exp_device_rel')
          const expIdSet = new Set(
            rel ? Array.from(rel.rows.values()).filter((r) => deviceIds.includes(r.device_id)).map((r) => r.experience_id) : []
          )
          let rows = Array.from(t.rows.values()).filter((r) => expIdSet.has(r.id))
          if (distinctCountMatch[4]) {
            rows = this.applyConditions(rows, distinctCountMatch[4], remaining)
          }
          return { [alias]: rows.length }
        },
      }
    }

    // SELECT COUNT(*) AS cnt FROM experiences e [JOIN exp_device_rel] [WHERE ...]
    const countMatch = sql.match(/^SELECT\s+COUNT\(\*\)\s+AS\s+(\w+)\s+FROM\s+experiences\s+e(\s+JOIN\s+exp_device_rel\s+r\s+ON\s+e\.id\s*=\s*r\.experience_id)?(\s+WHERE\s+(.+))?$/i)
    if (countMatch) {
      const alias = countMatch[1]
      const hasJoin = !!countMatch[2]
      const whereClause = countMatch[4]
      return {
        get: (...vals: any[]) => {
          const t = this.tables.get('experiences')
          if (!t) return { [alias]: 0 }
          let rows = Array.from(t.rows.values()).map((r) => ({ ...r }))
          let remaining = vals
          if (hasJoin) {
            const rel = this.tables.get('exp_device_rel')
            // 支持 device_id = ? 单值 或 device_id IN (?, ?, ...) 多选
            const inMatch = whereClause && whereClause.match(/r\.device_id\s+IN\s*\(([^)]+)\)/i)
            const singleMatch = whereClause && whereClause.match(/r\.device_id\s*=\s*\?/i)
            if (inMatch) {
              const placeholderCount = inMatch[1].split(',').filter((s) => s.trim() === '?').length
              const deviceIds = remaining.slice(0, placeholderCount)
              remaining = remaining.slice(placeholderCount)
              const expIdSet = new Set(
                rel ? Array.from(rel.rows.values()).filter((r) => deviceIds.includes(r.device_id)).map((r) => r.experience_id) : []
              )
              // 多选 OR-join：一条经验关联多个选中设备不应重复计数（去重 by e.id）
              rows = rows.filter((r) => expIdSet.has(r.id))
            } else if (singleMatch) {
              const deviceId = remaining[0]
              remaining = remaining.slice(1)
              const expIds = rel
                ? Array.from(rel.rows.values()).filter((r) => r.device_id === deviceId).map((r) => r.experience_id)
                : []
              rows = rows.filter((r) => expIds.includes(r.id))
            }
          }
          if (whereClause) {
            rows = this.applyConditions(rows, whereClause, remaining)
          }
          return { [alias]: rows.length }
        },
      }
    }

    // SELECT e.*, (SELECT COUNT(*) FROM exp_device_rel ...) AS device_count FROM experiences e [JOIN ...] [WHERE ...] ORDER BY ...
    // listExperiences 行查询（两分支都带 device_count 子查询）
    const listMatch = sql.match(/^SELECT\s+e\.\*,\s*\(SELECT\s+COUNT\(\*\)\s+FROM\s+exp_device_rel\s+r2\s+WHERE\s+r2\.experience_id\s*=\s*e\.id\)\s+AS\s+device_count\s+FROM\s+experiences\s+e(\s+JOIN\s+exp_device_rel\s+r\s+ON\s+e\.id\s*=\s*r\.experience_id)?(\s+WHERE\s+(.+?))?\s+ORDER\s+BY\s+e\.created_at\s+DESC/i)
    if (listMatch) {
      const hasJoin = !!listMatch[1]
      const whereClause = listMatch[3]
      return {
        all: (...vals: any[]) => {
          const t = this.tables.get('experiences')
          if (!t) return []
          let rows = Array.from(t.rows.values()).map((r) => ({ ...r }))
          let remaining = vals
          // device_count 子查询回填（按 exp_device_rel 关联行计数）
          const rel = this.tables.get('exp_device_rel')
          rows.forEach((r) => {
            r.device_count = rel
              ? Array.from(rel.rows.values()).filter((rr) => rr.experience_id === r.id).length
              : 0
          })
          if (hasJoin) {
            // 支持 IN (?, ?) 多选 或 = ? 单值
            const inMatch = whereClause && whereClause.match(/r\.device_id\s+IN\s*\(([^)]+)\)/i)
            const singleMatch = whereClause && whereClause.match(/r\.device_id\s*=\s*\?/i)
            if (inMatch) {
              const placeholderCount = inMatch[1].split(',').filter((s) => s.trim() === '?').length
              const deviceIds = remaining.slice(0, placeholderCount)
              remaining = remaining.slice(placeholderCount)
              const expIdSet = new Set(
                rel ? Array.from(rel.rows.values()).filter((r) => deviceIds.includes(r.device_id)).map((r) => r.experience_id) : []
              )
              rows = rows.filter((r) => expIdSet.has(r.id))
            } else if (singleMatch) {
              const deviceId = remaining[0]
              remaining = remaining.slice(1)
              const expIds = rel
                ? Array.from(rel.rows.values()).filter((r) => r.device_id === deviceId).map((r) => r.experience_id)
                : []
              rows = rows.filter((r) => expIds.includes(r.id))
            }
          }
          if (whereClause) {
            // 剥离 JOIN 部分后把剩余 conditions 传给 applyConditions（仅 WHERE 后主体）
            let condClause = whereClause
            const inOrSingle = condClause.match(/r\.device_id\s+(IN\s*\([^)]+\)|=\s*\?)\s+AND\s+/i)
            if (inOrSingle) {
              condClause = condClause.slice(inOrSingle[0].length)
            }
            rows = this.applyConditions(rows, condClause, remaining)
          }
          // ORDER BY created_at DESC
          rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          return rows
        },
      }
    }

    // SELECT * FROM experiences WHERE id = ?（单行 getExperience）
    const singleMatch = sql.match(/^SELECT\s+\*\s+FROM\s+experiences\s+WHERE\s+id\s*=\s*\?$/i)
    if (singleMatch) {
      return {
        get: (id: any) => {
          const t = this.tables.get('experiences')
          if (!t) return undefined
          const row = t.rows.get(id)
          return row ? { ...row } : undefined
        },
      }
    }

    // SELECT r.device_id AS device_id FROM exp_device_rel ...
    if (/SELECT\s+r\.device_id\s+AS\s+device_id\s+FROM\s+exp_device_rel/i.test(sql)) {
      return {
        all: (expId: any) => {
          const rel = this.tables.get('exp_device_rel')
          if (!rel) return []
          return Array.from(rel.rows.values())
            .filter((r) => r.experience_id === expId)
            .map((r) => ({ device_id: r.device_id }))
        },
      }
    }

    throw new Error('mock DB 未实现的语句: ' + sql)
  }

  /** 对 WHERE 后的 conditions（AND join）逐段求值过滤，消费 params 数组。 */
  private applyConditions(rows: Row[], whereClause: string, vals: any[]): Row[] {
    if (!whereClause) return rows
    let remaining = vals
    return rows.filter((r) => {
      // 按出现顺序匹配各 condition 段（与 listExperiences 拼 conditions 顺序无关——逐段独立判定）
      // bi-temporal invalid_at IS NULL OR invalid_at > now
      if (/invalid_at\s+IS\s+NULL/i.test(whereClause)) {
        const now = mockNow()
        if (r.invalid_at && !(r.invalid_at > now)) return false
      }
      // e.category = ?
      let consumed: string[] = []
      const catM = whereClause.match(/e\.category\s*=\s*\?/)
      if (catM) {
        const cat = remaining[consumed.length]
        consumed.push('cat')
        if (r.category !== cat) return false
      }
      const statM = whereClause.match(/e\.status\s*=\s*\?/)
      if (statM) {
        const st = remaining[consumed.length]
        consumed.push('stat')
        if (r.status !== st) return false
      }
      // (e.title LIKE ? OR e.content LIKE ?) — 两个 param
      const searchM = whereClause.match(/e\.title\s+LIKE\s+\?\s+OR\s+e\.content\s+LIKE\s+\?/)
      if (searchM) {
        const kw1 = remaining[consumed.length]
        const kw2 = remaining[consumed.length + 1]
        consumed.push('kw1', 'kw2')
        const kw = kw1.replace(/^%|%/g, '') // 去 % 通配符做 includes
        const hit = (r.title || '').includes(kw) || (r.content || '').includes(kw)
        if (!hit) return false
      }
      // e.severity = ?
      const sevM = whereClause.match(/e\.severity\s*=\s*\?/)
      if (sevM) {
        const sv = remaining[consumed.length]
        consumed.push('sev')
        if (r.severity !== sv) return false
      }
      // (e.tags LIKE ? OR ...) — 一个或多个 param，命中任一
      const tagsOrs = (whereClause.match(/e\.tags\s+LIKE\s+\?/g) || []).length
      if (tagsOrs > 0) {
        let hit = false
        for (let i = 0; i < tagsOrs; i++) {
          const tagPat = remaining[consumed.length + i]
          const tagVal = tagPat.replace(/^%"|"$/g, '') // %"tag"% → tag
          try {
            const tagsArr = JSON.parse(r.tags || '[]')
            if (Array.isArray(tagsArr) && tagsArr.includes(tagVal)) { hit = true; break }
          } catch { /* 坏 JSON 忽略 */ }
        }
        consumed.push(...Array(tagsOrs).fill('tag'))
        if (!hit) return false
      }
      // 同步消费 vals（无返回值即可，remaining 是闭包变量不修改——这里只是占位）
      return true
    })
  }

  private matchesWhere(row: Row, whereClause: string | undefined, vals: any[]): boolean {
    if (!whereClause) return true
    if (/^id\s*=\s*\?$/i.test(whereClause)) return row.id === vals[0]
    if (/invalid_at\s+IS\s+NULL/i.test(whereClause)) {
      const now = mockNow()
      return !row.invalid_at || row.invalid_at > now
    }
    const colMatch = whereClause.match(/^(\w+)\s*=\s*\?$/)
    if (colMatch) return row[colMatch[1]] === vals[0]
    return true
  }
}

function seedDb(): MemDb {
  const db = new MemDb()
  db.ensureTable('experiences', [
    'id', 'title', 'category', 'content', 'tags', 'status', 'source_session_id',
    'attrs_enc', 'valid_at', 'invalid_at', 'last_verified_at', 'reuse_count',
    'created_at', 'updated_at', 'duplicate_of_exp_id', 'severity',
  ])
  db.ensureTable('exp_device_rel', ['id', 'experience_id', 'device_id', 'relation_type', 'created_at'],
    [['experience_id', 'device_id']])
  db.ensureTable('devices', ['id', 'name_enc'])
  db.ensureTable('chat_sessions', ['id', 'title'])
  return db
}

/** 直接造一条 experience 行（绕过 createExperience 强校验，用于构造 severity 列 NULL 历史数据等场景）。 */
function insertExpRaw(db: any, id: string, overrides: Partial<Record<string, any>> = {}) {
  db.tables.get('experiences').rows.set(id, {
    id,
    title: overrides.title ?? 't',
    category: overrides.category ?? 'troubleshooting',
    content: overrides.content ?? 'c',
    tags: overrides.tags ?? '[]',
    status: overrides.status ?? 'published',
    source_session_id: null,
    attrs_enc: overrides.attrs_enc ?? null,
    valid_at: overrides.valid_at ?? mockNow(),
    invalid_at: overrides.invalid_at ?? null,
    last_verified_at: null,
    reuse_count: 0,
    created_at: overrides.created_at ?? mockNow(),
    updated_at: overrides.updated_at ?? mockNow(),
    duplicate_of_exp_id: null,
    severity: overrides.severity, // 默认 undefined（mock 行无 key 即 NULL 语义）
    ...overrides.extra,
  })
}

beforeEach(() => {
  setExperienceMasterKey(MK_TEST_KEY)
  const db = seedDb()
  _setExperienceDbGetter(() => db as unknown as Database.Database)
  mockDbRef.current = db
})

describe('Phase 10 browse: severity fallback + device_count + deviceId 多选 + search/severity 筛选', () => {
  it('Test 1: severity 列 NULL 时 fallback 读 attrs.severity（历史数据兼容）', () => {
    const db = mockDbRef.current
    // 历史数据：severity 列 NULL，但 attrs_enc 解密后含 {severity:'high'}
    insertExpRaw(db, 'exp-history', {
      attrs_enc: encField(JSON.stringify({ severity: 'high', symptoms: 's' }), MK_TEST_KEY),
      severity: null,
    })
    const res = listExperiences({ includeInvalid: true })
    const row = res.rows.find((r: any) => r.id === 'exp-history') as any
    expect(row).toBeTruthy()
    expect(row.severity).toBe('high') // fallback 填充
    expect(row.attrs.severity).toBe('high') // attrs 仍带 severity
    expect(row.attrs_enc).toBeUndefined() // 密文不外泄
  })

  it('Test 2: severity 明文列优先于 attrs.severity（明文列非 NULL 不 fallback）', () => {
    const db = mockDbRef.current
    insertExpRaw(db, 'exp-plain', {
      attrs_enc: encField(JSON.stringify({ severity: 'low' }), MK_TEST_KEY),
      severity: 'critical', // 明文列已填
    })
    const res = listExperiences({ includeInvalid: true })
    const row = res.rows.find((r: any) => r.id === 'exp-plain') as any
    expect(row.severity).toBe('critical') // 明文列优先，不 fallback 到 attrs.severity='low'
  })

  it('Test 3: device_count 回填——关联 3 个设备返 3', () => {
    const db = mockDbRef.current
    insertExpRaw(db, 'exp-rel3')
    db.tables.get('exp_device_rel').rows.set('r1', { id: 'r1', experience_id: 'exp-rel3', device_id: 'd1' })
    db.tables.get('exp_device_rel').rows.set('r2', { id: 'r2', experience_id: 'exp-rel3', device_id: 'd2' })
    db.tables.get('exp_device_rel').rows.set('r3', { id: 'r3', experience_id: 'exp-rel3', device_id: 'd3' })
    const res = listExperiences({ includeInvalid: true })
    const row = res.rows.find((r: any) => r.id === 'exp-rel3') as any
    expect(row.device_count).toBe(3)
  })

  it('Test 4: device_count 零关联返 0', () => {
    const db = mockDbRef.current
    insertExpRaw(db, 'exp-no-rel')
    const res = listExperiences({ includeInvalid: true })
    const row = res.rows.find((r: any) => r.id === 'exp-no-rel') as any
    expect(row.device_count).toBe(0)
  })

  it('Test 5: deviceId 多选 OR-join——关联 A+B 的经验恰返 1 次；单值/数组两形态都命中', () => {
    const db = mockDbRef.current
    insertExpRaw(db, 'exp-ab')
    db.tables.get('exp_device_rel').rows.set('ra', { id: 'ra', experience_id: 'exp-ab', device_id: 'A' })
    db.tables.get('exp_device_rel').rows.set('rb', { id: 'rb', experience_id: 'exp-ab', device_id: 'B' })

    // 多选 ['A','B']：经验关联 A 和 B，IN 占位 OR-join，应恰返 1 次（去重不重复）
    const r1 = listExperiences({ deviceId: ['A', 'B'], includeInvalid: true })
    const hits1 = r1.rows.filter((r: any) => r.id === 'exp-ab')
    expect(hits1.length).toBe(1)

    // 单值 ['A']：仍命中
    const r2 = listExperiences({ deviceId: ['A'], includeInvalid: true })
    const hits2 = r2.rows.filter((r: any) => r.id === 'exp-ab')
    expect(hits2.length).toBe(1)

    // 单值 string 向后兼容：同样命中
    const r3 = listExperiences({ deviceId: 'A', includeInvalid: true })
    const hits3 = r3.rows.filter((r: any) => r.id === 'exp-ab')
    expect(hits3.length).toBe(1)
  })

  it('Test 6: search LIKE 命中 title/content，未命中返空', () => {
    const db = mockDbRef.current
    insertExpRaw(db, 'exp-ssh', { title: 'SSH 故障排查指南', content: '检查 sshd 配置', severity: 'high' })
    insertExpRaw(db, 'exp-other', { title: '其他', content: '其他内容', severity: 'low' })

    const hit = listExperiences({ search: 'SSH', includeInvalid: true })
    const ids = hit.rows.map((r: any) => r.id)
    expect(ids).toContain('exp-ssh')
    expect(ids).not.toContain('exp-other')

    const miss = listExperiences({ search: '不存在关键词XYZ', includeInvalid: true })
    expect(miss.rows.length).toBe(0)
  })

  it('Test 7: severity 直筛——只返 severity 匹配的行（明文列 + fallback 两路径）', () => {
    const db = mockDbRef.current
    // 明文列路径：severity='high'
    insertExpRaw(db, 'exp-sev-high', { severity: 'high', attrs_enc: null })
    // fallback 路径：severity 列 NULL 但 attrs.severity='high'
    insertExpRaw(db, 'exp-sev-fallback', {
      severity: null,
      attrs_enc: encField(JSON.stringify({ severity: 'high' }), MK_TEST_KEY),
    })
    // 不匹配行
    insertExpRaw(db, 'exp-sev-low', { severity: 'low', attrs_enc: null })

    const res = listExperiences({ severity: 'high', includeInvalid: true })
    const ids = res.rows.map((r: any) => r.id)
    // 明文列路径必命中；fallback 路径因 SQL WHERE severity=? 直筛 NULL 列筛不到（已知限制，
    // D-10-2 指明：fallback 只保证「读」，不保证「筛」）
    expect(ids).toContain('exp-sev-high')
    expect(ids).not.toContain('exp-sev-low')
  })
})

describe('Phase 10 browse: restoreExperience（受控接口，清 invalid_at + status 回 published）', () => {
  it('restore 把 invalid_at 清 NULL 且 status 显式回 published', () => {
    const db = mockDbRef.current
    insertExpRaw(db, 'exp-restored', { status: 'published', invalid_at: mockNow() })
    // 先确认 invalid_at 已落
    expect((db.tables.get('experiences').rows.get('exp-restored')).invalid_at).toBeTruthy()
    const got = restoreExperience('exp-restored') as any
    expect(got.invalid_at).toBeNull()
    expect(got.status).toBe('published')
  })

  it('restore 与 invalidate 对称：invalidate 落 invalid_at，restore 清回', () => {
    const e = createExperience({ title: 't', category: 'product', content: 'c' })
    invalidateExperience(e.id)
    const afterInv = mockDbRef.current.tables.get('experiences').rows.get(e.id)
    expect(afterInv.invalid_at).toBeTruthy()
    const afterRest = restoreExperience(e.id) as any
    expect(afterRest.invalid_at).toBeNull()
  })
})
