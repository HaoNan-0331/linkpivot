/**
 * McpPackageService —— Phase 29 包生命周期 service（29-03，PKG-01/02/03/06）。
 *
 * 职责：导入登记（校验+落盘+指纹，D-12）/ 重导入覆盖（指纹比对+env 键交集，D-23/D-24）/
 * 删包级联（先杀进程→事务三表清净→删目录，D-30）/ 删除影响面查询 / 自动测（D-14，D-25）。
 *
 * 形态：静态类 facade（mcpService 同款骨架）。
 *  - _setDbGetter 测试注入口；_setRootGetter 注入包根目录（生产= userData/mcp-packages/）
 *  - MK 仅为 confirmOverwrite 的 rel 行 env_json_enc 键剔除服务（encField/decField 红线，
 *    零裸 encrypt/decrypt），由 main.ts 经 setMcpPackageMasterKey() 注入
 *
 * 安全红线：
 *  - T-29-03-01 落盘只写校验器（29-01 五向量）已过的条目 + 写出前二次路径守卫 + 目标限定
 *    root/{name}/；fflate unzipSync 不还原符号链接条目（zip mode 位被忽略），双保险见 writePackageFiles
 *  - T-29-03-02 体积上限：校验器 200MB/1GB 双重拦截（网关层另有同值上限）
 *  - T-29-03-03 confirmOverwrite 事务内零 rel DELETE——只 UPDATE env_json_enc 剔除被删键
 *  - T-29-03-05 deletePackage 先 McpProcessRegistry 杀该包全部运行实例再级联删
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { app } from 'electron'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { validateMcpb, buildFingerprintTree, isFingerprintExcluded, MAX_PACKAGE_BYTES, ENV_KEY_RE } from './mcpPackageValidator'
import { MAX_BATCH } from './mcpService'
import type { McpManifest, FileEntry, VectorResult, EnvMetaEntry } from './mcpPackageValidator'
import { testConnection, verifyPackageFingerprint, reportPackageIntegrityFailure, resolvePackageSpawn } from './mcpClient'
import type { McpTestResult, StageCallback } from './mcpClient'
import { McpToolPolicy } from './mcpToolPolicy'
import type { McpToolAnnotations } from './mcpToolPolicy'
import { McpProcessRegistry } from './mcpProcessRegistry'

/** manifest.name 长度上限（网关与 service 同源，D-05 包身份健壮性） */
export const MAX_PKG_NAME_LENGTH = 100

/**
 * 设备/配置 env 键名字符集规则（WR-03 单源）：字母/下划线开头，仅字母数字下划线，≤100 字符。
 * 29.1 起唯一定义点迁 mcpPackageValidator（纯函数层，envMeta 键名校验同源消费），此处转发导出
 * 保持 mcpIpc / createConfigFromPackage 既有 import 路径不变（mcp:createConfigFromPackage 与
 * mcp:save deviceEnvs 两通道共用同一规则，防 drift——含 =、控制字符、PATH 覆盖等键名可经宽
 * 校验通道写入 buildChildEnv 覆盖 PATH）。
 */
export { ENV_KEY_RE } from './mcpPackageValidator'
/** 29.1 D-03/D-04：envMeta 单键元数据类型（唯一定义点 validator，此处转发导出） */
export type { EnvMetaEntry } from './mcpPackageValidator'

export interface EnvKeysDiff {
  kept: string[]
  added: string[]
  removed: string[]
}

/** D-23 覆盖确认弹窗直接消费的比对数据 */
export interface PackageReimportDiff {
  oldVersion: string
  newVersion: string
  oldTreeSha256: string
  newTreeSha256: string
  toolsAdded: string[]
  toolsRemoved: string[]
  env: EnvKeysDiff
}

/** 自动测结果（mcp_packages.last_test JSON 形态，29-02 v27 已建列） */
export interface PackageLastTest {
  stage: string
  ok: boolean
  reason?: string
  /** PKG-04/D-25：实测多出的工具 = 默认禁用清单（29-04 消费端二次过滤） */
  extraTools: string[]
  missingTools: string[]
  testedAt: string
}

/** IPC 出口投影：包级本无 env 值，仅 envKeys 名单 + envMeta 明文元数据（无明文可泄） */
export interface McpPackageView {
  id: number
  name: string
  version: string | null
  runtime: 'node' | 'python'
  entry: string
  models: string[]
  toolCount: number
  envKeys: string[]
  /** 29.1 D-04：与 envKeys 同源解 manifest_json（杜绝 env_meta 列与 manifest 两处不一致）；坏 JSON 降级 {} */
  envMeta: Record<string, EnvMetaEntry>
  dirPath: string
  sizeBytes: number
  disabled: boolean
  lastTest: PackageLastTest | null
  createdAt: string
  updatedAt: string
}

export interface McpPackageDetail extends McpPackageView {
  manifest: McpManifest
  fingerprintTreeSha256: string
  fingerprintFiles: Array<{ path: string; sha256: string }>
}

export type ImportOutcome =
  | { ok: false; error: string; vectors?: VectorResult[] }
  | { ok: true; status: 'imported'; package: McpPackageView }
  | { ok: true; status: 'exists'; package: McpPackageView }
  | { ok: true; status: 'changed'; package: McpPackageView; diff: PackageReimportDiff }

export type OverwriteOutcome =
  | { ok: false; error: string; vectors?: VectorResult[] }
  | { ok: true; status: 'overwritten'; package: McpPackageView; diff: PackageReimportDiff }
  | { ok: true; status: 'exists'; package: McpPackageView }

