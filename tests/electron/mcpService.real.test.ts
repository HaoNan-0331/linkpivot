import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 21 Plan 21-05 Task 2 —— mcpService 真路径落库测试（in-memory db + _setDbGetter + 测试 MK）。
 *
 * Mock 策略（handleLeak.real.test.ts 头部惯例——仅 mock 非被测重依赖）：
 *   - getDatabase → vi.hoisted 内存库（service 本体真跑，含 encField/decField 真加密）
 *   - getDeviceById（./device，牵连 device 加密列/连接单例）→ 内存 devices 表投影
 *
 * 断言面：密文落库（v2: 前缀、无明文）/ ****尾4 出口脱敏 / D-04 绑定冲突事务回滚 /
 * deleteConfig CASCADE / recordTestResult last_test_*（T-21-05-02：断言只比对密文前缀与 mask 形态，不打印明文）。
 */

const h = vi.hoisted(() => ({
  db: null as Database.Database | null,
  devices: {} as Record<string, { name: string }>
}))

vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => h.db
}))

vi.mock('../../electron/services/device', () => ({
  getDeviceById: (id: string) => h.devices[id] ?? null
}))

import { McpService } from '../../electron/services/mcpService'

const TEST_MK = 'test-mk-21-05'

/** v16 形态 DDL（与 init.ts 逐字一致子集：devices 最小形态 + mcp_configs + mcp_device_rel） */
const DDL = `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE mcp_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('stdio','http')),
    command_or_url TEXT NOT NULL,
    args_json TEXT,
    env_json_enc TEXT,
    credential_enc TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_test_at TEXT,
    last_test_status TEXT,
    last_test_tool_count INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE mcp_device_rel (
    id TEXT PRIMARY KEY,
    mcp_config_id INTEGER NOT NULL,
    device_id TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    env_json_enc TEXT,
    FOREIGN KEY (mcp_config_id) REFERENCES mcp_configs(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_device_rel_mcp ON mcp_device_rel(mcp_config_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_device_rel_device ON mcp_device_rel(device_id);
`

beforeEach(() => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(DDL)
  db.prepare("INSERT INTO devices (id, name) VALUES ('dev-1', '核心交换机'), ('dev-2', '出口路由器')").run()
  h.db = db
  h.devices = { 'dev-1': { name: '核心交换机' }, 'dev-2': { name: '出口路由器' } }
  McpService._setDbGetter(() => h.db!)
  McpService.setMcpMasterKey(TEST_MK)
})

afterEach(() => {
  h.db?.close()
  h.db = null
})

