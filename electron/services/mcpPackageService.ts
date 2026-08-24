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

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { validateMcpb, buildFingerprintTree, MAX_PACKAGE_BYTES } from './mcpPackageValidator'
import type { McpManifest, FileEntry, VectorResult } from './mcpPackageValidator'

/** manifest.name 长度上限（网关与 service 同源，D-05 包身份健壮性） */
export const MAX_PKG_NAME_LENGTH = 100

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

/** IPC 出口投影：包级本无 env 值，仅 envKeys 名单（无明文可泄） */
export interface McpPackageView {
  id: number
  name: string
  version: string | null
  runtime: 'node' | 'python'
  entry: string
  models: string[]
  toolCount: number
  envKeys: string[]
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
      McpPackageService.assertSafeEntryPath(f.path)
      const target = join(dir, ...f.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.content)
    }
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
    McpPackageService.writePackageFiles(dir, v.fileTree)
    conn.prepare(
      `INSERT INTO mcp_packages (name, version, runtime, entry, manifest_json, fingerprint, fingerprint_json, dir_path, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(manifest.name, manifest.version, manifest.runtime, manifest.entry,
      JSON.stringify(manifest), fp.treeSha256, JSON.stringify(fp), dir, v.totalBytes)
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

    // 1) 替换包目录文件（fs 先行；若中途崩溃，DB 旧指纹与磁盘不一致由 29-04 spawn 前重验兜底检出）
    McpPackageService.writePackageFiles(existing.dir_path, v.fileTree)

    // 2) DB 事务：rel 行 env 键剔除 + 主表更新
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
        `UPDATE mcp_packages SET version = ?, runtime = ?, entry = ?, manifest_json = ?, fingerprint = ?,
         fingerprint_json = ?, size_bytes = ?, last_test = NULL, updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(manifest.version, manifest.runtime, manifest.entry, JSON.stringify(manifest),
        fp.treeSha256, JSON.stringify(fp), v.totalBytes, packageId)
    })()
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
}
