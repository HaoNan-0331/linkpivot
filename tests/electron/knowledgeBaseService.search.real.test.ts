// tests/electron/knowledgeBaseService.search.real.test.ts
//
// Phase 16 TEST-03 characterization 基线（16-02 第二段 Task 2）——kb 第 10 个导出函数 search
// 的确定性基线：vi.mock('../../electron/services/ai') 固定 getAiConfig/callAI 应答（IO 边界，
// D-01 范式），DB/目录走 makeRealDb 真库真 tmpdir（D-03/D-04），现状语义含怪癖照录（D-06）：
//   Q3 search 无界拼 prompt——全部 ready chunks 索引进 LLM 上下文（TXN-04 三层收敛靶子）
//   Q4 search 三处 fallback 静默降级，无 degraded 可观测标注（TXN-04 靶子）
// 怪癖清单汇总落盘 16-QUIRKS.md，行为裁决留 Phase 18 D 组。
//
// 造数红线：uploadDocument 的 category 只允许合法枚举 'manual'|'api'|'template'|'notes'
// （init.ts:221 CHECK 约束），本套件一律用 'manual'。
//
// 虚拟索引顺序：ORDER BY d.title, c.chunk_index（kb:668）——种子文档按标题排序控索引位。

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

// 建 kb 四对象（DDL 照 init.ts:214-284 逐字抄，含三触发器——UPDATE image_ids 依赖 kb_chunks_au）
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
        VALUES (new.rowid, new.title, new.content,
          (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = new.id));
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
        VALUES ('delete', old.rowid, old.title, old.content,
          (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = old.id));
    END;

    CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks
      WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.image_ids IS NOT NEW.image_ids
    BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title, content, image_desc)
        VALUES ('delete', old.rowid, old.title, old.content,
          (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = old.id));
      INSERT INTO kb_chunks_fts(rowid, title, content, image_desc)
        VALUES (new.rowid, new.title, new.content,
          (SELECT GROUP_CONCAT(description, ' ') FROM kb_images WHERE chunk_id = new.id));
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
  it('1. getAiConfig 返 null（无 apiKey）→ fallback 返回前 topK chunks + document attach + images=[]', async () => {
    const { docA } = await seedAb()
    getAiConfigMock.mockReturnValue(null)

    // 现状怪癖 Q4，Phase 18 裁决：fallback 静默降级无 degraded 标注（TXN-04 靶子）——
    // 返回形态与 AI 选中路径完全一致，调用方无从感知本次没走 LLM
    const top2 = await search('拓扑问题', undefined, 2)
    expect(top2).toHaveLength(2)
    expect(top2.map((c: any) => c.title)).toEqual(['第一章 A1', '第二章 A2'])
    expect(top2[0].document).toEqual({ id: docA.id, title: '文档A', file_name: '文档A.txt' })
    expect(top2[0].images).toEqual([])
    expect(callAIMock).not.toHaveBeenCalled()

    // 默认 topK=5 > 库内 4 chunks → 全量返回
    const all = await search('拓扑问题')
    expect(all).toHaveLength(4)
    expect(all.map((c: any) => c.title)).toEqual(['第一章 A1', '第二章 A2', '第一章 B1', '第二章 B2'])
  })

  it('2. callAI 返 none → 返回 []（kb:702）', async () => {
    await seedAb()
    callAIMock.mockResolvedValue('none')
    const result = await search('无关问题')
    expect(result).toEqual([])
    expect(callAIMock).toHaveBeenCalledTimes(1)
  })

  it('3. callAI 返 0,2 → 按序返回选中 2 chunks + document attach（kb:715-720）', async () => {
    const { docA, docB } = await seedAb()
    callAIMock.mockResolvedValue('0,2')
    const result = await search('拓扑问题')
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('第一章 A1')
    expect(result[0].content).toContain('A1正文甲token')
    expect(result[0].document).toEqual({ id: docA.id, title: '文档A', file_name: '文档A.txt' })
    expect(result[1].title).toBe('第一章 B1')
    expect(result[1].content).toContain('B1正文乙token')
    expect(result[1].document).toEqual({ id: docB.id, title: '文档B', file_name: '文档B.txt' })
  })

  it('4. callAI 返中文逗号 0，2 → split 正则 /[,，\\s]+/ 兼容（kb:704）', async () => {
    await seedAb()
    callAIMock.mockResolvedValue('0，2')
    const result = await search('拓扑问题')
    expect(result).toHaveLength(2)
    expect(result.map((c: any) => c.title)).toEqual(['第一章 A1', '第一章 B1'])
  })

  it('5. callAI 返越界/非数字 99,abc,-1 → indices 过滤后空 → fallback 前 topK（kb:706-711）', async () => {
    await seedAb()
    callAIMock.mockResolvedValue('99,abc,-1')
    // 现状怪癖 Q4，Phase 18 裁决：AI 应答无效时静默 fallback 全量前 topK，无 degraded 标注
    const result = await search('拓扑问题')
    expect(result).toHaveLength(4)
    expect(result.map((c: any) => c.title)).toEqual(['第一章 A1', '第二章 A2', '第一章 B1', '第二章 B2'])
  })

  it('6. callAI reject → catch fallback 前 topK（kb:721-726）', async () => {
    await seedAb()
    callAIMock.mockRejectedValue(new Error('network down'))
    // 现状怪癖 Q4，Phase 18 裁决：LLM 异常静默吞掉（catch 无日志无标注），降级返回前 topK
    const result = await search('拓扑问题')
    expect(result).toHaveLength(4)
    expect(result.map((c: any) => c.document.title)).toEqual(['文档A', '文档A', '文档B', '文档B'])
  })

  it('7. deviceIds 过滤：device_id IN (...) OR device_id IS NULL 双分支（kb:663-667）', async () => {
    await seedReady('文档C.txt', '第一章 C1\nC1正文\n第二章 C2\nC2正文', 'dev-1')
    await seedReady('文档D.txt', '第一章 D1\nD1正文\n第二章 D2\nD2正文', null)
    await seedReady('文档E.txt', '第一章 E1\nE1正文\n第二章 E2\nE2正文', 'dev-2')

    // dev-1 视角：索引 = 文档C(dev-1) + 文档D(NULL)，无 文档E(dev-2)
    callAIMock.mockResolvedValue('0,2')
    const forDev1 = await search('问题', ['dev-1'])
    expect(forDev1.map((c: any) => c.document.title)).toEqual(['文档C', '文档D'])

    // dev-2 视角：索引按 title 排序 = D0,D1,E0,E1 → '2,3' 选中 文档E 两 chunks
    callAIMock.mockResolvedValue('2,3')
    const forDev2 = await search('问题', ['dev-2'])
    expect(forDev2.map((c: any) => c.document.title)).toEqual(['文档E', '文档E'])
  })

  it('8. 空库（无 ready chunks）→ 返回 []（kb:671）', async () => {
    callAIMock.mockResolvedValue('0,1')
    const result = await search('任何问题')
    expect(result).toEqual([])
    // allChunks 空在 getAiConfig 检查前短路，不触 LLM
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('9. pending 文档 chunk 不入虚拟索引（status=ready 过滤 kb:661）', async () => {
    await seedAb()
    // 同步 return 即 pending，紧接着同步段执行 search 的索引查询（先于 setImmediate 处理）→ 确定性排除
    const docP = uploadTxt('文档P.txt', '第一章 P1\nP1正文\n第二章 P2\nP2正文')
    callAIMock.mockResolvedValue('0,1,2,3')
    const result = await search('问题')
    expect(result).toHaveLength(4)
    // 用两文档 chunk 计数差断言：返回只含 A/B 的 4 chunks，文档P 的 2 chunks 不在索引
    expect(result.every((c: any) => c.document.title !== '文档P')).toBe(true)
    // 排干异步处理，防 setImmediate 在 afterEach 关库后才跑（catch 内 db.prepare 抛错成 unhandled）
    await waitForStatus(docP.id, 'ready')
    const total = (
      handle!.db.prepare('SELECT COUNT(*) AS c FROM kb_chunks').get() as any
    ).c
    expect(total).toBe(6) // A2 + B2 + P2 = 6（P ready 后库里 6 chunks，但上面 search 只见 4）
  })

  it('10. attachImages：image_ids IN 批查返回 / 畸形 JSON → images=[]（kb:640-652）', async () => {
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
    expect(result[0].images.map((i: any) => i.id)).toEqual(['img-x', 'img-y'])
    expect(result[0].images[0]).toEqual({
      id: 'img-x',
      file_path: path.join(tmpParent, 'kb_images', 'img-x.png'),
      description: '描述X',
    })
    // 畸形 image_ids JSON → try/catch fallback images=[]
    expect(result[1].images).toEqual([])
  })

  it('11. callAI 入参断言：pickPrompt 含 indexLines 拼接的全部 chunk 索引行（无界拼 prompt）', async () => {
    await seedAb()
    callAIMock.mockResolvedValue('0')
    const result = await search('拓扑是什么')
    expect(result).toHaveLength(1)

    expect(callAIMock).toHaveBeenCalledTimes(1)
    const [passedConfig, messages] = callAIMock.mock.calls[0]
    expect(passedConfig).toBe(AI_CONFIG)
    const prompt = messages[0].content
    expect(messages[0].role).toBe('user')
    expect(prompt).toContain('用户问题：拓扑是什么')
    expect(prompt).toContain('最多返回5个')
    // 现状怪癖 Q3，Phase 18 裁决：无界拼 prompt——全部 ready chunks 索引进 LLM 上下文
    //（TXN-04 三层收敛靶子：库增长 = prompt 无限膨胀，无截断无分页）
    expect(prompt).toContain('[0] 文档: 文档A | 章节: 第一章 A1 | 摘要: 第一章 A1 A1正文甲token')
    expect(prompt).toContain('[1] 文档: 文档A | 章节: 第二章 A2 | 摘要: 第二章 A2 A2正文甲token')
    expect(prompt).toContain('[2] 文档: 文档B | 章节: 第一章 B1 | 摘要: 第一章 B1 B1正文乙token')
    expect(prompt).toContain('[3] 文档: 文档B | 章节: 第二章 B2 | 摘要: 第二章 B2 B2正文乙token')
  })
})
