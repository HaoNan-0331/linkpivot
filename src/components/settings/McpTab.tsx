import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Alert, Button, Card, Drawer, Empty, Input, Modal, Popconfirm, Select, Space,
  Spin, Switch, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { WarningOutlined } from '@ant-design/icons'
import type { McpConfigDto, McpTestRequestDto, McpTestResultDto, McpToolInfoDto } from '../../types/electron'
import type { Device } from '../../types/device'

const { Text } = Typography

// D-05：stdio 保存门槛——会话内记忆（模块级内存变量，登录会话/renderer 重载自然失效）
let gatePassedInSession = false

/** 未修改凭证哨兵（main 侧 mcpService/mcpIpc 同名常量约定：沿用已存明文，不重传） */
const UNCHANGED_ENV_SENTINEL = '****__unchanged__'

const ipcErrMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const TYPE_LABEL: Record<'stdio' | 'http', string> = {
  stdio: '本地程序 (stdio)',
  http: '网络服务 (http)',
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
// 环境变量编辑器行：fromSaved=true 表示回显脱敏值（未修改 → 哨兵；置空 → 删除）
// ---------------------------------------------------------------------------
interface EnvRow {
  key: string
  value: string
  /** true = 值为脱敏回显（****尾4），未改动；用户一旦输入即转 false（新明文） */
  masked: boolean
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
  type: 'stdio' | 'http'
  commandOrUrl: string
  args: string[]
  envRows: EnvRow[]
  credential: string // http 令牌；''=未修改（编辑时）/空（新建）
  credentialMasked: string | null
  deviceIds: string[]
}

const emptyForm: FormState = {
  id: null, name: '', type: 'stdio', commandOrUrl: '', args: [], envRows: [],
  credential: '', credentialMasked: null, deviceIds: [],
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

  // 门槛（D-05）
  const [gateOpen, setGateOpen] = useState(false)
  const [gateInput, setGateInput] = useState('')
  const [gateError, setGateError] = useState<string | null>(null)

  // 连接测试（行测试 + 表单测试共用一套状态；表单开着时面板渲染进 Modal）
  const [test, setTest] = useState<TestState | null>(null)
  const testIdRef = useRef<string | null>(null)
  const [drawerTool, setDrawerTool] = useState<McpToolInfoDto | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [list, devs] = await Promise.all([window.api.mcp.list(), window.api.device.list()])
      setConfigs(list)
      setDevices(devs)
    } catch (e: unknown) {
      setLoadError(ipcErrMsg(e))
    }
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
    setFormError(null)
    setTest(null)
    setFormOpen(true)
  }

  const openEdit = (cfg: McpConfigDto) => {
    // env 回显：envKeysMasked（"KEY=****尾4"）→ 键 + 脱敏值（masked=true 未修改哨兵）
    const envRows: EnvRow[] = cfg.envKeysMasked.map((entry) => {
      const idx = entry.indexOf('=')
      return idx > 0
        ? { key: entry.slice(0, idx), value: entry.slice(idx + 1), masked: true }
        : { key: entry, value: '****', masked: true }
    })
    setForm({
      id: cfg.id,
      name: cfg.name,
      type: cfg.type,
      commandOrUrl: cfg.commandOrUrl,
      args: [...cfg.args],
      envRows,
      credential: '', // 未输入新令牌 = 不修改（credentialMasked 回显）
      credentialMasked: cfg.credentialMasked,
      deviceIds: [...cfg.deviceIds],
    })
    setFormError(null)
    setTest(null)
    setFormOpen(true)
  }

  // 类型切换：保留名称/绑定，清空另一类型字段（UI-SPEC 交互契约 1）
  const switchType = (type: 'stdio' | 'http') => {
    setForm((f) => f.type === type ? f : {
      ...f, type,
      commandOrUrl: '', args: [], envRows: [], credential: '', credentialMasked: null,
    })
  }

  /** 组装 temp 测试入参 / save 入参共用的 env 抽取 */
  const collectEnv = (): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const row of form.envRows) {
      if (!row.key) continue
      env[row.key] = row.masked ? UNCHANGED_ENV_SENTINEL : row.value
    }
    return env
  }

  /** 表单内「测试连接」：允许未保存值（含刚输入明文）单向即抛即用 */
  const runFormTest = async () => {
    await runTest({
      configId: form.id,
      temp: {
        type: form.type,
        commandOrUrl: form.commandOrUrl || undefined,
        args: form.type === 'stdio' ? form.args : [],
        env: form.type === 'stdio' ? collectEnv() : undefined,
        // credential：未输入=undefined（沿用已存）；http 输入新值=明文
        credential: form.type === 'http' && form.credential !== '' ? form.credential : undefined,
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

  // ---- 保存（stdio 首次门槛 D-05；D-04 冲突 Alert）----
  const handleSaveClick = () => {
    if (form.type === 'stdio' && !gatePassedInSession) {
      setGateOpen(true)
      return
    }
    doSave()
  }

  const passGate = () => {
    if (gateInput !== '我已知晓风险') {
      setGateError('输入内容不匹配，请照抄上方引号内的原文')
      return
    }
    gatePassedInSession = true
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
        type: form.type,
        commandOrUrl: form.commandOrUrl.trim(),
        args: form.type === 'stdio' ? form.args : [],
        env: form.type === 'stdio' ? collectEnv() : null,
        credential: form.type === 'http' ? (form.credential === '' ? undefined : form.credential) : null,
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
      await window.api.mcp.delete(id)
      message.success('已删除')
      load()
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
    { title: '名称', dataIndex: 'name', render: (v: string, r) => (<Space size={4}><Text strong>{v}</Text>{!r.enabled && <Tag>已停用</Tag>}</Space>) },
    {
      title: '类型', dataIndex: 'type', width: 150,
      render: (v: 'stdio' | 'http') => <Tag color={v === 'stdio' ? 'blue' : 'green'}>{TYPE_LABEL[v]}</Tag>,
    },
    {
      title: '绑定设备', dataIndex: 'deviceNames', width: 200,
      render: (names: string[]) => names.length > 0
        ? <Space size={4} wrap>{names.map((n, i) => <Tag key={i}>{n}</Tag>)}</Space>
        : <Text type="secondary">—</Text>,
    },
    {
      title: '最近测试', width: 200,
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

  const successResult = test && !test.running && !test.cancelled && test.result?.ok ? test.result : null

  const testPanels = test && (
    <>
      <TestPanel state={test} onCancel={cancelRunningTest} />
      {successResult && <TestSuccessPanel result={successResult} onOpenTool={setDrawerTool} />}
    </>
  )

  return (
    <div>
      <Card
        title="MCP 配置"
        size="small"
        extra={<Button type="primary" onClick={openCreate}>新建配置</Button>}
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
            <Button type="primary" onClick={openCreate}>新建配置</Button>
          </Empty>
        ) : (
          <Table size="small" rowKey="id" columns={columns} dataSource={configs} pagination={false} />
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
              ]}
            />
          </div>
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
              <div>
                <Text strong>环境变量</Text>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>凭证性质值只回显末 4 位，未修改不会重新保存</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  {form.envRows.map((row, i) => (
                    <Space key={i} align="center">
                      <Input
                        style={{ width: 180 }}
                        value={row.key}
                        onChange={(e) => setForm((f) => {
                          const rows = [...f.envRows]; rows[i] = { ...row, key: e.target.value }; return { ...f, envRows: rows }
                        })}
                        placeholder="变量名"
                      />
                      <Input.Password
                        style={{ width: 260 }}
                        value={row.value}
                        onChange={(e) => setForm((f) => {
                          const rows = [...f.envRows]; rows[i] = { key: row.key, value: e.target.value, masked: false }; return { ...f, envRows: rows }
                        })}
                        placeholder="值"
                      />
                      <Button
                        type="link" size="small" danger
                        onClick={() => setForm((f) => ({ ...f, envRows: f.envRows.filter((_, j) => j !== i) }))}
                      >
                        删除
                      </Button>
                    </Space>
                  ))}
                  <div>
                    <Button size="small" onClick={() => setForm((f) => ({ ...f, envRows: [...f.envRows, { key: '', value: '', masked: false }] }))}>
                      添加变量
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : (
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
                <Text strong>认证令牌</Text>
                {form.credentialMasked && (
                  <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>当前已保存：{form.credentialMasked}（留空 = 不修改）</div>
                )}
                <Input.Password
                  value={form.credential}
                  onChange={(e) => setForm((f) => ({ ...f, credential: e.target.value }))}
                  placeholder={form.credentialMasked ? '留空则沿用已保存令牌' : 'Bearer Token'}
                  style={{ marginTop: 4 }}
                />
              </div>
            </>
          )}
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
          <div>
            <Button onClick={runFormTest} disabled={test?.running ?? false}>
              测试连接
            </Button>
          </div>
          {testPanels}
        </div>
      </Modal>

      {/* stdio 首次保存门槛 Modal（D-05，UI-SPEC 文案逐字） */}
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
        <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 8 }}>本次登录会话内记住，网络服务 (http) 类型不触发此确认。</div>
      </Modal>

      <ToolDrawer tool={drawerTool} onClose={() => setDrawerTool(null)} />
    </div>
  )
}
