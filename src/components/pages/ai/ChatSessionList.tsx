import { Button } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ChatSession } from '@/types/ai'

interface ChatSessionListProps {
  sessions: ChatSession[]
  currentSessionId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  unreadSessionIds?: Set<string>   // Phase 31 D-03：未读会话集合（回复完成且已切走——组件只渲染小点，点入即清在 useAIChat）
  newSessionInFlight?: boolean     // Phase 31 D-05①：新建会话 IPC 在途（按钮 loading+disabled，防连点双建）
}

export default function ChatSessionList({ sessions, currentSessionId, onSelect, onNew, onDelete, unreadSessionIds, newSessionInFlight }: ChatSessionListProps) {
  return (
    <div style={{
      width: 220,
      borderRight: '1px solid var(--nt-alias-border-l2)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--nt-alias-border-l2)' }}>
        <Button block icon={<PlusOutlined />} onClick={onNew} loading={newSessionInFlight} disabled={newSessionInFlight}>
          新建会话
        </Button>
      </div>
      <div className="nt-scroll-stable" style={{ flex: 1, overflowY: 'auto' }}>
        {sessions.map((session) => (
          <div
            key={session.id}
            onClick={() => onSelect(session.id)}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              background: session.id === currentSessionId ? 'var(--nt-alias-state-business-tertiary)' : 'transparent',
              borderLeft: session.id === currentSessionId ? '3px solid var(--nt-alias-state-business-primary)' : '3px solid transparent',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 'var(--nt-font-xs-13-font-size)',
              color: 'var(--nt-alias-label-primary)',
            }}
            onMouseEnter={(e) => { if (session.id !== currentSessionId) (e.currentTarget.style.background = 'var(--nt-alias-interactive-bg-hover)') }}
            onMouseLeave={(e) => { if (session.id !== currentSessionId) (e.currentTarget.style.background = 'transparent') }}
          >
            {/* Phase 31 D-03：未读小点（微信未读心智——知道哪有新内容但不打扰）；当前会话不显示
                （正在看的会话无未读语义），与 :36 选中蓝 borderLeft 同色系 */}
            {unreadSessionIds?.has(session.id) && session.id !== currentSessionId && (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--nt-alias-state-business-primary)', flexShrink: 0, marginRight: 6 }} />
            )}
            <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.title}
            </div>
            <DeleteOutlined
              style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 12, marginLeft: 4, flexShrink: 0 }}
              onClick={(e) => { e.stopPropagation(); onDelete(session.id) }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
