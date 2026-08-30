import { useState } from 'react'
import { Form, Input, Button, Card, Typography, message } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useAuthStore } from '../stores/authStore'

const { Title } = Typography

export default function InitAdmin({ onSuccess }: { onSuccess: () => void }) {
  const [loading, setLoading] = useState(false)
  const initAdmin = useAuthStore((s) => s.initAdmin)

  const onFinish = async (values: { username: string; password: string; confirmPassword: string }) => {
    if (values.password !== values.confirmPassword) { message.error('两次密码不一致'); return }
    setLoading(true)
    const error = await initAdmin(values.username, values.password)
    setLoading(false)
    if (error) { message.error(error) } else { message.success('管理员创建成功'); onSuccess() }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: 'var(--nt-alias-bg-module-platform)' }}>
      <Card style={{ width: 400 }}>
        <Title level={3} style={{ textAlign: 'center' }}>初始化管理员账号</Title>
        <Form onFinish={onFinish}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="管理员用户名" />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 10, message: '密码不低于 10 位' },
              {
                validator: (_: unknown, value: string) =>
                  value && /[a-zA-Z]/.test(value) && /\d/.test(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('密码需同时包含字母和数字')),
              },
            ]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码（不低于 10 位，需同时包含字母和数字）" />
          </Form.Item>
          <Form.Item name="confirmPassword" rules={[{ required: true, message: '请确认密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="确认密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>创建管理员</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
