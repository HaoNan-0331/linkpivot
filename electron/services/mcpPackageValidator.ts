import { createHash } from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'

/**
 * 设备/配置 env 键名字符集规则（WR-03 单源，29.1 起迁本纯函数层为唯一定义点）：
 * 字母/下划线开头，仅字母数字下划线，≤100 字符。mcpIpc（mcp:save deviceEnvs 通道）/
 * mcpPackageService（createConfigFromPackage）/ 本校验器（envMeta 键名）三处共用同一规则，
 * 防 drift（含 =、控制字符、PATH 覆盖等键名可经宽校验通道写入 buildChildEnv 覆盖 PATH）。
 */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/

/**
 * .mcpb 六向量校验器 + SHA-256 全树指纹（Phase 29 PKG-02 安全核心 + 29.1 envMeta 向量）。
 *
 * 纯函数层：无 DB、无 IPC、无子进程——D-11 明确只做结构检查，
 * 不做静态内容扫描，也绝不执行任何包内代码。
 * 下游消费方：29-03 导入登记 / 29-04 spawn 前重验（防 TOCTOU）。
 */

export interface McpTool {
  name: string
  description: string
  readOnlyHint?: boolean
}

/** envMeta 单键元数据（29.1 D-03：明文元数据，不含 env 值——值通道仍 env_json_enc） */
export interface EnvMetaEntry {
  label: string
  description?: string
  required?: boolean
  example?: string
  default?: string
}

/**
 * 29.1 CR MD-05：envMeta 结构清洗（spawn 强制层消费 manifest_json 前的同构守卫）。
 * manifest 在导入时已过 parseMcpbManifest 六向量结构校验——此处防 DB 篡改/历史坏行
 * 直接进 spawn 合并（required 硬拦 + default 叠加链路）：
 *  - 键名不合法（ENV_KEY_RE）或 entry 非对象 → 整项丢弃
 *  - label/description/example/default 仅保留 string 类型字段；label 缺失兜底键名
 *    （applyEnvMeta 报错文案同款 fallback，人话不丢）
 *  - required 真值收窄为 true（truthy → true，不松于 applyEnvMeta 的 truthy 判定——
 *    fail-closed 方向：篡改值不得让 required 拦截消失）
 * 非 plain object 入参 → undefined（无 envMeta 现状行为，零回归）。
 */
export function sanitizeEnvMeta(v: unknown): Record<string, EnvMetaEntry> | undefined {
  if (!isPlainObject(v)) return undefined
  let out: Record<string, EnvMetaEntry> | undefined
  for (const [k, e] of Object.entries(v)) {
    if (!ENV_KEY_RE.test(k) || !isPlainObject(e)) continue
    const entry: EnvMetaEntry = { label: typeof e.label === 'string' && e.label.length > 0 ? e.label : k }
    if (e.required) entry.required = true
    if (typeof e.description === 'string') entry.description = e.description
    if (typeof e.example === 'string') entry.example = e.example
    if (typeof e.default === 'string') entry.default = e.default
    out ??= {}
    out[k] = entry
  }
  return out
}

export interface McpManifest {
  name: string
  version: string
  runtime: 'node' | 'python'
  entry: string
  models: string[]
  tools: McpTool[]
  envKeys?: string[]
  envMeta?: Record<string, EnvMetaEntry>
}

export interface FileEntry {
  path: string
  content: Uint8Array
}

export interface VectorResult {
  id: 'manifest-schema' | 'entry-whitelist' | 'zip-slip' | 'double-extension' | 'manifest-lie' | 'envmeta-lie'
  ok: boolean
  reason?: string
}

export interface SizeOverride {
  /** 注入的压缩字节数（测试用，D-04 上限触发不真造 200MB） */
  compressedBytes?: number
  /** 注入的解压累计字节数（测试用） */
  uncompressedBytes?: number
}

export interface ValidateResult {
  passed: boolean
  vectors: VectorResult[]
  manifest?: McpManifest
  fileTree?: FileEntry[]
  totalBytes: number
}

/** D-04 双重体积上限：包文件 ≤200MB 且解压后 ≤1GB（防解压炸弹） */
export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024
export const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024

/** D-01 双轨入口白名单 */
const ENTRY_EXT: Record<'node' | 'python', string[]> = {
  node: ['.js', '.mjs', '.cjs'],
  python: ['.py'],
}

/** 双扩展伪装：代码扩展名后跟可执行扩展名（全树扫描，不只 entry） */
const DOUBLE_EXT_RE = /\.(js|mjs|cjs|py)\.(exe|bat|cmd|ps1|scr|com|pif|vbs)$/i

