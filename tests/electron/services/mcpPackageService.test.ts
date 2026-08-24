import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8, strFromU8 } from 'fflate'

/**
 * Phase 29 Plan 29-03 —— mcpPackageService 包生命周期真路径测试。
 *
 * Mock 策略（mcpDeviceEnvMigration.test.ts 惯例）：
 *   - getDatabase → vi.hoisted 内存库（service 本体真跑，含 encField/decField 真加密）
 *   - mcpClient.testConnection → hoisted mock（testPackage 不真 spawn）
 *   - mcpProcessRegistry → hoisted mock（deletePackage 不真 taskkill）
 *
 * 断言面（Task 1 导入/覆盖族）：
 *   - 新导入落库 + 文件落盘（userData/mcp-packages/{name}/）
 *   - 同名同指纹幂等 exists；同名异指纹 changed + diff 且原包零改动（攻击性用例）
 *   - confirmOverwrite：指纹/manifest 更新 + 配置绑定保留 + env 键交集（D-24）
 *   - 出口投影永无 env 明文（包级仅 envKeys 名单）
 */

const h = vi.hoisted(() => {
  const clientMock = { testConnection: vi.fn() }
  const registryMock = { listActive: vi.fn(), killTree: vi.fn(), register: vi.fn(), unregister: vi.fn() }
  return { db: null as Database.Database | null, clientMock, registryMock }
})

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => h.db
}))

vi.mock('../../../electron/services/mcpClient', () => ({
  testConnection: h.clientMock.testConnection
}))

vi.mock('../../../electron/services/mcpProcessRegistry', () => ({
  McpProcessRegistry: h.registryMock
}))

import { McpPackageService } from '../../../electron/services/mcpPackageService'
import { encField, decField } from '../../../electron/utils/crypto'

const TEST_MK = 'test-mk-29-03'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('stdio','http')),
      command_or_url TEXT NOT NULL,
      args_json TEXT,
      env_json_enc TEXT,
      credential_enc TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_test_at TEXT,
      last_test_status TEXT,
      last_test_tool_count INTEGER,
      package_id INTEGER REFERENCES mcp_packages(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE mcp_device_rel (
      id TEXT PRIMARY KEY,
      mcp_config_id INTEGER NOT NULL,
      device_id TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      env_json_enc TEXT,
      FOREIGN KEY (mcp_config_id) REFERENCES mcp_configs(id) ON DELETE CASCADE
    );
    CREATE TABLE mcp_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      version TEXT,
      runtime TEXT NOT NULL CHECK(runtime IN ('node','python')),
      entry TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      dir_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      last_test TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

interface ZipOpts {
  name?: string
  version?: string
  entryContent?: string
  envKeys?: string[]
  tools?: string[]
  entryName?: string
}

function mkMcpb(opts: ZipOpts = {}): Buffer {
  const manifest = {
    name: opts.name ?? 'demo-pkg',
    version: opts.version ?? '1.0.0',
    runtime: 'node',
    entry: opts.entryName ?? 'main.js',
    models: ['S5735'],
    tools: (opts.tools ?? ['tool_a']).map((n) => ({ name: n, description: `${n} desc` })),
    ...(opts.envKeys ? { envKeys: opts.envKeys } : {}),
  }
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    [opts.entryName ?? 'main.js']: strToU8(opts.entryContent ?? 'console.log(1)'),
  }) as unknown as Buffer
}

let rootDir: string

function seedPackageConfig(db: Database.Database, packageId: number, envByDevice: Record<string, Record<string, string>>): void {
  const info = db.prepare(
    `INSERT INTO mcp_configs (name, type, command_or_url, package_id) VALUES (?, 'stdio', 'node', ?)`
  ).run(`cfg-${packageId}`, packageId)
  const ins = db.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id, env_json_enc) VALUES (?, ?, ?, ?)')
  let i = 0
  for (const [deviceId, env] of Object.entries(envByDevice)) {
    ins.run(`rel-${i++}`, info.lastInsertRowid as number, deviceId, encField(JSON.stringify(env), TEST_MK))
  }
}

function relEnv(db: Database.Database, deviceId: string): Record<string, string> | null {
  const row = db.prepare('SELECT env_json_enc FROM mcp_device_rel WHERE device_id = ?').get(deviceId) as { env_json_enc: string | null }
  if (!row?.env_json_enc) return null
  return JSON.parse(decField(row.env_json_enc, TEST_MK)!) as Record<string, string>
}

