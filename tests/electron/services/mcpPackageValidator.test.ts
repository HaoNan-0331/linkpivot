import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import {
  validateMcpb,
  buildFingerprintTree,
  isFingerprintExcluded,
  parseMcpbManifest,
} from '../../../electron/services/mcpPackageValidator'

/**
 * Phase 29 Plan 29-01 —— .mcpb 五向量校验器攻击样本测试集（PKG-02）。
 *
 * 全部样本在内存用 fflate.zipSync 构造（不落盘），buffer 直接喂 validateMcpb。
 * 五向量：manifest-schema / entry-whitelist / zip-slip / double-extension / manifest-lie
 * + D-04 双重体积上限（mock 元数据注入，不真造 200MB/1GB）+ 全树指纹确定性。
 *
 * 语义依据 29-CONTEXT：D-01 双轨入口 / D-06 单入口单 server / D-07 型号包含匹配 /
 * D-08 工具名称+描述+readOnlyHint / D-09 envKeys 仅键名 / D-11 纯结构检查零执行。
 */

interface Tool {
  name: string
  description: string
  readOnlyHint?: boolean
}

function validPythonManifest(): Record<string, unknown> {
  // 照 nsfocus-nf-mcp 真实包形态：python 入口 + NF 型号 + 只读标记工具
  return {
    name: 'nsfocus-nf',
    version: '1.0.0',
    runtime: 'python',
    entry: 'nf_mcp/server.py',
    models: ['NF'],
    tools: [
      { name: 'get_system_status', description: '查询系统状态', readOnlyHint: true },
      { name: 'add_blacklist_ip', description: '加入黑名单' },
    ],
    envKeys: ['NF_HOST', 'NF_PORT', 'TOKEN'],
  }
}

function validNodeManifest(): Record<string, unknown> {
  return {
    name: 'net-tools',
    version: '0.1.0',
    runtime: 'node',
    entry: 'main.js',
    models: ['S5735', 'CE6857'],
    tools: [{ name: 'show_interface', description: '查接口', readOnlyHint: true }],
    envKeys: [],
  }
}

function entryContent(manifest: Record<string, unknown>): Uint8Array {
  return strToU8(`# entry stub for ${String(manifest.name)}\n`)
}

function makeMcpb(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files)
}

function manifestFile(manifest: Record<string, unknown>): Uint8Array {
  return strToU8(JSON.stringify(manifest))
}

function vec(result: ReturnType<typeof validateMcpb>, id: string) {
  const v = result.vectors.find((x) => x.id === id)
  expect(v).toBeDefined()
  return v!
}

describe('parseMcpbManifest 强 schema 解析', () => {
  it('合法 JSON → 返回 McpManifest', () => {
    const m = parseMcpbManifest(JSON.stringify(validPythonManifest()))
    expect(m.name).toBe('nsfocus-nf')
    expect(m.runtime).toBe('python')
  })

  it('畸形 JSON → throw', () => {
    expect(() => parseMcpbManifest('{oops')).toThrow()
  })
})

describe('向量一 manifest-schema', () => {
  it('缺 runtime → fail（人话 reason）', () => {
    const m = validNodeManifest()
    delete m.runtime
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) }))
    expect(vec(r, 'manifest-schema').ok).toBe(false)
    expect(r.passed).toBe(false)
    expect(vec(r, 'manifest-schema').reason).toBeTruthy()
  })

  it('runtime 非 node|python → fail', () => {
    const m = validNodeManifest()
    m.runtime = 'bash'
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) }))
    expect(vec(r, 'manifest-schema').ok).toBe(false)
  })

  it('tools 项缺 name → fail', () => {
    const m = validNodeManifest()
    m.tools = [{ description: '缺名字' } as unknown as Tool]
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) }))
    expect(vec(r, 'manifest-schema').ok).toBe(false)
  })

  it('tools 项缺 description → fail（D-08）', () => {
    const m = validNodeManifest()
    m.tools = [{ name: 'x' } as unknown as Tool]
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) }))
    expect(vec(r, 'manifest-schema').ok).toBe(false)
  })

  it('字段齐全 python 照真实包形态 → pass', () => {
    const m = validPythonManifest()
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
    expect(vec(r, 'manifest-schema').ok).toBe(true)
  })

  // CR-01（Phase 29 code-review）：包名白名单——name 参与目录构造与 rmSync(recursive)，
  // 必须在 manifest-schema 向量拒绝路径逃逸/破坏性删除形态（包名维度 zip-slip）
  it('CR-01：name 为 ".." / 含路径分隔符 / 盘符 / 以点开头 → manifest-schema fail', () => {
    for (const evil of ['..', '.', 'a/../../b', 'a\\b', '/abs', 'C:\\x', '.hidden', '']) {
      const m = validNodeManifest()
      m.name = evil
      const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) }))
      expect(vec(r, 'manifest-schema').ok, `name=${evil}`).toBe(false)
      expect(r.passed).toBe(false)
    }
  })

  it('CR-01：合法字符集包名（字母数字._- 混合）→ pass', () => {
    const m = validNodeManifest()
    m.name = 'Pkg.v2_beta-01'
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) }))
    expect(vec(r, 'manifest-schema').ok).toBe(true)
  })
})

