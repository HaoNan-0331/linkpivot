import { useCallback, useEffect, useRef, useState } from 'react'
import { useNodesState, useEdgesState, addEdge, type Connection } from 'reactflow'
import { Button, message } from 'antd'
import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import TopologyCanvas from '@/components/topology/TopologyCanvas'
import AddDeviceModal from '@/components/topology/AddDeviceModal'
import LayoutPreviewBanner from '@/components/topology/LayoutPreviewBanner'
import { spreadLayout, type Point } from '@/utils/topologyLayout'
import DiscoveryPanel from '@/components/topology/DiscoveryPanel'
import EditNodeModal from '@/components/topology/EditNodeModal'
import { useTopologyToolbarStore } from '@/stores/topologyToolbarStore'
import type { TopologyNode, TopologyNodeData, TopologyEdgeData, TopologyEdge, TopologySummary } from '@/types/topology'
import type { ConnectionType, UpdateDeviceDTO } from '@/types/device'

// D-08（Phase 19 / REN-02）：topology 记录已知字段覆盖集（Topology 类型字段），供未识别字段 warn 判定
const KNOWN_TOPOLOGY_KEYS = new Set(['id', 'name', 'nodes', 'edges', 'status', 'createdAt', 'updatedAt'])
// T-19-04：未识别字段 warn 全局去重标志（至多一次）
let warnedUnknownTopologyKeys = false

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
  // Phase 26 / D-11：网格吸附 toggle，默认关闭
  const [snapEnabled, setSnapEnabled] = useState(false)
  // Phase 26 / D-13：视野中心（画布坐标）——由 TopologyCanvas 经 useStore 换算写入，供新增设备落点
  const viewportCenterRef = useRef({ x: 0, y: 0 })
  // FE-03 (D-5-4): ref-mirror 同步最新 nodes/edges，供注册一次但需读最新拓扑的回调读取，消除 stale closure。
  // 不迁 useNodesState/useEdgesState 到 store（红线）——仅回调读取路径从闭包变量改为 ref.current。
  const nodesRef = useRef<TopologyNode[]>([])
  const edgesRef = useRef<TopologyEdge[]>([])
  const setToolbarState = useTopologyToolbarStore((s) => s.setToolbar)

  // FE-03: ref 同步 effect（O(1) 赋值，与既有 isLoadingRef/saveTimerRef 同模式，无性能影响）
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

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

  const loadTopology = useCallback(async (id: string) => {
    isLoadingRef.current = true
    const topo = await window.api.topology.getById(id)
    if (topo) {
      setNodes(topo.nodes || [])
      setEdges(topo.edges || [])
    }
    isLoadingRef.current = false
  }, [setNodes, setEdges])

  const fetchTopologies = useCallback(async () => {
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
    // Auto-select most recent topology if none selected
    if (list.length > 0) {
      setCurrentTopologyId(list[0].id)
      loadTopology(list[0].id)
    }
  }, [loadTopology])

  useEffect(() => {
    fetchTopologies()
  }, [fetchTopologies])

  const handleTopologyChange = useCallback((id: string | null) => {
    // D-06 复位：切换拓扑即丢弃未保存预览（防误离开拦截在 TopologyToolbar，T-26-03-03）
    if (previewRef.current) {
      previewRef.current = false
      setIsLayoutPreviewing(false)
      layoutSnapshotRef.current = null
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
    setCurrentTopologyId(id)
    if (id) {
      loadTopology(id)
    } else {
      setNodes([])
      setEdges([])
    }
  }, [loadTopology, setNodes, setEdges])

  const saveTopology = useCallback(async () => {
    if (!currentTopologyId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    await window.api.topology.update(currentTopologyId, {
      nodes: nodesRef.current.map((n) => ({ ...n })),
      edges: edgesRef.current.map((e) => ({ ...e })),
    })
    message.success('保存成功')
  }, [currentTopologyId])

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

  // Phase 26 / D-09：整理布局——原位散开（无选中=全图，框选=仅选中节点，未选中坐标严格不变）
  // 成功进入预览态（挂起自动保存）；异常零副作用（preview 态不进入，画布未改动）
  const handleOrganizeLayout = useCallback(() => {
    const current = nodesRef.current
    if (current.length === 0) return
    try {
      const subset = selectedNodeIds.size > 0 ? [...selectedNodeIds] : undefined
      const positions = spreadLayout(
        current.map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          width: n.width ?? undefined,
          height: n.height ?? undefined,
        })),
        { subset }
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
    const topo = await window.api.topology.create({ name, nodes: [], edges: [] })
    await fetchTopologies()
    setCurrentTopologyId(topo.id)
    setNodes([])
    setEdges([])
    message.success('创建成功')
  }, [fetchTopologies, setNodes, setEdges])

  const handleDelete = useCallback(async () => {
    if (!currentTopologyId) return
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
  }, [currentTopologyId, fetchTopologies, setNodes, setEdges])

  const handleImport = useCallback(async (jsonStr: string) => {
    try {
      const topo = await window.api.topology.importJson(jsonStr)
      await fetchTopologies()
      setCurrentTopologyId(topo.id)
      if (topo.nodes) setNodes(topo.nodes)
      if (topo.edges) setEdges(topo.edges)
      message.success('导入成功')
    } catch {
      message.error('导入失败')
    }
  }, [fetchTopologies, setNodes, setEdges])

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
      snapEnabled,
      onToggleSnap: () => setSnapEnabled((v) => !v),
      isLayoutPreviewing,
    })
    return () => setToolbarState(null)
  }, [topologies, currentTopologyId, handleTopologyChange, handleNew, saveTopology, handleDelete, handleImport, handleExport, handleOrganizeLayout, snapEnabled, isLayoutPreviewing, setToolbarState])

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

  const handleNodeDoubleClick = useCallback(async (_nodeId: string, data: TopologyNodeData) => {
    try {
      const connType: ConnectionType = data.connectionType || 'ssh'
      if (connType === 'web') {
        const device = await window.api.device.getById(data.deviceId)
        if (device?.webUrl) {
          await window.api.connection.openWeb(device.webUrl)
        } else {
          message.warning('该设备未配置 Web 地址')
        }
      } else if (connType === 'telnet') {
        await window.api.connection.telnetConnect(data.deviceId)
      } else if (connType === 'rdp') {
        await window.api.connection.rdpConnect(data.deviceId)
      } else {
        await window.api.connection.sshConnect(data.deviceId)
      }
    } catch {
      message.error('连接失败')
    }
  }, [])

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
        await window.api.device.update(updatedData.deviceId, {
          name: updatedData.deviceName,
          ipAddress: updatedData.ipAddress,
          deviceType: updatedData.deviceType,
          vendor: updatedData.vendor,
          model: updatedData.model,
        } as unknown as UpdateDeviceDTO)
        // 成功后再镜像本地节点（值与 service 落库一致，debounce 回写不产生冲突数据）
        setNodes((nds) =>
          nds.map((n) =>
            n.data.deviceId === updatedData.deviceId ? { ...n, data: updatedData } : n
          )
        )
        setEditModalOpen(false)
        setEditingNodeData(null)
      } catch (e: unknown) {
        message.error('保存失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [setNodes]
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
        snapEnabled={snapEnabled}
        viewportCenterRef={viewportCenterRef}
        nodesRef={nodesRef}
        onGuideSnap={handleGuideSnap}
        onPushAside={handlePushAside}
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
        existingNodes={nodes}
        getViewportCenter={() => ({ ...viewportCenterRef.current })}
        onConfirm={handleAddDevices}
        onCancel={() => setAddDeviceOpen(false)}
      />
      <DiscoveryPanel
        open={discoveryOpen}
        onCancel={() => setDiscoveryOpen(false)}
        onConfirm={handleDiscoveryConfirm}
      />
      <EditNodeModal
        open={editModalOpen}
        data={editingNodeData}
        onConfirm={handleEditConfirm}
        onCancel={() => { setEditModalOpen(false); setEditingNodeData(null) }}
      />
    </div>
  )
}
