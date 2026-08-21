import { theme } from 'antd'
import { useStore } from 'reactflow'

/**
 * Phase 26 / TOPO-03（D-05 + UI-SPEC Interaction 5）：对齐参考线 guide layer。
 * 自绘渲染（不走 React Flow edge），仅拖拽按压期间由父组件传入非空 guides，
 * 松手即消失。1px 虚线，色走 antd colorPrimary token（不硬编码 hex）。
 * 坐标换算与 SelectionToolbar 同式：screen = canvas * zoom + translate。
 */
export interface GuideSegment {
  /** 'x' = 垂直参考线（x = at）；'y' = 水平参考线（y = at） */
  axis: 'x' | 'y'
  /** 参考线所在画布坐标（对齐线位置） */
  at: number
  /** 线段另一轴的画布坐标范围（两节点包围盒并集） */
  from: number
  to: number
}

interface AlignmentGuidesProps {
  guides: GuideSegment[]
}

export default function AlignmentGuides({ guides }: AlignmentGuidesProps) {
  const transform = useStore((s) => s.transform)
  const { token } = theme.useToken()

  if (guides.length === 0) return null

  return (
    <>
      {guides.map((g, i) => {
        const screenAt = g.at * transform[2] + (g.axis === 'x' ? transform[0] : transform[1])
        const screenFrom =
          (g.axis === 'x' ? g.from : g.from) * transform[2] +
          (g.axis === 'x' ? transform[1] : transform[0])
        const length = (g.to - g.from) * transform[2]
        const common = {
          position: 'absolute' as const,
          pointerEvents: 'none' as const,
          zIndex: 9,
        }
        return g.axis === 'x' ? (
          <div
            key={`gx-${i}`}
            style={{
              ...common,
              left: screenAt,
              top: screenFrom,
              height: Math.max(length, 1),
              borderLeft: `1px dashed ${token.colorPrimary}`,
            }}
          />
        ) : (
          <div
            key={`gy-${i}`}
            style={{
              ...common,
              top: screenAt,
              left: screenFrom,
              width: Math.max(length, 1),
              borderTop: `1px dashed ${token.colorPrimary}`,
            }}
          />
        )
      })}
    </>
  )
}
