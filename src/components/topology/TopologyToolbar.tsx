import { useState } from 'react'
import { Button, Select, Modal, Input, Popconfirm, message } from 'antd'
import {
  PlusOutlined,
  SaveOutlined,
  DeleteOutlined,
  ImportOutlined,
  ExportOutlined,
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
}

export default function TopologyToolbar({
  topologies,
  currentTopologyId,
  onTopologyChange,
  onNew,
  onSave,
  onDelete,
  onImport,
  onExport,
}: TopologyToolbarProps) {
  const [newModalOpen, setNewModalOpen] = useState(false)
  const [newName, setNewName] = useState('')

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
          fontSize: 11,
          color: '#999',
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
        onChange={onTopologyChange}
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
    </div>
  )
}
