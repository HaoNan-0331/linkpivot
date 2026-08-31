import { Client } from 'ssh2'
import { getDatabase } from '../database/connection'
import { ARPParser } from './arpParser'
import { encField, decField } from '../utils/crypto'
import { listDevices, resolveExecChannel } from './device'
import { SSH_READY_TIMEOUT_MS, SSH_ALGORITHMS } from '../utils/sshConfig'
import { executeTelnetCommand, pickDisablePaginationCmd, pickShellPrompt } from '../utils/telnetExec'

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

/**
 * Phase 36（36-03，D-10）：channels 投影 → 命令行通道平铺视图（arpIpc 单设备路径与
 * collectFromAll list 路径共用）。resolveExecChannel 解析有效命令通道（默认 web/rdp 回退
 * 已配 SSH > Telnet——多通道 web 默认设备若配了 telnet 应能采集）后平铺该通道凭证到
 * DeviceInfo 既有形状；无命令行通道 → 凭证空值 + connectionType 原样（采集连接自然失败，
 * error 计入结果不崩溃）。旧 flat 形态入参（无 channels）原样透传（兼容既有测试桩）。
 */
export function toCmdChannelView(device: any): any {
  const channels: any[] = Array.isArray(device?.channels) ? device.channels : []
  if (channels.length === 0) return device
  const names = channels.map((c) => c.channel as string)
  const exec = resolveExecChannel(device?.connectionType ?? null, names)
  const ch = exec !== null ? channels.find((c) => c.channel === exec) : undefined
  return {
    ...device,
    connectionType: exec ?? device?.connectionType,
    port: ch?.port ?? null,
    username: ch?.username ?? '',
    password: ch?.password ?? '',
  }
}

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
      // Phase 36（36-03）：channels 投影设备（getDeviceById/listDevices 现形态）经 D-10
      // 解析平铺后采集；flat 形态入参原样透传。签名不变（36-03 plan 契约）。
      const dev = toCmdChannelView(device)
      const command = getARPCommand(dev.vendor)
      let output: string
      if (dev.connectionType === 'ssh') {
        output = await executeSSH(dev.ipAddress, dev.port || 22, dev.username, dev.password, command, this.timeout)
      } else {
        // WR-03：telnet 路径同 ai.ts 分流——按 vendor 关分页 + 精确 shellPrompt。
        // 默认 /[>#]/ 在 ARP 输出含裸 #（接口名/注释）时提前 resolve 截断；长 ARP 表部分设备 ---- More ----
        // 分页 telnet-client exec 不自动翻页会截断第一屏。复用 telnetExec.ts 抽出的 vendor picker。
        output = await executeTelnetCommand(
          dev.ipAddress, dev.port || 23, dev.username, dev.password, command,
          {
            timeout: this.timeout,
            disablePaginationCmd: pickDisablePaginationCmd(dev.vendor),
            shellPrompt: pickShellPrompt(dev.vendor),
          }
        )
      }
      result.entries = ARPParser.parse(output, dev.vendor)
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }
    return result
  }

  async collectFromDevices(
    devices: any[],
    onProgress?: (progress: { total: number; completed: number; current?: string }) => void
  ): Promise<ARPCollectionResult[]> {
    const progress = { total: devices.length, completed: 0, current: undefined as string | undefined }
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
