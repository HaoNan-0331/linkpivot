import { create } from 'zustand'
import { message } from 'antd'
import type { UpdateEventPayload, UpdateInfoBrief } from '../types/electron'

/**
 * Phase 30（30-04，D-01~D-06）：升级弹窗三态/进度/事件分发的跨组件状态。
 * UpdateModal（MainLayout 常驻）与 AboutTab（设置页第五 tab）双入口复用同一弹窗（D-08）。
 * 事件分发 applyUpdateEvent 以 modalPhase 相位转移为守卫——UpdateModal/AboutTab 双订阅同事件时
 * 首次调用同步翻转相位，第二次调用守卫落空，副作用（message.error）天然恰好一次。
 */

export type UpdateModalPhase = 'closed' | 'info' | 'progress' | 'ready'

export interface UpdateProgressSnapshot {
  percent: number
  transferred: number
  total: number
}

interface UpdateStore {
  /** 弹窗三态 + 关闭（UI-SPEC 状态机：单弹窗走完全程，D-04） */
  modalPhase: UpdateModalPhase
  updateInfo: UpdateInfoBrief | null
  progress: UpdateProgressSnapshot | null
  /** 当前应用版本（MainLayout 启动经 getVersion 拉取，弹窗版本行/AboutTab 展示共用） */
  appVersion: string
  /** MainLayout 启动一次性 getStatus 处理完毕——供 update-available 事件竞态兜底判定（W-2） */
  bootstrapReady: boolean
  openInfo: (info: UpdateInfoBrief) => void
  openProgress: () => void
  openReady: (info: UpdateInfoBrief) => void
  closeModal: () => void
  setProgress: (p: UpdateProgressSnapshot) => void
  setAppVersion: (v: string) => void
  markBootstrapDone: () => void
  /** update:event 七类事件分发（checking-for-update / update-not-available 无 renderer 副作用，忽略） */
  applyUpdateEvent: (evt: UpdateEventPayload) => void
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  modalPhase: 'closed',
  updateInfo: null,
  progress: null,
  appVersion: '',
  bootstrapReady: false,

  openInfo: (info) => set({ modalPhase: 'info', updateInfo: info }),
  openProgress: () => set({ modalPhase: 'progress' }),
  openReady: (info) => set({ modalPhase: 'ready', updateInfo: info }),
  closeModal: () => set({ modalPhase: 'closed' }),
  setProgress: (p) => set({ progress: p }),
  setAppVersion: (v) => set({ appVersion: v }),
  markBootstrapDone: () => set({ bootstrapReady: true }),

  applyUpdateEvent: (evt) => {
    switch (evt.type) {
      case 'download-progress':
        // 进度快照；modalPhase 已是 'progress' 时保持（下载事件不自行开窗）
        set({
          progress: {
            percent: evt.payload.percent,
            transferred: evt.payload.transferred,
            total: evt.payload.total,
          },
        })
        return
      case 'update-downloaded':
        set({ updateInfo: evt.payload })
        // progress 原地转 ready（D-04 单弹窗走完全程）；Bootstrap 就绪通道经 openReady 另行开窗
        if (get().modalPhase === 'progress') set({ modalPhase: 'ready', progress: null })
        return
      case 'update-cancelled':
        // 回 info 可重试态（D-06）；仅下载中弹窗受影响，不自行开窗
        if (get().modalPhase === 'progress') set({ modalPhase: 'info', progress: null })
        return
      case 'error':
        // 下载中途失败自动回 info 可重试 + 失败提示，绝不卡死 progress 态（W-1：
        // progress 态三关闭参数均 false、取消按钮对已失败下载 no-op，不回退则用户被迫重启应用）。
        // 其余态忽略——自动通道失败静默（UPD-01），手动检查失败走 checkNow 结构化返回。
        if (get().modalPhase === 'progress') {
          set({ modalPhase: 'info', progress: null })
          message.error('下载失败，请稍后重试，或到 Releases 页手动下载。')
        }
        return
      case 'update-available':
        set({ updateInfo: evt.payload })
        // 慢网络竞态兜底（W-2）：检测完成晚于启动 Bootstrap 一次性拉取时，本会话仍自动弹
        // （D-03「登录后立即弹」不因竞态丢失）。两序恰好弹一次：Bootstrap 已弹则 modalPhase
        // !== 'closed'，本分支不重弹；复核再查一次 modalPhase 防 await 期间用户已开弹窗。
        if (get().bootstrapReady && get().modalPhase === 'closed') {
          window.api.update
            .getStatus()
            .then((s) => {
              if (s.phase === 'available' && !s.suppressed && get().modalPhase === 'closed' && s.updateInfo) {
                get().openInfo(s.updateInfo)
              }
            })
            .catch(() => {
              // 自动通道失败静默（UPD-01）
            })
        }
        return
      default:
        return
    }
  },
}))
