import { useState, useEffect } from 'react'
import { Form, Input, Button, Card, Typography, message } from 'antd'
import { UserOutlined, LockOutlined, SafetyCertificateOutlined, ReloadOutlined } from '@ant-design/icons'
import { useAuthStore } from '../stores/authStore'

const { Title } = Typography

export default function Login() {
  const [loading, setLoading] = useState(false)
  const [captchaSvg, setCaptchaSvg] = useState('')
  const [captchaKey, setCaptchaKey] = useState('')
  const [form] = Form.useForm()
  const doLogin = useAuthStore((s) => s.login)

  const loadCaptcha = async () => {
    const result = await window.api.auth.getCaptchaSvg()
    setCaptchaSvg(result.svg)
    setCaptchaKey(result.key)
    form.setFieldValue('captcha', '')
  }

  useEffect(() => { loadCaptcha() }, [])

  const onFinish = async (values: { username: string; password: string; captcha: string }) => {
    setLoading(true)
    const error = await doLogin(values.username, values.password, captchaKey, values.captcha)
    setLoading(false)
    if (error) { message.error(error); loadCaptcha() }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: 'var(--nt-alias-bg-module-platform)' }}>
      <Card style={{ width: 400 }}>
        <Title level={3} style={{ textAlign: 'center' }}>灵枢</Title>
        <Form form={form} onFinish={onFinish}>
          <Form.Item name="username" rules={[{ required: true }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Form.Item name="captcha" rules={[{ required: true }]}>
            <Input prefix={<SafetyCertificateOutlined />} placeholder="验证码" />
          </Form.Item>
          <Form.Item>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div dangerouslySetInnerHTML={{ __html: captchaSvg }} style={{ cursor: 'pointer' }} onClick={loadCaptcha} />
              <Button icon={<ReloadOutlined />} onClick={loadCaptcha} type="text">换一张</Button>
            </div>
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>登录</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
