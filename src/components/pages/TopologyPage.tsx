import { useCallback, useEffect, useRef, useState } from 'react'
import { useNodesState, useEdgesState, addEdge, type Connection } from 'reactflow'
import { Button, message } from 'antd'
import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import TopologyCanvas from '@/components/topology/TopologyCanvas'
import AddDeviceModal from '@/components/topology/AddDeviceModal'
import DiscoveryPanel from '@/components/topology/DiscoveryPanel'
import EditNodeModal from '@/components/topology/EditNodeModal'
import { useTopologyToolbarStore } from '@/stores/topologyToolbarStore'
import type { TopologyNode, TopologyNodeData, TopologyEdgeData, TopologyEdge } from '@/types/topology'
import type { ConnectionType } from '@/types/device'

export default function TopologyPage() {
  const [topologies, setTopologies] = useState<any[]>([])
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
  const setToolbarState = useTopologyToolbarStore((s) => s.setToolbar)

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
      nodes: nodes.map((n) => ({ ...n })),
      edges: edges.map((e) => ({ ...e })),
    })
    message.success('保存成功')
  }, [currentTopologyId, nodes, edges])

  const debouncedSave = useCallback(() => {
    if (!currentTopologyId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      window.api.topology.update(currentTopologyId, {
        nodes: nodes.map((n) => ({ ...n })),
        edges: edges.map((e) => ({ ...e })),
      })
    }, 1000)
  }, [currentTopologyId, nodes, edges])

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
    await window.api.topology.delete(currentTopologyId)
    setCurrentTopologyId(null)
    setNodes([])
    setEdges([])
    await fetchTopologies()
    message.success('删除成功')
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
      // Merge discovered nodes (skip duplicates by deviceId)
      const existingIds = new Set(nodes.map((n) => n.data.deviceId))
      const newNodes = discoveredNodes.filter((n) => !existingIds.has(n.data.deviceId))
      setNodes((nds) => [...nds, ...newNodes])

      // Merge discovered edges (skip duplicates by source+target)
      const existingEdgeKeys = new Set(
        edges.map((e) => `${e.source}->${e.target}`)
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
    [nodes, edges, setNodes, setEdges]
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
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) return
    setEditingNodeData(node.data)
    setEditModalOpen(true)
  }, [selectedNodeIds, nodes])

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
