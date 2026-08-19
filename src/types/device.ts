export type ConnectionType = 'ssh' | 'telnet' | 'web' | 'rdp'
export type DeviceType = 'router' | 'switch' | 'firewall' | 'server' | 'generic'

export interface Device {
  id: string
  topologyId: string | null
  name: string
  vendor: string
  model: string
  version: string
  ipAddress: string
  deviceType: DeviceType
  connectionType: ConnectionType
  port: number | null
  username: string
  password: string
  sshKeyPath: string
  sshKeyContent: string
  webUrl: string
  status: 'online' | 'offline' | 'unknown'
  lastChecked: string | null
  createdAt: string
  updatedAt: string
  // Phase 23（DSL-03/D-02）：能力三布尔，main 经 device:list 投影下发（hasMcp 由
  // mcp_device_rel 派生），renderer 只消费不推导。
  capabilities: {
    hasSSH: boolean
    hasTelnet: boolean
    hasMcp: boolean
  }
}

export interface CreateDeviceDTO {
  name: string
  vendor?: string
  model?: string
  version?: string
  ipAddress: string
  deviceType?: DeviceType
  connectionType: ConnectionType
  port?: number
  username?: string
  password?: string
  sshKeyPath?: string
  sshKeyContent?: string
  webUrl?: string
}

export type UpdateDeviceDTO = Partial<CreateDeviceDTO>
