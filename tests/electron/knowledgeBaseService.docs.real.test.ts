// tests/electron/knowledgeBaseService.docs.real.test.ts
//
// Phase 16 TEST-03 characterization 基线（16-01 第一段）——断言 kb docs/chunk CRUD + txt 解析的
// 现状语义含怪癖（D-06）：发现怪癖仅在注释标记，怪癖清单在 16-02 落盘，行为裁决留 Phase 18 D 组。
// 经 makeRealDb 真库 + _setKbDbGetter/_setKbDirs 注入（D-03 真路径段 + D-04 tmpdir 真目录注入），
// DDL 照 electron/database/init.ts:214-284 逐字抄（kb_documents/kb_chunks/kb_images/kb_chunks_fts + 3 触发器，
// 不 import 生产 init.ts——getDatabase 单例牵连，12-01 OQ#1 方案 A 既定决策）。
//
// 造数红线：uploadDocument 的 category 只允许合法枚举 'manual'|'api'|'template'|'notes'
// （init.ts:221 CHECK 约束），本套件一律用 'manual'（个别 it 用 'api' 验 category 过滤）。
//
// 现状怪癖登记（均标「现状怪癖，Phase 18 裁决」）：
//   1. uploadDocument/reprocessDocument 经 setImmediate 异步处理，无完成通知——同步 return 必为 pending，
//      测试用 waitForStatus 轮询 DB status 兜底（T-16-01-03：5000ms 超时 throw 防挂死）。
//   2. splitByHeadingPatterns 前一章 level 取自「下一标题」层级 + 末章收尾 push level 恒 1；
//      headingPatterns[4]/[5]（1.1 → level 3 / 1.1.1 → level 4）不可达——pattern[3] `\s*`（零或多空白）
//      先命中任何 `1.1 xxx` / `1.1.1 xxx` → 实际一律 level 2。
//   3. '文档内容' fallback（kb:583-585）实际不可达——无标题纯文本落 title='未命名'。
//   4. kb 无加密列：kb_documents.title / kb_chunks.content 裸 SQL 直读即明文（D-08 落点，
//      kb:6 encField/decField dead import 零调用）。
//   5. kb_chunks_fts（FTS5 外部内容表，content='kb_chunks'）不可直读——SELECT/COUNT 任何列投影均报
//      `no such column: T.image_desc`（kb_chunks 无 image_desc 列），仅 MATCH + 裸 rowid 投影可查；
//      CJK unicode61 分词按整段连续汉字成单 token，MATCH 必须整词命中。
//   6. kb_chunks_au 触发器 delete 命令值不匹配 → `database disk image is malformed`：chunk 插入（ai 触发器
//      image_desc=NULL）后、先插入非空 description 的图片行再 UPDATE image_ids，delete 端 image_desc 子查询
//      变为非空与索引不符即抛（description='' 与 NULL 等价不抛——生产无 vision 配置 docx 路径因此幸存，
//      vision 描述非空则 processDocument 落 status='error'）。
//
// assert 直接 handle.db.prepare 查表行数与字段值（anomalyNewIp.real.test.ts 范式），禁主观词。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { makeRealDb } from './_helpers/realDb'
import type { RealDbHandle } from './_helpers/realDb'
import {
  uploadDocument,
  listDocuments,
  getDocument,
  updateChunk,
  deleteChunk,
  mergeChunks,
  splitChunk,
  deleteDocument,
  reprocessDocument,
  _setKbDbGetter,
  _setKbDirs,
} from '../../electron/services/knowledgeBaseService'
import { getDatabase } from '../../electron/database/connection'

// 集中持有本次测试的 db handle + tmpdir 父目录，afterEach 统一还原 + 清理
let handle: RealDbHandle | null = null
let tmpParent = ''

// 建 kb 四对象（DDL 照 init.ts:214-284 逐字抄，含 kb_chunks_au 触发器 END 收尾）。
// updateChunk 的 FTS sync 与 deleteDocument/deleteChunk 的 FTS 清理依赖三个触发器，缺了必挂。
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

// uploadDocument/reprocessDocument 经 setImmediate 异步处理无完成通知（现状怪癖，Phase 18 裁决），
// 轮询 kb_documents.status 兜底；T-16-01-03：5000ms 超时 throw 防挂死。
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

