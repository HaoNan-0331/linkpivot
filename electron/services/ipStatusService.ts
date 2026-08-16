import { getDatabase } from '../database/connection'

export class IPStatusService {
  static beginCollection(): string {
    return new Date().toISOString()
  }

  static updateIPStatus(ip: string, mac: string, collectionTime: string): void {
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM ip_status WHERE ip = ?').get(ip) as any
    if (existing) {
      db.prepare('UPDATE ip_status SET mac = ?, status = \'used\', last_seen = ?, updated_at = CURRENT_TIMESTAMP WHERE ip = ?')
        .run(mac, collectionTime, ip)
    } else {
      db.prepare('INSERT INTO ip_status (ip, mac, status, first_seen, last_seen) VALUES (?, ?, \'used\', ?, ?)')
        .run(ip, mac, collectionTime, collectionTime)
    }
  }

  static batchUpdateIPStatus(entries: Array<{ ip: string; mac: string }>, collectionTime: string): void {
    const db = getDatabase()
    const updateExisting = db.prepare('UPDATE ip_status SET mac = ?, status = \'used\', last_seen = ?, updated_at = CURRENT_TIMESTAMP WHERE ip = ?')
    const insertNew = db.prepare('INSERT INTO ip_status (ip, mac, status, first_seen, last_seen) VALUES (?, ?, \'used\', ?, ?)')
    // 18-04（TXN-02）：exists 探测语句提到事务定义之前（与上两 stmt 并排），事务回调体内零 db.prepare
    const existsProbe = db.prepare('SELECT 1 FROM ip_status WHERE ip = ?')
    const transaction = db.transaction((items: Array<{ ip: string; mac: string }>) => {
      for (const entry of items) {
        const existing = existsProbe.get(entry.ip)
        if (existing) { updateExisting.run(entry.mac, collectionTime, entry.ip) }
        else { insertNew.run(entry.ip, entry.mac, collectionTime, collectionTime) }
      }
    })
    transaction(entries)
  }

  static endCollection(collectionTime: string, networkPrefix?: string): number {
    const db = getDatabase()
    let query = 'UPDATE ip_status SET status = \'deprecated\', updated_at = CURRENT_TIMESTAMP WHERE last_seen < ? AND status = \'used\''
    const params: any[] = [collectionTime]
    if (networkPrefix) { query += ' AND ip LIKE ?'; params.push(`${networkPrefix}.%`) }
    const result = db.prepare(query).run(...params)
    return result.changes
  }

  static getStatusStats(prefix?: string): { used: number; deprecated: number } {
    const db = getDatabase()
    let query = 'SELECT status, COUNT(*) as count FROM ip_status'
    const params: any[] = []
    if (prefix) { query += ' WHERE ip LIKE ?'; params.push(`${prefix}.%`) }
    query += ' GROUP BY status'
    const rows = db.prepare(query).all(...params) as any[]
    const stats = { used: 0, deprecated: 0 }
    for (const row of rows) {
      if (row.status === 'used') stats.used = row.count
      if (row.status === 'deprecated') stats.deprecated = row.count
    }
    return stats
  }
}
