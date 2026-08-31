import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'
import { hashDeviceName } from './deviceName'
import { v24 } from '../database/migrations'

let MK = ''

export function setDeviceMasterKey(key: string) { MK = key }

function enc(val: string | null | undefined): string | null { return encField(val, MK) }
function dec(val: string | null | undefined): string { return decField(val, MK) }

/** Phase 36（36-02，LOGIN-01）：四通道固定序——channels 投影排序 / 写路径规范化 / D-09 滑落共用。 */
const CHANNEL_ORDER = ['ssh', 'telnet', 'web', 'rdp'] as const

function isKnownChannel(ch: unknown): ch is string {
  return typeof ch === 'string' && (CHANNEL_ORDER as readonly string[]).includes(ch)
}

/** Phase 36（36-03，D-10）：命令行通道固定回退序——SSH > Telnet（连接悬空回退 / AI 执行 / ARP 采集三链共用）。 */
const CMD_ORDER = ['ssh', 'telnet'] as const

/**
 * Phase 36（36-03，D-10）：有效命令通道解析（纯函数）。
 * 默认通道（connection_type）是 ssh/telnet 且在已配通道集合内 → 用之；否则按 CMD_ORDER
 * 固定序回退到首条已配命令行通道（默认 web/rdp 或悬空时的兜底）；无命令行通道 → null
 * （消费方 capabilities 派生 false，isDeviceExecutable fail-closed 既有行为，Pitfall 5）。
 */
export function resolveExecChannel(defaultChannel: string | null, channels: string[]): 'ssh' | 'telnet' | null {
  if (
    defaultChannel !== null &&
    (CMD_ORDER as readonly string[]).includes(defaultChannel) &&
    channels.includes(defaultChannel)
  ) {
    return defaultChannel as 'ssh' | 'telnet'
  }
  for (const ch of CMD_ORDER) {
    if (channels.includes(ch)) return ch
  }
  return null
}

/** H-1 脱敏字段清单（顶层与 channels 元素同名递归共用）。resolution 非敏感不在清单（D-04）。 */
const SECRET_KEYS = ['password', 'sshKeyContent'] as const

/**
 * H-1（v0.3.0 audit）：设备凭证 IPC 边界脱敏投影（纯函数）。
 *
 * 红线：renderer 任何 IPC 返回值中不含明文 password/sshKeyContent（只可能收到 ****尾4位，
 * 与 ai.ts getAiConfigMasked 同格式）。所有 device IPC 出口（device:list/getById/create/update、
 * experience:listDevices）包裹；service 内部主进程明文消费方（connection.ts 终端连接、arpCollector 采集、
 * experienceService 主进程路径）不受影响。
 *
 * Phase 36（36-02，Pitfall 4）：channels 嵌套递归脱敏——子表凭证同红线，漏递归即明文出 main。
 * main.ts 既有 device IPC 出口 .map(maskDeviceSecrets) 零改动覆盖（递归天然生效）。
 */
export function maskDeviceSecrets<T>(device: T): T {
  const masked: Record<string, unknown> = { ...(device as Record<string, unknown>) }
  for (const key of SECRET_KEYS) {
    const v = masked[key]
    if (typeof v === 'string' && v.length > 0) masked[key] = `****${v.slice(-4)}`
  }
  if (Array.isArray(masked.channels)) {
    masked.channels = (masked.channels as Record<string, unknown>[]).map((ch) => {
      const m = { ...ch }
      for (const key of SECRET_KEYS) {
        const v = m[key]
        if (typeof v === 'string' && v.length > 0) m[key] = `****${v.slice(-4)}`
      }
      return m
    })
  }
  return masked as T
}

