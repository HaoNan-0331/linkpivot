import { useCallback, useRef, useState } from 'react'
import ReactFlow, {
  Controls,
  MiniMap,
  Background,
  type Connection,
  type OnNodesChange,
  type OnEdgesChange,
  BackgroundVariant,
} from 'reactflow'
import type { TopologyNode, TopologyEdge, TopologyNodeData } from '@/types/topology'
import DeviceNode from './DeviceNode'
import EdgeWithInterfaces from './EdgeWithInterfaces'
import ConnectionModal from './ConnectionModal'
import SelectionToolbar from './SelectionToolbar'

const nodeTypes = { deviceNode: DeviceNode }
const edgeTypes = { edgeWithInterfaces: EdgeWithInterfaces }

interface TopologyCanvasProps {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  onConnect?: (connection: Connection, sourceInterface: string, targetInterface: string) => void
  onNodeDoubleClick?: (nodeId: string, data: TopologyNodeData) => void
  onDeleteSelected?: () => void
  onEditSelectedNode?: () => void
  onSelectionChange?: (nodeIds: string[], edgeIds: string[]) => void
  snapEnabled?: boolean
}

export default function TopologyCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeDoubleClick,
  onDeleteSelected,
  onEditSelectedNode,
  onSelectionChange,
  snapEnabled = false,
}: TopologyCanvasProps) {
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedNodes, setSelectedNodes] = useState<TopologyNode[]>([])
  const [selectedEdges, setSelectedEdges] = useState<TopologyEdge[]>([])
  const pendingConnection = useRef<Connection | null>(null)

  const handleConnect = useCallback((connection: Connection) => {
    pendingConnection.current = connection
    setModalOpen(true)
  }, [])

  const handleModalConfirm = useCallback(
    (sourceInterface: string, targetInterface: string) => {
      if (pendingConnection.current && onConnect) {
        onConnect(pendingConnection.current, sourceInterface, targetInterface)
      }
      pendingConnection.current = null
      setModalOpen(false)
    },
    [onConnect]
  )

  const handleModalCancel = useCallback(() => {
    pendingConnection.current = null
    setModalOpen(false)
  }, [])

  const handleSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: { nodes: TopologyNode[]; edges: TopologyEdge[] }) => {
      setSelectedNodes(selNodes)
      setSelectedEdges(selEdges)
      onSelectionChange?.(selNodes.map((n) => n.id), selEdges.map((e) => e.id))
    },
    [onSelectionChange]
  )

  const sourceDeviceName = nodes.find((n) => n.id === pendingConnection.current?.source)?.data?.deviceName
  const targetDeviceName = nodes.find((n) => n.id === pendingConnection.current?.target)?.data?.deviceName

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeDoubleClick={(_event, node) => {
          onNodeDoubleClick?.(node.id, node.data)
        }}
        onSelectionChange={handleSelectionChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        snapToGrid={snapEnabled}
        snapGrid={[20, 20]}
        fitView
        defaultEdgeOptions={{
          type: 'edgeWithInterfaces',
        }}
      >
        <Controls />
        <MiniMap
          nodeStrokeColor="#888"
          nodeColor="#e6f7ff"
          nodeBorderRadius={8}
        />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <SelectionToolbar
          selectedNodes={selectedNodes}
          selectedEdges={selectedEdges}
          allNodes={nodes}
          onDelete={onDeleteSelected || (() => {})}
          onEdit={onEditSelectedNode || (() => {})}
        />
      </ReactFlow>
      <ConnectionModal
        open={modalOpen}
        sourceDeviceName={sourceDeviceName}
        targetDeviceName={targetDeviceName}
        onConfirm={handleModalConfirm}
        onCancel={handleModalCancel}
      />
    </div>
  )
}
