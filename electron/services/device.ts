import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { hashDeviceName } from './deviceName'

let MK = ''

export function setDeviceMasterKey(key: string) { MK = key }

function enc(val: string | null | undefined): string | null { return encField(val, MK) }
function dec(val: string | null | undefined): string { return decField(val, MK) }

/**
 * H-1（v0.3.0 audit）：设备凭证 IPC 边界脱敏投影（纯函数）。
 *
 * 红线：renderer 任何 IPC 返回值中不含明文 password/sshKeyContent（只可能收到 ****尾4位，
 * 与 ai.ts getAiConfigMasked 同格式）。仅 IPC 出口（device:list/getById、experience:listDevices）
 * 包裹；service 内部主进程明文消费方（connection.ts 终端连接、arpCollector 采集、
 * experienceService 主进程路径）不受影响。
 */
export function maskDeviceSecrets<T>(device: T): T {
  const masked: Record<string, unknown> = { ...(device as Record<string, unknown>) }
  for (const key of ['password', 'sshKeyContent'] as const) {
    const v = masked[key]
    if (typeof v === 'string' && v.length > 0) masked[key] = `****${v.slice(-4)}`
  }
  return masked as T
}

/**
 * Phase 23（23-03，DSL-03/D-04）：能力三布尔单源派生——device.ts rowToDevice 与
 * ai.ts getDeviceByIdInternal 共用（消除两处派生漂移）。hasSSH/hasTelnet 严格按
 * connectionType 派生，hasMcp 由调用方 SQL LEFT JOIN 带出的 has_mcp 派生。
 */
export function deriveCapabilities(row: {
  connection_type?: string | null
  has_mcp?: number | boolean | null
}): { hasSSH: boolean; hasTelnet: boolean; hasMcp: boolean } {
  return {
    hasSSH: row.connection_type === 'ssh',
    hasTelnet: row.connection_type === 'telnet',
    hasMcp: Boolean(row.has_mcp),
  }
}

function rowToDevice(row: any): any {
  return {
    id: row.id,
    topologyId: row.topology_id,
    name: dec(row.name_enc),
    vendor: dec(row.vendor_enc),
    model: dec(row.model_enc),
    version: dec(row.version_enc),
    ipAddress: dec(row.ip_enc),
    deviceType: row.device_type || 'generic',
    connectionType: row.connection_type,
    port: dec(row.port_enc) ? parseInt(dec(row.port_enc)) : null,
    username: dec(row.username_enc),
    password: dec(row.password_enc),
    sshKeyPath: dec(row.ssh_key_path_enc),
    sshKeyContent: dec(row.ssh_key_content_enc),
    webUrl: dec(row.web_url_enc),
    status: row.status || 'unknown',
    lastChecked: row.last_checked || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Phase 23（DSL-03/D-02）：能力三布尔随投影下发——hasSSH/hasTelnet 严格按 connectionType
    // 派生（不猜通道），hasMcp 由 mcp_device_rel 关联存在性派生（listDevices LEFT JOIN 带 has_mcp）。
    // 三布尔独立不做最高档合并；非敏感字段，出口经 maskDeviceSecrets 原样透传。
    capabilities: deriveCapabilities(row),
  }
}

export function listDevices() {
  // DSL-03：单条 SQL LEFT JOIN 派生 hasMcp（mcp_device_rel.device_id UNIQUE 保证一对一，无重复行）；
  // prepare 在 .all() 调用处一次构造、map 外复用，无 N+1；无缓存现查（锁定决策）。
  return (
    getDatabase().prepare(`
      SELECT d.*, (r.device_id IS NOT NULL) AS has_mcp
      FROM devices d
      LEFT JOIN mcp_device_rel r ON r.device_id = d.id
      ORDER BY d.created_at DESC
    `).all() as any[]
  ).map(rowToDevice)
}

/**
 * Phase 25（25-02，ASSET-03/D-12）：name_hash 冲突行 → 可读错误。
 * 冲突设备名称/IP 经 dec 解密后拼入 message（不输出密文）；设备名/IP 对已登录用户
 * 本就可见，无新增泄露面（T-25-07 accept），不返回凭证类字段。
 */
