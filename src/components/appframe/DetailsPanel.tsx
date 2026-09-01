import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppFrameStore } from '@/stores/appFrameStore'
import { useDeviceDetailStore } from '@/stores/deviceDetailStore'
import DeviceDetailPanel from './DeviceDetailPanel'
import EdgeDetailPanel from './EdgeDetailPanel'

/**
 * DetailsPanel —— AppFrame details 栏容器（Phase 35 / UI-07，D-01 预留骨架）。
 *
 * 订阅 store 的 width/collapsed/dragging（单字段 selector，Pattern 3）：折叠 = inline
 * width 归 0 + [data-collapsed] visibility 隐藏（appframe.css），展开 = 记忆宽度。
 *
 * ⚠ SC2 红线（折叠保挂载）：子树永不条件渲染——禁止用折叠标志做 JSX 短路写法
 * （unmount 会丢子树状态，拓扑 React Flow 场景不可接受）。依据（reactflow 11.11.4
 * 实装源码验证）：内建 ResizeObserver 对容器尺寸变化只更新 store 的 width/height、
 * 不触碰 d3-zoom transform，fitView 由 init 闩锁保证仅一次——前提是 React 层
 * 不卸载子树，CSS 层只做视觉隐藏。
 *
 * 本组件与 AppFrameResizer 是宽度态仅有的两个 DOM 消费者（MainLayout 与 center
 * 子树禁止订阅，Pattern 3 拖拽隔离）。Phase 38（38-01）追加订阅 selectedDeviceId
 * （单字段 selector）→ Phase 39（39-01）追加订阅 selectedEdge（单字段 selector，
 * 清单内组件 Pattern 3 合规）——宽度态消费者仍仅本组件与 AppFrameResizer，
 * MainLayout 与 center 子树对 appFrameStore 与 deviceDetailStore 均禁止订阅。
 *
 * Phase 39（39-01）可见性总纲（38-D01 扩展）：可见 ⇔ 拓扑页且恰好单选一台设备
 * （含未纳管节点）或恰好单选一条连线——effectiveCollapsed = !hasContent || collapsed
 * （无内容自动收起 + 用户手动收起并集），子树挂载不动，仅 CSS/宽度隐藏（SC2 不破）。
 * 设备/连线互斥由 store 写侧（TopologyPage 选中同步 effect）保证 + 两面板各自内部
 * null 态 return null——两组件并列常驻渲染、永不条件化（「内容切换非挂载切换」
 * 38 期同款语义），任一时刻至多一个面板渲染内容。
 */
export default function DetailsPanel() {
  const width = useAppFrameStore((s) => s.width)
  const collapsed = useAppFrameStore((s) => s.collapsed)
  const dragging = useAppFrameStore((s) => s.dragging)
  const setCollapsedAuto = useAppFrameStore((s) => s.setCollapsedAuto)
  const selectedDeviceId = useDeviceDetailStore((s) => s.selectedDeviceId)
  const selectedEdge = useDeviceDetailStore((s) => s.selectedEdge)
  const location = useLocation()

  // 39 可见性总纲本地判定：非拓扑页 / 无单选设备且无单选连线 = 无内容
  const hasContent =
    location.pathname === '/topology' && (selectedDeviceId !== null || selectedEdge !== null)
  const effectiveCollapsed = !hasContent || collapsed

  // SC1 autoExpand（38-01 → 39-01 对称扩展）：点选（含换选）设备或连线即自动展开——
  // 重置用户手动收起态。瞬态写不落盘（setCollapsedAuto 裸 set），手动折叠记忆（toggle
  // 持久）不受污染。语义边界：同节点/同连线重复点击不构成新选中（RF 不重发
  // onSelectionChange），手动收起意图优先——换选任意设备或连线即重开。
  useEffect(() => {
    if (selectedDeviceId !== null || selectedEdge !== null) setCollapsedAuto(false)
  }, [selectedDeviceId, selectedEdge, setCollapsedAuto])

  return (
    <aside
      className="nt-appframe-details"
      data-collapsed={effectiveCollapsed}
      data-dragging={dragging}
      style={{ width: effectiveCollapsed ? 0 : width }}
    >
      {/* Phase 38（38-02）：35 期预留占位替换为 DeviceDetailPanel 详情内容——
          无条件挂载（SC2 红线延续，无任何 {visible && ...} 短路）；折叠保挂载的活性证明
          职责由面板内状态（逐通道测试结果）在目检中承接 */}
      <DeviceDetailPanel />
      {/* Phase 39（39-01）：连线详情并列常驻（单选连线时 DeviceDetailPanel 内部
          selectedDeviceId null 门控 return null，互斥由 store 写侧保证——两组件实例
          永不条件化，SC2「内容切换非挂载切换」38 期同款语义） */}
      <EdgeDetailPanel />
    </aside>
  )
}
