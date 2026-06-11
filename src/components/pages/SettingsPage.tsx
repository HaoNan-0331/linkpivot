import { useState, useEffect } from 'react'
import { Card, Form, Input, Button, Select, message, Divider, Space, Spin, Tabs, Switch, InputNumber, Row, Col } from 'antd'
import { LogoutOutlined, PlayCircleOutlined, DatabaseOutlined } from '@ant-design/icons'
import { useAuthStore } from '../../stores/authStore'
import CommandWhitelistEditor from '../settings/CommandWhitelistEditor'
import ExecModeSwitch from '../settings/ExecModeSwitch'
import type { AIConfig } from '../../types/electron'

const providerOptions = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'custom', label: '自定义' },
]

const api = (window as any).api

export default function SettingsPage() {
  const [form] = Form.useForm()
  const [configLoading, setConfigLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [originalApiKey, setOriginalApiKey] = useState('')
  const logout = useAuthStore((s) => s.logout)

  // Scheduler state
  const [schedulerConfig, setSchedulerConfig] = useState<any>({})
  const [schedulerStatus, setSchedulerStatus] = useState<any>({})
  const [schedulerLoading, setSchedulerLoading] = useState(false)

  useEffect(() => { loadConfig(); loadScheduler() }, [])

  const loadConfig = async () => {
    try {
      const config = await window.api.ai.getConfig()
      if (config) { form.setFieldsValue(config); setOriginalApiKey(config.apiKey) }
    } catch (e: any) { message.error(e.message) }
    setConfigLoading(false)
  }

  const loadScheduler = async () => {
    try {
      const [config, status] = await Promise.all([api.scheduler.getConfig(), api.scheduler.getStatus()])
      setSchedulerConfig(config)
      setSchedulerStatus(status)
    } catch { /* ignore */ }
  }

  const handleSaveConfig = async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      const payload: Partial<AIConfig> = {
        provider: values.provider,
        baseUrl: values.baseUrl,
        modelName: values.modelName,
        visionBaseUrl: values.visionBaseUrl,
        visionApiKey: values.visionApiKey,
        visionModel: values.visionModel,
      }
      if (values.apiKey && values.apiKey !== originalApiKey) payload.apiKey = values.apiKey
      if (values.visionApiKey && values.visionApiKey !== originalApiKey) payload.visionApiKey = values.visionApiKey
      await window.api.ai.saveConfig(payload as AIConfig)
      message.success('AI 配置已保存')
      const config = await window.api.ai.getConfig()
      if (config) { form.setFieldsValue(config); setOriginalApiKey(config.apiKey) }
    } catch (e: any) { if (e.errorFields) return; message.error(e.message) }
    setSaving(false)
  }

  const handleToggleScheduler = async (enabled: boolean) => {
    setSchedulerLoading(true)
    try {
      const config = await api.scheduler.updateConfig({ enabled, intervalMinutes: schedulerConfig.intervalMinutes })
      setSchedulerConfig(config)
      message.success(enabled ? '已启用定时采集' : '已禁用定时采集')
      loadScheduler()
    } catch (e: any) { message.error(e.message) }
    setSchedulerLoading(false)
  }

  const handleIntervalChange = async (value: number | null) => {
    if (!value) return
    setSchedulerLoading(true)
    try {
      const config = await api.scheduler.updateConfig({ intervalMinutes: value })
      setSchedulerConfig(config)
    } catch (e: any) { message.error(e.message) }
    setSchedulerLoading(false)
  }

  const handleRunNow = async () => {
    setSchedulerLoading(true)
    try {
      const result = await api.scheduler.runNow()
      if (result.success) message.success(result.message)
      else message.warning(result.message)
    } catch (e: any) { message.error(e.message) }
    setSchedulerLoading(false)
    loadScheduler()
  }

  if (configLoading) {
    return <div style={{ textAlign: 'center', paddingTop: 100 }}><Spin size="large" /></div>
  }

  const generalSettings = (
    <div>
      <Card title="AI 模型配置" size="small" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical" initialValues={{ provider: 'openai' }}>
          <Form.Item label="提供商" name="provider" rules={[{ required: true, message: '请选择提供商' }]}>
            <Select options={providerOptions} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item label="API Key" name="apiKey">
            <Input.Password placeholder="输入 API Key" />
          </Form.Item>
          <Form.Item label="Base URL" name="baseUrl">
            <Input placeholder="如 https://api.openai.com/v1（可留空使用默认值）" />
          </Form.Item>
          <Form.Item label="模型名称" name="modelName" rules={[{ required: true, message: '请输入模型名称' }]}>
            <Input placeholder="如 gpt-4o" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={handleSaveConfig} loading={saving}>保存配置</Button>
          </Form.Item>
        </Form>
      </Card>
      <Card title="多模态模型配置" size="small" style={{ marginBottom: 16 }}>
        <p style={{ color: '#999', fontSize: 12, marginTop: 0 }}>用于资料库图片识别。未配置时，图片功能将降级（图片仅存储不生成描述）。</p>
        <Form form={form} layout="vertical">
          <Form.Item label="Base URL" name="visionBaseUrl">
            <Input placeholder="留空则使用上方 AI 模型的 Base URL" />
          </Form.Item>
          <Form.Item label="API Key" name="visionApiKey">
            <Input.Password placeholder="留空则使用上方 AI 模型的 API Key" />
          </Form.Item>
          <Form.Item label="模型名称" name="visionModel">
            <Input placeholder="如 gpt-4o、claude-3-sonnet（需支持图片输入）" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={handleSaveConfig} loading={saving}>保存配置</Button>
          </Form.Item>
        </Form>
      </Card>
      <div style={{ marginBottom: 16 }}><CommandWhitelistEditor /></div>
      <div style={{ marginBottom: 16 }}><ExecModeSwitch /></div>
      <Divider />
      <Space>
        <Button icon={<LogoutOutlined />} danger onClick={logout}>退出登录</Button>
      </Space>
    </div>
  )

  const ipSettings = (
    <div>
      <Card title="定时采集" size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col><span>启用定时采集:</span></Col>
          <Col><Switch checked={!!schedulerConfig.enabled} onChange={handleToggleScheduler} loading={schedulerLoading} /></Col>
          <Col><span>间隔(分钟):</span></Col>
          <Col><InputNumber min={5} max={1440} value={schedulerConfig.intervalMinutes || 60} onChange={handleIntervalChange} style={{ width: 100 }} /></Col>
          <Col><Button icon={<PlayCircleOutlined />} onClick={handleRunNow} loading={schedulerLoading}>立即运行</Button></Col>
        </Row>
        <div style={{ marginTop: 12, color: '#666' }}>
          {schedulerConfig.lastRun && <span>上次运行: {schedulerConfig.lastRun} | </span>}
          {schedulerConfig.nextRun && <span>下次运行: {schedulerConfig.nextRun}</span>}
          {schedulerStatus.isTaskRunning && <span style={{ color: '#1890ff', marginLeft: 8 }}>正在运行中...</span>}
        </div>
      </Card>
      <Card title="数据库管理" size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical">
          <span>IP 管理数据存储在拓扑管理数据库中</span>
          <Button icon={<DatabaseOutlined />} onClick={async () => {
            try {
              message.info('请通过文件管理器访问数据库目录')
            } catch { message.info('请通过系统设置查看数据库位置') }
          }}>打开数据目录</Button>
        </Space>
      </Card>
    </div>
  )

  return (
    <div style={{ maxWidth: 900, padding: 16 }}>
      <Tabs items={[
        { key: 'general', label: '通用设置', children: generalSettings },
        { key: 'ip', label: 'IP 管理', children: ipSettings },
      ]} />
    </div>
  )
}
