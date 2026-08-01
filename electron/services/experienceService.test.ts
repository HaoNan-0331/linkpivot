import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  createExperience,
  getExperience,
  listExperiences,
  updateExperience,
  invalidateExperience,
  relateDevice,
  unrelateDevice,
  listDevicesByExperience,
  listExperiencesByDevice,
  incReuseCount,
  touchLastVerifiedAt,
  setExperienceMasterKey,
  MAX_BATCH,
  _setExperienceDbGetter,
} from './experienceService'

/**
 * experienceService 测试。
 *
 * DEP-1 约束：better-sqlite3 native binding 经 @electron/rebuild 按 Electron ABI 重建，
 * 在 plain Node（vitest 运行时）下 NODE_MODULE_VERSION 不匹配无法加载。
 * 故用内存 mock DB 复刻 better-sqlite3 的子集 API（prepare/exec/transaction/pragma），
 * 覆盖 service 实际使用的查询路径，验证业务逻辑正确性（与 migrationHelpers.test.ts 规避 native 的思路一致）。
 * mock 只需支撑 service 用到的语句形态（INSERT/UPDATE/DELETE/SELECT/COUNT/sqlite_master 查询/PRAGMA）。
 */

const MK_TEST_KEY = 'test-master-key-32-bytes-ok!!'

