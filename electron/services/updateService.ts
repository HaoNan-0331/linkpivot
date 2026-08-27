import { getDatabase } from '../database/connection'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import { createSystemLog } from './systemLog'

/**
 * Phase 30（UPD-01/02/03/04/06）—— 升级压制判定 + 更新错误分诊 + 压制配置读写 + updater 集成。
 *
 * 30-02 底座（纯函数层，语义未动）：
 * - shouldAutoPrompt：压制判定纯函数（不读 DB、不读时钟以外状态，Date.now() 允许）——
 *   「跳过此版本」命中该版本号不再弹；「不再提醒」30d/180d 档到期自动恢复、'forever' 档
 *   永静默；仅作用于启动自动提醒通道，手动检查不受影响（D-02）。
 * - classifyUpdateError：六类错误分诊纯函数（Pitfall 6 分诊表），对任意畸形输入兜底
 *   'unknown'（T-30-05 accept，零 IO）。
 * - UpdateService 压制配置四方法：ai_config.update_skip_version / update_snooze_until 两列
 *   fail-safe 读 + 硬校验写（ai.ts agent 三参数同款形态；列明文非敏感，T-30-06 accept）。
 *
 * 30-03 集成（本文件增量，RESEARCH Pattern 1/3 + Pitfall 1/7）：
 * - autoUpdater 单例封装：init（dev 门控 + SC 红线默认值覆写）/ 七事件转发（update:event
 *   单通道广播全部窗口 + systemLog type='update'）/ 七公共方法（getStatus / checkForUpdatesAuto /
 *   checkNow / startDownload / cancelDownload / quitAndInstall / getVersion）。
 * - 测试经 _setUpdaterForTest 注入 mock（ELECTRON_RUN_AS_NODE 环境绝不触真 autoUpdater——
 *   Pitfall 7 红线）；生产实例 = electron-updater 导出的 autoUpdater 单例（win32 = NsisUpdater）。
 *
 * DB getter 经 _setUpdateDbGetter 注入（测试解耦，ai.ts _setAiDbGetter 先例），
 * 生产默认 getDatabase。
 */

/** 压制判定输入：两列当前值（NULL=无压制） */
export interface SuppressState {
  skipVersion: string | null
  snoozeUntil: string | null
}

/**
 * 启动自动提醒通道的压制判定（纯函数）。
 * 判定顺序（plan 30-02 固定）：skip 命中 → false；'forever' → false；
 * 可解析的未来 ISO 时间戳 → false；其余（null / 过期 / 无效串）→ true。
 */
export function shouldAutoPrompt(version: string, opts: SuppressState): boolean {
  if (opts.skipVersion !== null && opts.skipVersion === version) {
    return false
  }
  if (opts.snoozeUntil === 'forever') {
    return false
  }
  if (opts.snoozeUntil !== null) {
    const until = Date.parse(opts.snoozeUntil)
    if (!Number.isNaN(until) && until > Date.now()) {
      return false
    }
  }
  return true
}

/** 更新检测错误六类分诊（Pitfall 6） */
export type UpdateErrorKind = 'network' | 'proxy' | 'ratelimit' | 'nometa' | 'server' | 'unknown'

/** 5xx 三位数字（词边界锚定，避免端口号/ID 误命中） */
const SERVER_5XX_RE = /\b5\d{2}\b/

/**
 * 更新检测错误分类纯函数。特征从 (err as any)?.code / statusCode / message 三处拼串，
 * 判定顺序固定：network → proxy → ratelimit → nometa → server → unknown。
 * 畸形错误对象（null/undefined/无字段）拼出空串，兜底 'unknown'（T-30-05）。
 */
