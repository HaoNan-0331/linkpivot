import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Empty, Input, Modal, Select, Space, Tag, Tooltip, Typography } from 'antd'
import type { McpEnvMetaEntryDto } from '../../types/electron'

const { Text } = Typography

/**
 * Phase 29 Plan 29-08（Gap-3/Gap-5，PKG-05）—— 设备卡片式 env 编辑器。
 *
 * 交互模型（UAT 确认）：
 *  - 【绑定设备】弹设备单选框，确定后页面新增一张设备卡片（一次一台）
 *  - 已绑定设备（boundConfigName != null）由父组件在组装 selectOptions 时过滤，
 *    弹窗中不出现（本组件不含 boundConfigName 字段，亦无 disabled 灰显分支）；
 *    组件内对疑似已绑定项再作防御性过滤兜底
 *  - 卡片 body = env 行编辑器：【＋添加变量】新增行，每行 = 变量名（可编辑）+
 *    值（Input.Password）+ 删除；env 键集合完全由行驱动，不限于任何预设列（Gap-5）
 *  - 值回显只透传 ****尾4 脱敏串，哨兵判定（UNCHANGED_ENV_SENTINEL）归父组件
 */

export interface DeviceCardItem {
  deviceId: string
  name: string
  model: string | null
  matchReason?: string | null
}

export interface DeviceSelectOption {
  deviceId: string
  name: string
  model: string | null
  matchReason?: string | null
  /** 父组件传入即视为已绑定（防御性兜底；正常情况下父组件已过滤不传入） */
  boundConfigName?: string | null
}

interface DeviceEnvCardsProps {
  /** 已添加的设备卡片 */
  cards: DeviceCardItem[]
  /** deviceId → envKey → 值（未修改项存 ****尾4 脱敏回显串） */
  envValues: Record<string, Record<string, string>>
  /** 行值/键变更回调；行删除时发 (deviceId, key, '')——父组件按约定删除该键 */
  onValueChange: (deviceId: string, key: string, v: string) => void
  onAddDevice: (deviceId: string) => void
  onRemoveDevice: (deviceId: string) => void
  /** 单选弹窗候选设备（已绑定设备由父组件过滤，不传入） */
  selectOptions: DeviceSelectOption[]
  /** 29.1 D-03：包级 env 元数据（键 → label/description/required/example/default）；缺省回落裸键名渲染 */
  envMeta?: Record<string, McpEnvMetaEntryDto>
  emptyHint?: string
}

interface EnvRow {
  key: string
  val: string
}

const toRows = (value: Record<string, string>): EnvRow[] =>
  Object.entries(value).map(([key, val]) => ({ key, val }))

/** 比较「意图态」：空值条目视同缺席（父组件约定空值=删除键，删除后键不在 Record 中） */
const sameEnvMap = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const na = Object.entries(a).filter(([, v]) => v !== '')
  if (na.length !== Object.keys(b).filter((k) => b[k] !== '').length) return false
  for (const [k, v] of na) {
    if (b[k] !== v) return false
  }
  return true
}

/**
 * env 行编辑器（同文件内不导出）。
 * 29-09 走查修复（问题4）：草稿行模型——行列表完全由本地态驱动；键为空的新增行、
 * 值清空过程中的行停留在草稿态，不再与「空值=删除键」通道直接耦合（旧实现 addRow 发
 * ('','') 被父组件按约定判删除，行永远进不来，按钮表现为无响应）。
 * 仅当行同时具备非空键与非空值才提交进父组件 value；行删除/键改名仍按约定发空值删旧键。
 * 变量名编辑 = 旧键删新键加，由内部 diff 最终态后统一 onChange。
 */
