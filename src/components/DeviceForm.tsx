import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Form, Input, Select, InputNumber, Modal, Alert, Tabs, Switch } from 'antd'
import type { Device, CreateDeviceDTO, DeviceChannelDTO, ConnectionType } from '../types/device'
import { CHANNEL_LABELS } from '../types/device'

interface Props {
  open: boolean
  device?: Device | null
  /** Phase 25（ASSET-01/D-01~D-03）：复制模式源设备——预填非凭证字段，凭证不继承 */
  copySource?: Device | null
  /** Phase 25（D-13）：IP 分层比对用的现有设备列表（警告级，非硬拦） */
  existingDevices?: Device[]
  /** Phase 36（36-04，D-02/§6.3）：零通道引导——true 时表单顶部渲染引导 Alert（36-05 拓扑双击 0 通道分支消费） */
  credentialHint?: boolean
  /** Phase 36（36-04，§6.3）：Tabs 初始 activeKey——定位到用户最可能想配的通道（缺省/非法值回落 'ssh'） */
  initialChannel?: ConnectionType
  onOk: (values: CreateDeviceDTO) => void
  onCancel: () => void
}

/** §5.1/§5.4 四通道固定序——tab 顺序与默认通道 options 顺序一致（UI-SPEC §九 label 唯一表共用） */
const CHANNEL_KEYS: ConnectionType[] = ['ssh', 'telnet', 'web', 'rdp']

/** §5.2 destructive 警示行：自研内联文本微结构（双轨铁律允许位）——12/18 warn-label，无底无边框 */
const WARN_INLINE_STYLE: CSSProperties = {
  fontSize: 'var(--nt-font-xxs-12-font-size)',
  lineHeight: 'var(--nt-font-xxs-12-line-height)',
  color: 'var(--nt-alias-state-warn-label)',
}

/** §二/§四 tab 已配 dot：6px 实心圆点，距标签文字 4px（title/aria「已配置」，无光环） */
const CHANNEL_DOT_STYLE: CSSProperties = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--nt-alias-state-success-primary)',
  marginInlineStart: 4,
  verticalAlign: 'middle',
}

/** 表单内通道节形态（AntD 嵌套 name 数组的 values 形状——提交前组装为 DeviceChannelDTO[]） */
interface ChannelSectionValues {
  enabled?: boolean
  port?: number | null
  username?: string
  password?: string
  sshKeyPath?: string
  sshKeyContent?: string
  webUrl?: string
  resolution?: string
}

type DeviceFormValues = Omit<CreateDeviceDTO, 'channels'> & {
  channels?: Partial<Record<ConnectionType, ChannelSectionValues>>
}

function resolveInitialChannel(ch?: ConnectionType): ConnectionType {
  return ch && (CHANNEL_KEYS as string[]).includes(ch) ? ch : 'ssh'
}