describe('McpService 真路径（in-memory db + 真加密）', () => {
  it('stdio env 整体 _enc 落库：sqlite 原文为 v2: 密文、无明文；decodeForTest 回读等值', () => {
    const saved = McpService.saveConfig({
      name: '本地工具箱', type: 'stdio', commandOrUrl: 'node',
      args: ['server.js'], env: { API_KEY: 'secret-env-abcdef' }
    })
    expect(saved.ok).toBe(true)

    const raw = h.db!.prepare('SELECT env_json_enc FROM mcp_configs').get() as { env_json_enc: string | null }
    expect(raw.env_json_enc).toBeTruthy()
    expect(raw.env_json_enc!.startsWith('v2:')).toBe(true)
    expect(raw.env_json_enc).not.toContain('secret-env-abcdef')

    const decoded = McpService.decodeForTest(1)
    expect(decoded).not.toBeNull()
    expect(decoded!.env).toEqual({ API_KEY: 'secret-env-abcdef' })
    expect(decoded!.args).toEqual(['server.js'])
  })

  it('listConfigs 出口脱敏：credentialMasked / envKeysMasked 只见 ****尾4，永无明文密文', () => {
    McpService.saveConfig({
      name: '内网 MCP', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp',
      credential: 'token-987654', deviceIds: ['dev-1']
    })
    McpService.saveConfig({
      name: '本地工具箱', type: 'stdio', commandOrUrl: 'node',
      env: { API_KEY: 'secret-env-abcdef' }
    })
    const views = McpService.listConfigs()
    const http = views.find((v) => v.name === '内网 MCP')!
    const stdio = views.find((v) => v.name === '本地工具箱')!
    expect(http.credentialMasked).toBe('****7654')
    expect(http.deviceIds).toEqual(['dev-1'])
    expect(http.deviceNames).toEqual(['核心交换机'])
    expect(stdio.envKeysMasked).toEqual(['API_KEY=****cdef'])
    // 整个出口投影序列化后不含明文/密文
    const json = JSON.stringify(views)
    expect(json).not.toContain('token-987654')
    expect(json).not.toContain('secret-env-abcdef')
    expect(json).not.toContain('v2:')
  })

  it('D-04 绑定冲突：设备已绑他配置 → 拒绝返「请先在那边解绑」且事务回滚（原绑定不变、新配置零写入）', () => {
    const a = McpService.saveConfig({
      name: '配置A', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp', deviceIds: ['dev-1']
    })
    expect(a.ok).toBe(true)

    const countBefore = (h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get() as { c: number }).c
    const b = McpService.saveConfig({
      name: '配置B', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp', deviceIds: ['dev-1']
    })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error).toContain('请先在那边解绑')

    // 事务回滚：dev-1 仍绑配置A；配置B 未落库
    const rel = h.db!.prepare('SELECT mcp_config_id FROM mcp_device_rel WHERE device_id = ?').get('dev-1') as { mcp_config_id: number }
    expect(rel.mcp_config_id).toBe(1)
    const countAfter = (h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_configs').get() as { c: number }).c
    expect(countAfter).toBe(countBefore)
  })

  it('deleteConfig 级联清理 mcp_device_rel（FK CASCADE）', () => {
    McpService.saveConfig({
      name: '配置A', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp', deviceIds: ['dev-1', 'dev-2']
    })
    expect((h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get() as { c: number }).c).toBe(2)
    McpService.deleteConfig(1)
    expect((h.db!.prepare('SELECT COUNT(*) AS c FROM mcp_device_rel').get() as { c: number }).c).toBe(0)
  })

  it('recordTestResult 写 last_test_* 三列', () => {
    McpService.saveConfig({ name: '配置A', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp' })
    McpService.recordTestResult(1, 'success', 5)
    const row = h.db!.prepare('SELECT last_test_at, last_test_status, last_test_tool_count FROM mcp_configs WHERE id = 1').get() as any
    expect(row.last_test_at).toBeTruthy()
    expect(row.last_test_status).toBe('success')
    expect(row.last_test_tool_count).toBe(5)
  })

  it('WR-03 saveConfig 更新不存在的 id：返回「配置不存在或已被删除」而非晦涩 FK 错误/崩溃', () => {
    // 带 deviceIds 形态（原本会触发 rel INSERT 的 FK 约束异常）
    const withRels = McpService.saveConfig({
      id: 999, name: '幽灵配置', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp', deviceIds: ['dev-1']
    })
    expect(withRels.ok).toBe(false)
    if (!withRels.ok) expect(withRels.error).toContain('配置不存在或已被删除')
    // 不带 deviceIds 形态（原本 rowToView(undefined) TypeError）
    const plain = McpService.saveConfig({ id: 999, name: '幽灵配置', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp' })
    expect(plain.ok).toBe(false)
    if (!plain.ok) expect(plain.error).toContain('配置不存在或已被删除')
  })

  it('WR-05 http credential null=显式清空：保存后 credentialMasked 归 null（清空通道可用）', () => {
    const saved = McpService.saveConfig({
      name: '令牌配置', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp', credential: 'token-987654'
    })
    expect(saved.ok).toBe(true)
    expect(McpService.listConfigs()[0].credentialMasked).toBe('****7654')
    const cleared = McpService.saveConfig({
      id: 1, name: '令牌配置', type: 'http', commandOrUrl: 'http://127.0.0.1:9/mcp', credential: null
    })
    expect(cleared.ok).toBe(true)
    expect(McpService.listConfigs()[0].credentialMasked).toBeNull()
    expect(McpService.decodeForTest(1)!.credential).toBeNull()
  })
})
