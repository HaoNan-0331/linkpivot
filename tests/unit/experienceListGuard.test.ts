import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'

// SEC-05（Phase 13 Plan 03）：experience:list IPC 网关层 DoS 防御回归网（D-13-8 mock 单测）。
//
// 设计：experienceIpc.sanitizeListInput 是纯函数（不调 listExperiences），做 search/tags
// 截断 + severity throw。直接调用该纯函数验证截断/throw，无需 setAuthenticated/secure 包装/
// ipcMain mock（D-13-8「纯函数最高 ROI」范式）。service 层兜底（listExperiences limit MAX_BATCH
// throw）+ 枚举一致性两项单独 it 用 _setExperienceDbGetter mock DB 注入验证（D-13-7 双层第二层确认）。
//
// DEP-1 约束：plain vitest 无法加载 electron-ABI better-sqlite3，故 service 层兜底 it 经
// _setExperienceDbGetter 注入内存 mock DB（沿用 experienceService.test.ts 范式，规避 native binding）。

import {
  sanitizeListInput,
} from '../../electron/ipc/experienceIpc'
import {
  listExperiences,
  MAX_BATCH,
  VALID_SEVERITIES,
  _setExperienceDbGetter,
} from '../../electron/services/experienceService'
import type { ExperienceListInput } from '../../src/types/experience'

// ---------- 内存 mock DB（service 层兜底 it 用，规避 DEP-1 native binding） ----------
interface Row { [col: string]: any }
class MemDb {
  tables: Map<string, { rows: Map<string, Row> }> = new Map()
  exec(): void { /* no-op：测试不建表 */ }
  prepare(sql: string): any {
    const norm = sql.trim().replace(/\s+/g, ' ')
    // listExperiences({limit: MAX_BATCH+1}) 在到达 SQL 前已 throw（limit 守卫），不会走到 prepare。
    // 但 mock 须兜底返回空集，防 test 报「mock DB 未实现的语句」。
    if (/^SELECT/i.test(norm) && /FROM\s+experiences/i.test(norm)) {
      return { all: () => [], get: () => ({ cnt: 0 }) }
    }
    throw new Error('mock DB 未实现的语句: ' + sql)
  }
  transaction<T>(fn: () => T): () => T { return () => fn() }
  pragma(): any { return [] }
}

function seedDb(): MemDb {
  const db = new MemDb()
  db.tables.set('experiences', { rows: new Map() })
  return db
}

beforeEach(() => {
  // service 层兜底 it 注入 mock DB（sanitizeListInput 纯函数 it 不依赖 DB）
  const db = seedDb()
  _setExperienceDbGetter(() => db as unknown as Database.Database)
})

describe('SEC-05 sanitizeListInput（experience:list IPC 网关层 DoS 校验）', () => {
  // —— search 截断（D-13-6 ≤100 字符，Pattern A 钳制静默容错）——
  it('超长 search（200 字符）截断到 ≤100 字符（阻断超长 LIKE 多词 OR-join 全表扫 DoS 面）', () => {
    const out = sanitizeListInput({ search: 'x'.repeat(200) })
    expect(out.search).toBeDefined()
    expect(out.search!.length).toBeLessThanOrEqual(100)
  })

  // —— tags 截取（D-13-6 ≤20 个，Pattern A 钳制）——
  it('超量 tags（30 个）截取到前 20 个（阻断超量 LIKE OR-join DoS 面）', () => {
    const out = sanitizeListInput({ tags: Array.from({ length: 30 }, (_, i) => `tag-${i}`) })
    expect(Array.isArray(out.tags)).toBe(true)
    expect(out.tags!.length).toBe(20)
  })

  // —— 单 tag 截断（D-13-6 ≤30 字符，Pattern A 钳制）——
  it('超长单 tag（50 字符）截断到 ≤30 字符', () => {
    const out = sanitizeListInput({ tags: ['y'.repeat(50)] })
    expect(Array.isArray(out.tags)).toBe(true)
    expect(out.tags!.length).toBe(1)
    expect(out.tags![0].length).toBeLessThanOrEqual(30)
  })

  // —— W-1 fix（v1.2 audit）：tags 非 string 元素 filter 滤除 ——
  it('W-1: tags 非 string 元素（123/null/undefined）被 filter 滤除，只留 string 截断（防下游 listExperiences t.replace throw）', () => {
    const out = sanitizeListInput({ tags: ['正常', 123, null, 'a'.repeat(40), undefined, '也正常'] as any })
    expect(out.tags).toEqual(['正常', 'a'.repeat(30), '也正常'])
  })

  // —— severity throw（D-13-5 固定集合非法值，Pattern B throw 暴露 bug）——
  it('非法 severity（BOGUS）throw 含「severity 非法」（固定集合非法值暴露调用方 bug）', () => {
    expect(() => sanitizeListInput({ severity: 'BOGUS' })).toThrow('severity 非法')
  })

  // —— 合法 severity 透传（不误伤合法筛选）——
  it('合法 severity（critical）正常透传不 throw', () => {
    const out = sanitizeListInput({ severity: 'critical' } as ExperienceListInput)
    expect(out.severity).toBe('critical')
  })

  // —— 正常搜索不误伤（运维日常搜索如「华为交换机 DHCP」~15 字符）——
  it('正常长度 search（华为交换机 DHCP）原样透传（钳制不误伤日常搜索）', () => {
    const out = sanitizeListInput({ search: '华为交换机 DHCP' })
    expect(out.search).toBe('华为交换机 DHCP')
  })

  // —— D-13-7 双层防御第二层确认：service 层 listExperiences limit MAX_BATCH throw 仍在 ——
  it('service 层 listExperiences({limit: MAX_BATCH+1}) throw「limit 超过 MAX_BATCH」（D-13-7 双层第二层兜底）', () => {
    // 防「绕 IPC 直调 service 查全表」残余风险——IPC 网关层不复查 limit（D-13-7），service 层兜底保留。
    expect(() => listExperiences({ limit: MAX_BATCH + 1 })).toThrow('limit 超过 MAX_BATCH')
  })

  // —— 枚举一致性（防误改 VALID_SEVERITIES，IPC/service 单一来源）——
  it('VALID_SEVERITIES 枚举一致（deepEqual critical/high/medium/low/info，IPC 复用单一来源）', () => {
    expect(Array.isArray(VALID_SEVERITIES)).toBe(true)
    expect([...VALID_SEVERITIES]).toEqual(['critical', 'high', 'medium', 'low', 'info'])
  })
})
