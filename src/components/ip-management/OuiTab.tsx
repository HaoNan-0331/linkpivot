import { useState, useEffect, useRef } from 'react'
import { Button, Table, Card, Row, Col, Statistic, Input, Modal, Form, Tag, Popconfirm, message } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ImportOutlined, SearchOutlined } from '@ant-design/icons'
import type { ElectronAPI } from '@/types/electron'
import type { OUIRow, OUIStats, CreateOUIInput } from '@/types/oui'
import { TruncatedAlert, rangeShowTotal } from '@/components/common/TruncatedAlert'

interface OuiTabProps { api: ElectronAPI }

export default function OuiTab({ api }: OuiTabProps) {
  const [entries, setEntries] = useState<OUIRow[]>([])
  // Phase 19 REN-01 D-01~D-03：getAll 信封驱动截断提示；search 裸数组路径须清空防陈旧误报（T-19-11 状态矩阵）
  const [envelope, setEnvelope] = useState<{ total: number; truncated: boolean }>({ total: 0, truncated: false })
  const [stats, setStats] = useState<OUIStats>({} as OUIStats)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<OUIRow | null>(null)
  const [form] = Form.useForm()
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const searchTimer = useRef<number | null>(null)

  const loadAll = async () => {
    setLoading(true)
    try {
      const [e, s] = await Promise.all([api.oui.getAll(), api.oui.getStats()])
      setEntries(e.rows)
      setEnvelope({ total: e.total, truncated: e.truncated })
      setStats(s)
    } finally { setLoading(false) }
  }

  useEffect(() => { loadAll() }, [])

  const search = async (kw: string) => {
    if (!kw) { loadAll(); return }
    setLoading(true)
    try {
      // search 返回裸数组无信封——清空 truncated 防陈旧截断误报（T-19-11）
      setEntries(await api.oui.search(kw))
      setEnvelope({ total: 0, truncated: false })
    } finally { setLoading(false) }
  }

  const onSearchChange = (value: string) => {
    setKeyword(value)
    if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => search(value), 300)
  }

  const openModal = (record?: OUIRow) => {
    setEditing(record || null)
    if (record) form.setFieldsValue({ ouiPrefix: record.oui_prefix, vendorName: record.vendor_name })
    else form.resetFields()
    setModalOpen(true)
  }

  const save = async () => {
    try {
      const values = await form.validateFields()
      if (editing) {
        await api.oui.update({ id: editing.id, ...values })
        message.success('更新成功')
      } else {
        await api.oui.add(values)
        message.success('添加成功')
      }
      setModalOpen(false)
      loadAll()
    } catch { /* validation */ }
  }

  const deleteEntry = async (id: number) => {
    try {
      await api.oui.delete(id)
      message.success('删除成功')
      loadAll()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const batchImport = async () => {
    const lines = importText.trim().split('\n').filter(Boolean)
    const importEntries: CreateOUIInput[] = lines.map(line => {
      const parts = line.split(',')
      return { ouiPrefix: parts[0]?.trim() || '', vendorName: parts[1]?.trim() || '' }
    }).filter(e => e.ouiPrefix && e.vendorName)

    if (importEntries.length === 0) { message.warning('无有效数据'); return }

    try {
      const count = await api.oui.addBatch(importEntries)
      message.success(`成功导入 ${count} 条`)
      setImportOpen(false)
      setImportText('')
      loadAll()
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const columns = [
    {
      title: 'OUI 前缀', dataIndex: 'oui_prefix', key: 'oui_prefix',
      render: (v: string) => {
        if (!v || v.length < 6) return v
        return `${v.slice(0, 2)}:${v.slice(2, 4)}:${v.slice(4, 6)}`
      },
    },
    { title: '厂商名称', dataIndex: 'vendor_name', key: 'vendor_name' },
    {
      title: '类型', dataIndex: 'is_custom', key: 'is_custom',
      render: (v: number) => v ? <Tag color="blue">自定义</Tag> : <Tag>系统</Tag>,
    },
    {
      title: '操作', key: 'actions',
      render: (_: unknown, record: OUIRow) => (
        <>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModal(record)} />
          {record.is_custom ? (
            <Popconfirm title="确定删除?" onConfirm={() => deleteEntry(record.id)}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          ) : null}
        </>
      ),
    },
  ]

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}><Card size="small"><Statistic title="总条目" value={stats.total} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="自定义" value={stats.custom} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="厂商数" value={stats.vendors} /></Card></Col>
      </Row>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <Input placeholder="搜索 OUI 前缀或厂商名称" value={keyword} onChange={e => onSearchChange(e.target.value)}
          prefix={<SearchOutlined />} style={{ width: 300 }} allowClear />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>添加</Button>
        <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>批量导入</Button>
      </div>

      {/* Phase 19 REN-01 D-01~D-03：truncated=true 常驻 Alert；total 不传信封值（客户端 cap 红线） */}
      <TruncatedAlert truncated={envelope.truncated} shown={entries.length} total={envelope.total}
        guidance="数据量超出单次加载上限，可通过上方搜索框按 OUI 前缀或厂商名筛选查看" />
      <Table dataSource={entries} columns={columns} rowKey="id" size="small" loading={loading}
        pagination={{ pageSize: 20, showTotal: rangeShowTotal }} />

      {/* 添加/编辑弹窗 */}
      <Modal title={editing ? '编辑 OUI' : '添加 OUI'} open={modalOpen} onOk={save} onCancel={() => setModalOpen(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="ouiPrefix" label="OUI 前缀" rules={[{ required: true }]}>
            <Input placeholder="6位十六进制，如: 001122 或 00:11:22" />
          </Form.Item>
          <Form.Item name="vendorName" label="厂商名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批量导入弹窗 */}
      <Modal title="批量导入 OUI" open={importOpen} onOk={batchImport} onCancel={() => setImportOpen(false)} width={500}>
        <p style={{ color: '#999', marginBottom: 8 }}>每行格式: OUI前缀,厂商名称 (如: 001122,Huawei)</p>
        <Input.TextArea rows={10} value={importText} onChange={e => setImportText(e.target.value)}
          placeholder="001122,Huawei&#10;00:11:22,Cisco&#10;334455,H3C" />
      </Modal>
    </div>
  )
}