export class McpPackageService {
  private static MK = ''

  static setMcpPackageMasterKey(key: string): void {
    McpPackageService.MK = key
  }

  private static dbGetter: () => Database.Database = getDatabase

  /** @internal 测试专用：注入 db getter。 */
  static _setDbGetter(fn: () => Database.Database): void {
    McpPackageService.dbGetter = fn
  }

  /** 包根目录（生产 = userData/mcp-packages；ELECTRON_RUN_AS_NODE 下 app 不可用时退 tmpdir，测试必注入） */
  private static rootGetter: () => string = () => {
    const a = app as unknown as { getPath?: (n: string) => string } | undefined
    try {
      const base = a?.getPath?.('userData') ?? tmpdir()
      return join(base, 'mcp-packages')
    } catch {
      return join(tmpdir(), 'mcp-packages')
    }
  }

  /** @internal 测试专用：注入包根目录。 */
  static _setRootGetter(fn: () => string): void {
    McpPackageService.rootGetter = fn
  }

  private static db(): Database.Database {
    return McpPackageService.dbGetter()
  }

  // -------------------------------------------------------------------
  // 出口投影
  // -------------------------------------------------------------------

  private static parseManifestSafe(raw: string): McpManifest | null {
    try {
      const m = JSON.parse(raw) as McpManifest
      return m && typeof m === 'object' ? m : null
    } catch {
      return null
    }
  }

  private static parseLastTestSafe(raw: string | null | undefined): PackageLastTest | null {
    if (!raw) return null
    try {
      const t = JSON.parse(raw) as PackageLastTest
      return t && typeof t === 'object' && typeof t.ok === 'boolean' ? t : null
    } catch {
      return null
    }
  }