/**
 * Phase 23（23-03，DSL-03/D-04）：能力三布尔单源派生——device.ts rowToDevice 与
 * ai.ts getDeviceByIdInternal 共用（消除两处派生漂移）。hasMcp 由调用方 SQL LEFT JOIN
 * 带出的 has_mcp 派生。
 *
 * Phase 36（36-02，D-05）：channels 在场按子表行存在性派生 hasSSH/hasTelnet（可同真）；
 * 缺场按 connection_type 旧严格派生——过渡签名保 aiExec.ts 既有调用方编译绿
 * （36-03 切换后改必传）。三布尔恒 boolean 不出 undefined（Pitfall 5：
 * isDeviceExecutable fail-closed 对 capabilities 缺失敏感，禁 undefined）。
 */
export function deriveCapabilities(row: {
  connection_type?: string | null
  has_mcp?: number | boolean | null
}, channels?: string[]): { hasSSH: boolean; hasTelnet: boolean; hasMcp: boolean } {
  return {
    hasSSH: channels ? channels.includes('ssh') : row.connection_type === 'ssh',
    hasTelnet: channels ? channels.includes('telnet') : row.connection_type === 'telnet',
    hasMcp: Boolean(row.has_mcp),
  }
}

/**
 * device_credentials 行 → channels 投影元素（main 进程内明文；IPC 出口经 maskDeviceSecrets
 * 递归脱敏后才到 renderer）。decField 降级空串按空值呈现，行仍保留（单行坏密文不阻断
 * 通道存在性表达）。resolution 为明文列直读（D-04 裁决补记 2026-08-31：非敏感不入 _enc，
 * 不经 decField；仅 RDP 通道行有语义值）。
 */
function credRowToChannel(c: any) {
  const portStr = dec(c.port_enc)
  return {
    channel: c.channel,
    port: portStr ? parseInt(portStr) : null,
    username: dec(c.username_enc),
    password: dec(c.password_enc),
    sshKeyPath: dec(c.ssh_key_path_enc),
    sshKeyContent: dec(c.ssh_key_content_enc),
    webUrl: dec(c.web_url_enc),
    resolution: (c.resolution ?? null) as string | null,
  }
}

/** Phase 36（36-03，LOGIN-02）：channels 明文行形态（main 进程内消费；IPC 出口经 maskDeviceSecrets 递归脱敏）。 */
export interface DeviceChannelRow {
  channel: string
  port: number | null
  username: string
  password: string
  sshKeyPath: string
  sshKeyContent: string
  webUrl: string
  resolution: string | null
}

/** device_credentials 行集合 → 固定序 channels 投影（rowToDevice 与 getDeviceChannels 共用）。 */
function assembleChannels(credRows: any[]): DeviceChannelRow[] {
  const byChannel = new Map<string, any>()
  for (const c of credRows) {
    if (isKnownChannel(c?.channel)) byChannel.set(c.channel, c)
  }
  return (CHANNEL_ORDER as readonly string[])
    .map((ch) => byChannel.get(ch))
    .filter((c) => c !== undefined)
    .map(credRowToChannel)
}

/**
 * Phase 36（36-03）：单设备已配通道明文行（CHANNEL_ORDER 固定序，与投影 channels 同构）。
 * 连接（openTerminal 通道分流）/AI 执行（getDeviceByIdInternal D-10 投影）/ARP 采集三链
 * 按 (device_id, channel) 行级定位凭证用。
 */
export function getDeviceChannels(deviceId: string): DeviceChannelRow[] {
  const db = getDatabase()
  const credRows = db.prepare('SELECT * FROM device_credentials WHERE device_id = ?').all(deviceId) as any[]
  return assembleChannels(credRows)
}

function rowToDevice(row: any, credRows: any[] = []): any {
  // Phase 36（36-02，D-08）：顶层六凭证字段平铺解密移除（不留双源）——凭证唯一真源为
  // device_credentials 子表，经 channels 投影按固定序组装下发。capabilities 改子表派生。
  const channels = assembleChannels(credRows)
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
    channels,
    status: row.status || 'unknown',
    lastChecked: row.last_checked || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Phase 23（DSL-03/D-02）→ Phase 36（D-05）：三布尔随投影下发，hasSSH/hasTelnet 按
    // channels 集合派生（可同真），hasMcp 由 mcp_device_rel 关联存在性派生（LEFT JOIN 带
    // has_mcp）；三布尔独立不做最高档合并；非敏感字段，出口经 maskDeviceSecrets 原样透传。
    capabilities: deriveCapabilities(row, channels.map((c) => c.channel)),
  }
}

