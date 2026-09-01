import { create } from 'zustand'
import type { DeviceType } from '@/types/device'

/**
 * Phase 38 / DETAIL-01（38-01，D-01 可见性总纲）：跨层设备选中态 store——
 * TopologyPage（Routes 内）写 / DetailsPanel·AppFrameResizer（Routes 外）读。
 *
 * selectedDeviceId 语义收敛单字段：仅「拓扑画布恰好单选一台设备节点」时非 null
 * （无选中/多选 ≥2/单选连线一律 null，D-03——连线选中自然落 null 分支）；值为
 * node.data.deviceId（React Flow node.id 经 nodesRef 换算，TopologyPage 写侧保证）。
 *
 * ⚠ Pattern 3 红线：订阅者仅 DetailsPanel、AppFrameResizer、DeviceDetailPanel、
 * EdgeDetailPanel、TopologyPage 五处——AIPage 为 mount-only getState 快照消费
 * （consumePendingAiDevice 一次性读清，不订阅）；MainLayout 与 center 子树对
 * deviceDetailStore 禁止订阅。TopologyPage 写侧取 action 引用（写完即走），另订阅
 * refreshCounter 单字段（38 review CR-01 编辑后画布节点定向镜像信号——离散 bump
 * 一次重渲染，非每帧宽度态，语义不破）。
 *
 * Phase 39（39-01）语义扩展：
 * - selectedEdge 为「恰好单选一条连线」的写侧换算快照（值由 TopologyPage 经
 *   edgesRef/nodesRef 换算保证；EdgeDetailPanel 订阅该单字段）。
 * - selectedNodeMeta 与 selectedDeviceId 同步写（missing 态纳管预填与右栏删除
 *   命令的节点定位源）。
 * - canvasActions 为回调注册位（TopologyPage mount 注册/卸载置 null，消费方一律
 *   getState() 一次性取用调用、不订阅——consumePendingAiDevice 同款「读清即走」
 *   语义家族）。
 * - 设备/连线互斥语义由写侧（TopologyPage 选中同步 effect）保证，store 层不强制。
 *
 * 瞬态 store：零持久化——选中态/刷新信号均为会话内瞬态，跨会话无意义。
 */

/**
 * Phase 39（39-01，D-02/D-04）：连线选中快照——恰好单选一条连线时由写侧
 * （TopologyPage 选中同步 effect）经 edgesRef/nodesRef 换算的展示快照，右栏零查询。
 * deviceId 可空：连线两端可能是未纳管节点（data.deviceId 为 AI 标识而非资产 id），
 * 此时仅名字可显示、不可跳转（D-04 跳转门控）。
 */
export interface EdgeSelectionSnapshot {
  edgeId: string
  sourceInterface: string
  targetInterface: string
  sourceDeviceId: string | null
  sourceDeviceName: string
  targetDeviceId: string | null
  targetDeviceName: string
}

/**
 * Phase 39（39-01）：选中节点元信息快照——与 selectedDeviceId 同步写。
 * nodeId 是画布节点 id ≠ deviceId（data.deviceId）：右栏删除/纳管等跨层命令按
 * nodeId 定位画布节点（removeNodeFromCanvas/adoptNodeToDevice 消费）。
 */
export interface SelectedNodeMeta {
  nodeId: string
  deviceId: string
  deviceName: string
  deviceType: DeviceType
}

/**
 * Phase 39（39-01，接入点②跨层命令通道）：Routes 外（右栏）→ Routes 内（画布）
 * 的命令契约——TopologyPage mount 注册 useCallback 引用、卸载置 null；右栏消费方
 * 一律 getState().canvasActions 一次性取用调用（不订阅，Pattern 3 读清即走）。
 * 39-02/39-03 只消费不再改 TopologyPage 命令层。
 */
export interface TopologyCanvasActions {
  /** 接口回写（D-02）：setEdges 定向换 data，落库走既有 1s debounce 自动保存链 */
  applyEdgeInterfaces: (edgeId: string, sourceInterface: string, targetInterface: string) => void
  /** 从拓扑移除节点（D-06 轻删）：filter 节点 + 悬空边 + 清本地选中（右栏自动收起） */
  removeNodeFromCanvas: (nodeId: string) => void
  /** 删连线（D-07 轻删）：filter 边 + 清本地选中（右栏自动收起） */
  removeEdgeFromCanvas: (edgeId: string) => void
  /** 纳管回写（D-09）：按节点 id 定向换 data.deviceId + 清 unmanaged 标志（39-03 消费） */
  adoptNodeToDevice: (nodeId: string, deviceId: string) => void
  /** 跳转选中设备（D-04）：画布受控选中 + 本地选中直写 + store 直写三步幂等 */
  focusDevice: (deviceId: string) => void
}

interface DeviceDetailStore {
  /** D-01 单选收敛：恰好单选一台设备节点的 deviceId，否则 null */
  selectedDeviceId: string | null
  /** 编辑保存成功 bump +1（38-02 面板重拉 getById + 38 review CR-01 TopologyPage 画布节点镜像，两处消费） */
  refreshCounter: number
  /** AI 对话跳转中转（38-02 写 / AIPage mount 消费，本 plan 只定契约） */
  pendingAiDeviceId: string | null
  /** 39-01：恰好单选一条连线的换算快照，否则 null（写侧互斥保证） */
  selectedEdge: EdgeSelectionSnapshot | null
  /** 39-01：选中节点元信息，与 selectedDeviceId 同步写（null 同步） */
  selectedNodeMeta: SelectedNodeMeta | null
  /** 39-01：跨层命令注册位（TopologyPage mount 注册/卸载置 null，消费方 getState 一次性取用） */
  canvasActions: TopologyCanvasActions | null
  setSelectedDeviceId: (id: string | null) => void
  /** bump refreshCounter——画布侧编辑保存成功路径调用 */
  refresh: () => void
  setPendingAiDevice: (id: string | null) => void
  /** 原子读清：读当前 pendingAiDeviceId，非 null 则置 null，返回读值（AIPage mount 一次性消费） */
  consumePendingAiDevice: () => string | null
  setSelectedEdge: (edge: EdgeSelectionSnapshot | null) => void
  setSelectedNodeMeta: (meta: SelectedNodeMeta | null) => void
  setCanvasActions: (actions: TopologyCanvasActions | null) => void
}

export const useDeviceDetailStore = create<DeviceDetailStore>((set, get) => ({
  selectedDeviceId: null,
  refreshCounter: 0,
  pendingAiDeviceId: null,
  selectedEdge: null,
  selectedNodeMeta: null,
  canvasActions: null,
  setSelectedDeviceId: (id) => set({ selectedDeviceId: id }),
  refresh: () => set({ refreshCounter: get().refreshCounter + 1 }),
  setPendingAiDevice: (id) => set({ pendingAiDeviceId: id }),
  consumePendingAiDevice: () => {
    const pending = get().pendingAiDeviceId
    if (pending !== null) set({ pendingAiDeviceId: null })
    return pending
  },
  setSelectedEdge: (edge) => set({ selectedEdge: edge }),
  setSelectedNodeMeta: (meta) => set({ selectedNodeMeta: meta }),
  setCanvasActions: (actions) => set({ canvasActions: actions }),
}))
