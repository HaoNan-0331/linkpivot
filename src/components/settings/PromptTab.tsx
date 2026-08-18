import { useState, useEffect, useMemo, useRef } from 'react'
import { Button, Card, Collapse, Modal, Input, Tag, Badge, Tooltip, Alert, Space, Spin, Switch, Typography, message } from 'antd'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import { WarningOutlined } from '@ant-design/icons'
import type { PromptEntryView } from '../../types/electron'
import { diffInline } from './promptDiff'

const { Text, Paragraph } = Typography

// D-03/D-04：门槛通过状态仅存 renderer 内存（模块级变量，不落 localStorage/DB），
// 登出（renderer 重载）或应用重启自然失效（T-20-09）。
let gatePassedInSession = false

// UI-SPEC Diff 配色（Word 修订模式风格，行内连续）
const DIFF_REMOVE_BG = '#fff1f0'
const DIFF_REMOVE_FG = '#cf1322'
const DIFF_ADD_BG = '#f6ffed'
const DIFF_ADD_FG = '#389e0d'

const ipcErrMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// D-01：进 tab 时后台扫描——AntD Tabs 切走再切回不重挂面板，
// 由 SettingsPage 递增 refreshKey 触发本组件重新拉取（切页面重挂载亦触发首次 load）
export default function PromptTab({ refreshKey = 0 }: { refreshKey?: number }) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [entries, setEntries] = useState<PromptEntryView[]>([])
  // D-03：门槛（未通过 = 只读概览）
  const [gatePassed, setGatePassed] = useState(gatePassedInSession)
  const [gateOpen, setGateOpen] = useState(false)
  const [gateInput, setGateInput] = useState('')
  const [gateError, setGateError] = useState<string | null>(null)
  // 门槛待编辑条目：门槛未过时只开门槛窗，绝不与编辑器同屏（T-20-09 门槛绕过修复）
  const [pendingEntry, setPendingEntry] = useState<PromptEntryView | null>(null)
  // 冲突三选（D-01/D-02）
  const [conflictEntry, setConflictEntry] = useState<PromptEntryView | null>(null)
  // 编辑器（D-05）
  const [editing, setEditing] = useState<PromptEntryView | null>(null)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  // antd 6 TextArea 实例 ref：resizableTextArea.textArea 为原生 textarea（插入光标定位用）
  const textAreaRef = useRef<TextAreaRef>(null)
  // 恢复默认二次确认
  const [resetTarget, setResetTarget] = useState<PromptEntryView | null>(null)
  const [resetting, setResetting] = useState(false)

  const load = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const list = await window.api.prompt.list()
      setEntries(list)
    } catch (e: unknown) {
      setLoadError(ipcErrMsg(e))
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [refreshKey])

  const grouped = useMemo(() => {
    const map = new Map<string, PromptEntryView[]>()
    for (const entry of entries) {
      const arr = map.get(entry.group) ?? []
      arr.push(entry)
      map.set(entry.group, arr)
    }
    return Array.from(map.entries())
  }, [entries])

  const conflictCount = entries.filter((en) => en.conflict).length

  // 冲突三选 diff：a = 我的旧版本（删除红底），b = 官方新默认（新增绿底）
  const conflictDiff = useMemo(() => {
    if (conflictEntry?.overrideContent == null) return []
    return diffInline(conflictEntry.overrideContent, conflictEntry.defaultContent)
  }, [conflictEntry])

  // 「仅看变化」窗口化：变化段全保留，相邻 same 段仅留两端各 30 字上下文，中间折叠为省略段
  const [diffOnlyChanges, setDiffOnlyChanges] = useState(false)
  const conflictChanges = useMemo(() => conflictDiff.filter((s) => s.type !== 'same').length, [conflictDiff])
  const DIFF_CTX_CHARS = 30
  type DiffViewSeg = { type: 'same' | 'add' | 'remove'; text: string; omitted?: number }
  const conflictDiffView = useMemo<DiffViewSeg[]>(() => {
    if (!diffOnlyChanges) return conflictDiff
    const out: DiffViewSeg[] = []
    conflictDiff.forEach((seg, i) => {
      if (seg.type !== 'same') { out.push(seg); return }
      const prevChanged = i > 0 && conflictDiff[i - 1].type !== 'same'
      const nextChanged = i < conflictDiff.length - 1 && conflictDiff[i + 1].type !== 'same'
      if (!prevChanged && !nextChanged) return
      const head = prevChanged ? Math.min(DIFF_CTX_CHARS, seg.text.length) : 0
      const tail = nextChanged ? Math.min(DIFF_CTX_CHARS, seg.text.length) : 0
      if (head + tail >= seg.text.length) { out.push(seg); return }
      if (head > 0) out.push({ type: 'same', text: seg.text.slice(0, head) })
      out.push({ type: 'same', text: '', omitted: seg.text.length - head - tail })
      if (tail > 0) out.push({ type: 'same', text: seg.text.slice(seg.text.length - tail) })
    })
    return out
  }, [conflictDiff, diffOnlyChanges])

  // 必需变量缺失即时校验（D-05 UI 层；网关层二次校验在 prompt:save）
  const missingVars = useMemo(() => {
    if (!editing) return []
    return editing.requiredVars.filter((v) => !editContent.includes(`{{${v}}}`))
  }, [editing, editContent])

  // 变量面板合并去重：requiredVars（纯名字）与 optionalVars（名字+说明）按 name 并集，
  // 必需→红 Tag、可选→灰 Tag，说明文字统一挂在变量行内（修复两段重复渲染）
  const varDocs = useMemo(() => {
    if (!editing) return []
    const descMap = new Map(editing.optionalVars.map((v) => [v.name, v.desc]))
    const requiredSet = new Set(editing.requiredVars)
    const names = Array.from(new Set([...editing.requiredVars, ...editing.optionalVars.map((v) => v.name)]))
    return names.map((name) => ({ name, desc: descMap.get(name), required: requiredSet.has(name) }))
  }, [editing])

  const passGate = () => {
    if (gateInput !== '我已知晓风险') {
      setGateError('输入内容不匹配，请照抄上方引号内的原文')
      return
    }
    gatePassedInSession = true
    setGatePassed(true)
    setGateOpen(false)
    setGateInput('')
    setGateError(null)
    // 门槛通过后进入待编辑条目（openEntry 记录的 pendingEntry）
    if (pendingEntry) {
      setEditing(pendingEntry)
      setEditContent(pendingEntry.overrideContent ?? pendingEntry.defaultContent)
      setPendingEntry(null)
    }
  }

  /** 入口分流：冲突条目 → 三选；其余 → 门槛（未过时只开门槛窗，绝不与编辑器同屏）→ 编辑器 */
  const openEntry = (entry: PromptEntryView) => {
    if (entry.conflict && entry.overrideContent != null) {
      setConflictEntry(entry)
      return
    }
    if (!gatePassed) {
      setPendingEntry(entry)
      setGateOpen(true)
      return
    }
    setEditing(entry)
    setEditContent(entry.overrideContent ?? entry.defaultContent)
  }

  const insertVar = (name: string) => {
    const token = `{{${name}}}`
    const ta = textAreaRef.current?.resizableTextArea?.textArea
    if (!ta) {
      setEditContent(editContent + token)
      return
    }
    const start = ta.selectionStart ?? editContent.length
    const end = ta.selectionEnd ?? start
    const next = editContent.slice(0, start) + token + editContent.slice(end)
    setEditContent(next)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + token.length
      ta.setSelectionRange(pos, pos)
    })
  }

  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const result = await window.api.prompt.save(editing.id, editContent)
      if (result.ok) {
        message.success('提示词已保存')
        setEditing(null)
        load()
      } else {
        message.error(result.error)
      }
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
    setSaving(false)
  }

  const handleReset = async () => {
    if (!resetTarget) return
    setResetting(true)
    try {
      await window.api.prompt.reset(resetTarget.id)
      message.success('已恢复默认')
      setResetTarget(null)
      setEditing(null)
      setConflictEntry(null)
      load()
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
    setResetting(false)
  }

  // 冲突三选：「采用新默认」= reset
  const adoptNewDefault = async () => {
    if (!conflictEntry) return
    const id = conflictEntry.id
    try {
      await window.api.prompt.reset(id)
      message.success('已采用新默认')
      setConflictEntry(null)
      load()
    } catch (e: unknown) {
      message.error(ipcErrMsg(e))
    }
  }

  if (loading) return <Spin />

  if (loadError != null) {
    return (
      <Alert
        type="error"
        showIcon
        message={`加载提示词失败：${loadError}。请重试；若持续失败请重启应用`}
        action={<Button size="small" onClick={load}>重试</Button>}
      />
    )
  }

  const entryHeader = (entry: PromptEntryView) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {entry.conflict && (
        <Tooltip title="官方默认已更新，需要处理">
          <Badge color="#faad14" />
        </Tooltip>
      )}
      <Text strong>{entry.id}</Text>
      <Tag style={{ fontSize: 12 }}>官方 v{entry.version}</Tag>
      {entry.overrideContent != null && entry.basedOnVersion != null && (
        <Tag color="orange" style={{ fontSize: 12 }}>基于 v{entry.basedOnVersion} 修改</Tag>
      )}
      {entry.safetyCritical && (
        <Tooltip title="⚠ 安全关键——修改可能影响命令确认与注入防护，请谨慎">
          <Text type="danger" style={{ fontSize: 12 }}>
            <WarningOutlined style={{ marginRight: 4 }} />
            安全关键——修改可能影响命令确认与注入防护，请谨慎
          </Text>
        </Tooltip>
      )}
      <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{entry.description}</Text>
    </span>
  )

  return (
    <div>
      {/* 门槛状态提示（D-04 会话记忆文案） */}
      {gatePassed ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="本次登录已确认风险，可直接编辑（登出或重启应用后需重新输入）"
        />
      ) : (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="各条提示词当前使用官方默认值；点击任意条目可查看与修改"
        />
      )}
      {conflictCount > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`有 ${conflictCount} 条提示词的官方默认已更新，需要处理`}
        />
      )}

      <Collapse
        items={grouped.map(([group, list]) => ({
          key: group,
          label: <Text strong style={{ fontSize: 16 }}>{group}</Text>,
          children: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {list.map((entry) => (
                <Card key={entry.id} size="small" title={entryHeader(entry)}>
                  <Paragraph
                    style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginBottom: 8, color: '#595959' }}
                    ellipsis={{ rows: 3, expandable: true, symbol: '展开全文' }}
                  >
                    {entry.overrideContent ?? entry.defaultContent}
                  </Paragraph>
                  <Space>
                    <Button type="primary" onClick={() => openEntry(entry)}>编辑</Button>
                    {entry.overrideContent != null ? (
                      <Button danger onClick={() => setResetTarget(entry)}>恢复默认</Button>
                    ) : (
                      <Tooltip title="未修改过，当前即官方默认值">
                        <Button danger disabled>恢复默认</Button>
                      </Tooltip>
                    )}
                  </Space>
                </Card>
              ))}
            </div>
          ),
        }))}
        defaultActiveKey={grouped.map(([g]) => g)}
      />

      {/* 门槛 Modal（D-03） */}
      <Modal
        open={gateOpen}
        title={
          <Space>
            <WarningOutlined style={{ color: '#faad14' }} />
            修改 AI 提示词有风险
          </Space>
        }
        okText="确认"
        cancelText="取消"
        onOk={passGate}
        onCancel={() => { setGateOpen(false); setGateInput(''); setGateError(null); setPendingEntry(null) }}
      >
        <div style={{ padding: '8px 0', color: '#595959' }}>
          AI 提示词控制助手的行为方式。改错可能导致 AI 回复异常、误判命令，极端情况下需要恢复默认才能修复。请在下方输入「我已知晓风险」继续。
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
      </Modal>

      {/* 冲突三选 Modal（D-01/D-02） */}
      <Modal
        open={conflictEntry != null}
        title="官方默认已更新"
        footer={[
          <Button key="keep" onClick={() => setConflictEntry(null)}>保留我的</Button>,
          <Button key="adopt" danger onClick={adoptNewDefault}>采用新默认</Button>,
          <Button
            key="merge"
            type="primary"
            onClick={() => {
              if (!conflictEntry) return
              setEditContent(conflictEntry.overrideContent ?? conflictEntry.defaultContent)
              setEditing(conflictEntry)
              setConflictEntry(null)
            }}
          >
            手动合并
          </Button>,
        ]}
        onCancel={() => setConflictEntry(null)}
        width={720}
      >
        <Paragraph>
          官方更新了这条提示词的默认值，而你改过它。请选择：<Text strong>保留我的</Text>（继续用你改过的版本，忽略官方改进）/
          <Text strong>采用新默认</Text>（丢弃你的修改，换成官方新版）/
          <Text strong>手动合并</Text>（在编辑器里把两边改动合到一起）
        </Paragraph>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
          <Text style={{ fontSize: 12 }}>
            <span style={{ background: DIFF_REMOVE_BG, color: DIFF_REMOVE_FG, padding: '0 4px', fontWeight: 600 }}>红底加粗</span>
            {' '}你的版本独有（将被替换）
          </Text>
          <Text style={{ fontSize: 12 }}>
            <span style={{ background: DIFF_ADD_BG, color: DIFF_ADD_FG, padding: '0 4px', fontWeight: 600 }}>绿底加粗</span>
            {' '}官方新默认新增
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>共 {conflictChanges} 处变化</Text>
          <Switch size="small" checked={diffOnlyChanges} onChange={setDiffOnlyChanges} />
          <Text type="secondary" style={{ fontSize: 12 }}>仅看变化</Text>
        </div>
        <div
          style={{
            border: '1px solid #f0f0f0',
            borderRadius: 4,
            padding: 8,
            fontFamily: 'monospace',
            fontSize: 13,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            maxHeight: 360,
            overflow: 'auto',
          }}
        >
          {conflictDiffView.map((seg, i) => {
            if (seg.omitted != null) {
              return (
                <span key={i} style={{ color: '#bfbfbf', fontStyle: 'italic', fontSize: 12 }}>
                  {`\n……（省略 ${seg.omitted} 字相同内容）……\n`}
                </span>
              )
            }
            return (
              <span
                key={i}
                style={{
                  background: seg.type === 'remove' ? DIFF_REMOVE_BG : seg.type === 'add' ? DIFF_ADD_BG : undefined,
                  color: seg.type === 'remove' ? DIFF_REMOVE_FG : seg.type === 'add' ? DIFF_ADD_FG : undefined,
                  fontWeight: seg.type === 'same' ? undefined : 600,
                }}
              >
                {seg.text}
              </span>
            )
          })}
        </div>
      </Modal>

      {/* 编辑器 Modal（D-05）：左大文本区为视觉锚点 + 右窄变量面板 */}
      <Modal
        open={editing != null}
        title={`编辑：${editing?.id ?? ''}`}
        okText="保存修改"
        cancelText="取消"
        onOk={handleSave}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        width={920}
      >
        {missingVars.length > 0 && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={`无法保存：缺少必需变量 ${missingVars.map((v) => `{{${v}}}`).join('、')}，AI 调用时需要这些占位符才能正确填充信息`}
          />
        )}
        {/* 默认值对照（PMT-02）：改过的条目编辑时可参照官方默认原文 */}
        {editing && editing.overrideContent != null && (
          <Collapse
            size="small"
            style={{ marginBottom: 12 }}
            items={[{
              key: 'default',
              label: <Text type="secondary" style={{ fontSize: 12 }}>官方默认值（v{editing.version}）对照 — 点开展开</Text>,
              children: (
                <Paragraph
                  style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#595959', fontFamily: 'monospace', marginBottom: 0 }}
                  ellipsis={{ rows: 4, expandable: true, symbol: '展开全文' }}
                >
                  {editing.defaultContent}
                </Paragraph>
              ),
            }]}
          />
        )}
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Input.TextArea
              ref={textAreaRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              style={{ fontSize: 13, fontFamily: 'monospace' }}
              autoSize={{ minRows: 18, maxRows: 28 }}
            />
          </div>
          <div style={{ width: 240, flexShrink: 0, border: '1px solid #f0f0f0', borderRadius: 4, padding: 8, maxHeight: 480, overflow: 'auto' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>变量（点击插入光标处）</Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {varDocs.map((v) => (
                <div key={v.name} style={{ padding: 8, background: '#fafafa', borderRadius: 4 }}>
                  <a onClick={() => insertVar(v.name)} style={{ fontFamily: 'monospace', fontSize: 13 }}>{`{{${v.name}}}`}</a>
                  {v.required
                    ? <Tag color="red" style={{ marginLeft: 4, fontSize: 12 }}>必需</Tag>
                    : <Tag style={{ marginLeft: 4, fontSize: 12 }}>可选</Tag>}
                  {v.desc && <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>{v.desc}</div>}
                </div>
              ))}
              {editing && varDocs.length === 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>此条目无占位变量</Text>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* 恢复默认二次确认 */}
      <Modal
        open={resetTarget != null}
        title="恢复默认"
        okText="确定恢复"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={resetting}
        onOk={handleReset}
        onCancel={() => setResetTarget(null)}
      >
        <Paragraph>
          恢复默认：将丢弃你对该条提示词的全部修改，改回官方版本。此操作不可撤销，确定恢复？
        </Paragraph>
      </Modal>
    </div>
  )
}
