import { Input, Button } from 'antd'
import { SendOutlined } from '@ant-design/icons'

const { TextArea } = Input

interface ChatInputProps {
  value: string
  loading: boolean
  onChange: (v: string) => void
  onSend: () => void
}

export default function ChatInput({ value, loading, onChange, onSend }: ChatInputProps) {
  return (
    <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
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
    </div>
  )
}
