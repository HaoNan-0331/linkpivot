import { memo, useEffect } from 'react'
import { Modal, Input, Select, Form } from 'antd'
import type { TopologyNodeData } from '@/types/topology'
import type { DeviceType } from '@/types/device'
// WR-05（38 review）：类型下拉 options 自 types/device.ts DEVICE_TYPE_LABELS 派生（全局唯一表）
import { DEVICE_TYPE_OPTIONS } from '@/types/device'

interface EditNodeModalProps {
  open: boolean
  data: TopologyNodeData | null
  onConfirm: (updated: TopologyNodeData) => void
  onCancel: () => void
}

interface FormValues {
  deviceName: string
  ipAddress: string
  deviceType: DeviceType
  vendor: string
  model: string
}

function EditNodeModal({
  open,
  data,
  onConfirm,
  onCancel,
}: EditNodeModalProps) {
  const [form] = Form.useForm<FormValues>()

  useEffect(() => {
    if (open && data) {
      form.setFieldsValue({
        deviceName: data.deviceName,
        ipAddress: data.ipAddress,
        deviceType: data.deviceType,
        vendor: data.vendor || '',
        model: data.model || '',
      })
    }
  }, [open, data, form])

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      onConfirm({
        ...data!,
        deviceName: values.deviceName,
        ipAddress: values.ipAddress,
        deviceType: values.deviceType,
        // CR-01（25.1）：保留空串——空串=清空（service 层 `!== undefined` 守卫会真实落库），
        // undefined=不修改。禁止折叠为 undefined，否则清空 vendor/model 时 devices 表保留旧值，
        // 而本地 setNodes 与拓扑 debounce 落空值，拓扑与设备页分叉。name/ipAddress 必填不受影响。
        vendor: values.vendor,
        model: values.model,
      })
    } catch {
      // validation failed
    }
  }

  return (
    <Modal
      title="编辑节点属性"
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      okText="确认"
      cancelText="取消"
      destroyOnHidden
      width={440}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item name="deviceName" label="设备名称" rules={[{ required: true, message: '请输入设备名称' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="ipAddress" label="IP 地址" rules={[{ required: true, message: '请输入 IP 地址' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="deviceType" label="设备类型" rules={[{ required: true }]}>
          <Select options={DEVICE_TYPE_OPTIONS} />
        </Form.Item>
        <Form.Item name="vendor" label="厂商">
          <Input placeholder="华为、Cisco、H3C..." />
        </Form.Item>
        <Form.Item name="model" label="型号">
          <Input placeholder="S5735-L48T4X" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// Phase 26 / 26-04 round 3 P-C：memo 隔离——props 全稳定（回调经 useCallback / 模块级 noop），
// 父组件拖拽每帧重渲染时本组件直接跳过
export default memo(EditNodeModal)
