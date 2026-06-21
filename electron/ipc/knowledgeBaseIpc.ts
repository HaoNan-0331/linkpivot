import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  uploadDocument,
  listDocuments,
  deleteDocument,
  getDocument,
  reprocessDocument,
  search,
  updateChunk,
  deleteChunk,
  mergeChunks,
  splitChunk,
  imgDir,
} from '../services/knowledgeBaseService'

export function registerKbIpc() {
  ipcMain.handle('kb:uploadBuffer', async (_e, buffer: ArrayBuffer, fileName: string, fileType: string, fileSize: number, category: string, deviceId: string | null) => {
    return uploadDocument(Buffer.from(buffer), fileName, fileType, fileSize, category, deviceId)
  })

  ipcMain.handle('kb:listDocuments', async (_e, deviceId?: string, category?: string) => {
    return listDocuments(deviceId || null, category || null)
  })

  ipcMain.handle('kb:deleteDocument', async (_e, docId: string) => {
    return deleteDocument(docId)
  })

  ipcMain.handle('kb:getDocument', async (_e, docId: string) => {
    return getDocument(docId)
  })

  ipcMain.handle('kb:getStatus', async (_e, docId: string) => {
    const doc = getDocument(docId)
    if (!doc) return null
    return { id: doc.id, status: doc.status, error_message: doc.error_message, chunk_count: doc.chunk_count }
  })

  ipcMain.handle('kb:reprocess', async (_e, docId: string) => {
    return reprocessDocument(docId)
  })

  ipcMain.handle('kb:search', async (_e, query: string, deviceIds?: string[], topK?: number) => {
    return search(query, deviceIds, topK)
  })

  ipcMain.handle('kb:updateChunk', async (_e, chunkId: string, title: string, content: string) => {
    return updateChunk(chunkId, title, content)
  })

  ipcMain.handle('kb:deleteChunk', async (_e, chunkId: string) => {
    return deleteChunk(chunkId)
  })

  ipcMain.handle('kb:mergeChunks', async (_e, chunkIds: string[], newTitle: string) => {
    return mergeChunks(chunkIds, newTitle)
  })

  ipcMain.handle('kb:splitChunk', async (_e, chunkId: string, splitPosition: number, title1: string, title2: string) => {
    return splitChunk(chunkId, splitPosition, title1, title2)
  })

  ipcMain.handle('kb:getImageData', async (_e, imagePath: string) => {
    if (!imagePath || typeof imagePath !== 'string') return null
    // 限定只能读取知识库图片目录，防止路径穿越读取任意文件（.ssh/id_rsa、SQLite 等）
    const base = path.resolve(imgDir())
    const resolved = path.resolve(imagePath)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null
    if (!fs.existsSync(resolved)) return null
    const buffer = fs.readFileSync(resolved)
    // 按文件头魔数探测真实图片类型，防止扩展名伪造
    let mime: string | null = null
    if (buffer.length >= 4) {
      if (buffer[0] === 0xff && buffer[1] === 0xd8) mime = 'image/jpeg'
      else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) mime = 'image/png'
      else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) mime = 'image/gif'
    }
    if (!mime) return null
    return `data:${mime};base64,${buffer.toString('base64')}`
  })
}
