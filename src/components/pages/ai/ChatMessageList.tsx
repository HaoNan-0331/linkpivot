import { useRef, useEffect, useState } from 'react'
import { Tag, Button, Popover } from 'antd'
import { RobotOutlined, BookOutlined } from '@ant-design/icons'
import type { AgentSourceItem, AgentTierName, ChatMsg, ReferenceItem } from './types'
import type { Experience } from '@/types/experience'
import ExperienceDetailModal from '../../knowledge/ExperienceDetailModal'
import SessionMessagesModal from './SessionMessagesModal'
import ToolResultCard from './ToolResultCard'
import AssistantMarkdown from './AssistantMarkdown'
import { formatChatTime } from './formatChatTime'

interface ChatMessageListProps {
  messages: ChatMsg[]
  loading: boolean
  /** Phase 28（28-05，D-06）：agent 任务运行中常驻停止按钮（进度区，不得被消息顶走） */
  agentRunning?: boolean
  onStop?: () => void
}

// Phase 28（28-05，D-12）：分档标签中文名（agentRouter.TIER_LABELS 同款，renderer 侧副本）
const TIER_LABELS: Record<AgentTierName, string> = {
  troubleshoot: '故障排查',
  configQuery: '配置查询',
  knowledge: '知识问答',
  inspection: '巡检执行',
}

// 分档 Popover：本档预取数据源清单（静态列表，无交互纵深——UI-SPEC §Interaction 7）
const TIER_PREFETCH_LIST: Record<AgentTierName, string[]> = {
  troubleshoot: ['知识库', '经验库', '设备上下文'],
  configQuery: ['知识库', '经验库', '设备上下文'],
  knowledge: ['知识库', '经验库'],
  inspection: ['知识库', '经验库', '设备上下文'],
}

// Phase 28（28-05，D-09）：来源徽章文案（kind → 📚/📗/🔧 前缀锚点，UI-SPEC §Copywriting；N=0 不显示）
const SOURCE_BADGE_LABELS: Record<AgentSourceItem['kind'], string> = {
  kb: '📚 知识库',
  exp: '📗 经验',
  device: '🔧 设备',
  mcp: '🔧 工具',
}

const SOURCE_KIND_NAMES: Record<AgentSourceItem['kind'], string> = {
  kb: '知识库',
  exp: '经验库',
  device: '设备',
  mcp: '工具',
}

