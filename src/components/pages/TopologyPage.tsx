import { useCallback, useEffect, useRef, useState } from 'react'
import { useNodesState, useEdgesState, addEdge, type Connection } from 'reactflow'
import { Button, message } from 'antd'
import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import TopologyCanvas from '@/components/topology/TopologyCanvas'
import AddDeviceModal from '@/components/topology/AddDeviceModal'
import LayoutPreviewBanner from '@/components/topology/LayoutPreviewBanner'
import ChannelPickerModal from '@/components/topology/ChannelPickerModal'
import DeviceForm from '@/components/DeviceForm'
import { spreadLayout, alignNodes, NODE_WIDTH, NODE_HEIGHT, type AlignMode, type Point } from '@/utils/topologyLayout'
import DiscoveryPanel from '@/components/topology/DiscoveryPanel'
import EditNodeModal from '@/components/topology/EditNodeModal'
import { useTopologyToolbarStore } from '@/stores/topologyToolbarStore'
import { useDeviceDetailStore } from '@/stores/deviceDetailStore'
import type { TopologyNode, TopologyNodeData, TopologyEdgeData, TopologyEdge, TopologySummary } from '@/types/topology'
// Phase 38（38-01）：CHANNEL_SHORT_LABELS 短标表迁 types/device.ts 全局唯一化（38-02 右栏第三消费方）
import { CHANNEL_SHORT_LABELS } from '@/types/device'
import type { ConnectionType, CreateDeviceDTO, Device } from '@/types/device'

// D-08（Phase 19 / REN-02）：topology 记录已知字段覆盖集（Topology 类型字段），供未识别字段 warn 判定
const KNOWN_TOPOLOGY_KEYS = new Set(['id', 'name', 'nodes', 'edges', 'status', 'createdAt', 'updatedAt'])
// T-19-04：未识别字段 warn 全局去重标志（至多一次）
let warnedUnknownTopologyKeys = false

// Phase 26 / 26-04 round 3 P-B：节点 width/height 固化——历史持久化节点无显式尺寸时
// RF 每帧重复测量并循环发 dimension changes（reactflow issue 3925 官方确认拖拽卡顿根因），
// 组装时按布局算法常量（80/60）补默认尺寸，消除受控模式尺寸循环 diff
function normalizeNodeSizes(nodes: TopologyNode[]): TopologyNode[] {
  return nodes.map((n) =>
    n.width == null || n.height == null
      ? { ...n, width: n.width ?? NODE_WIDTH, height: n.height ?? NODE_HEIGHT }
      : n
  )
}

