import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { BackupScheduler, BACKUP_QUIT_WAIT_TIMEOUT_MS } from '../../../electron/services/backupScheduler'

/**
 * Phase 30 Plan 30-01（UPD-07 / BUG-3）—— in-flight 备份追踪与顺序语义单测。
 *
 * 根因：better-sqlite3 backup = setImmediate 分页传输（lib/methods/backup.js），未 await 时
 * 后置步骤在备份刚传第一页就执行（假完成）；同步 before-quit 链不等在途备份直接 closeDatabase
 * → backups 目录残留撕裂 .bak 冒充有效备份。
 *
 * 覆盖：
 *   ① hasInFlightBackup：backup Promise pending 期间 true、resolve 后 false
 *   ② waitIdle：无在途备份立即 resolve（零等待，不依赖超时定时器）
 *   ③ waitIdle：在途备份完成后 resolve（先于超时）
 *   ④ waitIdle：超时放行不抛错（T-30-01 退出永不卡死；在途未完成也放行）
 *   ⑤ executeTask 后置步骤顺序：restrictFilePermissions 在备份完成后才执行（假完成回归锁）
 *   ⑥ createPremigrationBackup await 语义：备份未 resolve 前整体 pending，resolve 后才返回路径
 *   ⑦ waitIdle：在途备份 reject 也放行（失败留痕走 runTask catch，不阻塞退出）
 *
 * Mock 策略（ai.test.ts vi.mock 模块注入先例，28-02 执行决策）：electron / connection /
 * acl / systemLog 全 mock，被测对象 BackupScheduler 用真实现。
 */

const { backupMock, restrictFilePermissionsMock, createSystemLogMock, configRow } = vi.hoisted(() => ({
  backupMock: vi.fn(),
  restrictFilePermissionsMock: vi.fn(),
  createSystemLogMock: vi.fn(),
  configRow: {
    id: 1, enabled: 1, interval_minutes: 60, last_run: null, next_run: null,
    periodic_retention: 5, premigration_retention: 5,
  },
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '') }, // beforeAll 里按 tmpdir 临时目录重设
  BrowserWindow: { getAllWindows: () => [] }, // notifyRenderer 广播空窗口集
}))
vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => ({
    backup: backupMock, // 可控备份 Promise（deferred 阻塞/放行）
    prepare: () => ({ get: () => configRow, run: () => {} }), // getConfig/pruneBackups 路径最小 row
  }),
}))
vi.mock('../../../electron/database/acl', () => ({
  restrictFilePermissions: restrictFilePermissionsMock,
}))
vi.mock('../../../electron/services/systemLog', () => ({
  createSystemLog: createSystemLogMock,
}))

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e?: unknown) => void }

function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** TS private 是编译期限定——测试经 bracket 访问私有静态成员（不建生产注入口，28-02 决策） */
type SchedulerInternals = {
  executeTask: () => Promise<void>
  inFlightBackup: Promise<unknown> | null
  intervalId: ReturnType<typeof setInterval> | null
  isRunning: boolean
}
const internals = BackupScheduler as unknown as SchedulerInternals

