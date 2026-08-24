import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { McpToolPolicy, isVerifiedReadOnlyName } from '../../../electron/services/mcpToolPolicy'

/**
 * Phase 22 Plan 22-01 Task 2 —— McpToolPolicy（工具级策略 service）真路径验证。
 *
 * 单条件判定（22-04 用户裁决，推翻 22-01 双条件）：readOnlyHint=true（server 声明）即
 * 免确认可勾——通用 MCP server（如 playwright 全系 browser_*）名字不命中网络设备风格
 * 正则，双条件下免确认功能形同虚设。名字正则降级为展示层「已验证只读」加强标记
 * （isVerifiedReadOnlyName），不影响可勾性。
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
    CREATE TABLE mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, package_id INTEGER
    );
    CREATE TABLE mcp_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, last_test TEXT
    );
  `)
  return db
}

/** 登记两配置同属一包（D-22 包级策略共享形态） */
function seedPackageConfigs(): { pkgId: number, cfgA: number, cfgB: number } {
  const d = (McpToolPolicy as unknown as { db(): Database.Database }).db()
  d.prepare('INSERT INTO mcp_packages (id, name) VALUES (7, ?)').run('demo-pkg')
  d.prepare('INSERT INTO mcp_configs (id, name, package_id) VALUES (1, ?, 7)').run('cfg-a')
  d.prepare('INSERT INTO mcp_configs (id, name, package_id) VALUES (2, ?, 7)').run('cfg-b')
  return { pkgId: 7, cfgA: 1, cfgB: 2 }
}

beforeEach(() => {
  const db = freshDb()
  McpToolPolicy._setDbGetter(() => db)
})

describe('isReadOnlyEligible 单条件判定矩阵（22-04 用户裁决）', () => {
  it('hint=true → true，无论名字是否命中只读正则', () => {
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'get_status', annotations: { readOnlyHint: true } })).toBe(true)
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'reboot_device', annotations: { readOnlyHint: true } })).toBe(true)
    // 通用 MCP server 命名（playwright 全系 browser_*）也只看 hint
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'browser_snapshot', annotations: { readOnlyHint: true } })).toBe(true)
  })

  it('hint 缺失/false → 一律 false（单条件从严侧）', () => {
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'get_status' })).toBe(false)
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'get_status', annotations: {} })).toBe(false)
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'get_status', annotations: { readOnlyHint: false } })).toBe(false)
    // 名字命中正则但 server 未声明只读 → 不可勾（正则不单独构成可勾条件）
    expect(McpToolPolicy.isReadOnlyEligible({ name: 'show_version', annotations: { readOnlyHint: false } })).toBe(false)
  })
})

