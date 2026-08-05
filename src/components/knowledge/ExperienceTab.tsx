import { useEffect, useRef, useState } from 'react'
import {
  Table,
  Button,
  Input,
  Select,
  Switch,
  Space,
  Modal,
  Tag,
  Popconfirm,
  Empty,
  message,
} from 'antd'
import { EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { Device } from '@/types/device'
import type {
  Experience,
  ExperienceCategory,
  ExperienceInput,
  ExperienceUpdateInput,
  ExperienceListInput,
  ExperienceRelatedDevice,
} from '@/types/experience'
import ExperienceEditForm from './ExperienceEditForm'
import ExperienceDetailModal from './ExperienceDetailModal'

/**
 * ExperienceTab —— Phase 10 经验浏览 Tab（UI-SPEC §1-5 锁定契约 + BROWSE-01/02/03/04）。
 *
 * 消费 10-01 落地的 service/IPC（含 deviceId 多选 IN 占位 OR-join + device_count 子查询零 N+1 + restore 受控接口）
 * 与 10-02 落地的 ExperienceEditForm 公共组件（含 onSubmit 第二参 relateDevices，10-03 解决 10-02 遗留）。
 *
 * 筛选 bar 8 元素（UI-SPEC §3 锁定顺序）：新增经验 primary → 搜索 Input 240 → 分类 Select →
 * 严重度 Select → 状态 Select → 设备 Select（mode multiple）→ 标签 Select（mode multiple）→ 显示已失效 Switch。
 *
 * Table 9 列（UI-SPEC §2 锁定顺序）：标题<a>/分类 Tag blue/严重程度 Tag/标签 Tag/关联设备（device_count N 台 或 全局灰 Tag）/
 * 状态 Tag/有效期/最后验证/操作。
 *
 * 行操作三能力（D-10-3）：有效经验「编辑/标失效/删除」；失效经验「编辑/恢复有效/删除」。
 * draft 不进浏览页：前端 filter `record.status !== 'draft'`（Phase 9 待确认草稿专属）。
 */

const CATEGORY_OPTIONS: Array<{ value: ExperienceCategory; label: string }> = [
  { value: 'troubleshooting', label: '故障排查' },
  { value: 'best_practices', label: '最佳实践' },
  { value: 'product', label: '产品' },
  { value: 'env', label: '环境' },
]

const SEVERITY_OPTIONS = [
  { value: 'critical', label: '致命' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
  { value: 'info', label: '提示' },
]

const STATUS_OPTIONS = [
  { value: 'published', label: '有效' },
  { value: 'invalid', label: '已失效' },
]

const SEVERITY_TAG: Record<string, { color: string; label: string }> = {
  critical: { color: 'red', label: '致命' },
  high: { color: 'volcano', label: '高' },
  medium: { color: 'orange', label: '中' },
  low: { color: 'gold', label: '低' },
  info: { color: 'blue', label: '提示' },
}

const CATEGORY_LABEL: Record<ExperienceCategory, string> = {
  troubleshooting: '故障排查',
  best_practices: '最佳实践',
  product: '产品',
  env: '环境',
}

function formatTs(ts?: string | null): string {
  if (!ts) return ''
  return ts.length >= 16 ? ts.slice(0, 16) : ts
}

function isInvalid(exp: Experience): boolean {
  if (!exp.invalid_at) return false
  const t = new Date(exp.invalid_at.replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return false
  return t <= Date.now()
}

export default function ExperienceTab() {
  const [list, setList] = useState<Experience[]>([])
  const [loading, setLoading] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])

  // 筛选 state
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<ExperienceCategory | undefined>()
  const [severity, setSeverity] = useState<string | undefined>()
  const [status, setStatus] = useState<string | undefined>()
  const [deviceId, setDeviceId] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [includeInvalid, setIncludeInvalid] = useState(false)

  // Modal 编排
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingExp, setEditingExp] = useState<Experience | null>(null)
  const [detailExp, setDetailExp] = useState<Experience | null>(null)

  // 搜索防抖
  const debounceRef = useRef<number | null>(null)

  // 拉设备候选（设备 Select 用）
  useEffect(() => {
    window.api.device
      .list()
      .then((all) => setDevices(all))
      .catch(() => setDevices([]))
  }, [])

  const loadExperiences = async () => {
    setLoading(true)
    try {
      const opts: ExperienceListInput = {
        search: search.trim() || undefined,
        category,
        severity,
        status: status as ExperienceListInput['status'],
        deviceId: deviceId.length > 0 ? deviceId : undefined,
        tags: tags.length > 0 ? tags : undefined,
        includeInvalid,
        limit: 100,
        offset: 0,
      }
      const res = await window.api.experience.list(opts)
      // draft 不进浏览页（Phase 9 待确认草稿专属，前端 filter 兜底）
      setList(res.rows.filter((r) => r.status !== 'draft'))
    } catch (err) {
      message.error('加载经验列表失败: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 任一筛选变化触发（防抖）
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      loadExperiences()
    }, 300)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, category, severity, status, deviceId, tags, includeInvalid])

  const openCreate = () => {
    setEditingExp(null)
    setEditModalOpen(true)
  }

  const openEdit = (record: Experience) => {
    setEditingExp(record)
    setEditModalOpen(true)
  }

  const openDetail = (record: Experience) => {
    setDetailExp(record)
  }

  const closeEdit = () => {
    setEditModalOpen(false)
    setEditingExp(null)
  }

  // 关联设备 diff 同步（10-03 解决 10-02 relateDevices 遗留）
  const syncRelateDevices = async (expId: string, nextIds: string[]) => {
    let current: ExperienceRelatedDevice[] = []
    try {
      current = await window.api.experience.listDevices(expId)
    } catch {
      current = []
    }
    const currentIds = current.map((d) => d.id)
    const toAdd = nextIds.filter((id) => !currentIds.includes(id))
    const toRemove = currentIds.filter((id) => !nextIds.includes(id))
    await Promise.all([
      ...toAdd.map((id) => window.api.experience.relateDevice(expId, id)),
      ...toRemove.map((id) => window.api.experience.unrelateDevice(expId, id)),
    ])
  }

  // 新增/编辑提交（含 relateDevices 第二参）
  const handleSubmitEdit = async (
    fields: ExperienceInput | ExperienceUpdateInput,
    relateDevices?: string[]
  ) => {
    try {
      if (editingExp) {
        // 编辑态：update 白名单字段（CR-01 不收 status）+ 关联设备 diff 同步
        await window.api.experience.update(
          editingExp.id,
          fields as ExperienceUpdateInput
        )
        if (relateDevices && relateDevices.length >= 0) {
          await syncRelateDevices(editingExp.id, relateDevices)
        }
      } else {
        // 新增态：直 published（红线③ 例外：人工录入非 AI 产出）+ 关联设备新增
        const created = await window.api.experience.create(
          fields as ExperienceInput
        )
        if (relateDevices && relateDevices.length > 0) {
          await syncRelateDevices(created.id, relateDevices)
        }
      }
      message.success('保存成功')
      closeEdit()
      loadExperiences()
    } catch (err) {
      message.error('保存失败: ' + (err as Error).message)
    }
  }

  const handleInvalidate = async (id: string) => {
    try {
      await window.api.experience.invalidate(id)
      message.success('已标记为失效')
      loadExperiences()
    } catch (err) {
      message.error('标失效失败: ' + (err as Error).message)
    }
  }

  const handleRestore = async (id: string) => {
    try {
      await window.api.experience.restore(id)
      message.success('已恢复为有效')
      loadExperiences()
    } catch (err) {
      message.error('恢复失败: ' + (err as Error).message)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await window.api.experience.delete(id)
      message.success('已删除')
      loadExperiences()
    } catch (err) {
      message.error('删除失败: ' + (err as Error).message)
    }
  }

  // 表格列定义（UI-SPEC §2 锁定 9 列顺序）
  const columns = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      render: (_: unknown, record: Experience) => (
        <a onClick={() => openDetail(record)}>{record.title}</a>
      ),
    },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 100,
      render: (cat: ExperienceCategory) => (
        <Tag color="blue">{CATEGORY_LABEL[cat] || cat}</Tag>
      ),
    },
    {
      title: '严重程度',
      dataIndex: 'severity',
      key: 'severity',
      width: 90,
      render: (_: unknown, record: Experience) => {
        if (record.category !== 'troubleshooting') {
          return <span style={{ color: '#999' }}>—</span>
        }
        const sev = record.severity ?? record.attrs?.severity ?? null
        const tag = sev ? SEVERITY_TAG[sev] : null
        return tag ? <Tag color={tag.color}>{tag.label}</Tag> : <span style={{ color: '#999' }}>—</span>
      },
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      render: (tags: string[] | undefined) => {
        const arr = tags ?? []
        if (arr.length === 0) return <span style={{ color: '#999' }}>—</span>
        const shown = arr.slice(0, 3)
        const rest = arr.length - shown.length
        return (
          <Space size={4} wrap>
            {shown.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
            {rest > 0 && <Tag>+{rest}</Tag>}
          </Space>
        )
      },
    },
    {
      title: '关联设备',
      key: 'device_count',
      width: 120,
      render: (_: unknown, record: Experience) =>
        record.device_count && record.device_count > 0 ? (
          <span>{record.device_count} 台</span>
        ) : (
          <Tag>全局</Tag>
        ),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_: unknown, record: Experience) => {
        const invalid = isInvalid(record)
        return invalid ? (
          <Tag color="default">已失效</Tag>
        ) : (
          <Tag color="success">有效</Tag>
        )
      },
    },
    {
      title: '有效期',
      key: 'valid_range',
      width: 180,
      render: (_: unknown, record: Experience) => {
        const start = formatTs(record.valid_at) || '—'
        const invalid = isInvalid(record)
        if (record.invalid_at && invalid) {
          return (
            <span>
              {start} ~ <span style={{ color: '#ff4d4f' }}>{formatTs(record.invalid_at)}</span>
            </span>
          )
        }
        return <span>{start} ~ 至今</span>
      },
    },
    {
      title: '最后验证',
      dataIndex: 'last_verified_at',
      key: 'last_verified_at',
      width: 150,
      render: (ts: string | null | undefined) =>
        ts ? (
          formatTs(ts)
        ) : (
          <span style={{ color: '#999' }}>未验证</span>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_: unknown, record: Experience) => {
        const invalid = isInvalid(record)
        return (
          <Space size={4} wrap>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(record)}
            >
              编辑
            </Button>
            {invalid ? (
              <Button size="small" onClick={() => handleRestore(record.id)}>
                恢复有效
              </Button>
            ) : (
              <Popconfirm
                title="标记为失效？"
                description="失效后将从默认视图剔除，但仍可查/可恢复，不会物理删除。"
                onConfirm={() => handleInvalidate(record.id)}
                okText="标失效"
                cancelText="取消"
              >
                <Button size="small">标失效</Button>
              </Popconfirm>
            )}
            <Popconfirm
              title="确认删除"
              description={`将彻底删除经验『${record.title}』，操作不可恢复。`}
              onConfirm={() => handleDelete(record.id)}
              okText="删除"
              cancelText="取消"
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增经验
        </Button>
        <Input
          placeholder="搜索经验标题或正文"
          allowClear
          style={{ width: 240 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onPressEnter={() => loadExperiences()}
        />
        <Select
          placeholder="全部分类"
          allowClear
          style={{ width: 120 }}
          value={category}
          onChange={(v) => setCategory(v)}
          options={CATEGORY_OPTIONS}
        />
        <Select
          placeholder="全部严重度"
          allowClear
          style={{ width: 120 }}
          value={severity}
          onChange={(v) => setSeverity(v)}
          options={SEVERITY_OPTIONS}
        />
        <Select
          placeholder="全部状态"
          allowClear
          style={{ width: 120 }}
          value={status}
          onChange={(v) => setStatus(v)}
          options={STATUS_OPTIONS}
        />
        <Select
          mode="multiple"
          placeholder="筛选设备"
          allowClear
          style={{ width: 160 }}
          value={deviceId}
          onChange={(v: string[]) => setDeviceId(v)}
          options={devices.map((d) => ({ value: d.id, label: d.name }))}
        />
        <Select
          mode="multiple"
          placeholder="筛选标签"
          allowClear
          style={{ width: 160 }}
          value={tags}
          onChange={(v: string[]) => setTags(v)}
          options={Array.from(new Set(list.flatMap((r) => r.tags ?? []))).map(
            (t) => ({ value: t, label: t })
          )}
        />
        <Space>
          <span>显示已失效</span>
          <Switch checked={includeInvalid} onChange={setIncludeInvalid} />
        </Space>
      </Space>

      <Table
        columns={columns}
        dataSource={list}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 20 }}
        locale={{
          emptyText: (
            <Empty description="暂无经验。AI 对话后点『经验总结』自动沉淀，或点击右上角『新增经验』手动录入。" />
          ),
        }}
      />

      <Modal
        title={editingExp ? '编辑经验' : '新增经验'}
        open={editModalOpen}
        footer={null}
        width={640}
        onCancel={closeEdit}
        destroyOnClose
      >
        <ExperienceEditForm
          initialValue={editingExp ?? undefined}
          onSubmit={handleSubmitEdit}
          onCancel={closeEdit}
        />
      </Modal>

      <ExperienceDetailModal
        open={!!detailExp}
        experience={detailExp}
        onClose={() => setDetailExp(null)}
        onEdit={() => {
          if (detailExp) {
            const rec = detailExp
            setDetailExp(null)
            openEdit(rec)
          }
        }}
        onInvalidate={
          detailExp && !isInvalid(detailExp)
            ? () => {
                if (detailExp) {
                  handleInvalidate(detailExp.id)
                  setDetailExp(null)
                }
              }
            : undefined
        }
        onRestore={
          detailExp && isInvalid(detailExp)
            ? () => {
                if (detailExp) {
                  handleRestore(detailExp.id)
                  setDetailExp(null)
                }
              }
            : undefined
        }
        onDelete={
          detailExp
            ? () => {
                if (detailExp) {
                  const id = detailExp.id
                  const title = detailExp.title
                  Modal.confirm({
                    title: '确认删除',
                    content: `将彻底删除经验『${title}』，操作不可恢复。`,
                    okText: '删除',
                    cancelText: '取消',
                    okButtonProps: { danger: true },
                    onOk: () => {
                      handleDelete(id)
                      setDetailExp(null)
                    },
                  })
                }
              }
            : undefined
        }
      />
    </div>
  )
}