export function listDevices() {
  // DSL-03：单条 SQL LEFT JOIN 派生 hasMcp（mcp_device_rel.device_id UNIQUE 保证一对一，无重复行）。
  // Phase 36（36-02，Open Q4 改良裁决）：第二条 prepared 全量查 device_credentials → JS 按
  // device_id 分组 → rowToDevice 消费——两条 prepare 各一次（迭代外，不随设备数增长，无 N+1），
  // 规避 GROUP_CONCAT 多列配对脆弱性；无缓存现查（锁定决策）。
  const db = getDatabase()
  const rows = db.prepare(`
      SELECT d.*, (r.device_id IS NOT NULL) AS has_mcp
      FROM devices d
      LEFT JOIN mcp_device_rel r ON r.device_id = d.id
      ORDER BY d.created_at DESC
    `).all() as any[]
  const credRows = db.prepare('SELECT * FROM device_credentials').all() as any[]
  const credsByDevice = new Map<string, any[]>()
  for (const c of credRows) {
    const list = credsByDevice.get(c.device_id)
    if (list) list.push(c)
    else credsByDevice.set(c.device_id, [c])
  }
  return rows.map((row) => rowToDevice(row, credsByDevice.get(row.id) ?? []))
}

/**
 * Phase 25（25-02，ASSET-03/D-12）：name_hash 冲突行 → 可读错误。
 * 冲突设备名称/IP 经 dec 解密后拼入 message（不输出密文）；设备名/IP 对已登录用户
 * 本就可见，无新增泄露面（T-25-07 accept），不返回凭证类字段。
 */
function deviceNameConflictError(conflictRow: any): Error {
  return new Error(`设备名称已存在：${dec(conflictRow.name_enc)} (${dec(conflictRow.ip_enc)})`)
}

/**
 * Phase 36（36-02，LOGIN-01）：通道节来源归一。
 * data.channels 在场 → 四通道固定序规范化（值域外节静默丢弃——DB CHECK 双层兜底
 * T-36-02-03；同通道重复节后到为准）。
 * 缺场 → 过渡 shim（本 plan 引入、36-04 移除）：旧平铺入参（port/username/password/
 * sshKeyPath/sshKeyContent/webUrl 在场字段）按 data.connectionType（update 缺省时取库内
 * 现存 connection_type）映射为单通道节走同一 UPSERT 路径，未改造 DeviceForm/DevicesPage
 * 行为不变（字段级 !== undefined 保留「留空=不修改」，H-1）。create 恒产生默认通道节
 * （旧形态 connectionType 必填且决定 capabilities 派生，行为保持）；update 仅平铺凭证
 * 字段在场时产生节点（纯改名等操作零通道写）。
 */
function resolveChannelNodes(data: any, currentConnectionType: string | null | undefined, mode: 'create' | 'update'): any[] {
  if (Array.isArray(data?.channels)) {
    const byChannel = new Map<string, any>()
    for (const node of data.channels) {
      if (!node || !isKnownChannel(node.channel)) continue
      byChannel.set(node.channel, node)
    }
    return (CHANNEL_ORDER as readonly string[]).filter((ch) => byChannel.has(ch)).map((ch) => byChannel.get(ch))
  }
  const FLAT_KEYS = ['port', 'username', 'password', 'sshKeyPath', 'sshKeyContent', 'webUrl'] as const
  const hasFlat = FLAT_KEYS.some((k) => data?.[k] !== undefined)
  if (mode === 'update' && !hasFlat) return []
  const channel = data?.connectionType !== undefined ? data.connectionType : (currentConnectionType ?? null)
  if (!isKnownChannel(channel)) return []
  return [{
    channel,
    enabled: true,
    port: data?.port,
    username: data?.username,
    password: data?.password,
    sshKeyPath: data?.sshKeyPath,
    sshKeyContent: data?.sshKeyContent,
    webUrl: data?.webUrl,
  }]
}

