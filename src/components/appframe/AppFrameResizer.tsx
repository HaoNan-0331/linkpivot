import { useLocation } from 'react-router-dom'
import { useDeviceDetailStore } from '@/stores/deviceDetailStore'
import { useDetailsResizer } from './useDetailsResizer'

/**
 * AppFrameResizer —— details 栏拖拽把手（Phase 35 / UI-07）。
 *
 * 形态（UI-07 字面）：8px 全高命中条（.nt-appframe-resizer）与 12×32 圆角可视
 * pill（.nt-appframe-resizer-pill）分离——pill 的 pointer-events:none 由 CSS 承载，
 * 本组件零命中语义。
 *
 * Phase 38（38-01，D-01）把手门控：非拓扑页/无单选设备（!hasContent）时 return
 * null——右栏视觉不存在，把手随之消失。Phase 39（39-01，CR-01 39 review）总纲对称
 * 扩展：单选连线同为有内容态——连线详情下把手必须在场（DetailsPanel aside 内无任何
 * 关闭按钮，appFrameStore.toggle 仅由把手触发，把手缺席 = 连线详情态无法手动收起/
 * 调宽）。35「折叠态也在场——否则没法点开」的
 * 存在理由自 38 起变更：展开由点选设备自动驱动（SC1），把手职责收敛为
 * 「有内容时手动收起/恢复/拖宽」。把手非 DetailsPanel 子树，return null 不触
 * SC2 保挂载红线（SC2 只约束 details 子树永不条件渲染）。
 *
 * 手势逻辑全在 useDetailsResizer（D-03 双手势契约）；hook 调用保持在组件顶层
 * （return null 仅跳过渲染）。键盘调宽为 stretch 目标不设验收门（RESEARCH OQ3 终裁）。
 */
export default function AppFrameResizer() {
  const { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, dragging } =
    useDetailsResizer()
  const selectedDeviceId = useDeviceDetailStore((s) => s.selectedDeviceId)
  // 39-01 对称扩展（CR-01 39 review）：单选连线同为有内容态
  const selectedEdge = useDeviceDetailStore((s) => s.selectedEdge)
  const location = useLocation()

  // 与 DetailsPanel 相同的 D-01 总纲本地判定（跨层选中 + 路由；39 版 = 单选设备或单选连线）
  const hasContent =
    location.pathname === '/topology' && (selectedDeviceId !== null || selectedEdge !== null)
  if (!hasContent) return null

  return (
    <div
      className="nt-appframe-resizer"
      data-dragging={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label="详情栏宽度把手（单击展开或收起，拖动调整宽度）"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span className="nt-appframe-resizer-pill" />
    </div>
  )
}
