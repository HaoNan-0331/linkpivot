import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'

// H-4（v0.3.0 audit）：getDeviceByIdInternal 缺 deviceType 字段回归网。
//
// 红线：拓扑自动发现产生的节点 deviceType 反映 devices 表 device_type 列真实值
// （修复前 dev?.deviceType 恒 undefined → discovery.ts:340 节点错型 generic）。
// mock DB 注入 MemDb 返回 devices 行（_enc 列给 null，decField 对 null 自带降级返回 null）。

class MemDb {
  deviceRow: Record<string, unknown> | null = null
  prepare(sql: string): unknown {
    const norm = sql.trim().replace(/\s+/g, ' ')
    if (/^SELECT \* FROM devices WHERE id = \?$/.test(norm)) {
      return { get: () => this.deviceRow }
    }
    // Phase 23-03：getDeviceByIdInternal 改 LEFT JOIN mcp_device_rel 投影 has_mcp
    if (/^SELECT d\.\*, \(r\.device_id IS NOT NULL\) AS has_mcp FROM devices d LEFT JOIN mcp_device_rel r ON r\.device_id = d\.id WHERE d\.id = \?$/.test(norm)) {
      return { get: () => (this.deviceRow ? { ...this.deviceRow, has_mcp: 0 } : null) }
    }
    throw new Error('mock DB 未实现的语句: ' + sql)
  }
}

const state = vi.hoisted(() => ({ db: null as MemDb | null }))
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => {
    if (!state.db) throw new Error('测试未注入 mock DB')
    return state.db
  },
}))

import { getDeviceByIdInternal } from '../../electron/services/ai'

function makeRow(deviceType: string | null): Record<string, unknown> {
  return {
    id: 'd1', topology_id: null, name_enc: null, vendor_enc: null, model_enc: null,
    version_enc: null, ip_enc: null, device_type: deviceType, connection_type: 'ssh',
    port_enc: null, username_enc: null, password_enc: null, ssh_key_path_enc: null,
    ssh_key_content_enc: null, web_url_enc: null, status: 'unknown',
    last_checked: null, created_at: '2026-01-01', updated_at: '2026-01-01',
  }
}

beforeEach(() => {
  state.db = new MemDb()
})

describe('H-4 getDeviceByIdInternal deviceType 投影', () => {
  it("devices 行 device_type='switch' 时返回 deviceType==='switch'（真实列值）", () => {
    state.db!.deviceRow = makeRow('switch')
    const dev = getDeviceByIdInternal('d1')
    expect(dev).not.toBeNull()
    expect(dev.deviceType).toBe('switch')
  })

  it('device_type 为 NULL 时返回 generic（与 rowToDevice 同语义兜底）', () => {
    state.db!.deviceRow = makeRow(null)
    const dev = getDeviceByIdInternal('d1')
    expect(dev).not.toBeNull()
    expect(dev.deviceType).toBe('generic')
  })
})
