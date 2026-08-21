import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import ReactFlow, {
  Controls,
  MiniMap,
  Background,
  useStore,
  type Connection,
  type OnNodesChange,
  type OnEdgesChange,
  BackgroundVariant,
} from 'reactflow'
import type { TopologyNode, TopologyEdge, TopologyNodeData } from '@/types/topology'
import {
  snapWithAntiOverlap,
  resolvePushAside,
  SNAP_GRID,
  NODE_WIDTH,
  NODE_HEIGHT,
  type AlignMode,
  type LayoutNode,
  type Point,
} from '@/utils/topologyLayout'
import DeviceNode from './DeviceNode'
import EdgeWithInterfaces from './EdgeWithInterfaces'
import ConnectionModal from './ConnectionModal'
import SelectionToolbar from './SelectionToolbar'
import AlignmentGuides, { type GuideSegment } from './AlignmentGuides'

const nodeTypes = { deviceNode: DeviceNode }
const edgeTypes = { edgeWithInterfaces: EdgeWithInterfaces }

// Phase 26 / D-13：ViewportCenterReporter——store 消费必须在 <ReactFlow> children 内
// （StoreContext 仅向 children 提供，组件 body 层 useStore 会 throw error#001）。
// 写入父组件 ref 不触发重渲染；订阅 3 个原始值，重渲染成本可忽略。
function ViewportCenterReporter({ viewportCenterRef }: { viewportCenterRef?: { current: { x: number; y: number } } }) {
  const transform = useStore((s) => s.transform)
  const rfWidth = useStore((s) => s.width)
  const rfHeight = useStore((s) => s.height)
  useEffect(() => {
    if (!viewportCenterRef || !rfWidth || !rfHeight || !transform[2]) return
    viewportCenterRef.current = {
      x: (rfWidth / 2 - transform[0]) / transform[2],
      y: (rfHeight / 2 - transform[1]) / transform[2],
    }
  }, [transform, rfWidth, rfHeight, viewportCenterRef])
  return null
}

interface TopologyCanvasProps {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  onConnect?: (connection: Connection, sourceInterface: string, targetInterface: string) => void
  onNodeDoubleClick?: (nodeId: string, data: TopologyNodeData) => void
  onDeleteSelected?: () => void
  onEditSelectedNode?: () => void
  onSelectionChange?: (nodeIds: string[], edgeIds: string[]) => void
  snapEnabled?: boolean
  // Phase 26 / D-13：视野中心（画布坐标）ref 注出口——供新增设备最近空位落点计算
  viewportCenterRef?: { current: { x: number; y: number } }
  // Phase 26 / D-14 高频拖拽路径：读 nodesRef.current（ref-mirror 红线，无闭包 stale）
  nodesRef?: { current: TopologyNode[] }
  // Phase 26 / D-05：参考线/网格吸附命中——拖动节点落点回写（仅变更节点换引用）
  onGuideSnap?: (nodeId: string, pos: Point) => void
  // Phase 26 / D-04：推挤让位映射（被压节点 → 新位置，拖动节点永不在内）
  onPushAside?: (moves: Map<string, Point>) => void
  // Phase 26 / D-12：选区对齐（经 props 回调链上抛 Page，Page 调 alignNodes 后 setNodes）
  onAlignSelected?: (mode: AlignMode) => void
}

// Phase 26 / D-04/D-05：TopologyNode → LayoutNode 最小映射（width/height null → undefined 收敛类型分叉）
function toLayoutNode(n: TopologyNode): LayoutNode {
  return {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: n.width ?? undefined,
    height: n.height ?? undefined,
  }
}

// Phase 26 / TOPO-03：参考线段计算——吸附命中后反查对齐伙伴节点，
// 线段覆盖拖动节点与伙伴节点包围盒并集（画布坐标，AlignmentGuides 内换算屏幕坐标）
function computeGuideSegments(
  snapped: Point,
  candidate: Point,
  dragged: { width: number; height: number },
  others: LayoutNode[]
): GuideSegment[] {
  const segments: GuideSegment[] = []
  for (const o of others) {
    const ow = o.width ?? NODE_WIDTH
    const oh = o.height ?? NODE_HEIGHT
    if (snapped.x !== candidate.x) {
      const targets = [o.x, o.x + ow / 2, o.x + ow]
      const sources = [snapped.x, snapped.x + dragged.width / 2, snapped.x + dragged.width]
      const matched = targets.find((t) => sources.some((s) => Math.abs(t - s) < 0.5))
      if (matched !== undefined) {
        segments.push({
          axis: 'x',
          at: matched,
          from: Math.min(snapped.y, o.y),
          to: Math.max(snapped.y + dragged.height, o.y + oh),
        })
      }
    }
    if (snapped.y !== candidate.y) {
      const targets = [o.y, o.y + oh / 2, o.y + oh]
      const sources = [snapped.y, snapped.y + dragged.height / 2, snapped.y + dragged.height]
      const matched = targets.find((t) => sources.some((s) => Math.abs(t - s) < 0.5))
      if (matched !== undefined) {
        segments.push({
          axis: 'y',
          at: matched,
          from: Math.min(snapped.x, o.x),
          to: Math.max(snapped.x + dragged.width, o.x + ow),
        })
      }
    }
  }
  return segments
}

