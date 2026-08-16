import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import type Database from 'better-sqlite3'

/**
 * Phase 17 Plan 17-03 Task 1 —— SEC-06 legacy fixture 真路径矩阵验证（SC#1/SC#2/SC#3/SC#4 + D-03）。
 *
 * 以「v0.3.0 明文旧库」（A3：v0.3.0 = user_version 12，DDL 逐字照抄 git tag v0.3.0 init.ts 对应块
 * + v2 明文列）为起点，全链路验证 17-01/17-02 交付的行为主体：
 *   组1 v13 迁移幂等（真 DDL，hasColumn 守卫真跑）
 *   组2 回填 + 读回逐字一致（SC#1）+ 旧列置 NULL + 二次回填 no-op
 *   组3 字节净化（SC#4/Pitfall 7，正反双向：正控 A / freelist 残留 B / VACUUM 净化 C）
 *   组4 新写路径密文落库（SC#2）+ append 追加完整（SC#3/P2 + 矩阵 #2 清旧列）
 *   组5 坏密文占位符（D-03 字面量）+ 坏密文 append 跳写保原文 + 混合期透明（状态矩阵 #1/#4/#5）
 *
 * 边界（OQ#1 既定 + plan 验收红线）：
 *   - 不 import 生产 migrations.ts / init.ts / connection.ts——applyV13 函数体逐字照抄
 *     migrations.ts v13（migrations 经 getDatabase 单例牵连 electron app）；hasColumn 从
 *     migrationHelpers import（纯函数 + type-only 依赖，无 electron 牵连）。
 *   - afterEach 还原两注入口为中性 stub（非 getDatabase——RUN_AS_NODE 下真 getDatabase 经
 *     app.getPath 必 throw，中性 stub 同样 throw 但带清晰文案；vitest 文件级隔离下跨文件零影响）。
 *
 * 安全域（threat_model T-17-11/12/13/14）：
 *   - 字节断言三段式：每次读字节前 wal_checkpoint(TRUNCATE)（WAL 页未并入主文件时断言失真）；
 *     ASCII MARKER 避编码歧义；断言 A 正控杜绝假绿（marker 检不出时立即红）。
 *   - D-03 占位符用字面量断言（不 import DECRYPT_FAIL_PLACEHOLDER，文案 drift 即红）。
 *   - TEST_MK 为非空测试常量（照 connection.probe.real 先例），不触碰生产 userData/masterKey。
 */

import { makeRealDb, type RealDbHandle } from './_helpers/realDb'
import { hasColumn } from '../../electron/database/migrationHelpers'
import {
  setSystemLogMasterKey,
  _setSystemLogDbGetter,
  createSystemLog,
  getSystemLogs,
  backfillSystemLogEnc,
} from '../../electron/services/systemLog'
import {
  setAiExecLoggerMasterKey,
  _setAiExecLoggerDbGetter,
  createLog,
  appendLogAiResponse,
  getLogs,
  backfillAiExecLogEnc,
} from '../../electron/services/aiExecLogger'

const TEST_MK = 'nt-test-mk-17s'

// 字节净化探针：纯 ASCII 串避免编码歧义（T-17-12）
const MARKER = 'PLAINTEXT-MARKER-7F3A9C'

let handle: RealDbHandle | null = null

// ---------------------------------------------------------------------------
// 基建：legacy schema 构造 + v13 应用 helper
// ---------------------------------------------------------------------------

/**
 * 手搓 v0.3.0 legacy schema（user_version = 12）。DDL 逐字照抄 git tag v0.3.0 init.ts 对应块：
 *   - ai_exec_logs：v0.3.0 init.ts:58-67 基础 7 列（无明文列）+ v2 迁移明文列
 *     （migrations.ts v2：prompt_text/ai_response TEXT DEFAULT ''——v0.3.0 库经 v2 ALTER 所加）
 *   - ai_system_logs：v0.3.0 init.ts:85-96 v11 形态（type CHECK 含 'security'，明文列无 DEFAULT）
 *   - scheduler_config：v0.3.0 init.ts:194-200 五列形态（无 retention_days——由 v13 加）
 */
