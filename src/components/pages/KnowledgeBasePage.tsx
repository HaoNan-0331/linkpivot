import { useState, useEffect, useRef } from 'react'
import { Table, Button, Upload, Modal, message, Tag, Space, Popconfirm, Input, Select, Card, Checkbox, InputNumber, Tabs, Alert } from 'antd'
import { UploadOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined, FileTextOutlined, FilePdfOutlined, FileWordOutlined, EditOutlined, MergeCellsOutlined, ScissorOutlined, SaveOutlined, CloseOutlined } from '@ant-design/icons'
import type { KbDocument, KbChunk, KbImage, KbSearchResult, KbSearchEnvelope } from '@/types/kb'
import type { Device } from '@/types/device'
import { getImage } from './kb/imageCache'
import ExperienceTab from '../knowledge/ExperienceTab'

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

function ChunkContent({ content, images }: { content: string; images: KbImage[] }) {
  const [imgDataMap, setImgDataMap] = useState<Record<string, string>>({})
  const [previewImg, setPreviewImg] = useState<string | null>(null)

  useEffect(() => {
    if (!images || images.length === 0) return
    // FE-04 (D-5-5): AbortController 替代 cancelled 标志位，结构化取消
    const controller = new AbortController()
    const signal = controller.signal
    Promise.all(images.map(async (img: KbImage) => {
      try {
        const data = await getImage(img.file_path, signal)
        // 卸载/切换后 abort → 不 setState
        if (!signal.aborted && data) {
          setImgDataMap(prev => ({ ...prev, [img.id]: data }))
        }
      } catch {
        // FRAG-2 顺带：图片失败不再完全静默，console.warn 提供反馈（UI 不崩）
        console.warn('[kb] 图片加载失败:', img.file_path)
      }
    }))
    return () => { controller.abort() } // 卸载/切换取消在途（结构化）
  }, [images])

  // Collect all [图片N] markers in order, map to images array index
  const markers = [...content.matchAll(/\[图片(\d+)\]/g)]
  const markerToImgIdx: Record<number, number> = {}
  markers.forEach((m, i) => { markerToImgIdx[parseInt(m[1], 10)] = i })

  const parts = content.split(/(\[图片\d+\])/g)

  return (
    <>
      <div style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', fontSize: 13, color: '#333', lineHeight: 1.8 }}>
        {parts.map((part, i) => {
          const match = part.match(/^\[图片(\d+)\]$/)
          if (match) {
            const imgNum = parseInt(match[1], 10)
            const localIdx = markerToImgIdx[imgNum]
            const img = localIdx !== undefined ? images?.[localIdx] : undefined
            if (img && imgDataMap[img.id]) {
              return (
                <span key={i} style={{ display: 'inline-block', verticalAlign: 'middle', margin: '4px 2px', cursor: 'pointer' }}
                  onClick={() => setPreviewImg(imgDataMap[img.id])}>
                  <img src={imgDataMap[img.id]} alt={img.description || `图片${imgNum}`}
                    style={{ maxWidth: 280, maxHeight: 180, borderRadius: 4, border: '1px solid #e8e8e8' }} />
                </span>
              )
            }
            return <span key={i} style={{ color: '#999', fontSize: 12, background: '#f5f5f5', padding: '2px 6px', borderRadius: 4 }}>{part}</span>
          }
          return <span key={i}>{part}</span>
        })}
      </div>
      {previewImg && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          onClick={() => setPreviewImg(null)}>
          <img src={previewImg} alt="预览" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'absolute', top: 20, right: 30, color: '#fff', fontSize: 28, cursor: 'pointer' }} onClick={() => setPreviewImg(null)}>✕</div>
        </div>
      )}
    </>
  )
}

