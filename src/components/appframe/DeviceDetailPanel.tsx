import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Button, Spin, message } from 'antd'
import { useDeviceDetailStore } from '@/stores/deviceDetailStore'
import {
  CHANNEL_LABELS,
  CHANNEL_SHORT_LABELS,
  type ChannelTestResult,
  type ConnectionType,
  type Device,
  type DeviceType,
} from '@/types/device'

/**
 * DeviceDetailPanel —— details 栏设备详情内容组件（Phase 38 / DETAIL-01 · D-07/D-08）。
 *
 * 「双击=连、编辑弹窗=改、右栏=看」的「看」半：点选拓扑节点后三区常驻展示——
 * 基础信息区（D-08）+ 登录通道区（D-07，已配行行内 [连接] 直连 D-04）+ 快捷操作区（D-05）。
 * 替换 35 期预留占位组件；本组件经 DetailsPanel 无条件挂载（35 SC2 折叠保挂载
 * 红线——三态为内容切换非挂载切换，折叠再展开面板内状态不丢）。
 *
 * 数据源：device.getById（36 channels 投影，凭证经 main 侧脱敏下发）。H-1 红线：本组件
 * 只渲染 username/port 等非敏感字段，敏感凭证字段（脱敏形态也不渲染）零引用。
 * 样式全走模块级 CSSProperties 常量 + 内联 var(--nt-*) token（audit:tokens 红线）。
 */

/** D-07 四通道固定序（channels 投影本身已固定序，渲染遍历以全集四行为准——未配行显性呈现） */
const ALL_CHANNELS: ConnectionType[] = ['ssh', 'telnet', 'web', 'rdp']

/** D-07 端口补全表：descriptor 在 port 缺省（null）时按通道默认端口呈现 */
const DEFAULT_PORTS: Record<ConnectionType, number> = {
  ssh: 22,
  telnet: 23,
  web: 443,
  rdp: 3389,
}

/** D-08 设备类型中文映射（DevicesPage deviceTypeLabels 同值先例，全局表单值域一致） */
const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  router: '路由器',
  switch: '交换机',
  firewall: '防火墙',
  server: '服务器',
  generic: '通用',
}

/** D-08 在线状态中文映射 */
const STATUS_LABELS: Record<Device['status'], string> = {
  online: '在线',
  offline: '离线',
  unknown: '未知',
}

/** D-08 在线状态 token 色（audit:tokens——值域只 var(--nt-*) 别名） */
const STATUS_COLORS: Record<Device['status'], string> = {
  online: 'var(--nt-alias-state-success-primary)',
  offline: 'var(--nt-alias-state-error-primary)',
  unknown: 'var(--nt-alias-label-tertiary)',
}

// —— 模块级样式常量（ChannelPickerModal/35 期占位组件 先例；零色值/字号字面量） ——

/** 面板根容器：16 padding 纵向 12 节奏（35 期占位组件先例档位） */
const PANEL_STYLE: CSSProperties = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

/** 分区容器：区内 8 节奏 */
const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

/** 设备名头部：base-16-strong（500 16/24）label-primary */
const DEVICE_NAME_STYLE: CSSProperties = {
  font: 'var(--nt-font-base-16-strong)',
  color: 'var(--nt-alias-label-primary)',
}

/** 在线状态徽标：xxs-12，色随 STATUS_COLORS（spread 合成） */
const STATUS_BADGE_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-xxs-12-font-size)',
  lineHeight: 'var(--nt-font-xxs-12-line-height)',
  flex: 'none',
}

/** 上次检测时间：xxs-12 label-caption */
const LAST_CHECKED_STYLE: CSSProperties = {
  font: 'var(--nt-font-xxs-12)',
  color: 'var(--nt-alias-label-caption)',
  flex: 'none',
}

/** 字段行容器（label + value 两列，基线对齐） */
const FIELD_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
}

/** 字段标签：xxs-12 label-caption 固定宽两列对齐 */
const FIELD_LABEL_STYLE: CSSProperties = {
  font: 'var(--nt-font-xxs-12)',
  color: 'var(--nt-alias-label-caption)',
  flex: 'none',
  width: 60,
}

/** 字段值：xs-13 label-primary 单行截断 */
const FIELD_VALUE_STYLE: CSSProperties = {
  font: 'var(--nt-font-xs-13)',
  color: 'var(--nt-alias-label-primary)',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** IP 字段值：代码栈变体（fontFamily 覆写，ChannelPickerModal descriptor 同款） */
const FIELD_VALUE_CODE_STYLE: CSSProperties = {
  ...FIELD_VALUE_STYLE,
  fontFamily: 'var(--nt-font-family-code)',
}

/** 空态标题：s-14-strong label-secondary */
const EMPTY_TITLE_STYLE: CSSProperties = {
  font: 'var(--nt-font-s-14-strong)',
  color: 'var(--nt-alias-label-secondary)',
}

/** 空态次行：xxs-12 label-tertiary */
const EMPTY_HINT_STYLE: CSSProperties = {
  font: 'var(--nt-font-xxs-12)',
  color: 'var(--nt-alias-label-tertiary)',
}

/** loading 态：Spin 居中容器 */
const LOADING_STYLE: CSSProperties = {
  padding: '32px 0',
  display: 'flex',
  justifyContent: 'center',
}

/** 通道行容器：可换行（测试结果追加时长文案自然折行不溢出） */
const CHANNEL_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  flexWrap: 'wrap',
}

