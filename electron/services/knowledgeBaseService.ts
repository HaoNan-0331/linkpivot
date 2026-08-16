import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { getAiConfig, callAI } from './ai'
import type { KbSearchEnvelope } from '../../src/types/kb'

let MK = ''

export function setKbMasterKey(key: string) {
  MK = key
}

// ---- @internal 注入口（Phase 16 TEST-03 characterization 基线，D-07 零生产改动红线的唯一例外授权） ----
// 生产路径 dbGetter 默认 = getDatabase 单例，行为零变化；仅 main 进程测试代码可调；
// 无 IPC channel 暴露给 renderer（kbIpc 只包装业务函数，注入口不进 ipcMain.handle）。
let dbGetter: () => Database.Database = getDatabase

/** @internal 测试专用：注入 db getter（生产不调用）。 */
export function _setKbDbGetter(fn: () => Database.Database): void {
  dbGetter = fn
}

let kbDirsOverride: { kb: () => string; img: () => string } | null = null

/** @internal 测试专用：注入 kb/img 父目录（生产不调用）。注入的是父路径，kb_files/kb_images 子目录创建仍走本文件真逻辑（D-04）。 */
export function _setKbDirs(dirs: { kb: () => string; img: () => string } | null): void {
  kbDirsOverride = dirs
}

