import { useState } from 'react'
import { CodeOutlined, BookOutlined, FileSearchOutlined, ToolOutlined } from '@ant-design/icons'
import type { AgentStepStatus, ToolResultMessage } from './types'
import { formatChatTime } from './formatChatTime'

/**
 * ToolResultCard —— 工具调用/命令执行 24px 单行压缩卡（Phase 22 / 22-05 建立，
 * Phase 34 / 34-03 重写为 dsh ToolRow 形态，SC3 / UI-05）。
 *
 * 数据源唯一：22-03 `ai:toolResult` 下发的 tool_result 载荷（useAIChat 经
 * isValidToolResultPayload fail-closed 校验后入列，畸形载荷根本到不了这里）。
 * 语义红线（T-22-18）：卡片只呈现参数/原始 JSON，AI 解读只出现在后续气泡，
 * 卡片与气泡视觉分离（本卡片为次级行，非 AI 气泡样式）。
 * 渲染红线（T-22-17）：React 文本转义 + 禁 dangerouslySetInnerHTML。
 *
 * 34-03 形态契约（34-UI-SPEC §6.2）：
 * - 折叠态 = 24px 单行（leading 状态槽 + 状态词 + 标题 + 单行截断摘要 + 行尾时间），
 *   radius 6 无底色无边框（D-04 失败仅文字红不红容器）；扫光仅 running/retrying
 *   （ai-chat.css .nt-tool-row[data-sweep] 消费）。
 * - 七态 + 旧 MCP 三态统一单渲染路径（D-05：无 stepStatus 时按 status 补映射，零 main 改动）。
 * - 点击整行原地内联展开 IN/OUT 双区（D-11/D-12，见下方展开区）。
 */

// sanitizeUntrusted 截断后缀形态「…[已截断至 N 字符]」（22-03 契约）
const TRUNCATED_SUFFIX_RE = /…\[已截断至 (\d+) 字符\]\s*$/

// 超时人话原因固定文案（UI-SPEC Error state，MCS-05）
const TIMEOUT_REASON = '工具服务 60 秒内未响应，已自动中断'

// Phase 34（34-03，D-04/D-05/D-06）：STEP_STATUS_META v2——七态统一视觉表
// （34-UI-SPEC §四逐行落库）。旧红描边字段随重写移除（D-04：失败/超时/熔断仅状态词
// 与摘要文字红，容器无底色无边框无红描边）；sweep 扫光仅 running/retrying
// （D-06：重试中同为过程态有扫光，2.6s ease-out infinite 由 CSS 承载）。
interface StepStatusVisualMeta {
  label: string
  wordColor: string
  leading: 'dot' | 'action'
  dotState?: 'success' | 'failed' | 'warn'
  sweep: boolean
}

const STEP_STATUS_META: Record<AgentStepStatus, StepStatusVisualMeta> = {
  running: { label: '执行中', wordColor: 'var(--nt-alias-label-secondary)', leading: 'action', sweep: true },
  retrying: { label: '重试中', wordColor: 'var(--nt-alias-state-warn-label)', leading: 'action', sweep: true },
  done: { label: '完成', wordColor: 'var(--nt-alias-label-tertiary)', leading: 'dot', dotState: 'success', sweep: false },
  failed: { label: '失败', wordColor: 'var(--nt-alias-state-error-primary)', leading: 'dot', dotState: 'failed', sweep: false },
  burned: { label: '已熔断', wordColor: 'var(--nt-alias-state-error-primary)', leading: 'dot', dotState: 'failed', sweep: false },
  cooldown: { label: '冷却中', wordColor: 'var(--nt-alias-state-warn-label)', leading: 'dot', dotState: 'warn', sweep: false },
  interrupted: { label: '已中断', wordColor: 'var(--nt-alias-state-warn-label)', leading: 'dot', dotState: 'warn', sweep: false },
}

// D-05 统一视觉解析：stepStatus 在场查 v2 表；旧 MCP payload 无 stepStatus 时按
// status 补映射（success → done 视觉「完成」/ timeout → failed 视觉「超时」/
// failed → failed 视觉「失败」）。一套渲染路径，无第二分支 Tag 渲染。
function resolveStatusVisual(data: ToolResultMessage): StepStatusVisualMeta {
  if (data.stepStatus !== undefined) return STEP_STATUS_META[data.stepStatus]
  if (data.status === 'success') return { ...STEP_STATUS_META.done, label: '完成' }
  if (data.status === 'timeout') return { ...STEP_STATUS_META.failed, label: '超时' }
  return { ...STEP_STATUS_META.failed, label: '失败' }
}

