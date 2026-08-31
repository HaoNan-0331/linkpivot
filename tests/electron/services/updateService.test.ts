import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import Database from 'better-sqlite3'
import { CancellationToken } from 'builder-util-runtime'

/**
 * Phase 30 Plan 30-02（UPD-03/04/06）—— 升级压制判定 + 六类错误分诊 + 压制配置读写测试。
 * Phase 30 Plan 30-03（UPD-01/02）—— updater 集成行为锁（init 红线覆写 / 事件转发 / 七方法）。
 *
 * 覆盖：
 *   a) v30 迁移幂等：最小基线表加两列 + user_version=30 + 重复执行不 throw + MIGRATION_HEAD===30
 *   b) shouldAutoPrompt 全分支矩阵（skip 命中/不等、snooze 未来/过期/forever/null/无效串、叠加优先级）
 *   c) classifyUpdateError 六类分诊（正例 + 数字 statusCode/串形态 + 畸形输入兜底）
 *   d) fail-safe 读：列缺失/表缺失回退 null 不 throw
 *   e) setSkipVersion/setSnooze 硬校验拒绝不落库 + 三档写入读回（±2s 容差）
 *   f) 30-03 updater 集成：①dev 门控 ②SC 红线覆写锁 ③④⑤⑥ 事件转发矩阵
 *      ⑦checkNow 结构化错误 ⑧download/cancel token 交互 ⑨下载中 error 回退（W-1）
 *
 * 安全域：内存库（`:memory:`）无落盘；_setUpdateDbGetter 注入（不碰生产单例）；
 * electron / electron-updater / systemLog 全 vi.mock（backupScheduler.test 同款策略），
 * updater 实例经 _setUpdaterForTest 注入 mock——ELECTRON_RUN_AS_NODE 绝不触真 autoUpdater（Pitfall 7）。
 */

import {
  UpdateService,
  shouldAutoPrompt,
  classifyUpdateError,
  _setUpdateDbGetter,
} from '../../../electron/services/updateService'
import { v30, MIGRATION_HEAD } from '../../../electron/database/migrations'

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: false, getVersion: () => '0.4.0' },
  BrowserWindow: { getAllWindows: (): Array<{ webContents: { send: (channel: string, data: unknown) => void } }> => [] },
}))
vi.mock('electron', () => electronMock)
// 真 electron-updater 模块在 ELECTRON_RUN_AS_NODE 下不可加载语义——mock 掉，生产单例永不触达
vi.mock('electron-updater', () => ({ autoUpdater: {} }))
const createSystemLogMock = vi.hoisted(() => vi.fn())
vi.mock('../../../electron/services/systemLog', () => ({
  createSystemLog: createSystemLogMock,
}))

/** 最小基线 ai_config（无压制两列——v30 前形态，ALTER ADD COLUMN 对最小形态即可用） */
function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE ai_config (id TEXT PRIMARY KEY, created_at TEXT)')
  db.exec("INSERT INTO ai_config (id) VALUES ('1')")
  v30(db)
  return db
}

const DUMMY_GETTER = () => {
  throw new Error('neutral')
}

afterEach(() => {
  _setUpdateDbGetter(DUMMY_GETTER)
  UpdateService._resetUpdaterForTest()
  electronMock.app.isPackaged = false
  electronMock.BrowserWindow.getAllWindows = () => []
})

describe('v30 迁移幂等（T-30-02）', () => {
  it('v30：最小基线 ai_config 加 update_skip_version/update_snooze_until 两列，user_version=30', () => {
    const db = makeDb()
    const cols = db.prepare("PRAGMA table_info('ai_config')").all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('update_skip_version')
    expect(cols.map((c) => c.name)).toContain('update_snooze_until')
    expect(db.pragma('user_version', { simple: true })).toBe(30)
    db.close()
  })

  it('v30 重复执行不 throw（hasColumn 幂等守卫）；MIGRATION_HEAD === 30', () => {
    const db = makeDb()
    expect(() => v30(db)).not.toThrow() // 第二次重复执行
    expect(db.pragma('user_version', { simple: true })).toBe(30)
    expect(MIGRATION_HEAD).toBe(32) // 36-01 v32 推进
    db.close()
  })
})

