import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Popconfirm, Spin, message } from 'antd'
import { useDeviceDetailStore } from '@/stores/deviceDetailStore'
import DeviceForm from '@/components/DeviceForm'
import {
  CHANNEL_LABELS,
  CHANNEL_SHORT_LABELS,
  DEVICE_TYPE_LABELS,
  type ChannelTestResult,
  type ConnectionType,
  type CreateDeviceDTO,
  type Device,
} from '@/types/device'

/**
 * DeviceDetailPanel —— details 栏设备详情内容组件（Phase 38 / DETAIL-01 · D-07/D-08）。
 *
 * 「双击=连、全参数弹窗=改、右栏=看」（39 期心智，38「编辑弹窗=改」收敛）的「看」半：
 * 点选拓扑节点后三区常驻展示——基础信息区（D-08）+ 登录通道区（D-07，已配行行内 [连接]
 * 直连 D-04）+ 快捷操作区（D-05，「编辑」弹 DeviceForm 编辑态——39-02 D-01 与设备管理页
 * 点资产「编辑」零能力差异）；missing 态（39-03）文案 + 「一键添加到资产列表」纳管按钮
 * （D-09）+「删除节点」轻删（D-10）三元素并存。
 * 替换 35 期预留占位组件；本组件经 DetailsPanel 无条件挂载（35 SC2 折叠保挂载
 * 红线——三态为内容切换非挂载切换，折叠再展开面板内状态不丢）。
 *
 * 数据源：device.getById（36 channels 投影，凭证经 main 侧脱敏下发）。H-1 红线：本组件
 * 只渲染 username/port 等非敏感字段，敏感凭证字段（脱敏形态也不渲染）零引用。
 * 样式全走模块级 CSSProperties 常量 + 内联 var(--nt-*) token（audit:tokens 红线）。
 */

/** D-07 四通道固定序（channels 投影本身已固定序，渲染遍历以全集四行为准——未配行显性呈现） */
const ALL_CHANNELS: ConnectionType[] = ['ssh', 'telnet', 'web', 'rdp']

/**
 * D-07 端口补全表：descriptor 在 port 缺省（null）时按通道默认端口呈现。
 * WR-04（38 review）：web 不在此列——实际连接端口由 main 侧按 Web 站点协议判定
 * （https→443 / http→80），而 SC3 脱敏边界下本组件不可知协议，臆测展示 443 与实际
 * 连接行为不符（http 形态误示）；故 web 行 port null 时不补默认端口，descriptor 仅
 * 显示 username。已配真实端口的行不受影响（直显配置值）。
 */
