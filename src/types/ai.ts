import type { TopologyNode, TopologyEdge } from './topology'

/**
 * AI 会话/消息 Row DTO（FE-02 / D-5-3）。
 *
 * 字段取证自 electron/services/ai.ts 的 INSERT/SELECT 语句 +
 * AIPage.tsx 消费面（getSessionMessages / chat 入参 messages）。
 * ChatMessage.role 收为 'user' | 'assistant' 联合类型（收敛 electron.d.ts 旧 string）。
 * 运行时分支（confirm_required / kb_answer 等 JSON.parse 结果）属运行时窄化，
 * 不在此静态建模。
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
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

/**
 * discoverTopology 返回值。复用 src/types/topology 的 TopologyNode/TopologyEdge
 * （DiscoveryPanel.tsx:98-99 消费面读为这两个类型；discovery.ts 主进程侧 any[]
 * 经 IPC 透传后 renderer 视为已结构化节点）。
 */
export interface DiscoverResult {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  failedDevices: Array<{ deviceId: string; deviceName: string; error: string }>
}
