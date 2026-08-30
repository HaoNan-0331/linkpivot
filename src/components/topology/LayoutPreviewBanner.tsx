import { memo } from 'react'
import { Button, Space } from 'antd'

interface LayoutPreviewBannerProps {
  visible: boolean
  onSave: () => void
  onUndo: () => void
}

// Phase 26 / D-06~D-08：布局预览态提示条——画布顶部居中浮层，不弹确认（UI-SPEC Copywriting Contract 逐字）
function LayoutPreviewBanner({ visible, onSave, onUndo }: LayoutPreviewBannerProps) {
  if (!visible) return null
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10,
        background: 'var(--nt-alias-bg-base)',
        padding: '8px 16px',
        borderRadius: '0 0 6px 6px',
        boxShadow: 'var(--nt-shadow-lv3)',
      }}
    >
      <Space size={8}>
        <span style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-label-secondary)' }}>已生成布局预览，可直接拖拽微调</span>
        <Button type="primary" size="small" onClick={onSave}>
          保存布局
        </Button>
        <Button size="small" onClick={onUndo}>
          撤销布局
        </Button>
      </Space>
    </div>
  )
}

// Phase 26 / 26-04 round 3 P-C：memo 隔离——props 全稳定（回调经 useCallback / 模块级 noop），
// 父组件拖拽每帧重渲染时本组件直接跳过
export default memo(LayoutPreviewBanner)