export default function TopologyCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeDoubleClick,
  onDeleteSelected,
  onEditSelectedNode,
  onSelectionChange,
  snapEnabled = false,
  viewportCenterRef,
  nodesRef,
  onGuideSnap,
  onPushAside,
  onAlignSelected,
}: TopologyCanvasProps) {
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedNodes, setSelectedNodes] = useState<TopologyNode[]>([])
  const [selectedEdges, setSelectedEdges] = useState<TopologyEdge[]>([])
  // Phase 26 / TOPO-03：参考线段（画布坐标）——仅拖拽按压期间非空，松手清空
  const [guides, setGuides] = useState<GuideSegment[]>([])
  const pendingConnection = useRef<Connection | null>(null)

  const handleConnect = useCallback((connection: Connection) => {
    pendingConnection.current = connection
    setModalOpen(true)
  }, [])

  const handleModalConfirm = useCallback(
    (sourceInterface: string, targetInterface: string) => {
      if (pendingConnection.current && onConnect) {
        onConnect(pendingConnection.current, sourceInterface, targetInterface)
      }
      pendingConnection.current = null
      setModalOpen(false)
    },
    [onConnect]
  )

  const handleModalCancel = useCallback(() => {
    pendingConnection.current = null
    setModalOpen(false)
  }, [])

  const handleSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: { nodes: TopologyNode[]; edges: TopologyEdge[] }) => {
      setSelectedNodes(selNodes)
      setSelectedEdges(selEdges)
      onSelectionChange?.(selNodes.map((n) => n.id), selEdges.map((e) => e.id))
    },
    [onSelectionChange]
  )

  // Phase 26 / D-04 + D-05（拖拽中，高频路径）：
  // ① 先经 snapWithAntiOverlap 判参考线对齐候选（GUIDE_THRESHOLD 6px 分支，内部已做防重叠校验）；
  // ② snapped:false（候选压第三节点/无候选）时走 resolvePushAside 推挤让位（可连锁，拖动节点永不被弹回）。
  // 全程读 nodesRef.current（ref-mirror 红线），无闭包 state 读取。
  const handleNodeDrag = useCallback(
    (_event: MouseEvent, node: TopologyNode) => {
      if (!onGuideSnap && !onPushAside) return
      const all = nodesRef?.current ?? []
      if (all.length === 0) return
      const others = all.filter((n) => n.id !== node.id).map(toLayoutNode)
      if (others.length === 0) return
      const candidate = { x: node.position.x, y: node.position.y }
      const res = snapWithAntiOverlap(candidate, node.id, others, SNAP_GRID)
      if (res.snapped) {
        if (res.pos.x !== candidate.x || res.pos.y !== candidate.y) {
          onGuideSnap?.(node.id, res.pos)
          setGuides(
            computeGuideSegments(
              res.pos,
              candidate,
              { width: node.width ?? NODE_WIDTH, height: node.height ?? NODE_HEIGHT },
              others
            )
          )
        } else {
          setGuides([])
        }
      } else {
        setGuides([])
        const draggedRect = {
          x: candidate.x,
          y: candidate.y,
          width: node.width ?? NODE_WIDTH,
          height: node.height ?? NODE_HEIGHT,
        }
        const moves = resolvePushAside(node.id, draggedRect, others)
        if (moves.size > 0) onPushAside?.(moves)
      }
    },
    [nodesRef, onGuideSnap, onPushAside]
  )

  // Phase 26 / D-11：松手落点——snapToGrid 开启时经防重叠次序处理（重叠则放弃网格吸附，保留拖拽/推挤结果）
  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, node: TopologyNode) => {
      setGuides([])
      if (!snapEnabled || !onGuideSnap) return
      const all = nodesRef?.current ?? []
      if (all.length === 0) return
      const others = all.filter((n) => n.id !== node.id).map(toLayoutNode)
      if (others.length === 0) return
      const res = snapWithAntiOverlap(
        { x: node.position.x, y: node.position.y },
        node.id,
        others,
        SNAP_GRID
      )
      if (res.snapped && (res.pos.x !== node.position.x || res.pos.y !== node.position.y)) {
        onGuideSnap(node.id, res.pos)
      }
    },
    [snapEnabled, nodesRef, onGuideSnap]
  )

  const sourceDeviceName = nodes.find((n) => n.id === pendingConnection.current?.source)?.data?.deviceName
  const targetDeviceName = nodes.find((n) => n.id === pendingConnection.current?.target)?.data?.deviceName

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeDoubleClick={(_event, node) => {
          onNodeDoubleClick?.(node.id, node.data)
        }}
        onSelectionChange={handleSelectionChange}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        snapToGrid={snapEnabled}
        snapGrid={[20, 20]}
        fitView
        defaultEdgeOptions={{
          type: 'edgeWithInterfaces',
        }}
      >
        <Controls />
        <MiniMap
          nodeStrokeColor="#888"
          nodeColor="#e6f7ff"
          nodeBorderRadius={8}
        />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <ViewportCenterReporter viewportCenterRef={viewportCenterRef} />
        <AlignmentGuides guides={guides} />
        <SelectionToolbar
          selectedNodes={selectedNodes}
          selectedEdges={selectedEdges}
          allNodes={nodes}
          onDelete={onDeleteSelected || (() => {})}
          onEdit={onEditSelectedNode || (() => {})}
          onAlign={onAlignSelected}
        />
      </ReactFlow>
      <ConnectionModal
        open={modalOpen}
        sourceDeviceName={sourceDeviceName}
        targetDeviceName={targetDeviceName}
        onConfirm={handleModalConfirm}
        onCancel={handleModalCancel}
      />
    </div>
  )
}
