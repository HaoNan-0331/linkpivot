import { Table, Tag, Tooltip, Typography, Space, Input } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { ReactNode } from 'react'

const { Text } = Typography

/**
 * Phase 29 Plan 29-06（PKG-05，D-15/D-16/D-21）—— 设备级 env 表格编辑器。
 *
 * 「从包创建向导」与手工「本地程序」编辑态共用组件：
 *  - 行 = 设备（名称/型号/匹配原因/冲突灰显 + 「已绑配置 {name}」标注）
 *  - 列 = env 键（只读列头，monospace），值单元格 Input.Password（UI 契约 4）
 *  - 值回显只显 ****尾4 哨兵形态——renderer 永不接收明文（UI 契约 5，
 *    UNCHANGED_ENV_SENTINEL 双侧同名常量约定在 McpTab 侧统一消费）
 */

export interface DeviceEnvRow {
  deviceId: string
  name: string
  model: string | null
  /** 命中的 manifest 型号（「匹配：{型号}」原因标注；未命中 null） */
  matchReason?: string | null
  /** 已被其它配置绑定 → 行灰显 + 不可勾选（硬拦截在 service 事务，此处仅 UI） */
  boundConfigName?: string | null
}

interface DeviceEnvTableProps {
  rows: DeviceEnvRow[]
  /** env 键列（来自 manifest 声明或手工配置既有键并集） */
  envKeys: string[]
  /** deviceId → key → 值（未修改项存 ****尾4 脱敏回显串） */
  value: Record<string, Record<string, string>>
  onChange: (deviceId: string, key: string, v: string) => void
  /** 提供则渲染勾选列（向导预筛 / 手工编辑态绑定设备）；不提供则纯 env 录入 */
  selected?: string[]
  onSelectedChange?: (ids: string[]) => void
  /** 手工模式「添加变量」入口挂槽（新增 env 键列） */
  addKeySlot?: ReactNode
  /** 空列提示文案（向导：该包未声明环境变量，无需填写） */
  emptyKeysHint?: string
}

export default function DeviceEnvTable({
  rows, envKeys, value, onChange, selected, onSelectedChange, addKeySlot, emptyKeysHint,
}: DeviceEnvTableProps) {
  if (envKeys.length === 0) {
    return (
      <div>
        <Text type="secondary">{emptyKeysHint ?? '该包未声明环境变量，无需填写'}</Text>
        {addKeySlot}
      </div>
    )
  }

  const columns: ColumnsType<DeviceEnvRow> = [
    {
      title: '设备', width: 220,
      render: (_: unknown, r) => {
        const conflict = r.boundConfigName != null
        return (
          <div style={{ opacity: conflict ? 0.45 : 1 }}>
            <Space>
              <Text strong style={{ whiteSpace: 'normal' }}>{r.name}</Text>
              {r.matchReason != null && <Tag color="purple" style={{ marginInlineEnd: 0 }}>匹配：{r.matchReason}</Tag>}
            </Space>
            <div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.model ?? '型号未知'}</div>
            {conflict && (
              <Tooltip title={`已绑配置 ${r.boundConfigName}`}>
                <Tag style={{ marginTop: 2 }}>已绑配置 {r.boundConfigName}</Tag>
              </Tooltip>
            )}
          </div>
        )
      },
    },
    ...envKeys.map<ColumnsType<DeviceEnvRow>[number]>((key) => ({
      title: <code style={{ fontFamily: 'monospace', fontSize: 13 }}>{key}</code>,
      render: (_: unknown, r) => (
        <Input.Password
          size="small"
          style={{ width: '100%', maxWidth: 220 }}
          value={value[r.deviceId]?.[key] ?? ''}
          placeholder="值"
          onChange={(e) => onChange(r.deviceId, key, e.target.value)}
        />
      ),
    })),
  ]

  return (
    <div>
      <Table
        size="small"
        rowKey="deviceId"
        columns={columns}
        dataSource={rows}
        pagination={rows.length > 8 ? { pageSize: 8, hideOnSinglePage: true } : false}
        scroll={{ x: 'max-content' }}
        {...(onSelectedChange != null && selected != null
          ? {
              rowSelection: {
                selectedRowKeys: selected,
                onChange: (keys) => onSelectedChange(keys.map(String)),
                getCheckboxProps: (r: DeviceEnvRow) => ({ disabled: r.boundConfigName != null }),
              },
            }
          : {})}
      />
      {addKeySlot}
    </div>
  )
}
