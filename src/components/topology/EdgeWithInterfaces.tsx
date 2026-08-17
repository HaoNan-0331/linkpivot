// Phase 19 REN-03 分诊结论：本组件不加 React.memo——依赖 useStore((s) => s.nodeInternals)（:45）实时读
// 源/目标节点 position，拖拽时 nodeInternals 变但 edge props（source/target/data/style）不变。
// 若 comparator 只比 props 相等则边不重算 → 接口标签位置滞留（:60-70 每渲染重算 nearest handles 是
// 现状实时跟随行为，不可吃掉——P13 过严坑）；memo 化收益为零且过严风险实质化，故不 memo。
import { EdgeLabelRenderer, useStore, type EdgeProps } from 'reactflow'
import type { TopologyEdgeData } from '@/types/topology'

interface HandlePos {
  x: number
  y: number
}

function getHandlePositions(x: number, y: number, width: number, height: number): HandlePos[] {
  return [
    { x: x + width / 2, y: y },           // top
    { x: x + width / 2, y: y + height },   // bottom
    { x: x, y: y + height / 2 },           // left
    { x: x + width, y: y + height / 2 },   // right
  ]
}

function findNearestHandles(
  srcHandles: HandlePos[],
  tgtHandles: HandlePos[],
): { source: HandlePos; target: HandlePos } {
  let minDist = Infinity
  let best = { source: srcHandles[0], target: tgtHandles[0] }
  for (const s of srcHandles) {
    for (const t of tgtHandles) {
      const dx = s.x - t.x
      const dy = s.y - t.y
      const dist = dx * dx + dy * dy
      if (dist < minDist) {
        minDist = dist
        best = { source: s, target: t }
      }
    }
  }
  return best
}

export default function EdgeWithInterfaces({
  id,
  source,
  target,
  data,
  style,
}: EdgeProps<TopologyEdgeData>) {
  const nodeInternals = useStore((s) => s.nodeInternals)

  const sourceNode = nodeInternals.get(source)
  const targetNode = nodeInternals.get(target)

  // Fallback: use node centers if dimensions not measured yet
  const srcW = sourceNode?.width || 60
  const srcH = sourceNode?.height || 80
  const tgtW = targetNode?.width || 60
  const tgtH = targetNode?.height || 80
  const srcX = sourceNode?.position?.x ?? 0
  const srcY = sourceNode?.position?.y ?? 0
  const tgtX = targetNode?.position?.x ?? 0
  const tgtY = targetNode?.position?.y ?? 0

  const srcHandles = getHandlePositions(srcX, srcY, srcW, srcH)
  const tgtHandles = getHandlePositions(tgtX, tgtY, tgtW, tgtH)
  const nearest = findNearestHandles(srcHandles, tgtHandles)

  const sx = nearest.source.x
  const sy = nearest.source.y
  const tx = nearest.target.x
  const ty = nearest.target.y
  const labelX = (sx + tx) / 2
  const labelY = (sy + ty) / 2
  const edgePath = `M${sx},${sy} L${tx},${ty}`

  const sourceLabel = data?.sourceInterface || ''
  const targetLabel = data?.targetInterface || ''
  const hasLabel = sourceLabel || targetLabel
  const labelText = [sourceLabel, targetLabel].filter(Boolean).join(' — ')

  return (
    <>
      <path
        id={id}
        d={edgePath}
        style={style}
        className="react-flow__edge-path"
        stroke="#b1b1b7"
        strokeWidth={1.5}
        fill="none"
      />
      {hasLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 10,
              color: '#666',
              background: '#fff',
              padding: '1px 4px',
              borderRadius: 3,
              border: '1px solid #e8e8e8',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {labelText}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