  private static rowToView(row: any): McpPackageView {
    const manifest = McpPackageService.parseManifestSafe(row.manifest_json)
    return {
      id: row.id,
      name: row.name,
      version: row.version ?? null,
      runtime: row.runtime,
      entry: row.entry,
      models: manifest?.models ?? [],
      toolCount: manifest?.tools?.length ?? 0,
      envKeys: manifest?.envKeys ?? [],
      envMeta: manifest?.envMeta ?? {},
      dirPath: row.dir_path,
      sizeBytes: row.size_bytes,
      disabled: !!row.disabled,
      lastTest: McpPackageService.parseLastTestSafe(row.last_test),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private static rowToDetail(row: any): McpPackageDetail {
    let files: Array<{ path: string; sha256: string }> = []
    try {
      files = JSON.parse(row.fingerprint_json).files ?? []
    } catch {
      // 坏 JSON 降级空清单（指纹主列 fingerprint 仍在）
    }
    return {
      ...McpPackageService.rowToView(row),
      manifest: McpPackageService.parseManifestSafe(row.manifest_json) as McpManifest,
      fingerprintTreeSha256: row.fingerprint,
      fingerprintFiles: files,
    }
  }

  // -------------------------------------------------------------------
  // 落盘（T-29-03-01）
  // -------------------------------------------------------------------

  /** 解压前二次路径守卫：校验器已拒逃逸路径，此处兜底再核（防未来校验器回归） */
  private static assertSafeEntryPath(p: string): void {
    const bad = p === '' || p.includes('\\') || p.includes(':') || p.startsWith('/') ||
      p.split('/').some((s) => !s || s === '.' || s === '..')
    if (bad) throw new Error(`包内路径不安全，拒绝落盘：${p}`)
  }

  private static writePackageFiles(dir: string, fileTree: FileEntry[]): void {
    rmSync(dir, { recursive: true, force: true })
    for (const f of fileTree) {
      // 指纹排除条目（__pycache__/pyc/pyo）不落盘——磁盘树与指纹树保持同集，
      // 且包携带的陈旧字节码缓存不进现场（解释器首跑会自行重建）
      if (isFingerprintExcluded(f.path)) continue
      McpPackageService.assertSafeEntryPath(f.path)
      const target = join(dir, ...f.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.content)
    }
  }

  /**
   * CR-01 纵深防御（第二道闸，独立于校验器）：所有 rmSync/join(root, name) 落点前置校验——
   * 目录 resolve 后必须严格位于包根目录之下（等于根也拒绝），否则拒绝操作。
   * 覆盖 importPackage / confirmOverwrite / deletePackage 全部破坏性路径，防校验器回归。
   */
  private static unsafePackageDirError(dir: string): string | null {
    const root = resolve(McpPackageService.rootGetter())
    const abs = resolve(dir)
    if (abs === root || !abs.startsWith(root + sep)) {
      return `包目录路径不安全（逃逸包根目录），拒绝操作：${dir}`
    }
    return null
  }

  // -------------------------------------------------------------------
  // 导入 / 覆盖族（Task 1）
  // -------------------------------------------------------------------

  /**
   * 导入登记（D-12：登记包模板，不产生配置不绑设备）。
   * 同名同指纹幂等 exists；同名异指纹 changed+diff 不落库（等 confirmOverwrite）。
   */
  static importPackage(buffer: Uint8Array): ImportOutcome {
    const v = validateMcpb(buffer)
    if (!v.passed || !v.manifest || !v.fileTree) {
      const failed = v.vectors.filter((x) => !x.ok)
      return { ok: false, error: `包校验未通过：${failed.map((f) => f.reason ?? f.id).join('；')}`, vectors: v.vectors }
    }
    const manifest = v.manifest
    if (manifest.name.length > MAX_PKG_NAME_LENGTH) {
      return { ok: false, error: `包名超过 ${MAX_PKG_NAME_LENGTH} 字符上限` }
    }
    if (buffer.byteLength > MAX_PACKAGE_BYTES) {
      return { ok: false, error: '包文件体积超过 200MB 上限' }
    }
    const fp = buildFingerprintTree(v.fileTree)
    const conn = McpPackageService.db()
    const existing = conn.prepare('SELECT * FROM mcp_packages WHERE name = ?').get(manifest.name) as any
    if (existing) {
      if (existing.fingerprint === fp.treeSha256) {
        return { ok: true, status: 'exists', package: McpPackageService.rowToView(existing) }
      }
      const diff = McpPackageService.buildDiff(
        McpPackageService.parseManifestSafe(existing.manifest_json), existing.fingerprint, existing.version,
        manifest, fp.treeSha256
      )
      return { ok: true, status: 'changed', package: McpPackageService.rowToView(existing), diff }
    }
    const dir = join(McpPackageService.rootGetter(), manifest.name)
    // CR-01 纵深防御：落盘前 resolve 前缀守卫（校验器白名单之外的第二道闸）
    const unsafe = McpPackageService.unsafePackageDirError(dir)
    if (unsafe) return { ok: false, error: unsafe }
    McpPackageService.writePackageFiles(dir, v.fileTree)
    try {
      conn.prepare(
        `INSERT INTO mcp_packages (name, version, runtime, entry, manifest_json, env_meta, fingerprint, fingerprint_json, dir_path, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(manifest.name, manifest.version, manifest.runtime, manifest.entry,
        JSON.stringify(manifest), manifest.envMeta ? JSON.stringify(manifest.envMeta) : null,
        fp.treeSha256, JSON.stringify(fp), dir, v.totalBytes)
    } catch (e) {
      // WR-04：DB 落库失败（如并发同名 UNIQUE 兜底触发）补偿删除孤儿目录，防磁盘/DB 不一致
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
    const row = conn.prepare('SELECT * FROM mcp_packages WHERE name = ?').get(manifest.name) as any
    return { ok: true, status: 'imported', package: McpPackageService.rowToView(row) }
  }

  /** reimport 与 import 同链路（IPC 层 mcp:reimportPackage 别名消费） */
  static reimportPackage(buffer: Uint8Array): ImportOutcome {
    return McpPackageService.importPackage(buffer)
  }

  private static buildDiff(
    oldManifest: McpManifest | null, oldTreeSha256: string, oldVersion: string | null,
    newManifest: McpManifest, newTreeSha256: string
  ): PackageReimportDiff {
    const oldEnv = oldManifest?.envKeys ?? []
    const newEnv = newManifest.envKeys ?? []
    const oldTools = (oldManifest?.tools ?? []).map((t) => t.name)
    const newTools = newManifest.tools.map((t) => t.name)
    return {
      oldVersion: oldVersion ?? '',
      newVersion: newManifest.version,
      oldTreeSha256,
      newTreeSha256,
      toolsAdded: newTools.filter((t) => !oldTools.includes(t)),
      toolsRemoved: oldTools.filter((t) => !newTools.includes(t)),
      env: {
        kept: oldEnv.filter((k) => newEnv.includes(k)),
        added: newEnv.filter((k) => !oldEnv.includes(k)),
        removed: oldEnv.filter((k) => !newEnv.includes(k)),
      },
    }
  }

  /**
   * 确认覆盖（D-23/D-24）：替换包目录文件 + 更新指纹/manifest/version；
   * mcp_configs 绑定原样保留（事务内零 rel DELETE，T-29-03-03）；
   * env 键删除 → 各 rel 行 env_json_enc 剔除对应键（交集保留）。
   */
  static confirmOverwrite(packageId: number, buffer: Uint8Array): OverwriteOutcome {
    const conn = McpPackageService.db()
    const existing = conn.prepare('SELECT * FROM mcp_packages WHERE id = ?').get(packageId) as any
    if (!existing) return { ok: false, error: '包不存在或已被删除' }
    const v = validateMcpb(buffer)
    if (!v.passed || !v.manifest || !v.fileTree) {
      const failed = v.vectors.filter((x) => !x.ok)
      return { ok: false, error: `包校验未通过：${failed.map((f) => f.reason ?? f.id).join('；')}`, vectors: v.vectors }
    }
    const manifest = v.manifest
    if (manifest.name !== existing.name) {
      return { ok: false, error: `包名不一致（现库 ${existing.name}，导入包 ${manifest.name}）——同名即同包，请改名后重新打包` }
    }
    const fp = buildFingerprintTree(v.fileTree)
    if (fp.treeSha256 === existing.fingerprint) {
      return { ok: true, status: 'exists', package: McpPackageService.rowToView(existing) }
    }
    const diff = McpPackageService.buildDiff(
      McpPackageService.parseManifestSafe(existing.manifest_json), existing.fingerprint, existing.version,
      manifest, fp.treeSha256
    )

    // CR-01 纵深防御：换目录前 resolve 前缀守卫（dir_path 来自 DB 行，防持久化二次触发）
    const unsafe = McpPackageService.unsafePackageDirError(existing.dir_path)
    if (unsafe) return { ok: false, error: unsafe }

    // 1) WR-04：新内容先写包根下临时目录，DB 事务成功后再原子换入——
    //    事务失败时磁盘零变动（旧内容原样），不再出现「磁盘已新、DB 旧指纹」的不一致窗口
    const tmpDir = join(McpPackageService.rootGetter(), `.overwrite-${packageId}-${Date.now()}`)
    McpPackageService.writePackageFiles(tmpDir, v.fileTree)

    // 2) DB 事务：rel 行 env 键剔除 + 主表更新
    try {
      conn.transaction((): void => {
      const removedKeys = diff.env.removed
      if (removedKeys.length > 0) {
        const stmtRel = conn.prepare(
          `SELECT rel.id AS relId, rel.env_json_enc AS enc FROM mcp_device_rel rel
           JOIN mcp_configs c ON c.id = rel.mcp_config_id
           WHERE c.package_id = ? AND rel.env_json_enc IS NOT NULL`
        )
        const stmtUpd = conn.prepare('UPDATE mcp_device_rel SET env_json_enc = ? WHERE id = ?')
        for (const r of stmtRel.all(packageId) as Array<{ relId: string; enc: string }>) {
          const dec = decField(r.enc, McpPackageService.MK)
          if (!dec) continue // 坏密文跳过（decField 失败已走 setDecryptFailureHandler）
          try {
            const env = JSON.parse(dec) as Record<string, string>
            if (!env || typeof env !== 'object') continue
            let changed = false
            for (const k of removedKeys) {
              if (k in env) {
                delete env[k]
                changed = true
              }
            }
            if (changed) stmtUpd.run(encField(JSON.stringify(env), McpPackageService.MK), r.relId)
          } catch {
            // 坏 JSON 跳过该行（交集语义降级为不动）
          }
        }
      }
      conn.prepare(
        `UPDATE mcp_packages SET version = ?, runtime = ?, entry = ?, manifest_json = ?, env_meta = ?, fingerprint = ?,
         fingerprint_json = ?, size_bytes = ?, last_test = NULL, updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(manifest.version, manifest.runtime, manifest.entry, JSON.stringify(manifest),
        manifest.envMeta ? JSON.stringify(manifest.envMeta) : null,
        fp.treeSha256, JSON.stringify(fp), v.totalBytes, packageId)
      })()
    } catch (e) {
      // WR-04：事务失败补偿——清临时目录，磁盘保持旧内容（DB 已随事务 ROLLBACK）
      rmSync(tmpDir, { recursive: true, force: true })
      throw e
    }

    // 3) 换盘前先杀该包全部运行实例（WR-02，复用 deletePackage 树杀路径——Windows
    //    运行中 node.exe/python.exe 持句柄，rmSync 会 EBUSY/EPERM → DB 新指纹/磁盘
    //    旧内容不一致 → 包被 TOCTOU 重验自动禁用）
    const ownIds = new Set(
      (conn.prepare('SELECT id FROM mcp_configs WHERE package_id = ?')
        .all(packageId) as Array<{ id: number }>).map((r) => String(r.id))
    )
    for (const rec of McpProcessRegistry.listActive()) {
      if (ownIds.has(String(rec.configId).split(':')[0])) McpProcessRegistry.killTree(rec.pid)
    }
    // 4) 换入：删旧目录 → 临时目录同卷 rename 到位（旧内容 → 新内容近原子替换）；
    //    失败补偿：旧目录改名 .stale-<id>-<ts> 隔离后再试换入（rmSync 半删/残留句柄场景），
    //    仍失败则抛错（DB 指纹已是新值、磁盘未换入——下次 spawn TOCTOU 检出即禁用，fail-closed）
    try {
      rmSync(existing.dir_path, { recursive: true, force: true })
      renameSync(tmpDir, existing.dir_path)
    } catch {
      const staleDir = join(McpPackageService.rootGetter(), `.stale-${packageId}-${Date.now()}`)
      try {
        renameSync(existing.dir_path, staleDir)
      } catch { /* 旧目录已删净或同样被占——继续尝试换入新目录 */ }
      try {
        renameSync(tmpDir, existing.dir_path)
      } catch (e2) {
        console.warn(
          `[mcpPackage] confirmOverwrite 换盘失败（DB 指纹已更新、磁盘未换入，下次 spawn 将 TOCTOU 检出并禁用包，请重新覆盖导入）：`,
          (e2 as Error).message
        )
        throw e2
      }
    }
    const row = conn.prepare('SELECT * FROM mcp_packages WHERE id = ?').get(packageId) as any
    return { ok: true, status: 'overwritten', package: McpPackageService.rowToView(row), diff }
  }

  static listPackages(): McpPackageView[] {
    const rows = McpPackageService.db().prepare('SELECT * FROM mcp_packages ORDER BY id').all() as any[]
    return rows.map((r) => McpPackageService.rowToView(r))
  }

  static getPackage(id: number): McpPackageDetail | null {
    const row = McpPackageService.db().prepare('SELECT * FROM mcp_packages WHERE id = ?').get(id) as any
    return row ? McpPackageService.rowToDetail(row) : null
  }

  // -------------------------------------------------------------------
  // 删包 / 影响面 / 自动测族（Task 1b）
  // -------------------------------------------------------------------

  /** D-30 删除确认清单数据：将删配置（含各绑定设备数）/ 将解绑设备数 / 包目录路径 */
  static getPackageDeleteImpact(packageId: number): {
    configs: Array<{ id: number; name: string; deviceCount: number }>
    totalDevices: number
    dirPath: string
  } | null {
    const conn = McpPackageService.db()
    const row = conn.prepare('SELECT dir_path FROM mcp_packages WHERE id = ?').get(packageId) as any
    if (!row) return null
    const cfgs = conn.prepare(
      `SELECT c.id AS id, c.name AS name, COUNT(rel.device_id) AS deviceCount
       FROM mcp_configs c LEFT JOIN mcp_device_rel rel ON rel.mcp_config_id = c.id
       WHERE c.package_id = ? GROUP BY c.id ORDER BY c.id`
    ).all(packageId) as Array<{ id: number; name: string; deviceCount: number }>
    return {
      configs: cfgs,
      totalDevices: cfgs.reduce((s, c) => s + c.deviceCount, 0),
      dirPath: row.dir_path,
    }
  }

  /**
   * 删包（D-30，T-29-03-05）：先 McpProcessRegistry 杀该包全部运行实例
   * （按 包→配置→实例反查，只杀本包 configId 对应 pid）→ 事务级联删
   * rel/configs/packages → 事务外 fs.rm 包目录。
   */
  static deletePackage(packageId: number): { ok: true } | { ok: false; error: string } {
    const conn = McpPackageService.db()
    const row = conn.prepare('SELECT * FROM mcp_packages WHERE id = ?').get(packageId) as any
    if (!row) return { ok: false, error: '包不存在或已被删除' }
    // CR-01 纵深防御：rmSync 前置 resolve 前缀守卫——dir_path 逃逸包根即整体拒绝
    // （DB 行被篡改的形态；不执行任何破坏性动作，由用户人工核查）
    const unsafe = McpPackageService.unsafePackageDirError(row.dir_path)
    if (unsafe) return { ok: false, error: unsafe }

    // 1) 杀该包全部运行实例（登记键=复合键 `${configId}:${deviceId}`（29-04 D-18）——取 ':' 前
    //    configId 段比对，设备级多实例一并树杀；只杀本包配置对应的 pid）
    const stmtCfgIds = conn.prepare('SELECT id FROM mcp_configs WHERE package_id = ?')
    const ownConfigIds = new Set((stmtCfgIds.all(packageId) as Array<{ id: number }>).map((r) => String(r.id)))
    for (const rec of McpProcessRegistry.listActive()) {
      if (ownConfigIds.has(String(rec.configId).split(':')[0])) McpProcessRegistry.killTree(rec.pid)
    }

    // 2) 事务级联四表清净（mcp_device_rel 经 mcp_configs FK CASCADE，显式删防 FK 关闭路径；
    //    v29 D-05/D-06：包级策略行 mcp_tools WHERE package_id 随删包清理，T-29.1-09 防孤儿行）
    conn.transaction((): void => {
      conn.prepare(
        'DELETE FROM mcp_device_rel WHERE mcp_config_id IN (SELECT id FROM mcp_configs WHERE package_id = ?)'
      ).run(packageId)
      conn.prepare('DELETE FROM mcp_tools WHERE package_id = ?').run(packageId)
      conn.prepare('DELETE FROM mcp_configs WHERE package_id = ?').run(packageId)
      conn.prepare('DELETE FROM mcp_packages WHERE id = ?').run(packageId)
    })()

    // 3) 事务外删文件目录
    rmSync(row.dir_path, { recursive: true, force: true })
    return { ok: true }
  }

  /**
   * 自动测（D-14）：spawn + 握手 + listTools 与 manifest.tools 名字集合比对。
   *  - node 轨道：command='node' args=[entry 绝对路径]——resolveStdioCommand 三路径分流
   *    自带 process.execPath + ELECTRON_RUN_AS_NODE 兜底（D-03 现场无需装 node）
   *  - python 轨道：包内嵌 python.exe（python/python.exe 或 python.exe）；未内嵌时
   *    结构化失败落 last_test（spawn 细化归 29-04）
   *  - PKG-04/D-25：多出工具 = extraTools 落 last_test（默认禁用清单，29-04 消费端
   *    二次过滤不入工具缓存可用集）；少了仅提示 missingTools。
   * env：包级无 env 值（设备级才有，29-06），自动测以空 env 起——依赖 env 的 server
   * 可能握手失败，失败 reason 落 last_test 供诊断。
   */
  static async testPackage(packageId: number, opts?: {
    testId?: string
    onStage?: (stage: 'starting' | 'handshake' | 'listing', elapsedMs: number) => void
  }): Promise<{ ok: boolean; error?: string; extraTools?: string[]; missingTools?: string[] }> {
    const conn = McpPackageService.db()
    const row = conn.prepare('SELECT * FROM mcp_packages WHERE id = ?').get(packageId) as any
    if (!row) return { ok: false, error: '包不存在或已被删除' }
    const manifest = McpPackageService.parseManifestSafe(row.manifest_json)
    if (!manifest) return { ok: false, error: '包 manifest 元数据损坏' }

    const testedAt = new Date().toISOString()
    const writeLastTest = (t: PackageLastTest): void => {
      conn.prepare(
        "UPDATE mcp_packages SET last_test = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(JSON.stringify(t), packageId)
    }

    // WR-01：与 getConnection spawn 路径同源守卫——disabled 门 + TOCTOU 指纹重验，
    // 防「重测」按钮成为绕过 29-04 红线的包内代码执行入口
    if (row.disabled) {
      return { ok: false, error: '包已被禁用（TOCTOU 检出后需重新导入校验），不能自动测试' }
    }
    try {
      verifyPackageFingerprint(row.dir_path, row.fingerprint_json)
    } catch (e) {
      const reason = (e as { reason?: string }).reason ?? '包指纹重验失败（TOCTOU 检出）'
      if ((e as { code?: string })?.code === 'package_integrity_failed') {
        // 同款副作用：禁用包（重新导入走完整校验链才能恢复）+ 经注入 handler 留 security 日志
        try {
          conn.prepare(
            "UPDATE mcp_packages SET disabled = 1, updated_at = datetime('now','localtime') WHERE id = ?"
          ).run(packageId)
        } catch { /* 禁用失败不吞主线错误 */ }
        try {
          reportPackageIntegrityFailure({ packageId, dirPath: row.dir_path, detail: reason })
        } catch { /* handler 故障不吞主线错误 */ }
      }
      writeLastTest({ stage: 'starting', ok: false, reason, extraTools: [], missingTools: [], testedAt })
      return { ok: false, error: reason }
    }

    const entryAbs = join(row.dir_path, ...manifest.entry.replace(/\\/g, '/').split('/'))
    let commandOrUrl: string
    let args: string[]
    if (manifest.runtime === 'python') {
      const pyCandidates = ['python/python.exe', 'python.exe']
        .map((rel) => join(row.dir_path, ...rel.split('/')))
      const py = pyCandidates.find((p) => existsSyncSafe(p))
      if (!py) {
        const reason = '包内未找到内嵌嵌入式 Python（python/python.exe）——python 轨道 spawn 将在后续版本落地，当前仅支持 node 轨道自动测'
        writeLastTest({ stage: 'starting', ok: false, reason, extraTools: [], missingTools: [], testedAt })
        return { ok: false, error: reason }
      }
      commandOrUrl = py
      args = [entryAbs]
    } else {
      commandOrUrl = 'node'
      args = [entryAbs]
    }

    const testId = opts?.testId ?? `pkgtest-${packageId}-${Date.now()}`
    const result = await testConnection(testId, {
      type: 'stdio',
      commandOrUrl,
      args,
      env: {},
      credential: null,
    }, opts?.onStage)

    if (result.ok) {
      const declared = manifest.tools.map((t) => t.name)
      const actual = result.tools.map((t) => t.name)
      const extraTools = actual.filter((n) => !declared.includes(n))
      const missingTools = declared.filter((n) => !actual.includes(n))
      writeLastTest({ stage: 'listing', ok: true, extraTools, missingTools, testedAt })
      // WR-02（29.1-03 直写）：实测成功 → 工具缓存按 package_id 直写（v29 D-05 包级策略），
      // AI buildMcpContexts 开箱可用（annotations 实测值透传，免确认资格由策略层判定）
      McpPackageService.savePackageToolCache(packageId, result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations as McpToolAnnotations | undefined,
      })))
      return { ok: true, extraTools, missingTools }
    }
    writeLastTest({
      stage: 'listing',
      ok: false,
      reason: result.error.reason,
      extraTools: [],
      missingTools: [],
      testedAt,
    })
    return { ok: false, error: result.error.reason }
  }

  // -------------------------------------------------------------------
  // 29-09 走查二：包配置行级「测试」包轨路由（缺陷1+3 根因修复）
  // -------------------------------------------------------------------

  /**
   * 包配置（type='package'）行级连接测试——mcp:testConnection 识别包配置后路由至此。
   * 与 stdio/http 旧通道的差异：
   *  - spawn 前置守卫与 getConnection 包轨同源：disabled 门 + TOCTOU 全树指纹重验
   *    （检出即 disabled=1 + security 日志副作用，testPackage 同款链路）
   *  - spawn 计划复用 resolvePackageSpawn（python 内嵌轨道 / node entry——不复制第二份逻辑）
   *  - env 注入 = 首台绑定设备（MIN(rel.id)）的 env_json_enc 解密合并；无绑定设备空 env
   *    也可测（只验包能起 + 握手 + tools/list）
   *  - 进度事件/取消/超时/树杀复用 mcpClient.testConnection 既有基建（testId 透传）
   */
  static async testPackageConfig(configId: number, opts?: {
    testId?: string
    onStage?: StageCallback
  }): Promise<McpTestResult> {
    const conn = McpPackageService.db()
    const cfg = conn.prepare('SELECT id, source, package_id FROM mcp_configs WHERE id = ?')
      .get(configId) as { id: number; source: string; package_id: number | null } | undefined
    if (!cfg) return { ok: false, error: { code: 'MCP_ERROR', reason: '配置不存在或已被删除' } }
    if (cfg.source !== 'package' || cfg.package_id == null) {
      return { ok: false, error: { code: 'MCP_ERROR', reason: '该配置不是 MCP 包配置（包轨测试仅适用于 type=package）' } }
    }
    const row = conn.prepare('SELECT * FROM mcp_packages WHERE id = ?').get(cfg.package_id) as any
    if (!row) return { ok: false, error: { code: 'MCP_ERROR', reason: '包不存在或已被删除' } }
    if (row.disabled) {
      return { ok: false, error: { code: 'MCP_ERROR', reason: '包已被禁用（TOCTOU 检出后需重新导入校验），不能测试' } }
    }
    // WR-01 同款：TOCTOU 指纹重验失败 → disabled=1 + security 日志副作用（不 spawn）
    try {
      verifyPackageFingerprint(row.dir_path, row.fingerprint_json)
    } catch (e) {
      const reason = (e as { reason?: string }).reason ?? '包指纹重验失败（TOCTOU 检出）'
      if ((e as { code?: string })?.code === 'package_integrity_failed') {
        try {
          conn.prepare(
            "UPDATE mcp_packages SET disabled = 1, updated_at = datetime('now','localtime') WHERE id = ?"
          ).run(cfg.package_id)
        } catch { /* 禁用失败不吞主线错误 */ }
        try {
          reportPackageIntegrityFailure({ packageId: cfg.package_id, dirPath: row.dir_path, detail: reason })
        } catch { /* handler 故障不吞主线错误 */ }
      }
      return { ok: false, error: { code: 'package_integrity_failed', reason } }
    }

    // spawn 计划：复用 29-04 包轨装配（python 内嵌 / node entry）——python 未内嵌结构化失败
    let plan: { command: string; args: string[] }
    try {
      plan = resolvePackageSpawn({
        packageId: row.id,
        dirPath: row.dir_path,
        runtime: row.runtime,
        entry: row.entry,
        fingerprintJson: row.fingerprint_json ?? '',
      })
    } catch (e) {
      const err = e as { code?: string; reason?: string }
      return { ok: false, error: { code: err?.code ?? 'MCP_ERROR', reason: err?.reason ?? '包 spawn 计划装配失败' } }
    }

    // env：首台绑定设备（MIN(rel.id)）env 解密合并；无绑定设备空 env（坏密文/坏 JSON 降级空组）
    let env: Record<string, string> = {}
    const rel = conn.prepare(
      'SELECT env_json_enc FROM mcp_device_rel WHERE mcp_config_id = ? ORDER BY id LIMIT 1'
    ).get(configId) as { env_json_enc: string | null } | undefined
    if (rel?.env_json_enc) {
      const dec = decField(rel.env_json_enc, McpPackageService.MK)
      if (dec) {
        try {
          const parsed = JSON.parse(dec)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) env = parsed as Record<string, string>
        } catch { /* 坏 JSON 降级空 env */ }
      }
    }

    const testId = opts?.testId ?? `pkgcfgtest-${configId}-${Date.now()}`
    // 复用 mcpClient.testConnection 全套基建（进度/取消/超时/树杀）：plan.command 形态
    // 对 resolveStdioCommand 语义稳定（python=包内绝对路径直用；node=PATH 主路径+兜底）
    return testConnection(testId, {
      type: 'stdio',
      commandOrUrl: plan.command,
      args: plan.args,
      env,
      credential: null,
    }, opts?.onStage)
  }

  // -------------------------------------------------------------------
  // 从包创建配置（29-06，PKG-05：D-20/D-21/D-22）
  // -------------------------------------------------------------------

  /**
   * 29.1-03（D-05 直写）：工具缓存按 package_id 直写 mcp_tools——不再借存同包
   * MIN(id) 根配置（v29 借存链路终结；无配置/删光配置场景均可预填，包在策略在）。
   * fail-soft：mcp_tools 表缺失（最小 schema 测试）或写失败时跳过——缓存冷启动为空
   * 仍是可用降级（用户手动行级测试可重建），不阻断导入/创建主线。
   */
  private static savePackageToolCache(packageId: number, tools: Array<{ name: string; description?: string; annotations?: McpToolAnnotations; inputSchema?: unknown }>): void {
    try {
      McpToolPolicy.savePackageToolCache(packageId, tools)
    } catch {
      // fail-soft：见方法注
    }
  }

  /**
   * 型号匹配设备清单（D-07）：manifest.models 对 device.model 做
   * 忽略大小写/首尾空格的包含匹配；附每台 matchedModel 原因与已绑冲突标注
   * （T-29-06-03：匹配只影响 UI 预勾选，硬拦截在 createConfigFromPackage 事务内）。
   * 设备 name/model 为密文列，与全局同源 MK 经 decField 解密（坏密文降级空串）。
   */
  static listMatchedDevices(packageId: number): McpMatchedDeviceView[] | null {
    const conn = McpPackageService.db()
    const row = conn.prepare('SELECT manifest_json FROM mcp_packages WHERE id = ?').get(packageId) as any
    if (!row) return null
    const manifest = McpPackageService.parseManifestSafe(row.manifest_json)
    if (!manifest) return null

    const stmtBound = conn.prepare(
      `SELECT c.name AS name FROM mcp_device_rel r JOIN mcp_configs c ON c.id = r.mcp_config_id WHERE r.device_id = ?`
    )
    const devices = conn.prepare('SELECT id, name_enc, model_enc FROM devices ORDER BY created_at, id').all() as any[]
    return devices.map((d) => {
      const model = decField(d.model_enc, McpPackageService.MK) ?? ''
      const deviceName = decField(d.name_enc, McpPackageService.MK) ?? d.id
      const hit = (manifest.models ?? []).find(
        (m) => m.trim() !== '' && model.toLowerCase().includes(m.trim().toLowerCase())
      )
      const bound = stmtBound.get(d.id) as { name: string } | undefined
      return {
        deviceId: d.id,
        name: deviceName,
        model: model || null,
        matchedModel: hit ? hit.trim() : null,
        boundConfigName: bound?.name ?? null,
      }
    })
  }

  /**
   * 单条配置绑定 N 台设备（29-07 Gap-2 语义修订）：单事务 INSERT 恰好 1 条
   * mcp_configs（package_id 来源标记 + name 入参）+ N 行 rel（每行独立 env_json_enc）。
   * 冲突判定事务内 SELECT 先行（防 TOCTOU）：任一设备已绑其它配置 → 整体拒绝
   * 零部分写入（D-19）。env 变量名不再受 manifest.envKeys 限制（Gap-5），
   * 仅受格式/长度/数量上限约束。
   */
  static createConfigFromPackage(
    packageId: number,
    name: string,
    deviceEnvs: Array<{ deviceId: string; env: Record<string, string> }>
  ): { ok: true; configId: number } | { ok: false; error: string } {
    const conn = McpPackageService.db()
    const row = conn.prepare('SELECT * FROM mcp_packages WHERE id = ?').get(packageId) as any
    if (!row) return { ok: false, error: '包不存在或已被删除' }
    if (row.disabled) return { ok: false, error: '包已被禁用（TOCTOU 检出后需重新导入校验），不能创建配置' }
    const manifest = McpPackageService.parseManifestSafe(row.manifest_json)
    if (!manifest) return { ok: false, error: '包 manifest 元数据损坏' }

    // ---- 入参守卫（Gap-5：不再比对 manifest.envKeys，仅格式/长度/数量上限）----
    if (typeof name !== 'string' || name.trim() === '') return { ok: false, error: '配置名称不能为空' }
    if (name.trim().length > MAX_PKG_NAME_LENGTH) {
      return { ok: false, error: `配置名称超过 ${MAX_PKG_NAME_LENGTH} 字符上限` }
    }
    if (deviceEnvs.length === 0) return { ok: false, error: '未选择任何设备' }
    if (deviceEnvs.length > MAX_BATCH) return { ok: false, error: `deviceEnvs 超过批量上限 ${MAX_BATCH}` }
    const seen = new Set<string>()
    for (const item of deviceEnvs) {
      if (!item || typeof item.deviceId !== 'string' || item.deviceId === '') {
        return { ok: false, error: '参数无效：deviceId' }
      }
      if (seen.has(item.deviceId)) return { ok: false, error: `设备 ${item.deviceId} 重复提交` }
      seen.add(item.deviceId)
      const entries = Object.entries(item.env ?? {})
      if (entries.length > 50) return { ok: false, error: '单设备环境变量超过 50 对上限' }
      for (const [k, v] of entries) {
        if (!ENV_KEY_RE.test(k)) return { ok: false, error: `环境变量名 ${k} 不合法（字母/下划线开头，仅含字母数字下划线，≤100 字符）` }
        if (typeof v !== 'string' || v.length > 2000) {
          return { ok: false, error: `环境变量 ${k} 的值必须为 string 且不超过 2000 字符` }
        }
      }
    }

    let result: { ok: true; configId: number } | { ok: false; error: string } | null = null
    conn.transaction((): void => {
      // ---- 冲突判定先行（先于一切 INSERT，防 TOCTOU；DB UNIQUE 兜底并发竞态）----
      const stmtBound = conn.prepare('SELECT mcp_config_id FROM mcp_device_rel WHERE device_id = ?')
      const stmtCfgName = conn.prepare('SELECT name FROM mcp_configs WHERE id = ?')
      const stmtDev = conn.prepare('SELECT id, name_enc FROM devices WHERE id = ?')
      for (const item of deviceEnvs) {
        const bound = stmtBound.get(item.deviceId) as { mcp_config_id: number } | undefined
        if (bound) {
          const dev = stmtDev.get(item.deviceId) as { name_enc: string } | undefined
          const devName = dev ? decField(dev.name_enc, McpPackageService.MK) ?? item.deviceId : item.deviceId
          const otherName = (stmtCfgName.get(bound.mcp_config_id) as { name: string } | undefined)?.name ?? `#${bound.mcp_config_id}`
          result = { ok: false, error: `设备 ${devName} 已绑在配置 ${otherName}，请先在那边解绑` }
          return
        }
        if (!stmtDev.get(item.deviceId)) {
          result = { ok: false, error: `设备 ${item.deviceId} 不存在或已被删除，请刷新列表` }
          return
        }
      }

      // ---- 恰好 1 条 config + N 行 rel（各设备独立 env 密文，T-29-07 同款红线）----
      // 29-09 走查二：type 真实化为 'package'（v28 CHECK 已放开）——不再靠
      // source='package' 暗号谎报 stdio；command_or_url 存 manifest.entry
      // （spawn 形态由包元数据装配，读取处不依赖该列——Fix-4）
      const stmtInsCfg = conn.prepare(
        `INSERT INTO mcp_configs (name, type, command_or_url, args_json, package_id, source)
         VALUES (?, 'package', ?, '[]', ?, 'package')`
      )
      const stmtInsRel = conn.prepare(
        'INSERT INTO mcp_device_rel (id, mcp_config_id, device_id, env_json_enc) VALUES (?, ?, ?, ?)'
      )
      const info = stmtInsCfg.run(name.trim(), row.entry, packageId)
      for (const item of deviceEnvs) {
        const envStr = item.env && Object.keys(item.env).length > 0 ? JSON.stringify(item.env) : null
        stmtInsRel.run(uuidv4(), info.lastInsertRowid as number, item.deviceId, envStr ? encField(envStr, McpPackageService.MK) : null)
      }
      result = { ok: true, configId: info.lastInsertRowid as number }
    })()
    // CFA 不跟踪事务闭包赋值——显式宽类型还原后判定
    if ((result as { ok?: boolean } | null)?.ok === true) {
      // WR-02 同款（29.1-03 直写）：创建即预填包级工具缓存（package_id 直写，AI 开箱可用）
      McpPackageService.savePackageToolCache(packageId, manifest.tools.map((t) => ({
        name: t.name,
        description: t.description,
      })))
    }
    return result!
  }
}

/** 29-06：型号预筛出口投影（无凭证字段；匹配只作 UI 预勾选，非硬拦截） */
export interface McpMatchedDeviceView {
  deviceId: string
  name: string
  model: string | null
  /** 命中的 manifest 型号串（未命中 null） */
  matchedModel: string | null
  /** 已被其它配置绑定的冲突标注（UI 灰显） */
  boundConfigName: string | null
}

/** existsSync 包装（单一 import 面便于阅读） */
function existsSyncSafe(p: string): boolean {
  return existsSync(p)
}