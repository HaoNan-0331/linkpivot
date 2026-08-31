import { useCallback, useEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import { useAppFrameStore } from '@/stores/appFrameStore'
import { clampDetailsWidth } from '@/utils/appFrame'

/**
 * useDetailsResizer —— AppFrame details 栏拖拽把手手势 hook（Phase 35 / UI-07 / D-03）。
 *
 * 双手势契约（D-03）：同一命中条上 pointerup 时以「按压期间是否越过 4px 移动阈值」判定——
 * 未越阈 = 单击 → store.toggle()（展开/收起一次到位）；越阈 = 拖拽 → 连续调宽。
 *
 * 实现要点（35-RESEARCH Pattern 2 + Pitfall 2/3/5）：
 * - setPointerCapture：指针出条/出窗仍持续收事件（A4）；
 * - up/cancel 身份校验（35-REVIEW CR-01）：pointerdown 记录发起 pointerId，
 *   up 额外校验主键——右键/中键释放、外部手势终点落在把手上、拖拽中第二键
 *   释放一律忽略，不误触发 toggle/commit；
 * - rAF 合帧（Pitfall 3）：pointermove 只写 pendingWidthRef，requestAnimationFrame
 *   单飞提交 setDragWidth——1000Hz 鼠标下避免每秒千次 store 写；
 * - 拖拽激活时 document.body.style.userSelect = 'none' 防蓝选（Pitfall 5），
 *   pointerup/cancel 恢复；
 * - 宽度绝对换算（frame 右缘到指针距离）——从折叠态直接拖开天然成立；
 * - 窗口 resize 重 clamp（Pitfall 4，effect 带 cleanup 免疫 StrictMode 双跑，Pitfall 9）。
 *
 * ⚠ 红线（Pitfall 2）：把手组件不挂 onClick——pointerup 已接管单击判定，
 * click 会在拖拽结束后补触发造成误 toggle。
 */

/** 拖拽判定阈值（px，A2 假设：Windows SM_CXDRAG 量级，体验参数真机一验即知） */
const DRAG_THRESHOLD = 4

/** 手势 ref 态（非渲染态——不触发重渲染，pointerup 判定用） */
interface GestureState {
  dragging: boolean
  startX: number
  /** 发起手势的 pointerId（null = 无活跃手势）——up/cancel 身份校验用（35-REVIEW CR-01） */
  pointerId: number | null
}

export interface UseDetailsResizerReturn {
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void
  /** 拖拽中标记（store 单一来源，驱动把手与 details 的 [data-dragging] 伪态） */
  dragging: boolean
}

export function useDetailsResizer(): UseDetailsResizerReturn {
  // 渲染态：仅 dragging 经 store 订阅（单字段 selector，Pattern 3）
  const dragging = useAppFrameStore((s) => s.dragging)

  const gestureRef = useRef<GestureState>({ dragging: false, startX: 0, pointerId: null })
  // rAF 合帧件（Pitfall 3）：pending 宽度 + 在飞帧 id
  const pendingWidthRef = useRef<number | null>(null)
  const rafIdRef = useRef<number | null>(null)

  const scheduleFrame = useCallback((): void => {
    if (rafIdRef.current !== null) return // 单飞：已有在飞帧不重复申请
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      if (pendingWidthRef.current !== null) {
        useAppFrameStore.getState().setDragWidth(pendingWidthRef.current)
        pendingWidthRef.current = null
      }
    })
  }, [])

  /** 冲刷待提交帧：pointerup/cancel 前先落地最后宽度（Pitfall 3） */
  const flushFrame = useCallback((): void => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    if (pendingWidthRef.current !== null) {
      useAppFrameStore.getState().setDragWidth(pendingWidthRef.current)
      pendingWidthRef.current = null
    }
  }, [])

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return // 仅主键
    // 指针出条/出窗仍收事件（A4）
    e.currentTarget.setPointerCapture(e.pointerId)
    // 记录发起指针：up/cancel 身份校验依据（CR-01）
    gestureRef.current = { dragging: false, startX: e.clientX, pointerId: e.pointerId }
  }, [])

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const g = gestureRef.current
    if (!g.dragging && Math.abs(e.clientX - g.startX) <= DRAG_THRESHOLD) return // 未越阈
    if (!g.dragging) {
      g.dragging = true
      useAppFrameStore.getState().setDragging(true)
      // Pitfall 5：拖拽跨越 center 内容时防文本/节点标签蓝选，pointerup/cancel 恢复
      document.body.style.userSelect = 'none'
    }
    // 宽度绝对换算：frame 右缘到指针距离（非增量——折叠态直接拖开天然成立）。
    // frame 经 closest 取 .nt-appframe；未接线期（35-01 骨架无 MainLayout 消费者）
    // closest 落空回退 window.innerWidth 防御
    const frameEl = e.currentTarget.closest('.nt-appframe')
    if (frameEl) {
      const rect = frameEl.getBoundingClientRect()
      pendingWidthRef.current = clampDetailsWidth(rect.right - e.clientX, rect.width)
    } else {
      pendingWidthRef.current = clampDetailsWidth(
        window.innerWidth - e.clientX,
        window.innerWidth,
      )
    }
    scheduleFrame()
  }, [scheduleFrame])

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    // CR-01 身份校验：仅本手势的主键释放可结帐——右键/中键单击把手（onPointerDown 早退
    // 但其 pointerup 仍会送达）、外部起始终点落在把手上的手势（无对应 pointerdown）、
    // 拖拽途中第二键释放，一律直接忽略，不 toggle / 不 commit / 不重置
    const g = gestureRef.current
    if (g.pointerId !== e.pointerId || e.button !== 0) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    flushFrame()
    if (!g.dragging) {
      // 单击 = 展开/收起一次到位（D-03）
      useAppFrameStore.getState().toggle()
    } else {
      // 拖拽结束写盘（D-07 离散时刻）
      useAppFrameStore.getState().commitWidth()
    }
    document.body.style.userSelect = ''
    useAppFrameStore.getState().setDragging(false)
    gestureRef.current = { dragging: false, startX: 0, pointerId: null }
  }, [flushFrame])

  const onPointerCancel = useCallback((e: PointerEvent<HTMLDivElement>): void => {
    // 手势被系统打断：释放/冲刷/恢复/重置同 pointerup，但不 toggle 不 commit。
    // CR-01：cancel 无 button 语义，仅校验 pointerId（外部指针误触发的 cancel 不重置本手势）
    if (gestureRef.current.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    flushFrame()
    document.body.style.userSelect = ''
    useAppFrameStore.getState().setDragging(false)
    gestureRef.current = { dragging: false, startX: 0, pointerId: null }
  }, [flushFrame])

  // 卸载兜底（35-REVIEW WR-01）：拖拽中 MainLayout 被卸载（登出门控切换 Login 等）时
  // pointerup 不再送达已卸载元素——冲刷在飞帧 + 恢复全局选择样式 + 复位拖拽标记，
  // 防 body.userSelect='none' 残留到登录页（文本不可选）。各操作幂等，
  // cleanup 后可重跑，StrictMode effect 双跑安全（Pitfall 9 同理）
  useEffect(() => {
    return () => {
      flushFrame()
      document.body.style.userSelect = ''
      useAppFrameStore.getState().setDragging(false)
    }
  }, [flushFrame])

  // 窗口 resize 重 clamp（Pitfall 4 瞬态：40% 上限随窗口变化；reclamp 不写盘）。
  // cleanup 免疫 StrictMode effect 双跑（Pitfall 9）
  useEffect(() => {
    const handleResize = () => useAppFrameStore.getState().reclamp(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, dragging }
}
