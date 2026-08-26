import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert, Button, Card, Drawer, Empty, Input, Modal, Space, Spin, Steps, Table, Tag, Typography, Upload, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CheckCircleOutlined, CloseCircleOutlined, DownloadOutlined, InboxOutlined, WarningOutlined,
} from '@ant-design/icons'
import type {
  McpImportOutcomeDto, McpPackageDeleteImpactDto, McpPackageDetailDto, McpPackageViewDto,
  McpVectorResultDto,
} from '../../types/electron'
import EnvKeyMetaList from './EnvKeyMetaList'

const { Text } = Typography

const ipcErrMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// 六向量标签（校验器 VECTOR_ORDER 同序，D-13：逐项 ✓/✗ + 失败人话 reason；29.1 增 envmeta-lie）
const VECTOR_LABELS: Record<McpVectorResultDto['id'], string> = {
  'manifest-schema': 'manifest 结构',
  'entry-whitelist': '入口类型白名单',
  'zip-slip': '路径逃逸防护',
  'double-extension': '双扩展伪装',
  'manifest-lie': 'manifest 与内容一致',
  'envmeta-lie': 'envMeta 键集一致',
}

const VECTOR_ORDER: McpVectorResultDto['id'][] = [
  'manifest-schema', 'entry-whitelist', 'zip-slip', 'double-extension', 'manifest-lie', 'envmeta-lie',
]

const STAGE_TEXT: Record<string, string> = {
  starting: '正在启动程序…',
  handshake: '正在建立连接…',
  listing: '正在获取工具清单…',
}

function genTestId(): string {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
}

/** 指纹 monospace 展示块 */
function FingerprintBlock({ sha }: { sha: string }) {
  return (
    <pre style={{ fontFamily: 'monospace', fontSize: 13, background: '#fafafa', padding: 8, borderRadius: 4, overflow: 'auto', margin: '4px 0 0', wordBreak: 'break-all' }}>
      {sha}
    </pre>
  )
}

// ---------------------------------------------------------------------------
// 包自动测面板（登记成功后向导内嵌，失败不打断登记态）
// ---------------------------------------------------------------------------
interface PkgTestState {
  testId: string
  stage: string
  elapsedSec: number
  running: boolean
  extraTools: string[]
  missingTools: string[]
  failReason: string | null
}