describe('shouldAutoPrompt 压制判定矩阵（Pattern 3 / D-02 仅自动通道）', () => {
  const V = '1.2.3'

  it('skip 命中 → false；不同版本号 → true（自动恢复）', () => {
    expect(shouldAutoPrompt(V, { skipVersion: V, snoozeUntil: null })).toBe(false)
    expect(shouldAutoPrompt(V, { skipVersion: '0.9.9', snoozeUntil: null })).toBe(true)
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: null })).toBe(true)
  })

  it('snooze 未来 ISO → false；过期 ISO → true（到期自动恢复提醒）', () => {
    const future = new Date(Date.now() + 86400000).toISOString()
    const past = new Date(Date.now() - 86400000).toISOString()
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: future })).toBe(false)
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: past })).toBe(true)
  })

  it("snooze 'forever' → false（永静默）；null → true；无效串 'abc' → true", () => {
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: 'forever' })).toBe(false)
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: null })).toBe(true)
    expect(shouldAutoPrompt(V, { skipVersion: null, snoozeUntil: 'abc' })).toBe(true)
  })

  it('skip+snooze 叠加：skip 命中优先于无效 snooze 串 → false', () => {
    // snoozeUntil='abc' 单独判定为 true；叠加 skip 命中仍 false——证明 skip 判定在前
    expect(shouldAutoPrompt(V, { skipVersion: V, snoozeUntil: 'abc' })).toBe(false)
    expect(shouldAutoPrompt(V, { skipVersion: V, snoozeUntil: new Date(Date.now() + 86400000).toISOString() })).toBe(false)
  })
})