function kbDir(): string {
  const parent = kbDirsOverride ? kbDirsOverride.kb() : app.getPath('userData')
  const dir = path.join(parent, 'kb_files')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function imgDir(): string {
  const parent = kbDirsOverride ? kbDirsOverride.img() : app.getPath('userData')
  const dir = path.join(parent, 'kb_images')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------- Document CRUD ----------

export function uploadDocument(
  buffer: Buffer,
  fileName: string,
  fileType: string,
  fileSize: number,
  category: string,
  deviceId: string | null
): any {
  const id = uuidv4()
  const ext = path.extname(fileName) || `.${fileType}`
  const storedName = `${id}${ext}`
  const filePath = path.join(kbDir(), storedName)
  fs.writeFileSync(filePath, buffer)

  const title = path.basename(fileName, ext)
  const db = dbGetter()
  db.prepare(`
    INSERT INTO kb_documents (id, title, file_name, file_path, file_type, file_size, category, device_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, title, fileName, filePath, fileType, fileSize, category, deviceId)

  // Async process
  setImmediate(() => {
    processDocument(id).catch((err: any) => {
      console.error('[KB] processDocument failed:', err)
      db.prepare('UPDATE kb_documents SET status = ?, error_message = ? WHERE id = ?')
        .run('error', err.message, id)
    })
  })

  return getDocument(id)
}

export function listDocuments(deviceId?: string | null, category?: string | null): any[] {
  const db = dbGetter()
  const conditions: string[] = []
  const params: any[] = []

  if (deviceId) {
    conditions.push('(device_id = ? OR device_id IS NULL)')
    params.push(deviceId)
  }
  if (category) {
    conditions.push('category = ?')
    params.push(category)
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''
  return db.prepare(`SELECT * FROM kb_documents${where} ORDER BY created_at DESC`).all(...params)
}

// TXN-02 (18-01)：kb 图片查询 N+1 消除——单条 document_id 批查（走既有 idx_kb_images_doc），
// 按 chunk_id 分组。批查无 ORDER BY，经索引返回即 rowid（插入序）；生产写入路径按扫描序
// push image_ids（uploadDocument :415-419），故 JSON 序 == 插入序，两序一致。
// 挂载行投影 { id, file_path, description }——与旧逐 chunk `WHERE id IN` 行形态逐字一致
//（search 基线 it 10 对 images[0] deep-equal，不得携带 chunk_id）。
function groupImagesByChunk(
  db: ReturnType<typeof getDatabase>,
  docIds: string[]
): Map<string, Array<{ id: string; file_path: string; description: string | null }>> {
  const grouped = new Map<string, Array<{ id: string; file_path: string; description: string | null }>>()
  const distinct = [...new Set(docIds)]
  if (distinct.length === 0) return grouped
  const placeholders = distinct.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id, file_path, description, chunk_id FROM kb_images WHERE document_id IN (${placeholders})`
  ).all(...distinct) as any[]
  for (const { id, file_path, description, chunk_id } of rows) {
    const list = grouped.get(chunk_id)
    if (list) list.push({ id, file_path, description })
    else grouped.set(chunk_id, [{ id, file_path, description }])
  }
  return grouped
}

// groupImagesByChunk 配套挂载：各 chunk 从分组取本 chunk 图片，按自身 image_ids JSON 序
// 过滤/排序（与旧逐 chunk IN 行序一致）；JSON.parse 异常降级 images=[] 现状语义保留（:113-115）。
function attachGroupedImages(chunk: any, grouped: Map<string, Array<{ id: string; file_path: string; description: string | null }>>): any {
  if (chunk.image_ids) {
    try {
      const ids = JSON.parse(chunk.image_ids) as string[]
      const own = grouped.get(chunk.id) ?? []
      const byId = new Map(own.map(r => [r.id, r]))
      chunk.images = ids.map(id => byId.get(id)).filter(Boolean)
    } catch { chunk.images = [] }
  } else {
    chunk.images = []
  }
  return chunk
}

export function getDocument(docId: string): any | null {
  const db = dbGetter()
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) return null

  const chunks = db.prepare(
    'SELECT id, chunk_index, title, content, char_count, level, image_ids FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index'
  ).all(docId) as any[]

  // TXN-02 (18-01)：图片查询仅此 1 条 document_id 批查（替代逐 chunk WHERE id IN 的 N+1）
  const grouped = groupImagesByChunk(db, [docId])
  for (const chunk of chunks) {
    attachGroupedImages(chunk, grouped)
  }

  return { ...doc, chunks }
}

// ---------- Chunk CRUD ----------

export function updateChunk(chunkId: string, title: string, content: string): void {
  const db = dbGetter()
  // kb-db-malformed：UPDATE + FTS sync 显式包进单事务，保证原子（防 taskkill 致 FTS shadow 半途中断写入）。
  // FTS sync 仍 try/catch（FTS 损坏不应回滚 chunk 主数据）。
  const tx = db.transaction(() => {
    db.prepare('UPDATE kb_chunks SET title = ?, content = ?, char_count = ? WHERE id = ?')
      .run(title, content, content.length, chunkId)
    try {
      const chunk = db.prepare('SELECT rowid FROM kb_chunks WHERE id = ?').get(chunkId) as any
      if (chunk) {
        // Q10（18-02 方案 A 终裁）：image_desc 恒 NULL，与 v14 三触发器双端常量一致——
        // kb_chunks_fts 零生产 MATCH 读者，NULL 常量可静态证明不 mismatch（malformed 根除）。
        db.prepare('INSERT OR REPLACE INTO kb_chunks_fts (rowid, title, content, image_desc) VALUES (?, ?, ?, ?)')
          .run(chunk.rowid, title, content, null)
      }
    } catch { /* FTS sync failed, non-critical */ }
  })
  tx()
}

export function deleteChunk(chunkId: string): void {
  const db = dbGetter()
  const chunk = db.prepare('SELECT document_id FROM kb_chunks WHERE id = ?').get(chunkId) as any
  if (!chunk) return
  // Delete associated image files (filesystem, 事务外：DB 已提交后再删，避免 DB 回滚后文件已删的不一致)
  const images = db.prepare('SELECT file_path FROM kb_images WHERE chunk_id = ?').all(chunkId) as any[]
  // kb-db-malformed：DELETE images + chunk + reindex + chunk_count 显式包进单事务，保证原子。
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM kb_images WHERE chunk_id = ?').run(chunkId)
    db.prepare('DELETE FROM kb_chunks WHERE id = ?').run(chunkId)
    // Reindex remaining chunks
    const remaining = db.prepare('SELECT id FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index').all(chunk.document_id) as any[]
    const reindex = db.prepare('UPDATE kb_chunks SET chunk_index = ? WHERE id = ?')
    for (let i = 0; i < remaining.length; i++) {
      reindex.run(i, remaining[i].id)
    }
    db.prepare('UPDATE kb_documents SET chunk_count = ? WHERE id = ?').run(remaining.length, chunk.document_id)
  })
  tx()
  for (const img of images) {
    try { fs.unlinkSync(img.file_path) } catch { /* ignore */ }
  }
}

