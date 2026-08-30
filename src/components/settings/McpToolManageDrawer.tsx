import { useCallback, useEffect, useState } from 'react'
import { Checkbox, Drawer, Empty, Spin, Switch, Table, Tag, Tooltip, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { McpToolCacheDto } from '../../types/electron'

const { Text } = Typography

const ipcErrMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 置灰原因（22-04 裁决后单条件文案；判定权在 main，renderer 只消费 skipConfirmEligible） */
const SKIP_CONFIRM_INELIGIBLE_TIP =
  '该工具未被 MCP server 声明为只读（readOnlyHint），只能逐次确认。'

interface Props {
  open: boolean
  onClose: () => void
  config: { id: number; name: string } | null
}

/**
 * D-02 工具级管理抽屉：单一数据源 mcp:getToolCache（最近一次连接测试落库清单），
 * 启用/免确认切换即保存；免确认可勾性唯一依据 = main 下发的 skipConfirmEligible。
 */
export default function McpToolManageDrawer({ open, onClose, config }: Props) {
  const [tools, setTools] = useState<McpToolCacheDto[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (config == null) return
    setLoading(true)
    try {
      setTools(await window.api.mcp.getToolCache(config.id))
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
    setLoading(false)
  }, [config])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const handleToggleEnabled = async (record: McpToolCacheDto, enabled: boolean) => {
    if (config == null) return
    try {
      await window.api.mcp.setToolEnabled(config.id, record.name, enabled)
      load()
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  const handleToggleSkipConfirm = async (record: McpToolCacheDto, skip: boolean) => {
    if (config == null) return
    try {
      const result = await window.api.mcp.setToolSkipConfirm(config.id, record.name, skip)
      if (result.ok) {
        if (skip) {
          message.success(`已设为免确认：${record.name} 将在「智能」档下直接执行（「每次确认」档仍会弹窗）`)
        }
      } else {
        message.warning(result.reason)
      }
      load()
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  const columns: ColumnsType<McpToolCacheDto> = [
    {
      title: '工具名', dataIndex: 'name', width: 180,
      render: (v: string) => <code style={{ fontFamily: 'var(--nt-font-family-code)', fontSize: 'var(--nt-font-xs-13-font-size)' }}>{v}</code>,
    },
    {
      title: '描述', dataIndex: 'description', ellipsis: true,
      render: (v: string | undefined) => (v ? <Tooltip title={v}><span>{v}</span></Tooltip> : <Text type="secondary">—</Text>),
    },
    {
      title: '只读', width: 90,
      // 两档 Tag（22-04 裁决）：hint=true 且名字命中正则 →「已验证只读」（加强标记）；
      // 仅 hint=true →「只读」。均消费 main 下发字段，组件无本地判定。
      render: (_: unknown, record: McpToolCacheDto) =>
        record.annotations?.readOnlyHint === true ? (
          record.verifiedReadOnly ? (
            <Tag color="success">已验证只读</Tag>
          ) : (
            <Tag color="success">只读</Tag>
          )
        ) : null,
    },
    {
      title: '启用', dataIndex: 'enabled', width: 70,
      render: (v: 0 | 1, record: McpToolCacheDto) => (
        <Switch checked={v === 1} onChange={(checked) => handleToggleEnabled(record, checked)} />
      ),
    },
    {
      title: '免确认', dataIndex: 'skipConfirm', width: 80,
      render: (v: 0 | 1, record: McpToolCacheDto) => record.skipConfirmEligible ? (
        <Checkbox checked={v === 1} onChange={(e) => handleToggleSkipConfirm(record, e.target.checked)} />
      ) : (
        <Tooltip title={SKIP_CONFIRM_INELIGIBLE_TIP}>
          <Checkbox checked={false} disabled />
        </Tooltip>
      ),
    },
  ]

  return (
    <Drawer open={open} onClose={onClose} title={config != null ? `工具管理：${config.name}` : ''} width={640}>
      {loading ? (
        <Spin />
      ) : tools.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <div>
              <div style={{ fontWeight: 600 }}>暂无工具清单</div>
              <div style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-label-secondary)', marginTop: 4 }}>
                工具清单来自最近一次连接测试的结果。请先返回配置列表点「测试」，成功后再回来管理工具。
              </div>
            </div>
          }
        />
      ) : (
        <Table size="small" rowKey="name" columns={columns} dataSource={tools} pagination={false} />
      )}
    </Drawer>
  )
}
