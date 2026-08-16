// tests/electron/knowledgeBaseService.search.real.test.ts
//
// Phase 16 TEST-03 characterization 基线（16-02 第二段 Task 2）——kb 第 10 个导出函数 search
// 的确定性基线：vi.mock('../../electron/services/ai') 固定 getAiConfig/callAI 应答（IO 边界，
// D-01 范式），DB/目录走 makeRealDb 真库真 tmpdir（D-03/D-04）。
// 18-01（TXN-04）基线改写：search 契约改 KbSearchEnvelope 信封（rows + degraded/degradedReason/
// indexTotal/indexCapped），Q3/Q4 怪癖修复后断言同步改写（基线即守门）：
//   Q3 无界拼 prompt → L1 substr 80 摘要 + L2 MAX_INDEX_ENTRIES=200 截断（it 11/12/13）
//   Q4 三处 fallback 静默降级 → degradedReason 枚举入信封 + console.warn（it 1/5/6）
//
// 造数红线：uploadDocument 的 category 只允许合法枚举 'manual'|'api'|'template'|'notes'
// （init.ts:221 CHECK 约束），本套件一律用 'manual'。
//
// 虚拟索引顺序：ORDER BY d.title, c.chunk_index——种子文档按标题排序控索引位。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { makeRealDb } from './_helpers/realDb'
import type { RealDbHandle } from './_helpers/realDb'
import {
  uploadDocument,
  search,
  _setKbDbGetter,
  _setKbDirs,
} from '../../electron/services/knowledgeBaseService'
import { getDatabase } from '../../electron/database/connection'

// mock 范围仅 './ai'（IO 边界）：getAiConfig / callAI 固定应答，不触网（T-16-02-03 自造文本）
const { getAiConfigMock, callAIMock } = vi.hoisted(() => ({
  getAiConfigMock: vi.fn(),
  callAIMock: vi.fn(),
}))
vi.mock('../../electron/services/ai', () => ({
  getAiConfig: () => getAiConfigMock(),
  callAI: (...args: any[]) => callAIMock(...args),
}))

const AI_CONFIG = { apiKey: 'sk-test', baseUrl: 'http://x', modelName: 'm' }

let handle: RealDbHandle | null = null
let tmpParent = ''

// 建 kb 四对象（DDL 照 init.ts kb 块逐字抄，含三触发器（image_desc 恒 NULL，18-02 v14 方案 A）——UPDATE image_ids 依赖 kb_chunks_au）
function createKbTables(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER,
      category TEXT DEFAULT 'manual' CHECK(category IN ('manual','api','template','notes')),
      device_id TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','error')),
      error_message TEXT,
      chunk_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      image_ids TEXT,
      char_count INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(document_id);

    CREATE TABLE IF NOT EXISTS kb_images (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      chunk_id TEXT REFERENCES kb_chunks(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_kb_images_doc ON kb_images(document_id);
    CREATE INDEX IF NOT EXISTS idx_kb_images_chunk ON kb_images(chunk_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      title,
      content,
      image_desc,
      content='kb_chunks',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
        VALUES (new.rowid, new.title, new.content, NULL);
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
        VALUES ('delete', old.rowid, old.title, old.content, NULL);
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks
      WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids
    BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
        VALUES ('delete', old.rowid, old.title, old.content, NULL);
      INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
        VALUES (new.rowid, new.title, new.content, NULL);
    END;
  `)
}

// Q2 现状怪癖，Phase 18 裁决：setImmediate 异步处理无完成通知，轮询 DB status 兜底
async function waitForStatus(docId: string, expected: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    const row = handle!.db
      .prepare('SELECT status FROM kb_documents WHERE id = ?')
      .get(docId) as { status: string } | undefined
    if (row && row.status === expected) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForStatus timeout (${timeoutMs}ms): doc=${docId} expected=${expected} actual=${row ? row.status : 'missing'}`
      )
    }
    await new Promise((r) => setTimeout(r, 15))
  }
}

// txt 造数 helper（category 一律合法枚举 'manual'）
function uploadTxt(fileName: string, text: string, deviceId: string | null = null): any {
  const buf = Buffer.from(text, 'utf-8')
  return uploadDocument(buf, fileName, 'txt', buf.length, 'manual', deviceId)
}

async function seedReady(fileName: string, text: string, deviceId: string | null = null): Promise<any> {
  const doc = uploadTxt(fileName, text, deviceId)
  await waitForStatus(doc.id, 'ready')
  return doc
}

