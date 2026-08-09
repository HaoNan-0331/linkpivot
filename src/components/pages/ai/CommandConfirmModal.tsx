import { Modal, Button, Tag } from 'antd'
import type { ConfirmData } from './types'

interface CommandConfirmModalProps {
  pendingConfirm: ConfirmData | null
  onConfirm: (approved: boolean) => void
  // Phase 14 Plan 02：confirm IPC 在途视觉锁（FIX-02 #1 视觉层），双按钮 loading+disabled
  confirmInFlight: boolean
}

export default function CommandConfirmModal({ pendingConfirm, onConfirm, confirmInFlight }: CommandConfirmModalProps) {
  return (
    <Modal
      open={!!pendingConfirm}
      title={`命令执行确认（${pendingConfirm?.commands?.length || 0} 条命令）`}
      onCancel={() => onConfirm(false)}
      footer={[
        <Button key="reject" danger onClick={() => onConfirm(false)} loading={confirmInFlight} disabled={confirmInFlight}>
          拒绝执行
        </Button>,
        <Button key="approve" type="primary" onClick={() => onConfirm(true)} loading={confirmInFlight} disabled={confirmInFlight}>
          确认执行
        </Button>,
      ]}
    >
      {pendingConfirm && (
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
