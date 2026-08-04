import { Client } from 'ssh2'
import { getDatabase } from '../database/connection'
import { ARPParser } from './arpParser'
import { encField, decField } from '../utils/crypto'
import { listDevices } from './device'
import { SSH_READY_TIMEOUT_MS, SSH_ALGORITHMS } from '../utils/sshConfig'
import { executeTelnetCommand } from '../utils/telnetExec'

let MK = ''
export function setArpMasterKey(key: string) { MK = key }

function dec(val: string | null | undefined): string { return decField(val, MK) }

interface ARPEntry { ip: string; mac: string; vlan?: string; interface?: string; aging?: number; type?: string }
interface ARPCollectionResult { deviceId: string; deviceName: string; deviceIp: string; vendor: string; entries: ARPEntry[]; collectedAt: string; error?: string }

function getARPCommand(vendor: string): string {
  switch (vendor.toLowerCase()) {
    case 'huawei': case 'h3c': return 'display arp all'
    case 'cisco': case 'ruijie': return 'show ip arp'
    default: return 'display arp all'
  }
}

async function executeSSH(host: string, port: number, username: string, password: string, command: string, timeout: number = SSH_READY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    // D-6-2：settled-flag 防重复 resolve/reject；cleanup 为统一资源回收出口（clearTimeout + client.end），
    // 任意 ready/exec stream/error/client error/timeout 路径均经 finish() → cleanup()，杜绝 stray timer 与残留 socket。
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timer) { clearTimeout(timer); timer = undefined }
      // client.end() 优雅发 EOF；client 已 end/destroy 后再 end 可能抛，幂等忽略（D-6-2/T-06-01-02）
      try { client.end() } catch { /* ignore */ }
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    timer = setTimeout(() => {
      // timeout 兜底路径：对端可能不响应 EOF，cleanup 的 end() 之外追加 destroy() 强制销毁 socket（D-6-2）
      finish(() => {
        try { client.destroy() } catch { /* ignore */ }
        reject(new Error(`SSH timeout after ${timeout}ms`))
      })
    }, timeout)

    try {
      client.on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) { finish(() => reject(err)); return }
          let output = ''
          stream.on('data', (data: Buffer) => { output += data.toString() })
          stream.stderr.on('data', (data: Buffer) => { output += data.toString() })
          stream.on('close', () => { finish(() => resolve(output)) })
          stream.on('error', (e: Error) => { finish(() => reject(e)) })
        })
      })
      client.on('error', (err) => { finish(() => reject(err)) })
      client.connect({
        host, port, username, password, readyTimeout: timeout,
        algorithms: SSH_ALGORITHMS,
      })
    } catch (err) {
      // 同步异常兜底（client.connect 同步抛等罕见场景）：cleanup + reject，与异步回调路径同构
      finish(() => reject(err))
    }
  })
}

// executeTelnet 已抽取为共用 util（electron/utils/telnetExec.ts），见 executeTelnetCommand。
// arpCollector 走原始输出（不做 gbk/ANSI 处理），由 ARPParser 自行解析。

export class ARPCollector {
  private concurrency: number
  private timeout: number

  constructor(options?: { concurrency?: number; timeout?: number }) {
    this.concurrency = options?.concurrency ?? 3
    this.timeout = options?.timeout ?? 30000
  }

  async collectFromDevice(device: { id: string; name: string; ipAddress: string; vendor: string; connectionType: string; port: number | null; username: string; password: string }): Promise<ARPCollectionResult> {
    const result: ARPCollectionResult = {
      deviceId: device.id, deviceName: device.name, deviceIp: device.ipAddress,
      vendor: device.vendor, entries: [], collectedAt: new Date().toISOString(),
    }
    try {
      const command = getARPCommand(device.vendor)
      let output: string
      if (device.connectionType === 'ssh') {
        output = await executeSSH(device.ipAddress, device.port || 22, device.username, device.password, command, this.timeout)
      } else {
        output = await executeTelnetCommand(device.ipAddress, device.port || 23, device.username, device.password, command, { timeout: this.timeout })
      }
      result.entries = ARPParser.parse(output, device.vendor)
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }
    return result
  }

  async collectFromDevices(
    devices: any[],
    onProgress?: (progress: { total: number; completed: number; current?: string }) => void
  ): Promise<ARPCollectionResult[]> {
    const progress = { total: devices.length, completed: 0 }
    const results: ARPCollectionResult[] = []
    for (let i = 0; i < devices.length; i += this.concurrency) {
      const batch = devices.slice(i, i + this.concurrency)
      const batchResults = await Promise.all(batch.map(async (device) => {
        progress.current = device.name; onProgress?.(progress)
        const result = await this.collectFromDevice(device)
        progress.completed++; onProgress?.(progress)
        return result
      }))
      results.push(...batchResults)
    }
    return results
  }

  static async collectFromAll(): Promise<ARPCollectionResult[]> {
    const devices = listDevices()
    if (devices.length === 0) return []
    const collector = new ARPCollector()
    return collector.collectFromDevices(devices)
  }
}
