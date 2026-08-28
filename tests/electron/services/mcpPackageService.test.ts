import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  const clientMock = {
    testConnection: vi.fn(),
    verifyPackageFingerprint: vi.fn(), // 默认 no-op（通过）；WR-01 用例 mock 抛 package_integrity_failed
    reportPackageIntegrityFailure: vi.fn(),
    resolvePackageSpawn: vi.fn(),
  }
  const registryMock = { listActive: vi.fn(), killTree: vi.fn(), register: vi.fn(), unregister: vi.fn() }
  return { db: null as Database.Database | null, clientMock, registryMock }
})

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => h.db
}))

// 29.1 CR HI-01：service 另消费 applyEnvMeta 纯函数——用真实现（mcpClient.test.ts 已单测，
// 此处只验接线语义，不再造第二份逻辑），仅替换四个副作用函数；其余导出经 importOriginal 原样透传
vi.mock('../../../electron/services/mcpClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/services/mcpClient')>()
  return {
    ...actual,
    testConnection: h.clientMock.testConnection,
    verifyPackageFingerprint: h.clientMock.verifyPackageFingerprint,
    reportPackageIntegrityFailure: h.clientMock.reportPackageIntegrityFailure,
    resolvePackageSpawn: h.clientMock.resolvePackageSpawn,
  }
})

vi.mock('../../../electron/services/mcpProcessRegistry', () => ({
  McpProcessRegistry: h.registryMock
}))

import { McpPackageService } from '../../../electron/services/mcpPackageService'
import { McpPackageSwapGuard } from '../../../electron/services/mcpPackageSwapGuard'
import { encField, decField } from '../../../electron/utils/crypto'