describe('classifyUpdateError 六类分诊（Pitfall 6）', () => {
  it('六类各一正例', () => {
    expect(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe('network')
    expect(classifyUpdateError(new Error('connect ECONNREFUSED 127.0.0.1:10809'))).toBe('proxy')
    expect(classifyUpdateError({ statusCode: 429, message: 'Too Many Requests' })).toBe('ratelimit')
    expect(classifyUpdateError(new Error('ERR_UPDATER_NO_PUBLISHED_VERSIONS'))).toBe('nometa')
    expect(classifyUpdateError({ statusCode: 502, message: 'Bad Gateway' })).toBe('server')
    expect(classifyUpdateError(new Error('随便'))).toBe('unknown')
  })

  it('数字 statusCode 形态 + 403 串形态 + ECONNREFUSED 非 127.0.0.1 判 unknown', () => {
    expect(classifyUpdateError({ code: 'ETIMEDOUT' })).toBe('network')
    expect(classifyUpdateError({ statusCode: 403 })).toBe('ratelimit')
    expect(classifyUpdateError(new Error('HTTP 403 Forbidden'))).toBe('ratelimit') // 403 串形态
    expect(classifyUpdateError({ statusCode: 404, message: 'Not Found' })).toBe('nometa')
    expect(classifyUpdateError(new Error('ERR_UPDATER_LATEST_VERSION_NOT_FOUND'))).toBe('nometa')
    expect(classifyUpdateError({ statusCode: 503 })).toBe('server')
    expect(classifyUpdateError(new Error('HTTP 5xx: 503 Service Unavailable'))).toBe('server') // 5xx 串形态
    // ECONNREFUSED 但非本机代理地址 → 不判 proxy（无其他特征兜底 unknown）
    expect(classifyUpdateError(new Error('connect ECONNREFUSED 10.0.0.1:22'))).toBe('unknown')
  })

  it('Chromium net 栈死代理错误码形态（30-05 真机形态②实证：electron.net 走死系统代理报 net::ERR_PROXY_CONNECTION_FAILED，非 errno 形态）', () => {
    expect(classifyUpdateError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toBe('proxy')
    expect(classifyUpdateError({ code: 'ERR_PROXY_CONNECTION_FAILED' })).toBe('proxy')
  })

  it('畸形输入兜底 unknown（null/undefined/plain string/空对象，T-30-05）', () => {
    expect(classifyUpdateError(null)).toBe('unknown')
    expect(classifyUpdateError(undefined)).toBe('unknown')
    expect(classifyUpdateError('plain string error')).toBe('unknown')
    expect(classifyUpdateError({})).toBe('unknown')
    expect(classifyUpdateError(42)).toBe('unknown')
  })
})

describe('UpdateService 压制配置 fail-safe 读写', () => {
  it('基线表无两列：getSkipVersion/getSnoozeUntil 返回 null 不 throw（fail-safe）', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE ai_config (id TEXT PRIMARY KEY, created_at TEXT)')
    db.exec("INSERT INTO ai_config (id) VALUES ('1')")
    _setUpdateDbGetter(() => db)
    expect(UpdateService.getSkipVersion()).toBeNull()
    expect(UpdateService.getSnoozeUntil()).toBeNull()
    db.close()
  })

  it('无 ai_config 表：同样回退 null 不 throw', () => {
    const db = new Database(':memory:')
    _setUpdateDbGetter(() => db)
    expect(UpdateService.getSkipVersion()).toBeNull()
    expect(UpdateService.getSnoozeUntil()).toBeNull()
    db.close()
  })

  it('v30 后两列 NULL 态读回 null；setSkipVersion 拒绝 abc 与 <script>（success:false 不落库）；合法 0.5.0 读写回', () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    expect(UpdateService.getSkipVersion()).toBeNull() // NULL → null
    expect(UpdateService.getSnoozeUntil()).toBeNull()

    const r1 = UpdateService.setSkipVersion('abc')
    expect(r1.success).toBe(false)
    expect(r1.error).toContain('版本号')
    const r2 = UpdateService.setSkipVersion('<script>')
    expect(r2.success).toBe(false)
    expect(UpdateService.getSkipVersion()).toBeNull() // 拒绝值未落库

    expect(UpdateService.setSkipVersion('0.5.0').success).toBe(true)
    expect(UpdateService.getSkipVersion()).toBe('0.5.0')
    db.close()
  })

  it("setSnooze('30d')：ISO 值在期望区间（±2s 容差）读回", () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    const before = Date.now() + 30 * 86400000
    expect(UpdateService.setSnooze('30d').success).toBe(true)
    const after = Date.now() + 30 * 86400000
    const readBack = UpdateService.getSnoozeUntil()
    expect(readBack).not.toBeNull()
    const ts = Date.parse(readBack as string)
    expect(ts).toBeGreaterThanOrEqual(before - 2000)
    expect(ts).toBeLessThanOrEqual(after + 2000)
    db.close()
  })

  it("setSnooze('180d')：ISO 值在期望区间（±2s 容差）读回", () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    const before = Date.now() + 180 * 86400000
    expect(UpdateService.setSnooze('180d').success).toBe(true)
    const after = Date.now() + 180 * 86400000
    const readBack = UpdateService.getSnoozeUntil()
    expect(readBack).not.toBeNull()
    const ts = Date.parse(readBack as string)
    expect(ts).toBeGreaterThanOrEqual(before - 2000)
    expect(ts).toBeLessThanOrEqual(after + 2000)
    db.close()
  })

  it("setSnooze('forever')：字面 'forever' 哨兵读回", () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    expect(UpdateService.setSnooze('forever').success).toBe(true)
    expect(UpdateService.getSnoozeUntil()).toBe('forever')
    db.close()
  })

  it('setSnooze 非法档位拒绝（success:false 不落库，T-30-04 枚举硬校验）', () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    const r = UpdateService.setSnooze('abc' as never)
    expect(r.success).toBe(false)
    expect(r.error).toContain('档位')
    expect(UpdateService.getSnoozeUntil()).toBeNull() // 拒绝值未落库
    db.close()
  })
})

// =====================================================================
// 30-03：updater 集成（mock updater + mock BrowserWindow 广播捕集）
// =====================================================================

/** 与生产 MinimalUpdater 结构同形的 mock（经 _setUpdaterForTest 注入，Pitfall 7） */
type MockUpdater = NonNullable<Parameters<typeof UpdateService._setUpdaterForTest>[0]>

interface SentMessage {
  channel: string
  data: { type: string; payload?: unknown }
}

interface MockHarness {
  updater: MockUpdater
  emit: (event: string, ...args: unknown[]) => void
  sent: SentMessage[]
}