// ---------------------------------------------------------------------------
// 主组件（Gap-1）：「MCP 包」独立平级列表区块（Card），右上【导入】= 唯一 accent CTA（契约 11）
// ---------------------------------------------------------------------------
export default function McpPackageTab({ onPackagesChanged }: { onPackagesChanged?: () => void }) {
  // ---- 导入向导 ----
  const [wizardOpen, setWizardOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [importing, setImporting] = useState(false)
  const [fileName, setFileName] = useState('')
  const bufferRef = useRef<ArrayBuffer | null>(null)
  const [outcome, setOutcome] = useState<McpImportOutcomeDto | null>(null)
  const [detail, setDetail] = useState<McpPackageDetailDto | null>(null)
  // 覆盖确认（status 'changed' 时出现）
  const [overwriteOpen, setOverwriteOpen] = useState(false)
  const [overwriting, setOverwriting] = useState(false)
  const [overwriteImpact, setOverwriteImpact] = useState<McpPackageDeleteImpactDto | null>(null)
  // 登记后自动测
  const [pkgTest, setPkgTest] = useState<PkgTestState | null>(null)
  const pkgTestIdRef = useRef<string | null>(null)

  // ---- 包列表（平铺区块）----
  const [packages, setPackages] = useState<McpPackageViewDto[]>([])
  const [pkgLoading, setPkgLoading] = useState(false)
  const [fpDetail, setFpDetail] = useState<McpPackageDetailDto | null>(null)
  // 删包确认
  const [deleteTarget, setDeleteTarget] = useState<McpPackageViewDto | null>(null)
  const [deleteImpact, setDeleteImpact] = useState<McpPackageDeleteImpactDto | null>(null)
  const [deleteInput, setDeleteInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  // 行重测
  const [rowTest, setRowTest] = useState<PkgTestState | null>(null)
  const rowTestIdRef = useRef<string | null>(null)

  // 进度事件订阅（向导 + Drawer 行重测共用一套 testId 过滤）
  useEffect(() => {
    const off = window.api.mcp.onPackageTestProgress((data) => {
      const apply = (prev: PkgTestState | null): PkgTestState | null =>
        prev && prev.testId === data.testId ? { ...prev, stage: data.stage } : prev
      if (pkgTestIdRef.current === data.testId) setPkgTest(apply)
      if (rowTestIdRef.current === data.testId) setRowTest(apply)
    })
    return off
  }, [])

  // 已耗时秒数计时（两处测试态）
  useEffect(() => {
    if (!pkgTest?.running && !rowTest?.running) return
    const timer = setInterval(() => {
      setPkgTest((prev) => prev?.running ? { ...prev, elapsedSec: prev.elapsedSec + 1 } : prev)
      setRowTest((prev) => prev?.running ? { ...prev, elapsedSec: prev.elapsedSec + 1 } : prev)
    }, 1000)
    return () => clearInterval(timer)
  }, [pkgTest?.running, rowTest?.running])

  const resetWizard = () => {
    setStep(0)
    setFileName('')
    bufferRef.current = null
    setOutcome(null)
    setDetail(null)
    setOverwriteOpen(false)
    setPkgTest(null)
    setImporting(false)
  }

  const openWizard = () => {
    resetWizard()
    setWizardOpen(true)
  }

  const runTest = async (packageId: number, target: 'wizard' | 'row'): Promise<void> => {
    const testId = genTestId()
    const init: PkgTestState = { testId, stage: 'starting', elapsedSec: 0, running: true, extraTools: [], missingTools: [], failReason: null }
    if (target === 'wizard') { pkgTestIdRef.current = testId; setPkgTest(init) }
    else { rowTestIdRef.current = testId; setRowTest(init) }
    try {
      const r = await window.api.mcp.testPackage({ packageId, testId })
      const done: Partial<PkgTestState> = {
        running: false,
        extraTools: r.extraTools ?? [],
        missingTools: r.missingTools ?? [],
        failReason: r.ok ? null : (r.error ?? '未知原因'),
      }
      if (target === 'wizard') setPkgTest((prev) => prev && prev.testId === testId ? { ...prev, ...done } : prev)
      else setRowTest((prev) => prev && prev.testId === testId ? { ...prev, ...done } : prev)
    } catch (e: unknown) {
      const fail = { running: false, failReason: ipcErrMsg(e) }
      if (target === 'wizard') setPkgTest((prev) => prev && prev.testId === testId ? { ...prev, ...fail } : prev)
      else setRowTest((prev) => prev && prev.testId === testId ? { ...prev, ...fail } : prev)
    } finally {
      if (pkgTestIdRef.current === testId) pkgTestIdRef.current = null
      if (rowTestIdRef.current === testId) rowTestIdRef.current = null
    }
  }

  /** 选文件 → 立即导入（校验+登记/changed 判定），结果驱动向导第 2 步 */
  const handleFile = async (file: File) => {
    setFileName(file.name)
    setImporting(true)
    setOutcome(null)
    setDetail(null)
    try {
      const buffer = await file.arrayBuffer()
      bufferRef.current = buffer
      const r = await window.api.mcp.importPackage(buffer)
      setOutcome(r)
      if (r.ok) {
        const d = await window.api.mcp.getPackage(r.package.id)
        if (d.ok) setDetail(d.package)
        if (r.status === 'changed') {
          try {
            const imp = await window.api.mcp.getPackageDeleteImpact(r.package.id)
            setOverwriteImpact(imp.ok ? imp.impact : null)
          } catch { /* 影响面查询失败不阻断差异展示 */ }
        }
        setStep(1)
        onPackagesChanged?.()
        loadPackages()
      } else {
        setStep(1)
      }
    } catch (e: unknown) {
      setOutcome({ ok: false, error: ipcErrMsg(e) })
      setStep(1)
    }
    setImporting(false)
  }

  const downloadSpec = async () => {
    try {
      const r = await window.api.mcp.exportFormatSpec()
      if (r.ok && !r.canceled) message.success(`已导出到 ${r.path}`)
      if (!r.ok) message.error(r.error)
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  /** 覆盖确认（D-23/D-24）：指纹并排 + env 键三清单，确认后替换 */
  const doOverwrite = async () => {
    const buffer = bufferRef.current
    if (!buffer || outcome?.ok !== true || outcome.status !== 'changed') return
    setOverwriting(true)
    try {
      const r = await window.api.mcp.confirmOverwrite(outcome.package.id, buffer)
      if (r.ok) {
        const d = await window.api.mcp.getPackage(r.package.id)
        if (d.ok) setDetail(d.package)
        // 覆盖完成 → 向导按 exists 形态继续（预览/登记走新内容）
        setOutcome({ ok: true, status: 'exists', package: r.package })
        setOverwriteOpen(false)
        message.success('已用新内容覆盖包文件')
        onPackagesChanged?.()
        loadPackages()
      } else {
        message.error(r.error)
        if (r.vectors) setOutcome({ ok: false, error: r.error, vectors: r.vectors })
      }
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
    setOverwriting(false)
  }

  // ---- 包列表加载（组件挂载即加载；导入/删除后刷新）----
  const loadPackages = useCallback(async () => {
    setPkgLoading(true)
    try {
      setPackages(await window.api.mcp.listPackages())
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
    setPkgLoading(false)
  }, [])

  useEffect(() => {
    loadPackages()
  }, [loadPackages])

  const showFingerprint = async (id: number) => {
    try {
      const r = await window.api.mcp.getPackage(id)
      if (r.ok) setFpDetail(r.package)
      else message.error(r.error)
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  const openDelete = async (pkg: McpPackageViewDto) => {
    setDeleteTarget(pkg)
    setDeleteInput('')
    setDeleteImpact(null)
    try {
      const r = await window.api.mcp.getPackageDeleteImpact(pkg.id)
      if (r.ok) setDeleteImpact(r.impact)
      else message.error(r.error)
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const r = await window.api.mcp.deletePackage(deleteTarget.id)
      if (r.ok) {
        message.success('包已删除')
        setDeleteTarget(null)
        loadPackages()
        onPackagesChanged?.()
      } else {
        message.error(r.error)
      }
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
    setDeleting(false)
  }

  // -------------------------------------------------------------------
  // 渲染：向导第 2 步五向量（视觉锚点，契约 11）
  // -------------------------------------------------------------------
  const renderVectors = () => {
    if (!outcome) return null
    const vectors = outcome.ok ? ([] as McpVectorResultDto[]) : outcome.vectors ?? []
    const failed = !outcome.ok
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {VECTOR_ORDER.map((id) => {
          const v = vectors.find((x) => x.id === id)
          const ok = !failed || (v?.ok ?? false)
          return (
            <div key={id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              {ok
                ? <CheckCircleOutlined style={{ color: '#389e0d', fontSize: 16, lineHeight: '22px' }} />
                : <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 16, lineHeight: '22px' }} />}
              <div>
                <Text strong>{VECTOR_LABELS[id]}</Text>
                {!ok && v?.reason && (
                  <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>
                    {VECTOR_LABELS[id]}未通过：{v.reason}。可联系包作者修正后重新打包。
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const toolColumns: ColumnsType<{ name: string; description: string; readOnlyHint?: boolean }> = [
    { title: '名称', dataIndex: 'name', width: 220, render: (v: string) => <code style={{ fontFamily: 'monospace', fontSize: 13 }}>{v}</code> },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '', width: 80,
      render: (_: unknown, record) => record.readOnlyHint === true ? <Tag color="success">只读</Tag> : null,
    },
  ]

  const pkgColumns: ColumnsType<McpPackageViewDto> = [
    {
      title: '名称', dataIndex: 'name', width: 200,
      render: (v: string, r) => (
        <Space size={4} style={{ display: 'flex' }}>
          <Text strong style={{ whiteSpace: 'normal', wordBreak: 'break-word', minWidth: 0 }}>{v}</Text>
          {r.disabled && <Tag color="red" style={{ flexShrink: 0, alignSelf: 'flex-start' }}>已禁用</Tag>}
          {(r.lastTest?.extraTools?.length ?? 0) > 0 && !r.disabled && (
            <Tag color="orange" style={{ flexShrink: 0, alignSelf: 'flex-start' }}>工具不一致</Tag>
          )}
        </Space>
      ),
    },
    { title: '版本', dataIndex: 'version', width: 90, render: (v: string | null) => <code style={{ fontFamily: 'monospace', fontSize: 13 }}>{v ?? '—'}</code> },
    { title: '运行时', dataIndex: 'runtime', width: 90, render: (v: 'node' | 'python') => <Tag color={v === 'node' ? 'blue' : 'purple'}>{v}</Tag> },
    { title: '工具数', dataIndex: 'toolCount', width: 70 },
    {
      title: '操作', width: 200,
      render: (_: unknown, r) => (
        <Space size={4}>
          <Button type="link" size="small" disabled={rowTest?.running ?? false} onClick={() => runTest(r.id, 'row')}>重测</Button>
          <Button type="link" size="small" onClick={() => showFingerprint(r.id)}>指纹</Button>
          <Button type="link" size="small" danger onClick={() => openDelete(r)}>删除</Button>
        </Space>
      ),
    },
  ]

  /** 包差异/禁用明细（D-28 徽章可见性；无任何一键信任按钮，D-25/契约 6） */
  const pkgRowDetail = (r: McpPackageViewDto) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
      {r.disabled && (
        <Alert
          type="error" showIcon
          message="启动前完整性校验失败，包已被禁用。请重新导入并完成校验后恢复。"
        />
      )}
      {(r.lastTest?.extraTools?.length ?? 0) > 0 && (
        <Alert
          type="warning" showIcon
          message={`实测多出 ${r.lastTest!.extraTools.length} 个未声明工具，已默认禁用不暴露给 AI。请包作者修正 manifest 重新发布后重新导入。`}
          description={r.lastTest!.extraTools.join('、')}
        />
      )}
      {(r.lastTest?.missingTools?.length ?? 0) > 0 && (
        <Alert
          type="info" showIcon
          message={`manifest 声明的 ${r.lastTest!.missingTools.length} 个工具实测未提供：${r.lastTest!.missingTools.join('、')}`}
        />
      )}
      {r.lastTest && !r.lastTest.ok && r.lastTest.reason && (
        <Alert type="error" showIcon message={`上次自动测试失败（${r.lastTest.stage} 阶段）：${r.lastTest.reason}`} />
      )}
      {/* 走查修复（问题2）：健康包四类告警全空时展开行不能是空白——给出明确「无异常」结论 */}
      {!r.disabled
        && (r.lastTest?.extraTools?.length ?? 0) === 0
        && (r.lastTest?.missingTools?.length ?? 0) === 0
        && !(r.lastTest && !r.lastTest.ok && r.lastTest.reason) && (
        <Text type="secondary">
          无异常：五项安全校验通过，无工具差异{r.lastTest?.ok ? '，上次自动测试通过' : '（尚未执行自动测试，可点「重测」验证）'}。
        </Text>
      )}
    </div>
  )

  // 契约 1：严格线性不可跳步——第 1 步未选文件/导入中、第 2 步校验失败或详情缺失时禁用下一步
  const wizardNextDisabled =
    (step === 0 && (importing || outcome == null)) ||
    (step === 1 && outcome != null && !outcome.ok) ||
    (step === 2 && detail == null)

  return (
    <>
      {/* Gap-1：包是与配置平级的一等列表区块；右上【导入】= 本页唯一 accent CTA（契约 11） */}
      <Card
        title="MCP 包"
        size="small"
        extra={<Button type="primary" onClick={openWizard}>导入</Button>}
      >
        {pkgLoading ? <Spin /> : packages.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div>
                <div style={{ fontWeight: 600 }}>还没有导入 MCP 包</div>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>
                  MCP 包（.mcpb）是打包好的设备操控工具集，一个产品一个包。
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={openWizard}>导入包</Button>
                  校验通过后即可在新建配置时选用。
                </div>
              </div>
            }
          />
        ) : (
          <Table
            size="small" rowKey="id" columns={pkgColumns} dataSource={packages}
            pagination={false} expandable={{ expandedRowRender: pkgRowDetail }}
          />
        )}
        {rowTest?.running && (
          <Alert style={{ marginTop: 16 }} type="info" showIcon icon={<Spin size="small" />} message={`${STAGE_TEXT[rowTest.stage] ?? STAGE_TEXT.starting}（已耗时 ${rowTest.elapsedSec} 秒）`} />
        )}
        {rowTest && !rowTest.running && (
          <Alert
            style={{ marginTop: 16 }}
            type={rowTest.failReason == null ? 'success' : 'error'}
            showIcon
            message={rowTest.failReason == null ? '自动测试通过' : `自动测试失败：${rowTest.failReason}`}
            description={rowTest.failReason == null && rowTest.extraTools.length > 0
              ? `实测多出 ${rowTest.extraTools.length} 个未声明工具，已默认禁用不暴露给 AI。请包作者修正 manifest 重新发布后重新导入。`
              : undefined}
          />
        )}
      </Card>

      {/* 四步导入向导（宽 720，严格线性不可跳步，契约 1） */}
      <Modal
        open={wizardOpen}
        title="导入 MCP 包"
        width={720}
        footer={null}
        onCancel={() => setWizardOpen(false)}
      >
        <Steps
          size="small"
          current={step}
          items={[{ title: '选择文件' }, { title: '校验结果' }, { title: '预览详情' }, { title: '确认登记' }]}
        />
        <div style={{ marginTop: 24, minHeight: 200 }}>
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Upload.Dragger
                accept=".mcpb"
                maxCount={1}
                showUploadList={false}
                beforeUpload={(file) => { handleFile(file); return false }}
                disabled={importing}
              >
                <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                <p className="ant-upload-text">{importing ? '正在读取并校验包…' : '点击或拖入 .mcpb 包文件'}</p>
                <p className="ant-upload-hint">单个包 ≤200MB；导入前会执行五项安全校验</p>
              </Upload.Dragger>
              <div>
                <Button type="link" icon={<DownloadOutlined />} style={{ padding: 0 }} onClick={downloadSpec}>
                  下载 .mcpb 格式说明
                </Button>
              </div>
            </div>
          )}
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {importing && <Spin />}
              {!importing && outcome && (
                <>
                  {renderVectors()}
                  {outcome.ok && outcome.status === 'changed' && (
                    <Alert
                      type="warning" showIcon
                      message="检测到同名包内容已变化"
                      description={
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div>新旧指纹不一致。确认后将用新内容替换包文件，配置及其设备绑定关系原样保留。</div>
                          <Button danger onClick={() => setOverwriteOpen(true)}>查看差异并覆盖</Button>
                        </div>
                      }
                    />
                  )}
                  {outcome.ok && outcome.status === 'exists' && (
                    <Alert type="info" showIcon message="该包内容与已登记版本完全一致，无需重复导入。可直接进入下一步完成登记确认。" />
                  )}
                  {!outcome.ok && (
                    <Alert type="error" showIcon message="包校验未通过，无法导入" description={fileName ? `文件：${fileName}` : undefined} />
                  )}
                </>
              )}
            </div>
          )}
          {step === 2 && detail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <Text strong>将启动</Text>
                <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Tag color={detail.runtime === 'node' ? 'blue' : 'purple'}>{detail.runtime}</Tag>
                  <code style={{ fontFamily: 'monospace', fontSize: 13 }}>{detail.runtime === 'node' ? 'node' : 'python/python.exe'} {detail.entry}</code>
                </div>
              </div>
              <div>
                <Text strong>工具清单（{detail.manifest.tools.length} 个）</Text>
                <Table
                  size="small" rowKey="name" columns={toolColumns} dataSource={detail.manifest.tools}
                  pagination={false} scroll={{ y: 240 }} style={{ marginTop: 8 }}
                />
              </div>
              <div>
                <Text strong>适用型号</Text>
                <div style={{ marginTop: 4 }}>
                  {detail.models.length > 0
                    ? detail.models.map((m) => <Tag key={m}>{m}</Tag>)
                    : <Text type="secondary">未声明（任意设备可选用）</Text>}
                </div>
              </div>
              <div>
                <Text strong>环境变量键</Text>
                <div style={{ marginTop: 4 }}>
                  {/* 29.1 UAT：展示逻辑抽 EnvKeyMetaList 单源（与 McpTab 包信息区永同步） */}
                  {detail.envKeys.length > 0
                    ? <EnvKeyMetaList envKeys={detail.envKeys} envMeta={detail.envMeta} />
                    : <Text type="secondary">该包未声明环境变量，无需填写</Text>}
                </div>
              </div>
            </div>
          )}
          {step === 3 && detail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Alert
                type="info" showIcon
                message={<>即将登记 <Text strong>{detail.name}</Text>（v{detail.version}，{detail.toolCount} 个工具）。登记不创建配置、不绑定设备，仅入库供后续「从包创建配置」选用。</>}
              />
              {/* 登记后内嵌自动测面板（失败不打断登记态） */}
              {pkgTest?.running && (
                <Alert type="info" showIcon icon={<Spin size="small" />} message={`${STAGE_TEXT[pkgTest.stage] ?? STAGE_TEXT.starting}（已耗时 ${pkgTest.elapsedSec} 秒）`} />
              )}
              {pkgTest && !pkgTest.running && pkgTest.failReason == null && (
                <Alert
                  type="success" showIcon
                  message="自动测试通过，工具清单与 manifest 一致"
                  description={pkgTest.extraTools.length > 0
                    ? `实测多出 ${pkgTest.extraTools.length} 个未声明工具，已默认禁用不暴露给 AI。请包作者修正 manifest 重新发布后重新导入。`
                    : undefined}
                />
              )}
              {pkgTest && !pkgTest.running && pkgTest.failReason != null && (
                <Alert
                  type="error" showIcon
                  message="登记成功但自动测试失败：请查看以下诊断。包已登记，可稍后在包管理中重测或诊断。"
                  description={`${STAGE_TEXT[pkgTest.stage] ? `${pkgTest.stage} 阶段` : ''} ${pkgTest.failReason}`.trim()}
                />
              )}
            </div>
          )}
        </div>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {/* 走查修复（问题1）：换文件 = 重置向导并显式保持弹窗打开，回到第 1 步重新选文件 */}
          {step > 0 && (
            <Button onClick={() => {
              if (step === 1) { resetWizard(); setWizardOpen(true) } else setStep(step - 1)
            }}>{step === 1 ? '换文件' : '上一步'}</Button>
          )}
          {step < 3 && (
            <Button type="primary" disabled={wizardNextDisabled} onClick={() => setStep(step + 1)}>下一步</Button>
          )}
          {step === 3 && detail && !pkgTest && (
            <Button type="primary" onClick={() => runTest(detail.id, 'wizard')}>确认登记入库</Button>
          )}
          {step === 3 && pkgTest && (
            <Button type="primary" onClick={() => { setWizardOpen(false); onPackagesChanged?.(); loadPackages() }}>完成</Button>
          )}
        </div>
      </Modal>

      {/* 重导入覆盖确认 Modal（D-23/D-24，契约 6：无快捷信任通道） */}
      <Modal
        open={overwriteOpen}
        title="检测到同名包内容已变化"
        okText="确认覆盖"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={overwriting}
        onOk={doOverwrite}
        onCancel={() => setOverwriteOpen(false)}
        width={640}
      >
        {outcome?.ok && outcome.status === 'changed' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 8 }}>
            <div>
              确认后将用新内容替换包文件，{overwriteImpact ? overwriteImpact.configs.length : 0} 条配置及其设备绑定关系原样保留。
              （env 键变化：保留 {outcome.diff.env.kept.length} 个 / 新增 {outcome.diff.env.added.length} 个需在绑定设备时补填 / 删除 {outcome.diff.env.removed.length} 个——已保存的对应设备值将被一并移除）
            </div>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <Text strong>旧指纹（v{outcome.diff.oldVersion || '?'}）</Text>
                <FingerprintBlock sha={outcome.diff.oldTreeSha256} />
              </div>
              <div style={{ flex: 1 }}>
                <Text strong>新指纹（v{outcome.diff.newVersion}）</Text>
                <FingerprintBlock sha={outcome.diff.newTreeSha256} />
              </div>
            </div>
            <div>
              <Text strong>env 键清单</Text>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13 }}>
                {outcome.diff.env.kept.map((k) => <li key={`k-${k}`}><code style={{ fontFamily: 'monospace', fontSize: 13 }}>{k}</code>{detail?.envMeta?.[k] ? `（${detail.envMeta[k].label}）` : ''} — 保留</li>)}
                {outcome.diff.env.added.map((k) => <li key={`a-${k}`}><code style={{ fontFamily: 'monospace', fontSize: 13 }}>{k}</code>{detail?.envMeta?.[k] ? `（${detail.envMeta[k].label}）` : ''} — 新增（绑定设备时补填值）</li>)}
                {outcome.diff.env.removed.map((k) => <li key={`r-${k}`}><code style={{ fontFamily: 'monospace', fontSize: 13 }}>{k}</code> — 删除</li>)}
              </ul>
            </div>
            {(outcome.diff.toolsAdded.length > 0 || outcome.diff.toolsRemoved.length > 0) && (
              <div>
                <Text strong>工具变化</Text>
                <div style={{ marginTop: 4, fontSize: 13 }}>
                  {outcome.diff.toolsAdded.length > 0 && <div>新增：{outcome.diff.toolsAdded.join('、')}</div>}
                  {outcome.diff.toolsRemoved.length > 0 && <div>移除：{outcome.diff.toolsRemoved.join('、')}</div>}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 指纹查看 Drawer（monospace） */}
      <Drawer
        open={fpDetail != null}
        onClose={() => setFpDetail(null)}
        title={fpDetail ? `指纹：${fpDetail.name}` : ''}
        width={560}
      >
        {fpDetail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <Text strong>全树 SHA-256</Text>
              <FingerprintBlock sha={fpDetail.fingerprintTreeSha256} />
            </div>
            <div>
              <Text strong>文件清单（{fpDetail.fingerprintFiles.length} 个）</Text>
              <Table
                size="small" rowKey="path" style={{ marginTop: 8 }}
                pagination={false} scroll={{ y: 320 }}
                dataSource={fpDetail.fingerprintFiles}
                columns={[
                  { title: '路径', dataIndex: 'path', ellipsis: true, render: (v: string) => <code style={{ fontFamily: 'monospace', fontSize: 13 }}>{v}</code> },
                  { title: 'SHA-256', dataIndex: 'sha256', ellipsis: true, render: (v: string) => <code style={{ fontFamily: 'monospace', fontSize: 13 }}>{v.slice(0, 16)}…</code> },
                ]}
              />
            </div>
          </div>
        )}
      </Drawer>

      {/* 删包级联确认（D-30，契约 7：输入包名原文） */}
      <Modal
        open={deleteTarget != null}
        title={
          <Space>
            <WarningOutlined style={{ color: '#faad14' }} />
            删除包「{deleteTarget?.name ?? ''}」
          </Space>
        }
        okText="删除"
        okButtonProps={{ danger: true, disabled: !deleteTarget || deleteInput !== deleteTarget.name }}
        cancelText="取消"
        confirmLoading={deleting}
        onOk={doDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        {deleteImpact && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {deleteImpact.configs.length > 0
                ? deleteImpact.configs.map((c) => <li key={c.id}>删除配置「{c.name}」（含 {c.deviceCount} 台设备绑定）</li>)
                : <li>该包没有关联配置，无级联影响</li>}
              {deleteImpact.configs.length > 0 && <li>解绑设备共 {deleteImpact.totalDevices} 台</li>}
              <li>删除包文件目录：<code style={{ fontFamily: 'monospace', fontSize: 13 }}>{deleteImpact.dirPath}</code></li>
            </ul>
            <div style={{ color: '#595959' }}>此操作不可撤销。请在下方输入包名原文「{deleteTarget?.name}」确认。</div>
            <Input
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              placeholder={`请输入包名原文：${deleteTarget?.name ?? ''}`}
            />
          </div>
        )}
      </Modal>
    </>
  )
}
