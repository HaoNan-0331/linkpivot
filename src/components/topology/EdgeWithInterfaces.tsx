// Phase 26 / 26-01（D-14 拖拽卡顿根因修复）：原实现 `useStore((s) => s.nodeInternals)` 订阅整个
// nodeInternals Map——拖拽每帧 nodeInternals 引用全量更换，所有边的订阅全部击穿 → 每帧 O(E) 全量
// 边重渲染（大拓扑拖拽卡顿根因）。改为按源/目标节点逐字段原始值订阅（number 原语，Object.is 比较）：
// 仅与被拖节点相连的边重渲染，其余边零重渲染。接口标签实时跟随行为（nearest handles 每渲染重算）不变。
import { EdgeLabelRenderer, useStore, type EdgeProps } from 'reactflow'
import { NODE_WIDTH, NODE_HEIGHT } from '@/utils/topologyLayout'
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
  // D-14：逐字段原始值订阅（width/height/position.x/y），仅相连节点的坐标变化才触发本边重渲染
  // CR-01（26 review）：兜底常量对齐 topologyLayout 模块约定（80/60），原 60/80 互换导致
  // 首帧未测量时 handle 端点按转置包围盒计算
  const srcW = useStore((s) => s.nodeInternals.get(source)?.width) || NODE_WIDTH
  const srcH = useStore((s) => s.nodeInternals.get(source)?.height) || NODE_HEIGHT
  const tgtW = useStore((s) => s.nodeInternals.get(target)?.width) || NODE_WIDTH
  const tgtH = useStore((s) => s.nodeInternals.get(target)?.height) || NODE_HEIGHT
  const srcX = useStore((s) => s.nodeInternals.get(source)?.position?.x) ?? 0
  const srcY = useStore((s) => s.nodeInternals.get(source)?.position?.y) ?? 0
  const tgtX = useStore((s) => s.nodeInternals.get(target)?.position?.x) ?? 0
  const tgtY = useStore((s) => s.nodeInternals.get(target)?.position?.y) ?? 0

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
      {/* Phase 33 / D-05（33-04 特批）：连线色迁场景层 static token，属性位 var() 写法（plan 明文形态）。
          注：reactflow 基础 CSS 已在 .react-flow__edge-path 上定义同值 stroke 且 CSS 规则恒优先于
          SVG presentation attribute——本属性位迁移前后均为兜底位，实际绘制色由 reactflow CSS 承载，
          选中态/更新态描边规则不受影响，画布零行为变化。 */}
      <path
        id={id}
        d={edgePath}
        style={style}
        className="react-flow__edge-path"
        stroke="var(--nt-static-neutral-bluish-300)"
        strokeWidth={1.5}
        fill="none"
      />
      {hasLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 'var(--nt-font-xxxs-11-font-size)',
              color: 'var(--nt-alias-label-secondary)',
              background: 'var(--nt-alias-bg-base)',
              padding: '1px 4px',
              borderRadius: 3,
              border: '1px solid var(--nt-alias-border-l2)',
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
