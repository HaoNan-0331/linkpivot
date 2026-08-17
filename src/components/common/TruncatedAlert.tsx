/**
 * 分页信封截断提示共享组件 + 范围式 showTotal（Phase 19 REN-01，D-01~D-03）。
 *
 * - D-01 文案三要素：事实（已显示前 N 条 / 共 M 条）+ 数量 + 应对动作（guidance）
 * - D-02 Pagination showTotal 范围式「第 X-Y 条 / 共 Z 条」，四处（IP/OUI/异常三 tab + ExperienceTab 19-06）统一本单一来源
 * - D-03 常驻不可关：不设 closable/afterClose，条件渲染（非 visibility 隐藏）
 *
 * 样式族锚点：KnowledgeBasePage.tsx 降级 Alert（Alert type="warning" showIcon style={{ marginBottom: 16 }}）。
 */
import { Alert } from 'antd'
import type { ReactNode } from 'react'

export function TruncatedAlert({ truncated, shown, total, guidance }: {
  truncated: boolean
  shown: number
  total: number
  guidance: ReactNode
}) {
  if (!truncated) return null
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={`已显示前 ${shown} 条 / 共 ${total} 条`}
      description={guidance}
    />
  )
}

/** antd Pagination showTotal 兼容签名：范围式范围展示（D-02） */
export const rangeShowTotal = (total: number, range: [number, number]) =>
  `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`
