import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

/**
 * Phase 29 Plan 29-04 Task 1 —— 设备级实例化：复合键 + python 轨道 + TOCTOU 全树重验。
 *
 * 覆盖（T-29-04-01 TOCTOU / T-29-04-02 复合键 / T-29-04-06 python 路径）：
 * - verifyPackageFingerprint：一致通过 / 篡改 / 新增 / 删除文件均拒绝（D-27 全树）
 * - connectionKey 复合键（configId:deviceId，缺省 '0' 兼容手工配置旧语义）
 * - 同配置两设备 = 两个独立连接（http loopback 对端，无子进程）
 * - TOCTOU 拒绝启动：getConnection 带 package opts 篡改后抛 package_integrity_failed +
 *   integrityHandler 被回调（D-26 副作用链路入口）
 * - resolvePackageSpawn python 分支：内嵌 python.exe 绝对路径 + entry 绝对 args + plain；
 *   缺内嵌 python 结构化拒绝
 *
 * 真路径形态：包目录用 mkdtemp 真文件树；连接用进程内 http mock（mcpClient.real.test.ts
 * 已覆盖 stdio 真 spawn 三路径，这里不重复）。跑法红线：npm run test:electron。
 */

import { vi } from 'vitest'
import {
  connectionKey,
  verifyPackageFingerprint,
  resolvePackageSpawn,
  setIntegrityHandler,
  getConnection,
  callToolWithTimeout,
  closeMcpConnection,
  applyEnvMeta,
  _activeConnectionKeys
} from '../../../electron/services/mcpClient'
import type { PackageSpawnInfo } from '../../../electron/services/mcpClient'
import type { EnvMetaEntry } from '../../../electron/services/mcpPackageValidator'
import { buildFingerprintTree } from '../../../electron/services/mcpPackageValidator'
import type { FileEntry } from '../../../electron/services/mcpPackageValidator'
import { startMockHttpMcpServer } from '../_helpers/mockMcpServer'

/** 构造内存 FileEntry 树并落盘到临时目录（两态同源——指纹天然一致） */
function makePackageDir(files: Array<{ path: string; content: string }>): { dir: string; fileTree: FileEntry[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mcpb-'))
  const fileTree: FileEntry[] = []
  for (const f of files) {
    const abs = path.join(dir, ...f.path.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.content)
    fileTree.push({ path: f.path, content: Buffer.from(f.content, 'utf8') })
  }
  return { dir, fileTree }
}

/** 断言 fn 抛出结构化错误且 code 匹配（plain object 非 Error——toThrow 匹配器不适用） */
function expectStructThrow(fn: () => void, code: string): any {
  try { fn() } catch (e) { expect((e as any)?.code).toBe(code); return e }
  throw new Error(`expected throw ${code}, but no throw`)
}

function sha(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

const PKG_FILES = [
  { path: 'manifest.json', content: '{"name":"demo","version":"1.0.0"}' },
  { path: 'server.js', content: 'console.log("server")' },
  { path: 'lib/util.js', content: 'export const x = 1' },
]

const pkgInfo = (dir: string, fingerprintJson: string, runtime: 'node' | 'python' = 'node'): PackageSpawnInfo => ({
  packageId: 42,
  dirPath: dir,
  runtime,
  entry: runtime === 'python' ? 'server.py' : 'server.js',
  fingerprintJson,
})

let cleanupDirs: string[] = []

afterEach(() => {
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 清理容错 */ }
  }
  cleanupDirs = []
  setIntegrityHandler(null)
})