/** 工具名合法字符（manifest-lie 向量：防名字注入） */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * CR-01：包名白名单（manifest-schema 向量）。name 直接参与目录构造与 rmSync(recursive)，
 * 必须字符集白名单——首字符限字母数字（天然拒绝 `.`/`..`/路径分隔符/盘符/NTFS ADS `:`），
 * 其后仅字母数字/点/下划线/连字符。防「包名维度 zip-slip」路径逃逸 + 破坏性删除。
 */
export const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const VECTOR_ORDER: VectorResult['id'][] = [
  'manifest-schema',
  'entry-whitelist',
  'zip-slip',
  'double-extension',
  'manifest-lie',
  'envmeta-lie',
]

/** envMeta DoS 上限（T-29.1-06）：序列化总长 64KB / 键数 100 / 单字符串字段 2000 字符 */
const MAX_ENV_META_BYTES = 64 * 1024
const MAX_ENV_META_KEYS = 100
const MAX_ENV_META_STR = 2000

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i === -1 ? '' : p.slice(i).toLowerCase()
}

function isSafeRelPath(p: string): boolean {
  if (p === '' || p.includes('\\') || p.includes(':')) return false
  if (p.startsWith('/') || p.startsWith('.')) return false
  const segs = p.split('/')
  return segs.every((s) => s !== '' && s !== '.' && s !== '..')
}

/** 解析 manifest.json（畸形 throw，供调用方转人话错误） */
export function parseMcpbManifest(raw: string): McpManifest {
  const obj = JSON.parse(raw) as Record<string, unknown>
  // 注意: 必须用 function 声明——TS 6.0 起 const 箭头函数形式的 never-guard 不再触发 CFA assertion 收窄
  function bad(msg: string): never {
    throw new Error(msg)
  }
  if (typeof obj !== 'object' || obj === null) bad('manifest 不是 JSON 对象')
  for (const k of ['name', 'version', 'entry']) {
    if (typeof obj[k] !== 'string' || (obj[k] as string).length === 0) bad(`manifest.${k} 缺失或不是非空字符串`)
  }
  if (!PKG_NAME_RE.test(obj.name as string)) {
    bad('manifest.name 只允许字母数字开头，且仅含字母数字/点/下划线/连字符（1-100 字符，不得为 . / .. / 含路径分隔符）')
  }
  if (obj.runtime !== 'node' && obj.runtime !== 'python') bad('manifest.runtime 必须是 node 或 python')
  if (!Array.isArray(obj.models) || obj.models.some((x) => typeof x !== 'string')) bad('manifest.models 必须是字符串数组')
  const tools = obj.tools
  if (!Array.isArray(tools) || tools.length === 0) bad('manifest.tools 必须是非空数组')
  for (const t of tools) {
    if (typeof t !== 'object' || t === null) bad('manifest.tools 项必须是对象')
    const tt = t as Record<string, unknown>
    if (typeof tt.name !== 'string' || tt.name.length === 0) bad('manifest.tools 项缺少 name')
    if (typeof tt.description !== 'string' || tt.description.length === 0) bad(`工具 ${String(tt.name)} 缺少 description`)
    if (tt.readOnlyHint !== undefined && typeof tt.readOnlyHint !== 'boolean') bad(`工具 ${String(tt.name)} 的 readOnlyHint 必须是布尔`)
  }
  if (obj.envKeys !== undefined) {
    if (!Array.isArray(obj.envKeys) || obj.envKeys.some((x) => typeof x !== 'string')) bad('manifest.envKeys 必须是字符串数组')
  }
  // 29.1 D-03：envMeta 畸形结构照 envKeys throw 风格拒绝（防投毒哲学，T-29.1-05）
  if (obj.envMeta !== undefined) {
    if (!isPlainObject(obj.envMeta)) bad('manifest.envMeta 必须是对象（键为 env 键名）')
    const keys = Object.keys(obj.envMeta)
    if (keys.length > MAX_ENV_META_KEYS) bad(`manifest.envMeta 键数超过 ${MAX_ENV_META_KEYS} 上限`)
    if (Buffer.byteLength(JSON.stringify(obj.envMeta), 'utf8') > MAX_ENV_META_BYTES) {
      bad(`manifest.envMeta 序列化后超过 ${MAX_ENV_META_BYTES / 1024}KB 上限`)
    }
    for (const k of keys) {
      if (!ENV_KEY_RE.test(k)) bad(`manifest.envMeta 键名 ${k} 不合法（字母/下划线开头，仅含字母数字下划线，≤100 字符）`)
      const e = obj.envMeta[k]
      if (!isPlainObject(e)) bad(`manifest.envMeta.${k} 必须是对象`)
      if (typeof e.label !== 'string' || e.label.length === 0) bad(`manifest.envMeta.${k}.label 必须是非空字符串`)
      for (const f of ['description', 'example', 'default'] as const) {
        if (e[f] !== undefined && typeof e[f] !== 'string') bad(`manifest.envMeta.${k}.${f} 必须是字符串`)
      }
      if (e.required !== undefined && typeof e.required !== 'boolean') bad(`manifest.envMeta.${k}.required 必须是布尔`)
      for (const f of ['label', 'description', 'example', 'default'] as const) {
        if (typeof e[f] === 'string' && (e[f] as string).length > MAX_ENV_META_STR) {
          bad(`manifest.envMeta.${k}.${f} 超过 ${MAX_ENV_META_STR} 字符上限`)
        }
      }
    }
  }
  const manifest: McpManifest = {
    name: obj.name as string,
    version: obj.version as string,
    runtime: obj.runtime as 'node' | 'python',
    entry: obj.entry as string,
    models: obj.models as string[],
    tools: (obj.tools as McpTool[]).map((t) => ({
      name: t.name,
      description: t.description,
      ...(t.readOnlyHint !== undefined ? { readOnlyHint: t.readOnlyHint } : {}),
    })),
    ...(Array.isArray(obj.envKeys) ? { envKeys: obj.envKeys as string[] } : {}),
    ...(isPlainObject(obj.envMeta) ? { envMeta: obj.envMeta as Record<string, EnvMetaEntry> } : {}),
  }
  return manifest
}

