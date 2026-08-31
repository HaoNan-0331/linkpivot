/**
 * DeviceCredentialMigration —— Phase 36（36-01，LOGIN-03/D-08）post-MK 设备凭证子表回填
 * + devices 行内凭证六列物理清理。
 *
 * 多通道凭证模型落地：devices 行内六列（port_enc/username_enc/password_enc/
 * ssh_key_path_enc/ssh_key_content_enc/web_url_enc）按 connection_type 映射迁入
 * device_credentials 子表行（36-CONTEXT 回填映射表）；全部迁完（无坏密文残留）后
 * 六列物理清理（D-08「不留 deprecated 双源」，ALTER DROP COLUMN——SQLite 3.35+，
 * better-sqlite3 12.9 内置 3.53 实测可用，不走 v28 式表 rebuild 避 FK CASCADE 陷阱）。
 *
 * 回填是加密写 → 必须在 MK 注入后执行（不能进迁移步骤，v10/v13/v23 caveat 铁律：
 * 迁移失败中止启动 / 回填失败可重试不阻塞，职责分离）；main.ts 在 backfillDeviceEnv
 * 调用点之后追加调用（29-02 先例时序）。
 *
 * 形态：静态类 facade（mcpDeviceEnvMigration 骨架同款），MK 挂 private static MK
 * 由 setDeviceCredentialMasterKey() 注入（不直读 keyManager）；_setDbGetter 测试注入口。
 *
 * 字段加密红线：凭证列读写只走 encField/decField（禁裸调 encrypt/decrypt）。
 * decField 降级（非 NULL 密文解出 '' ⟺ 坏密文，encField('') === null——非空 _enc
 * 不可能来自合法空明文）→ 整行 skipped++ 不插不造假数据（Pitfall 2）；skipped>0
 * 不清列保数据（SC3 数据零丢失优先），下次启动重试。
 * 回填 INSERT 用 OR IGNORE（(device_id, channel) 不存在才插——Pitfall 1 回填-约束
 * 死锁防护，重试/中断续跑幂等）；多写包 db.transaction（原子性红线）；
 * prepared statement 循环外复用（DB 性能红线）。
 */

import crypto from 'crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { hasColumn } from '../database/migrationHelpers'
import { encField, decField } from '../utils/crypto'

export interface DeviceCredentialBackfillResult {
  backfilled: number
  /** 坏密文/通道不可映射跳过的行数（保留旧列，下次启动重试） */
  skipped: number
  /** 六个行内凭证列是否已物理清理（D-08） */
  droppedColumns: boolean
}

/** devices 行内凭证六列（D-08 清列对象，DROP 顺序即此数组序） */
const LEGACY_DEVICE_ENC_COLUMNS = [
  'port_enc',
  'username_enc',
  'password_enc',
  'ssh_key_path_enc',
  'ssh_key_content_enc',
  'web_url_enc',
] as const

/**
 * 回填映射表（36-CONTEXT / 36-RESEARCH §迁移架构）：旧 connection_type →
 * 子表行 (device_id, connection_type) 迁入的行内列。
 * resolution 无历史来源（D-04 裁决补记新增列）——回填不涉及，迁移后各通道行恒 NULL。
 */
const CHANNEL_MIGRATION_COLUMNS: Record<string, readonly string[]> = {
  ssh: ['port_enc', 'username_enc', 'password_enc', 'ssh_key_path_enc', 'ssh_key_content_enc'],
  telnet: ['port_enc', 'username_enc', 'password_enc'],
  web: ['web_url_enc'],
  rdp: ['port_enc', 'username_enc'],
}

interface LegacyDeviceRow {
  id: string
  connection_type: string | null
  [col: string]: string | null
}

export class DeviceCredentialMigration {
  private static MK = ''

  static setDeviceCredentialMasterKey(key: string): void {
    DeviceCredentialMigration.MK = key
  }

  // 默认走生产单例 db；测试经 _setDbGetter 注入内存 mock（mcpDeviceEnvMigration 同款惯例）。
  private static dbGetter: () => Database.Database = getDatabase

  static _setDbGetter(fn: () => Database.Database): void {
    DeviceCredentialMigration.dbGetter = fn
  }

