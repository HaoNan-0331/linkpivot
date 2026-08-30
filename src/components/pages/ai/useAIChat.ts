import { useState, useCallback, useRef, useEffect } from 'react'
import { message } from 'antd'
import type { ChatSession } from '@/types/ai'
import type { ConfirmDraftsResult } from '@/types/experience'
import type { UseAIChatReturn, DeviceOption, ChatMsg, ConfirmData, ToolResultMessage } from './types'
import { parseAiReply, parsedToMessages, isValidToolResultPayload, historyMessageToChatMsgs, applyStepCardToMessages, mergeStashedCards, attributeToolResultSession } from './parseAiReply'

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
  // confirmInFlight 仅控制 ApprovalPanel 按钮 loading+disabled 给用户在途反馈
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

  // ===== Phase 31（31-03，FIX-02 会话切换竞态）新增态与 ref（照上方 confirmInFlight/pendingConfirmRef 双轨先例）=====
  // D-01/D-04：在途回复归属会话双轨——ref 供事件/终态同步读最新值，state 供 D-02 他会在途回复提示条消费
  const [replySessionId, setReplySessionId] = useState<string | null>(null)
  const replySessionIdRef = useRef<string | null>(null)
  // D-04：异会话步骤卡暂存——在途回合产生的全部步骤卡载荷按归属会话全量暂存
  //（31-05 候选③：切走前已上屏与切走后到达的卡都进暂存，切回 mergeStashedCards 幂等合并）；
  // 回合存活期不删（多次往返靠幂等防重复），回复完成 finishReply 弃之
  //（以 DB 落库 + meta.steps 重建恢复为准，防两路重复）
  const stashedStepCardsRef = useRef<Map<string, ToolResultMessage[]>>(new Map())
  // D-05①：新建会话 IPC 在途双轨——同步 ref 锁根治连点双发 + state 驱动新建按钮 loading+disabled
  const [newSessionInFlight, setNewSessionInFlight] = useState(false)
  const newSessionInFlightRef = useRef(false)
  // D-03：未读会话集合（回复完成且用户已切走 → 会话列表小点，点入即清）——更新一律 new Set 引用替换
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(new Set())
  // D-01/D-05②：currentSessionId ref 镜像——此后「读最新会话 id」一律走此 ref，不信闭包快照
  // Phase 31（31-05，WR-01 硬化）：ref 赋值改为「同步先行」——handleSelectSession/
  // handleNewSession 在 setState 前直接写 ref（消灭 useEffect 镜像 126–151ms 滞后窗口）；
  // 本 useEffect 镜像保留作兜底（防未来新增 setCurrentSessionId 调用点漏写 ref）
  const currentSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  // Phase 22（22-05，D-03）：main→renderer `ai:toolResult` 事件订阅（22-03 下发契约，
  // 每次 MCP 工具调用完成后推送——含确认后执行分支，故必须走事件而非 chat 响应体）。
  // T-22-16 fail-closed：payload 为 unknown，逐字段校验失败整条丢弃（不降级展示、不入对话流）。
  // Phase 28（28-05，D-08 步骤卡状态机）：payload 携带 stepIndex（agent 步骤推送）时按
  // stepIndex 定位既有卡片函数式更新（running→done 单卡状态机，禁一步两卡——RESEARCH
  // Pitfall 4）；无 stepIndex（旧 MCP tool_result）保持追加兼容。
  // 28-06 R7：定位逻辑收敛为 applyStepCardToMessages 纯函数——扫描止于最近一条 user 消息
  // （本轮边界）。stepIndex 每轮 chat() 从 0 重数，跨轮同 index 是不同卡片；旧「整列表倒序
  // 找同 index」会把第二轮任务的新卡原地覆盖到第一轮旧卡上（新检索卡从不出现）。
  // Phase 31（31-03，D-01/D-04）：归属过滤——attributeToolResultSession（31-02 契约）归因
  // payload.sessionId 优先 / legacy 回退在途回复会话 / null 按当前会话渲染（保既有行为）。
  // Phase 31（31-05，FIX-02 候选③）：在途回合载荷**无条件全量入暂存**（与 live 上屏并行，
  // 不再只暂存「切走后到达」的卡——31-04 真机裁决：切走前已上屏的卡仅存内存 messages，
  // 切回被 DB history 整体替换后丢失，stash 恒 0 锤实）。切回统一 mergeStashedCards
  // 幂等合并（stepIndex 重放更新同一卡 + legacy 五键判重），多轮往返不丢不重；
  // 归属 = 当前显示会话（或 legacy 无在途回复）→ 上屏；异会话且非在途（孤儿事件）→
  // 丢弃，防孤儿暂存与 DB 恢复重复。
  useEffect(() => {
    const unsubscribe = window.api.ai.onToolResult((payload: unknown) => {
      if (!isValidToolResultPayload(payload)) return
      const owner = attributeToolResultSession(payload, replySessionIdRef.current)
      // 31-05 候选③：载荷属于在途回合（owner = 在途回复归属会话）→ 无论当前显示哪个会话，
      // 按到达顺序 append 进该会话暂存（get-or-create）——live 上屏与暂存记录并行发生
      if (replySessionIdRef.current !== null && owner === replySessionIdRef.current) {
        const stashed = stashedStepCardsRef.current.get(owner)
        if (stashed) stashed.push(payload)
        else stashedStepCardsRef.current.set(owner, [payload])
      }
      if (owner === null || owner === currentSessionIdRef.current) {
        setMessages((prev) => applyStepCardToMessages(prev, payload))
        return
      }
    })
    return unsubscribe
  }, [])

  // Phase 27 checkpoint（用户语义定案）：弹窗组件卸载（切界面/路由离开）时若仍有未决确认，
  // 自动发取消——唯一放行路径是点「确认执行」，其余一切中断（含本卸载）统一判取消。
  // handleConfirm 决策后 setPendingConfirm(null) → ref 同步为 null → 卸载不双发。
  const pendingConfirmRef = useRef<ConfirmData | null>(null)
  useEffect(() => { pendingConfirmRef.current = pendingConfirm }, [pendingConfirm])
  useEffect(() => () => {
    const p = pendingConfirmRef.current
    if (p?.execId) {
      void window.api.ai.confirmCommand(p.execId, false).catch(() => { /* main 侧批次可能已 TTL 清理 */ })
    }
  }, [])

  // Phase 31（31-03，FIX-02）：回复统一终态 helper——所有回复终态（handleSend answer/异常、
  // handleConfirm 终态、handleStop）必经此处：
  // ① 清在途回复归属（ref + state 双轨置空）；
  // ② 弃该会话暂存步骤卡（D-04：完成时刻以 DB 落库 + getSessionMessages/meta.steps 重建恢复为准，
  //   防暂存与 DB 恢复两路重复渲染）；
  // ③ 完成时用户已切走（currentSessionIdRef ≠ 归属会话）→ 会话列表未读角标（D-03）。
  // handleSend 的 confirm_required 分支【不】调——确认续跑未完，归属 ref 必须存活跨 handleConfirm。
  const finishReply = useCallback(() => {
    const sid = replySessionIdRef.current
    if (sid === null) return
    replySessionIdRef.current = null
    setReplySessionId(null)
    stashedStepCardsRef.current.delete(sid)
    if (currentSessionIdRef.current !== sid) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev)
        next.add(sid)
        return next
      })
    }
  }, [])

  const loadSessions = useCallback(async () => {    const list = await window.api.ai.listSessions()
    setSessions(list)
    // Phase 31（31-03，D-05②）：await listSessions() 期间 currentSessionId 闭包值是旧快照
    //（并发切换/新建后未刷新）——改读 ref 镜像最新值判空，防重复选中/重复建会话
    if (!currentSessionIdRef.current) {
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

  // Phase 31（31-03，D-05①）：同步 ref 锁根治「回复进行中点新建偶发建两个」——同渲染周期
  // 第二次点击（含 StrictMode 双调用）同步跳过（照 confirmInFlightRef WR-01 先例）；
  // state 双轨驱动新建按钮在途禁用视觉；try/finally 保证异常路径也双释放。
  const handleNewSession = useCallback(async () => {
    if (newSessionInFlightRef.current) return
    newSessionInFlightRef.current = true
    setNewSessionInFlight(true)
    try {
      const session = await window.api.ai.createSession('新对话')
      setSessions((prev) => [session, ...prev])
      // Phase 31（31-05，WR-01 硬化）：ref 同步先行（同 handleSelectSession 模式——
      // createSession await 期间用户可并发切换会话，ref 立即反映最新归属）
      currentSessionIdRef.current = session.id
      setCurrentSessionId(session.id)
      setMessages([])
      setPendingConfirm(null)
    } finally {
      newSessionInFlightRef.current = false
      setNewSessionInFlight(false)
    }
  }, [])

  const handleSelectSession = useCallback(async (sessionId: string) => {
    // Phase 31（31-05，WR-01 硬化）：ref 同步先行——判重与赋值合并为对 ref 的同步读写
    //（31-04 实测 useEffect 镜像滞后 126–151ms，虽本轮零内容经窗口泄漏，仍消灭比较窗口；
    // setState 随后，:61 useEffect 镜像保留兜底防未来新增 setState 点）
    if (sessionId === currentSessionIdRef.current) return
    currentSessionIdRef.current = sessionId
    setCurrentSessionId(sessionId)
    setPendingConfirm(null)
    const msgs = await window.api.ai.getSessionMessages(sessionId)
    // Phase 31（31-05，WR-01 硬化）：post-await 陈旧性守卫——getSessionMessages 返回后
    // ref ≠ 目标会话即放弃本次 setMessages（同时覆盖镜像滞后窗口、乱序 resolve、快速连点
    // 三场景——最后一次 select 胜出；其下的暂存合并与清未读随之跳过是正确行为，后续真正的
    // select 会做）
    if (currentSessionIdRef.current !== sessionId) return
    // 28-06 R2 缺陷⑥：历史恢复消费 meta（此前整体丢弃）——meta.steps 重建步骤卡消息、
    // meta.sources/tier/noRealtimeData/backfillNotes 复原 agentMeta 徽章行，与实时路径同构
    setMessages(msgs.flatMap((m) => historyMessageToChatMsgs({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      meta: m.meta,
    })))
    // Phase 31（31-05，候选③）：回复进行中切回原会话——mergeStashedCards 幂等合并暂存
    // 步骤卡（在途回合载荷全量暂存：切走前已上屏 + 切走后到达，切回完整重建不重复）；
    // **回合存活期不删暂存条目**（多次往返靠幂等防重复）——弃暂存只保留在 finishReply
    // 与 handleDeleteSession 两处；回复完成后 finishReply 已弃暂存，get 为空自然跳过
    const stashed = stashedStepCardsRef.current.get(sessionId)
    if (stashed && stashed.length > 0) {
      setMessages((prev) => mergeStashedCards(prev, stashed))
    }
    // Phase 31（31-03，D-03）：点入即清未读角标（无在场未读时保持引用不变，避免无谓重渲染）
    setUnreadSessionIds((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await window.api.ai.deleteSession(sessionId)
    } catch (e: unknown) {
      // D-09：deleteSession 18-02 已事务化（chat_history+chat_sessions 单事务），失败即整体回滚。
      // 删除失败保持原会话列表与当前选中不变（不执行 setSessions 切换）。
      message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
      return
    }
    // Phase 31（31-03，D-05③）：updater 纯化——原 updater 内嵌 handleSelectSession/
    // handleNewSession 副作用，StrictMode 双调用即双发（偶发重复建两个会话的根因之一）。
    // 决策依据移到 updater 之外：基于渲染态 sessions 算 remaining，副作用平铺在 setSessions
    // 之后（照 handleConfirm 副作用平铺先例）。
    const remaining = sessions.filter((s) => s.id !== sessionId)
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    // Phase 31（31-03）：清理被删会话的暂存步骤卡与未读角标残留
    stashedStepCardsRef.current.delete(sessionId)
    setUnreadSessionIds((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
    if (sessionId === currentSessionIdRef.current) {
      // Current session deleted, switch to first remaining or create new
      if (remaining.length > 0) {
        void handleSelectSession(remaining[0].id)
      } else {
        void handleNewSession()
      }
    }
  }, [sessions, handleSelectSession, handleNewSession])

  // loadData: 迁移自 AIPage.tsx:52，参数 hasConfig 由编排层（getConfig 后）传入
  const loadData = useCallback(async (hasConfig: boolean) => {
    try {
      const devs = await window.api.device.list()
      // Phase 23（DSL-01）：移除 SSH/Telnet 前置过滤，全设备进入 AI 上下文；
      // capabilities/ipAddress 由 main 投影下发，renderer 只消费不推导。
      setDevices(
        devs.map((d) => ({
          id: d.id,
          name: d.name,
          ipAddress: d.ipAddress,
          connectionType: d.connectionType,
          capabilities: d.capabilities
        }))
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

  // Phase 28（28-05，AGENT-05/D-06）：停止按钮——立即中止一切（main 侧 AbortController 断
  // LLM fetch + 循环中止，在途步骤卡定格「已中断」），不触发 AI 总结；系统提示条为代码注入
  // 非 AI 生成（UI-SPEC 文案）。main 侧无进行中对话时显式回误（不误伤他人窗口），静默忽略。
  const handleStop = useCallback(async () => {
    if (!loading) return
    try {
      const r = await window.api.ai.cancelChat()
      if (r && r.success === false) {
        message.error(r.error || '停止失败：当前无进行中的对话')
        return
      }
    } catch (e: unknown) {
      message.error('停止失败：' + (e instanceof Error ? e.message : String(e)))
      return
    }
    setLoading(false)
    // Phase 31（31-03，D-01）：归属守卫——已停止消息仅归属会话可见（切走时 main 侧已落库，
    // 切回经 history 恢复）；停止即回复终态，finishReply 统一清理（与 handleSend AbortError
    // catch 路径的 finishReply 幂等双保险——ref 空判直接 return）
    if (replySessionIdRef.current === currentSessionIdRef.current) {
      setMessages((prev) => [...prev, { role: 'assistant', content: '已停止——任务中断，不生成总结；已执行步骤保留在上方', createdAt: new Date().toISOString() }])
    }
    finishReply()
  }, [loading, finishReply])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || loading || !currentSessionId) return

    // Phase 31（31-03，D-01）：发送时刻锁定归属会话——post-await 一切上屏/落标题以
    // sendingSessionId 为键；replySessionIdRef 同时供 onToolResult 归因与 D-02 提示条消费
    const sendingSessionId = currentSessionId
    replySessionIdRef.current = sendingSessionId
    setReplySessionId(sendingSessionId)

    // Phase 34（34-01，D-07/D-10）：renderer 新产消息统一补 createdAt（ISO，零 main/IPC 改动）
    const userMsg: ChatMsg = { role: 'user', content: text, createdAt: new Date().toISOString() }
    const newMessages = [...messages, userMsg]
    // Phase 31（31-05，WR-01 对齐）：用户消息 append 函数式化——与 onToolResult 事件订阅
    // 的函数式更新同语义（发送同渲染周期内并发到达的步骤卡不被整体替换覆盖）；
    // chat() 入参仍用发送时刻闭包快照 newMessages（不追加在途卡，语义不变）
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const reply = await window.api.ai.chat(
        newMessages.map((m) => ({ role: m.role, content: m.content })),
        selectedDevices.length > 0 ? selectedDevices : undefined,
        sendingSessionId
      )

      // Auto title: update session title from first user message
      // Phase 31（31-03）：auto title 归属发送会话（sendingSessionId）——await 期间用户切换
      // 会话后标题不随 currentSessionId 漂移写到别的会话（裁量附带修复；messages.length === 0
      // 发送前快照判断保留）
      if (messages.length === 0) {
        const title = text.length > 20 ? text.substring(0, 20) + '...' : text
        void window.api.ai.updateSessionTitle(sendingSessionId, title)
        setSessions((prev) => prev.map((s) => s.id === sendingSessionId ? { ...s, title } : s))
      }

      // Phase 19 REN-02：AI 应答解析收敛为纯函数 parseAiReply（原 :154-200 内联段语义逐字迁移：
      // confirm_required 提前返回 / kb·exp 引用归一 + session 拆分，P14 unknown 边界校验）
      const parsed = parseAiReply(reply)
      if (parsed.kind === 'confirm') {
        // Phase 31（31-03）：跨会话也弹窗（防确认死锁：切走后弹窗仍在，确认链路不断）；
        // 不 finishReply——归属 ref 存活跨 handleConfirm；loading 终由 handleConfirm 释放
        setPendingConfirm(parsed.confirm)
        setLoading(false)
        return
      }
      // CR-01 fix（Phase 22 code-review）：post-await 一律函数式更新——await 期间
      // ai:toolResult 事件已按 prev 追加过工具结果卡片，基于发送前 newMessages snapshot
      // 的整体替换会把卡片整批丢弃（D-03 核心交付在主发送路径不可见）。与 handleConfirm 对齐。
      if (parsed.kind === 'answer' || parsed.kind === 'toolResult' || parsed.kind === 'plain') {
        // Phase 31（31-03，D-01）：归属守卫——仅归属会话仍是当前显示会话才上屏（切走则跳过：
        // DB 已落库，切回经 history 恢复，不串话）；setLoading(false) 不被守卫包裹（全局锁必释放，D-02）
        if (replySessionIdRef.current === currentSessionIdRef.current) {
          setMessages((prev) => [...prev, ...parsedToMessages(parsed)])
        }
        setLoading(false)
        finishReply()
        return
      }
    } catch (e: unknown) {
      // 28-06 缺陷②：用户停止（AbortError）不是发送失败——main 侧已兜底回文中断通知，
      // 双保险：万一 AbortError 仍逃逸到 renderer，不弹「错误: ...aborted」误导条
      const isAbort = e instanceof DOMException && e.name === 'AbortError'
        || /aborted|用户已停止/i.test(e instanceof Error ? e.message : String(e))
      // Phase 31（31-03，D-01）：同款归属守卫——错误/中断条仅归属会话可见
      if (replySessionIdRef.current === currentSessionIdRef.current) {
        if (isAbort) {
          setMessages((prev) => prev.some((m) => m.content.includes('已停止——任务中断'))
            ? prev
            : [...prev, { role: 'assistant', content: '已停止——任务中断，不生成总结；已执行步骤保留在上方', createdAt: new Date().toISOString() }])
        } else {
          const errMsg = `错误: ${e instanceof Error ? e.message : String(e)}`
          setMessages((prev) => [...prev, { role: 'assistant', content: errMsg, createdAt: new Date().toISOString() }])
        }
      }
    }
    // 全部异常/终态统一出口：全局锁无条件释放 + 回复结题（confirm 分支上方已 return，不会到此）
    setLoading(false)
    finishReply()
  }, [input, loading, currentSessionId, messages, selectedDevices, finishReply])

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
      // 22-05 人工验证 Bug 1 修复：确认档第二次工具调用时 main 侧 confirmCommand 会再返回
      // confirm_required（有界循环下一批调用）——与 handleSend 同款分支：重新弹窗 + 保持
      // loading，绝不当最终回复入列（否则第二轮无弹窗、对话卡死）。
      if (parsed.kind === 'confirm') {
        setPendingConfirm(parsed.confirm)
        confirmInFlightRef.current = false // WR-01 fix：释放同步锁供下一轮确认
        setConfirmInFlight(false) // Phase 14-02：视觉锁释放（弹窗重新打开自行接管交互）
        return // 不 setLoading(false)——保持 loading 等待下一次用户确认
      }
      // CR-01 fix：与 handleSend 共用 parsedToMessages（函数式追加语义单一来源）
      // Phase 31（31-03，D-01）：归属守卫——确认续跑结果仅归属会话可见（切走则跳过上屏，
      // DB 已落库切回经 history 恢复）
      if (replySessionIdRef.current === currentSessionIdRef.current) {
        setMessages((prev) => [...prev, ...parsedToMessages(parsed)])
      }
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    }
    confirmInFlightRef.current = false // WR-01 fix：释放同步锁（正常 + 异常路径均到此）
    setConfirmInFlight(false) // Phase 14-02：IPC 完成（含异常）释放视觉锁
    setLoading(false)
    finishReply() // Phase 31（31-03）：确认终态统一结题（上方 confirm 再弹分支已 return 不结题）
  }, [pendingConfirm, currentSessionId, finishReply])

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
    confirmInFlight, // Phase 14-02：confirm IPC 在途视觉锁（ApprovalPanel 按钮 loading+disabled）
    // Phase 31（31-03，FIX-02）：D-02 在途回复归属会话 / D-03 未读角标 / D-05① 新建在途
    replySessionId,
    unreadSessionIds,
    newSessionInFlight,
    setSelectedDevices,
    setInput,
    loadData,
    handleNewSession,
    handleSelectSession,
    handleDeleteSession,
    handleSend,
    handleConfirm,
    // Phase 28（28-05）：停止按钮链路（agent 任务运行中进度区常驻，D-06 立即中止）
    agentRunning: loading,
    handleStop,
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
