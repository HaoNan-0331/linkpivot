# Phase 5: Frontend Refactor & Types - Pattern Map

**Mapped:** 2026-07-02
**Files analyzed:** 17 (5 待创建新文件 + 12 待修改文件)
**Analogs found:** 17 / 17（所有新文件均有可参照的现有代码；2 个新文件因「项目首次引入该模式」为 partial match，planner 须以决策约束为补充）

> **来源说明：** 本 phase 无 RESEARCH.md（研究跳过）。文件清单与决策约束（D-5-1~D-5-7）全部来自 `05-CONTEXT.md`，代码摘录全部逐字来自当前活代码（带行号），planner 据此写非浅层 task 的 `read_first`。

---

## File Classification

### 待创建新文件（5）

| New File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/components/pages/ai/useAIChat.ts` | hook (page-local state holder) | request-response (IPC) + event-driven (session/message mutations) | (a) `src/components/pages/AIPage.tsx:31-179`（内联 state+handler，待提取）；(b) `src/stores/authStore.ts`（状态组织参照，但 D-5-1 决策**不**用 zustand） | partial（项目首例自定义 hook，无现成 hook 文件；状态组织参照既有 store） |
| `src/components/pages/ai/ChatSessionList.tsx` | component (presentational list) | render-only (props in, callbacks out) | `src/components/ip-management/ArpTab.tsx`（设备列表渲染）+ `AIPage.tsx:198-240`（现有 session 列表 JSX） | role-match（项目无独立 list 子组件先例，借用现有内联列表） |
| `src/components/pages/ai/ChatMessageList.tsx` | component (presentational list) | render-only | `AIPage.tsx:259-324`（现有消息渲染 JSX）+ `KnowledgeBasePage.tsx:31-86` `ChunkContent`（同类「内容+附件渲染」组件） | role-match |
| `src/components/pages/ai/ChatInput.tsx` | component (controlled input) | event-driven (onChange/onPressEnter → callback) | `AIPage.tsx:326-350`（现有 TextArea+Button JSX） | role-match |
| `src/components/pages/ai/CommandConfirmModal.tsx` | component (modal) | event-driven (onOk/onCancel → callback) | `AIPage.tsx:353-396`（现有 confirm Modal JSX）+ `src/components/topology/*Modal.tsx`（既有 Modal 组件模式） | role-match（既有 topology Modal 是独立文件先例） |
| `src/components/pages/kb/imageCache.ts`（或 `src/utils/imageCache.ts`） | utility (module-level LRU + in-flight dedup) | request-response (IPC) + cache | `electron/services/ouiService.ts:6,30-40,43-56`（模块级 `vendorMap` 懒加载缓存 + 优雅降级回退） | role-match（CONVENTIONS §1「静态类缓存例外」是项目唯一现存的模块级缓存先例；renderer 侧无先例，partial） |

> **注：** 上表 6 行 = 5 个新文件（`useAIChat.ts` 单独一行 + 4 子组件分 4 行）。D-5-1 决策 `CommandConfirmModal` 与 3 个 list/input 子组件并列，共 4 个子组件文件。

### 待修改文件（11）

| Modified File | FE | Role | Data Flow | Closest Analog（自身现状） |
|---|---|---|---|---|
| `src/components/pages/AIPage.tsx` | FE-01（独占，FE-02 不触碰） | page (orchestration) | request-response | 自身（拆分对象）；4 处 `any` 由 FE-01 抽 hook 时顺带收敛（D-5-2） |
| `src/components/pages/TopologyPage.tsx` | FE-03（独占） | page (React Flow canvas host) | event-driven (toolbar/flow callbacks) | 自身（ref-mirror 改造对象） |
| `src/stores/topologyToolbarStore.ts` | FE-03 | store (zustand) | pub-sub (callback contract) | 自身（回调契约，已 23 行） |
| `src/components/pages/KnowledgeBasePage.tsx` | FE-02 + FE-04（**同文件禁并行**） | page (CRUD + chunk rendering) | request-response + streaming(poll) | 自身（17 处 any + ChunkContent 图片加载） |
| `src/types/electron.d.ts` | FE-02（foundation，最先做） | config (type contract) | n/a（声明文件） | 自身（26 处 `Promise<any>`）+ `src/types/pagination.ts`（Phase 4 已建 `PaginatedResult<T>` 复用范本） |
| `src/types/device.ts` | FE-02（复用，可能补 DTO） | config (DTO) | n/a | 自身（已 export `Device`/`CreateDeviceDTO`/`ConnectionType` 等） |
| `src/types/topology.ts` | FE-02（复用） | config (DTO) | n/a | 自身（已 export `Topology`/`TopologyNode` 等） |
| `src/types/network.ts` | FE-02（复用） | config (DTO) | n/a | 自身（已 export `NetworkSegment`/`IPDetail`/`IPUsage` 等） |
| `src/types/arp.ts` / `anomaly.ts` / `oui.ts` | FE-02（复用，可能补 Row DTO） | config (DTO) | n/a | 自身（已 export 各 domain interface） |
| `src/components/ip-management/{ArpTab,AnomalyTab,NetworkTab,OuiTab}.tsx` | FE-02（4 文件） | component (Tab) | request-response | 自身（`api: any` props + `: any` state） |
| `src/components/pages/{SettingsPage,DevicesPage}.tsx` | FE-02（2 文件） | page | request-response | 自身（DevicesPage 已 typed，4 处 any 在 catch；SettingsPage 8 处） |

---

## Pattern Assignments

### 1. `src/components/pages/ai/useAIChat.ts` (hook, request-response + event-driven)

**Analog:** `src/components/pages/AIPage.tsx:31-179`（待提取的源）；`src/stores/authStore.ts`（状态组织参照）

**决策约束（D-5-1，必读）：**
- **不用 zustand**（项目 store 既定边界 = 跨组件全局态；AI 会话态 page-local，引入 `aiChatStore` 全局单例无收益且污染全局命名空间）。
- **不用 prop drilling**（10+ state + 6 handler 的宽 prop 面使子组件难独立测试/复用）。
- **hook 契约即类型边界**：`useAIChat()` 返回 typed contract，4 子组件经切片消费——与 FE-02 协同（hook 返回类型即子组件的强类型边界）。

**要提取的 state（10 个，`AIPage.tsx:32-41` 逐字）：**
```typescript
32  const [devices, setDevices] = useState<DeviceOption[]>([])
33  const [selectedDevices, setSelectedDevices] = useState<string[]>([])
34  const [sessions, setSessions] = useState<ChatSession[]>([])
35  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
36  const [messages, setMessages] = useState<ChatMsg[]>([])
37  const [input, setInput] = useState('')
38  const [loading, setLoading] = useState(false)
39  const [configLoading, setConfigLoading] = useState(true)
40  const [hasConfig, setHasConfig] = useState(false)
41  const [pendingConfirm, setPendingConfirm] = useState<ConfirmData | null>(null)
```

**要提取的 handler（7 个，`AIPage.tsx:52-179` 逐字）：**
```typescript
52  async function loadData()
73  async function loadSessions()
87  async function handleNewSession()         // 返回 session（AIPage.tsx:93），hook 须保留返回值
96  async function handleSelectSession(sessionId: string)
104 async function handleDeleteSession(sessionId: string)
118 async function handleSend()               // 含 JSON.parse(reply) 分支：confirm_required / kb_answer / 普通（line 142-159）
167 async function handleConfirm(approved: boolean)
```

**本地 interface（须随 hook 迁移到 hook 文件或 `src/components/pages/ai/types.ts`，planner 裁量）：**
```typescript
9   interface DeviceOption { id: string; name: string; connectionType: string }
15  interface ChatMsg { id?: string; role: 'user' | 'assistant'; content: string; createdAt?: string;
                       references?: Array<{ docTitle: string; chunkTitle: string; docId: string }> }
23  interface ConfirmData { type: 'confirm_required'; execId: string;
                           commands: Array<{ deviceName: string; command: string }>;
                           rejectedCommands?: Array<{ command: string; reason: string }>; aiExplanation: string }
```

**FE-02 顺带收敛的 any 点位（D-5-2，AIPage 由 FE-01 独占，FE-02 不触碰）：**
```typescript
60    .filter((d: any) => d.connectionType === 'ssh' || d.connectionType === 'telnet')
61    .map((d: any) => ({ id: d.id, name: d.name, connectionType: d.connectionType }))
101   const msgs = await window.api.ai.getSessionMessages(sessionId)
      setMessages(msgs.map((m: ChatMessage) => ({ ... })))  // m: ChatMessage 已声明，但 electron.d.ts ChatMessage.role 是 string（line 39），须收为 'user'|'assistant'
160   } catch (e: any) {                                     // handleSend
175   } catch (e: any) {                                     // handleConfirm
```
> **依赖：** `devices`/`m` 的 `(d: any)` 收敛**依赖 FE-02 先建模 electron.d.ts 的 `device.list()` 返回类型**（当前 `Promise<any[]>`，electron.d.ts:62）。planner 须在 wave 编排上让 electron.d.ts 建模先于/同期于 useAIChat 提取（见 CONTEXT §Integration Points）。

**状态组织参照（authStore.ts:13-42，逐字，注意是「组织参照」非「模式照搬」）：**
```typescript
13  export const useAuthStore = create<AuthState>((set) => ({
14    isLoggedIn: false,
15    isFirstRun: false,
16    token: null,
17    checkFirstRun: async () => {
18      const firstRun = await window.api.auth.isFirstRun()
19      set({ isFirstRun: firstRun })
20    },
21    login: async (username, password, captchaKey, captchaInput) => {
22      const result = await window.api.auth.login(username, password, captchaKey, captchaInput)
23      if (result.success) { set({ isLoggedIn: true, token: result.token! }); return null }
24      return result.error || '登录失败'
25    },
```
> **类比要点：** authStore 展示了「typed state interface + action 方法签名 + `window.api.*` 走 IPC 桥」的组织方式。useAIChat **沿用此组织**（typed contract + action），但**改为 React `useState` 而非 zustand `create`**（D-5-1）。hook 形态参照 React 标准 `useXxx` 命名 + 返回对象切片。

**调用方（AIPage.tsx 拆分后）：** hook 在 AIPage 编排层调用一次，返回值按子组件消费切片下传 prop。

---

### 2. `src/components/pages/ai/ChatSessionList.tsx` (component, render-only)

**Analog:** `src/components/pages/AIPage.tsx:198-240`（待提取的现有 session 列表 JSX，逐字）

**Props 契约（由 useAIChat 返回值切片，FE-02 协同强类型化）：**
- `sessions: ChatSession[]`、`currentSessionId: string | null`
- `onSelect: (id: string) => void`、`onNew: () => void`、`onDelete: (id: string) => void`

**要提取的 JSX（`AIPage.tsx:199-240` 逐字）：**
```tsx
199     <div style={{ width: 220, borderRight: '1px solid #f0f0f0',
200       display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
206       <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
207         <Button block icon={<PlusOutlined />} onClick={handleNewSession}>新建会话</Button>
210       <div style={{ flex: 1, overflowY: 'auto' }}>
212         {sessions.map((session) => (
213           <div key={session.id} onClick={() => handleSelectSession(session.id)}
              style={{ padding: '8px 12px', cursor: 'pointer',
                background: session.id === currentSessionId ? '#e6f7ff' : 'transparent',
                borderLeft: session.id === currentSessionId ? '3px solid #1890ff' : '3px solid transparent',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 13, color: '#333' }}
227             onMouseEnter={(e) => { if (session.id !== currentSessionId) (e.currentTarget.style.background = '#fafafa') }}
228             onMouseLeave={(e) => { if (session.id !== currentSessionId) (e.currentTarget.style.background = 'transparent') }}>
230             <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
231               {session.title}
232             </div>
233             <DeleteOutlined style={{ color: '#999', fontSize: 12, marginLeft: 4, flexShrink: 0 }}
235               onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id) }} />
```

**命名/导出规范（CONVENTIONS §Naming）：** PascalCase + `export default function ChatSessionList(...)`；类型 props 用 `interface ChatSessionListProps {...}`（参照 ArpTab.tsx:5 `interface ArpTabProps { api: any }` 形态，但 props 不用 `any`）。

---

### 3. `src/components/pages/ai/ChatMessageList.tsx` (component, render-only)

**Analog:** `src/components/pages/AIPage.tsx:259-324`（消息渲染 JSX）+ `src/components/pages/KnowledgeBasePage.tsx:31-86` `ChunkContent`（同类「内容+附件」渲染组件结构参照）

**Props 契约：**
- `messages: ChatMsg[]`、`loading: boolean`
- 内部 `chatEndRef = useRef<HTMLDivElement>(null)` + effect 滚动（`AIPage.tsx:42-46` 逐字）：
```tsx
42  const chatEndRef = useRef<HTMLDivElement>(null)
44  useEffect(() => {
45    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
46  }, [messages])
```

**要提取的 JSX（`AIPage.tsx:260-324` 逐字）：** 含空态（RobotOutlined，line 268-272）、消息气泡（line 274-315，按 `msg.role` 区分 user/assistant 样式）、assistant 参考来源（references，line 302-312）、loading 思考中（line 316-322）、`<div ref={chatEndRef} />`（line 323）。

**结构参照（ChunkContent，`KnowledgeBasePage.tsx:54-85`）：** 同类「props in + 内部 useState/useEffect + 纯渲染」的展示型组件模式，无 IPC 调用（区别于 ChunkContent 的图片加载，本组件不直接调 IPC）。

---

### 4. `src/components/pages/ai/ChatInput.tsx` (component, event-driven)

**Analog:** `src/components/pages/AIPage.tsx:326-350`（TextArea + Button JSX，逐字）

**Props 契约：**
- `value: string`、`loading: boolean`
- `onChange: (v: string) => void`、`onSend: () => void`

**要提取的 JSX（`AIPage.tsx:327-350` 逐字）：**
```tsx
327     <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
328       <TextArea value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            autoSize={{ minRows: 1, maxRows: 4 }}
333         onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); handleSend() } }}
339         disabled={loading} />
341       <Button type="primary" icon={<SendOutlined />} onClick={handleSend}
            loading={loading} disabled={!input.trim()}>发送</Button>
```

---

### 5. `src/components/pages/ai/CommandConfirmModal.tsx` (component, modal)

**Analog:** `src/components/pages/AIPage.tsx:353-396`（现有 confirm Modal JSX，逐字）+ `src/components/topology/*Modal.tsx`（既有独立 Modal 文件先例）

**Props 契约：**
- `pendingConfirm: ConfirmData | null`
- `onConfirm: (approved: boolean) => void`

**要提取的 JSX（`AIPage.tsx:354-396` 逐字）：** Modal 标题（`pendingConfirm?.commands?.length`）、footer 双按钮（拒绝/确认）、命令 Tag 列表（line 370-376）、rejectedCommands（line 377-387）、aiExplanation（line 388-393）。

**独立 Modal 文件先例（拓扑模态）：** `src/components/topology/AddDeviceModal.tsx` / `EditNodeModal.tsx` / `ConnectionModal.tsx` 均为独立 default 导出组件 + `open`/`onConfirm`/`onCancel` props 契约——本组件沿用。

---

### 6. `src/components/pages/kb/imageCache.ts` (utility, request-response + cache)

**Analog:** `electron/services/ouiService.ts:4-6,28-40,43-56`（模块级 `vendorMap` 懒加载缓存 + 优雅降级回退 + CONVENTIONS §1 静态类缓存例外）

**决策约束（D-5-5 / D-5-6，必读）：**
- **模块级 LRU（非 per-instance）**：ChunkContent 频繁 re-mount，per-instance 缓存随卸载失效 → 必然重拉。
- **in-flight 去重**：模块级 `Map<file_path, Promise<string>>`，同图并发请求复用同一 Promise。
- **AbortController 客户端取消**（D-5-5）：cleanup 调 `controller.abort()`，替代现状 `cancelled` 标志位（`KnowledgeBasePage.tsx:37,44`）；better-sqlite3 同步读不可真中断，AbortController 落地为「结构化取消标志 + 卸载防 setState」。
- **不改 IPC `kb:getImageData` 签名**（Phase 4 刚稳定 IPC 契约，preload.ts/electron.d.ts 不动）。

**模块级缓存先例（ouiService.ts，逐字）：**
```typescript
4   export class OUIService {
5     // PERF-01 (D-P1)：模块级 vendorMap 懒加载缓存。null = 未预载（启动时 preload() 全量载入）。
6     private static vendorMap: Map<string, string> | null = null
```
**懒加载 + 优雅降级（ouiService.ts:28-40，逐字）：**
```typescript
28    try {
29      const db = getDatabase()
30      const rows = db.prepare('SELECT oui_prefix, vendor_name FROM oui_database').all() as Array<{...}>
30      const map = new Map<string, string>()
31      for (const row of rows) { map.set(this.normalizeMac(row.oui_prefix), row.vendor_name) }
35      this.vendorMap = map
36    } catch (e: any) {
37      // D-P1 优雅降级：预载失败 → vendorMap 保持 null → getVendor 回退查库路径。功能不中断，仅失去优化。
38      this.vendorMap = null
39      console.error('[oui] preload 失败，回退逐行查库:', e.message)
40    }
```
**查询时命中/回退（ouiService.ts:43-56，逐字）：**
```typescript
43    static getVendor(mac: string): string {
44      if (!mac) return 'Unknown'
46      // D-P1：Map 已预载 → O(1) 内存查找；Map 为 null → 回退 prepare().get() 查库路径
47      if (this.vendorMap !== null) { return this.vendorMap.get(oui) || 'Unknown' }
53      const db = getDatabase()
54      const row = db.prepare('SELECT vendor_name FROM oui_database WHERE oui_prefix = ?').get(...)
      return row?.vendor_name || 'Unknown'
56    }
```

**imageCache 应实现的 API 形态（planner 裁量，建议）：**
```typescript
// 模块级（file scope），非 class、非 per-instance
const cache = new Map<string, string>()      // LRU keyed by file_path → base64 data url
const inFlight = new Map<string, Promise<string>>()  // in-flight 去重
export async function getImage(path: string, signal: AbortSignal): Promise<string> { ... }
```

**调用方改造（ChunkContent，`KnowledgeBasePage.tsx:35-45` 逐字现状）：**
```tsx
35    useEffect(() => {
36      if (!images || images.length === 0) return
37      let cancelled = false                                                  // ← FE-04 改为 AbortController
38      Promise.all(images.map(async (img: any) => {                           // ← FE-02 收 img: any → KbImage
39        try {
40          const data = await window.api.kb.getImageData(img.file_path)       // ← FE-04 改为 getImage(img.file_path, signal)
41          if (!cancelled && data) setImgDataMap(prev => ({ ...prev, [img.id]: data }))
42        } catch { /* ignore */ }                                             // ← FRAG-2 顺带：失败 fallback 占位
43      }))
44      return () => { cancelled = true }                                      // ← FE-04 改为 controller.abort()
45    }, [images])
```

**类型协同（D-5-6）：** `images: any[]`（line 31）由 FE-02 收为 `KbImage[]`（在 `src/types/kb.ts` 就近补 `interface KbImage`，D-5-3「缺 DTO 就近补」）。**FE-02 类型化须先于/同期于 FE-04**（同文件 KnowledgeBasePage.tsx，禁并行）。

---

### 7. `src/components/pages/AIPage.tsx` (modified, FE-01 独占)

**改动性质：** 399 行拆分 → 退化为薄编排层（`import useAIChat` + 渲染 4 子组件 + configLoading/hasConfig 守卫保留）。AIPage 的 4 处 `any`（line 60,61,160,175）由 FE-01 提取时顺带收敛（D-5-2）。

**保留的守卫逻辑（`AIPage.tsx:181-194` 逐字）：**
```tsx
181   if (configLoading) {
182     return <div style={{ textAlign: 'center', paddingTop: 100 }}><Spin size="large" /></div>
183   }
185   if (!hasConfig) {
186     return (<div style={{ textAlign: 'center', paddingTop: 100 }}>
188       <ExclamationCircleOutlined style={{ fontSize: 48, color: '#faad14', marginBottom: 16 }} />
189       <div style={{ fontSize: 16, color: '#666' }}>请先在「系统设置」中配置 AI 服务参数</div>
190     </div>)
194   }
```
> `configLoading`/`hasConfig` 属于 page-local（守卫渲染），建议留 AIPage 编排层；`devices`/`selectedDevices`/`sessions`/`messages`/`input`/`loading`/`pendingConfirm` 迁入 useAIChat。planner 裁量切分边界。

---

### 8. `src/components/pages/TopologyPage.tsx` (modified, FE-03 独占)

**改动性质：** ref-mirror 模式（D-5-4），新增 `nodesRef`/`edgesRef`，所有「注册一次但需读最新拓扑」的回调在调用时读 `ref.current`。**不迁 nodes/edges 到 store**（React Flow `useNodesState`/`useEdgesState` 契约不变；迁 store 触及核心价值「拓扑准确呈现」最高优先级面，风险高）。

**stale closure 风险面（精确定位，逐字）：**

(a) **debouncedSave setTimeout 闭包捕获 nodes/edges（`TopologyPage.tsx:72-81`）：**
```tsx
72    const debouncedSave = useCallback(() => {
73      if (!currentTopologyId) return
74      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
75      saveTimerRef.current = setTimeout(() => {
76        window.api.topology.update(currentTopologyId, {
77          nodes: nodes.map((n) => ({ ...n })),       // ← 闭包捕获 nodes（line 78 同理 edges）
78          edges: edges.map((e) => ({ ...e })),
79        })
80      }, 1000)
81    }, [currentTopologyId, nodes, edges])            // ← deps 含 nodes/edges，每次变化重建 callback
```
> **现状靠 line 91 effect deps + line 74 clearTimeout 维持正确，但模式脆弱**（CONTEXT D-5-4）。ref-mirror 后：`nodes.map` → `nodesRef.current.map`，`useCallback` deps 去掉 `nodes`/`edges`。

(b) **saveTopology 同理（`TopologyPage.tsx:62-70`）：**
```tsx
62    const saveTopology = useCallback(async () => {
63      if (!currentTopologyId) return
64      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
65      await window.api.topology.update(currentTopologyId, {
66        nodes: nodes.map((n) => ({ ...n })),         // ← ref-mirror: nodesRef.current
67        edges: edges.map((e) => ({ ...e })),
68      })
69      message.success('保存成功')
70    }, [currentTopologyId, nodes, edges])
```

(c) **toolbar 注册 effect（`TopologyPage.tsx:143-156`）：**
```tsx
143   // Sync toolbar state to sidebar store
144   useEffect(() => {
145     setToolbarState({
146       topologies,
147       currentTopologyId,
148       onTopologyChange: handleTopologyChange,     // ← 这些 callback 若 deps 不全则 stale
149       onNew: handleNew, onSave: saveTopology, onDelete: handleDelete,
152       onImport: handleImport, onExport: handleExport,
153     })
154     return () => setToolbarState(null)
156   }, [topologies, currentTopologyId, handleTopologyChange, handleNew, saveTopology,
       handleDelete, handleImport, handleExport, setToolbarState])