export function mergeChunks(chunkIds: string[], newTitle: string): string {
  const db = dbGetter()
  const chunks = chunkIds.map(id => db.prepare('SELECT * FROM kb_chunks WHERE id = ?').get(id) as any).filter(Boolean)
  if (chunks.length < 2) throw new Error('至少需要2个章节才能合并')
  const docId = chunks[0].document_id
  const mergedContent = chunks.map(c => `## ${c.title}\n\n${c.content}`).join('\n\n')
  const mergedId = uuidv4()
  const minIndex = Math.min(...chunks.map(c => c.chunk_index))

  // kb-db-malformed：多 DELETE + INSERT + reindex + chunk_count 包进单事务，保证原子。
  const tx = db.transaction(() => {
    for (const c of chunks) {
      db.prepare('DELETE FROM kb_chunks WHERE id = ?').run(c.id)
    }
    db.prepare('INSERT INTO kb_chunks (id, document_id, chunk_index, title, content, level, char_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(mergedId, docId, minIndex, newTitle, mergedContent, 1, mergedContent.length)
    const remaining = db.prepare('SELECT id FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index').all(docId) as any[]
    const reindex = db.prepare('UPDATE kb_chunks SET chunk_index = ? WHERE id = ?')
    for (let i = 0; i < remaining.length; i++) {
      reindex.run(i, remaining[i].id)
    }
    db.prepare('UPDATE kb_documents SET chunk_count = ? WHERE id = ?').run(remaining.length, docId)
  })
  tx()
  return mergedId
}

export function splitChunk(chunkId: string, splitPosition: number, title1: string, title2: string): string[] {
  const db = dbGetter()
  const chunk = db.prepare('SELECT * FROM kb_chunks WHERE id = ?').get(chunkId) as any
  if (!chunk) throw new Error('章节不存在')
  if (splitPosition <= 0 || splitPosition >= chunk.content.length) throw new Error('拆分位置无效')

  const content1 = chunk.content.slice(0, splitPosition).trim()
  const content2 = chunk.content.slice(splitPosition).trim()
  const id1 = uuidv4()
  const id2 = uuidv4()

  // kb-db-malformed：DELETE + 2 INSERT + reindex + chunk_count 包进单事务，保证原子。
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM kb_chunks WHERE id = ?').run(chunkId)

    db.prepare('INSERT INTO kb_chunks (id, document_id, chunk_index, title, content, level, char_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id1, chunk.document_id, chunk.chunk_index, title1, content1, chunk.level, content1.length)
    db.prepare('INSERT INTO kb_chunks (id, document_id, chunk_index, title, content, level, char_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id2, chunk.document_id, chunk.chunk_index + 1, title2, content2, chunk.level, content2.length)

    const remaining = db.prepare('SELECT id FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index').all(chunk.document_id) as any[]
    const reindex = db.prepare('UPDATE kb_chunks SET chunk_index = ? WHERE id = ?')
    for (let i = 0; i < remaining.length; i++) {
      reindex.run(i, remaining[i].id)
    }
    db.prepare('UPDATE kb_documents SET chunk_count = ? WHERE id = ?').run(remaining.length, chunk.document_id)
  })
  tx()
  return [id1, id2]
}

export function deleteDocument(docId: string): void {
  const db = dbGetter()
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) throw new Error('文档不存在')

  // Delete image files
  const images = db.prepare('SELECT file_path FROM kb_images WHERE document_id = ?').all(docId) as any[]
  for (const img of images) {
    try { fs.unlinkSync(img.file_path) } catch { /* ignore */ }
  }

  // Delete document file
  try { fs.unlinkSync(doc.file_path) } catch { /* ignore */ }

  // Delete DB records (chunks first to trigger FTS cleanup)
  // kb-db-malformed：3 DELETE 包进单事务，保证原子（FTS 触发器随 chunks DELETE 同步清理）。
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM kb_chunks WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM kb_images WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM kb_documents WHERE id = ?').run(docId)
  })
  tx()
}