const DEFAULT_PORTS: Record<Exclude<ConnectionType, 'web'>, number> = {
  ssh: 22,
  telnet: 23,
  rdp: 3389,
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
export const PANEL_STYLE: CSSProperties = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

/** 分区容器：区内 8 节奏 */
export const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

/** 设备名头部：base-16-strong（500 16/24）label-primary */
export const DEVICE_NAME_STYLE: CSSProperties = {
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
export const FIELD_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
}

/** 字段标签：xxs-12 label-caption 固定宽两列对齐 */
export const FIELD_LABEL_STYLE: CSSProperties = {
  font: 'var(--nt-font-xxs-12)',
  color: 'var(--nt-alias-label-caption)',
  flex: 'none',
  width: 60,
}

/** 字段值：xs-13 label-primary 单行截断 */
export const FIELD_VALUE_STYLE: CSSProperties = {
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

/** 区标题（登录通道/快捷操作）：xs-13-strong label-secondary */
export const SECTION_TITLE_STYLE: CSSProperties = {
  font: 'var(--nt-font-xs-13-strong)',
  color: 'var(--nt-alias-label-secondary)',
}

/** 操作区按钮行：横向 8 间隔可换行（窄栏三按钮不溢出） */
export const ACTION_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

export default function DeviceDetailPanel() {
  // Pattern 3（单字段 selector）：跨层选中态与刷新信号（38-01 落库契约）
  const selectedDeviceId = useDeviceDetailStore((s) => s.selectedDeviceId)
  const refreshCounter = useDeviceDetailStore((s) => s.refreshCounter)
  // Pattern 3（action 引用，TopologyPage 写侧同款）：编辑保存刷新信号 + AI 跳转中转写入
  const refresh = useDeviceDetailStore((s) => s.refresh)
  const setPendingAiDevice = useDeviceDetailStore((s) => s.setPendingAiDevice)
  // 39-02：选中节点元信息（删除双动作的画布节点定位源——39-01 与 selectedDeviceId 同步写，
  // 组件已在 Pattern 3 订阅者清单内，本处仅语义扩展）
  const selectedNodeMeta = useDeviceDetailStore((s) => s.selectedNodeMeta)
  const navigate = useNavigate()

  // getById 四态：loading（拉取中）/ ready（渲染三区）/ missing（真未找到——仅由已完成
  // 的本 id 拉取 d === null 到达，纳管/删节点动作只在此态提供）/ error（IPC 查询异常——
  // WR-02 39 review 与 missing 分流：设备可能实际存在且健康，仅渲染文案 + 重试，不提供
  // 纳管/删节点动作，防「删除节点」误删实际存在设备的画布节点）。
  // WR-02（38 review）：初始态与空选复位均为 'loading' 而非 'missing'——'missing' 只能由
  // 「已完成的本 id 拉取」到达，防 null→选中 切换的渲染帧（effect 尚未执行）闪一帧
  // 「设备不存在或已删除」错误文案（空选由 selectedDeviceId===null 早退分支接管，不误显 Spin）
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const [device, setDevice] = useState<Device | null>(null)
  // 测试连接逐通道结果（D-05，38-02 Task 2 实装触发路径）：仅含已配通道键；
  // 切设备/编辑刷新时清除（本 effect 首行），防上一台结果错位到新选中设备行
  const [testResults, setTestResults] = useState<Partial<Record<ConnectionType, ChannelTestResult>> | null>(null)
  // D-05 测试连接在途标志（按钮 loading 防重复触发，T-38-07 单用户桌面场景无放大面）
  const [testing, setTesting] = useState(false)
  // 39-02（D-01）编辑弹窗开合：弹 DeviceForm 编辑态（device prop 即当前 device state——
  // ready 态下为当前详情设备，无需再构造 TopologyNodeData 投影）
  const [editOpen, setEditOpen] = useState(false)
  // 39-03（D-09）：纳管弹窗开合——missing 态弹 DeviceForm 新建+预填形态（presetSource）
  const [adoptOpen, setAdoptOpen] = useState(false)
  // WR-02（39 review）：error 态重试计数——bump 触发 getById effect 重跑（fresh cancelled
  // 守卫），不动全局 refreshCounter（那会连带 TopologyPage CR-01 镜像重拉，语义过宽）
  const [retryCounter, setRetryCounter] = useState(0)

  useEffect(() => {
    // 切设备/编辑刷新（refreshCounter bump）：清除上一台的逐通道测试结果 + 纳管弹窗陈旧态
    //（38 期选中切换清理在途交互态同款义务——missing→ready/空选切换后 stale true 会使
    // 下次进 missing 分支时纳管弹窗自动弹出，回归点⑦）
    setTestResults(null)
    setAdoptOpen(false)
    if (selectedDeviceId === null) {
      // 无选中（右栏被手动展开等边缘态）：复位不拉取（渲染走空选 null 门控分支）；
      // 状态复位 'loading' 而非 'missing'（WR-02——见 detailState 声明处注释）
      setDevice(null)
      setDetailState('loading')
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
        // WR-02（39 review）：IPC 查询异常独立 error 态——设备可能实际存在且健康，与
        // 「设备已删」混叠会在误判时提供纳管/删节点动作（「删除节点」会移除实际存在
        // 设备的画布节点）。error 态仅文案 + 重试（本地不落脏值）
        if (cancelled) return
        setDevice(null)
        setDetailState('error')
      }
    })()
    return () => { cancelled = true }
  }, [selectedDeviceId, refreshCounter, retryCounter])

  // D-04 通道行内直连：统一入口 connection.open(deviceId, channel) 零弹窗（36-03 单入口）；
  // 失败带通道短标归因（TopologyPage openChannel 同款 §6.4 文案契约）
  const openChannel = useCallback(async (deviceId: string, channel: ConnectionType) => {
    try {
      await window.api.connection.open(deviceId, channel)
    } catch {
      message.error(`${CHANNEL_SHORT_LABELS[channel]} 连接失败`)
    }
  }, [])

  // D-05 编辑入口（39-02 D-01）：弹 DeviceForm 编辑态——与设备管理页点资产「编辑」同款
  // 全参数组件零能力差异（基础字段 + 四通道凭证区 + 默认通道），弃 38 期六字段弹窗
  const handleEdit = useCallback(() => setEditOpen(true), [])

  // 39-02（D-01）编辑保存：照 TopologyPage handleCredentialFormOk 同型——device.update
  // 全量载荷（values 含 channels）纯透传，勿双重剔除（H-1「留空=不修改」剔除已由 DeviceForm
  // handleFinish 完成，DevicesPage :62-63 注释红线）。
  // topoFields 级联集约束（WR-01 25.1 活文档，自 38 期退役弹窗的保存回调迁移至此）：DeviceForm 编辑态
  // 提交的 topoFields 六字段均在 updateDevice 级联集（device.ts topoFields）内；version/channels
  // 写 devices/device_credentials 表不经拓扑级联，节点快照本无此二字段，无分叉。
  // 保存链零新增接线：refresh() bump 后本面板既有 getById effect 重拉（右栏即时刷新），
  // TopologyPage 既有 CR-01 镜像 effect 把 topoFields 六字段写回画布节点。
  const handleEditFormOk = useCallback(
    async (values: CreateDeviceDTO) => {
      if (!device) return
      try {
        await window.api.device.update(device.id, values)
        message.success('设备更新成功')
        setEditOpen(false)
        // 三写路径之一（本入口）：refreshCounter bump → 右栏重拉 + CR-01 画布节点镜像（38 期信号线沿用）
        refresh()
      } catch (e: unknown) {
        // D-09：updateDevice 事务化，失败即整体回滚（失败不关弹窗、本地不落脏值）
        message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [device, refresh]
  )

  const handleEditFormCancel = useCallback(() => setEditOpen(false), [])

  // 39-03（D-09）：纳管预填对象——按 Device 类型构造最小对象（未采集字段空串/合法空值补齐）。
  // name 取 selectedNodeMeta.deviceName（预填唯一可靠源——discovery AI 命名）；deviceType
  // 照传（恒 'generic' 无信息量但语义正确）；ipAddress/vendor/model 空串 = discovery 采集
  // 现状（deviceId 是 AI 输出标识不可靠，不作 IP 推断——IP 留空用户手填，这是数据现状收敛
  // 不是实现遗漏）。useMemo 稳定引用——DeviceForm 回填 effect 以 fillSource 为 deps，
  // 内联构造每渲染换引用会触发 resetFields 重放。
  const adoptPresetSource = useMemo<Device | null>(
    () =>
      selectedNodeMeta
        ? {
            id: selectedNodeMeta.deviceId,
            topologyId: null,
            name: selectedNodeMeta.deviceName,
            vendor: '',
            model: '',
            version: '',
            ipAddress: '',
            deviceType: selectedNodeMeta.deviceType,
            connectionType: null,
            channels: [],
            status: 'unknown',
            lastChecked: null,
            createdAt: '',
            updatedAt: '',
            capabilities: { hasSSH: false, hasTelnet: false, hasMcp: false },
          }
        : null,
    [selectedNodeMeta]
  )

  // D-09 纳管入口：弹 DeviceForm 新建+预填形态（title「添加设备」、名称预填、无「复制自」
  // Alert、无同 IP 硬拦、凭证区新配可顺手配——39-03 Task 2 presetSource 形态）
  const handleAdopt = useCallback(() => setAdoptOpen(true), [])

  const handleAdoptFormCancel = useCallback(() => setAdoptOpen(false), [])

  // WR-02（39 review）：error 态重试——本地计数 bump 重跑上方 getById effect（重置
  // loading 态 + fresh cancelled 守卫），见 retryCounter 声明处注释
  const handleRetry = useCallback(() => setRetryCounter((c) => c + 1), [])

  // D-09 纳管保存（DevicesPage handleCreate 先例）：device.create 返回完整 Device 投影——
  // 新 id 即返回值 .id，经 adoptNodeToDevice 回写画布节点。
  // 纳管闭环链（39-01 预置，三步全链零新增接线）：
  // adoptNodeToDevice 按节点 id 匹配换 data.deviceId + 清 unmanaged（内存镜像防 1s debounce
  // 以旧 deviceId 整图覆写——CR-01 同族红线 T-39-10）→ nodes 引用变化触发 TopologyPage 选中
  // 同步 effect 重跑 → setSelectedDeviceId(新 id) → 本面板 getById 重拉 → 右栏自动切该设备
  // 正常详情 + DeviceNode 虚线徽标随 data 引用更新消失。
  const handleAdoptOk = useCallback(
    async (values: CreateDeviceDTO) => {
      if (!selectedNodeMeta) return
      try {
        const created = await window.api.device.create(values)
        message.success('设备添加成功')
        useDeviceDetailStore
          .getState()
          .canvasActions?.adoptNodeToDevice(selectedNodeMeta.nodeId, created.id)
        setAdoptOpen(false)
      } catch (e: unknown) {
        // D-09：createDevice 事务化，失败即整体回滚（失败不关弹窗、本地不落脏值）
        message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [selectedNodeMeta]
  )

  // D-10 未知设备一键删（免确认，与「删连线」同款轻删——D-07 框架内最轻一档）：未知设备
  // 不在资产表，删除即纯画布移除（无资产级联、无凭证数据），重新发现可找回；onClick 直调
  // removeNodeFromCanvas（无 Popconfirm/Modal 确认包裹），删后命令内清选中 → 右栏经选中
  // 同步链自动收起。selectedNodeMeta null 时按钮 disabled + 此处 return 双保险。
  const handleDeleteUnknownNode = useCallback(() => {
    if (!selectedNodeMeta) return
    useDeviceDetailStore.getState().canvasActions?.removeNodeFromCanvas(selectedNodeMeta.nodeId)
  }, [selectedNodeMeta])

  // D-06 从拓扑移除（轻删免确认 D-07）：经 39-01 命令通道节点出图 + 悬空边清除 + 清选中——
  // 清选中触发选中同步 effect 上抛 null，右栏经选中同步链自动收起（无需本地善后）；设备
  // 管理页记录保留、节点可重新添加（破坏半径完全可重做，T-39-07 accept）。selectedNodeMeta
  // 为 null 时按钮 disabled + 此处 return 双保险（无节点定位信息不可删）。
  const handleRemoveFromCanvas = useCallback(() => {
    if (!selectedNodeMeta) return
    useDeviceDetailStore.getState().canvasActions?.removeNodeFromCanvas(selectedNodeMeta.nodeId)
  }, [selectedNodeMeta])

  // D-06 彻底删除设备（唯一二次确认点——Popconfirm 在按钮 JSX 处，D-07）：device.delete 库内
  // 级联删资产记录 + 拓扑节点 + 悬空边（device.ts deleteDevice）。红线（CR-01 同族，T-39-06）：
  // 成功后必须同帧镜像画布内存态——若不镜像，随后任意画布操作的 1s debounce 自动保存将以
  // 旧值整图覆写 data_enc，把库内已删节点静默写回（静默回滚）。镜像内含清选中 → 右栏经
  // 选中同步链自动收起。
  // WR-03（39 review）：镜像键弃 selectedNodeMeta 改 data.deviceId（removeNodesByDeviceId，
  // 与库内级联同键）——meta 缺场的竞态帧（focusDevice 第三步直写窗口/防御分支命中）下镜像
  // 不再被跳过；按钮不设 meta 缺场 disabled（「从拓扑移除」按 meta.nodeId 定位故需防御，
  // 本路径镜像不依赖 meta，禁用反而无谓拦截合法删除）。
  const handleDeleteDevice = useCallback(async () => {
    if (!device) return
    try {
      await window.api.device.delete(device.id)
      message.success('设备删除成功')
      useDeviceDetailStore.getState().canvasActions?.removeNodesByDeviceId(device.id)
    } catch (e: unknown) {
      // D-09：deleteDevice 事务化，失败即整体回滚
      message.error('操作失败，数据已回滚无变化：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [device])

  // D-05 测试连接（36-05 connection.test 全通道并行探测复用）：逐通道结果按 channel 键
  // 归并写入 testResults（仅含已配通道键，行内展示位在通道区已配行）；零通道设备无通道
  // 可测（按钮 disabled）。finally 释放在途标志（按钮 loading 防重复触发）
  // WR-01（38 review）在途响应守卫：effect 首行清 testResults 只能清已落结果，挡不住在途
  // promise——resolve 后校验「选中设备 + refreshCounter 均未变」（与上方 getById effect 的
  // 清除触发条件对称：切设备/编辑刷新任一发生即弃，防旧设备或编辑前通道集的探测文案
  // 错位落进当前通道行）
  const handleTest = useCallback(async () => {
    if (!device) return
    const targetId = device.id
    const startCounter = useDeviceDetailStore.getState().refreshCounter
    setTesting(true)
    try {
      const result = await window.api.connection.test(targetId)
      const s = useDeviceDetailStore.getState()
      if (s.selectedDeviceId !== targetId || s.refreshCounter !== startCounter) return
      const map: Partial<Record<ConnectionType, ChannelTestResult>> = {}
      for (const c of result.channels) map[c.channel] = c
      setTestResults(map)
    } catch (e: unknown) {
      message.error('测试失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setTesting(false)
    }
  }, [device])

  // D-05 AI 对话跳转（store 中转方案，PATTERNS §5 推荐②——比 router state 少一条隐式
  // 契约）：先写中转字段再 navigate，AIPage mount effect 一次性读清（原子消费防重放）
  const handleAiChat = useCallback(() => {
    if (!device) return
    setPendingAiDevice(device.id)
    navigate('/ai')
  }, [device, setPendingAiDevice, navigate])

  // 39-01 空选门控收敛为 return null：38 期此分支渲染空态引导文案；39 期单选连线时右栏展开
  // 而 selectedDeviceId 为 null——保留文案会与 EdgeDetailPanel 连线详情同屏叠加。return null
  // 是内容级门控，组件实例仍由父层无条件挂载（SC2 不破——内容切换非挂载切换）；WR-02
  // 「null→选中一帧 missing 误显」防线语义不变（null 期无任何内容，选中后 loading 在途照旧）。
  if (selectedDeviceId === null) return null

  if (detailState === 'loading') {
    return (
      <div style={PANEL_STYLE}>
        <div style={LOADING_STYLE}>
          <Spin size="small" />
        </div>
      </div>
    )
  }

  // WR-02（39 review）：error 态独立分支——IPC 查询异常与「设备已删」分流，仅错误文案 +
  // 重试按钮，不渲染纳管/删节点动作（missing 态动作只允许由 d === null 真未找到路径到达）
  if (detailState === 'error') {
    return (
      <div style={PANEL_STYLE}>
        <div style={EMPTY_TITLE_STYLE}>设备信息加载失败</div>
        <div style={EMPTY_HINT_STYLE}>查询设备详情时出错，设备可能仍存在，请重试。</div>
        <div style={ACTION_ROW_STYLE}>
          <Button size="small" onClick={handleRetry}>
            重试
          </Button>
        </div>
      </div>
    )
  }

  if (detailState === 'missing' || device === null) {
    return (
      <div style={PANEL_STYLE}>
        <div style={EMPTY_TITLE_STYLE}>设备不存在或已删除</div>
        <div style={EMPTY_HINT_STYLE}>该节点对应的设备资料已被删除，可在设备管理页确认后清理节点。</div>
        {/* D-09 两件事并存（不区分「未知设备」vs「已删除设备」成因）：文案保留 + 纳管按钮
            追加；D-10「删除节点」与纳管并列（一次点击直接删免确认）。WR-02 39 review 起
            IPC 查询异常已分流 error 态，本分支仅真未找到（d === null）路径到达。selectedNodeMeta
            null 时两按钮 disabled（防御——正常单选链保证非 null） */}
        <div style={ACTION_ROW_STYLE}>
          <Button size="small" type="primary" disabled={selectedNodeMeta === null} onClick={handleAdopt}>
            一键添加到资产列表
          </Button>
          <Button size="small" danger disabled={selectedNodeMeta === null} onClick={handleDeleteUnknownNode}>
            删除节点
          </Button>
        </div>
        {/* 39-03（D-09）：纳管 DeviceForm 新建+预填实例——与 39-02 编辑态实例互斥（missing
            态下编辑实例必不在渲染树，两实例分属不同 return 分支天然互斥）；不传
            existingDevices（沿 TopologyPage/39-02 先例——IP 分层 D-13 警告静默） */}
        <DeviceForm
          open={adoptOpen}
          presetSource={adoptPresetSource}
          onOk={handleAdoptOk}
          onCancel={handleAdoptFormCancel}
        />
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
        <div style={SECTION_TITLE_STYLE}>登录通道</div>
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
          // D-07 descriptor：username:port（port 缺省按 DEFAULT_PORTS 补全；username 空串
          // 仅 port——telnet 无认证设备形态）。WR-04：web 通道不查补全表（协议不可知，
          // 见 DEFAULT_PORTS 注释）——port null 时仅显示 username（无 username 显 '—'）
          const port = k === 'web' ? ch.port : ch.port ?? DEFAULT_PORTS[k]
          const descriptor = port != null
            ? ch.username
              ? `${ch.username}:${port}`
              : `${port}`
            : ch.username || '—'
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

      {/* 快捷操作区（D-05）：编辑 / 测试连接 / AI 对话 + 删除分组行（39 D-06 决策变更——
          删除双动作入右栏，撤销 38 D-06「删除不入面板」） */}
      <div style={SECTION_STYLE}>
        <div style={SECTION_TITLE_STYLE}>快捷操作</div>
        <div style={ACTION_ROW_STYLE}>
          <Button size="small" onClick={handleEdit}>
            编辑
          </Button>
          <Button size="small" loading={testing} disabled={channels.length === 0} onClick={handleTest}>
            测试连接
          </Button>
          <Button size="small" onClick={handleAiChat}>
            AI 对话
          </Button>
        </div>
        {/* D-06 删除分组行（与主操作行视觉区隔——section gap 8 节奏）：「从拓扑移除」轻删
            免确认（可重做，非 danger——轻删语义）；「彻底删除设备」danger + Popconfirm
            二次确认（D-07 唯一确认点，资产级联删除不可逆，文案沿 DevicesPage 先例逐字） */}
        <div style={ACTION_ROW_STYLE}>
          <Button size="small" disabled={selectedNodeMeta === null} onClick={handleRemoveFromCanvas}>
            从拓扑移除
          </Button>
          <Popconfirm title="删除设备将同时从拓扑中移除，确定删除？" onConfirm={handleDeleteDevice}>
            <Button size="small" danger>
              彻底删除设备
            </Button>
          </Popconfirm>
        </div>
      </div>

      {/* 39-02（D-01）编辑弹窗：DeviceForm 编辑态——与设备管理页同款全参数形态。
          credentialHint 仅零通道设备传（TopologyPage 双击零通道引导先例——「该设备尚未配置
          登录通道」文案对已配设备不真）；不传 existingDevices（沿 TopologyPage 先例——右栏
          无 device.list 数据在手，拉全表成本不值其收益，IP 分层 D-13 警告静默）；无引导
          通道场景不传 initialChannel */}
      <DeviceForm
        open={editOpen}
        device={device}
        credentialHint={channels.length === 0}
        onOk={handleEditFormOk}
        onCancel={handleEditFormCancel}
      />
    </div>
  )
}
