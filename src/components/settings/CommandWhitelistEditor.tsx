import { useState, useEffect } from 'react'
import { Tag, Input, Button, Card, Space, message, Spin } from 'antd'
import { PlusOutlined, CloseOutlined } from '@ant-design/icons'

export default function CommandWhitelistEditor() {
  const [whitelist, setWhitelist] = useState<string[]>([])
  const [inputValue, setInputValue] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const list = await window.api.ai.getCommandWhitelist()
      setWhitelist(list)
    } catch (e: unknown) {
      // Phase 19 / REN-02：catch unknown + instanceof 窄化（OuiTab.tsx:71 范式）
      message.error(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleAdd = () => {
    const val = inputValue.trim()
    if (!val) return
    if (whitelist.includes(val)) {
      message.warning('该命令已存在')
      return
    }
    setWhitelist([...whitelist, val])
    setInputValue('')
  }

  const handleRemove = (item: string) => {
    setWhitelist(whitelist.filter((w) => w !== item))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.api.ai.saveCommandWhitelist(whitelist)
      message.success('白名单已保存')
    } catch (e: unknown) {
      // Phase 19 / REN-02：catch unknown + instanceof 窄化（OuiTab.tsx:71 范式）
      message.error(e instanceof Error ? e.message : String(e))
    }
    setSaving(false)
  }

  if (loading) return <Spin />

  return (
    <Card title="命令白名单" size="small">
      <div style={{ marginBottom: 12, color: 'var(--nt-alias-label-secondary)', fontSize: 'var(--nt-font-xs-13-font-size)' }}>
        白名单中的命令模式允许 AI 自动执行，无需人工确认。支持通配符，如 show *
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, minHeight: 32 }}>
        {whitelist.length === 0 && (
          <span style={{ color: 'var(--nt-alias-label-caption)' }}>暂无白名单命令</span>
        )}
        {whitelist.map((item) => (
          <Tag
            key={item}
            closable
            closeIcon={<CloseOutlined />}
            onClose={() => handleRemove(item)}
            style={{ fontSize: 'var(--nt-font-xs-13-font-size)', padding: '2px 8px' }}
          >
            {item}
          </Tag>
        ))}
      </div>
      <Space>
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="输入命令模式，如 show *"
          style={{ width: 240 }}
          onPressEnter={handleAdd}
        />
        <Button icon={<PlusOutlined />} onClick={handleAdd} disabled={!inputValue.trim()}>
          添加
        </Button>
        <Button type="primary" onClick={handleSave} loading={saving}>
          保存
        </Button>
      </Space>
    </Card>
  )
}
