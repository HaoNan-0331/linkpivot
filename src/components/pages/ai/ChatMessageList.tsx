import { useRef, useEffect, useState } from 'react'
import { Spin, Tag, Button } from 'antd'
import { RobotOutlined, UserOutlined, BookOutlined } from '@ant-design/icons'
import type { ChatMsg, ReferenceItem } from './types'
import type { Experience } from '@/types/experience'
import ExperienceDetailModal from '../../knowledge/ExperienceDetailModal'
import SessionMessagesModal from './SessionMessagesModal'
import ToolResultCard from './ToolResultCard'

interface ChatMessageListProps {
  messages: ChatMsg[]
  loading: boolean
  /** Phase 28（28-05，D-06）：agent 任务运行中常驻停止按钮（进度区，不得被消息顶走） */
  agentRunning?: boolean
  onStop?: () => void
}

export default function ChatMessageList({ messages, loading, agentRunning, onStop }: ChatMessageListProps) {
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Phase 11 RETRIEVE-03：点击经验/会话引用打开复用 Modal（D-11-12 不新建）
  // ExperienceDetailModal 需 Experience 对象传入（仿 ExperienceDetailModal.tsx 拉 devices useEffect 模式，
  // 但改为点击触发 experience.get 拉详情）；SessionMessagesModal sessionId 直传零适配。
  const [detailExp, setDetailExp] = useState<Experience | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [sessionModalId, setSessionModalId] = useState<string | null>(null)
  const [sessionModalOpen, setSessionModalOpen] = useState(false)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 经验引用点击 → 拉详情开 Modal（信任边界：references 只含 expId 元数据，详情经 secure IPC，
  // ExperienceDetailModal 走既有 stripEncColumns 边界，renderer 永不收 _enc 列，T-11-07 mitigate）
  const openExperience = (expId: string) => {
    // WR-06 fix：null 判（经验已删/不存在不弹空 Modal）+ .catch（IPC 失败不致 unhandled rejection）
    window.api.experience.get(expId).then((e) => {
      if (!e) return
      setDetailExp(e)
      setDetailOpen(true)
    }).catch((err) => {
      console.warn('[ChatMessageList] openExperience failed', expId, err)
    })
  }

  const openSession = (sessionId: string) => {
    setSessionModalId(sessionId)
    setSessionModalOpen(true)
  }

  // 按 ref.kind 分流渲染（kb 保持既有 / experience 可点开详情 / session 可点开会话原文）
  const renderRef = (ref: ReferenceItem, ri: number) => {
    if (ref.kind === 'kb') {
      return (
        <div key={ri} style={{ fontSize: 12, color: '#666', lineHeight: 1.8 }}>
          <BookOutlined style={{ marginRight: 4, color: '#1890ff' }} />
          {ref.docTitle} — {ref.chunkTitle}
        </div>
      )
    }
    if (ref.kind === 'experience') {
      return (
        <div
          key={ri}
          style={{ fontSize: 12, color: '#1890ff', lineHeight: 1.8, cursor: 'pointer' }}
          title="点击查看经验详情"
          onClick={() => openExperience(ref.expId)}
        >
          📖 {ref.title}
          {ref.unsupported && (
            <Tag color="warning" style={{ marginLeft: 6, fontSize: 11 }}>⚠ 命令已失支持</Tag>
          )}
        </div>
      )
    }
    // kind === 'session'
    return (
      <div
        key={ri}
        style={{ fontSize: 12, color: '#1890ff', lineHeight: 1.8, cursor: 'pointer' }}
        title="点击查看原始会话"
        onClick={() => openSession(ref.sessionId)}
      >
        💬 {ref.title}
      </div>
    )
  }

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
        // Phase 22（22-05，D-03）：tool_result 消息渲染结构化卡片——次级块视觉，
        // 不套 AI 气泡样式（卡片与 AI 解读气泡分离，T-22-18）
        msg.toolResult ? (
          <div key={msg.id || idx} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
            <ToolResultCard data={msg.toolResult} />
          </div>
        ) : (
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
                {msg.references.map((ref, ri) => renderRef(ref, ri))}
              </div>
            )}
          </div>
        </div>
        )
      ))}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
          <div style={{ padding: '8px 12px', background: '#fff', borderRadius: 8, border: '1px solid #e8e8e8' }}>
            <Spin size="small" /> <span style={{ marginLeft: 8, color: '#999' }}>思考中...</span>
            {/* Phase 28（28-05，D-06）：agent 任务运行中常驻「停止」——立即中止，无二次确认 */}
            {agentRunning && onStop && (
              <Button danger size="small" style={{ marginLeft: 12 }} onClick={onStop}>
                停止
              </Button>
            )}
          </div>
        </div>
      )}
      <div ref={chatEndRef} />
      {/* Phase 11 RETRIEVE-03 D-11-12：复用 Phase 10 ExperienceDetailModal + Phase 9 SessionMessagesModal */}
      <ExperienceDetailModal open={detailOpen} experience={detailExp} onClose={() => setDetailOpen(false)} />
      <SessionMessagesModal open={sessionModalOpen} sessionId={sessionModalId} onClose={() => setSessionModalOpen(false)} />
    </div>
  )
}
