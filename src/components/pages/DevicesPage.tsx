import { useState, useEffect } from 'react'
import { Table, Button, Space, Popconfirm, message, Typography } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined } from '@ant-design/icons'
import DeviceForm from '../DeviceForm'
import type { Device, CreateDeviceDTO } from '../../types/device'

const { Title } = Typography

const deviceTypeLabels: Record<string, string> = {
  router: '路由器', switch: '交换机', firewall: '防火墙', server: '服务器', generic: '通用',
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Device | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try { setDevices(await window.api.device.list()) } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleCreate = async (values: CreateDeviceDTO) => {
    try {
      await window.api.device.create(values)
      message.success('设备添加成功')
      setFormOpen(false); load()
    } catch (e: unknown) {
      message.error(`添加失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleUpdate = async (values: CreateDeviceDTO) => {
    if (!editing) return
    // H-1：编辑时密码/Key 留空（''/undefined）= 不修改——从 payload 剔除，
    // updateDevice 的 `!== undefined` 字段级跳过语义生效，不误清空已有凭证。
    const payload: Record<string, unknown> = { ...values }
    if (!payload.password) delete payload.password
    if (!payload.sshKeyContent) delete payload.sshKeyContent
    try {
      await window.api.device.update(editing.id, payload as unknown as CreateDeviceDTO)
      message.success('设备更新成功')
      setEditing(null); setFormOpen(false); load()
    } catch (e: unknown) {
      message.error(`更新失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleDelete = async (id: string) => {
    await window.api.device.delete(id)
    message.success('设备删除成功')
    load()
  }

  const handleTest = async (device: Device) => {
    setTestingId(device.id)
    try {
      const result = await window.api.connection.test(device.id)
      if (result.success) {
        message.success(`${device.name}: ${result.message}`)
      } else {
        message.error(`${device.name}: ${result.message}`)
      }
    } catch (e: unknown) {
      message.error(`${device.name}: 测试失败 - ${e instanceof Error ? e.message : String(e)}`)
    }
    setTestingId(null)
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>设备管理</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true) }}>添加设备</Button>
      </div>
      <Table columns={[
        { title: '设备名称', dataIndex: 'name', key: 'name' },
        { title: '类型', dataIndex: 'deviceType', key: 'deviceType', render: (v: string) => deviceTypeLabels[v] || v },
        { title: '厂商', dataIndex: 'vendor', key: 'vendor' },
        { title: '型号', dataIndex: 'model', key: 'model' },
        { title: 'IP', dataIndex: 'ipAddress', key: 'ipAddress' },
        { title: '连接方式', dataIndex: 'connectionType', key: 'connectionType', render: (v: string) => v?.toUpperCase() },
        { title: '操作', key: 'action', render: (_: unknown, r: Device) => (
          <Space>
            <Button icon={<ApiOutlined />} type="text" loading={testingId === r.id} onClick={() => handleTest(r)} title="测试连接" />
            <Button icon={<EditOutlined />} type="text" onClick={() => { setEditing(r); setFormOpen(true) }} title="编辑" />
            <Popconfirm title="删除设备将同时从拓扑中移除，确定删除？" onConfirm={() => handleDelete(r.id)}>
              <Button icon={<DeleteOutlined />} type="text" danger title="删除" />
            </Popconfirm>
          </Space>
        )},
      ]} dataSource={devices} rowKey="id" loading={loading} pagination={false} />
      <DeviceForm open={formOpen} device={editing} onOk={editing ? handleUpdate : handleCreate}
        onCancel={() => { setFormOpen(false); setEditing(null) }} />
    </div>
  )
}
