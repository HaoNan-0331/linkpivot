import { getDatabase } from '../database/connection'

/**
 * Phase 30（UPD-03/04/06）—— 升级压制判定 + 更新错误分诊 + 压制配置读写。
 *
 * 本文件是存储底座与判定核心，**零 updater 库依赖**（updater 库 import 由 30-03 集成，
 * RESEARCH Pitfall 7 解耦红线）；也**不 import electron**（app/autoUpdater 均归 30-03）。
 *
 * - shouldAutoPrompt：压制判定纯函数（不读 DB、不读时钟以外状态，Date.now() 允许）——
 *   「跳过此版本」命中该版本号不再弹；「不再提醒」30d/180d 档到期自动恢复、'forever' 档
 *   永静默；仅作用于启动自动提醒通道，手动检查不受影响（D-02，checkNow 由 30-03 承接）。
 * - classifyUpdateError：六类错误分诊纯函数（Pitfall 6 分诊表），对任意畸形输入兜底
 *   'unknown'（T-30-05 accept，零 IO）。
 * - UpdateService 四静态方法：ai_config.update_skip_version / update_snooze_until 两列
 *   fail-safe 读 + 硬校验写（ai.ts agent 三参数同款形态；列明文非敏感，T-30-06 accept）。
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
}
