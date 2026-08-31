import { useEffect, useState, type CSSProperties } from 'react'
import { Modal, Radio } from 'antd'
import { CHANNEL_LABELS, type ConnectionType, type Device, type DeviceChannel } from '@/types/device'

/**
 * ChannelPickerModal —— 拓扑双击多通道选择框（Phase 36 / 36-05，LOGIN-02 · D-01~D-03）。
 *
 * 契约 = 36-UI-SPEC §6.2：Modal 400 / title `连接 {deviceName}` / footer 默认双按钮
 * （okText「连 接」cancel 默认「取 消」）；Radio.Group 垂直行 = radio(16) + 通道标签
 * （CHANNEL_LABELS 单源，与表单 tab 逐字一致）+ descriptor（user@ip:port / URL，代码栈
 * 单行截断）+（记忆命中行）「上次使用」徽标。
 *
 * D-03 记忆：localStorage 单 key JSON map，预选 = 记忆（在场校验）> 默认通道 > 固定序首行；
 * 写入时刻 = 用户点「连 接」确认时（记「上次所选」非「上次成功」）。键盘走 Radio.Group
 * 原生 ↑↓（零自造键盘协议）；不加 loading 锁（终端/浏览器窗口弹出即反馈，D-01 手感）。
 *
 * 安全（T-36-05-01/04）：记忆仅作预选（读失败/非法 JSON 静默降级，不进任何 SQL/凭证路径）；
 * descriptor 只拼 username/ip/port/webUrl 非脱敏字段（channels 投影的 password/sshKeyContent
 * 为 ****尾4 脱敏形态，本组件零消费）。
 */

/** D-03 记忆载体：localStorage 单 key（camelCase 语义名，appFrameStore/ExecModeSwitch 先例） */
const LAST_CHANNEL_KEY = 'lastChannelByDevice'

/** §6.2 固定序（预选第三优先级兜底；channels 投影本身已固定序，此处防御性复用） */
const CHANNEL_ORDER: ConnectionType[] = ['ssh', 'telnet', 'web', 'rdp']

// —— 行内槽样式（§三：自研内联文本微结构——通道行 descriptor 族；值域只 var(--nt-*)） ——

/** 通道标签：s-14 label-primary flex:none */
const CHANNEL_LABEL_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-s-14-font-size)',
  lineHeight: 'var(--nt-font-s-14-line-height)',
  color: 'var(--nt-alias-label-primary)',
  flex: 'none',
}

/** descriptor：xxs-12 代码栈 label-tertiary，fill 单行截断 */
const DESCRIPTOR_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-xxs-12-font-size)',
  lineHeight: 'var(--nt-font-xxs-12-line-height)',
  fontFamily: 'var(--nt-font-family-code)',
  color: 'var(--nt-alias-label-tertiary)',
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** 「上次使用」徽标：xxxs-11 strong 档 500 state-business-primary flex:none */
const LAST_USED_BADGE_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-xxxs-11-font-size)',
  lineHeight: 'var(--nt-font-xxxs-11-line-height)',
  fontWeight: 500,
  color: 'var(--nt-alias-state-business-primary)',
  flex: 'none',
}

/**
 * D-03 记忆读取——T-36-05-01：localStorage 可被污染，读失败/非法 JSON/非对象形态一律
 * 静默降级为空 map（记忆仅作预选增强，非法值在场校验天然滤掉）。
 */
