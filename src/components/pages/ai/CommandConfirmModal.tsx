import { Modal, Button, Tag } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import type { ConfirmData } from './types'

interface CommandConfirmModalProps {
  pendingConfirm: ConfirmData | null
  onConfirm: (approved: boolean) => void
  // Phase 14 Plan 02：confirm IPC 在途视觉锁（FIX-02 #1 视觉层），双按钮 loading+disabled
  confirmInFlight: boolean
}

// Phase 27（27-04，GUARD-04 D-05）：越权确认形态渲染块。
// 分色契约（27-UI-SPEC，禁改）：red=GUARD-02/03 越权级、gold=GUARD-01 白名单外；
// explanation 全部 main 侧生成透传，renderer 不硬编码目标状态文案。
// 红线（D-04/T-27-12）：本形态内不得提供任何绕过确认门或快捷扩权的入口。
function GuardBody({ guardInfo, commands, aiExplanation }: {
  guardInfo: NonNullable<ConfirmData['guardInfo']>
  commands: ConfirmData['commands']
  aiExplanation: string
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
      <p><WarningOutlined style={{ color: '#faad14', marginRight: 4 }} />AI 命令命中 {guardInfo.hits.length} 条安全规则，请核对目标后确认：</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <div style={{ flex: 1, background: '#f5f5f5', padding: 16, borderRadius: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>预期目标</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>{guardInfo.expectedTarget}</div>
          <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>对话选中</div>
        </div>
        <div style={{ flex: 1, background: '#f5f5f5', padding: 16, borderRadius: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>实际目标</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>{guardInfo.hits[0]?.target}</div>
          <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>{guardInfo.hits[0]?.explanation}</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        {guardInfo.hits.map((h, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <Tag color={h.level === 'red' ? 'red' : 'gold'} style={{ fontSize: 13 }}>{h.ruleId}</Tag>
            <span style={{ fontSize: 14 }}>{h.explanation}</span>
            {/* Phase 27 checkpoint：每条 hit 下方附来源命令原文（索引缺失时跳过） */}
            {hasMap && idxArr![i] != null && commands[idxArr![i]] && (
              <div style={{
                background: '#fff1f0', padding: 8, borderRadius: 4, marginTop: 4,
                fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all',
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
            <div style={{ color: '#999', fontSize: 12, borderBottom: '1px solid #f0f0f0', paddingBottom: 4, marginBottom: 8 }}>
              常规命令（无越权风险）
            </div>
            {normalCommands.map((cmd, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <Tag color="blue" style={{ fontSize: 13 }}>
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
              background: '#f5f5f5', padding: 12, borderRadius: 4, marginBottom: 6,
              fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all',
            }}>
              [{cmd.deviceName}] {cmd.command}
            </div>
          ))}
        </>
      )}
      <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, marginTop: 12 }}>
        <strong>AI 说明:</strong>
        <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', fontSize: 13 }}>
          {aiExplanation}
        </div>
      </div>
    </div>
  )
}

export default function CommandConfirmModal({ pendingConfirm, onConfirm, confirmInFlight }: CommandConfirmModalProps) {
  const guardInfo = pendingConfirm?.guardInfo
  return (
    <Modal
      open={!!pendingConfirm}
      title={guardInfo
        ? <span>
            <WarningOutlined style={{ color: '#faad14', marginRight: 8 }} />
            越权确认{guardInfo.hitCommandIndexes && guardInfo.hitCommandIndexes.length === guardInfo.hits.length
              ? `（${new Set(guardInfo.hitCommandIndexes).size} 条命中 / 共 ${pendingConfirm?.commands?.length || 0} 条命令）`
              : ''}
          </span>
        : `命令执行确认（${pendingConfirm?.commands?.length || 0} 条命令）`}
      onCancel={() => onConfirm(false)}
      footer={guardInfo ? [
        <Button key="reject" danger onClick={() => onConfirm(false)} loading={confirmInFlight} disabled={confirmInFlight}>
          取消
        </Button>,
        <Button key="approve" type="primary" onClick={() => onConfirm(true)} loading={confirmInFlight} disabled={confirmInFlight}>
          确认执行
        </Button>,
      ] : [
        <Button key="reject" danger onClick={() => onConfirm(false)} loading={confirmInFlight} disabled={confirmInFlight}>
          拒绝执行
        </Button>,
        <Button key="approve" type="primary" onClick={() => onConfirm(true)} loading={confirmInFlight} disabled={confirmInFlight}>
          确认执行
        </Button>,
      ]}
    >
      {pendingConfirm && guardInfo ? (
        <GuardBody
          guardInfo={guardInfo}
          commands={pendingConfirm.commands}
          aiExplanation={pendingConfirm.aiExplanation}
        />
      ) : pendingConfirm && (
        <div>
          <p><strong>待执行命令:</strong></p>
          {pendingConfirm.commands.map((cmd, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <Tag color="blue" style={{ fontSize: 13 }}>
                [{cmd.deviceName}] {cmd.command}
              </Tag>
            </div>
          ))}
          {pendingConfirm.rejectedCommands && pendingConfirm.rejectedCommands.length > 0 && (
            <>
              <p style={{ marginTop: 8 }}><strong>已拒绝命令:</strong></p>
              {pendingConfirm.rejectedCommands.map((r, i) => (
                <div key={i} style={{ marginBottom: 4 }}>
                  <Tag color="red" style={{ fontSize: 13 }}>{r.command}</Tag>
                  <span style={{ color: '#999', fontSize: 12 }}> {r.reason}</span>
                </div>
              ))}
            </>
          )}
          <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, marginTop: 12 }}>
            <strong>AI 说明:</strong>
            <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', fontSize: 13 }}>
              {pendingConfirm.aiExplanation}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
