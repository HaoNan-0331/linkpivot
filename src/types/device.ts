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
 * Phase 38（38-01）：短标表自 TopologyPage 内联迁入——第三消费方 appframe/DeviceDetailPanel
 * （38-02）连接失败文案归因；与 CHANNEL_LABELS 全称表仍为两套清单（36 §九契约），仅共址不合并。
 */
export const CHANNEL_SHORT_LABELS: Record<ConnectionType, string> = {
  ssh: 'SSH',
  telnet: 'Telnet',
  web: 'Web',
  rdp: 'RDP',
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
 * 「留空=不修改」按通道按字段生效，H-1；WR-03 例外：明文回填字段提交空串/port null = 显式
 * 清除已存值）；enabled=false 删该通道行（清空即禁用）。
 * resolution 仅 RDP 节携带值（明文列直写）；createDevice/updateDevice 与服务层写语义对齐。
 */
export interface DeviceChannelDTO {
  channel: ConnectionType
  enabled: boolean
  /** WR-03（36 review）：null = 编辑态显式清空（服务层写 NULL 列）；undefined = 不修改 */
  port?: number | null
  username?: string
  password?: string
  sshKeyPath?: string
  sshKeyContent?: string
  webUrl?: string
  resolution?: string
}

/**
 * Phase 36（36-05 checkpoint 用户裁决，Q1 变更）：测试连接单通道探活结果——
 * message 复用各探活函数既有文案契约（SSH 连接成功 / Telnet 连接成功 / Web 端口可达 /
 * RDP 端口可达 / errno 中文映射 / 探测失败: ...）。
 */
export interface ChannelTestResult {
  channel: ConnectionType
  success: boolean
  message: string
}

/**
 * Phase 36（36-05 checkpoint 用户裁决，Q1 变更）：测试连接全通道并行探测聚合——
 * channels 按固定序 ssh/telnet/web/rdp；success = 全通道通过；message 单通道 = 该通道
 * 文案（UX 等价旧版），多通道 = `${pass}/${total} 通道连接成功`；零通道保持
 * 「该设备未配置登录通道」单一失败契约（channels: []）。
 */
export interface ConnectionTestResult {
  success: boolean
  message: string
  channels: ChannelTestResult[]
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
  // WR-01（36 review）：D-09 滑落可写 NULL（全通道 off → 默认通道置空，enforceDefaultChannel）
  // ——投影类型与运行时契约对齐，后续消费点由 tsc 强制显式处理 null（既有消费点均已 null 安全：
  // ChannelPickerModal != null 校验 / DevicesPage some() 回退 / TopologyPage || 'ssh'）。
  connectionType: ConnectionType | null
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