/**
 * Phase 36（36-02，LOGIN-01/Pitfall 8）：通道节写——enabled=true → UPSERT（凭证字段仅
 * 输入 !== undefined 时更新对应 _enc 列，「留空=不修改」按通道按字段生效，H-1）；
 * enabled=false → DELETE 该行（清空即禁用）。IIF 在场标志位（0/1）在单条常驻 prepared
 * 内实现字段级条件更新（UPSERT/DELETE 两条 prepare 循环外常驻，DB 性能红线）。
 * resolution 为明文列直写（!== undefined 才写、不进 encField——D-04 裁决补记；
 * 值仅 RDP 行有语义，服务层不做通道限定）。port 转 string 后 encField（v13 起字符串列）。
 */
function applyChannelNodes(db: ReturnType<typeof getDatabase>, deviceId: string, nodes: any[], now: string): void {
  const upsert = db.prepare(`
    INSERT INTO device_credentials
      (id, device_id, channel, port_enc, username_enc, password_enc,
       ssh_key_path_enc, ssh_key_content_enc, web_url_enc, resolution, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, channel) DO UPDATE SET
      port_enc = IIF(?, excluded.port_enc, device_credentials.port_enc),
      username_enc = IIF(?, excluded.username_enc, device_credentials.username_enc),
      password_enc = IIF(?, excluded.password_enc, device_credentials.password_enc),
      ssh_key_path_enc = IIF(?, excluded.ssh_key_path_enc, device_credentials.ssh_key_path_enc),
      ssh_key_content_enc = IIF(?, excluded.ssh_key_content_enc, device_credentials.ssh_key_content_enc),
      web_url_enc = IIF(?, excluded.web_url_enc, device_credentials.web_url_enc),
      resolution = IIF(?, excluded.resolution, device_credentials.resolution),
      updated_at = excluded.updated_at
  `)
  const del = db.prepare('DELETE FROM device_credentials WHERE device_id = ? AND channel = ?')
  const flag = (v: unknown) => (v !== undefined ? 1 : 0)
  for (const node of nodes) {
    if (node?.enabled === false) {
      del.run(deviceId, node.channel)
      continue
    }
    upsert.run(
      uuidv4(), deviceId, node.channel,
      node.port !== undefined ? enc(String(node.port)) : null,
      node.username !== undefined ? enc(node.username) : null,
      node.password !== undefined ? enc(node.password) : null,
      node.sshKeyPath !== undefined ? enc(node.sshKeyPath) : null,
      node.sshKeyContent !== undefined ? enc(node.sshKeyContent) : null,
      node.webUrl !== undefined ? enc(node.webUrl) : null,
      node.resolution !== undefined ? node.resolution : null,
      now, now,
      flag(node.port), flag(node.username), flag(node.password),
      flag(node.sshKeyPath), flag(node.sshKeyContent), flag(node.webUrl), flag(node.resolution)
    )
  }
}

/**
 * D-09 默认通道滑落（DB 权威，RESEARCH Pattern 3）：通道写操作全部执行后（同一设备写事务内，
 * T-36-02-04 原子）重查通道集合——connection_type 不在集合 → 按固定序 ssh > telnet > web > rdp
 * 滑到下一条已配通道；集合空 → 置 NULL（零通道，init.ts CHECK 无 NOT NULL 可空已验证）。
 * 返回是否发生变化及终值（变化时拓扑级联以终值刷新 connectionType，Pitfall 9 快照跟随）。
 */
