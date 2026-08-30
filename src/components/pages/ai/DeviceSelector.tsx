import { useMemo, useState } from 'react'
import { Checkbox, Input, Popover, Tag } from 'antd'
import type { DeviceOption } from './types'

/**
 * 全设备选择器（Phase 23 / DSL-01，D-01/D-02/D-09；23-04 反馈1 收起态重构）。
 *
 * - 收起态一行：已选设备名摘要（≤3 台直列，>3 台「前2名 等 N 台」；未选时引导文案），
 *   不压缩对话区面积；未选时显示引导文案「点击选择目标设备」
 * - hover 浮层展开完整选择器（Popover trigger="hover"——浮层本身属 trigger 容器，
 *   移入列表不消失，移开整体收起；比纯 hover-in-list 更稳，交互失败可降级 click）
 * - D-01: 浮层内 Input 按名称/IP 即时过滤 + Checkbox 平铺列表（无分组折叠、无筛选 chip）
 * - D-02: 每行能力 Tag 并列标注——绿=可执行(hasSSH||hasTelnet) / 蓝=可调MCP(hasMcp) /
 *   灰=仅问答（三布尔全 false）；双能力设备双 Tag 并列渲染
 * - D-09: 选中 >10 台 inline 黄色提示，不 disable 不阻止
 *
 * 零本地推导契约：Tag 判定只消费 main 经 device:list 下发的 capabilities 布尔，
 * 不从 connectionType 推导（T-23-11）。
 */
export default function DeviceSelector({
  devices,
  selectedDevices,
  onChange
}: {
  devices: DeviceOption[]
  selectedDevices: string[]
  onChange: (ids: string[]) => void
}) {
  const [keyword, setKeyword] = useState('')

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return devices
    return devices.filter(
      (d) => d.name.toLowerCase().includes(kw) || (d.ipAddress || '').toLowerCase().includes(kw)
    )
  }, [devices, keyword])

  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...selectedDevices, id] : selectedDevices.filter((i) => i !== id))
  }

  // 收起态摘要（反馈1）：已选名称直列，>3 台截断为「前2 等 N 台」；未选显示引导
  const selectedNames = selectedDevices
    .map((id) => devices.find((d) => d.id === id)?.name)
    .filter((n): n is string => !!n)
  const summary =
    selectedNames.length === 0
      ? '点击选择目标设备'
      : selectedNames.length <= 3
        ? `已选：${selectedNames.join('、')}`
        : `已选：${selectedNames.slice(0, 2).join('、')} 等 ${selectedNames.length} 台`

  const panel = (
    <div style={{ width: 320 }}>
      <div style={{ fontWeight: 500, marginBottom: 6, fontSize: 'var(--nt-font-xs-13-font-size)' }}>选择目标设备</div>
      <Input
        allowClear
        size="small"
        placeholder="搜索设备名称"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        style={{ marginBottom: 4 }}
      />
      <div
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          border: '1px solid var(--nt-alias-border-l4)',
          borderRadius: 6,
          padding: '4px 8px'
        }}
      >
        {filtered.length === 0 && (
          <div style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)', padding: '6px 0' }}>无匹配设备</div>
        )}
        {filtered.map((d) => {
          const checked = selectedDevices.includes(d.id)
          return (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', padding: '2px 0' }}>
              <Checkbox checked={checked} onChange={(e) => toggle(d.id, e.target.checked)}>
                <span style={{ fontSize: 'var(--nt-font-xs-13-font-size)' }}>{d.name}</span>
              </Checkbox>
              <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                {(d.capabilities.hasSSH || d.capabilities.hasTelnet) && (
                  <Tag color="green" style={{ marginLeft: 6, fontSize: 'var(--nt-font-xxxs-11-font-size)', marginRight: 0 }}>可执行</Tag>
                )}
                {d.capabilities.hasMcp && (
                  <Tag color="blue" style={{ marginLeft: 6, fontSize: 'var(--nt-font-xxxs-11-font-size)', marginRight: 0 }}>可调MCP</Tag>
                )}
                {!d.capabilities.hasSSH && !d.capabilities.hasTelnet && !d.capabilities.hasMcp && (
                  <Tag style={{ marginLeft: 6, fontSize: 'var(--nt-font-xxxs-11-font-size)', marginRight: 0 }}>仅问答</Tag>
                )}
              </span>
            </div>
          )
        })}
      </div>
      {selectedDevices.length > 10 && (
        <Tag color="warning" style={{ marginTop: 4, fontSize: 'var(--nt-font-xxxs-11-font-size)' }}>
          设备较多，AI 回答质量可能下降
        </Tag>
      )}
    </div>
  )

  return (
    <Popover
      content={panel}
      trigger="hover"
      placement="bottomRight"
      mouseEnterDelay={0.15}
      overlayStyle={{ maxWidth: 360 }}
    >
      <div
        style={{
          maxWidth: 360,
          padding: '4px 10px',
          border: '1px solid var(--nt-alias-border-l4)',
          borderRadius: 6,
          fontSize: 'var(--nt-font-xs-13-font-size)',
          color: selectedNames.length > 0 ? 'var(--nt-alias-label-primary)' : 'var(--nt-alias-label-tertiary)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {summary}
      </div>
    </Popover>
  )
}
