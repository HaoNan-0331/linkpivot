import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  migrateLegacyUserData,
  LEGACY_DIR_NAMES,
  TARGET_DIR_NAME,
} from '../../../electron/utils/dataDirMigration'

/**
 * Phase 30.1 Plan 30.1-02 —— 改名后 userData 目录一次性原子迁移行为锁（六用例）。
 *
 * 背景：productName 改「灵枢」后 Electron 默认 userData 会漂移到 %APPDATA%\灵枢，
 * 0.4.0 老用户 DB/masterKey/kb_files/backups 全部「消失」。迁移语义：
 *   - target=LinkPivot 已存在 → none（永不覆盖既有目录红线，用例 3）
 *   - 按 LEGACY_DIR_NAMES 有序遍历（打包态「网络拓扑管理工具」优先，用例 5）
 *   - renameSync 同卷原子搬迁；失败 → fallback 继续用旧目录（数据可用性优先，用例 6）
 *
 * 纯函数零 electron import（ELECTRON_RUN_AS_NODE 可测）；每用例 os.tmpdir() mkdtemp
 * 独立 appData 根，互不串扰；afterEach 统一回收。
 */

const roots: string[] = []

/** 独立 appData 根（%APPDATA% 等价物） */
function makeAppDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'datadir-mig-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true })
  }
})

describe('migrateLegacyUserData（30.1-02 改名数据迁移）', () => {
  it('导出契约：LEGACY_DIR_NAMES 有序（打包态优先）/ TARGET_DIR_NAME=LinkPivot', () => {
    expect(LEGACY_DIR_NAMES[0]).toBe('网络拓扑管理工具')
    expect(LEGACY_DIR_NAMES).toContain('network-topology-manager')
    expect(TARGET_DIR_NAME).toBe('LinkPivot')
  })

  it('用例 1：无 legacy 无 target → none（调用方 setPath 到全新 LinkPivot 目录）', () => {
    const root = makeAppDataRoot()
    const r = migrateLegacyUserData(root)
    expect(r.status).toBe('none')
    expect(r.from).toBeUndefined()
  })

  it('用例 2：legacy「网络拓扑管理工具」存在 → migrated，哨兵文件随目录整体搬迁，legacy 消失', () => {
    const root = makeAppDataRoot()
    const legacy = path.join(root, '网络拓扑管理工具')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'topology.db'), 'db')
    fs.writeFileSync(path.join(legacy, 'master.key'), 'key')
    const r = migrateLegacyUserData(root)
    expect(r.status).toBe('migrated')
    expect(r.from).toBe(legacy)
    const target = path.join(root, TARGET_DIR_NAME)
    expect(fs.existsSync(path.join(target, 'topology.db'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'master.key'))).toBe(true)
    expect(fs.existsSync(legacy)).toBe(false)
  })

  it('用例 3：target LinkPivot 已存在 + legacy 也在 → none，legacy 原样保留（永不覆盖红线）', () => {
    const root = makeAppDataRoot()
    const legacy = path.join(root, '网络拓扑管理工具')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'topology.db'), 'old-db')
    const target = path.join(root, TARGET_DIR_NAME)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'topology.db'), 'existing-db')
    const r = migrateLegacyUserData(root)
    expect(r.status).toBe('none')
    // legacy 原样保留 + target 内容未被动
    expect(fs.existsSync(path.join(legacy, 'topology.db'))).toBe(true)
    expect(fs.readFileSync(path.join(target, 'topology.db'), 'utf8')).toBe('existing-db')
  })

  it('用例 4：仅 dev legacy「network-topology-manager」存在 → migrated（次优先级可用）', () => {
    const root = makeAppDataRoot()
    const legacy = path.join(root, 'network-topology-manager')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'topology.db'), 'db')
    const r = migrateLegacyUserData(root)
    expect(r.status).toBe('migrated')
    expect(r.from).toBe(legacy)
    expect(fs.existsSync(path.join(root, TARGET_DIR_NAME, 'topology.db'))).toBe(true)
    expect(fs.existsSync(legacy)).toBe(false)
  })

  it('用例 5：双 legacy 并存 → 优先迁移「网络拓扑管理工具」，dev 目录原样不动', () => {
    const root = makeAppDataRoot()
    const pkgLegacy = path.join(root, '网络拓扑管理工具')
    fs.mkdirSync(pkgLegacy, { recursive: true })
    fs.writeFileSync(path.join(pkgLegacy, 'topology.db'), 'pkg-db')
    const devLegacy = path.join(root, 'network-topology-manager')
    fs.mkdirSync(devLegacy, { recursive: true })
    fs.writeFileSync(path.join(devLegacy, 'topology.db'), 'dev-db')
    const r = migrateLegacyUserData(root)
    expect(r.status).toBe('migrated')
    expect(r.from).toBe(pkgLegacy)
    // 打包态真实用户数据优先落到 target；dev 目录原样不动
    expect(fs.readFileSync(path.join(root, TARGET_DIR_NAME, 'topology.db'), 'utf8')).toBe('pkg-db')
    expect(fs.existsSync(path.join(devLegacy, 'topology.db'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('用例 6：legacy 被占用 rename 失败 → fallback + from 指向该 legacy（数据可用性优先）', () => {
    const root = makeAppDataRoot()
    const legacy = path.join(root, '网络拓扑管理工具')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'topology.db'), 'db')
    // 模拟旧应用仍占用文件（Windows 下目录树内有打开句柄 → rename 失败）
    const fd = fs.openSync(path.join(legacy, 'topology.db'), 'r')
    try {
      const r = migrateLegacyUserData(root)
      expect(r.status).toBe('fallback')
      expect(r.from).toBe(legacy)
      // fallback 语义：legacy 目录与数据仍在原位
      expect(fs.existsSync(path.join(legacy, 'topology.db'))).toBe(true)
    } finally {
      fs.closeSync(fd)
    }
  })
})
