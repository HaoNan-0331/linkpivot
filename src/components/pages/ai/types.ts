import type { ChatSession } from '@/types/ai'
import type { ConfirmDraftsResult } from '@/types/experience'

/**
 * AI 子树本地类型（FE-01 / D-5-1）。
 *
 * DeviceOption/ChatMsg/ConfirmData 原 AIPage.tsx:9-29 本地 interface，迁移至此。
 * ChatSession/ChatMessage 复用 src/types/ai.ts（05-01 建），不重复发明。
 */

export interface DeviceOption {
  id: string
  name: string
  ipAddress: string
  connectionType: string
  // Phase 23（DSL-03/D-02）：能力三布尔，main 经 device:list 投影下发，
  // renderer 只消费不推导（零本地推导契约，UI 消费在 23-04）。
  capabilities: {
    hasSSH: boolean
    hasTelnet: boolean
    hasMcp: boolean
  }
}

// Phase 11 RETRIEVE-03：引用来源联合类型（kb / experience / session）
// - kb：Phase 5 既有 KB 文档引用（kb_answer 分支注入，useAIChat 消费时补 kind:'kb'）
// - experience：经验引用（exp_answer 分支注入，点击开 ExperienceDetailModal）
// - session：会话引用（exp_answer 的 experience.sourceSessionId 非空时拆出，点击开 SessionMessagesModal）
// D-11-11：references 从精排注入记录拿（main 已知注入哪些经验），不需 AI 标记。
// 注意 ai.ts:835 实际返回 camelCase（expId/sourceSessionId），非 snake_case。
export type ReferenceItem =
  | { kind: 'kb'; docTitle: string; chunkTitle: string; docId: string }
  | { kind: 'experience'; expId: string; title: string; unsupported?: boolean }
  | { kind: 'session'; sessionId: string; title: string }

// 渲染层消息：比 src/types/ai.ts 的 ChatMessage 多 references 字段
// （handleSend 的 kb_answer/exp_answer 分支由 AI 回复 JSON 附加，仅渲染层消费）
export interface ChatMsg {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  references?: ReferenceItem[]
  // Phase 22（22-05，D-03）：tool_result 事件入列后的结构化卡片数据源
  toolResult?: ToolResultMessage
}

/**
 * MCP 工具调用结果载荷（Phase 22 / 22-05，D-03）。
 * 契约固定于 22-03 main 侧 ToolResultPayload（ai:toolResult webContents.send 下发），
 * renderer 侧唯一数据源，字段逐字对齐；resultJson 已在 main 侧 sanitizeUntrusted 清洗。
 */
export interface ToolResultMessage {
  type: 'tool_result'
  server: string
  tool: string
  deviceName: string
  argsJson: string
  resultJson: string
  status: 'success' | 'failed' | 'timeout'
  errorText?: string
}

export interface ConfirmData {
  type: 'confirm_required'
  execId: string
  // Phase 22（22-05）：MCP 工具确认复用本协议，commands 元素可携带可选
  // server/tool/argsJson 字段（22-03 下发，renderer 按字段存在性区分命令/工具行）
  commands: Array<{
    deviceName: string
    command: string
    server?: string
    tool?: string
    argsJson?: string
  }>
  rejectedCommands?: Array<{ command: string; reason: string }>
  aiExplanation: string
}

/**
 * useAIChat 返回契约（typed boundary，4 子组件经切片消费，D-5-1）。
 * configLoading/hasConfig 属 page 守卫，留 AIPage 编排层，不在此契约。
 */
export interface UseAIChatReturn {
  devices: DeviceOption[]
  selectedDevices: string[]
  sessions: ChatSession[]
  currentSessionId: string | null
  messages: ChatMsg[]
  input: string
  loading: boolean
  pendingConfirm: ConfirmData | null
  // Phase 14 Plan 02：confirm IPC 在途视觉锁（CommandConfirmModal 按钮 loading+disabled 消费）
  confirmInFlight: boolean
  setSelectedDevices: (ids: string[]) => void
  setInput: (v: string) => void
  loadData: (hasConfig: boolean) => Promise<void>
  handleNewSession: () => Promise<void>
  handleSelectSession: (id: string) => Promise<void>
  handleDeleteSession: (id: string) => Promise<void>
  handleSend: () => Promise<void>
  handleConfirm: (approved: boolean) => Promise<void>
  // Phase 8 Plan 03：经验总结（点「经验总结」按钮）
  summarizing: boolean
  canSummarize: boolean        // 会话有内容才可点（SC1 强约束）
  handleSummarize: () => Promise<void>
  // Phase 9 Plan 03：人工确认弹窗 + 待确认角标（D-9-7）
  reviewOpen: boolean
  reviewInitialDraftIds: string[]
  pendingDraftCount: number
  setReviewOpen: (open: boolean) => void
  handleReviewSubmitted: (result: ConfirmDraftsResult) => Promise<void>
  openReviewFromBadge: () => Promise<void>
}
