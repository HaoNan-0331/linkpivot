import { memo } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import type { DeviceType } from '@/types/device'
import type { TopologyNodeData } from '@/types/topology'

import routerIcon from '@/assets/icons/router.svg'
import switchIcon from '@/assets/icons/switch.svg'
import firewallIcon from '@/assets/icons/firewall.svg'
import serverIcon from '@/assets/icons/server.svg'
import equipmentIcon from '@/assets/icons/equipment.svg'

const iconMap: Record<DeviceType, string> = {
  router: routerIcon,
  switch: switchIcon,
  firewall: firewallIcon,
  server: serverIcon,
  generic: equipmentIcon,
}

// Phase 19 REN-03：memo 化自定义节点，拖拽仅被拖节点重渲染（P13 组装侧——useNodesState 拖拽仅被拖节点换引用）。
// comparator 白名单（P13 双坑红线）：
// - selected 必含：:47-48 选中态边框/底色随选即变，漏掉 = 选中视觉恒失效（恒失效坑）
// - data 引用相等：TopologyPage handleEditConfirm 对被编辑节点 { ...n, data: updatedData }
//   产新 data 引用 → memo 放行编辑更新（D-09 ①「编辑节点立即刷新」回归前提）
function DeviceNodeInner({ data, selected }: NodeProps<TopologyNodeData>) {
  const iconSrc = iconMap[data.deviceType] || equipmentIcon

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Handle type="target" position={Position.Top} id="top" style={{ background: '#1890ff', width: 8, height: 8 }} />
      <Handle type="target" position={Position.Bottom} id="bottom" style={{ background: '#1890ff', width: 8, height: 8 }} />
      <Handle type="target" position={Position.Left} id="left" style={{ background: '#1890ff', width: 8, height: 8 }} />
      <Handle type="target" position={Position.Right} id="right" style={{ background: '#1890ff', width: 8, height: 8 }} />

      <div
        style={{
          position: 'absolute',
          top: -20,
          whiteSpace: 'nowrap',
          fontSize: 12,
          fontWeight: 600,
          color: '#333',
          userSelect: 'none',
        }}
      >
        {data.deviceName}
      </div>

      <div
        style={{
          padding: 4,
          borderRadius: 8,
          border: selected ? '2px solid #1890ff' : '2px solid transparent',
          background: selected ? 'rgba(24,144,255,0.06)' : 'transparent',
        }}
      >
        <img src={iconSrc} alt={data.deviceType} width={50} height={50} draggable={false} />
      </div>

      <div
        style={{
          marginTop: 2,
          fontSize: 10,
          color: '#999',
          userSelect: 'none',
        }}
      >
        {data.ipAddress}
      </div>

      <Handle type="source" position={Position.Top} id="top" style={{ background: '#52c41a', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: '#52c41a', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Left} id="left" style={{ background: '#52c41a', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} id="right" style={{ background: '#52c41a', width: 8, height: 8 }} />
    </div>
  )
}

const DeviceNode = memo(DeviceNodeInner, (prev, next) => prev.selected === next.selected && prev.data === next.data)

export default DeviceNode