/**
 * .mcpb 五向量校验。buffer 为 zip 字节；sizeOverride 仅供测试注入 D-04 上限。
 * 前序 fail 可短路后续，但 vectors 数组仍逐项给出已检结果（未检项 ok=true 无 reason
 * 约定不可取——未检项标记 ok=true 且无 reason，UI 只展示 fail 项）。
 */
export function validateMcpb(buffer: Buffer | Uint8Array, sizeOverride?: SizeOverride): ValidateResult {
  const vectors: VectorResult[] = []
  const push = (id: VectorResult['id'], ok: boolean, reason?: string) => vectors.push({ id, ok, ...(ok || !reason ? {} : { reason }) })
  const compressedBytes = sizeOverride?.compressedBytes ?? buffer.byteLength
  let totalBytes = 0
  let manifest: McpManifest | undefined
  let fileTree: FileEntry[] | undefined

  // 尺寸前置（D-04）：超限直接逐项短路（解压都不做，防炸弹从源头拒绝）
  if (compressedBytes > MAX_PACKAGE_BYTES) {
    const reason = `包文件体积 ${(compressedBytes / 1024 / 1024).toFixed(0)}MB 超过 200MB 上限`
    for (const id of VECTOR_ORDER) push(id, false, id === 'manifest-schema' ? reason : `${reason}，后续校验未执行`)
    return { passed: false, vectors, totalBytes: compressedBytes }
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(buffer, {
      filter: () => true,
    })
  } catch {
    const reason = '不是有效的 zip 格式（无法解压）'
    for (const id of VECTOR_ORDER) push(id, false, id === 'manifest-schema' ? reason : `${reason}，后续校验未执行`)
    return { passed: false, vectors, totalBytes: compressedBytes }
  }

  fileTree = Object.entries(entries).map(([path, content]) => ({ path, content }))
  totalBytes = sizeOverride?.uncompressedBytes ?? fileTree.reduce((s, f) => s + f.content.byteLength, 0)
  if (totalBytes > MAX_EXTRACTED_BYTES) {
    const reason = `解压后总尺寸 ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)}GB 超过 1GB 上限（疑似解压炸弹）`
    for (const id of VECTOR_ORDER) push(id, false, id === 'manifest-schema' ? reason : `${reason}，后续校验未执行`)
    return { passed: false, vectors, fileTree, totalBytes }
  }

  // 向量一：manifest-schema
  let schemaOk = false
  const mfEntry = fileTree.find((f) => f.path === 'manifest.json')
  if (!mfEntry) {
    push('manifest-schema', false, '缺少 manifest.json（包内未找到该文件）')
  } else {
    try {
      manifest = parseMcpbManifest(strFromU8(mfEntry.content))
      schemaOk = true
      push('manifest-schema', true)
    } catch (e) {
      push('manifest-schema', false, e instanceof Error ? e.message : 'manifest.json 解析失败')
    }
  }

  // 向量二：entry-whitelist（D-01 双轨）
  let entryOk = false
  if (!manifest) {
    push('entry-whitelist', false, 'manifest 无效，入口类型无法校验')
  } else {
    const allowed = ENTRY_EXT[manifest.runtime]
    if (!allowed.includes(extOf(manifest.entry))) {
      push('entry-whitelist', false, `runtime=${manifest.runtime} 的入口只接受 ${allowed.join('/')}，实际为 ${manifest.entry}`)
    } else {
      entryOk = true
      push('entry-whitelist', true)
    }
  }

  // 向量三：zip-slip（逐条目路径检查：绝对路径/盘符/反斜杠/../.. 段全拒）
  const unsafePaths = fileTree.map((f) => f.path).filter((p) => !isSafeRelPath(p))
  if (unsafePaths.length > 0) {
    push('zip-slip', false, `包内存在逃逸路径（绝对路径/反斜杠/.. 逃逸）：${unsafePaths.slice(0, 3).join('、')}`)
  } else {
    push('zip-slip', true)
  }

  // 向量四：double-extension（全树扫描，不只 entry）
  const disguised = fileTree.map((f) => f.path).filter((p) => DOUBLE_EXT_RE.test(p.split('/').pop() ?? ''))
  if (disguised.length > 0) {
    push('double-extension', false, `包内存在双扩展伪装可执行文件：${disguised.slice(0, 3).join('、')}`)
  } else {
    push('double-extension', true)
  }

  // 向量五：manifest-lie（声明必须命中实际内容）
  if (!manifest || !schemaOk || !entryOk) {
    push('manifest-lie', false, '前序校验未通过，manifest 与实际内容的一致性无法校验')
  } else {
    const entryPath = manifest.entry.replace(/\\/g, '/')
    const entryExists = fileTree.some((f) => f.path === entryPath)
    const badTools = manifest.tools.filter((t) => !TOOL_NAME_RE.test(t.name)).map((t) => t.name)
    if (!entryExists) {
      push('manifest-lie', false, `manifest 声明的入口 ${manifest.entry} 在包内不存在`)
    } else if (badTools.length > 0) {
      push('manifest-lie', false, `工具名含非法字符（只允许字母数字下划线连字符，最长 64）：${badTools.join('、')}`)
    } else {
      push('manifest-lie', true)
    }
  }

  // 向量六：envmeta-lie（29.1 D-03：envMeta 键集必须 ⊆ envKeys——越界键 = 谎报向量）
  if (!manifest || !schemaOk) {
    push('envmeta-lie', false, '前序校验未通过，envMeta 键集一致性无法校验')
  } else if (manifest.envMeta) {
    const envKeys = manifest.envKeys ?? []
    const outOfBounds = Object.keys(manifest.envMeta).filter((k) => !envKeys.includes(k))
    if (outOfBounds.length > 0) {
      push('envmeta-lie', false, `manifest.envMeta 含 envKeys 之外的键（越界元数据谎报）：${outOfBounds.slice(0, 3).join('、')}`)
    } else {
      push('envmeta-lie', true)
    }
  } else {
    // 缺省 envMeta 合法（旧包向后兼容）；envKeys 有而 envMeta 缺某键也合法（元数据可选）
    push('envmeta-lie', true)
  }

  return {
    passed: vectors.every((v) => v.ok),
    vectors,
    ...(manifest && schemaOk ? { manifest } : {}),
    ...(fileTree ? { fileTree } : {}),
    totalBytes,
  }
}

