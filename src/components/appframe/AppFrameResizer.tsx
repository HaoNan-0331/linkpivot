import { useDetailsResizer } from './useDetailsResizer'

/**
 * AppFrameResizer —— details 栏拖拽把手（Phase 35 / UI-07）。
 *
 * 形态（UI-07 字面）：8px 全高命中条（.nt-appframe-resizer，折叠态也在场——
 * 否则没法点开）与 12×32 圆角可视 pill（.nt-appframe-resizer-pill）分离——
 * pill 的 pointer-events:none 由 CSS 承载，本组件零命中语义。
 *
 * 手势逻辑全在 useDetailsResizer（D-03 双手势契约）；本文件只剩 DOM 与语义属性。
 * 键盘调宽为 stretch 目标不设验收门（RESEARCH OQ3 终裁）。
 */
export default function AppFrameResizer() {
  const { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, dragging } =
    useDetailsResizer()

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