export function reprocessDocument(docId: string): any {
  const db = dbGetter()
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) throw new Error('文档不存在')

  // TXN-01（18-02）+ T-18-07：文件序反转为三段式——先收集路径 → tx 提交 → 再 unlink。
  // 事务回滚时文件仍在磁盘（可重试重处理）；孤儿文件由下次 reprocess 重删
  // （镜像 deleteChunk 三段式先例：DB 事务提交后再动文件系统）。
  const images = db.prepare('SELECT file_path FROM kb_images WHERE document_id = ?').all(docId) as any[]

  // kb-db-malformed + TXN-01：2 DELETE + status 重置包单事务保原子（镜像 deleteDocument 范式）。
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM kb_chunks WHERE document_id = ?').run(docId)
    db.prepare('DELETE FROM kb_images WHERE document_id = ?').run(docId)
    db.prepare('UPDATE kb_documents SET status = ?, error_message = NULL WHERE id = ?').run('pending', docId)
  })
  tx()

  for (const img of images) {
    try { fs.unlinkSync(img.file_path) } catch { /* ignore */ }
  }

  // Pitfall 1：processDocument 含 await describeImage（异步编排），永不整体包事务（P7 铁律）。
  setImmediate(() => {
    processDocument(docId).catch((err: any) => {
      console.error('[KB] reprocessDocument failed:', err)
      db.prepare('UPDATE kb_documents SET status = ?, error_message = ? WHERE id = ?')
        .run('error', err.message, docId)
    })
  })

  return getDocument(docId)
}

// ---------- Vision Model ----------

interface VisionConfig {
  baseUrl: string
  apiKey: string
  model: string
}

function getVisionConfig(): VisionConfig | null {
  const config = getAiConfig()
  if (!config) { console.log('[KB] getVisionConfig: no ai config'); return null }

  const baseUrl = config.visionBaseUrl || config.baseUrl
  const apiKey = config.visionApiKey || config.apiKey
  const model = config.visionModel

  if (!apiKey || !model) return null
  return { baseUrl, apiKey, model }
}

async function describeImage(imageBuffer: Buffer, ext: string, config: VisionConfig): Promise<string> {
  const base64 = imageBuffer.toString('base64')
  const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '请用中文简洁描述这张图片的内容，重点关注与网络设备、技术配置相关的信息。如果图片是纯文字截图，请转录其中的文字内容。' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      }],
      max_tokens: 300,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Vision API error (${response.status}): ${text}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

// ---------- Document Processing ----------

