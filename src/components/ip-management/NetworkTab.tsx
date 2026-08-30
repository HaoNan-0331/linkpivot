import { useState, useEffect } from 'react'
import { Button, Table, Card, Modal, Form, Input, Row, Col, Statistic, message, Popconfirm } from 'antd'
import { PlusOutlined, SearchOutlined, ThunderboltOutlined, ExportOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import type { ElectronAPI } from '@/types/electron'
import type { NetworkSegment, IPUsage, IPDetail } from '@/types/network'
import { TruncatedAlert, rangeShowTotal } from '@/components/common/TruncatedAlert'

interface NetworkTabProps { api: ElectronAPI }

export default function NetworkTab({ api }: NetworkTabProps) {
  const [segments, setSegments] = useState<NetworkSegment[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [ipUsage, setIpUsage] = useState<IPUsage | null>(null)
  const [ipDetails, setIpDetails] = useState<IPDetail[]>([])
  // Phase 19 REN-01 D-01~D-03：保留 getIPDetails 信封 total/truncated 驱动截断提示
  const [ipEnvelope, setIpEnvelope] = useState<{ total: number; truncated: boolean }>({ total: 0, truncated: false })
  const [searchIp, setSearchIp] = useState('')
  const [searchMac, setSearchMac] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<NetworkSegment | null>(null)
  const [form] = Form.useForm()

  const loadSegments = async () => {
    setLoading(true)
    try { setSegments(await api.network.getAll()) } finally { setLoading(false) }
  }

  useEffect(() => { loadSegments() }, [])

  const selectSegment = async (id: number) => {
    setSelectedId(id)
    try {
      const [usage, details] = await Promise.all([
        api.network.getIPUsage(id),
        api.network.getIPDetails(id, searchIp, searchMac),
      ])
      setIpUsage(usage)
      setIpDetails(details.rows)
      setIpEnvelope({ total: details.total, truncated: details.truncated })
    } catch (e: unknown) {
      console.error('Failed to load segment details:', e)
      message.error('加载网段详情失败: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const searchIPs = async () => {
    if (selectedId) {
      try {
        // Phase 19 REN-01：searchIPs 同款保留信封（truncated 提示与 getAll 路径一致）
        const res = await api.network.getIPDetails(selectedId, searchIp, searchMac)
        setIpDetails(res.rows)
        setIpEnvelope({ total: res.total, truncated: res.truncated })
      } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
    }
  }

  const autoDiscover = async () => {
    try {
      const discovered = await api.network.autoDiscover()
      if (discovered.length > 0) {
        message.success(`发现 ${discovered.length} 个新网段`)
        loadSegments()
      } else { message.info('未发现新网段') }
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const exportUsage = async () => {
    try {
      const path = await api.export.networkUsage(selectedId || undefined)
      if (path) message.success('导出成功: ' + path)
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const openModal = (record?: NetworkSegment) => {
    setEditing(record || null)
    if (record) form.setFieldsValue(record)
    else form.resetFields()
    setModalOpen(true)
  }

  const saveSegment = async () => {
    try {
      const values = await form.validateFields()
      if (editing) {
        await api.network.update({ id: editing.id, ...values })
        message.success('更新成功')
      } else {
        await api.network.create(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      loadSegments()
    } catch { /* validation failed */ }
  }

  const deleteSegment = async (id: number) => {
    try {
      await api.network.delete(id)
      if (selectedId === id) { setSelectedId(null); setIpUsage(null); setIpDetails([]) }
      message.success('删除成功')
      loadSegments()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const segColumns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '网段', dataIndex: 'network', key: 'network' },
    { title: '掩码', dataIndex: 'mask', key: 'mask' },
    { title: 'CIDR', dataIndex: 'cidr', key: 'cidr' },
    { title: '网关', dataIndex: 'gateway', key: 'gateway' },
    {
      title: '来源', dataIndex: 'isAutoDiscovered', key: 'source',
      render: (v: boolean) => v ? <span style={{ color: 'var(--nt-alias-state-business-primary)' }}>自动发现</span> : '手动添加'
    },
    {
      title: '操作', key: 'actions',
      render: (_: unknown, record: NetworkSegment) => (
        <>
          <Button type="link" size="small" onClick={() => selectSegment(record.id)}>查看</Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModal(record)} />
          <Popconfirm title="确定删除此网段?" onConfirm={() => deleteSegment(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </>
      ),
    },
  ]

  const ipColumns = [
    { title: 'IP 地址', dataIndex: 'ip', key: 'ip' },
    { title: 'MAC 地址', dataIndex: 'mac', key: 'mac' },
    { title: '厂商', dataIndex: 'macVendor', key: 'macVendor' },
    {
      title: '状态', dataIndex: 'status', key: 'status',
      render: (v: string) => <span style={{ color: v === 'used' ? 'var(--nt-alias-state-success-primary)' : 'var(--nt-alias-label-tertiary)' }}>{v === 'used' ? '已使用' : '弃用'}</span>
    },
    { title: '接口', dataIndex: 'interface', key: 'interface' },
    { title: '设备', dataIndex: 'deviceName', key: 'deviceName' },
    { title: '最后发现', dataIndex: 'lastSeen', key: 'lastSeen' },
  ]

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>添加网段</Button>
        <Button icon={<ThunderboltOutlined />} onClick={autoDiscover}>自动发现</Button>
        <Button icon={<ExportOutlined />} onClick={exportUsage} disabled={!selectedId}>导出</Button>
      </div>

      <Row gutter={16}>
        <Col span={10}>
          <Table dataSource={segments} columns={segColumns} rowKey="id" size="small"
            loading={loading} pagination={false} scroll={{ x: 'max-content' }}
            onRow={(record) => ({ onClick: () => selectSegment(record.id), style: { cursor: 'pointer', background: selectedId === record.id ? 'var(--nt-alias-state-business-tertiary)' : undefined } })}
          />
        </Col>
        <Col span={14}>
          {ipUsage ? (
            <>
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={6}><Statistic title="总IP" value={ipUsage.total} /></Col>
                <Col span={6}><Statistic title="已使用" value={ipUsage.used} valueStyle={{ color: 'var(--nt-alias-state-success-primary)' }} /></Col>
                <Col span={6}><Statistic title="可用" value={ipUsage.available} valueStyle={{ color: 'var(--nt-alias-state-business-primary)' }} /></Col>
                <Col span={6}><Statistic title="使用率" value={ipUsage.usagePercent} suffix="%" /></Col>
              </Row>
              <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                <Input placeholder="搜索 IP" value={searchIp} onChange={e => setSearchIp(e.target.value)} onPressEnter={searchIPs} prefix={<SearchOutlined />} style={{ width: 200 }} />
                <Input placeholder="搜索 MAC" value={searchMac} onChange={e => setSearchMac(e.target.value)} onPressEnter={searchIPs} style={{ width: 200 }} />
                <Button onClick={searchIPs}>搜索</Button>
              </div>
              {/* Phase 19 REN-01 D-01~D-03：truncated=true 常驻 Alert；total 不传信封值（客户端 cap 红线） */}
              <TruncatedAlert truncated={ipEnvelope.truncated} shown={ipDetails.length} total={ipEnvelope.total}
                guidance="当前网段 IP 超出单次加载上限，可点击右上方「导出」获取该网段完整 IP 清单（CSV）" />
              <Table dataSource={ipDetails} columns={ipColumns} rowKey="ip" size="small"
                pagination={{ pageSize: 20, showTotal: rangeShowTotal }} scroll={{ x: 'max-content' }} />
            </>
          ) : (
            <Card><span style={{ color: 'var(--nt-alias-label-tertiary)' }}>请选择一个网段查看 IP 详情</span></Card>
          )}
        </Col>
      </Row>

      <Modal title={editing ? '编辑网段' : '添加网段'} open={modalOpen} onOk={saveSegment} onCancel={() => setModalOpen(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="network" label="网络地址" rules={[{ required: true }]}>
            <Input placeholder="如: 192.168.1.0" />
          </Form.Item>
          <Form.Item name="mask" label="子网掩码" rules={[{ required: true }]}>
            <Input placeholder="如: 255.255.255.0" />
          </Form.Item>
          <Form.Item name="gateway" label="网关">
            <Input placeholder="可选" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