function deviceNameConflictError(conflictRow: any): Error {
  return new Error(`设备名称已存在：${dec(conflictRow.name_enc)} (${dec(conflictRow.ip_enc)})`)
}

export function createDevice(data: any) {
  const db = getDatabase()
  const id = uuidv4()
  const now = new Date().toISOString()
  const nameHash = hashDeviceName(String(data.name ?? ''))

  // Phase 25（25-02，ASSET-03）：唯一预检 + INSERT 同事务（防 TOCTOU，DB UNIQUE 是第二道兜底）。
  const tx = db.transaction(() => {
    const stmtFindByNameHash = db.prepare('SELECT id, name_enc, ip_enc FROM devices WHERE name_hash = ?')
    const conflict = stmtFindByNameHash.get(nameHash) as any
    if (conflict) throw deviceNameConflictError(conflict)

    db.prepare(`
      INSERT INTO devices (id, name_enc, vendor_enc, model_enc, version_enc, ip_enc,
        device_type, connection_type, port_enc, username_enc, password_enc,
        ssh_key_path_enc, ssh_key_content_enc, web_url_enc, created_at, updated_at, name_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, enc(data.name), enc(data.vendor), enc(data.model), enc(data.version),
      enc(data.ipAddress), data.deviceType || 'generic', data.connectionType,
      enc(data.port?.toString()), enc(data.username), enc(data.password),
      enc(data.sshKeyPath), enc(data.sshKeyContent), enc(data.webUrl), now, now, nameHash)
  })
  tx()

  return rowToDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(id))
}

export function updateDevice(id: string, data: any) {
  const db = getDatabase()
  const now = new Date().toISOString()
  const sets: string[] = ['updated_at = ?']
  const vals: any[] = [now]

  const encMap: Record<string, string> = {
    name: 'name_enc', vendor: 'vendor_enc', model: 'model_enc', version: 'version_enc',
    ipAddress: 'ip_enc', port: 'port_enc', username: 'username_enc', password: 'password_enc',
    sshKeyPath: 'ssh_key_path_enc', sshKeyContent: 'ssh_key_content_enc', webUrl: 'web_url_enc',
  }

  for (const [key, col] of Object.entries(encMap)) {
    if (data[key] !== undefined) { sets.push(`${col} = ?`); vals.push(enc(String(data[key]))) }
  }
  if (data.connectionType !== undefined) { sets.push('connection_type = ?'); vals.push(data.connectionType) }
  if (data.deviceType !== undefined) { sets.push('device_type = ?'); vals.push(data.deviceType) }

  // Phase 25（25-02，ASSET-03）：重命名时维护 name_hash 并在事务内查重（排除自身 id，D-11）。
  // name 未传（undefined）不触发查重也不改 hash，避免编辑其他字段被误拦。
  let newNameHash: string | null = null
  if (data.name !== undefined) {
    newNameHash = hashDeviceName(String(data.name))
    sets.push('name_hash = ?')
    vals.push(newNameHash)
  }

  vals.push(id)

  // Sync: update embedded device info in all topologies that reference this device
  const topoFields: Record<string, string> = {
    name: 'deviceName', deviceType: 'deviceType', connectionType: 'connectionType',
    ipAddress: 'ipAddress', vendor: 'vendor', model: 'model',
  }
  const changedFields = Object.keys(topoFields).filter(k => data[k] !== undefined)

  // TXN-01（18-02）：devices UPDATE + 拓扑 JSON 级联包同一同步事务，中途失败整体回滚（无半写状态）。
  // 循环内 JSON.parse catch+continue 行级容错原样保留进事务体（P8 禁顺手删 catch）；
  // UPDATE topologies 的 prepare 提循环外复用（TXN-02 精神）；encField/decField 加密调用不动。
  const tx = db.transaction(() => {
    // 唯一预检与 UPDATE 同事务（TOCTOU 防护）；排除自身 id，改回自身原名不误拦（D-11）。
    if (newNameHash !== null) {
      const conflict = db.prepare(
        'SELECT id, name_enc, ip_enc FROM devices WHERE name_hash = ? AND id != ?'
      ).get(newNameHash, id) as any
      if (conflict) throw deviceNameConflictError(conflict)
    }
    db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    if (changedFields.length > 0) {
      const topologies = db.prepare('SELECT id, data_enc FROM topologies').all() as any[]
      const stmtUpdateTopo = db.prepare('UPDATE topologies SET data_enc = ?, updated_at = ? WHERE id = ?')
      for (const topo of topologies) {
        let topoData: any
        try {
          topoData = JSON.parse(dec(topo.data_enc))
        } catch (e) {
          console.error('[device] 拓扑数据解析失败，跳过该拓扑:', topo.id, e)
          continue
        }
        let modified = false
        if (topoData.nodes) {
          for (const node of topoData.nodes) {
            if (node.data?.deviceId === id) {
              for (const field of changedFields) {
                node.data[topoFields[field]] = data[field]
              }
              modified = true
            }
          }
        }
        if (modified) {
          stmtUpdateTopo.run(encField(JSON.stringify(topoData), MK), now, topo.id)
        }
      }
    }
  })
  tx()

  return rowToDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(id))
}

export function deleteDevice(id: string) {
  const db = getDatabase()
  // TXN-01（18-02）：拓扑级联清理 + devices 行删除包同一同步事务，中途失败整体回滚。
  // JSON.parse catch+continue 行级容错原样保留进事务体（P8）；UPDATE prepare 提循环外复用（TXN-02）。
  const tx = db.transaction(() => {
    // Cascade: remove device node from all topologies that reference this device
    const topologies = db.prepare('SELECT id, data_enc FROM topologies').all() as any[]
    const stmtUpdateTopo = db.prepare('UPDATE topologies SET data_enc = ?, updated_at = ? WHERE id = ?')
    for (const topo of topologies) {
      let data: any
      try {
        data = JSON.parse(dec(topo.data_enc))
      } catch (e) {
        console.error('[device] 拓扑数据解析失败，跳过该拓扑:', topo.id, e)
        continue
      }
      if (data.nodes) {
        const filtered = data.nodes.filter((n: any) => n.id !== id && n.data?.deviceId !== id)
        if (filtered.length !== data.nodes.length) {
          data.nodes = filtered
          data.edges = (data.edges || []).filter((e: any) => e.source !== id && e.target !== id)
          const newDataStr = JSON.stringify(data)
          stmtUpdateTopo.run(encField(newDataStr, MK), new Date().toISOString(), topo.id)
        }
      }
    }
    db.prepare('DELETE FROM devices WHERE id = ?').run(id)
  })
  tx()
}

export function getDeviceById(id: string) {
  const row = getDatabase().prepare('SELECT * FROM devices WHERE id = ?').get(id) as any
  return row ? rowToDevice(row) : null
}

/**
 * Phase 25（25-02，ASSET-03/D-11）：设备名查重——提示性预检（供 25-03 IPC onBlur /
 * 25-04 批量行内标红复用）。命中返回冲突设备 { name, ipAddress } 明文，未命中返回 null。
 *
 * 非硬防线：预检与保存间隙的 TOCTOU 由保存路径事务内校验兜底（T-25-06 accept）；
 * excludeId 传入时排除该设备自身（编辑场景改名不改名自查）。
 */
export function checkDeviceName(
  name: string,
  excludeId?: string
): { name: string; ipAddress: string } | null {
  const db = getDatabase()
  const hash = hashDeviceName(name)
  const row = (
    excludeId !== undefined
      ? db.prepare('SELECT name_enc, ip_enc FROM devices WHERE name_hash = ? AND id != ?').get(hash, excludeId)
      : db.prepare('SELECT name_enc, ip_enc FROM devices WHERE name_hash = ?').get(hash)
  ) as any
  if (!row) return null
  return { name: dec(row.name_enc), ipAddress: dec(row.ip_enc) }
}
