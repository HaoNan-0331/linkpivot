import { ipcMain } from 'electron'
import {
  uploadDocument,
  listDocuments,
  deleteDocument,
  getDocument,
  reprocessDocument,
  search,
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
}