let tmpRoot: string

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-sched-test-'))
  vi.mocked(app.getPath).mockReturnValue(tmpRoot)
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  backupMock.mockReset()
  restrictFilePermissionsMock.mockClear()
  createSystemLogMock.mockClear()
  // 静态状态隔离：上一用例遗留 in-flight / interval / isRunning 不串扰本用例
  internals.inFlightBackup = null
  internals.intervalId = null
  internals.isRunning = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BackupScheduler in-flight 备份追踪与顺序语义（Phase 30-01 BUG-3）', () => {
  it('① hasInFlightBackup：backup Promise pending 期间 true，resolve 后 false', async () => {
    const d = deferred()
    backupMock.mockReturnValueOnce(d.promise)
    const exec = internals.executeTask()
    // executeTask 同步段已登记 inFlightBackup（backup 调用后、首个 await 前）
    expect(BackupScheduler.hasInFlightBackup()).toBe(true)
    d.resolve(undefined)
    await exec
    expect(BackupScheduler.hasInFlightBackup()).toBe(false)
    expect(internals.isRunning).toBe(false) // finally 复位结构保持
  })

  it('② waitIdle：无在途备份立即 resolve（零等待，不依赖超时定时器）', async () => {
    vi.useFakeTimers()
    let resolved = false
    void BackupScheduler.waitIdle(BACKUP_QUIT_WAIT_TIMEOUT_MS).then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(0) // 只 flush 微任务、不推进超时
    expect(resolved).toBe(true)
  })

  it('③ waitIdle：在途备份完成后 resolve（先于超时）', async () => {
    const d = deferred()
    backupMock.mockReturnValueOnce(d.promise)
    const exec = internals.executeTask()
    const waiting = BackupScheduler.waitIdle(BACKUP_QUIT_WAIT_TIMEOUT_MS)
    let resolved = false
    void waiting.then(() => { resolved = true })
    d.resolve(undefined)
    await exec
    await waiting
    expect(resolved).toBe(true)
    expect(BackupScheduler.hasInFlightBackup()).toBe(false)
  })

  it('④ waitIdle：超时放行不抛错——在途未完成也 resolve（T-30-01 退出永不卡死）', async () => {
    vi.useFakeTimers()
    const d = deferred()
    backupMock.mockReturnValueOnce(d.promise)
    const exec = internals.executeTask()
    expect(BackupScheduler.hasInFlightBackup()).toBe(true)
    const waiting = BackupScheduler.waitIdle(BACKUP_QUIT_WAIT_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(BACKUP_QUIT_WAIT_TIMEOUT_MS) // 30s 到点
    await expect(waiting).resolves.toBeUndefined() // 超时放行：resolve 而非 reject
    expect(BackupScheduler.hasInFlightBackup()).toBe(true) // 在途仍未完成——放行独立于备份完成
    d.resolve(undefined)
    await exec
  })

  it('⑤ executeTask 后置步骤顺序：restrictFilePermissions 在备份完成后才执行（假完成回归锁）', async () => {
    const d = deferred()
    backupMock.mockReturnValueOnce(d.promise)
    const exec = internals.executeTask()
    // 备份 pending：flush 微任务后 ACL 仍不得执行（旧缺陷=第一页后就跑后置步骤）
    await Promise.resolve().then(() => Promise.resolve())
    expect(restrictFilePermissionsMock).not.toHaveBeenCalled()
    d.resolve(undefined)
    await exec
    expect(backupMock).toHaveBeenCalledTimes(1)
    expect(restrictFilePermissionsMock).toHaveBeenCalledTimes(1)
    expect(String(restrictFilePermissionsMock.mock.calls[0][0])).toContain('topology-periodic-')
  })

  it('⑥ createPremigrationBackup await 语义：备份未 resolve 前整体 pending，resolve 后才返回路径', async () => {
    const d = deferred()
    backupMock.mockReturnValueOnce(d.promise)
    const p = BackupScheduler.createPremigrationBackup(24, 30)
    expect(BackupScheduler.hasInFlightBackup()).toBe(true) // premigration 同样登记 in-flight
    expect(backupMock).toHaveBeenCalledTimes(1)
    expect(String(backupMock.mock.calls[0][0])).toContain('topology-premigration-v24-to-v30-')
    let settled = false
    void p.then(() => { settled = true })
    await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve())
    expect(settled).toBe(false) // 备份未完成 → 不假完成
    expect(restrictFilePermissionsMock).not.toHaveBeenCalled()
    d.resolve(undefined)
    const ret = await p
    expect(settled).toBe(true)
    expect(ret).toContain('topology-premigration-v24-to-v30-') // 路径在 await 之后才返回
    expect(restrictFilePermissionsMock).toHaveBeenCalledTimes(1)
    expect(BackupScheduler.hasInFlightBackup()).toBe(false)
  })

  it('⑦ waitIdle：在途备份 reject 也放行（失败留痕走 runTask catch，不阻塞退出）', async () => {
    const d = deferred()
    backupMock.mockReturnValueOnce(d.promise)
    const exec = internals.executeTask()
    const waiting = BackupScheduler.waitIdle(BACKUP_QUIT_WAIT_TIMEOUT_MS)
    d.reject(new Error('backup io error'))
    await expect(waiting).resolves.toBeUndefined() // 在途失败不阻塞退出
    await expect(exec).rejects.toThrow('backup io error') // executeTask 仍传播失败（runTask catch 留痕）
    expect(BackupScheduler.hasInFlightBackup()).toBe(false) // 失败也清登记（不残留陈旧 in-flight）
  })
})
