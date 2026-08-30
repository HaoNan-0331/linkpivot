import { useEffect } from 'react'
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
import UpdateModal from './update/UpdateModal'
import { useUpdateStore } from '../stores/updateStore'

const { Sider, Content } = Layout

/**
 * Phase 30（30-04，D-03/D-05）：登录后主界面 mount 一次性拉取升级状态（渲染 null 不占布局）。
 * 时序：已下载待安装 → 优先弹 ready（跳过新版检测弹窗，D-05）；否则有未压制新版 → 弹 info
 * （D-03 登录后立即弹——MainLayout 本身仅登录后渲染）；suppressed 或其余不弹。
 * 处理完毕（无论弹与不弹）置 bootstrapReady——供 update-available 事件分支判慢网络竞态补弹（W-2）。
 * update:event 订阅（onUpdateEvent）在 UpdateModal 内（本组件挂载的常驻弹窗持有）。
 */
function UpdateBootstrap() {
  useEffect(() => {
    ;(async () => {
      try {
        const version = await window.api.update.getVersion()
        useUpdateStore.getState().setAppVersion(version)
      } catch {
        // 版本号拉取失败静默（弹窗版本行退化为空展示，不阻塞弹窗时序）
      }
      try {
        const s = await window.api.update.getStatus()
        if (!useUpdateStore.getState().appVersion && s.currentVersion) {
          useUpdateStore.getState().setAppVersion(s.currentVersion)
        }
        if (s.phase === 'downloaded' && s.updateInfo) {
          useUpdateStore.getState().openReady(s.updateInfo)
        } else if (s.phase === 'available' && !s.suppressed && s.updateInfo) {
          useUpdateStore.getState().openInfo(s.updateInfo)
        }
      } catch {
        // 自动检测失败静默（UPD-01）
      } finally {
        useUpdateStore.getState().markBootstrapDone()
      }
    })()
  }, [])
  return null
}

export default function MainLayout() {
  return (
    <HashRouter>
      <Layout style={{ height: '100vh' }}>
        <Sider width={200} theme="light" style={{ overflow: 'auto' }}>
          <div style={{ height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid var(--nt-alias-border-l2)' }}>
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
        {/* Phase 30（30-04）：升级弹窗常驻（Modal portal 挂 body）+ 启动一次性状态拉取 */}
        <UpdateBootstrap />
        <UpdateModal />
      </Layout>
    </HashRouter>
  )
}
