import { Button, Tag } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import type { ConfirmData } from './types'

interface ApprovalPanelProps {
  pendingConfirm: ConfirmData | null
  onConfirm: (approved: boolean) => void
  // Phase 14 Plan 02：confirm IPC 在途视觉锁（FIX-02 #1 视觉层），双按钮 loading+disabled
  confirmInFlight: boolean
}

/**
 * Phase 34（34-04，SC4 / UI-06）：危险命令内联审批面板（dsh ApprovalPanel 同构）。
 * pendingConfirm 在场时接管 ChatInput 挂点（互斥渲染，useAIChat 零改），替代 CommandConfirmModal 弹层。
 * 面板结构：琥珀警示头条「等待审批」→ 336px 封顶可滚动命令区（tabIndex=0 键盘可达）
 * → 卡级固定右对齐按钮行（长命令不把按钮推出视口）。
 *
 * 三条红线（自 27-04 CommandConfirmModal 随迁移延续）：
 * - D-04 / T-27-12：本面板不得提供任何绕过确认门或快捷扩权的入口——
 *   onConfirm(false)/onConfirm(true) 双按钮为唯一动作出口。
 * - 分色契约（27-UI-SPEC，禁改）：red=GUARD-02/03 越权级、gold=GUARD-01 白名单外；
 *   explanation 全部 main 侧生成透传，renderer 不硬编码目标状态文案。
 * - hitCommandIndexes 缺失（旧 payload）→ 降级全量命令列表。
 */