describe('verifyPackageFingerprint（D-27 全树重验）', () => {
  it('指纹一致 → 不抛（正常连接路径前置）', () => {
    const { dir, fileTree } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    expect(() => verifyPackageFingerprint(dir, JSON.stringify(fp))).not.toThrow()
  })

  it('篡改任一文件内容 → 抛 package_integrity_failed（含 treeSha 差异细节）', () => {
    const { dir, fileTree } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    fs.writeFileSync(path.join(dir, 'lib/util.js'), 'export const x = 2 // tampered')
    const e = expectStructThrow(() => verifyPackageFingerprint(dir, JSON.stringify(fp)), 'package_integrity_failed')
    expect(e.reason).toContain('lib/util.js')
  })

  it('新增文件（指纹清单外）→ 拒绝（全树语义，不只清单内文件）', () => {
    const { dir, fileTree } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    fs.writeFileSync(path.join(dir, 'evil.dll'), 'malicious')
    expectStructThrow(() => verifyPackageFingerprint(dir, JSON.stringify(fp)), 'package_integrity_failed')
  })

  it('删除文件 → 拒绝', () => {
    const { dir, fileTree } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    fs.unlinkSync(path.join(dir, 'server.js'))
    expectStructThrow(() => verifyPackageFingerprint(dir, JSON.stringify(fp)), 'package_integrity_failed')
  })

  it('落盘指纹清单坏 JSON → 拒绝（fail-closed）', () => {
    const { dir } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    expectStructThrow(() => verifyPackageFingerprint(dir, 'not-json'), 'package_integrity_failed')
  })

  // 29-09 走查三：__pycache__/*.pyc 是 Python 解释器首跑自动生成的磁盘产物，
  // 双侧（导入指纹 / 磁盘重验）同源排除——防 python 包首跑后永久 TOCTOU 误报
  it('运行时生成 __pycache__/*.pyc → 排除不触发 TOCTOU（双侧对称排除）', () => {
    const { dir, fileTree } = makePackageDir([
      ...PKG_FILES,
      { path: 'server.py', content: 'print("py")' },
      { path: '__pycache__/x.cpython-310.pyc', content: 'zip-carried-cache' },
    ])
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    // 模拟解释器首跑后磁盘长出的新字节码缓存（zip 里没有的）
    fs.mkdirSync(path.join(dir, 'nf_mcp', '__pycache__'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'nf_mcp/__pycache__/server.cpython-310.pyc'), 'runtime-generated')
    fs.writeFileSync(path.join(dir, 'root.pyc'), 'runtime-generated-root')
    expect(() => verifyPackageFingerprint(dir, JSON.stringify(fp))).not.toThrow()
  })

  it('排除清单只让位运行时产物：真正新增 .py 源文件仍触发 TOCTOU（安全语义不降级）', () => {
    const { dir, fileTree } = makePackageDir([
      ...PKG_FILES,
      { path: 'server.py', content: 'print("py")' },
      { path: '__pycache__/x.cpython-310.pyc', content: 'zip-carried-cache' },
    ])
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    fs.mkdirSync(path.join(dir, 'nf_mcp'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'nf_mcp/evil.py'), 'import os # injected source')
    expectStructThrow(() => verifyPackageFingerprint(dir, JSON.stringify(fp)), 'package_integrity_failed')
  })
})

describe('connectionKey 复合键（D-15/D-18）', () => {
  it('configId:deviceId 形态；deviceId 缺省 \'0\'（手工 stdio 旧语义不断）', () => {
    expect(connectionKey('7', 'd1')).toBe('7:d1')
    expect(connectionKey('7')).toBe('7:0')
    expect(connectionKey('7', 'd1')).not.toBe(connectionKey('7', 'd2'))
  })
})

describe('复合键连接：同配置两设备 = 两连接两回收键（http 对端）', () => {
  it('getConnection/callToolWithTimeout/closeMcpConnection 均按全键核算', async () => {
    const srv = await startMockHttpMcpServer({ pages: 1 })
    try {
      const cfg = { type: 'http' as const, commandOrUrl: `http://127.0.0.1:${srv.port}/mcp`, args: [], env: {}, credential: null }
      await getConnection('5', cfg, { deviceId: 'd1' })
      await getConnection('5', cfg, { deviceId: 'd2' })
      expect(_activeConnectionKeys().sort()).toEqual(['5:d1', '5:d2'])
      const r = await callToolWithTimeout('5', cfg, 'tool_0', {}, { deviceId: 'd2' }) as Record<string, unknown>
      expect(Array.isArray(r.content)).toBe(true)
      await closeMcpConnection('5', 'd1')
      expect(_activeConnectionKeys()).toEqual(['5:d2'])
      await closeMcpConnection('5', 'd2')
      expect(_activeConnectionKeys()).toEqual([])
    } finally {
      await srv.close()
    }
  }, 30000)

  it('无 deviceId（旧调用形态）键为 configId:0，不与设备级实例串线', async () => {
    const srv = await startMockHttpMcpServer({ pages: 1 })
    try {
      const cfg = { type: 'http' as const, commandOrUrl: `http://127.0.0.1:${srv.port}/mcp`, args: [], env: {}, credential: null }
      await getConnection('5', cfg)
      await getConnection('5', cfg, { deviceId: 'd1' })
      expect(_activeConnectionKeys().sort()).toEqual(['5:0', '5:d1'])
      await closeMcpConnection('5')
      await closeMcpConnection('5', 'd1')
    } finally {
      await srv.close()
    }
  }, 30000)
})