/**
 * 指纹排除清单（29-09 走查三，单源规则）：Python 运行时字节码缓存是解释器首跑后
 * 自动生成的磁盘产物（zip 内可不含、磁盘必然长出），不属于「包内容被篡改」信号。
 * 导入侧（buildFingerprintTree）与重验侧（mcpClient.collectDirFiles）必须消费同一
 * 过滤函数——禁止两处各写一份解析（同 commandSafety/privilegeGuard 单源哲学）。
 */
export const FINGERPRINT_EXCLUDE: readonly string[] = ['__pycache__/', '*.pyc', '*.pyo']

/** 指纹排除判定：路径任一段为 __pycache__，或后缀 .pyc/.pyo（posix 归一后判定） */
export function isFingerprintExcluded(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/')
  if (p.split('/').some((s) => s === '__pycache__')) return true
  return p.endsWith('.pyc') || p.endsWith('.pyo')
}

/**
 * 全树 SHA-256 指纹（D-27）：文件按 posix 相对路径字典序排序，逐文件哈希，
 * 再对「path+sha256」清单整体哈希得 treeSha256。同树同哈希、异树必异（排序保确定性）。
 * 排除清单内条目（__pycache__/pyc/pyo）不进指纹——导入与重验双侧同源过滤，
 * 保证未篡改包首跑后磁盘长出字节码缓存仍重验通过（对称性）。
 */
export function buildFingerprintTree(fileTree: FileEntry[]): { files: Array<{ path: string; sha256: string }>; treeSha256: string } {
  const files = [...fileTree]
    .filter((f) => !isFingerprintExcluded(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, sha256: createHash('sha256').update(f.content).digest('hex') }))
  const manifestText = files.map((f) => `${f.path}${f.sha256}`).join('\n')
  return { files, treeSha256: createHash('sha256').update(manifestText).digest('hex') }
}
