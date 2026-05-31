import { Menu, Divider } from 'antd'
import { ApartmentOutlined, DesktopOutlined, RobotOutlined, SettingOutlined, FileSearchOutlined, GlobalOutlined, BookOutlined } from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTopologyToolbarStore } from '@/stores/topologyToolbarStore'
import TopologyToolbar from './topology/TopologyToolbar'

const navItems = [
  { key: '/topology', icon: <ApartmentOutlined />, label: '拓扑管理' },
  { key: '/devices', icon: <DesktopOutlined />, label: '设备管理' },
  { key: '/ip-management', icon: <GlobalOutlined />, label: 'IP 管理' },
  { key: '/ai', icon: <RobotOutlined />, label: 'AI 助手' },
  { key: '/knowledge-base', icon: <BookOutlined />, label: '资料库' },
  { key: '/logs', icon: <FileSearchOutlined />, label: '日志审计' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
]

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const toolbarState = useTopologyToolbarStore((s) => s.toolbar)

  return (
    <>
      <Menu
        mode="inline"
        selectedKeys={[location.pathname]}
        items={navItems}
        onClick={({ key }) => navigate(key)}
        style={{ borderRight: 0 }}
      />
      {toolbarState && location.pathname === '/topology' && (
        <>
          <Divider style={{ margin: '4px 0' }} />
          <TopologyToolbar {...toolbarState} />
        </>
      )}
    </>
  )
}
