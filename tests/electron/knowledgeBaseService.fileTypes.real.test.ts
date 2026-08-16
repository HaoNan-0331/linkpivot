// tests/electron/knowledgeBaseService.fileTypes.real.test.ts
//
// Phase 16 TEST-03 characterization 基线（16-02 第二段 Task 1）——PDF/DOCX 重库解析路径
// 经真 pdfjs-dist / mammoth + 最小合法二进制 fixture 入基线（D-02 红线：两解析库禁 mock）。
// setup/teardown 照 16-01 docs 套件骨架（makeRealDb 真库 + DDL 照 init.ts:214-284 逐字抄 +
// _setKbDbGetter/_setKbDirs tmpdir 注入 + afterEach 还原清理），fixture 内联本文件顶部
// （TESTING.md「无 fixtures 目录约定，内联测试文件顶部」）。
//
// vi.mock 范围仅 '../../electron/services/ai'（IO 边界）：getAiConfig 返 null →
// getVisionConfig 返 null → describeImage 不调用、description 落 ''（确定性，不触真 fetch）；
// callAI 不会被本套件触达。pdfjs-dist/mammoth/jszip 全走真库（T-16-02-02）。
//
// 造数红线：uploadDocument 的 category 只允许合法枚举 'manual'|'api'|'template'|'notes'
// （init.ts:221 CHECK 约束），本套件一律用 'manual'。
//
// 现状怪癖（详见 16-QUIRKS.md）：
//   Q2 uploadDocument setImmediate 异步处理无完成通知——同步 return 必为 pending，轮询 DB 兜底。
//   Q6 docx 图片落 chunk 的「双轨」逻辑：parseDocxWithImagesAsync 里 images[].chunkIndex 按
//      Math.min(i, chapters.length-1) 分配（kb:487-489），但 processDocument 实际定位用的是
//      [图片N] 标记扫描（kb:402-410）——chunkIndex 字段对真实落位零影响，现状怪癖 Phase 18 裁决。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { makeRealDb } from './_helpers/realDb'
import type { RealDbHandle } from './_helpers/realDb'
import {
  uploadDocument,
  _setKbDbGetter,
  _setKbDirs,
} from '../../electron/services/knowledgeBaseService'
import { getDatabase } from '../../electron/database/connection'

// 仅 mock IO 边界 './ai'（D-02：pdfjs-dist/mammoth 禁 mock）
const { getAiConfigMock, callAIMock } = vi.hoisted(() => ({
  getAiConfigMock: vi.fn(),
  callAIMock: vi.fn(),
}))
vi.mock('../../electron/services/ai', () => ({
  getAiConfig: () => getAiConfigMock(),
  callAI: (...args: any[]) => callAIMock(...args),
}))

let handle: RealDbHandle | null = null
let tmpParent = ''

// 建 kb 四对象（DDL 照 init.ts kb 块逐字抄，含三触发器（image_desc 恒 NULL，18-02 v14 方案 A）——
// docx 图片路径依赖 kb_chunks_au 与 kb_chunks_ai 的 FTS 联动，缺了必挂）。
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

