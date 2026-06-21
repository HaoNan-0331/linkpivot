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
import { secure } from '../utils/authGuard'

export function registerKbIpc() {
  ipcMain.handle('kb:uploadBuffer', secure((_e, buffer: ArrayBuffer, fileName: string, fileType: string, fileSize: number, category: string, deviceId: string | null) =>
    uploadDocument(Buffer.from(buffer), fileName, fileType, fileSize, category, deviceId)))

  ipcMain.handle('kb:listDocuments', secure((_e, deviceId?: string, category?: string) =>
    listDocuments(deviceId || null, category || null)))

  ipcMain.handle('kb:deleteDocument', secure((_e, docId: string) => deleteDocument(docId)))
  ipcMain.handle('kb:getDocument', secure((_e, docId: string) => getDocument(docId)))
  ipcMain.handle('kb:getStatus', secure((_e, docId: string) => {
    const doc = getDocument(docId)
    if (!doc) return null
    return { id: doc.id, status: doc.status, error_message: doc.error_message, chunk_count: doc.chunk_count }
  }))
  ipcMain.handle('kb:reprocess', secure((_e, docId: string) => reprocessDocument(docId)))
  ipcMain.handle('kb:search', secure((_e, query: string, deviceIds?: string[], topK?: number) => search(query, deviceIds, topK)))
  ipcMain.handle('kb:updateChunk', secure((_e, chunkId: string, title: string, content: string) => updateChunk(chunkId, title, content)))
  ipcMain.handle('kb:deleteChunk', secure((_e, chunkId: string) => deleteChunk(chunkId)))
  ipcMain.handle('kb:mergeChunks', secure((_e, chunkIds: string[], newTitle: string) => mergeChunks(chunkIds, newTitle)))
  ipcMain.handle('kb:splitChunk', secure((_e, chunkId: string, splitPosition: number, title1: string, title2: string) => splitChunk(chunkId, splitPosition, title1, title2)))

  ipcMain.handle('kb:getImageData', secure(async (_e, imagePath: string) => {
    if (!imagePath || typeof imagePath !== 'string') return null
    // 限定只能读取知识库图片目录，防止路径穿越读取任意文件
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
  }))
}
