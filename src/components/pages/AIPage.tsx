import { useState, useEffect } from 'react'
import { Spin, Typography } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import { useAIChat } from './ai/useAIChat'
import DeviceSelector from './ai/DeviceSelector'
import ChatSessionList from './ai/ChatSessionList'
import ChatMessageList from './ai/ChatMessageList'
import ChatInput from './ai/ChatInput'
import CommandConfirmModal from './ai/CommandConfirmModal'
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
        <ExclamationCircleOutlined style={{ fontSize: 48, color: '#faad14', marginBottom: 16 }} />
        <div style={{ fontSize: 16, color: '#666' }}>
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
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, minWidth: 0 }}>
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
        <ChatMessageList messages={chat.messages} loading={chat.loading} />
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
        />
      </div>
      <CommandConfirmModal pendingConfirm={chat.pendingConfirm} onConfirm={chat.handleConfirm} confirmInFlight={chat.confirmInFlight} />
      <ReviewConfirmModal
        open={chat.reviewOpen}
        onClose={() => chat.setReviewOpen(false)}
        initialDraftIds={chat.reviewInitialDraftIds}
        onSubmitted={chat.handleReviewSubmitted}
      />
    </div>
  )
}
