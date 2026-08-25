import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Alert, Button, Card, Drawer, Empty, Input, Modal, Popconfirm, Select, Space,
  Spin, Switch, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { WarningOutlined } from '@ant-design/icons'
import type {
  McpConfigDto, McpMatchedDeviceDto, McpPackageViewDto, McpTestRequestDto, McpTestResultDto, McpToolInfoDto,
} from '../../types/electron'
import type { Device } from '../../types/device'
import McpToolManageDrawer from './McpToolManageDrawer'
import McpPackageTab from './McpPackageTab'
import DeviceEnvCards from './DeviceEnvCards'

const { Text } = Typography

// D-05（修订 2026-08-18）：stdio 保存门槛——每次「新建」stdio 配置必弹；编辑不弹

/** 未修改凭证哨兵（main 侧 mcpService/mcpIpc 同名常量约定：沿用已存明文，不重传） */
const UNCHANGED_ENV_SENTINEL = '****__unchanged__'

const ipcErrMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const TYPE_LABEL: Record<'stdio' | 'http' | 'package', string> = {
  stdio: '本地程序 (stdio)',
  http: '网络服务 (http)',
  package: 'MCP 包',
}

const STAGE_TEXT: Record<string, string> = {
  starting: '正在启动程序…',
  handshake: '正在建立连接…',
  listing: '正在获取工具清单…',
}

/** 相对时间（D-09 最近测试列；SQLite localtime 字符串 "YYYY-MM-DD HH:MM:SS"） */
function relativeTime(at: string | null): string {
  if (!at) return ''
  const t = new Date(at.replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return at
  const diff = Date.now() - t
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

function genTestId(): string {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
}

// ---------------------------------------------------------------------------
// 连接测试面板（等待 / 成功 / 失败 三态；表单内与行操作共用）
// ---------------------------------------------------------------------------
interface TestState {
  testId: string
  stage: string
  elapsedSec: number
  running: boolean
  result: McpTestResultDto | null
  cancelled: boolean
  elapsedMs?: number
}

function TestPanel({ state, onCancel }: { state: TestState; onCancel: () => void }) {
  if (state.running) {
    return (
      <Alert
        type="info"
        showIcon
        icon={<Spin size="small" />}
        message={`${STAGE_TEXT[state.stage] ?? STAGE_TEXT.starting}（已耗时 ${state.elapsedSec} 秒）`}
        action={<Button size="small" onClick={onCancel}>取消</Button>}
        style={{ marginBottom: 16 }}
      />
    )
  }
  if (state.cancelled) {
    return <Alert type="info" showIcon message="已取消，测试进程已结束" style={{ marginBottom: 16 }} />
  }
  if (!state.result) return null
  if (!state.result.ok) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 16 }}
        message="连接失败"
        description={
          <div>
            <div>{state.result.error.reason}（<code style={{ fontFamily: 'monospace', fontSize: 13 }}>{state.result.error.code}{state.result.error.errno != null ? ` / ${String(state.result.error.errno)}` : ''}</code>）。可检查命令/地址与凭证后重试。</div>
          </div>
        }
      />
    )
  }
  return null
}

/** 成功结果：工具表格 + 行点击抽屉（D-08） */
function TestSuccessPanel({ result, onOpenTool }: { result: Extract<McpTestResultDto, { ok: true }>; onOpenTool: (t: McpToolInfoDto) => void }) {
  const toolColumns: ColumnsType<McpToolInfoDto> = [
    { title: '名称', dataIndex: 'name', width: 220, render: (v: string) => <code style={{ fontFamily: 'monospace', fontSize: 13 }}>{v}</code> },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '', width: 80,
      render: (_: unknown, record: McpToolInfoDto) => {
        const readOnly = (record.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true
        return readOnly ? <Tag color="success">只读</Tag> : null
      },
    },
  ]
  return (
    <Card size="small" style={{ marginBottom: 16 }} title={`连接成功 · 协议版本 ${result.protocolVersion ?? '未知'} · 共 ${result.tools.length} 个工具`}>
      <Table
        size="small"
        rowKey="name"
        columns={toolColumns}
        dataSource={result.tools}
        pagination={false}
        scroll={{ y: 240 }}
        onRow={(record) => ({ onClick: () => onOpenTool(record), style: { cursor: 'pointer' } })}
      />
    </Card>
  )
}

