/**
 * McpDeviceEnvMigration —— Phase 29（29-02，PKG-05/D-17）post-MK 存量 env 回填。
 *
 * 设备级 env 模型（D-15）：mcp_device_rel.env_json_enc 存设备级覆盖；v27 前的存量
 * 共享 env 挂在 mcp_configs.env_json_enc——升级后需复制到每台绑定设备行（D-17）。
 *
 * 回填是加密写 → 必须在 MK 注入后执行（不能进迁移步骤，25-05 回填-索引死锁教训）；
 * main.ts 在 backfillNameHash 调用点之后追加调用（25-05 先例时序）。
 *
 * 形态：静态类 facade（mcpService 骨架同款），MK 挂 private static MK 由
 * setMcpDeviceEnvMasterKey() 注入（不直读 keyManager）；_setDbGetter 测试注入口。
 *
 * 字段加密红线：env_json_enc 读写只走 encField/decField（禁裸调 encrypt/decrypt）。
 * 坏密文降级（decField 失败返回 ''）→ 对应行跳过保持 NULL，不 throw 不造假数据
 * （读路径永不炸，T-29-02-02）。整体 db.transaction（多写原子性）；
 * prepared statement 循环外复用（DB 性能红线）。
 */

import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'

export interface BackfillResult {
  backfilled: number
  /** 解密失败/空 env 跳过的行数（保持 NULL，不造假数据） */
  skipped: number
}

export class McpDeviceEnvMigration {
  private static MK = ''

  static setMcpDeviceEnvMasterKey(key: string): void {
    McpDeviceEnvMigration.MK = key
  }

  // 默认走生产单例 db；测试经 _setDbGetter 注入内存 mock（mcpService 同款惯例）。
  private static dbGetter: () => Database.Database = getDatabase

  static _setDbGetter(fn: () => Database.Database): void {
    McpDeviceEnvMigration.dbGetter = fn
  }

  /**
   * 存量共享 env 复制到每台绑定设备（D-17）。
   * 幂等：只处理 rel.env_json_enc IS NULL 的行（重跑零写入）。
   * CR-01（Phase 29 code-review）：NULL 单义化——saveConfig 清空设备 env 时写空对象
   * 密文（'{}'）而非 NULL，IS NULL 只剩「pre-v27 存量行尚未回填」一义，用户清除后
   * 重启不再被配置级共享 env 静默复活。存量自愈：修复前已写 NULL 的清除行，本版本
   * 首次启动仍会被回填一次（无法与未回填行区分），用户再清一次即落 '{}' 永久生效。
   * 失败不 throw（调用方 main.ts 仅 warn 不阻塞启动，severity/name_hash 回填同范式）。
   */
  static backfillDeviceEnv(): BackfillResult {
    // T-29-02-04：MK 未注入（空串）直接返回，避免用空 key 造假密文
    if (!McpDeviceEnvMigration.MK) return { backfilled: 0, skipped: 0 }

    const db = McpDeviceEnvMigration.dbGetter()
    const rows = db.prepare(`
      SELECT rel.id AS rel_id, cfg.env_json_enc AS env_enc
      FROM mcp_device_rel rel
      JOIN mcp_configs cfg ON cfg.id = rel.mcp_config_id
      WHERE rel.env_json_enc IS NULL
    `).all() as Array<{ rel_id: string, env_enc: string | null }>

    const update = db.prepare('UPDATE mcp_device_rel SET env_json_enc = ? WHERE id = ?')
    let backfilled = 0
    let skipped = 0
    const tx = db.transaction(() => {
      for (const row of rows) {
        // decField：null → ''；坏密文 → ''（降级不 throw）——两种情况都跳过不造假数据
        const envJson = decField(row.env_enc, McpDeviceEnvMigration.MK)
        if (!envJson) {
          skipped++
          continue
        }
        update.run(encField(envJson, McpDeviceEnvMigration.MK), row.rel_id)
        backfilled++
      }
    })
    tx()
    return { backfilled, skipped }
  }
}
