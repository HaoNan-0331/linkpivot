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
import { McpProcessRegistry } from './mcpProcessRegistry'

export const MAX_BATCH = 1000

/**
 * renderer→main 单向哨兵（21-04 凭证不重传机制）：env 值「未修改（沿用脱敏回显）」。
 * saveConfig / testConnection 遇哨兵值时用已存明文替换（main 侧保留旧值）；
 * ''（空串）表示删除该键。
 */
export const UNCHANGED_ENV_SENTINEL = '****__unchanged__'

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
  /**
   * 29-06（D-16）：设备级 env（手工「本地程序」编辑态 DeviceEnvTable 提交）。
   * 仅覆盖列出的设备；env 值支持 UNCHANGED_ENV_SENTINEL 哨兵（沿用该设备已存明文）
   * 与 ''（删除该键）——与配置级 env 同一套哨兵语义，逐设备独立合并。
   */
  deviceEnvs?: Array<{ deviceId: string; env: Record<string, string> }> | null
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
  /**
   * 29-06（D-16）：每台绑定设备的 env 键值脱敏回显（"KEY=****尾4" 列表）。
   * 值只显尾 4 位哨兵形态，renderer 永不接收明文（T-29-06-02）。
   */
  deviceEnvMasked: Record<string, string[]>
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

  /** rel 行 env_json_enc → "KEY=****尾4" 脱敏列表（坏密文/坏 JSON 降级空列表） */
  private static maskedEnvList(enc: string | null | undefined): string[] {
    if (!enc) return []
    const dec = decField(enc, McpService.MK)
    try {
      const env = dec ? JSON.parse(dec) : {}
      if (env && typeof env === 'object') {
        return Object.entries(env as Record<string, string>)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => `${k}=${McpService.mask(v) ?? '****'}`)
      }
    } catch {
      // 坏 JSON 降级空列表
    }
    return []
  }

  /** 行 → 出口投影：解密 env/credential 仅用于脱敏投影，密文列不外泄 */
  private static rowToView(row: any, relRows: Array<{ device_id: string; env_json_enc?: string | null }>): McpConfigView {
    let envKeysMasked: string[] = []
    if (row.env_json_enc) {
      envKeysMasked = McpService.maskedEnvList(row.env_json_enc)
    }
    const deviceIds = relRows.map((r) => r.device_id)
    const deviceEnvMasked: Record<string, string[]> = {}
    for (const r of relRows) deviceEnvMasked[r.device_id] = McpService.maskedEnvList(r.env_json_enc)
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
      deviceEnvMasked,
    }
  }

  static listConfigs(): McpConfigView[] {
    const conn = McpService.db()
    const rows = conn.prepare('SELECT * FROM mcp_configs ORDER BY id').all() as any[]
    const stmtRel = conn.prepare('SELECT device_id, env_json_enc FROM mcp_device_rel WHERE mcp_config_id = ? ORDER BY created_at, device_id')
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
      // 21-04 哨兵合并：env 含哨兵值/空串删除标记时，用已存明文解冲突后替换 dto.env
      // （renderer 只回显 ****尾4，未修改键经哨兵跳过、main 侧保留旧值；空串=删除该键）
      if (dto.env && configId != null) {
        const hasSentinel = Object.values(dto.env).some((v) => v === UNCHANGED_ENV_SENTINEL || v === '')
        if (hasSentinel) {
          const existing = McpService.decodeForTest(configId)?.env ?? {}
          const merged: Record<string, string> = {}
          for (const [k, v] of Object.entries(dto.env)) {
            if (v === UNCHANGED_ENV_SENTINEL) {
              if (existing[k] !== undefined) merged[k] = existing[k]
            } else if (v !== '') {
              merged[k] = v
            }
          }
          dto.env = merged
        }
      }

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
        const info = conn.prepare(`UPDATE mcp_configs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
        // WR-03：UPDATE 0 行命中（id 不存在/已被并发删除）给用户明确反馈，
        // 防 rel INSERT FK 晦涩报错 / rowToView(undefined) TypeError
        if (info.changes === 0) {
          result = { ok: false, error: '配置不存在或已被删除，请刷新列表' }
          return
        }
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
      // 29-06（D-16）：删行前捕获各设备已存 env 明文（哨兵合并基线；覆盖式 diff 后回写）
      const deviceEnvs = dto.deviceEnvs ?? null
      let priorEnvByDevice: Map<string, Record<string, string>> | null = null
      if (deviceEnvs) {
        priorEnvByDevice = new Map()
        const stmtOldEnv = conn.prepare('SELECT device_id, env_json_enc FROM mcp_device_rel WHERE mcp_config_id = ?')
        for (const r of stmtOldEnv.all(dto.id ?? -1) as Array<{ device_id: string; env_json_enc: string | null }>) {
          const dec = r.env_json_enc ? decField(r.env_json_enc, McpService.MK) : null
          try {
            const parsed = dec ? JSON.parse(dec) : {}
            if (parsed && typeof parsed === 'object') priorEnvByDevice.set(r.device_id, parsed as Record<string, string>)
          } catch { /* 坏 JSON：该设备基线为空 */ }
        }
      }
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

      // ---- 29-06（D-16）：设备级 env 回写（encField 红线；哨兵/空串逐设备合并）----
      // WR-05：deviceIds 缺省（契约=不动绑定）时以 DB 现绑定设备集合为 boundSet，
      // 不再静默丢弃 deviceEnvs（防「只传 deviceEnvs 不传 deviceIds」的逐设备编辑丢失）
      if (deviceEnvs) {
        const stmtUpdRel = conn.prepare(
          'UPDATE mcp_device_rel SET env_json_enc = ? WHERE mcp_config_id = ? AND device_id = ?'
        )
        const boundSet = new Set(
          dto.deviceIds !== undefined
            ? dto.deviceIds
            : (conn.prepare('SELECT device_id FROM mcp_device_rel WHERE mcp_config_id = ?')
              .all(finalId) as Array<{ device_id: string }>).map((r) => r.device_id)
        )
        for (const item of deviceEnvs) {
          if (!boundSet.has(item.deviceId)) continue // 未绑定设备忽略（防越行写）
          const existing = priorEnvByDevice?.get(item.deviceId) ?? {}
          const merged: Record<string, string> = {}
          for (const [k, v] of Object.entries(item.env ?? {})) {
            if (v === UNCHANGED_ENV_SENTINEL) {
              if (existing[k] !== undefined) merged[k] = existing[k]
            } else if (v !== '') {
              merged[k] = v
            }
          }
          const envStr = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null
          stmtUpdRel.run(envStr ? encField(envStr, McpService.MK) : null, finalId, item.deviceId)
        }
      }

      const row = conn.prepare('SELECT * FROM mcp_configs WHERE id = ?').get(finalId) as any
      const relRows = conn.prepare('SELECT device_id, env_json_enc FROM mcp_device_rel WHERE mcp_config_id = ? ORDER BY created_at, device_id')
        .all(finalId) as Array<{ device_id: string }>
      result = { ok: true, config: McpService.rowToView(row, relRows) }
    })
    tx()
    return result!
  }

  /**
   * 主表 DELETE，mcp_device_rel 随 FK CASCADE 消失（Popconfirm 数据层级联）。
   * WR-03：先杀该 configId 全部运行中 stdio 实例（对齐 deletePackage 语义——防子进程
   * 持用户 env 明文残留至 10 分钟空闲回收）。
   * WR-06：包根配置（同包 MIN(id) 策略模板载体）删除保护——mcp_tools 随 FK CASCADE 清空
   * 会连带兄弟配置的工具启用/免确认策略瞬时归零，拒绝并提示改走删包入口。
   */
  static deleteConfig(id: number): { ok: true } | { ok: false; error: string } {
    const conn = McpService.db()
    const row = conn.prepare('SELECT id, source, package_id FROM mcp_configs WHERE id = ?')
      .get(id) as { id: number; source: string; package_id: number | null } | undefined
    if (!row) return { ok: true } // 幂等：行已不在即视为删净
    if (row.source === 'package' && row.package_id != null) {
      const root = conn.prepare('SELECT MIN(id) AS rootId FROM mcp_configs WHERE package_id = ?')
        .get(row.package_id) as { rootId: number | null } | undefined
      if (root?.rootId === id) {
        return {
          ok: false,
          error: '该配置是所在包的工具策略模板载体（首条包配置），删除会导致同包全部配置的工具启用/免确认策略一并丢失——如需移除请删除整个包',
        }
      }
    }
    for (const rec of McpProcessRegistry.listActive()) {
      if (String(rec.configId).split(':')[0] === String(id)) McpProcessRegistry.killTree(rec.pid)
    }
    conn.prepare('DELETE FROM mcp_configs WHERE id = ?').run(id)
    return { ok: true }
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