function createLegacyV12Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ai_exec_logs (
      id TEXT PRIMARY KEY,
      device_id TEXT,
      device_name_enc TEXT,
      command TEXT NOT NULL,
      status TEXT CHECK(status IN ('approved','rejected','pending','executed','failed')),
      mode TEXT CHECK(mode IN ('confirm','auto')),
      ai_reason TEXT,
      prompt_text TEXT DEFAULT '',
      ai_response TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE ai_system_logs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'discovery' CHECK(type IN ('discovery','acl','migration','backup','security')),
      status TEXT NOT NULL CHECK(status IN ('success','failed','warning')),
      device_ids TEXT,
      device_names TEXT,
      prompt_text TEXT,
      ai_response TEXT,
      parsed_result TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE scheduler_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      last_run TEXT,
      next_run TEXT
    );
  `)
  db.pragma('user_version = 12')
}

/**
 * v13 应用 helper——5 个守卫 ALTER 逐字照抄 migrations.ts v13 函数体 + 尾部 user_version=13，
 * 包单 db.transaction（不 import 生产 migrations.ts：经 getDatabase 牵连 electron app，OQ#1 边界）。
 */
function applyV13(db: Database.Database): void {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'ai_exec_logs', 'prompt_text_enc')) {
      db.exec('ALTER TABLE ai_exec_logs ADD COLUMN prompt_text_enc TEXT')
    }
    if (!hasColumn(db, 'ai_exec_logs', 'ai_response_enc')) {
      db.exec('ALTER TABLE ai_exec_logs ADD COLUMN ai_response_enc TEXT')
    }
    if (!hasColumn(db, 'ai_system_logs', 'prompt_text_enc')) {
      db.exec('ALTER TABLE ai_system_logs ADD COLUMN prompt_text_enc TEXT')
    }
    if (!hasColumn(db, 'ai_system_logs', 'ai_response_enc')) {
      db.exec('ALTER TABLE ai_system_logs ADD COLUMN ai_response_enc TEXT')
    }
    if (!hasColumn(db, 'scheduler_config', 'retention_days')) {
      db.exec('ALTER TABLE scheduler_config ADD COLUMN retention_days INTEGER DEFAULT 90')
    }
    db.pragma('user_version = 13')
  })
  step()
}

// 还原目标：中性 stub（防注入口闭包泄漏已 close 的 handle；RUN_AS_NODE 下真 getDatabase 必 throw，
// 中性 stub 同样 throw 但文案可诊断——不 import 生产 connection.ts，T-17-14）
function neutralDbGetter(): Database.Database {
  throw new Error('logEncMigration.real.test: db getter 未注入（afterEach 已还原中性 stub）')
}

// ---------------------------------------------------------------------------
// 造数 / 断言 helpers
// ---------------------------------------------------------------------------

interface LegacyRowOpts {
  promptText: string | null
  aiResponse: string | null
  createdAt?: string
}

/** 直插 legacy 明文行（模拟 v0.3.0 旧代码写出的 ai_exec_logs 行） */
function insertLegacyExecRow(opts: LegacyRowOpts): string {
  const id = `exec-${Math.random().toString(36).slice(2, 10)}`
  handle!.db
    .prepare(
      `INSERT INTO ai_exec_logs (id, device_id, device_name_enc, command, status, mode, ai_reason, prompt_text, ai_response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, 'dev-1', null, 'display version', 'executed', 'confirm', '17-03 测试原因', opts.promptText, opts.aiResponse, opts.createdAt ?? '2026-08-16 10:00:00')
  return id
}

