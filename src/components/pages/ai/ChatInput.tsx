import { Input, Button } from 'antd'
import { SendOutlined, ThunderboltOutlined } from '@ant-design/icons'

const { TextArea } = Input

interface ChatInputProps {
  value: string
  loading: boolean
  onChange: (v: string) => void
  onSend: () => void
  summarizing?: boolean
  onSummarize?: () => void
  canSummarize?: boolean   // 会话有内容才可点（SC1 强约束）
}

export default function ChatInput({ value, loading, onChange, onSend, summarizing, onSummarize, canSummarize }: ChatInputProps) {
  return (
    <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
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
        <Button
          icon={<ThunderboltOutlined />}
          onClick={onSummarize}
          loading={summarizing}
          disabled={!canSummarize || loading || summarizing}
        >
          经验总结
        </Button>
      )}
    </div>
  )
}
