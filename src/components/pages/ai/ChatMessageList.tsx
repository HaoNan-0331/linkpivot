import { useRef, useEffect } from 'react'
import { Spin } from 'antd'
import { RobotOutlined, UserOutlined, BookOutlined } from '@ant-design/icons'
import type { ChatMsg } from './types'

interface ChatMessageListProps {
  messages: ChatMsg[]
  loading: boolean
}

export default function ChatMessageList({ messages, loading }: ChatMessageListProps) {
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      border: '1px solid #f0f0f0',
      borderRadius: 8,
      padding: 16,
      background: '#fafafa',
    }}>
      {messages.length === 0 && (
        <div style={{ textAlign: 'center', color: '#bfbfbf', paddingTop: 60 }}>
          <RobotOutlined style={{ fontSize: 40, marginBottom: 8 }} />
          <div>向 AI 助手提问，选择设备后可查询设备信息</div>
        </div>
      )}
      {messages.map((msg, idx) => (
        <div
          key={msg.id || idx}
          style={{
            display: 'flex',
            justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            marginBottom: 12,
          }}
        >
          <div style={{
            maxWidth: '70%',
            padding: '8px 12px',
            borderRadius: 8,
            background: msg.role === 'user' ? '#1677ff' : '#fff',
            color: msg.role === 'user' ? '#fff' : '#333',
            border: msg.role === 'user' ? 'none' : '1px solid #e8e8e8',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 14,
            lineHeight: 1.6,
          }}>
            <div style={{ marginBottom: 4 }}>
              {msg.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
              <span style={{ marginLeft: 4, fontWeight: 500 }}>
                {msg.role === 'user' ? '我' : 'AI'}
              </span>
            </div>
            {msg.content}
            {msg.role === 'assistant' && msg.references && msg.references.length > 0 && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e8e8e8' }}>
                <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>参考来源：</div>
                {msg.references.map((ref, ri) => (
                  <div key={ri} style={{ fontSize: 12, color: '#666', lineHeight: 1.8 }}>
                    <BookOutlined style={{ marginRight: 4, color: '#1890ff' }} />
                    {ref.docTitle} — {ref.chunkTitle}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
          <div style={{ padding: '8px 12px', background: '#fff', borderRadius: 8, border: '1px solid #e8e8e8' }}>
            <Spin size="small" /> <span style={{ marginLeft: 8, color: '#999' }}>思考中...</span>
          </div>
        </div>
      )}
      <div ref={chatEndRef} />
    </div>
  )
}
