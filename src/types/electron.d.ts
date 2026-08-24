import type { PaginatedResult } from './pagination'
import type { Device, CreateDeviceDTO, UpdateDeviceDTO } from './device'
import type { Topology, TopologySummary } from './topology'
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
  // WR-04 fix（Phase 22 code-review）：main 侧 v18/v19 已放宽三档（createLog mode:'smart' 实际会发生）
  mode: 'confirm' | 'smart' | 'auto'
  aiReason: string
  promptText: string
  aiResponse: string
  // Phase 27（27-02 getLogs 投影 / 27-04 消费）：越权命中与人机处理结果
  guardHits: Array<{ ruleId: string; level: 'red' | 'yellow'; target: string; explanation: string }> | null
  guardOutcome: string | null
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
    // Phase 25（25-03，ASSET-04；25-05 移除批量创建）：查重预检 / 存量重名分组
    checkName: (name: string, excludeId?: string) => Promise<{ name: string; ipAddress: string } | null>
    listDuplicates: () => Promise<Array<{
      nameHash: string
      devices: Array<{ id: string; name: string; ipAddress: string; model: string; vendor: string }>
    }>>
  }
  topology: {
    // Phase 19 WR-01：列表走摘要类型（P14 全字段 optional，兼容持久化历史 JSON 缺字段的行）
    list: () => Promise<TopologySummary[]>
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
    // Phase 22（22-03/22-05，D-03）：main→renderer 工具结果推送订阅（返回解绑函数）
    onToolResult: (cb: (payload: unknown) => void) => () => void
    discoverTopology: (deviceIds: string[]) => Promise<DiscoverResult>
    /** Phase 28（28-04，AGENT-05/D-06）：停止 AI 对话（main 侧 AbortController 断 LLM fetch + 循环中止） */
    cancelChat: () => Promise<{ success: boolean; error?: string }>
    getConfig: () => Promise<AIConfig | null>
    saveConfig: (config: AIConfig) => Promise<void>
    getCommandWhitelist: () => Promise<string[]>
    saveCommandWhitelist: (list: string[]) => Promise<void>
    getExecMode: () => Promise<'confirm' | 'smart' | 'auto'>
    setExecMode: (mode: string, password: string) => Promise<{ success: boolean; error?: string }>
    // 28-06 缺陷④：getMcpMaxRounds/setMcpMaxRounds 退役（MCP 调用并入 agent 步数硬顶）
    // Phase 28（28-05，D-04）：Agent 硬顶三参数（步数 1-30 默认 12 / 熔断 1-5 默认 2 / 冷却 10-600s 默认 60）
    getAgentMaxRounds: () => Promise<number>
    setAgentMaxRounds: (rounds: number) => Promise<{ success: boolean; error?: string }>
    getAgentBurnoutCount: () => Promise<number>
    setAgentBurnoutCount: (count: number) => Promise<{ success: boolean; error?: string }>
    getAgentCooldownSecs: () => Promise<number>
    setAgentCooldownSecs: (secs: number) => Promise<{ success: boolean; error?: string }>
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
  // FE-02 (05-04)：kb.* 通道已全量收类型（05-01 的宽返回已在 05-04 收窄，DTO 见 src/types/kb.ts）
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
  // Phase 20 (20-03)：prompt.* 通道（promptIpc 四 secure handler，preload 透传）。
  // PromptEntryView/PromptDiffBase 与 electron/services/promptService.ts 接口镜像（IPC 边界无 _enc 列）。
  prompt: {
    list: () => Promise<PromptEntryView[]>
    save: (id: string, content: string) => Promise<{ ok: true } | { ok: false; error: string }>
    reset: (id: string) => Promise<{ ok: true }>
    keepMine: (id: string) => Promise<{ ok: true }>
    diff: (id: string) => Promise<PromptDiffBase>
  }
  // Phase 21 (21-02)：mcp.* 通道（mcpIpc 四 secure handler，preload 透传）。
  // 出口只含 Masked 凭证（****尾4），永无明文/密文（T-21-02-01）。
  mcp: {
    list: () => Promise<McpConfigDto[]>
    save: (dto: McpSaveDto) => Promise<{ ok: true; config: McpConfigDto } | { ok: false; error: string }>
    delete: (id: number) => Promise<{ ok: true } | { ok: false; error: string }>
    setEnabled: (id: number, enabled: boolean) => Promise<{ ok: true }>
    testConnection: (payload: McpTestRequestDto) => Promise<McpTestResultDto>
    cancelTest: (testId: string) => Promise<{ ok: boolean }>
    /** 订阅连接测试阶段进度，返回清理函数 */
    onTestProgress: (cb: (data: McpTestProgressDto) => void) => () => void
    // Phase 22 (22-01)：工具级策略通道（skipConfirmEligible 由 main 侧只读判定下发）
    getToolCache: (configId: number) => Promise<McpToolCacheDto[]>
    setToolEnabled: (configId: number, toolName: string, enabled: boolean) => Promise<{ ok: true }>
    setToolSkipConfirm: (configId: number, toolName: string, skip: boolean) =>
      Promise<{ ok: true } | { ok: false; reason: string }>
    // Phase 29（29-03/29-05，PKG-01/03）：包生命周期通道（出口投影无明文凭证，T-29-05-02）
    importPackage: (buffer: ArrayBuffer) => Promise<McpImportOutcomeDto>
    reimportPackage: (buffer: ArrayBuffer) => Promise<McpImportOutcomeDto>
    confirmOverwrite: (packageId: number, buffer: ArrayBuffer) => Promise<McpOverwriteOutcomeDto>
    listPackages: () => Promise<McpPackageViewDto[]>
    getPackage: (id: number) => Promise<{ ok: true; package: McpPackageDetailDto } | { ok: false; error: string }>
    getPackageDeleteImpact: (id: number) => Promise<{ ok: true; impact: McpPackageDeleteImpactDto } | { ok: false; error: string }>
    deletePackage: (id: number) => Promise<{ ok: true } | { ok: false; error: string }>
    testPackage: (payload: { packageId: number, testId?: string }) =>
      Promise<{ ok: boolean; error?: string; extraTools?: string[]; missingTools?: string[] }>
    // 29-06（PKG-05）：从包创建配置通道（型号预筛 + 批量绑定）
    listMatchedDevices: (packageId: number) =>
      Promise<{ ok: true; devices: McpMatchedDeviceDto[] } | { ok: false; error: string }>
    createConfigsFromPackage: (
      packageId: number,
      deviceEnvs: Array<{ deviceId: string; name?: string; env: Record<string, string> }>
    ) => Promise<{ ok: true; created: number } | { ok: false; error: string }>
    /** 29-07（Gap-2）：单条配置绑定 N 台设备（每台独立 env，Gap-5 键名放开） */
    createConfigFromPackage: (
      packageId: number,
      name: string,
      deviceEnvs: Array<{ deviceId: string; env: Record<string, string> }>
    ) => Promise<{ ok: true; configId: number } | { ok: false; error: string }>
    /** D-10：导出 .mcpb 格式说明到用户选择路径 */
    exportFormatSpec: () => Promise<{ ok: true; canceled: boolean; path?: string } | { ok: false; error: string }>
    /** 订阅包自动测阶段进度，返回清理函数 */
    onPackageTestProgress: (cb: (data: McpPackageTestProgressDto) => void) => () => void
  }
}

