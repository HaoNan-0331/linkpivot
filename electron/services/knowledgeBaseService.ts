import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'

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
    try {
      processDocument(id)
    } catch (err: any) {
      db.prepare('UPDATE kb_documents SET status = ?, error_message = ? WHERE id = ?')
        .run('error', err.message, id)
    }
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
  const doc = getDatabase().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) return null

  const chunks = getDatabase()
    .prepare('SELECT id, chunk_index, title, char_count, level FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(docId)
  return { ...doc, chunks }
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
    try {
      processDocument(docId)
    } catch (err: any) {
      db.prepare('UPDATE kb_documents SET status = ?, error_message = ? WHERE id = ?')
        .run('error', err.message, docId)
    }
  })

  return getDocument(docId)
}

// ---------- Document Processing ----------

function processDocument(docId: string): void {
  const db = getDatabase()
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
  if (!doc) throw new Error('文档不存在')

  db.prepare('UPDATE kb_documents SET status = ? WHERE id = ?').run('processing', docId)

  const buffer = fs.readFileSync(doc.file_path)
  let chapters: Array<{ title: string; content: string; level: number }>

  switch (doc.file_type) {
    case 'txt':
      chapters = parseTxt(buffer.toString('utf-8'))
      break
    case 'pdf':
      throw new Error('PDF 解析将在阶段2实现')
    case 'docx':
      throw new Error('Word 解析将在阶段2实现')
    default:
      throw new Error(`不支持的文件类型: ${doc.file_type}`)
  }

  // Save chunks
  const insertChunk = db.prepare(`
    INSERT INTO kb_chunks (id, document_id, chunk_index, title, content, level, char_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction(() => {
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i]
      insertChunk.run(uuidv4(), docId, i, ch.title, ch.content, ch.level, ch.content.length)
    }
  })
  insertMany()

  db.prepare('UPDATE kb_documents SET status = ?, chunk_count = ?, updated_at = datetime("now","localtime") WHERE id = ?')
    .run('ready', chapters.length, docId)
}

function parseTxt(text: string): Array<{ title: string; content: string; level: number }> {
  const chapters: Array<{ title: string; content: string; level: number }> = []
  const lines = text.split(/\r?\n/)
  let currentTitle = ''
  let currentContent: string[] = []
  let hasContent = false

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    const numberedMatch = line.match(/^([一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十]+[章节]|[0-9]+[、.．])\s*(.*)$/)

    if (headingMatch || numberedMatch) {
      if (hasContent) {
        chapters.push({
          title: currentTitle || '未命名',
          content: currentContent.join('\n').trim(),
          level: headingMatch ? headingMatch[1].length : 1,
        })
      }
      currentTitle = headingMatch ? headingMatch[2].trim() : line.trim()
      currentContent = [line]
      hasContent = false
    } else {
      currentContent.push(line)
      if (line.trim()) hasContent = true
    }
  }

  if (currentContent.some(l => l.trim())) {
    chapters.push({
      title: currentTitle || '未命名',
      content: currentContent.join('\n').trim(),
      level: 1,
    })
  }

  if (chapters.length === 0 && text.trim()) {
    chapters.push({ title: '文档内容', content: text.trim(), level: 1 })
  }

  // Split oversized chunks (>2000 chars) by paragraphs
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

  return result.length > 0 ? result : [{ title: '文档内容', content: text.trim(), level: 1 }]
}

// ---------- Search ----------

export function search(query: string, deviceIds?: string[], topK = 5): any[] {
  const db = getDatabase()

  const keywords = query
    .replace(/[，。！？、；：""''（）【】《》\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => `"${w}"`)
    .join(' OR ')

  if (!keywords) return []

  const candidateLimit = topK * 3
  let ftsSql = `
    SELECT c.id, c.document_id, c.chunk_index, c.title, c.content, c.level, c.image_ids, rank
    FROM kb_chunks_fts f
    JOIN kb_chunks c ON c.rowid = f.rowid
    WHERE kb_chunks_fts MATCH ?
  `
  const ftsParams: any[] = [keywords]

  if (deviceIds && deviceIds.length > 0) {
    const placeholders = deviceIds.map(() => '?').join(',')
    ftsSql += ` AND c.document_id IN (SELECT id FROM kb_documents WHERE device_id IN (${placeholders}) OR device_id IS NULL)`
    ftsParams.push(...deviceIds)
  }

  ftsSql += ' ORDER BY rank LIMIT ?'
  ftsParams.push(candidateLimit)

  const candidates = db.prepare(ftsSql).all(...ftsParams) as any[]
  if (candidates.length === 0) return []

  // Stage 2: LLM re-rank (Phase 3)
  const results = candidates.slice(0, topK).map(c => ({
    ...c,
    document: db.prepare('SELECT id, title, file_name, category FROM kb_documents WHERE id = ?').get(c.document_id),
  }))

  return results
}

export function ragQuery(query: string, deviceIds?: string[], topK = 5): { chunks: any[]; images: any[] } {
  const chunks = search(query, deviceIds, topK)
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
