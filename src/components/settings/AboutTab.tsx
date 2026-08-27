import { useEffect, useState } from 'react'
import { Card, Button, Typography, message } from 'antd'
import { useUpdateStore } from '../../stores/updateStore'
import type { UpdateErrorKind } from '../../types/electron'

const { Text, Link } = Typography

/** Releases 页直链（模块常量硬编码，T-30-12——不经任何 IPC 可写参数） */
const RELEASES_URL = 'https://github.com/HaoNan-0331/network-topology-manager/releases'

/**
 * UPD-06 六类错误分诊文案（UI-SPEC 逐字）；network/ratelimit/unknown 三类内嵌「手动下载」链接兜底
 * （本期升级源仅 GitHub Releases——内网用户 network 类「请到外网机下载安装包后拷贝安装」）。
 */
const KIND_MESSAGES: Record<UpdateErrorKind, string> = {
  network: '网络不可达，无法连接 GitHub。请到外网机下载安装包后拷贝安装。',
  proxy: '系统代理未响应，请检查代理软件是否正在运行。',
  ratelimit: 'GitHub 访问受限，请稍后重试，或到 Releases 页手动下载。',
  nometa: '暂无可用更新或发布配置异常。',
  server: '更新服务暂不可用，请稍后重试。',
  unknown: '检查更新失败，请稍后重试，或到 Releases 页手动下载。',
}

function openReleasesPage() {
  window.api.connection.openWeb(RELEASES_URL).catch(() => {
    // 外开失败静默（openExternalSafe 协议白名单既有通道）
  })
}

/** 六类分诊 message.error 内容（三类内嵌手动下载链接，ReactNode） */
function renderUpdateError(kind: UpdateErrorKind): React.ReactNode {
  const text = KIND_MESSAGES[kind]
  if (kind === 'network' || kind === 'ratelimit' || kind === 'unknown') {
    return (
      <span>
        {text} <Link onClick={openReleasesPage}>手动下载</Link>
      </span>
    )
  }
  return text
}

/** 状态行七态（UI-SPEC 状态行状态机） */
type AboutStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded' }
  | { kind: 'failed' }

function statusLineText(s: AboutStatus): string {
  switch (s.kind) {
    case 'idle':
      return '未检查更新'
    case 'checking':
      return '正在检查更新…'
    case 'latest':
      return `已是最新版本 v${s.version}`
    case 'available':
      return `发现新版本 v${s.version}`
    case 'downloading':
      return `正在下载新版本… ${s.percent}%`
    case 'downloaded':
      return '已下载待安装'
    case 'failed':
      return '上次检查更新失败'
  }
}

/**
 * Phase 30（30-04，D-07/D-08/UPD-05/06）：设置页第五「关于」tab。
 * 版本号 + 检查更新（手动全解禁 D-02）+ Releases 直链 + 七态状态行 + 已下载待安装第二出口
 * （「立即重启安装」，弹窗未开也能装）。已是最新走轻气泡不弹模态窗（D-08）。
 */
export default function AboutTab() {
  const [appVersion, setAppVersion] = useState('')
  const [status, setStatus] = useState<AboutStatus>({ kind: 'idle' })
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const v = await window.api.update.getVersion()
        setAppVersion(v)
      } catch {
        // 版本号拉取失败保持空展示
      }
      try {
        const s = await window.api.update.getStatus()
        if (s.phase === 'downloaded') {
          setStatus({ kind: 'downloaded' })
        } else if (s.phase === 'downloading' && s.progress) {
          setStatus({ kind: 'downloading', percent: Math.round(s.progress.percent) })
        } else if (s.phase === 'available' && s.updateInfo) {
          setStatus({ kind: 'available', version: s.updateInfo.version })
        }
      } catch {
        // 状态拉取失败保持「未检查更新」
      }
    })()
    // 下载事件实时刷新状态行百分比（cleanup 解绑；相位守卫在 store，双订阅无重复副作用）
    const unbind = window.api.update.onUpdateEvent((evt) => {
      if (evt.type === 'download-progress') {
        setStatus({ kind: 'downloading', percent: Math.round(evt.payload.percent) })
      } else if (evt.type === 'update-downloaded') {
        setStatus({ kind: 'downloaded' })
      }
    })
    return () => unbind()
  }, [])

  const handleCheck = async () => {
    setStatus({ kind: 'checking' })
    setChecking(true)
    try {
      const r = await window.api.update.checkNow()
      if (r.result === 'latest') {
        setStatus({ kind: 'latest', version: r.currentVersion })
        message.success(`已是最新版本 v${r.currentVersion}`, 3)
      } else if (r.result === 'available') {
        setStatus({ kind: 'available', version: r.updateInfo.version })
        // 手动检查无视一切压制（D-02），复用同一升级弹窗（D-08）
        useUpdateStore.getState().openInfo(r.updateInfo)
      } else {
        setStatus({ kind: 'failed' })
        message.error(renderUpdateError(r.errorKind), 4)
      }
    } catch {
      setStatus({ kind: 'failed' })
      message.error(renderUpdateError('unknown'), 4)
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = () => {
    window.api.update.install().catch(() => {
      message.error('安装启动失败，请稍后重试。')
    })
  }

  return (
    <Card title="关于本应用" size="small">
      <div style={{ marginBottom: 24 }}>
        <div>
          <Text>网络拓扑管理工具</Text>
        </div>
        <div style={{ marginTop: 4 }}>
          <Text type="secondary">当前版本</Text>{' '}
          <Text strong style={{ fontSize: 20 }}>
            v{appVersion}
          </Text>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {status.kind === 'downloaded' ? (
          <Button type="primary" onClick={handleInstall}>
            立即重启安装
          </Button>
        ) : (
          <Button type="primary" loading={checking} onClick={handleCheck}>
            检查更新
          </Button>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          {statusLineText(status)}
        </Text>
      </div>
      <div style={{ marginTop: 12 }}>
        <Link onClick={openReleasesPage}>查看 GitHub Releases 页</Link>
      </div>
    </Card>
  )
}