describe('TOCTOU 拒绝启动（T-29-04-01，D-26/D-27）', () => {
  it('spawn 前重验失败 → 抛 package_integrity_failed + integrityHandler 回调 + 零连接零 spawn', async () => {
    const { dir, fileTree } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    fs.appendFileSync(path.join(dir, 'server.js'), '// tampered after import')
    const handler = vi.fn()
    setIntegrityHandler(handler)
    const cfg = { type: 'stdio' as const, commandOrUrl: 'node', args: [], env: {}, credential: null }
    await expect(
      getConnection('9', cfg, { deviceId: 'd1', package: pkgInfo(dir, JSON.stringify(fp)) })
    ).rejects.toMatchObject({ code: 'package_integrity_failed' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ packageId: 42, dirPath: dir }))
    expect(_activeConnectionKeys()).toEqual([])
  }, 30000)

  it('integrityHandler 抛异常不吞 TOCTOU 主错误（handler 故障不降级安全语义）', async () => {
    const { dir, fileTree } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    fs.unlinkSync(path.join(dir, 'server.js'))
    setIntegrityHandler(() => { throw new Error('handler boom') })
    const cfg = { type: 'stdio' as const, commandOrUrl: 'node', args: [], env: {}, credential: null }
    await expect(
      getConnection('9', cfg, { deviceId: 'd1', package: pkgInfo(dir, JSON.stringify(fp)) })
    ).rejects.toMatchObject({ code: 'package_integrity_failed' })
  }, 30000)
})

describe('resolvePackageSpawn 双轨（D-02/D-03，T-29-04-06）', () => {
  it('runtime=python：包内嵌 python.exe 绝对路径 + entry 绝对 args + envMode plain + 无兜底', () => {
    const { dir, fileTree } = makePackageDir([
      ...PKG_FILES,
      { path: 'server.py', content: 'print("py")' },
      { path: 'python/python.exe', content: 'fake-pe' },
    ])
    cleanupDirs.push(dir)
    const plan = resolvePackageSpawn(pkgInfo(dir, JSON.stringify(buildFingerprintTree(fileTree)), 'python'))
    expect(plan.command).toBe(path.join(dir, 'python', 'python.exe'))
    expect(plan.args).toEqual([path.join(dir, 'server.py')])
    expect(plan.envMode).toBe('plain')
    expect(plan.fallback).toBeNull()
  })

  it('runtime=python 兜底次序：根 python.exe 也接受（29-03 testPackage 同源候选清单）', () => {
    const { dir, fileTree } = makePackageDir([
      { path: 'server.py', content: 'print("py")' },
      { path: 'python.exe', content: 'fake-pe-root' },
    ])
    cleanupDirs.push(dir)
    const plan = resolvePackageSpawn(pkgInfo(dir, JSON.stringify(buildFingerprintTree(fileTree)), 'python'))
    expect(plan.command).toBe(path.join(dir, 'python.exe'))
  })

  it('runtime=python 未内嵌 python.exe → 结构化拒绝（路径伪造不可行）', () => {
    const { dir, fileTree } = makePackageDir([{ path: 'server.py', content: 'print("py")' }])
    cleanupDirs.push(dir)
    expectStructThrow(() => resolvePackageSpawn(pkgInfo(dir, '', 'python')), 'MCP_PYTHON_MISSING')
  })

  it('runtime=node：command=node + entry 绝对 args（ELECTRON_RUN_AS_NODE 兜底沿用 D-03）', () => {
    const { dir, fileTree } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    const plan = resolvePackageSpawn(pkgInfo(dir, JSON.stringify(buildFingerprintTree(fileTree))))
    expect(plan.command).toBe('node')
    expect(plan.args).toEqual([path.join(dir, 'server.js')])
    expect(plan.fallback).not.toBeNull()
  })
})