beforeEach(() => {
  h.db = makeDb()
  rootDir = mkdtempSync(join(tmpdir(), 'mcp-pkg-test-'))
  McpPackageService._setRootGetter(() => rootDir)
  McpPackageService.setMcpPackageMasterKey(TEST_MK)
  h.clientMock.testConnection.mockReset()
  h.registryMock.listActive.mockReset().mockReturnValue([])
  h.registryMock.killTree.mockReset().mockReturnValue(true)
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('Task 1: importPackage / confirmOverwrite / list / get', () => {
  it('新导入：落库 + 文件落盘 + 指纹', () => {
    const res = McpPackageService.importPackage(mkMcpb({ envKeys: ['TOKEN'] }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe('imported')
    const row = (h.db!.prepare('SELECT * FROM mcp_packages').all() as any[])[0]
    expect(row.name).toBe('demo-pkg')
    expect(row.runtime).toBe('node')
    expect(row.dir_path).toBe(join(rootDir, 'demo-pkg'))
    expect(existsSync(join(rootDir, 'demo-pkg', 'main.js'))).toBe(true)
    expect(existsSync(join(rootDir, 'demo-pkg', 'manifest.json'))).toBe(true)
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(row.fingerprint_json).treeSha256).toBe(row.fingerprint)
    expect(row.size_bytes).toBeGreaterThan(0)
  })

  it('同名同指纹：幂等 exists，不重复落库', () => {
    McpPackageService.importPackage(mkMcpb())
    const res = McpPackageService.importPackage(mkMcpb())
    expect(res.ok && res.status).toBe('exists')
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get()).toEqual({ c: 1 })
  })

  it('同名异指纹：changed + diff，原包零改动（取消路径）', () => {
    McpPackageService.importPackage(mkMcpb({ envKeys: ['A', 'B'], version: '1.0.0' }))
    const before = readFileSync(join(rootDir, 'demo-pkg', 'main.js'), 'utf-8')
    const beforeRow = (h.db!.prepare('SELECT * FROM mcp_packages').all() as any[])[0]

    const res = McpPackageService.importPackage(mkMcpb({ envKeys: ['B', 'C'], version: '2.0.0', entryContent: 'console.log(2)', tools: ['tool_a', 'tool_z'] }))
    expect(res.ok && res.status).toBe('changed')
    if (res.ok && res.status === 'changed') {
      expect(res.diff.env.removed).toEqual(['A'])
      expect(res.diff.env.added).toEqual(['C'])
      expect(res.diff.env.kept).toEqual(['B'])
      expect(res.diff.oldVersion).toBe('1.0.0')
      expect(res.diff.newVersion).toBe('2.0.0')
      expect(res.diff.toolsAdded).toEqual(['tool_z'])
      expect(res.diff.oldTreeSha256).not.toBe(res.diff.newTreeSha256)
    }
    // 攻击性断言：changed 未确认 → 原包文件/DB 零改动
    const afterRow = (h.db!.prepare('SELECT * FROM mcp_packages').all() as any[])[0]
    expect(afterRow).toEqual(beforeRow)
    expect(readFileSync(join(rootDir, 'demo-pkg', 'main.js'), 'utf-8')).toBe(before)
  })

  it('confirmOverwrite：指纹/manifest 更新 + 配置绑定保留 + env 键交集（D-24）', () => {
    const imp = McpPackageService.importPackage(mkMcpb({ envKeys: ['A', 'B'] }))
    const pkgId = (h.db!.prepare('SELECT id FROM mcp_packages').get() as any).id
    seedPackageConfig(h.db!, pkgId, { dev1: { A: 'a1', B: 'b1' }, dev2: { A: 'a2', B: 'b2' } })

    const res = McpPackageService.confirmOverwrite(pkgId, mkMcpb({ envKeys: ['A', 'C'], version: '2.0.0', entryContent: 'console.log(2)' }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe('overwritten')

    const row = (h.db!.prepare('SELECT * FROM mcp_packages WHERE id = ?').get(pkgId) as any)
    expect(row.version).toBe('2.0.0')
    expect(readFileSync(join(rootDir, 'demo-pkg', 'main.js'), 'utf-8')).toBe('console.log(2)')
    // 绑定关系原样保留（T-29-03-03：绑定零 DELETE）
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get()).toEqual({ c: 2 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 1 })
    // env 键交集：删除键 B 清掉、保留键 A 原值不动
    expect(relEnv(h.db!, 'dev1')).toEqual({ A: 'a1' })
    expect(relEnv(h.db!, 'dev2')).toEqual({ A: 'a2' })
  })

  it('confirmOverwrite：包名不同拒绝；同指纹幂等', () => {
    const pkgId = (McpPackageService.importPackage(mkMcpb({ name: 'pkg-x' })) as any).package?.id
      ?? (h.db!.prepare('SELECT id FROM mcp_packages').get() as any).id
    const bad = McpPackageService.confirmOverwrite(pkgId, mkMcpb({ name: 'pkg-y' }))
    expect(bad.ok).toBe(false)
    const same = McpPackageService.confirmOverwrite(pkgId, mkMcpb({ name: 'pkg-x' }))
    expect(same.ok && same.status).toBe('exists')
  })

  it('非法包（zip-slip）：ok:false + vectors', () => {
    const evil = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'evil', version: '1', runtime: 'node', entry: 'main.js', models: [], tools: [{ name: 't', description: 'd' }] })),
      '../evil.js': strToU8('x'),
      'main.js': strToU8('x'),
    }) as unknown as Buffer
    const res = McpPackageService.importPackage(evil)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.vectors?.some((v) => v.id === 'zip-slip' && !v.ok)).toBe(true)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get()).toEqual({ c: 0 })
  })

  it('listPackages/getPackage：出口投影仅 envKeys 名单，无 env 明文', () => {
    McpPackageService.importPackage(mkMcpb({ envKeys: ['TOKEN'] }))
    const list = McpPackageService.listPackages()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('demo-pkg')
    expect(list[0].envKeys).toEqual(['TOKEN'])
    expect(JSON.stringify(list)).not.toContain('TOKEN=')

    const one = McpPackageService.getPackage(list[0].id)
    expect(one?.manifest.name).toBe('demo-pkg')
    expect(one?.fingerprintFiles.length).toBeGreaterThan(0)
    expect(one?.lastTest).toBeNull()
  })
})
