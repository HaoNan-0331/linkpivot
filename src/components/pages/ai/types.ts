import type { ChatSession } from '@/types/ai'

/**
 * AI 子树本地类型（FE-01 / D-5-1）。
 *
 * DeviceOption/ChatMsg/ConfirmData 原 AIPage.tsx:9-29 本地 interface，迁移至此。
 * ChatSession/ChatMessage 复用 src/types/ai.ts（05-01 建），不重复发明。
 */

export interface DeviceOption {
  id: string
  name: string
  connectionType: string
}

// 渲染层消息：比 src/types/ai.ts 的 ChatMessage 多 references 字段
// （handleSend 的 kb_answer 分支由 AI 回复 JSON 附加，仅渲染层消费）
export interface ChatMsg {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  references?: Array<{ docTitle: string; chunkTitle: string; docId: string }>
}

export interface ConfirmData {
  type: 'confirm_required'
  execId: string
  commands: Array<{ deviceName: string; command: string }>
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
  setSelectedDevices: (ids: string[]) => void
  setInput: (v: string) => void
  loadData: (hasConfig: boolean) => Promise<void>
  handleNewSession: () => Promise<void>
  handleSelectSession: (id: string) => Promise<void>
  handleDeleteSession: (id: string) => Promise<void>
  handleSend: () => Promise<void>
  handleConfirm: (approved: boolean) => Promise<void>
}
