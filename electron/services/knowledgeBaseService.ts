import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { getAiConfig, callAI } from './ai'

let MK = ''

export function setKbMasterKey(key: string) {
  MK = key
}

function kbDir(): string {
  const dir = path.join(app.getPath('userData'), 'kb_files')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function imgDir(): string {
  const dir = path.join(app.getPath('userData'), 'kb_images')
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
  const db = getDatabase()
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
  const db = getDatabase()
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

export function getDocument(docId: string): any | null {
  const db = getDatabase()
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) return null

  const chunks = db.prepare(
    'SELECT id, chunk_index, title, content, char_count, level, image_ids FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index'
  ).all(docId)

  // Attach images for each chunk
  for (const chunk of chunks) {
    if (chunk.image_ids) {
      try {
        const ids = JSON.parse(chunk.image_ids) as string[]
        chunk.images = db.prepare('SELECT id, file_path, description FROM kb_images WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids)
      } catch { chunk.images = [] }
    } else {
      chunk.images = []
    }
  }

  return { ...doc, chunks }
}

// ---------- Chunk CRUD ----------

export function updateChunk(chunkId: string, title: string, content: string): void {
  const db = getDatabase()
  db.prepare('UPDATE kb_chunks SET title = ?, content = ?, char_count = ? WHERE id = ?')
    .run(title, content, content.length, chunkId)
  // FTS sync removed — search uses AI-based chunk selection, not full-text index
}

export function deleteChunk(chunkId: string): void {
  const db = getDatabase()
  const chunk = db.prepare('SELECT document_id FROM kb_chunks WHERE id = ?').get(chunkId) as any
  if (!chunk) return
  // Delete associated images
  const images = db.prepare('SELECT file_path FROM kb_images WHERE chunk_id = ?').all(chunkId) as any[]
  for (const img of images) {
    try { fs.unlinkSync(img.file_path) } catch { /* ignore */ }
  }
  db.prepare('DELETE FROM kb_images WHERE chunk_id = ?').run(chunkId)
  db.prepare('DELETE FROM kb_chunks WHERE id = ?').run(chunkId)
  // Reindex remaining chunks
  const remaining = db.prepare('SELECT id FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index').all(chunk.document_id) as any[]
  const reindex = db.prepare('UPDATE kb_chunks SET chunk_index = ? WHERE id = ?')
  for (let i = 0; i < remaining.length; i++) {
    reindex.run(i, remaining[i].id)
  }
  db.prepare('UPDATE kb_documents SET chunk_count = ? WHERE id = ?').run(remaining.length, chunk.document_id)
}

export function mergeChunks(chunkIds: string[], newTitle: string): string {
  const db = getDatabase()
  const chunks = chunkIds.map(id => db.prepare('SELECT * FROM kb_chunks WHERE id = ?').get(id) as any).filter(Boolean)
  if (chunks.length < 2) throw new Error('至少需要2个章节才能合并')
  const docId = chunks[0].document_id
  const mergedContent = chunks.map(c => `## ${c.title}\n\n${c.content}`).join('\n\n')
  const mergedId = uuidv4()
  const minIndex = Math.min(...chunks.map(c => c.chunk_index))

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
  return mergedId
}

export function splitChunk(chunkId: string, splitPosition: number, title1: string, title2: string): string[] {
  const db = getDatabase()
  const chunk = db.prepare('SELECT * FROM kb_chunks WHERE id = ?').get(chunkId) as any
  if (!chunk) throw new Error('章节不存在')
  if (splitPosition <= 0 || splitPosition >= chunk.content.length) throw new Error('拆分位置无效')

  const content1 = chunk.content.slice(0, splitPosition).trim()
  const content2 = chunk.content.slice(splitPosition).trim()
  const id1 = uuidv4()
  const id2 = uuidv4()

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
  return [id1, id2]
}

export function deleteDocument(docId: string): void {
  const db = getDatabase()
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
  db.prepare('DELETE FROM kb_chunks WHERE document_id = ?').run(docId)
  db.prepare('DELETE FROM kb_images WHERE document_id = ?').run(docId)
  db.prepare('DELETE FROM kb_documents WHERE id = ?').run(docId)
}

export function reprocessDocument(docId: string): any {
  const db = getDatabase()
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) throw new Error('文档不存在')

  // Clean existing chunks and images
  const images = db.prepare('SELECT file_path FROM kb_images WHERE document_id = ?').all(docId) as any[]
  for (const img of images) {
    try { fs.unlinkSync(img.file_path) } catch { /* ignore */ }
  }
  db.prepare('DELETE FROM kb_chunks WHERE document_id = ?').run(docId)
  db.prepare('DELETE FROM kb_images WHERE document_id = ?').run(docId)

  db.prepare('UPDATE kb_documents SET status = ?, error_message = NULL WHERE id = ?').run('pending', docId)

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
  const db = getDatabase()
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) throw new Error('文档不存在')

  db.prepare('UPDATE kb_documents SET status = ? WHERE id = ?').run('processing', docId)

  const buffer = fs.readFileSync(doc.file_path)
  let chapters: Array<{ title: string; content: string; level: number }>
  let images: Array<{ chunkIndex: number; buffer: Buffer; ext: string }> = []

  switch (doc.file_type) {
    case 'txt':
      chapters = parseTxt(buffer.toString('utf-8'))
      break
    case 'pdf':
      chapters = parsePdf(buffer)
      images = (await extractPdfImages(buffer)).map((img, idx) => ({
        chunkIndex: Math.min(idx, chapters.length - 1),
        buffer: img.buffer,
        ext: img.ext,
      }))
      // Insert [图片N] markers into chunk content for PDF
      for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
        const ci = images[imgIdx].chunkIndex
        if (ci >= 0 && ci < chapters.length) {
          chapters[ci].content += `\n[图片${imgIdx + 1}]`
        }
      }
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
          console.log(`[KB] vision describe ok: img=${imgFileName} desc_len=${description.length}`)
        } catch (err: any) {
          console.error(`[KB] vision describe FAILED: img=${imgFileName} error=${err.message}`)
        }
      } else {
        console.warn(`[KB] vision model not configured, skipping image description for ${imgFileName}`)
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

// ---------- PNG Encoder ----------

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  CRC_TABLE[n] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const typeB = Buffer.from(type, 'ascii')
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])))
  return Buffer.concat([len, typeB, data, crcB])
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const zlib = require('zlib')
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    const off = y * (width * 4 + 1)
    raw[off] = 0 // filter: None
    const src = y * width * 4
    for (let x = 0; x < width * 4; x++) raw[off + 1 + x] = rgba[src + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- PDF Parsing ----------

function parsePdf(buffer: Buffer): Array<{ title: string; content: string; level: number }> {
  // pdf-parse is ESM-incompatible, use dynamic require
  const pdfParse = require('pdf-parse')
  const data = pdfParse(buffer)
  const text: string = data.text
  if (!text || !text.trim()) return []

  // Try to use outline (bookmarks) for chapter structure
  const outline = data.outline || []
  if (outline.length > 0) {
    return splitByOutline(text, outline)
  }

  // Fallback: detect headings by text patterns
  return splitByHeadingPatterns(text)
}

/** Extract images from PDF using pdfjs-dist (best-effort) */
async function extractPdfImages(buffer: Buffer): Promise<Array<{ buffer: Buffer; ext: string }>> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
    const images: Array<{ buffer: Buffer; ext: string }> = []
    const OPS = pdfjsLib.OPS

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum)
      try {
        const opList = await page.getOperatorList()
        for (let i = 0; i < opList.fnArray.length; i++) {
          if (opList.fnArray[i] === OPS.paintImageXObject ||
              opList.fnArray[i] === OPS.paintJpegXObject) {
            const imgName = opList.argsArray[i][0]
            try {
              const imgData = await new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('timeout')), 5000)
                try {
                  page.objs.get(imgName, (data: any) => { clearTimeout(timer); resolve(data) })
                } catch (e: any) { clearTimeout(timer); reject(e) }
              })
              if (imgData?.data && imgData.width > 0 && imgData.height > 0) {
                const { width, height, kind, data: pixelData } = imgData
                const pixels = width * height
                let rgba: Uint8Array
                if (kind === 1) { // Grayscale → RGBA
                  rgba = new Uint8Array(pixels * 4)
                  for (let j = 0; j < pixels; j++) {
                    rgba[j * 4] = rgba[j * 4 + 1] = rgba[j * 4 + 2] = pixelData[j]; rgba[j * 4 + 3] = 255
                  }
                } else if (kind === 2) { // RGB → RGBA
                  rgba = new Uint8Array(pixels * 4)
                  for (let j = 0; j < pixels; j++) {
                    rgba[j * 4] = pixelData[j * 3]; rgba[j * 4 + 1] = pixelData[j * 3 + 1]
                    rgba[j * 4 + 2] = pixelData[j * 3 + 2]; rgba[j * 4 + 3] = 255
                  }
                } else {
                  rgba = pixelData instanceof Uint8Array ? pixelData : new Uint8Array(pixelData)
                }
                // Skip tiny images (likely icons/decorations under 20x20)
                if (width >= 20 && height >= 20) {
                  images.push({ buffer: encodePng(width, height, rgba), ext: 'png' })
                }
              }
            } catch { /* individual image extraction failure, skip */ }
          }
        }
      } finally { page.cleanup() }
    }
    doc.destroy()
    console.log(`[KB] extractPdfImages: found ${images.length} images`)
    return images
  } catch (err: any) {
    console.log(`[KB] extractPdfImages failed: ${err.message}`)
    return []
  }
}