async function processDocument(docId: string): Promise<void> {
  const db = dbGetter()
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) throw new Error('文档不存在')

  db.prepare('UPDATE kb_documents SET status = ? WHERE id = ?').run('processing', docId)

  const buffer = fs.readFileSync(doc.file_path)
  let chapters: Array<{ title: string; content: string; level: number }>
  let images: Array<{ buffer: Buffer; ext: string }> = []

  switch (doc.file_type) {
    case 'txt':
      chapters = parseTxt(buffer.toString('utf-8'))
      break
    case 'pdf':
      chapters = await parsePdf(buffer)
      break
    case 'docx':
      const docxResult = await parseDocxWithImagesAsync(buffer)
      chapters = docxResult.chapters
      images = docxResult.images
      break
    default:
      throw new Error(`不支持的文件类型: ${doc.file_type}`)
  }

  // Save chunks
  const chunkIds: string[] = []
  const insertChunk = db.prepare(`
    INSERT INTO kb_chunks (id, document_id, chunk_index, title, content, level, char_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction(() => {
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i]
      const chunkId = uuidv4()
      chunkIds.push(chunkId)
      insertChunk.run(chunkId, docId, i, ch.title, ch.content, ch.level, ch.content.length)
    }
  })
  insertMany()

  // Save images and generate descriptions
  // Scan each chunk's content for [图片N] markers to find which images belong to which chunk
  if (images.length > 0) {
    const visionConfig = getVisionConfig()
    const insertImage = db.prepare(`
      INSERT INTO kb_images (id, document_id, chunk_id, file_path, description)
      VALUES (?, ?, ?, ?, ?)
    `)

    for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
      const img = images[imgIdx]
      const imgId = uuidv4()
      const imgFileName = `${imgId}.${img.ext}`
      const imgFilePath = path.join(imgDir(), imgFileName)

      // element.read('base64') may return base64 string, convert to Buffer if needed
      const imgBuffer = Buffer.isBuffer(img.buffer) ? img.buffer : Buffer.from(img.buffer, 'base64')
      fs.writeFileSync(imgFilePath, imgBuffer)
      console.log(`[KB] saved image ${imgIdx + 1}: ${imgFileName} size=${imgBuffer.length}`)

      let description = ''
      if (visionConfig) {
        try {
          description = await describeImage(imgBuffer, img.ext, visionConfig)
        } catch { /* description generation failed, continue without */ }
      }

      // Find which chunk contains [图片N] marker (1-based)
      const marker = `[图片${imgIdx + 1}]`
      let targetChunkId = chunkIds[0]
      for (let ci = 0; ci < chapters.length; ci++) {
        if (chapters[ci].content.includes(marker)) {
          targetChunkId = chunkIds[ci]
          break
        }
      }

      insertImage.run(imgId, docId, targetChunkId, imgFilePath, description)

      // Update chunk's image_ids
      const chunk = db.prepare('SELECT image_ids FROM kb_chunks WHERE id = ?').get(targetChunkId) as any
      const existingIds: string[] = chunk?.image_ids ? JSON.parse(chunk.image_ids) : []
      existingIds.push(imgId)
      db.prepare('UPDATE kb_chunks SET image_ids = ? WHERE id = ?').run(JSON.stringify(existingIds), targetChunkId)
    }
  }

  db.prepare(`UPDATE kb_documents SET status = ?, chunk_count = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
    .run('ready', chapters.length, docId)
}

function parseTxt(text: string): Array<{ title: string; content: string; level: number }> {
  return splitByHeadingPatterns(text)
}

// ---------- PDF Parsing ----------

async function parsePdf(buffer: Buffer): Promise<Array<{ title: string; content: string; level: number }>> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdfjs v6：destroy() 在 loadingTask 上（PDFDocumentProxy 无 destroy），释放 worker 资源须持 task
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
  const doc = await loadingTask.promise

  let fullText = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const textContent = await page.getTextContent()
    fullText += textContent.items.map((item: any) => item.str).join(' ') + '\n'
    page.cleanup()
  }
  loadingTask.destroy()

  if (!fullText.trim()) return []
  return splitByHeadingPatterns(fullText)
}

// ---------- Word Parsing ----------

// C-M2（v0.3.0 audit）：死代码已删——parseDocx/parseDocxWithImages/splitByOutline/ragQuery
// 全仓零引用（在用的 Word 解析是下方 parseDocxWithImagesAsync，检索走上方 search）。

