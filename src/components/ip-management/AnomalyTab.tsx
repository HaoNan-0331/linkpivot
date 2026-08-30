import { useState, useEffect } from 'react'
import { Button, Table, Card, Row, Col, Statistic, Tag, Modal, Input, Popconfirm, message, Tabs } from 'antd'
import { DeleteOutlined, PlusOutlined, HistoryOutlined } from '@ant-design/icons'
import type { ElectronAPI } from '@/types/electron'
import type { IPMACChange, ChangeStats, ExcludedIP, IPMACBinding, CreateExcludedIPInput } from '@/types/anomaly'
import { TruncatedAlert, rangeShowTotal } from '@/components/common/TruncatedAlert'

interface AnomalyTabProps { api: ElectronAPI }

const changeTypeMap: Record<string, { label: string; color: string }> = {
  mac_changed: { label: 'MAC变化', color: 'orange' },
  new_ip: { label: '新IP', color: 'blue' },
  ip_reused: { label: 'IP重用', color: 'purple' },
}

export default function AnomalyTab({ api }: AnomalyTabProps) {
  const [stats, setStats] = useState<ChangeStats>({} as ChangeStats)
  const [changes, setChanges] = useState<IPMACChange[]>([])
  // Phase 19 REN-01 D-01~D-03：getChanges 信封驱动截断提示
  const [changesEnvelope, setChangesEnvelope] = useState<{ total: number; truncated: boolean }>({ total: 0, truncated: false })
  const [excludedIPs, setExcludedIPs] = useState<ExcludedIP[]>([])
  const [loading, setLoading] = useState(false)
  const [historyIp, setHistoryIp] = useState<string | null>(null)
  const [historyData, setHistoryData] = useState<IPMACBinding[]>([])
  const [addExcludeOpen, setAddExcludeOpen] = useState(false)
  const [excludeForm, setExcludeForm] = useState<CreateExcludedIPInput>({ ipOrCidr: '', description: '' })
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([])

  const loadData = async () => {
    setLoading(true)
    try {
      const [s, c, e] = await Promise.all([
        api.anomaly.getStats(),
        api.anomaly.getChanges(),
        api.anomaly.getExcludedIPs(),
      ])
      setStats(s)
      setChanges(c.rows)
      setChangesEnvelope({ total: c.total, truncated: c.truncated })
      setExcludedIPs(e)
    } finally { setLoading(false) }
  }

  useEffect(() => { loadData() }, [])

  const acknowledge = async (id: number, notes?: string) => {
    try {
      await api.anomaly.acknowledge(id, notes)
      message.success('已确认')
      loadData()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const acknowledgeAll = async () => {
    try {
      const count = await api.anomaly.acknowledgeAll()
      message.success(`已确认 ${count} 条`)
      loadData()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const deleteChanges = async (ids: number[]) => {
    try {
      await api.anomaly.deleteChanges(ids)
      message.success('已删除')
      setSelectedRowKeys([])
      loadData()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const batchExclude = async () => {
    const ips = selectedRowKeys.map(id => {
      const change = changes.find(c => c.id === id)
      return change?.ip
    }).filter(Boolean)
    try {
      for (const ip of ips) {
        if (!ip) continue
        await api.anomaly.addExcludedIP({ ipOrCidr: ip })
      }
      message.success(`已排除 ${ips.length} 个 IP`)
      setSelectedRowKeys([])
      loadData()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const showHistory = async (ip: string) => {
    try {
      setHistoryIp(ip)
      setHistoryData(await api.anomaly.getBindingHistory(ip))
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const addExclude = async () => {
    try {
      await api.anomaly.addExcludedIP(excludeForm)
      setAddExcludeOpen(false)
      setExcludeForm({ ipOrCidr: '', description: '' })
      message.success('已添加')
      loadData()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const deleteExclude = async (id: number) => {
    try {
      await api.anomaly.deleteExcludedIP(id)
      loadData()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const exportChanges = async (unackOnly: boolean = false) => {
    try {
      const path = await api.export.changes(unackOnly)
      if (path) message.success('导出成功: ' + path)
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const changeColumns = [
    { title: 'IP', dataIndex: 'ip', key: 'ip' },
    {
      title: '类型', dataIndex: 'changeType', key: 'changeType',
      render: (v: string) => { const t = changeTypeMap[v]; return t ? <Tag color={t.color}>{t.label}</Tag> : v },
    },
    { title: '原 MAC', dataIndex: 'oldMac', key: 'oldMac' },
    { title: '新 MAC', dataIndex: 'newMac', key: 'newMac' },
    { title: '检测时间', dataIndex: 'detectedAt', key: 'detectedAt' },
    {
      title: '状态', dataIndex: 'acknowledged', key: 'acknowledged',
      render: (v: boolean) => v ? <Tag color="green">已确认</Tag> : <Tag color="red">未确认</Tag>,
    },
    {
      title: '操作', key: 'actions',
      render: (_: unknown, record: IPMACChange) => (
        <>
          {!record.acknowledged && <Button type="link" size="small" onClick={() => acknowledge(record.id)}>确认</Button>}
          <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showHistory(record.ip)} />
        </>
      ),
    },
  ]

  const excludeColumns = [
    { title: 'IP/CIDR', dataIndex: 'ipOrCidr', key: 'ipOrCidr' },
    { title: '描述', dataIndex: 'description', key: 'description' },
    {
      title: '操作', key: 'actions',
      render: (_: unknown, record: ExcludedIP) => (
        <Popconfirm title="确定删除?" onConfirm={() => deleteExclude(record.id)}>
          <Button type="link" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={5}><Card size="small"><Statistic title="总事件" value={stats.total} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="未确认" value={stats.unacknowledged} valueStyle={{ color: 'var(--nt-static-red-900)' }} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="MAC变化" value={stats.macChanged} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="新IP" value={stats.newIp} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="IP重用" value={stats.ipReused} /></Card></Col>
      </Row>

      <Tabs items={[
        {
          key: 'changes', label: '变更事件',
          children: (
            <>
              <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                <Button onClick={acknowledgeAll} disabled={(stats.unacknowledged || 0) === 0}>全部确认</Button>
                <Popconfirm title="确定删除选中的事件?" onConfirm={() => deleteChanges(selectedRowKeys)}>
                  <Button danger disabled={selectedRowKeys.length === 0}>删除选中 ({selectedRowKeys.length})</Button>
                </Popconfirm>
                <Button onClick={batchExclude} disabled={selectedRowKeys.length === 0}>排除选中 IP</Button>
                <Button onClick={() => exportChanges(false)}>导出全部</Button>
                <Button onClick={() => exportChanges(true)}>导出未确认</Button>
              </div>
              {/* Phase 19 REN-01 D-01~D-03：truncated=true 常驻 Alert；total 不传信封值（客户端 cap 红线）；排除 IP 子表与绑定历史 Modal 不动 */}
              <TruncatedAlert truncated={changesEnvelope.truncated} shown={changes.length} total={changesEnvelope.total}
                guidance="已超出单次加载上限，可删除已处理事件缩小列表，或「导出全部」CSV 获取完整记录" />
              <Table dataSource={changes} columns={changeColumns} rowKey="id" size="small"
                loading={loading}
                rowSelection={{ selectedRowKeys, onChange: (keys) => setSelectedRowKeys(keys as number[]) }}
                pagination={{ pageSize: 20, showTotal: rangeShowTotal }} />
            </>
          ),
        },
        {
          key: 'excluded', label: '排除 IP',
          children: (
            <>
              <div style={{ marginBottom: 8 }}>
                <Button icon={<PlusOutlined />} onClick={() => setAddExcludeOpen(true)}>添加排除规则</Button>
                <span style={{ marginLeft: 8, color: 'var(--nt-alias-label-tertiary)' }}>支持 IP、CIDR(192.168.1.0/24)、通配符(192.168.1.*)</span>
              </div>
              <Table dataSource={excludedIPs} columns={excludeColumns} rowKey="id" size="small" pagination={false} />
            </>
          ),
        },
      ]} />

      {/* 绑定历史弹窗 */}
      <Modal title={`IP 绑定历史 - ${historyIp}`} open={!!historyIp} onCancel={() => setHistoryIp(null)} footer={null} width={600}>
        <Table dataSource={historyData} columns={[
          { title: 'MAC', dataIndex: 'mac', key: 'mac' },
          { title: '首次发现', dataIndex: 'firstSeen', key: 'firstSeen' },
          { title: '最后发现', dataIndex: 'lastSeen', key: 'lastSeen' },
          { title: '状态', dataIndex: 'isActive', key: 'isActive', render: (v: boolean) => v ? <Tag color="green">活跃</Tag> : <Tag>非活跃</Tag> },
        ]} rowKey="id" size="small" pagination={false} />
      </Modal>

      {/* 添加排除规则弹窗 */}
      <Modal title="添加排除规则" open={addExcludeOpen} onOk={addExclude} onCancel={() => setAddExcludeOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input placeholder="IP / CIDR / 通配符" value={excludeForm.ipOrCidr} onChange={e => setExcludeForm({ ...excludeForm, ipOrCidr: e.target.value })} />
          <Input placeholder="描述(可选)" value={excludeForm.description} onChange={e => setExcludeForm({ ...excludeForm, description: e.target.value })} />
        </div>
      </Modal>
    </div>
  )
}
