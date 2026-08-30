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
} from '@/types/experience'
import ExperienceEditForm from './ExperienceEditForm'
import ExperienceDetailModal from './ExperienceDetailModal'
import { rangeShowTotal } from '../common/TruncatedAlert'

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
 * Phase 19 REN-01（19-06）：翻页改真服务端分页（limit 20 / offset (page-1)*20，19-01 ORDER BY
 * created_at DESC, id DESC 双锚点保证行序稳定翻页无重复无丢行）；draft 排除由 service 层承担
 * （19-01：listExperiences opts.status 未传时默认排除 draft），前端 filter 移除。
 */

// D-04 契约：固定 20 条/页
const PAGE_SIZE = 20

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

// Phase 10 Plan 04 WR-05：兼容 'YYYY-MM-DD HH:mm:ss'（localtime）与 ISO 'T' 两种格式。
// 原实现 ts.slice(0,16) 假定空格分隔，遇 ISO 时间戳会保留字面 T（'2026-08-05T12:00'）。
// 改为 Date 解析 + pad 格式化，无字面 T；解析失败降级原值（不崩）。
function formatTs(ts?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isInvalid(exp: Experience): boolean {
  if (!exp.invalid_at) return false
  const t = new Date(exp.invalid_at.replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return false
  return t <= Date.now()
}

export default function ExperienceTab() {
  const [list, setList] = useState<Experience[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
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
  // WR-02：page ref 镜像——筛选 effect 需读最新 page 但不将其纳入依赖（否则 setPage 又触发本 effect 造成双加载）
  const pageRef = useRef(1)
  useEffect(() => {
    pageRef.current = page
  }, [page])

  // 拉设备候选（设备 Select 用）
  useEffect(() => {
    window.api.device
      .list()
      .then((all) => setDevices(all))
      .catch(() => setDevices([]))
  }, [])

  // 删除/恢复/标失效后 reload 的越界守卫：当前页 reload 后为空且 page > 1 时回退末有效页（防空页）
  const reloadWithFallback = async () => {
    const res = await loadExperiences()
    if (res !== null && res.rows.length === 0 && page > 1) {
      setPage(Math.max(1, Math.ceil(res.total / PAGE_SIZE)))
    }
  }

  const loadExperiences = async (): Promise<{ rows: Experience[]; total: number } | null> => {
    setLoading(true)
    try {
      // Phase 10 Plan 04 问题 2：status='invalid' 走 invalidOnly 路径（失效行 status 列仍 'published'，
      // 传 status='invalid' 查不到）；status='published' 强制 includeInvalid=false 显有效经验。
      const opts: ExperienceListInput = {
        search: search.trim() || undefined,
        category,
        severity,
        status: status === 'published' ? 'published' : undefined,
        invalidOnly: status === 'invalid' ? true : undefined,
        deviceId: deviceId.length > 0 ? deviceId : undefined,
        tags: tags.length > 0 ? tags : undefined,
        includeInvalid: status === 'published' ? false : status === 'invalid' ? true : includeInvalid,
        // Phase 19 REN-01：真服务端分页（D-04 固定 20/页）；draft 排除由 service 层承担（19-01：
        // opts.status 未传时默认排除 draft），前端 filter 已移除。
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }
      const res = await window.api.experience.list(opts)
      // 服务端分页 total 必传信封真总数（D-06，与三 tab cap 后 rows.length 相反——分页是完整数据通道）
      setList(res.rows)
      setTotal(res.total)
      return { rows: res.rows, total: res.total }
    } catch (err) {
      // 换页失败不清 setList：保留旧页数据不白屏
      message.error('加载经验列表失败: ' + (err as Error).message)
      return null
    } finally {
      setLoading(false)
    }
  }

  // 任一筛选变化触发；筛选变化重置第 1 页（D-05）。
  // WR-02：page > 1 时仅 setPage(1)，由 page effect 立即以新筛选加载一次（不防抖重复）；
  // page === 1 时走 300ms 防抖加载。
  useEffect(() => {
    if (pageRef.current !== 1) {
      setPage(1)
      return
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      loadExperiences()
    }, 300)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, category, severity, status, deviceId, tags, includeInvalid])

  // 换页触发（无防抖，翻页即取）
  useEffect(() => {
    loadExperiences()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

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

  // Phase 10 Plan 04 WR-02：关联设备 diff 同步改单 IPC（service 层 setExperienceDevices 单事务原子）。
  // 原 Promise.all N IPC 非原子，部分失败留半成品关联；改单 IPC 后 throw ROLLBACK 全成全败。
  const syncRelateDevices = async (expId: string, nextIds: string[]) => {
    await window.api.experience.setDevices(expId, nextIds)
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
        // WR-03 顺手清：原 relateDevices.length>=0 永真，改 if (relateDevices) 更清晰（undefined 不触发同步）
        if (relateDevices) {
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
      reloadWithFallback()
    } catch (err) {
      message.error('标失效失败: ' + (err as Error).message)
    }
  }

  const handleRestore = async (id: string) => {
    try {
      await window.api.experience.restore(id)
      message.success('已恢复为有效')
      reloadWithFallback()
    } catch (err) {
      message.error('恢复失败: ' + (err as Error).message)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await window.api.experience.delete(id)
      message.success('已删除')
      reloadWithFallback()
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
          return <span style={{ color: 'var(--nt-alias-label-tertiary)' }}>—</span>
        }
        const sev = record.severity ?? record.attrs?.severity ?? null
        const tag = sev ? SEVERITY_TAG[sev] : null
        return tag ? <Tag color={tag.color}>{tag.label}</Tag> : <span style={{ color: 'var(--nt-alias-label-tertiary)' }}>—</span>
      },
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      render: (tags: string[] | undefined) => {
        const arr = tags ?? []
        if (arr.length === 0) return <span style={{ color: 'var(--nt-alias-label-tertiary)' }}>—</span>
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
              {start} ~ <span style={{ color: 'var(--nt-alias-state-error-primary)' }}>{formatTs(record.invalid_at)}</span>
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
          <span style={{ color: 'var(--nt-alias-label-tertiary)' }}>未验证</span>
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
          // Phase 10 Plan 04 问题 2：状态 Select 与 includeInvalid 单向联动（UI-SPEC §3 + UAT 测试 6/8 修复）。
          // 选「已失效」→ status='invalid' + includeInvalid=true（走 invalidOnly 路径筛 invalid_at<=now）；
          // 选「有效」→ status='published' + includeInvalid=false（强制，覆盖 Switch 状态）；
          // 清空（undefined）→ 不改 includeInvalid（Switch 仍可独立 toggle）。
          // Switch 的 onChange 保持 setIncludeInvalid 不变（单向：Select 影响 Switch，反之不）。
          onChange={(v) => {
            setStatus(v)
            if (v === 'invalid') setIncludeInvalid(true)
            else if (v === 'published') setIncludeInvalid(false)
          }}
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
          // Phase 19 PATTERNS 裁决：标签候选只覆盖当前页（20 条），可接受——服务端分页下不额外全量拉标签
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
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showTotal: rangeShowTotal,
          onChange: (p) => setPage(p),
        }}
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