// Phase 27（27-04，GUARD-04 D-05）：越权确认形态渲染块。
// Phase 34（34-04）：自 CommandConfirmModal :18-119 全量迁入（inline style 逐段照搬、文案逐字）；
// 末尾「AI 说明:」块不再自带独立 200px 滚动——aiExplanation 已上提为面板 headline 区。
// checkpoint fix（27 期）：rejectedCommands 展示为越权形态必备块——混批中白名单拒绝的命令
// 对用户不可见，"共 N 条命令"计数不含被拒项易误读为 AI 只发了一条。
function GuardBody({ guardInfo, commands, rejectedCommands }: {
  guardInfo: NonNullable<ConfirmData['guardInfo']>
  commands: ConfirmData['commands']
  rejectedCommands?: ConfirmData['rejectedCommands']
}) {
  // Phase 27 checkpoint（方案 A 分区展示）：命中命令下标集合 + 未命中常规命令分区。
  // hitCommandIndexes 缺失（旧 payload）→ normalCommands 置 null，回退现状全量命令列表（降级红线）
  const idxArr = guardInfo.hitCommandIndexes
  const hasMap = Array.isArray(idxArr) && idxArr.length === guardInfo.hits.length
  const hitIndexSet = hasMap ? new Set(idxArr) : null
  const normalCommands = hitIndexSet
    ? commands.filter((_, i) => !hitIndexSet.has(i))
    : null
  return (
    <div>
      <p><WarningOutlined style={{ color: 'var(--nt-alias-state-warn-primary)', marginRight: 4 }} />AI 命令命中 {guardInfo.hits.length} 条安全规则，请核对目标后确认：</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <div style={{ flex: 1, background: 'var(--nt-alias-bg-module-platform)', padding: 16, borderRadius: 4 }}>
          <div style={{ fontSize: 'var(--nt-font-xs-13-font-size)', fontWeight: 600 }}>预期目标</div>
          <div style={{ fontSize: 'var(--nt-font-xs-13-font-size)', marginTop: 4 }}>{guardInfo.expectedTarget}</div>
          <div style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)', marginTop: 4 }}>对话选中</div>
        </div>
        <div style={{ flex: 1, background: 'var(--nt-alias-bg-module-platform)', padding: 16, borderRadius: 4 }}>
          <div style={{ fontSize: 'var(--nt-font-xs-13-font-size)', fontWeight: 600 }}>实际目标</div>
          <div style={{ fontSize: 'var(--nt-font-xs-13-font-size)', marginTop: 4 }}>{guardInfo.hits[0]?.target}</div>
          <div style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)', marginTop: 4 }}>{guardInfo.hits[0]?.explanation}</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        {guardInfo.hits.map((h, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <Tag color={h.level === 'red' ? 'red' : 'gold'} style={{ fontSize: 'var(--nt-font-xs-13-font-size)' }}>{h.ruleId}</Tag>
            <span style={{ fontSize: 'var(--nt-font-s-14-font-size)' }}>{h.explanation}</span>
            {/* Phase 27 checkpoint：每条 hit 下方附来源命令原文（索引缺失时跳过） */}
            {hasMap && idxArr![i] != null && commands[idxArr![i]] && (
              <div style={{
                background: 'var(--nt-static-red-50)', padding: 8, borderRadius: 4, marginTop: 4,
                fontFamily: 'var(--nt-font-family-code)', fontSize: 'var(--nt-font-xs-13-font-size)',
                whiteSpace: 'pre', overflowX: 'auto',
              }}>
                [{commands[idxArr![i]].deviceName}] {commands[idxArr![i]].command}
              </div>
            )}
          </div>
        ))}
      </div>
      {/* Phase 27 checkpoint（方案 A）：常规命令分区——未命中命令列「无越权风险」分节（蓝 Tag）。
          hitCommandIndexes 缺失 → 回退现状全量命令列表（降级红线） */}
      {normalCommands ? (
        normalCommands.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)', borderBottom: '1px solid var(--nt-alias-border-l2)', paddingBottom: 4, marginBottom: 8 }}>
              常规命令（无越权风险）
            </div>
            {normalCommands.map((cmd, i) => (
              <div key={i} style={{ marginBottom: 6, overflowX: 'auto' }}>
                <Tag color="blue" style={{ fontSize: 'var(--nt-font-xs-13-font-size)' }}>
                  [{cmd.deviceName}] {cmd.command}
                </Tag>
              </div>
            ))}
          </div>
        )
      ) : (
        <>
          <p style={{ marginTop: 12 }}><strong>命令原文:</strong></p>
          {commands.map((cmd, i) => (
            <div key={i} style={{
              background: 'var(--nt-alias-bg-module-platform)', padding: 12, borderRadius: 4, marginBottom: 6,
              fontFamily: 'var(--nt-font-family-code)', fontSize: 'var(--nt-font-xs-13-font-size)',
              whiteSpace: 'pre', overflowX: 'auto',
            }}>
              [{cmd.deviceName}] {cmd.command}
            </div>
          ))}
        </>
      )}
      {rejectedCommands && rejectedCommands.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)', borderBottom: '1px solid var(--nt-alias-border-l2)', paddingBottom: 4, marginBottom: 8 }}>
            已拒绝命令（{rejectedCommands.length} 条，不会执行）
          </div>
          {rejectedCommands.map((r, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <div style={{ overflowX: 'auto' }}>
                <Tag color="red" style={{ fontSize: 'var(--nt-font-xs-13-font-size)' }}>{r.command}</Tag>
              </div>
              <span style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)' }}>{r.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ApprovalPanel({ pendingConfirm, onConfirm, confirmInFlight }: ApprovalPanelProps) {
  if (!pendingConfirm) return null
  const guardInfo = pendingConfirm.guardInfo
  return (
    <div
      className="nt-chat-card nt-approve-root"
      style={{
        // marginTop 12 与 ChatInput 根容器同节奏（互斥接管同一挂点的槽位几何对齐）
        width: '100%',
        marginTop: 12,
        borderRadius: 22,
        border: '1px solid var(--nt-alias-state-warn-secondary)',
        background: 'var(--nt-specific-input-major)',
        boxShadow: 'var(--nt-shadow-lv2)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ① 琥珀警示头条（strip） */}
      <div style={{
        background: 'var(--nt-alias-state-warn-tertiary)',
        color: 'var(--nt-alias-state-warn-primary)',
        fontSize: 'var(--nt-font-xs-13-font-size)',
        lineHeight: 'var(--nt-font-xs-13-line-height)',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--nt-alias-state-warn-primary)', flex: 'none' }} />
        等待审批
      </div>
      {/* ② 可滚动命令区（body）——336px 封顶使按钮行永不被长命令推出视口。
          tabIndex=0 + role=group：区域自身无可聚焦子元素，键盘用户须经此 tab stop
          才能滚读到命令尾部后再决策（dsh ApprovalPanel 键盘契约）。 */}
      <div
        className="nt-approve-scroll"
        tabIndex={0}
        role="group"
        aria-label="审批详情"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '12px 16px 0',
          maxHeight: 336,
          overflowY: 'auto',
        }}
      >
        {guardInfo ? (
          <>
            {/* 越权分支 headline：标题行（Modal 标题迁移，计数判定式照既有 :129-131）→ AI 说明段 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: 'var(--nt-font-s-14-font-size)',
              lineHeight: 'var(--nt-font-s-14-line-height)',
              fontWeight: 600,
              color: 'var(--nt-alias-label-primary)',
            }}>
              <WarningOutlined style={{ color: 'var(--nt-alias-state-warn-primary)', marginRight: 8 }} />
              越权确认{guardInfo.hitCommandIndexes && guardInfo.hitCommandIndexes.length === guardInfo.hits.length
                ? `（${new Set(guardInfo.hitCommandIndexes).size} 条命中 / 共 ${pendingConfirm.commands.length} 条命令）`
                : ''}
            </div>
            <div style={{
              fontSize: 'var(--nt-font-markdown-table-font-size)',
              lineHeight: 'var(--nt-font-markdown-table-line-height)',
              fontWeight: 500,
              color: 'var(--nt-alias-label-primary)',
              whiteSpace: 'pre-wrap',
            }}>
              {pendingConfirm.aiExplanation}
            </div>
            <GuardBody
              guardInfo={guardInfo}
              commands={pendingConfirm.commands}
              rejectedCommands={pendingConfirm.rejectedCommands}
            />
          </>
        ) : (
          <>
            {/* 普通分支 headline：仅 AI 说明段 */}
            <div style={{
              fontSize: 'var(--nt-font-markdown-table-font-size)',
              lineHeight: 'var(--nt-font-markdown-table-line-height)',
              fontWeight: 500,
              color: 'var(--nt-alias-label-primary)',
              whiteSpace: 'pre-wrap',
            }}>
              {pendingConfirm.aiExplanation}
            </div>
            {/* 既有小节头「待执行命令:」保留（源 :160 ASCII 冒号逐字）——信息零丢失原则
                + 与越权分支分区头（常规命令/已拒绝命令）结构对仗 */}
            <div style={{
              fontSize: 'var(--nt-font-xs-13-font-size)',
              fontWeight: 600,
              color: 'var(--nt-alias-label-caption)',
              margin: '12px 0 4px',
            }}>
              待执行命令:
            </div>
            {pendingConfirm.commands.map((cmd, i) => (
              <div key={i} style={{
                fontFamily: 'var(--nt-font-family-code)',
                fontSize: 'var(--nt-font-xs-13-font-size)',
                lineHeight: 'var(--nt-font-xs-13-line-height)',
                color: 'var(--nt-alias-label-tertiary)',
                wordBreak: 'break-all',
              }}>
                [{cmd.deviceName}] {cmd.command}
              </div>
            ))}
            {pendingConfirm.rejectedCommands && pendingConfirm.rejectedCommands.length > 0 && (
              <>
                <div style={{
                  fontSize: 'var(--nt-font-xs-13-font-size)',
                  fontWeight: 600,
                  color: 'var(--nt-alias-label-caption)',
                  margin: '12px 0 4px',
                }}>
                  已拒绝命令:
                </div>
                {pendingConfirm.rejectedCommands.map((r, i) => (
                  <div key={i}>
                    <div style={{
                      fontFamily: 'var(--nt-font-family-code)',
                      fontSize: 'var(--nt-font-xs-13-font-size)',
                      lineHeight: 'var(--nt-font-xs-13-line-height)',
                      color: 'var(--nt-alias-label-tertiary)',
                      wordBreak: 'break-all',
                    }}>
                      {r.command}
                    </div>
                    <div style={{ color: 'var(--nt-alias-label-tertiary)', fontSize: 'var(--nt-font-xxs-12-font-size)', lineHeight: 'var(--nt-font-xxs-12-line-height)' }}>{r.reason}</div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
      {/* ③ 按钮行（actionRow，卡级固定在滚动区外）——onConfirm(false)/onConfirm(true)
          为面板唯一动作出口（D-04/T-27-12：无绕过确认门或快捷扩权入口）。
          拒绝按钮静止态无红（无 danger），hover 才变红（.nt-approve-reject，ai-chat.css）；
          越权分支原「取消」按 UI-SPEC §九状态词表统一为「拒绝执行」。 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 16px' }}>
        <Button
          className="nt-approve-reject"
          onClick={() => onConfirm(false)}
          loading={confirmInFlight}
          disabled={confirmInFlight}
        >
          拒绝执行
        </Button>
        <Button
          type="primary"
          onClick={() => onConfirm(true)}
          loading={confirmInFlight}
          disabled={confirmInFlight}
        >
          确认执行
        </Button>
      </div>
    </div>
  )
}
