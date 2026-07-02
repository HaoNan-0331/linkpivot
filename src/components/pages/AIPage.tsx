import { useState, useEffect } from 'react'
import { Spin, Select, Typography } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import { useAIChat } from './ai/useAIChat'
import ChatSessionList from './ai/ChatSessionList'
import ChatMessageList from './ai/ChatMessageList'
import ChatInput from './ai/ChatInput'
import CommandConfirmModal from './ai/CommandConfirmModal'

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
        {/* Header（编排层归属，issue 3）：设备多选 Select 经 hook 消费 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Title level={4} style={{ margin: 0 }}>AI 助手</Title>
          <Select
            mode="multiple"
            allowClear
            placeholder="选择目标设备（可多选）"
            style={{ minWidth: 280, maxWidth: 400 }}
            value={chat.selectedDevices}
            onChange={chat.setSelectedDevices}
            options={chat.devices.map((d) => ({ value: d.id, label: `${d.name} (${d.connectionType.toUpperCase()})` }))}
            maxTagCount="responsive"
          />
        </div>
        <ChatMessageList messages={chat.messages} loading={chat.loading} />
        <ChatInput
          value={chat.input}
          loading={chat.loading}
          onChange={chat.setInput}
          onSend={chat.handleSend}
        />
      </div>
      <CommandConfirmModal pendingConfirm={chat.pendingConfirm} onConfirm={chat.handleConfirm} />
    </div>
  )
}
