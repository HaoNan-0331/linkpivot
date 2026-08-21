import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Modal, Space, Table, Tag, Typography, message } from 'antd'
import type { Device, CreateDeviceDTO } from '../types/device'

const { Text } = Typography

const MAX_BATCH = 50

interface BatchRow {
  key: number
  name: string
  ipAddress: string
}

interface Props {
  open: boolean
  source: Device | null
  onClose: () => void
  onCreated: () => void
}

// Phase 25（ASSET-02/D-04~D-07）：批量复制 N 份（1-50）——上半逐行编辑名称/IP 表格，
// 下半单凭证区一套（用户本次主动输入，不继承源设备凭证，D-01/D-04）。
// 行内强制人工命名：与源同名/批内互重标红「⚠同名」，IP 同理标「⚠同IP」，
// 任一行违规提交按钮 disabled；不做自动后缀（D-05）。
export default function DeviceBatchForm({ open, source, onClose, onCreated }: Props) {
  const [count, setCount] = useState(1)
  const [rows, setRows] = useState<BatchRow[]>([])
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  // open 且有源时初始化行数组（1 行，预填源名称/IP）
  const initialize = (n: number, src: Device) => {
    setRows(Array.from({ length: n }, (_, i) => ({ key: i, name: src.name, ipAddress: src.ipAddress })))
  }

  // source 变化 / open 打开时重置；份数变化时重建（保留已改行值会引入复杂度，重建即重置，语义清晰）
  useEffect(() => {
    if (open && source) {
      setCount(1)
      initialize(1, source)
      form.resetFields()
      form.setFieldsValue({ username: source.username })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source])

  const handleCountChange = (n: number | null) => {
    const next = n ?? 1
    setCount(next)
    if (source) initialize(next, source)
  }

  const updateRow = (key: number, field: 'name' | 'ipAddress', value: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)))
  }

  // 归一化与后端 deviceName.ts 对齐：toLowerCase().trim()（提示性比对，硬防线在 service 层）
  const norm = (s: string) => (s ?? '').trim().toLowerCase()

  const rowFlags = useMemo(() => {
    if (!source) return new Map<number, { dupName: boolean; dupIp: boolean }>()
    const flags = new Map<number, { dupName: boolean; dupIp: boolean }>()
    rows.forEach((r) => {
      const n = norm(r.name)
      const ip = norm(r.ipAddress)
      // 与源同名/同 IP，或批内互重（归一化后出现次数 > 1）
      const nameCount = rows.filter((o) => norm(o.name) === n).length
      const ipCount = rows.filter((o) => norm(o.ipAddress) === ip).length
      flags.set(r.key, {
        dupName: (!!n && n === norm(source.name)) || (!!n && nameCount > 1),
        dupIp: (!!ip && ip === norm(source.ipAddress)) || (!!ip && ipCount > 1),
      })
    })
    return flags
  }, [rows, source])

  const hasViolation = useMemo(
    () => Array.from(rowFlags.values()).some((f) => f.dupName || f.dupIp) || rows.some((r) => !r.name.trim() || !r.ipAddress.trim()),
    [rowFlags, rows],
  )

  const handleSave = async (values: { username?: string; password?: string; sshKeyPath?: string; sshKeyContent?: string }) => {
    if (!source || hasViolation) return
    const items: CreateDeviceDTO[] = rows.map((r) => ({
      name: r.name.trim(),
      ipAddress: r.ipAddress.trim(),
      vendor: source.vendor, model: source.model, version: source.version,
      deviceType: source.deviceType, connectionType: source.connectionType,
      port: source.port ?? undefined, webUrl: source.webUrl || undefined,
      username: values.username, password: values.password,
      sshKeyPath: values.sshKeyPath, sshKeyContent: values.sshKeyContent,
    }))
    setSaving(true)
    try {
      await window.api.device.createBatch(items)
      message.success(`批量复制成功：${items.length} 份已创建`)
      onClose()
      onCreated()
    } catch (e: unknown) {
      // D-06：服务层事务全回滚，失败保持 Modal 打开供修正后重交
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!source) return null

  return (
    <Modal
      title={`批量复制设备（源：${source.name}）`}
      open={open}
      onCancel={onClose}
      width={720}
      destroyOnHidden
      footer={null}
    >
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`复制自『${source.name}』`} description="每份设备需人工命名/配 IP；源设备凭证不会继承，请在下方统一重新输入。" />
      <div style={{ marginBottom: 16 }}>
        <Space>
          <Text>复制份数</Text>
          <InputNumber min={1} max={MAX_BATCH} value={count} onChange={handleCountChange} />
          <Text type="secondary">（1-{MAX_BATCH}，变更份数将重置表格）</Text>
        </Space>
      </div>
      <Table
        size="small"
        pagination={false}
        dataSource={rows}
        rowKey="key"
        columns={[
          { title: '#', width: 40, render: (_: unknown, __: BatchRow, i: number) => i + 1 },
          {
            title: '名称 *',
            render: (_: unknown, r: BatchRow) => (
              <Space.Compact style={{ width: '100%' }}>
                <Input value={r.name} onChange={(e) => updateRow(r.key, 'name', e.target.value)} status={rowFlags.get(r.key)?.dupName ? 'error' : undefined} />
                {rowFlags.get(r.key)?.dupName && <Tag color="error">⚠同名</Tag>}
              </Space.Compact>
            ),
          },
          {
            title: 'IP *',
            render: (_: unknown, r: BatchRow) => (
              <Space.Compact style={{ width: '100%' }}>
                <Input value={r.ipAddress} onChange={(e) => updateRow(r.key, 'ipAddress', e.target.value)} status={rowFlags.get(r.key)?.dupIp ? 'error' : undefined} />
                {rowFlags.get(r.key)?.dupIp && <Tag color="error">⚠同IP</Tag>}
              </Space.Compact>
            ),
          },
        ]}
      />
      <Form form={form} layout="vertical" onFinish={handleSave} style={{ marginTop: 16 }}>
        <Text strong>凭证（全部 {rows.length} 份共用，不继承源设备）</Text>
        <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
          <Form.Item name="username" label="账号" style={{ flex: 1 }} initialValue={source.username}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="密码" style={{ flex: 1 }} rules={[{ required: true, message: '必填（复制件不继承源设备密码）' }]}>
            <Input.Password placeholder="必填重输（复制件不继承源设备密码）" />
          </Form.Item>
        </div>
        {source.connectionType === 'ssh' && (
          <>
            <Form.Item name="sshKeyPath" label="SSH Key 文件路径">
              <Input placeholder="C:/Users/.ssh/id_rsa（可选）" />
            </Form.Item>
            <Form.Item name="sshKeyContent" label="或粘贴 SSH Key 内容" rules={[{ required: true, message: '必填重输（复制件不继承源设备密钥）' }]}>
              <Input.TextArea rows={3} placeholder="必填重输（复制件不继承源设备密钥）" />
            </Form.Item>
          </>
        )}
        <Button type="primary" htmlType="submit" disabled={hasViolation} loading={saving} block>
          批量保存 {rows.length} 份{hasViolation ? '（存在同名/同IP行，请修正）' : ''}
        </Button>
      </Form>
    </Modal>
  )
}
