import type { PaginatedResult } from './pagination'
import type { Device, CreateDeviceDTO, UpdateDeviceDTO } from './device'
import type { Topology } from './topology'
import type { NetworkSegment, IPUsage, IPDetail, CreateNetworkInput, UpdateNetworkInput } from './network'
import type { ARPEntry, ARPCollectionResult, ARPScanProgress } from './arp'
import type { IPMACBinding, IPMACChange, ChangeStats, ExcludedIP, CreateExcludedIPInput } from './anomaly'
import type { OUIRow, CreateOUIInput, UpdateOUIInput, OUIStats, ScheduleConfig, SchedulerStatus, UpdateScheduleInput } from './oui'
import type { ChatMessage, ChatSession, DiscoverResult } from './ai'
import type { KbDocument, KbStatus, KbSearchEnvelope } from './kb'
import type { Experience, ExperienceInput, ExperienceUpdateInput, ExperienceListResult, ExperienceListInput, ExperienceRelatedDevice, DraftingResult, ConfirmDraftsInput, ConfirmDraftsResult, DraftSummary, SessionMessage } from './experience'
// FE-02：ChatMessage/ChatSession 迁至 ./ai（role 收联合类型）。
// re-export 维持既有 `import { ChatMessage } from '@/types/electron'` 调用面
// 不中断（AIPage.tsx 等，FE-01 Wave 2 将迁移导入路径至 @/types/ai）。
export type { ChatMessage, ChatSession }

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

// ARPCollector / schedulerService 共用的批量采集统计结构
// （arpIpc.ts:49-70 / schedulerService.ts:71 的 entries/changes/failures/deprecated）
export interface ARPBatchStats {
  entries: number
  changes: number
  failures: number
  deprecated: number
}

export interface ARPBatchResult {
  results: ARPCollectionResult[]
  stats: ARPBatchStats
}

export interface SchedulerRunResult {
  success: boolean
  message: string
  stats?: { devices: number; entries: number; changes: number }
}