export default function KnowledgeBasePage() {
  const [documents, setDocuments] = useState<KbDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [filterDevice, setFilterDevice] = useState<string | undefined>()
  const [filterCategory, setFilterCategory] = useState<string | undefined>()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KbSearchResult[]>([])
  // TXN-04 (18-01)：检索信封元数据（degraded/indexTotal/indexCapped），驱动降级 Alert warning（D-08）
  const [searchEnvelope, setSearchEnvelope] = useState<KbSearchEnvelope | null>(null)
  const [searching, setSearching] = useState(false)
  const [detailDoc, setDetailDoc] = useState<KbDocument | null>(null)
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [editingChunkId, setEditingChunkId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [selectedChunks, setSelectedChunks] = useState<string[]>([])
  const [splitModalOpen, setSplitModalOpen] = useState(false)
  const [splitChunkId, setSplitChunkId] = useState('')
  const [splitPos, setSplitPos] = useState(0)
  const [splitTitle1, setSplitTitle1] = useState('')
  const [splitTitle2, setSplitTitle2] = useState('')
  const pollingRef = useRef<number | null>(null)
  // Phase 10（UI-SPEC §1）：经验 Tab 懒加载（首次切到 exp 才挂载，避免默认文档 Tab 无谓加载经验列表）
  const [expTabLoaded, setExpTabLoaded] = useState(false)

  const loadDocuments = async () => {
    setLoading(true)
    try {
      const list = await window.api.kb.listDocuments(filterDevice, filterCategory)
      setDocuments(list)
    } catch (err) {
      message.error('加载文档列表失败: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    window.api.device.list().then(list => setDevices(list)).catch(() => {})
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
      // D-09：deleteDocument 多写已事务化，失败即整体回滚
      message.error('操作失败，数据已回滚无变化：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleReprocess = async (docId: string) => {
    try {
      await window.api.kb.reprocess(docId)
      message.success('已重新提交处理')
      loadDocuments()
    } catch (err) {
      // D-09：reprocessDocument 18-02 三段式事务化，失败即 DB 状态整体回滚
      message.error('操作失败，数据已回滚无变化：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const envelope = await window.api.kb.search(searchQuery)
      setSearchResults(envelope.rows)
      setSearchEnvelope(envelope)
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
      setEditingChunkId(null)
      setSelectedChunks([])
      setDetailModalOpen(true)
    } catch (err) {
      message.error('获取详情失败: ' + (err as Error).message)
    }
  }

  const reloadDetail = async () => {
    if (!detailDoc) return
    try {
      const doc = await window.api.kb.getDocument(detailDoc.id)
      setDetailDoc(doc)
      setEditingChunkId(null)
      setSelectedChunks([])
    } catch (err) {
      message.error('刷新失败: ' + (err as Error).message)
    }
  }

  const startEdit = (chunk: KbChunk) => {
    setEditingChunkId(chunk.id)
    setEditTitle(chunk.title || '')
    setEditContent(chunk.content || '')
  }

  const saveEdit = async () => {
    if (!editingChunkId) return
    try {
      await window.api.kb.updateChunk(editingChunkId, editTitle, editContent)
      message.success('保存成功')
      setEditingChunkId(null)
      reloadDetail()
    } catch (err) {
      message.error('保存失败: ' + (err as Error).message)
    }
  }

  const handleDeleteChunk = async (chunkId: string) => {
    try {
      await window.api.kb.deleteChunk(chunkId)
      message.success('章节已删除')
      reloadDetail()
      loadDocuments()
    } catch (err) {
      message.error('删除失败: ' + (err as Error).message)
    }
  }

  const handleMerge = async () => {
    if (selectedChunks.length < 2) {
      message.warning('请至少选择2个章节')
      return
    }
    if (!detailDoc || !detailDoc.chunks) return
    const chunks = detailDoc.chunks.filter((c: KbChunk) => selectedChunks.includes(c.id))
    const defaultTitle = chunks.map((c: KbChunk) => c.title).filter(Boolean).join(' + ')
    let mergeTitle = defaultTitle
    Modal.confirm({
      title: '合并章节',
      content: (
        <div>
          <p>将合并 {selectedChunks.length} 个章节</p>
          <Input defaultValue={defaultTitle} placeholder="合并后的标题" onChange={e => { mergeTitle = e.target.value }} />
        </div>
      ),
      onOk: async () => {
        try {
          await window.api.kb.mergeChunks(selectedChunks, mergeTitle)
          message.success('合并成功')
          setSelectedChunks([])
          reloadDetail()
          loadDocuments()
        } catch (err) {
          message.error('合并失败: ' + (err as Error).message)
        }
      },
    })
  }

  const openSplitModal = (chunk: KbChunk) => {
    setSplitChunkId(chunk.id)
    setSplitPos(Math.floor((chunk.content || '').length / 2))
    setSplitTitle1(chunk.title || '上半部分')
    setSplitTitle2('下半部分')
    setSplitModalOpen(true)
  }

  const handleSplit = async () => {
    try {
      await window.api.kb.splitChunk(splitChunkId, splitPos, splitTitle1, splitTitle2)
      message.success('拆分成功')
      setSplitModalOpen(false)
      reloadDetail()
      loadDocuments()
    } catch (err) {
      message.error('拆分失败: ' + (err as Error).message)
    }
  }

  const toggleChunkSelect = (chunkId: string) => {
    setSelectedChunks(prev =>
      prev.includes(chunkId) ? prev.filter(id => id !== chunkId) : [...prev, chunkId]
    )
  }

  const columns = [
    {
      title: '文件名',
      dataIndex: 'file_name',
      key: 'file_name',
      render: (name: string, record: KbDocument) => (
        <Space>
          {FILE_TYPE_ICONS[record.file_type ?? ''] || <FileTextOutlined />}
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
      width: 200,
      render: (status: string, record: KbDocument) => {
        const s = STATUS_MAP[status] || { color: 'default', text: status }
        return (
          <div>
            <Tag color={s.color}>{s.text}</Tag>
            {status === 'error' && record.error_message && (
              <div style={{ color: '#ff4d4f', fontSize: 12, marginTop: 2 }}>{record.error_message}</div>
            )}
          </div>
        )
      },
    },
    { title: '上传时间', dataIndex: 'created_at', key: 'created_at', width: 170 },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_: unknown, record: KbDocument) => (
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
      <Tabs
        defaultActiveKey="docs"
        onChange={(key) => {
          if (key === 'exp') setExpTabLoaded(true)
        }}
        items={[
          {
            key: 'docs',
            label: '文档',
            children: (
              <>
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
                      options={[{ value: '', label: '全局文档' }, ...devices.map((d) => ({ value: d.id, label: d.name }))]}
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
            options={devices.map((d) => ({ value: d.id, label: d.name }))}
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
        {/* TXN-04 (18-01) D-08：降级/截断可观测——正常路径（degraded=false 且 indexCapped=null）不渲染 */}
        {searchEnvelope && (searchEnvelope.degraded || searchEnvelope.indexCapped !== null) && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={searchEnvelope.degraded ? 'AI 筛选不可用，已降级为关键词匹配' : `已从 ${searchEnvelope.indexTotal} 条截取前 ${searchEnvelope.indexCapped} 条`}
            description={searchEnvelope.degraded && searchEnvelope.indexCapped !== null ? `已从 ${searchEnvelope.indexTotal} 条截取前 ${searchEnvelope.indexCapped} 条` : undefined}
          />
        )}
        {searchResults.length > 0 && (
          <div>
            {searchResults.map((r: KbSearchResult, i: number) => (
              <Card key={r.id} size="small" style={{ marginBottom: 8 }} title={
                <Space>
                  <Tag color="blue">#{i + 1}</Tag>
                  <span style={{ fontWeight: 600 }}>{r.title || '无标题'}</span>
                  <span style={{ color: '#999' }}>来自: {r.document?.title}</span>
                </Space>
              }>
                <ChunkContent content={r.content || ''} images={r.images || []} />
              </Card>
            ))}
          </div>
        )}
      </Card>
              </>
            ),
          },
          {
            key: 'exp',
            label: '经验',
            children: expTabLoaded ? <ExperienceTab /> : null,
          },
        ]}
      />

      <Modal
        title={detailDoc ? `文档详情 - ${detailDoc.title}` : '文档详情'}
        open={detailModalOpen}
        onCancel={() => { setDetailModalOpen(false); setEditingChunkId(null); setSelectedChunks([]) }}
        footer={null}
        width={900}
      >
        {detailDoc && (
          <div>
            <Space style={{ marginBottom: 12 }}>
              <span><strong>文件名：</strong>{detailDoc.file_name}</span>
              <span><strong>状态：</strong><Tag color={STATUS_MAP[detailDoc.status ?? '']?.color}>{STATUS_MAP[detailDoc.status ?? '']?.text}</Tag></span>
              <span><strong>分块数：</strong>{detailDoc.chunk_count}</span>
              {selectedChunks.length >= 2 && (
                <Button size="small" type="primary" icon={<MergeCellsOutlined />} onClick={handleMerge}>
                  合并选中({selectedChunks.length})
                </Button>
              )}
            </Space>
            {(detailDoc.chunks?.length ?? 0) > 0 ? detailDoc.chunks!.map((c: KbChunk) => (
              <Card
                key={c.id}
                size="small"
                style={{ marginBottom: 8 }}
                title={
                  <Space>
                    <Checkbox
                      checked={selectedChunks.includes(c.id)}
                      onChange={() => toggleChunkSelect(c.id)}
                    />
                    <Tag>#{c.chunk_index + 1}</Tag>
                    {editingChunkId === c.id ? (
                      <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} style={{ width: 200 }} />
                    ) : (
                      <span style={{ fontWeight: 600 }}>{c.title || '无标题'}</span>
                    )}
                    <span style={{ color: '#999' }}>{c.char_count}字</span>
                  </Space>
                }
                extra={
                  <Space>
                    {editingChunkId === c.id ? (
                      <>
                        <Button size="small" type="primary" icon={<SaveOutlined />} onClick={saveEdit}>保存</Button>
                        <Button size="small" icon={<CloseOutlined />} onClick={() => setEditingChunkId(null)}>取消</Button>
                      </>
                    ) : (
                      <>
                        <Button size="small" icon={<EditOutlined />} onClick={() => startEdit(c)}>编辑</Button>
                        <Button size="small" icon={<ScissorOutlined />} onClick={() => openSplitModal(c)}>拆分</Button>
                        <Popconfirm title="确认删除此章节？" onConfirm={() => handleDeleteChunk(c.id)} okText="删除" cancelText="取消">
                          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                        </Popconfirm>
                      </>
                    )}
                  </Space>
                }
              >
                {editingChunkId === c.id ? (
                  <Input.TextArea value={editContent} onChange={e => setEditContent(e.target.value)} rows={8} />
                ) : (
                  <ChunkContent content={c.content || ''} images={c.images || []} />
                )}
              </Card>
            )) : <p style={{ color: '#999' }}>暂无分块数据</p>}
          </div>
        )}
      </Modal>

      <Modal
        title="拆分章节"
        open={splitModalOpen}
        onOk={handleSplit}
        onCancel={() => setSplitModalOpen(false)}
        okText="拆分"
        width={500}
      >
        <div style={{ marginBottom: 12 }}>
          <span>拆分位置（字符偏移）：</span>
          <InputNumber min={1} value={splitPos} onChange={v => setSplitPos(v || 0)} style={{ width: 120 }} />
        </div>
        <Input placeholder="上半部分标题" value={splitTitle1} onChange={e => setSplitTitle1(e.target.value)} style={{ marginBottom: 8 }} />
        <Input placeholder="下半部分标题" value={splitTitle2} onChange={e => setSplitTitle2(e.target.value)} />
      </Modal>
    </div>
  )
}
