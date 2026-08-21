import { useEffect, useState } from 'react'
import { Modal, Table, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { v4 as uuidv4 } from 'uuid'
import { nearestFreePosition, NODE_WIDTH, NODE_HEIGHT, type LayoutNode } from '@/utils/topologyLayout'
import type { Device, DeviceType } from '@/types/device'
import type { TopologyNode } from '@/types/topology'

interface AddDeviceModalProps {
  open: boolean
  existingNodes: TopologyNode[]
  // Phase 26 / D-13：视野中心（画布坐标）取值器——Modal 不在 ReactFlow Provider 内，由父组件经 ref 注入
  getViewportCenter?: () => { x: number; y: number }
  onConfirm: (nodes: TopologyNode[]) => void
  onCancel: () => void
}

const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  router: '路由器',
  switch: '交换机',
  firewall: '防火墙',
  server: '服务器',
  generic: '通用设备',
}

export default function AddDeviceModal({
  open,
  existingNodes,
  getViewportCenter,
  onConfirm,
  onCancel,
}: AddDeviceModalProps) {
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setLoading(true)
      window.api.device
        .list()
        .then((list) => setDevices(list))
        .finally(() => setLoading(false))
      setSelectedRowKeys([])
    }
  }, [open])

  const existingDeviceIds = new Set(existingNodes.map((n) => n.data.deviceId))

  const availableDevices = devices.filter((d) => !existingDeviceIds.has(d.id))

  const columns: ColumnsType<Device> = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: 'IP地址', dataIndex: 'ipAddress', key: 'ipAddress' },
    {
      title: '类型',
      dataIndex: 'deviceType',
      key: 'deviceType',
      render: (t: DeviceType) => DEVICE_TYPE_LABELS[t] || t,
    },
    { title: '厂商', dataIndex: 'vendor', key: 'vendor' },
  ]

  const handleOk = () => {
    if (selectedRowKeys.length === 0) {
      message.warning('请选择至少一个设备')
      return
    }

    // Phase 26 / D-13：新增设备落当前视野中心最近不重叠空位（替换原 Math.random 随机落点）；
    // 批量添加时已生成的新节点也计入占位集，多台设备依次散开不互相叠压
    const center = getViewportCenter?.() ?? { x: 300, y: 200 }
    const occupied: LayoutNode[] = existingNodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }))
    const newNodes: TopologyNode[] = selectedRowKeys.map((deviceId) => {
      const device = devices.find((d) => d.id === deviceId)!
      const pos = nearestFreePosition(center, occupied)
      const nodeId = uuidv4()
      occupied.push({ id: nodeId, x: pos.x, y: pos.y, width: NODE_WIDTH, height: NODE_HEIGHT })
      return {
        id: nodeId,
        type: 'deviceNode' as const,
        position: { x: pos.x, y: pos.y },
        data: {
          deviceId: device.id,
          deviceName: device.name,
          deviceType: device.deviceType,
          connectionType: device.connectionType,
          ipAddress: device.ipAddress,
          vendor: device.vendor,
          model: device.model,
        },
      }
    })

    onConfirm(newNodes)
    setSelectedRowKeys([])
  }

  return (
    <Modal
      title="添加设备到拓扑"
      open={open}
      onOk={handleOk}
      onCancel={() => { setSelectedRowKeys([]); onCancel() }}
      okText="添加"
      cancelText="取消"
      width={700}
    >
      <Table<Device>
        rowKey="id"
        columns={columns}
        dataSource={availableDevices}
        loading={loading}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys as string[]),
        }}
        pagination={false}
        size="small"
      />
    </Modal>
  )
}
