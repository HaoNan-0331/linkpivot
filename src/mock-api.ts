// Mock window.api for browser-based testing
// This file is only loaded when running outside Electron
if (!(window as any).api) {
  console.log('[mock] Injecting mock window.api')

  // Persistent stores via localStorage
  const load = <T>(key: string, fallback: T): T => {
    try { const d = localStorage.getItem('mock_' + key); return d ? JSON.parse(d) : fallback } catch { return fallback }
  }
  const save = (key: string, val: any) => { try { localStorage.setItem('mock_' + key, JSON.stringify(val)) } catch {} }

  let users = load<{ id: string; username: string; password: string }[]>('users', [])
  let devices = load<any[]>('devices', [])
  let topologies = load<any[]>('topologies', [])
  let commandWhitelist = load<string[]>('whitelist', ['display', 'show', 'enable', 'system-view', 'quit', 'ping', 'traceroute', 'terminal'])
  let execLogs = load<any[]>('execLogs', [])
  let chatHistory = load<any[]>('chatHistory', [])
  let systemLogs = load<any[]>('systemLogs', [])
  let aiConfig = load<any>('aiConfig', null)
  let execMode = load<string>('execMode', 'confirm')
  let mcpMaxRounds = load<number>('mcpMaxRounds', 5)
  let adminInitialized = load<boolean>('adminInit', false)

  let currentUser: any = null
  void currentUser

  ;(window as any).api = {
    auth: {
      login: async (u: string, p: string, _ck: string, _ci: string) => {
        if (!adminInitialized) return { success: false, error: '请先初始化管理员' }
        const user = users.find(x => x.username === u && x.password === p)
        if (!user) return { success: false, error: '用户名或密码错误' }
        currentUser = user
        return { success: true }
      },
      getCaptchaSvg: async () => {
        return { svg: '<svg><text x="0" y="20" font-size="24">TEST</text></svg>', key: 'mock-key' }
      },
      isFirstRun: async () => !adminInitialized,
      initAdmin: async (u: string, p: string) => {
        users.push({ id: '1', username: u, password: p })
        adminInitialized = true
        save('users', users)
        save('adminInit', true)
        return { success: true }
      },
    },
    device: {
      list: async () => devices.map(d => ({ ...d })),
      create: async (data: any) => {
        const dev = { id: 'dev-' + Date.now(), ...data, createdAt: new Date().toISOString() }
        devices.push(dev); save('devices', devices)
        return dev
      },
      update: async (id: string, data: any) => {
        const idx = devices.findIndex(d => d.id === id)
        if (idx >= 0) { Object.assign(devices[idx], data); save('devices', devices) }
        return { success: true }
      },
      delete: async (id: string) => {
        devices = devices.filter(d => d.id !== id); save('devices', devices)
        return { success: true }
      },
      getById: async (id: string) => devices.find(d => d.id === id) || null,
    },
    topology: {
      list: async () => topologies.map(t => ({ id: t.id, name: t.name })),
      getById: async (id: string) => topologies.find(t => t.id === id) || null,
      create: async (data: any) => {
        const topo = { id: 'topo-' + Date.now(), name: data.name, nodes: [], edges: [], status: 'active', createdAt: new Date().toISOString() }
        topologies.push(topo); save('topologies', topologies)
        return topo
      },
      update: async (id: string, data: any) => {
        const idx = topologies.findIndex(t => t.id === id)
        if (idx >= 0) { Object.assign(topologies[idx], data); save('topologies', topologies) }
        return { success: true }
      },
      delete: async (id: string) => {
        topologies = topologies.filter(t => t.id !== id); save('topologies', topologies)
        return { success: true }
      },
      exportJson: async (id: string) => {
        const t = topologies.find(t => t.id === id)
        return t ? JSON.stringify(t, null, 2) : ''
      },
      importJson: async (jsonStr: string) => {
        const data = JSON.parse(jsonStr)
        const topo = { id: 'topo-' + Date.now(), name: data.name || 'Imported', nodes: data.nodes || [], edges: data.edges || [], status: 'active' }
        topologies.push(topo); save('topologies', topologies)
        return topo
      },
    },
    connection: {
      sshConnect: async (_deviceId: string) => ({ sessionId: 'mock-session' }),
      telnetConnect: async (_deviceId: string) => ({ sessionId: 'mock-session' }),
      openWeb: async (_url: string) => ({ success: true }),
      disconnect: async (_sessionId: string) => ({ success: true }),
      onData: (_sid: string, _cb: (data: string) => void) => {},
      write: async (_sid: string, _data: string) => ({ success: true }),
    },
    ai: {
      chat: async (messages: any[], _deviceId?: string) => {
        const config = aiConfig
        if (!config || !config.apiKey) throw new Error('请先配置 AI 服务（API Key 未设置）')
        // Use Vite proxy to avoid CORS in browser mode
        const apiBase = '/proxy/ai/api/coding/v3'
        const res = await fetch(`${apiBase}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.modelName, messages }),
        })
        if (!res.ok) { const t = await res.text(); throw new Error(`AI API 错误 (${res.status}): ${t}`) }
        const data = await res.json()
        return data.choices?.[0]?.message?.content || ''
      },
      discoverTopology: async (_deviceIds: string[]) => ({ nodes: [], edges: [], failedDevices: [] }),
      getConfig: async () => aiConfig ? { ...aiConfig, apiKey: aiConfig.apiKey ? `****${aiConfig.apiKey.slice(-4)}` : '' } : null,
      saveConfig: async (config: any) => {
        // Merge: only overwrite non-masked fields
        const merged = { ...aiConfig, ...config }
        // If apiKey looks masked, keep the old one
        if (config.apiKey && config.apiKey.startsWith('****')) {
          merged.apiKey = aiConfig?.apiKey || ''
        }
        aiConfig = merged; save('aiConfig', aiConfig); return { success: true }
      },
      getCommandWhitelist: async () => [...commandWhitelist],
      saveCommandWhitelist: async (list: string[]) => { commandWhitelist = [...list]; save('whitelist', commandWhitelist); return { success: true } },
      getExecMode: async () => execMode,
      setExecMode: async (mode: string, _password: string) => { execMode = mode; save('execMode', execMode); return { success: true } },
      getMcpMaxRounds: async () => mcpMaxRounds,
      setMcpMaxRounds: async (rounds: number) => {
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) return { success: false, error: 'MCP 轮次上限必须在 1-20 之间' }
        mcpMaxRounds = rounds; save('mcpMaxRounds', mcpMaxRounds); return { success: true }
      },
      confirmCommand: async (_execId: string, _approved: boolean) => '命令已执行（模拟）',
      getLogs: async (_limit?: number) => [...execLogs],
      getChatHistory: async () => [...chatHistory],
      saveMessage: async (role: string, content: string, _deviceId?: string | null) => { chatHistory.push({ id: Date.now().toString(), role, content, deviceId: _deviceId || null, createdAt: new Date().toISOString() }); save('chatHistory', chatHistory) },
      createSession: async (title: string) => ({ id: 's-' + Date.now(), title, deviceId: null, createdAt: new Date().toISOString() }),
      listSessions: async () => [],
      getSessionMessages: async (_sessionId: string) => [],
      deleteSession: async (_sessionId: string) => {},
      updateSessionTitle: async (_sessionId: string, _title: string) => {},
      getSystemLogs: async (_limit?: number) => [...systemLogs],
    },
  }
}
