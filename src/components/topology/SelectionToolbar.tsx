import { memo, useMemo } from 'react'
import { Button, Divider, Space, Tooltip } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  VerticalAlignTopOutlined,
  VerticalAlignBottomOutlined,
  ColumnWidthOutlined,
  ColumnHeightOutlined,
} from '@ant-design/icons'
import { useStore } from 'reactflow'
import type { TopologyNode, TopologyEdge } from '@/types/topology'
import type { AlignMode } from '@/utils/topologyLayout'

interface SelectionToolbarProps {
  selectedNodes: TopologyNode[]
  selectedEdges: TopologyEdge[]
  onDelete: () => void
  onEdit: () => void
  /** Phase 26 / D-12：对齐回调链（经 props 上抛到 Page，Page 调 alignNodes 后 setNodes） */
  onAlign?: (mode: AlignMode) => void
}

// Phase 26 / 26-04 round 3 P-C：切断 nodes props 下传链（官方 perf 指南「most common
// pitfall is directly accessing the nodes array in components」）——不再收 allNodes prop，
// 位置改为 RF store 细粒度订阅（与 AlignmentGuides 同模式）：selector 每帧跑但用
// 坐标级 equality 比较，位置不变则零重渲染；拖拽时工具条仍实时跟随选中节点。
// selectedNodes/selectedEdges 仅选区变化时换引用（拖拽帧稳定），memo 后跳过无关帧渲染。
function SelectionToolbarBase({
  selectedNodes,
  selectedEdges,
  onDelete,
  onEdit,
  onAlign,
}: SelectionToolbarProps) {
  const transform = useStore((s) => s.transform)

  // 相关节点 id 集：选中节点 + 选中连线两端（连线选区工具条同样居中跟随）
  const relevantIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of selectedNodes) ids.add(n.id)
    for (const e of selectedEdges) {
      ids.add(e.source)
      ids.add(e.target)
    }
    return ids
  }, [selectedNodes, selectedEdges])

  // 位置快照订阅：坐标级 equality（数组内逐点 x/y 比较），静止零渲染、拖拽跟随
  const positions = useStore(
    (s) => {
      const pts: { x: number; y: number }[] = []
      for (const n of s.nodeInternals.values()) {
        if (relevantIds.has(n.id)) pts.push(n.position)
      }
      return pts
    },
    (a, b) =>
      a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y)
  )

  const hasSelection = selectedNodes.length > 0 || selectedEdges.length > 0
  if (!hasSelection || positions.length === 0) return null

  let x = 0
  let y = 0
  for (const p of positions) {
    x += p.x
    y += p.y
  }
  const avgX = x / positions.length
  const avgY = y / positions.length - 60
  const screenX = avgX * transform[2] + transform[0]
  const screenY = avgY * transform[2] + transform[1]

  const isNodeSelected = selectedNodes.length > 0
  // Phase 26 / D-12（UI-SPEC Interaction 7）：框选 ≥2 节点对齐按钮组可用；均分需 ≥3
  const canAlign = selectedNodes.length >= 2
  const canDistribute = selectedNodes.length >= 3

  return (
    <Space
      style={{
        position: 'absolute',
        left: screenX,
        top: screenY,
        transform: 'translate(-50%, -100%)',
        zIndex: 10,
        background: '#fff',
        padding: '4px 8px',
        borderRadius: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}
    >
      {isNodeSelected && (
        <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
          编辑属性
        </Button>
      )}
      {canAlign && (
        <>
          <Tooltip title="左对齐">
            <Button size="small" icon={<AlignLeftOutlined />} onClick={() => onAlign?.('left')} />
          </Tooltip>
          <Tooltip title="右对齐">
            <Button size="small" icon={<AlignRightOutlined />} onClick={() => onAlign?.('right')} />
          </Tooltip>
          <Tooltip title="顶部对齐">
            <Button size="small" icon={<VerticalAlignTopOutlined />} onClick={() => onAlign?.('top')} />
          </Tooltip>
          <Tooltip title="底部对齐">
            <Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => onAlign?.('bottom')} />
          </Tooltip>
          <Tooltip title={canDistribute ? '水平均分' : '需要至少 3 个节点'}>
            <Button
              size="small"
              icon={<ColumnWidthOutlined />}
              disabled={!canDistribute}
              onClick={() => onAlign?.('hDistribute')}
            />
          </Tooltip>
          <Tooltip title={canDistribute ? '垂直均分' : '需要至少 3 个节点'}>
            <Button
              size="small"
              icon={<ColumnHeightOutlined />}
              disabled={!canDistribute}
              onClick={() => onAlign?.('vDistribute')}
            />
          </Tooltip>
          <Divider type="vertical" />
        </>
      )}
      <Button size="small" danger icon={<DeleteOutlined />} onClick={onDelete}>
        删除
      </Button>
    </Space>
  )
}

// P-C：memo 隔离——props 全稳定（selectedNodes/selectedEdges 仅选区变化换引用、
// 回调经 useCallback / 模块级 noop），Canvas 每帧重渲染时本组件直接跳过
const SelectionToolbar = memo(SelectionToolbarBase)
export default SelectionToolbar
