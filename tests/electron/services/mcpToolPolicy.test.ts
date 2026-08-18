import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { McpToolPolicy, READONLY_TOOL_NAME_RE } from '../../../electron/services/mcpToolPolicy'

/**
 * Phase 22 Plan 22-01 Task 2 —— McpToolPolicy（工具级策略 service）真路径验证。
 *
 * 双条件判定（MCS-02 从严）：readOnlyHint=true（server 声明）AND 工具名匹配本地只读正则
 * （本地自主裁决，不信任 server 单方声明）才允许 skip_confirm=true。
 *
 * 安全域：内存库（:memory:）无落盘；经 _setDbGetter 注入（mcpService 同款惯例）。
 */

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE mcp_tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      skip_confirm INTEGER NOT NULL DEFAULT 0,
      tool_meta TEXT,
      updated_at TEXT,
      UNIQUE(config_id, tool_name)
    );
  `)
  return db
}

beforeEach(() => {
  McpToolPolicy._setDbGetter(freshDb)
})

describe('isReadOnlyEligible 双条件判定矩阵', () => {
  it('hint=true + 名字匹配只读正则 → true', () => {
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'get_status', annotations: { readOnlyHint: true } })).toBe(true)
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'list_interfaces', annotations: { readOnlyHint: true } })).toBe(true)
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'query_arp_table', annotations: { readOnlyHint: true } })).toBe(true)
  })

  it('hint=true 但名字不匹配正则（如 reboot_device）→ false', () => {
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'reboot_device', annotations: { readOnlyHint: true } })).toBe(false)
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'delete_config', annotations: { readOnlyHint: true } })).toBe(false)
  })

  it('hint 缺失/false → 一律 false（MCS-02 从严）', () => {
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'get_status' })).toBe(false)
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'get_status', annotations: {} })).toBe(false)
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'get_status', annotations: { readOnlyHint: false } })).toBe(false)
  })

  it('READONLY_TOOL_NAME_RE 导出且覆盖只读动词前缀', () => {
    expect(READONLY_TOOL_NAME_RE).toBeInstanceOf(RegExp)
    for (const n of ['get_x', 'show_x', 'list_x', 'read_x', 'status_x', 'query_x', 'ping_x', 'health_x', 'describe_x']) {
      expect(READONLY_TOOL_NAME_RE.test(n)).toBe(true)
    }
    for (const n of ['reboot_x', 'write_x', 'exec_x', 'set_x']) {
      expect(READONLY_TOOL_NAME_RE.test(n)).toBe(false)
    }
  })
})

describe('saveToolCache / getToolCache / 策略保留', () => {
  it('saveToolCache 落库后 getToolCache 返回含 annotations 的清单', () => {
    McpToolPolicy.saveToolCache(1, [
      { name: 'get_status', description: 'd1', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
      { name: 'reboot_device', description: 'd2' },
    ])
    const cache = McpToolPolicy.getToolCache(1)
    expect(cache).toHaveLength(2)
    const g = cache.find((t) => t.name === 'get_status')!
    expect(g.description).toBe('d1')
    expect(g.annotations?.readOnlyHint).toBe(true)
    expect(g.inputSchema).toEqual({ type: 'object' })
    expect(g.enabled).toBe(1)
    expect(g.skipConfirm).toBe(0)
  })

  it('saveToolCache 二次调用后既有行 enabled/skip_confirm 策略值保留', () => {
    McpToolPolicy.saveToolCache(1, [
      { name: 'get_status', annotations: { readOnlyHint: true } },
      { name: 'reboot_device' },
    ])
    McpToolPolicy.setEnabled(1, 'get_status', false)
    expect(McpToolPolicy.setSkipConfirm(1, 'get_status', true)).toBe(true)

    // 清单更新（去掉 reboot_device、新增新工具）
    McpToolPolicy.saveToolCache(1, [
      { name: 'get_status', annotations: { readOnlyHint: true } },
      { name: 'ping_host' },
    ])
    const cache = McpToolPolicy.getToolCache(1)
    expect(cache).toHaveLength(2)
    const g = cache.find((t) => t.name === 'get_status')!
    expect(g.enabled).toBe(0) // 策略保留
    expect(g.skipConfirm).toBe(1) // 策略保留
    const p = cache.find((t) => t.name === 'ping_host')!
    expect(p.enabled).toBe(1) // 新行默认
    expect(p.skipConfirm).toBe(0)
    expect(cache.find((t) => t.name === 'reboot_device')).toBeUndefined() // 已消失工具被清
  })

  it('工具数 >500 截断（T-22-04 DoS 守卫）', () => {
    const tools = Array.from({ length: 600 }, (_, i) => ({ name: `get_t${i}` }))
    McpToolPolicy.saveToolCache(1, tools)
    expect(McpToolPolicy.getToolCache(1)).toHaveLength(500)
  })
})

describe('setEnabled / setSkipConfirm / getEnabledTools / getSkipConfirmTools', () => {
  beforeEach(() => {
    McpToolPolicy.saveToolCache(1, [
      { name: 'get_status', annotations: { readOnlyHint: true } },
      { name: 'reboot_device', annotations: { readOnlyHint: true } }, // hint 有但名字不匹配
      { name: 'ping_host' },
    ])
  })

  it('setEnabled 更新对应行', () => {
    McpToolPolicy.setEnabled(1, 'reboot_device', false)
    const cache = McpToolPolicy.getToolCache(1)
    expect(cache.find((t) => t.name === 'reboot_device')!.enabled).toBe(0)
    expect(McpToolPolicy.getEnabledTools(1).map((t) => t.name)).toEqual(['get_status', 'ping_host'])
  })

  it('setSkipConfirm(true) 对不满足双条件的工具被拒绝', () => {
    expect(McpToolPolicy.setSkipConfirm(1, 'reboot_device', true)).toBe(false) // 名字不匹配
    expect(McpToolPolicy.getToolCache(1).find((t) => t.name === 'reboot_device')!.skipConfirm).toBe(0)
    expect(McpToolPolicy.setSkipConfirm(1, 'ping_host', true)).toBe(false) // 无 hint
    expect(McpToolPolicy.setSkipConfirm(1, 'get_status', true)).toBe(true) // 双条件满足
    expect(McpToolPolicy.setSkipConfirm(1, 'get_status', false)).toBe(true) // 关闭不受限
    expect(McpToolPolicy.setSkipConfirm(1, 'nonexistent_tool', true)).toBe(false) // 行不存在
  })

  it('getSkipConfirmTools 返回 Set 且只含已开免确认工具', () => {
    McpToolPolicy.setSkipConfirm(1, 'get_status', true)
    const s = McpToolPolicy.getSkipConfirmTools(1)
    expect(s).toBeInstanceOf(Set)
    expect(s.has('get_status')).toBe(true)
    expect(s.size).toBe(1)
  })

  it('getEnabledTools 只返回 enabled=1 行', () => {
    McpToolPolicy.setEnabled(1, 'ping_host', false)
    McpToolPolicy.setEnabled(1, 'get_status', false)
    expect(McpToolPolicy.getEnabledTools(1).map((t) => t.name)).toEqual(['reboot_device'])
  })
})