// Async version that also extracts images
async function parseDocxWithImagesAsync(buffer: Buffer): Promise<{
  chapters: Array<{ title: string; content: string; level: number }>
  images: Array<{ buffer: Buffer; ext: string }>
}> {
  const mammoth = require('mammoth')
  const images: Array<{ buffer: Buffer; ext: string }> = []

  console.log('[KB] parseDocxWithImagesAsync: starting, buffer size:', buffer.length)
  const result = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.inline((element: any) => {
      console.log('[KB] convertImage callback: contentType=', element.contentType)
      return element.read('base64').then((imgBuffer: Buffer) => {
        const ext = element.contentType?.split('/')[1] || 'png'
        console.log('[KB] image extracted: ext=', ext, 'size=', imgBuffer.length)
        images.push({ buffer: imgBuffer, ext })
        return { src: `[图片${images.length}]` }
      }).catch((err: any) => {
        console.error('[KB] image read error:', err)
        return { src: '' }
      })
    })
  })
  console.log('[KB] mammoth done. images count:', images.length, 'messages:', result.messages?.length)
  const html = result.value as string

  if (!html || !html.trim()) return { chapters: [], images: [] }

  const chapters = splitHtmlByHeadings(html)

  // D-03（Q6 裁决）：原「按序号预分配图片落章节」死轨已删——processDocument 实际落位走
  // [图片N] 标记扫描（:403-411），该预分配字段零消费者，连字段一并移除。
  return { chapters, images }
}

function splitHtmlByHeadings(html: string): Array<{ title: string; content: string; level: number }> {
  const chapters: Array<{ title: string; content: string; level: number }> = []

  // Split by <h1>-<h6> tags
  const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi
  const parts = html.split(headingRegex)

  // parts: [before, level, title, content, level, title, content, ...]
  // First element is content before any heading
  if (parts.length < 4) {
    // No headings found, try bold+numbering pattern
    const textOnly = stripHtml(html)
    return splitByHeadingPatterns(textOnly)
  }

  // Content before first heading
  const preamble = stripHtml(parts[0])
  if (preamble.trim()) {
    chapters.push({ title: '前言', content: preamble.trim(), level: 1 })
  }

  for (let i = 1; i < parts.length - 2; i += 3) {
    const level = parseInt(parts[i], 10)
    const title = stripHtml(parts[i + 1])
    const content = stripHtml(parts[i + 2])
    if (title || content.trim()) {
      chapters.push({ title: title || '未命名', content: content.trim(), level })
    }
  }

  // Fallback if no real chapters extracted
  if (chapters.length === 0) {
    const textOnly = stripHtml(html)
    return splitByHeadingPatterns(textOnly)
  }

  return splitOversizedChapters(chapters)
}

// ---------- Common Helpers ----------