describe('isVerifiedReadOnlyName 展示层加强标记判定', () => {
  it('网络设备风格只读动词前缀 / _get_ / _list_ 段 → true', () => {
    for (const n of ['get_x', 'show_x', 'list_x', 'read_x', 'status_x', 'query_x', 'ping_x', 'health_x', 'describe_x', 'device_get_info', 'node_list_all']) {
      expect(isVerifiedReadOnlyName(n)).toBe(true)
    }
  })

  it('通用命名（browser_* 等）→ false（仅展示降档，不影响可勾性）', () => {
    for (const n of ['browser_snapshot', 'browser_navigate', 'reboot_x', 'write_x', 'exec_x', 'set_x']) {
      expect(isVerifiedReadOnlyName(n)).toBe(false)
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
      { name: 'reboot_device', annotations: { readOnlyHint: true } }, // hint=true：单条件下也可免确认
      { name: 'ping_host' },
    ])
  })

  it('setEnabled 更新对应行', () => {
    McpToolPolicy.setEnabled(1, 'reboot_device', false)
    const cache = McpToolPolicy.getToolCache(1)
    expect(cache.find((t) => t.name === 'reboot_device')!.enabled).toBe(0)
    expect(McpToolPolicy.getEnabledTools(1).map((t) => t.name)).toEqual(['get_status', 'ping_host'])
  })

  it('setSkipConfirm(true) 对无 hint 的工具被拒绝；hint=true（无论名字）放行', () => {
    expect(McpToolPolicy.setSkipConfirm(1, 'reboot_device', true)).toBe(true) // hint=true 即可（22-04 单条件）
    expect(McpToolPolicy.setSkipConfirm(1, 'ping_host', true)).toBe(false) // 无 hint
    expect(McpToolPolicy.setSkipConfirm(1, 'get_status', true)).toBe(true)
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

// ---------- Phase 22 code-review WR-07：单条 tool_meta 尺寸上限 ----------

describe('saveToolCache 单条 tool_meta 尺寸上限（WR-07）', () => {
  it('巨型 description → 落库 meta ≤ 64_000 字符，description 置空、annotations（readOnlyHint）保留', () => {
    McpToolPolicy.saveToolCache(1, [
      { name: 'get_huge', description: 'd'.repeat(200_000), annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
    ])
    const row = McpToolPolicy.getToolCache(1)[0]
    const g = McpToolPolicy as unknown as { db(): { prepare(sql: string): { get(): { tool_meta: string } } } }
    const metaLen = g.db().prepare('SELECT tool_meta FROM mcp_tools WHERE config_id = 1').get().tool_meta.length
    expect(metaLen).toBeLessThanOrEqual(64_000)
    expect(row.description).toBeUndefined() // 展示字段被降级丢弃
    expect(row.inputSchema).toBeUndefined()
    expect(row.annotations?.readOnlyHint).toBe(true) // 策略判定依赖保留
  })

  it('巨型 inputSchema 同样降级，且 hint=true 的免确认可勾性不受影响', () => {
    McpToolPolicy.saveToolCache(1, [
      { name: 'get_big_schema', annotations: { readOnlyHint: true }, inputSchema: { props: 'x'.repeat(300_000) } },
    ])
    expect(McpToolPolicy.setSkipConfirm(1, 'get_big_schema', true)).toBe(true)
  })

  it('正常尺寸 meta 原样落库（不受上限影响）', () => {
    McpToolPolicy.saveToolCache(1, [
      { name: 'get_normal', description: '正常描述', annotations: { readOnlyHint: false }, inputSchema: { type: 'object' } },
    ])
    const row = McpToolPolicy.getToolCache(1)[0]
    expect(row.description).toBe('正常描述')
    expect(row.inputSchema).toEqual({ type: 'object' })
    expect(row.annotations?.readOnlyHint).toBe(false)
  })
})

// ---------- Phase 29（29-04，D-22/D-25）：包级策略模板 + extraTools 消费端二次过滤 ----------

describe('包级策略共享（D-22：同包全部配置共享一份策略）', () => {
  beforeEach(() => {
    seedPackageConfigs()
  })

  it('经任一包配置 saveToolCache → 另一包配置读取到同一份清单（聚合到包根配置）', () => {
    McpToolPolicy.saveToolCache(2, [
      { name: 'get_status', annotations: { readOnlyHint: true } },
      { name: 'reboot_device' },
    ])
    expect(McpToolPolicy.getToolCache(1).map((t) => t.name)).toEqual(['get_status', 'reboot_device'])
  })

  it('同包两配置改一处策略，另一处读取结果同步', () => {
    McpToolPolicy.saveToolCache(2, [
      { name: 'get_status', annotations: { readOnlyHint: true } },
      { name: 'reboot_device' },
    ])
    // 经配置 B 改策略
    expect(McpToolPolicy.setEnabled(2, 'reboot_device', false)).toBe(undefined)
    expect(McpToolPolicy.setSkipConfirm(2, 'get_status', true)).toBe(true)
    // 配置 A 读取同步
    const fromA = McpToolPolicy.getToolCache(1)
    expect(fromA.find((t) => t.name === 'reboot_device')!.enabled).toBe(0)
    expect(fromA.find((t) => t.name === 'get_status')!.skipConfirm).toBe(1)
    expect(McpToolPolicy.getSkipConfirmTools(1).has('get_status')).toBe(true)
    expect(McpToolPolicy.getDisabledToolNames(1)).toEqual(['reboot_device'])
  })

  it('手工配置（package_id NULL）维持 config 维度旧路径：不与包配置串线', () => {
    const d = (McpToolPolicy as unknown as { db(): Database.Database }).db()
    d.prepare('INSERT INTO mcp_configs (id, name, package_id) VALUES (3, ?, NULL)').run('cfg-manual')
    McpToolPolicy.saveToolCache(1, [{ name: 'pkg_tool', annotations: { readOnlyHint: true } }])
    McpToolPolicy.saveToolCache(3, [{ name: 'manual_tool' }])
    expect(McpToolPolicy.getToolCache(3).map((t) => t.name)).toEqual(['manual_tool'])
    expect(McpToolPolicy.getToolCache(2).map((t) => t.name)).toEqual(['pkg_tool'])
  })
})

describe('extraTools 消费端二次过滤（PKG-04/D-25，T-29-04-03）', () => {
  beforeEach(() => {
    seedPackageConfigs()
  })

  it('last_test.extraTools 工具名不出现在策略可用集（即使 mcp_tools 行 enabled=1）', () => {
    const d = (McpToolPolicy as unknown as { db(): Database.Database }).db()
    d.prepare('UPDATE mcp_packages SET last_test = ? WHERE id = 7').run(
      JSON.stringify({ stage: 'listing', ok: true, extraTools: ['undeclared_evil'], missingTools: [], testedAt: '2026-08-24T00:00:00Z' })
    )
    McpToolPolicy.saveToolCache(1, [
      { name: 'get_status', annotations: { readOnlyHint: true } },
      { name: 'undeclared_evil', annotations: { readOnlyHint: true } },
    ])
    // 缓存行两工具都在（UI 抽屉可见）；可用集排除 extraTools
    expect(McpToolPolicy.getToolCache(1).map((t) => t.name)).toContain('undeclared_evil')
    expect(McpToolPolicy.getEnabledTools(1).map((t) => t.name)).toEqual(['get_status'])
  })

  it('同包另一配置同样被过滤（包维度路由）+ 手工配置不受 extraTools 影响', () => {
    const d = (McpToolPolicy as unknown as { db(): Database.Database }).db()
    d.prepare('UPDATE mcp_packages SET last_test = ? WHERE id = 7').run(
      JSON.stringify({ stage: 'listing', ok: true, extraTools: ['undeclared_evil'], missingTools: [], testedAt: '2026-08-24T00:00:00Z' })
    )
    d.prepare('INSERT INTO mcp_configs (id, name, package_id) VALUES (3, ?, NULL)').run('cfg-manual')
    McpToolPolicy.saveToolCache(2, [
      { name: 'get_status' },
      { name: 'undeclared_evil' },
    ])
    McpToolPolicy.saveToolCache(3, [{ name: 'undeclared_evil' }])
    expect(McpToolPolicy.getEnabledTools(1).map((t) => t.name)).toEqual(['get_status'])
    expect(McpToolPolicy.getEnabledTools(3).map((t) => t.name)).toEqual(['undeclared_evil'])
  })

  it('last_test 缺失/坏 JSON/extraTools 非数组 → 不过滤（fail-safe 回退旧行为）', () => {
    const d = (McpToolPolicy as unknown as { db(): Database.Database }).db()
    d.prepare('UPDATE mcp_packages SET last_test = ? WHERE id = 7').run('not-json')
    McpToolPolicy.saveToolCache(1, [{ name: 'get_status' }])
    expect(McpToolPolicy.getEnabledTools(1).map((t) => t.name)).toEqual(['get_status'])
  })
})