export default function TopologyPage() {
  // Phase 19 / REN-02：topologies 强类型 TopologySummary（P14 全字段 optional，兼容持久化历史 JSON）
  const [topologies, setTopologies] = useState<TopologySummary[]>([])
  const [currentTopologyId, setCurrentTopologyId] = useState<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNodeData>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<TopologyEdgeData>([])
  const [addDeviceOpen, setAddDeviceOpen] = useState(false)
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingNodeData, setEditingNodeData] = useState<TopologyNodeData | null>(null)
  // Phase 36（36-05，LOGIN-02）：双击三分支态——≥2 通道选择框设备；0 通道引导表单设备与
  // Tabs 定位初值（快照 connectionType，Pitfall 9 允许的唯一快照消费位）
  const [pickerDevice, setPickerDevice] = useState<Device | null>(null)
  const [credentialDevice, setCredentialDevice] = useState<Device | null>(null)
  const [credentialInitialChannel, setCredentialInitialChannel] = useState<ConnectionType>('ssh')
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set())
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set())
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isLoadingRef = useRef(false)
  // Phase 26 / D-06：布局预览态——同步 ref guard（非 state，防异步竞态漏写，T-26-03-01），
  // 为 true 时自动保存 effect 挂起，预览期间的拖拽微调不落库（D-07 微调与布局结果合并保存）
  const previewRef = useRef(false)
  // Phase 26 / D-08：单步快照（布局应用前捕获，逐节点浅拷 position，禁结构化共享）
  const layoutSnapshotRef = useRef<TopologyNode[] | null>(null)
  const [isLayoutPreviewing, setIsLayoutPreviewing] = useState(false)
  // Phase 26 / D-13：视野中心（画布坐标）——由 TopologyCanvas 经 useStore 换算写入，供新增设备落点
  const viewportCenterRef = useRef({ x: 0, y: 0 })
  // FE-03 (D-5-4): ref-mirror 同步最新 nodes/edges，供注册一次但需读最新拓扑的回调读取，消除 stale closure。
  // 不迁 useNodesState/useEdgesState 到 store（红线）——仅回调读取路径从闭包变量改为 ref.current。
  const nodesRef = useRef<TopologyNode[]>([])
  const edgesRef = useRef<TopologyEdge[]>([])
  const setToolbarState = useTopologyToolbarStore((s) => s.setToolbar)
  // Phase 38（38-01，DETAIL-01）：跨层选中态写侧——action 引用写完即走；另订阅 refreshCounter
  // 单字段（38 review CR-01 镜像信号：离散 bump 才重渲染一次，非每帧宽度态，Pattern 3 语义不破）
  const setSelectedDeviceId = useDeviceDetailStore((s) => s.setSelectedDeviceId)
  const refreshDeviceDetail = useDeviceDetailStore((s) => s.refresh)
  const detailRefreshCounter = useDeviceDetailStore((s) => s.refreshCounter)
  // Phase 39（39-01）：选中态扩展写侧 action + 跨层命令注册位（引用写完即走，Pattern 3）
  const setSelectedEdge = useDeviceDetailStore((s) => s.setSelectedEdge)
  const setSelectedNodeMeta = useDeviceDetailStore((s) => s.setSelectedNodeMeta)
  const setCanvasActions = useDeviceDetailStore((s) => s.setCanvasActions)

  // FE-03: ref 同步 effect（O(1) 赋值，与既有 isLoadingRef/saveTimerRef 同模式，无性能影响）
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

  // Phase 38（38-01，D-01/D-03 收敛点）→ Phase 39（39-01）三分支扩展：选中同步 effect——
  // 拓扑选中态上行 deviceDetailStore。分支一「恰好单选一台设备节点」上抛 data.deviceId +
  // 节点元信息快照（React Flow node.id ≠ deviceId，必须经 nodesRef 换算）并互斥清空连线
  // 快照；分支二（39 新增）「零节点选中且恰好单选一条连线」经 edgesRef/nodesRef 换算八字段
  // 连线快照上抛（右栏零查询，端节点缺失时 deviceId null/名字空串——未纳管端不可跳转）；
  // 分支三（零选/多选）三分支全置 null。设备/连线互斥由 RF 选中天然保证 + 写侧双清。
  // 选 effect 而非在 handleCanvasSelectionChange 回调内写：覆盖非回调选中变化路径——
  // handleDeleteSelected 本地清选中、loadTopology 换图节点替换；nodes 拖拽每帧换引用的
  // 代价仅为一次数组 find + zustand 同值 set（订阅方 Object.is 判等零重渲染）。
  // 声明位置必须在 nodesRef 同步 effect 之后：同 commit 内先刷新镜像再读。
  useEffect(() => {
    if (selectedNodeIds.size === 1) {
      const nodeId = [...selectedNodeIds][0]
      const node = nodesRef.current.find((n) => n.id === nodeId)
      setSelectedDeviceId(node ? node.data.deviceId : null)
      setSelectedNodeMeta(
        node
          ? {
              nodeId: node.id,
              deviceId: node.data.deviceId,
              deviceName: node.data.deviceName,
              deviceType: node.data.deviceType,
            }
          : null
      )
      setSelectedEdge(null)
      return
    }
    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 1) {
      const edgeId = [...selectedEdgeIds][0]
      const edge = edgesRef.current.find((e) => e.id === edgeId)
      if (edge) {
        const sourceNode = nodesRef.current.find((n) => n.id === edge.source)
        const targetNode = nodesRef.current.find((n) => n.id === edge.target)
        setSelectedEdge({
          edgeId: edge.id,
          sourceInterface: edge.data?.sourceInterface ?? '',
          targetInterface: edge.data?.targetInterface ?? '',
          sourceDeviceId: sourceNode ? sourceNode.data.deviceId : null,
          sourceDeviceName: sourceNode ? sourceNode.data.deviceName : '',
          targetDeviceId: targetNode ? targetNode.data.deviceId : null,
          targetDeviceName: targetNode ? targetNode.data.deviceName : '',
        })
      } else {
        // stale edgeId（换图后残留）：并入清空
        setSelectedEdge(null)
      }
      setSelectedDeviceId(null)
      setSelectedNodeMeta(null)
      return
    }
    // 零选/多选（含节点+连线混选）：三分支全置 null
    setSelectedDeviceId(null)
    setSelectedNodeMeta(null)
    setSelectedEdge(null)
  }, [selectedNodeIds, selectedEdgeIds, nodes, edges, setSelectedDeviceId, setSelectedNodeMeta, setSelectedEdge])

  // Phase 38（38-01，D-02 双保险）→ 39-01 对称扩展：切页卸载即清空跨层选中（含连线快照与
  // 节点元信息，照 :403 toolbar cleanup 先例）
  useEffect(
    () => () => {
      setSelectedDeviceId(null)
      setSelectedNodeMeta(null)
      setSelectedEdge(null)
    },
    [setSelectedDeviceId, setSelectedNodeMeta, setSelectedEdge]
  )

  // Phase 38（38 review CR-01）：编辑保存后画布节点定向镜像——updateDevice 虽在库内级联刷新
  // topologies.data_enc，但画布内存 nodes 仍持旧字段值；若不镜像，随后任意画布操作触发的
  // 1s debounce 自动保存将以旧值整图覆写 data_enc（右栏改名被静默回滚）。本页三条编辑写路径
  // （画布侧 EditNodeModal / 零通道引导 DeviceForm / 38-02 右栏编辑）均 bump refreshCounter，
  // 后两条此前无镜像；此处按 bump 时刻选中设备重拉 getById，把 topoFields 级联六字段写回对应
  // 节点。对画布侧自身编辑幂等无害（值与库内一致）；镜像 setNodes 会经自动保存 effect 以
  // 已修正值再写一次 data_enc，与库内一致无冲突。失败仅 warn（库内已正确，下次载图自收敛）。
  useEffect(() => {
    if (detailRefreshCounter === 0) return
    const devId = useDeviceDetailStore.getState().selectedDeviceId
    if (!devId) return
    void window.api.device
      .getById(devId)
      .then((d) => {
        if (!d) return
        setNodes((nds) =>
          nds.map((n) =>
            n.data.deviceId === devId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    deviceName: d.name,
                    deviceType: d.deviceType,
                    connectionType: d.connectionType,
                    ipAddress: d.ipAddress,
                    vendor: d.vendor,
                    model: d.model,
                  },
                }
              : n
          )
        )
      })
      .catch((e: unknown) => {
        console.warn('编辑保存后画布节点镜像失败', e instanceof Error ? e.message : String(e))
      })
  }, [detailRefreshCounter, setNodes])

  // Phase 26 / D-04 + D-05：位置映射应用——仅对 moves 涉及节点换引用（保持 26-01 细粒度修复，
  // 不 map 全量 {...n}），未涉及节点原引用透传（memo comparator 直接命中，无重渲染）
  const applyPositionMoves = useCallback(
    (moves: Map<string, Point>) => {
      if (moves.size === 0) return
      setNodes((nds) =>
        nds.map((n) => {
          const p = moves.get(n.id)
          return p ? { ...n, position: { x: p.x, y: p.y } } : n
        })
      )
    },
    [setNodes]
  )

  // Phase 26 / D-05：参考线/网格吸附命中——拖动节点落点回写（单节点换引用）
  const handleGuideSnap = useCallback(
    (nodeId: string, pos: Point) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, position: { x: pos.x, y: pos.y } } : n))
      )
    },
    [setNodes]
  )

  // Phase 26 / D-04：推挤让位映射（被压节点，拖动节点永不在 moves 内——resolvePushAside 红线）
  const handlePushAside = useCallback((moves: Map<string, Point>) => {
    applyPositionMoves(moves)
  }, [applyPositionMoves])

  // Phase 26 / D-12（TOPO-04）：选区对齐——alignNodes 纯函数算映射后仅对变更节点换引用；
  // 均分 <3 节点返回空 Map（按钮侧已禁用，双保险）
  const handleAlignSelected = useCallback(
    (mode: AlignMode) => {
      if (selectedNodeIds.size < 2) return
      const moves = alignNodes(
        [...selectedNodeIds],
        nodesRef.current.map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          width: n.width ?? undefined,
          height: n.height ?? undefined,
        })),
        mode
      )
      applyPositionMoves(moves)
    },
    [selectedNodeIds, applyPositionMoves]
  )

  const loadTopology = useCallback(async (id: string) => {
    isLoadingRef.current = true
    const topo = await window.api.topology.getById(id)
    if (topo) {
      setNodes(normalizeNodeSizes(topo.nodes || []))
      setEdges(topo.edges || [])
    }
    // WR-01（26 review）：React 18 批处理下自动保存 effect 在同步代码结束后才 flush，
    // 同步置 false 会使 guard 失效（每次切换拓扑多一次原样写回库）。仿 handleUndoLayout
    // 用 setTimeout(0) 保持 guard 到 effect 跳过本帧。
    setTimeout(() => {
      isLoadingRef.current = false
    }, 0)
  }, [setNodes, setEdges])

  // WR-07（26 review）：selectId 指定强制选中的拓扑 id——handleNew/handleImport 场景下
  // 跳过「自动选 list[0]」，避免与后续 setCurrentTopologyId(topo.id) 双重加载竞态错位
  const fetchTopologies = useCallback(async (selectId?: string) => {
    // WR-01：过滤无 id 的历史脏数据行，防 undefined 传播为 currentTopologyId / getById(undefined)
    const list = (await window.api.topology.list()).filter((t): t is TopologySummary & { id: string } => !!t.id)
    // D-08（Phase 19 / REN-02）：旧版本拓扑 JSON 含未识别字段时静默忽略 + console.warn 可观测——
    // 仅输出字段名键集不输出值（T-19-05，拓扑数据可能含 IP 等资产信息）；
    // 模块级 warnedUnknownTopologyKeys 去重，整个会话至多 warn 一次（T-19-04 防大拓扑刷屏）。
    if (!warnedUnknownTopologyKeys) {
      for (const record of list) {
        const unknown = Object.keys(record).filter((k) => !KNOWN_TOPOLOGY_KEYS.has(k))
        if (unknown.length > 0) {
          warnedUnknownTopologyKeys = true
          console.warn('拓扑数据含未识别字段', unknown)
          break
        }
      }
    }
    setTopologies(list)
    // 选中优先级：显式 selectId > 最近一条（list[0]）；selectId 不在列表（已删/竞态）则退回 list[0]
    const target = selectId && list.some((t) => t.id === selectId) ? selectId : list[0]?.id
    if (target) {
      setCurrentTopologyId(target)
      loadTopology(target)
    }
  }, [loadTopology])

  useEffect(() => {
    fetchTopologies()
  }, [fetchTopologies])

  // CR-02（26 review）：预览态复位抽公共函数——handleNew/handleDelete/handleImport 经
  // fetchTopologies 自动选中新拓扑时绕过 handleTopologyChange，若不复位将导致预览横幅残留、
  // layoutSnapshotRef 指向旧拓扑快照、自动保存 effect 对新拓扑永久挂起（编辑静默丢失）。
  const resetPreviewState = useCallback(() => {
    if (!previewRef.current) return
    previewRef.current = false
    setIsLayoutPreviewing(false)
    layoutSnapshotRef.current = null
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [])

  const handleTopologyChange = useCallback((id: string | null) => {
    // D-06 复位：切换拓扑即丢弃未保存预览（防误离开拦截在 TopologyToolbar，T-26-03-03）
    resetPreviewState()
    setCurrentTopologyId(id)
    if (id) {
      loadTopology(id)
    } else {
      setNodes([])
      setEdges([])
    }
  }, [resetPreviewState, loadTopology, setNodes, setEdges])

  const saveTopology = useCallback(async () => {
    if (!currentTopologyId) return
    // WR-02（26 review）：预览态下手动保存必须退出预览态（横幅残留/撤销回滚已存布局/
    // 自动保存持续挂起三害同源）
    resetPreviewState()
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    await window.api.topology.update(currentTopologyId, {
      nodes: nodesRef.current.map((n) => ({ ...n })),
      edges: edgesRef.current.map((e) => ({ ...e })),
    })
    message.success('保存成功')
  }, [currentTopologyId, resetPreviewState])

  const debouncedSave = useCallback(() => {
    if (!currentTopologyId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      window.api.topology.update(currentTopologyId, {
        nodes: nodesRef.current.map((n) => ({ ...n })),
        edges: edgesRef.current.map((e) => ({ ...e })),
      })
    }, 1000)
  }, [currentTopologyId])

  // Phase 26 / D-09（26-04 再工 spec ③）：整理布局——星型分层放射三模式
  // 无选中 = 全图（剔除叶子后核心定根）；选 1 台 = 以该设备为根排全图；选多台 = 仅整理选中集
  // 成功进入预览态（挂起自动保存）；异常零副作用（preview 态不进入，画布未改动）
  const handleOrganizeLayout = useCallback(() => {
    const current = nodesRef.current
    if (current.length === 0) return
    try {
      const selected = [...selectedNodeIds]
      const positions = spreadLayout(
        current.map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          width: n.width ?? undefined,
          height: n.height ?? undefined,
        })),
        edgesRef.current.map((e) => ({ source: e.source, target: e.target })),
        {
          centerId: selected.length === 1 ? selected[0] : undefined,
          subset: selected.length > 1 ? selected : undefined,
        }
      )
      if (positions.size === 0) return
      // 先快照后应用（语句顺序红线：快照必须捕获布局前位置）
      layoutSnapshotRef.current = current.map((n) => ({
        ...n,
        position: { ...n.position },
      }))
      previewRef.current = true
      setIsLayoutPreviewing(true)
      // 挂起已在途 debounce（防残留 timer 在预览态落库）
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      setNodes((nds) =>
        nds.map((n) => {
          const p = positions.get(n.id)
          return p ? { ...n, position: { x: p.x, y: p.y } } : n
        })
      )
    } catch {
      message.error('布局整理失败，画布未改动')
    }
  }, [selectedNodeIds, setNodes])

  // Phase 26 / D-07：保存布局——微调与布局结果合并一次写库（复用 saveTopology 形态）
  const handleSaveLayout = useCallback(async () => {
    if (!currentTopologyId || !previewRef.current) return
    previewRef.current = false
    setIsLayoutPreviewing(false)
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    try {
      await window.api.topology.update(currentTopologyId, {
        nodes: nodesRef.current.map((n) => ({ ...n })),
        edges: edgesRef.current.map((e) => ({ ...e })),
      })
      layoutSnapshotRef.current = null
      message.success('布局已保存')
    } catch (e: unknown) {
      message.error('保存失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [currentTopologyId])

  // Phase 26 / D-08：撤销布局——单步快照一键恢复布局前全量位置，不弹确认
  const handleUndoLayout = useCallback(() => {
    const snapshot = layoutSnapshotRef.current
    if (!snapshot) return
    previewRef.current = false
    setIsLayoutPreviewing(false)
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    // 一帧 guard：防自动保存 effect 把快照位置再 debounce 写库（T-26-03-02）
    isLoadingRef.current = true
    setNodes(snapshot.map((n) => ({ ...n, position: { ...n.position } })))
    layoutSnapshotRef.current = null
    message.info('已撤销，恢复布局前位置')
    setTimeout(() => {
      isLoadingRef.current = false
    }, 0)
  }, [setNodes])

  useEffect(() => {
    if (isLoadingRef.current) return
    // D-06：布局预览态挂起自动保存——guard 先于 debouncedSave（T-26-03-01）
    if (previewRef.current) return
    if (currentTopologyId && (nodes.length > 0 || edges.length > 0)) {
      debouncedSave()
    }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [nodes, edges, currentTopologyId, debouncedSave])

  const handleNew = useCallback(async (name: string) => {
    resetPreviewState()
    const topo = await window.api.topology.create({ name, nodes: [], edges: [] })
    // WR-07：经 fetchTopologies(topo.id) 单一选中/加载路径（新拓扑必在 list，空节点由 loadTopology 置空）
    await fetchTopologies(topo.id)
    message.success('创建成功')
  }, [resetPreviewState, fetchTopologies])

  const handleDelete = useCallback(async () => {
    if (!currentTopologyId) return
    resetPreviewState()
    try {
      await window.api.topology.delete(currentTopologyId)
      setCurrentTopologyId(null)
      setNodes([])
      setEdges([])
      await fetchTopologies()
      message.success('删除成功')
    } catch (e: unknown) {
      // D-09：deleteTopology 18-02 已事务化，失败即整体回滚（对照同文件 handleImport catch 结构）
      message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [currentTopologyId, resetPreviewState, fetchTopologies, setNodes, setEdges])

  const handleImport = useCallback(async (jsonStr: string) => {
    try {
      resetPreviewState()
      const topo = await window.api.topology.importJson(jsonStr)
      // WR-07：同 handleNew，经 selectId 单一选中路径防双重加载
      await fetchTopologies(topo.id)
      setCurrentTopologyId(topo.id)
      if (topo.nodes) setNodes(normalizeNodeSizes(topo.nodes))
      if (topo.edges) setEdges(topo.edges)
      message.success('导入成功')
    } catch {
      message.error('导入失败')
    }
  }, [resetPreviewState, fetchTopologies, setNodes, setEdges])

  const handleExport = useCallback(async () => {
    if (!currentTopologyId) return
    try {
      const jsonStr = await window.api.topology.exportJson(currentTopologyId)
      const topo = topologies.find((t) => t.id === currentTopologyId)
      const blob = new Blob([jsonStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${topo?.name || 'topology'}.json`
      a.click()
      URL.revokeObjectURL(url)
      message.success('导出成功')
    } catch {
      message.error('导出失败')
    }
  }, [currentTopologyId, topologies])

  // Sync toolbar state to sidebar store
  useEffect(() => {
    setToolbarState({
      topologies,
      currentTopologyId,
      onTopologyChange: handleTopologyChange,
      onNew: handleNew,
      onSave: saveTopology,
      onDelete: handleDelete,
      onImport: handleImport,
      onExport: handleExport,
      onOrganizeLayout: handleOrganizeLayout,
      selectedCount: selectedNodeIds.size,
      isLayoutPreviewing,
    })
    return () => setToolbarState(null)
  }, [topologies, currentTopologyId, handleTopologyChange, handleNew, saveTopology, handleDelete, handleImport, handleExport, handleOrganizeLayout, selectedNodeIds, isLayoutPreviewing, setToolbarState])

  const handleConnect = useCallback(
    (connection: Connection, sourceInterface: string, targetInterface: string) => {
      const edgeData: TopologyEdgeData = { sourceInterface, targetInterface }
      setEdges((eds) =>
        addEdge({ ...connection, type: 'edgeWithInterfaces', data: edgeData }, eds)
      )
    },
    [setEdges]
  )

  const handleAddDevices = useCallback((newNodes: TopologyNode[]) => {
    setNodes((nds) => [...nds, ...newNodes])
    setAddDeviceOpen(false)
  }, [setNodes])

  // Phase 26 / 26-04 round 3 P-C：稳定回调/取值器——内联箭头函数每帧新引用会击穿子组件 memo
  const handleAddDeviceCancel = useCallback(() => setAddDeviceOpen(false), [])
  const handleDiscoveryCancel = useCallback(() => setDiscoveryOpen(false), [])
  const handleEditCancel = useCallback(() => {
    setEditModalOpen(false)
    setEditingNodeData(null)
  }, [])
  const getViewportCenter = useCallback(() => ({ ...viewportCenterRef.current }), [])
  const getExistingNodes = useCallback(() => nodesRef.current, [])

  const handleDiscoveryConfirm = useCallback(
    (discoveredNodes: TopologyNode[], discoveredEdges: TopologyEdge[]) => {
      // FE-03: 读 ref.current 取最新拓扑（消除 stale closure），合并去重语义不变
      const existingIds = new Set(nodesRef.current.map((n) => n.data.deviceId))
      const newNodes = discoveredNodes.filter((n) => !existingIds.has(n.data.deviceId))
      setNodes((nds) => [...nds, ...newNodes])

      const existingEdgeKeys = new Set(
        edgesRef.current.map((e) => `${e.source}->${e.target}`)
      )
      const newEdges = discoveredEdges.filter(
        (e) => !existingEdgeKeys.has(`${e.source}->${e.target}`)
      )
      setEdges((eds) => [...eds, ...newEdges])

      setDiscoveryOpen(false)
      if (newNodes.length > 0 || newEdges.length > 0) {
        message.success(
          `导入 ${newNodes.length} 个节点、${newEdges.length} 条连线`
        )
      } else {
        message.info('所有节点和连线已存在，无需导入')
      }
    },
    [setNodes, setEdges]
  )

  // §6.4 连接失败文案：带通道短标归因（SSH/Telnet/Web/RDP）；统一入口失败在此统一呈现
  const openChannel = useCallback(async (deviceId: string, channel: ConnectionType) => {
    try {
      await window.api.connection.open(deviceId, channel)
    } catch {
      message.error(`${CHANNEL_SHORT_LABELS[channel]} 连接失败`)
    }
  }, [])

  // Phase 36（36-05，LOGIN-02 · D-01/D-02/D-03）：双击三分支——判定唯一源 = device.getById
  // 的 channels 投影（Pitfall 9 禁读节点 JSON 快照；快照 connectionType 仅作零通道引导的
  // Tabs 定位初值）。0 通道弹编辑态 DeviceForm 引导补配；1 通道免弹直连；≥2 通道弹
  // ChannelPickerModal。连接统一单入口 connection.open(deviceId, channel)（36-03 落地，
  // web 也走 main——旧 renderer 直取 webUrl 分支删除）。
  const handleNodeDoubleClick = useCallback(async (_nodeId: string, data: TopologyNodeData) => {
    try {
      const device = await window.api.device.getById(data.deviceId)
      if (!device) {
        message.error('设备不存在')
        return
      }
      const channels = device.channels ?? []
      if (channels.length === 0) {
        // D-02 零通道引导：编辑态表单 + credentialHint Alert + Tabs 定位（非法/空值回落 'ssh'）
        setCredentialInitialChannel(data.connectionType || 'ssh')
        setCredentialDevice(device)
        return
      }
      if (channels.length === 1) {
        // D-01 单通道免弹直连（现状手感）
        await openChannel(device.id, channels[0].channel)
        return
      }
      // D-03 ≥2 通道选择框（预选 = 记忆 > 默认通道 > 固定序首行，组件内解析）
      setPickerDevice(device)
    } catch {
      // §6.4：无法归因通道（getById 失败等）回落既有文案
      message.error('连接失败')
    }
  }, [openChannel])

  // D-03 确认回调——记忆写入已在 ChannelPickerModal 确认时刻完成（记「上次所选」非
  // 「上次成功」）；此处关框 + 统一入口连接（不设 loading 键，§6.2）
  const handlePickerConnect = useCallback((channel: ConnectionType) => {
    if (!pickerDevice) return
    const deviceId = pickerDevice.id
    setPickerDevice(null)
    openChannel(deviceId, channel)
  }, [pickerDevice, openChannel])

  // D-02 零通道引导表单保存——device:update 单一写路径（DevicesPage handleUpdate 同型；
  // 凭证变更不影响节点 data，拓扑画布零刷新）
  const handleCredentialFormOk = useCallback(async (values: CreateDeviceDTO) => {
    if (!credentialDevice) return
    try {
      await window.api.device.update(credentialDevice.id, values)
      message.success('设备更新成功')
      // Phase 38（38-01）：双写路径 refresh bump——38-02 右栏面板重拉 getById 的信号线
      refreshDeviceDetail()
      setCredentialDevice(null)
    } catch (e: unknown) {
      // D-09：updateDevice 事务化，失败即整体回滚（本地不落脏值）
      message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [credentialDevice, refreshDeviceDetail])

  const handleCredentialFormCancel = useCallback(() => setCredentialDevice(null), [])
  const handlePickerCancel = useCallback(() => setPickerDevice(null), [])

  const handleDeleteSelected = useCallback(() => {
    setNodes((nds) => nds.filter((n) => !selectedNodeIds.has(n.id)))
    setEdges((eds) => eds.filter((e) => !selectedEdgeIds.has(e.id) && !selectedNodeIds.has(e.source) && !selectedNodeIds.has(e.target)))
    setSelectedNodeIds(new Set())
    setSelectedEdgeIds(new Set())
  }, [selectedNodeIds, selectedEdgeIds, setNodes, setEdges])

  const handleEditSelectedNode = useCallback(() => {
    const nodeId = [...selectedNodeIds][0]
    if (!nodeId) return
    // FE-03: 读 ref.current 取最新 nodes（消除 stale closure）
    const node = nodesRef.current.find((n) => n.id === nodeId)
    if (!node) return
    setEditingNodeData(node.data)
    setEditModalOpen(true)
  }, [selectedNodeIds])

  const handleCanvasSelectionChange = useCallback((nodeIds: string[], edgeIds: string[]) => {
    setSelectedNodeIds(new Set(nodeIds))
    setSelectedEdgeIds(new Set(edgeIds))
  }, [])

  // —— Phase 39（39-01 接入点②）：五条跨层命令（外层右栏调用、本页执行）——
  // 结构照 toolbar 注册 effect（:446-461 先例）方向反转；消费方一律
  // getState().canvasActions 一次性取用（Pattern 3 读清即走，不订阅）。
  // 39-02（删除双动作）/39-03（纳管回写）只消费，不再改本命令层。

  // D-02 接口回写：setEdges 定向换 data（handleEditConfirm 镜像 :626-630 节点版形态改边版）。
  // 落库链零新增：edges 引用变化自动触发既有自动保存 effect → debouncedSave 1s topology.update。
  const applyEdgeInterfaces = useCallback(
    (edgeId: string, sourceInterface: string, targetInterface: string) => {
      setEdges((eds) =>
        eds.map((e) =>
          e.id === edgeId ? { ...e, data: { ...e.data, sourceInterface, targetInterface } } : e
        )
      )
    },
    [setEdges]
  )

  // D-06 从拓扑移除（轻删）：handleDeleteSelected :584-589 单节点版——filter 节点 + 悬空边 +
  // 清本地选中；清选中触发选中同步 effect 上抛 null，右栏自动收起（链路自洽）。
  const removeNodeFromCanvas = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
      setSelectedNodeIds(new Set())
      setSelectedEdgeIds(new Set())
    },
    [setNodes, setEdges]
  )

  // D-07 删连线（轻删免确认）：filter 边 + 清本地选中（右栏自动收起）。
  const removeEdgeFromCanvas = useCallback(
    (edgeId: string) => {
      setEdges((eds) => eds.filter((e) => e.id !== edgeId))
      setSelectedNodeIds(new Set())
      setSelectedEdgeIds(new Set())
    },
    [setEdges]
  )

  // D-09 纳管回写：按节点 id（非 deviceId）定向换 data.deviceId + 置 unmanaged 为 undefined
  // （省键——JSON 持久化时字段消失即历史形态）。红线：节点 id 本身不可改（edges source/target
  // 断链）。不动选中：nodes 引用变化触发选中同步 effect 重跑，setSelectedDeviceId 自动变为
  // 新 deviceId，右栏从 missing 切正常详情（39-03 消费闭环）。
  const adoptNodeToDevice = useCallback(
    (nodeId: string, deviceId: string) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, deviceId, unmanaged: undefined } } : n
        )
      )
    },
    [setNodes]
  )

  // D-04 跳转选中设备：三步直写（不依赖 RF 受控 selected → onSelectionChange 回流可靠性，
  // PATTERNS No Analog 表已标注该回流无先例需真机验证——直写形态全链幂等，回流有无均无害）。
  // 前置防御：经 nodesRef.current 按 data.deviceId 严格等值定位，未命中整体 return。
  const focusDevice = useCallback(
    (deviceId: string) => {
      const target = nodesRef.current.find((n) => n.data.deviceId === deviceId)
      if (!target) return
      // 一步画布视觉选中：节点 selected 重置（目标 true 其余 false，引用保序换引用）+ 边全清
      setNodes((nds) =>
        nds.map((n) => {
          const want = n.id === target.id
          return n.selected === want ? n : { ...n, selected: want }
        })
      )
      setEdges((eds) => eds.map((e) => (e.selected ? { ...e, selected: false } : e)))
      // 二步本地选中 state 直写——D-04 闭环关键：若 RF onSelectionChange 不回流，本地两 state
      // 仍持旧值（如旧连线选中），而 setNodes 引起的 nodes 引用变化会触发选中同步 effect 以
      // stale 本地选中态重跑（走分支二恢复旧 selectedEdge、清 selectedDeviceId），覆写第三步
      // 直写值致跳转闭环断裂；直写本地后，effect 无论重跑与否均按与画布一致的选中态计算，
      // 结果幂等。RF 回流触发时全链同值幂等无害。
      setSelectedNodeIds(new Set([target.id]))
      setSelectedEdgeIds(new Set())
      // 三步 store 直写（右栏即时切换；selectedNodeMeta 与 setSelectedEdge(null) 由随后必跑的
      // 选中同步 effect 分支一按新本地选中态补写，写侧形态对齐）
      setSelectedDeviceId(deviceId)
    },
    [setNodes, setEdges, setSelectedDeviceId]
  )

  // 命令注册 effect：mount 注册五条 useCallback 引用、卸载置 null（toolbar 注册 cleanup 先例）
  useEffect(() => {
    setCanvasActions({
      applyEdgeInterfaces,
      removeNodeFromCanvas,
      removeEdgeFromCanvas,
      adoptNodeToDevice,
      focusDevice,
    })
    return () => setCanvasActions(null)
  }, [
    applyEdgeInterfaces,
    removeNodeFromCanvas,
    removeEdgeFromCanvas,
    adoptNodeToDevice,
    focusDevice,
    setCanvasActions,
  ])

  // Phase 25.1（25.1-01）：设备属性编辑收敛 device:update 单一写路径——service 层 updateDevice
  // 同一事务内同步 devices 表（updated_at/name_hash/重名拦截）并级联刷新所有 topologies.data_enc，
  // 消除原「只 setNodes + debounce 写 data_enc」的旁路写库（设备管理页不同步根因）。
  // 失败不 setNodes（本地不落脏值），错误明文透出（重名冲突含冲突设备名+IP，D-12）。
  // 约束（plan-checker，WR-01 25.1）：EditNodeModal 可编辑字段必须 ⊆ updateDevice topoFields
  // 级联集（name/deviceType/connectionType/ipAddress/vendor/model，见 device.ts topoFields）。
  // 新增可编辑字段（如 version/webUrl）须先确认已在级联集内，否则拓扑 JSON 不级联、本地镜像分叉。
  const handleEditConfirm = useCallback(
    async (updatedData: TopologyNodeData) => {
      try {
        // WR-06（26 review）：UpdateDeviceDTO = Partial<CreateDeviceDTO>，字段全 optional，
        // 直接构造可赋值对象——删双断言，新增字段缺漏即刻产生编译错误（防 25.1-01 级联集分叉）
        await window.api.device.update(updatedData.deviceId, {
          name: updatedData.deviceName,
          ipAddress: updatedData.ipAddress,
          deviceType: updatedData.deviceType,
          vendor: updatedData.vendor,
          model: updatedData.model,
        })
        // 成功后再镜像本地节点（值与 service 落库一致，debounce 回写不产生冲突数据）
        setNodes((nds) =>
          nds.map((n) =>
            n.data.deviceId === updatedData.deviceId ? { ...n, data: updatedData } : n
          )
        )
        setEditModalOpen(false)
        setEditingNodeData(null)
        // Phase 38（38-01）：双写路径 refresh bump——38-02 右栏面板重拉 getById 的信号线
        refreshDeviceDetail()
      } catch (e: unknown) {
        message.error('保存失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [setNodes, refreshDeviceDetail]
  )

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <TopologyCanvas
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeDoubleClick={handleNodeDoubleClick}
        onDeleteSelected={handleDeleteSelected}
        onEditSelectedNode={handleEditSelectedNode}
        onSelectionChange={handleCanvasSelectionChange}
        viewportCenterRef={viewportCenterRef}
        nodesRef={nodesRef}
        onGuideSnap={handleGuideSnap}
        onPushAside={handlePushAside}
        onAlignSelected={handleAlignSelected}
      />
      <LayoutPreviewBanner
        visible={isLayoutPreviewing}
        onSave={handleSaveLayout}
        onUndo={handleUndoLayout}
      />
      {currentTopologyId && (
        <>
          <Button
            shape="circle"
            icon={<SearchOutlined />}
            size="large"
            style={{ position: 'absolute', bottom: 24, right: 80, zIndex: 10 }}
            onClick={() => setDiscoveryOpen(true)}
            title="拓扑发现"
          />
          <Button
            type="primary"
            shape="circle"
            icon={<PlusOutlined />}
            size="large"
            style={{ position: 'absolute', bottom: 24, right: 24, zIndex: 10 }}
            onClick={() => setAddDeviceOpen(true)}
          />
        </>
      )}
      <AddDeviceModal
        open={addDeviceOpen}
        getExistingNodes={getExistingNodes}
        getViewportCenter={getViewportCenter}
        onConfirm={handleAddDevices}
        onCancel={handleAddDeviceCancel}
      />
      <DiscoveryPanel
        open={discoveryOpen}
        onCancel={handleDiscoveryCancel}
        onConfirm={handleDiscoveryConfirm}
      />
      <EditNodeModal
        open={editModalOpen}
        data={editingNodeData}
        onConfirm={handleEditConfirm}
        onCancel={handleEditCancel}
      />
      {/* Phase 36（36-05，D-03）：双击 ≥2 通道选择框（记忆预选 + 确认时刻写 lastChannelByDevice） */}
      <ChannelPickerModal
        open={pickerDevice !== null}
        device={pickerDevice}
        onConnect={handlePickerConnect}
        onCancel={handlePickerCancel}
      />
      {/* Phase 36（36-05，D-02）：双击 0 通道引导——编辑态 DeviceForm（与 DevicesPage 共用
          组件不同实例）；credentialHint 引导 Alert + initialChannel Tabs 定位（36-04 落库休眠
          的引导 props 在此点亮） */}
      <DeviceForm
        open={credentialDevice !== null}
        device={credentialDevice}
        credentialHint
        initialChannel={credentialInitialChannel}
        onOk={handleCredentialFormOk}
        onCancel={handleCredentialFormCancel}
      />
    </div>
  )
}
