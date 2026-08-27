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
 * 语义（测试 tests/electron/utils/dataDirMigration.test.ts 六用例锁死）：
 *   - target 已存在 → 'none'（永不覆盖既有目录，幂等守卫在最前）
 *   - 按 LEGACY_DIR_NAMES 有序命中 → renameSync 同卷原子搬迁 → 'migrated'
 *   - rename 失败（旧应用占用等）→ 'fallback' + from=该 legacy 路径（调用方 setPath
 *     回旧目录，数据可用性优先于路径美观；应用启动永不因迁移炸死，T-30.1-07）
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
      // 占用/权限等失败：不炸启动、不试第二个 legacy（避免半迁移状态），回退继续用旧目录
      return { status: 'fallback', from: legacy }
    }
  }
  return { status: 'none' }
}
