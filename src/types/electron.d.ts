export interface AIConfig {
  provider: string
  apiKey: string
  baseUrl: string
  modelName: string
  visionBaseUrl?: string
  visionApiKey?: string
  visionModel?: string
}

export interface AIExecLog {
  id: string
  deviceId: string
  deviceName: string
  command: string
  status: 'approved' | 'rejected' | 'pending' | 'executed' | 'failed'
  mode: 'confirm' | 'auto'
  aiReason: string
  promptText: string
  aiResponse: string
  createdAt: string
}

export interface AISystemLog {
  id: string
  type: string
  status: string
  deviceIds: string
  deviceNames: string
  promptText: string
  aiResponse: string
  parsedResult: string
  errorMessage: string
  createdAt: string
}

export interface ChatMessage {
  id: string
  role: string
  content: string
  deviceId: string | null
  createdAt: string
}

export interface ChatSession {
  id: string
  title: string
  deviceId: string | null
  createdAt: string
}

import type { PaginatedResult } from './pagination'

export interface ElectronAPI {
  auth: {
    login: (u: string, p: string, ck: string, ci: string) => Promise<{ success: boolean; token?: string; error?: string }>
    getCaptchaSvg: () => Promise<{ svg: string; key: string }>
    isFirstRun: () => Promise<boolean>
    initAdmin: (u: string, p: string) => Promise<{ success: boolean; error?: string }>
  }
  device: {
    list: () => Promise<any[]>
    create: (data: any) => Promise<any>
    update: (id: string, data: any) => Promise<any>
    delete: (id: string) => Promise<void>
    getById: (id: string) => Promise<any>
  }
  topology: {
    list: () => Promise<any[]>
    getById: (id: string) => Promise<any>
    create: (data: any) => Promise<any>
    update: (id: string, data: any) => Promise<void>
    delete: (id: string) => Promise<void>
    exportJson: (id: string) => Promise<string>
    importJson: (json: string) => Promise<any>
  }
  connection: {
    sshConnect: (deviceId: string) => Promise<{ sessionId: string }>
    telnetConnect: (deviceId: string) => Promise<{ sessionId: string }>
    rdpConnect: (deviceId: string) => Promise<{ sessionId: string }>
    openWeb: (url: string) => Promise<void>
    disconnect: (sessionId: string) => Promise<void>
    onData: (sid: string, cb: (data: string) => void) => void
    write: (sid: string, data: string) => Promise<void>
    test: (deviceId: string) => Promise<{ success: boolean; message: string }>
  }
  ai: {
    chat: (messages: Array<{ role: string; content: string }>, deviceIds?: string[], sessionId?: string) => Promise<string>
    discoverTopology: (deviceIds: string[]) => Promise<{ nodes: any[]; edges: any[]; failedDevices: Array<{ deviceId: string; deviceName: string; error: string }> }>
    getConfig: () => Promise<AIConfig | null>
    saveConfig: (config: AIConfig) => Promise<void>
    getCommandWhitelist: () => Promise<string[]>
    saveCommandWhitelist: (list: string[]) => Promise<void>
    getExecMode: () => Promise<'confirm' | 'auto'>
    setExecMode: (mode: string, password: string) => Promise<{ success: boolean; error?: string }>
    confirmCommand: (execId: string, approved: boolean) => Promise<string>
    getLogs: (limit?: number) => Promise<AIExecLog[]>
    getChatHistory: () => Promise<ChatMessage[]>
    saveMessage: (role: string, content: string, deviceId?: string | null, sessionId?: string | null) => Promise<void>
    clearHistory: () => Promise<void>
    createSession: (title: string, deviceId?: string) => Promise<ChatSession>
    listSessions: () => Promise<ChatSession[]>
    getSessionMessages: (sessionId: string) => Promise<ChatMessage[]>
    deleteSession: (sessionId: string) => Promise<void>
    updateSessionTitle: (sessionId: string, title: string) => Promise<void>
    getSystemLogs: (limit?: number) => Promise<AISystemLog[]>
  }
  kb: {
    uploadBuffer: (buffer: ArrayBuffer, fileName: string, fileType: string, fileSize: number, category: string, deviceId: string | null) => Promise<any>
    listDocuments: (deviceId?: string, category?: string) => Promise<any[]>
    deleteDocument: (docId: string) => Promise<void>
    getDocument: (docId: string) => Promise<any>
    getStatus: (docId: string) => Promise<any>
    reprocess: (docId: string) => Promise<any>
    search: (query: string, deviceIds?: string[], topK?: number) => Promise<any[]>
    updateChunk: (chunkId: string, title: string, content: string) => Promise<void>
    deleteChunk: (chunkId: string) => Promise<void>
    mergeChunks: (chunkIds: string[], newTitle: string) => Promise<string>
    splitChunk: (chunkId: string, splitPosition: number, title1: string, title2: string) => Promise<string[]>
    getImageData: (imagePath: string) => Promise<string | null>
  }
  network: {
    getAll: () => Promise<any[]>
    getById: (id: number) => Promise<any>
    create: (data: any) => Promise<any>
    update: (data: any) => Promise<any>
    delete: (id: number) => Promise<void>
    autoDiscover: () => Promise<any[]>
    getIPUsage: (networkId: number) => Promise<any>
    // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
    getIPDetails: (networkId: number, searchIp?: string, searchMac?: string, sortBy?: string, sortOrder?: string, limit?: number, offset?: number) => Promise<PaginatedResult<any>>
  }
  anomaly: {
    // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
    getChanges: (unacknowledgedOnly?: boolean, limit?: number, offset?: number) => Promise<PaginatedResult<any>>
    acknowledge: (id: number, notes?: string) => Promise<void>
    acknowledgeAll: () => Promise<number>
    deleteChange: (id: number) => Promise<void>
    deleteChanges: (ids: number[]) => Promise<void>
    getStats: () => Promise<any>
    getBindingHistory: (ip: string) => Promise<any[]>
    getExcludedIPs: () => Promise<any[]>
    addExcludedIP: (data: any) => Promise<any>
    deleteExcludedIP: (id: number) => Promise<void>
  }
  oui: {
    // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
    getAll: (limit?: number, offset?: number) => Promise<PaginatedResult<any>>
    search: (keyword: string) => Promise<any[]>
    getById: (id: number) => Promise<any>
    add: (data: any) => Promise<any>
    addBatch: (entries: any[]) => Promise<number>
    update: (data: any) => Promise<any>
    delete: (id: number) => Promise<void>
    deleteBatch: (ids: number[]) => Promise<void>
    getVendor: (mac: string) => Promise<string | null>
    getAllVendors: () => Promise<any[]>
    getStats: () => Promise<any>
  }
}

export interface TerminalAPI {
  onData: (cb: (data: string) => void) => void
  write: (data: string) => Promise<void>
}

declare global {
  interface Window {
    api: ElectronAPI
    terminalApi: TerminalAPI
  }
}
