import { describe, it, expect, beforeEach, vi } from 'vitest'

// H-2（v0.3.0 audit）：auth:initAdmin 首启门控回归网。
//
// 红线：users 表非空时 initAdmin 一律返回 success:false，不执行 INSERT。
// auth.ts 经 getDatabase() 链到 connection.ts→electron，plain vitest 用 vi.mock 注入
// 最小 MemDb：'SELECT COUNT(*) as c FROM users' 返回可切换的 {c:0}/{c:1}；
// INSERT 捕获到数组供断言。hashPassword 是纯 node crypto，可直跑。

class MemDb {
  userCount = 0
  inserts: unknown[][] = []
  prepare(sql: string): unknown {
    const norm = sql.trim().replace(/\s+/g, ' ')
    if (/^SELECT COUNT\(\*\) as c FROM users$/i.test(norm)) {
      return { get: () => ({ c: this.userCount }) }
    }
    if (/^INSERT INTO users /i.test(norm)) {
      return { run: (...args: unknown[]) => { this.inserts.push(args) } }
    }
    throw new Error('mock DB 未实现的语句: ' + sql)
  }
}

const state = vi.hoisted(() => ({ db: null as MemDb | null }))
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => {
    if (!state.db) throw new Error('测试未注入 mock DB')
    return state.db
  },
}))

import { initAdmin, isFirstRun } from '../../electron/services/auth'

beforeEach(() => {
  state.db = new MemDb()
})

describe('H-2 initAdmin 首启门控（服务层）', () => {
  it('users 表非空（count=1，非首启）时返回 success:false 且不执行 INSERT', async () => {
    state.db!.userCount = 1
    const r = await initAdmin('admin', 'StrongPass123')
    expect(r.success).toBe(false)
    expect(state.db!.inserts).toHaveLength(0)
    expect(isFirstRun()).toBe(false)
  })

  it('users 表为空（count=0，首启）+ 合规密码 → INSERT 被调用且 success:true', async () => {
    state.db!.userCount = 0
    const r = await initAdmin('admin', 'StrongPass123')
    expect(r.success).toBe(true)
    expect(state.db!.inserts).toHaveLength(1)
    const [id, username, hash] = state.db!.inserts[0]
    expect(typeof id).toBe('string')
    expect(username).toBe('admin')
    expect(hash).not.toBe('StrongPass123')
  })

  it('首启 + 弱密码（<10 位纯字母）→ 返回密码强度 error，无 INSERT', async () => {
    state.db!.userCount = 0
    const r = await initAdmin('admin', 'short')
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
    expect(state.db!.inserts).toHaveLength(0)
  })
})