// WR-02 mock 当前时间（YYYY-MM-DD HH:MM:SS localtime，对齐 datetime('now','localtime') 格式）。
// invalidateExperience 写入 invalid_at 用 datetime('now','localtime')，mock 改写为
// 真实可比时间戳（替代 'NOW-MOCK' 字符串），让过滤侧能做真实 `>` 文本比较，复刻
// listExperiences 的 bi-temporal `invalid_at IS NULL OR invalid_at > datetime(...)` 双分支。
function mockNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}
// 偏移 mock 时间（秒），用于构造过期/未来 invalid_at 三态：负=过去（已失效），正=未来（有效）
function mockNowOffseted(offsetSec: number): string {
  return new Date(Date.now() + offsetSec * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

// ---------- 内存 mock DB ----------
interface Row { [col: string]: any }
interface MockTable {
  rows: Map<string, Row>
  autoindex: number
  columns: string[]
  uniqueKeys: string[][] // UNIQUE 组合列名
}

/**
 * 括号/引号感知的 VALUES 分词器：处理 datetime('now','localtime') 内含逗号 + 引号字符串。
 * 输入 "?, ?, 'draft', datetime('now','localtime')" → ['?', '?', "'draft'", "datetime('now','localtime')"]
 */
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
    // 建表（测试 setup + v8 迁移 DDL 都走 exec）：解析出表名即可，列由 seed 显式声明
    const createMatch = norm.match(/CREATE\s+(VIRTUAL\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)/i)
    if (createMatch) {
      this.ensureTable(createMatch[3], [])
      return
    }
    const createIdx = norm.match(/CREATE\s+INDEX/i)
    if (createIdx) return // 索引不影响内存语义
    const pragmaMatch = norm.match(/PRAGMA\s+user_version\s*=\s*(\d+)/i)
    if (pragmaMatch) {
      this.userVersion = parseInt(pragmaMatch[1], 10)
      return
    }
    // INSERT via exec（service 不用，迁移也不用，忽略）
  }

  prepare(sql: string) {
    const norm = sql.trim().replace(/\s+/g, ' ')
    return this.buildStatement(norm)
  }

  transaction<T>(fn: () => T): () => T {
    return () => fn()
  }

  pragma(stmt: string): any {
    const m = stmt.match(/user_version\s*=\s*(\d+)/i)
    if (m) {
      this.userVersion = parseInt(m[1], 10)
      return
    }
    const readVersion = stmt.trim().match(/^user_version$/i)
    if (readVersion) return [{ user_version: this.userVersion }]
    return []
  }

  private buildStatement(sql: string): any {
    // SELECT ... FROM sqlite_master
    if (/FROM\s+sqlite_master/i.test(sql)) {
      return {
        get: () => {
          if (/name='experiences'/i.test(sql)) {
            const t = this.tables.get('experiences')
            // 迁移幂等守卫查 schema 是否含 attrs_enc：seed 时若声明了 attrs_enc 列则返回含特征串
            return t && t.columns.includes('attrs_enc')
              ? { sql: 'CREATE TABLE experiences (... attrs_enc ...)' }
              : undefined
          }
          return undefined
        },
      }
    }

    // INSERT —— VALUES 段需括号感知分词（datetime('now','localtime') 内含逗号/括号）
    const insertHead = sql.match(/^INSERT\s+(OR\s+IGNORE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(/i)
    if (insertHead) {
      const orIgnore = !!insertHead[1]
      const table = insertHead[2]
      const cols = insertHead[3].split(',').map((s) => s.trim())
      // 提取 VALUES(...) 的内容（insertHead 已匹配到 'VALUES ('，取其后到末尾闭合括号）
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
              // 字面量：'draft' → draft；datetime('now','localtime') → 真实可比时间戳（WR-02）
              const litStr = ph.match(/^'(.*)'$/)
              if (litStr) row[c] = litStr[1]
              else if (/^datetime\(/i.test(ph)) row[c] = mockNow()
              else row[c] = undefined
            }
          })
          // id 生成（uuid 由调用方传入；exp_device_rel 也传 uuid）
          const idVal = row.id
          // UNIQUE 去重检查
          if (orIgnore && t.uniqueKeys.length > 0) {
            for (const keyCols of t.uniqueKeys) {
              const dup = Array.from(t.rows.values()).some((existing) =>
                keyCols.every((kc) => existing[kc] === row[kc])
              )
              if (dup) return { changes: 0 }
            }
          }
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
          // 解析 SET col1 = ?, col2 = datetime('now','localtime')
          const assignments = setClause.split(',').map((s) => s.trim())
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
              // datetime('now','localtime') 或 reuse_count = reuse_count + 1 这类表达式
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
                } else if (typeof v === 'string' && v.toLowerCase().startsWith("datetime(")) {
                  row[c] = mockNow()
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

    // DELETE
    const deleteMatch = sql.match(/^DELETE\s+FROM\s+(\w+)(\s+WHERE\s+(.+))?$/i)
    if (deleteMatch) {
      const table = deleteMatch[1]
      const whereClause = deleteMatch[3]
      return {
        run: (...vals: any[]) => {
          const t = this.tables.get(table)
          if (!t) throw new Error(`no table ${table}`)
          let changed = 0
          for (const [id, row] of Array.from(t.rows.entries())) {
            if (!whereClause || this.matchesWhere(row, whereClause, vals)) {
              t.rows.delete(id)
              changed++
            }
          }
          return { changes: changed }
        },
      }
    }

    // SELECT COUNT(*) —— 支持 FROM <table> [alias] [JOIN ...] [WHERE ...]
    const countMatch = sql.match(/^SELECT\s+COUNT\(\*\)\s+AS\s+(\w+)\s+FROM\s+(\w+)(\s+\w+)?(\s+JOIN\s+.+?)?(\s+WHERE\s+(.+))?$/i)
    if (countMatch) {
      const alias = countMatch[1]
      const table = countMatch[2]
      const whereClause = countMatch[6]
      const hasJoin = !!countMatch[4]
      return {
        get: (...vals: any[]) => {
          const t = this.tables.get(table)
          if (!t) return { [alias]: 0 }
          let rows = Array.from(t.rows.values()).map((r) => ({ ...r }))
          let remaining = vals
          // JOIN exp_device_rel 反查 device
          if (hasJoin && /exp_device_rel/i.test(countMatch[4])) {
            const rel = this.tables.get('exp_device_rel')
            const deviceId = remaining[0]
            remaining = remaining.slice(1)
            const expIds = rel
              ? Array.from(rel.rows.values()).filter((r) => r.device_id === deviceId).map((r) => r.experience_id)
              : []
            rows = rows.filter((r) => expIds.includes(r.id))
          }
          // 其余 WHERE 条件（category/status/invalid 过滤）
          if (whereClause) {
            rows = rows.filter((r) => {
              // WR-02 复刻 bi-temporal 双分支：invalid_at IS NULL OR invalid_at > now
              // （真实文本比较，覆盖过期/有效/NULL 三态，不再靠 'NOW-MOCK' truthy 碰巧通过）
              if (/invalid_at\s+IS\s+NULL/i.test(whereClause)) {
                const now = mockNow()
                if (r.invalid_at && !(r.invalid_at > now)) return false
              }
              const catM = whereClause.match(/e\.category\s*=\s*\?|category\s*=\s*\?/)
              if (catM) {
                const cat = remaining[0]
                remaining = remaining.slice(1)
                if (r.category !== cat) return false
              }
              const statM = whereClause.match(/e\.status\s*=\s*\?|status\s*=\s*\?/)
              if (statM) {
                const st = remaining[0]
                remaining = remaining.slice(1)
                if (r.status !== st) return false
              }
              return true
            })
          }
          return { [alias]: rows.length }
        },
      }
    }

    // SELECT * FROM <table> WHERE id = ? (单行)
    const singleMatch = sql.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?$/i)
    if (singleMatch) {
      const table = singleMatch[1]
      return {
        get: (id: any) => {
          const t = this.tables.get(table)
          if (!t) return undefined
          const row = t.rows.get(id)
          return row ? { ...row } : undefined
        },
      }
    }

    // SELECT * FROM <table> [JOIN ...] WHERE ... ORDER BY ...
    // 支持 experiences 表的 listExperiences 查询 + JOIN exp_device_rel 反查
    if (/^SELECT/i.test(sql) && /FROM\s+experiences/i.test(sql)) {
      return {
        all: (...vals: any[]) => {
          const t = this.tables.get('experiences')
          if (!t) return []
          // 解析 WHERE 中的 conditions（简化：deviceId JOIN、invalid 过滤、category/status）
          let rows = Array.from(t.rows.values()).map((r) => ({ ...r }))
          // deviceId 反查：JOIN exp_device_rel
          const devMatch = sql.match(/device_id\s*=\s*\?/)
          if (devMatch) {
            const rel = this.tables.get('exp_device_rel')
            const deviceId = vals[0]
            const expIds = rel
              ? Array.from(rel.rows.values()).filter((r) => r.device_id === deviceId).map((r) => r.experience_id)
              : []
            rows = rows.filter((r) => expIds.includes(r.id))
            vals = vals.slice(1)
          }
          // category = ?
          const catMatch = sql.match(/category\s*=\s*\?/)
          if (catMatch) {
            const cat = vals[0]
            rows = rows.filter((r) => r.category === cat)
            vals = vals.slice(1)
          }
          // status = ?
          const statMatch = sql.match(/e\.status\s*=\s*\?|status\s*=\s*\?/)
          if (statMatch) {
            const st = vals[0]
            rows = rows.filter((r) => r.status === st)
            vals = vals.slice(1)
          }
          // WR-02 includeInvalid=false 过滤：复刻 bi-temporal 双分支真实比较
          // （invalid_at IS NULL OR invalid_at > now），覆盖过期/有效/NULL 三态
          if (/invalid_at\s+IS\s+NULL/i.test(sql)) {
            const now = mockNow()
            rows = rows.filter((r) => !r.invalid_at || r.invalid_at > now)
          }
          return rows
        },
      }
    }

    // SELECT d.* FROM devices d JOIN exp_device_rel r ... WHERE r.experience_id = ?
    if (/FROM\s+devices\s+d\s+JOIN\s+exp_device_rel/i.test(sql)) {
      return {
        all: (expId: any) => {
          const rel = this.tables.get('exp_device_rel')
          const devices = this.tables.get('devices')
          if (!rel || !devices) return []
          const devIds = Array.from(rel.rows.values())
            .filter((r) => r.experience_id === expId)
            .map((r) => r.device_id)
          return devIds.map((id) => ({ ...devices.rows.get(id) })).filter(Boolean)
        },
      }
    }

    throw new Error('mock DB 未实现的语句: ' + sql)
  }

  private matchesWhere(row: Row, whereClause: string | undefined, vals: any[]): boolean {
    if (!whereClause) return true
    // id = ?
    const idMatch = whereClause.match(/^id\s*=\s*\?$/i)
    if (idMatch) return row.id === vals[0]
    // experience_id = ? AND device_id = ?
    const relMatch = whereClause.match(/^experience_id\s*=\s*\?\s+AND\s+device_id\s*=\s*\?$/i)
    if (relMatch) return row.experience_id === vals[0] && row.device_id === vals[1]
    // WR-02 复杂表达式（invalid_at IS NULL OR invalid_at > datetime(...))
    // 真实文本比较，覆盖过期/有效/NULL 三态
    if (/invalid_at\s+IS\s+NULL/i.test(whereClause)) {
      const now = mockNow()
      return !row.invalid_at || row.invalid_at > now
    }
    // 单列 = ?（experience_id = ? 等）
    const colMatch = whereClause.match(/^(\w+)\s*=\s*\?$/)
    if (colMatch) return row[colMatch[1]] === vals[0]
    return true
  }
}

