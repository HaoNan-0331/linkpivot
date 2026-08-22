import { useState, useEffect, useMemo } from 'react'
import { Table, Button, Tag, Tabs, Card, Modal, Tooltip, Segmented, Empty } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { AIExecLog, AISystemLog } from '@/types/electron'

// ---------- AI 助手执行日志 ----------

const statusConfig: Record<string, { color: string; label: string }> = {
  approved: { color: 'green', label: '已批准' },
  rejected: { color: 'red', label: '已拒绝' },
  pending: { color: 'orange', label: '待确认' },
  executed: { color: 'blue', label: '已执行' },
  failed: { color: 'red', label: '执行失败' },
}

// Phase 27 checkpoint（用户语义定案）：越权处理结果二态——唯一放行路径是点「确认执行」；
// 其余一切（点取消/关弹窗/切界面/关应用/TTL 过期）统一「用户取消」（main 侧 reconcile 订正，
// 此处兜底：reconcile 前的极短暂 pending 窗口也按取消显示）。
function guardOutcomeOf(log: AIExecLog): 'user_confirmed' | 'user_cancelled' {
  return log.guardOutcome === 'user_confirmed' ? 'user_confirmed' : 'user_cancelled'
}

const guardOutcomeConfig: Record<string, { color: string; label: string }> = {
  user_confirmed: { color: 'green', label: '用户确认放行' },
  user_cancelled: { color: 'red', label: '用户取消' },
}

