import { memo, useRef, useState } from 'react'
import { Button, Select, Modal, Input, Popconfirm, Tooltip, message } from 'antd'
import {
  PlusOutlined,
  SaveOutlined,
  DeleteOutlined,
  ImportOutlined,
  ExportOutlined,
  ApartmentOutlined,
} from '@ant-design/icons'

// Phase 19 / REN-02（P14）：字段 optional 化——与 TopologySummary 对齐，兼容持久化历史 JSON
interface TopologyItem {
  id?: string
  name?: string
  status?: string
}

interface TopologyToolbarProps {
  topologies: TopologyItem[]
  currentTopologyId: string | null
  onTopologyChange: (id: string | null) => void
  onNew: (name: string) => void
  onSave: () => void
  onDelete: () => void
  onImport: (jsonStr: string) => void
  onExport: () => void
  onOrganizeLayout: () => void
  // Phase 26 / 26-04 再工 spec ④：画布选中设备数——tooltip 动态文案
  selectedCount: number
  isLayoutPreviewing: boolean
}

function TopologyToolbar({
  topologies,
  currentTopologyId,
  onTopologyChange,
  onNew,
  onSave,
  onDelete,
  onImport,
  onExport,
  onOrganizeLayout,
  selectedCount,
  isLayoutPreviewing,
}: TopologyToolbarProps) {
  const [newModalOpen, setNewModalOpen] = useState(false)
  const [newName, setNewName] = useState('')
  // Phase 26 / T-26-03-03：预览态防误离开——Select onChange 拦截，确认放弃才切换
  const [leaveModalOpen, setLeaveModalOpen] = useState(false)
  const pendingTopologyIdRef = useRef<string | null>(null)

  const handleTopologySelect = (id: string | null) => {
    if (isLayoutPreviewing) {
      pendingTopologyIdRef.current = id
      setLeaveModalOpen(true)
      return
    }
    onTopologyChange(id)
  }

  const handleLeaveConfirm = () => {
    const id = pendingTopologyIdRef.current
    pendingTopologyIdRef.current = null
    setLeaveModalOpen(false)
    onTopologyChange(id)
  }

  const handleLeaveCancel = () => {
    pendingTopologyIdRef.current = null
    setLeaveModalOpen(false)
  }

  const handleNew = () => {
    if (!newName.trim()) {
      message.warning('请输入拓扑名称')
      return
    }
    onNew(newName.trim())
    setNewName('')
    setNewModalOpen(false)
  }

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const text = await file.text()
      try {
        JSON.parse(text)
        onImport(text)
      } catch {
        message.error('无效的JSON文件')
      }
    }
    input.click()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px' }}>
      <div
        style={{
          fontSize: 'var(--nt-font-xxxs-11-font-size)',
          color: 'var(--nt-alias-label-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 2,
        }}
      >
        拓扑操作
      </div>
      <Select
        style={{ width: '100%' }}
        placeholder="选择拓扑"
        allowClear
        value={currentTopologyId}
        onChange={handleTopologySelect}
        options={topologies.map((t) => ({ label: t.name, value: t.id }))}
        size="small"
      />
      <Button
        block
        size="small"
        icon={<PlusOutlined />}
        onClick={() => setNewModalOpen(true)}
      >
        新建
      </Button>
      <Button
        block
        size="small"
        icon={<SaveOutlined />}
        disabled={!currentTopologyId}
        onClick={onSave}
      >
        保存
      </Button>
      <Popconfirm
        title="确定删除此拓扑？"
        onConfirm={onDelete}
        okText="确定"
        cancelText="取消"
      >
        <Button
          block
          size="small"
          icon={<DeleteOutlined />}
          danger
          disabled={!currentTopologyId}
        >
          删除
        </Button>
      </Popconfirm>
      <Button block size="small" icon={<ImportOutlined />} onClick={handleImport}>
        导入
      </Button>
      {/* Phase 26 / 26-04 再工 spec ④：整理布局 tooltip 按选中态动态文案 */}
      <Tooltip
        title={
          selectedCount === 0
            ? '未选中：按连接层级星型排列全图'
            : selectedCount === 1
              ? '已选 1 台：以该设备为中心排列全图'
              : '已选多台：仅整理选中设备'
        }
      >
        <Button
          block
          size="small"
          icon={<ApartmentOutlined />}
          disabled={!currentTopologyId}
          onClick={onOrganizeLayout}
        >
          整理布局
        </Button>
      </Tooltip>
      {/* D-11 网格吸附按钮已移除（26-04 checkpoint round 3 用户裁决「没有太大意义」） */}
      <Button
        block
        size="small"
        icon={<ExportOutlined />}
        disabled={!currentTopologyId}
        onClick={onExport}
      >
        导出
      </Button>

      <Modal
        title="新建拓扑"
        open={newModalOpen}
        onOk={handleNew}
        onCancel={() => { setNewModalOpen(false); setNewName('') }}
        okText="创建"
        cancelText="取消"
      >
        <Input
          placeholder="拓扑名称"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={handleNew}
          autoFocus
        />
      </Modal>
      <Modal
        title="布局预览尚未保存"
        open={leaveModalOpen}
        onOk={handleLeaveConfirm}
        onCancel={handleLeaveCancel}
        okText="放弃修改"
        okButtonProps={{ danger: true }}
        cancelText="继续编辑"
      >
        切换拓扑将丢弃未保存的布局调整，是否放弃修改？
      </Modal>
    </div>
  )
}

// Phase 26 / 26-04 round 3 P-C：memo 隔离——props 全稳定（回调经 useCallback / 模块级 noop），
// 父组件拖拽每帧重渲染时本组件直接跳过
export default memo(TopologyToolbar)
