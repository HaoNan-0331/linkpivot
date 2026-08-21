import { useEffect, useState } from 'react'
import { Form, Input, Select, InputNumber, Modal, Alert } from 'antd'
import type { Device, CreateDeviceDTO } from '../types/device'

interface Props {
  open: boolean
  device?: Device | null
  /** Phase 25（ASSET-01/D-01~D-03）：复制模式源设备——预填非凭证字段，凭证必填重输 */
  copySource?: Device | null
  /** Phase 25（D-13）：IP 分层比对用的现有设备列表（警告级，非硬拦） */
  existingDevices?: Device[]
  onOk: (values: CreateDeviceDTO) => void
  onCancel: () => void
}

export default function DeviceForm({ open, device, copySource, existingDevices, onOk, onCancel }: Props) {
  const [form] = Form.useForm()
  const connType = Form.useWatch('connectionType', form)
  const [confirmLoading, setConfirmLoading] = useState(false)
  const isCopy = !!copySource
  // 编辑或复制共用「回填源」；区别在凭证语义（编辑=留空不修改，复制=必填重输）
  const fillSource = device ?? copySource

  useEffect(() => {
    if (fillSource) {
      // H-1：编辑分支不回填 password/sshKeyContent（IPC 已脱敏为 ****尾4位，回填会把掩码串
      // 当真实值提交覆盖凭证）。编辑走「留空=不修改」（updateDevice 字段级 !== undefined 跳过）；
      // 复制模式（D-01）同样不回填——源凭证永远不出 main 进程，用户必填重输。
      form.setFieldsValue({
        name: fillSource.name, vendor: fillSource.vendor, model: fillSource.model, version: fillSource.version,
        ipAddress: fillSource.ipAddress, deviceType: fillSource.deviceType, connectionType: fillSource.connectionType,
        port: fillSource.port, username: fillSource.username, sshKeyPath: fillSource.sshKeyPath, webUrl: fillSource.webUrl,
      })
    } else {
      form.resetFields()
    }
  }, [fillSource, form, open])

  // D-11/D-12：名称失焦实时查重（编辑模式 excludeId=自身；复制/新建 excludeId=undefined）。
  // 命中注入红框错误，错误信息含冲突设备名称与 IP（提示性预检，硬防线在 service 层事务内拦截）。
  const handleNameBlur = async (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.target.value?.trim()
    if (!value) return
    try {
      const hit = await window.api.device.checkName(value, device?.id)
      if (hit) {
        form.setFields([{ name: 'name', errors: [`名称已存在：${hit.name} (${hit.ipAddress})`] }])
      } else {
        form.setFields([{ name: 'name', errors: [] }])
      }
    } catch {
      // 查重通道异常不阻塞表单（提示性预检），提交时 service 层仍会硬拦
    }
  }

  // D-13 分层（警告级）：IP 与「其他设备」（非编辑自身、非复制源）相同 = 黄色警告可保存。
  const handleIpBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.target.value?.trim()
    if (!value || !existingDevices) return
    const dup = existingDevices.find((d) => d.ipAddress === value && d.id !== device?.id && d.id !== copySource?.id)
    if (dup) {
      form.setFields([{ name: 'ipAddress', warnings: [`IP 与设备『${dup.name}』相同，请确认是否允许`] }])
    } else {
      form.setFields([{ name: 'ipAddress', warnings: [] }])
    }
  }

  const handleFinish = async (values: CreateDeviceDTO) => {
    setConfirmLoading(true)
    try {
      await onOk(values)
    } finally {
      setConfirmLoading(false)
    }
  }

  return (
    <Modal title={device ? '编辑设备' : isCopy ? '复制设备' : '添加设备'} open={open} onOk={() => form.submit()} onCancel={onCancel} width={600} destroyOnHidden confirmLoading={confirmLoading}>
      {isCopy && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`复制自『${copySource!.name}』`} description="已预填源设备信息（可修改）；密码/密钥不会继承，请重新输入。" />
      )}
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item name="name" label="设备名称" rules={[{ required: true, message: '请输入设备名称' }]}>
          <Input onBlur={handleNameBlur} />
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
        <Form.Item
          name="ipAddress"
          label="设备 IP"
          rules={[
            { required: true },
            // D-13 硬拦：复制件与源设备同 IP 必改（红级，validator 阻断提交）
            ...(isCopy
              ? [{
                  validator: (_: unknown, value: string) =>
                    value && value === copySource!.ipAddress
                      ? Promise.reject(new Error('与源设备 IP 相同，必须修改'))
                      : Promise.resolve(),
                }]
              : []),
          ]}
        >
          <Input placeholder="192.168.1.1" onBlur={handleIpBlur} />
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
              <Form.Item
                name="password"
                label="密码"
                style={{ flex: 1 }}
                // D-01：复制模式凭证必填重输；编辑模式保持 H-1「留空=不修改」
                rules={isCopy ? [{ required: true, message: '复制件不继承源设备密码，必填重输' }] : undefined}
              >
                <Input.Password placeholder={isCopy ? '必填重输（复制件不继承源设备密码）' : device ? '留空则不修改' : undefined} />
              </Form.Item>
            </div>
            {connType === 'ssh' && (
              <>
                <Form.Item name="sshKeyPath" label="SSH Key 文件路径">
                  <Input placeholder="C:/Users/.ssh/id_rsa（可选）" />
                </Form.Item>
                <Form.Item
                  name="sshKeyContent"
                  label="或粘贴 SSH Key 内容"
                  // D-01：复制模式凭证必填重输（密码与 Key 均不预填不继承）
                  rules={isCopy ? [{ required: true, message: '复制件不继承源设备密钥，必填重输' }] : undefined}
                >
                  <Input.TextArea rows={3} placeholder={isCopy ? '必填重输（复制件不继承源设备密钥）' : device ? '留空则不修改；粘贴新内容将覆盖' : '-----BEGIN OPENSSH PRIVATE KEY-----...（可选）'} />
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
