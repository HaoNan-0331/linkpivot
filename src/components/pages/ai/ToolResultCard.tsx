import { useState } from 'react'
import { Tag, Spin } from 'antd'
import { DownOutlined, RightOutlined } from '@ant-design/icons'
import type { AgentStepStatus, ToolResultMessage } from './types'

/**
 * ToolResultCard —— MCP 工具调用结果结构化卡片（Phase 22 / 22-05，D-03 / MCS-04）。
 *
 * 数据源唯一：22-03 `ai:toolResult` 下发的 tool_result 载荷（useAIChat 经
 * isValidToolResultPayload fail-closed 校验后入列，畸形载荷根本到不了这里）。
 * 语义红线（T-22-18）：卡片只呈现参数/原始 JSON，AI 解读只出现在后续气泡，
 * 卡片与气泡视觉分离（本卡片为次级块，非 AI 气泡样式）。
 * 渲染红线（T-22-17）：React 文本转义 + 禁 dangerouslySetInnerHTML。
 *
 * 28-06 R5 缺陷B（UI-SPEC L30/L100）：折叠交互统一——折叠态单行（动作描述 + 状态徽标，
 * 一眼可知当前在做什么），点击头行展开调用参数 + 原始结果详情；agent 步骤卡与旧 MCP
 * tool_result 卡同形态延续；running/interrupted 等过程态同样折叠交互（动作行常驻可感知
 * 进度，详情按需展开）。
 */

// sanitizeUntrusted 截断后缀形态「…[已截断至 N 字符]」（22-03 契约）
const TRUNCATED_SUFFIX_RE = /…\[已截断至 (\d+) 字符\]\s*$/

// 超时人话原因固定文案（UI-SPEC Error state，MCS-05）
const TIMEOUT_REASON = '工具服务 60 秒内未响应，已自动中断'

// Phase 28（28-05，D-08/D-13/D-14/D-15）：agent 步骤状态徽标七值分色表（UI-SPEC §Color 穷举，
// 与 27 期确认弹窗三色域互不混淆——重试中 orange 为过程态非安全等级）。
const STEP_STATUS_META: Record<AgentStepStatus, { color: string; label: string; spin?: boolean; redBorder?: boolean }> = {
  running: { color: 'processing', label: '执行中', spin: true },
  done: { color: 'green', label: '完成' },
  failed: { color: 'red', label: '失败' },
  retrying: { color: 'orange', label: '重试中' },
  burned: { color: 'volcano', label: '已熔断（连续重复）', redBorder: true },
  cooldown: { color: 'default', label: '冷却中' },
  interrupted: { color: 'default', label: '已中断' },
}

// 步骤卡片动作描述模板（UI-SPEC Copywriting：main 生成，renderer 按 actionType 呈现）
function stepActionLabel(data: ToolResultMessage): string {
  const firstLine = (data.argsJson || '').split('\n')[0]
  switch (data.actionType) {
    case 'cmd':
      return data.deviceName ? `在 ${data.deviceName} 执行 ${firstLine}` : `执行 ${firstLine}`
    case 'kb':
      return `检索知识库${firstLine ? `：${firstLine}` : ''}`
    case 'exp':
      return `检索经验库${firstLine ? `：${firstLine}` : ''}`
    case 'mcp':
      return `调用工具 ${data.tool}`
    default:
      return `${data.tool} · ${data.deviceName}`
  }
}

interface ToolResultCardProps {
  data: ToolResultMessage
}

