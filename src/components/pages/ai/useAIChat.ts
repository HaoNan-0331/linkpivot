import { useState, useCallback } from 'react'
import { message } from 'antd'
import type { ChatSession } from '@/types/ai'
import type { UseAIChatReturn, DeviceOption, ChatMsg, ConfirmData } from './types'

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

  const loadSessions = useCallback(async () => {
    const list = await window.api.ai.listSessions()
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
    await window.api.ai.deleteSession(sessionId)
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

      // Check if reply is a confirm_required or kb_answer response
      try {
        const parsed = JSON.parse(reply) as ConfirmData & { type: string; content?: string; references?: ChatMsg['references'] }
        if (parsed.type === 'confirm_required') {
          setPendingConfirm(parsed)
          setLoading(false)
          return
        }
        if (parsed.type === 'kb_answer') {
          setMessages([...newMessages, { role: 'assistant', content: parsed.content || '', references: parsed.references }])
          setLoading(false)
          return
        }
      } catch {
        // Not JSON — normal reply
      }

      setMessages([...newMessages, { role: 'assistant', content: reply }])
    } catch (e: unknown) {
      const errMsg = `错误: ${e instanceof Error ? e.message : String(e)}`
      setMessages([...newMessages, { role: 'assistant', content: errMsg }])
    }
    setLoading(false)
  }, [input, loading, currentSessionId, messages, selectedDevices])

  const handleConfirm = useCallback(async (approved: boolean) => {
    if (!pendingConfirm || !currentSessionId) return
    const confirmData = pendingConfirm
    setPendingConfirm(null) // 立即关闭弹窗，防止重复点击
    setLoading(true)
    try {
      const result = await window.api.ai.confirmCommand(confirmData.execId, approved)
      setMessages((prev) => [...prev, { role: 'assistant', content: result }])
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }, [pendingConfirm, currentSessionId])

  return {
    devices,
    selectedDevices,
    sessions,
    currentSessionId,
    messages,
    input,
    loading,
    pendingConfirm,
    setSelectedDevices,
    setInput,
    loadData,
    handleNewSession,
    handleSelectSession,
    handleDeleteSession,
    handleSend,
    handleConfirm,
  }
}
