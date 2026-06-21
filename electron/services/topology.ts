import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/connection'
import { encField, decField } from '../utils/crypto'

let MK = ''

export function setTopologyMasterKey(key: string) { MK = key }

function enc(val: string | null | undefined): string | null { return encField(val, MK) }
function dec(val: string | null | undefined): string { return decField(val, MK) }

interface TopologyData {
  nodes: any[]
  edges: any[]
}

function rowToTopology(row: any, includeData = false): any {
  const result: any = {
    id: row.id,
    name: dec(row.name_enc),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (includeData && row.data_enc) {
    const dataStr = dec(row.data_enc)
    const data: TopologyData = JSON.parse(dataStr)
    result.nodes = data.nodes || []
    result.edges = data.edges || []
  }
  return result
}

export function listTopologies() {
  const rows = getDatabase()
    .prepare('SELECT * FROM topologies ORDER BY updated_at DESC')
    .all() as any[]
  return rows.map((row) => rowToTopology(row, false))
}

export function getTopologyById(id: string) {
  const row = getDatabase()
    .prepare('SELECT * FROM topologies WHERE id = ?')
    .get(id) as any
  return row ? rowToTopology(row, true) : null
}

export function createTopology(data: any) {
  const db = getDatabase()
  const id = uuidv4()
  const now = new Date().toISOString()
  const topologyData: TopologyData = {
    nodes: data.nodes || [],
    edges: data.edges || [],
  }
  const dataStr = JSON.stringify(topologyData)

  db.prepare(`
    INSERT INTO topologies (id, name_enc, data_enc, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, enc(data.name), enc(dataStr), data.status || 'draft', now, now)

  return rowToTopology(
    db.prepare('SELECT * FROM topologies WHERE id = ?').get(id),
    true
  )
}

export function updateTopology(id: string, data: any) {
  const db = getDatabase()
  const now = new Date().toISOString()
  const sets: string[] = ['updated_at = ?']
  const vals: any[] = [now]

  if (data.name !== undefined) {
    sets.push('name_enc = ?')
    vals.push(enc(data.name))
  }
  if (data.status !== undefined) {
    sets.push('status = ?')
    vals.push(data.status)
  }
  if (data.nodes !== undefined || data.edges !== undefined) {
    const existing = db.prepare('SELECT data_enc FROM topologies WHERE id = ?').get(id) as any
    let existingData: TopologyData = { nodes: [], edges: [] }
    if (existing?.data_enc) {
      existingData = JSON.parse(dec(existing.data_enc))
    }
    if (data.nodes !== undefined) existingData.nodes = data.nodes
    if (data.edges !== undefined) existingData.edges = data.edges
    sets.push('data_enc = ?')
    vals.push(enc(JSON.stringify(existingData)))
  }

  vals.push(id)
  db.prepare(`UPDATE topologies SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function deleteTopology(id: string) {
  const db = getDatabase()
  db.prepare('UPDATE devices SET topology_id = NULL WHERE topology_id = ?').run(id)
  db.prepare('DELETE FROM topologies WHERE id = ?').run(id)
}

export function exportTopology(id: string): string {
  const row = getDatabase()
    .prepare('SELECT * FROM topologies WHERE id = ?')
    .get(id) as any
  if (!row) throw new Error('Topology not found')

  const topo = rowToTopology(row, true)
  return JSON.stringify(topo, null, 2)
}

export function importTopology(jsonStr: string) {
  let data: any
  try {
    data = JSON.parse(jsonStr)
  } catch {
    throw new Error('无效的 JSON 格式')
  }
  if (!data || typeof data !== 'object') throw new Error('JSON 必须是对象')
  if (data.nodes !== undefined && !Array.isArray(data.nodes)) throw new Error('nodes 必须是数组')
  if (data.edges !== undefined && !Array.isArray(data.edges)) throw new Error('edges 必须是数组')
  const MAX_NODES = 5000
  if (Array.isArray(data.nodes) && data.nodes.length > MAX_NODES) {
    throw new Error(`节点数量超过上限 ${MAX_NODES}，请精简后导入`)
  }
  return createTopology({
    name: data.name || 'Imported Topology',
    nodes: data.nodes || [],
    edges: data.edges || [],
    status: data.status || 'draft',
  })
}
