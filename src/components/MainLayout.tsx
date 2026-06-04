import { Layout } from 'antd'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopologyPage from './pages/TopologyPage'
import DevicesPage from './pages/DevicesPage'
import IpManagementPage from './pages/IpManagementPage'
import AIPage from './pages/AIPage'
import LogAuditPage from './pages/LogAuditPage'
import SettingsPage from './pages/SettingsPage'
import KnowledgeBasePage from './pages/KnowledgeBasePage'

const { Sider, Content } = Layout

export default function MainLayout() {
  return (
    <HashRouter>
      <Layout style={{ height: '100vh' }}>
        <Sider width={200} theme="light" style={{ overflow: 'auto' }}>
          <div style={{ height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #f0f0f0' }}>
            <strong>拓扑管理</strong>
          </div>
          <Sidebar />
        </Sider>
        <Layout>
          <Content style={{ height: '100%', overflow: 'auto' }}>
            <Routes>
              <Route path="/" element={<Navigate to="/topology" replace />} />
              <Route path="/topology" element={<TopologyPage />} />
              <Route path="/devices" element={<DevicesPage />} />
              <Route path="/ip-management" element={<IpManagementPage />} />
              <Route path="/ai" element={<AIPage />} />
              <Route path="/knowledge-base" element={<KnowledgeBasePage />} />
              <Route path="/logs" element={<LogAuditPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
    </HashRouter>
  )
}