describe('向量二 entry-whitelist（D-01 双轨）', () => {
  it('node + .js/.mjs/.cjs → pass', () => {
    for (const entry of ['main.js', 'main.mjs', 'main.cjs']) {
      const m = validNodeManifest()
      m.entry = entry
      const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), [entry]: entryContent(m) }))
      expect(vec(r, 'entry-whitelist').ok).toBe(true)
    }
  })

  it('node + .exe/.bat/.ps1 → fail', () => {
    for (const entry of ['main.exe', 'main.bat', 'main.ps1']) {
      const m = validNodeManifest()
      m.entry = entry
      const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), [entry]: entryContent(m) }))
      expect(vec(r, 'entry-whitelist').ok).toBe(false)
    }
  })

  it('python + .py → pass', () => {
    const m = validPythonManifest()
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
    expect(vec(r, 'entry-whitelist').ok).toBe(true)
  })

  it('python + .pyc/.exe → fail', () => {
    for (const entry of ['server.pyc', 'server.exe']) {
      const m = validPythonManifest()
      m.entry = entry
      const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), [entry]: entryContent(m) }))
      expect(vec(r, 'entry-whitelist').ok).toBe(false)
    }
  })
})

describe('向量三 zip-slip', () => {
  it('条目名含 ../ → fail', () => {
    const m = validNodeManifest()
    const r = validateMcpb(makeMcpb({
      'manifest.json': manifestFile(m),
      'main.js': entryContent(m),
      '../evil.js': entryContent(m),
    }))
    expect(vec(r, 'zip-slip').ok).toBe(false)
  })

  it('绝对路径 /etc/x → fail', () => {
    const m = validNodeManifest()
    const r = validateMcpb(makeMcpb({
      'manifest.json': manifestFile(m),
      'main.js': entryContent(m),
      '/etc/x': entryContent(m),
    }))
    expect(vec(r, 'zip-slip').ok).toBe(false)
  })

  it('反斜杠逃逸 ..\\..\\x → fail', () => {
    const m = validNodeManifest()
    const r = validateMcpb(makeMcpb({
      'manifest.json': manifestFile(m),
      'main.js': entryContent(m),
      '..\\..\\x': entryContent(m),
    }))
    expect(vec(r, 'zip-slip').ok).toBe(false)
  })
})

describe('向量四 double-extension（全树扫描，不只 entry）', () => {
  it('entry 为 server.py.exe → fail', () => {
    const m = validPythonManifest()
    m.entry = 'server.py.exe'
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'server.py.exe': entryContent(m) }))
    expect(vec(r, 'double-extension').ok).toBe(false)
  })

  it('entry 合法但包内任意文件 main.js.bat → fail', () => {
    const m = validNodeManifest()
    const r = validateMcpb(makeMcpb({
      'manifest.json': manifestFile(m),
      'main.js': entryContent(m),
      'vendor/main.js.bat': entryContent(m),
    }))
    expect(vec(r, 'double-extension').ok).toBe(false)
  })

  it('普通双扩展无关文件（readme.md.txt）→ 不触发该向量', () => {
    const m = validNodeManifest()
    const r = validateMcpb(makeMcpb({
      'manifest.json': manifestFile(m),
      'main.js': entryContent(m),
      'readme.md.txt': entryContent(m),
    }))
    expect(vec(r, 'double-extension').ok).toBe(true)
  })
})

describe('向量五 manifest-lie', () => {
  it('manifest.entry 在 zip 中不存在 → fail', () => {
    const m = validNodeManifest()
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m) }))
    expect(vec(r, 'manifest-lie').ok).toBe(false)
  })

  it('工具名含非法字符 → fail', () => {
    const m = validNodeManifest()
    m.tools = [{ name: 'rm -rf /', description: 'x' }]
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) }))
    expect(vec(r, 'manifest-lie').ok).toBe(false)
  })
})

describe('D-04 双重体积上限', () => {
  it('压缩尺寸超 200MB（mock 元数据注入）→ fail 且 reason 指向包体积', () => {
    const m = validNodeManifest()
    const buf = makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) })
    const r = validateMcpb(buf, { compressedBytes: 201 * 1024 * 1024 })
    expect(r.passed).toBe(false)
    expect(r.vectors.some((v) => !v.ok && /200MB|体积/.test(v.reason ?? ''))).toBe(true)
  })

  it('解压累计超 1GB（mock 元数据注入）→ fail 且 reason 指向解压后', () => {
    const m = validNodeManifest()
    const buf = makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) })
    const r = validateMcpb(buf, { uncompressedBytes: 1025 * 1024 * 1024 })
    expect(r.passed).toBe(false)
    expect(r.vectors.some((v) => !v.ok && /1GB|解压/.test(v.reason ?? ''))).toBe(true)
  })
})

