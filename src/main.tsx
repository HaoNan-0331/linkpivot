import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ntTheme } from './theme/ntTheme'
import './styles/global.css'
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/scrollbar.css'
import './styles/ai-chat.css'
import './styles/appframe.css'
import 'reactflow/dist/style.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={ntTheme}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ConfigProvider>
  </React.StrictMode>
)
