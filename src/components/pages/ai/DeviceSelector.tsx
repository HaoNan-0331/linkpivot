import { useMemo, useState } from 'react'
import { Checkbox, Input, Tag } from 'antd'
import type { DeviceOption } from './types'

/**
 * 全设备选择器（Phase 23 / DSL-01，D-01/D-02/D-09）。
 *
 * - D-01: Input 按名称/IP 即时过滤 + Checkbox 平铺列表（无分组折叠、无筛选 chip）
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

  return (
    <div style={{ minWidth: 280, maxWidth: 400 }}>
      <Input.Search
        allowClear
        size="small"
        placeholder="搜索名称/IP..."
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        style={{ marginBottom: 4 }}
      />
      <div
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          border: '1px solid #d9d9d9',
          borderRadius: 6,
          padding: '4px 8px'
        }}
      >
        {filtered.length === 0 && (
          <div style={{ color: '#999', fontSize: 12, padding: '6px 0' }}>无匹配设备</div>
        )}
        {filtered.map((d) => {
          const checked = selectedDevices.includes(d.id)
          return (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', padding: '2px 0' }}>
              <Checkbox checked={checked} onChange={(e) => toggle(d.id, e.target.checked)}>
                <span style={{ fontSize: 13 }}>{d.name}</span>
              </Checkbox>
              <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                {(d.capabilities.hasSSH || d.capabilities.hasTelnet) && (
                  <Tag color="green" style={{ marginLeft: 6, fontSize: 11, marginRight: 0 }}>可执行</Tag>
                )}
                {d.capabilities.hasMcp && (
                  <Tag color="blue" style={{ marginLeft: 6, fontSize: 11, marginRight: 0 }}>可调MCP</Tag>
                )}
                {!d.capabilities.hasSSH && !d.capabilities.hasTelnet && !d.capabilities.hasMcp && (
                  <Tag style={{ marginLeft: 6, fontSize: 11, marginRight: 0 }}>仅问答</Tag>
                )}
              </span>
            </div>
          )
        })}
      </div>
      {selectedDevices.length > 10 && (
        <Tag color="warning" style={{ marginTop: 4, fontSize: 11 }}>
          设备较多，AI 回答质量可能下降
        </Tag>
      )}
    </div>
  )
}
