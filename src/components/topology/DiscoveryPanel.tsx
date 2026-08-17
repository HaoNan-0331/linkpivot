import { useCallback, useEffect, useState } from 'react'
import {
  Modal,
  Select,
  Button,
  List,
  Tag,
  Spin,
  Alert,
  Space,
  Typography,
} from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import type { TopologyNode, TopologyEdge } from '@/types/topology'

interface DeviceOption {
  id: string
  name: string
  ipAddress: string
  connectionType: string
  vendor: string
}

interface FailedDevice {
  deviceId: string
  deviceName: string
  error: string
}

type Step = 'select' | 'collecting' | 'done'

interface DiscoveryPanelProps {
  open: boolean
  onCancel: () => void
  onConfirm: (nodes: TopologyNode[], edges: TopologyEdge[]) => void
}

export default function DiscoveryPanel({
  open,
  onCancel,
  onConfirm,
}: DiscoveryPanelProps) {
  const [devices, setDevices] = useState<DeviceOption[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [step, setStep] = useState<Step>('select')
  const [progress, setProgress] = useState('')
  const [resultNodes, setResultNodes] = useState<TopologyNode[]>([])
  const [resultEdges, setResultEdges] = useState<TopologyEdge[]>([])
  const [failedDevices, setFailedDevices] = useState<FailedDevice[]>([])
  const [error, setError] = useState('')

  const fetchDevices = useCallback(async () => {
    try {
      const list = await window.api.device.list()
      // Only show CLI devices (ssh/telnet)
      // Phase 19 / REN-02：(d: any)×2 → Device 强类型（device.list() 已返 Promise<Device[]>，照抄 useAIChat 收窄版写法）
      const cliDevices = list.filter(
        (d) => d.connectionType === 'ssh' || d.connectionType === 'telnet'
      )
      setDevices(
        cliDevices.map((d) => ({
          id: d.id,
          name: d.name,
          ipAddress: d.ipAddress,
          connectionType: d.connectionType,
          vendor: d.vendor || '未知',
        }))
      )
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchDevices()
      resetState()
    }
  }, [open, fetchDevices])

  const resetState = () => {
    setSelectedIds([])
    setStep('select')
    setProgress('')
    setResultNodes([])
    setResultEdges([])
    setFailedDevices([])
    setError('')
  }

  const handleStart = async () => {
    if (selectedIds.length === 0) return
    setStep('collecting')
    setProgress('正在采集设备信息...')
    setError('')

    try {
      const result = await window.api.ai.discoverTopology(selectedIds)
      setResultNodes(result.nodes || [])
      setResultEdges(result.edges || [])
      setFailedDevices(result.failedDevices || [])
      setStep('done')
    } catch (e: unknown) {
      // Phase 19 / REN-02：catch unknown + instanceof 窄化（OuiTab.tsx:71 范式），fallback 沿用原默认文案
      setError(e instanceof Error ? e.message : '拓扑发现失败')
      setStep('done')
    }
  }

  const handleConfirm = () => {
    onConfirm(resultNodes, resultEdges)
    resetState()
  }

  const handleCancel = () => {
    resetState()
    onCancel()
  }

  const renderFooter = () => {
    if (step === 'select') {
      return (
        <Space>
          <Button onClick={handleCancel}>取消</Button>
          <Button
            type="primary"
            icon={<SearchOutlined />}
            disabled={selectedIds.length === 0}
            onClick={handleStart}
          >
            开始发现
          </Button>
        </Space>
      )
    }

    if (step === 'collecting') {
      return (
        <Space>
          <Button onClick={handleCancel}>取消</Button>
        </Space>
      )
    }

    // step === 'done'
    return (
      <Space>
        <Button onClick={handleCancel}>取消</Button>
        {resultNodes.length > 0 && (
          <Button type="primary" onClick={handleConfirm}>
            确认并导入 ({resultNodes.length} 节点, {resultEdges.length} 连线)
          </Button>
        )}
      </Space>
    )
  }

  return (
    <Modal
      title="拓扑自动发现"
      open={open}
      onCancel={handleCancel}
      footer={renderFooter()}
      width={600}
      destroyOnHidden
    >
      {step === 'select' && (
        <>
          <Typography.Paragraph type="secondary">
            选择需要发现拓扑的设备（仅支持 SSH/Telnet 连接的设备）。系统将通过 SSH
            采集设备信息，并由 AI 分析设备间的连接关系。
          </Typography.Paragraph>
          <Select
            mode="multiple"
            placeholder="选择设备"
            style={{ width: '100%' }}
            value={selectedIds}
            onChange={setSelectedIds}
            options={devices.map((d) => ({
              label: `${d.name} (${d.ipAddress}) - ${d.vendor}`,
              value: d.id,
            }))}
          />
        </>
      )}

      {step === 'collecting' && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin size="large" />
          <Typography.Paragraph style={{ marginTop: 16 }}>
            {progress}
          </Typography.Paragraph>
        </div>
      )}

      {step === 'done' && (
        <>
          {error && (
            <Alert type="error" message="发现失败" description={error} showIcon style={{ marginBottom: 16 }} />
          )}

          {resultNodes.length > 0 && (
            <Alert
              type="success"
              message={`发现 ${resultNodes.length} 个节点、${resultEdges.length} 条连线`}
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          {resultNodes.length > 0 && (
            <>
              <Typography.Text strong>发现的节点：</Typography.Text>
              <List
                size="small"
                dataSource={resultNodes}
                style={{ maxHeight: 200, overflow: 'auto', marginBottom: 16 }}
                renderItem={(node) => (
                  <List.Item>
                    <Space>
                      <Tag color="blue">{node.data.deviceName}</Tag>
                      <Typography.Text type="secondary">
                        {node.data.ipAddress}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}

          {resultEdges.length > 0 && (() => {
            const nodeNameMap = new Map(resultNodes.map((n) => [n.id, n.data.deviceName]))
            return (
              <>
                <Typography.Text strong>发现的连线：</Typography.Text>
                <List
                  size="small"
                  dataSource={resultEdges}
                  style={{ maxHeight: 150, overflow: 'auto', marginBottom: 16 }}
                  renderItem={(edge) => (
                    <List.Item>
                      <Typography.Text>
                        {nodeNameMap.get(edge.source) || edge.source} → {nodeNameMap.get(edge.target) || edge.target}
                        {edge.data?.sourceInterface && (
                          <Typography.Text type="secondary">
                            {' '}
                            ({edge.data.sourceInterface} - {edge.data.targetInterface})
                          </Typography.Text>
                        )}
                      </Typography.Text>
                    </List.Item>
                  )}
                />
              </>
            )
          })()}

          {failedDevices.length > 0 && (
            <>
              <Typography.Text strong type="warning">
                失败的设备：
              </Typography.Text>
              <List
                size="small"
                dataSource={failedDevices}
                style={{ maxHeight: 150, overflow: 'auto' }}
                renderItem={(item) => (
                  <List.Item>
                    <Space>
                      <Tag color="error">{item.deviceName}</Tag>
                      <Typography.Text type="danger">{item.error}</Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
        </>
      )}
    </Modal>
  )
}