/** 直插 legacy 明文行（模拟 v0.3.0 旧代码写出的 ai_system_logs 行） */
function insertLegacySystemRow(opts: LegacyRowOpts): string {
  const id = `sys-${Math.random().toString(36).slice(2, 10)}`
  handle!.db
    .prepare(
      `INSERT INTO ai_system_logs (id, type, status, device_ids, device_names, prompt_text, ai_response, parsed_result, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, 'discovery', 'success', null, null, opts.promptText, opts.aiResponse, null, null, opts.createdAt ?? '2026-08-16 10:00:00')
  return id
}

/** ~10KB 大载荷文本，每 ~60 字符内嵌一次 MARKER（溢出页链确定性，Pitfall 7） */
function bigMarkerPayload(): string {
  const parts: string[] = []
  for (let i = 0; i < 170; i++) {
    parts.push(`s${String(i).padStart(4, '0')} ${MARKER} ${'p'.repeat(32)}`)
  }
  return parts.join('\n')
}

/** 读字节前必须 wal_checkpoint(TRUNCATE)——WAL 页未并入主文件时字节断言失真（T-17-11/12） */
function checkpointedDbBytes(): Buffer {
  handle!.db.pragma('wal_checkpoint(TRUNCATE)')
  return fs.readFileSync(handle!.dbPath)
}

function execRow(id: string): {
  prompt_text: string | null
  ai_response: string | null
  prompt_text_enc: string | null
  ai_response_enc: string | null
} {
  return handle!.db
    .prepare('SELECT prompt_text, ai_response, prompt_text_enc, ai_response_enc FROM ai_exec_logs WHERE id = ?')
    .get(id) as any
}

function systemRow(id: string): {
  prompt_text: string | null
  ai_response: string | null
  prompt_text_enc: string | null
  ai_response_enc: string | null
} {
  return handle!.db
    .prepare('SELECT prompt_text, ai_response, prompt_text_enc, ai_response_enc FROM ai_system_logs WHERE id = ?')
    .get(id) as any
}

/** 明文列残留计数（回填净化终点判据：全库为 0） */
function plaintextResidualCount(table: 'ai_exec_logs' | 'ai_system_logs'): number {
  return (
    handle!.db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE prompt_text IS NOT NULL OR ai_response IS NOT NULL`)
      .get() as any
  ).c
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach（kb real test 范式：注入 + 还原纪律防漂移）
// ---------------------------------------------------------------------------

beforeEach(() => {
  handle = makeRealDb()
  createLegacyV12Schema(handle.db)
  _setSystemLogDbGetter(() => handle!.db)
  _setAiExecLoggerDbGetter(() => handle!.db)
  setSystemLogMasterKey(TEST_MK)
  setAiExecLoggerMasterKey(TEST_MK)
})

afterEach(() => {
  // 还原纪律（T-17-14）：两注入口还原中性 stub、两 MK 复位 ''、handle.close() 严格删三文件
  _setSystemLogDbGetter(neutralDbGetter)
  _setAiExecLoggerDbGetter(neutralDbGetter)
  setSystemLogMasterKey('')
  setAiExecLoggerMasterKey('')
  if (handle) {
    handle.close()
    handle = null
  }
})

// ---------------------------------------------------------------------------
// 组1 v13 迁移幂等（真 DDL）
// ---------------------------------------------------------------------------

