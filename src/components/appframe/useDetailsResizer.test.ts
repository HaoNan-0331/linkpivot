/**
 * Phase 35 useDetailsResizer 手势守卫直连单测（35-REVIEW CR-01 回归）。
 *
 * 项目 renderer 测试基建现状（26-02 先例 + 项目记忆）：vitest node 环境、无 jsdom、
 * 无 @testing-library——不造渲染测试。本文件以最小桩面直连断言手势回调纯逻辑：
 * - vi.stubGlobal 打桩 window / localStorage / document / rAF（appFrameStore 模块
 *   初始化即读 localStorage + window.innerWidth，须桩先于动态 import 就位）；
 * - react-dom/server renderToString 跑一次 Probe 组件捕获 useDetailsResizer()
 *   返回的回调（SSR 同步执行 hook 体，useCallback/useRef 正常生效；effect 不跑——
 *   resize 监听不在测试面）；
 * - PointerEvent 以最小假事件注入（pointerId/button/clientX/currentTarget 四字段
 *   即覆盖被测路径），rAF 桩不落帧——pending 宽度统一在 up/cancel 的 flushFrame
 *   同步冲刷，宽度断言完全确定。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { PointerEvent } from 'react'
import type { UseDetailsResizerReturn } from './useDetailsResizer'

// ---- 全局桩（须先于被测模块动态 import 就位） ----
const setItemSpy = vi.fn((): void => {})
const fakeDoc = { body: { style: { userSelect: '' } } }

vi.stubGlobal('window', { innerWidth: 1920 })
vi.stubGlobal('localStorage', { getItem: (): null => null, setItem: setItemSpy })
vi.stubGlobal('document', fakeDoc)
vi.stubGlobal('requestAnimationFrame', (): number => 99)
vi.stubGlobal('cancelAnimationFrame', (): void => {})

const { useDetailsResizer } = await import('./useDetailsResizer')
const { useAppFrameStore } = await import('@/stores/appFrameStore')

// ---- hook 回调捕获（renderToString 同步执行 hook 体一次） ----
let probe: UseDetailsResizerReturn | null = null
const Probe = (): null => {
  probe = useDetailsResizer()
  return null
}

/** 每次调用 = 一次全新组件实例（gestureRef 等隔离），返回其回调集 */
const captureHook = (): UseDetailsResizerReturn => {
  probe = null
  renderToString(createElement(Probe))
  if (probe === null) throw new Error('useDetailsResizer 回调捕获失败')
  return probe
}

// ---- 假把手元素（仅实现被触达的 capture 查询/closest 接口面） ----
const makeFakeTarget = () => {
  const capture = { id: null as number | null }
  return {
    setPointerCapture: (id: number): void => {
      capture.id = id
    },
    releasePointerCapture: (id: number): void => {
      if (capture.id === id) capture.id = null
    },
    hasPointerCapture: (id: number): boolean => capture.id === id,
    closest: (_selector: string): null => null,
  }
}

/** 最小 PointerEvent（默认主键/pointerId 1/clientX 500，按需覆盖） */
const makePointerEvent = (
  target: ReturnType<typeof makeFakeTarget>,
  overrides: { pointerId?: number; button?: number; clientX?: number } = {},
): PointerEvent<HTMLDivElement> =>
  ({
    pointerId: 1,
    button: 0,
    clientX: 500,
    currentTarget: target,
    ...overrides,
  }) as unknown as PointerEvent<HTMLDivElement>

