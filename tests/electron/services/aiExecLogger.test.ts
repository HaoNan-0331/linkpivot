import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

/**
 * Phase 27 Plan 27-02（GUARD-05/D-07）—— ai_exec_logs 越权审计两列存储层验证。
 *
 * 覆盖：
 *   a) createLog 带 guardHits 落库，getLogs 可读回（JSON 往返）
 *   b) guard_hits 塞坏 JSON 时 getLogs 返回 null 不 throw（T-27-05 读路径降级）
 *   c) updateLogGuardOutcome 写值可查（投影 guardOutcome）
 *   d) v25 迁移幂等（老库已有列重跑不 throw）+ init.ts fresh DDL 含两列 + status CHECK 零改动
 *
 * 安全域：内存库（`:memory:`）无落盘；_setAiExecLoggerDbGetter 注入（不碰生产单例）。
 */

import {
  createLog,
  getLogs,
  updateLogGuardOutcome,
  reconcilePendingGuardOutcomes,
  _setAiExecLoggerDbGetter,
} from '../../../electron/services/aiExecLogger'
import { v25, MIGRATION_HEAD } from '../../../electron/database/migrations'

/** v24 形态 ai_exec_logs（无 guard 列——v25 前基线，status/mode CHECK 与现状一致） */
function createV24FormTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ai_exec_logs (
      id TEXT PRIMARY KEY,
      device_id TEXT,
      device_name_enc TEXT,
      command TEXT NOT NULL,
      status TEXT CHECK(status IN ('approved','rejected','pending','executed','failed')),
      mode TEXT CHECK(mode IN ('confirm','smart','auto')),
      ai_reason TEXT,
      prompt_text TEXT,
      ai_response TEXT,
      prompt_text_enc TEXT,
      ai_response_enc TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `)
  db.pragma('user_version = 24')
}

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  createV24FormTable(db)
  v25(db)
  return db
}

const DUMMY_GETTER = () => {
  throw new Error('neutral')
}

afterEach(() => {
  _setAiExecLoggerDbGetter(DUMMY_GETTER)
})

describe('aiExecLogger guard 审计列（27-02）', () => {
  it('a) createLog 带 guardHits 落库，getLogs 读回结构一致；未传为 null', () => {
    const db = makeDb()
    _setAiExecLoggerDbGetter(() => db)
    const hits = [
      { ruleId: 'GUARD-02' as const, level: 'red' as const, target: '10.1.1.2', explanation: '跳板命令目标非当前设备' },
      { ruleId: 'GUARD-01' as const, level: 'yellow' as const, target: '8.8.8.8', explanation: '探测公网目标' },
    ]
    const idWith = createLog({
      deviceId: 'd1', deviceName: 'Core-SW1', command: 'ssh 10.1.1.2',
      status: 'pending', mode: 'confirm', aiReason: 'r', guardHits: hits,
    })
    const idWithout = createLog({
      deviceId: 'd1', deviceName: 'Core-SW1', command: 'show ver',
      status: 'executed', mode: 'auto', aiReason: 'r',
    })

    const logs = getLogs(10)
    const withRow = logs.find((l) => l.id === idWith)!
    expect(withRow.guardHits).toEqual(hits)
    expect(withRow.guardOutcome).toBeNull()
    const withoutRow = logs.find((l) => l.id === idWithout)!
    expect(withoutRow.guardHits).toBeNull()
    db.close()
  })

  it('b) guard_hits 坏 JSON / 非 JSON 数组 → getLogs 返回 null 不 throw', () => {
    const db = makeDb()
    const insert = db.prepare(
      "INSERT INTO ai_exec_logs (id, device_id, device_name_enc, command, status, mode, ai_reason, guard_hits) VALUES (?, ?, NULL, 'x', 'pending', 'confirm', 'r', ?)"
    )
    insert.run('bad-json', 'd1', '{not-json')
    insert.run('not-array', 'd1', '"just-a-string"')
    _setAiExecLoggerDbGetter(() => db)

    const logs = getLogs(10)
    expect(logs.find((l) => l.id === 'bad-json')!.guardHits).toBeNull()
    expect(logs.find((l) => l.id === 'not-array')!.guardHits).toBeNull()
    db.close()
  })

  it('c) updateLogGuardOutcome 写 user_confirmed / user_cancelled 可投影读回', () => {
    const db = makeDb()
    _setAiExecLoggerDbGetter(() => db)
    const id1 = createLog({
      deviceId: 'd1', deviceName: 'A', command: 'ssh 10.1.1.2',
      status: 'pending', mode: 'confirm', aiReason: 'r',
      guardHits: [{ ruleId: 'GUARD-02', level: 'red', target: '10.1.1.2', explanation: 'x' }],
    })
    const id2 = createLog({
      deviceId: 'd1', deviceName: 'A', command: 'telnet 10.1.1.3',
      status: 'pending', mode: 'confirm', aiReason: 'r',
    })
    updateLogGuardOutcome(id1, 'user_confirmed')
    updateLogGuardOutcome(id2, 'user_cancelled')

    const logs = getLogs(10)
    expect(logs.find((l) => l.id === id1)!.guardOutcome).toBe('user_confirmed')
    expect(logs.find((l) => l.id === id2)!.guardOutcome).toBe('user_cancelled')
    db.close()
  })

  it('d) v25 幂等（列已存在重跑不 throw）+ 老库升级路径列就位 + MIGRATION_HEAD=26', () => {
    const db = makeDb()
    // 已有列的老库重跑（模拟 user_version 回退场景）
    expect(() => v25(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(25)
    const cols = (db.prepare('PRAGMA table_info(ai_exec_logs)').all() as Array<{ name: string }>).map((r) => r.name)
    expect(cols).toContain('guard_hits')
    expect(cols).toContain('guard_outcome')
    expect(MIGRATION_HEAD).toBe(32) // 36-01 v32 推进（v25 自身 user_version 断言不变）
    db.close()
  })

  it('e) init.ts fresh ai_exec_logs DDL 含两列；migrations.ts 无 ai_exec_logs CHECK 新增', () => {
    const root = path.resolve(__dirname, '../../..')
    const initSrc = fs.readFileSync(path.join(root, 'electron/database/init.ts'), 'utf-8')
    const m = initSrc.match(/CREATE TABLE IF NOT EXISTS ai_exec_logs \(([\s\S]*?)\);/)
    expect(m).toBeTruthy()
    expect(m![1]).toContain('guard_hits TEXT')
    expect(m![1]).toContain('guard_outcome TEXT')

    // status CHECK 零改动：init.ts 仍为原五值枚举
    expect(m![1]).toContain("status TEXT CHECK(status IN ('approved','rejected','pending','executed','failed'))")

    const migrationsSrc = fs.readFileSync(path.join(root, 'electron/database/migrations.ts'), 'utf-8')
    const v25Idx = migrationsSrc.indexOf('export const v25')
    const v25Src = migrationsSrc.slice(v25Idx, migrationsSrc.indexOf('export const v26'))
    expect(v25Src).not.toContain('CHECK')
  })
})

describe('aiExecLogger reconcile 未决订正（Phase 27 checkpoint：未点确认=取消）', () => {
  it('a) 孤儿未决记录（批次不在存活集）订正 user_cancelled + rejected；存活批次记录不动', () => {
    const db = makeDb()
    _setAiExecLoggerDbGetter(() => db)
    const orphanId = createLog({
      deviceId: 'd1', deviceName: 'A', command: 'ssh 10.0.0.2', status: 'pending', mode: 'confirm',
      guardHits: [{ ruleId: 'GUARD-02', level: 'red', target: '10.0.0.2', explanation: '跳转目标非当前设备' }],
    })
    const liveId = createLog({
      deviceId: 'd1', deviceName: 'A', command: 'ping 8.8.8.8', status: 'pending', mode: 'confirm',
      guardHits: [{ ruleId: 'GUARD-01', level: 'yellow', target: '8.8.8.8', explanation: '目标不在对话设备集' }],
    })
    const plainId = createLog({ deviceId: 'd1', deviceName: 'A', command: 'uptime', status: 'pending', mode: 'confirm' })
    const n = reconcilePendingGuardOutcomes(new Set([liveId]))
    expect(n).toBe(1)
    const row = (id: string) => db.prepare('SELECT status, guard_outcome FROM ai_exec_logs WHERE id = ?').get(id) as { status: string, guard_outcome: string | null }
    expect(row(orphanId)).toEqual({ status: 'rejected', guard_outcome: 'user_cancelled' })
    expect(row(liveId)).toEqual({ status: 'pending', guard_outcome: null })
    // 非 guard 记录不在订正范围（保持既有行为）
    expect(row(plainId)).toEqual({ status: 'pending', guard_outcome: null })
  })

  it('b) 空存活集（启动全量订正）+ 幂等（已订正行不再命中）', () => {
    const db = makeDb()
    _setAiExecLoggerDbGetter(() => db)
    const id = createLog({
      deviceId: 'd1', deviceName: 'A', command: 'ssh 10.0.0.3', status: 'pending', mode: 'auto',
      guardHits: [{ ruleId: 'GUARD-02', level: 'red', target: '10.0.0.3', explanation: '跳转目标非当前设备' }],
    })
    expect(reconcilePendingGuardOutcomes(new Set())).toBe(1)
    expect(reconcilePendingGuardOutcomes(new Set())).toBe(0) // 幂等
    const row = db.prepare('SELECT status, guard_outcome FROM ai_exec_logs WHERE id = ?').get(id) as { status: string, guard_outcome: string }
    expect(row).toEqual({ status: 'rejected', guard_outcome: 'user_cancelled' })
  })
})