function AIExecLogTab() {
  const [logs, setLogs] = useState<AIExecLog[]>([])
  const [loading, setLoading] = useState(false)
  const [detailLog, setDetailLog] = useState<AIExecLog | null>(null)
  // Phase 27（D-07）：全部 | 越权记录 二档；越权档内三态筛选（D-08：不做场景/设备/时间筛选）
  const [view, setView] = useState<'全部' | '越权记录'>('全部')
  const [outcomeFilter, setOutcomeFilter] = useState<string>('全部')

  const load = async () => {
    setLoading(true)
    try {
      const data = await window.api.ai.getLogs(200)
      setLogs(data)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const guardLogs = useMemo(() => logs.filter((l) => (l.guardHits?.length ?? 0) > 0), [logs])
  const filteredGuardLogs = useMemo(() => {
    if (outcomeFilter === '全部') return guardLogs
    const key = Object.keys(guardOutcomeConfig).find(
      (k) => guardOutcomeConfig[k].label === outcomeFilter
    )
    return guardLogs.filter((l) => key ? guardOutcomeOf(l) === key : true)
  }, [guardLogs, outcomeFilter])

  const isGuardView = view === '越权记录'
  const dataSource = isGuardView ? filteredGuardLogs : logs

  return (
    <>
      <Card
        title="AI 助手执行日志"
        size="small"
        extra={<Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>}
      >
        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <Segmented
            value={view}
            onChange={(v) => {
              setView(v as '全部' | '越权记录')
              // checkpoint 反馈：切视图自动刷新——测试后切回看不到新记录，需手动点刷新才可见
              if (v === '越权记录') load()
            }}
            options={['全部', '越权记录']}
          />
          {isGuardView && (
            <Segmented
              value={outcomeFilter}
              onChange={(v) => setOutcomeFilter(v as string)}
              options={['全部', '用户确认放行', '用户取消']}
            />
          )}
        </div>
        {isGuardView && dataSource.length === 0 && !loading ? (
          <Empty
            description={
              <span>
                {outcomeFilter === '全部'
                  ? '暂无越权记录——AI 命令未触发任何越权规则'
                  : `「${outcomeFilter}」筛选档暂无匹配记录（越权记录共 ${guardLogs.length} 条）`}
                <br />
                <span style={{ color: '#999', fontSize: 12 }}>
                  当 AI 命令目标超出对话设备集或发生跳转时，会在此留下确认记录；未点「确认执行」的一切中断均记为用户取消
                </span>
              </span>
            }
          />
        ) : (
        <Table<AIExecLog>
          dataSource={dataSource}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 800 }}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 170,
              render: (v: string) => new Date(v).toLocaleString(),
            },
            {
              title: '设备',
              dataIndex: 'deviceName',
              width: 120,
            },
            {
              title: '命令',
              dataIndex: 'command',
              width: 200,
              ellipsis: true,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (v: string) => {
                const cfg = statusConfig[v]
                return cfg ? <Tag color={cfg.color}>{cfg.label}</Tag> : v
              },
            },
            ...(isGuardView ? [{
              title: '处理结果',
              width: 120,
              render: (_: unknown, record: AIExecLog) => {
                const outcome = guardOutcomeOf(record)
                if (!outcome) return '-'
                const cfg = guardOutcomeConfig[outcome]
                return <Tag color={cfg.color}>{cfg.label}</Tag>
              },
            }, {
              title: '命中规则',
              width: 140,
              render: (_: unknown, record: AIExecLog) => (
                <span>
                  {(record.guardHits ?? []).map((h, i) => (
                    <Tooltip key={i} title={h.explanation}>
                      <Tag color={h.level === 'red' ? 'red' : 'gold'} style={{ fontSize: 13 }}>{h.ruleId}</Tag>
                    </Tooltip>
                  ))}
                </span>
              ),
            }] : []),
            {
              title: '模式',
              dataIndex: 'mode',
              width: 90,
              render: (v: string) => {
                // checkpoint 反馈：越权视图下 auto 命中记录 = 全自动模式仍被防线强制打断（D-06），
                // 需明确标识「自动拦截」区分于普通 auto 直执行记录；三档模式各得其所（smart 此前误标「确认」）
                if (v === 'auto') {
                  return <Tag color="purple">{isGuardView ? '自动拦截' : '自动'}</Tag>
                }
                if (v === 'smart') return <Tag>智能</Tag>
                return <Tag>确认</Tag>
              },
            },
            {
              title: 'AI 原因',
              dataIndex: 'aiReason',
              ellipsis: true,
              render: (v: string) => (
                <Tooltip title={v}><span>{v}</span></Tooltip>
              ),
            },
            {
              title: '操作',
              width: 80,
              render: (_: unknown, record: AIExecLog) => (
                <Button type="link" size="small" onClick={() => setDetailLog(record)}>
                  详情
                </Button>
              ),
            },
          ]}
        />
        )}
      </Card>

      <Modal
        open={!!detailLog}
        title="执行日志详情"
        onCancel={() => setDetailLog(null)}
        footer={null}
        width={720}
      >
        {detailLog && (
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            <div style={{ marginBottom: 12 }}>
              <strong>设备:</strong> {detailLog.deviceName}
            </div>
            <div style={{ marginBottom: 12 }}>
              <strong>执行命令:</strong> {detailLog.command}
            </div>
            <div style={{ marginBottom: 12 }}>
              <strong>状态:</strong>{' '}
              {(() => {
                const cfg = statusConfig[detailLog.status]
                return cfg ? <Tag color={cfg.color}>{cfg.label}</Tag> : detailLog.status
              })()}
            </div>
            <div style={{ marginBottom: 12 }}>
              <strong>模式:</strong>{' '}
              <Tag color={detailLog.mode === 'auto' ? 'purple' : 'default'}>
                {detailLog.mode === 'auto' ? '自动（越权命令仍强制打断确认）' : detailLog.mode === 'smart' ? '智能' : '确认'}
              </Tag>
              {detailLog.mode === 'auto' && detailLog.guardHits && detailLog.guardHits.length > 0 && (
                <span style={{ color: '#999', fontSize: 12, marginLeft: 4 }}>auto 模式拦截记录</span>
              )}
            </div>
            <div style={{ marginBottom: 8 }}>
              <strong>发送给 AI 的 Prompt:</strong>
            </div>
            <pre style={{
              background: '#f5f5f5', padding: 12, borderRadius: 4,
              fontSize: 12, maxHeight: 200, overflow: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {detailLog.promptText || '(空)'}
            </pre>
            <div style={{ margin: '12px 0 8px' }}>
              <strong>AI 原始响应:</strong>
            </div>
            <pre style={{
              background: '#f5f5f5', padding: 12, borderRadius: 4,
              fontSize: 12, maxHeight: 200, overflow: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {detailLog.aiResponse || '(空)'}
            </pre>
          </div>
        )}
      </Modal>
    </>
  )
}

// ---------- AI 系统执行日志 ----------

function AISystemLogTab() {
  const [logs, setLogs] = useState<AISystemLog[]>([])
  const [loading, setLoading] = useState(false)
  const [detailLog, setDetailLog] = useState<AISystemLog | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const data = await window.api.ai.getSystemLogs(100)
      setLogs(data)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <>
      <Card
        title="AI 系统执行日志（拓扑发现）"
        size="small"
        extra={<Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>}
      >
        <Table<AISystemLog>
          dataSource={logs}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 700 }}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 170,
              render: (v: string) => new Date(v).toLocaleString(),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (v: string) => (
                <Tag color={v === 'success' ? 'green' : 'red'}>
                  {v === 'success' ? '成功' : '失败'}
                </Tag>
              ),
            },
            {
              title: '设备',
              dataIndex: 'deviceNames',
              width: 200,
              ellipsis: true,
            },
            {
              title: '错误信息',
              dataIndex: 'errorMessage',
              ellipsis: true,
              render: (v: string) => v || '-',
            },
            {
              title: '操作',
              width: 80,
              render: (_: unknown, record: AISystemLog) => (
                <Button type="link" size="small" onClick={() => setDetailLog(record)}>
                  详情
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={!!detailLog}
        title={`系统日志详情 — ${detailLog?.status === 'success' ? '成功' : '失败'}`}
        onCancel={() => setDetailLog(null)}
        footer={null}
        width={720}
      >
        {detailLog && (
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            <div style={{ marginBottom: 12 }}>
              <strong>设备:</strong> {detailLog.deviceNames}
            </div>
            {detailLog.errorMessage && (
              <div style={{ marginBottom: 12, color: '#ff4d4f' }}>
                <strong>错误:</strong> {detailLog.errorMessage}
              </div>
            )}
            <div style={{ marginBottom: 8 }}>
              <strong>发送给 AI 的 Prompt:</strong>
            </div>
            <pre style={{
              background: '#f5f5f5', padding: 12, borderRadius: 4,
              fontSize: 12, maxHeight: 200, overflow: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {detailLog.promptText || '(空)'}
            </pre>
            <div style={{ margin: '12px 0 8px' }}>
              <strong>AI 原始响应:</strong>
            </div>
            <pre style={{
              background: '#f5f5f5', padding: 12, borderRadius: 4,
              fontSize: 12, maxHeight: 200, overflow: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {detailLog.aiResponse || '(空)'}
            </pre>
            {detailLog.parsedResult && (
              <>
                <div style={{ margin: '12px 0 8px' }}>
                  <strong>解析结果:</strong>
                </div>
                <pre style={{
                  background: '#f0fff0', padding: 12, borderRadius: 4,
                  fontSize: 12, maxHeight: 200, overflow: 'auto',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {detailLog.parsedResult}
                </pre>
              </>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}

// ---------- 主页面 ----------

export default function LogAuditPage() {
  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <Tabs
        defaultActiveKey="exec"
        items={[
          { key: 'exec', label: 'AI 助手执行日志', children: <AIExecLogTab /> },
          { key: 'system', label: 'AI 系统执行日志', children: <AISystemLogTab /> },
        ]}
      />
    </div>
  )
}
