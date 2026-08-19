import { describe, it, expect, vi } from 'vitest'

/**
 * listDevices capabilities 投影测试（Phase 23 / DSL-03 / D-02）。
 *
 * 约束：
 * - device:list 每设备下发 capabilities: { hasSSH, hasTelnet, hasMcp } 三独立布尔
 * - hasSSH/hasTelnet 严格按 connectionType 派生；hasMcp 由 mcp_device_rel LEFT JOIN 派生
 * - LEFT JOIN 不产生重复行（mcp_device_rel.device_id UNIQUE，每设备恰好一行）
 *
 * Mock 策略：getDatabase → 内存 mock（mock 路径按 device.ts 的模块解析写
 * ../../electron/database/connection），prepare 只服务 listDevices 的单条 SELECT。
 * 加密列存 null（decField(null) → ''），非敏感明文列直接给出。
 */

const deviceRows: any[] = [
  { id: 'd-ssh', connection_type: 'ssh', has_mcp: 0 },
  { id: 'd-telnet', connection_type: 'telnet', has_mcp: 0 },
  { id: 'd-web', connection_type: 'web', has_mcp: 0 },
  { id: 'd-rdp', connection_type: 'rdp', has_mcp: 0 },
  { id: 'd-ssh-mcp', connection_type: 'ssh', has_mcp: 1 },
  { id: 'd-web-mcp', connection_type: 'web', has_mcp: 1 },
]

const prepareSpy = vi.fn()

vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => {
      prepareSpy(sql)
      return { all: () => deviceRows.map((r) => ({ ...r })) }
    },
  }),
}))

import { listDevices } from '../../electron/services/device'

describe('listDevices — capabilities 三布尔投影（D-02）', () => {
  it('单条 SQL LEFT JOIN mcp_device_rel 派生 has_mcp（无 N+1：prepare 恰好一次）', () => {
    prepareSpy.mockClear()
    const devices = listDevices()
    expect(prepareSpy).toHaveBeenCalledTimes(1)
    expect(prepareSpy.mock.calls[0][0]).toContain('mcp_device_rel')
    expect(prepareSpy.mock.calls[0][0]).toContain('LEFT JOIN')
    expect(devices).toHaveLength(deviceRows.length) // 无重复行
  })

  it('ssh 设备无 MCP 绑定 → hasSSH true / hasTelnet false / hasMcp false', () => {
    const d = listDevices().find((x: any) => x.id === 'd-ssh')!
    expect(d.capabilities).toEqual({ hasSSH: true, hasTelnet: false, hasMcp: false })
  })

  it('telnet 设备 → hasTelnet true / hasSSH false', () => {
    const d = listDevices().find((x: any) => x.id === 'd-telnet')!
    expect(d.capabilities).toEqual({ hasSSH: false, hasTelnet: true, hasMcp: false })
  })

  it('web/rdp 设备无 MCP → 三布尔全 false（仅问答档）', () => {
    for (const id of ['d-web', 'd-rdp']) {
      const d = listDevices().find((x: any) => x.id === id)!
      expect(d.capabilities).toEqual({ hasSSH: false, hasTelnet: false, hasMcp: false })
    }
  })

  it('mcp_device_rel 有关联行 → hasMcp true（可与 hasSSH 并存，三布尔独立）', () => {
    const sshMcp = listDevices().find((x: any) => x.id === 'd-ssh-mcp')!
    expect(sshMcp.capabilities).toEqual({ hasSSH: true, hasTelnet: false, hasMcp: true })
    const webMcp = listDevices().find((x: any) => x.id === 'd-web-mcp')!
    expect(webMcp.capabilities).toEqual({ hasSSH: false, hasTelnet: false, hasMcp: true })
  })

  it('capabilities 三键均为布尔类型', () => {
    for (const d of listDevices()) {
      expect(typeof d.capabilities.hasSSH).toBe('boolean')
      expect(typeof d.capabilities.hasTelnet).toBe('boolean')
      expect(typeof d.capabilities.hasMcp).toBe('boolean')
    }
  })
})
