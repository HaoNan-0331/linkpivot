export type ConnectionType = 'ssh' | 'telnet' | 'web' | 'rdp'
export type DeviceType = 'router' | 'switch' | 'firewall' | 'server' | 'generic'

/**
 * Phase 36（36-04，UI-SPEC §九）：通道 label 全局唯一表——DeviceForm tab、通道选择框行、
 * DevicesPage Tooltip 全清单共用（单一来源防三处漂移）；错误前缀/卡后缀用的短标另行内联。
 */
export const CHANNEL_LABELS: Record<ConnectionType, string> = {
  ssh: 'SSH',
  telnet: 'Telnet',
  web: 'Web 界面',
  rdp: 'RDP 远程桌面',
}

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
 * resolution 仅 RDP 节携带值（明文列直写）；createDevice/updateDevice 与服务层写语义对齐。
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
  // Phase 36（36-04，LOGIN-01）：顶层六凭证平铺字段移除（36-02 过渡可选形态收口）——凭证唯一
  // 真源为 channels 投影（device_credentials 子表），服务层过渡 shim 已随本 plan 移除。
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

/**
 * Phase 36（36-04，LOGIN-01）：凭证按通道节提交，服务层过渡 shim 已移除——
 * connectionType 为「默认通道」（可选，缺省/悬空由服务层 D-09 滑落收敛到首条已配通道）；
 * channels 为通道配置唯一写入口（enabled 节内未携带的凭证字段 = 留空不修改）。
 */
export interface CreateDeviceDTO {
  name: string
  vendor?: string
  model?: string
  version?: string
  ipAddress: string
  deviceType?: DeviceType
  connectionType?: ConnectionType
  channels?: DeviceChannelDTO[]
}

export type UpdateDeviceDTO = Partial<CreateDeviceDTO>
