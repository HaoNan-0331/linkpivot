/**
 * McpService —— Phase 21 MCP 配置数据层 service（21-02，MCP-01/MCP-02）。
 *
 * 形态裁决（21-02 plan）：静态类 facade（CONVENTIONS 红线默认，ouiService/anomalyService 同款），
 * masterKey 挂 private static MK，由 main.ts 启动时经 setMcpMasterKey() 注入（不直读 keyManager）。
 *
 * 字段加密红线：env_json_enc / credential_enc 只走 encField/decField，禁止裸调 encrypt/decrypt。
 *
 * 出口脱敏红线（T-21-02-01）：listConfigs 出口投影只含 Masked 字段（****尾4），
 * 明文凭证仅经 decodeEnvForTest 在 main 进程内部供 21-03 mcpClient 使用，绝不进 IPC 出口。
 *
 * D-04 绑定冲突：saveConfig 事务内先 SELECT mcp_device_rel 判定设备是否已被他配置绑定，
 * 命中即拒绝（不自动换绑）返 { ok:false, error }；device_id 单列 UNIQUE 是 DB 层兜底（双保险）。
 *
 * 批量上限：MAX_BATCH=1000（deviceIds 数组，网关层同步校验）。
 */

import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { getDeviceById } from './device'

export const MAX_BATCH = 1000

export interface McpSaveInput {
  /** 有值 → UPDATE；空 → INSERT（新建） */
  id?: number | null
  name: string
  type: 'stdio' | 'http'
  commandOrUrl: string
  args?: string[]
  /** stdio 环境变量键值对（undefined=不动现值；null/空对象=清空） */
  env?: Record<string, string> | null
  /** http token（undefined=不动现值；null=清空；string=重加密） */
  credential?: string | null
  /** 全量期望绑定设备（覆盖式 diff） */
  deviceIds?: string[]
  enabled?: boolean
}

/** IPC 出口投影（凭证只含 Masked，永无明文/密文 —— T-21-02-01） */
export interface McpConfigView {
  id: number
  name: string
  type: 'stdio' | 'http'
  commandOrUrl: string
  args: string[]
  credentialMasked: string | null
  envKeysMasked: string[]
  deviceIds: string[]
  deviceNames: string[]
  enabled: boolean
  source: string
  lastTestAt: string | null
  lastTestStatus: string | null
  lastTestToolCount: number | null
}

/** main 进程内部用（21-03 mcpClient 连接测试）——绝不进 IPC 出口 */
export interface McpDecodedConfig {
  type: 'stdio' | 'http'
  commandOrUrl: string
  args: string[]
  env: Record<string, string>
  credential: string | null
}

export class McpService {
  private static MK = ''

  static setMcpMasterKey(key: string): void {
    McpService.MK = key
  }

  // 默认走生产单例 db；测试经 _setDbGetter 注入内存 mock（experienceService 同款惯例）。
  private static dbGetter: () => Database.Database = getDatabase

  /** @internal 测试专用：注入 db getter（生产不调用）。 */
  static _setDbGetter(fn: () => Database.Database): void {
    McpService.dbGetter = fn
  }

  private static db(): Database.Database {
    return McpService.dbGetter()
  }

  /** ****尾4 脱敏（device.maskDeviceSecrets 同款格式；短值也保留尾4截取自然行为） */
  private static mask(v: string | null | undefined): string | null {
    if (!v) return null
    return `****${v.slice(-4)}`
  }