describe('指纹一致的 node 包正常连接（真路径不回归）', () => {
  it('package opts 指纹一致 → spawn 成功 + 连接键为 configId:deviceId', async () => {
    // mock 对端复制入包（entry = server.mjs），指纹按落盘树计算——真 spawn 走 node 轨道
    const helperPath = path.resolve(__dirname, '../_helpers/mockMcpServer.ts')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mcpb-ok-'))
    cleanupDirs.push(dir)
    const helperSrc = fs.readFileSync(helperPath, 'utf8')
    // 无 --child flag 的包轨道 spawn 形态：复制体尾部直接进入 stdio child 入口（等价 --child）
    const serverSrc = helperSrc + '\nrunStdioChild()\n'
    fs.writeFileSync(path.join(dir, 'server.mjs'), serverSrc)
    const fileTree: FileEntry[] = [{ path: 'server.mjs', content: Buffer.from(serverSrc, 'utf8') }]
    const fp = buildFingerprintTree(fileTree)
    const pkg = pkgInfo(dir, JSON.stringify(fp))
    pkg.entry = 'server.mjs'
    const cfg = { type: 'stdio' as const, commandOrUrl: 'node', args: [], env: {}, credential: null }
    const client = await getConnection('11', cfg, { deviceId: 'dA', package: pkg })
    const tools = await client.listTools()
    expect(tools.tools.length).toBeGreaterThan(0)
    expect(_activeConnectionKeys()).toEqual(['11:dA'])
    await closeMcpConnection('11', 'dA')
    expect(_activeConnectionKeys()).toEqual([])
  }, 30000)
})

