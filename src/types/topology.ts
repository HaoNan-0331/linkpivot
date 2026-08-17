import { Node, Edge } from 'reactflow'
import { DeviceType, ConnectionType } from './device'

export interface TopologyNodeData {
  deviceId: string
  deviceName: string
  deviceType: DeviceType
  connectionType: ConnectionType
  ipAddress: string
  vendor?: string
  model?: string
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
