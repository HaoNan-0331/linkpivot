import { useState, useEffect } from 'react'
import type { CSSProperties } from 'react'
import { Table, Button, Space, Popconfirm, message, notification, Typography, Alert, Tooltip } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined, CopyOutlined } from '@ant-design/icons'
import DeviceForm from '../DeviceForm'
import DuplicateNamesModal from '../DuplicateNamesModal'
import type { Device, CreateDeviceDTO } from '../../types/device'
import { CHANNEL_LABELS } from '../../types/device'

const { Title } = Typography

/** Phase 36（36-04，UI-SPEC §三/§八）：+N 多通道后缀——自研内联文本微结构（12/18 label-caption） */
const PLUS_SUFFIX_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-xxs-12-font-size)',
  lineHeight: 'var(--nt-font-xxs-12-line-height)',
  color: 'var(--nt-alias-label-caption)',
}

/** Phase 36（36-05 checkpoint 用户裁决，Q1 变更）：多通道测试结果行——xxs-12 行（audit ③④ token 化） */
const CHANNEL_RESULT_LINE_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-xxs-12-font-size)',
  lineHeight: 'var(--nt-font-xxs-12-line-height)',
}

const deviceTypeLabels: Record<string, string> = {
  router: '路由器', switch: '交换机', firewall: '防火墙', server: '服务器', generic: '通用',
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Device | null>(null)
  // Phase 25（ASSET-01）：复制入口——独立 state，不改既有 editing 语义
  const [copySource, setCopySource] = useState<Device | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  // Phase 25（ASSET-04/D-08）：存量重名分组——非空时顶部黄色 Alert 引导，清零后自动消失
  const [dupGroups, setDupGroups] = useState<Array<{ nameHash: string; devices: unknown[] }>>([])
  const [dupModalOpen, setDupModalOpen] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setDevices(await window.api.device.list()) } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
    setLoading(false)
  }

  // 只读通道：失败静默降级为不显示 Alert（非阻断引导，不让重名查询故障影响设备页）
  const loadDupGroups = async () => {
    try { setDupGroups(await window.api.device.listDuplicates()) } catch (e) { console.warn('listDuplicates failed', e) }
  }

  useEffect(() => { load(); loadDupGroups() }, [])

  const handleCreate = async (values: CreateDeviceDTO) => {
    try {
      await window.api.device.create(values)
      message.success('设备添加成功')
      setFormOpen(false); setCopySource(null); load()
    } catch (e: unknown) {
      message.error(`添加失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleUpdate = async (values: CreateDeviceDTO) => {
    if (!editing) return
    // H-1（36-04 按通道节形态）：「留空=不修改」剔除已在 DeviceForm handleFinish 内完成
    //（on 节空凭证字段剔除；off 节 enabled:false 交服务层 DELETE）——本处纯透传，勿双重剔除。
    try {
      await window.api.device.update(editing.id, values)
      message.success('设备更新成功')
      setEditing(null); setFormOpen(false); load(); loadDupGroups()
    } catch (e: unknown) {
      // D-09：updateDevice 18-02 已事务化，失败即整体回滚
      message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await window.api.device.delete(id)
      message.success('设备删除成功')
      load(); loadDupGroups()
    } catch (e: unknown) {
      // D-09：deleteDevice 18-02 已事务化，失败即整体回滚
      message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const handleTest = async (device: Device) => {
    setTestingId(device.id)
    try {
      const result = await window.api.connection.test(device.id)
      // Phase 36（36-05 checkpoint 用户裁决，Q1 变更）：全通道并行探测——0/1 通道保持原
      // message 形态（单通道 UX 等价旧版；零通道 = 「该设备未配置登录通道」）；
      // ≥2 通道 notification 逐通道 ✓/✗ 一屏全览（部分失败 warning / 全败 error / 全过 success）
      if (result.channels.length <= 1) {
        const only = result.channels[0]
        const text = `${device.name}: ${only ? only.message : result.message}`
        if (only && only.success) message.success(text)
        else message.error(text)
      } else {
        const passCount = result.channels.filter((c) => c.success).length
        notification.open({
          type: result.success ? 'success' : passCount === 0 ? 'error' : 'warning',
          // 顶部居中：默认右上角会遮挡页面标题区的「添加设备」按钮
          placement: 'top',
          message: `${device.name} 连接测试：${result.message}`,
          description: (
            <div>
              {result.channels.map((c) => (
                <div key={c.channel} style={CHANNEL_RESULT_LINE_STYLE}>
                  <span
                    style={{
                      color: c.success
                        ? 'var(--nt-alias-state-success-primary)'
                        : 'var(--nt-alias-state-error-primary)',
                      marginRight: 8,
                    }}
                  >
                    {c.success ? '✓' : '✗'}
                  </span>
                  <span style={{ marginRight: 8 }}>{CHANNEL_LABELS[c.channel]}</span>
                  <span>{c.message}</span>
                </div>
              ))}
            </div>
          ),
          duration: 8,
        })
      }
    } catch (e: unknown) {
      message.error(`${device.name}: 测试失败 - ${e instanceof Error ? e.message : String(e)}`)
    }
    setTestingId(null)
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>设备管理</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true) }}>添加设备</Button>
      </div>
      {dupGroups.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`存在 ${dupGroups.length} 组重名设备（共 ${dupGroups.reduce((n, g) => n + g.devices.length, 0)} 台），处理后自动启用名称唯一防护`}
          action={<Button size="small" danger onClick={() => setDupModalOpen(true)}>查看清单</Button>}
          closable={false}
        />
      )}
      <Table columns={[
        { title: '设备名称', dataIndex: 'name', key: 'name' },
        { title: '类型', dataIndex: 'deviceType', key: 'deviceType', render: (v: string) => deviceTypeLabels[v] || v },
        { title: '厂商', dataIndex: 'vendor', key: 'vendor' },
        { title: '型号', dataIndex: 'model', key: 'model' },
        { title: 'IP', dataIndex: 'ipAddress', key: 'ipAddress' },
        {
          title: '连接方式', dataIndex: 'connectionType', key: 'connectionType',
          // Phase 36（36-04，§八）：默认通道 toUpperCase + 多通道 +N 后缀 + 全通道 Tooltip；零通道「—」
          render: (_: unknown, r: Device) => {
            const channels = r.channels ?? []
            if (channels.length === 0) return '—'
            const def = channels.some((c) => c.channel === r.connectionType)
              ? r.connectionType
              : channels[0].channel
            const content = (
              <span>
                {def.toUpperCase()}
                {channels.length > 1 && (
                  <span style={PLUS_SUFFIX_STYLE}>{`+${channels.length - 1}`}</span>
                )}
              </span>
            )
            return (
              <Tooltip title={`已配通道：${channels.map((c) => CHANNEL_LABELS[c.channel]).join('、')}`}>
                {content}
              </Tooltip>
            )
          },
        },
        { title: '操作', key: 'action', render: (_: unknown, r: Device) => (
          <Space>
            <Button icon={<ApiOutlined />} type="text" loading={testingId === r.id} onClick={() => handleTest(r)} title="测试连接" />
            <Button icon={<EditOutlined />} type="text" onClick={() => { setEditing(r); setFormOpen(true) }} title="编辑" />
            <Button icon={<CopyOutlined />} type="text" onClick={() => { setCopySource(r); setEditing(null); setFormOpen(true) }} title="复制" />
            <Popconfirm title="删除设备将同时从拓扑中移除，确定删除？" onConfirm={() => handleDelete(r.id)}>
              <Button icon={<DeleteOutlined />} type="text" danger title="删除" />
            </Popconfirm>
          </Space>
        )},
      ]} dataSource={devices} rowKey="id" loading={loading} pagination={false} />
      <DeviceForm open={formOpen} device={editing} copySource={copySource} existingDevices={devices}
        onOk={editing ? handleUpdate : handleCreate}
        onCancel={() => { setFormOpen(false); setEditing(null); setCopySource(null) }} />
      <DuplicateNamesModal
        open={dupModalOpen}
        onClose={() => setDupModalOpen(false)}
        onChanged={() => { load(); loadDupGroups() }}
      />
    </div>
  )
}