/** 工具详情抽屉：参数 schema 结构化 + 完整元数据（13px monospace） */
function ToolDrawer({ tool, onClose }: { tool: McpToolInfoDto | null; onClose: () => void }) {
  return (
    <Drawer open={tool != null} onClose={onClose} title={tool ? `工具：${tool.name}` : ''} width={560}>
      {tool && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Text strong>描述</Text>
            <div style={{ marginTop: 4 }}>{tool.description ?? '（无描述）'}</div>
          </div>
          <div>
            <Text strong>参数 schema</Text>
            <pre style={{ fontFamily: 'monospace', fontSize: 13, background: '#fafafa', padding: 8, borderRadius: 4, overflow: 'auto', margin: '4px 0 0' }}>
              {JSON.stringify(tool.inputSchema ?? {}, null, 2)}
            </pre>
          </div>
          <div>
            <Text strong>完整元数据</Text>
            <pre style={{ fontFamily: 'monospace', fontSize: 13, background: '#fafafa', padding: 8, borderRadius: 4, overflow: 'auto', margin: '4px 0 0' }}>
              {JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// 表单状态（受控组件；类型切换清空另一类型字段、保留名称与绑定）
// ---------------------------------------------------------------------------
interface FormState {
  id: number | null
  name: string
  /** 29-09（Gap-2）：表单内部三类型——'package' 仅表单态，落库配置仍 type='stdio'（source='package'） */
  type: 'stdio' | 'http' | 'package'
  commandOrUrl: string
  args: string[]
  credential: string // http 令牌；''=未修改（编辑时）/空（新建）
  credentialMasked: string | null
  deviceIds: string[]
  /** 29-09：package 分支选中的包 id */
  pkgId: number | null
  /** 29-06（D-16）/29-09 Gap-4：stdio 设备级 env（deviceId → 键 → 值，键集合行驱动，值存 ****尾4 哨兵形态） */
  deviceEnvValues: Record<string, Record<string, string>>
}

const emptyForm: FormState = {
  id: null, name: '', type: 'stdio', commandOrUrl: '', args: [],
  credential: '', credentialMasked: null, deviceIds: [], pkgId: null, deviceEnvValues: {},
}

/** "KEY=****尾4" 脱敏条目 → 键（无 = 的畸形条目整条当键） */
function maskedEntryKey(entry: string): string {
  const i = entry.indexOf('=')
  return i > 0 ? entry.slice(0, i) : entry
}

/** "KEY=****尾4" 脱敏条目 → 值（****尾4 形态；畸形条目 '****'） */
function maskedEntryValue(entry: string): string {
  const i = entry.indexOf('=')
  return i > 0 ? entry.slice(i + 1) : '****'
}

export default function McpTab({ refreshKey = 0 }: { refreshKey?: number }) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [configs, setConfigs] = useState<McpConfigDto[]>([])
  const [devices, setDevices] = useState<Device[]>([])

  // 表单
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // WR-05：http 已保存令牌的显式清除标记（保存/临时测试均发「清除」语义，不再无通道可清）
  const [clearCred, setClearCred] = useState(false)

  // 门槛（D-05）
  const [gateOpen, setGateOpen] = useState(false)
  const [gateInput, setGateInput] = useState('')
  const [gateError, setGateError] = useState<string | null>(null)

  // 连接测试（行测试 + 表单测试共用一套状态；表单开着时面板渲染进 Modal）
  const [test, setTest] = useState<TestState | null>(null)
  const testIdRef = useRef<string | null>(null)
  const [drawerTool, setDrawerTool] = useState<McpToolInfoDto | null>(null)

  // D-02 工具管理抽屉（数据源 = mcp:getToolCache 测试缓存）
  const [toolDrawerConfig, setToolDrawerConfig] = useState<McpConfigDto | null>(null)

  // 29-06：stdio 编辑态设备级 env 未修改哨兵基线（openEdit 时快照，保存时比对）
  const editMaskedRef = useRef<Record<string, Record<string, string>>>({})
  // 29-09（Gap-2）：package 分支——已导入包清单 + 型号预筛（已绑定设备过滤后再进弹窗）
  const [pkgs, setPkgs] = useState<McpPackageViewDto[]>([])
  const [matched, setMatched] = useState<McpMatchedDeviceDto[] | null>(null)
  const [matchedForId, setMatchedForId] = useState<number | null>(null)
  const [matchedLoading, setMatchedLoading] = useState(false)

  // 29-08 契约：行删除/键改发 (deviceId, key, '')——空值 = 删除该键
  const setDeviceEnvValue = useCallback((deviceId: string, key: string, v: string) => {
    setForm((f) => {
      const dev = { ...(f.deviceEnvValues[deviceId] ?? {}) }
      if (v === '') delete dev[key]
      else dev[key] = v
      return { ...f, deviceEnvValues: { ...f.deviceEnvValues, [deviceId]: dev } }
    })
  }, [])

  /** package 分支：切换包时清空已绑卡片与 env（不同包匹配面不同） */
  const selectPackage = useCallback((id: number) => {
    setMatched(null)
    setMatchedForId(null)
    setForm((f) => ({ ...f, pkgId: id, deviceIds: [], deviceEnvValues: {} }))
  }, [])

  const addFormDevice = useCallback((deviceId: string) => {
    setForm((f) => ({ ...f, deviceIds: [...f.deviceIds, deviceId] }))
  }, [])

  const removeFormDevice = useCallback((deviceId: string) => {
    setForm((f) => {
      const deviceEnvValues = { ...f.deviceEnvValues }
      delete deviceEnvValues[deviceId]
      return { ...f, deviceIds: f.deviceIds.filter((id) => id !== deviceId), deviceEnvValues }
    })
  }, [])

  // package 分支：已导入（未禁用）包清单——表单切到 package 时加载
  useEffect(() => {
    if (!formOpen || form.type !== 'package') return
    window.api.mcp.listPackages()
      .then((list) => setPkgs(list.filter((p) => !p.disabled)))
      .catch((e: unknown) => setFormError(ipcErrMsg(e)))
  }, [formOpen, form.type])

  // package 分支：选中包后拉型号预筛（已绑定设备过滤后再进 DeviceEnvCards 弹窗）
  useEffect(() => {
    if (!formOpen || form.type !== 'package' || form.pkgId == null || matchedForId === form.pkgId) return
    setMatchedLoading(true)
    window.api.mcp.listMatchedDevices(form.pkgId)
      .then((res) => {
        if (res.ok) { setMatched(res.devices); setMatchedForId(form.pkgId) }
        else setFormError(res.error)
      })
      .catch((e: unknown) => setFormError(ipcErrMsg(e)))
      .finally(() => setMatchedLoading(false))
  }, [formOpen, form.type, form.pkgId, matchedForId])

  // 走查修复（问题1 根因）：整屏 Spin 会卸载 McpPackageTab（导入向导状态丢失、弹窗被吞）。
  // 仅首次加载整屏 Spin；后续刷新（refreshKey/onPackagesChanged 触发）静默更新数据，不卸载子组件。
  const loadedOnceRef = useRef(false)
  const load = useCallback(async () => {
    if (!loadedOnceRef.current) setLoading(true)
    setLoadError(null)
    try {
      const [list, devs] = await Promise.all([window.api.mcp.list(), window.api.device.list()])
      setConfigs(list)
      setDevices(devs)
    } catch (e: unknown) {
      setLoadError(ipcErrMsg(e))
    }
    loadedOnceRef.current = true
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [refreshKey, load])

  // 阶段进度订阅（按 testId 过滤，T-21-04-04）
  useEffect(() => {
    const off = window.api.mcp.onTestProgress((data) => {
      if (testIdRef.current !== data.testId) return
      setTest((prev) => prev ? { ...prev, stage: data.stage, elapsedMs: data.elapsedMs } : prev)
    })
    return off
  }, [])

  // 已耗时秒数计时
  useEffect(() => {
    if (!test?.running) return
    const timer = setInterval(() => {
      setTest((prev) => prev ? { ...prev, elapsedSec: prev.elapsedSec + 1 } : prev)
    }, 1000)
    return () => clearInterval(timer)
  }, [test?.running])

  const deviceIdOwner = (deviceId: string, excludeId: number | null): string | null => {
    for (const c of configs) {
      if (c.id !== excludeId && c.deviceIds.includes(deviceId)) return c.name
    }
    return null
  }

  const openCreate = () => {
    setForm({ ...emptyForm })
    setClearCred(false)
    setFormError(null)
    setTest(null)
    setMatched(null)
    setMatchedForId(null)
    setFormOpen(true)
  }

  const openEdit = (cfg: McpConfigDto) => {
    // 29-06（D-16/D-17）/29-09：stdio 编辑态设备级 env 回显——逐设备 "KEY=****尾4"
    // （存量迁移后每台各一组；键集合行驱动，卡内每台独立展示）
    const deviceEnvValues: Record<string, Record<string, string>> = {}
    const maskedSnap: Record<string, Record<string, string>> = {}
    for (const id of cfg.deviceIds) {
      const m: Record<string, string> = {}
      for (const entry of cfg.deviceEnvMasked[id] ?? []) m[maskedEntryKey(entry)] = maskedEntryValue(entry)
      deviceEnvValues[id] = { ...m }
      maskedSnap[id] = { ...m }
    }
    editMaskedRef.current = maskedSnap
    setForm({
      id: cfg.id,
      name: cfg.name,
      type: cfg.type,
      commandOrUrl: cfg.commandOrUrl,
      args: [...cfg.args],
      credential: '', // 未输入新令牌 = 不修改（credentialMasked 回显）
      credentialMasked: cfg.credentialMasked,
      pkgId: null,
      deviceIds: [...cfg.deviceIds],
      deviceEnvValues,
    })
    setFormError(null)
    setTest(null)
    setClearCred(false)
    setMatched(null)
    setMatchedForId(null)
    setFormOpen(true)
  }

  // 类型切换：保留名称，清空另一类型字段（UI-SPEC 交互契约 1）；
  // 29-09：package 与 stdio/http 互切时清空包选择与设备卡片（匹配面不同，避免脏绑定）
  const switchType = (type: 'stdio' | 'http' | 'package') => {
    setClearCred(false)
    setForm((f) => {
      if (f.type === type) return f
      const crossPackage = type === 'package' || f.type === 'package'
      return {
        ...f, type,
        commandOrUrl: '', args: [], credential: '', credentialMasked: null,
        ...(crossPackage ? { pkgId: null, deviceIds: [], deviceEnvValues: {} } : {}),
      }
    })
    if (type === 'package') { setMatched(null); setMatchedForId(null) }
  }

  /** 表单内「测试连接」：允许未保存值（含刚输入明文）单向即抛即用 */
  const runFormTest = async () => {
    await runTest({
      configId: form.id,
      temp: {
        // package 分支不渲染测试按钮（配置未落库前无 spawn 入口），此处类型收窄必然 stdio/http
        type: form.type as 'stdio' | 'http',
        commandOrUrl: form.commandOrUrl || undefined,
        args: form.type === 'stdio' ? form.args : [],
        // 29-09 Gap-4：stdio env 已设备级化，temp 测试不含设备级 env（沿用已存形态）
        env: undefined,
        // credential：未输入=undefined（沿用已存）；http 输入新值=明文；显式清除=空串（WR-05 统一语义）
        credential: form.type === 'http'
          ? (clearCred ? '' : form.credential !== '' ? form.credential : undefined)
          : undefined,
      },
    })
  }

  /** 行操作「测试」：已存配置解密测试，结果落库（D-09） */
  const runRowTest = async (cfg: McpConfigDto) => {
    setFormOpen(false)
    await runTest({ configId: cfg.id, temp: null })
  }

  const runTest = async (payload: { configId: number | null; temp: McpTestRequestDto['temp'] }) => {
    const testId = genTestId()
    testIdRef.current = testId
    setTest({ testId, stage: 'starting', elapsedSec: 0, running: true, result: null, cancelled: false })
    setDrawerTool(null)
    try {
      const result = await window.api.mcp.testConnection({
        testId,
        configId: payload.configId,
        temp: payload.temp,
      })
      setTest((prev) => {
        if (!prev || prev.testId !== testId) return prev
        return { ...prev, running: false, result, cancelled: !result.ok && result.error.code === 'MCP_CANCELLED' }
      })
      // 已存配置测试后刷新（最近测试列，D-09）
      if (payload.configId != null) load()
    } catch (e: unknown) {
      setTest((prev) => prev ? { ...prev, running: false, result: { ok: false, error: { code: 'IPC_ERROR', reason: ipcErrMsg(e) } } } : prev)
    } finally {
      if (testIdRef.current === testId) testIdRef.current = null
    }
  }

  const cancelRunningTest = async () => {
    const id = test?.testId
    if (!id) return
    try {
      await window.api.mcp.cancelTest(id)
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  // ---- 保存（D-05 修订：每次新建 stdio 必弹门槛；编辑不弹；D-04 冲突 Alert）----
  // 29-09：package 分支不经 stdio 门槛（spawn 入口来自已过五向量校验 + 全树指纹的登记包，
  // 非用户任意命令；T-29-09-04 accept，service 侧 TOCTOU 重验仍生效，真机 HV 用户签字确认）
  const handleSaveClick = () => {
    if (form.type === 'package') {
      doPackageSave()
      return
    }
    if (form.type === 'stdio' && form.id == null) {
      setGateOpen(true)
      return
    }
    doSave()
  }

  /** 29-09（Gap-2）：package 分支保存——单条配置绑定 N 台设备（29-07 通道） */
  const doPackageSave = async () => {
    if (form.name.trim() === '') { setFormError('请填写名称'); return }
    if (form.pkgId == null) { setFormError('请选择 MCP 包'); return }
    if (form.deviceIds.length === 0) { setFormError('请至少绑定一台设备'); return }
    setSaving(true)
    setFormError(null)
    try {
      // 新建无脱敏回显（无哨兵）：非空值条目直接透传输入值
      const deviceEnvs = form.deviceIds.map((id) => {
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(form.deviceEnvValues[id] ?? {})) {
          if (k !== '' && v !== '') env[k] = v
        }
        return { deviceId: id, env }
      })
      const res = await window.api.mcp.createConfigFromPackage(form.pkgId, form.name.trim(), deviceEnvs)
      if (res.ok) {
        message.success('配置已创建')
        setFormOpen(false)
        load()
      } else {
        setFormError(res.error)
      }
    } catch (e: unknown) {
      setFormError(ipcErrMsg(e))
    }
    setSaving(false)
  }

  const passGate = () => {
    if (gateInput !== '我已知晓风险') {
      setGateError('输入内容不匹配，请照抄上方引号内的原文')
      return
    }
    setGateOpen(false)
    setGateInput('')
    setGateError(null)
    doSave()
  }

  const doSave = async () => {
    if (form.name.trim() === '') { setFormError('请填写名称'); return }
    if (form.commandOrUrl.trim() === '') { setFormError(form.type === 'stdio' ? '请填写命令' : '请填写服务地址 URL'); return }
    setSaving(true)
    setFormError(null)
    try {
      const result = await window.api.mcp.save({
        id: form.id,
        name: form.name.trim(),
        // package 分支走 doPackageSave（createConfigFromPackage），此处类型收窄必然 stdio/http
        type: form.type as 'stdio' | 'http',
        commandOrUrl: form.commandOrUrl.trim(),
        args: form.type === 'stdio' ? form.args : [],
        // 29-09 Gap-4：stdio env 全面设备级化——新建与编辑均组装 deviceEnvs，
        // 配置级共享 env 恒为 undefined（main 侧不动共享 env）
        env: form.type === 'stdio' ? undefined : null,
        deviceEnvs: form.type === 'stdio'
          ? form.deviceIds.map((id) => {
              const env: Record<string, string> = {}
              for (const [k, v] of Object.entries(form.deviceEnvValues[id] ?? {})) {
                if (k === '' || v === '') continue
                const snap = editMaskedRef.current[id]?.[k]
                // 值与脱敏回显快照一致 = 未修改 → 哨兵（main 侧沿用该设备已存明文）
                env[k] = snap != null && v === snap ? UNCHANGED_ENV_SENTINEL : v
              }
              return { deviceId: id, env }
            })
          : undefined,
        // WR-05：clearCred → null（清空已存令牌）；留空=undefined（沿用）；非空=重设
        credential: form.type === 'http'
          ? (clearCred ? null : form.credential === '' ? undefined : form.credential)
          : null,
        deviceIds: form.deviceIds,
        enabled: true,
      })
      if (result.ok) {
        message.success('配置已保存')
        setFormOpen(false)
        load()
      } else {
        // D-04 并发冲突等业务拒绝：表单顶部 Alert
        setFormError(result.error)
      }
    } catch (e: unknown) {
      setFormError(ipcErrMsg(e))
    }
    setSaving(false)
  }

  const handleDelete = async (id: number) => {
    try {
      const r = await window.api.mcp.delete(id)
      if (r.ok) {
        message.success('已删除')
        load()
      } else {
        message.error(r.error)
      }
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  const handleToggle = async (id: number, enabled: boolean) => {
    try {
      await window.api.mcp.setEnabled(id, enabled)
      load()
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  const columns: ColumnsType<McpConfigDto> = [
    {
      title: '名称', dataIndex: 'name', width: 240,
      render: (v: string, r) => (
        <Space size={4} style={{ display: 'flex' }}>
          <Text strong style={{ whiteSpace: 'normal', wordBreak: 'break-word', minWidth: 0 }}>{v}</Text>
          {!r.enabled && <Tag style={{ flexShrink: 0, alignSelf: 'flex-start' }}>已停用</Tag>}
        </Space>
      ),
    },
    {
      title: '类型', dataIndex: 'type', width: 140,
      render: (v: 'stdio' | 'http') => <Tag color={v === 'stdio' ? 'blue' : 'green'} style={{ whiteSpace: 'nowrap' }}>{TYPE_LABEL[v]}</Tag>,
    },
    {
      title: '绑定设备', dataIndex: 'deviceNames', width: 180, ellipsis: true,
      render: (names: string[]) => names.length > 0
        ? <Tooltip title={names.join('、')}><span>{names.join('、')}</span></Tooltip>
        : <Text type="secondary">—</Text>,
    },
    {
      title: '最近测试', width: 190, ellipsis: true,
      render: (_: unknown, r: McpConfigDto) => {
        if (r.lastTestStatus === 'success') {
          return <Text style={{ color: '#389e0d' }}>成功 · {r.lastTestToolCount ?? 0} 个工具 · {relativeTime(r.lastTestAt)}</Text>
        }
        if (r.lastTestStatus === 'failed') {
          return <Text type="danger">失败 · {relativeTime(r.lastTestAt)}</Text>
        }
        return <Text type="secondary">—</Text>
      },
    },
    {
      title: '启用', dataIndex: 'enabled', width: 80,
      render: (v: boolean, r: McpConfigDto) => <Switch checked={v} onChange={(checked) => handleToggle(r.id, checked)} />,
    },
    {
      title: '操作', width: 180,
      render: (_: unknown, r: McpConfigDto) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => runRowTest(r)}>测试</Button>
          <Button type="link" size="small" onClick={() => setToolDrawerConfig(r)}>工具</Button>
          <Button type="link" size="small" onClick={() => openEdit(r)}>编辑</Button>
          <Popconfirm
            title={`删除配置「${r.name}」？将同时解除与 ${r.deviceIds.length} 台设备的绑定。`}
            okText="删除" okButtonProps={{ danger: true }} cancelText="取消"
            onConfirm={() => handleDelete(r.id)}
          >
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  if (loading) return <Spin />

  if (loadError != null) {
    return (
      <Alert
        type="error" showIcon
        message={`加载 MCP 配置失败：${loadError}。请重试；若持续失败请重启应用`}
        action={<Button size="small" onClick={load}>重试</Button>}
      />
    )
  }

  const empty = configs.length === 0

  // 29-09（Gap-2）：package 分支——选中包 + 卡片/弹窗候选（已绑定设备过滤，弹窗不出现）
  const pkg = pkgs.find((p) => p.id === form.pkgId) ?? null
  const matchedRows = matched ?? []
  const pkgCards = form.deviceIds.map((id) => {
    const d = matchedRows.find((m) => m.deviceId === id)
    return { deviceId: id, name: d?.name ?? id, model: d?.model ?? null, matchReason: d?.matchedModel ?? null }
  })
  const pkgSelectOptions = matchedRows
    .filter((d) => d.boundConfigName == null)
    .map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      model: d.model,
      matchReason: d.matchedModel,
      boundConfigName: d.boundConfigName,
    }))

  // 29-09 Gap-4：stdio 分支（新建/编辑统一）——卡片 + 弹窗候选（已绑定设备不进弹窗）
  const stdioCards = form.deviceIds.map((id) => {
    const d = devices.find((x) => x.id === id)
    return { deviceId: id, name: d?.name ?? id, model: d?.model || null }
  })
  const stdioSelectOptions = devices
    .filter((d) => deviceIdOwner(d.id, form.id) == null)
    .map((d) => ({ deviceId: d.id, name: d.name, model: d.model || null }))

  const successResult = test && !test.running && !test.cancelled && test.result?.ok ? test.result : null

  const testPanels = test && (
    <>
      <TestPanel state={test} onCancel={cancelRunningTest} />
      {successResult && <TestSuccessPanel result={successResult} onOpenTool={setDrawerTool} />}
    </>
  )

  return (
    <div>
      {/* Gap-1：MCP 包 = 与 MCP 配置平级的一等列表区块（两 Card 垂直并列，间距 16） */}
      <McpPackageTab onPackagesChanged={load} />
      <Card
        style={{ marginTop: 16 }}
        title="MCP 配置"
        size="small"
        extra={(
          <Space>
            <Button type="primary" onClick={openCreate}>新建配置</Button>
          </Space>
        )}
      >
        {empty ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div>
                <div style={{ fontWeight: 600 }}>还没有 MCP 配置</div>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>
                  MCP 配置用于让 AI 通过标准协议操控设备管理界面。点击「新建配置」，填入服务程序或地址并绑定设备即可开始。
                </div>
              </div>
            }
          >
          </Empty>
        ) : (
          <Table size="small" rowKey="id" columns={columns} dataSource={configs} pagination={false} scroll={{ x: 'max-content' }} />
        )}
      </Card>

      {/* 行测试结果区（次级视觉层级，仅触发测试后出现） */}
      {testPanels}

      {/* 新建/编辑 Modal（D-01/D-10/D-11/D-04） */}
      <Modal
        open={formOpen}
        title={form.id != null ? `编辑配置：${form.name}` : '新建配置'}
        okText="保存"
        cancelText="取消"
        onOk={handleSaveClick}
        confirmLoading={saving}
        onCancel={() => { setFormOpen(false); setTest(null) }}
        width={640}
      >
        {formError != null && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={formError} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Text strong>名称</Text>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="配置名称（如：设备运维 MCP）"
              style={{ marginTop: 4 }}
            />
          </div>
          <div>
            <Text strong>类型</Text>
            <Select
              value={form.type}
              onChange={switchType}
              style={{ width: 240, marginTop: 4 }}
              options={[
                { value: 'stdio', label: TYPE_LABEL.stdio },
                { value: 'http', label: TYPE_LABEL.http },
                // 编辑态不提供切到「MCP 包」（包配置只能从包创建，落库即 stdio+package 来源）
                { value: 'package', label: TYPE_LABEL.package, disabled: form.id != null },
              ]}
            />
          </div>
          {/* 走查修复（问题3）：三类型严格分支——http 字段块仅在 type==='http' 渲染，package 分支不混入 */}
          {form.type === 'stdio' ? (
            <>
              <div>
                <Text strong>命令</Text>
                <Input
                  value={form.commandOrUrl}
                  onChange={(e) => setForm((f) => ({ ...f, commandOrUrl: e.target.value }))}
                  placeholder="如 npx 或完整程序路径"
                  style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 13 }}
                />
              </div>
              <div>
                <Text strong>参数</Text>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>逐个添加，输入后按回车确认</div>
                <Select
                  mode="tags"
                  value={form.args}
                  onChange={(args) => setForm((f) => ({ ...f, args }))}
                  style={{ width: '100%', marginTop: 4 }}
                  tokenSeparators={[]}
                  open={false}
                  placeholder="如 -y、@modelcontextprotocol/server-everything"
                />
              </div>
            </>
          ) : form.type === 'http' ? (
            <>
              <div>
                <Text strong>服务地址 URL</Text>
                <Input
                  value={form.commandOrUrl}
                  onChange={(e) => setForm((f) => ({ ...f, commandOrUrl: e.target.value }))}
                  placeholder="如 https://example.com/mcp"
                  style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 13 }}
                />
              </div>
              <div>
                <Text strong>认证令牌（选填）</Text>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>
                  仅支持「静态 Bearer 令牌」：填写后会自动放入请求头 Authorization 中发给对方服务，暂不支持 OAuth 动态授权。若对方服务用网址参数认证（如地址里带 ?key=xxx），直接把 key 保留在服务地址里即可，本框留空。
                </div>
                {form.credentialMasked && !clearCred && (
                  <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>
                    当前已保存：{form.credentialMasked}（留空 = 不修改）
                    <Button type="link" size="small" danger style={{ padding: 0, marginLeft: 8 }} onClick={() => setClearCred(true)}>
                      清除已保存令牌
                    </Button>
                  </div>
                )}
                {clearCred && (
                  <div style={{ fontSize: 12, color: '#d46b08', marginTop: 2 }}>
                    保存后将清除已保存的令牌
                    <Button type="link" size="small" style={{ padding: 0, marginLeft: 8 }} onClick={() => setClearCred(false)}>
                      撤销清除（保留原令牌）
                    </Button>
                  </div>
                )}
                <Input.Password
                  value={form.credential}
                  disabled={clearCred}
                  onChange={(e) => setForm((f) => ({ ...f, credential: e.target.value }))}
                  placeholder={form.credentialMasked ? '留空则沿用已保存令牌' : 'Bearer Token'}
                  style={{ marginTop: 4 }}
                />
              </div>
            </>
          ) : null}
          {form.type === 'stdio' ? (
            // 29-06（D-16）/29-09 Gap-4：新建与编辑统一——逐台设备卡片 + 卡内独立 env（行驱动键集合）
            <div>
              <Text strong>绑定设备与环境变量</Text>
              <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>
                每台绑定设备各一组环境变量（互不影响）；一台设备只能绑定一个 MCP 配置。凭证性质值只回显末 4 位，未修改不会重新保存。
              </div>
              <div style={{ marginTop: 8 }}>
                <DeviceEnvCards
                  cards={stdioCards}
                  envValues={form.deviceEnvValues}
                  onValueChange={setDeviceEnvValue}
                  onAddDevice={addFormDevice}
                  onRemoveDevice={removeFormDevice}
                  selectOptions={stdioSelectOptions}
                />
              </div>
            </div>
          ) : form.type === 'package' ? (
            // 29-09（Gap-2）：MCP 包分支——选包 + 预览 + 逐台设备卡片（已绑定设备不进弹窗）
            <>
              <div>
                <Text strong>选择 MCP 包</Text>
                {pkgs.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="还没有可用的 MCP 包——先在上方「MCP 包」列表完成导入（已禁用的包不可用）"
                  />
                ) : (
                  <>
                    <Select
                      value={form.pkgId ?? undefined}
                      onChange={selectPackage}
                      style={{ width: 480, marginTop: 4 }}
                      placeholder="选择已导入的 MCP 包"
                      options={pkgs.map((p) => ({
                        value: p.id,
                        label: `${p.name}${p.version ? ` v${p.version}` : ''} · ${p.runtime} · ${p.toolCount} 个工具`,
                      }))}
                    />
                    {pkg && (
                      <Card size="small" style={{ marginTop: 8 }}>
                        <Space direction="vertical" size={4}>
                          <div>适用型号：{pkg.models.length > 0 ? pkg.models.map((m) => <Tag key={m}>{m}</Tag>) : <Text type="secondary">未声明（全部设备需手动添加）</Text>}</div>
                          <div>环境变量：{pkg.envKeys.length > 0
                            ? <Space size={4} wrap>{pkg.envKeys.map((k) => <code key={k} style={{ fontFamily: 'monospace', fontSize: 13 }}>{k}</code>)}</Space>
                            : <Text type="secondary">该包未声明环境变量，可按需自定义</Text>}</div>
                          <div style={{ fontSize: 12, color: '#8c8c8c' }}>入口：<code style={{ fontFamily: 'monospace', fontSize: 13 }}>{pkg.entry}</code>（{pkg.runtime}）</div>
                        </Space>
                      </Card>
                    )}
                  </>
                )}
              </div>
              <div>
                <Text strong>绑定设备与环境变量</Text>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>
                  每台绑定设备各一组环境变量（互不影响）；一台设备只能绑定一个 MCP 配置。
                </div>
                <div style={{ marginTop: 8 }}>
                  {matchedLoading ? <Spin /> : (
                    <DeviceEnvCards
                      cards={pkgCards}
                      envValues={form.deviceEnvValues}
                      onValueChange={setDeviceEnvValue}
                      onAddDevice={addFormDevice}
                      onRemoveDevice={removeFormDevice}
                      selectOptions={pkgSelectOptions}
                      emptyHint={form.pkgId == null ? '请先选择 MCP 包，再绑定设备' : undefined}
                    />
                  )}
                </div>
              </div>
            </>
          ) : (
          <div>
            <Text strong>绑定设备</Text>
            <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>一台设备只能绑定一个 MCP 配置</div>
            <Select
              mode="multiple"
              value={form.deviceIds}
              onChange={(deviceIds) => setForm((f) => ({ ...f, deviceIds }))}
              style={{ width: '100%', marginTop: 4 }}
              placeholder="选择要绑定的设备"
              options={devices.map((d) => {
                const owner = deviceIdOwner(d.id, form.id)
                return {
                  value: d.id,
                  label: d.name,
                  disabled: owner != null,
                  title: owner != null ? `已绑配置 ${owner}` : undefined,
                }
              })}
              optionRender={(option) => {
                const owner = deviceIdOwner(option.value as string, form.id)
                return owner != null
                  ? <Tooltip title={`已绑配置 ${owner}`}><span style={{ color: '#bfbfbf' }}>{option.label}（已绑配置 {owner}）</span></Tooltip>
                  : <span>{option.label}</span>
              }}
            />
          </div>
          )}
          {form.type !== 'package' && (
            <div>
              <Button onClick={runFormTest} disabled={test?.running ?? false}>
                测试连接
              </Button>
            </div>
          )}
          {testPanels}
        </div>
      </Modal>

      {/* stdio 新建保存门槛 Modal（D-05 修订：每次新建必弹；编辑不弹） */}
      <Modal
        open={gateOpen}
        title={
          <Space>
            <WarningOutlined style={{ color: '#faad14' }} />
            确认在本机启动程序
          </Space>
        }
        okText="确认"
        cancelText="取消"
        onOk={passGate}
        onCancel={() => { setGateOpen(false); setGateInput(''); setGateError(null) }}
      >
        <div style={{ padding: '8px 0', color: '#595959' }}>
          本地程序 (stdio) 类型的配置保存后，连接时将在此电脑上启动你所填写的程序，并由它连接设备。请确认程序来源可信。请在下方输入「我已知晓风险」继续。
        </div>
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>原文展示：</Text>
          <code style={{ fontFamily: 'monospace', fontSize: 13, background: '#f5f5f5', padding: '2px 6px' }}>我已知晓风险</code>
        </div>
        <Input
          value={gateInput}
          onChange={(e) => { setGateInput(e.target.value); setGateError(null) }}
          placeholder="请输入「我已知晓风险」"
          onPressEnter={passGate}
          status={gateError ? 'error' : undefined}
        />
        {gateError && <Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{gateError}</Text>}
        <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 8 }}>每次新建本地程序 (stdio) 配置都会再次确认；编辑已有配置不触发；网络服务 (http) 类型不触发此确认。</div>
      </Modal>

      <ToolDrawer tool={drawerTool} onClose={() => setDrawerTool(null)} />

      {/* D-02 工具级管理抽屉（启用/免确认，数据源 getToolCache） */}
      <McpToolManageDrawer
        open={toolDrawerConfig != null}
        onClose={() => setToolDrawerConfig(null)}
        config={toolDrawerConfig}
      />
    </div>
  )
}
