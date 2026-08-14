import { useEffect, useState } from 'react'
import { Form, Input, Select, InputNumber, Modal } from 'antd'
import type { Device, CreateDeviceDTO } from '../types/device'

interface Props {
  open: boolean
  device?: Device | null
  onOk: (values: CreateDeviceDTO) => void
  onCancel: () => void
}

export default function DeviceForm({ open, device, onOk, onCancel }: Props) {
  const [form] = Form.useForm()
  const connType = Form.useWatch('connectionType', form)
  const [confirmLoading, setConfirmLoading] = useState(false)

  useEffect(() => {
    if (device) {
      // H-1：编辑分支不回填 password/sshKeyContent（IPC 已脱敏为 ****尾4位，回填会把掩码串
      // 当真实值提交覆盖凭证）。走「留空=不修改」语义（updateDevice 字段级 !== undefined 跳过）。
      form.setFieldsValue({
        name: device.name, vendor: device.vendor, model: device.model, version: device.version,
        ipAddress: device.ipAddress, deviceType: device.deviceType, connectionType: device.connectionType,
        port: device.port, username: device.username, sshKeyPath: device.sshKeyPath, webUrl: device.webUrl,
      })
    } else {
      form.resetFields()
    }
  }, [device, form, open])

  const handleFinish = async (values: CreateDeviceDTO) => {
    setConfirmLoading(true)
    try {
      await onOk(values)
    } finally {
      setConfirmLoading(false)
    }
  }

  return (
    <Modal title={device ? '编辑设备' : '添加设备'} open={open} onOk={() => form.submit()} onCancel={onCancel} width={600} destroyOnHidden confirmLoading={confirmLoading}>
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item name="name" label="设备名称" rules={[{ required: true, message: '请输入设备名称' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="deviceType" label="设备类型" rules={[{ required: true }]}>
          <Select options={[
            { value: 'router', label: '路由器' },
            { value: 'switch', label: '交换机' },
            { value: 'firewall', label: '防火墙' },
            { value: 'server', label: '服务器' },
            { value: 'generic', label: '通用设备' },
          ]} />
        </Form.Item>
        <Form.Item name="vendor" label="厂商" rules={[{ required: true, message: '请输入设备厂商' }]}>
          <Input placeholder="华为、Cisco、H3C..." />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="model" label="型号" style={{ flex: 1 }}>
            <Input placeholder="S5735-L48T4X" />
          </Form.Item>
          <Form.Item name="version" label="版本" style={{ flex: 1 }}>
            <Input placeholder="V200R021" />
          </Form.Item>
        </div>
        <Form.Item name="ipAddress" label="设备 IP" rules={[{ required: true }]}>
          <Input placeholder="192.168.1.1" />
        </Form.Item>
        <Form.Item name="connectionType" label="连接方式" rules={[{ required: true }]}>
          <Select options={[
            { value: 'ssh', label: 'SSH' },
            { value: 'telnet', label: 'Telnet' },
            { value: 'web', label: 'Web 界面' },
            { value: 'rdp', label: 'RDP 远程桌面' },
          ]} />
        </Form.Item>
        {connType !== 'web' && (
          <>
            <Form.Item name="port" label="端口">
              <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder={connType === 'ssh' ? '22' : connType === 'rdp' ? '3389' : '23'} />
            </Form.Item>
            <div style={{ display: 'flex', gap: 16 }}>
              <Form.Item name="username" label="账号" style={{ flex: 1 }}><Input /></Form.Item>
              <Form.Item name="password" label="密码" style={{ flex: 1 }}><Input.Password placeholder={device ? '留空则不修改' : undefined} /></Form.Item>
            </div>
            {connType === 'ssh' && (
              <>
                <Form.Item name="sshKeyPath" label="SSH Key 文件路径">
                  <Input placeholder="C:/Users/.ssh/id_rsa（可选）" />
                </Form.Item>
                <Form.Item name="sshKeyContent" label="或粘贴 SSH Key 内容">
                  <Input.TextArea rows={3} placeholder={device ? '留空则不修改；粘贴新内容将覆盖' : '-----BEGIN OPENSSH PRIVATE KEY-----...（可选）'} />
                </Form.Item>
              </>
            )}
          </>
        )}
        {connType === 'web' && (
          <Form.Item name="webUrl" label="Web URL" rules={[{ required: true }]}>
            <Input placeholder="https://192.168.1.1" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}
