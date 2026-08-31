import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

/**
 * Phase 37 Plan 37-01（RETRIEVE-CTRL-01）—— 检索行为两开关（D-01/D-03）持久化地基：
 * v33 迁移（幂等 + 双路径一致）+ getRetrievalPrefs/setRetrievalPrefs/resolveBackfillMode。
 *
 * 覆盖：
 *   a) v32 形态库跑 v33：两列就位 + 存量行取默认 0/'smart' + user_version=33 + 重跑不报错（幂等）
 *   b) 全新库走 init.ts fresh DDL：建表即含两列且默认 0/'smart'（与 v33 形态一致）
 *   c) 双路径逐字一致：init.ts DDL 两列定义与 migrations.ts v33 ALTER 列定义逐字相等
 *   d) getRetrievalPrefs：缺行/NULL/越权值（2、'xxx'）/列缺失异常全部回退 DEFAULT 不抛错
 *   e) setRetrievalPrefs：合法值写后读回一致；非布尔/非法枚举显式拒绝（不触 DB）
 *   f) resolveBackfillMode：troubleshoot 恒 'force'（D-02 唯一裁决点）+ 开关值透传
 *
 * 安全域：内存库（`:memory:`）无落盘；_setAiDbGetter 注入（不碰生产单例）。
 * 运行方式：npm run test:electron（better-sqlite3 Electron ABI，禁 npx vitest 单文件过滤）。
 */

import {
  getRetrievalPrefs,
  setRetrievalPrefs,
  resolveBackfillMode,
  DEFAULT_RETRIEVAL_PREFS,
  _setAiDbGetter,
} from '../../../electron/services/aiAgentState'
import { v33, MIGRATION_HEAD } from '../../../electron/database/migrations'

const ROOT = path.resolve(__dirname, '../../..')

/** v32 形态 ai_config（v33 前现库最新形态：init.ts 基线列 + v4 vision 三列 + v26/v30 ALTER 列） */
function createV32FormAiConfig(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ai_config (
      id TEXT PRIMARY KEY,
      provider_enc TEXT,
      api_key_enc TEXT,
      base_url_enc TEXT,
      model_name_enc TEXT,
      vision_base_url_enc TEXT,
      vision_api_key_enc TEXT,
      vision_model_enc TEXT,
      exec_mode TEXT DEFAULT 'confirm' CHECK(exec_mode IN ('confirm','smart','auto')),
      mcp_max_rounds INTEGER NOT NULL DEFAULT 5,
      agent_max_rounds INTEGER,
      agent_burnout_count INTEGER,
      agent_cooldown_secs INTEGER,
      update_skip_version TEXT,
      update_snooze_until TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `)
  db.exec("INSERT INTO ai_config (id) VALUES ('cfg-1')")
  db.pragma('user_version = 32')
}

/** v33 后标准形态库（带一行数据） */
function makeDb(): Database.Database {
  const db = new Database(':memory:')
  createV32FormAiConfig(db)
  v33(db)
  return db
}

/**
 * 畸形态库（模拟被篡改 DB——T-37-02 accept / T-37-03 读侧 fail-safe 兜底面）：
 * 两列存在但无 NOT NULL/CHECK 约束，可写入 NULL 与越权值（'xxx'/2）。
 */
function makeTamperDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE ai_config (
      id TEXT PRIMARY KEY,
      retrieval_prefetch_enabled INTEGER,
      retrieval_backfill_mode TEXT
    );
    INSERT INTO ai_config (id) VALUES ('cfg-x');
  `)
  return db
}

const DUMMY_GETTER = () => {
  throw new Error('neutral')
}

afterEach(() => {
  _setAiDbGetter(DUMMY_GETTER)
})

