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

describe('Task 1b: deletePackage / getPackageDeleteImpact / testPackage', () => {
  function importOne(opts: ZipOpts = {}): number {
    const res = McpPackageService.importPackage(mkMcpb(opts))
    if (!res.ok) throw new Error('import failed')
    return res.package.id
  }

  it('getPackageDeleteImpact：配置列表含绑定设备数 + 包目录路径（D-30 确认清单）', () => {
    const pkgId = importOne()
    seedPackageConfig(h.db!, pkgId, { dev1: { A: '1' }, dev2: { A: '2' } })
    const impact = McpPackageService.getPackageDeleteImpact(pkgId)
    expect(impact).not.toBeNull()
    expect(impact!.dirPath).toBe(join(rootDir, 'demo-pkg'))
    expect(impact!.configs).toHaveLength(1)
    expect(impact!.configs[0].deviceCount).toBe(2)
    expect(impact!.totalDevices).toBe(2)
  })

  it('deletePackage：先杀运行实例 → 三表级联清净 + 目录删除（D-30）', () => {
    const pkgId = importOne()
    seedPackageConfig(h.db!, pkgId, { dev1: { A: '1' } })
    // 该包一条配置对应的运行实例登记（configId 键形态）
    h.registryMock.listActive.mockReturnValue([
      { pid: 101, configId: '999', startedAt: 0 },
      { pid: 202, configId: String((h.db!.prepare('SELECT id FROM mcp_configs').get() as any).id), startedAt: 0 },
    ])
    const res = McpPackageService.deletePackage(pkgId)
    expect(res.ok).toBe(true)
    // 只杀该包配置对应的 pid=202，不误杀他配置 pid=101（T-29-03-05）
    expect(h.registryMock.killTree).toHaveBeenCalledTimes(1)
    expect(h.registryMock.killTree).toHaveBeenCalledWith(202)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get()).toEqual({ c: 0 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 0 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get()).toEqual({ c: 0 })
    expect(existsSync(join(rootDir, 'demo-pkg'))).toBe(false)
  })

  it('deletePackage：包不存在拒绝', () => {
    expect(McpPackageService.deletePackage(9999).ok).toBe(false)
  })

  it('testPackage：实测多出工具 → extraTools 默认禁用清单落 last_test（PKG-04/D-25）', async () => {
    const pkgId = importOne({ tools: ['tool_a'] })
    h.clientMock.testConnection.mockResolvedValue({
      ok: true,
      protocolVersion: '1.0',
      tools: [
        { name: 'tool_a', description: 'd', inputSchema: {} },
        { name: 'evil_extra', description: 'd', inputSchema: {} },
      ],
    })
    const res = await McpPackageService.testPackage(pkgId)
    expect(res.ok).toBe(true)
    expect(res.extraTools).toEqual(['evil_extra'])
    expect(res.missingTools).toEqual([])
    // last_test JSON 落库可读回
    const detail = McpPackageService.getPackage(pkgId)
    expect(detail?.lastTest?.ok).toBe(true)
    expect(detail?.lastTest?.extraTools).toEqual(['evil_extra'])
    expect(detail?.lastTest?.missingTools).toEqual([])
    expect(typeof detail?.lastTest?.testedAt).toBe('string')
    // spawn 契约：node 轨道 entry 绝对路径
    const call = h.clientMock.testConnection.mock.calls[0]
    expect(call[1]).toMatchObject({ type: 'stdio', commandOrUrl: 'node' })
    expect(call[1].args[0]).toBe(join(rootDir, 'demo-pkg', 'main.js'))
  })

  it('testPackage：实测少了工具仅提示 missingTools；失败写 reason', async () => {
    const pkgId = importOne({ tools: ['tool_a', 'tool_b'] })
    h.clientMock.testConnection.mockResolvedValue({
      ok: true, protocolVersion: '1.0',
      tools: [{ name: 'tool_a', description: 'd', inputSchema: {} }],
    })
    const res = await McpPackageService.testPackage(pkgId)
    expect(res.ok).toBe(true)
    expect(res.missingTools).toEqual(['tool_b'])
    expect(res.extraTools).toEqual([])

    h.clientMock.testConnection.mockResolvedValue({ ok: false, error: { code: 'MCP_TIMEOUT', reason: '超时' } })
    const fail = await McpPackageService.testPackage(pkgId)
    expect(fail.ok).toBe(false)
    const detail = McpPackageService.getPackage(pkgId)
    expect(detail?.lastTest?.ok).toBe(false)
    expect(detail?.lastTest?.reason).toContain('超时')
  })

  it('testPackage：python 轨道无内嵌 python.exe → 结构化失败落 last_test（29-04 预留分支）', async () => {
    const pyPkg = zipSync({
      'manifest.json': strToU8(JSON.stringify({
        name: 'py-pkg', version: '1.0.0', runtime: 'python', entry: 'main.py',
        models: ['NF'], tools: [{ name: 't1', description: 'd' }],
      })),
      'main.py': strToU8('print(1)'),
    }) as unknown as Buffer
    const res = McpPackageService.importPackage(pyPkg)
    expect(res.ok && res.status).toBe('imported')
    const out = await McpPackageService.testPackage((h.db!.prepare("SELECT id FROM mcp_packages WHERE name='py-pkg'").get() as any).id)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('嵌入式 Python')
    const detail = McpPackageService.getPackage((h.db!.prepare("SELECT id FROM mcp_packages WHERE name='py-pkg'").get() as any).id)
    expect(detail?.lastTest?.ok).toBe(false)
    expect(h.clientMock.testConnection).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Phase 29 Plan 29-06（PKG-05）：listMatchedDevices + createConfigsFromPackage
// ---------------------------------------------------------------------------
describe('Task 1 (29-06): listMatchedDevices / createConfigsFromPackage', () => {
  /** 设备种子：name/model 与生产同形（密文列，TEST_MK 加密） */
  function seedDevice(db: Database.Database, id: string, name: string, model: string | null): void {
    db.prepare(
      'INSERT INTO devices (id, name_enc, model_enc) VALUES (?, ?, ?)'
    ).run(id, encField(name, TEST_MK), model != null ? encField(model, TEST_MK) : null)
  }

  function importPkgWithModels(models: string[], envKeys: string[]): number {
    const manifest = {
      name: 'nf-pkg', version: '1.0.0', runtime: 'node', entry: 'main.js',
      models, tools: [{ name: 't1', description: 'd' }], envKeys,
    }
    const buf = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'main.js': strToU8('console.log(1)'),
    }) as unknown as Buffer
    const res = McpPackageService.importPackage(buf)
    if (!res.ok) throw new Error('import failed')
    return res.package.id
  }

  beforeEach(() => {
    h.db!.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name_enc TEXT NOT NULL,
        model_enc TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
  })

  it('listMatchedDevices：型号包含匹配（忽略大小写/首尾空格）+ 冲突标注（D-07/D-21）', () => {
    const pkgId = importPkgWithModels(['S5735', 'CE6857'], ['NF_TOKEN', 'NF_PORT'])
    seedDevice(h.db!, 'd1', 'SW-1F', 'Huawei S5735-LI')
    seedDevice(h.db!, 'd2', 'Core-A', ' ce6857ei ')
    seedDevice(h.db!, 'd3', 'SRV-X', 'Lenovo ThinkServer')
    // d1 已被其它（非本包）配置绑定 → 冲突标注
    const other = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('other', 'stdio', 'node')"
    ).run()
    h.db!.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id) VALUES (?, ?, ?)')
      .run('rel-x', other.lastInsertRowid as number, 'd1')

    const list = McpPackageService.listMatchedDevices(pkgId)
    expect(list).toHaveLength(3)
    const d1 = list.find((d) => d.deviceId === 'd1')!
    const d2 = list.find((d) => d.deviceId === 'd2')!
    const d3 = list.find((d) => d.deviceId === 'd3')!
    expect(d1.name).toBe('SW-1F')
    expect(d1.model).toBe('Huawei S5735-LI')
    expect(d1.matchedModel).toBe('S5735')
    expect(d1.boundConfigName).toBe('other')
    expect(d2.matchedModel).toBe('CE6857') // 首尾空格 + 小写变体命中
    expect(d2.boundConfigName).toBeNull()
    expect(d3.matchedModel).toBeNull()
    // 包不存在拒绝
    expect(McpPackageService.listMatchedDevices(9999)).toBeNull()
  })

  it('createConfigsFromPackage：10 设备批量生成 10 config + 10 rel 各自独立 env 密文（D-20/D-21）', () => {
    const pkgId = importPkgWithModels(['S5735'], ['NF_TOKEN', 'NF_PORT'])
    const deviceEnvs: Array<{ deviceId: string; env: Record<string, string> }> = []
    for (let i = 0; i < 10; i++) {
      const id = `fw-${i}`
      seedDevice(h.db!, id, `FW-${i}`, `S5735-${i}`)
      deviceEnvs.push({ deviceId: id, env: { NF_TOKEN: `tok-${i}`, NF_PORT: String(8000 + i) } })
    }
    const res = McpPackageService.createConfigsFromPackage(pkgId, deviceEnvs)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.created).toBe(10)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs WHERE package_id = ?').get(pkgId)).toEqual({ c: 10 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get()).toEqual({ c: 10 })
    // 各自独立密文：逐台解密互不串线
    for (let i = 0; i < 10; i++) {
      const env = relEnv(h.db!, `fw-${i}`)!
      expect(env).toEqual({ NF_TOKEN: `tok-${i}`, NF_PORT: String(8000 + i) })
    }
    const c0 = h.db!.prepare('SELECT * FROM mcp_configs WHERE package_id = ? ORDER BY id').all(pkgId)[0] as any
    expect(c0.name).toBe('nf-pkg-FW-0')
    expect(c0.type).toBe('stdio')
    expect(c0.source).toBe('package')
  })

  it('createConfigsFromPackage：任一设备已绑其它配置 → 整体拒绝零部分写入（D-19/T-29-06-01）', () => {
    const pkgId = importPkgWithModels(['S5735'], ['NF_TOKEN'])
    seedDevice(h.db!, 'a1', 'A1', 'S5735')
    seedDevice(h.db!, 'a2', 'A2', 'S5735')
    const other = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('existing', 'stdio', 'node')"
    ).run()
    h.db!.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id) VALUES (?, ?, ?)')
      .run('rel-y', other.lastInsertRowid as number, 'a2')

    const res = McpPackageService.createConfigsFromPackage(pkgId, [
      { deviceId: 'a1', env: { NF_TOKEN: 't1' } },
      { deviceId: 'a2', env: { NF_TOKEN: 't2' } },
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('A2')
    // 零部分写入：不新增任何 config / rel / env 密文
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 1 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get()).toEqual({ c: 1 })
    expect(relEnv(h.db!, 'a1')).toBeNull()
  })

  it('createConfigsFromPackage：入参守卫（未知 env 键 / 未知设备 / 包不存在）', () => {
    const pkgId = importPkgWithModels(['S5735'], ['NF_TOKEN'])
    seedDevice(h.db!, 'b1', 'B1', 'S5735')
    expect(McpPackageService.createConfigsFromPackage(pkgId, [
      { deviceId: 'b1', env: { EVIL_KEY: 'x' } },
    ]).ok).toBe(false)
    expect(McpPackageService.createConfigsFromPackage(pkgId, [
      { deviceId: 'ghost', env: { NF_TOKEN: 'x' } },
    ]).ok).toBe(false)
    expect(McpPackageService.createConfigsFromPackage(9999, []).ok).toBe(false)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 0 })
  })
})
