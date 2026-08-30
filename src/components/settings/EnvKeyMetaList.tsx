import { Tag } from 'antd'
import type { McpEnvMetaEntryDto } from '../../types/electron'

/**
 * 29.1 UAT（29.1-06）：MCP 包环境变量键清单人话化展示（每键一行）。
 * 共享单源——McpTab 包信息卡与 McpPackageTab 导入预览（step2 环境变量键）两处复用，
 * 后续所有 MCP 包两处永同步。无 envMeta 的键回退裸键名渲染（兼容旧包/手工包）。
 */
export default function EnvKeyMetaList({ envKeys, envMeta }: {
  envKeys: string[]
  envMeta?: Record<string, McpEnvMetaEntryDto>
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
      {envKeys.map((k) => {
        const m = envMeta?.[k]
        if (m == null) {
          return <code key={k} style={{ fontFamily: 'var(--nt-font-family-code)', fontSize: 'var(--nt-font-xs-13-font-size)' }}>{k}</code>
        }
        return (
          <div
            key={k}
            style={{ fontSize: 'var(--nt-font-xs-13-font-size)', display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}
          >
            <code style={{ fontFamily: 'var(--nt-font-family-code)', fontSize: 'var(--nt-font-xs-13-font-size)' }}>{k}</code>
            <span style={{ fontWeight: 600 }}>{m.label}</span>
            {m.required === true && <Tag color="red" style={{ marginInlineEnd: 0 }}>必填</Tag>}
            {m.default != null && <Tag style={{ marginInlineEnd: 0 }}>默认 {m.default}</Tag>}
            {m.description != null && (
              <span style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-label-secondary)' }}>{m.description}</span>
            )}
            {m.example != null && (
              <span style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-label-secondary)' }}>示例：{m.example}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