  /**
   * 存量行内凭证迁入 device_credentials 子表 + 迁完物理清理六列（D-08）。
   *
   * 幂等：password_enc 根守卫（清列完成的库整体 no-op——重复升级零动作）+
   * INSERT OR IGNORE（重试/中断续跑不重插）。坏密文行跳过不清列（保数据，
   * 下次启动重试）；失败不 throw（调用方 main.ts 仅 warn 不阻塞启动，
   * severity/name_hash/env 回填同范式）。
   */
  static backfillDeviceCredentials(): DeviceCredentialBackfillResult {
    // T-29-02-04：MK 未注入（空串）直接返回，避免用空 key 造假密文
    if (!DeviceCredentialMigration.MK) return { backfilled: 0, skipped: 0, droppedColumns: false }

    const db = DeviceCredentialMigration.dbGetter()
    // 幂等根守卫（D-08）：password_enc 已清理（清列完成）的库整体 no-op——重复升级零动作
    if (!hasColumn(db, 'devices', 'password_enc')) {
      return { backfilled: 0, skipped: 0, droppedColumns: false }
    }

    const rows = db.prepare(`
      SELECT id, connection_type, port_enc, username_enc, password_enc,
        ssh_key_path_enc, ssh_key_content_enc, web_url_enc
      FROM devices
    `).all() as LegacyDeviceRow[]

    // (device_id, channel) 不存在才插（Pitfall 1 防回填-约束死锁；重试续跑幂等）
    const insert = db.prepare(`
      INSERT OR IGNORE INTO device_credentials
        (id, device_id, channel, port_enc, username_enc, password_enc,
         ssh_key_path_enc, ssh_key_content_enc, web_url_enc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    let backfilled = 0
    let skipped = 0
    const tx = db.transaction(() => {
      for (const row of rows) {
        const cols = row.connection_type ? CHANNEL_MIGRATION_COLUMNS[row.connection_type] : undefined
        if (!cols) {
          // 通道不可映射（connection_type 为 NULL，CHECK 值域外不可达）但行内有凭证数据
          // → skipped 保列待人工处置（LOGIN-03 数据零丢失优先，不清列）
          if (LEGACY_DEVICE_ENC_COLUMNS.some((c) => row[c] !== null)) skipped++
          continue
        }
        // 插行判据：该通道映射列中至少一列原值非 NULL 才插行
        // （凭证全空设备不插 → 零通道设备，D-02 引导兜底前提）
        if (!cols.some((c) => row[c] !== null)) continue

        const plain: Record<string, string | null> = {}
        let badCipher = false
        for (const c of cols) {
          const raw = row[c]
          const dec = decField(raw, DeviceCredentialMigration.MK)
          // 非 NULL 密文解出空串 ⟺ 坏密文（降级不 throw）——整行跳过不造假数据（Pitfall 2）
          if (raw !== null && dec === '') {
            badCipher = true
            break
          }
          plain[c] = raw === null ? null : dec
        }
        if (badCipher) {
          skipped++ // 不插行；skipped>0 不清列，下次启动重试（SC3 数据零丢失优先）
          continue
        }
        const res = insert.run(
          crypto.randomUUID(),
          row.id,
          row.connection_type as string,
          encField(plain['port_enc'], DeviceCredentialMigration.MK),
          encField(plain['username_enc'], DeviceCredentialMigration.MK),
          encField(plain['password_enc'], DeviceCredentialMigration.MK),
          encField(plain['ssh_key_path_enc'], DeviceCredentialMigration.MK),
          encField(plain['ssh_key_content_enc'], DeviceCredentialMigration.MK),
          encField(plain['web_url_enc'], DeviceCredentialMigration.MK)
        )
        if (res.changes > 0) backfilled++
      }
    })
    tx()

    // D-08 清列门控：待迁行数（仍有映射列数据且子表无对应行的设备）以事务后 SQL 权威重算
    // （不依赖循环内推导——任意中间态都正确判定）+ skipped === 0（无坏密文/不可映射残留）。
    const pendingRow = db.prepare(`
      SELECT COUNT(*) AS c FROM devices d
      WHERE (
        (d.connection_type = 'ssh' AND (d.port_enc IS NOT NULL OR d.username_enc IS NOT NULL
          OR d.password_enc IS NOT NULL OR d.ssh_key_path_enc IS NOT NULL OR d.ssh_key_content_enc IS NOT NULL))
        OR (d.connection_type = 'telnet' AND (d.port_enc IS NOT NULL OR d.username_enc IS NOT NULL
          OR d.password_enc IS NOT NULL))
        OR (d.connection_type = 'web' AND d.web_url_enc IS NOT NULL)
        OR (d.connection_type = 'rdp' AND (d.port_enc IS NOT NULL OR d.username_enc IS NOT NULL))
        OR (d.connection_type IS NULL AND (d.port_enc IS NOT NULL OR d.username_enc IS NOT NULL
          OR d.password_enc IS NOT NULL OR d.ssh_key_path_enc IS NOT NULL
          OR d.ssh_key_content_enc IS NOT NULL OR d.web_url_enc IS NOT NULL))
      )
      AND NOT EXISTS (
        SELECT 1 FROM device_credentials c
        WHERE c.device_id = d.id AND c.channel = d.connection_type
      )
    `).get() as { c: number }
    const pending = pendingRow.c

    let droppedColumns = false
    if (pending === 0 && skipped === 0) {
      // 六条 DROP 包单事务（多写原子红线）：部分失败整体回滚，下次启动整段重试
      const dropTx = db.transaction(() => {
        for (const col of LEGACY_DEVICE_ENC_COLUMNS) {
          db.exec(`ALTER TABLE devices DROP COLUMN ${col}`)
        }
      })
      dropTx()
      droppedColumns = true
    }
    return { backfilled, skipped, droppedColumns }
  }
}
