import { useState, useEffect } from 'react'
import { Popover, Button, Switch, Segmented, message } from 'antd'
import { SearchOutlined } from '@ant-design/icons'

/**
 * RetrievalControlButton —— AI 检索行为设置入口（Phase 37 / 37-03，RETRIEVE-CTRL-01，D-09/D-10）。
 *
 * 输入行行首小图标 + Popover 设置面板（自治组件零 props，ExecModeSwitch :30-70 状态机同构）：
 * - 「预取注入」Switch（D-01：开 = 档位矩阵预取注入，关 = 循环前零注入零 [预取] 卡）
 * - 「补查模式」Segmented 强制/智能（模式切换而非有无——关 ≠ 不查，是 AI 决策）
 * - 两行小字钉死 D-10 硬约束（智能 AI 决策语义 + troubleshoot 档恒强制例外 D-02）
 *
 * 读写仅经 window.api.ai.getRetrievalPrefs/setRetrievalPrefs（37-01 secure IPC + service 校验，
 * 组件不触 DB 不触其他通道 T-37-10）；作用域全局持久非会话级（CONTEXT Discretion 4）；
 * 读失败静默（prefs 保持 null → 面板控件 disabled 不白屏，T-37-11）。面板内容全在浮层，
 * 不挤 34 期 .nt-chat-card min(780px,100cqi-32px) 宽度契约（PATTERNS #8）。
 */
type BackfillMode = 'force' | 'smart'

interface RetrievalPrefs {
  prefetchEnabled: boolean
  backfillMode: BackfillMode
}

/** prefs 未就绪时 onChange 合成整对象的兜底底座（D-03 默认关 + 智能，与 main 侧 DEFAULT_RETRIEVAL_PREFS 同值） */
const FALLBACK_PREFS: RetrievalPrefs = { prefetchEnabled: false, backfillMode: 'smart' }

export default function RetrievalControlButton() {
  const [prefs, setPrefs] = useState<RetrievalPrefs | null>(null)
  const [loading, setLoading] = useState(false)

  // ExecModeSwitch load 同构：挂载即读，catch 静默（DEV mock 异常不白屏，控件保持 disabled）
  useEffect(() => {
    window.api.ai.getRetrievalPrefs().then(setPrefs).catch(() => { /* ignore */ })
  }, [])

  // 单一写入通道：即写即存 + result.success 分支（ExecModeSwitch doSwitch 同构）
  const doWrite = async (next: RetrievalPrefs) => {
    setLoading(true)
    try {
      const result = await window.api.ai.setRetrievalPrefs(next)
      if (result.success) {
        setPrefs(next)
        message.success('检索设置已更新')
      } else {
        message.error(result.error || '设置失败')
      }
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const disabled = loading || prefs === null

  const panel = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span>预取注入</span>
        <Switch
          size="small"
          checked={prefs?.prefetchEnabled ?? false}
          disabled={disabled}
          onChange={(v) => doWrite({ ...(prefs ?? FALLBACK_PREFS), prefetchEnabled: v })}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span>补查模式</span>
        <Segmented<BackfillMode>
          size="small"
          value={prefs?.backfillMode}
          disabled={disabled}
          options={[
            { value: 'force', label: '强制补查' },
            { value: 'smart', label: '智能补查' },
          ]}
          onChange={(v) => doWrite({ ...(prefs ?? FALLBACK_PREFS), backfillMode: v })}
        />
      </div>
      {/* D-10 硬约束两行小字：第一行表达「关 ≠ 不查，是 AI 决策」，第二行钉死故障档例外（D-02） */}
      <div style={{ fontSize: 'var(--nt-font-xxs-12-font-size)', lineHeight: 'var(--nt-font-xxs-12-line-height)', color: 'var(--nt-alias-label-tertiary)' }}>
        <div>智能模式下由 AI 判断是否补查</div>
        <div>故障排查问题始终强制补查</div>
      </div>
    </div>
  )

  return (
    <Popover content={panel} trigger="click" placement="topRight" overlayStyle={{ maxWidth: 320 }}>
      <Button type="text" size="small" icon={<SearchOutlined />} aria-label="检索设置" disabled={loading} />
    </Popover>
  )
}
