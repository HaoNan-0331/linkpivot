import { useEffect, useState } from 'react'
import { Form, Input, Select, Button, Space } from 'antd'
import type { Device } from '@/types/device'
import type {
  Experience,
  ExperienceInput,
  ExperienceUpdateInput,
  ExperienceCategory,
  ExperienceAttrs,
} from '@/types/experience'

/**
 * ExperienceEditForm —— Phase 10 经验手动新增/编辑公共表单组件（D-10-1 抽取自 Phase 9 ReviewConfirmEditForm + ReviewConfirmModal.validateDraft）。
 *
 * 与 Phase 9 表单差异（UI-SPEC §5 锁定）：
 * - 去除「查看原始会话」按钮（详情 Modal 侧独立入口）
 * - 去除 UPDATE supersedeOld Checkbox（手动 CRUD 无 UPDATE 语义，无 duplicate_of_exp_id 触发条件）
 * - 状态由 form 内部 useState 持（uncontrolled，单条编辑，无 Phase 9 批量决策列表/decision patch 形态）
 * - 新增态提交直 createExperience({...fields, status: 'published'})（红线③ 例外：人工录入非 AI 产出）
 *
 * 质量门 validateDraft 单一来源（D-10-1 核心）：本文件导出 validateDraft，Phase 9 ReviewConfirmModal 改 import 此处，
 * 消除双份校验漂移。错误串中文与 UI-SPEC copy contract 逐字一致。
 *
 * 外层 Modal 由调用方（ExperienceTab）包裹（width 640，UI-SPEC §4）；本组件只渲染 Form + footer Button。
 */

const CATEGORY_OPTIONS: Array<{ value: ExperienceCategory; label: string }> = [
  { value: 'troubleshooting', label: '故障排查' },
  { value: 'best_practices', label: '最佳实践' },
  { value: 'product', label: '产品' },
  { value: 'env', label: '环境' },
]

