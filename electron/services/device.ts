import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'

let MK = ''

export function setDeviceMasterKey(key: string) { MK = key }

function enc(val: string | null | undefined): string | null { return encField(val, MK) }
function dec(val: string | null | undefined): string { return decField(val, MK) }

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
  }
}

export function listDevices() {
  return (getDatabase().prepare('SELECT * FROM devices ORDER BY created_at DESC').all() as any[]).map(rowToDevice)
}

export function createDevice(data: any) {
  const db = getDatabase()
  const id = uuidv4()
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO devices (id, name_enc, vendor_enc, model_enc, version_enc, ip_enc,
      device_type, connection_type, port_enc, username_enc, password_enc,
      ssh_key_path_enc, ssh_key_content_enc, web_url_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, enc(data.name), enc(data.vendor), enc(data.model), enc(data.version),
    enc(data.ipAddress), data.deviceType || 'generic', data.connectionType,
    enc(data.port?.toString()), enc(data.username), enc(data.password),
    enc(data.sshKeyPath), enc(data.sshKeyContent), enc(data.webUrl), now, now)

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

  vals.push(id)
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals)

  // Sync: update embedded device info in all topologies that reference this device
  const topoFields: Record<string, string> = {
    name: 'deviceName', deviceType: 'deviceType', connectionType: 'connectionType',
    ipAddress: 'ipAddress', vendor: 'vendor', model: 'model',
  }
  const changedFields = Object.keys(topoFields).filter(k => data[k] !== undefined)
  if (changedFields.length > 0) {
    const topologies = db.prepare('SELECT id, data_enc FROM topologies').all() as any[]
    for (const topo of topologies) {
      const dataStr = dec(topo.data_enc)
      const topoData = JSON.parse(dataStr)
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
        db.prepare('UPDATE topologies SET data_enc = ?, updated_at = ? WHERE id = ?')
          .run(encField(JSON.stringify(topoData), MK), now, topo.id)
      }
    }
  }

  return rowToDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(id))
}

export function deleteDevice(id: string) {
  const db = getDatabase()
  // Cascade: remove device node from all topologies that reference this device
  const topologies = db.prepare('SELECT id, data_enc FROM topologies').all() as any[]
  for (const topo of topologies) {
    const dataStr = dec(topo.data_enc)
    const data = JSON.parse(dataStr)
    if (data.nodes) {
      const filtered = data.nodes.filter((n: any) => n.id !== id && n.data?.deviceId !== id)
      if (filtered.length !== data.nodes.length) {
        data.nodes = filtered
        data.edges = (data.edges || []).filter((e: any) => e.source !== id && e.target !== id)
        const newDataStr = JSON.stringify(data)
        db.prepare('UPDATE topologies SET data_enc = ?, updated_at = ? WHERE id = ?')
          .run(encField(newDataStr, MK), new Date().toISOString(), topo.id)
      }
    }
  }
  db.prepare('DELETE FROM devices WHERE id = ?').run(id)
}

export function getDeviceById(id: string) {
  const row = getDatabase().prepare('SELECT * FROM devices WHERE id = ?').get(id) as any
  return row ? rowToDevice(row) : null
}