```
> **stale 风险：** effect deps 含全部 callback，callback 变化就重注册——但「注册与调用间的窗口」任何 stale 都风险。ref-mirror 后 callback 读 `nodesRef.current`，deps 可收敛，注册稳定。

(d) **onConnect（`TopologyPage.tsx:158-166, 264`）：**
```tsx
158   const handleConnect = useCallback(
159     (connection: Connection, sourceInterface: string, targetInterface: string) => {
160       const edgeData: TopologyEdgeData = { sourceInterface, targetInterface }
161       setEdges((eds) => addEdge({ ...connection, type: 'edgeWithInterfaces', data: edgeData }, eds))
162     },
163     [setEdges]
164   )
...
264   onConnect={handleConnect}                       // React Flow 注册点
```
> 本 callback 用 `setEdges(eds => ...)` 函数式更新，无 stale 风险——但 `handleDiscoveryConfirm`（line 173-199）读闭包 `nodes`/`edges`（line 176,181-183），是 stale 面。planner 须逐一审查 `useCallback` deps 含 `nodes`/`edges` 的所有点（line 70,81,141,198,228,237）。

**现有 ref 先例（`TopologyPage.tsx:24-25`）：** 项目已用 ref-mirror 模式（`isLoadingRef` 防 effect 重入，line 29/35/84），新增 `nodesRef`/`edgesRef` 与此一致。

---

### 9. `src/stores/topologyToolbarStore.ts` (modified, FE-03)

**全文（23 行，逐字）：** callback 契约 `onSave/onNew/onDelete/onImport/onExport/onTopologyChange`，TopologyPage 注册（`TopologyPage.tsx:144-156`）、Sidebar 消费。FE-03 改造点：**若 planner 选择让 toolbar 回调读 ref**，则 store 契约不变（callback 签名不变，只是 callback 体内读 ref.current）。SC #3 字面「store getState」由 ref-mirror 满足**意图**（CONTEXT §specifics D-5-4）。

```typescript
1   import { create } from 'zustand'
3   interface TopologyToolbarState {
4     topologies: { id: string; name: string; status: string }[]
5     currentTopologyId: string | null
6     onTopologyChange: (id: string | null) => void
7     onNew: (name: string) => void
8     onSave: () => void
9     onDelete: () => void
10    onImport: (jsonStr: string) => void
11    onExport: () => void
12  }
14  interface ToolbarStore {
15    toolbar: TopologyToolbarState | null
16    setToolbar: (state: TopologyToolbarState | null) => void
17  }
19  export const useTopologyToolbarStore = create<ToolbarStore>((set) => ({
20    toolbar: null,
21    setToolbar: (state) => set({ toolbar: state }),
22  }))
```

---

### 10. `src/components/pages/KnowledgeBasePage.tsx` (modified, FE-02 + FE-04 同文件禁并行)

**改动性质：** FE-02 收 17 处 any（含 ChunkContent `images: any[]` → `KbImage[]`）+ FE-04 改 ChunkContent 图片加载为 AbortController + imageCache。

**共享文件约束（CONTEXT §Integration Points，红线）：**
- FE-02 类型化**先于** FE-04 缓存（FE-04 用 FE-02 的 `KbImage` 类型）。
- **禁止并行**——planner 须同 plan 串行或严格分 wave。

**FE-02 典型 any 点位（17 处中的典型，逐字）：**
```tsx
31  function ChunkContent({ content, images }: { content: string; images: any[] })  // ← images: any[] → KbImage[]
38    Promise.all(images.map(async (img: any) => {                                    // ← img: any → KbImage
89  const [documents, setDocuments] = useState<any[]>([])
91  const [devices, setDevices] = useState<any[]>([])
95  const [searchResults, setSearchResults] = useState<any[]>([])
97  const [detailDoc, setDetailDoc] = useState<any>(null)
114     setDocuments(list as any[])                                                   // ← listDocuments 返回 any[]
115   } catch (err) { message.error('加载文档列表失败: ' + (err as Error).message) }   // err: unknown（strict），(err as Error) 可保留或收 unknown
123   window.api.device.list().then(list => setDevices(list as any[]))
179     setSearchResults(results as any[])
211   const startEdit = (chunk: any) => {                                             // ← chunk: any → KbChunk
245     const chunks = detailDoc.chunks.filter((c: any) => selectedChunks.includes(c.id))
385     ...devices.map((d: any) => ({ value: d.id, label: d.name }))
437     {searchResults.map((r: any, i: number) => (
473     detailDoc.chunks?.length > 0 ? detailDoc.chunks.map((c: any) => (
```
> **根因：** 这些 `any` 的源头是 `electron.d.ts` 的 `kb.*` 通道全 `Promise<any>`（line 108-121）+ `device.list: Promise<any[]>`（line 62）。FE-02 必须**先建模 electron.d.ts**，KB 页的 `any[]` 才能引用真实 DTO（D-5-3「复用 src/types DTO，缺 DTO 就近补 interface XxxRow」）。

**FE-04 改造点（见上方 §6 imageCache 的调用方改造）。**

---

### 11. `src/types/electron.d.ts` (modified, FE-02 foundation)

**改动性质：** 26 处 `Promise<any>` 建模为复用 `src/types` DTO。**最先做**（类型流出后所有 call site 受益，CONTEXT §Integration Points）。

**Phase 4 已建的 3 个 PaginatedResult 通道（`electron.d.ts:130-148`，逐字，FE-02 直接复用）：**
```typescript
130   // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
131   getIPDetails: (...) => Promise<PaginatedResult<any>>          // network
134   // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
135     getChanges: (...) => Promise<PaginatedResult<any>>          // anomaly
146   oui: {
147     // DATA-01 / D-4-2: list 通道返回信封 { rows, total, truncated }，渲染层读 .rows
148     getAll: (...) => Promise<PaginatedResult<any>>              // oui
```
> **FE-02 任务：** 将 `PaginatedResult<any>` 的泛型参数 `any` 收为真实 Row 类型（如 `PaginatedResult<IPDetail>` / `PaginatedResult<IPMACChange>` / `PaginatedResult<OUIEntry>`），**复用** src/types DTO。

**未建模的通道（`electron.d.ts:62-159`，FE-02 建模对象）：**
```typescript
62    device: { list: () => Promise<any[]>; create: (data: any) => Promise<any>; update: ...; getById: () => Promise<any> }
68    topology: { list: () => Promise<any[]>; getById: () => Promise<any>; create: ...; update: ...; importJson: () => Promise<any> }
89      discoverTopology: (...) => Promise<{ nodes: any[]; edges: any[]; failedDevices: ... }>   // ai
108   kb: { uploadBuffer / listDocuments / getDocument / getStatus / reprocess / search / getImageData ...全 Promise<any> }
123   network: { getAll / getById / create / update / autoDiscover / getIPUsage ...全 Promise<any> }
133   anomaly: { getStats / getBindingHistory / getExcludedIPs / addExcludedIP ...全 Promise<any> }
146   oui: { search / getById / add / addBatch / update / getAllVendors / getStats ...全 Promise<any> }
```

**建模深度（D-5-3 决策，逐字执行）：**
- **优先复用** src/types 既有 DTO：`Device`（device.ts:4）、`Topology`（topology.ts:23）、`NetworkSegment`（network.ts:1）、`IPDetail`/`IPUsage`（network.ts:22,14）、`IPMACChange`/`ChangeStats`/`ExcludedIP`（anomaly.ts）、`OUIEntry`/`OUIStats`（oui.ts）、`ARPEntry`（arp.ts）。
- **缺 DTO 的 DB row 就近补 `interface XxxRow`**：如 kb 图片行（`KbImage`）、ai 会话/消息行（`ChatSession`/`ChatMessage` 已在 electron.d.ts:37,45，但字段宽松如 `role: string` 须收）、kb 文档行/分块行（`KbDocument`/`KbChunk`）。**不在 electron.d.ts 内联**，补到 `src/types/kb.ts`（新建）/`src/types/ai.ts`（可新建或在 electron.d.ts 旁）。

**验收（D-5-2 grep 基线，红线）：** `grep ": any|as any"` 限定 **`src/` + `src/types/electron.d.ts`** 显著收敛；**不含后端**（后端 276 处不动，verifier 不得用全仓库总数对比）。

---

### 12. `src/types/{device,topology,network,arp,anomaly,oui}.ts` (modified, FE-02 复用 + 可能补 Row DTO)

**现状 export 清单（grep 结果，FE-02 复用基础）：**

| 文件 | export 清单 |
|---|---|
| `device.ts` | `ConnectionType`(1) `DeviceType`(2) `Device`(4) `CreateDeviceDTO`(26) `UpdateDeviceDTO`(42) |
| `topology.ts` | `TopologyNodeData`(4) `TopologyNode`(14) `TopologyEdgeData`(16) `TopologyEdge`(21) `Topology`(23) |
| `network.ts` | `NetworkSegment`(1) `IPUsage`(14) `IPDetail`(22) `CreateNetworkInput`(33) `UpdateNetworkInput`(41) |
| `arp.ts` | `ARPEntry`(1) `ARPCollectionResult`(10) `ARPScanProgress`(20) |
| `anomaly.ts` | `ChangeType`(1) `IPMACBinding`(3) `IPMACChange`(12) `ChangeStats`(24) `ExcludedIP`(32) `CreateExcludedIPInput`(39) |
| `oui.ts` | `OUIEntry`(1) `CreateOUIInput`(10) `UpdateOUIInput`(15) `OUIStats`(21) `ScheduleConfig`(27) `SchedulerStatus`(35) `UpdateScheduleInput`(41) |
| `pagination.ts` | `PaginatedResult<T>`(12)（Phase 4 建） |
| `backup.ts` | `BackupConfig`(5) `BackupStatus`(19) `UpdateBackupInput`(25) |

> **planner 任务：** 评估上述 DTO 是否覆盖 electron.d.ts 所有通道的返回/参数类型；缺的（如 kb 文档/分块/图片行、ai discoverTopology 的 nodes/edges）就近补 `interface XxxRow` 到对应 `<domain>.ts` 或新建 `kb.ts`。

---

### 13. `src/components/ip-management/{ArpTab,AnomalyTab,NetworkTab,OuiTab}.tsx` (modified, FE-02)

**改动性质：** 4 文件，收 `api: any` props + `: any` state + `(e: any)` catch。

**典型点位（逐字）：**

ArpTab.tsx（12 处）：
```tsx
5   interface ArpTabProps { api: any }                  // ← api: ElectronAPI（或切片类型）
9   const [results, setResults] = useState<any[]>([])   // ← ARP 扫描结果行
10  const [stats, setStats] = useState<any>(null)
11  const [devices, setDevices] = useState<any[]>([])   // ← Device[]
16    api.device.list().then((list: any[]) => {          // ← Device[]
17      setDevices(list.filter((d: any) => ...))
28    } catch (e: any) { message.error('采集失败: ' + e.message) }   // ← e: unknown
50    } catch (e: any) { ... }
59    } catch (e: any) { ... }
81      render: (_: any, record: any) => ( ... )        // Table 列 render
141     rowKey={(row: any) => `${row.ip}-${row.mac}`}   // ← ARPEntry
```

AnomalyTab.tsx（5 处）、NetworkTab.tsx（8 处）、OuiTab.tsx（8 处）模式相同：
- `interface XxxTabProps { api: any }` → 收为 `ElectronAPI` 或其切片
- `useState<any[]>` / `useState<any>({})` → 收为对应 DTO（`IPMACChange[]`/`NetworkSegment[]`/`OUIEntry[]` 等，复用 src/types）
- `(e: any)` catch → `unknown`（strict 下 catch 子句默认 unknown，删 `: any` 即可，或保留 `(err as Error)`）
- Table `render: (_: any, record: any)` → 收为行 DTO

**Phase 4 已适配点（保留，勿回退）：** `AnomalyTab.tsx:33` `setChanges(c.rows)`、`NetworkTab.tsx:34,43` `details.rows`、`OuiTab.tsx:23` `setEntries(e.rows)` —— 渲染层已读 `.rows`，FE-02 仅收 `rows` 内元素类型。

---

### 14. `src/components/pages/{SettingsPage,DevicesPage}.tsx` (modified, FE-02)

**DevicesPage.tsx（4 处，部分已 typed）：** 已用 `Device`/`CreateDeviceDTO`（line 5,14,17,28,38,83）；残余 any 在 catch：
```tsx
22  } catch (e: any) { message.error(e.message) }   // load
33  } catch (e: any) { ... }                        // handleCreate
44  } catch (e: any) { ... }                        // handleUpdate
64  } catch (e: any) { ... }                        // handleTest
```
> electron.d.ts 建模后这些 catch 的 `e` 收 `unknown`（删 `: any`），DevicesPage 改动 trivial（D-5-2「顺带清」）。

**SettingsPage.tsx（8 处）：**
```tsx
15  const api = (window as any).api                 // ← 多余，已有 window.api 类型（electron.d.ts:169）；删除此行用 window.api
25  const [schedulerConfig, setSchedulerConfig] = useState<any>({})   // ← SchedulerStatus（oui.ts:35）
26  const [schedulerStatus, setSchedulerStatus] = useState<any>({})
35    } catch (e: any) { ... }
44    } catch { /* ignore */ }                       // 已是 unknown（无标注），保留
65    } catch (e: any) { ... }
76    } catch (e: any) { ... }
86    } catch (e: any) { ... }
96    } catch (e: any) { ... }
```
> **注意：** `scheduler.*` 通道**未在 electron.d.ts 建模**（当前 SettingsPage.tsx:15 用 `(window as any).api` 绕过类型）——FE-02 须在 electron.d.ts 补 `scheduler` 通道建模（复用 oui.ts 的 `ScheduleConfig`/`SchedulerStatus`），否则 SettingsPage 的 `api: any` 无法根除。

---

## Shared Patterns

### 类型契约源头（FE-02 foundation，所有 IPC 调用点共享）
**Source:** `src/types/electron.d.ts`（26 处 `Promise<any>`）
**Apply to:** 所有 `window.api.*` 调用点（AIPage、4 Tab、SettingsPage、DevicesPage、KnowledgeBasePage、TopologyPage）
**约束（D-5-3）：** 复用 src/types DTO，缺 DTO 就近补 `interface XxxRow`，**不重复发明类型**，**不在 electron.d.ts 内联**。electron.d.ts 必须最先做（CONTEXT §Integration Points）。

### 错误处理（catch 子句）
**Source:** 既有 .tsx 全用 `catch (e: any) { message.error(e.message) }`（如 ArpTab.tsx:28）
**Apply to:** 所有 FE-02 收 any 的 catch 点
**决策（D-5-2 离散裁量）：** `catch (e: any)` 改 `catch (e: unknown)` 后 `e.message` 不可直接访问——planner 选 `(e as Error).message` 或 `e instanceof Error ? e.message : String(e)`。strict 模式下 catch 子句默认 unknown，删 `: any` 即编译通过，但 `e.message` 须窄化。DevicesPage/SettingsPage/ArpTab 等全仓库统一此模式。

### React 组件命名/导出
**Source:** CONVENTIONS §Naming/Exports + ArpTab.tsx:5/7、DevicesPage.tsx:13
**Apply to:** 5 个新文件（4 子组件 + useAIChat hook）
**规范：** 组件 PascalCase + `export default function`；hook 用 `export function useXxx`（非 default）；类型 props `interface XxxProps {...}`；导入顺序：第三方 → `import type` → `@/...`（CONVENTIONS §Import Organization）。

### 模块级缓存 + 优雅降级（FE-04）
**Source:** `electron/services/ouiService.ts:4-6,28-40,43-56`（CONVENTIONS §1 静态类缓存例外）
**Apply to:** `src/components/pages/kb/imageCache.ts`
**要点：** 模块级（file scope）`Map` 懒加载、null = 未预载/失败、try/catch 优雅降级回退、注释标 `D-P1`/`D-5-6` 红线编号。**renderer 侧首次引入此模式**（既有只在主进程）。

### ref-mirror（FE-03）
**Source:** `TopologyPage.tsx:24-25`（`saveTimerRef`/`isLoadingRef` 现有先例）
**Apply to:** TopologyPage 全部「注册一次但读最新 nodes/edges」的 callback（debouncedSave/saveTopology/toolbar 注册 effect/handleDiscoveryConfirm 等）
**要点：** 新增 `nodesRef`/`edgesRef` + effect 同步 `ref.current = nodes`；callback 体内读 `ref.current` 而非闭包变量；`useCallback` deps 去掉 `nodes`/`edges`。**不迁 store**（D-5-4 红线）。

### 静态验证三绿门禁（全 FE 验收）
**Source:** CONVENTIONS §TypeScript Strictness + Phase 2/3/4 既定模式
**Apply to:** FE-01/02/03/04 全部
**命令：** `tsc -p tsconfig.web.json`（严格 + noUnusedLocals + noUnusedParameters 全绿）+ electron main esbuild + `vitest run`。FE-01 额外人工 HV（AIPage 4 子组件交互冒烟，D-5-7 不引入组件测试基建）。

---

## No Analog Found

| File | Role | Data Flow | Reason | Planner 补充来源 |
|---|---|---|---|---|
| `src/components/pages/ai/useAIChat.ts` | hook | request-response + event-driven | **项目首例自定义 hook**（无 `src/hooks/` 目录、无既有 hook 文件） | 状态组织参照 `authStore.ts`（CONVENTIONS §State Management），hook 形态用 React 标准；逻辑来源 = AIPage.tsx:31-179 内联 state+handler（已摘录） |
| `src/components/pages/kb/imageCache.ts` | utility (module-level cache) | request-response + cache | **renderer 侧首例模块级缓存**（既有模块级缓存只在主进程 ouiService） | 模式照搬 `ouiService.ts` 的 `vendorMap`（CONVENTIONS §1 静态类缓存例外），改为 renderer file-scope `Map` + AbortSignal；决策约束 D-5-5/D-5-6 |

> 其余 15 个文件均有「自身现状」作精确 analog（修改类文件）或「待提取的现有 JSX」作 analog（4 子组件）。

---

## Metadata

**Analog search scope:** `src/components/pages/`、`src/components/ip-management/`、`src/components/topology/`、`src/stores/`、`src/types/`、`electron/services/ouiService.ts`、`.planning/codebase/{STRUCTURE,CONVENTIONS}.md`
**Files scanned:** 16 源文件 + 3 文档（STRUCTURE/CONVENTIONS/pagination）
**Pattern extraction date:** 2026-07-02
**CodeGraph 使用：** 本次模式映射以「逐字摘录活代码」为核心，采用 Read/Grep 直接读取（确保行号与 planner 的 `read_first` 一致），未走 codegraph 符号索引（codegraph 适合调用关系追踪，本任务是精确行号摘录，Read 更直接）。

---

*Phase: 5-Frontend Refactor & Types*
*Pattern map: 2026-07-02*