interface PdfOutlineItem {
  title: string
  level: number
  dest?: any
}

function splitByOutline(text: string, outline: PdfOutlineItem[]): Array<{ title: string; content: string; level: number }> {
  const lines = text.split(/\r?\n/)
  const chapters: Array<{ title: string; content: string; level: number }> = []
  const titles = outline.map(o => o.title.trim())

  let currentTitle = titles[0] || '前言'
  let currentLevel = outline[0]?.level || 1
  let currentContent: string[] = []
  let nextTitleIdx = 1
  let foundFirst = false

  for (const line of lines) {
    const nextTitle = nextTitleIdx < titles.length ? titles[nextTitleIdx] : null

    if (nextTitle && line.trim().includes(nextTitle)) {
      if (foundFirst || currentContent.some(l => l.trim())) {
        chapters.push({
          title: currentTitle,
          content: currentContent.join('\n').trim(),
          level: currentLevel,
        })
      }
      currentTitle = nextTitle
      currentLevel = outline[nextTitleIdx]?.level || 1
      currentContent = [line]
      nextTitleIdx++
      foundFirst = true
    } else {
      currentContent.push(line)
      foundFirst = foundFirst || line.trim().length > 0
    }
  }

  if (currentContent.some(l => l.trim())) {
    chapters.push({ title: currentTitle, content: currentContent.join('\n').trim(), level: currentLevel })
  }

  return splitOversizedChapters(chapters.length > 0 ? chapters : [{ title: '文档内容', content: text.trim(), level: 1 }])
}

