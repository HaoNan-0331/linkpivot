import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 30 Plan 30-02（UPD-03/04/06）—— 升级压制判定 + 六类错误分诊 + 压制配置读写测试。
 *
 * 覆盖：
 *   a) v30 迁移幂等：最小基线表加两列 + user_version=30 + 重复执行不 throw + MIGRATION_HEAD===30
 *   b) shouldAutoPrompt 全分支矩阵（skip 命中/不等、snooze 未来/过期/forever/null/无效串、叠加优先级）
 *   c) classifyUpdateError 六类分诊（正例 + 数字 statusCode/串形态 + 畸形输入兜底）
 *   d) fail-safe 读：列缺失/表缺失回退 null 不 throw
 *   e) setSkipVersion/setSnooze 硬校验拒绝不落库 + 三档写入读回（±2s 容差）
 *
 * 安全域：内存库（`:memory:`）无落盘；_setUpdateDbGetter 注入（不碰生产单例）。
 */

import {
  UpdateService,
  shouldAutoPrompt,
  classifyUpdateError,
  _setUpdateDbGetter,
} from '../../../electron/services/updateService'
import { v30, MIGRATION_HEAD } from '../../../electron/database/migrations'

/** 最小基线 ai_config（无压制两列——v30 前形态，ALTER ADD COLUMN 对最小形态即可用） */
function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE ai_config (id TEXT PRIMARY KEY, created_at TEXT)')
  db.exec("INSERT INTO ai_config (id) VALUES ('1')")
  v30(db)
  return db
}

const DUMMY_GETTER = () => {
  throw new Error('neutral')
}

afterEach(() => {
  _setUpdateDbGetter(DUMMY_GETTER)
})

describe('v30 迁移幂等（T-30-02）', () => {
  it('v30：最小基线 ai_config 加 update_skip_version/update_snooze_until 两列，user_version=30', () => {
    const db = makeDb()
    const cols = db.prepare("PRAGMA table_info('ai_config')").all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('update_skip_version')
    expect(cols.map((c) => c.name)).toContain('update_snooze_until')
    expect(db.pragma('user_version', { simple: true })).toBe(30)
    db.close()
  })

  it('v30 重复执行不 throw（hasColumn 幂等守卫）；MIGRATION_HEAD === 30', () => {
    const db = makeDb()
    expect(() => v30(db)).not.toThrow() // 第二次重复执行
    expect(db.pragma('user_version', { simple: true })).toBe(30)
    expect(MIGRATION_HEAD).toBe(30) // 30-02 v30 推进
    db.close()
  })
})

describe('shouldAutoPrompt 压制判定矩阵（Pattern 3 / D-02 仅自动通道）', () => {
  const V = '1.2.3'

  it('skip 命中 → false；不同版本号 → true（自动恢复）', () => {
    expect(shouldAutoPrompt(V, { skipVersion: V, snoozeUntil: null })).toBe(false)
    expect(shouldAutoPrompt(V, { skipVersion: '0.9.9', snoozeUntil: null })).toBe(true)
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: null })).toBe(true)
  })

  it('snooze 未来 ISO → false；过期 ISO → true（到期自动恢复提醒）', () => {
    const future = new Date(Date.now() + 86400000).toISOString()
    const past = new Date(Date.now() - 86400000).toISOString()
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: future })).toBe(false)
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: past })).toBe(true)
  })

  it("snooze 'forever' → false（永静默）；null → true；无效串 'abc' → true", () => {
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: 'forever' })).toBe(false)
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: null })).toBe(true)
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: 'abc' })).toBe(true)
  })

  it('skip+snooze 叠加：skip 命中优先于无效 snooze 串 → false', () => {
    // snoozeUntil='abc' 单独判定为 true；叠加 skip 命中仍 false——证明 skip 判定在前
    expect(shouldAutoPrompt(V, { skipVersion: V, snoozeUntil: 'abc' })).toBe(false)
    expect(shouldAutoPrompt(V, { skipVersion: V, snoozeUntil: new Date(Date.now() + 86400000).toISOString() })).toBe(false)
  })
})

