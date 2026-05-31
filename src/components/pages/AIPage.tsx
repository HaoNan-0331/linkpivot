import { useState, useEffect, useRef } from 'react'
import { Select, Input, Button, Spin, Typography, message, Modal, Tag } from 'antd'
import { SendOutlined, RobotOutlined, UserOutlined, ExclamationCircleOutlined, PlusOutlined, DeleteOutlined, BookOutlined } from '@ant-design/icons'
import type { ChatSession, ChatMessage } from '@/types/electron'

const { Title } = Typography
const { TextArea } = Input

interface DeviceOption {
  id: string
  name: string
  connectionType: string
}

interface ChatMsg {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  references?: Array<{ docTitle: string; chunkTitle: string; docId: string }>
}

interface ConfirmData {
  type: 'confirm_required'
  execId: string
  commands: Array<{ deviceName: string; command: string }>
  rejectedCommands?: Array<{ command: string; reason: string }>
  aiExplanation: string
}

export default function AIPage() {
  const [devices, setDevices] = useState<DeviceOption[]>([])
  const [selectedDevices, setSelectedDevices] = useState<string[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [configLoading, setConfigLoading] = useState(true)
  const [hasConfig, setHasConfig] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmData | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    try {
      const [devs, config] = await Promise.all([
        window.api.device.list(),
        window.api.ai.getConfig(),
      ])
      setDevices(
        devs
          .filter((d: any) => d.connectionType === 'ssh' || d.connectionType === 'telnet')
          .map((d: any) => ({ id: d.id, name: d.name, connectionType: d.connectionType }))
      )
      setHasConfig(!!config && !!config.apiKey)
      if (config) {
        await loadSessions()
      }
    } catch {
      // ignore
    }
    setConfigLoading(false)
  }

  async function loadSessions() {
    const list = await window.api.ai.listSessions()
    setSessions(list)
    if (!currentSessionId) {
      if (list.length > 0) {
        // Load most recent session
        await handleSelectSession(list[0].id)
      } else {
        // No sessions exist yet, create the first one
        await handleNewSession()
      }
    }
  }

  async function handleNewSession() {
    const session = await window.api.ai.createSession('新对话')
    setSessions((prev) => [session, ...prev])
    setCurrentSessionId(session.id)
    setMessages([])
    setPendingConfirm(null)
    return session
  }

  async function handleSelectSession(sessionId: string) {
    if (sessionId === currentSessionId) return
    setCurrentSessionId(sessionId)
    setPendingConfirm(null)
    const msgs = await window.api.ai.getSessionMessages(sessionId)
    setMessages(msgs.map((m: ChatMessage) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, createdAt: m.createdAt })))
  }

  async function handleDeleteSession(sessionId: string) {
    await window.api.ai.deleteSession(sessionId)
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    if (sessionId === currentSessionId) {
      // Current session deleted, create new one
      const remaining = sessions.filter((s) => s.id !== sessionId)
      if (remaining.length > 0) {
        await handleSelectSession(remaining[0].id)
      } else {
        await handleNewSession()
      }
    }
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || loading || !currentSessionId) return

    const userMsg: ChatMsg = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    try {
      const reply = await window.api.ai.chat(
        newMessages.map((m) => ({ role: m.role, content: m.content })),
        selectedDevices.length > 0 ? selectedDevices : undefined,
        currentSessionId
      )

      // Auto title: update session title from first user message
      if (messages.length === 0) {
        const title = text.length > 20 ? text.substring(0, 20) + '...' : text
        window.api.ai.updateSessionTitle(currentSessionId, title)
        setSessions((prev) => prev.map((s) => s.id === currentSessionId ? { ...s, title } : s))
      }

      // Check if reply is a confirm_required or kb_answer response
      try {
        const parsed = JSON.parse(reply)
        if (parsed.type === 'confirm_required') {
          setPendingConfirm(parsed)
          setLoading(false)
          return
        }
        if (parsed.type === 'kb_answer') {
          setMessages([...newMessages, { role: 'assistant', content: parsed.content, references: parsed.references }])
          setLoading(false)
          return
        }
      } catch {
        // Not JSON — normal reply
      }

      setMessages([...newMessages, { role: 'assistant', content: reply }])
    } catch (e: any) {
      const errMsg = `错误: ${e.message}`
      setMessages([...newMessages, { role: 'assistant', content: errMsg }])
    }
    setLoading(false)
  }

  async function handleConfirm(approved: boolean) {
    if (!pendingConfirm || !currentSessionId) return
    const confirmData = pendingConfirm
    setPendingConfirm(null) // 立即关闭弹窗，防止重复点击
    setLoading(true)
    try {
      const result = await window.api.ai.confirmCommand(confirmData.execId, approved)
      setMessages((prev) => [...prev, { role: 'assistant', content: result }])
    } catch (e: any) {
      message.error(e.message)
    }
    setLoading(false)
  }

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
      {/* Left: Session list */}
      <div style={{
        width: 220,
        borderRight: '1px solid #f0f0f0',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
          <Button block icon={<PlusOutlined />} onClick={handleNewSession}>
            新建会话
          </Button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => handleSelectSession(session.id)}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                background: session.id === currentSessionId ? '#e6f7ff' : 'transparent',
                borderLeft: session.id === currentSessionId ? '3px solid #1890ff' : '3px solid transparent',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 13,
                color: '#333',
              }}
              onMouseEnter={(e) => { if (session.id !== currentSessionId) (e.currentTarget.style.background = '#fafafa') }}
              onMouseLeave={(e) => { if (session.id !== currentSessionId) (e.currentTarget.style.background = 'transparent') }}
            >
              <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session.title}
              </div>
              <DeleteOutlined
                style={{ color: '#999', fontSize: 12, marginLeft: 4, flexShrink: 0 }}
                onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id) }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Right: Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Title level={4} style={{ margin: 0 }}>AI 助手</Title>
          <Select
            mode="multiple"
            allowClear
            placeholder="选择目标设备（可多选）"
            style={{ minWidth: 280, maxWidth: 400 }}
            value={selectedDevices}
            onChange={setSelectedDevices}
            options={devices.map((d) => ({ value: d.id, label: `${d.name} (${d.connectionType.toUpperCase()})` }))}
            maxTagCount="responsive"
          />
        </div>

        {/* Chat messages */}
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

        {/* Input area */}
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            autoSize={{ minRows: 1, maxRows: 4 }}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            disabled={loading}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            loading={loading}
            disabled={!input.trim()}
          >
            发送
          </Button>
        </div>
      </div>

      {/* Confirm modal */}
      <Modal
        open={!!pendingConfirm}
        title={`命令执行确认（${pendingConfirm?.commands?.length || 0} 条命令）`}
        onCancel={() => handleConfirm(false)}
        footer={[
          <Button key="reject" danger onClick={() => handleConfirm(false)}>
            拒绝执行
          </Button>,
          <Button key="approve" type="primary" onClick={() => handleConfirm(true)}>
            确认执行
          </Button>,
        ]}
      >
        {pendingConfirm && (
          <div>
            <p><strong>待执行命令:</strong></p>
            {pendingConfirm.commands.map((cmd, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <Tag color="blue" style={{ fontSize: 13 }}>
                  [{cmd.deviceName}] {cmd.command}
                </Tag>
              </div>
            ))}
            {pendingConfirm.rejectedCommands && pendingConfirm.rejectedCommands.length > 0 && (
              <>
                <p style={{ marginTop: 8 }}><strong>已拒绝命令:</strong></p>
                {pendingConfirm.rejectedCommands.map((r, i) => (
                  <div key={i} style={{ marginBottom: 4 }}>
                    <Tag color="red" style={{ fontSize: 13 }}>{r.command}</Tag>
                    <span style={{ color: '#999', fontSize: 12 }}> {r.reason}</span>
                  </div>
                ))}
              </>
            )}
            <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, marginTop: 12 }}>
              <strong>AI 说明:</strong>
              <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', fontSize: 13 }}>
                {pendingConfirm.aiExplanation}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
