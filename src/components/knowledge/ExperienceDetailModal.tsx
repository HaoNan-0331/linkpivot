import { useEffect, useState } from 'react'
import { Modal, Tag, Space, Button, Empty, Spin } from 'antd'
import { EditOutlined, DeleteOutlined } from '@ant-design/icons'
import SessionMessagesModal from '../pages/ai/SessionMessagesModal'
import type {
  Experience,
  ExperienceCategory,
  ExperienceRelatedDevice,
} from '@/types/experience'

/**
 * ExperienceDetailModal —— Phase 10 经验只读详情 Modal（UI-SPEC §6 + SC5）。
 *
 * width 900 / footer=null（详情只读，不嵌编辑表单，UI-SPEC §4 caveat）。
 * 顶部 Space：标题 strong + 状态 Tag + 分类 Tag + severity Tag（troubleshooting 类显语义色）。
 * 元数据行（strong label + 值）：来源会话（截短 + 「查看原始会话」叠层 SessionMessagesModal）
 * / 关联设备（listDevices 取设备名列表）/ 复用次数 / 最后验证 / 有效期 / 创建/更新时间。
 * 正文 content pre-wrap maxHeight 400 overflow auto（KB ChunkContent 范式）。
 * troubleshooting 类显 attrs 模板字段块（故障现象/根本原因/解决办法/预防措施）。
 * 底部 Space：编辑/标失效或恢复/删除 回调按钮（文案与行操作一致）。
 *
 * severity Tag 语义色（UI-SPEC Color 锁定，禁止新色）：
 * critical=red / high=volcano / medium=orange / low=gold / info=blue。
 * 状态：有效=success 绿「有效」/ 失效=default 灰「已失效」（不染红，红只给删除）。
 */

const CATEGORY_LABEL: Record<ExperienceCategory, string> = {
  troubleshooting: '故障排查',
  best_practices: '最佳实践',
  product: '产品',
  env: '环境',
}

const SEVERITY_TAG: Record<string, { color: string; label: string }> = {
  critical: { color: 'red', label: '致命' },
  high: { color: 'volcano', label: '高' },
  medium: { color: 'orange', label: '中' },
  low: { color: 'gold', label: '低' },
  info: { color: 'blue', label: '提示' },
}