/** mock updater + 可变窗口集（webContents.send 捕集 update:event 广播） */
function makeUpdater(): MockHarness {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const sent: SentMessage[] = []
  const windows: Array<{ webContents: { send: (channel: string, data: unknown) => void } }> = [
    { webContents: { send: (channel: string, data: unknown) => sent.push({ channel, data: data as SentMessage['data'] }) } },
  ]
  electronMock.BrowserWindow.getAllWindows = () => windows
  const updater: MockUpdater = {
    autoInstallOnAppQuit: true, // 初始 true：init 未覆写时可观测
    autoDownload: true,
    allowPrerelease: true,
    logger: null,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? []
      arr.push(listener)
      listeners.set(event, arr)
    },
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  }
  const emit = (event: string, ...args: unknown[]): void => {
    for (const l of listeners.get(event) ?? []) l(...args)
  }
  return { updater, emit, sent }
}

describe('updater 集成（30-03，UPD-01/02）', () => {
  beforeEach(() => {
    electronMock.app.isPackaged = true
    createSystemLogMock.mockClear()
  })

  it('① init dev 门控：!app.isPackaged 直接 return（不覆写默认值、不注册事件、不触 updater）', () => {
    electronMock.app.isPackaged = false
    const { updater, emit, sent } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    expect(updater.autoInstallOnAppQuit).toBe(true) // 未被覆写（init 未触 updater）
    expect(updater.autoDownload).toBe(true)
    emit('update-available', { version: '9.9.9' }) // 无监听器注册
    expect(UpdateService.getStatus().phase).toBe('idle')
    expect(sent).toHaveLength(0)
  })

  it('② init SC 红线行为锁：autoInstallOnAppQuit === false 且 autoDownload === false（Pitfall 1）', () => {
    const { updater } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.autoDownload).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.logger).toBe(console)
    // 重复 init 幂等（inited 守卫下默认值覆写仍执行，事件不重复注册）
    UpdateService.init()
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('③ update-available → phase=available + updateInfo 暂存 + update:event 广播', () => {
    const { updater, emit, sent } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    emit('update-available', { version: '0.5.0', releaseNotes: '修复若干问题', releaseDate: '2026-08-27T00:00:00Z' })
    const st = UpdateService.getStatus()
    expect(st.phase).toBe('available')
    expect(st.updateInfo).toEqual({ version: '0.5.0', notes: '修复若干问题', releaseDate: '2026-08-27T00:00:00Z' })
    expect(st.currentVersion).toBe('0.4.0')
    expect(st.suppressed).toBe(false) // 无压制两列（dbGetter DUMMY → fail-safe null）
    expect(sent.some((m) => m.channel === 'update:event' && m.data.type === 'update-available')).toBe(true)
  })

  it('④ download-progress → phase=downloading + progress 快照（percent/transferred/total）', () => {
    const { updater, emit, sent } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    emit('update-available', { version: '0.5.0' })
    emit('download-progress', { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 512 })
    const st = UpdateService.getStatus()
    expect(st.phase).toBe('downloading')
    expect(st.progress).toEqual({ percent: 42.5, transferred: 425, total: 1000 })
    expect(sent.some((m) => m.channel === 'update:event' && m.data.type === 'download-progress')).toBe(true)
  })

  it('⑤ update-downloaded → phase=downloaded + systemLog type=update 审计', () => {
    const { updater, emit } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    emit('update-downloaded', { version: '0.5.0', releaseNotes: null, releaseDate: '2026-08-27T00:00:00Z' })
    const st = UpdateService.getStatus()
    expect(st.phase).toBe('downloaded')
    expect(st.updateInfo).toEqual({ version: '0.5.0', notes: '', releaseDate: '2026-08-27T00:00:00Z' })
    expect(createSystemLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'update', status: 'success', errorMessage: expect.stringContaining('新版本已下载') })
    )
  })

  it('⑥ update-cancelled → 回可重试态 available（D-06；updateInfo 保留供重试）', () => {
    const { updater, emit, sent } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    emit('update-available', { version: '0.5.0' })
    emit('download-progress', { percent: 10, transferred: 100, total: 1000 })
    expect(UpdateService.getStatus().phase).toBe('downloading')
    emit('update-cancelled')
    const st = UpdateService.getStatus()
    expect(st.phase).toBe('available')
    expect(st.updateInfo?.version).toBe('0.5.0')
    expect(sent.some((m) => m.channel === 'update:event' && m.data.type === 'update-cancelled')).toBe(true)
  })

  it('⑦ checkNow：checkForUpdates reject(ENOTFOUND) → { result:"error", errorKind:"network" } 不 throw', async () => {
    const { updater } = makeUpdater()
    updater.checkForUpdates = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com')
    }
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    const r = await UpdateService.checkNow()
    expect(r.result).toBe('error')
    expect((r as { errorKind: string }).errorKind).toBe('network')
    expect((r as { message: string }).message).toContain('ENOTFOUND')
  })

  it('⑦b checkNow 成功路径：有新版 available（事件驱动暂存）/ 无新版 latest；error 事件暂存错误优先透出', async () => {
    const { updater, emit } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    // 有新版：checkForUpdates 期间 emit update-available（electron-updater 真实行为）
    updater.checkForUpdates = async () => {
      emit('update-available', { version: '0.5.0', releaseNotes: '', releaseDate: '' })
    }
    const r1 = await UpdateService.checkNow()
    expect(r1.result).toBe('available')
    expect((r1 as { updateInfo: { version: string } }).updateInfo.version).toBe('0.5.0')
    // 无新版
    updater.checkForUpdates = async () => {
      emit('update-not-available', {})
    }
    const r2 = await UpdateService.checkNow()
    expect(r2.result).toBe('latest')
    expect((r2 as { currentVersion: string }).currentVersion).toBe('0.4.0')
    // resolve 但期间 error 事件暂存（electron-updater 部分失败路径经事件而非 reject）
    updater.checkForUpdates = async () => {
      emit('error', new Error('HTTP 404 Not Found'))
    }
    const r3 = await UpdateService.checkNow()
    expect(r3.result).toBe('error')
    expect((r3 as { errorKind: string }).errorKind).toBe('nometa')
  })

  it('⑧ startDownload/cancelDownload：token.cancel 被调用（D-06）+ 下载失败回 { started:false }', async () => {
    const { updater } = makeUpdater()
    let resolveDownload!: (v: string[]) => void
    updater.downloadUpdate = vi.fn(() => new Promise<string[]>((res) => { resolveDownload = res }))
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    const dl = UpdateService.startDownload()
    UpdateService.cancelDownload()
    const token = (updater.downloadUpdate as unknown as Mock).mock.calls[0][0] as CancellationToken
    expect(token.cancelled).toBe(true) // cancelDownload → 真实 CancellationToken.cancel 生效
    resolveDownload([])
    await expect(dl).resolves.toEqual({ started: true })
    // 失败路径：downloadUpdate reject → 结构化回错不 throw
    updater.downloadUpdate = vi.fn(() => Promise.reject(new Error('sha512 mismatch')))
    const r = await UpdateService.startDownload()
    expect(r.started).toBe(false)
    expect(r.errorKind).toBe('unknown')
  })

  it('⑨ 下载中 error 恢复（W-1）：downloading → error 后回 available + update:type=error 广播 + systemLog failed', () => {
    const { updater, emit, sent } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    emit('update-available', { version: '0.5.0' })
    emit('download-progress', { percent: 50, transferred: 500, total: 1000 })
    expect(UpdateService.getStatus().phase).toBe('downloading')
    emit('error', new Error('download interrupted'))
    const st = UpdateService.getStatus()
    expect(st.phase).toBe('available') // 回可重试态，不永久卡「正在下载中」
    expect(st.updateInfo?.version).toBe('0.5.0') // updateInfo 保留供重试
    expect(sent.some((m) => m.channel === 'update:event' && m.data.type === 'error')).toBe(true)
    expect(createSystemLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'update', status: 'failed' })
    )
  })

  it('⑩ checkForUpdatesAuto：init 未跑直接 return 不触 updater；quitAndInstall(true, true) 参数锁', async () => {
    const { updater } = makeUpdater()
    UpdateService._setUpdaterForTest(updater) // 不调 init → inited=false 短路（dev 门控同理）
    await UpdateService.checkForUpdatesAuto()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    UpdateService.init()
    UpdateService.quitAndInstall()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('⑪ getStatus suppressed 联动：skip 命中该版本 → suppressed=true（shouldAutoPrompt 消费实证）', () => {
    const db = makeDb()
    _setUpdateDbGetter(() => db)
    expect(UpdateService.setSkipVersion('0.5.0').success).toBe(true)
    const { updater, emit } = makeUpdater()
    UpdateService._setUpdaterForTest(updater)
    UpdateService.init()
    emit('update-available', { version: '0.5.0' })
    expect(UpdateService.getStatus().suppressed).toBe(true)
    db.close()
  })
})