// Phase 21 (21-04)：连接测试请求——temp 携带表单未保存明文凭证（单向即抛即用，响应永不回含）
export interface McpTestRequestDto {
  /** 随机串（renderer 生成），进度事件/取消均按 testId 对应 */
  testId: string
  /** 已存配置 id（行操作「测试」/编辑表单测试时携带，结果落库 D-09） */
  configId?: number | null
  /** 表单未保存值；env 值哨兵 '****__unchanged__' 表示沿用已存明文 */
  temp?: {
    type: 'stdio' | 'http'
    commandOrUrl?: string
    args?: string[]
    env?: Record<string, string>
    credential?: string
  } | null
}

/** 阶段进度事件（T-21-04-04：仅数据字段，无凭证） */
export interface McpTestProgressDto {
  testId: string
  stage: 'starting' | 'handshake' | 'listing'
  elapsedMs: number
}

export interface McpToolInfoDto {
  name: string
  description?: string
  inputSchema: unknown
  annotations?: unknown
}

/** 连接测试结果（无任何凭证回传字段——T-21-04-01） */
export type McpTestResultDto =
  | { ok: true; protocolVersion: string | undefined; tools: McpToolInfoDto[] }
  | { ok: false; error: { code: string; reason: string; errno?: string | number } }

/** Phase 22 (22-01)：工具清单 + 策略行（skipConfirmEligible 为 main 侧判定结果，renderer 只消费） */
export interface McpToolCacheDto {
  name: string
  description?: string
  annotations?: { readOnlyHint?: boolean }
  inputSchema?: unknown
  enabled: 0 | 1
  skipConfirm: 0 | 1
  skipConfirmEligible: boolean
  /** 22-04：名字命中本地只读正则（展示层「已验证只读」两档 Tag，纯展示，不影响可勾性） */
  verifiedReadOnly: boolean
}

