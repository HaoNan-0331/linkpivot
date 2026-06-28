import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { hasColumn } from '../../electron/database/migrationHelpers'

/**
 * hasColumn 接受 db 参数（不在内部调 getDatabase）——正是为可测试性而设计。
 * 用最小 mock 桩 PRAGMA table_info 的 .all() 返回，无需实例化真实 better-sqlite3
 * （避免 native binding 在 Node/Electron 不同 NODE_MODULE_VERSION 下的加载冲突，
 *  与现有 crypto/auth 测试规避 better-sqlite3 的做法一致）。
 */
function makeDb(colNames: string[]): Database.Database {
  const stmt = { all: () => colNames.map((name) => ({ name })) }
  return { prepare: () => stmt } as unknown as Database.Database
}

describe('hasColumn', () => {
  it('returns true when column exists', () => {
    const db = makeDb(['id', 'name'])
    expect(hasColumn(db, 't', 'name')).toBe(true)
    expect(hasColumn(db, 't', 'id')).toBe(true)
  })

  it('returns false when column does not exist', () => {
    const db = makeDb(['id'])
    expect(hasColumn(db, 't', 'nonexistent')).toBe(false)
  })

  it('correct based on column defs not row data', () => {
    const db = makeDb(['id', 'session_id'])
    expect(hasColumn(db, 'chat_history', 'session_id')).toBe(true)
  })

  it('returns false for absent column on new table shape', () => {
    const db = makeDb(['id'])
    expect(hasColumn(db, 'chat_history', 'session_id')).toBe(false)
  })
})
