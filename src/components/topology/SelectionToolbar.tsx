import { useMemo } from 'react'
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
  allNodes: TopologyNode[]
  onDelete: () => void
  onEdit: () => void
  /** Phase 26 / D-12：对齐回调链（经 props 上抛到 Page，Page 调 alignNodes 后 setNodes） */
  onAlign?: (mode: AlignMode) => void
}

export default function SelectionToolbar({
  selectedNodes,
  selectedEdges,
  allNodes,
  onDelete,
  onEdit,
  onAlign,
}: SelectionToolbarProps) {
  const transform = useStore((s) => s.transform)

  const position = useMemo(() => {
    const hasSelection = selectedNodes.length > 0 || selectedEdges.length > 0
    if (!hasSelection) return null

    let x = 0
    let y = 0
    let count = 0

    // Collect positions from selected nodes
    for (const node of selectedNodes) {
      x += node.position.x
      y += node.position.y
      count++
    }

    // Collect positions from nodes connected by selected edges
    const nodeMap = new Map(allNodes.map((n) => [n.id, n]))
    for (const edge of selectedEdges) {
      const src = nodeMap.get(edge.source)
      const tgt = nodeMap.get(edge.target)
      if (src) { x += src.position.x; y += src.position.y; count++ }
      if (tgt) { x += tgt.position.x; y += tgt.position.y; count++ }
    }

    if (count === 0) return null

    const avgX = x / count
    const avgY = y / count - 60

    const screenX = avgX * transform[2] + transform[0]
    const screenY = avgY * transform[2] + transform[1]

    return { x: screenX, y: screenY }
  }, [selectedNodes, selectedEdges, allNodes, transform])

  if (!position) return null

  const isNodeSelected = selectedNodes.length > 0
  // Phase 26 / D-12（UI-SPEC Interaction 7）：框选 ≥2 节点对齐按钮组可用；均分需 ≥3
  const canAlign = selectedNodes.length >= 2
  const canDistribute = selectedNodes.length >= 3

  return (
    <Space
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
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
