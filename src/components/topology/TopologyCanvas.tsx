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
// Phase 26 / 26-04 round 3 P-A：defaultEdgeOptions 必须模块级常量——JSX 内联对象每帧
// 新引用会触发 RF 内部 store updater 每帧 diff（官方 perf 指南点名）
const DEFAULT_EDGE_OPTIONS = { type: 'edgeWithInterfaces' } as const

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
  // Phase 26 / D-13：视野中心（画布坐标）ref 注出口——供新增设备最近空位落点计算
  viewportCenterRef?: { current: { x: number; y: number } }
  // Phase 26 / D-14 高频拖拽路径：读 nodesRef.current（ref-mirror 红线，无闭包 stale）
  nodesRef?: { current: TopologyNode[] }
  // Phase 26 / D-05：参考线吸附命中——拖动节点落点回写（仅变更节点换引用）
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

  // Phase 26 / 26-04 再工 spec ①：guides setState 仅在段内容变化时触发
  // （浅比较段数 + axis/at/from/to，防每帧 set 新数组触发无谓重渲染）
  const guidesRef = useRef<GuideSegment[]>([])
  const setGuidesIfChanged = useCallback((next: GuideSegment[]) => {
    const prev = guidesRef.current
    const same =
      prev.length === next.length &&
      prev.every(
        (s, i) =>
          s.axis === next[i].axis &&
          s.at === next[i].at &&
          s.from === next[i].from &&
          s.to === next[i].to
      )
    if (same) return
    guidesRef.current = next
    setGuides(next)
  }, [])

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

  // Phase 26 / 26-04 再工 spec ①⑤（拖拽中，高频路径——只做轻量事）：
  // 每帧仅「节点跟鼠标走（RF 内置）+ 参考线吸附判定」，不做推挤/不移动其它节点。
  // 次序规则：参考线吸附命中 > 自由落点（D-11 网格吸附已移除，checkpoint round 3
  // 用户裁决「没有太大意义」）。
  // guides setState 仅在段内容变化时触发（浅比较段数/坐标，非每帧 set 新数组）。
  // 全程读 nodesRef.current（ref-mirror 红线），无闭包 state 读取。
  const handleNodeDrag = useCallback(
    (_event: MouseEvent, node: TopologyNode) => {
      if (!onGuideSnap) return
      const all = nodesRef?.current ?? []
      if (all.length === 0) return
      const others = all.filter((n) => n.id !== node.id).map(toLayoutNode)
      if (others.length === 0) return
      const candidate = { x: node.position.x, y: node.position.y }
      const res = snapWithAntiOverlap(candidate, node.id, others)
      if (res.snapped && (res.pos.x !== candidate.x || res.pos.y !== candidate.y)) {
        onGuideSnap(node.id, res.pos)
        setGuidesIfChanged(
          computeGuideSegments(
            res.pos,
            candidate,
            { width: node.width ?? NODE_WIDTH, height: node.height ?? NODE_HEIGHT },
            others
          )
        )
      } else {
        setGuidesIfChanged([])
      }
    },
    [nodesRef, onGuideSnap]
  )

  // Phase 26 / 26-04 再工 spec ②（松手结算）：拖拽中被压设备原地不动（允许视觉重叠）；
  // 鼠标松开时若拖动节点落点与其它设备重叠 → 被 overlapping 的设备弹开到最近空位
  // （resolvePushAside 红线：拖动节点永不在 moves 内，落点不动）。150ms 平滑滑开
  // 动画由 DeviceNode CSS transition 承担（dragging=false 时生效）。
  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, node: TopologyNode) => {
      setGuidesIfChanged([])
      if (!onPushAside) return
      const all = nodesRef?.current ?? []
      const others = all.filter((n) => n.id !== node.id).map(toLayoutNode)
      if (others.length === 0) return
      const draggedRect = {
        x: node.position.x,
        y: node.position.y,
        width: node.width ?? NODE_WIDTH,
        height: node.height ?? NODE_HEIGHT,
      }
      const moves = resolvePushAside(node.id, draggedRect, others)
      if (moves.size > 0) onPushAside(moves)
    },
    [nodesRef, onPushAside, setGuidesIfChanged]
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
        fitView
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        nodeDragThreshold={1}
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