export default function ToolResultCard({ data }: ToolResultCardProps) {
  // 28-06 R5 缺陷B：折叠 = 一行（动作描述 + 状态）；展开 = 调用参数 + 原始结果详情
  const [expanded, setExpanded] = useState(false)

  // Phase 28（28-05）：agent 步骤卡（stepStatus 在场）——七态徽标 + 动作描述模板；
  // burned/failed 超限放弃整卡红边框（D-14）。旧 MCP payload 无 stepStatus 走原三态渲染。
  const stepMeta = data.stepStatus !== undefined ? STEP_STATUS_META[data.stepStatus] : undefined

  const statusMeta =
    data.status === 'success'
      ? { color: 'green', label: '成功' }
      : data.status === 'timeout'
        ? { color: 'red', label: '超时' }
        : { color: 'red', label: '失败' }

  // 截断提示：从 main 侧 sanitizeUntrusted 截断后缀解析 N（无后缀则不提示）
  const truncatedMatch = TRUNCATED_SUFFIX_RE.exec(data.resultJson)
  const truncatedTo = truncatedMatch ? Number(truncatedMatch[1]) : null
  // 失败/超时态的原始错误（monospace 内联）：resultJson 空时回落 errorText
  const rawErrorText = data.resultJson || data.errorText || ''

  return (
    <div
      style={{
        background: '#fafafa',
        border: stepMeta?.redBorder ? '1px solid #cf1322' : '1px solid #e8e8e8',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 13,
        lineHeight: 1.6,
        maxWidth: '100%',
      }}
    >
      {/* 头行（整行可点，折叠/展开唯一切换位）：agent 步骤卡 = 动作描述模板 + 七态徽标；
          旧 MCP 卡 = 工具名 · 设备名 + 三态 Tag。折叠态仅此一行（UI-SPEC：一行表明当前正在做什么） */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <DownOutlined style={{ fontSize: 11, color: '#999' }} /> : <RightOutlined style={{ fontSize: 11, color: '#999' }} />}
        <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {stepMeta ? stepActionLabel(data) : `${data.tool} · ${data.deviceName}`}
        </strong>
        {stepMeta ? (
          <Tag color={stepMeta.color} style={{ marginInlineEnd: 0 }}>
            {stepMeta.spin && <Spin size="small" style={{ marginRight: 4 }} />}
            {stepMeta.label}
          </Tag>
        ) : (
          <Tag color={statusMeta.color} style={{ marginInlineEnd: 0 }}>{statusMeta.label}</Tag>
        )}
      </div>

      {/* 展开区：调用参数 + 失败原因 + 原始结果（点击头行展开后才可见） */}
      {expanded && (
        <div>
          {!stepMeta && <div style={{ color: '#999', fontSize: 12, marginTop: 6 }}>{data.server}</div>}

          {/* 调用参数：JSON 原文 monospace */}
          <div style={{ marginTop: 8 }}>
            <span style={{ color: '#666' }}>调用参数：</span>
            <div
              style={{
                background: '#f5f5f5',
                padding: 12,
                borderRadius: 4,
                marginTop: 4,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                fontSize: 13,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {data.argsJson || '（无参数）'}
            </div>
          </div>

          {/* 失败/超时态：人话原因 + 原始错误（UI-SPEC Error state 逐字文案） */}
          {data.status !== 'success' && (
            <div style={{ marginTop: 8, color: '#cf1322' }}>
              调用失败：{data.status === 'timeout' ? TIMEOUT_REASON : data.errorText || '未知原因'}
              （<span style={{ fontFamily: 'Consolas, Monaco, "Courier New", monospace' }}>{rawErrorText}</span>）。
              对话可继续，可让 AI 重试或换用其他方式。
            </div>
          )}

          {/* 原始结果：结构化 JSON 展示 + 截断提示 */}
          <div style={{ marginTop: 8 }}>
            <span style={{ color: '#666' }}>原始结果：</span>
            {truncatedTo !== null && (
              <div style={{ color: '#999', fontSize: 12, marginTop: 2 }}>结果过长，已截断至 {truncatedTo} 字符</div>
            )}
            <div
              style={{
                background: '#f5f5f5',
                padding: 12,
                borderRadius: 4,
                marginTop: 4,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                fontSize: 13,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {data.resultJson || '（无返回内容）'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
