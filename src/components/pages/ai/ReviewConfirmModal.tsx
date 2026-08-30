import { useState, useEffect } from 'react'
import { Modal, Button, Tag, Checkbox, Spin, Empty, message } from 'antd'
import type {
  Experience,
  ExperienceUpdateInput,
  ConfirmDraftsInput,
  ConfirmDraftsResult,
} from '@/types/experience'
import SessionMessagesModal from './SessionMessagesModal'
import ReviewConfirmEditForm from './ReviewConfirmEditForm'
// D-10-1：validateDraft 质量门单一来源已迁至 ExperienceEditForm（Phase 10 公共组件），
// 本文件 re-export 供 ReviewConfirmEditForm 复用（保守方案：仅切单一源，表单字段结构不动，保 Phase 9 零回归）。
import { validateDraft } from '../../knowledge/ExperienceEditForm'
export { validateDraft }

/**
 * ReviewConfirmModal —— Phase 9 人工确认主壳（红线③ session→permanent 唯一人工闸口的 renderer 执行点）。
 *
 * 宽 Modal（80vw）+ master-detail 左右分栏（D-9-3）：
 * - 左：草稿列表（Checkbox 采纳/丢弃 + Tag 标注 category/UPDATE + 质量门未过标红 + UPDATE 草稿显 supersedeOld Checkbox）
 * - 右：选中条目编辑表单（ReviewConfirmEditForm 子组件）
 *
 * 底部批量提交「确认采纳 N 条 + 删除 M 条」一次性调 confirmDrafts IPC（D-9-4 单事务原子）。
 * 质量门三层纵深第一层（renderer 实时校验标红 + 确认按钮禁用，D-9-4 质量门三层纵深）。
 *
 * D-9-2：UPDATE 草稿（duplicate_of_exp_id 非空）supersedeOld 默认 false（防 Phase 8 AI 误判 UPDATE 实为 ADD 误删旧条目）。
 * D-9-7：relateDevices 初始化 undefined（仅 length>0 数组触发 service 层 diff，不动现有关联）。
 */

/** 决策类型：每条草稿的采纳/丢弃 + 字段编辑 + 关联设备变更 + UPDATE supersede */
export interface DraftDecision {
  action: 'adopt' | 'discard'
  supersedeOld: boolean
  fields: ExperienceUpdateInput
  relateDevices: string[] | undefined
}

interface ReviewConfirmModalProps {
  open: boolean
  onClose: () => void
  /** Phase 8 summarizeSession 完成后传入 created/updated exp_id 列表；空则走 listDrafts 全量暂存 draft（D-9-7） */
  initialDraftIds?: string[]
  /** 提交后回调（刷新角标计数） */
  onSubmitted?: (result: ConfirmDraftsResult) => void
}

/** onChange patch 局部形态（DraftDecision 子集） */
type DecisionPatch = Partial<DraftDecision>