const SEVERITY_OPTIONS: Array<{ value: NonNullable<ExperienceAttrs['severity']>; label: string }> = [
  { value: 'critical', label: '致命' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
  { value: 'info', label: '提示' },
]

/** 空表单基线（新增态用，title/content/category 占位，无 attrs / tags）。 */
const EMPTY_FIELDS: ExperienceUpdateInput = {
  title: '',
  category: 'troubleshooting',
  content: '',
  tags: [],
  attrs: {},
}

/**
 * 质量门 renderer 实时校验（单一来源，D-10-1）。
 * - troubleshooting 类：attrs.severity/symptoms/resolution 必填（与 service 层 assertTroubleshootingAttrs 兜底校验对齐）
 * - 轻结构类（best_practices/product/env）：title/content 必填
 * 返回 errors 字符串数组（空数组=通过）。
 *
 * Phase 9 ReviewConfirmModal 改 import 此处复用，消除双份漂移。
 */
export function validateDraft(d: Experience, fields: ExperienceUpdateInput): string[] {
  const errs: string[] = []
  const cat = fields.category ?? d.category
  const attrs = fields.attrs ?? d.attrs
  if (cat === 'troubleshooting') {
    if (!attrs || !attrs.severity) errs.push('缺 严重程度')
    if (!attrs || !attrs.symptoms || !String(attrs.symptoms).trim()) errs.push('缺 故障现象')
    if (!attrs || !attrs.resolution || !String(attrs.resolution).trim()) errs.push('缺 解决办法')
  } else {
    if (!fields.title || !String(fields.title).trim()) errs.push('缺 标题')
    if (!fields.content || !String(fields.content).trim()) errs.push('缺 内容')
  }
  return errs
}

interface ExperienceEditFormProps {
  /** 编辑态预填；新增态 undefined（新增态提交直 published）。 */
  initialValue?: Experience
  /** 提交回调。新增态传入参带 status:'published'（红线③ 例外）；编辑态传 update 白名单字段（CR-01 不收 status）。
   * relateDevices（第二参）：关联设备 ids 数组，由调用方在 onSubmit 后调 experience:relateDevice/unrelateDevice
   * 同步关联设备（10-03 解决 10-02 relateDevices 遗留：手动新增/编辑的关联设备需可保存）。 */
  onSubmit: (fields: ExperienceInput | ExperienceUpdateInput, relateDevices?: string[]) => void
  onCancel: () => void
}

export default function ExperienceEditForm({
  initialValue,
  onSubmit,
  onCancel,
}: ExperienceEditFormProps) {
  const [fields, setFields] = useState<ExperienceUpdateInput>(() => {
    if (!initialValue) return { ...EMPTY_FIELDS }
    return {
      title: initialValue.title,
      category: initialValue.category,
      content: initialValue.content,
      tags: initialValue.tags,
      attrs: initialValue.attrs ?? {},
    }
  })
  const [devices, setDevices] = useState<Array<{ id: string; name: string }>>([])
  const [relateDevices, setRelateDevices] = useState<string[]>([])

  // Phase 10 Plan 04 问题 1a：放开设备类型 filter，候选含全类型（SSH/Telnet/Web/RDP）。
  // 原 T-10-08 mitigation（filter ssh/telnet）仅适用 AI 起草模块（Phase 8/9，AI 助手仅连 ssh/telnet）；
  // 手动 CRUD 关联设备应支持全类型（CONTEXT Constraints 产品功能约束四类远程通道设计意图）。
  // 关联≠连接（仅元数据引用，设备 DTO 已走 rowToDevice 白名单投影无 `_enc` 密文泄露，T-10-04-05 accept）。
  useEffect(() => {
    window.api.device.list().then((all: Device[]) =>
      setDevices(all.map((d) => ({ id: d.id, name: d.name })))
    ).catch(() => setDevices([]))
  }, [])

  // 编辑态预填已关联设备（内部 useEffect 调 listDevices，避免调用方负担；relateDevices undefined = 不改关联）。
  useEffect(() => {
    if (!initialValue) return
    let cancelled = false
    window.api.experience.listDevices(initialValue.id).then((rs) => {
      if (cancelled) return
      setRelateDevices(rs.map((d) => d.id))
    }).catch(() => {
      if (!cancelled) setRelateDevices([])
    })
    return () => {
      cancelled = true
    }
  }, [initialValue])

  const cat = fields.category ?? 'troubleshooting'
  const attrs = fields.attrs ?? {}
  // 质量门基线对象：新增态传空 Experience 占位（无 id/title，仅 category 由 fields 决定）；
  // validateDraft 内部仅读 d.category / d.attrs 作 fallback，fields 已覆盖时 d 值不影响判定。
  const baseline: Experience = initialValue ?? {
    id: '',
    title: '',
    category: cat,
    content: '',
    tags: [],
    status: 'published',
    valid_at: '',
    reuse_count: 0,
    created_at: '',
    updated_at: '',
  }
  const errs = validateDraft(baseline, fields)

  function patchField<K extends keyof ExperienceUpdateInput>(key: K, value: ExperienceUpdateInput[K]) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  function patchAttr<K extends keyof ExperienceAttrs>(key: K, value: ExperienceAttrs[K]) {
    setFields((prev) => ({ ...prev, attrs: { ...attrs, [key]: value } }))
  }

  function handleSubmit() {
    if (errs.length > 0) return
    // 关联设备 ids 拼回 attrs 不参与——关联设备走单独 relateDevices 通道（由调用方在 onSubmit 后调 relateDevice IPC）。
    // 本组件仅负责表单字段提交；relateDevices 经 onSubmit 第二参回传调用方（见下 handleSubmit 扩展）。
    if (initialValue) {
      // 编辑态：传 update 白名单字段（CR-01 不收 status），relateDevices 回传调用方做 diff 同步
      onSubmit({ ...fields }, relateDevices)
    } else {
      // 新增态：直 published（红线③ 例外，D-10-1/CONTEXT specifics/UI-SPEC copy 红线③）
      const input: ExperienceInput = {
        title: fields.title ?? '',
        category: fields.category ?? 'troubleshooting',
        content: fields.content ?? '',
        tags: fields.tags,
        attrs: fields.attrs,
        status: 'published',
      }
      onSubmit(input, relateDevices)
    }
  }

  return (
    <Form layout="vertical">
      <Form.Item
        label="标题"
        validateStatus={errs.includes('缺 标题') ? 'error' : ''}
        help={errs.includes('缺 标题') ? '缺 标题' : ''}
      >
        <Input value={fields.title ?? ''} onChange={(e) => patchField('title', e.target.value)} />
      </Form.Item>
      <Form.Item label="分类">
        <Select
          value={cat}
          onChange={(v: ExperienceCategory) => patchField('category', v)}
          options={CATEGORY_OPTIONS}
        />
      </Form.Item>
      <Form.Item
        label="内容"
        validateStatus={errs.includes('缺 内容') ? 'error' : ''}
        help={errs.includes('缺 内容') ? '缺 内容' : ''}
      >
        <Input.TextArea
          value={fields.content ?? ''}
          rows={6}
          onChange={(e) => patchField('content', e.target.value)}
        />
      </Form.Item>
      <Form.Item label="标签">
        <Select
          mode="tags"
          value={fields.tags ?? []}
          onChange={(v: string[]) => patchField('tags', v)}
        />
      </Form.Item>
      {cat === 'troubleshooting' && (
        <>
          <Form.Item
            label="严重程度"
            validateStatus={errs.includes('缺 严重程度') ? 'error' : ''}
            help={errs.includes('缺 严重程度') ? '缺 严重程度' : ''}
          >
            <Select
              value={attrs.severity}
              onChange={(v: NonNullable<ExperienceAttrs['severity']>) => patchAttr('severity', v)}
              options={SEVERITY_OPTIONS}
              allowClear
            />
          </Form.Item>
          <Form.Item
            label="故障现象"
            validateStatus={errs.includes('缺 故障现象') ? 'error' : ''}
            help={errs.includes('缺 故障现象') ? '缺 故障现象' : ''}
          >
            <Input.TextArea
              value={attrs.symptoms ?? ''}
              rows={3}
              onChange={(e) => patchAttr('symptoms', e.target.value)}
            />
          </Form.Item>
          <Form.Item label="根本原因">
            <Input.TextArea
              value={attrs.root_cause ?? ''}
              rows={2}
              onChange={(e) => patchAttr('root_cause', e.target.value)}
            />
          </Form.Item>
          <Form.Item
            label="解决办法"
            validateStatus={errs.includes('缺 解决办法') ? 'error' : ''}
            help={errs.includes('缺 解决办法') ? '缺 解决办法' : ''}
          >
            <Input.TextArea
              value={attrs.resolution ?? ''}
              rows={3}
              onChange={(e) => patchAttr('resolution', e.target.value)}
            />
          </Form.Item>
          <Form.Item label="预防措施">
            <Input.TextArea
              value={attrs.prevention ?? ''}
              rows={2}
              onChange={(e) => patchAttr('prevention', e.target.value)}
            />
          </Form.Item>
        </>
      )}
      <Form.Item label="关联设备">
        <Select
          mode="multiple"
          value={relateDevices}
          onChange={(v: string[]) => setRelateDevices(v)}
          options={devices.map((d) => ({ value: d.id, label: d.name }))}
          placeholder="不改关联则留空"
          allowClear
        />
      </Form.Item>
      <Space style={{ justifyContent: 'flex-end', display: 'flex' }}>
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" disabled={errs.length > 0} onClick={handleSubmit}>
          保存
        </Button>
      </Space>
    </Form>
  )
}
