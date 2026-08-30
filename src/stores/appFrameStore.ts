import { create } from 'zustand'
import { clampDetailsWidth, parsePersistedFrame } from '../utils/appFrame'

/**
 * Phase 35 / UI-07（D-07/D-08）：AppFrame 三栏骨架宽度态 store（35-01）。
 *
 * 宽度态唯一权威源：width（details 栏像素宽）/ collapsed（D-02 默认折叠）/
 * dragging（拖拽中标记，驱动 [data-dragging] transition:none）。
 *
 * ⚠ Pattern 3 红线：宽度态消费者仅 AppFrameResizer 与 DetailsPanel 两个组件，
 * MainLayout 与 center 子树（<Routes> 下全部页面）禁止订阅——拖拽每帧的
 * 重渲染被隔离在右栏，拓扑画布/AI 对话区零重渲染。
 *
 * 未来接口（D-08）：后续页面要打开 details（如设备详情面板）直接
 * `useAppFrameStore.getState().toggle()`（或展开态判定后调用），零结构改动。
 *
 * 写盘契约（D-07 离散时刻）：localStorage 只在 toggle()/commitWidth() 两个
 * 时刻写入（persist 私有辅助）——拖拽过程零 IO，pointerup 才落盘。
 */

/** localStorage key（camelCase 语义名，ExecModeSwitch 的 execModeSmartHintShown 先例） */
const APP_FRAME_STORAGE_KEY = 'appFrameDetails'

// 读盘即 clamp（Pitfall 4：历史大屏存盘宽 vs 今小窗口，读出即收敛防爆版）
const initialFrame = parsePersistedFrame(
  localStorage.getItem(APP_FRAME_STORAGE_KEY),
  window.innerWidth,
)

interface AppFrameStore {
  /** details 栏像素宽（已 clamp；折叠态视觉宽由 inline style 归 0，此值保留记忆） */
  width: number
  collapsed: boolean
  dragging: boolean
  /** rAF 帧提交路径（拖拽调宽）；collapsed 强制 false——承载「从折叠态直接拖开」语义（D-03 拖开分支） */
  setDragWidth: (w: number) => void
  setDragging: (d: boolean) => void
  /** 单击把手展开/收起（D-03），翻转后写盘 */
  toggle: () => void
  /** pointerup 拖拽结束写盘（D-07 离散时刻） */
  commitWidth: () => void
  /** 窗口 resize 重 clamp（Pitfall 4 瞬态收敛），不写盘 */
  reclamp: (frameWidth: number) => void
}

export const useAppFrameStore = create<AppFrameStore>((set, get) => ({
  width: initialFrame.width,
  collapsed: initialFrame.collapsed,
  dragging: false,

  setDragWidth: (w) => set({ width: w, collapsed: false }),
  setDragging: (d) => set({ dragging: d }),
  toggle: () => {
    set({ collapsed: !get().collapsed })
    persist(get())
  },
  commitWidth: () => persist(get()),
  reclamp: (frameWidth) => set({ width: clampDetailsWidth(get().width, frameWidth) }),
}))

/** 私有写盘辅助：全文件唯一 setItem 调用点（仅 toggle/commitWidth 触达） */
function persist(state: { width: number; collapsed: boolean }): void {
  localStorage.setItem(
    APP_FRAME_STORAGE_KEY,
    JSON.stringify({ width: state.width, collapsed: state.collapsed }),
  )
}
