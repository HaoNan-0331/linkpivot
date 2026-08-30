import { useState, useEffect } from 'react'
import { Card, Modal, Input, Typography, message, Space, Segmented } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'

const { Text } = Typography

type ExecMode = 'confirm' | 'smart' | 'auto'

/** 首次切「智能」一次性提示 localStorage key（UI-SPEC 契约 1） */
const SMART_HINT_KEY = 'execModeSmartHintShown'

/** 三档说明文案（UI-SPEC Copywriting 表逐字） */
const MODE_DESC: Record<ExecMode, string> = {
  confirm: '每次确认 — 所有命令与工具调用一律弹窗确认，包括已勾免确认的工具（演示/交接时最稳）',
  smart: '智能 — 命令与写操作工具弹窗确认，已勾免确认的只读工具直接执行',
  auto: '全自动 — 白名单命令与全部工具直接执行，无需确认',
}

const MODE_LABEL: Record<ExecMode, string> = {
  confirm: '每次确认',
  smart: '智能',
  auto: '全自动',
}

export default function ExecModeSwitch() {
  const [mode, setMode] = useState<ExecMode>('confirm')
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

  const handleSwitch = (target: string | number) => {
    const t = target as ExecMode
    if (t === 'auto') {
      setPassword('')
      setModalOpen(true)
      return
    }
    if (t === 'smart' && !localStorage.getItem(SMART_HINT_KEY)) {
      message.info('智能模式：只读且已勾免确认的工具将直接执行')
      localStorage.setItem(SMART_HINT_KEY, '1')
    }
    doSwitch(t, '')
  }

  const doSwitch = async (target: ExecMode, pwd: string) => {
    setLoading(true)
    try {
      const result = await window.api.ai.setExecMode(target, pwd)
      if (result.success) {
        setMode(target)
        message.success(`已切换为「${MODE_LABEL[target]}」模式`)
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
            <Segmented<ExecMode>
              value={mode}
              onChange={handleSwitch}
              disabled={loading}
              options={[
                { label: MODE_LABEL.confirm, value: 'confirm' },
                { label: MODE_LABEL.smart, value: 'smart' },
                { label: MODE_LABEL.auto, value: 'auto' },
              ]}
            />
            <Text>{MODE_DESC[mode]}</Text>
          </div>
        </Space>
      </Card>

      <Modal
        open={modalOpen}
        title={
          <Space>
            <ExclamationCircleOutlined style={{ color: 'var(--nt-alias-state-warn-primary)' }} />
            切换到自动执行模式
          </Space>
        }
        okText="确认切换"
        cancelText="取消"
        onOk={handleConfirmModal}
        onCancel={() => setModalOpen(false)}
      >
        <div style={{ marginBottom: 16, color: 'var(--nt-alias-label-secondary)' }}>
          自动执行模式下，白名单内的命令将由 AI 直接在设备上执行，无需人工确认。
          <br />
          MCP 工具调用也将免确认直接在设备上执行。
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
