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
// - dragging 必含：Phase 26 / D-04 弹开动画——非拖动节点 150ms ease-out 过渡、拖动节点零 transition
function DeviceNodeInner({ data, selected, dragging }: NodeProps<TopologyNodeData>) {
  const iconSrc = iconMap[data.deviceType] || equipmentIcon

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // Phase 26 / D-04（UI-SPEC 弹开动画约定）：被推挤让位节点平滑位移，拖动节点零延迟跟指针
        transition: dragging ? 'none' : 'transform 150ms ease-out, left 150ms ease-out, top 150ms ease-out',
      }}
    >
      <Handle type="target" position={Position.Top} id="top" style={{ background: 'var(--nt-static-deepseek-500)', width: 8, height: 8 }} />
      <Handle type="target" position={Position.Bottom} id="bottom" style={{ background: 'var(--nt-static-deepseek-500)', width: 8, height: 8 }} />
      <Handle type="target" position={Position.Left} id="left" style={{ background: 'var(--nt-static-deepseek-500)', width: 8, height: 8 }} />
      <Handle type="target" position={Position.Right} id="right" style={{ background: 'var(--nt-static-deepseek-500)', width: 8, height: 8 }} />

      <div
        style={{
          position: 'absolute',
          top: -20,
          whiteSpace: 'nowrap',
          fontSize: 'var(--nt-font-xxs-12-font-size)',
          fontWeight: 600,
          color: 'var(--nt-alias-label-primary)',
          userSelect: 'none',
        }}
      >
        {data.deviceName}
      </div>

      {/* Phase 39（39-03，D-08）：未纳管角标——名称标签上方居中同族定位（absolute +
          flex 容器 alignItems center 静态位，与名称标签零重叠），仅 data.unmanaged 为
          true 时渲染（39-03 载图 device.list 比对写入）；warn 系 token，徽标为 DOM 内联
          style 位 var() 可用（非 SVG 属性位，MiniMap 陷阱不适用） */}
      {data.unmanaged && (
        <div
          style={{
            position: 'absolute',
            top: -36,
            whiteSpace: 'nowrap',
            fontSize: 'var(--nt-font-xxxs-11-font-size)',
            lineHeight: 'var(--nt-font-xxxs-11-line-height)',
            color: 'var(--nt-alias-state-warn-label)',
            border: '1px solid var(--nt-alias-state-warn-primary)',
            borderRadius: 4,
            background: 'var(--nt-alias-state-warn-tertiary)',
            padding: '0 4px',
            userSelect: 'none',
          }}
        >
          未纳管
        </div>
      )}

      <div
        style={{
          padding: 4,
          borderRadius: 8,
          // 39-03（D-08）：未选中且未纳管 → warn 系虚线边框；选中态实线优先覆盖（选中反馈
          // 优先于纳管状态）；已纳管节点非选中 transparent 零变化
          border: selected
            ? '2px solid var(--nt-static-deepseek-500)'
            : data.unmanaged
              ? '2px dashed var(--nt-alias-state-warn-primary)'
              : '2px solid transparent',
          background: selected ? 'var(--nt-static-deepseek-50)' : 'transparent',
        }}
      >
        <img src={iconSrc} alt={data.deviceType} width={50} height={50} draggable={false} />
      </div>

      <div
        style={{
          marginTop: 2,
          fontSize: 'var(--nt-font-xxxs-11-font-size)',
          color: 'var(--nt-alias-label-tertiary)',
          userSelect: 'none',
        }}
      >
        {data.ipAddress}
      </div>

      <Handle type="source" position={Position.Top} id="top" style={{ background: 'var(--nt-static-green-500)', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: 'var(--nt-static-green-500)', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Left} id="left" style={{ background: 'var(--nt-static-green-500)', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} id="right" style={{ background: 'var(--nt-static-green-500)', width: 8, height: 8 }} />
    </div>
  )
}

const DeviceNode = memo(
  DeviceNodeInner,
  (prev, next) =>
    prev.selected === next.selected && prev.data === next.data && prev.dragging === next.dragging
)

export default DeviceNode