// 标准种子：文档A / 文档B 各 2 chunks。虚拟索引顺序（ORDER BY d.title, c.chunk_index）：
// [0]=A 第一章A1 [1]=A 第二章A2 [2]=B 第一章B1 [3]=B 第二章B2
const TEXT_A = '第一章 A1\nA1正文甲token\n第二章 A2\nA2正文甲token'
const TEXT_B = '第一章 B1\nB1正文乙token\n第二章 B2\nB2正文乙token'

async function seedAb(): Promise<{ docA: any; docB: any }> {
  const docA = await seedReady('文档A.txt', TEXT_A)
  const docB = await seedReady('文档B.txt', TEXT_B)
  return { docA, docB }
}

beforeEach(() => {
  vi.resetAllMocks()
  getAiConfigMock.mockReturnValue(AI_CONFIG)
  handle = makeRealDb()
  createKbTables(handle.db)
  _setKbDbGetter(() => handle!.db)
  tmpParent = path.join(os.tmpdir(), `nt-kbtest-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  _setKbDirs({ kb: () => tmpParent, img: () => tmpParent })
})

afterEach(() => {
  // 还原注入口为生产默认（防跨文件漂移），再关库 + 删 tmpdir（T-16-02-01 严格清理）
  _setKbDbGetter(getDatabase)
  _setKbDirs(null)
  if (handle) {
    handle.close()
    handle = null
  }
  try {
    fs.rmSync(tmpParent, { recursive: true, force: true })
  } catch {
    /* ENOENT 容错 */
  }
})

describe('kb search（真路径 realDb + vi.mock ai 固定应答）', () => {
  it('1. getAiConfig 返 null（无 apiKey）→ 降级信封 no_api_key + rows 前 topK chunks + document attach + images=[]', async () => {
    const { docA } = await seedAb()
    getAiConfigMock.mockReturnValue(null)

    // Q4 修复（18-01 TXN-04）：无 apiKey 降级不再静默——degradedReason='no_api_key' 入信封
    const top2 = await search('拓扑问题', undefined, 2)
    expect(top2.rows).toHaveLength(2)
    expect(top2.rows.map((c: any) => c.title)).toEqual(['第一章 A1', '第二章 A2'])
    expect(top2.rows[0].document).toEqual({ id: docA.id, title: '文档A', file_name: '文档A.txt' })
    expect(top2.rows[0].images).toEqual([])
    expect(top2.degraded).toBe(true)
    expect(top2.degradedReason).toBe('no_api_key')
    expect(top2.indexTotal).toBe(4)
    expect(top2.indexCapped).toBeNull()
    expect(callAIMock).not.toHaveBeenCalled()

    // 默认 topK=5 > 库内 4 chunks → 全量返回
    const all = await search('拓扑问题')
    expect(all.rows).toHaveLength(4)
    expect(all.rows.map((c: any) => c.title)).toEqual(['第一章 A1', '第二章 A2', '第一章 B1', '第二章 B2'])
    expect(all.degraded).toBe(true)
    expect(all.degradedReason).toBe('no_api_key')
  })

  it('2. callAI 返 none → rows=[] 且非降级（LLM 明确判定无相关章节）', async () => {
    await seedAb()
    callAIMock.mockResolvedValue('none')
    const result = await search('无关问题')
    expect(result.rows).toEqual([])
    expect(result.degraded).toBe(false)
    expect(result.degradedReason).toBeUndefined()
    expect(callAIMock).toHaveBeenCalledTimes(1)
  })

  it('3. callAI 返 0,2 → 按序返回选中 2 chunks + document attach', async () => {
    const { docA, docB } = await seedAb()
    callAIMock.mockResolvedValue('0,2')
    const result = await search('拓扑问题')
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].title).toBe('第一章 A1')
    expect(result.rows[0].content).toContain('A1正文甲token')
    expect(result.rows[0].document).toEqual({ id: docA.id, title: '文档A', file_name: '文档A.txt' })
    expect(result.rows[1].title).toBe('第一章 B1')
    expect(result.rows[1].content).toContain('B1正文乙token')
    expect(result.rows[1].document).toEqual({ id: docB.id, title: '文档B', file_name: '文档B.txt' })
  })

  it('4. callAI 返中文逗号 0，2 → split 正则 /[,，\\s]+/ 兼容', async () => {
    await seedAb()
    callAIMock.mockResolvedValue('0，2')
    const result = await search('拓扑问题')
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map((c: any) => c.title)).toEqual(['第一章 A1', '第一章 B1'])
  })

  it('5. callAI 返越界/非数字 99,abc,-1 → indices 过滤后空 → 降级信封 empty_pick + rows 前 topK', async () => {
    await seedAb()
    callAIMock.mockResolvedValue('99,abc,-1')
    // Q4 修复（18-01 TXN-04）：AI 应答无效索引降级不再静默——degradedReason='empty_pick'
    const result = await search('拓扑问题')
    expect(result.rows).toHaveLength(4)
    expect(result.rows.map((c: any) => c.title)).toEqual(['第一章 A1', '第二章 A2', '第一章 B1', '第二章 B2'])
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('empty_pick')
  })

  it('6. callAI reject → 降级信封 callai_error + rows 前 topK', async () => {
    await seedAb()
    callAIMock.mockRejectedValue(new Error('network down'))
    // Q4 修复（18-01 TXN-04）：LLM 异常降级不再静默吞掉——degradedReason='callai_error' + console.warn
    const result = await search('拓扑问题')
    expect(result.rows).toHaveLength(4)
    expect(result.rows.map((c: any) => c.document.title)).toEqual(['文档A', '文档A', '文档B', '文档B'])
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('callai_error')
  })

  it('7. deviceIds 过滤：device_id IN (...) OR device_id IS NULL 双分支', async () => {
    await seedReady('文档C.txt', '第一章 C1\nC1正文\n第二章 C2\nC2正文', 'dev-1')
    await seedReady('文档D.txt', '第一章 D1\nD1正文\n第二章 D2\nD2正文', null)
    await seedReady('文档E.txt', '第一章 E1\nE1正文\n第二章 E2\nE2正文', 'dev-2')

    // dev-1 视角：索引 = 文档C(dev-1) + 文档D(NULL)，无 文档E(dev-2)
    callAIMock.mockResolvedValue('0,2')
    const forDev1 = await search('问题', ['dev-1'])
    expect(forDev1.rows.map((c: any) => c.document.title)).toEqual(['文档C', '文档D'])

    // dev-2 视角：索引按 title 排序 = D0,D1,E0,E1 → '2,3' 选中 文档E 两 chunks
    callAIMock.mockResolvedValue('2,3')
    const forDev2 = await search('问题', ['dev-2'])
    expect(forDev2.rows.map((c: any) => c.document.title)).toEqual(['文档E', '文档E'])
  })

  it('8. 空库（无 ready chunks）→ rows=[] 空信封（indexTotal=0）', async () => {
    callAIMock.mockResolvedValue('0,1')
    const result = await search('任何问题')
    expect(result.rows).toEqual([])
    expect(result.degraded).toBe(false)
    expect(result.indexTotal).toBe(0)
    expect(result.indexCapped).toBeNull()
    // allChunks 空在 getAiConfig 检查前短路，不触 LLM
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('9. pending 文档 chunk 不入虚拟索引（status=ready 过滤）', async () => {
    await seedAb()
    // 同步 return 即 pending，紧接着同步段执行 search 的索引查询（先于 setImmediate 处理）→ 确定性排除
    const docP = uploadTxt('文档P.txt', '第一章 P1\nP1正文\n第二章 P2\nP2正文')
    callAIMock.mockResolvedValue('0,1,2,3')
    const result = await search('问题')
    expect(result.rows).toHaveLength(4)
    // 用两文档 chunk 计数差断言：返回只含 A/B 的 4 chunks，文档P 的 2 chunks 不在索引
    expect(result.rows.every((c: any) => c.document.title !== '文档P')).toBe(true)
    // 排干异步处理，防 setImmediate 在 afterEach 关库后才跑（catch 内 db.prepare 抛错成 unhandled）
    await waitForStatus(docP.id, 'ready')
    const total = (
      handle!.db.prepare('SELECT COUNT(*) AS c FROM kb_chunks').get() as any
    ).c
    expect(total).toBe(6) // A2 + B2 + P2 = 6（P ready 后库里 6 chunks，但上面 search 只见 4）
  })

  it('10. attachImages：image_ids IN 批查返回 / 畸形 JSON → images=[]', async () => {
    const docA = await seedReady('文档A.txt', TEXT_A)
    const chunks = handle!.db
      .prepare('SELECT id FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(docA.id) as any[]
    // 先 UPDATE image_ids 再插图片行（16-01 怪癖 #6 顺序红线：反序必抛 malformed）
    handle!.db
      .prepare('UPDATE kb_chunks SET image_ids = ? WHERE id = ?')
      .run(JSON.stringify(['img-x', 'img-y']), chunks[0].id)
    handle!.db
      .prepare('UPDATE kb_chunks SET image_ids = ? WHERE id = ?')
      .run('not-json', chunks[1].id)
    const insImg = handle!.db.prepare(
      'INSERT INTO kb_images (id, document_id, chunk_id, file_path, description) VALUES (?, ?, ?, ?, ?)'
    )
    insImg.run('img-x', docA.id, chunks[0].id, path.join(tmpParent, 'kb_images', 'img-x.png'), '描述X')
    insImg.run('img-y', docA.id, chunks[0].id, path.join(tmpParent, 'kb_images', 'img-y.png'), null)

    callAIMock.mockResolvedValue('0,1')
    const result = await search('问题')
    expect(result.rows[0].images.map((i: any) => i.id)).toEqual(['img-x', 'img-y'])
    expect(result.rows[0].images[0]).toEqual({
      id: 'img-x',
      file_path: path.join(tmpParent, 'kb_images', 'img-x.png'),
      description: '描述X',
    })
    // 畸形 image_ids JSON → try/catch fallback images=[]
    expect(result.rows[1].images).toEqual([])
  })

  it('11. callAI 入参断言：索引行含 80 字摘要（L1）+ 全部索引行可见（未截断）', async () => {
    await seedAb()
    callAIMock.mockResolvedValue('0')
    const result = await search('拓扑是什么')
    expect(result.rows).toHaveLength(1)

    expect(callAIMock).toHaveBeenCalledTimes(1)
    const [passedConfig, messages] = callAIMock.mock.calls[0]
    expect(passedConfig).toBe(AI_CONFIG)
    const prompt = messages[0].content
    expect(messages[0].role).toBe('user')
    expect(prompt).toContain('用户问题：拓扑是什么')
    expect(prompt).toContain('最多返回5个')
    // Q3 修复（18-01 L1）：索引行摘要来自 SQL substr(c.content,1,80)——短内容与旧 slice(0,80) 逐字一致
    expect(prompt).toContain('[0] 文档: 文档A | 章节: 第一章 A1 | 摘要: 第一章 A1 A1正文甲token')
    expect(prompt).toContain('[1] 文档: 文档A | 章节: 第二章 A2 | 摘要: 第二章 A2 A2正文甲token')
    expect(prompt).toContain('[2] 文档: 文档B | 章节: 第一章 B1 | 摘要: 第一章 B1 B1正文乙token')
    expect(prompt).toContain('[3] 文档: 文档B | 章节: 第二章 B2 | 摘要: 第二章 B2 B2正文乙token')
    // 4 chunks < 200 → 未截断，无标注行
    expect(result.indexTotal).toBe(4)
    expect(result.indexCapped).toBeNull()
    expect(prompt).not.toContain('（索引已从')
  })

  it('12. L2 截断：>200 chunks → indexCapped=200 + prompt 索引只含前 200 行 + 截断标注行', async () => {
    // 直接 SQL 造 205 ready chunks（单文档）——本 it 靶子是索引条数上限，非解析语义
    handle!.db.prepare(
      `INSERT INTO kb_documents (id, title, file_name, file_path, file_type, file_size, category, device_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready')`
    ).run('doc-big', '文档BIG', '文档BIG.txt', path.join(tmpParent, 'big.txt'), 'txt', 1, 'manual', null)
    const ins = handle!.db.prepare(
      'INSERT INTO kb_chunks (id, document_id, chunk_index, title, content, level, char_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (let i = 0; i < 205; i++) {
      ins.run(`chunk-${i}`, 'doc-big', i, `章节${i}`, `章节${i}正文token`, 1, 20)
    }

    callAIMock.mockResolvedValue('0')
    const result = await search('问题')
    expect(result.indexTotal).toBe(205)
    expect(result.indexCapped).toBe(200)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].title).toBe('章节0')

    const prompt = callAIMock.mock.calls[0][1][0].content
    // 截断可观测（T-18-03）：prompt 尾部标注 + 索引只含前 200 行（[200]-[204] 不可见）
    expect(prompt).toContain('（索引已从 205 条截取前 200 条）')
    expect(prompt).toContain('[0] 文档: 文档BIG | 章节: 章节0')
    expect(prompt).toContain('[199] 文档: 文档BIG | 章节: 章节199')
    expect(prompt).not.toContain('[200] 文档')
  })

  it('13. 正常 AI 选中路径：degraded=false + indexCapped=null + rows 含全文（非 80 字摘要版）', async () => {
    const longBody = '章节长文正文' + 'X'.repeat(100) + '尾部token'
    await seedReady('文档长.txt', `第一章 长文\n${longBody}\n第二章 短\n短正文`)
    callAIMock.mockResolvedValue('0')
    const result = await search('问题')
    expect(result.degraded).toBe(false)
    expect(result.degradedReason).toBeUndefined()
    expect(result.indexCapped).toBeNull()
    expect(result.indexTotal).toBe(2)
    expect(result.rows).toHaveLength(1)
    // L1 配套批查取全文：rows.content 含 80 字窗口外的尾部 token
    expect(result.rows[0].content).toContain('尾部token')
    // L1：prompt 索引行只含 substr 80 摘要，不含摘要窗口外的尾部 token
    const prompt = callAIMock.mock.calls[0][1][0].content
    expect(prompt).not.toContain('尾部token')
  })
})