// 标题 = 短类目短语 flex:none 不截断（34-UI-SPEC §6.2 拆两层裁决）：
// [预取]/[补查] 前缀保留（28-06 决策产物）+ 类目；细节归摘要槽。
function stepTitle(data: ToolResultMessage): string {
  const prefix = data.prefetched ? '[预取] ' : data.backfilled ? '[补查] ' : ''
  switch (data.actionType) {
    case 'cmd':
      return `${prefix}${data.deviceName ? `在 ${data.deviceName} 执行命令` : '执行命令'}`
    case 'kb':
      return `${prefix}检索知识库`
    case 'exp':
      return `${prefix}检索经验库`
    case 'mcp':
      return `${prefix}调用工具 ${data.tool}`
    default:
      return data.tool
  }
}

// 摘要 = 细节首行（28-06 firstLine 提取逻辑复用）：cmd/kb/exp/mcp 均取 argsJson 首行
function firstLine(s: string): string {
  return s.split('\n')[0]
}

// leading 动作图标（running/retrying 过程态）：cmd→Code / kb→Book / exp→FileSearch /
// mcp→Tool；无 actionType（旧 MCP default）→ToolOutlined 兜底（34-UI-SPEC §6.2）
const ACTION_ICON_BY_TYPE: Record<NonNullable<ToolResultMessage['actionType']>, typeof CodeOutlined> = {
  cmd: CodeOutlined,
  kb: BookOutlined,
  exp: FileSearchOutlined,
  mcp: ToolOutlined,
}

interface ToolResultCardProps {
  data: ToolResultMessage
  /** Phase 34（34-03，D-10）：宿主 ChatMsg.createdAt——行尾时间戳数据源（零 main/IPC 改动） */
  createdAt?: string
}

