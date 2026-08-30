import { useState } from 'react'

/**
 * DetailsPlaceholder —— details 栏占位说明（Phase 35 / UI-07，D-01 预留骨架）。
 *
 * 本期 details 栏是可拖可折叠的空容器，设备详情面板留给后续专门 phase；
 * 「折叠不卸载/状态不丢」验收用本占位内容即可验证。
 *
 * 挂载时刻活性证明（SC2 目检依据）：useState 惰性初始化记录挂载时间戳并常显——
 * 折叠再展开时间戳不变，即证子树未卸载（DetailsPanel 永不条件渲染）。
 * 样式全走内联 var(--nt-*) token，零色值字面量（audit:tokens 红线）。
 */
export default function DetailsPlaceholder() {
  // 惰性初始化：仅首挂载求值一次，后续重渲染不刷新
  const [mountedAt] = useState(() => new Date().toLocaleTimeString())

  return (
    <div
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <strong
        style={{
          font: 'var(--nt-font-s-14-strong)',
          color: 'var(--nt-alias-label-primary)',
        }}
      >
        详情栏（预留）
      </strong>
      <div style={{ font: 'var(--nt-font-xs-13)', color: 'var(--nt-alias-label-secondary)' }}>
        详情栏预留位，设备详情面板见后续 phase。
      </div>
      <div style={{ font: 'var(--nt-font-xxs-12)', color: 'var(--nt-alias-label-caption)' }}>
        拖动左侧把手调整宽度，单击把手展开或收起。
      </div>
      <div style={{ font: 'var(--nt-font-xxs-12)', color: 'var(--nt-alias-label-dimmed)' }}>
        挂载时刻：{mountedAt}（折叠再展开不变，即证子树未卸载）
      </div>
    </div>
  )
}
