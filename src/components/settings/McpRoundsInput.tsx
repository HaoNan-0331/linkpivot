import { useState, useEffect } from 'react'
import { Card, InputNumber, Button, Typography, Space, message } from 'antd'

const { Text } = Typography

/** 22-05 checkpoint：MCP 连续调用轮次上限系统设置（合法 1-20，默认 5，非法库值 main 侧 fail-safe 回退 5） */
export default function McpRoundsInput() {
  const [rounds, setRounds] = useState<number>(5)
  const [loading, setLoading] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const v = await window.api.ai.getMcpMaxRounds()
        setRounds(v)
      } catch {
        // ignore — 保持默认展示
      }
    })()
  }, [])

  const handleSave = async () => {
    setLoading(true)
    try {
      const result = await window.api.ai.setMcpMaxRounds(rounds)
      if (result.success) {
        setDirty(false)
        message.success(`已保存：MCP 连续调用轮次上限 = ${rounds}`)
      } else {
        message.error(result.error || '保存失败')
      }
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  return (
    <Card title="MCP 连续调用" size="small">
      <Space direction="vertical" size={4}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Text>连续调用轮次上限</Text>
          <InputNumber
            min={1}
            max={20}
            value={rounds}
            disabled={loading}
            onChange={(v) => {
              if (typeof v === 'number') {
                setRounds(v)
                setDirty(true)
              }
            }}
          />
          <Button type="primary" size="small" loading={loading} disabled={!dirty} onClick={handleSave}>
            保存
          </Button>
        </div>
        <Text type="secondary">
          AI 每轮工具调用回注结果后若仍需调用工具可继续下一轮，超过该上限后改为直接总结回答（范围 1-20，默认 5）。
          每轮工具调用仍独立执行确认检查，调高上限不改变安全行为。
        </Text>
      </Space>
    </Card>
  )
}
