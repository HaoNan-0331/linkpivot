import { useState } from 'react'
import { Tag, Button } from 'antd'
import type { ToolResultMessage } from './types'

/**
 * ToolResultCard —— MCP 工具调用结果结构化卡片（Phase 22 / 22-05，D-03 / MCS-04）。
 *
 * 数据源唯一：22-03 `ai:toolResult` 下发的 tool_result 载荷（useAIChat 经
 * isValidToolResultPayload fail-closed 校验后入列，畸形载荷根本到不了这里）。
 * 语义红线（T-22-18）：卡片只呈现参数/原始 JSON，AI 解读只出现在后续气泡，
 * 卡片与气泡视觉分离（本卡片为次级块，非 AI 气泡样式）。
 * 渲染红线（T-22-17）：React 文本转义 + 禁 dangerouslySetInnerHTML。
 */

const COLLAPSED_MAX_HEIGHT = 160
// sanitizeUntrusted 截断后缀形态「…[已截断至 N 字符]」（22-03 契约）
const TRUNCATED_SUFFIX_RE = /…\[已截断至 (\d+) 字符\]\s*$/

// 超时人话原因固定文案（UI-SPEC Error state，MCS-05）
const TIMEOUT_REASON = '工具服务 60 秒内未响应，已自动中断'

interface ToolResultCardProps {
  data: ToolResultMessage
}

export default function ToolResultCard({ data }: ToolResultCardProps) {
  const [expanded, setExpanded] = useState(false)

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

  const resultBlock = (
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
        maxHeight: expanded ? undefined : COLLAPSED_MAX_HEIGHT,
        overflow: expanded ? 'visible' : 'hidden',
      }}
    >
      {data.resultJson || '（无返回内容）'}
    </div>
  )

  return (
    <div
      style={{
        background: '#fafafa',
        border: '1px solid #e8e8e8',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 13,
        lineHeight: 1.6,
        maxWidth: '100%',
      }}
    >
      {/* 头部：工具名 · 设备名 + 状态 Tag */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>{data.tool} · {data.deviceName}</strong>
        <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
        <span style={{ color: '#999', fontSize: 12 }}>{data.server}</span>
      </div>

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

      {/* 原始结果：结构化 JSON 展示，默认折叠 + 展开/收起 + 截断提示 */}
      <div style={{ marginTop: 8 }}>
        <span style={{ color: '#666' }}>原始结果：</span>
        {truncatedTo !== null && (
          <div style={{ color: '#999', fontSize: 12, marginTop: 2 }}>结果过长，已截断至 {truncatedTo} 字符</div>
        )}
        {resultBlock}
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开全部'}
        </Button>
      </div>
    </div>
  )
}