describe('spawn envMeta（29.1-04：D-01 required 硬拦 + D-02 default 叠加）', () => {
  const META: Record<string, EnvMetaEntry> = {
    NF_TOKEN: { label: '防火墙令牌', required: true },
    NF_PORT: { label: 'API 端口', default: '443' },
  }
  const META_REQ_DEFAULT: Record<string, EnvMetaEntry> = {
    NF_TOKEN: { label: '防火墙令牌', required: true, default: 'tok-default' },
  }

  it('required 键未填 → throw MCP_ENV_REQUIRED_MISSING，reason 含 label 可定位文案', () => {
    const e = expectStructThrow(() => applyEnvMeta({}, META), 'MCP_ENV_REQUIRED_MISSING')
    expect(e.reason).toContain('防火墙令牌')
    expect(e.reason).toContain('未配置')
  })

  it('required 键空串/仅空白 → 同判缺（trim 判定，T-29.1-12 fail-open 兜住）', () => {
    expectStructThrow(() => applyEnvMeta({ NF_TOKEN: '' }, META), 'MCP_ENV_REQUIRED_MISSING')
    expectStructThrow(() => applyEnvMeta({ NF_TOKEN: '   ' }, META), 'MCP_ENV_REQUIRED_MISSING')
  })

  it('required 键无 label → reason 回退裸键名（仍可定位）', () => {
    const e = expectStructThrow(() => applyEnvMeta({}, { NF_TOKEN: { label: 'NF_TOKEN', required: true } }), 'MCP_ENV_REQUIRED_MISSING')
    expect(e.reason).toContain('NF_TOKEN')
  })

  it('default 叠加：用户未提供 → 补包默认；用户填过 → 用户值优先（D-02）', () => {
    const portOnly: Record<string, EnvMetaEntry> = { NF_PORT: META.NF_PORT }
    expect(applyEnvMeta({}, portOnly)).toEqual({ NF_PORT: '443' })
    expect(applyEnvMeta({ NF_PORT: '8443' }, portOnly)).toEqual({ NF_PORT: '8443' })
    // 用户空串 = 留空语义 → 跟随包默认
    expect(applyEnvMeta({ NF_PORT: '' }, portOnly)).toEqual({ NF_PORT: '443' })
  })

  it('required + default 并存 → default 补上即通过硬拦', () => {
    expect(applyEnvMeta({}, META_REQ_DEFAULT)).toEqual({ NF_TOKEN: 'tok-default' })
  })

  it('纯内存叠加不改入参（不落库语义的前置：无写库路径，无引用污染）', () => {
    const userEnv = { NF_PORT: '8443' }
    applyEnvMeta(userEnv, META_REQ_DEFAULT)
    expect(userEnv).toEqual({ NF_PORT: '8443' })
  })

  it('无 envMeta / 空 envMeta → 返回用户原值副本（零回归，行为等同现状）', () => {
    expect(applyEnvMeta({ A: '1' }, undefined)).toEqual({ A: '1' })
    expect(applyEnvMeta({ A: '1' }, {})).toEqual({ A: '1' })
    expect(applyEnvMeta({}, undefined)).toEqual({})
  })

  it('getConnection 包轨 required 缺值 → connectStdio 前拒绝 + 零连接零 spawn', async () => {
    const { dir, fileTree } = makePackageDir(PKG_FILES)
    cleanupDirs.push(dir)
    const fp = buildFingerprintTree(fileTree)
    const cfg = { type: 'stdio' as const, commandOrUrl: 'node', args: [], env: { NF_PORT: '8443' }, credential: null }
    const pkg: PackageSpawnInfo = { ...pkgInfo(dir, JSON.stringify(fp)), envMeta: META }
    await expect(
      getConnection('13', cfg, { deviceId: 'd1', package: pkg })
    ).rejects.toMatchObject({ code: 'MCP_ENV_REQUIRED_MISSING' })
    expect(_activeConnectionKeys()).toEqual([])
  }, 30000)

  it('getConnection 包轨 default 叠加实证：真 spawn 子进程收 NF_PORT=用户值 + NF_TOKEN=包默认', async () => {
    // mock 对端复制入包，模块加载即落 envdump.json（spawn 时刻生效 env 的唯一观测点）
    const helperPath = path.resolve(__dirname, '../_helpers/mockMcpServer.ts')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mcpb-env-'))
    cleanupDirs.push(dir)
    const prelude = "import { writeFileSync } from 'node:fs'\n" +
      "writeFileSync(new URL('./envdump.json', import.meta.url), JSON.stringify({ NF_PORT: process.env.NF_PORT ?? null, NF_TOKEN: process.env.NF_TOKEN ?? null }))\n"
    const serverSrc = prelude + fs.readFileSync(helperPath, 'utf8') + '\nrunStdioChild()\n'
    fs.writeFileSync(path.join(dir, 'server.mjs'), serverSrc)
    const fileTree: FileEntry[] = [{ path: 'server.mjs', content: Buffer.from(serverSrc, 'utf8') }]
    const fp = buildFingerprintTree(fileTree)
    const pkg: PackageSpawnInfo = {
      packageId: 43, dirPath: dir, runtime: 'node', entry: 'server.mjs',
      fingerprintJson: JSON.stringify(fp), envMeta: {
        NF_TOKEN: { label: '防火墙令牌', required: true, default: 'tok-default' },
        NF_PORT: { label: 'API 端口', default: '443' },
      },
    }
    const cfg = { type: 'stdio' as const, commandOrUrl: 'node', args: [], env: { NF_PORT: '8443' }, credential: null }
    const client = await getConnection('14', cfg, { deviceId: 'dB', package: pkg })
    expect(_activeConnectionKeys()).toEqual(['14:dB'])
    await closeMcpConnection('14', 'dB')
    const dump = JSON.parse(fs.readFileSync(path.join(dir, 'envdump.json'), 'utf8'))
    expect(dump.NF_PORT).toBe('8443') // 用户值优先
    expect(dump.NF_TOKEN).toBe('tok-default') // 留空即用包默认（spawn 叠加）
  }, 30000)
})

beforeEach(() => {
  vi.clearAllMocks()
})

// 供 sha 对照的直算断言（buildFingerprintTree 交叉验证，防止测试与实现同源盲区）
void sha