// seed：复刻 init.ts 的 experiences + exp_device_rel + devices + chat_sessions 列结构
function seedDb(): MemDb {
  const db = new MemDb()
  db.ensureTable('experiences', [
    'id', 'title', 'category', 'content', 'tags', 'status', 'source_session_id',
    'attrs_enc', 'valid_at', 'invalid_at', 'last_verified_at', 'reuse_count',
    'created_at', 'updated_at',
  ])
  db.ensureTable('exp_device_rel', ['id', 'experience_id', 'device_id', 'relation_type', 'created_at'],
    [['experience_id', 'device_id']])
  db.ensureTable('devices', ['id', 'name_enc'])
  db.ensureTable('chat_sessions', ['id', 'title'])
  return db
}

beforeEach(() => {
  setExperienceMasterKey(MK_TEST_KEY)
  const db = seedDb()
  _setExperienceDbGetter(() => db as unknown as Database.Database)
})

describe('experienceService', () => {
  it('createExperience 合法 troubleshooting 经验成功', () => {
    const exp = createExperience({
      title: '核心交换机 ARP 表满',
      category: 'troubleshooting',
      content: '清理 ARP 表后恢复',
      attrs: { severity: 'high', symptoms: 'arp 表爆', resolution: 'clear arp' },
    })
    expect(exp.id).toBeTruthy()
    expect(exp.category).toBe('troubleshooting')
    expect(exp.status).toBe('draft')
    expect(exp.attrs).toMatchObject({ severity: 'high', resolution: 'clear arp' })
    expect(exp.attrs_enc).toBeUndefined() // 密文不外泄
  })

  it('createExperience 拒绝非法 category', () => {
    expect(() =>
      createExperience({
        title: 'x',
        category: 'invalid_cat' as any,
        content: '',
      })
    ).toThrow()
  })

  it('createExperience troubleshooting 类缺 severity 抛错（WR-04 attrs 清空也强制）', () => {
    // attrs 非空但无 severity
    expect(() =>
      createExperience({
        title: '缺严重度',
        category: 'troubleshooting',
        content: 'c',
        attrs: { symptoms: 's' },
      })
    ).toThrow('troubleshooting 类经验 attrs 必须含合法 severity')

    // attrs 非法 severity
    expect(() =>
      createExperience({
        title: '非法严重度',
        category: 'troubleshooting',
        content: 'c',
        attrs: { severity: 'catastrophic' as any },
      })
    ).toThrow('troubleshooting 类经验 attrs 必须含合法 severity')

    // WR-04：attrs 显式传空对象也强制 severity（不再走空 attrs 早返分支）
    expect(() =>
      createExperience({
        title: '清空 attrs',
        category: 'troubleshooting',
        content: 'c',
        attrs: {},
      })
    ).toThrow('troubleshooting 类经验 attrs 必须含合法 severity')

    // WR-04：attrs 为 null 也强制 severity
    expect(() =>
      createExperience({
        title: 'null attrs',
        category: 'troubleshooting',
        content: 'c',
        attrs: null,
      })
    ).toThrow('troubleshooting 类经验 attrs 必须含合法 severity')
  })

  it('createExperience 非 troubleshooting 空 attrs 不加密（attrs_enc 为 null）', () => {
    const exp = createExperience({
      title: '最佳实践',
      category: 'best_practices',
      content: '定期备份',
    })
    expect(exp.attrs).toBeNull()
    const direct = getExperience(exp.id)
    expect(direct).not.toBeNull()
    expect((direct as any).attrs_enc).toBeUndefined()
  })

  it('getExperience 解密回填 attrs 且不外泄 attrs_enc', () => {
    const created = createExperience({
      title: 't',
      category: 'troubleshooting',
      content: 'c',
      attrs: { severity: 'low', root_cause: 'rc' },
    })
    const got = getExperience(created.id)
    expect(got).not.toBeNull()
    expect((got as any).attrs).toMatchObject({ severity: 'low', root_cause: 'rc' })
    expect((got as any).attrs_enc).toBeUndefined()
  })

  it('getExperience 不存在返回 null', () => {
    expect(getExperience('nonexistent-id')).toBeNull()
  })

  it('listExperiences includeInvalid=false 默认过滤已失效', () => {
    const e1 = createExperience({ title: '有效', category: 'product', content: 'c' })
    const e2 = createExperience({ title: '将失效', category: 'product', content: 'c' })
    invalidateExperience(e2.id)
    const res = listExperiences({})
    const ids = res.rows.map((r: any) => r.id)
    expect(ids).toContain(e1.id)
    expect(ids).not.toContain(e2.id)
  })

  it('listExperiences includeInvalid=true 包含失效', () => {
    const e1 = createExperience({ title: '有效', category: 'product', content: 'c' })
    const e2 = createExperience({ title: '将失效', category: 'product', content: 'c' })
    invalidateExperience(e2.id)
    const res = listExperiences({ includeInvalid: true })
    expect(res.rows.length).toBe(2)
  })

  // WR-02 回归保护：bi-temporal `invalid_at IS NULL OR invalid_at > now` 真实文本比较。
  // 三态：NULL（永有效）/ 过去（已失效）/ 未来（仍有效），验证 listExperiences 默认过滤正确，
  // 而非靠 'NOW-MOCK' 字符串 truthy 碰巧通过。配合 CR-02 格式契约。
  it('listExperiences bi-temporal 三态过滤（NULL 永有效 / 过去已失效 / 未来仍有效）', () => {
    const db = seedDb()
    _setExperienceDbGetter(() => db as unknown as Database.Database)
    const exp = db.tables.get('experiences')!
    const mkRow = (id: string, invalidAt: string | null) => ({
      id, title: id, category: 'product', content: 'c', tags: '[]', status: 'draft',
      attrs_enc: null, valid_at: mockNowOffseted(-3600),
      invalid_at: invalidAt, last_verified_at: null, reuse_count: 0,
      created_at: mockNowOffseted(-3600), updated_at: mockNowOffseted(-3600),
    })
    exp.rows.set('exp-null', mkRow('exp-null', null))            // NULL → 永有效
    exp.rows.set('exp-past', mkRow('exp-past', mockNowOffseted(-600)))  // 过去 → 已失效
    exp.rows.set('exp-future', mkRow('exp-future', mockNowOffseted(600))) // 未来 → 仍有效

    // includeInvalid=false：只返 NULL 与未来（有效态）
    const valid = listExperiences({ includeInvalid: false })
    const validIds = valid.rows.map((r: any) => r.id).sort()
    expect(validIds).toEqual(['exp-future', 'exp-null'])
    expect(valid.total).toBe(2)

    // includeInvalid=true：返全部三态
    const all = listExperiences({ includeInvalid: true })
    expect(all.rows.length).toBe(3)
    expect(all.total).toBe(3)
  })

  it('listExperiences bi-temporal 过期行经 invalidateExperience 被过滤（回归）', () => {
    // invalidateExperience 写 mockNow()，过滤时 mockNow() 略晚 → 已过期被过滤（真实 sqlite 语义）
    const e1 = createExperience({ title: '有效', category: 'product', content: 'c' })
    const e2 = createExperience({ title: '将失效', category: 'product', content: 'c' })
    invalidateExperience(e2.id)
    const res = listExperiences({ includeInvalid: false })
    const ids = res.rows.map((r: any) => r.id)
    expect(ids).toContain(e1.id)
    expect(ids).not.toContain(e2.id)
  })

  it('listExperiences limit 超过 MAX_BATCH 抛错', () => {
    expect(() => listExperiences({ limit: MAX_BATCH + 1 })).toThrow('limit 超过 MAX_BATCH')
  })

  it('listExperiences 返回截断信封 {rows, total, truncated}', () => {
    const res = listExperiences({ limit: 100, offset: 0 })
    expect(res).toHaveProperty('rows')
    expect(res).toHaveProperty('total')
    expect(res).toHaveProperty('truncated')
    expect(res.truncated).toBe(false)
  })

  it('updateExperience 动态字段更新 + attrs 重新校验加密', () => {
    const exp = createExperience({
      title: '原标题',
      category: 'troubleshooting',
      content: 'c',
      attrs: { severity: 'low' },
    })
    const updated = updateExperience(exp.id, {
      title: '新标题',
      attrs: { severity: 'critical', resolution: '重启' },
    })
    expect(updated.title).toBe('新标题')
    expect((updated as any).attrs).toMatchObject({ severity: 'critical', resolution: '重启' })
    expect((updated as any).attrs_enc).toBeUndefined()
  })

  it('updateExperience troubleshooting 改 attrs 缺 severity 抛错', () => {
    const exp = createExperience({
      title: 't',
      category: 'troubleshooting',
      content: 'c',
      attrs: { severity: 'low' },
    })
    expect(() => updateExperience(exp.id, { attrs: { symptoms: 's' } })).toThrow('severity')
  })

  it('invalidateExperience 设 invalid_at（软失效）', () => {
    const exp = createExperience({ title: 't', category: 'product', content: 'c' })
    const inv = invalidateExperience(exp.id)
    expect((inv as any).invalid_at).toBeTruthy()
  })

  it('relateDevice 幂等去重（重复关联不报错）', () => {
    const exp = createExperience({ title: 't', category: 'product', content: 'c' })
    relateDevice(exp.id, 'dev-1')
    expect(() => relateDevice(exp.id, 'dev-1')).not.toThrow()
    const devices = listDevicesByExperience(exp.id)
    expect(devices.length).toBe(1)
  })

  it('unrelateDevice 删除关联', () => {
    const exp = createExperience({ title: 't', category: 'product', content: 'c' })
    relateDevice(exp.id, 'dev-1')
    unrelateDevice(exp.id, 'dev-1')
    expect(listDevicesByExperience(exp.id).length).toBe(0)
  })

  it('listExperiencesByDevice 反查设备关联经验', () => {
    const e1 = createExperience({ title: 'e1', category: 'product', content: 'c' })
    const e2 = createExperience({ title: 'e2', category: 'product', content: 'c' })
    relateDevice(e1.id, 'dev-A')
    relateDevice(e2.id, 'dev-A')
    const exps = listExperiencesByDevice('dev-A')
    expect(exps.length).toBe(2)
    const ids = exps.map((e: any) => e.id)
    expect(ids).toContain(e1.id)
    expect(ids).toContain(e2.id)
  })

  it('incReuseCount 与 touchLastVerifiedAt 预埋接口可调用', () => {
    const exp = createExperience({ title: 't', category: 'product', content: 'c' })
    expect(() => incReuseCount(exp.id)).not.toThrow()
    expect(() => touchLastVerifiedAt(exp.id)).not.toThrow()
    const got = getExperience(exp.id) as any
    expect(got.reuse_count).toBe(1)
  })

  it('decField 失败降级 attrs 为空对象（坏密文不崩）', () => {
    // 直接造一条 attrs_enc 是坏密文的行验证降级路径
    const db = seedDb()
    _setExperienceDbGetter(() => db as unknown as Database.Database)
    db.tables.get('experiences')!.rows.set('bad-id', {
      id: 'bad-id',
      title: '坏密文',
      category: 'troubleshooting',
      content: '',
      tags: '[]',
      status: 'draft',
      attrs_enc: 'not-valid-ciphertext',
      valid_at: '2026-01-01',
      invalid_at: null,
      last_verified_at: null,
      reuse_count: 0,
    })
    const got = getExperience('bad-id') as any
    expect(got).not.toBeNull()
    expect(got.attrs_enc).toBeUndefined()
    expect(got.attrs).toEqual({}) // decField 降级 ''，JSON.parse('')→异常→fallback {}
  })
})