export default function ChatMessageList({ messages, loading, agentRunning, onStop }: ChatMessageListProps) {
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Phase 11 RETRIEVE-03：点击经验/会话引用打开复用 Modal（D-11-12 不新建）
  // ExperienceDetailModal 需 Experience 对象传入（仿 ExperienceDetailModal.tsx 拉 devices useEffect 模式，
  // 但改为点击触发 experience.get 拉详情）；SessionMessagesModal sessionId 直传零适配。
  const [detailExp, setDetailExp] = useState<Experience | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [sessionModalId, setSessionModalId] = useState<string | null>(null)
  const [sessionModalOpen, setSessionModalOpen] = useState(false)
  // Phase 28（28-05，D-09）：来源徽章行展开态（按消息下标，点击徽章展开明细列表）
  const [expandedSources, setExpandedSources] = useState<Set<number>>(new Set())

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 经验引用点击 → 拉详情开 Modal（信任边界：references 只含 expId 元数据，详情经 secure IPC，
  // ExperienceDetailModal 走既有 stripEncColumns 边界，renderer 永不收 _enc 列，T-11-07 mitigate）
  const openExperience = (expId: string) => {
    // WR-06 fix：null 判（经验已删/不存在不弹空 Modal）+ .catch（IPC 失败不致 unhandled rejection）
    window.api.experience.get(expId).then((e) => {
      if (!e) return
      setDetailExp(e)
      setDetailOpen(true)
    }).catch((err) => {
      console.warn('[ChatMessageList] openExperience failed', expId, err)
    })
  }

  const openSession = (sessionId: string) => {
    setSessionModalId(sessionId)
    setSessionModalOpen(true)
  }

  // 按 ref.kind 分流渲染（kb 保持既有 / experience 可点开详情 / session 可点开会话原文）
  const renderRef = (ref: ReferenceItem, ri: number) => {
    if (ref.kind === 'kb') {
      return (
        <div key={ri} style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-label-secondary)', lineHeight: 'var(--nt-font-xxs-12-line-height)' }}>
          <BookOutlined style={{ marginRight: 4, color: 'var(--nt-alias-state-business-primary)' }} />
          {ref.docTitle} — {ref.chunkTitle}
        </div>
      )
    }
    if (ref.kind === 'experience') {
      return (
        <div
          key={ri}
          style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-state-business-primary)', lineHeight: 'var(--nt-font-xxs-12-line-height)', cursor: 'pointer' }}
          title="点击查看经验详情"
          onClick={() => openExperience(ref.expId)}
        >
          📖 {ref.title}
          {ref.unsupported && (
            <Tag color="warning" style={{ marginLeft: 6, fontSize: 'var(--nt-font-xxxs-11-font-size)' }}>⚠ 命令已失支持</Tag>
          )}
        </div>
      )
    }
    // kind === 'session'
    return (
      <div
        key={ri}
        style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-state-business-primary)', lineHeight: 'var(--nt-font-xxs-12-line-height)', cursor: 'pointer' }}
        title="点击查看原始会话"
        onClick={() => openSession(ref.sessionId)}
      >
        💬 {ref.title}
      </div>
    )
  }

  // Phase 28（28-05，D-09/D-11/D-12）：agent 轨迹 meta 渲染——来源徽章行 + 明细展开 +
  // 无源灰 Tag + 补查知情记录。全部只认 payload 结构化字段（msg.agentMeta），
  // AI 正文 content 字符串无任何触发路径（T-28-05-01 红线）。
  const renderAgentMeta = (msg: ChatMsg, idx: number) => {
    const meta = msg.agentMeta
    if (!meta) return null // 历史消息无 meta（meta_enc 缺失/降级）自然跳过，零报错
    const expanded = expandedSources.has(idx)
    const badgeKinds = (Object.keys(SOURCE_BADGE_LABELS) as AgentSourceItem['kind'][])
      .map((k) => ({ kind: k, items: meta.sources.filter((s) => s.kind === k) }))
      .filter((g) => g.items.length > 0) // N=0 的类型不显示徽章（UI-SPEC）
    return (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--nt-alias-border-l2)' }}>
        {badgeKinds.map((g) => (
          <Tag
            key={g.kind}
            style={{ cursor: 'pointer', fontSize: 'var(--nt-font-xxs-12-font-size)' }}
            onClick={() =>
              setExpandedSources((prev) => {
                const next = new Set(prev)
                if (next.has(idx)) next.delete(idx)
                else next.add(idx)
                return next
              })
            }
          >
            {SOURCE_BADGE_LABELS[g.kind]} ×{g.items.length}
          </Tag>
        ))}
        {/* D-11 无源声明：零检索零执行固定灰 Tag——只由 payload 布尔驱动，正文字符串不可触发 */}
        {meta.noRealtimeData === true && <Tag style={{ fontSize: 'var(--nt-font-xxs-12-font-size)' }}>未查询实时数据</Tag>}
        {expanded && (
          <div style={{ marginTop: 4 }}>
            {badgeKinds.flatMap((g) =>
              g.items.map((s, si) => (
                <div
                  key={`${g.kind}-${si}`}
                  style={{
                    fontSize: 'var(--nt-font-xxs-12-font-size)',
                    lineHeight: 'var(--nt-font-xxs-12-line-height)',
                    color: s.kind === 'exp' && s.refId ? 'var(--nt-alias-state-business-primary)' : 'var(--nt-alias-label-secondary)',
                    cursor: s.kind === 'exp' && s.refId ? 'pointer' : 'default',
                  }}
                  title={s.kind === 'exp' && s.refId ? '点击查看经验详情' : undefined}
                  onClick={() => {
                    if (s.kind === 'exp' && s.refId) openExperience(s.refId)
                  }}
                >
                  [{SOURCE_KIND_NAMES[s.kind]}] {s.title}
                  {s.summary ? ` — ${s.summary}` : ''}
                </div>
              ))
            )}
          </div>
        )}
        {/* 28-04（AGENT-03）：补查知情记录（零命中/设备未查），结构化通道非正文改写 */}
        {meta.backfillNotes && meta.backfillNotes.length > 0 && (
          <div style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-label-tertiary)', lineHeight: 'var(--nt-font-xxs-12-line-height)', marginTop: 4 }}>
            {meta.backfillNotes.map((n, ni) => <div key={ni}>{n}</div>)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="nt-scroll-stable" style={{
      flex: 1,
      overflowY: 'auto',
      padding: '16px 0',
      background: 'var(--nt-alias-bg-base)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Phase 34（34-01，SC1）：空态真居中——flex:1 占满滚动区余高（文案逐字保留，34-UI-SPEC §九） */}
      {messages.length === 0 && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 240 }}>
          <div style={{ textAlign: 'center', color: 'var(--nt-alias-label-caption)' }}>
            <RobotOutlined style={{ fontSize: 40, marginBottom: 8 }} />
            <div>向 AI 助手提问，选择设备后可查询设备信息</div>
          </div>
        </div>
      )}
      {/* Phase 34（34-01，SC1）：正文列包装——min(748px,100cqi-64px) 居中（ai-chat.css），
          纵向 rhythm 16px 由列 gap 接管（消息包装 marginBottom 移除）；水平居中交给列公式，
          滚动区自身不加侧 padding */}
      <div className="nt-chat-column">
      {messages.map((msg, idx) => {
        // Phase 34（34-02，D-07/D-08）：时间戳三档格式化（缺场 fail-open 空串 → 不渲染）
        const timeText = formatChatTime(msg.createdAt)
        // Phase 22（22-05，D-03）：tool_result 消息渲染结构化卡片——次级块视觉，
        // 不套 AI 气泡样式（卡片与 AI 解读气泡分离，T-22-18）；Phase 34（34-03，
        // D-10）：传宿主 ChatMsg.createdAt 作 24px 单行卡行尾时间戳数据源
        if (msg.toolResult) {
          return (
            <div key={msg.id || idx} style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <ToolResultCard data={msg.toolResult} createdAt={msg.createdAt} />
            </div>
          )
        }
        // Phase 34（34-02，SC2/UI-04）：用户消息不对称气泡——右对齐列 + r22 品牌淡蓝底 +
        // 纯文本正文（不经 markdown，dsh 用户气泡为纯文本语义）+ 16/24 正文字号；
        // 头像/「我」前缀行移除（不对称形态本身区分角色）；时间戳气泡外下方常显（D-07）
        if (msg.role === 'user') {
          return (
            <div key={msg.id || idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <div style={{
                maxWidth: 'min(525px, 82%)',
                padding: '10px 16px',
                borderRadius: 22,
                background: 'var(--nt-specific-bubble)',
                color: 'var(--nt-alias-label-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 'var(--nt-font-base-16-font-size)',
                lineHeight: 'var(--nt-font-base-16-line-height)',
              }}>
                {msg.content}
              </div>
              {timeText !== '' && (
                <div style={{ alignSelf: 'flex-end', marginTop: 2, fontSize: 'var(--nt-font-xxs-12-font-size)', lineHeight: 'var(--nt-font-xxs-12-line-height)', color: 'var(--nt-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                  {timeText}
                </div>
              )}
            </div>
          )
        }
        // Phase 34（34-02，SC2/UI-04）：助手回复全宽裸 markdown（无边框/无底色/无圆角容器，
        // 33-02 的 border-l2 卡壳与灰底移除）；附属块自上而下 = 分档 Tag → hardStop 黄条 →
        // references 参考来源 → agentMeta 徽章行（今日 DOM 相对顺序在正文之后延续，交互零改）；
        // 时间戳附属块之后末尾常显（D-07）
        return (
          <div key={msg.id || idx}>
            <AssistantMarkdown content={msg.content} />
            {/* D-12 分档标签：Popover 列本档预取清单（payload tier 字段驱动，
                TIER_LABELS/TIER_PREFETCH_LIST 逻辑与文案零改；自原头像行迁至附属块区首位） */}
            {msg.agentMeta?.tier && (
              <div style={{ marginTop: 8 }}>
                <Popover
                  title={`${TIER_LABELS[msg.agentMeta.tier]}档预取数据源`}
                  content={
                    <div style={{ fontSize: 'var(--nt-font-xxs-12-font-size)' }}>
                      本档已预取：{TIER_PREFETCH_LIST[msg.agentMeta.tier].join('、')}
                    </div>
                  }
                >
                  <Tag style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', cursor: 'pointer', marginRight: 0 }}>
                    {TIER_LABELS[msg.agentMeta.tier]}
                  </Tag>
                </Popover>
              </div>
            )}
            {/* D-13/D-06 硬顶诚实收尾：用户停止系统级黄底提示条（代码层 hardStop 标志驱动，逐字逐样式保留） */}
            {msg.agentMeta?.hardStop === 'user_cancel' && (
              <div style={{ marginTop: 8 }}>
                <div
                  style={{
                    background: 'var(--nt-alias-state-warn-tertiary)',
                    border: '1px solid var(--nt-alias-state-warn-secondary)',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 'var(--nt-font-xxs-12-font-size)',
                    color: 'var(--nt-alias-state-warn-label)',
                    marginBottom: 4,
                  }}
                >
                  任务进行中被手动停止，未生成总结；已执行步骤保留在上方。
                </div>
              </div>
            )}
            {msg.references && msg.references.length > 0 && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--nt-alias-border-l2)' }}>
                <div style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', color: 'var(--nt-alias-label-tertiary)', marginBottom: 4 }}>参考来源：</div>
                {msg.references.map((ref, ri) => renderRef(ref, ri))}
              </div>
            )}
            {renderAgentMeta(msg, idx)}
            {timeText !== '' && (
              <div style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', lineHeight: 'var(--nt-font-xxs-12-line-height)', color: 'var(--nt-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                {timeText}
              </div>
            )}
          </div>
        )
      })}
      {/* Phase 34（34-02，SC2）：思考中指示改 26px 单行 shimmer 扫字（.nt-turn-status，
          ai-chat.css §2 契约；字号 14/22 wt500 沿 34-UI-SPEC §三 s-14 strong 档）。
          Phase 28（28-05，D-06）：agent 任务运行中常驻「停止」——立即中止，无二次确认
          （逻辑与挂位零改；31-04 根因④归属门控条件在 AIPage 侧，零改） */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center' }}>
          <span
            className="nt-turn-status"
            style={{
              fontSize: 'var(--nt-font-s-14-font-size)',
              lineHeight: 'var(--nt-font-s-14-line-height)',
              fontWeight: 'var(--nt-font-s-14-strong-font-weight)',
            }}
          >
            思考中…
          </span>
          {agentRunning && onStop && (
            <Button danger size="small" style={{ marginLeft: 12 }} onClick={onStop}>
              停止
            </Button>
          )}
        </div>
      )}
      <div ref={chatEndRef} />
      </div>
      {/* Phase 11 RETRIEVE-03 D-11-12：复用 Phase 10 ExperienceDetailModal + Phase 9 SessionMessagesModal */}
      <ExperienceDetailModal open={detailOpen} experience={detailExp} onClose={() => setDetailOpen(false)} />
      <SessionMessagesModal open={sessionModalOpen} sessionId={sessionModalId} onClose={() => setSessionModalOpen(false)} />
    </div>
  )
}