// Q2 现状怪癖，Phase 18 裁决：setImmediate 异步处理无完成通知，轮询 DB status 兜底。
// pdfjs-dist/mammoth 首次动态加载 + 解析较慢，超时给 12000ms。
async function waitForStatus(docId: string, expected: string, timeoutMs = 12000): Promise<void> {
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
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ---------- PDF fixture：手搓最小合法 PDF（内联构造，无 fixtures 目录约定） ----------
//
// 结构：%PDF-1.4 header + catalog + pages + 每页 page/content stream + 共享 Type1 字体
// + xref 表 + trailer。CJK 字符经字体 /Encoding /Differences 的 /uniXXXX 字形名映射到
// 128+ 自定义码位（pdf.js 按 Adobe uniXXXX 约定解析回 Unicode），ASCII 字符原码透传。
// pdfjs 按页提取文本：每页 items 以 ' ' join + 页尾补 '\n'（kb:442）——多行文本须拆多页。
function buildPdf(pageTexts: string[]): Buffer {
  const charCodes = new Map<string, number>()
  let nextCode = 128
  const encodePdfString = (s: string): string => {
    let out = ''
    for (const ch of s) {
      if (ch === '(' || ch === ')' || ch === '\\') {
        out += '\\' + ch
      } else if (ch.charCodeAt(0) < 128) {
        out += ch
      } else {
        let code = charCodes.get(ch)
        if (code === undefined) {
          code = nextCode
          nextCode += 1
          charCodes.set(ch, code)
        }
        out += String.fromCharCode(code)
      }
    }
    return out
  }
  const encoded = pageTexts.map(encodePdfString)
  const diffNames = [...charCodes.keys()]
    .map((ch) => `/uni${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ')
  const encoding = charCodes.size
    ? `/Encoding << /Type /Encoding /Differences [ 128 ${diffNames} ] >>`
    : '/Encoding /WinAnsiEncoding'

  const nPages = pageTexts.length
  const fontObjNum = 3 + 2 * nPages
  const objects: string[] = []
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = Array.from({ length: nPages }, (_, i) => `${3 + 2 * i} 0 R`).join(' ')
  objects.push(`<< /Type /Pages /Kids [ ${kids} ] /Count ${nPages} >>`)
  for (let i = 0; i < nPages; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${4 + 2 * i} 0 R >>`
    )
    const stream = `BT /F1 12 Tf 50 700 Td (${encoded[i]}) Tj ET`
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${encoding} >>`)

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, idx) => {
    offsets.push(pdf.length)
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = pdf.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += xref
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// ---------- DOCX fixture：require('jszip') 现场构造最小 docx（mammoth 依赖 npm hoist 可 resolve） ----------
//
// 容器：[Content_Types].xml + _rels/.rels + word/document.xml + word/styles.xml
//（styles.xml 必带——mammoth 经 pStyle id → styles.xml 的 w:name 解析出 'heading N' 才走默认
// p[style-name='Heading N'] => hN 映射）；图片场景再加 word/_rels/document.xml.rels +
// word/media/image1.png（1x1 PNG 内联 base64 常量）。
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface DocxPara {
  style?: 'Heading1' | 'Heading2'
  text?: string
  imageRid?: string
}

async function buildDocx(paras: DocxPara[], withImage = false): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const JSZip = require('jszip')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>${
      withImage ? '\n<Default Extension="png" ContentType="image/png"/>' : ''
    }
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`
  )
  const drawingXml = (rid: string) =>
    `<w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  const bodyXml = paras
    .map((p) => {
      const pPr = p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : ''
      const run = p.imageRid
        ? drawingXml(p.imageRid)
        : `<w:r><w:t xml:space="preserve">${p.text ?? ''}</w:t></w:r>`
      return `<w:p>${pPr}${run}</w:p>`
    })
    .join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${bodyXml}</w:body></w:document>`
  )
  if (withImage) {
    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`
    )
    zip.file('word/media/image1.png', Buffer.from(PNG_1X1_BASE64, 'base64'), { binary: true })
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

// category 一律合法枚举 'manual'（init.ts:221 CHECK 约束红线）
async function uploadDocx(fileName: string, paras: DocxPara[], withImage = false): Promise<any> {
  const buf = await buildDocx(paras, withImage)
  return uploadDocument(buf, fileName, 'docx', buf.length, 'manual', null)
}

function uploadPdf(fileName: string, pageTexts: string[]): any {
  const buf = buildPdf(pageTexts)
  return uploadDocument(buf, fileName, 'pdf', buf.length, 'manual', null)
}

function docChunks(docId: string): Array<{
  id: string; chunk_index: number; title: string; content: string; level: number; image_ids: string | null
}> {
  return handle!.db
    .prepare('SELECT id, chunk_index, title, content, level, image_ids FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(docId) as any[]
}

beforeEach(() => {
  vi.resetAllMocks()
  // getVisionConfig → null：describeImage 不调用、description 落 ''（确定性，不触真 fetch）
  getAiConfigMock.mockReturnValue(null)
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

describe('kb PDF 解析（真 pdfjs-dist，D-02 真库红线）', () => {
  it('1. pdf 有文本：三页文本（章标题/正文/小节）→ ready + 2 chunks，title/content 含 第一章/1.1', async () => {
    // pdfjs 每页文本以 '\n' 收尾（kb:442）→ 三页 = 三行，splitByHeadingPatterns 切章节：
    // 行1 第一章 命中 pattern[1]，行2 正文（hasContent），行3 1.1 命中 pattern[3]（16-01 怪癖：1.1 一律 level 2）
    const doc = uploadPdf('网络拓扑.pdf', ['第一章 拓扑基础', '拓扑结构正文说明', '1.1 概述要点'])
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].title).toBe('第一章 拓扑基础')
    expect(chunks[0].content).toBe('第一章 拓扑基础\n拓扑结构正文说明')
    expect(chunks[0].level).toBe(2) // 前一章 level 取自下一标题层级（1.1 → pattern[3] level 2）
    // pdfjs 现状语义照录：'1.1 ' ASCII 字形与 /Differences 自定义码位 CJK 字形间插入空格
    // （'概 述 要 点'），纯 CJK 页（chunk 0）无此现象；仍命中 pattern[3] → 切分不受影响
    expect(chunks[1].title).toBe('1.1 概 述 要 点')
    expect(chunks[1].content).toBe('1.1 概 述 要 点')
    expect(chunks[1].level).toBe(1) // 末章收尾 push level 恒 1
  })

  it('2. pdf 无文本（content stream 无 Tj）→ ready + chunk_count=0（空章节分支 kb:447）', async () => {
    const doc = uploadPdf('纯图.pdf', [''])
    await waitForStatus(doc.id, 'ready')
    expect(docChunks(doc.id)).toHaveLength(0)
    const row = handle!.db
      .prepare('SELECT status, chunk_count FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(row.status).toBe('ready')
    expect(row.chunk_count).toBe(0)
  })

  it('3. file_type=pdf 但 buffer 非法 → pdfjs 抛错 → status=error + error_message 非空', async () => {
    const buf = Buffer.from('this is definitely not a pdf file')
    const doc = uploadDocument(buf, '损坏.pdf', 'pdf', buf.length, 'manual', null)
    await waitForStatus(doc.id, 'error')
    const row = handle!.db
      .prepare('SELECT status, error_message FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(row.status).toBe('error')
    expect(row.error_message).toBeTruthy()
  })
})

describe('kb DOCX 解析（真 mammoth + jszip 构造，D-02 真库红线）', () => {
  it('4. h1/h2 标题切分：前言 + level 1/2 章节（splitHtmlByHeadings kb:494-531）', async () => {
    const doc = await uploadDocx('配置指南.docx', [
      { text: '前言正文段落' },
      { style: 'Heading1', text: '第一章 配置指南' },
      { text: '配置正文内容' },
      { style: 'Heading2', text: '1.1 端口说明' },
      { text: '端口正文内容' },
    ])
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(3)
    // 首 heading 前有正文 → '前言' 分支（kb:509-513）
    expect(chunks[0].title).toBe('前言')
    expect(chunks[0].content).toBe('前言正文段落')
    expect(chunks[0].level).toBe(1)
    expect(chunks[1].title).toBe('第一章 配置指南')
    expect(chunks[1].content).toBe('配置正文内容')
    expect(chunks[1].level).toBe(1) // h1 → level 1（tag 数字直取，无 txt 路径的「下一标题」怪癖）
    expect(chunks[2].title).toBe('1.1 端口说明')
    expect(chunks[2].content).toBe('端口正文内容')
    expect(chunks[2].level).toBe(2) // h2 → level 2
  })

  it('5. 无 heading HTML → 降级 splitByHeadingPatterns（parts.length<4 分支 kb:503-507）', async () => {
    const doc = await uploadDocx('纯文本.docx', [
      { text: '一、基础配置' },
      { text: '基础正文' },
      { text: '1、进阶设置' },
      { text: '进阶正文' },
    ])
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    // mammoth 输出纯 <p> 无 <hN> → splitHtmlByHeadings parts.length<4 → stripHtml（</p>→\n\n）
    // → splitByHeadingPatterns：一、（pattern[2]）/ 1、（pattern[3]）均 level 2
    expect(chunks.map((c) => c.title)).toEqual(['一、基础配置', '1、进阶设置'])
    expect(chunks[0].content).toBe('一、基础配置\n\n基础正文')
    expect(chunks[0].level).toBe(2)
    expect(chunks[1].content).toBe('1、进阶设置\n\n进阶正文')
    expect(chunks[1].level).toBe(1) // 末章收尾 push level 恒 1
  })

  it('6. 含图片：[图片1] 标记定位 chunk + 落盘 kb_images/<id>.png + description="" + image_ids', async () => {
    const doc = await uploadDocx(
      '图文指南.docx',
      [
        { style: 'Heading1', text: '第一章 图文指南' },
        { text: '图文正文开始' },
        { imageRid: 'rIdImg1' },
        { text: '图文正文结束' },
      ],
      true
    )
    await waitForStatus(doc.id, 'ready')
    const chunks = docChunks(doc.id)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].title).toBe('第一章 图文指南')
    // mammoth convertImage 返 src=[图片1] → stripHtml img→[图片1] 标记留在章节 content
    expect(chunks[0].content).toContain('[图片1]')

    const imgs = handle!.db
      .prepare('SELECT id, document_id, chunk_id, file_path, description FROM kb_images WHERE document_id = ?')
      .all(doc.id) as any[]
    expect(imgs).toHaveLength(1)
    // 现状怪癖 Q6，Phase 18 裁决：实际落位由 [图片N] 标记扫描决定（kb:402-410），
    // parseDocxWithImagesAsync 的 Math.min chunkIndex 分配（kb:487-489）对真实落位零影响
    expect(imgs[0].chunk_id).toBe(chunks[0].id)
    // getVisionConfig null（getAiConfig mock null）→ describeImage 不调用 → description=''（kb:395-399）
    expect(imgs[0].description).toBe('')
    // 图片落盘 tmpParent/kb_images/<id>.png 且字节一致（D-04 真目录真文件）
    const expectedPng = Buffer.from(PNG_1X1_BASE64, 'base64')
    expect(fs.existsSync(imgs[0].file_path)).toBe(true)
    expect(imgs[0].file_path.startsWith(path.join(tmpParent, 'kb_images'))).toBe(true)
    expect(fs.readFileSync(imgs[0].file_path).equals(expectedPng)).toBe(true)
    // chunk.image_ids JSON 含图片 id（kb:414-418）
    expect(JSON.parse(chunks[0].image_ids!)).toEqual([imgs[0].id])
  })

  it('7. 空 document.xml（无段落）→ ready + chunk_count=0（kb:482 空分支）', async () => {
    const doc = await uploadDocx('空白.docx', [])
    await waitForStatus(doc.id, 'ready')
    expect(docChunks(doc.id)).toHaveLength(0)
    const row = handle!.db
      .prepare('SELECT status, chunk_count FROM kb_documents WHERE id = ?')
      .get(doc.id) as any
    expect(row.status).toBe('ready')
    expect(row.chunk_count).toBe(0)
  })
})