export default function ToolResultCard({ data, createdAt }: ToolResultCardProps) {
  // 折叠 = 24px 单行；展开 = 调用参数 + 原始结果（点击整行/Enter/Space 切换）
  const [expanded, setExpanded] = useState(false)

  const meta = resolveStatusVisual(data)
  // 失败视觉（failed/burned/旧 failed/旧 timeout——补映射后 dotState 同为 failed）：
  // 摘要覆盖为错误首行红字（dsh errorSummary 同款，D-04 文字红）
  const failureVisual = meta.dotState === 'failed'
  const summaryText = failureVisual ? firstLine(data.errorText || data.resultJson) : firstLine(data.argsJson || '')
  const timeText = formatChatTime(createdAt)

  // 截断提示：从 main 侧 sanitizeUntrusted 截断后缀解析 N（无后缀则不提示）
  const truncatedMatch = TRUNCATED_SUFFIX_RE.exec(data.resultJson)
  const truncatedTo = truncatedMatch ? Number(truncatedMatch[1]) : null
  // 失败/超时态的原始错误（monospace 内联）：resultJson 空时回落 errorText
  const rawErrorText = data.resultJson || data.errorText || ''

  const LeadingActionIcon = (data.actionType && ACTION_ICON_BY_TYPE[data.actionType]) || ToolOutlined

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      {/* 头行（24px 单行压缩卡，整行可点）：槽序 ①leading 16px ②状态词(+6) ③标题(+6)
          ④sep 点(+8) ⑤摘要(+8) ⑥行尾时间(+8)——逐槽 marginLeft 无统一 gap（dsh ToolRow 公式）。
          高度 24 / radius 6 / flex / cursor / overflow hidden 由 .nt-tool-row CSS 承载 */}
      <div
        className="nt-tool-row"
        data-sweep={meta.sweep ? 'true' : undefined}
        onClick={() => setExpanded((v) => !v)}
        style={{
          fontSize: 'var(--nt-font-markdown-small-font-size)',
          lineHeight: 'var(--nt-font-markdown-small-line-height)',
        }}
      >
        {meta.leading === 'action' ? (
          // 过程态（running/retrying）：动作图标 16px label-tertiary，槽宽恒 16px
          <span style={{ width: 16, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <LeadingActionIcon style={{ fontSize: 16, color: 'var(--nt-alias-label-tertiary)' }} />
          </span>
        ) : (
          // 终态：16px relative 包装内 StateDot 与 hover 淡切箭头兄弟并列
          // （箭头禁嵌 dot 子节点——父级 hover 淡出会连带隐藏；基态 opacity 与行 hover
          //   淡入交由 ai-chat.css .nt-tool-preview 接管，DOM 不自带 opacity）
          <span style={{ position: 'relative', width: 16, flex: 'none' }}>
            <span className="nt-state-dot" data-state={meta.dotState} />
            <span
              className="nt-tool-preview"
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                color: 'var(--nt-alias-label-tertiary)',
              }}
            >
              →
            </span>
          </span>
        )}
        {/* 状态词（七态 + 旧三态，过程态唯一文字区分 D-06） */}
        <span style={{ flex: 'none', marginLeft: 6, color: meta.wordColor }}>{meta.label}</span>
        {/* 标题：短类目短语不截断 */}
        <span style={{ flex: 'none', marginLeft: 6, color: 'var(--nt-alias-label-secondary)' }}>{stepTitle(data)}</span>
        {/* sep 点：摘要为空时省略 */}
        {summaryText !== '' && (
          <span style={{ width: 2, height: 2, borderRadius: '50%', background: 'var(--nt-alias-label-tertiary)', flex: 'none', marginLeft: 8 }} />
        )}
        {/* 摘要：fill 单行截断；失败态覆盖为错误首行红字 */}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            marginLeft: 8,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: failureVisual ? 'var(--nt-alias-state-error-primary)' : 'var(--nt-alias-label-tertiary)',
          }}
        >
          {summaryText}
        </span>
        {/* 行尾时间：flex none 不被截断（D-09 摘要让位）；空串 fail-open 不渲染 */}
        {timeText !== '' && (
          <span
            style={{
              flex: 'none',
              marginLeft: 8,
              fontSize: 'var(--nt-font-xxs-12-font-size)',
              lineHeight: 'var(--nt-font-xxs-12-line-height)',
              color: 'var(--nt-alias-label-tertiary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {timeText}
          </span>
        )}
        {/* sr-only 状态文本（屏幕阅读器感知进行/失败态，T-34-08；扫光 aria-hidden 在 CSS 侧） */}
        <span className="nt-sr-only">{meta.label}</span>
      </div>

      {/* 展开区：调用参数 + 失败原因 + 原始结果（点击头行展开后才可见；Task 2 重写为 IN/OUT 双区） */}
      {expanded && (
        <div>
          {!data.stepStatus && <div style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)', marginTop: 6 }}>{data.server}</div>}

          {/* 调用参数：JSON 原文 monospace */}
          <div style={{ marginTop: 8 }}>
            <span style={{ color: 'var(--nt-alias-label-secondary)' }}>调用参数：</span>
            <div
              style={{
                background: 'var(--nt-alias-bg-module-platform)',
                padding: 12,
                borderRadius: 4,
                marginTop: 4,
                fontFamily: 'var(--nt-font-family-code)',
                fontSize: 'var(--nt-font-xs-13-font-size)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {data.argsJson || '（无参数）'}
            </div>
          </div>

          {/* 失败/超时态：人话原因 + 原始错误（UI-SPEC Error state 逐字文案） */}
          {data.status !== 'success' && (
            <div style={{ marginTop: 8, color: 'var(--nt-alias-state-error-primary)' }}>
              调用失败：{data.status === 'timeout' ? TIMEOUT_REASON : data.errorText || '未知原因'}
              （<span style={{ fontFamily: 'var(--nt-font-family-code)' }}>{rawErrorText}</span>）。
              对话可继续，可让 AI 重试或换用其他方式。
            </div>
          )}

          {/* 原始结果：结构化 JSON 展示 + 截断提示 */}
          <div style={{ marginTop: 8 }}>
            <span style={{ color: 'var(--nt-alias-label-secondary)' }}>原始结果：</span>
            {truncatedTo !== null && (
              <div style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)', marginTop: 2 }}>结果过长，已截断至 {truncatedTo} 字符</div>
            )}
            <div
              style={{
                background: 'var(--nt-alias-bg-module-platform)',
                padding: 12,
                borderRadius: 4,
                marginTop: 4,
                fontFamily: 'var(--nt-font-family-code)',
                fontSize: 'var(--nt-font-xs-13-font-size)',
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