// txt 造数 helper（category 一律合法枚举，默认 'manual'）
function uploadTxt(fileName: string, text: string, deviceId: string | null = null, category = 'manual'): any {
  const buf = Buffer.from(text, 'utf-8')
  return uploadDocument(buf, fileName, 'txt', buf.length, category, deviceId)
}

function docChunks(docId: string): Array<{
  id: string; chunk_index: number; title: string; content: string; level: number; char_count: number
}> {
  return handle!.db
    .prepare('SELECT id, chunk_index, title, content, level, char_count FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(docId) as any[]
}

function count(sql: string, ...params: any[]): number {
  return (handle!.db.prepare(sql).get(...params) as any).c
}

// kb_chunks_fts 是 FTS5 外部内容表且 kb_chunks 无 image_desc 列——任何列投影直读均报
// `no such column: T.image_desc`（现状怪癖 #5，Phase 18 裁决），只能经 MATCH + 裸 rowid 投影断言索引态。
function ftsMatchRowids(term: string): number[] {
  return (
    handle!.db
      .prepare('SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?')
      .all(term) as any[]
  ).map((r) => r.rowid)
}

function ftsMatchCount(term: string): number {
  return (
    handle!.db
      .prepare('SELECT COUNT(*) AS c FROM (SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?)')
      .get(term) as any
  ).c
}

beforeEach(() => {
  handle = makeRealDb()
  createKbTables(handle.db)
  _setKbDbGetter(() => handle!.db)
  tmpParent = path.join(os.tmpdir(), `nt-kbtest-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  _setKbDirs({ kb: () => tmpParent, img: () => tmpParent })
})

afterEach(() => {
  // 还原注入口为生产默认（防跨文件漂移），再关库 + 删 tmpdir（T-16-01-01 严格清理）
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

describe('kb uploadDocument + txt 解析（真路径 realDb）', () => {
  it('1. uploadDocument 同步 return 时 status=pending + DB 行落库（title=文件名去扩展名）', async () => {
    const doc = uploadTxt('基础文档.txt', '第一章 概述\n概述正文')
    expect(doc.id).toBeTruthy()
    // 现状怪癖，Phase 18 裁决：setImmediate 异步处理无完成通知，同步 return 必为 pending
    expect(doc.status).toBe('pending')
    const row = handle!.db
      .prepare('SELECT status, chunk_count, title, file_type, category, device_id FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(row.status).toBe('pending')
    expect(row.chunk_count).toBe(0)
    expect(row.title).toBe('基础文档')
    expect(row.file_type).toBe('txt')
    expect(row.category).toBe('manual')
    expect(row.device_id).toBeNull()
    await waitForStatus(doc.id, 'ready')
  })

  it('2. Markdown #/## 切分（title 含标记行、content 首行为标题行、level 怪癖）', async () => {
    const doc = uploadTxt('md.txt', '# 一级标题\n一级正文\n## 二级标题\n二级正文')
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].title).toBe('# 一级标题')
    expect(chunks[0].content).toBe('# 一级标题\n一级正文')
    // 现状怪癖，Phase 18 裁决：前一章 level 取自「下一标题」的层级（# 一级标题 被 ## 命中时 push → level 2）
    expect(chunks[0].level).toBe(2)
    expect(chunks[1].title).toBe('## 二级标题')
    expect(chunks[1].content).toBe('## 二级标题\n二级正文')
    // 现状怪癖，Phase 18 裁决：末章收尾 push level 恒硬编码 1
    expect(chunks[1].level).toBe(1)
  })

  it('3. 第一章 pattern → level 1（单标题文档）', async () => {
    const doc = uploadTxt('zh.txt', '第一章 概述\n概述正文')
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].title).toBe('第一章 概述')
    expect(chunks[0].content).toBe('第一章 概述\n概述正文')
    expect(chunks[0].level).toBe(1)
  })

  it('4. 一、/1、 pattern → level 2', async () => {
    const doc = uploadTxt('cn.txt', '一、基础\n基础正文\n1、进阶\n进阶正文\n二、高级\n高级正文')
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks.map((c) => c.title)).toEqual(['一、基础', '1、进阶', '二、高级'])
    expect(chunks[0].level).toBe(2) // 「一、基础」在「1、进阶」命中时 push（level 2）
    expect(chunks[1].level).toBe(2) // 「1、进阶」在「二、高级」命中时 push（level 2）
    expect(chunks[2].level).toBe(1) // 末章收尾 push level 恒 1（现状怪癖，Phase 18 裁决）
  })

  it('5. 1.1/1.1.1 pattern 实际都命中 1、 分支 → level 2（pattern[4]/[5] level 3/4 不可达）', async () => {
    const docA = uploadTxt('num.txt', '1.1 安装\n安装正文\n1.2 配置\n配置正文')
    await waitForStatus(docA.id, 'ready')
    const chunksA = docChunks(docA.id)
    expect(chunksA.map((c) => c.title)).toEqual(['1.1 安装', '1.2 配置'])
    // 现状怪癖，Phase 18 裁决：pattern[3] `^(\d+)[、.．]\s*(.*)` 的 `\s*`（零或多空白）先命中任何
    // `1.1 xxx`（1 + . + 空串 + 余文），headingPatterns[4]/[5]（level 3/4）为不可达死代码 → 一律 level 2
    expect(chunksA[0].level).toBe(2)
    expect(chunksA[1].level).toBe(1)

    const docB = uploadTxt('num2.txt', '1.1 安装\n安装正文\n1.1.1 详细\n详细正文')
    await waitForStatus(docB.id, 'ready')
    const chunksB = docChunks(docB.id)
    expect(chunksB.map((c) => c.title)).toEqual(['1.1 安装', '1.1.1 详细'])
    expect(chunksB[0].level).toBe(2) // 同上：pattern[3] 先命中 → level 2（非 level 4）
    expect(chunksB[1].level).toBe(1)
  })

  it('6. 无标题纯文本 → 单 chapter title=未命名（文档内容 fallback 实际不可达）', async () => {
    const doc = uploadTxt('plain.txt', '纯文本第一行\n纯文本第二行')
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(1)
    // 现状怪癖，Phase 18 裁决：收尾 push 用 currentTitle || '未命名'，任何非空文本必先经收尾 push
    // （chapters.length≥1），kb:583-585 '文档内容' fallback 分支不可达
    expect(chunks[0].title).toBe('未命名')
    expect(chunks[0].content).toBe('纯文本第一行\n纯文本第二行')
    expect(chunks[0].level).toBe(1)
  })

  it('7. >2000 字章节按空行段落拆分（splitOversizedChapters，拆后每段 ≤2000）', async () => {
    const p1 = '甲'.repeat(900)
    const p2 = '乙'.repeat(900)
    const p3 = '丙'.repeat(900)
    const doc = uploadTxt('big.txt', `第一章 大章\n${p1}\n\n${p2}\n\n${p3}`)
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].title).toBe('第一章 大章')
    // heading 行与 p1 之间是单换行 → 同一段落；p1+p2 累计 1809 ≤2000，p3 触发 flush
    expect(chunks[0].content).toBe(`第一章 大章\n${p1}\n\n${p2}`)
    expect(chunks[0].content.length).toBeLessThanOrEqual(2000)
    expect(chunks[1].title).toBe('第一章 大章')
    expect(chunks[1].content).toBe(p3)
  })

  it('8. 单超长段落（无空行）不可再拆 → 保留单超长 chunk', async () => {
    const long = '长'.repeat(3000)
    const doc = uploadTxt('longpara.txt', `第一章 单段\n${long}`)
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(1)
    // 现状语义：subContent.length===0 时超限不 flush，单段 >2000 原样保留
    expect(chunks[0].content).toBe(`第一章 单段\n${long}`)
    expect(chunks[0].content.length).toBeGreaterThan(2000)
  })

  it('9. 源文件落盘 tmpParent/kb_files/<id>.txt 且内容一致（D-04 真目录真文件）', async () => {
    const text = '第一章 概述\n落盘正文'
    const doc = uploadTxt('ondisk.txt', text)
    const expectedPath = path.join(tmpParent, 'kb_files', `${doc.id}.txt`)
    expect(doc.file_path).toBe(expectedPath)
    expect(fs.existsSync(expectedPath)).toBe(true)
    expect(fs.readFileSync(expectedPath, 'utf-8')).toBe(text)
    await waitForStatus(doc.id, 'ready')
    expect(fs.existsSync(expectedPath)).toBe(true)
  })

  it('10. file_type=xlsx → 轮询 status=error 且 error_message 含 不支持的文件类型', async () => {
    const buf = Buffer.from('not-real-xlsx')
    const doc = uploadDocument(buf, '表格.xlsx', 'xlsx', buf.length, 'manual', null)
    await waitForStatus(doc.id, 'error')
    const row = handle!.db
      .prepare('SELECT status, error_message FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(row.status).toBe('error')
    expect(row.error_message).toContain('不支持的文件类型')
  })
})

describe('kb listDocuments（真路径 realDb）', () => {
  it('11. deviceId 过滤命中 device_id=? OR device_id IS NULL 两分支', async () => {
    const docA = uploadTxt('a.txt', '第一章 A\n内容', 'dev1')
    const docB = uploadTxt('b.txt', '第一章 B\n内容', 'dev2')
    const docC = uploadTxt('c.txt', '第一章 C\n内容', null)
    await waitForStatus(docA.id, 'ready')
    await waitForStatus(docB.id, 'ready')
    await waitForStatus(docC.id, 'ready')

    const rows = listDocuments('dev1') as any[]
    expect(rows.map((r) => r.id).sort()).toEqual([docA.id, docC.id].sort())

    const rowsB = listDocuments('dev2') as any[]
    expect(rowsB.map((r) => r.id).sort()).toEqual([docB.id, docC.id].sort())
  })

  it('12. category 过滤（api 命中 / manual 排除）', async () => {
    const docManual = uploadTxt('m.txt', '第一章 M\n内容', null, 'manual')
    const docApi = uploadTxt('p.txt', '第一章 P\n内容', null, 'api')
    await waitForStatus(docManual.id, 'ready')
    await waitForStatus(docApi.id, 'ready')

    const rows = listDocuments(null, 'api') as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(docApi.id)
    expect(rows[0].category).toBe('api')
  })

  it('13. 无过滤全量 + ORDER BY created_at DESC', async () => {
    const d1 = uploadTxt('o1.txt', '第一章 O1\n内容')
    const d2 = uploadTxt('o2.txt', '第一章 O2\n内容')
    const d3 = uploadTxt('o3.txt', '第一章 O3\n内容')
    await waitForStatus(d1.id, 'ready')
    await waitForStatus(d2.id, 'ready')
    await waitForStatus(d3.id, 'ready')
    // created_at 秒级精度同秒不可区分，手工 UPDATE 出确定性顺序
    handle!.db.prepare("UPDATE kb_documents SET created_at = '2026-01-03 00:00:00' WHERE id = ?").run(d1.id)
    handle!.db.prepare("UPDATE kb_documents SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(d2.id)
    handle!.db.prepare("UPDATE kb_documents SET created_at = '2026-01-02 00:00:00' WHERE id = ?").run(d3.id)

    const rows = listDocuments() as any[]
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.id)).toEqual([d1.id, d3.id, d2.id])
  })
})

describe('kb getDocument（真路径 realDb）', () => {
  it('14. chunks 按 chunk_index 排序 + image_ids JSON parse 后 IN 批查 attach images', async () => {
    const doc = uploadTxt('img.txt', '第一章 A\nA 正文\n第二章 B\nB 正文')
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(2)

    // txt 路径不产图，手工回填 image_ids 再落图片行（复刻 attach 读取形态）。
    // 现状怪癖 #6，Phase 18 裁决：必须先 UPDATE image_ids（此时 kb_images 无行，au 触发器 delete 端
    // image_desc 子查询与 ai 触发器插入端同为 NULL 才匹配）；若先插非空 description 图片行再 UPDATE
    // image_ids，会触发 `database disk image is malformed`（见文末 FTS 怪癖 describe it 31）。
    handle!.db.prepare('UPDATE kb_chunks SET image_ids = ? WHERE id = ?').run(JSON.stringify(['img-1', 'img-2']), chunks[0].id)
    handle!.db.prepare('UPDATE kb_chunks SET image_ids = ? WHERE id = ?').run(JSON.stringify(['img-3']), chunks[1].id)
    const insImg = handle!.db.prepare(
      'INSERT INTO kb_images (id, document_id, chunk_id, file_path, description) VALUES (?, ?, ?, ?, ?)'
    )
    insImg.run('img-1', doc.id, chunks[0].id, path.join(tmpParent, 'kb_images', 'img-1.png'), '图一描述')
    insImg.run('img-2', doc.id, chunks[0].id, path.join(tmpParent, 'kb_images', 'img-2.png'), '图二描述')
    insImg.run('img-3', doc.id, chunks[1].id, path.join(tmpParent, 'kb_images', 'img-3.png'), null)

    const got = getDocument(doc.id) as any
    expect(got.chunks.map((c: any) => c.title)).toEqual(['第一章 A', '第二章 B'])
    expect(got.chunks[0].images.map((i: any) => i.id)).toEqual(['img-1', 'img-2'])
    expect(got.chunks[0].images[0].description).toBe('图一描述')
    expect(got.chunks[1].images.map((i: any) => i.id)).toEqual(['img-3'])
  })

  it('15. image_ids 畸形 JSON → images=[]（T-sj1-02）', async () => {
    const doc = uploadTxt('bad.txt', '第一章 X\n正文')
    await waitForStatus(doc.id, 'ready')
    const chunk = docChunks(doc.id)[0]
    handle!.db.prepare("UPDATE kb_chunks SET image_ids = 'not-json' WHERE id = ?").run(chunk.id)

    const got = getDocument(doc.id) as any
    expect(got.chunks[0].images).toEqual([])
  })

  it('16. 不存在 docId → null', () => {
    expect(getDocument('no-such-doc')).toBeNull()
  })
})

describe('kb chunk CRUD（真路径 realDb）', () => {
  it('17. updateChunk 更新 title/content/char_count + kb_chunks_fts 对应 rowid 行同步', async () => {
    const doc = uploadTxt('upd.txt', '第一章 原章\noriginaltoken body')
    await waitForStatus(doc.id, 'ready')
    const chunk = docChunks(doc.id)[0]
    const rowid = (
      handle!.db.prepare('SELECT rowid AS r FROM kb_chunks WHERE id = ?').get(chunk.id) as any
    ).r
    // ai 触发器已把 INSERT 行写入 fts（MATCH 裸 rowid 投影是唯一可读通道，现状怪癖 #5）
    expect(ftsMatchRowids('originaltoken')).toEqual([rowid])

    updateChunk(chunk.id, '第一章 新章', 'newtoken body 更新正文')

    const after = handle!.db
      .prepare('SELECT title, content, char_count FROM kb_chunks WHERE id = ?')
      .get(chunk.id) as any
    expect(after.title).toBe('第一章 新章')
    expect(after.content).toBe('newtoken body 更新正文')
    expect(after.char_count).toBe('newtoken body 更新正文'.length)
    // au 触发器（kb:602-611 delete 旧值 + insert 新值）已同步：旧 token 清出索引、新 token 入索引
    expect(ftsMatchRowids('originaltoken')).toEqual([])
    expect(ftsMatchRowids('newtoken')).toEqual([rowid])
  })

  it('18. deleteChunk 后 reindex（剩余 chunk_index 从 0 重排）+ chunk_count 更新 + fts 清理', async () => {
    const doc = uploadTxt('del.txt', '一、A\nsharedtoken one\n二、B\nsharedtoken two\n三、C\nsharedtoken three')
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(3)
    expect(ftsMatchCount('sharedtoken')).toBe(3)

    deleteChunk(chunks[1].id)

    const after = docChunks(doc.id)
    expect(after.map((c) => c.title)).toEqual(['一、A', '三、C'])
    expect(after.map((c) => c.chunk_index)).toEqual([0, 1])
    const docRow = handle!.db
      .prepare('SELECT chunk_count FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(docRow.chunk_count).toBe(2)
    // ad 触发器联动清理：被删 chunk 的 token 出索引（'two' 原属 chunk[1]）
    expect(ftsMatchCount('sharedtoken')).toBe(2)
    expect(ftsMatchCount('two')).toBe(0)
  })

  it('19. deleteChunk 不存在 id → 静默 return（不 throw 不改动）', async () => {
    const doc = uploadTxt('del2.txt', '第一章 X\nx')
    await waitForStatus(doc.id, 'ready')
    expect(() => deleteChunk('no-such-chunk')).not.toThrow()
    expect(docChunks(doc.id)).toHaveLength(1)
  })

  it('20. mergeChunks 传 1 个 id → throw 至少需要2个章节才能合并', async () => {
    const doc = uploadTxt('mg.txt', '一、A\na\n二、B\nb')
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(() => mergeChunks([chunks[0].id], '合并')).toThrow('至少需要2个章节才能合并')
  })

  it('21. mergeChunks 正常合并：内容 ## title\\n\\ncontent join + minIndex 占位 + reindex', async () => {
    const doc = uploadTxt('mg2.txt', '一、A\n甲正文\n二、B\n乙正文')
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)

    const mergedId = mergeChunks([chunks[0].id, chunks[1].id], '合并章')

    const expected = `## ${chunks[0].title}\n\n${chunks[0].content}\n\n## ${chunks[1].title}\n\n${chunks[1].content}`
    const merged = handle!.db.prepare('SELECT * FROM kb_chunks WHERE id = ?').get(mergedId) as any
    expect(merged.title).toBe('合并章')
    expect(merged.content).toBe(expected)
    expect(merged.level).toBe(1)
    expect(merged.char_count).toBe(expected.length)
    expect(merged.chunk_index).toBe(0)
    expect(docChunks(doc.id).map((c) => c.id)).toEqual([mergedId])
    const docRow = handle!.db
      .prepare('SELECT chunk_count FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(docRow.chunk_count).toBe(1)
  })

  it('22. splitChunk splitPosition 越界 → throw 拆分位置无效', async () => {
    const doc = uploadTxt('sp.txt', '第一章 拆\n拆分正文内容')
    await waitForStatus(doc.id, 'ready')
    const chunk = docChunks(doc.id)[0]
    expect(() => splitChunk(chunk.id, 0, 'A', 'B')).toThrow('拆分位置无效')
    expect(() => splitChunk(chunk.id, chunk.content.length, 'A', 'B')).toThrow('拆分位置无效')
  })

  it('23. splitChunk chunk 不存在 → throw 章节不存在', () => {
    expect(() => splitChunk('no-such-chunk', 5, 'A', 'B')).toThrow('章节不存在')
  })

  it('24. splitChunk 正常拆分：两 chunk 内容 slice/trim + reindex + chunk_count', async () => {
    const doc = uploadTxt('sp2.txt', '一、原章\n前半正文后半正文')
    await waitForStatus(doc.id, 'ready')
    const chunk = docChunks(doc.id)[0]
    const sp = chunk.content.indexOf('后半')

    const [id1, id2] = splitChunk(chunk.id, sp, '前章', '后章')

    const after = docChunks(doc.id)
    expect(after).toHaveLength(2)
    expect(after[0].id).toBe(id1)
    expect(after[0].title).toBe('前章')
    expect(after[0].content).toBe(chunk.content.slice(0, sp).trim())
    expect(after[0].level).toBe(chunk.level)
    expect(after[0].char_count).toBe(chunk.content.slice(0, sp).trim().length)
    expect(after[1].id).toBe(id2)
    expect(after[1].title).toBe('后章')
    expect(after[1].content).toBe(chunk.content.slice(sp).trim())
    expect(after.map((c) => c.chunk_index)).toEqual([0, 1])
    const docRow = handle!.db
      .prepare('SELECT chunk_count FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(docRow.chunk_count).toBe(2)
  })
})

describe('kb deleteDocument / reprocessDocument（真路径 realDb）', () => {
  it('25. deleteDocument：kbDir 源文件 unlink + 三表清理 + fts 触发器联动清理', async () => {
    const doc = uploadTxt('dd.txt', '第一章 删\nsharedtoken 删除正文')
    await waitForStatus(doc.id, 'ready')
    expect(fs.existsSync(doc.file_path)).toBe(true)
    expect(ftsMatchCount('sharedtoken')).toBe(1)

    deleteDocument(doc.id)

    expect(fs.existsSync(doc.file_path)).toBe(false)
    expect(count('SELECT COUNT(*) AS c FROM kb_documents WHERE id = ?', doc.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM kb_chunks WHERE document_id = ?', doc.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM kb_images WHERE document_id = ?', doc.id)).toBe(0)
    // ad 触发器联动清理 fts（MATCH 是唯一可读通道，现状怪癖 #5）
    expect(ftsMatchCount('sharedtoken')).toBe(0)
  })

  it('26. deleteDocument 不存在 id → throw 文档不存在', () => {
    expect(() => deleteDocument('no-such-doc')).toThrow('文档不存在')
  })

  it('27. reprocessDocument：旧 chunks 清空 + 同步 return status=pending → 轮询 ready 重切分', async () => {
    const doc = uploadTxt('rp.txt', '一、A\na\n二、B\nb')
    await waitForStatus(doc.id, 'ready')
    expect(docChunks(doc.id)).toHaveLength(2)

    const returned = reprocessDocument(doc.id) as any
    // 现状怪癖，Phase 18 裁决：同步 return 时 chunks 已清空、status 回 pending（setImmediate 异步重处理无完成通知）
    expect(returned.status).toBe('pending')
    expect(docChunks(doc.id)).toHaveLength(0)
    const row = handle!.db
      .prepare('SELECT status, error_message FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(row.status).toBe('pending')
    expect(row.error_message).toBeNull()

    await waitForStatus(doc.id, 'ready')
    expect(docChunks(doc.id).map((c) => c.title)).toEqual(['一、A', '二、B'])
  })

  it('28. reprocessDocument 不存在 id → throw 文档不存在', () => {
    expect(() => reprocessDocument('no-such-doc')).toThrow('文档不存在')
  })
})

describe('kb 加密现状怪癖（D-08 落点）', () => {
  it('29. kb_documents.title 与 kb_chunks.content 裸 SQL 直读即明文（kb 无加密列）', async () => {
    const doc = uploadTxt('enc.txt', '第一章 明文\n明文正文')
    await waitForStatus(doc.id, 'ready')

    // 现状怪癖，Phase 18 裁决：kb 无加密列——kb:6 encField/decField dead import 零调用，
    // title/content 裸 SQL 直读即明文（S-M1/Phase 18 D 组加密列迁移后才可能有加密断言靶子）
    const titleRow = handle!.db
      .prepare('SELECT title FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(titleRow.title).toBe('enc')
    const chunkRow = handle!.db
      .prepare('SELECT content FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 1')
      .get(doc.id) as any
    expect(chunkRow.content).toBe('第一章 明文\n明文正文')
  })
})

describe('kb FTS 现状怪癖（外部内容表，Phase 18 裁决）', () => {
  it('30. kb_chunks_fts 不可直读：SELECT 任何列投影报 no such column: T.image_desc，MATCH 裸 rowid 可查', async () => {
    const doc = uploadTxt('fts.txt', '第一章 索引\nindextoken 中文正文全文')
    await waitForStatus(doc.id, 'ready')
    // 现状怪癖 #5，Phase 18 裁决：外部内容表（content='kb_chunks'）声明的 image_desc 列在 kb_chunks
    // 不存在，任何列投影直读（SELECT title / COUNT(*)）均抛 no such column: T.image_desc
    expect(() =>
      handle!.db.prepare('SELECT title FROM kb_chunks_fts WHERE rowid = 1').all()
    ).toThrow(/no such column: T\.image_desc/)
    expect(() =>
      handle!.db.prepare('SELECT COUNT(*) AS c FROM kb_chunks_fts').get()
    ).toThrow(/no such column: T\.image_desc/)
    // MATCH + 裸 rowid 投影是唯一可读通道；CJK unicode61 整段连续汉字成单 token，须整词命中
    const rowid = (
      handle!.db.prepare('SELECT rowid AS r FROM kb_chunks LIMIT 1').get() as any
    ).r
    expect(ftsMatchRowids('indextoken')).toEqual([rowid])
    expect(ftsMatchRowids('中文正文全文')).toEqual([rowid])
    expect(ftsMatchRowids('中文')).toEqual([]) // 连续汉字段成单 token，'中文' 子串不命中
  })

  it('31. docx 形态顺序（先插非空 description 图片行再 UPDATE image_ids）→ database disk image is malformed', async () => {
    const doc = uploadTxt('mal.txt', '第一章 图\nmalformedtoken 正文')
    await waitForStatus(doc.id, 'ready')
    const chunk = docChunks(doc.id)[0]
    // 现状怪癖 #6，Phase 18 裁决：ai 触发器插入时 image_desc=NULL；插入非空 description 的图片行后
    // UPDATE image_ids 触发 kb_chunks_au，delete 端 image_desc 子查询已变非空与索引不符 → FTS5 抛
    // database disk image is malformed（description='' 与 NULL 等价不抛——生产无 vision 配置时
    // docx 路径 description='' 幸存；vision 描述非空则 processDocument 落 status='error'）
    handle!.db
      .prepare('INSERT INTO kb_images (id, document_id, chunk_id, file_path, description) VALUES (?, ?, ?, ?, ?)')
      .run('img-bad', doc.id, chunk.id, path.join(tmpParent, 'kb_images', 'img-bad.png'), '非空描述')
    expect(() =>
      handle!.db.prepare('UPDATE kb_chunks SET image_ids = ? WHERE id = ?').run('["img-bad"]', chunk.id)
    ).toThrow(/database disk image is malformed/)
  })
})
