import { useAppFrameStore } from '@/stores/appFrameStore'
import DetailsPlaceholder from './DetailsPlaceholder'

/**
 * DetailsPanel —— AppFrame details 栏容器（Phase 35 / UI-07，D-01 预留骨架）。
 *
 * 订阅 store 的 width/collapsed/dragging（单字段 selector，Pattern 3）：折叠 = inline
 * width 归 0 + [data-collapsed] visibility 隐藏（appframe.css），展开 = 记忆宽度。
 *
 * ⚠ SC2 红线（折叠保挂载）：子树永不条件渲染——禁止用折叠标志做 JSX 短路写法
 * （unmount 会丢子树状态，拓扑 React Flow 场景不可接受）。依据（reactflow 11.11.4
 * 实装源码验证）：内建 ResizeObserver 对容器尺寸变化只更新 store 的 width/height、
 * 不触碰 d3-zoom transform，fitView 由 init 闩锁保证仅一次——前提是 React 层
 * 不卸载子树，CSS 层只做视觉隐藏。
 *
 * 本组件与 AppFrameResizer 是宽度态仅有的两个 DOM 消费者（MainLayout 与 center
 * 子树禁止订阅，Pattern 3 拖拽隔离）。
 */
export default function DetailsPanel() {
  const width = useAppFrameStore((s) => s.width)
  const collapsed = useAppFrameStore((s) => s.collapsed)
  const dragging = useAppFrameStore((s) => s.dragging)

  return (
    <aside
      className="nt-appframe-details"
      data-collapsed={collapsed}
      data-dragging={dragging}
      style={{ width: collapsed ? 0 : width }}
    >
      <DetailsPlaceholder />
    </aside>
  )
}