describe('v33 迁移 + 双路径一致（RETRIEVE-CTRL-01）', () => {
  it('v32 形态库跑 v33：两列就位 + 存量行取默认 0/\'smart\' + user_version=33 + 重跑不报错', () => {
    const db = new Database(':memory:')
    createV32FormAiConfig(db)
    v33(db)

    const cols = (db.prepare("PRAGMA table_info('ai_config')").all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('retrieval_prefetch_enabled')
    expect(cols).toContain('retrieval_backfill_mode')

    // ALTER ADD COLUMN DEFAULT 对存量行回填默认值（D-03：预取关 + 补查智能）
    const row = db
      .prepare('SELECT retrieval_prefetch_enabled AS p, retrieval_backfill_mode AS m FROM ai_config WHERE id = ?')
      .get('cfg-1') as { p: number; m: string }
    expect(row.p).toBe(0)
    expect(row.m).toBe('smart')

    expect(db.pragma('user_version', { simple: true })).toBe(33)
    expect(() => v33(db)).not.toThrow() // 幂等重跑（hasColumn 守卫命中）
    expect(db.pragma('user_version', { simple: true })).toBe(33) // guard 命中也推进 HEAD（v31 模式）
    db.close()
  })

  it('全新库走 init.ts fresh DDL：建表即含两列且默认 0/\'smart\'（与 v33 形态一致）', () => {
    const initSrc = fs.readFileSync(path.join(ROOT, 'electron/database/init.ts'), 'utf-8')
    const m = /CREATE TABLE IF NOT EXISTS ai_config \(([\s\S]*?)\);/.exec(initSrc)
    expect(m, 'init.ts ai_config DDL 未命中').toBeTruthy()

    const db = new Database(':memory:')
    db.exec(`CREATE TABLE ai_config (${m![1]});`)
    const info = db.prepare("PRAGMA table_info('ai_config')").all() as Array<{ name: string; dflt_value: string }>
    const prefetch = info.find((c) => c.name === 'retrieval_prefetch_enabled')
    const mode = info.find((c) => c.name === 'retrieval_backfill_mode')
    expect(prefetch?.dflt_value).toBe('0')
    expect(mode?.dflt_value).toBe("'smart'")

    // 新行缺省落默认值（INSERT 不指定两列）
    db.exec("INSERT INTO ai_config (id) VALUES ('cfg-fresh')")
    const row = db
      .prepare("SELECT retrieval_prefetch_enabled AS p, retrieval_backfill_mode AS m FROM ai_config WHERE id = 'cfg-fresh'")
      .get() as { p: number; m: string }
    expect(row.p).toBe(0)
    expect(row.m).toBe('smart')
    db.close()
  })

  it('双路径逐字一致：init.ts DDL 两列定义与 migrations.ts v33 ALTER 列定义逐字相等', () => {
    const migrationsSrc = fs.readFileSync(path.join(ROOT, 'electron/database/migrations.ts'), 'utf-8')
    const initSrc = fs.readFileSync(path.join(ROOT, 'electron/database/init.ts'), 'utf-8')

    const v33Idx = migrationsSrc.indexOf('export const v33')
    expect(v33Idx).toBeGreaterThanOrEqual(0)
    const v33Src = migrationsSrc.slice(v33Idx, migrationsSrc.indexOf('export const MIGRATIONS'))

    const migPrefetch = /ALTER TABLE ai_config ADD COLUMN (retrieval_prefetch_enabled [^']+)/.exec(v33Src)?.[1]
    const migMode = /ALTER TABLE ai_config ADD COLUMN (retrieval_backfill_mode [^"]+)\)/.exec(v33Src)?.[1]
    const initPrefetch = /^\s*(retrieval_prefetch_enabled [^,\n]+),$/m.exec(initSrc)?.[1]
    const initMode = /^\s*(retrieval_backfill_mode .+),$/m.exec(initSrc)?.[1]

    expect(migPrefetch).toBeDefined()
    expect(migMode).toBeDefined()
    expect(initPrefetch).toBe(migPrefetch)
    expect(initMode).toBe(migMode)
    // CHECK 枚举锁逐字（库级拦截非法枚举，T-37-02）
    expect(initMode).toContain("CHECK(retrieval_backfill_mode IN ('force','smart'))")
  })

  it('MIGRATION_HEAD=33（注册完整性静态守卫，防 bump 漏改）', () => {
    expect(MIGRATION_HEAD).toBe(33)
  })
})

describe('getRetrievalPrefs fail-safe 矩阵（T-37-03）', () => {
  it('缺行/NULL/越权值（2、\'xxx\'）/列缺失异常全部回退 DEFAULT 不抛错', () => {
    // 缺行：表存在但无行
    const db = makeDb()
    _setAiDbGetter(() => db)
    db.exec('DELETE FROM ai_config')
    expect(getRetrievalPrefs()).toEqual(DEFAULT_RETRIEVAL_PREFS)

    // NULL / 越权值：畸形态库（无 NOT NULL/CHECK，模拟被篡改 DB）
    const tdb = makeTamperDb()
    _setAiDbGetter(() => tdb)
    tdb.prepare('UPDATE ai_config SET retrieval_prefetch_enabled = NULL, retrieval_backfill_mode = NULL').run()
    expect(getRetrievalPrefs()).toEqual(DEFAULT_RETRIEVAL_PREFS)

    tdb.prepare("UPDATE ai_config SET retrieval_prefetch_enabled = 2, retrieval_backfill_mode = 'smart'").run()
    expect(getRetrievalPrefs()).toEqual({ prefetchEnabled: false, backfillMode: 'smart' }) // 2 畸形回退默认 false

    tdb.prepare("UPDATE ai_config SET retrieval_prefetch_enabled = 1, retrieval_backfill_mode = 'xxx'").run()
    expect(getRetrievalPrefs()).toEqual({ prefetchEnabled: true, backfillMode: 'smart' }) // 'xxx' 回退 'smart'

    // 列缺失异常：无 ai_config 表的空库整体 catch 回退
    const empty = new Database(':memory:')
    _setAiDbGetter(() => empty)
    expect(getRetrievalPrefs()).toEqual(DEFAULT_RETRIEVAL_PREFS)
    db.close()
    tdb.close()
    empty.close()
  })

  it('合法值 0/false 与 1/force 正常读回', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)
    db.prepare("UPDATE ai_config SET retrieval_prefetch_enabled = 0, retrieval_backfill_mode = 'force'").run()
    expect(getRetrievalPrefs()).toEqual({ prefetchEnabled: false, backfillMode: 'force' })
    db.prepare("UPDATE ai_config SET retrieval_prefetch_enabled = 1, retrieval_backfill_mode = 'smart'").run()
    expect(getRetrievalPrefs()).toEqual({ prefetchEnabled: true, backfillMode: 'smart' })
    db.close()
  })
})

describe('setRetrievalPrefs 校验与写读一致', () => {
  it('合法值写入读回一致（true/force 与 false/smart 两态，DB 落 1/0 明文）', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)

    expect(setRetrievalPrefs({ prefetchEnabled: true, backfillMode: 'force' })).toEqual({ success: true })
    expect(getRetrievalPrefs()).toEqual({ prefetchEnabled: true, backfillMode: 'force' })
    let row = db.prepare('SELECT retrieval_prefetch_enabled AS p, retrieval_backfill_mode AS m FROM ai_config').get() as { p: number; m: string }
    expect(row).toEqual({ p: 1, m: 'force' })

    expect(setRetrievalPrefs({ prefetchEnabled: false, backfillMode: 'smart' })).toEqual({ success: true })
    expect(getRetrievalPrefs()).toEqual({ prefetchEnabled: false, backfillMode: 'smart' })
    row = db.prepare('SELECT retrieval_prefetch_enabled AS p, retrieval_backfill_mode AS m FROM ai_config').get() as { p: number; m: string }
    expect(row).toEqual({ p: 0, m: 'smart' })
    db.close()
  })

  it('prefetchEnabled 非布尔 → success:false error 含「预取开关」且不触 DB', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)
    setRetrievalPrefs({ prefetchEnabled: true, backfillMode: 'force' })

    const bad = setRetrievalPrefs({ prefetchEnabled: 2, backfillMode: 'smart' } as unknown as Parameters<typeof setRetrievalPrefs>[0])
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('预取开关')
    // 拒绝不触 DB：库值保持原样
    expect(getRetrievalPrefs()).toEqual({ prefetchEnabled: true, backfillMode: 'force' })
    db.close()
  })

  it('backfillMode 非 force/smart → success:false error 含「补查模式」且不触 DB', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)

    const bad = setRetrievalPrefs({ prefetchEnabled: true, backfillMode: 'xxx' } as unknown as Parameters<typeof setRetrievalPrefs>[0])
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('补查模式')
    expect(getRetrievalPrefs()).toEqual(DEFAULT_RETRIEVAL_PREFS) // 库值未动（默认态）
    db.close()
  })
})

describe('resolveBackfillMode（D-02 唯一裁决点）', () => {
  it('开关 smart + troubleshoot → force；smart + knowledge → smart（troubleshoot 恒强制无视开关）', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)
    db.prepare("UPDATE ai_config SET retrieval_backfill_mode = 'smart'").run()

    expect(resolveBackfillMode('troubleshoot')).toBe('force')
    expect(resolveBackfillMode('knowledge')).toBe('smart')
    expect(resolveBackfillMode('configQuery')).toBe('smart')
    expect(resolveBackfillMode('inspection')).toBe('smart')
    db.close()
  })

  it('开关 force + 任意档 → force', () => {
    const db = makeDb()
    _setAiDbGetter(() => db)
    db.prepare("UPDATE ai_config SET retrieval_backfill_mode = 'force'").run()

    for (const tier of ['troubleshoot', 'knowledge', 'configQuery', 'inspection'] as const) {
      expect(resolveBackfillMode(tier)).toBe('force')
    }
    db.close()
  })
})