describe('classifyUpdateError 六类分诊（Pitfall 6）', () => {
  it('六类各一正例', () => {
    expect(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe('network')
    expect(classifyUpdateError(new Error('connect ECONNREFUSED 127.0.0.1:10809'))).toBe('proxy')
    expect(classifyUpdateError({ statusCode: 429, message: 'Too Many Requests' })).toBe('ratelimit')
    expect(classifyUpdateError(new Error('ERR_UPDATER_NO_PUBLISHED_VERSIONS'))).toBe('nometa')
    expect(classifyUpdateError({ statusCode: 502, message: 'Bad Gateway' })).toBe('server')
    expect(classifyUpdateError(new Error('随便'))).toBe('unknown')
  })

  it('数字 statusCode 形态 + 403 串形态 + ECONNREFUSED 非 127.0.0.1 判 unknown', () => {
    expect(classifyUpdateError({ code: 'ETIMEDOUT' })).toBe('network')
    expect(classifyUpdateError({ statusCode: 403 })).toBe('ratelimit')
    expect(classifyUpdateError(new Error('HTTP 403 Forbidden'))).toBe('ratelimit') // 403 串形态
    expect(classifyUpdateError({ statusCode: 404, message: 'Not Found' })).toBe('nometa')
    expect(classifyUpdateError(new Error('ERR_UPDATER_LATEST_VERSION_NOT_FOUND'))).toBe('nometa')
    expect(classifyUpdateError({ statusCode: 503 })).toBe('server')
    expect(classifyUpdateError(new Error('HTTP 5xx: 503 Service Unavailable'))).toBe('server') // 5xx 串形态
    // ECONNREFUSED 但非本机代理地址 → 不判 proxy（无其他特征兜底 unknown）
    expect(classifyUpdateError(new Error('connect ECONNREFUSED 10.0.0.1:22'))).toBe('unknown')
  })

  it('畸形输入兜底 unknown（null/undefined/plain string/空对象，T-30-05）', () => {
    expect(classifyUpdateError(null)).toBe('unknown')
    expect(classifyUpdateError(undefined)).toBe('unknown')
    expect(classifyUpdateError('plain string error')).toBe('unknown')
    expect(classifyUpdateError({})).toBe('unknown')
    expect(classifyUpdateError(42)).toBe('unknown')
  })
})

describe('UpdateService 压制配置 fail-safe 读写', () => {
  it('基线表无两列：getSkipVersion/getSnoozeUntil 返回 null 不 throw（fail-safe）', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE ai_config (id TEXT PRIMARY KEY, created_at TEXT)')
    db.exec("INSERT INTO ai_config (id) VALUES ('1')")
    _setUpdateDbGetter(() => db)
    expect(UpdateService.getSkipVersion()).toBeNull()
    expect(UpdateService.getSnoozeUntil()).toBeNull()
    db.close()
  })

  it('无 ai_config 表：同样回退 null 不 throw', () => {
    const db = new Database(':memory:')
    _setUpdateDbGetter(() => db)
    expect(UpdateService.getSkipVersion()).toBeNull()
    expect(UpdateService.getSnoozeUntil()).toBeNull()
    db.close()
  })

  it('v30 后两列 NULL 态读回 null；setSkipVersion 拒绝 abc 与 <script>（success:false 不落库）；合法 0.5.0 读写回', () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    expect(UpdateService.getSkipVersion()).toBeNull() // NULL → null
    expect(UpdateService.getSnoozeUntil()).toBeNull()

    const r1 = UpdateService.setSkipVersion('abc')
    expect(r1.success).toBe(false)
    expect(r1.error).toContain('版本号')
    const r2 = UpdateService.setSkipVersion('<script>')
    expect(r2.success).toBe(false)
    expect(UpdateService.getSkipVersion()).toBeNull() // 拒绝值未落库

    expect(UpdateService.setSkipVersion('0.5.0').success).toBe(true)
    expect(UpdateService.getSkipVersion()).toBe('0.5.0')
    db.close()
  })

  it("setSnooze('30d')：ISO 值在期望区间（±2s 容差）读回", () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    const before = Date.now() + 30 * 86400000
    expect(UpdateService.setSnooze('30d').success).toBe(true)
    const after = Date.now() + 30 * 86400000
    const readBack = UpdateService.getSnoozeUntil()
    expect(readBack).not.toBeNull()
    const ts = Date.parse(readBack as string)
    expect(ts).toBeGreaterThanOrEqual(before - 2000)
    expect(ts).toBeLessThanOrEqual(after + 2000)
    db.close()
  })

  it("setSnooze('180d')：ISO 值在期望区间（±2s 容差）读回", () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    const before = Date.now() + 180 * 86400000
    expect(UpdateService.setSnooze('180d').success).toBe(true)
    const after = Date.now() + 180 * 86400000
    const readBack = UpdateService.getSnoozeUntil()
    expect(readBack).not.toBeNull()
    const ts = Date.parse(readBack as string)
    expect(ts).toBeGreaterThanOrEqual(before - 2000)
    expect(ts).toBeLessThanOrEqual(after + 2000)
    db.close()
  })

  it("setSnooze('forever')：字面 'forever' 哨兵读回", () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    expect(UpdateService.setSnooze('forever').success).toBe(true)
    expect(UpdateService.getSnoozeUntil()).toBe('forever')
    db.close()
  })

  it('setSnooze 非法档位拒绝（success:false 不落库，T-30-04 枚举硬校验）', () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    const r = UpdateService.setSnooze('abc' as never)
    expect(r.success).toBe(false)
    expect(r.error).toContain('档位')
    expect(UpdateService.getSnoozeUntil()).toBeNull() // 拒绝值未落库
    db.close()
  })
})