export default function DeviceForm({ open, device, copySource, existingDevices, credentialHint, initialChannel, onOk, onCancel }: Props) {
  const [form] = Form.useForm()
  const [confirmLoading, setConfirmLoading] = useState(false)
  const isCopy = !!copySource
  // 编辑或复制共用「回填源」；区别在凭证语义（编辑=已配通道回填 + 留空不修改，复制=四节全 off 零回填）
  const fillSource = device ?? copySource
  // §6.3 Tabs 初始定位（36-05 消费）：每次打开按 initialChannel 重置，缺省/非法回落 'ssh'
  const [activeKey, setActiveKey] = useState<ConnectionType>(() => resolveInitialChannel(initialChannel))

  // §5.2 通道启用态（Switch 权威）——字段 disabled / tab dot / 默认通道 options / 警示可见性共用
  const sshOn = Form.useWatch(['channels', 'ssh', 'enabled'], form) === true
  const telnetOn = Form.useWatch(['channels', 'telnet', 'enabled'], form) === true
  const webOn = Form.useWatch(['channels', 'web', 'enabled'], form) === true
  const rdpOn = Form.useWatch(['channels', 'rdp', 'enabled'], form) === true
  const onMap: Record<ConnectionType, boolean> = { ssh: sshOn, telnet: telnetOn, web: webOn, rdp: rdpOn }
  const onKeys = CHANNEL_KEYS.filter((ch) => onMap[ch])
  const defaultChannel = Form.useWatch('connectionType', form)

  // §5.2 destructive 契约：编辑态「初始已配」通道被拨 off → 节首行 inline 警示（无二次弹窗）
  const initiallyConfigured = new Set(
    !isCopy && device ? (device.channels ?? []).map((c) => c.channel) : []
  )

  useEffect(() => {
    if (open) setActiveKey(resolveInitialChannel(initialChannel))
  }, [open, initialChannel])

  useEffect(() => {
    if (fillSource) {
      // H-1（红线，按通道保留）：编辑分支不回填 password/sshKeyContent（channels 投影经 IPC
      // 递归脱敏为 ****尾4，回填会把掩码串当真实值提交覆盖凭证）——留空走「不修改」（enabled
      // 节内空凭证字段提交时剔除，服务层字段级 !== undefined 跳过）；复制模式（D-01/§5.5）
      // 四节全 off + 零回填——源凭证永远不出 main 进程，启用即等于新配。
      const chRow = (ch: ConnectionType) =>
        (!isCopy ? (fillSource.channels ?? []).find((c) => c.channel === ch) : undefined)
      form.resetFields()
      form.setFieldsValue({
        name: fillSource.name, vendor: fillSource.vendor, model: fillSource.model, version: fillSource.version,
        ipAddress: fillSource.ipAddress, deviceType: fillSource.deviceType,
        channels: {
          ssh: {
            enabled: chRow('ssh') !== undefined,
            port: chRow('ssh')?.port ?? undefined,
            username: chRow('ssh')?.username ?? undefined,
            sshKeyPath: chRow('ssh')?.sshKeyPath ?? undefined,
          },
          telnet: {
            enabled: chRow('telnet') !== undefined,
            port: chRow('telnet')?.port ?? undefined,
            username: chRow('telnet')?.username ?? undefined,
          },
          web: {
            enabled: chRow('web') !== undefined,
            webUrl: chRow('web')?.webUrl ?? undefined,
          },
          rdp: {
            enabled: chRow('rdp') !== undefined,
            port: chRow('rdp')?.port ?? undefined,
            username: chRow('rdp')?.username ?? undefined,
            // 分辨率非脱敏明文字段，编辑态正常回填（D-04 裁决补记；空=不指定）
            resolution: chRow('rdp')?.resolution ?? undefined,
          },
        },
        // D-07：默认通道必为已配通道之一——仅对应通道行存在时回填（悬空旧值不带入表单态，
        // 缺省由服务层 D-09 滑落收敛为首条已配）
        connectionType:
          !isCopy && fillSource.connectionType && chRow(fillSource.connectionType) !== undefined
            ? fillSource.connectionType
            : undefined,
      })
    } else {
      form.resetFields()
    }
  }, [fillSource, form, open, isCopy])

  // D-09 表单内滑落镜像（§5.4）：现选默认通道不在 on 集合（含空选）→ 滑到固定序下一条 on，
  // 全部 off 置空——滑落无提示；服务层滑落为 DB 权威，此处仅保单次会话视觉一致。
  useEffect(() => {
    if (!open) return
    if (onKeys.length === 0) {
      if (defaultChannel !== undefined) form.setFieldValue('connectionType', undefined)
      return
    }
    if (defaultChannel === undefined || !(onKeys as string[]).includes(defaultChannel)) {
      form.setFieldValue('connectionType', onKeys[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onKeys 由下方四个通道布尔派生
  }, [open, form, defaultChannel, sshOn, telnetOn, webOn, rdpOn])

  // §5.2 auto-on（D-04「填了即启用」）：任一字段输入非空 → 该通道自动置 on；不自动 off
  //（清空字段不自动禁用，禁用必须显式拨 off——防误触丢配置）
  const enableChannel = (ch: ConnectionType) => {
    if (form.getFieldValue(['channels', ch, 'enabled']) !== true) {
      form.setFieldValue(['channels', ch, 'enabled'], true)
    }
  }
  const onChannelFieldChange = (ch: ConnectionType, value: unknown) => {
    if (value !== undefined && value !== null && String(value) !== '') enableChannel(ch)
  }

  // §5.3 H-1 已存提示（SC1「界面只显 ****尾4」落点）：尾4 取自脱敏投影（masked 值即 ****尾4 形态）
  const storedRow = (ch: ConnectionType) =>
    !isCopy && device ? (device.channels ?? []).find((c) => c.channel === ch) : undefined
  const passwordPlaceholder = (ch: ConnectionType): string | undefined => {
    const row = storedRow(ch)
    if (row?.password) return `已存 ${row.password}，留空则不修改`
    return device ? '留空则不修改' : undefined
  }
  const keyContentPlaceholder = (): string | undefined => {
    const row = storedRow('ssh')
    if (row?.sshKeyContent) return `已存密钥（${row.sshKeyContent}），留空则不修改；粘贴新内容将覆盖`
    return device ? '留空则不修改；粘贴新内容将覆盖' : '-----BEGIN OPENSSH PRIVATE KEY-----...（可选）'
  }

  // D-11/D-12：名称失焦实时查重（编辑模式 excludeId=自身；复制/新建 excludeId=undefined）。
  // 命中注入红框错误，错误信息含冲突设备名称与 IP（提示性预检，硬防线在 service 层事务内拦截）。
  const handleNameBlur = async (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.target.value?.trim()
    if (!value) return
    try {
      const hit = await window.api.device.checkName(value, device?.id)
      if (hit) {
        form.setFields([{ name: 'name', errors: [`名称已存在：${hit.name} (${hit.ipAddress})`] }])
      } else {
        form.setFields([{ name: 'name', errors: [] }])
      }
    } catch {
      // 查重通道异常不阻塞表单（提示性预检），提交时 service 层仍会硬拦
    }
  }

  // D-13 分层（警告级）：IP 与「其他设备」（非编辑自身、非复制源）相同 = 黄色警告可保存。
  const handleIpBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.target.value?.trim()
    if (!value || !existingDevices) return
    const dup = existingDevices.find((d) => d.ipAddress === value && d.id !== device?.id && d.id !== copySource?.id)
    if (dup) {
      form.setFields([{ name: 'ipAddress', warnings: [`IP 与设备『${dup.name}』相同，请确认是否允许`] }])
    } else {
      form.setFields([{ name: 'ipAddress', warnings: [] }])
    }
  }

  // D-06 统一保存：Modal「确 定」一次提交 channels 节——enabled 节内空凭证字段剔除
  //（= 留空不修改，H-1）；显式 off 节发 enabled:false 整节提交（服务层 DELETE）；不再发送
  // 任何平铺凭证字段（36-04 终态，通道配置唯一入口 = channels 节）。
  // 防线（36-05 真机 UAT 数据丢失缺陷）：节缺场/未注册（enabled 非 boolean——Tabs 懒渲染
  // 下未点开 tab 的字段不入 form store）绝不可编码为 enabled:false——服务层 DELETE 语义
  // 会静默清掉已存凭证。缺场节整节剔除：服务层对不在场节点零触碰（resolveChannelNodes
  // 只规范化在场节，缺场不清既有子表行），D-09 滑落写后 SQL 重查 DB 集合不受缺场影响。
  // forceRender 已根治懒渲染缺场，此处为回归防线（缺场仅显式 true/false 均非时触发）。
  const handleFinish = async (values: DeviceFormValues) => {
    const hasText = (v: unknown): v is string => typeof v === 'string' && v !== ''
    const nodes: DeviceChannelDTO[] = []
    for (const ch of CHANNEL_KEYS) {
      const sec = values.channels?.[ch]
      if (typeof sec?.enabled !== 'boolean') continue
      if (!sec.enabled) {
        nodes.push({ channel: ch, enabled: false })
        continue
      }
      const node: DeviceChannelDTO = { channel: ch, enabled: true }
      if (sec.port !== undefined && sec.port !== null) node.port = sec.port
      if (hasText(sec.username)) node.username = sec.username
      if (hasText(sec.password)) node.password = sec.password
      if (hasText(sec.sshKeyPath)) node.sshKeyPath = sec.sshKeyPath
      if (hasText(sec.sshKeyContent)) node.sshKeyContent = sec.sshKeyContent
      if (hasText(sec.webUrl)) node.webUrl = sec.webUrl
      // 分辨率非脱敏明文字段（编辑态已回填当前值）：enabled 节随表单现值提交——清空即不指定
      //（空串按字段级 !== undefined 语义直写，openRDP 端格式不符自然忽略）
      if (typeof sec.resolution === 'string') node.resolution = sec.resolution
      nodes.push(node)
    }
    const payload: CreateDeviceDTO = {
      name: values.name, vendor: values.vendor, model: values.model, version: values.version,
      ipAddress: values.ipAddress, deviceType: values.deviceType,
      ...(values.connectionType !== undefined ? { connectionType: values.connectionType } : {}),
      channels: nodes,
    }
    setConfirmLoading(true)
    try {
      await onOk(payload)
    } finally {
      setConfirmLoading(false)
    }
  }

  // 每通道节首行：Switch（显式权威）+ 编辑态拨 off 的 inline 警示（§5.2）
  const sectionHead = (ch: ConnectionType): ReactNode => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <Form.Item name={['channels', ch, 'enabled']} valuePropName="checked" noStyle>
        <Switch />
      </Form.Item>
      {initiallyConfigured.has(ch) && !onMap[ch] && (
        <span style={WARN_INLINE_STYLE}>保存后将删除该通道已存凭证</span>
      )}
    </div>
  )

  const sectionChildren: Record<ConnectionType, ReactNode> = {
    ssh: (
      <>
        {sectionHead('ssh')}
        <Form.Item name={['channels', 'ssh', 'port']} label="端口">
          <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="22" disabled={!sshOn} onChange={(v) => onChannelFieldChange('ssh', v)} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name={['channels', 'ssh', 'username']} label="账号" style={{ flex: 1 }}>
            <Input disabled={!sshOn} onChange={(e) => onChannelFieldChange('ssh', e.target.value)} />
          </Form.Item>
          <Form.Item name={['channels', 'ssh', 'password']} label="密码" style={{ flex: 1 }}>
            <Input.Password placeholder={passwordPlaceholder('ssh')} disabled={!sshOn} onChange={(e) => onChannelFieldChange('ssh', e.target.value)} />
          </Form.Item>
        </div>
        <Form.Item name={['channels', 'ssh', 'sshKeyPath']} label="SSH Key 文件路径">
          <Input placeholder="C:/Users/.ssh/id_rsa（可选）" disabled={!sshOn} onChange={(e) => onChannelFieldChange('ssh', e.target.value)} />
        </Form.Item>
        <Form.Item name={['channels', 'ssh', 'sshKeyContent']} label="或粘贴 SSH Key 内容">
          <Input.TextArea rows={3} placeholder={keyContentPlaceholder()} disabled={!sshOn} onChange={(e) => onChannelFieldChange('ssh', e.target.value)} />
        </Form.Item>
      </>
    ),
    telnet: (
      <>
        {sectionHead('telnet')}
        <Form.Item name={['channels', 'telnet', 'port']} label="端口">
          <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="23" disabled={!telnetOn} onChange={(v) => onChannelFieldChange('telnet', v)} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name={['channels', 'telnet', 'username']} label="账号" style={{ flex: 1 }}>
            <Input disabled={!telnetOn} onChange={(e) => onChannelFieldChange('telnet', e.target.value)} />
          </Form.Item>
          <Form.Item name={['channels', 'telnet', 'password']} label="密码" style={{ flex: 1 }}>
            <Input.Password placeholder={passwordPlaceholder('telnet')} disabled={!telnetOn} onChange={(e) => onChannelFieldChange('telnet', e.target.value)} />
          </Form.Item>
        </div>
      </>
    ),
    web: (
      <>
        {sectionHead('web')}
        <Form.Item name={['channels', 'web', 'webUrl']} label="Web URL">
          <Input placeholder="https://192.168.1.1" disabled={!webOn} onChange={(e) => onChannelFieldChange('web', e.target.value)} />
        </Form.Item>
      </>
    ),
    rdp: (
      <>
        {sectionHead('rdp')}
        <Form.Item name={['channels', 'rdp', 'port']} label="端口">
          <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="3389" disabled={!rdpOn} onChange={(v) => onChannelFieldChange('rdp', v)} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name={['channels', 'rdp', 'username']} label="账号" style={{ flex: 1 }}>
            <Input disabled={!rdpOn} onChange={(e) => onChannelFieldChange('rdp', e.target.value)} />
          </Form.Item>
          {/* WR-02（36 review，RESEARCH A4 裁决「保字段不动行为」）：RDP 密码为预留字段——
              openRDP 仅消费 username/resolution 写 .rdp（mstsc 不支持 .rdp 明文密码行，
              password 51:b 需 DPAPI 密文由 mstsc 自生成），本值加密落库后无连接消费方；
              连接时 mstsc 自行提示输入密码。device_credentials.password_enc 为四通道共享列。 */}
          <Form.Item name={['channels', 'rdp', 'password']} label="密码" style={{ flex: 1 }}>
            <Input.Password placeholder={passwordPlaceholder('rdp')} disabled={!rdpOn} onChange={(e) => onChannelFieldChange('rdp', e.target.value)} />
          </Form.Item>
        </div>
        <Form.Item name={['channels', 'rdp', 'resolution']} label="分辨率">
          <Input placeholder="1920x1080（可选）" disabled={!rdpOn} onChange={(e) => onChannelFieldChange('rdp', e.target.value)} />
        </Form.Item>
      </>
    ),
  }

  return (
    <Modal title={device ? '编辑设备' : isCopy ? '复制设备' : '添加设备'} open={open} onOk={() => form.submit()} onCancel={onCancel} width={600} destroyOnHidden confirmLoading={confirmLoading}>
      {credentialHint && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="该设备尚未配置登录通道" description="补配任一通道的凭证并保存后，即可双击连接。" />
      )}
      {isCopy && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`复制自『${copySource!.name}』`} description="已预填源设备信息（可修改）；密码/密钥不会继承，请重新输入。" />
      )}
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item name="name" label="设备名称" rules={[{ required: true, message: '请输入设备名称' }]}>
          <Input onBlur={handleNameBlur} />
        </Form.Item>
        <Form.Item name="deviceType" label="设备类型" rules={[{ required: true }]}>
          <Select options={[
            { value: 'router', label: '路由器' },
            { value: 'switch', label: '交换机' },
            { value: 'firewall', label: '防火墙' },
            { value: 'server', label: '服务器' },
            { value: 'generic', label: '通用设备' },
          ]} />
        </Form.Item>
        <Form.Item name="vendor" label="厂商" rules={[{ required: true, message: '请输入设备厂商' }]}>
          <Input placeholder="华为、Cisco、H3C..." />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="model" label="型号" style={{ flex: 1 }}>
            <Input placeholder="S5735-L48T4X" />
          </Form.Item>
          <Form.Item name="version" label="版本" style={{ flex: 1 }}>
            <Input placeholder="V200R021" />
          </Form.Item>
        </div>
        <Form.Item
          name="ipAddress"
          label="设备 IP"
          rules={[
            { required: true },
            // D-13 硬拦：复制件与源设备同 IP 必改（红级，validator 阻断提交）
            ...(isCopy
              ? [{
                  validator: (_: unknown, value: string) =>
                    value && value === copySource!.ipAddress
                      ? Promise.reject(new Error('与源设备 IP 相同，必须修改'))
                      : Promise.resolve(),
                }]
              : []),
          ]}
        >
          <Input placeholder="192.168.1.1" onBlur={handleIpBlur} />
        </Form.Item>
        {/* D-07 默认通道（非必填，零通道可保存）：options ⊆ 当前 on 通道（固定序）；
            滑落镜像见上方 useEffect（现选不在集合滑到下一条 on，全 off 置空，无提示） */}
        <Form.Item name="connectionType" label="默认通道" extra="双击直连与 AI 执行命令优先使用默认通道">
          <Select placeholder="未配置" options={onKeys.map((ch) => ({ value: ch, label: CHANNEL_LABELS[ch] }))} />
        </Form.Item>
        {/* D-04 四 tab 常驻不可增删：填了即启用（auto-on）、拨 off 置灰可反悔、已配 dot 标注。
            forceRender：四 pane 首挂即渲染注册全部通道 Form.Item——AntD Tabs 默认懒渲染下
            未点开的 tab 字段不入 form store，useWatch 缺场致已配 dot 不亮/默认通道缺选项/
            onFinish 缺节被编码 enabled:false 静默删已存凭证（36-05 UAT 数据丢失缺陷根因） */}
        <Tabs
          activeKey={activeKey}
          onChange={(k) => setActiveKey(resolveInitialChannel(k as ConnectionType))}
          items={CHANNEL_KEYS.map((ch) => ({
            key: ch,
            forceRender: true,
            label: (
              <span>
                {CHANNEL_LABELS[ch]}
                {onMap[ch] && <span title="已配置" aria-label="已配置" style={CHANNEL_DOT_STYLE} />}
              </span>
            ),
            children: sectionChildren[ch],
          }))}
        />
      </Form>
    </Modal>
  )
}