function enforceDefaultChannel(db: ReturnType<typeof getDatabase>, deviceId: string, now: string): { changed: boolean; value: string | null } {
  const row = db.prepare('SELECT connection_type FROM devices WHERE id = ?').get(deviceId) as any
  const set = (db.prepare('SELECT channel FROM device_credentials WHERE device_id = ?').all(deviceId) as any[])
    .map((r) => r.channel as string)
  const current = (row?.connection_type ?? null) as string | null
  let final = current
  if (current === null || !set.includes(current)) {
    final = (CHANNEL_ORDER as readonly string[]).find((ch) => set.includes(ch)) ?? null
  }
  if (final !== current) {
    db.prepare('UPDATE devices SET connection_type = ?, updated_at = ? WHERE id = ?').run(final, now, deviceId)
    return { changed: true, value: final }
  }
  return { changed: false, value: current }
}

export function createDevice(data: any) {
  const db = getDatabase()
  const id = uuidv4()
  const now = new Date().toISOString()
  const nameHash = hashDeviceName(String(data.name ?? ''))

  // Phase 25（25-02，ASSET-03）：唯一预检 + INSERT 同事务（防 TOCTOU，DB UNIQUE 是第二道兜底）。
  // Phase 36（36-02，D-08）：主行 INSERT 移除六行内凭证列（fresh-install 不建/遗留库已随 v32
  // 回填清列）——凭证经通道节 UPSERT/DELETE 落 device_credentials（唯一真源），与主行同一事务。
  const tx = db.transaction(() => {
    const stmtFindByNameHash = db.prepare('SELECT id, name_enc, ip_enc FROM devices WHERE name_hash = ?')
    const conflict = stmtFindByNameHash.get(nameHash) as any
    if (conflict) throw deviceNameConflictError(conflict)

    db.prepare(`
      INSERT INTO devices (id, name_enc, vendor_enc, model_enc, version_enc, ip_enc,
        device_type, connection_type, created_at, updated_at, name_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, enc(data.name), enc(data.vendor), enc(data.model), enc(data.version),
      enc(data.ipAddress), data.deviceType || 'generic', data.connectionType ?? null, now, now, nameHash)

    // FK 即时校验：主行先行，通道行随后；D-09 滑落收尾（同一事务原子）
    const nodes = resolveChannelNodes(data, undefined, 'create')
    if (nodes.length > 0) applyChannelNodes(db, id, nodes, now)
    enforceDefaultChannel(db, id, now)
  })
  tx()

  return getDeviceById(id) as any
}

export function updateDevice(id: string, data: any) {
  const db = getDatabase()
  const now = new Date().toISOString()
  const sets: string[] = ['updated_at = ?']
  const vals: any[] = [now]

  // Phase 36（36-02，D-08）：六凭证键移出 encMap——主行不再写行内凭证（fresh-install 不建/
  // 遗留库已清列）；凭证走通道节 UPSERT/DELETE（device_credentials 唯一真源，见事务体）。
  const encMap: Record<string, string> = {
    name: 'name_enc', vendor: 'vendor_enc', model: 'model_enc', version: 'version_enc',
    ipAddress: 'ip_enc',
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
  // 级联取值：显式入参（!== undefined）优先；D-09 滑落终值在事务内覆写 connectionType
  //（connectionType 在 topoFields 级联集内，Pitfall 9 节点快照跟随默认通道终值刷新）。
  const cascadeValues: Record<string, unknown> = {}
  for (const field of Object.keys(topoFields)) {
    if (data[field] !== undefined) cascadeValues[field] = data[field]
  }

  // TXN-01（18-02）：devices UPDATE + 通道节写 + D-09 滑落 + 拓扑 JSON 级联包同一同步事务，
  // 中途失败整体回滚（无半写状态）。循环内 JSON.parse catch+continue 行级容错原样保留进
  // 事务体（P8 禁顺手删 catch）；UPDATE topologies 的 prepare 提循环外复用（TXN-02 精神）；
  // encField/decField 加密调用不动。
  const tx = db.transaction(() => {
    // 唯一预检与 UPDATE 同事务（TOCTOU 防护）；排除自身 id，改回自身原名不误拦（D-11）。
    if (newNameHash !== null) {
      const conflict = db.prepare(
        'SELECT id, name_enc, ip_enc FROM devices WHERE name_hash = ? AND id != ?'
      ).get(newNameHash, id) as any
      if (conflict) throw deviceNameConflictError(conflict)
    }
    // 过渡 shim 的通道解析锚点：data.connectionType 缺场时按库内现存默认通道映射（主 UPDATE 前）
    const before = db.prepare('SELECT connection_type FROM devices WHERE id = ?').get(id) as any
    db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    // Phase 36（36-02）：通道节 UPSERT/DELETE（channels DTO 或平铺 shim）+ D-09 滑落（原子）
    const nodes = resolveChannelNodes(data, before?.connection_type ?? null, 'update')
    if (nodes.length > 0) applyChannelNodes(db, id, nodes, now)
    const fallback = enforceDefaultChannel(db, id, now)
    if (fallback.changed) cascadeValues.connectionType = fallback.value
    const changedFields = Object.keys(cascadeValues)
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
                node.data[topoFields[field]] = cascadeValues[field]
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

  // Phase 25（25-03，ASSET-04/D-10）：重命名清零后即时建索引——事务提交成功后，
  // 仅重命名路径（data.name !== undefined）调 listDuplicateGroups 检测，重名组清零
  // 即调 ensureNameUniqueIndex 补建 UNIQUE 索引（防护当场生效，无需前端触发时序配合）。
  // 开销：设备量级几百 + name_hash 明文列 GROUP BY 毫秒级，可接受。
  // try/catch 包裹：失败仅 warn，不让已成功的重命名抛错（第二道兜底可下次启动/下次重命名补建）。
  if (data.name !== undefined) {
    try {
      if (listDuplicateGroups().length === 0) ensureNameUniqueIndex()
    } catch (e) {
      console.warn('[device] 重命名后补建 name_hash 唯一索引失败（non-blocking）:', e)
    }
  }

  return getDeviceById(id) as any
}

/**
 * Phase 25（25-03，ASSET-04/D-09）：存量重名分组扫描——供 UI 重名处理页区分展示。
 * 只按已回填的 name_hash 分组（name_hash IS NULL 的未回填行不参与，等 post-MK 回填后自然纳入）。
 * 返回成员解密后的 name/ipAddress 明文 + model/vendor；不含凭证字段（T-25-12 accept：
 * 登录用户本可在设备列表看到这些字段）。
 */
export function listDuplicateGroups(): Array<{
  nameHash: string
  devices: Array<{ id: string; name: string; ipAddress: string; model: string; vendor: string }>
}> {
  const db = getDatabase()
  const stmtMembers = db.prepare(
    'SELECT id, name_enc, ip_enc, model_enc, vendor_enc FROM devices WHERE name_hash = ? ORDER BY created_at'
  )
  return (
    db.prepare(
      'SELECT name_hash FROM devices WHERE name_hash IS NOT NULL GROUP BY name_hash HAVING COUNT(*) > 1'
    ).all() as any[]
  ).map((row) => ({
    nameHash: row.name_hash,
    devices: (stmtMembers.all(row.name_hash) as any[]).map((m) => ({
      id: m.id,
      name: dec(m.name_enc),
      ipAddress: dec(m.ip_enc),
      model: dec(m.model_enc),
      vendor: dec(m.vendor_enc),
    })),
  }))
}

/**
 * Phase 25（25-03，ASSET-04/v23）：post-MK 幂等回填——启动时（MK 注入后）把
 * name_hash IS NULL 的存量行解密 name_enc → hashDeviceName → 回填。
 * 逐点镜像 backfillSeverityFromHistory 幂等范式：WHERE 守卫 + prepare 提循环外 +
 * 单行 catch 跳过不 throw + 返回计数（含重名组数供启动日志/后续清零流程）。
 * 失败仅 warn 不阻塞启动（调用方 main.ts try/catch，T-25-11）。
 */
export function backfillNameHash(): { backfilled: number; duplicateGroups: number } {
  const db = getDatabase()
  const rows = db.prepare('SELECT id, name_enc FROM devices WHERE name_hash IS NULL').all() as any[]

  // Phase 25（25-05，缺陷修复）：回填-索引死锁自愈——v24 迁移先于回填跑，全表 NULL 时
  // 其清零门控误判成立（无重名组）→ UNIQUE 索引先建。此状态下回填存量重名行会违反
  // UNIQUE 被逐行 catch 静默跳过 → name_hash 永久 NULL（Alert 不现、查重失效）。
  // 语义：存量 NULL 行存在时，索引的「清零承诺」是假的，属无效索引——先 DROP 再回填。
  if (rows.length > 0) {
    const staleIndex = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_devices_name_hash'"
    ).get()
    if (staleIndex) db.exec('DROP INDEX idx_devices_name_hash')
  }

  const stmtUpdate = db.prepare('UPDATE devices SET name_hash = ? WHERE id = ?')
  let backfilled = 0
  for (const row of rows) {
    try {
      const name = dec(row.name_enc)
      if (!name) {
        // 空名守卫：dec 降级返回空串的行无法归一化，回填空名 hash 会把多行解密失败
        // 设备聚成假重名组——跳过留 NULL，待数据修复后下次启动自愈。
        console.warn('[device] 回填 name_hash 跳过空名/解密失败行:', row.id)
        continue
      }
      stmtUpdate.run(hashDeviceName(name), row.id)
      backfilled++
    } catch (e) {
      console.warn('[device] 回填 name_hash 单行失败，跳过:', row.id, e)
    }
  }
  const dup = db.prepare(
    'SELECT COUNT(*) AS c FROM (SELECT name_hash FROM devices WHERE name_hash IS NOT NULL GROUP BY name_hash HAVING COUNT(*) > 1)'
  ).get() as { c: number }
  return { backfilled, duplicateGroups: dup.c }
}

/**
 * Phase 25（25-03，ASSET-04/D-10；25-05 修正清零判定）：运行时复用 v24 清零门控建 UNIQUE 索引。
 * 真正清零 = NULL 行计数为 0 且无重名组（旧判定只看无重名组，v24 在全 NULL 时误建索引后
 * 幂等守卫 `if (existing) return true` 使中招库永无自愈路径）。
 * 索引已存在但仍有 NULL 行 → 索引清零前提从未成立，属无效索引：先 DROP 再按新判定评估。
 * 多次调用安全（真正清零后 no-op 返回 true）。
 */
export function ensureNameUniqueIndex(): boolean {
  const db = getDatabase()
  const nulls = db.prepare('SELECT COUNT(*) AS c FROM devices WHERE name_hash IS NULL')
    .get() as { c: number }
  const existing = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_devices_name_hash'"
  ).get()
  if (existing) {
    if (nulls.c === 0) return true // 真正清零：索引有效，no-op
    db.exec('DROP INDEX idx_devices_name_hash') // 无效索引（清零前提从未成立），撤后重评估
  }
  if (nulls.c > 0) return false // 尚有未回填行：未真正清零，不建
  return v24(db)
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
  // Phase 36（36-02）：凭证唯一真源 device_credentials——第二条 prepared（WHERE device_id）
  // 与主查各一次（迭代外），rowToDevice 组装 channels 投影（与 listDevices 同构，无 N+1）。
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any
  if (!row) return null
  const credRows = db.prepare('SELECT * FROM device_credentials WHERE device_id = ?').all(id) as any[]
  return rowToDevice(row, credRows)
}

/**
 * Phase 25（25-02，ASSET-03/D-11）：设备名查重——提示性预检（供 25-03 IPC onBlur /
 * 25-04 复制表单失焦查重复用）。命中返回冲突设备 { name, ipAddress } 明文，未命中返回 null。
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