export function classifyUpdateError(err: unknown): UpdateErrorKind {
  const e = (err ?? {}) as { code?: unknown; statusCode?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const rawStatus = e.statusCode
  const statusCode = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : -1
  const statusCodeText = statusCode >= 0 ? String(statusCode) : ''
  const message = typeof e.message === 'string' ? e.message : ''
  const s = `${code} ${statusCodeText} ${message}`

  if (s.includes('ENOTFOUND') || s.includes('EAI_AGAIN') || s.includes('ETIMEDOUT')) {
    return 'network'
  }
  if (s.includes('ECONNREFUSED') && s.includes('127.0.0.1')) {
    return 'proxy'
  }
  if (statusCode === 403 || statusCode === 429 || s.includes('403') || s.includes('429')) {
    return 'ratelimit'
  }
  if (
    s.includes('ERR_UPDATER_NO_PUBLISHED_VERSIONS') ||
    s.includes('ERR_UPDATER_LATEST_VERSION_NOT_FOUND') ||
    s.includes('404')
  ) {
    return 'nometa'
  }
  if ((statusCode >= 500 && statusCode <= 599) || SERVER_5XX_RE.test(s)) {
    return 'server'
  }
  return 'unknown'
}

let updateDbGetter: () => ReturnType<typeof getDatabase> = getDatabase

/** 测试注入口：内存库替换生产单例（仅压制两列读写使用，ai.ts _setAiDbGetter 同款） */
export function _setUpdateDbGetter(getter: () => ReturnType<typeof getDatabase>): void {
  updateDbGetter = getter
}

/** 「跳过此版本」合法格式：纯三段数字 semver（x.y.z），防注入/超长串落库（T-30-04） */
const SKIP_VERSION_RE = /^\d+\.\d+\.\d+$/

/** 新版本信息（update-available / update-downloaded 事件负载；30-04 消费契约） */
export interface UpdateInfoBrief {
  version: string
  notes: string
  releaseDate: string
}

/** update:event 单通道广播负载（30-04 消费契约；七事件 = electron-updater 事件面全量） */
export interface UpdateEventPayload {
  type:
    | 'checking-for-update'
    | 'update-available'
    | 'update-not-available'
    | 'download-progress'
    | 'update-downloaded'
    | 'update-cancelled'
    | 'error'
  payload?: UpdateInfoBrief | ProgressBroadcast | UpdateErrorBrief
}

/** download-progress 事件负载（electron-updater ProgressInfo 子集） */
interface ProgressBroadcast {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** error 事件负载 */
interface UpdateErrorBrief {
  errorKind: UpdateErrorKind
  message: string
}

/** getStatus 快照（30-04 消费契约；progress 仅 downloading 阶段附带） */
export interface UpdateStatusInfo {
  phase: 'idle' | 'available' | 'downloading' | 'downloaded'
  currentVersion: string
  updateInfo: UpdateInfoBrief | null
  /** 启动自动提醒通道被压制（skip / 不再提醒命中；手动检查无视压制 D-02） */
  suppressed: boolean
  progress?: { percent: number; transferred: number; total: number }
}

/** checkNow 结果（30-04 消费契约；业务拒绝走结果对象不 throw——29-06 saveConfig 契约先例） */
export type CheckNowResult =
  | { result: 'latest'; currentVersion: string }
  | { result: 'available'; currentVersion: string; updateInfo: UpdateInfoBrief }
  | { result: 'error'; errorKind: UpdateErrorKind; message: string }

/**
 * 最小 updater 结构契约：autoUpdater 单例的行为子集（属性四 + 方法四）。
 * 生产实例类型面是抽象 AppUpdater（quitAndInstall 在 BaseUpdater 子类，运行时 win32 的
 * NsisUpdater 实例具备），故经 getUpdater() 单点收窄；测试经 _setUpdaterForTest 注入同形 mock。
 */
interface MinimalUpdater {
  autoInstallOnAppQuit: boolean
  autoDownload: boolean
  allowPrerelease: boolean
  logger: unknown
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(cancellationToken?: CancellationToken): Promise<Array<string>>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

/** 畸形错误对象的消息提取（classifyUpdateError 同款宽容形态） */
function errMessage(err: unknown): string {
  const m = (err as { message?: unknown })?.message
  return typeof m === 'string' && m.length > 0 ? m : '更新检查失败'
}

/** UpdateInfo → 精简契约（畸形字段逐个降级空串，不 throw） */
function toBrief(info: unknown): UpdateInfoBrief {
  const i = (info ?? {}) as { version?: unknown; releaseNotes?: unknown; releaseDate?: unknown }
  return {
    version: typeof i.version === 'string' ? i.version : '',
    notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '',
    releaseDate: typeof i.releaseDate === 'string' ? i.releaseDate : '',
  }
}

export class UpdateService {
  /** 读 ai_config.update_skip_version；空/NULL/列缺失异常一律回退 null（fail-safe） */
  static getSkipVersion(): string | null {
    try {
      const row = updateDbGetter()
        .prepare('SELECT update_skip_version FROM ai_config LIMIT 1')
        .get() as { update_skip_version?: string | null } | undefined
      const v = row?.update_skip_version
      return typeof v === 'string' && v.length > 0 ? v : null
    } catch {
      return null
    }
  }

  /** 「跳过此版本」写入口：仅收纳 /^\d+\.\d+\.\d+$/ 版本号，非法拒绝落库显式回错（T-30-04） */
  static setSkipVersion(v: string): { success: boolean; error?: string } {
    if (typeof v !== 'string' || !SKIP_VERSION_RE.test(v)) {
      return { success: false, error: '版本号格式非法' }
    }
    updateDbGetter().prepare('UPDATE ai_config SET update_skip_version = ?').run(v)
    return { success: true }
  }

  /** 读 ai_config.update_snooze_until；空/NULL/列缺失异常一律回退 null（fail-safe） */
  static getSnoozeUntil(): string | null {
    try {
      const row = updateDbGetter()
        .prepare('SELECT update_snooze_until FROM ai_config LIMIT 1')
        .get() as { update_snooze_until?: string | null } | undefined
      const v = row?.update_snooze_until
      return typeof v === 'string' && v.length > 0 ? v : null
    } catch {
      return null
    }
  }

  /**
   * 「不再提醒」档位写入口（枚举硬校验，非法拒绝落库显式回错，T-30-04）：
   * '30d'/'180d' → 未来 ISO 时间戳（到期自动恢复提醒）；'forever' → 字面哨兵（自动通道永静默）。
   */
  static setSnooze(mode: '30d' | '180d' | 'forever'): { success: boolean; error?: string } {
    let value: string
    if (mode === 'forever') {
      value = 'forever'
    } else if (mode === '30d') {
      value = new Date(Date.now() + 30 * 86400000).toISOString()
    } else if (mode === '180d') {
      value = new Date(Date.now() + 180 * 86400000).toISOString()
    } else {
      return { success: false, error: '不再提醒档位非法' }
    }
    updateDbGetter().prepare('UPDATE ai_config SET update_snooze_until = ?').run(value)
    return { success: true }
  }

  // ===== 30-03：updater 集成（UPD-01 静默检测 / UPD-02 下载与显式安装）=====

  private static inited = false
  private static updaterOverride: MinimalUpdater | null = null
  private static phase: UpdateStatusInfo['phase'] = 'idle'
  private static pendingVersion: UpdateInfoBrief | null = null
  private static progress: ProgressBroadcast | null = null
  private static cancellationToken: CancellationToken | null = null
  private static manualChecking = false
  private static manualCheckError: UpdateErrorBrief | null = null

  /** 测试注入口：mock updater 替换生产单例（Pitfall 7——测试环境绝不触真 autoUpdater） */
  static _setUpdaterForTest(mock: MinimalUpdater | null): void {
    this.updaterOverride = mock
  }

  /** 测试隔离复位：updater 注入与全部实例状态清零（静态状态跨用例不串扰） */
  static _resetUpdaterForTest(): void {
    this.updaterOverride = null
    this.inited = false
    this.phase = 'idle'
    this.pendingVersion = null
    this.progress = null
    this.cancellationToken = null
    this.manualChecking = false
    this.manualCheckError = null
  }

  private static getUpdater(): MinimalUpdater {
    return this.updaterOverride ?? (autoUpdater as unknown as MinimalUpdater)
  }

  /** 手动检查暂存错误读取（方法出口恢复声明类型——checkNow 的属性 CFA 不跨越事件回调写入） */
  private static readManualCheckError(): UpdateErrorBrief | null {
    return this.manualCheckError
  }

  /**
   * 初始化（main.ts whenReady 启动链调用）。dev 门控：!app.isPackaged 直接 return
   * （Pitfall 7——electron:dev / test 环境零 updater 副作用），随即三行显式覆写默认值：
   * - autoUpdater.autoInstallOnAppQuit = false —— SC 红线（Pitfall 1 最高危）：默认 true
   *   （AppUpdater.js:114）会在用户退出应用时机静默安装
   * - autoUpdater.autoDownload = false —— 弹窗按钮触发下载（D-04）
   * - autoUpdater.allowPrerelease = false —— 只认正式版
   */
  static init(): void {
    if (!app.isPackaged) return
    const updater = this.getUpdater()
    updater.autoInstallOnAppQuit = false
    updater.autoDownload = false
    updater.allowPrerelease = false
    updater.logger = console
    if (this.inited) return // 默认值覆写幂等；事件注册只做一次（防重复注册）
    this.inited = true
    this.registerUpdaterEvents(updater)
  }

  /** 七事件转发（update:event 单通道广播 + 关键节点 systemLog type='update' 审计，T-30-08） */
  private static registerUpdaterEvents(updater: MinimalUpdater): void {
    updater.on('checking-for-update', () => {
      this.notifyRenderer('update:event', { type: 'checking-for-update' })
    })
    updater.on('update-available', (info: unknown) => {
      this.pendingVersion = toBrief(info)
      this.phase = 'available'
      this.notifyRenderer('update:event', { type: 'update-available', payload: this.pendingVersion })
    })
    updater.on('update-not-available', () => {
      this.phase = 'idle'
      this.pendingVersion = null
      this.notifyRenderer('update:event', { type: 'update-not-available' })
    })
    updater.on('download-progress', (p: unknown) => {
      const q = (p ?? {}) as Partial<ProgressBroadcast>
      this.progress = {
        percent: typeof q.percent === 'number' ? q.percent : 0,
        transferred: typeof q.transferred === 'number' ? q.transferred : 0,
        total: typeof q.total === 'number' ? q.total : 0,
        bytesPerSecond: typeof q.bytesPerSecond === 'number' ? q.bytesPerSecond : 0,
      }
      this.phase = 'downloading'
      this.notifyRenderer('update:event', { type: 'download-progress', payload: this.progress })
    })
    updater.on('update-downloaded', (info: unknown) => {
      this.pendingVersion = toBrief(info)
      this.phase = 'downloaded'
      try {
        createSystemLog({ type: 'update', status: 'success', errorMessage: '新版本已下载待安装' })
      } catch { /* 日志失败不影响主流程 */ }
      this.notifyRenderer('update:event', { type: 'update-downloaded', payload: this.pendingVersion })
    })
    updater.on('update-cancelled', () => {
      this.phase = 'available' // 回可重试态（D-06）
      this.notifyRenderer('update:event', { type: 'update-cancelled' })
    })
    updater.on('error', (err: unknown) => {
      // 下载中途失败回可重试态（与 update-cancelled 同语义）：否则 getStatus/AboutTab 状态行
      // 永久卡「正在下载中」（checker 修订 W-1 main 侧一致性）；updateInfo 保留供重试
      if (this.phase === 'downloading') this.phase = 'available'
      const brief: UpdateErrorBrief = { errorKind: classifyUpdateError(err), message: errMessage(err) }
      try {
        createSystemLog({ type: 'update', status: 'failed', errorMessage: `更新失败（${brief.errorKind}）: ${brief.message}` })
      } catch { /* 日志失败不影响主流程 */ }
      if (this.manualChecking) this.manualCheckError = brief // 手动检查通道透出（D-02/UPD-06）
      this.notifyRenderer('update:event', { type: 'error', payload: brief })
    })
  }

  /** 状态快照：phase / 当前版本 / 暂存新版本 / 压制判定（仅自动通道语义）/ 进度 */
  static getStatus(): UpdateStatusInfo {
    const suppressed = this.pendingVersion !== null
      ? !shouldAutoPrompt(this.pendingVersion.version, {
          skipVersion: this.getSkipVersion(),
          snoozeUntil: this.getSnoozeUntil(),
        })
      : false
    return {
      phase: this.phase,
      currentVersion: app.getVersion(),
      updateInfo: this.pendingVersion,
      suppressed,
      ...(this.phase === 'downloading' && this.progress
        ? { progress: { percent: this.progress.percent, transferred: this.progress.transferred, total: this.progress.total } }
        : {}),
    }
  }

  /** 启动静默检测（main.ts fire-and-forget 调用，不 await）：失败静默零打扰（UPD-01 / D-03） */
  static async checkForUpdatesAuto(): Promise<void> {
    if (!this.inited || !app.isPackaged) return
    try {
      await this.getUpdater().checkForUpdates()
    } catch { /* 启动通道：失败静默（手动检查时才把错误交给分类器透出） */ }
  }

  /**
   * 手动检查（AboutTab「检查更新」按钮）：全解禁——不查压制（D-02），错误以结构化
   * { result:'error', errorKind } 返回绝不向上 throw。manualChecking 旗标包住 await，
   * 期间 error 事件暂存的错误优先透出（electron-updater 部分失败路径经事件而非 promise reject）。
   */
  static async checkNow(): Promise<CheckNowResult> {
    this.manualChecking = true
    this.manualCheckError = null
    try {
      await this.getUpdater().checkForUpdates()
      // await 期间 error 事件可能已暂存（TS 属性 CFA 看不见事件回调写入，经方法读返回声明类型）
      const stashed = this.readManualCheckError()
      if (stashed) {
        return { result: 'error', errorKind: stashed.errorKind, message: stashed.message }
      }
      if (this.pendingVersion) {
        return { result: 'available', currentVersion: app.getVersion(), updateInfo: this.pendingVersion }
      }
      return { result: 'latest', currentVersion: app.getVersion() }
    } catch (err) {
      return { result: 'error', errorKind: classifyUpdateError(err), message: errMessage(err) }
    } finally {
      this.manualChecking = false
      this.manualCheckError = null
    }
  }

  /** 下载（弹窗「立即升级」触发）：CancellationToken 登记，取消即 update-cancelled 事件（D-06） */
  static async startDownload(): Promise<{ started: boolean; errorKind?: UpdateErrorKind }> {
    const cancellationToken = new CancellationToken()
    this.cancellationToken = cancellationToken
    try {
      await this.getUpdater().downloadUpdate(cancellationToken)
      return { started: true }
    } catch (err) {
      return { started: false, errorKind: classifyUpdateError(err) }
    } finally {
      if (this.cancellationToken === cancellationToken) this.cancellationToken = null
    }
  }

  /** 取消下载：触发 electron-updater update-cancelled 事件 → phase 回可重试态 */
  static cancelDownload(): void {
    this.cancellationToken?.cancel()
  }

  /**
   * 显式安装（唯一安装触发点，SC 红线）：静默安装 + 安装后重启。触发的 app.quit() 走
   * 30-01 before-quit guard 天然兼容（安装器已 spawn，等在途备份 ≤30s 可接受）。
   */
  static quitAndInstall(): void {
    this.getUpdater().quitAndInstall(true, true)
  }

  /** 当前应用版本（AboutTab 展示，app.getVersion() 经 IPC 下发） */
  static getVersion(): string {
    return app.getVersion()
  }

  /** 广播全部窗口（backupScheduler.notifyRenderer 形态；单窗口 send 失败不阻塞其余窗口） */
  private static notifyRenderer(channel: string, data: UpdateEventPayload): void {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send(channel, data) } catch { /* window closed */ }
    }
  }
}
