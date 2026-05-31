import { useState, useEffect, useRef } from 'react'
import { Table, Button, Upload, Modal, message, Tag, Space, Popconfirm, Input, Select, Card } from 'antd'
import { UploadOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined, FileTextOutlined, FilePdfOutlined, FileWordOutlined } from '@ant-design/icons'

const CATEGORY_OPTIONS = [
  { value: 'manual', label: '手册' },
  { value: 'api', label: 'API文档' },
  { value: 'template', label: '配置模板' },
  { value: 'notes', label: '笔记' },
]

const FILE_TYPE_ICONS: Record<string, React.ReactNode> = {
  txt: <FileTextOutlined style={{ color: '#666' }} />,
  pdf: <FilePdfOutlined style={{ color: '#f5222d' }} />,
  docx: <FileWordOutlined style={{ color: '#1890ff' }} />,
}

const STATUS_MAP: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: '待处理' },
  processing: { color: 'processing', text: '处理中' },
  ready: { color: 'success', text: '就绪' },
  error: { color: 'error', text: '失败' },
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function KnowledgeBasePage() {
  const [documents, setDocuments] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [devices, setDevices] = useState<any[]>([])
  const [filterDevice, setFilterDevice] = useState<string | undefined>()
  const [filterCategory, setFilterCategory] = useState<string | undefined>()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [detailDoc, setDetailDoc] = useState<any>(null)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const pollingRef = useRef<number | null>(null)

  const loadDocuments = async () => {
    setLoading(true)
    try {
      const list = await window.api.kb.listDocuments(filterDevice, filterCategory)
      setDocuments(list as any[])
    } catch (err) {
      message.error('加载文档列表失败: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    window.api.device.list().then(list => setDevices(list as any[])).catch(() => {})
  }, [])

  useEffect(() => { loadDocuments() }, [filterDevice, filterCategory])

  // Poll processing documents
  useEffect(() => {
    const hasProcessing = documents.some((d) => d.status === 'pending' || d.status === 'processing')
    if (hasProcessing && !pollingRef.current) {
      pollingRef.current = window.setInterval(loadDocuments, 2000)
    }
    if (!hasProcessing && pollingRef.current) {
      window.clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    return () => { if (pollingRef.current) { window.clearInterval(pollingRef.current); pollingRef.current = null } }
  }, [documents])

  const handleUpload = async (file: File, category: string, deviceId: string | null) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'txt'
    const fileType = ext === 'doc' || ext === 'docx' ? 'docx' : ext
    const buffer = await file.arrayBuffer()
    try {
      await window.api.kb.uploadBuffer(buffer, file.name, fileType, file.size, category, deviceId)
      message.success(`${file.name} 上传成功`)
      loadDocuments()
    } catch (err) {
      message.error('上传失败: ' + (err as Error).message)
    }
  }

  const handleDelete = async (docId: string) => {
    try {
      await window.api.kb.deleteDocument(docId)
      message.success('删除成功')
      loadDocuments()
    } catch (err) {
      message.error('删除失败: ' + (err as Error).message)
    }
  }

  const handleReprocess = async (docId: string) => {
    try {
      await window.api.kb.reprocess(docId)
      message.success('已重新提交处理')
      loadDocuments()
    } catch (err) {
      message.error('重新处理失败: ' + (err as Error).message)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const results = await window.api.kb.search(searchQuery)
      setSearchResults(results as any[])
    } catch (err) {
      message.error('检索失败: ' + (err as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const showDetail = async (docId: string) => {
    try {
      const doc = await window.api.kb.getDocument(docId)
      setDetailDoc(doc)
      setDetailModalOpen(true)
    } catch (err) {
      message.error('获取详情失败: ' + (err as Error).message)
    }
  }

  const columns = [
    {
      title: '文件名',
      dataIndex: 'file_name',
      key: 'file_name',
      render: (name: string, record: any) => (
        <Space>
          {FILE_TYPE_ICONS[record.file_type] || <FileTextOutlined />}
          <a onClick={() => showDetail(record.id)}>{name}</a>
        </Space>
      ),
    },
    { title: '分类', dataIndex: 'category', key: 'category', width: 100, render: (v: string) => CATEGORY_OPTIONS.find(c => c.value === v)?.label || v },
    {
      title: '关联设备',
      dataIndex: 'device_id',
      key: 'device_id',
      width: 140,
      render: (id: string | null) => {
        if (!id) return <Tag>全局</Tag>
        const dev = devices.find((d) => d.id === id)
        return <span>{dev?.name || id}</span>
      },
    },
    { title: '大小', dataIndex: 'file_size', key: 'file_size', width: 100, render: (v: number) => formatSize(v) },
    { title: '分块数', dataIndex: 'chunk_count', key: 'chunk_count', width: 80 },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => {
        const s = STATUS_MAP[status] || { color: 'default', text: status }
        return <Tag color={s.color}>{s.text}</Tag>
      },
    },
    { title: '上传时间', dataIndex: 'created_at', key: 'created_at', width: 170 },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_: any, record: any) => (
        <Space>
          {record.status === 'error' && (
            <Button size="small" icon={<ReloadOutlined />} onClick={() => handleReprocess(record.id)}>重试</Button>
          )}
          <Popconfirm
            title="确认删除"
            description={`将删除文档"${record.file_name}"及其所有分块数据`}
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Card title="资料库" style={{ marginBottom: 16 }}>
        <Space wrap style={{ marginBottom: 16 }}>
          <Upload
            accept=".txt,.pdf,.doc,.docx"
            showUploadList={false}
            beforeUpload={(file) => {
              const ext = file.name.split('.').pop()?.toLowerCase()
              if (!['txt', 'pdf', 'doc', 'docx'].includes(ext || '')) {
                message.error('仅支持 TXT、PDF、Word 文件')
                return false
              }
              let uploadCategory = 'manual'
              let uploadDeviceId: string | null = null
              Modal.confirm({
                title: '上传文档',
                content: (
                  <div>
                    <p>{file.name} ({formatSize(file.size)})</p>
                    <Select defaultValue="manual" style={{ width: '100%', marginTop: 8 }} options={CATEGORY_OPTIONS} onChange={v => { uploadCategory = v }} />
                    <Select placeholder="关联设备（可选）" allowClear style={{ width: '100%', marginTop: 8 }}
                      options={[{ value: '', label: '全局文档' }, ...devices.map((d: any) => ({ value: d.id, label: d.name }))]}
                      onChange={v => { uploadDeviceId = v || null }}
                    />
                  </div>
                ),
                onOk: () => handleUpload(file, uploadCategory, uploadDeviceId),
              })
              return false
            }}
          >
            <Button type="primary" icon={<UploadOutlined />}>上传文档</Button>
          </Upload>
          <Select
            placeholder="筛选设备"
            allowClear
            style={{ width: 160 }}
            value={filterDevice}
            onChange={setFilterDevice}
            options={devices.map((d: any) => ({ value: d.id, label: d.name }))}
          />
          <Select
            placeholder="筛选分类"
            allowClear
            style={{ width: 120 }}
            value={filterCategory}
            onChange={setFilterCategory}
            options={CATEGORY_OPTIONS}
          />
        </Space>

        <Table
          columns={columns}
          dataSource={documents}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Card title="检索测试" style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
          <Input
            placeholder="输入关键词检索文档片段"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onPressEnter={handleSearch}
          />
          <Button type="primary" icon={<SearchOutlined />} loading={searching} onClick={handleSearch}>检索</Button>
        </Space.Compact>
        {searchResults.length > 0 && (
          <div>
            {searchResults.map((r: any, i: number) => (
              <Card key={r.id} size="small" style={{ marginBottom: 8 }} title={
                <Space>
                  <Tag color="blue">#{i + 1}</Tag>
                  <span style={{ fontWeight: 600 }}>{r.title || '无标题'}</span>
                  <span style={{ color: '#999' }}>来自: {r.document?.title}</span>
                </Space>
              }>
                <div style={{ maxHeight: 80, overflow: 'hidden' }}>
                  {r.content?.slice(0, 300)}{r.content?.length > 300 ? '...' : ''}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>

      <Modal
        title={detailDoc ? `文档详情 - ${detailDoc.title}` : '文档详情'}
        open={detailModalOpen}
        onCancel={() => setDetailModalOpen(false)}
        footer={null}
        width={700}
      >
        {detailDoc && (
          <div>
            <p><strong>文件名：</strong>{detailDoc.file_name}</p>
            <p><strong>类型：</strong>{detailDoc.file_type}</p>
            <p><strong>分类：</strong>{CATEGORY_OPTIONS.find(c => c.value === detailDoc.category)?.label}</p>
            <p><strong>状态：</strong><Tag color={STATUS_MAP[detailDoc.status]?.color}>{STATUS_MAP[detailDoc.status]?.text}</Tag></p>
            {detailDoc.error_message && <p><strong style={{ color: '#ff4d4f' }}>错误：</strong>{detailDoc.error_message}</p>}
            <p><strong>分块数：</strong>{detailDoc.chunk_count}</p>
            {detailDoc.chunks?.length > 0 && (
              <div>
                <strong>章节列表：</strong>
                {detailDoc.chunks.map((c: any) => (
                  <div key={c.id} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                    <Space>
                      <Tag>#{c.chunk_index + 1}</Tag>
                      <span>{c.title || '无标题'}</span>
                      <span style={{ color: '#999' }}>{c.char_count}字</span>
                    </Space>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
