import type { ChatSession } from '@/types/ai'
import type { ConfirmDraftsResult } from '@/types/experience'
import type { ConnectionType } from '@/types/device'

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
  // WR-01（36 review）：对齐 Device.connectionType 可空形态（D-09 全 off → NULL）
  connectionType: ConnectionType | null
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
  // Phase 28（28-05，D-09/D-11/D-12）：agent 轨迹 meta（sources/tier/noRealtimeData 等），
  // 仅由 payload 字段驱动渲染（来源徽章/分档标签/无源标签），AI 正文字符串无触发路径
  agentMeta?: AgentMeta
}

/** Phase 28（28-05）：agent 步骤状态七值（与 main 侧 AgentStep.status 契约逐字对齐） */
export type AgentStepStatus = 'running' | 'done' | 'failed' | 'retrying' | 'burned' | 'cooldown' | 'interrupted'

/** Phase 28（28-05）：来源轨迹项（main 侧 SourceRecord 契约，代码层生成非 AI 自述） */
export interface AgentSourceItem {
  kind: 'kb' | 'exp' | 'device' | 'mcp'
  title: string
  summary?: string
  refId?: string
}

/** Phase 28（28-05）：agent 回答结构化轨迹（D-09 来源 / D-11 无源声明 / D-12 分档） */
export interface AgentMeta {
  sources: AgentSourceItem[]
  tier?: AgentTierName
  noRealtimeData?: boolean
  hardStop?: 'user_cancel'
  backfillNotes?: string[]
}

/** Phase 28（28-05）：分档四值（main 侧 agentRouter.AgentTier 契约对齐） */
export type AgentTierName = 'troubleshoot' | 'configQuery' | 'knowledge' | 'inspection'

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
  // Phase 28（28-05，D-08 步骤级推送）：agent 步骤扩展字段——存在即按步骤卡状态机渲染
  // （useAIChat 按 stepIndex 定位更新既有卡片）；旧 MCP payload 无新字段自然降级追加
  stepIndex?: number
  actionType?: 'cmd' | 'kb' | 'exp' | 'mcp'
  stepStatus?: AgentStepStatus
  /** 28-06 R6 增强 a：分档预取步骤卡标志——动作描述加「[预取]」前缀（循环前已完成的检索） */
  prefetched?: boolean
  /** 28-06 R8：后置证据补查步骤卡标志——动作描述加「[补查]」前缀（收尾按 TIER_RETRIEVAL_PLAN 补查缺席源） */
  backfilled?: boolean
  // Phase 31（31-02，FIX-02 D-01）：归属会话标识——与 main 侧 ToolResultPayload 逐字对齐；
  // 旧载荷无字段自然降级（归因回退在途会话，见 parseAiReply.attributeToolResultSession）
  sessionId?: string
  /**
   * Phase 36（36-05，D-11）：cmd 步骤执行通道标注——fail-open 契约（区别于 31-02 sessionId
   * 在场即校验）：缺场放行零渲染（legacy 载荷/历史消息）；在场但非 'ssh'|'telnet' 枚举值
   * 渲染层按缺场处理（忽略该位，不丢弃整条卡片）。仅展示用途（ToolResultCard 标题后缀）。
   */
  execChannel?: 'ssh' | 'telnet'
}

/**
 * 越权命中（Phase 27 / 27-04，GUARD-04 D-05）。
 * 契约固定于 main 侧 privilegeGuard.GuardHit（27-03 经 confirm_required payload
 * guardInfo 下发），字段逐字对齐；explanation 由 main 生成人话解释，renderer 透传不硬编码。
 */
export interface GuardHitInfo {
  ruleId: string
  level: 'red' | 'yellow'
  target: string
  explanation: string
}

export interface ConfirmData {
  type: 'confirm_required'
  execId: string
  // Phase 27（27-04，D-05）：越权命中批次可选携带 guardInfo——存在时
  // ApprovalPanel 切「越权确认」形态；历史/普通 confirm 无此字段渲染路径零变化
  guardInfo?: {
    expectedTarget: string
    hits: GuardHitInfo[]
    // Phase 27 checkpoint：hit ↔ commands 索引映射（长度 = hits.length，元素 = 来源命令下标）。
    // 可选——历史/异常 payload 无此字段时 ApprovalPanel 降级为现状全量命令列表
    hitCommandIndexes?: number[]
  }
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
  // Phase 14 Plan 02：confirm IPC 在途视觉锁（ApprovalPanel 按钮 loading+disabled 消费）
  confirmInFlight: boolean
  // Phase 31（31-03，D-02）：在途回复归属会话——非空且 ≠ currentSessionId 时
  // ChatInput 显示「AI 正在其他会话回答中」提示条（输入全局锁的语义化提示）
  replySessionId: string | null
  // Phase 31（31-03，D-03）：回复完成且用户已切走的会话集合——ChatSessionList 未读小点，
  // 点入该会话即清除（微信未读心智：知道哪有新内容但不打扰）
  unreadSessionIds: Set<string>
  // Phase 31（31-03，D-05①）：新建会话 IPC 在途——新建按钮 loading+disabled（防连点双建）
  newSessionInFlight: boolean
  setSelectedDevices: (ids: string[]) => void
  setInput: (v: string) => void
  loadData: (hasConfig: boolean) => Promise<void>
  handleNewSession: () => Promise<void>
  handleSelectSession: (id: string) => Promise<void>
  handleDeleteSession: (id: string) => Promise<void>
  handleSend: () => Promise<void>
  handleConfirm: (approved: boolean) => Promise<void>
  // Phase 28（28-05，AGENT-05/D-06）：agent 任务运行中标志（= loading）+ 停止按钮回调
  // （调 window.api.ai.cancelChat 立即中止，不触发 AI 总结，步骤卡自然保留）
  agentRunning: boolean
  handleStop: () => Promise<void>
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
