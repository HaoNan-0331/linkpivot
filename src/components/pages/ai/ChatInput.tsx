import { Input, Button, Badge } from 'antd'
import { SendOutlined, ThunderboltOutlined } from '@ant-design/icons'
import RetrievalControlButton from './RetrievalControlButton'

const { TextArea } = Input

interface ChatInputProps {
  value: string
  loading: boolean
  onChange: (v: string) => void
  onSend: () => void
  summarizing?: boolean
  onSummarize?: () => void
  canSummarize?: boolean   // 会话有内容才可点（SC1 强约束）
  pendingDraftCount?: number       // Phase 9 D-9-7 待确认草稿角标
  onOpenReview?: () => void        // 角标点击重开确认弹窗
  aiReplyElsewhere?: boolean       // Phase 31 D-02：AI 正在其他会话回答中——输入全局锁的语义化提示
}

export default function ChatInput({ value, loading, onChange, onSend, summarizing, onSummarize, canSummarize, pendingDraftCount, onOpenReview, aiReplyElsewhere }: ChatInputProps) {
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Phase 31 D-02：他会在途回复提示条——回复归属其他会话时告知用户输入为何禁用
          （disabled={loading} 全局锁机制原样保留，不改造 cancelChatControllers）。
          Phase 34（34-01，SC1）：提示条与输入行同挂 .nt-chat-card 卡层宽 min(780px,100cqi-32px)；
          视觉采 dsh notice 形态（12/18 + interactive-bg-hover 底 r8，文案逐字保留） */}
      {aiReplyElsewhere && (
        <div
          className="nt-chat-card"
          style={{
            width: '100%',
            fontSize: 'var(--nt-font-xxs-12-font-size)',
            lineHeight: 'var(--nt-font-xxs-12-line-height)',
            color: 'var(--nt-alias-label-secondary)',
            background: 'var(--nt-alias-interactive-bg-hover)',
            borderRadius: 8,
            padding: '4px 8px',
          }}
        >
          AI 正在其他会话回答中，输入已临时锁定
        </div>
      )}
      {/* Phase 34（34-01，SC1）：输入行卡层——.nt-chat-card 同宽居中（与审批面板互斥渲染位同层） */}
      <div className="nt-chat-card" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', width: '100%' }}>
        {/* Phase 37（37-03，D-09）：检索设置入口——行首小图标，面板全在 Popover 浮层
            （自治组件零 props 不挤宽度契约）；行 alignItems flex-end 下面板图标 alignSelf
            center 保持与单行 TextArea 视觉居中对齐 */}
        <div style={{ alignSelf: 'center' }}>
          <RetrievalControlButton />
        </div>
        <TextArea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          autoSize={{ minRows: 1, maxRows: 4 }}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          disabled={loading}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={onSend}
          loading={loading}
          disabled={!value.trim()}
        >
          发送
        </Button>
        {onSummarize && (
          <Badge count={pendingDraftCount ?? 0} offset={[-4, 4]} color="var(--nt-alias-state-warn-primary)">
            <Button
              icon={<ThunderboltOutlined />}
              onClick={onSummarize}
              loading={summarizing}
              disabled={!canSummarize || loading || summarizing}
            >
              经验总结
            </Button>
          </Badge>
        )}
        {onOpenReview && (pendingDraftCount ?? 0) > 0 && (
          <Button type="link" onClick={onOpenReview}>
            待确认 {pendingDraftCount} 条
          </Button>
        )}
      </div>
    </div>
  )
}
