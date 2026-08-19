import { contextBridge, ipcRenderer } from 'electron'

const api = {
  auth: {
    login: (u: string, p: string, ck: string, ci: string) => ipcRenderer.invoke('auth:login', u, p, ck, ci),
    getCaptchaSvg: () => ipcRenderer.invoke('auth:getCaptcha'),
    isFirstRun: () => ipcRenderer.invoke('auth:isFirstRun'),
    initAdmin: (u: string, p: string) => ipcRenderer.invoke('auth:initAdmin', u, p),
  },
  device: {
    list: () => ipcRenderer.invoke('device:list'),
    create: (data: unknown) => ipcRenderer.invoke('device:create', data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('device:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('device:delete', id),
    getById: (id: string) => ipcRenderer.invoke('device:getById', id),
  },
  topology: {
    list: () => ipcRenderer.invoke('topology:list'),
    getById: (id: string) => ipcRenderer.invoke('topology:getById', id),
    create: (data: unknown) => ipcRenderer.invoke('topology:create', data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('topology:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('topology:delete', id),
    exportJson: (id: string) => ipcRenderer.invoke('topology:exportJson', id),
    importJson: (data: string) => ipcRenderer.invoke('topology:importJson', data),
  },
  connection: {
    sshConnect: (deviceId: string) => ipcRenderer.invoke('connection:ssh', deviceId),
    telnetConnect: (deviceId: string) => ipcRenderer.invoke('connection:telnet', deviceId),
    rdpConnect: (deviceId: string) => ipcRenderer.invoke('connection:rdp', deviceId),
    openWeb: (url: string) => ipcRenderer.invoke('connection:openWeb', url),
    disconnect: (sessionId: string) => ipcRenderer.invoke('connection:disconnect', sessionId),
    onData: (sid: string, cb: (data: string) => void) => {
      ipcRenderer.on(`connection:data:${sid}`, (_e, data) => cb(data))
    },
    write: (sid: string, data: string) => ipcRenderer.invoke('connection:write', sid, data),
    test: (deviceId: string) => ipcRenderer.invoke('connection:test', deviceId),
  },
  ai: {
    chat: (messages: unknown[], deviceIds?: string[], sessionId?: string) => ipcRenderer.invoke('ai:chat', messages, deviceIds, sessionId),
    // Phase 22（22-03，D-03）：main→renderer 工具结果推送订阅（返回解绑函数）
    onToolResult: (cb: (payload: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on('ai:toolResult', listener as never)
      return () => ipcRenderer.removeListener('ai:toolResult', listener as never)
    },
    discoverTopology: (deviceIds: string[]) => ipcRenderer.invoke('ai:discoverTopology', deviceIds),
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    saveConfig: (config: unknown) => ipcRenderer.invoke('ai:saveConfig', config),
    getCommandWhitelist: () => ipcRenderer.invoke('ai:getCommandWhitelist'),
    saveCommandWhitelist: (list: string[]) => ipcRenderer.invoke('ai:saveCommandWhitelist', list),
    getExecMode: () => ipcRenderer.invoke('ai:getExecMode'),
    setExecMode: (mode: string, password: string) => ipcRenderer.invoke('ai:setExecMode', mode, password),
    // 22-05 checkpoint：MCP 轮次上限读写
    getMcpMaxRounds: () => ipcRenderer.invoke('ai:getMcpMaxRounds'),
    setMcpMaxRounds: (rounds: number) => ipcRenderer.invoke('ai:setMcpMaxRounds', rounds),
    confirmCommand: (execId: string, approved: boolean) => ipcRenderer.invoke('ai:confirmCommand', execId, approved),
    getLogs: (limit?: number) => ipcRenderer.invoke('ai:getLogs', limit),
    getChatHistory: () => ipcRenderer.invoke('ai:getChatHistory'),
    saveMessage: (role: string, content: string, deviceId?: string | null, sessionId?: string | null) => ipcRenderer.invoke('ai:saveMessage', role, content, deviceId, sessionId),
    createSession: (title: string, deviceId?: string) => ipcRenderer.invoke('ai:createSession', title, deviceId),
    listSessions: () => ipcRenderer.invoke('ai:listSessions'),
    getSessionMessages: (sessionId: string) => ipcRenderer.invoke('ai:getSessionMessages', sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('ai:deleteSession', sessionId),
    updateSessionTitle: (sessionId: string, title: string) => ipcRenderer.invoke('ai:updateSessionTitle', sessionId, title),
    getSystemLogs: (limit?: number) => ipcRenderer.invoke('ai:getSystemLogs', limit),
  },
  arp: {
    collectFromDevice: (deviceId: string) => ipcRenderer.invoke('arp:collectFromDevice', deviceId),
    collectFromAll: () => ipcRenderer.invoke('arp:collectFromAll'),
  },
  network: {
    getAll: () => ipcRenderer.invoke('network:getAll'),
    getById: (id: number) => ipcRenderer.invoke('network:getById', id),
    create: (data: unknown) => ipcRenderer.invoke('network:create', data),
    update: (data: unknown) => ipcRenderer.invoke('network:update', data),
    delete: (id: number) => ipcRenderer.invoke('network:delete', id),
    autoDiscover: () => ipcRenderer.invoke('network:autoDiscover'),
    getIPUsage: (networkId: number) => ipcRenderer.invoke('network:getIPUsage', networkId),
    getIPDetails: (networkId: number, searchIp?: string, searchMac?: string, sortBy?: string, sortOrder?: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('network:getIPDetails', networkId, searchIp, searchMac, sortBy, sortOrder, limit, offset),
  },
  anomaly: {
    getChanges: (unacknowledgedOnly?: boolean, limit?: number, offset?: number) => ipcRenderer.invoke('anomaly:getChanges', unacknowledgedOnly, limit, offset),
    acknowledge: (id: number, notes?: string) => ipcRenderer.invoke('anomaly:acknowledge', id, notes),
    acknowledgeAll: () => ipcRenderer.invoke('anomaly:acknowledgeAll'),
    deleteChange: (id: number) => ipcRenderer.invoke('anomaly:deleteChange', id),
    deleteChanges: (ids: number[]) => ipcRenderer.invoke('anomaly:deleteChanges', ids),
    getStats: () => ipcRenderer.invoke('anomaly:getStats'),
    getBindingHistory: (ip: string) => ipcRenderer.invoke('anomaly:getBindingHistory', ip),
    getExcludedIPs: () => ipcRenderer.invoke('anomaly:getExcludedIPs'),
    addExcludedIP: (data: unknown) => ipcRenderer.invoke('anomaly:addExcludedIP', data),
    deleteExcludedIP: (id: number) => ipcRenderer.invoke('anomaly:deleteExcludedIP', id),
  },
  oui: {
    getAll: (limit?: number, offset?: number) => ipcRenderer.invoke('oui:getAll', limit, offset),
    search: (keyword: string) => ipcRenderer.invoke('oui:search', keyword),
    getById: (id: number) => ipcRenderer.invoke('oui:getById', id),
    add: (data: unknown) => ipcRenderer.invoke('oui:add', data),
    addBatch: (entries: unknown[]) => ipcRenderer.invoke('oui:addBatch', entries),
    update: (data: unknown) => ipcRenderer.invoke('oui:update', data),
    delete: (id: number) => ipcRenderer.invoke('oui:delete', id),
    deleteBatch: (ids: number[]) => ipcRenderer.invoke('oui:deleteBatch', ids),
    getVendor: (mac: string) => ipcRenderer.invoke('oui:getVendor', mac),
    getAllVendors: () => ipcRenderer.invoke('oui:getAllVendors'),
    getStats: () => ipcRenderer.invoke('oui:getStats'),
  },
  prompt: {
    list: () => ipcRenderer.invoke('prompt:list'),
    save: (id: string, content: string) => ipcRenderer.invoke('prompt:save', id, content),
    reset: (id: string) => ipcRenderer.invoke('prompt:reset', id),
    keepMine: (id: string) => ipcRenderer.invoke('prompt:keepMine', id),
    diff: (id: string) => ipcRenderer.invoke('prompt:diff', id),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    save: (dto: unknown) => ipcRenderer.invoke('mcp:save', dto),
    delete: (id: number) => ipcRenderer.invoke('mcp:delete', id),
    setEnabled: (id: number, enabled: boolean) => ipcRenderer.invoke('mcp:setEnabled', id, enabled),
    testConnection: (payload: unknown) => ipcRenderer.invoke('mcp:testConnection', payload),
    cancelTest: (testId: string) => ipcRenderer.invoke('mcp:cancelTest', testId),
    // 22-01 工具级策略通道（skipConfirmEligible 由 main 侧判定下发，renderer 不自带规则）
    getToolCache: (configId: number) => ipcRenderer.invoke('mcp:getToolCache', configId),
    setToolEnabled: (configId: number, toolName: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:setToolEnabled', configId, toolName, enabled),
    setToolSkipConfirm: (configId: number, toolName: string, skip: boolean) =>
      ipcRenderer.invoke('mcp:setToolSkipConfirm', configId, toolName, skip),
    // 订阅连接测试阶段进度，返回清理函数（T-21-04-04）
    onTestProgress: (cb: (data: { testId: string; stage: string; elapsedMs: number }) => void) => {
      const listener = (_e: unknown, data: { testId: string; stage: string; elapsedMs: number }) => cb(data)
      ipcRenderer.on('mcp:testProgress', listener)
      return () => ipcRenderer.removeListener('mcp:testProgress', listener)
    },
  },
  export: {
    arpTable: () => ipcRenderer.invoke('export:arpTable'),
    changes: (unacknowledgedOnly?: boolean) => ipcRenderer.invoke('export:changes', unacknowledgedOnly),
    networkUsage: (networkId?: number) => ipcRenderer.invoke('export:networkUsage', networkId),
  },
  scheduler: {
    getConfig: () => ipcRenderer.invoke('scheduler:getConfig'),
    updateConfig: (data: unknown) => ipcRenderer.invoke('scheduler:updateConfig', data),
    runNow: () => ipcRenderer.invoke('scheduler:runNow'),
    getStatus: () => ipcRenderer.invoke('scheduler:getStatus'),
  },
  kb: {
    uploadBuffer: (buffer: ArrayBuffer, fileName: string, fileType: string, fileSize: number, category: string, deviceId: string | null) => ipcRenderer.invoke('kb:uploadBuffer', buffer, fileName, fileType, fileSize, category, deviceId),
    listDocuments: (deviceId?: string, category?: string) => ipcRenderer.invoke('kb:listDocuments', deviceId, category),
    deleteDocument: (docId: string) => ipcRenderer.invoke('kb:deleteDocument', docId),
    getDocument: (docId: string) => ipcRenderer.invoke('kb:getDocument', docId),
    getStatus: (docId: string) => ipcRenderer.invoke('kb:getStatus', docId),
    reprocess: (docId: string) => ipcRenderer.invoke('kb:reprocess', docId),
    search: (query: string, deviceIds?: string[], topK?: number) => ipcRenderer.invoke('kb:search', query, deviceIds, topK),
    updateChunk: (chunkId: string, title: string, content: string) => ipcRenderer.invoke('kb:updateChunk', chunkId, title, content),
    deleteChunk: (chunkId: string) => ipcRenderer.invoke('kb:deleteChunk', chunkId),
    mergeChunks: (chunkIds: string[], newTitle: string) => ipcRenderer.invoke('kb:mergeChunks', chunkIds, newTitle),
    splitChunk: (chunkId: string, splitPosition: number, title1: string, title2: string) => ipcRenderer.invoke('kb:splitChunk', chunkId, splitPosition, title1, title2),
    getImageData: (imagePath: string) => ipcRenderer.invoke('kb:getImageData', imagePath),
  },
  experience: {
    list: (opts?: unknown) => ipcRenderer.invoke('experience:list', opts),
    get: (id: string) => ipcRenderer.invoke('experience:get', id),
    create: (input: unknown) => ipcRenderer.invoke('experience:create', input),
    update: (id: string, fields: unknown) => ipcRenderer.invoke('experience:update', id, fields),
    delete: (id: string) => ipcRenderer.invoke('experience:delete', id),
    invalidate: (id: string) => ipcRenderer.invoke('experience:invalidate', id),
    restore: (id: string) => ipcRenderer.invoke('experience:restore', id),
    relateDevice: (experienceId: string, deviceId: string, relationType?: string) => ipcRenderer.invoke('experience:relateDevice', experienceId, deviceId, relationType),
    unrelateDevice: (experienceId: string, deviceId: string) => ipcRenderer.invoke('experience:unrelateDevice', experienceId, deviceId),
    setDevices: (experienceId: string, deviceIds: string[]) => ipcRenderer.invoke('experience:setDevices', experienceId, deviceIds),
    listByDevice: (deviceId: string, includeInvalid?: boolean) => ipcRenderer.invoke('experience:listByDevice', deviceId, includeInvalid),
    listDevices: (experienceId: string) => ipcRenderer.invoke('experience:listDevices', experienceId),
    summarizeSession: (sessionId: string) => ipcRenderer.invoke('experience:summarizeSession', sessionId),
    // Phase 9 人工确认（review）—— 经 window.api.experience.* 调用，全 secure 包装
    confirmDrafts: (input: unknown) => ipcRenderer.invoke('experience:confirmDrafts', input),
    listDrafts: () => ipcRenderer.invoke('experience:listDrafts'),
    getSessionMessages: (sessionId: string, limit?: number) => ipcRenderer.invoke('experience:getSessionMessages', sessionId, limit),
  },
}

contextBridge.exposeInMainWorld('api', api)
