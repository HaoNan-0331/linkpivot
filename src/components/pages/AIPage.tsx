import { useState, useEffect } from 'react'
import { Spin, Typography } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import { useAIChat } from './ai/useAIChat'
import DeviceSelector from './ai/DeviceSelector'
import ChatSessionList from './ai/ChatSessionList'
import ChatMessageList from './ai/ChatMessageList'
import ChatInput from './ai/ChatInput'
import ApprovalPanel from './ai/ApprovalPanel'
import ReviewConfirmModal from './ai/ReviewConfirmModal'

const { Title } = Typography

/**
 * AIPage 薄编排层（FE-01 / D-5-1）。
 *
 * 职责仅限：configLoading/hasConfig page 守卫 + 调用 useAIChat hook +
 * header 设备多选 Select（编排层归属，issue 3 写死）+ 渲染 4 子组件。
 *
 * 会话/消息/输入/确认逻辑全部下沉 useAIChat hook；header Select 经
 * chat.selectedDevices/setSelectedDevices 消费 hook 状态（非子组件职责）。
 */
export default function AIPage() {
  const [configLoading, setConfigLoading] = useState(true)
  const [hasConfig, setHasConfig] = useState(false)

  const chat = useAIChat()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const config = await window.api.ai.getConfig()
        const ok = !!config && !!config.apiKey
        if (cancelled) return
        setHasConfig(ok)
        await chat.loadData(ok)
      } catch (e: unknown) {
        console.error('[ai] loadConfig 失败:', e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setConfigLoading(false)
      }
    })()
    return () => { cancelled = true }
    // CR-01 fix：mount-only 初始化（恢复原 AIPage useEffect(loadData, []) 语义）。
    // [chat] 会因 useAIChat 每渲染返回新对象字面量触发无限重渲染（getConfig→loadData→setState→再渲染→IPC 风暴）。
    // chat.loadData 为 first-render 闭包，捕获初始 currentSessionId=null，mount 加载语义正确。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (configLoading) {
    return <div style={{ textAlign: 'center', paddingTop: 100 }}><Spin size="large" /></div>
  }

  if (!hasConfig) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 100 }}>
        <ExclamationCircleOutlined style={{ fontSize: 48, color: 'var(--nt-alias-state-warn-primary)', marginBottom: 16 }} />
        <div style={{ fontSize: 'var(--nt-font-base-16-font-size)', color: 'var(--nt-alias-label-secondary)' }}>
          请先在「系统设置」中配置 AI 服务参数
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <ChatSessionList
        sessions={chat.sessions}
        currentSessionId={chat.currentSessionId}
        onSelect={chat.handleSelectSession}
        onNew={chat.handleNewSession}
        onDelete={chat.handleDeleteSession}
        unreadSessionIds={chat.unreadSessionIds}
        newSessionInFlight={chat.newSessionInFlight}
      />
      {/* Phase 34（34-01，SC1/UI-04）：对话列容器挂 .nt-chat-container——container-type: inline-size
          容器查询基准 + 三枚宽度契约变量（ai-chat.css），正文列/输入卡两公式以 100cqi 消费 */}
      <div className="nt-chat-container" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, minWidth: 0 }}>
        {/* Header（编排层归属，issue 3）：设备选择经 hook 消费。
            Phase 23（DSL-01/D-01/D-02/D-09）：Select 替换为 DeviceSelector
            （全设备平铺 + 搜索过滤 + 三档能力 Tag 并列 + >10 台软警告）。 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <Title level={4} style={{ margin: 0 }}>AI 助手</Title>
          <DeviceSelector
            devices={chat.devices}
            selectedDevices={chat.selectedDevices}
            onChange={chat.setSelectedDevices}
          />
        </div>
        {/* Phase 28（28-05）：agentRunning/handleStop——agent 任务运行中进度区常驻停止按钮（D-06） */}
        {/* Phase 31（31-05，根因④，31-04 裁决新根因）：「思考中/停止」指示按归属门控——
            在途回复归属其他会话时不在当前会话消息区渲染指示气泡（31-04 真机锤实：用户在 B
            看到的「A 的气泡」即此全局 loading 指示，非内容串话）。与下方 ChatInput
            aiReplyElsewhere 同款归属条件（D-02 输入锁/提示条语义保留不动，T5 已过）；
            replySessionId === null（legacy/无在途）保持原行为 */}
        <ChatMessageList
          messages={chat.messages}
          loading={chat.loading && (chat.replySessionId === null || chat.replySessionId === chat.currentSessionId)}
          agentRunning={chat.agentRunning}
          onStop={chat.handleStop}
        />
        {/* Phase 34（34-04，SC4/UI-06）：输入挂点互斥渲染——pendingConfirm 在场时内联审批面板
            接管 ChatInput 挂点（同宽 .nt-chat-card 层），原确认弹层渲染点移除（SC4）。
            pendingConfirm 为全局状态（非会话作用域），31-03「跨会话也弹窗」防确认死锁语义
            经互斥渲染天然延续；useAIChat 审批状态机零改（只换呈现组件）。 */}
        {chat.pendingConfirm ? (
          <ApprovalPanel
            pendingConfirm={chat.pendingConfirm}
            onConfirm={chat.handleConfirm}
            confirmInFlight={chat.confirmInFlight}
          />
        ) : (
          <ChatInput
            value={chat.input}
            loading={chat.loading}
            onChange={chat.setInput}
            onSend={chat.handleSend}
            summarizing={chat.summarizing}
            onSummarize={chat.handleSummarize}
            canSummarize={chat.canSummarize}
            pendingDraftCount={chat.pendingDraftCount}
            onOpenReview={chat.openReviewFromBadge}
            aiReplyElsewhere={chat.loading && chat.replySessionId !== null && chat.replySessionId !== chat.currentSessionId}
          />
        )}
      </div>
      <ReviewConfirmModal
        open={chat.reviewOpen}
        onClose={() => chat.setReviewOpen(false)}
        initialDraftIds={chat.reviewInitialDraftIds}
        onSubmitted={chat.handleReviewSubmitted}
      />
    </div>
  )
}