export default function ReviewConfirmModal({
  open,
  onClose,
  initialDraftIds,
  onSubmitted,
}: ReviewConfirmModalProps) {
  const [drafts, setDrafts] = useState<Experience[]>([])
  const [decisions, setDecisions] = useState<Record<string, DraftDecision>>({})
  const [selectedExpId, setSelectedExpId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [sessionModalSessionId, setSessionModalSessionId] = useState<string | null>(null)

  // WR-08：用 draftIdsKey（join 的字符串）作 effect 依赖而非 initialDraftIds 引用。
  // initialDraftIds 每次由 useAIChat handleSummarize/openReviewFromBadge 新建数组引用，
  // 即使内容相同也会触发 effect → setDecisions 重置用户已编辑决策。join 成字符串稳定比较，
  // 同一批 draft id（顺序由 summarizeSession 返回决定，稳定）不重置。
  const draftIdsKey = (initialDraftIds ?? []).slice().sort().join(',')
  useEffect(() => {
    if (!open) return
    setLoading(true)
    const fetcher =
      initialDraftIds && initialDraftIds.length > 0
        ? Promise.all(initialDraftIds.map((id) => window.api.experience.get(id))).then((rs) =>
            rs.filter((x): x is Experience => !!x)
          )
        : window.api.experience.listDrafts()
    fetcher
      .then((list) => {
        setDrafts(list)
        // 初始化 decisions：默认全部 adopt（用户纵览后可改 discard），supersedeOld 默认 false（D-9-2）
        const init: Record<string, DraftDecision> = {}
        for (const d of list) {
          init[d.id] = {
            action: 'adopt',
            supersedeOld: false,
            fields: {
              title: d.title,
              category: d.category,
              content: d.content,
              tags: d.tags,
              attrs: d.attrs ?? undefined,
            },
            relateDevices: undefined, // undefined = 不改现有关联（与 service 层 length>0 守卫语义一致）
          }
        }
        setDecisions(init)
        setSelectedExpId(list.length > 0 ? list[0].id : null)
      })
      .finally(() => setLoading(false))
    // initialDraftIds 经 hook 父层每次新建数组引用触发刷新（开弹窗时），闭包内消费最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftIdsKey])

  const selectedDraft = drafts.find((d) => d.id === selectedExpId) ?? null

  function updateDecision(id: string, patch: DecisionPatch) {
    setDecisions((prev) => {
      const cur = prev[id]
      if (!cur) return prev
      const nextFields = patch.fields ? { ...cur.fields, ...patch.fields } : cur.fields
      return { ...prev, [id]: { ...cur, ...patch, fields: nextFields } }
    })
  }

  function setAll(action: 'adopt' | 'discard') {
    setDecisions((prev) => {
      const next: Record<string, DraftDecision> = {}
      for (const id of Object.keys(prev)) next[id] = { ...prev[id], action }
      return next
    })
  }

  // 质量门：任一 adopt 草稿缺必填项则禁用提交（D-9-4 renderer 第一层）
  const hasBlockingErrors = drafts.some((d) => {
    const dec = decisions[d.id]
    return dec && dec.action === 'adopt' && validateDraft(d, dec.fields).length > 0
  })

  const adoptCount = drafts.filter((d) => decisions[d.id]?.action === 'adopt').length
  const discardCount = drafts.filter((d) => decisions[d.id]?.action === 'discard').length

  async function handleSubmit() {
    if (hasBlockingErrors) return
    setSubmitting(true)
    try {
      const input: ConfirmDraftsInput = {
        drafts: drafts.map((d) => {
          const dec = decisions[d.id]
          return {
            expId: d.id,
            action: dec.action,
            fields: dec.fields,
            relateDevices: dec.relateDevices, // undefined 或 length>0 数组；service 层 length>0 才 diff
            supersedeOld: dec.supersedeOld,
          }
        }),
      }
      const result = await window.api.experience.confirmDrafts(input)
      message.success(
        `已采纳 ${result.adopted} 条，删除 ${result.discarded} 条` +
          (result.superseded > 0 ? `，标失效旧条目 ${result.superseded} 条` : '')
      )
      onSubmitted?.(result)
      onClose()
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Modal
        open={open}
        title={`经验草稿确认（${drafts.length} 条）`}
        onCancel={onClose}
        width="80vw"
        footer={[
          <Button key="cancel" onClick={onClose}>
            取消（暂存，稍后从角标重开）
          </Button>,
          <Button key="allAdopt" onClick={() => setAll('adopt')}>
            全选采纳
          </Button>,
          <Button key="allDiscard" danger onClick={() => setAll('discard')}>
            全选删除
          </Button>,
          <Button
            key="submit"
            type="primary"
            loading={submitting}
            disabled={hasBlockingErrors || drafts.length === 0}
            onClick={handleSubmit}
          >
            确认采纳 {adoptCount} 条 + 删除 {discardCount} 条
          </Button>,
        ]}
      >
        {loading ? (
          <Spin />
        ) : drafts.length === 0 ? (
          <Empty description="暂无待确认草稿" />
        ) : (
          <div style={{ display: 'flex', gap: 16, minHeight: 400 }}>
            {/* 左：草稿列表 */}
            <div
              style={{
                width: 360,
                borderRight: '1px solid var(--nt-alias-border-l2)',
                paddingRight: 16,
                overflowY: 'auto',
                maxHeight: 480,
              }}
            >
              {drafts.map((d) => {
                const dec = decisions[d.id]
                const errs = dec ? validateDraft(d, dec.fields) : []
                const blocking = errs.length > 0 && dec?.action === 'adopt'
                return (
                  <div
                    key={d.id}
                    onClick={() => setSelectedExpId(d.id)}
                    style={{
                      padding: 8,
                      marginBottom: 4,
                      cursor: 'pointer',
                      background: selectedExpId === d.id ? 'var(--nt-alias-state-business-tertiary)' : 'var(--nt-alias-bg-base)',
                      border: blocking ? '1px solid var(--nt-alias-state-error-primary)' : '1px solid var(--nt-alias-border-l4)',
                      borderRadius: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Checkbox
                        checked={dec?.action === 'adopt'}
                        onChange={(e) =>
                          updateDecision(d.id, { action: e.target.checked ? 'adopt' : 'discard' })
                        }
                      />
                      <span
                        style={{
                          flex: 1,
                          textDecoration: dec?.action === 'discard' ? 'line-through' : 'none',
                        }}
                      >
                        {dec?.fields.title || d.title}
                      </span>
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <Tag color="blue">{d.category}</Tag>
                      {d.duplicate_of_exp_id && <Tag color="orange">UPDATE</Tag>}
                      {blocking && <Tag color="red">{errs.join(' / ')}</Tag>}
                    </div>
                    {d.duplicate_of_exp_id && dec?.action === 'adopt' && (
                      <Checkbox
                        style={{ marginTop: 4, fontSize: 'var(--nt-font-xxs-12-font-size)' }}
                        checked={dec.supersedeOld}
                        onChange={(e) => updateDecision(d.id, { supersedeOld: e.target.checked })}
                      >
                        标失效旧条目（默认不勾，主动勾才 supersede）
                      </Checkbox>
                    )}
                  </div>
                )
              })}
            </div>
            {/* 右：编辑表单（选中条目）—— Task 2a 内联最简占位，Task 2b 替换为 ReviewConfirmEditForm */}
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 480 }}>
              {selectedDraft ? (
                <ReviewConfirmEditForm
                  draft={selectedDraft}
                  decision={decisions[selectedDraft.id]}
                  onChange={(patch) => updateDecision(selectedDraft.id, patch)}
                  onViewSession={() =>
                    setSessionModalSessionId(selectedDraft.source_session_id ?? null)
                  }
                />
              ) : (
                <Empty description="选择左侧草稿编辑" />
              )}
            </div>
          </div>
        )}
      </Modal>
      {/* 子 Modal 叠层（D-9-5 溯源回链） */}
      <SessionMessagesModal
        open={!!sessionModalSessionId}
        sessionId={sessionModalSessionId}
        onClose={() => setSessionModalSessionId(null)}
      />
    </>
  )
}
