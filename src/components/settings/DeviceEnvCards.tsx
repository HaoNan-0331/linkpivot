import { useMemo, useState } from 'react'
import { Button, Card, Empty, Input, Modal, Select, Space, Tag, Typography } from 'antd'

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
  emptyHint?: string
}

/**
 * env 行编辑器（同文件内不导出）。
 * 变量名编辑 = 旧键删新键加，由内部组装完整 Record 后统一 onChange。
 */
function EnvRowsEditor({
  deviceId, value, onChange,
}: {
  deviceId: string
  value: Record<string, string>
  onChange: (deviceId: string, key: string, v: string) => void
}) {
  /** 行序保持稳定：以插入序维护 key 列表（Record 本身无序） */
  const [keyOrder, setKeyOrder] = useState<string[]>(() => Object.keys(value))

  /** 以最终态逐键同步：消失的键发空值（约定 = 删除该键），存在/变化的键发新值 */
  const emit = (next: Record<string, string>) => {
    setKeyOrder(Object.keys(next))
    for (const k of Object.keys(value)) {
      if (!(k in next)) onChange(deviceId, k, '')
    }
    for (const [k, v] of Object.entries(next)) {
      if (value[k] !== v) onChange(deviceId, k, v)
    }
  }

  const addRow = () => {
    emit({ ...value, '': '' })
  }

  const removeRow = (key: string) => {
    const next = { ...value }
    delete next[key]
    emit(next)
  }

  const renameKey = (oldKey: string, newKey: string) => {
    if (newKey === oldKey) return
    const next: Record<string, string> = {}
    for (const k of keyOrder.length > 0 ? keyOrder : Object.keys(value)) {
      if (k === oldKey) {
        // 同名目标已存在时后者覆盖（用户自行取舍）
        next[newKey] = value[oldKey] ?? ''
      } else if (!(k in next)) {
        next[k] = value[k] ?? ''
      }
    }
    emit(next)
  }

  const rows = keyOrder.filter((k) => k in value)
  if (rows.length === 0 && Object.keys(value).length === 0) {
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
      {rows.map((key) => (
        <Space key={key || '__empty__'} align="center">
          <Input
            style={{ width: 180 }}
            placeholder="变量名"
            value={key}
            onChange={(e) => renameKey(key, e.target.value)}
          />
          <Input.Password
            style={{ width: 260 }}
            placeholder="值"
            value={value[key] ?? ''}
            onChange={(e) => onChange(deviceId, key, e.target.value)}
          />
          <Button type="link" size="small" danger onClick={() => removeRow(key)}>删除</Button>
        </Space>
      ))}
      <div>
        <Button size="small" onClick={addRow}>＋添加变量</Button>
      </div>
    </div>
  )
}

export default function DeviceEnvCards({
  cards, envValues, onValueChange, onAddDevice, onRemoveDevice, selectOptions, emptyHint,
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