function stripHtml(html: string): string {
  return html
    .replace(/<img[^>]*src="\[图片(\d+)\]"[^>]*\/?>/gi, '[图片$1]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

function splitByHeadingPatterns(text: string): Array<{ title: string; content: string; level: number }> {
  const chapters: Array<{ title: string; content: string; level: number }> = []
  const lines = text.split(/\r?\n/)
  let currentTitle = ''
  let currentContent: string[] = []
  let hasContent = false

  // D-04（Q7 裁决）：原 pattern[4]（1.1→level 3）/ pattern[5]（1.1.1→level 4）不可达规则已删——
  // pattern[3] 的 [、.．] 后 \s*（零或多空白）先命中任何「1.1 xxx」，二者一律落 level 2，从未可达。
  // level 取值语义（前一章 level 取自下一标题层级）与末章收尾 push 恒 1 保持现状（renderer 树形展示不变）。
  const headingPatterns = [
    /^(#{1,6})\s+(.+)$/,                                          // Markdown
    /^第([一二三四五六七八九十百千]+)[章节篇部]\s*(.*)/,              // 第X章/节/篇
    /^([一二三四五六七八九十]+)[、.．]\s*(.*)/,                     // 一、二、
    /^(\d+)[、.．]\s*(.*)/,                                        // 1、2、（1.1/1.1.1 经 \s* 零空白同落此规则）
  ]

  for (const line of lines) {
    let isHeading = false
    let headingTitle = ''
    let headingLevel = 1

    for (const pattern of headingPatterns) {
      const match = line.match(pattern)
      if (match) {
        isHeading = true
        headingTitle = line.trim()
        if (pattern === headingPatterns[0]) headingLevel = match[1].length
        else if (pattern === headingPatterns[1]) headingLevel = 1
        else if (pattern === headingPatterns[2]) headingLevel = 2
        else if (pattern === headingPatterns[3]) headingLevel = 2
        break
      }
    }

    if (isHeading) {
      if (hasContent) {
        chapters.push({ title: currentTitle || '未命名', content: currentContent.join('\n').trim(), level: headingLevel })
      }
      currentTitle = headingTitle
      currentContent = [line]
      hasContent = false
    } else {
      currentContent.push(line)
      if (line.trim()) hasContent = true
    }
  }

  if (currentContent.some(l => l.trim())) {
    chapters.push({ title: currentTitle || '未命名', content: currentContent.join('\n').trim(), level: 1 })
  }

  // D-05（Q8 裁决）：原「零章节时按整段兜底成单章」不可达分支已删——
  // 任何非空文本必先经上方收尾 push（currentTitle || '未命名'），chapters.length≥1 恒成立。

  return splitOversizedChapters(chapters)
}

function splitOversizedChapters(chapters: Array<{ title: string; content: string; level: number }>): Array<{ title: string; content: string; level: number }> {
  const result: typeof chapters = []
  for (const ch of chapters) {
    if (ch.content.length > 2000) {
      const paragraphs = ch.content.split(/\n\s*\n/)
      let subContent: string[] = []
      let subLen = 0
      for (const p of paragraphs) {
        if (subLen + p.length > 2000 && subContent.length > 0) {
          result.push({ title: ch.title, content: subContent.join('\n\n'), level: ch.level })
          subContent = []
          subLen = 0
        }
        subContent.push(p)
        subLen += p.length
      }
      if (subContent.length > 0) {
        result.push({ title: ch.title, content: subContent.join('\n\n'), level: ch.level })
      }
    } else {
      result.push(ch)
    }
  }
  return result
}

// ---------- Search ----------

// TXN-04 (18-01) L2：LLM 索引条目上限——库增长时 prompt 不再无界膨胀（Q3）。
// 截断可观测：indexCapped 经信封回传 renderer（T-18-03），prompt 索引块尾部同步标注。
export const MAX_INDEX_ENTRIES = 200

// search 图片挂载复用模块级 groupImagesByChunk/attachGroupedImages（TXN-02，与 getDocument 单一来源），
// 不再持逐 chunk WHERE id IN 的局部 attachImages。

export async function search(query: string, deviceIds?: string[], topK = 5): Promise<KbSearchEnvelope> {
  const db = dbGetter()

  // 1. Extract all ready chunks as virtual index
  // L1（TXN-04）：索引构建不再 SELECT 全文——LLM 索引行只需 80 字摘要（T-18-02）；
  // AI 选中 / 降级返回的 ≤topK 行另发一条 id IN 占位符批查取全文（见 fetchFullRows）。
  let sql = `SELECT c.id, c.document_id, c.chunk_index, c.title, substr(c.content, 1, 80) AS summary, c.level, c.image_ids,
    d.title AS doc_title, d.file_name
    FROM kb_chunks c JOIN kb_documents d ON c.document_id = d.id
    WHERE d.status = 'ready'`
  const params: any[] = []
  if (deviceIds && deviceIds.length > 0) {
    const ph = deviceIds.map(() => '?').join(',')
    sql += ` AND (d.device_id IN (${ph}) OR d.device_id IS NULL)`
    params.push(...deviceIds)
  }
  sql += ` ORDER BY d.title, c.chunk_index`
  const allChunks = db.prepare(sql).all(...params) as any[]

  if (allChunks.length === 0) {
    return { rows: [], degraded: false, indexTotal: 0, indexCapped: null }
  }

  // 2. Build virtual index (compact, like INDEX.md)
  // L2（TXN-04）：indexLines 只取前 MAX_INDEX_ENTRIES 条（ORDER BY 前缀语义，与全量同序）
  const indexTotal = allChunks.length
  const cappedChunks = allChunks.slice(0, MAX_INDEX_ENTRIES)
  const indexCapped = indexTotal > MAX_INDEX_ENTRIES ? MAX_INDEX_ENTRIES : null
  const indexLines = cappedChunks.map((c, i) =>
    `[${i}] 文档: ${c.doc_title} | 章节: ${c.title || '无标题'} | 摘要: ${(c.summary || '').replace(/\n/g, ' ')}`
  ).join('\n')
  const indexBlock = indexCapped !== null
    ? `${indexLines}\n（索引已从 ${indexTotal} 条截取前 ${indexCapped} 条）`
    : indexLines

  // L1 配套：≤topK 命中行取全文——单条 id IN 占位符批查（'?,'.repeat 模板生成占位符，值全走绑定禁拼接），
  // 返回行列集与旧全量索引行逐字一致（含 content 全文 + doc_title/file_name join 列）。
  const fetchFullRows = (rows: any[]): any[] => {
    if (rows.length === 0) return []
    const placeholders = '?,'.repeat(rows.length - 1) + '?'
    const full = db.prepare(
      `SELECT c.id, c.document_id, c.chunk_index, c.title, c.content, c.level, c.image_ids,
        d.title AS doc_title, d.file_name
        FROM kb_chunks c JOIN kb_documents d ON c.document_id = d.id
        WHERE c.id IN (${placeholders})`
    ).all(...rows.map(r => r.id)) as any[]
    const byId = new Map(full.map(r => [r.id, r]))
    return rows.map(r => byId.get(r.id)).filter(Boolean)
  }
  // TXN-02 (18-01)：decorate 批处理——命中行一次 document_id IN 批查挂图（≤topK 行零 N+1，
  // 含 file_path 供 ChunkContent 渲染 [图片N]，行序按各 chunk image_ids JSON 序与旧一致）
  const decorate = (rowsToDecorate: any[]): any[] => {
    const grouped = groupImagesByChunk(db, rowsToDecorate.map(r => r.document_id))
    return rowsToDecorate.map(chunk => {
      chunk.document = { id: chunk.document_id, title: chunk.doc_title, file_name: chunk.file_name }
      return attachGroupedImages(chunk, grouped)
    })
  }
  // 降级行 = fallback 前 topK 行（返回语义同旧实现，未经 LLM 筛选）
  const fallbackRows = () => decorate(fetchFullRows(allChunks.slice(0, topK)))

  // 3. AI picks relevant chunks from the index
  const config = getAiConfig()
  if (!config || !config.apiKey) {
    console.warn('[kb:search] degraded: no_api_key')
    return { rows: fallbackRows(), degraded: true, degradedReason: 'no_api_key', indexTotal, indexCapped }
  }

  const pickPrompt = `你是一个文档检索助手。以下是资料库中所有文档的章节索引。用户提出了一个问题，请从索引中选出与问题最相关的章节。

用户问题：${query}

章节索引：
${indexBlock}

请返回最相关的章节编号，用逗号分隔，按相关性从高到低排列。最多返回${topK}个。
如果没有相关章节，返回：none
只返回编号，不要解释。`

  try {
    const response = await callAI(config, [{ role: 'user', content: pickPrompt }])

    // LLM 明确判定无相关章节（none）是正常结论，非降级
    if (!response || response.trim().toLowerCase() === 'none') {
      return { rows: [], degraded: false, indexTotal, indexCapped }
    }

    // 编号只可能落在 LLM 可见的截断索引内（cappedChunks），越界/非数字一律过滤
    const indices = response.trim().split(/[,，\s]+/)
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((i: number) => !isNaN(i) && i >= 0 && i < cappedChunks.length)

    if (indices.length === 0) {
      console.warn('[kb:search] degraded: empty_pick')
      return { rows: fallbackRows(), degraded: true, degradedReason: 'empty_pick', indexTotal, indexCapped }
    }

    // 4. Return selected chunks with document info and image descriptions
    const rows = decorate(fetchFullRows(indices.slice(0, topK).map((i: number) => cappedChunks[i])))
    return { rows, degraded: false, indexTotal, indexCapped }
  } catch {
    console.warn('[kb:search] degraded: callai_error')
    return { rows: fallbackRows(), degraded: true, degradedReason: 'callai_error', indexTotal, indexCapped }
  }
}