export interface ElectronAPI {
  auth: {
    login: (u: string, p: string, ck: string, ci: string) => Promise<{ success: boolean; token?: string; error?: string }>
    getCaptchaSvg: () => Promise<{ svg: string; key: string }>
    isFirstRun: () => Promise<boolean>
    initAdmin: (u: string, p: string) => Promise<{ success: boolean; error?: string }>
  }
  device: {
    list: () => Promise<Device[]>
    create: (data: CreateDeviceDTO) => Promise<Device>
    update: (id: string, data: UpdateDeviceDTO) => Promise<Device>
    delete: (id: string) => Promise<void>
    getById: (id: string) => Promise<Device | null>
  }
  topology: {
    list: () => Promise<Topology[]>
    getById: (id: string) => Promise<Topology | null>
    create: (data: Partial<Topology>) => Promise<Topology>
    update: (id: string, data: Partial<Pick<Topology, 'nodes' | 'edges'>>) => Promise<void>
    delete: (id: string) => Promise<void>
    exportJson: (id: string) => Promise<string>
    importJson: (json: string) => Promise<Topology>
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
    chat: (messages: Array<{ role: 'user' | 'assistant'; content: string }>, deviceIds?: string[], sessionId?: string) => Promise<string>
    discoverTopology: (deviceIds: string[]) => Promise<DiscoverResult>
    getConfig: () => Promise<AIConfig | null>
    saveConfig: (config: AIConfig) => Promise<void>
    getCommandWhitelist: () => Promise<string[]>
    saveCommandWhitelist: (list: string[]) => Promise<void>
    getExecMode: () => Promise<'confirm' | 'auto'>
    setExecMode: (mode: string, password: string) => Promise<{ success: boolean; error?: string }>
    confirmCommand: (execId: string, approved: boolean) => Promise<string>
    getLogs: (limit?: number) => Promise<AIExecLog[]>
    getChatHistory: () => Promise<ChatMessage[]>
    saveMessage: (role: 'user' | 'assistant', content: string, deviceId?: string | null, sessionId?: string | null) => Promise<void>
    createSession: (title: string, deviceId?: string) => Promise<ChatSession>
    listSessions: () => Promise<ChatSession[]>
    getSessionMessages: (sessionId: string) => Promise<ChatMessage[]>
    deleteSession: (sessionId: string) => Promise<void>
    updateSessionTitle: (sessionId: string, title: string) => Promise<void>
    getSystemLogs: (limit?: number) => Promise<AISystemLog[]>
  }
  // FE-02：补 arp 通道（preload.ts:59-62 已暴露，旧 electron.d.ts 漏标致 ArpTab 用 api:any 绕过）
  arp: {
    collectFromDevice: (deviceId: string) => Promise<ARPCollectionResult>
    collectFromAll: () => Promise<ARPBatchResult>
  }
  // FE-02：补 export 通道（preload.ts:99-103 已暴露，ArpTab/NetworkTab/AnomalyTab 用）
  export: {
    arpTable: () => Promise<string | null>
    changes: (unacknowledgedOnly?: boolean) => Promise<string | null>
    networkUsage: (networkId?: number) => Promise<string | null>
  }
  // FE-02：补 scheduler 通道（preload.ts:104-109 + schedulerIpc.ts:6-19 真实 4 通道，
  // 对齐 SettingsPage.tsx 调用面 getConfig/updateConfig/runNow/getStatus）
  scheduler: {
    getConfig: () => Promise<ScheduleConfig>
    updateConfig: (data: UpdateScheduleInput) => Promise<ScheduleConfig>
    runNow: () => Promise<SchedulerRunResult>
    getStatus: () => Promise<SchedulerStatus>
  }
  // FE-02 (05-04)：kb.* 通道收类型（05-01 保留 Promise<any>，本 plan 接力，DTO 见 src/types/kb.ts）
  kb: {
    uploadBuffer: (buffer: ArrayBuffer, fileName: string, fileType: string, fileSize: number, category: string, deviceId: string | null) => Promise<{ id: string }>
    listDocuments: (deviceId?: string, category?: string) => Promise<KbDocument[]>
    deleteDocument: (docId: string) => Promise<void>
    getDocument: (docId: string) => Promise<KbDocument | null>
    getStatus: (docId: string) => Promise<KbStatus>
    reprocess: (docId: string) => Promise<{ id: string }>
    // TXN-04 (18-01)：search 返回信封（rows + degraded/indexTotal/indexCapped），渲染层读 .rows
    search: (query: string, deviceIds?: string[], topK?: number) => Promise<KbSearchEnvelope>
    updateChunk: (chunkId: string, title: string, content: string) => Promise<void>
    deleteChunk: (chunkId: string) => Promise<void>
    mergeChunks: (chunkIds: string[], newTitle: string) => Promise<string>
    splitChunk: (chunkId: string, splitPosition: number, title1: string, title2: string) => Promise<string[]>
    getImageData: (imagePath: string) => Promise<string | null>
  }
  network: {
    getAll: () => Promise<NetworkSegment[]>
    getById: (id: number) => Promise<NetworkSegment | null>
    create: (data: CreateNetworkInput) => Promise<NetworkSegment>
    update: (data: UpdateNetworkInput) => Promise<NetworkSegment>
    delete: (id: number) => Promise<void>
    autoDiscover: () => Promise<NetworkSegment[]>
    getIPUsage: (networkId: number) => Promise<IPUsage>
    // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
    getIPDetails: (networkId: number, searchIp?: string, searchMac?: string, sortBy?: string, sortOrder?: string, limit?: number, offset?: number) => Promise<PaginatedResult<IPDetail>>
  }
  anomaly: {
    // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
    getChanges: (unacknowledgedOnly?: boolean, limit?: number, offset?: number) => Promise<PaginatedResult<IPMACChange>>
    acknowledge: (id: number, notes?: string) => Promise<void>
    acknowledgeAll: () => Promise<number>
    deleteChange: (id: number) => Promise<void>
    deleteChanges: (ids: number[]) => Promise<void>
    getStats: () => Promise<ChangeStats>
    getBindingHistory: (ip: string) => Promise<IPMACBinding[]>
    getExcludedIPs: () => Promise<ExcludedIP[]>
    addExcludedIP: (data: CreateExcludedIPInput) => Promise<ExcludedIP>
    deleteExcludedIP: (id: number) => Promise<void>
  }
  oui: {
    // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
    // 泛型用 OUIRow（snake_case DB 行，ouiService 未做 camelCase 映射）
    getAll: (limit?: number, offset?: number) => Promise<PaginatedResult<OUIRow>>
    search: (keyword: string) => Promise<OUIRow[]>
    getById: (id: number) => Promise<OUIRow | null>
    add: (data: CreateOUIInput) => Promise<OUIRow>
    addBatch: (entries: CreateOUIInput[]) => Promise<number>
    update: (data: UpdateOUIInput) => Promise<OUIRow>
    delete: (id: number) => Promise<void>
    deleteBatch: (ids: number[]) => Promise<void>
    getVendor: (mac: string) => Promise<string | null>
    // ouiService.getAllVendors 返回 string[]（vendor_name 列，未包对象）
    getAllVendors: () => Promise<string[]>
    getStats: () => Promise<OUIStats>
  }
  // Phase 7 (07-02)：experience.* 通道收类型（全 secure 包装，channel 命名遵循全仓 camelCase 约定）。
  // experience:listDevices 返 ExperienceRelatedDevice[]（IPC 边界已剥离所有 `_enc` 后缀密文列，SEC-02）。
  experience: {
    list: (opts?: ExperienceListInput) => Promise<ExperienceListResult>
    get: (id: string) => Promise<Experience | null>
    create: (input: ExperienceInput) => Promise<Experience>
    update: (id: string, fields: ExperienceUpdateInput) => Promise<Experience>
    delete: (id: string) => Promise<void>
    invalidate: (id: string) => Promise<Experience>
    restore: (id: string) => Promise<Experience>
    relateDevice: (experienceId: string, deviceId: string, relationType?: string) => Promise<void>
    unrelateDevice: (experienceId: string, deviceId: string) => Promise<void>
    setDevices: (experienceId: string, deviceIds: string[]) => Promise<void>
    listByDevice: (deviceId: string, includeInvalid?: boolean) => Promise<Experience[]>
    listDevices: (experienceId: string) => Promise<ExperienceRelatedDevice[]>
    summarizeSession: (sessionId: string) => Promise<DraftingResult>
    // Phase 9 人工确认（review）—— 三向一致：channel 名 = preload invoke = 此处方法名（逐字）
    confirmDrafts: (input: ConfirmDraftsInput) => Promise<ConfirmDraftsResult>
    listDrafts: () => Promise<DraftSummary[]>
    getSessionMessages: (sessionId: string, limit?: number) => Promise<SessionMessage[]>
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