// Phase 10 Plan 04 WR-05：兼容 'YYYY-MM-DD HH:mm:ss'（localtime）与 ISO 'T' 两种格式（无字面 T）。
function formatTs(ts?: string | null): string {
  if (!ts) return ''
  const d = new Date(ts.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isValid(exp: Experience): boolean {
  if (!exp.invalid_at) return true
  const t = new Date(exp.invalid_at.replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return true
  return t > Date.now()
}

interface ExperienceDetailModalProps {
  open: boolean
  experience: Experience | null
  onClose: () => void
  onEdit?: () => void
  onInvalidate?: () => void
  onRestore?: () => void
  onDelete?: () => void
}

export default function ExperienceDetailModal({
  open,
  experience,
  onClose,
  onEdit,
  onInvalidate,
  onRestore,
  onDelete,
}: ExperienceDetailModalProps) {
  const [devices, setDevices] = useState<ExperienceRelatedDevice[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [sessionModalSessionId, setSessionModalSessionId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !experience) {
      setDevices([])
      return
    }
    setLoadingDevices(true)
    window.api.experience
      .listDevices(experience.id)
      .then((rs) => setDevices(rs))
      .catch(() => setDevices([]))
      .finally(() => setLoadingDevices(false))
  }, [open, experience])

  if (!experience) {
    return (
      <Modal
        title="经验详情"
        open={open}
        onCancel={onClose}
        footer={null}
        width={900}
      >
        <Empty />
      </Modal>
    )
  }

  const exp = experience
  const valid = isValid(exp)
  const cat = exp.category
  const attrs = exp.attrs ?? null
  const sev = exp.severity ?? attrs?.severity ?? null
  const sevTag = sev ? SEVERITY_TAG[sev] : null

  return (
    <Modal
      title={`经验详情 - ${exp.title}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{exp.title}</span>
        <Tag color={valid ? 'success' : 'default'}>{valid ? '有效' : '已失效'}</Tag>
        <Tag color="blue">{CATEGORY_LABEL[cat]}</Tag>
        {cat === 'troubleshooting' && sevTag && (
          <Tag color={sevTag.color}>{sevTag.label}</Tag>
        )}
      </Space>

      <div style={{ marginBottom: 12 }}>
        <Space wrap>
          {exp.source_session_id ? (
            <span>
              <strong>来源会话：</strong>
              {exp.source_session_id.slice(0, 8)}
              <Button
                size="small"
                type="link"
                onClick={() => setSessionModalSessionId(exp.source_session_id!)}
              >
                查看原始会话
              </Button>
            </span>
          ) : (
            <span><strong>来源会话：</strong>手动录入</span>
          )}
          <span>
            <strong>关联设备：</strong>
            {loadingDevices ? (
              <Spin size="small" />
            ) : devices.length > 0 ? (
              devices.map((d) => d.name).join('、')
            ) : (
              <Tag>全局</Tag>
            )}
          </span>
          <span><strong>复用次数：</strong>{exp.reuse_count}</span>
          <span>
            <strong>最后验证：</strong>
            {exp.last_verified_at ? formatTs(exp.last_verified_at) : <span style={{ color: '#999' }}>未验证</span>}
          </span>
          <span>
            <strong>有效期：</strong>
            {formatTs(exp.valid_at) || '—'} ~{' '}
            {exp.invalid_at ? (
              <span style={{ color: '#ff4d4f' }}>{formatTs(exp.invalid_at)}</span>
            ) : (
              '至今'
            )}
          </span>
          <span><strong>创建时间：</strong>{formatTs(exp.created_at) || '—'}</span>
          <span><strong>更新时间：</strong>{formatTs(exp.updated_at) || '—'}</span>
        </Space>
      </div>

      <div
        style={{
          whiteSpace: 'pre-wrap',
          maxHeight: 400,
          overflow: 'auto',
          background: '#fafafa',
          padding: 12,
          borderRadius: 4,
          marginBottom: 12,
        }}
      >
        {exp.content}
      </div>

      {cat === 'troubleshooting' && attrs && (
        <div style={{ marginBottom: 12 }}>
          {attrs.symptoms ? (
            <div style={{ marginBottom: 8 }}>
              <strong>故障现象：</strong>
              <div style={{ whiteSpace: 'pre-wrap' }}>{attrs.symptoms}</div>
            </div>
          ) : null}
          {attrs.root_cause ? (
            <div style={{ marginBottom: 8 }}>
              <strong>根本原因：</strong>
              <div style={{ whiteSpace: 'pre-wrap' }}>{attrs.root_cause}</div>
            </div>
          ) : null}
          {attrs.resolution ? (
            <div style={{ marginBottom: 8 }}>
              <strong>解决办法：</strong>
              <div style={{ whiteSpace: 'pre-wrap' }}>{attrs.resolution}</div>
            </div>
          ) : null}
          {attrs.prevention ? (
            <div style={{ marginBottom: 8 }}>
              <strong>预防措施：</strong>
              <div style={{ whiteSpace: 'pre-wrap' }}>{attrs.prevention}</div>
            </div>
          ) : null}
        </div>
      )}

      <Space>
        <Button icon={<EditOutlined />} onClick={onEdit}>编辑</Button>
        {valid
          ? (onInvalidate && <Button onClick={onInvalidate}>标失效</Button>)
          : (onRestore && <Button onClick={onRestore}>恢复有效</Button>)}
        {onDelete && (
          <Button danger icon={<DeleteOutlined />} onClick={onDelete}>删除</Button>
        )}
      </Space>

      <SessionMessagesModal
        open={!!sessionModalSessionId}
        sessionId={sessionModalSessionId}
        onClose={() => setSessionModalSessionId(null)}
      />
    </Modal>
  )
}