/** 已配通道名：xxs-12-strong label-primary */
const CHANNEL_NAME_STYLE: CSSProperties = {
  font: 'var(--nt-font-xxs-12-strong)',
  color: 'var(--nt-alias-label-primary)',
  flex: 'none',
}

/** 未配通道名：xxs-12 label-tertiary（整行弱化） */
const CHANNEL_NAME_DIM_STYLE: CSSProperties = {
  font: 'var(--nt-font-xxs-12)',
  color: 'var(--nt-alias-label-tertiary)',
  flex: 'none',
}

/** 已配 ✓ 徽标：xxs-12 state-success-primary */
const CHANNEL_OK_STYLE: CSSProperties = {
  font: 'var(--nt-font-xxs-12)',
  color: 'var(--nt-alias-state-success-primary)',
  flex: 'none',
}

/** 未配 ✗ 提示：xxs-12 label-dimmed */
const CHANNEL_UNCONFIGURED_STYLE: CSSProperties = {
  font: 'var(--nt-font-xxs-12)',
  color: 'var(--nt-alias-label-dimmed)',
  flex: 'none',
}

/** descriptor（username:port）：xxs-12 代码栈 label-tertiary 单行截断 fill */
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

/** 「·默认」星标：xxxs-11 state-business-primary（「上次使用」徽标同款档位） */
const DEFAULT_BADGE_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-xxxs-11-font-size)',
  lineHeight: 'var(--nt-font-xxxs-11-line-height)',
  color: 'var(--nt-alias-state-business-primary)',
  flex: 'none',
}

/** 测试结果追加：xxxs-11，色随 success（spread 合成）；break-all 防 errno 长词溢出 */
const TEST_RESULT_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-xxxs-11-font-size)',
  lineHeight: 'var(--nt-font-xxxs-11-line-height)',
  flex: 'none',
  wordBreak: 'break-all',
}

/** 行内 [连接] 按钮：AntD 小号（双轨铁律——AntD 子树零 --nt-* 注入） */
const CONNECT_BUTTON_STYLE: CSSProperties = {
  flex: 'none',
}

