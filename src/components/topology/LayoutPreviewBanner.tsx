import { Button, Space } from 'antd'

interface LayoutPreviewBannerProps {
  visible: boolean
  onSave: () => void
  onUndo: () => void
}

// Phase 26 / D-06~D-08：布局预览态提示条——画布顶部居中浮层，不弹确认（UI-SPEC Copywriting Contract 逐字）
export default function LayoutPreviewBanner({ visible, onSave, onUndo }: LayoutPreviewBannerProps) {
  if (!visible) return null
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10,
        background: '#fff',
        padding: '8px 16px',
        borderRadius: '0 0 6px 6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}
    >
      <Space size={8}>
        <span style={{ fontSize: 12, color: '#666' }}>已生成布局预览，可直接拖拽微调</span>
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
