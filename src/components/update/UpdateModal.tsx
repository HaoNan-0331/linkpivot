import { useEffect, useState } from 'react'
import { Modal, Progress, Checkbox, Radio, Alert, Button, Typography, message } from 'antd'
import { useUpdateStore } from '../../stores/updateStore'
import { sanitizeReleaseNotes } from '../../utils/releaseNotes'
import type { UpdateSnoozeMode } from '../../types/electron'

const { Text, Paragraph, Link } = Typography

/** 字节 → MB 展示（一位小数，UI-SPEC「已下载 48.3 MB / 77.9 MB（62%）」形态） */
function fmtMB(bytes: number | undefined): string {
  return ((bytes ?? 0) / 1024 / 1024).toFixed(1) + ' MB'
}

/**
 * Phase 30（30-04，UPD-01/03/04）：升级弹窗——单弹窗三态走完全程（D-04）。
 * info（版本行 + 清洗后更新说明 + 立即升级/跳过/不再提醒档位）→ progress（原地切换，进度 + 取消）
 * → ready（稍后/立即重启安装）。文案逐字采用 30-UI-SPEC；release notes 只以 React 文本节点渲染
 * 清洗后纯文本（sanitizeReleaseNotes，零原始 HTML 注入渲染面，UPD-01 红线）。
 * 事件订阅 onUpdateEvent → updateStore.applyUpdateEvent（进度/完成/取消/失败均事件驱动）。
 */
export default function UpdateModal() {
  const modalPhase = useUpdateStore((s) => s.modalPhase)
  const updateInfo = useUpdateStore((s) => s.updateInfo)
  const progress = useUpdateStore((s) => s.progress)
  const appVersion = useUpdateStore((s) => s.appVersion)
  const openProgress = useUpdateStore((s) => s.openProgress)
  const closeModal = useUpdateStore((s) => s.closeModal)
  const applyUpdateEvent = useUpdateStore((s) => s.applyUpdateEvent)

  const [noRemind, setNoRemind] = useState(false)
  const [snoozeMode, setSnoozeMode] = useState<UpdateSnoozeMode>('30d')

  // main→renderer 升级事件订阅（cleanup 解绑）
  useEffect(() => {
    const unbind = window.api.update.onUpdateEvent((payload) => applyUpdateEvent(payload))
    return () => unbind()
  }, [applyUpdateEvent])

  // 关闭后复位勾选态（下次打开默认不勾、默认 30 天）
  useEffect(() => {
    if (modalPhase === 'closed') {
      setNoRemind(false)
      setSnoozeMode('30d')
    }
  }, [modalPhase])

  const version = updateInfo?.version ?? ''
  const cleanNotes = updateInfo ? sanitizeReleaseNotes(updateInfo.notes) : ''
  const percent = Math.round(progress?.percent ?? 0)

  // X / 遮罩 / ESC 关闭（info/ready 态）：勾选「不再提醒」则先提交所选档位再关窗（fire-and-forget 静默）
  const handleCancel = () => {
    if (noRemind) {
      window.api.update.setSnooze(snoozeMode).catch(() => {
        // 压制档位提交失败静默（下次启动仍可再设）
      })
    }
    closeModal()
  }

  // 「跳过此版本」：仅记 skip_version，忽略「不再提醒」勾选（UI-SPEC 关闭语义表）
  const handleSkip = () => {
    if (updateInfo) {
      window.api.update.setSkipVersion(updateInfo.version).catch(() => {
        // 静默
      })
    }
    closeModal()
  }

  // 「立即升级」：忽略勾选直接下载；progress 原地切换。启动失败兜底（Rule 2）：
  // error 事件未到的 started:false / invoke 异常同样回 info 可重试，绝不卡死 progress 态（W-1 同族）。
  const handleDownload = async () => {
    setNoRemind(false)
    openProgress()
    const revertFromProgress = () => {
      if (useUpdateStore.getState().modalPhase !== 'progress') return
      useUpdateStore.setState({ modalPhase: 'info', progress: null })
      message.error('下载失败，请稍后重试，或到 Releases 页手动下载。')
    }
    try {
      const r = await window.api.update.download()
      if (!r.started) revertFromProgress()
    } catch {
      revertFromProgress()
    }
  }

  // 「取消」下载：回 info 由 update-cancelled 事件驱动，无确认（可重下，非破坏性）
  const handleCancelDownload = () => {
    window.api.update.cancel().catch(() => {
      // 静默
    })
  }

  // 「立即重启安装」：quitAndInstall 唯一显式触发点（SC 红线——绝不静默安装）
  const handleInstall = () => {
    window.api.update.install().catch(() => {
      message.error('安装启动失败，请稍后重试。')
    })
  }

  const title = modalPhase === 'progress' ? '正在下载新版本' : modalPhase === 'ready' ? '新版本已就绪' : '发现新版本'

  return (
    <Modal
      open={modalPhase !== 'closed'}
      title={title}
      width={520}
      // progress 态三关闭参数均为 false——下载中无 X / 遮罩 / ESC，唯一出口「取消」按钮（D-04/D-06）
      closable={modalPhase === 'progress' ? false : true}
      maskClosable={modalPhase === 'progress' ? false : true}
      keyboard={modalPhase === 'progress' ? false : true}
      onCancel={handleCancel}
      footer={null}
    >
      {modalPhase === 'info' && (
        <>
          <div>
            <Text strong style={{ fontSize: 16 }}>
              新版本 v{version}
            </Text>
            <Text type="secondary">（当前 v{appVersion}）</Text>
          </div>
          <div style={{ marginTop: 12 }}>
            <Text>更新内容：</Text>
          </div>
          <div style={{ background: '#f5f5f5', maxHeight: 200, overflow: 'auto', padding: 12, marginTop: 4 }}>
            {cleanNotes ? (
              <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{cleanNotes}</Paragraph>
            ) : (
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                本版本暂无更新说明。
              </Paragraph>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <Checkbox checked={noRemind} onChange={(e) => setNoRemind(e.target.checked)}>
              不再提醒
            </Checkbox>
            {noRemind && (
              <div style={{ marginTop: 8 }}>
                <Radio.Group
                  value={snoozeMode}
                  onChange={(e) => setSnoozeMode(e.target.value as UpdateSnoozeMode)}
                >
                  <Radio value="30d">30 天</Radio>
                  <Radio value="180d">180 天</Radio>
                  <Radio value="forever">永久</Radio>
                </Radio.Group>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    关闭窗口后将按所选档位暂停自动提醒
                  </Text>
                </div>
              </div>
            )}
          </div>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
            <Link style={{ fontSize: 12 }} onClick={handleSkip}>
              跳过此版本
            </Link>
            <Button type="primary" onClick={handleDownload}>
              立即升级
            </Button>
          </div>
        </>
      )}
      {modalPhase === 'progress' && (
        <>
          <Progress percent={percent} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            已下载 {fmtMB(progress?.transferred)} / {fmtMB(progress?.total)}（{percent}%）
          </Text>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={handleCancelDownload}>取消</Button>
          </div>
        </>
      )}
      {modalPhase === 'ready' && (
        <>
          <Text>v{version} 安装包已下载完成，重启应用后即可完成安装。</Text>
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="重启将断开所有远程会话（SSH / Telnet / MCP），请确认无正在执行的任务。"
          />
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={closeModal}>稍后</Button>
            <Button type="primary" onClick={handleInstall}>
              立即重启安装
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
