import { dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { getDatabase } from '../database/connection'

function ipToNumber(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return ((parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

function ipInCIDR(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr, 10)
  const ipNum = ipToNumber(ip)
  const netNum = ipToNumber(network)
  if (ipNum === null || netNum === null || isNaN(prefix) || prefix < 0 || prefix > 32) return false
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
  return (ipNum & mask) === (netNum & mask)
}

/** RFC4180 CSV 字段转义：含逗号/引号/换行的字段用双引号包裹，内部引号转义为 ""。 */
function csvEscape(field: any): string {
  const s = String(field ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export class ExportService {
  static async exportARPTable(): Promise<string | null> {
    const db = getDatabase()
    const rows = db.prepare('SELECT DISTINCT ip, mac, vlan, interface, MAX(collected_at) as collected_at FROM arp_entries GROUP BY ip, mac ORDER BY ip').all() as any[]
    if (rows.length === 0) throw new Error('没有 ARP 数据可导出')
    const csvLines = [
      'IP地址,MAC地址,VLAN,接口,最后采集时间',
      ...rows.map(row => [row.ip, row.mac || '', row.vlan || '', row.interface || '', row.collected_at || ''].map(csvEscape).join(','))
    ]
    return this.saveCSV(csvLines, 'arp-table')
  }

  static async exportChanges(unacknowledgedOnly: boolean = false): Promise<string | null> {
    const db = getDatabase()
    let query = 'SELECT ip, old_mac, new_mac, change_type, detected_at, acknowledged, acknowledged_at, notes FROM ip_mac_changes'
    if (unacknowledgedOnly) query += ' WHERE acknowledged = 0'
    query += ' ORDER BY detected_at DESC'
    const rows = db.prepare(query).all() as any[]
    if (rows.length === 0) throw new Error('没有变化事件可导出')
    const labels: Record<string, string> = { mac_changed: 'MAC变化', new_ip: '新IP', ip_reused: 'IP重用' }
    const csvLines = [
      'IP地址,原MAC,新MAC,变化类型,检测时间,已确认,确认时间,备注',
      ...rows.map(row => [row.ip, row.old_mac || '', row.new_mac || '', labels[row.change_type] || row.change_type, row.detected_at || '', row.acknowledged ? '是' : '否', row.acknowledged_at || '', row.notes || ''].map(csvEscape).join(','))
    ]
    return this.saveCSV(csvLines, 'ip-mac-changes')
  }

  static async exportNetworkUsage(networkId?: number): Promise<string | null> {
    const db = getDatabase()
    let networkQuery = 'SELECT id, name, network, cidr FROM network_segments'
    const params: any[] = []
    if (networkId) { networkQuery += ' WHERE id = ?'; params.push(networkId) }
    const networks = db.prepare(networkQuery).all(...params) as any[]
    if (networks.length === 0) throw new Error('没有网段数据可导出')
    const csvLines: string[] = ['网段名称,网段地址,CIDR,IP地址,MAC地址,状态,最后发现时间']
    for (const network of networks) {
      const cidr = `${network.network}/${network.cidr}`
      // 真实 CIDR 匹配（替代前3段 LIKE），修正非 /24 网段误计
      const ipRows = db.prepare(`SELECT latest.ip, latest.mac, latest.collected_at FROM (SELECT a.ip, a.mac, a.collected_at, ROW_NUMBER() OVER (PARTITION BY a.ip ORDER BY a.collected_at DESC) as rn FROM arp_entries a) latest WHERE latest.rn = 1 ORDER BY latest.ip`).all() as any[]
      for (const row of ipRows.filter((r) => ipInCIDR(r.ip, cidr))) {
        csvLines.push([network.name, network.network, String(network.cidr), row.ip, row.mac || '', '已使用', row.collected_at || ''].map(csvEscape).join(','))
      }
    }
    return this.saveCSV(csvLines, 'network-usage')
  }

  private static async saveCSV(lines: string[], defaultName: string): Promise<string | null> {
    const result = await dialog.showSaveDialog({
      title: '保存 CSV 文件',
      defaultPath: `${defaultName}-${this.getDateStr()}.csv`,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }, { name: '所有文件', extensions: ['*'] }],
    })
    if (result.canceled || !result.filePath) return null
    const content = '\uFEFF' + lines.join('\n')
    await writeFile(result.filePath, content, 'utf-8')
    return result.filePath
  }

  private static getDateStr(): string {
    const now = new Date()
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  }
}