describe('buildFingerprintTree 确定性', () => {
  it('同内容两文件树 → treeSha256 相等', () => {
    const tree = [
      { path: 'a.js', content: strToU8('hello') },
      { path: 'b/c.py', content: strToU8('world') },
    ]
    const t1 = buildFingerprintTree(tree)
    const t2 = buildFingerprintTree([
      { path: 'b/c.py', content: strToU8('world') },
      { path: 'a.js', content: strToU8('hello') },
    ])
    expect(t1.treeSha256).toBe(t2.treeSha256)
    expect(t1.files.map((f) => f.path)).toEqual(['a.js', 'b/c.py'])
    expect(t1.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('任一文件改 1 字节 → treeSha256 变化', () => {
    const base = buildFingerprintTree([{ path: 'a.js', content: strToU8('hello') }])
    const changed = buildFingerprintTree([{ path: 'a.js', content: strToU8('hellp') }])
    expect(base.treeSha256).not.toBe(changed.treeSha256)
  })

  it('路径列表变化（新增文件）→ treeSha256 变化', () => {
    const base = buildFingerprintTree([{ path: 'a.js', content: strToU8('hello') }])
    const grown = buildFingerprintTree([
      { path: 'a.js', content: strToU8('hello') },
      { path: 'b.js', content: strToU8('x') },
    ])
    expect(base.treeSha256).not.toBe(grown.treeSha256)
  })
})

describe('指纹排除清单（29-09 走查三：__pycache__/pyc 运行时产物单源排除）', () => {
  it('isFingerprintExcluded：__pycache__ 目录段 / .pyc / .pyo 后缀命中；普通文件不命中', () => {
    expect(isFingerprintExcluded('__pycache__/x.cpython-310.pyc')).toBe(true)
    expect(isFingerprintExcluded('nf_mcp/__pycache__/server.pyc')).toBe(true)
    expect(isFingerprintExcluded('nf_mcp/server.pyo')).toBe(true)
    expect(isFingerprintExcluded('root.pyc')).toBe(true)
    expect(isFingerprintExcluded('nf_mcp/server.py')).toBe(false)
    expect(isFingerprintExcluded('manifest.json')).toBe(false)
  })

  it('buildFingerprintTree 过滤排除条目：含 pyc 的树与不含的树同指纹', () => {
    const clean = [{ path: 'server.py', content: strToU8('print(1)') }]
    const dirty = [
      ...clean,
      { path: '__pycache__/server.cpython-310.pyc', content: strToU8('cache') },
      { path: 'lib/__pycache__/x.pyc', content: strToU8('cache2') },
    ]
    expect(buildFingerprintTree(clean).treeSha256).toBe(buildFingerprintTree(dirty).treeSha256)
  })
})

describe('向量六 envmeta-lie（29.1 D-03：envMeta 键集 ⊆ envKeys）', () => {
  it('合法：envMeta 键集 ⊆ envKeys → 全向量 pass', () => {
    const m = validPythonManifest()
    m.envMeta = {
      TOKEN: { label: '接口令牌', required: true },
      NF_PORT: { label: '端口', default: '443', example: '8443', description: 'REST 端口' },
    }
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
    expect(r.passed).toBe(true)
    expect(vec(r, 'envmeta-lie').ok).toBe(true)
    expect(r.manifest?.envMeta?.TOKEN).toEqual({ label: '接口令牌', required: true })
  })

  it('越界：envMeta 含 envKeys 之外的键 → envmeta-lie fail 且 reason 含 envMeta', () => {
    const m = validPythonManifest()
    m.envMeta = { EVIL_KEY: { label: '越界' } }
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
    expect(r.passed).toBe(false)
    expect(vec(r, 'envmeta-lie').ok).toBe(false)
    expect(vec(r, 'envmeta-lie').reason).toContain('envMeta')
    expect(vec(r, 'envmeta-lie').reason).toContain('EVIL_KEY')
  })

  it('缺省：manifest 无 envMeta → pass（旧包向后兼容）', () => {
    const m = validPythonManifest()
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
    expect(r.passed).toBe(true)
    expect(vec(r, 'envmeta-lie').ok).toBe(true)
    expect(r.manifest?.envMeta).toBeUndefined()
  })

  it('envKeys 有而 envMeta 缺某键 → pass（元数据可选）', () => {
    const m = validPythonManifest()
    m.envMeta = { NF_HOST: { label: '主机地址' } }
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
    expect(r.passed).toBe(true)
  })

  it('畸形：envMeta 非 plain object（数组/字符串/null）→ manifest-schema fail', () => {
    for (const evil of [[{ label: 'x' }], 'oops', null]) {
      const m = validPythonManifest()
      m.envMeta = evil as unknown as Record<string, unknown>
      const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
      expect(vec(r, 'manifest-schema').ok, `envMeta=${JSON.stringify(evil)}`).toBe(false)
      expect(r.passed).toBe(false)
    }
  })

  it('畸形：label 非字符串 / required 非布尔 / default 非 / example 非 / description 非 → manifest-schema fail', () => {
    const evils: Array<Record<string, unknown>> = [
      { label: 123 },
      { label: 'ok', required: 'yes' },
      { label: 'ok', default: 443 },
      { label: 'ok', example: true },
      { label: 'ok', description: [] },
    ]
    for (const entry of evils) {
      const m = validPythonManifest()
      m.envMeta = { NF_HOST: entry } as never
      const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
      expect(vec(r, 'manifest-schema').ok, `entry=${JSON.stringify(entry)}`).toBe(false)
    }
  })

  it('畸形：envMeta 键名不匹配 ENV_KEY_RE（数字开头/含连字符）→ manifest-schema fail', () => {
    for (const evilKey of ['1BAD', 'NF-HOST', 'A=B']) {
      const m = validPythonManifest()
      m.envKeys = [...(m.envKeys as string[]), evilKey]
      m.envMeta = { [evilKey]: { label: 'x' } }
      const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
      expect(vec(r, 'manifest-schema').ok, `key=${evilKey}`).toBe(false)
    }
  })

  it('DoS 防护（T-29.1-06）：键数超 100 → manifest-schema fail', () => {
    const m = validNodeManifest()
    m.envKeys = []
    const meta: Record<string, { label: string }> = {}
    for (let i = 0; i < 101; i++) {
      const k = `K${String(i).padStart(3, '0')}`
      m.envKeys.push(k)
      meta[k] = { label: `l${i}` }
    }
    m.envMeta = meta as never
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'main.js': entryContent(m) }))
    expect(vec(r, 'manifest-schema').ok).toBe(false)
  })

  it('DoS 防护（T-29.1-06）：单字符串字段超 2000 字符 → manifest-schema fail', () => {
    const m = validPythonManifest()
    m.envMeta = { NF_HOST: { label: 'a'.repeat(2001) } }
    const r = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m), 'nf_mcp/server.py': entryContent(m) }))
    expect(vec(r, 'manifest-schema').ok).toBe(false)
  })

  it('envMeta 变化 → 全树指纹变化（覆盖导入 diff 可见）', () => {
    const m1 = validPythonManifest()
    m1.envMeta = { NF_HOST: { label: '主机' } }
    const m2 = validPythonManifest()
    m2.envMeta = { NF_HOST: { label: '防火墙主机' } }
    const r1 = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m1), 'nf_mcp/server.py': entryContent(m1) }))
    const r2 = validateMcpb(makeMcpb({ 'manifest.json': manifestFile(m2), 'nf_mcp/server.py': entryContent(m2) }))
    expect(r1.fileTree && r2.fileTree ? buildFingerprintTree(r1.fileTree).treeSha256 : '').not.toBe(
      r2.fileTree ? buildFingerprintTree(r2.fileTree).treeSha256 : ''
    )
  })
})