// Phase 21：MCP 配置视图（mcpService.McpConfigView 的 renderer 镜像）
export interface McpConfigDto {
  id: number
  name: string
  type: 'stdio' | 'http'
  commandOrUrl: string
  args: string[]
  credentialMasked: string | null
  envKeysMasked: string[]
  deviceIds: string[]
  deviceNames: string[]
  enabled: boolean
  source: string
  lastTestAt: string | null
  lastTestStatus: string | null
  lastTestToolCount: number | null
  /** 29-06（D-16）：每台绑定设备 env 键值脱敏回显（"KEY=****尾4"，永无明文） */
  deviceEnvMasked: Record<string, string[]>
}

export interface McpSaveDto {
  id?: number | null
  name: string
  type: 'stdio' | 'http'
  commandOrUrl: string
  args?: string[]
  env?: Record<string, string> | null
  credential?: string | null
  deviceIds?: string[]
  /** 29-06（D-16）：设备级 env（哨兵 '****__unchanged__' 沿用该设备已存明文；'' 删除该键） */
  deviceEnvs?: Array<{ deviceId: string; env: Record<string, string> }> | null
  enabled?: boolean
}

/** 29-06：型号预筛设备行（无凭证字段；matchedModel/boundConfigName 仅 UI 预勾选/灰显标注） */
export interface McpMatchedDeviceDto {
  deviceId: string
  name: string
  model: string | null
  matchedModel: string | null
  boundConfigName: string | null
}

// Phase 29：MCP 包视图（mcpPackageService.McpPackageView 的 renderer 镜像——仅 env 键名，无明文值）
export interface McpPackageViewDto {
  id: number
  name: string
  version: string | null
  runtime: 'node' | 'python'
  entry: string
  models: string[]
  toolCount: number
  envKeys: string[]
  dirPath: string
  sizeBytes: number
  disabled: boolean
  lastTest: McpPackageLastTestDto | null
  createdAt: string
  updatedAt: string
}

export interface McpPackageLastTestDto {
  stage: string
  ok: boolean
  reason?: string
  /** PKG-04/D-25：实测多出的未声明工具（默认禁用清单） */
  extraTools: string[]
  missingTools: string[]
  testedAt: string
}

export interface McpPackageToolDto {
  name: string
  description: string
  readOnlyHint?: boolean
}

export interface McpPackageDetailDto extends McpPackageViewDto {
  manifest: {
    name: string
    version: string
    runtime: 'node' | 'python'
    entry: string
    models: string[]
    tools: McpPackageToolDto[]
    envKeys?: string[]
  }
  fingerprintTreeSha256: string
  fingerprintFiles: Array<{ path: string; sha256: string }>
}

/** 五向量校验结果（renderer 直渲染 ✓/✗） */
export interface McpVectorResultDto {
  id: 'manifest-schema' | 'entry-whitelist' | 'zip-slip' | 'double-extension' | 'manifest-lie'
  ok: boolean
  reason?: string
}

export interface McpPackageReimportDiffDto {
  oldVersion: string
  newVersion: string
  oldTreeSha256: string
  newTreeSha256: string
  toolsAdded: string[]
  toolsRemoved: string[]
  env: { kept: string[]; added: string[]; removed: string[] }
}

export type McpImportOutcomeDto =
  | { ok: false; error: string; vectors?: McpVectorResultDto[] }
  | { ok: true; status: 'imported'; package: McpPackageViewDto }
  | { ok: true; status: 'exists'; package: McpPackageViewDto }
  | { ok: true; status: 'changed'; package: McpPackageViewDto; diff: McpPackageReimportDiffDto }

export type McpOverwriteOutcomeDto =
  | { ok: false; error: string; vectors?: McpVectorResultDto[] }
  | { ok: true; status: 'overwritten'; package: McpPackageViewDto; diff: McpPackageReimportDiffDto }
  | { ok: true; status: 'exists'; package: McpPackageViewDto }

export interface McpPackageDeleteImpactDto {
  configs: Array<{ id: number; name: string; deviceCount: number }>
  totalDevices: number
  dirPath: string
}

export interface McpPackageTestProgressDto {
  testId: string
  stage: string
  elapsedMs: number
}

// Phase 20：提示词注册表条目视图（20-01 PromptService.listEntries 返回形态的 renderer 镜像）
export interface PromptEntryView {
  id: string
  group: string
  description: string
  version: number
  defaultContent: string
  overrideContent: string | null
  basedOnVersion: number | null
  /** override 基线落后于 registry 当前版本（D-01 冲突，UI 三选弹窗） */
  conflict: boolean
  safetyCritical: boolean
  requiredVars: string[]
  optionalVars: Array<{ name: string; desc: string }>
}

export interface PromptDiffBase {
  defaultContent: string
  overrideContent: string | null
  basedOnVersion: number | null
  currentVersion: number
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