describe('Phase 35 useDetailsResizer 手势守卫（35-REVIEW CR-01）', () => {
  beforeEach(() => {
    useAppFrameStore.setState({ width: 320, collapsed: true, dragging: false })
    fakeDoc.body.style.userSelect = ''
    setItemSpy.mockClear()
  })

  it('右键/中键 pointerup（无对应主键 pointerdown）不触发 toggle——修前右键单击把手 100% 误折叠/展开', () => {
    const h = captureHook()
    const t = makeFakeTarget()
    // 右键按下被 onPointerDown 早退（无手势），其 pointerup（button=2）仍会送达把手
    h.onPointerUp(makePointerEvent(t, { pointerId: 7, button: 2 }))
    h.onPointerUp(makePointerEvent(t, { pointerId: 7, button: 1 }))
    const s = useAppFrameStore.getState()
    expect(s.collapsed).toBe(true)
    expect(s.width).toBe(320)
    expect(s.dragging).toBe(false)
    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('外部起始的手势（pointerId 不匹配）主键释放在把手上不触发 toggle；本指针释放才 toggle 一次', () => {
    const h = captureHook()
    const t = makeFakeTarget()
    h.onPointerDown(makePointerEvent(t, { pointerId: 1, clientX: 500 }))
    // center 拖选文本/拖 React Flow 节点后松手恰好落在 8px 命中条：无对应 pointerdown
    h.onPointerUp(makePointerEvent(t, { pointerId: 5, button: 0, clientX: 500 }))
    expect(useAppFrameStore.getState().collapsed).toBe(true)
    // 本手势主键释放 → 单击 toggle（守卫不误伤正常路径）
    h.onPointerUp(makePointerEvent(t, { pointerId: 1, button: 0, clientX: 500 }))
    const s = useAppFrameStore.getState()
    expect(s.collapsed).toBe(false)
    expect(setItemSpy).toHaveBeenCalledTimes(1) // toggle 写盘恰一次
  })

  it('拖拽中第二键/他指针释放不提前结帐：dragging 与 userSelect 保持，主键 up 才 flush+commit', () => {
    const h = captureHook()
    const t = makeFakeTarget()
    h.onPointerDown(makePointerEvent(t, { pointerId: 1, clientX: 1000 }))
    h.onPointerMove(makePointerEvent(t, { pointerId: 1, clientX: 400 })) // 越阈 4px → dragging
    expect(useAppFrameStore.getState().dragging).toBe(true)
    expect(fakeDoc.body.style.userSelect).toBe('none')

    // 他指针主键释放（触屏/笔第二指）→ pointerId 守卫拦截
    h.onPointerUp(makePointerEvent(t, { pointerId: 2, button: 0, clientX: 400 }))
    // 同指针右键释放（鼠标主键拖拽中按松右键）→ button 守卫拦截
    h.onPointerUp(makePointerEvent(t, { pointerId: 1, button: 2, clientX: 400 }))
    // 修前此处已提前 commitWidth + setDragging(false)（[data-dragging] 闪烁宽度瞬跳）
    let s = useAppFrameStore.getState()
    expect(s.dragging).toBe(true)
    expect(s.width).toBe(320) // rAF 桩不落帧，伪释放未 flush 任何宽度
    expect(fakeDoc.body.style.userSelect).toBe('none')

    // 主键继续移动后正常释放 → 冲刷终值 500（1920-1420）+ commit 写盘
    h.onPointerMove(makePointerEvent(t, { pointerId: 1, clientX: 1420 }))
    h.onPointerUp(makePointerEvent(t, { pointerId: 1, button: 0, clientX: 1420 }))
    s = useAppFrameStore.getState()
    expect(s.width).toBe(500)
    expect(s.dragging).toBe(false)
    expect(s.collapsed).toBe(false) // setDragWidth 拖开语义
    expect(fakeDoc.body.style.userSelect).toBe('')
    expect(setItemSpy).toHaveBeenCalledTimes(1) // commitWidth 写盘恰一次
  })

  it('pointercancel 仅校验 pointerId：他指针 cancel 不重置本手势，本指针 cancel 冲刷但不写盘', () => {
    const h = captureHook()
    const t = makeFakeTarget()
    h.onPointerDown(makePointerEvent(t, { pointerId: 1, clientX: 500 }))
    h.onPointerMove(makePointerEvent(t, { pointerId: 1, clientX: 200 })) // 越阈，pending=768（1920-200 超上限收敛）

    h.onPointerCancel(makePointerEvent(t, { pointerId: 9, clientX: 200 }))
    let s = useAppFrameStore.getState()
    expect(s.dragging).toBe(true)
    expect(s.width).toBe(320)
    expect(fakeDoc.body.style.userSelect).toBe('none')

    h.onPointerCancel(makePointerEvent(t, { pointerId: 1, clientX: 200 }))
    s = useAppFrameStore.getState()
    expect(s.dragging).toBe(false)
    expect(s.width).toBe(768) // 在飞帧冲刷落地
    expect(s.collapsed).toBe(false)
    expect(fakeDoc.body.style.userSelect).toBe('')
    expect(setItemSpy).not.toHaveBeenCalled() // cancel 不 toggle 不 commit
  })
})
