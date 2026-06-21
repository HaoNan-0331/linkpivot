import React from 'react'
import { Result, Button } from 'antd'

interface Props {
  children: React.ReactNode
}
interface State {
  hasError: boolean
  error?: Error
}

/**
 * 全局错误边界：捕获子树渲染异常，展示降级 UI，避免整应用白屏。
 * 可嵌套使用，对拓扑画布 / AI 页等重灾区做局部隔离。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  handleReload = () => {
    window.location.reload()
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined })
  }

  render() {
    if (this.state.hasError) {
      return (
        <Result
          status="error"
          title="程序出现异常"
          subTitle={this.state.error?.message || '渲染过程中发生未知错误'}
          extra={[
            <Button key="reload" type="primary" onClick={this.handleReload}>
              重载应用
            </Button>,
            <Button key="reset" onClick={this.handleReset}>
              尝试恢复
            </Button>,
          ]}
        />
      )
    }
    return this.props.children
  }
}
