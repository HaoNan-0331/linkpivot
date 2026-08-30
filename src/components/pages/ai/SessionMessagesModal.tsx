import { useEffect, useState } from 'react'
import { Modal, Button, Spin, Empty, Tag } from 'antd'
import type { SessionMessage } from '@/types/experience'

/**
 * SessionMessagesModal —— 原始会话溯源回链只读子 Modal（D-9-5 溯源回链）。
 *
 * 在 ReviewConfirmModal 内点「查看原始会话」叠层打开，展示该 source_session_id 的会话明文
 * （design D-04 明文回链，用户核对自己对话，单机 safeStorage 绑机器，不做 PII 脱敏）。
 *
 * 经 window.api.experience.getSessionMessages（Plan 02 新增 secure channel）拉取，
 * 与 ai 域 window.api.ai.getSessionMessages namespace 隔离（前者 Phase 9 经验溯源专用）。
 *
 * 边界处理：source_session_id 不存在/会话已删/无消息 → Empty 提示「原会话已不可查」。
 */
interface SessionMessagesModalProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
}

export default function SessionMessagesModal({ open, sessionId, onClose }: SessionMessagesModalProps) {
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !sessionId) {
      setMessages([])
      return
    }
    setLoading(true)
    window.api.experience
      .getSessionMessages(sessionId)
      .then((msgs) => setMessages(msgs))
      .finally(() => setLoading(false))
  }, [open, sessionId])

  return (
    <Modal
      open={open}
      title="原始会话（只读）"
      onCancel={onClose}
      width={720}
      footer={[<Button key="close" onClick={onClose}>关闭</Button>]}
    >
      {loading ? (
        <Spin />
      ) : messages.length === 0 ? (
        <Empty description="原会话已不可查（会话已删除或无消息）" />
      ) : (
        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          {messages.map((m) => (
            <div key={m.id} style={{ marginBottom: 8 }}>
              <Tag color={m.role === 'user' ? 'blue' : 'green'}>{m.role}</Tag>
              <div
                style={{
                  marginTop: 4,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 60,
                  overflowY: 'auto',
                  fontSize: 'var(--nt-font-xs-13-font-size)',
                  background: 'var(--nt-alias-bg-module-platform)',
                  padding: 8,
                  borderRadius: 4,
                }}
              >
                {m.content}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
