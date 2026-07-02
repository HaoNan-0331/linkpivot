import { Button } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ChatSession } from '@/types/ai'

interface ChatSessionListProps {
  sessions: ChatSession[]
  currentSessionId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export default function ChatSessionList({ sessions, currentSessionId, onSelect, onNew, onDelete }: ChatSessionListProps) {
  return (
    <div style={{
      width: 220,
      borderRight: '1px solid #f0f0f0',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
        <Button block icon={<PlusOutlined />} onClick={onNew}>
          新建会话
        </Button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sessions.map((session) => (
          <div
            key={session.id}
            onClick={() => onSelect(session.id)}
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
              onClick={(e) => { e.stopPropagation(); onDelete(session.id) }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
