import fs from 'fs'
import path from 'path'

/**
 * 改名后 userData 目录一次性原子迁移（Phase 30.1-02）。
 *
 * 背景：productName 改「灵枢」后 Electron 默认 userData 会从 %APPDATA%\网络拓扑管理工具
 * 漂移到 %APPDATA%\灵枢，0.4.0 老用户的 DB/masterKey/kb_files/backups 将全部「消失」。
 * main.ts 在一切 userData 消费之前调用本函数 + app.setPath('userData', ...) 钉定到 LinkPivot，
 * 与 productName 解耦（未来显示名再改不再迁移数据）。
 *
 * 语义（测试 tests/electron/utils/dataDirMigration.test.ts 八用例锁死）：
 *   - target 已存在 → 'none'（永不覆盖既有目录，幂等守卫在最前）
 *   - 按 LEGACY_DIR_NAMES 有序命中 → renameSync 同卷原子搬迁 → 'migrated'
 *   - rename 失败且 legacy 仍在（旧应用占用等）→ 'fallback' + from=该 legacy 路径
 *     （调用方 setPath 回旧目录，数据可用性优先于路径美观；应用启动永不因迁移炸死，T-30.1-07）
 *   - rename 失败且 legacy 已消失（并发实例恰好完成同一次迁移，WR-02）→ 'none'
 *     （target 已就绪；禁止 setPath 回已被迁走的空路径——假性数据丢失窗口）
 *   - 无 legacy 无 target（全新安装，WR-01）→ 'none' + 显式 mkdirSync 保证 target 就绪
 *
 * 纯函数零 electron import（ELECTRON_RUN_AS_NODE 可测）。
 */

/** 有序 legacy 目录名：打包态（0.4.0 productName）优先，dev 态（package.json name）次之 */
export const LEGACY_DIR_NAMES = ['网络拓扑管理工具', 'network-topology-manager']

/** 钉定的 userData 目录名（与 productName「灵枢」解耦） */
export const TARGET_DIR_NAME = 'LinkPivot'

export interface MigrationResult {
  status: 'none' | 'migrated' | 'fallback'
  from?: string
}

/**
 * WR-01（30-06）：显式保证 target 目录就绪。
 *
 * setPath 改写的目录 Electron 无「启动时隐式创建」等价承诺（默认 userData 由 Chromium
 * 启动流程保证创建，setPath 后不适用）——不建目录时 getOrCreateMasterKey 的
 * writeFileSync(master.key)（先于 initDatabase）将 ENOENT →「启动失败」dialog → quit，
 * 全新安装（无 legacy 数据）首启即炸。recursive 对已存在目录为幂等 noop；
 * mkdir 失败不炸启动（尽力而为，语义等价于无此防御的现状，T-30.1-07）。
 */
function ensureTargetDir(target: string): void {
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
  } catch { /* 目录创建失败不炸启动：Electron 后续写 userData 时按现状语义暴露 */ }
}

export function migrateLegacyUserData(appDataDir: string): MigrationResult {
  const target = path.join(appDataDir, TARGET_DIR_NAME)
  // 幂等守卫在最前：既有 LinkPivot 目录绝不覆盖（可能是已迁移完成或并行实例）
  if (fs.existsSync(target)) return { status: 'none' }

  for (const name of LEGACY_DIR_NAMES) {
    const legacy = path.join(appDataDir, name)
    if (!fs.existsSync(legacy)) continue
    try {
      // 同卷 rename 原子搬迁：DB/masterKey/kb_files/backups 随目录整体移动，无逐文件拷贝窗口
      fs.renameSync(legacy, target)
      return { status: 'migrated', from: legacy }
    } catch {
      // WR-02（30-06）：rename 失败先复核 legacy 是否仍在，区分两类失败根因：
      //   - legacy 仍在（win32 占用/权限）→ fallback 回旧目录：不炸启动、不试第二个
      //     legacy（避免半迁移状态），数据可用性优先；
      //   - legacy 已消失（并发实例在本实例 existsSync 通过后恰好完成同一次 rename 的
      //     源消失型 ENOENT）→ target 已就绪，等价 'none'——禁止 setPath 回已被迁走的
      //     空路径（当次会话「数据全没了」假象 + 空库重建风险）。
      if (fs.existsSync(legacy)) {
        return { status: 'fallback', from: legacy }
      }
      ensureTargetDir(target)
      return { status: 'none' }
    }
  }
  // WR-01（30-06）：无 legacy 无 target（全新安装）——显式建 target，防 setPath 到不存在目录
  ensureTargetDir(target)
  return { status: 'none' }
}
