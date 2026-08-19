import { useState, useCallback, useRef, useEffect } from 'react'
import { message } from 'antd'
import type { ChatSession } from '@/types/ai'
import type { ConfirmDraftsResult } from '@/types/experience'
import type { UseAIChatReturn, DeviceOption, ChatMsg, ConfirmData } from './types'
import { parseAiReply, isValidToolResultPayload } from './parseAiReply'

/**
 * useAIChat —— AIPage page-local 会话态自定义 hook（FE-01 / D-5-1）。
 *
 * 持有原 AIPage.tsx:32-41 的 8 个会话态 + 7 个 handler（loadData/loadSessions/
 * handleNewSession/handleSelectSession/handleDeleteSession/handleSend/handleConfirm）。
 *
 * 状态策略 = 自定义 hook（非 zustand、非 prop drilling）：AI 会话态 page-local，
 * 仅 AI 子树消费，引入 aiChatStore 全局单例无收益且污染全局命名空间（D-5-1）。
 *
 * configLoading/hasConfig 属 page 守卫，留 AIPage 编排层（不在此 hook）。
 *
 * FE-02 顺带收敛（D-5-2，AIPage 由 FE-01 独占）：
 * - 原 line 60/61 `(d: any)` → Device[] 强类型，filter 去标注
 * - 原 line 101 `m.role as 'user'|'assistant'` → role 已联合类型（05-01），去 cast
 * - 原 line 160/175 `catch (e: any)` → `catch (e: unknown)` + instanceof 窄化
 */
