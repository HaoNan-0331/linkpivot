import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 28 Plan 28-01（AGENT-04 前置）—— agent 循环硬顶三参数 get/钳制/set + v26 迁移验证。
 *
 * 覆盖：
 *   a) getAgentMaxRounds：NULL/非整数/<1/>30 一律回退 12；列缺失异常回退 12
 *   b) getAgentBurnoutCount：非法回退 2，钳制 1-5
 *   c) getAgentCooldownSecs：非法回退 60，钳制 10-600
 *   d) setAgentMaxRounds(31) 返回 success:false 且 error 含 "1-30"；合法值落库成功
 *   e) v26 在已有 v25 库上重复执行不报错（hasColumn 幂等）
 *
 * 安全域：内存库（`:memory:`）无落盘；_setAiDbGetter 注入（不碰生产单例）。
 */

import {
  getAgentMaxRounds,
  setAgentMaxRounds,
  getAgentBurnoutCount,
  setAgentBurnoutCount,
  getAgentCooldownSecs,
  setAgentCooldownSecs,
  DEFAULT_AGENT_MAX_ROUNDS,
  _setAiDbGetter,
} from '../../../electron/services/ai'
import { v26, MIGRATION_HEAD } from '../../../electron/database/migrations'

/** v25 形态 ai_config（无 agent 三列——v26 前基线） */
function createV25FormAiConfig(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ai_config (
      id TEXT PRIMARY KEY,
      provider_enc TEXT,
      api_key_enc TEXT,
      base_url_enc TEXT,
      model_name_enc TEXT,
      exec_mode TEXT DEFAULT 'confirm' CHECK(exec_mode IN ('confirm','smart','auto')),
      mcp_max_rounds INTEGER NOT NULL DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `)
  db.exec("INSERT INTO ai_config (id) VALUES ('cfg-1')")
  db.exec(`
    CREATE TABLE chat_history (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content_enc TEXT NOT NULL,
      device_id TEXT,
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `)
  db.pragma('user_version = 25')
}

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  createV25FormAiConfig(db)
  v26(db)
  return db
}

const DUMMY_GETTER = () => {
  throw new Error('neutral')
}

afterEach(() => {
  _setAiDbGetter(DUMMY_GETTER)
})

describe('agent 硬顶三参数 get/set（D-04）', () => {
  it('getAgentMaxRounds：NULL/非整数/越界一律 fail-safe 回退默认 12', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)
    expect(getAgentMaxRounds()).toBe(DEFAULT_AGENT_MAX_ROUNDS) // NULL → 12
    for (const bad of [0, -3, 31, 12.5]) {
      db.prepare('UPDATE ai_config SET agent_max_rounds = ?').run(bad)
      expect(getAgentMaxRounds()).toBe(12)
    }
  })

  it('getAgentMaxRounds：列缺失异常回退 12；合法值正常读回', () => {
    const db = new Database(':memory:') // 无 ai_config 表
    _setAiDbGetter(() => db)
    expect(getAgentMaxRounds()).toBe(12)

    const db2 = makeDb()
    _setAiDbGetter(() => db2)
    db2.prepare('UPDATE ai_config SET agent_max_rounds = ?').run(20)
    expect(getAgentMaxRounds()).toBe(20)
  })

  it('setAgentMaxRounds(31) 拒绝：success:false 且 error 含 1-30；合法值落库成功', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)
    const bad = setAgentMaxRounds(31)
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('1-30')
    expect(setAgentMaxRounds(0).success).toBe(false)
    expect(setAgentMaxRounds(12.5).success).toBe(false)
    expect(setAgentMaxRounds(12).success).toBe(true)
    expect(getAgentMaxRounds()).toBe(12)
  })

  it('getAgentBurnoutCount：非法回退 2，钳制 1-5；set 越界拒绝', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)
    expect(getAgentBurnoutCount()).toBe(2) // NULL → 2
    for (const bad of [0, 6, 2.5, -1]) {
      db.prepare('UPDATE ai_config SET agent_burnout_count = ?').run(bad)
      expect(getAgentBurnoutCount()).toBe(2)
    }
    const r = setAgentBurnoutCount(6)
    expect(r.success).toBe(false)
    expect(r.error).toContain('1-5')
    expect(setAgentBurnoutCount(3).success).toBe(true)
    expect(getAgentBurnoutCount()).toBe(3)
  })

  it('getAgentCooldownSecs：非法回退 60，钳制 10-600；set 越界拒绝', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)
    expect(getAgentCooldownSecs()).toBe(60) // NULL → 60
    for (const bad of [9, 601, 30.5, 0]) {
      db.prepare('UPDATE ai_config SET agent_cooldown_secs = ?').run(bad)
      expect(getAgentCooldownSecs()).toBe(60)
    }
    const r = setAgentCooldownSecs(601)
    expect(r.success).toBe(false)
    expect(r.error).toContain('10-600')
    expect(setAgentCooldownSecs(120).success).toBe(true)
    expect(getAgentCooldownSecs()).toBe(120)
  })
})

describe('v26 迁移幂等（T-28-01-03）', () => {
  it('v25 库上 v26 加三列 + chat_history.meta_enc；重复执行不报错；user_version=26', () => {
    const db = makeDb()
    expect(v26(db)).toBeUndefined() // 第二次重复执行（hasColumn 幂等守卫）
    const uv = db.pragma('user_version') as Array<{ user_version: number }>
    expect(uv[0].user_version).toBe(26)
    expect(MIGRATION_HEAD).toBe(32) // 36-01 v32 推进
  })

  it('v26 后 chat_history 可建 meta_enc 列（升级路径）', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE ai_config (id TEXT PRIMARY KEY, mcp_max_rounds INTEGER NOT NULL DEFAULT 5)')
    db.exec('CREATE TABLE chat_history (id TEXT PRIMARY KEY, role TEXT NOT NULL, content_enc TEXT NOT NULL, device_id TEXT, session_id TEXT, created_at TEXT)')
    db.pragma('user_version = 25')
    v26(db)
    const cols = db.prepare("PRAGMA table_info('chat_history')").all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('meta_enc')
  })
})
