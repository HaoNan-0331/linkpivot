import { ipcMain } from 'electron'
import fs from 'fs'
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
    if (!fs.existsSync(imagePath)) return null
    const buffer = fs.readFileSync(imagePath)
    const ext = imagePath.split('.').pop()?.toLowerCase() || 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png'
    return `data:${mime};base64,${buffer.toString('base64')}`
  })
}