function EnvRowsEditor({
  deviceId, value, onChange, envMeta,
}: {
  deviceId: string
  value: Record<string, string>
  onChange: (deviceId: string, key: string, v: string) => void
  envMeta?: Record<string, McpEnvMetaEntryDto>
}) {
  const [rows, setRows] = useState<EnvRow[]>(() => toRows(value))
  /** 自己刚发出的目标态：父组件回显与之一致时不重建本地行（避免输入过程行被重置） */
  const lastEmitted = useRef<Record<string, string> | null>(null)

  // 外部变更（编辑回显 / 卡片增删 / 父侧删除）同步进本地行
  useEffect(() => {
    if (lastEmitted.current && sameEnvMap(lastEmitted.current, value)) return
    setRows(toRows(value))
  }, [value])

  const apply = (next: EnvRow[]) => {
    setRows(next)
    const nextMap: Record<string, string> = {}
    for (const r of next) {
      if (r.key !== '' && r.val !== '') nextMap[r.key] = r.val
    }
    lastEmitted.current = nextMap
    for (const k of Object.keys(value)) {
      if (!(k in nextMap)) onChange(deviceId, k, '')
    }
    for (const [k, v] of Object.entries(nextMap)) {
      if (value[k] !== v) onChange(deviceId, k, v)
    }
  }

  const addRow = () => apply([...rows, { key: '', val: '' }])

  const removeRow = (idx: number) => apply(rows.filter((_, i) => i !== idx))

  const renameKey = (idx: number, newKey: string) => {
    if (rows[idx].key === newKey) return
    apply(rows.map((r, i) => (i === idx ? { ...r, key: newKey } : r)))
  }

  const setVal = (idx: number, v: string) => {
    apply(rows.map((r, i) => (i === idx ? { ...r, val: v } : r)))
  }

  if (rows.length === 0) {
    return (
      <div>
        <Text type="secondary">尚未配置环境变量，点击＋添加变量新增</Text>
        <div style={{ marginTop: 8 }}>
          <Button size="small" onClick={addRow}>＋添加变量</Button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((r, idx) => {
        // meta 按当前键名动态取（renameKey 后跟随；无 meta 键回落现状裸键名渲染）
        const meta = envMeta?.[r.key]
        // 29.1 D-01/D-02：required 且无 default 且值空（含删行/未填）→ 红框硬提示；
        // 有 default 的 required 键留空合法（default 兜底），仅灰字提示不标红
        const missingRequired = meta?.required === true && meta.default == null && r.val.trim() === ''
        const tooltipLines: string[] = []
        if (meta?.description != null) tooltipLines.push(meta.description)
        if (meta?.example != null) tooltipLines.push(`示例：${meta.example}`)
        return (
          <Space key={`row-${idx}`} align="center">
            <Input
              style={{ width: 180 }}
              placeholder="变量名"
              value={r.key}
              onChange={(e) => renameKey(idx, e.target.value)}
            />
            {meta && (
              <Tooltip title={tooltipLines.length > 0 ? tooltipLines.join('\n') : meta.label}>
                <Space size={4} style={{ maxWidth: 150 }}>
                  {meta.required === true && <Tag color="red" style={{ marginInlineEnd: 0 }}>必填</Tag>}
                  <span style={{
                    fontSize: 12, color: '#595959', maxWidth: 110,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{meta.label}</span>
                </Space>
              </Tooltip>
            )}
            <Input.Password
              style={{ width: 260 }}
              status={missingRequired ? 'error' : undefined}
              placeholder={meta?.default != null && r.val === '' ? `留空将使用包默认 ${meta.default}` : '值'}
              value={r.val}
              onChange={(e) => setVal(idx, e.target.value)}
            />
            <Button type="link" size="small" danger onClick={() => removeRow(idx)}>删除</Button>
          </Space>
        )
      })}
      <div>
        <Button size="small" onClick={addRow}>＋添加变量</Button>
      </div>
    </div>
  )
}

export default function DeviceEnvCards({
  cards, envValues, onValueChange, onAddDevice, onRemoveDevice, selectOptions, envMeta, emptyHint,
}: DeviceEnvCardsProps) {
  const [selectOpen, setSelectOpen] = useState(false)
  const [pickedId, setPickedId] = useState<string | null>(null)

  const cardIds = useMemo(() => new Set(cards.map((c) => c.deviceId)), [cards])

  // 已绑定设备由父组件过滤不传入；此处再作防御性过滤兜底（疑似已绑定项不出现）
  const options = useMemo(
    () => selectOptions.filter((o) => o.boundConfigName == null && !cardIds.has(o.deviceId)),
    [selectOptions, cardIds],
  )

  const confirmAdd = () => {
    if (pickedId == null) return
    onAddDevice(pickedId)
    setPickedId(null)
    setSelectOpen(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <Button size="small" onClick={() => { setPickedId(null); setSelectOpen(true) }}>绑定设备</Button>
      </div>

      {cards.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={emptyHint ?? '尚未绑定设备，点击「绑定设备」逐台添加并配置独立环境变量'}
        />
      ) : (
        cards.map((c) => (
          <Card
            key={c.deviceId}
            size="small"
            title={(
              <Space size={8} wrap>
                <Text strong>{c.name}</Text>
                <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>{c.model ?? '型号未知'}</Text>
                {c.matchReason != null && <Tag color="purple" style={{ marginInlineEnd: 0 }}>匹配：{c.matchReason}</Tag>}
              </Space>
            )}
            extra={(
              <Button type="link" size="small" danger onClick={() => onRemoveDevice(c.deviceId)}>移除</Button>
            )}
          >
            <EnvRowsEditor
              deviceId={c.deviceId}
              value={envValues[c.deviceId] ?? {}}
              onChange={onValueChange}
              envMeta={envMeta}
            />
          </Card>
        ))
      )}

      {/* 设备单选弹窗：一次添加一台；已绑定设备不出现（父组件已过滤） */}
      <Modal
        open={selectOpen}
        title="绑定设备"
        okText="确定"
        cancelText="取消"
        okButtonProps={{ disabled: pickedId == null }}
        onOk={confirmAdd}
        onCancel={() => setSelectOpen(false)}
      >
        <div style={{ paddingTop: 8 }}>
          {options.length === 0 ? (
            <Text type="secondary">没有可绑定的设备（已绑定其它配置的设备不会出现在此处）</Text>
          ) : (
            <Select
              style={{ width: '100%' }}
              placeholder="选择要绑定的设备"
              value={pickedId}
              onChange={(v: string) => setPickedId(v)}
              options={options.map((o) => ({
                value: o.deviceId,
                label: (
                  <Space size={6}>
                    <span>{o.name}</span>
                    <span style={{ fontSize: 12, color: '#8c8c8c' }}>{o.model ?? '型号未知'}</span>
                    {o.matchReason != null && <Tag color="purple" style={{ marginInlineEnd: 0 }}>匹配：{o.matchReason}</Tag>}
                  </Space>
                ),
              }))}
            />
          )}
        </div>
      </Modal>
    </div>
  )
}