// ---------- Word Parsing ----------

function parseDocx(buffer: Buffer): Array<{ title: string; content: string; level: number }> {
  return parseDocxWithImages(buffer).chapters
}

function parseDocxWithImages(buffer: Buffer): {
  chapters: Array<{ title: string; content: string; level: number }>
  images: Array<{ chunkIndex: number; buffer: Buffer; ext: string }>
} {
  const mammoth = require('mammoth')

  // Synchronous: just extract chapters, images handled separately
  const result = mammoth.convertToHtml({ buffer })
  const html: string = result.value

  if (!html || !html.trim()) return { chapters: [], images: [] }

  const chapters = splitHtmlByHeadings(html)
  return { chapters, images: [] }
}

// Async version that also extracts images
async function parseDocxWithImagesAsync(buffer: Buffer): Promise<{
  chapters: Array<{ title: string; content: string; level: number }>
  images: Array<{ chunkIndex: number; buffer: Buffer; ext: string }>
}> {
  const mammoth = require('mammoth')
  const images: Array<{ chunkIndex: number; buffer: Buffer; ext: string }> = []

  console.log('[KB] parseDocxWithImagesAsync: starting, buffer size:', buffer.length)
  const result = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.inline((element: any) => {
      console.log('[KB] convertImage callback: contentType=', element.contentType)
      return element.read('base64').then((imgBuffer: Buffer) => {
        const ext = element.contentType?.split('/')[1] || 'png'
        console.log('[KB] image extracted: ext=', ext, 'size=', imgBuffer.length)
        images.push({ chunkIndex: 0, buffer: imgBuffer, ext })
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

  // Distribute images across chunks
  for (let i = 0; i < images.length; i++) {
    images[i].chunkIndex = Math.min(i, chapters.length - 1)
  }

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

  const headingPatterns = [
    /^(#{1,6})\s+(.+)$/,                                          // Markdown
    /^第([一二三四五六七八九十百千]+)[章节篇部]\s*(.*)/,              // 第X章/节/篇
    /^([一二三四五六七八九十]+)[、.．]\s*(.*)/,                     // 一、二、
    /^(\d+)[、.．]\s*(.*)/,                                        // 1、2、
    /^(\d+\.\d+)\s+(.*)/,                                          // 1.1 Title
    /^(\d+\.\d+\.\d+)\s+(.*)/,                                     // 1.1.1 Title
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
        else if (pattern === headingPatterns[4]) headingLevel = 3
        else if (pattern === headingPatterns[5]) headingLevel = 4
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

  if (chapters.length === 0 && text.trim()) {
    chapters.push({ title: '文档内容', content: text.trim(), level: 1 })
  }

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

export async function search(query: string, deviceIds?: string[], topK = 5): Promise<any[]> {
  const db = getDatabase()

  // 1. Extract all ready chunks as virtual index
  let sql = `SELECT c.id, c.document_id, c.chunk_index, c.title, c.content, c.level, c.image_ids,
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

  if (allChunks.length === 0) return []

  // 2. Build virtual index (compact, like INDEX.md)
  const indexLines = allChunks.map((c, i) => {
    let line = `[${i}] 文档: ${c.doc_title} | 章节: ${c.title || '无标题'} | 摘要: ${(c.content || '').slice(0, 80).replace(/\n/g, ' ')}`
    if (c.image_ids) {
      try { line += ` | 包含${JSON.parse(c.image_ids).length}张图片` } catch { /* ignore */ }
    }
    return line
  }).join('\n')

  // 3. AI picks relevant chunks from the index
  const config = getAiConfig()
  if (!config || !config.apiKey) {
    // Fallback: return first topK chunks
    return allChunks.slice(0, topK).map(c => {
      c.document = { id: c.document_id, title: c.doc_title, file_name: c.file_name }
      return c
    })
  }

  const pickPrompt = `你是一个文档检索助手。以下是资料库中所有文档的章节索引。用户提出了一个问题，请从索引中选出与问题最相关的章节。

用户问题：${query}

章节索引：
${indexLines}

请返回最相关的章节编号，用逗号分隔，按相关性从高到低排列。最多返回${topK}个。
如果没有相关章节，返回：none
只返回编号，不要解释。`

  try {
    const response = await callAI(config, [{ role: 'user', content: pickPrompt }])

    if (!response || response.trim().toLowerCase() === 'none') return []

    const indices = response.trim().split(/[,，\s]+/)
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((i: number) => !isNaN(i) && i >= 0 && i < allChunks.length)

    if (indices.length === 0) return allChunks.slice(0, topK).map(c => {
      c.document = { id: c.document_id, title: c.doc_title, file_name: c.file_name }
      return c
    })

    // 4. Return selected chunks with document info and image descriptions
    const db2 = getDatabase()
    return indices.slice(0, topK).map((i: number) => {
      const chunk = allChunks[i]
      chunk.document = { id: chunk.document_id, title: chunk.doc_title, file_name: chunk.file_name }
      // Attach image descriptions for AI context
      if (chunk.image_ids) {
        try {
          const ids = JSON.parse(chunk.image_ids) as string[]
          chunk.images = db2.prepare('SELECT id, description FROM kb_images WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids)
        } catch { chunk.images = [] }
      } else { chunk.images = [] }
      return chunk
    })
  } catch {
    return allChunks.slice(0, topK).map(c => {
      c.document = { id: c.document_id, title: c.doc_title, file_name: c.file_name }
      c.images = []
      return c
    })
  }
}

export async function ragQuery(query: string, deviceIds?: string[], topK = 5): Promise<{ chunks: any[]; images: any[] }> {
  const chunks = await search(query, deviceIds, topK)
  const db = getDatabase()

  const images: any[] = []
  for (const chunk of chunks) {
    if (chunk.image_ids) {
      try {
        const ids = JSON.parse(chunk.image_ids) as string[]
        for (const imgId of ids) {
          const img = db.prepare('SELECT * FROM kb_images WHERE id = ?').get(imgId) as any
          if (img) images.push(img)
        }
      } catch { /* ignore */ }
    }
  }

  return { chunks, images }
}
