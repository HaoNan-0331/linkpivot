import { useState, useEffect } from 'react'
import { Switch, Card, Modal, Input, Typography, message, Space } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'

const { Text } = Typography

export default function ExecModeSwitch() {
  const [mode, setMode] = useState<'confirm' | 'auto'>('confirm')
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [password, setPassword] = useState('')
  const load = async () => {
    try {
      const m = await window.api.ai.getExecMode()
      setMode(m)
    } catch {
      // ignore
    }
  }

  useEffect(() => { load() }, [])

  const handleSwitch = (checked: boolean) => {
    const target: 'confirm' | 'auto' = checked ? 'auto' : 'confirm'
    if (target === 'auto') {
      setPassword('')
      setModalOpen(true)
    } else {
      doSwitch('confirm', '')
    }
  }

  const doSwitch = async (target: 'confirm' | 'auto', pwd: string) => {
    setLoading(true)
    try {
      const result = await window.api.ai.setExecMode(target, pwd)
      if (result.success) {
        setMode(target)
        message.success(`已切换为${target === 'auto' ? '自动执行' : '确认执行'}模式`)
      } else {
        message.error(result.error || '切换失败')
      }
    } catch (e: unknown) {
      // Phase 19 / REN-02：catch unknown + instanceof 窄化（OuiTab.tsx:71 范式）
      message.error(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  const handleConfirmModal = () => {
    if (!password.trim()) {
      message.warning('请输入管理员密码')
      return
    }
    setModalOpen(false)
    doSwitch('auto', password)
  }

  return (
    <>
      <Card title="执行模式" size="small">
        <Space direction="vertical" size={4}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Switch
              checked={mode === 'auto'}
              onChange={handleSwitch}
              loading={loading}
              checkedChildren="自动"
              unCheckedChildren="确认"
            />
            <Text>
              {mode === 'auto'
                ? '自动执行模式 — 白名单内命令直接执行，无需确认'
                : '确认执行模式 — 所有命令需人工确认后执行'}
            </Text>
          </div>
        </Space>
      </Card>

      <Modal
        open={modalOpen}
        title={
          <Space>
            <ExclamationCircleOutlined style={{ color: '#faad14' }} />
            切换到自动执行模式
          </Space>
        }
        okText="确认切换"
        cancelText="取消"
        onOk={handleConfirmModal}
        onCancel={() => setModalOpen(false)}
      >
        <div style={{ marginBottom: 16, color: '#666' }}>
          自动执行模式下，白名单内的命令将由 AI 直接在设备上执行，无需人工确认。
          <br />
          <Text type="danger">此操作存在风险，请输入管理员密码以确认。</Text>
        </div>
        <Input.Password
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入管理员密码"
          onPressEnter={handleConfirmModal}
        />
      </Modal>
    </>
  )
}
