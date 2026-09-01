import { create } from 'zustand'

/**
 * Phase 38 / DETAIL-01（38-01，D-01 可见性总纲）：跨层设备选中态 store——
 * TopologyPage（Routes 内）写 / DetailsPanel·AppFrameResizer（Routes 外）读。
 *
 * selectedDeviceId 语义收敛单字段：仅「拓扑画布恰好单选一台设备节点」时非 null
 * （无选中/多选 ≥2/单选连线一律 null，D-03——连线选中自然落 null 分支）；值为
 * node.data.deviceId（React Flow node.id 经 nodesRef 换算，TopologyPage 写侧保证）。
 *
 * ⚠ Pattern 3 红线：订阅者仅 DetailsPanel、AppFrameResizer、DeviceDetailPanel、
 * TopologyPage 四处——AIPage 为 mount-only getState 快照消费（consumePendingAiDevice
 * 一次性读清，不订阅）；MainLayout 与 center 子树对 deviceDetailStore 禁止订阅。
 * TopologyPage 写侧取 action 引用（写完即走），另订阅 refreshCounter 单字段（38 review
 * CR-01 编辑后画布节点定向镜像信号——离散 bump 一次重渲染，非每帧宽度态，语义不破）。
 *
 * 瞬态 store：零持久化——选中态/刷新信号均为会话内瞬态，跨会话无意义。
 */
interface DeviceDetailStore {
  /** D-01 单选收敛：恰好单选一台设备节点的 deviceId，否则 null */
  selectedDeviceId: string | null
  /** 编辑保存成功 bump +1（38-02 面板重拉 getById + 38 review CR-01 TopologyPage 画布节点镜像，两处消费） */
  refreshCounter: number
  /** AI 对话跳转中转（38-02 写 / AIPage mount 消费，本 plan 只定契约） */
  pendingAiDeviceId: string | null
  setSelectedDeviceId: (id: string | null) => void
  /** bump refreshCounter——画布侧编辑保存成功路径调用 */
  refresh: () => void
  setPendingAiDevice: (id: string | null) => void
  /** 原子读清：读当前 pendingAiDeviceId，非 null 则置 null，返回读值（AIPage mount 一次性消费） */
  consumePendingAiDevice: () => string | null
}

export const useDeviceDetailStore = create<DeviceDetailStore>((set, get) => ({
  selectedDeviceId: null,
  refreshCounter: 0,
  pendingAiDeviceId: null,
  setSelectedDeviceId: (id) => set({ selectedDeviceId: id }),
  refresh: () => set({ refreshCounter: get().refreshCounter + 1 }),
  setPendingAiDevice: (id) => set({ pendingAiDeviceId: id }),
  consumePendingAiDevice: () => {
    const pending = get().pendingAiDeviceId
    if (pending !== null) set({ pendingAiDeviceId: null })
    return pending
  },
}))
