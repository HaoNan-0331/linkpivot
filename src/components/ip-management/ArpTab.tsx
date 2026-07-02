import { useState, useEffect } from 'react'
import { Button, Table, Card, Collapse, Tag, message, Progress } from 'antd'
import { ReloadOutlined, ExportOutlined, CheckOutlined } from '@ant-design/icons'
import type { ElectronAPI, ARPBatchStats } from '@/types/electron'
import type { Device } from '@/types/device'
import type { ARPEntry, ARPCollectionResult } from '@/types/arp'

interface ArpTabProps { api: ElectronAPI }

// collectSelected 自建的聚合统计（仅 entries，无 changes/deprecated）
interface SelectedStats {
  entries: number
}

export default function ArpTab({ api }: ArpTabProps) {
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<ARPCollectionResult[]>([])
  const [stats, setStats] = useState<ARPBatchStats | SelectedStats | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([])
  const [selectOpen, setSelectOpen] = useState(false)

  useEffect(() => {
    api.device.list().then((list) => {
      setDevices(list.filter((d) => d.connectionType === 'ssh' || d.connectionType === 'telnet'))
    })
  }, [])

  const collectAll = async () => {
    setLoading(true)
    try {
      const res = await api.arp.collectFromAll()
      setResults(res.results || [])
      setStats(res.stats || null)
      message.success(`采集完成: ${res.results?.length || 0} 台设备, ${res.stats?.entries || 0} 条记录`)
    } catch (e: unknown) {
      message.error('采集失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setLoading(false) }
  }

  const collectSelected = async () => {
    if (selectedDeviceIds.length === 0) { message.warning('请先选择设备'); return }
    setLoading(true)
    setResults([])
    setStats(null)
    try {
      const allResults: ARPCollectionResult[] = []
      let totalEntries = 0
      for (const deviceId of selectedDeviceIds) {
        const result = await api.arp.collectFromDevice(deviceId)
        allResults.push(result)
        if (result.entries?.length) totalEntries += result.entries.length
      }
      setResults(allResults)
      // 逐设备采集无聚合变更/弃用统计，仅设 entries（changes/deprecated 显示为 '-'）
      setStats({ entries: totalEntries })
      message.success(`采集完成: ${allResults.length} 台设备, ${totalEntries} 条记录`)
    } catch (e: unknown) {
      message.error('采集失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setLoading(false) }
  }

  const exportArp = async () => {
    try {
      const path = await api.export.arpTable()
      if (path) message.success('导出成功: ' + path)
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
  }

  const toggleDevice = (id: string) => {
    setSelectedDeviceIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const selectAll = () => setSelectedDeviceIds(devices.map((d) => d.id))
  const clearSelection = () => setSelectedDeviceIds([])

  const columns = [
    { title: 'IP 地址', dataIndex: 'ip', key: 'ip' },
    { title: 'MAC 地址', dataIndex: 'mac', key: 'mac' },
    { title: 'VLAN', dataIndex: 'vlan', key: 'vlan' },
    { title: '接口', dataIndex: 'interface', key: 'interface' },
  ]

  const deviceColumns = [
    {
      title: '', key: 'select', width: 40,
      render: (_: unknown, record: Device) => (
        <input type="checkbox" checked={selectedDeviceIds.includes(record.id)}
          onChange={() => toggleDevice(record.id)} />
      ),
    },
    { title: '设备名称', dataIndex: 'name', key: 'name' },
    { title: 'IP', dataIndex: 'ipAddress', key: 'ipAddress' },
    {
      title: '厂商', dataIndex: 'vendor', key: 'vendor',
      render: (v: string) => v || '-'
    },
    {
      title: '连接', dataIndex: 'connectionType', key: 'connectionType',
      render: (v: string) => <Tag>{v?.toUpperCase()}</Tag>
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button type="primary" icon={<ReloadOutlined />} loading={loading} onClick={collectAll}>全部采集</Button>
        <Button icon={<CheckOutlined />} loading={loading} onClick={collectSelected}
          disabled={selectedDeviceIds.length === 0}>
          采集选中 ({selectedDeviceIds.length})
        </Button>
        <Button onClick={() => setSelectOpen(!selectOpen)}>
          {selectOpen ? '收起设备列表' : '选择设备'}
        </Button>
        <Button icon={<ExportOutlined />} onClick={exportArp} disabled={results.length === 0}>导出 ARP 表</Button>
      </div>

      {selectOpen && (
        <Card size="small" title="设备列表" style={{ marginBottom: 16 }}
          extra={<span><a onClick={selectAll}>全选</a> | <a onClick={clearSelection}>清空</a></span>}>
          <Table dataSource={devices} columns={deviceColumns} rowKey="id" size="small"
            pagination={false} />
        </Card>
      )}

      {loading && <Progress percent={100} status="active" style={{ marginBottom: 16 }} />}

      {stats && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <span>设备: {results.length} | ARP条目: {stats.entries} | 异常变更: {'changes' in stats ? stats.changes : '-'} | 弃用IP: {'deprecated' in stats ? stats.deprecated : '-'}</span>
        </Card>
      )}

      <Collapse items={results.map((r, idx: number) => ({
        key: idx,
        label: (
          <span>
            {r.deviceName} ({r.deviceIp})
            {r.error ? <Tag color="red" style={{ marginLeft: 8 }}>失败</Tag> :
              <Tag color="green" style={{ marginLeft: 8 }}>{r.entries?.length || 0} 条</Tag>}
          </span>
        ),
        children: r.error ? (
          <Tag color="red">{r.error}</Tag>
        ) : (
          <Table dataSource={r.entries || []} columns={columns}
            rowKey={(row: ARPEntry) => `${row.ip}-${row.mac}`} size="small" pagination={false} />
        ),
      }))} />
    </div>
  )
}