describe('组1 v13 迁移幂等（真 DDL：hasColumn 守卫真跑）', () => {
  it('legacy v12 库 → applyV13 → 5 列存在 + user_version=13 → 二次调用 no-throw', () => {
    const db = handle!.db
    insertLegacyExecRow({ promptText: 'legacy 明文 prompt', aiResponse: 'legacy 明文 response' })
    // 前置守卫真跑证明：v0.3.0 库确无 v13 列（守卫不命中即 ALTER 生效，非空转）
    expect(hasColumn(db, 'ai_exec_logs', 'prompt_text_enc')).toBe(false)
    expect(hasColumn(db, 'ai_system_logs', 'prompt_text_enc')).toBe(false)
    expect(hasColumn(db, 'scheduler_config', 'retention_days')).toBe(false)
    expect(db.pragma('user_version', { simple: true })).toBe(12)

    applyV13(db)

    expect(hasColumn(db, 'ai_exec_logs', 'prompt_text_enc')).toBe(true)
    expect(hasColumn(db, 'ai_exec_logs', 'ai_response_enc')).toBe(true)
    expect(hasColumn(db, 'ai_system_logs', 'prompt_text_enc')).toBe(true)
    expect(hasColumn(db, 'ai_system_logs', 'ai_response_enc')).toBe(true)
    expect(hasColumn(db, 'scheduler_config', 'retention_days')).toBe(true)
    expect(db.pragma('user_version', { simple: true })).toBe(13)

    // 幂等：二次调用 no-throw（全部 hasColumn 守卫命中跳过）
    expect(() => applyV13(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(13)
  })

  it('retention_days 列 DEFAULT 90 生效（D-04：只加列零消费，存量行为默认值）', () => {
    applyV13(handle!.db)
    // 向单行配置表插入 id=1（复刻 schedulerService 懒 INSERT 形态），未指定 retention_days → 取 DEFAULT
    handle!.db.prepare('INSERT INTO scheduler_config (id, enabled) VALUES (1, 0)').run()
    const row = handle!.db.prepare('SELECT retention_days FROM scheduler_config WHERE id = 1').get() as any
    expect(row.retention_days).toBe(90)
  })
})

// ---------------------------------------------------------------------------
// 组2 回填 + 读回一致（SC#1）
// ---------------------------------------------------------------------------

describe('组2 回填 + 读回逐字一致（SC#1 legacy fixture）', () => {
  it('v0.3.0 明文库回填：backfilled=行数 + 读回与原文逐字一致 + 旧列全 NULL + 二次回填 no-op', () => {
    const EXEC_PROMPT_1 = '分析 192.168.1.0/24 网段的 ARP 表：\n发现 3 台设备（含 "核心交换机" SW1）'
    const EXEC_RESP_1 = 'AI 分析：网段利用率 30%，\n建议关注 192.168.1.254 网关的 ARP 表项'
    const SYS_PROMPT_1 = '拓扑发现 Prompt（含换行\n与引号 "引号"）'
    const SYS_RESP_1 = 'AI 发现了 5 台设备并推断 4 条边'

    // 各表两行：正常文本行 + 空 prompt 行（ai_response 非空 → 行仍入回填集）
    const execId1 = insertLegacyExecRow({ promptText: EXEC_PROMPT_1, aiResponse: EXEC_RESP_1, createdAt: '2026-08-16 10:00:01' })
    const execId2 = insertLegacyExecRow({ promptText: '', aiResponse: '空 prompt 行的响应', createdAt: '2026-08-16 10:00:02' })
    const sysId1 = insertLegacySystemRow({ promptText: SYS_PROMPT_1, aiResponse: SYS_RESP_1, createdAt: '2026-08-16 10:00:01' })
    const sysId2 = insertLegacySystemRow({ promptText: null, aiResponse: '空 prompt 行的响应（NULL 态）', createdAt: '2026-08-16 10:00:02' })

    applyV13(handle!.db)

    expect(backfillAiExecLogEnc()).toEqual({ backfilled: 2 })
    expect(backfillSystemLogEnc()).toEqual({ backfilled: 2 })

    // SC#1 读回逐字一致（密文经解密投影 / 空 prompt 行回填后读回 ''）
    const execLogs = getLogs()
    expect(execLogs.find((l) => l.id === execId1)!.promptText).toBe(EXEC_PROMPT_1)
    expect(execLogs.find((l) => l.id === execId1)!.aiResponse).toBe(EXEC_RESP_1)
    expect(execLogs.find((l) => l.id === execId2)!.promptText).toBe('')
    expect(execLogs.find((l) => l.id === execId2)!.aiResponse).toBe('空 prompt 行的响应')

    const sysLogs = getSystemLogs()
    expect(sysLogs.find((l) => l.id === sysId1)!.promptText).toBe(SYS_PROMPT_1)
    expect(sysLogs.find((l) => l.id === sysId1)!.aiResponse).toBe(SYS_RESP_1)
    expect(sysLogs.find((l) => l.id === sysId2)!.promptText).toBe('')
    expect(sysLogs.find((l) => l.id === sysId2)!.aiResponse).toBe('空 prompt 行的响应（NULL 态）')

    // 密文落库 + 明文列全 NULL（净化终点）
    expect(execRow(execId1).prompt_text_enc).toMatch(/^v2:/)
    expect(execRow(execId1).prompt_text).toBeNull()
    expect(execRow(execId1).ai_response).toBeNull()
    expect(systemRow(sysId1).prompt_text_enc).toMatch(/^v2:/)
    expect(plaintextResidualCount('ai_exec_logs')).toBe(0)
    expect(plaintextResidualCount('ai_system_logs')).toBe(0)

    // 幂等：二次回填 no-op（全库明文列均 NULL → 0 行）
    expect(backfillAiExecLogEnc()).toEqual({ backfilled: 0 })
    expect(backfillSystemLogEnc()).toEqual({ backfilled: 0 })
  })
})

// ---------------------------------------------------------------------------
// 组3 字节净化（SC#4 / Pitfall 7：正控 A / freelist 残留 B / VACUUM 净化 C）
// ---------------------------------------------------------------------------

describe('组3 字节净化（SC#4：UPDATE 置 NULL ≠ 字节净化，VACUUM 才是净化终点）', () => {
  it('大载荷明文行回填置 NULL 后字节残留（B），VACUUM 后文件字节无明文（C）——正控 A 先行', () => {
    // 矩阵 #2 态构造（回填前 append 已写全量 _enc 但明文残留）：_enc 两列预置非空 →
    // 回填走「保留原 _enc 只清旧列」分支，UPDATE 为纯收缩（无新密文分配溢出页）——
    // 这是「置 NULL 后 freelist 字节残留」的确定性构造（Pitfall 7 实证复验条件）：
    // 若走加密替换分支，新密文（base64 膨胀 ~1.37x）会复用刚释放的溢出页，残留可能被覆盖。
    const id = insertLegacyExecRow({ promptText: bigMarkerPayload(), aiResponse: bigMarkerPayload(), createdAt: '2026-08-16 11:00:00' })
    applyV13(handle!.db)
    handle!.db
      .prepare('UPDATE ai_exec_logs SET prompt_text_enc = ?, ai_response_enc = ? WHERE id = ?')
      .run('v2:matrix2-kept-enc-prompt', 'v2:matrix2-kept-enc-response', id)

    // 断言 A（正控，T-17-12 假绿防线）：行还活着，marker 确实可检——若 A 不成立后续断言无意义
    expect(checkpointedDbBytes().includes(MARKER)).toBe(true)

    // 回填（不 VACUUM）：矩阵 #2 分支——保留 _enc 原值 + 明文置 NULL
    expect(backfillAiExecLogEnc()).toEqual({ backfilled: 1 })
    const row = execRow(id)
    expect(row.prompt_text_enc).toBe('v2:matrix2-kept-enc-prompt')
    expect(row.ai_response_enc).toBe('v2:matrix2-kept-enc-response')
    expect(row.prompt_text).toBeNull()
    expect(row.ai_response).toBeNull()

    // 断言 B（freelist 残留实证）：UPDATE 置 NULL 后溢出页字节残留——freelist 叶页内容不被清除
    expect(checkpointedDbBytes().includes(MARKER)).toBe(true)

    // 断言 C（SC#4 净化终点）：VACUUM 重建文件后字节级无明文
    handle!.db.exec('VACUUM')
    expect(checkpointedDbBytes().includes(MARKER)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 组4 新写路径 + append（SC#2 / SC#3 / P2 / 矩阵 #2 清旧列）
// ---------------------------------------------------------------------------

describe('组4 新写路径密文落库 + append 追加（SC#2/SC#3）', () => {
  it('createLog/createSystemLog 新代码永不留明文：_enc 落库 + 旧明文列无内容 + 读回一致', () => {
    applyV13(handle!.db)

    const execId = createLog({
      deviceId: 'dev-1',
      deviceName: '核心交换机 SW1',
      command: 'display version',
      status: 'executed',
      mode: 'confirm',
      aiReason: '17-03 新写路径测试',
      promptText: '第一次发送给 AI 的 Prompt 原文',
      aiResponse: '第一次 AI 分析结果',
    })
    let row = execRow(execId)
    expect(row.prompt_text_enc).toMatch(/^v2:/)
    expect(row.ai_response_enc).toMatch(/^v2:/)
    expect(row.prompt_text_enc).not.toContain('第一次发送给 AI 的 Prompt 原文')
    // ai_exec_logs 明文列是 v2 ALTER 所加（TEXT DEFAULT ''）——新代码 INSERT 不含该列，
    // legacy 库上 schema default 留 ''（非明文内容；新装库该列不存在）。断言取「无明文内容」语义。
    expect(row.prompt_text === null || row.prompt_text === '').toBe(true)
    expect(row.ai_response === null || row.ai_response === '').toBe(true)
    expect(getLogs().find((l) => l.id === execId)!.promptText).toBe('第一次发送给 AI 的 Prompt 原文')

    // legacy 库自愈语义：''（schema default）入回填集（'' IS NOT NULL）→ 下次启动回填归一为 NULL
    expect(backfillAiExecLogEnc()).toEqual({ backfilled: 1 })
    row = execRow(execId)
    expect(row.prompt_text).toBeNull()
    expect(row.prompt_text_enc).toMatch(/^v2:/) // _enc 非空 → 保留原值只清旧列
    expect(getLogs().find((l) => l.id === execId)!.promptText).toBe('第一次发送给 AI 的 Prompt 原文')

    // ai_system_logs 明文列无 DEFAULT → 新行严格 NULL
    const sysId = createSystemLog({
      type: 'discovery',
      status: 'success',
      promptText: '系统日志新写路径 Prompt',
      aiResponse: '系统日志新写路径响应',
    })
    const srow = systemRow(sysId)
    expect(srow.prompt_text_enc).toMatch(/^v2:/)
    expect(srow.prompt_text).toBeNull()
    expect(srow.ai_response).toBeNull()
    const sysLogs = getSystemLogs()
    expect(sysLogs.find((l) => l.id === sysId)!.promptText).toBe('系统日志新写路径 Prompt')
    expect(sysLogs.find((l) => l.id === sysId)!.aiResponse).toBe('系统日志新写路径响应')
  })

  it('appendLogAiResponse 追加完整（SC#3/P2）：分隔符 + 第一次原文 + 二次内容 + 同事务清旧列', () => {
    applyV13(handle!.db)
    const id = createLog({
      deviceId: 'dev-1',
      deviceName: 'SW1',
      command: 'display arp',
      status: 'executed',
      mode: 'confirm',
      aiReason: 'append 测试',
      promptText: '第一次 Prompt 原文',
      aiResponse: '第一次分析结果',
    })

    appendLogAiResponse(id, '第二次 Prompt 内容', '第二次 AI 分析内容')

    const log = getLogs().find((l) => l.id === id)!
    // P2 追加完整：prompt 含分隔符（字面量）+ 第一次原文 + 二次 prompt
    expect(log.promptText).toContain('========== 命令执行后的第二次 AI 调用 ==========')
    expect(log.promptText).toContain('第一次 Prompt 原文')
    expect(log.promptText).toContain('发送给 AI 的 Prompt:\n第二次 Prompt 内容')
    expect(log.aiResponse).toContain('第一次分析结果')
    expect(log.aiResponse).toContain('AI 分析结果:\n第二次 AI 分析内容')

    // 矩阵 #2 清旧列：append UPDATE 同事务显式置 NULL（压过 schema DEFAULT ''）
    const row = execRow(id)
    expect(row.prompt_text_enc).toMatch(/^v2:/)
    expect(row.prompt_text).toBeNull()
    expect(row.ai_response).toBeNull()
  })

  it('legacy 明文行 append（fallback 路径）：明文前缀 + 追加内容 + _enc 非空 + 明文列 NULL', () => {
    // 矩阵 #1 态（迁移后、回填前）直接 append——列存在性 fallback 读旧明文拼接
    const id = insertLegacyExecRow({ promptText: 'legacy 明文第一次 Prompt', aiResponse: 'legacy 明文第一次响应', createdAt: '2026-08-16 12:00:00' })
    applyV13(handle!.db)

    appendLogAiResponse(id, '回填前的二次 Prompt', '回填前的二次响应')

    const log = getLogs().find((l) => l.id === id)!
    expect(log.promptText.startsWith('legacy 明文第一次 Prompt')).toBe(true)
    expect(log.promptText).toContain('========== 命令执行后的第二次 AI 调用 ==========')
    expect(log.promptText).toContain('发送给 AI 的 Prompt:\n回填前的二次 Prompt')
    expect(log.aiResponse.startsWith('legacy 明文第一次响应')).toBe(true)
    expect(log.aiResponse).toContain('AI 分析结果:\n回填前的二次响应')

    const row = execRow(id)
    expect(row.prompt_text_enc).toMatch(/^v2:/)
    expect(row.prompt_text).toBeNull()
    expect(row.ai_response).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 组5 坏密文 + 混合期（D-03 / 状态矩阵 #5 + #1/#4 并存）
// ---------------------------------------------------------------------------

describe('组5 坏密文占位 + append 跳写保原文 + 混合期透明（D-03）', () => {
  it('坏密文读侧占位符（D-03 文案字面量断言，非 import 常量）', () => {
    const execId = insertLegacyExecRow({ promptText: '将被加密再破坏的 prompt', aiResponse: '将被加密再破坏的响应', createdAt: '2026-08-16 13:00:00' })
    const sysId = insertLegacySystemRow({ promptText: '系统日志坏密文 prompt', aiResponse: '系统日志坏密文响应', createdAt: '2026-08-16 13:00:00' })
    applyV13(handle!.db)
    expect(backfillAiExecLogEnc()).toEqual({ backfilled: 1 })
    expect(backfillSystemLogEnc()).toEqual({ backfilled: 1 })

    // 正常读回先行（好密文基线）
    expect(getLogs().find((l) => l.id === execId)!.promptText).toBe('将被加密再破坏的 prompt')

    // 换机/换账户致 masterKey 变更场景：SQL 直查置必抛垃圾值（GCM tag 校验必失败）
    handle!.db
      .prepare("UPDATE ai_exec_logs SET prompt_text_enc = 'v2:AAAA', ai_response_enc = 'v2:AAAA' WHERE id = ?")
      .run(execId)
    handle!.db
      .prepare("UPDATE ai_system_logs SET prompt_text_enc = 'v2:BBBB', ai_response_enc = 'v2:BBBB' WHERE id = ?")
      .run(sysId)

    // D-03：不崩溃、不乱码、不空白——占位符文案字面量钉死（文案 drift 即红，T-17-13）
    const execLog = getLogs().find((l) => l.id === execId)!
    expect(execLog.promptText).toBe('[内容无法解密（密钥不匹配）]')
    expect(execLog.aiResponse).toBe('[内容无法解密（密钥不匹配）]')
    const sysLog = getSystemLogs().find((l) => l.id === sysId)!
    expect(sysLog.promptText).toBe('[内容无法解密（密钥不匹配）]')
    expect(sysLog.aiResponse).toBe('[内容无法解密（密钥不匹配）]')
  })

  it('坏密文行 append：解密失败判别器跳写，_enc 原文逐字未被降级覆盖摧毁', () => {
    const id = insertLegacyExecRow({ promptText: '不可恢复的第一次原文', aiResponse: '不可恢复的第一次响应', createdAt: '2026-08-16 13:30:00' })
    applyV13(handle!.db)
    backfillAiExecLogEnc()

    handle!.db
      .prepare("UPDATE ai_exec_logs SET prompt_text_enc = 'v2:CORRUPT-PROMPT', ai_response_enc = 'v2:CORRUPT-RESP' WHERE id = ?")
      .run(id)
    const before = execRow(id)

    // decField 降级 '' 经「非空 _enc」判别器识别 → 跳写（no-throw；对降级 '' 拼接重加密会
    // 不可逆摧毁首次调用原文——17-02 Pattern 2 修订版行为）
    expect(() => appendLogAiResponse(id, '二次 Prompt', '二次响应')).not.toThrow()

    const after = execRow(id)
    expect(after.prompt_text_enc).toBe(before.prompt_text_enc)
    expect(after.ai_response_enc).toBe(before.ai_response_enc)
    expect(after.prompt_text).toBeNull()
    expect(after.ai_response).toBeNull()
  })

  it('混合期：明文行（矩阵 #1）+ 密文行（矩阵 #4）并存读回各自正常（fallback 对用户透明）', () => {
    // 行 A：先插 → 回填 → 密文态（矩阵 #4）
    const idA = insertLegacyExecRow({ promptText: '密文态行 A 的 prompt', aiResponse: '密文态行 A 的响应', createdAt: '2026-08-16 14:00:00' })
    applyV13(handle!.db)
    backfillAiExecLogEnc()
    // 行 B：回填后再直插明文行（矩阵 #1：明文 + _enc NULL——迁移后回填前/回填间歇态）
    const idB = insertLegacyExecRow({ promptText: '明文态行 B 的 prompt', aiResponse: '明文态行 B 的响应', createdAt: '2026-08-16 14:00:01' })

    const rowA = execRow(idA)
    expect(rowA.prompt_text_enc).toMatch(/^v2:/)
    expect(rowA.prompt_text).toBeNull()
    const rowB = execRow(idB)
    expect(rowB.prompt_text_enc).toBeNull()
    expect(rowB.prompt_text).toBe('明文态行 B 的 prompt')

    const logs = getLogs()
    expect(logs.find((l) => l.id === idA)!.promptText).toBe('密文态行 A 的 prompt')
    expect(logs.find((l) => l.id === idB)!.promptText).toBe('明文态行 B 的 prompt')
    expect(logs.find((l) => l.id === idB)!.aiResponse).toBe('明文态行 B 的响应')
  })
})