function readLastChannelMap(): Record<string, ConnectionType> {
  try {
    const raw = localStorage.getItem(LAST_CHANNEL_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, ConnectionType>
  } catch {
    return {}
  }
}

/**
 * D-03 记忆写入（读-改-写 JSON map）。写入时刻 = 用户点「连 接」确认时刻——记「上次所选」
 * 非「上次成功」（§6.2 裁决）；写失败静默（预选增强非关键路径）。设备删除不清理：取值
 * 在场校验已兜底，体量随设备数无害。
 */
function writeLastChannel(deviceId: string, channel: ConnectionType): void {
  try {
    const map = readLastChannelMap()
    map[deviceId] = channel
    localStorage.setItem(LAST_CHANNEL_KEY, JSON.stringify(map))
  } catch {
    // 写失败静默降级——记忆丢失仅影响下次预选档位
  }
}

/**
 * §6.2 descriptor 公式：ssh `{username}@{ip}:{port||22}` / telnet `…23` / rdp `…3389`
 * （username 空省略 `xxx@` 前缀——telnet 无认证设备直接 `ip:port`）；web 全显 webUrl。
 */
function channelDescriptor(ch: DeviceChannel, ipAddress: string): string {
  if (ch.channel === 'web') return ch.webUrl
  const defaultPort = ch.channel === 'ssh' ? 22 : ch.channel === 'telnet' ? 23 : 3389
  const host = `${ipAddress}:${ch.port ?? defaultPort}`
  return ch.username ? `${ch.username}@${host}` : host
}

/**
 * §6.2 预选规则（D-03）：记忆（在场校验）> 默认通道 connectionType（同前校验）> 固定序首行。
 * runtime connectionType 可为 NULL（D-09 全 off 置空）——Set.has 天然滤掉，逐级回落。
 */
function resolveInitialChannel(device: Device, lastMap: Record<string, ConnectionType>): ConnectionType {
  const channels = device.channels ?? []
  if (channels.length === 0) return 'ssh' // 组件契约上不达（≥2 通道才开框），防御性兜底
  const available = new Set(channels.map((c) => c.channel))
  const last = lastMap[device.id]
  if (last !== undefined && available.has(last)) return last
  if (device.connectionType != null && available.has(device.connectionType)) return device.connectionType
  return CHANNEL_ORDER.find((c) => available.has(c)) ?? channels[0].channel
}

interface ChannelPickerModalProps {
  open: boolean
  device: Device | null
  /** 确认回调（选中通道）——记忆写入已在组件内确认时刻完成，调用方负责连接与关框 */
  onConnect: (channel: ConnectionType) => void
  onCancel: () => void
}

export default function ChannelPickerModal({ open, device, onConnect, onCancel }: ChannelPickerModalProps) {
  const [selected, setSelected] = useState<ConnectionType>('ssh')
  // 徽标数据源：打开时刻的记忆通道（仅命中现存通道行时渲染「上次使用」——在场校验同预选）
  const [memoryChannel, setMemoryChannel] = useState<ConnectionType | null>(null)

  // 打开时刻解析预选 + 徽标；关闭态 Radio 状态随 device 重置（双击另一设备不携带上次选择）
  useEffect(() => {
    if (open && device) {
      const map = readLastChannelMap()
      setMemoryChannel(map[device.id] ?? null)
      setSelected(resolveInitialChannel(device, map))
    }
  }, [open, device])

  // 确认（CTA「连 接」）：先写记忆（写入时刻 = 确认时刻，D-03）再交调用方统一入口连接；
  // 不设 loading 锁、不等待连接结果（§6.2——终端/浏览器窗口弹出即反馈）
  const handleOk = () => {
    if (!device) return
    writeLastChannel(device.id, selected)
    onConnect(selected)
  }

  const channels = device?.channels ?? []
  return (
    <Modal
      title={device ? `连接 ${device.name}` : '连接'}
      open={open}
      okText="连 接"
      onOk={handleOk}
      onCancel={onCancel}
      width={400}
      destroyOnHidden
    >
      <Radio.Group
        value={selected}
        onChange={(e) => setSelected(e.target.value as ConnectionType)}
      >
        {channels.map((ch) => (
          <Radio
            key={ch.channel}
            value={ch.channel}
            style={{ display: 'flex', alignItems: 'center', minHeight: 36, marginInlineEnd: 0 }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, minWidth: 0, width: '100%' }}>
              <span style={CHANNEL_LABEL_STYLE}>{CHANNEL_LABELS[ch.channel]}</span>
              <span style={DESCRIPTOR_STYLE}>{channelDescriptor(ch, device?.ipAddress ?? '')}</span>
              {memoryChannel === ch.channel && <span style={LAST_USED_BADGE_STYLE}>上次使用</span>}
            </span>
          </Radio>
        ))}
      </Radio.Group>
    </Modal>
  )
}