  /** 行 → 出口投影：解密 env/credential 仅用于脱敏投影，密文列不外泄 */
  private static rowToView(row: any, relRows: Array<{ device_id: string }>): McpConfigView {
    let envKeysMasked: string[] = []
    if (row.env_json_enc) {
      const dec = decField(row.env_json_enc, McpService.MK)
      try {
        const env = dec ? JSON.parse(dec) : {}
        if (env && typeof env === 'object') {
          envKeysMasked = Object.entries(env as Record<string, string>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => `${k}=${McpService.mask(v) ?? '****'}`)
        }
      } catch {
        // 坏 JSON 降级空列表（decField 失败已走 setDecryptFailureHandler）
      }
    }
    const deviceIds = relRows.map((r) => r.device_id)
    const deviceNames = deviceIds
      .map((id) => {
        const d = getDeviceById(id) as any
        return d?.name ?? id
      })
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      commandOrUrl: row.command_or_url,
      args: Array.isArray(row.args_json) ? row.args_json : parseArgsJson(row.args_json),
      credentialMasked: row.credential_enc ? McpService.mask(decField(row.credential_enc, McpService.MK)) : null,
      envKeysMasked,
      deviceIds,
      deviceNames,
      enabled: !!row.enabled,
      source: row.source,
      lastTestAt: row.last_test_at ?? null,
      lastTestStatus: row.last_test_status ?? null,
      lastTestToolCount: row.last_test_tool_count ?? null,
    }
  }

  static listConfigs(): McpConfigView[] {
    const conn = McpService.db()
    const rows = conn.prepare('SELECT * FROM mcp_configs ORDER BY id').all() as any[]
    const stmtRel = conn.prepare('SELECT device_id FROM mcp_device_rel WHERE mcp_config_id = ? ORDER BY created_at, device_id')
    return rows.map((r) => McpService.rowToView(r, stmtRel.all(r.id) as Array<{ device_id: string }>))
  }

  /**
   * upsert + 绑定 diff（单事务原子）。
   * D-04：设备已被「他配置」绑定 → 整体拒绝 { ok:false, error }（不自动换绑、不部分写入——
   * 冲突 SELECT 先行于一切写语句，DB UNIQUE 兜底并发竞态 T-21-02-04）。
   */
  static saveConfig(dto: McpSaveInput): { ok: true; config: McpConfigView } | { ok: false; error: string } {
    const conn = McpService.db()
    const configId = dto.id ?? null

    let result: { ok: true; config: McpConfigView } | { ok: false; error: string } | null = null
    const tx = conn.transaction((): void => {
      // ---- 冲突判定先行（先于一切写语句）----
      const stmtBound = conn.prepare('SELECT mcp_config_id FROM mcp_device_rel WHERE device_id = ?')
      const stmtCfgName = conn.prepare('SELECT name FROM mcp_configs WHERE id = ?')
      for (const deviceId of dto.deviceIds ?? []) {
        const bound = stmtBound.get(deviceId) as { mcp_config_id: number } | undefined
        if (bound && bound.mcp_config_id !== configId) {
          const deviceName = (getDeviceById(deviceId) as any)?.name ?? deviceId
          const otherName = (stmtCfgName.get(bound.mcp_config_id) as { name: string } | undefined)?.name ?? `#${bound.mcp_config_id}`
          result = { ok: false, error: `设备 ${deviceName} 已绑在配置 ${otherName}，请先在那边解绑` }
          return
        }
      }

      // ---- 主表 upsert ----
      const argsJson = JSON.stringify(dto.args ?? [])
      if (configId != null) {
        const sets = ['name = ?', 'type = ?', 'command_or_url = ?', 'args_json = ?', "updated_at = datetime('now','localtime')"]
        const params: any[] = [dto.name, dto.type, dto.commandOrUrl, argsJson]
        if (dto.env !== undefined) {
          const envStr = dto.env && Object.keys(dto.env).length > 0 ? JSON.stringify(dto.env) : null
          sets.push('env_json_enc = ?')
          params.push(envStr ? encField(envStr, McpService.MK) : null)
        }
        if (dto.credential !== undefined) {
          sets.push('credential_enc = ?')
          params.push(dto.credential ? encField(dto.credential, McpService.MK) : null)
        }
        if (dto.enabled !== undefined) {
          sets.push('enabled = ?')
          params.push(dto.enabled ? 1 : 0)
        }
        params.push(configId)
        conn.prepare(`UPDATE mcp_configs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      } else {
        const envStr = dto.env && Object.keys(dto.env).length > 0 ? JSON.stringify(dto.env) : null
        conn.prepare(
          `INSERT INTO mcp_configs (name, type, command_or_url, args_json, env_json_enc, credential_enc, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          dto.name, dto.type, dto.commandOrUrl, argsJson,
          envStr ? encField(envStr, McpService.MK) : null,
          dto.credential ? encField(dto.credential, McpService.MK) : null,
          dto.enabled === false ? 0 : 1
        )
      }

      // ---- 绑定覆盖式 diff：删旧 rel + 插新 rel ----
      const finalId: number = configId != null
        ? configId
        : (conn.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
      if (dto.deviceIds !== undefined) {
        conn.prepare('DELETE FROM mcp_device_rel WHERE mcp_config_id = ?').run(finalId)
        const stmtIns = conn.prepare('INSERT INTO mcp_device_rel (id, mcp_config_id, device_id) VALUES (?, ?, ?)')
        for (const deviceId of dto.deviceIds) {
          stmtIns.run(uuidv4(), finalId, deviceId)
        }
      }

      const row = conn.prepare('SELECT * FROM mcp_configs WHERE id = ?').get(finalId) as any
      const relRows = conn.prepare('SELECT device_id FROM mcp_device_rel WHERE mcp_config_id = ? ORDER BY created_at, device_id')
        .all(finalId) as Array<{ device_id: string }>
      result = { ok: true, config: McpService.rowToView(row, relRows) }
    })
    tx()
    return result!
  }

  /** 主表 DELETE，mcp_device_rel 随 FK CASCADE 消失（Popconfirm 数据层级联） */
  static deleteConfig(id: number): void {
    McpService.db().prepare('DELETE FROM mcp_configs WHERE id = ?').run(id)
  }

  static setEnabled(id: number, enabled: boolean): void {
    McpService.db().prepare(
      "UPDATE mcp_configs SET enabled = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(enabled ? 1 : 0, id)
  }

  /** 最近测试结果落库（21-04 测试通道调用，D-09） */
  static recordTestResult(id: number, status: 'success' | 'failed', toolCount?: number | null): void {
    McpService.db().prepare(
      `UPDATE mcp_configs SET last_test_at = datetime('now','localtime'), last_test_status = ?, last_test_tool_count = ?, updated_at = datetime('now','localtime') WHERE id = ?`
    ).run(status, toolCount ?? null, id)
  }

  /**
   * @internal 解密配置供 main 进程 mcpClient 连接测试（21-03/21-04）。
   * 绝不经 IPC 出口返 renderer（T-21-02-01 红线）。
   */
  static decodeForTest(id: number): McpDecodedConfig | null {
    const row = McpService.db().prepare('SELECT * FROM mcp_configs WHERE id = ?').get(id) as any
    if (!row) return null
    let env: Record<string, string> = {}
    if (row.env_json_enc) {
      const dec = decField(row.env_json_enc, McpService.MK)
      try {
        const parsed = dec ? JSON.parse(dec) : {}
        if (parsed && typeof parsed === 'object') env = parsed as Record<string, string>
      } catch {
        // 坏密文降级空 env（decField 失败已走 setDecryptFailureHandler）
      }
    }
    return {
      type: row.type,
      commandOrUrl: row.command_or_url,
      args: parseArgsJson(row.args_json),
      env,
      credential: row.credential_enc ? decField(row.credential_enc, McpService.MK) : null,
    }
  }
}

/** args_json 列 → string[]（坏 JSON 降级空数组） */
function parseArgsJson(v: unknown): string[] {
  if (v == null) return []
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
