import { useState, useEffect } from 'react'
import { Card, Form, Input, Button, Select, message, Divider, Space, Spin, Tabs, Switch, InputNumber, Row, Col } from 'antd'
import { LogoutOutlined, PlayCircleOutlined, DatabaseOutlined } from '@ant-design/icons'
import { useAuthStore } from '../../stores/authStore'
import CommandWhitelistEditor from '../settings/CommandWhitelistEditor'
import ExecModeSwitch from '../settings/ExecModeSwitch'
import type { AIConfig } from '../../types/electron'
import type { ScheduleConfig, SchedulerStatus } from '../../types/oui'

const providerOptions = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'custom', label: '自定义' },
]

export default function SettingsPage() {
  const [form] = Form.useForm()
  const [configLoading, setConfigLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [originalApiKey, setOriginalApiKey] = useState('')
  const [originalVisionApiKey, setOriginalVisionApiKey] = useState('')
  const logout = useAuthStore((s) => s.logout)

  // Scheduler state
  const [schedulerConfig, setSchedulerConfig] = useState<ScheduleConfig>({} as ScheduleConfig)
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus>({} as SchedulerStatus)
  const [schedulerLoading, setSchedulerLoading] = useState(false)
  // CR-01（18-REVIEW）：retentionDays 提交改 draft 本地态 + blur/Enter 提交——onChange 逐键提交会把
  // 输入过程的瞬态值（90→180 必经 "1"、"18"）落库并经 updateConfig→start() 启动钩子触发按瞬态
  // cutoff 的不可恢复批量 DELETE。draft 为 null 表示未编辑，展示并提交已落库配置值。
  const [retentionDraft, setRetentionDraft] = useState<number | null>(null)

  useEffect(() => { loadConfig(); loadScheduler() }, [])

  const loadConfig = async () => {
    try {
      const config = await window.api.ai.getConfig()
      if (config) {
        form.setFieldsValue(config)
        setOriginalApiKey(config.apiKey)
        setOriginalVisionApiKey(config.visionApiKey ?? '')
      }
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
    setConfigLoading(false)
  }

  const loadScheduler = async () => {
    try {
      const [config, status] = await Promise.all([window.api.scheduler.getConfig(), window.api.scheduler.getStatus()])
      setSchedulerConfig(config)
      setSchedulerStatus(status)
    } catch { /* ignore */ }
  }

  const handleSaveConfig = async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      // H-3：两个 Key 各自记录脱敏基准、各自比较——未改动的掩码串不进 payload，
      // 防任意保存把 **** 掩码串落库覆盖真实 Key（主进程 stripMaskedKeys 为第二道守卫）。
      const payload: Partial<AIConfig> = {
        provider: values.provider,
        baseUrl: values.baseUrl,
        modelName: values.modelName,
        visionBaseUrl: values.visionBaseUrl,
        visionModel: values.visionModel,
      }
      if (values.apiKey && values.apiKey !== originalApiKey) payload.apiKey = values.apiKey
      if (values.visionApiKey && values.visionApiKey !== originalVisionApiKey) payload.visionApiKey = values.visionApiKey
      await window.api.ai.saveConfig(payload as AIConfig)
      message.success('AI 配置已保存')
      const config = await window.api.ai.getConfig()
      if (config) {
        form.setFieldsValue(config)
        setOriginalApiKey(config.apiKey)
        setOriginalVisionApiKey(config.visionApiKey ?? '')
      }
    } catch (e: unknown) {
      // antd Form validateFields reject 返回 { errorFields } 对象
      if (e && typeof e === 'object' && 'errorFields' in e) return
      message.error(e instanceof Error ? e.message : String(e))
    }
    setSaving(false)
  }

  const handleToggleScheduler = async (enabled: boolean) => {
    setSchedulerLoading(true)
    try {
      const config = await window.api.scheduler.updateConfig({ enabled, intervalMinutes: schedulerConfig.intervalMinutes })
      setSchedulerConfig(config)
      message.success(enabled ? '已启用定时采集' : '已禁用定时采集')
      loadScheduler()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
    setSchedulerLoading(false)
  }

  const handleIntervalChange = async (value: number | null) => {
    if (!value) return
    setSchedulerLoading(true)
    try {
      const config = await window.api.scheduler.updateConfig({ intervalMinutes: value })
      setSchedulerConfig(config)
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
    setSchedulerLoading(false)
  }

  // 18-05（D-07）/ CR-01（18-REVIEW）：ARP 保留天数提交语义 = blur/Enter（非逐键）——retentionDays
  // 落库即可能触发 retention 清理（不可恢复删除），输入过程中的瞬态值（"1"/"18"）严禁提交。
  // 0 是合法特殊值（永不删除），不得 if (!value) return 短路（0 必须能提交），仅 null（未编辑）跳过；
  // 未变化/清空 draft 时直接复位，不发 IPC。
  const commitRetention = async () => {
    if (retentionDraft === null || retentionDraft === schedulerConfig.retentionDays) {
      setRetentionDraft(null)
      return
    }
    setSchedulerLoading(true)
    try {
      const config = await window.api.scheduler.updateConfig({ retentionDays: retentionDraft })
      setSchedulerConfig(config)
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
    setSchedulerLoading(false)
    setRetentionDraft(null)
  }

  const handleRunNow = async () => {
    setSchedulerLoading(true)
    try {
      const result = await window.api.scheduler.runNow()
      if (result.success) message.success(result.message)
      else message.warning(result.message)
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
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
          <Col><span>ARP 保留天数:</span></Col>
          <Col><InputNumber min={0} max={3650} value={retentionDraft ?? schedulerConfig.retentionDays ?? 90} onChange={setRetentionDraft} onBlur={commitRetention} onPressEnter={commitRetention} style={{ width: 100 }} /></Col>
          <Col><span style={{ color: '#999' }}>0=永不删除</span></Col>
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
