import { useCallback, useEffect, useRef, useState } from 'react'
import { useNodesState, useEdgesState, addEdge, type Connection } from 'reactflow'
import { Button, message } from 'antd'
import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import TopologyCanvas from '@/components/topology/TopologyCanvas'
import AddDeviceModal from '@/components/topology/AddDeviceModal'
import DiscoveryPanel from '@/components/topology/DiscoveryPanel'
import EditNodeModal from '@/components/topology/EditNodeModal'
import { useTopologyToolbarStore } from '@/stores/topologyToolbarStore'
import type { TopologyNode, TopologyNodeData, TopologyEdgeData, TopologyEdge, TopologySummary } from '@/types/topology'
import type { ConnectionType } from '@/types/device'

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
    const list = await window.api.topology.list()
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

  useEffect(() => {
    if (isLoadingRef.current) return
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
    })
    return () => setToolbarState(null)
  }, [topologies, currentTopologyId, handleTopologyChange, handleNew, saveTopology, handleDelete, handleImport, handleExport, setToolbarState])

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

  const handleEditConfirm = useCallback(
    (updatedData: TopologyNodeData) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.data.deviceId === updatedData.deviceId ? { ...n, data: updatedData } : n
        )
      )
      setEditModalOpen(false)
      setEditingNodeData(null)
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