describe('白例：完整合法包（双轨）', () => {
  it('合法 node 包 → passed=true 且六向量全 ok', () => {
    const m = validNodeManifest()
    const r = validateMcpb(makeMcpb({
      'manifest.json': manifestFile(m),
      'main.js': entryContent(m),
      'lib/util.js': strToU8('module.exports = 1'),
    }))
    expect(r.passed).toBe(true)
    expect(r.vectors).toHaveLength(6)
    expect(r.vectors.every((v) => v.ok)).toBe(true)
    expect(r.manifest?.name).toBe('net-tools')
    expect(r.fileTree?.length).toBe(3)
    expect(r.totalBytes).toBeGreaterThan(0)
  })

  it('合法 python 包（照 nsfocus-nf-mcp 形态）→ passed=true', () => {
    const m = validPythonManifest()
    const r = validateMcpb(makeMcpb({
      'manifest.json': manifestFile(m),
      'nf_mcp/server.py': entryContent(m),
      'nf_mcp/client.py': strToU8('import httpx'),
      'api_spec.json': strToU8('{}'),
    }))
    expect(r.passed).toBe(true)
    expect(r.vectors.every((v) => v.ok)).toBe(true)
    expect(r.manifest?.envKeys).toEqual(['NF_HOST', 'NF_PORT', 'TOKEN'])
  })
})
