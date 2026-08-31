export type ConnectionType = 'ssh' | 'telnet' | 'web' | 'rdp'
export type DeviceType = 'router' | 'switch' | 'firewall' | 'server' | 'generic'

/**
 * Phase 36（36-02，LOGIN-01）：设备通道凭证投影元素——device_credentials 子表行的 main 进程
 * 内明文形态，随 device:list / device:getById 的 channels 数组下发。
 * password/sshKeyContent 经 IPC 出口时已被 maskDeviceSecrets 递归脱敏为 ****尾4（H-1 红线，
 * renderer 永不收明文）；resolution 为 RDP 分辨率明文列（D-04 裁决补记：非敏感字段，明文下发合法）。
 */
export interface DeviceChannel {
  channel: ConnectionType
  port: number | null
  username: string
  password: string
  sshKeyPath: string
  sshKeyContent: string
  webUrl: string
  resolution: string | null
}

/**
 * Phase 36（36-02）：设备保存通道节入参——enabled=true 时 UPSERT（凭证字段 !== undefined 才写，
 * 「留空=不修改」按通道按字段生效，H-1）；enabled=false 删该通道行（清空即禁用）。
 * resolution 仅 RDP 节携带值（明文列直写）；createDevice/updateDevice 与本 plan 服务层写语义对齐。
 */
export interface DeviceChannelDTO {
  channel: ConnectionType
  enabled: boolean
  port?: number
  username?: string
  password?: string
  sshKeyPath?: string
  sshKeyContent?: string
  webUrl?: string
  resolution?: string
}

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
  // Phase 36（36-02）过渡期字段——main 投影已停发顶层平铺凭证（D-08 不留双源，凭证唯一真源
  // 为 channels），类型暂留可选保未改造 DeviceForm/DevicesPage 编译；36-04 随表单重构移除。
  port?: number | null
  username?: string
  password?: string
  sshKeyPath?: string
  sshKeyContent?: string
  webUrl?: string
  // Phase 36（36-02，LOGIN-01）：多通道凭证投影（main 进程内明文；IPC 出口 password/
  // sshKeyContent 经 maskDeviceSecrets 递归脱敏为 ****尾4）。channel 存在 = 通道已配置。
  channels: DeviceChannel[]
  status: 'online' | 'offline' | 'unknown'
  lastChecked: string | null
  createdAt: string
  updatedAt: string
  // Phase 23（DSL-03/D-02）→ Phase 36（D-05）：能力三布尔，main 经 device:list 投影下发
  //（hasSSH/hasTelnet 按子表行存在性派生可同真，hasMcp 由 mcp_device_rel 派生），
  // renderer 只消费不推导。
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
  /** Phase 36（36-02）：多通道凭证节（四通道固定序规范化）；缺场走旧平铺入参过渡 shim（36-04 表单切换） */
  channels?: DeviceChannelDTO[]
}

export type UpdateDeviceDTO = Partial<CreateDeviceDTO>