export default function DeviceDetailPanel() {
  // Pattern 3（单字段 selector）：跨层选中态与刷新信号（38-01 落库契约）
  const selectedDeviceId = useDeviceDetailStore((s) => s.selectedDeviceId)
  const refreshCounter = useDeviceDetailStore((s) => s.refreshCounter)

  // getById 三态：loading（拉取中）/ ready（渲染三区）/ missing（设备已删或查询异常）
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'missing'>('missing')
  const [device, setDevice] = useState<Device | null>(null)
  // 测试连接逐通道结果（D-05，38-02 Task 2 实装触发路径）：仅含已配通道键；
  // 切设备/编辑刷新时清除（本 effect 首行），防上一台结果错位到新选中设备行
  const [testResults, setTestResults] = useState<Partial<Record<ConnectionType, ChannelTestResult>> | null>(null)

  useEffect(() => {
    // 切设备/编辑刷新（refreshCounter bump）：清除上一台的逐通道测试结果
    setTestResults(null)
    if (selectedDeviceId === null) {
      // 无选中（右栏被手动展开等边缘态）：复位不拉取（渲染走空态引导分支）
      setDevice(null)
      setDetailState('missing')
      return
    }
    // T-38-09 竞态守卫（AIPage mount effect 同款）：cleanup 置位后旧响应到达即弃，
    // 防快速连点两台设备时先发旧响应覆盖新选中
    let cancelled = false
    setDetailState('loading')
    void (async () => {
      try {
        const d = await window.api.device.getById(selectedDeviceId)
        if (cancelled) return
        setDevice(d)
        setDetailState(d !== null ? 'ready' : 'missing')
      } catch {
        // getById 异常罕见，与「设备已删」共用空态文案（本地不落脏值）
        if (cancelled) return
        setDevice(null)
        setDetailState('missing')
      }
    })()
    return () => { cancelled = true }
  }, [selectedDeviceId, refreshCounter])

  // D-04 通道行内直连：统一入口 connection.open(deviceId, channel) 零弹窗（36-03 单入口）；
  // 失败带通道短标归因（TopologyPage openChannel 同款 §6.4 文案契约）
  const openChannel = useCallback(async (deviceId: string, channel: ConnectionType) => {
    try {
      await window.api.connection.open(deviceId, channel)
    } catch {
      message.error(`${CHANNEL_SHORT_LABELS[channel]} 连接失败`)
    }
  }, [])

  // 无选中空态引导（SC2 内容切换分支之一——组件本体仍无条件挂载）
  if (selectedDeviceId === null) {
    return (
      <div style={PANEL_STYLE}>
        <div style={EMPTY_TITLE_STYLE}>在拓扑画布点选设备节点</div>
        <div style={EMPTY_HINT_STYLE}>此处常驻显示设备详情：基础资料、登录通道与快捷操作</div>
        <div style={EMPTY_HINT_STYLE}>双击节点直连设备、右栏不打断画布操作。</div>
      </div>
    )
  }

  if (detailState === 'loading') {
    return (
      <div style={PANEL_STYLE}>
        <div style={LOADING_STYLE}>
          <Spin size="small" />
        </div>
      </div>
    )
  }

  if (detailState === 'missing' || device === null) {
    return (
      <div style={PANEL_STYLE}>
        <div style={EMPTY_TITLE_STYLE}>设备不存在或已删除</div>
        <div style={EMPTY_HINT_STYLE}>该节点对应的设备资料已被删除，可在设备管理页确认后清理节点。</div>
      </div>
    )
  }

  // —— ready：三区渲染 ——

  const channels = device.channels ?? []
  // D-07 默认通道判定（WR-01 窄化，DevicesPage :165-169 同款）：connectionType 可空且
  // 需在场校验，悬空回退首条已配通道；零通道 null（无星标）
  const defaultChannel: ConnectionType | null =
    device.connectionType != null && channels.some((c) => c.channel === device.connectionType)
      ? device.connectionType
      : channels[0]?.channel ?? null

  // D-08 基础信息字段行（vendor/model/version 空值显 '—'）
  const fields: Array<{ label: string, value: string, code?: boolean }> = [
    { label: '类型', value: DEVICE_TYPE_LABELS[device.deviceType] },
    { label: '厂商', value: device.vendor || '—' },
    { label: '型号', value: device.model || '—' },
    { label: 'IP', value: device.ipAddress, code: true },
    { label: '固件版本', value: device.version || '—' },
  ]

  return (
    <div style={PANEL_STYLE}>
      {/* 基础信息区（D-08） */}
      <div style={SECTION_STYLE}>
        <div style={DEVICE_NAME_STYLE}>{device.name}</div>
        <div style={FIELD_ROW_STYLE}>
          <span style={{ ...STATUS_BADGE_STYLE, color: STATUS_COLORS[device.status] }}>
            {STATUS_LABELS[device.status]}
          </span>
          <span style={LAST_CHECKED_STYLE}>上次检测：{device.lastChecked ?? '未检测'}</span>
        </div>
        {fields.map((f) => (
          <div key={f.label} style={FIELD_ROW_STYLE}>
            <span style={FIELD_LABEL_STYLE}>{f.label}</span>
            <span style={f.code ? FIELD_VALUE_CODE_STYLE : FIELD_VALUE_STYLE}>{f.value}</span>
          </div>
        ))}
      </div>

      {/* 登录通道区（D-07，含行内连接 D-04） */}
      <div style={SECTION_STYLE}>
        <div style={{ font: 'var(--nt-font-xs-13-strong)', color: 'var(--nt-alias-label-secondary)' }}>登录通道</div>
        {ALL_CHANNELS.map((k) => {
          const ch = channels.find((c) => c.channel === k)
          if (!ch) {
            // 未配行：通道名 + ✗ 未配置，无 [连接] 按钮（D-04）；零通道设备四行全未配，
            // 自然落到操作区「编辑」引导配凭证（36 D-02 语义衔接，右栏不弹任何框）
            return (
              <div key={k} style={CHANNEL_ROW_STYLE}>
                <span style={CHANNEL_NAME_DIM_STYLE}>{CHANNEL_LABELS[k]}</span>
                <span style={CHANNEL_UNCONFIGURED_STYLE}>✗ 未配置</span>
              </div>
            )
          }
          // D-07 descriptor：username:port（port 缺省按 DEFAULT_PORTS 补全；
          // username 空串仅 port——telnet 无认证设备形态）
          const port = ch.port ?? DEFAULT_PORTS[k]
          const descriptor = ch.username ? `${ch.username}:${port}` : `${port}`
          const result = testResults?.[k]
          return (
            <div key={k} style={CHANNEL_ROW_STYLE}>
              <span style={CHANNEL_NAME_STYLE}>{CHANNEL_LABELS[k]}</span>
              <span style={CHANNEL_OK_STYLE}>✓</span>
              <span style={DESCRIPTOR_STYLE}>{descriptor}</span>
              {defaultChannel === k && <span style={DEFAULT_BADGE_STYLE}>·默认</span>}
              {result && (
                <span
                  style={{
                    ...TEST_RESULT_STYLE,
                    color: result.success
                      ? 'var(--nt-alias-state-success-primary)'
                      : 'var(--nt-alias-state-error-primary)',
                  }}
                >
                  {`· ${result.message}`}
                </span>
              )}
              <Button size="small" style={CONNECT_BUTTON_STYLE} onClick={() => openChannel(device.id, ch.channel)}>
                连接
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
