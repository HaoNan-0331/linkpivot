import { useEffect, useState } from 'react'
import { Form, Input, Select, Button, Checkbox } from 'antd'
import type { Device } from '@/types/device'
import type {
  Experience,
  ExperienceUpdateInput,
  ExperienceCategory,
  ExperienceAttrs,
} from '@/types/experience'
import { validateDraft, type DraftDecision } from './ReviewConfirmModal'

/**
 * ReviewConfirmEditForm —— ReviewConfirmModal 右侧编辑表单子组件（Task 2b 提取自 Task 2a 占位）。
 *
 * 受控字段（title/category/content/tags）+ attrs 模板动态字段（category==='troubleshooting'
 * 显 symptoms/root_cause/resolution/prevention/severity，其余轻结构隐藏 attrs 块）+ 关联设备
 * 多选 Select（拉 ssh/telnet 设备，沿用 useAIChat.ts:88 过滤范式）+ UPDATE 旧条目 supersedeOld
 * Checkbox（D-9-2）+「查看原始会话」按钮（叠层 SessionMessagesModal）。
 *
 * onChange 经 patch 增量回写主壳（主壳 updateDecision 已做 fields 浅合并 + relateDevices 替换）。
 * 复用主壳导出的 validateDraft（质量门校验规则单一来源，无双份漂移）。
 */
interface ReviewConfirmEditFormProps {
  draft: Experience
  decision: DraftDecision
  onChange: (patch: Partial<DraftDecision>) => void
  onViewSession: () => void
}

const CATEGORY_OPTIONS: Array<{ value: ExperienceCategory; label: string }> = [
  { value: 'troubleshooting', label: '故障排查' },
  { value: 'best_practices', label: '最佳实践' },
  { value: 'product', label: '产品' },
  { value: 'env', label: '环境' },
]

const SEVERITY_OPTIONS: Array<{ value: NonNullable<ExperienceAttrs['severity']>; label: string }> = [
  { value: 'critical', label: 'critical' },
  { value: 'high', label: 'high' },
  { value: 'medium', label: 'medium' },
  { value: 'low', label: 'low' },
  { value: 'info', label: 'info' },
]

export default function ReviewConfirmEditForm({
  draft,
  decision,
  onChange,
  onViewSession,
}: ReviewConfirmEditFormProps) {
  const [devices, setDevices] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    window.api.device.list().then((all: Device[]) =>
      setDevices(
        all
          .filter((d) => d.connectionType === 'ssh' || d.connectionType === 'telnet')
          .map((d) => ({ id: d.id, name: d.name }))
      )
    ).catch(() => setDevices([]))
  }, [])

  const cat = decision.fields.category ?? draft.category
  const attrs = decision.fields.attrs ?? {}
  const errs = validateDraft(draft, decision.fields)

  // 更新 attrs 单字段（保留其余 attrs 字段）
  function patchAttr<K extends keyof ExperienceAttrs>(key: K, value: ExperienceAttrs[K]) {
    onChange({ fields: { attrs: { ...attrs, [key]: value } } as ExperienceUpdateInput })
  }

  return (
    <Form layout="vertical">
      <Form.Item label="标题" validateStatus={errs.includes('缺 title') ? 'error' : ''} help={errs.includes('缺 title') ? '缺 title' : ''}>
        <Input
          value={decision.fields.title ?? ''}
          onChange={(e) => onChange({ fields: { title: e.target.value } as ExperienceUpdateInput })}
        />
      </Form.Item>
      <Form.Item label="分类">
        <Select
          value={cat}
          onChange={(v: ExperienceCategory) =>
            onChange({ fields: { category: v } as ExperienceUpdateInput })
          }
          options={CATEGORY_OPTIONS}
        />
      </Form.Item>
      <Form.Item
        label="内容"
        validateStatus={errs.includes('缺 content') ? 'error' : ''}
        help={errs.includes('缺 content') ? '缺 content' : ''}
      >
        <Input.TextArea
          value={decision.fields.content ?? ''}
          rows={6}
          onChange={(e) =>
            onChange({ fields: { content: e.target.value } as ExperienceUpdateInput })
          }
        />
      </Form.Item>
      <Form.Item label="标签">
        <Select
          mode="tags"
          value={decision.fields.tags ?? []}
          onChange={(v: string[]) => onChange({ fields: { tags: v } as ExperienceUpdateInput })}
        />
      </Form.Item>
      {cat === 'troubleshooting' && (
        <>
          <Form.Item
            label="severity"
            validateStatus={errs.includes('缺 severity') ? 'error' : ''}
            help={errs.includes('缺 severity') ? '缺 severity' : ''}
          >
            <Select
              value={attrs.severity}
              onChange={(v: NonNullable<ExperienceAttrs['severity']>) => patchAttr('severity', v)}
              options={SEVERITY_OPTIONS}
              allowClear
            />
          </Form.Item>
          <Form.Item
            label="symptoms"
            validateStatus={errs.includes('缺 symptoms') ? 'error' : ''}
            help={errs.includes('缺 symptoms') ? '缺 symptoms' : ''}
          >
            <Input.TextArea
              value={attrs.symptoms ?? ''}
              rows={3}
              onChange={(e) => patchAttr('symptoms', e.target.value)}
            />
          </Form.Item>
          <Form.Item label="root_cause">
            <Input.TextArea
              value={attrs.root_cause ?? ''}
              rows={2}
              onChange={(e) => patchAttr('root_cause', e.target.value)}
            />
          </Form.Item>
          <Form.Item
            label="resolution"
            validateStatus={errs.includes('缺 resolution') ? 'error' : ''}
            help={errs.includes('缺 resolution') ? '缺 resolution' : ''}
          >
            <Input.TextArea
              value={attrs.resolution ?? ''}
              rows={3}
              onChange={(e) => patchAttr('resolution', e.target.value)}
            />
          </Form.Item>
          <Form.Item label="prevention">
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
          value={decision.relateDevices ?? []}
          onChange={(v: string[]) => onChange({ relateDevices: v })}
          options={devices.map((d) => ({ value: d.id, label: d.name }))}
          placeholder="不改关联则留空"
          allowClear
        />
      </Form.Item>
      {draft.duplicate_of_exp_id && (
        <Form.Item>
          <Checkbox
            checked={decision.supersedeOld}
            onChange={(e) => onChange({ supersedeOld: e.target.checked })}
          >
            标失效旧条目（默认不勾，主动勾才 supersede）
          </Checkbox>
        </Form.Item>
      )}
      <Button onClick={onViewSession}>查看原始会话</Button>
    </Form>
  )
}
