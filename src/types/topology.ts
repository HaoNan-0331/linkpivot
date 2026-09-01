import { Node, Edge } from 'reactflow'
import { DeviceType, ConnectionType } from './device'

export interface TopologyNodeData {
  deviceId: string
  deviceName: string
  deviceType: DeviceType
  // WR-01（36 review）：节点快照对齐 Device.connectionType 可空——服务层 topoFields 级联以
  // D-09 滑落终值刷新（全 off → NULL），快照运行时本可持有 null；消费点（TopologyPage 零通道
  // 引导 data.connectionType || 'ssh'）已 null 安全。
  connectionType: ConnectionType | null
  ipAddress: string
  vendor?: string
  model?: string
  // Phase 39（39-01，P14 兼容先例同 TopologySummary）：未纳管标志——历史持久化 JSON
  // 缺字段即 undefined = 已纳管语义；标志随 topology.update 整图持久化，纳管回写
  // （adoptNodeToDevice）置 undefined 省键——JSON.stringify 丢 undefined 键，落库
  // 即历史形态无脏数据。本 phase 仅落类型与写入点，渲染消费（虚线边框+徽标）归 39-03。
  unmanaged?: boolean
}

export type TopologyNode = Node<TopologyNodeData>

export interface TopologyEdgeData {
  sourceInterface: string
  targetInterface: string
}

export type TopologyEdge = Edge<TopologyEdgeData>

/**
 * Phase 19 / REN-02（P14）：拓扑列表摘要强类型——全字段 optional。
 * 持久化历史 JSON 可能缺字段（Topology 全必填不适配），消费组件（TopologyPage 列表）
 * 仅读 id/name，optional 化兼容旧数据；运行时未识别字段由消费侧 D-08 console.warn 可观测。
 */
export interface TopologySummary {
  id?: string
  name?: string
  status?: 'active' | 'pending' | 'draft'
  createdAt?: string
  updatedAt?: string
}

export interface Topology {
  id: string
  name: string
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  status: 'active' | 'pending' | 'draft'
  createdAt: string
  updatedAt: string
}