export function useAIChat(): UseAIChatReturn {
  const [devices, setDevices] = useState<DeviceOption[]>([])
  const [selectedDevices, setSelectedDevices] = useState<string[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmData | null>(null)
  // Phase 14 Plan 02：confirm IPC 在途视觉锁（FIX-02 #1 视觉层增强）
  // 与既有 setPendingConfirm(null) 关窗锁双保险——关窗锁防重复 IPC 主防线不变，
  // confirmInFlight 仅控制 CommandConfirmModal 按钮 loading+disabled 给用户在途反馈
  const [confirmInFlight, setConfirmInFlight] = useState(false)
  // WR-01 fix（code-review）：useRef 同步锁根治连点竞态——React state（confirmInFlight）异步刷新，
  // 同渲染周期连点第二次时 confirmInFlight 仍为 false（未刷新）→ 通过守卫发起重复 IPC（main 兜底 confirmCommand
  // 取后即删 throw 误导 toast）。ref.current 同步赋值，第二次连点同步检查立即跳过。与 setPendingConfirm(null) 关窗锁三保险。
  const confirmInFlightRef = useRef(false)
  const [summarizing, setSummarizing] = useState(false)
  // Phase 9 Plan 03：人工确认弹窗状态 + 待确认角标计数（D-9-7）
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewInitialDraftIds, setReviewInitialDraftIds] = useState<string[]>([])
  const [pendingDraftCount, setPendingDraftCount] = useState(0)

  // Phase 22（22-05，D-03）：main→renderer `ai:toolResult` 事件订阅（22-03 下发契约，
  // 每次 MCP 工具调用完成后推送——含确认后执行分支，故必须走事件而非 chat 响应体）。
  // T-22-16 fail-closed：payload 为 unknown，逐字段校验失败整条丢弃（不降级展示、不入对话流）。
  useEffect(() => {
    const unsubscribe = window.api.ai.onToolResult((payload: unknown) => {
      if (!isValidToolResultPayload(payload)) return
      setMessages((prev) => [...prev, { role: 'assistant', content: '', toolResult: payload }])
    })
    return unsubscribe
  }, [])

  const loadSessions = useCallback(async () => {    const list = await window.api.ai.listSessions()
    setSessions(list)
    if (!currentSessionId) {
      if (list.length > 0) {
        // Load most recent session
        await handleSelectSession(list[0].id)
      } else {
        // No sessions exist yet, create the first one
        await handleNewSession()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId])

  const handleNewSession = useCallback(async () => {
    const session = await window.api.ai.createSession('新对话')
    setSessions((prev) => [session, ...prev])
    setCurrentSessionId(session.id)
    setMessages([])
    setPendingConfirm(null)
  }, [])

  const handleSelectSession = useCallback(async (sessionId: string) => {
    setCurrentSessionId((cur) => {
      if (sessionId === cur) return cur
      return sessionId
    })
    if (sessionId === currentSessionId) return
    setPendingConfirm(null)
    const msgs = await window.api.ai.getSessionMessages(sessionId)
    setMessages(
      msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt }))
    )
  }, [currentSessionId])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await window.api.ai.deleteSession(sessionId)
    } catch (e: unknown) {
      // D-09：deleteSession 18-02 已事务化（chat_history+chat_sessions 单事务），失败即整体回滚。
      // 删除失败保持原会话列表与当前选中不变（不执行 setSessions 切换）。
      message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
      return
    }
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId)
      if (sessionId === currentSessionId) {
        // Current session deleted, switch to first remaining or create new
        if (remaining.length > 0) {
          void handleSelectSession(remaining[0].id)
        } else {
          void handleNewSession()
        }
      }
      return remaining
    })
  }, [currentSessionId, handleSelectSession, handleNewSession])

  // loadData: 迁移自 AIPage.tsx:52，参数 hasConfig 由编排层（getConfig 后）传入
  const loadData = useCallback(async (hasConfig: boolean) => {
    try {
      const devs = await window.api.device.list()
      setDevices(
        devs
          .filter((d) => d.connectionType === 'ssh' || d.connectionType === 'telnet')
          .map((d) => ({ id: d.id, name: d.name, connectionType: d.connectionType }))
      )
      if (hasConfig) {
        await loadSessions()
        // WR-01：同步既有暂存 draft 计数（D-9-7 角标初始化）
        // 首次 mount/重进页面时 listDrafts 拉取已存在 draft，避免角标为 0 使「待确认 N 条」入口形同虚设
        try {
          const remaining = await window.api.experience.listDrafts()
          setPendingDraftCount(remaining.length)
        } catch {
          setPendingDraftCount(0)
        }
      }
    } catch {
      // ignore —— 守卫已由编排层 configLoading 兜底
    }
  }, [loadSessions])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || loading || !currentSessionId) return

    const userMsg: ChatMsg = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    try {
      const reply = await window.api.ai.chat(
        newMessages.map((m) => ({ role: m.role, content: m.content })),
        selectedDevices.length > 0 ? selectedDevices : undefined,
        currentSessionId
      )

      // Auto title: update session title from first user message
      if (messages.length === 0) {
        const title = text.length > 20 ? text.substring(0, 20) + '...' : text
        void window.api.ai.updateSessionTitle(currentSessionId, title)
        setSessions((prev) => prev.map((s) => s.id === currentSessionId ? { ...s, title } : s))
      }

      // Phase 19 REN-02：AI 应答解析收敛为纯函数 parseAiReply（原 :154-200 内联段语义逐字迁移：
      // confirm_required 提前返回 / kb·exp 引用归一 + session 拆分，P14 unknown 边界校验）
      const parsed = parseAiReply(reply)
      if (parsed.kind === 'confirm') {
        setPendingConfirm(parsed.confirm)
        setLoading(false)
        return
      }
      if (parsed.kind === 'answer') {
        setMessages([...newMessages, { role: 'assistant', content: parsed.content, references: parsed.references }])
        setLoading(false)
        return
      }

      setMessages([...newMessages, parsed.kind === 'toolResult'
        ? { role: 'assistant', content: '', toolResult: parsed.toolResult }
        : { role: 'assistant', content: parsed.content }])
    } catch (e: unknown) {
      const errMsg = `错误: ${e instanceof Error ? e.message : String(e)}`
      setMessages([...newMessages, { role: 'assistant', content: errMsg }])
    }
    setLoading(false)
  }, [input, loading, currentSessionId, messages, selectedDevices])

  const handleConfirm = useCallback(async (approved: boolean) => {
    if (!pendingConfirm || !currentSessionId) return
    // WR-01 fix：同步锁——同渲染周期连点第二次立即跳过（ref.current 同步生效，不等 React state 刷新）
    if (confirmInFlightRef.current) return
    confirmInFlightRef.current = true
    const confirmData = pendingConfirm
    setPendingConfirm(null) // 立即关闭弹窗，防止重复点击
    setLoading(true)
    setConfirmInFlight(true) // Phase 14-02：视觉锁在途（按钮 loading+disabled）
    try {
      const result = await window.api.ai.confirmCommand(confirmData.execId, approved)
      // Phase 19 REN-02：原 Phase 11 UAT fix 内联解析段（:222-238）收敛为 parseAiReply（与 handleSend 同语义）
      const parsed = parseAiReply(result)
      if (parsed.kind === 'answer') {
        setMessages((prev) => [...prev, { role: 'assistant', content: parsed.content, references: parsed.references }])
      } else {
        // 纯文本回复（无 references）——原降级路径；tool_result 变体挂卡片数据源
        setMessages((prev) => [...prev, parsed.kind === 'toolResult'
          ? { role: 'assistant', content: '', toolResult: parsed.toolResult }
          : { role: 'assistant', content: parsed.content }])
      }
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    }
    confirmInFlightRef.current = false // WR-01 fix：释放同步锁（正常 + 异常路径均到此）
    setConfirmInFlight(false) // Phase 14-02：IPC 完成（含异常）释放视觉锁
    setLoading(false)
  }, [pendingConfirm, currentSessionId])

  // Phase 8 Plan 03：经验总结（点「经验总结」按钮 → experience:summarizeSession IPC）
  // SC1：empty/demoMode 提示不强产；SC5：source_session_id 幂等可重复点击；
  // 异步 loading 防重复点击；完成弹 antd message 汇总 created/updated/noop 计数，提示「草稿待确认」（Phase 9 入口）
  const handleSummarize = useCallback(async () => {
    if (!currentSessionId || summarizing) return
    setSummarizing(true)
    try {
      const result = await window.api.experience.summarizeSession(currentSessionId)
      if (result.demoMode) {
        message.warning('未配置 AI 服务，无法总结（请先在「系统设置」配置 AI）')
      } else if (result.empty) {
        message.info('该会话无可总结经验')
      } else {
        const parts: string[] = []
        if (result.created.length > 0) parts.push(`新增 ${result.created.length} 条草稿`)
        if (result.updated.length > 0) parts.push(`更新 ${result.updated.length} 条草稿`)
        if (result.noop.length > 0) parts.push(`跳过 ${result.noop.length} 条重复`)
        // Phase 9 Plan 03：created/updated 有 draft 才开 ReviewConfirmModal，否则仅提示
        const draftIds = [...result.created, ...result.updated].map((x) => x.exp_id)
        if (draftIds.length > 0) {
          message.success(`经验总结完成：${parts.join('，')}，请逐条确认`)
          setReviewInitialDraftIds(draftIds)
          setReviewOpen(true)
        } else {
          message.success(`经验总结完成：${parts.join('，')}（无待确认草稿）`)
        }
        setPendingDraftCount(draftIds.length)
      }
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSummarizing(false)
    }
  }, [currentSessionId, summarizing])

  // Phase 9 Plan 03：弹窗提交后回调——刷新暂存 draft 计数（角标用）
  const handleReviewSubmitted = useCallback(async (_result: ConfirmDraftsResult) => {
    try {
      const remaining = await window.api.experience.listDrafts()
      setPendingDraftCount(remaining.length)
    } catch {
      setPendingDraftCount(0)
    }
  }, [])

  // Phase 9 Plan 03：角标入口点击重开弹窗（D-9-7 暂存重开，拉全量暂存 draft）
  const openReviewFromBadge = useCallback(async () => {
    setReviewInitialDraftIds([])
    setReviewOpen(true)
  }, [])

  return {
    devices,
    selectedDevices,
    sessions,
    currentSessionId,
    messages,
    input,
    loading,
    pendingConfirm,
    confirmInFlight, // Phase 14-02：confirm IPC 在途视觉锁（CommandConfirmModal 按钮 loading+disabled）
    setSelectedDevices,
    setInput,
    loadData,
    handleNewSession,
    handleSelectSession,
    handleDeleteSession,
    handleSend,
    handleConfirm,
    summarizing,
    canSummarize: messages.length > 0,
    handleSummarize,
    // Phase 9 Plan 03：人工确认弹窗 + 待确认角标（D-9-7）
    reviewOpen,
    reviewInitialDraftIds,
    pendingDraftCount,
    setReviewOpen,
    handleReviewSubmitted,
    openReviewFromBadge,
  }
}