const TEST_MK = 'test-mk-29-03'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('stdio','http','package')),
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
      env_meta TEXT,
      fingerprint TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      dir_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      last_test TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE mcp_tools (
      config_id INTEGER,
      package_id INTEGER,
      tool_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      skip_confirm INTEGER NOT NULL DEFAULT 0,
      tool_meta TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(config_id, tool_name),
      UNIQUE(package_id, tool_name)
    );
  `)
  return db
}

interface ZipOpts {
  name?: string
  version?: string
  entryContent?: string
  envKeys?: string[]
  envMeta?: Record<string, { label: string; description?: string; required?: boolean; example?: string; default?: string }>
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
    ...(opts.envMeta ? { envMeta: opts.envMeta } : {}),
  }
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    [opts.entryName ?? 'main.js']: strToU8(opts.entryContent ?? 'console.log(1)'),
  }) as unknown as Buffer
}

let rootDir: string

function seedPackageConfig(db: Database.Database, packageId: number, envByDevice: Record<string, Record<string, string>>): void {
  const info = db.prepare(
    `INSERT INTO mcp_configs (name, type, command_or_url, package_id, source) VALUES (?, 'package', 'main.js', ?, 'package')`
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
  h.clientMock.verifyPackageFingerprint.mockReset() // 默认 no-op = 指纹通过
  h.clientMock.reportPackageIntegrityFailure.mockReset()
  // 默认 node 轨 spawn 计划（29-04 resolvePackageSpawn 真实形态镜像）
  h.clientMock.resolvePackageSpawn.mockReset().mockImplementation((pkg: { dirPath: string; entry: string }) => ({
    command: 'node', args: [join(pkg.dirPath, pkg.entry)], envMode: 'plain', fallback: null,
  }))
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

  // WR-02（Phase 29 code-review）：换盘前先杀该包全部运行实例（Windows 持句柄 rmSync EBUSY
  // → DB 新指纹/磁盘旧内容不一致 → TOCTOU 自动禁用）——只杀本包 configId，不误杀他包
  it('WR-02：confirmOverwrite 换盘前树杀该包运行实例（不误杀他配置/他包）', () => {
    const imp = McpPackageService.importPackage(mkMcpb())
    const pkgId = (imp as any).package.id
    seedPackageConfig(h.db!, pkgId, { dev1: { A: 'a1' } })
    const cfgId = Number((h.db!.prepare('SELECT id FROM mcp_configs WHERE package_id = ?').get(pkgId) as any).id)
    const otherCfg = Number((h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('other', 'stdio', 'node')"
    ).run().lastInsertRowid))
    h.registryMock.listActive.mockReturnValue([
      { pid: 601, configId: `${cfgId}:dev1`, startedAt: 0 },
      { pid: 602, configId: `${otherCfg}:dev1`, startedAt: 0 },
      { pid: 603, configId: '999:dev1', startedAt: 0 },
    ])
    const res = McpPackageService.confirmOverwrite(pkgId, mkMcpb({ version: '2.0.0', entryContent: 'console.log(2)' }))
    expect(res.ok).toBe(true)
    expect(h.registryMock.killTree).toHaveBeenCalledTimes(1)
    expect(h.registryMock.killTree).toHaveBeenCalledWith(601) // 只杀本包实例
    expect(readFileSync(join(rootDir, 'demo-pkg', 'main.js'), 'utf-8')).toBe('console.log(2)')
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

  it('29.1 D-04：带 envMeta 导入 → env_meta 列落库 + 投影 envMeta；缺省导入 → env_meta NULL + 投影 {}', () => {
    const res = McpPackageService.importPackage(mkMcpb({
      envKeys: ['NF_HOST', 'NF_PORT'],
      envMeta: {
        NF_HOST: { label: '防火墙地址', required: true },
        NF_PORT: { label: '端口', default: '443' },
      },
    }))
    expect(res.ok).toBe(true)
    const row = h.db!.prepare('SELECT env_meta FROM mcp_packages WHERE id = ?').get(res.ok ? res.package.id : 0) as { env_meta: string | null }
    expect(row.env_meta).toBeTruthy()
    expect(JSON.parse(row.env_meta!)).toEqual({
      NF_HOST: { label: '防火墙地址', required: true },
      NF_PORT: { label: '端口', default: '443' },
    })
    const view = McpPackageService.listPackages()[0]
    expect(view.envMeta.NF_HOST).toEqual({ label: '防火墙地址', required: true })
    expect(view.envMeta.NF_PORT).toEqual({ label: '端口', default: '443' })

    // 缺省 envMeta 旧包：env_meta NULL、投影 {}（向后兼容）
    McpPackageService.importPackage(mkMcpb({ name: 'old-pkg', envKeys: ['TOKEN'] }))
    const old = h.db!.prepare('SELECT env_meta FROM mcp_packages WHERE name = ?').get('old-pkg') as { env_meta: string | null }
    expect(old.env_meta).toBeNull()
    const oldView = McpPackageService.listPackages().find((p) => p.name === 'old-pkg')!
    expect(oldView.envMeta).toEqual({})
  })

  it('29.1 D-24 延伸：confirmOverwrite → envMeta 随 manifest 自动跟随（无合并逻辑）', () => {
    const imp = McpPackageService.importPackage(mkMcpb({
      envKeys: ['A', 'B'],
      envMeta: { A: { label: '旧标签' }, B: { label: 'B 标签' } },
    }))
    expect(imp.ok).toBe(true)
    if (!imp.ok) return
    const res = McpPackageService.confirmOverwrite(imp.package.id, mkMcpb({
      envKeys: ['A', 'B'], version: '2.0.0', entryContent: 'console.log(2)',
      envMeta: { A: { label: '新标签', description: '改了' } },
    }))
    expect(res.ok).toBe(true)
    const row = h.db!.prepare('SELECT env_meta FROM mcp_packages WHERE id = ?').get(imp.package.id) as { env_meta: string | null }
    expect(JSON.parse(row.env_meta!)).toEqual({ A: { label: '新标签', description: '改了' } })
    const view = McpPackageService.listPackages().find((p) => p.id === imp.package.id)!
    expect(view.envMeta).toEqual({ A: { label: '新标签', description: '改了' } })
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

  it('deletePackage：先杀运行实例 → 四表级联清净 + 目录删除（D-30/D-06）', () => {
    const pkgId = importOne()
    seedPackageConfig(h.db!, pkgId, { dev1: { A: '1' } })
    // v29 D-05/D-06：包级策略行随删包级联清理（T-29.1-09）
    h.db!.prepare('INSERT INTO mcp_tools (package_id, tool_name) VALUES (?, ?)').run(pkgId, 'tool_a')
    h.db!.prepare('INSERT INTO mcp_tools (config_id, tool_name) VALUES (?, ?)').run(9999, 'other_cfg_tool')
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
    // 该包策略行清零；他配置行不受影响（T-29.1-08 精确 package_id）
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_tools WHERE package_id = ?').get(pkgId)).toEqual({ c: 0 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_tools').get()).toEqual({ c: 1 })
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
// Phase 29 Plan 29-06（PKG-05）：listMatchedDevices
// ---------------------------------------------------------------------------
describe('Task 1 (29-06): listMatchedDevices', () => {
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

})

// ---------------------------------------------------------------------------
// Phase 29 Plan 29-07（Gap-2/Gap-5）：createConfigFromPackage 单条配置语义
// ---------------------------------------------------------------------------
describe('Task 1 (29-07): createConfigFromPackage 单条配置 + N 设备独立 env', () => {
  function importOne(opts: ZipOpts = {}): number {
    const res = McpPackageService.importPackage(mkMcpb(opts))
    if (!res.ok) throw new Error('import failed')
    return res.package.id
  }

  function seedDevice2(db: Database.Database, id: string, name: string): void {
    db.prepare('INSERT INTO devices (id, name_enc) VALUES (?, ?)').run(id, encField(name, TEST_MK))
  }

  function importPkg(envKeys: string[]): number {
    const manifest = {
      name: 's-pkg', version: '1.0.0', runtime: 'node', entry: 'main.js',
      models: ['S5735'], tools: [{ name: 't1', description: 'd' }], envKeys,
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

  it('成功：1 条 mcp_configs + N 行 rel 各自独立 env，返回 configId（Gap-2）', () => {
    const pkgId = importPkg(['NF_TOKEN'])
    seedDevice2(h.db!, 'x1', 'X1')
    seedDevice2(h.db!, 'x2', 'X2')
    seedDevice2(h.db!, 'x3', 'X3')
    const res = McpPackageService.createConfigFromPackage(pkgId, 'my-cfg', [
      { deviceId: 'x1', env: { NF_TOKEN: 't1' } },
      { deviceId: 'x2', env: { NF_TOKEN: 't2' } },
      { deviceId: 'x3', env: {} },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(typeof res.configId).toBe('number')
    // configs 恰好 +1（非 +N）
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 1 })
    const cfg = h.db!.prepare('SELECT * FROM mcp_configs').get() as any
    expect(cfg.id).toBe(res.configId)
    expect(cfg.name).toBe('my-cfg')
    expect(cfg.type).toBe('package') // 29-09 走查二：type 真实化
    expect(cfg.source).toBe('package')
    expect(cfg.package_id).toBe(pkgId)
    expect(cfg.command_or_url).toBe('main.js') // 29-09 Fix-4：存 manifest.entry（读取处不依赖）
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get()).toEqual({ c: 3 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel WHERE mcp_config_id = ?').get(res.configId)).toEqual({ c: 3 })
    expect(relEnv(h.db!, 'x1')).toEqual({ NF_TOKEN: 't1' })
    expect(relEnv(h.db!, 'x2')).toEqual({ NF_TOKEN: 't2' })
    expect(relEnv(h.db!, 'x3')).toBeNull() // 空 env → NULL
  })

  it('冲突：任一 deviceId 已绑其它配置 → 整体拒绝零部分写入（事务回滚，D-19）', () => {
    const pkgId = importPkg(['NF_TOKEN'])
    seedDevice2(h.db!, 'y1', 'Y1')
    seedDevice2(h.db!, 'y2', 'Y2')
    const other = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url) VALUES ('taken', 'stdio', 'node')"
    ).run()
    h.db!.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id) VALUES (?, ?, ?)')
      .run('rel-z', other.lastInsertRowid as number, 'y2')

    const res = McpPackageService.createConfigFromPackage(pkgId, 'cfg-y', [
      { deviceId: 'y1', env: { NF_TOKEN: 'a' } },
      { deviceId: 'y2', env: { NF_TOKEN: 'b' } },
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('Y2')
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 1 }) // 仅既有 other
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get()).toEqual({ c: 1 })
    expect(relEnv(h.db!, 'y1')).toBeNull()
  })

  it('Gap-5：env 键超出 manifest.envKeys（自定义键 MY_EXTRA_TOKEN）→ 创建成功且落库', () => {
    const pkgId = importPkg(['NF_TOKEN'])
    seedDevice2(h.db!, 'g1', 'G1')
    const res = McpPackageService.createConfigFromPackage(pkgId, 'cfg-gap5', [
      { deviceId: 'g1', env: { MY_EXTRA_TOKEN: 'extra-val' } },
    ])
    expect(res.ok).toBe(true)
    expect(relEnv(h.db!, 'g1')).toEqual({ MY_EXTRA_TOKEN: 'extra-val' })
  })

  it('v29 D-05：创建配置即预填包级工具缓存（package_id 直写，AI 开箱可用）', () => {
    const pkgId = importOne({ tools: ['tool_a', 'tool_b'] })
    // 空 deviceEnvs 守卫先行拒绝——预填不发生
    expect(McpPackageService.createConfigFromPackage(pkgId, 'cfg-x', []).ok).toBe(false)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_tools').get()).toEqual({ c: 0 })
    // 手工直插设备后走成功路径
    h.db!.prepare("INSERT INTO devices (id, name_enc) VALUES ('dev-x', '')").run()
    const ok = McpPackageService.createConfigFromPackage(pkgId, 'cfg-x', [{ deviceId: 'dev-x', env: {} }])
    expect(ok.ok).toBe(true)
    const rows = h.db!.prepare('SELECT tool_name, package_id, config_id FROM mcp_tools ORDER BY tool_name').all() as any[]
    expect(rows).toEqual([
      { tool_name: 'tool_a', package_id: pkgId, config_id: null },
      { tool_name: 'tool_b', package_id: pkgId, config_id: null },
    ])
  })

  it('包 disabled 拒绝；deviceEnvs 重复 deviceId 拒绝；空 deviceEnvs 拒绝', () => {
    const pkgId = importPkg(['NF_TOKEN'])
    seedDevice2(h.db!, 'w1', 'W1')
    seedDevice2(h.db!, 'w2', 'W2')
    h.db!.prepare('UPDATE mcp_packages SET disabled = 1 WHERE id = ?').run(pkgId)
    expect(McpPackageService.createConfigFromPackage(pkgId, 'n', [
      { deviceId: 'w1', env: {} },
    ]).ok).toBe(false)
    h.db!.prepare('UPDATE mcp_packages SET disabled = 0 WHERE id = ?').run(pkgId)
    expect(McpPackageService.createConfigFromPackage(pkgId, 'n', [
      { deviceId: 'w1', env: {} }, { deviceId: 'w1', env: {} },
    ]).ok).toBe(false)
    expect(McpPackageService.createConfigFromPackage(pkgId, 'n', []).ok).toBe(false)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 0 })
  })

  it('名称守卫：空/超长拒绝；未知设备拒绝；env 键格式/值长/对数上限拒绝', () => {
    const pkgId = importPkg(['NF_TOKEN'])
    seedDevice2(h.db!, 'v1', 'V1')
    const MAX_NAME = 100
    expect(McpPackageService.createConfigFromPackage(pkgId, '   ', [{ deviceId: 'v1', env: {} }]).ok).toBe(false)
    expect(McpPackageService.createConfigFromPackage(pkgId, 'x'.repeat(MAX_NAME + 1), [{ deviceId: 'v1', env: {} }]).ok).toBe(false)
    expect(McpPackageService.createConfigFromPackage(pkgId, 'n', [{ deviceId: 'ghost', env: {} }]).ok).toBe(false)
    expect(McpPackageService.createConfigFromPackage(pkgId, 'n', [{ deviceId: 'v1', env: { '9bad-key': 'x' } }]).ok).toBe(false)
    expect(McpPackageService.createConfigFromPackage(pkgId, 'n', [{ deviceId: 'v1', env: { K: 'x'.repeat(2001) } }]).ok).toBe(false)
    const bigEnv: Record<string, string> = {}
    for (let i = 0; i < 51; i++) bigEnv[`K${i}`] = 'v'
    expect(McpPackageService.createConfigFromPackage(pkgId, 'n', [{ deviceId: 'v1', env: bigEnv }]).ok).toBe(false)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 0 })
  })
})

// ---------------------------------------------------------------------------
// Phase 29 code-review 回归：CR-01 包名路径逃逸 / WR-01 testPackage 守卫 / WR-04 一致性
// ---------------------------------------------------------------------------
describe('Code-review fix: CR-01 / WR-01 / WR-02 / WR-04', () => {
  function importOne(opts: ZipOpts = {}): number {
    const res = McpPackageService.importPackage(mkMcpb(opts))
    if (!res.ok) throw new Error('import failed')
    return res.package.id
  }

  it('CR-01 攻击回归：name=".." 导入被拒且零副作用（包根/userData 不被 rmSync）', () => {
    // 包根同级放哨兵文件——若 dir 解析到包根上级并 rmSync，哨兵会被连带删除
    const sentinel = join(rootDir, '..', 'sentinel-cr01-a.txt')
    writeFileSync(sentinel, 'keep')
    const res = McpPackageService.importPackage(mkMcpb({ name: '..' }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('manifest.name')
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get()).toEqual({ c: 0 })
    expect(existsSync(sentinel)).toBe(true) // 零副作用：上级目录未被触碰
    expect(existsSync(rootDir)).toBe(true)
    rmSync(sentinel, { force: true })
  })

  it('CR-01 攻击回归：name 含路径分隔符（a/../../b）与反斜杠形态导入被拒', () => {
    for (const evil of ['a/../../b', 'a\\..\\b', '/abs/path', 'C:\\evil', '.hidden', '.']) {
      const res = McpPackageService.importPackage(mkMcpb({ name: evil }))
      expect(res.ok).toBe(false)
    }
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get()).toEqual({ c: 0 })
    // 包根下零新增目录
    expect(readdirSync(rootDir)).toEqual([])
  })

  it('CR-01 纵深防御：deletePackage 遇 dir_path 逃逸包根的 DB 行 → 整体拒绝不 rmSync', () => {
    const pkgId = importOne()
    const sentinel = join(rootDir, '..', 'sentinel-cr01-b.txt')
    writeFileSync(sentinel, 'keep')
    h.db!.prepare('UPDATE mcp_packages SET dir_path = ? WHERE id = ?').run(resolve(rootDir, '..'), pkgId)
    const res = McpPackageService.deletePackage(pkgId)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('不安全')
    expect(existsSync(sentinel)).toBe(true) // 逃逸目标未被删除
    rmSync(sentinel, { force: true })
  })

  it('WR-01：disabled 包 testPackage 直接拒绝（不 spawn）', async () => {
    const pkgId = importOne()
    h.db!.prepare('UPDATE mcp_packages SET disabled = 1 WHERE id = ?').run(pkgId)
    const res = await McpPackageService.testPackage(pkgId)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('已被禁用')
    expect(h.clientMock.testConnection).not.toHaveBeenCalled()
  })

  it('WR-01：TOCTOU 指纹重验失败 → 不 spawn + disabled=1 + last_test 落败因', async () => {
    const pkgId = importOne()
    h.clientMock.verifyPackageFingerprint.mockImplementation(() => {
      throw { code: 'package_integrity_failed', reason: '包指纹重验失败（TOCTOU 检出）：内容变化 main.js' }
    })
    const res = await McpPackageService.testPackage(pkgId)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('TOCTOU')
    expect(h.clientMock.testConnection).not.toHaveBeenCalled()
    const row = h.db!.prepare('SELECT disabled, last_test FROM mcp_packages WHERE id = ?').get(pkgId) as any
    expect(row.disabled).toBe(1)
    expect(JSON.parse(row.last_test).ok).toBe(false)
    expect(h.clientMock.reportPackageIntegrityFailure).toHaveBeenCalledTimes(1)
  })

  it('WR-02（v29 D-05 改直写）：testPackage 实测成功 → 工具缓存直写 package_id（不依赖配置存在）', async () => {
    const pkgId = importOne({ tools: ['tool_a'] })
    // 不建任何包配置——直写路径不再依赖 MIN(id) 根配置存在
    h.clientMock.testConnection.mockResolvedValue({
      ok: true, protocolVersion: '1.0',
      tools: [{ name: 'tool_a', description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } }],
    })
    const res = await McpPackageService.testPackage(pkgId)
    expect(res.ok).toBe(true)
    const rows = h.db!.prepare('SELECT tool_name, config_id, package_id FROM mcp_tools').all() as any[]
    expect(rows).toEqual([{ tool_name: 'tool_a', config_id: null, package_id: pkgId }])
  })

  it('WR-04：importPackage INSERT 失败 → 抛错且补偿删除孤儿目录（磁盘/DB 一致）', () => {
    // DROP 掉 fingerprint_json 列令 INSERT 报错（列不存在），模拟 DB 落库失败路径
    h.db!.exec('ALTER TABLE mcp_packages DROP COLUMN fingerprint_json')
    expect(() => McpPackageService.importPackage(mkMcpb())).toThrow()
    expect(existsSync(join(rootDir, 'demo-pkg'))).toBe(false) // 孤儿目录被补偿删除
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get()).toEqual({ c: 0 })
  })
})

// ---------------------------------------------------------------------------
// 29-09 走查二：包配置行级「测试」包轨路由（缺陷1+3 修复）
// ---------------------------------------------------------------------------
describe('29-09 走查二: testPackageConfig 包轨路由', () => {
  function importNodePkg(entry = 'main.js'): number {
    const manifest = {
      name: 'route-pkg', version: '1.0.0', runtime: 'node', entry,
      models: ['S5735'], tools: [{ name: 't1', description: 'd' }], envKeys: ['TOKEN'],
    }
    const buf = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      [entry]: strToU8('console.log(1)'),
    }) as unknown as Buffer
    const res = McpPackageService.importPackage(buf)
    if (!res.ok) throw new Error('import failed')
    return res.package.id
  }

  function seedPkgConfig(packageId: number, envByDevice: Record<string, Record<string, string>>): number {
    const info = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, package_id, source) VALUES ('route-cfg', 'package', 'main.js', ?, 'package')"
    ).run(packageId)
    const ins = h.db!.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id, env_json_enc) VALUES (?, ?, ?, ?)')
    let i = 0
    for (const [deviceId, env] of Object.entries(envByDevice)) {
      ins.run(`r-${i++}`, info.lastInsertRowid as number, deviceId, encField(JSON.stringify(env), TEST_MK))
    }
    return Number(info.lastInsertRowid)
  }

  it('包配置测试：指纹重验 → 包轨 spawn 计划 → 首台绑定设备 env 合并注入（不 spawn 包名）', async () => {
    const pkgId = importNodePkg()
    const cfgId = seedPkgConfig(pkgId, { dev1: { TOKEN: 'tok-1' }, dev2: { TOKEN: 'tok-2' } })
    h.clientMock.testConnection.mockResolvedValue({
      ok: true, protocolVersion: '1.0', tools: [{ name: 't1', description: 'd', inputSchema: {} }],
    })

    const res = await McpPackageService.testPackageConfig(cfgId, { testId: 'route-test-1' })
    expect(res.ok).toBe(true)
    expect(h.clientMock.verifyPackageFingerprint).toHaveBeenCalledTimes(1)
    expect(h.clientMock.resolvePackageSpawn).toHaveBeenCalledTimes(1)
    // 契约：stdio 通道 + node entry 绝对路径 + 首台绑定设备（rel MIN）env——绝不把包名当命令
    const call = h.clientMock.testConnection.mock.calls[0]
    expect(call[0]).toBe('route-test-1')
    expect(call[1]).toMatchObject({
      type: 'stdio',
      commandOrUrl: 'node',
      env: { TOKEN: 'tok-1' },
      credential: null,
    })
    expect(call[1].args[0]).toBe(join(rootDir, 'route-pkg', 'main.js'))
  })

  it('无绑定设备空 env 也可测（只验包能起+握手+tools/list）', async () => {
    const pkgId = importNodePkg()
    const cfgId = seedPkgConfig(pkgId, {})
    h.clientMock.testConnection.mockResolvedValue({
      ok: true, protocolVersion: '1.0', tools: [],
    })
    const res = await McpPackageService.testPackageConfig(cfgId)
    expect(res.ok).toBe(true)
    expect(h.clientMock.testConnection.mock.calls[0][1].env).toEqual({})
  })

  it('非包配置 / 配置不存在 / disabled 包 / TOCTOU 检出 → 结构化失败不 spawn', async () => {
    const manual = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, source) VALUES ('m', 'stdio', 'node', 'manual')"
    ).run()
    const r1 = await McpPackageService.testPackageConfig(Number(manual.lastInsertRowid))
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error.reason).toContain('不是 MCP 包配置')
    expect(await McpPackageService.testPackageConfig(99999)).toMatchObject({ ok: false })

    const pkgId = importNodePkg()
    const cfgId = seedPkgConfig(pkgId, {})
    h.db!.prepare('UPDATE mcp_packages SET disabled = 1 WHERE id = ?').run(pkgId)
    const r2 = await McpPackageService.testPackageConfig(cfgId)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.reason).toContain('已被禁用')
    h.db!.prepare('UPDATE mcp_packages SET disabled = 0 WHERE id = ?').run(pkgId)

    h.clientMock.verifyPackageFingerprint.mockImplementation(() => {
      throw { code: 'package_integrity_failed', reason: '包指纹重验失败（TOCTOU 检出）：内容变化 main.js' }
    })
    const r3 = await McpPackageService.testPackageConfig(cfgId)
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.error.code).toBe('package_integrity_failed')
    expect(h.clientMock.testConnection).not.toHaveBeenCalled()
    expect(h.db!.prepare('SELECT disabled AS d FROM mcp_packages WHERE id = ?').get(pkgId)).toEqual({ d: 1 })
    expect(h.clientMock.reportPackageIntegrityFailure).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 29.1 CR HI-01：行级测试通道接入 applyEnvMeta（required 硬拦 + default 叠加，对齐主链）
// ---------------------------------------------------------------------------
describe('29.1 CR HI-01: testPackageConfig spawn env 过 applyEnvMeta（与主链 getConnection 同语义）', () => {
  function importPkgWithEnvMeta(
    envMeta: Record<string, { label: string; required?: boolean; default?: string }>
  ): number {
    const res = McpPackageService.importPackage(mkMcpb({
      name: 'hi01-pkg',
      envKeys: Object.keys(envMeta),
      envMeta,
    }))
    if (!res.ok) throw new Error('import failed')
    return res.package.id
  }

  function seedCfg(packageId: number, envByDevice: Record<string, Record<string, string>>): number {
    const info = h.db!.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, package_id, source) VALUES ('hi01-cfg', 'package', 'main.js', ?, 'package')"
    ).run(packageId)
    const ins = h.db!.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id, env_json_enc) VALUES (?, ?, ?, ?)')
    let i = 0
    for (const [deviceId, env] of Object.entries(envByDevice)) {
      ins.run(`hr-${i++}`, info.lastInsertRowid as number, deviceId, encField(JSON.stringify(env), TEST_MK))
    }
    return Number(info.lastInsertRowid)
  }

  it('required 缺值 → MCP_ENV_REQUIRED_MISSING 结构化失败不 spawn，reason 含 label 人话（D-01 运行时层闭合）', async () => {
    const pkgId = importPkgWithEnvMeta({ NF_TOKEN: { label: '防火墙 API Token', required: true } })
    const cfgId = seedCfg(pkgId, { dev1: {} }) // 绑定设备 env 缺 required 键
    const res = await McpPackageService.testPackageConfig(cfgId)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('MCP_ENV_REQUIRED_MISSING')
      expect(res.error.reason).toContain('防火墙 API Token')
    }
    expect(h.clientMock.testConnection).not.toHaveBeenCalled()
  })

  it('required 留空但有 default → default 叠加后拉起（行级测试与主链真跑结论一致，消除通道矛盾）', async () => {
    const pkgId = importPkgWithEnvMeta({
      NF_TOKEN: { label: 'Token', required: true, default: 'tok-default' },
      NF_PORT: { label: '端口', default: '443' },
    })
    const cfgId = seedCfg(pkgId, { dev1: { NF_TOKEN: '' } }) // 用户留空 → 叠 default
    h.clientMock.testConnection.mockResolvedValue({
      ok: true, protocolVersion: '1.0', tools: [],
    })
    const res = await McpPackageService.testPackageConfig(cfgId)
    expect(res.ok).toBe(true)
    expect(h.clientMock.testConnection.mock.calls[0][1].env).toEqual({ NF_TOKEN: 'tok-default', NF_PORT: '443' })
  })

  it('用户已填值优先于 default（叠加不覆盖用户值）', async () => {
    const pkgId = importPkgWithEnvMeta({
      NF_TOKEN: { label: 'Token', required: true, default: 'tok-default' },
      NF_PORT: { label: '端口', default: '443' },
    })
    const cfgId = seedCfg(pkgId, { dev1: { NF_TOKEN: 'user-tok', NF_PORT: '8443' } })
    h.clientMock.testConnection.mockResolvedValue({
      ok: true, protocolVersion: '1.0', tools: [],
    })
    const res = await McpPackageService.testPackageConfig(cfgId)
    expect(res.ok).toBe(true)
    expect(h.clientMock.testConnection.mock.calls[0][1].env).toEqual({ NF_TOKEN: 'user-tok', NF_PORT: '8443' })
  })
})

// ---------------------------------------------------------------------------
// 29.1 CR MD-02：confirmOverwrite「DB 已提交 → 换盘」窗口防护
// 现网缺陷：换盘失败（或窗口内 spawn）用新指纹比旧磁盘 → TOCTOU 误判 → 包永久禁用，
// 恢复只能完整重导。修复语义：换盘失败按事务前快照回滚 DB（消除持续态误禁用窗口）+
// 换盘窗口 swap 守卫（spawn/测试通道返回「正在更新」可重试，不触发 TOCTOU 副作用）。
// ---------------------------------------------------------------------------
describe('29.1 CR MD-02: confirmOverwrite 换盘失败 → 快照回滚（不留「DB 新指纹/磁盘旧内容」TOCTOU 误禁用持续态）', () => {
  it('换盘 rename 失败 → DB 回滚事务前旧指纹/旧 rel env（被剔除键恢复），包不被置 disabled', () => {
    const imp = McpPackageService.importPackage(mkMcpb({ envKeys: ['A', 'B'] }))
    if (!imp.ok) throw new Error('import failed')
    const pkgId = imp.package.id
    seedPackageConfig(h.db!, pkgId, { dev1: { A: 'a1', B: 'b1' } })
    const oldFp = (h.db!.prepare('SELECT fingerprint AS f FROM mcp_packages WHERE id = ?').get(pkgId) as any).f
    const oldRel = relEnv(h.db!, 'dev1')
    expect(oldRel).toEqual({ A: 'a1', B: 'b1' })
    // 注入换盘失败：dir_path 指向包根内「父目录不存在」路径——rmSync(force) 对不存在路径
    // 静默通过、renameSync 因父目录缺失 ENOENT 必败（等价真实「rm 成功/rename 半途失败」形态）
    const phantom = join(rootDir, 'no-such-parent', 'demo-pkg')
    h.db!.prepare('UPDATE mcp_packages SET dir_path = ? WHERE id = ?').run(phantom, pkgId)
    expect(() =>
      McpPackageService.confirmOverwrite(pkgId, mkMcpb({ version: '2.0.0', envKeys: ['A'], entryContent: 'console.log(2)' }))
    ).toThrow()
    // 快照回滚：指纹回旧值（配旧磁盘内容）、事务剔除的 B 键恢复、包未禁用
    const row = h.db!.prepare('SELECT fingerprint AS f, disabled AS d FROM mcp_packages WHERE id = ?').get(pkgId) as any
    expect(row.f).toBe(oldFp)
    expect(row.d).toBe(0)
    expect(relEnv(h.db!, 'dev1')).toEqual(oldRel)
    // 真实磁盘旧内容原样（注入路径本就未触碰真实包目录）
    expect(readFileSync(join(rootDir, 'demo-pkg', 'main.js'), 'utf-8')).toBe('console.log(1)')
  })

  it('换盘异常路径也清零 swap 标记（finally 语义，不永久卡死测试通道）', () => {
    const imp = McpPackageService.importPackage(mkMcpb())
    if (!imp.ok) throw new Error('import failed')
    const pkgId = imp.package.id
    const phantom = join(rootDir, 'no-such-parent-2', 'demo-pkg')
    h.db!.prepare('UPDATE mcp_packages SET dir_path = ? WHERE id = ?').run(phantom, pkgId)
    expect(() =>
      McpPackageService.confirmOverwrite(pkgId, mkMcpb({ version: '2.0.0' }))
    ).toThrow()
    expect(McpPackageSwapGuard.isSwapping(pkgId)).toBe(false)
  })
})

describe('29.1 CR MD-02: 换盘窗口 swap 守卫——测试通道返回「正在更新」不触发 TOCTOU 重验/禁用', () => {
  function seedOne(): { pkgId: number; cfgId: number } {
    const imp = McpPackageService.importPackage(mkMcpb())
    if (!imp.ok) throw new Error('import failed')
    const pkgId = imp.package.id
    seedPackageConfig(h.db!, pkgId, { dev1: { A: 'a1' } })
    const cfgId = Number((h.db!.prepare('SELECT id FROM mcp_configs WHERE package_id = ?').get(pkgId) as any).id)
    return { pkgId, cfgId }
  }

  it('isSwapping 置位期间 testPackageConfig → MCP_PACKAGE_SWAPPING 结构化失败，不重验不 spawn 不禁用', async () => {
    const { pkgId, cfgId } = seedOne()
    McpPackageSwapGuard.begin(pkgId)
    try {
      const res = await McpPackageService.testPackageConfig(cfgId)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe('MCP_PACKAGE_SWAPPING')
        expect(res.error.reason).toContain('正在更新')
      }
      expect(h.clientMock.verifyPackageFingerprint).not.toHaveBeenCalled()
      expect(h.clientMock.testConnection).not.toHaveBeenCalled()
      expect((h.db!.prepare('SELECT disabled AS d FROM mcp_packages WHERE id = ?').get(pkgId) as any).d).toBe(0)
    } finally {
      McpPackageSwapGuard.end(pkgId)
    }
  })

  it('isSwapping 置位期间 testPackage → 提示稍后重试，不重验不禁用', async () => {
    const { pkgId } = seedOne()
    McpPackageSwapGuard.begin(pkgId)
    try {
      const res = await McpPackageService.testPackage(pkgId)
      expect(res.ok).toBe(false)
      expect(res.error).toContain('正在更新')
      expect(h.clientMock.verifyPackageFingerprint).not.toHaveBeenCalled()
      expect(h.clientMock.testConnection).not.toHaveBeenCalled()
      expect((h.db!.prepare('SELECT disabled AS d FROM mcp_packages WHERE id = ?').get(pkgId) as any).d).toBe(0)
    } finally {
      McpPackageSwapGuard.end(pkgId)
    }
  })

  it('守卫清零后通道即恢复（begin/end 对称，无残留拦截）', async () => {
    const { pkgId, cfgId } = seedOne()
    McpPackageSwapGuard.begin(pkgId)
    McpPackageSwapGuard.end(pkgId)
    h.clientMock.testConnection.mockResolvedValue({ ok: true, protocolVersion: '1.0', tools: [] })
    const res = await McpPackageService.testPackageConfig(cfgId)
    expect(res.ok).toBe(true)
    expect(h.clientMock.testConnection).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 0.5.0 线上回归修复（debug mcp-pkg-legacy-path）：mcp_packages.dir_path 绝对路径漂移
// 30.1 userData 整体迁移（network-topology-manager → LinkPivot）后 DB 内旧绝对路径失效：
// spawn ENOENT（+ integrity 副作用误禁用）+ delete/overwrite 沙箱拒绝 → 三路死锁。
// 修复语义回归锚点：healPackagePaths 启动自愈 + deletePackage legacy 残留出路（fail-closed 不削弱）。
// ---------------------------------------------------------------------------
describe('0.5.0 回归修复 mcp-pkg-legacy-path: healPackagePaths 启动自愈', () => {
  /** 复现线上形态：正常导入 → 模拟 30.1 迁移后 DB 行旧态（dir_path=旧绝对路径 + ENOENT 误禁用） */
  function seedLegacyDrift(db: Database.Database, legacyRoot: string): { pkgId: number; cfgId: number } {
    const res = McpPackageService.importPackage(mkMcpb())
    if (!res.ok) throw new Error('import failed')
    const pkgId = res.package.id
    const cfg = db.prepare(
      "INSERT INTO mcp_configs (name, type, command_or_url, package_id, source) VALUES ('legacy-cfg', 'package', 'main.js', ?, 'package')"
    ).run(pkgId)
    // 线上形态注入：dir_path 指向「已随 30.1 迁移消失」的旧 userData 绝对路径 + 假阳性 disabled=1
    db.prepare('UPDATE mcp_packages SET dir_path = ?, disabled = 1 WHERE id = ?')
      .run(join(legacyRoot, 'demo-pkg'), pkgId)
    return { pkgId, cfgId: Number(cfg.lastInsertRowid) }
  }

  it('legacy 前缀 dir_path + 误禁用 → 规范位置在盘且指纹复验通过 → 重写路径 + 清 disabled（幂等）', () => {
    const legacyRoot = join(rootDir, '..', 'legacy-user-data', 'mcp-packages')
    const { pkgId } = seedLegacyDrift(h.db!, legacyRoot)

    const r = McpPackageService.healPackagePaths()
    expect(r).toEqual({ scanned: 1, healed: 1 })
    const row = h.db!.prepare('SELECT dir_path, disabled FROM mcp_packages WHERE id = ?').get(pkgId) as any
    expect(row.dir_path).toBe(join(rootDir, 'demo-pkg')) // 重写为规范位置（当前包根 + name）
    expect(row.disabled).toBe(0) // ENOENT 假阳性禁用清除（指纹复验通过 = 内容与导入时一致）

    // 幂等：已一致的行快速跳过，零重复写
    const again = McpPackageService.healPackagePaths()
    expect(again.healed).toBe(0)
  })

  it('heal 后下游读点零改动即恢复：管理页影响面/出口投影读到规范路径（非死路径）', () => {
    const legacyRoot = join(rootDir, '..', 'legacy-user-data', 'mcp-packages')
    const { pkgId } = seedLegacyDrift(h.db!, legacyRoot)
    expect(McpPackageService.healPackagePaths().healed).toBe(1)
    expect(McpPackageService.getPackageDeleteImpact(pkgId)!.dirPath).toBe(join(rootDir, 'demo-pkg'))
    expect(McpPackageService.listPackages().find((p) => p.id === pkgId)!.dirPath).toBe(join(rootDir, 'demo-pkg'))
  })

  it('规范位置缺失（幽灵残留：目录没随迁/被手删）→ 跳过不改（保留 ENOENT 真实语义，fail-closed）', () => {
    const pkgId = (McpPackageService.importPackage(mkMcpb({ name: 'ghost-pkg' })) as any).package.id
    rmSync(join(rootDir, 'ghost-pkg'), { recursive: true, force: true })
    const legacy = 'C:\\Users\\legacy\\AppData\\Roaming\\network-topology-manager\\mcp-packages\\ghost-pkg'
    h.db!.prepare('UPDATE mcp_packages SET dir_path = ?, disabled = 1 WHERE id = ?').run(legacy, pkgId)

    const r = McpPackageService.healPackagePaths()
    expect(r.healed).toBe(0)
    const row = h.db!.prepare('SELECT dir_path, disabled FROM mcp_packages WHERE id = ?').get(pkgId) as any
    expect(row.dir_path).toBe(legacy) // 零改动
    expect(row.disabled).toBe(1)
  })

  it('规范位置指纹复验不通过（内容与导入时不一致）→ 跳过且不清 disabled（重新导入才是出路）', () => {
    const pkgId = (McpPackageService.importPackage(mkMcpb({ name: 'tamper-pkg' })) as any).package.id
    const legacy = 'C:\\Users\\legacy\\AppData\\Roaming\\network-topology-manager\\mcp-packages\\tamper-pkg'
    h.db!.prepare('UPDATE mcp_packages SET dir_path = ?, disabled = 1 WHERE id = ?').run(legacy, pkgId)
    // 规范位置在盘但内容被篡改 → 复验必败
    writeFileSync(join(rootDir, 'tamper-pkg', 'main.js'), 'tampered')
    h.clientMock.verifyPackageFingerprint.mockImplementation(() => {
      throw { code: 'package_integrity_failed', reason: '包指纹重验失败（TOCTOU 检出）：内容变化 main.js' }
    })

    const r = McpPackageService.healPackagePaths()
    expect(r.healed).toBe(0)
    const row = h.db!.prepare('SELECT dir_path, disabled FROM mcp_packages WHERE id = ?').get(pkgId) as any
    expect(row.dir_path).toBe(legacy)
    expect(row.disabled).toBe(1)
  })

  it('name 被篡改（派生规范位置逃逸包根）→ heal 跳过（留给既有拒绝链，不生产越界重写）', () => {
    const pkgId = (McpPackageService.importPackage(mkMcpb({ name: 'evil-pkg' })) as any).package.id
    const legacy = 'C:\\Users\\legacy\\AppData\\Roaming\\network-topology-manager\\mcp-packages\\x'
    h.db!.prepare('UPDATE mcp_packages SET name = ?, dir_path = ? WHERE id = ?').run('..\\evil', legacy, pkgId)

    const r = McpPackageService.healPackagePaths()
    expect(r.healed).toBe(0)
    const row = h.db!.prepare('SELECT dir_path FROM mcp_packages WHERE id = ?').get(pkgId) as any
    expect(row.dir_path).toBe(legacy)
  })
})

describe('0.5.0 回归修复 mcp-pkg-legacy-path: deletePackage legacy 残留死锁出路', () => {
  it('dir_path 逃逸且目标不在盘（legacy 迁移残留）→ DB 四表级联清净 + 清规范位置孤儿 + 逃逸路径零 fs 动作', () => {
    const res = McpPackageService.importPackage(mkMcpb())
    if (!res.ok) throw new Error('import failed')
    const pkgId = res.package.id
    seedPackageConfig(h.db!, pkgId, { dev1: { A: '1' } })
    // 逃逸目标不在盘的 legacy 残留形态；规范位置（root/demo-pkg）在盘持有真实包文件
    const phantom = join(rootDir, '..', 'gone-legacy-user-data', 'mcp-packages', 'demo-pkg')
    h.db!.prepare('UPDATE mcp_packages SET dir_path = ? WHERE id = ?').run(phantom, pkgId)

    const del = McpPackageService.deletePackage(pkgId)
    expect(del.ok).toBe(true)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get()).toEqual({ c: 0 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get()).toEqual({ c: 0 })
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get()).toEqual({ c: 0 })
    expect(existsSync(join(rootDir, 'demo-pkg'))).toBe(false) // 规范位置孤儿文件一并清净
    expect(existsSync(phantom)).toBe(false) // 逃逸路径从未被创建/触碰
  })

  it('dir_path 逃逸且目标在盘 → 维持 CR-01 整体拒绝不 rmSync（既有语义零削弱，上方 CR-01 用例同锚）', () => {
    const pkgId = (McpPackageService.importPackage(mkMcpb({ name: 'cr1-pkg' })) as any).package.id
    const sentinel = join(rootDir, '..', 'sentinel-legacy-residue.txt')
    writeFileSync(sentinel, 'keep')
    h.db!.prepare('UPDATE mcp_packages SET dir_path = ? WHERE id = ?').run(resolve(rootDir, '..'), pkgId)
    const del = McpPackageService.deletePackage(pkgId)
    expect(del.ok).toBe(false)
    if (!del.ok) expect(del.error).toContain('不安全')
    expect(existsSync(sentinel)).toBe(true)
    expect(h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_packages').get()).toEqual({ c: 1 }) // 行未删
    rmSync(sentinel, { force: true })
  })
})
