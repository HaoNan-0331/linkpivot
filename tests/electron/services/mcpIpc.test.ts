import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Phase 22 code-review —— mcpIpc 网关层回归（WR-01 / WR-03）。
 *
 * - WR-01：mcp:save 持久化路径 credential 长度上限（与 temp 路径 MAX_ENV_VALUE_LENGTH 同标准）
 * - WR-03：编辑表单 temp 测试（configId+temp 组合）不得写入已存配置的 mcp_tools
 *   策略缓存与最近测试记录（策略漂移守卫）；仅 temp=null 的行级「测试」才落库
 *
 * electron.ipcMain / 服务层全 mock，只测网关判定分支。
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(ch, fn)
    },
  },
}))
vi.mock('../../../electron/utils/authGuard', () => ({
  secure: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  safe: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}))
vi.mock('../../../electron/services/mcpService', () => ({
  MAX_BATCH: 1000,
  UNCHANGED_ENV_SENTINEL: '__UNCHANGED__',
  McpService: {
    listConfigs: vi.fn().mockReturnValue([]),
    saveConfig: vi.fn().mockReturnValue({ ok: true, id: 1 }),
    deleteConfig: vi.fn().mockReturnValue({ ok: true }),
    setEnabled: vi.fn(),
    decodeForTest: vi.fn().mockReturnValue({
      type: 'http', commandOrUrl: 'http://base', args: [], env: {}, credential: null,
    }),
    recordTestResult: vi.fn(),
  },
}))
vi.mock('../../../electron/services/mcpClient', () => ({
  testConnection: vi.fn(),
  cancelTest: vi.fn().mockReturnValue(true),
}))
vi.mock('../../../electron/services/mcpPackageService', () => ({
  McpPackageService: {
    testPackageConfig: vi.fn(),
  },
}))
vi.mock('../../../electron/services/mcpToolPolicy', () => ({
  McpToolPolicy: {
    saveToolCache: vi.fn(),
    getToolCache: vi.fn().mockReturnValue([]),
    setEnabled: vi.fn(),
    setSkipConfirm: vi.fn().mockReturnValue(true),
    isReadOnlyEligible: vi.fn().mockReturnValue(false),
  },
  isVerifiedReadOnlyName: vi.fn().mockReturnValue(false),
}))

import { registerMcpIpc } from '../../../electron/ipc/mcpIpc'
import { McpPackageService } from '../../../electron/services/mcpPackageService'
import { McpService } from '../../../electron/services/mcpService'
import { testConnection as runTest } from '../../../electron/services/mcpClient'
import { McpToolPolicy } from '../../../electron/services/mcpToolPolicy'

const okResult = { ok: true, tools: [{ name: 'get_status' }], error: null as never }

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  vi.mocked(McpService.decodeForTest).mockReturnValue({
    type: 'http', commandOrUrl: 'http://base', args: [], env: {}, credential: null,
  })
  vi.mocked(runTest).mockResolvedValue(okResult as never)
  registerMcpIpc()
})

describe('WR-01：mcp:save credential 长度上限（与 temp 路径同标准 2000）', () => {
  const baseDto = { name: 'cfg', type: 'http', commandOrUrl: 'http://x' } as const

  it('credential 超长（2001 字符）→ 拒绝且不落库', async () => {
    const save = handlers.get('mcp:save')!
    expect(() =>
      save({}, { ...baseDto, credential: 'c'.repeat(2001) })
    ).toThrow('credential 超长')
    expect(McpService.saveConfig).not.toHaveBeenCalled()
  })

  it('credential 合法长度（2000 字符内）→ 放行落库', () => {
    const save = handlers.get('mcp:save')!
    save({}, { ...baseDto, credential: 'c'.repeat(2000) })
    expect(McpService.saveConfig).toHaveBeenCalled()
  })
})

describe('Bug A（生产实测）：credential / commandOrUrl 保存与测试入口防御性 trim', () => {
  const baseDto = { name: 'cfg', type: 'http', commandOrUrl: 'http://x' } as const

  it('mcp:save：credential 带 \\t\\n 前后缀 → 落库前被 trim', () => {
    const save = handlers.get('mcp:save')!
    save({}, { ...baseDto, credential: '\ttoken-abc \n' })
    expect(McpService.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ credential: 'token-abc' })
    )
  })

  it('mcp:save：commandOrUrl 带首尾空白 → 落库前被 trim', () => {
    const save = handlers.get('mcp:save')!
    save({}, { ...baseDto, commandOrUrl: '  http://x/y\r\n' })
    expect(McpService.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ commandOrUrl: 'http://x/y' })
    )
  })

  it('mcp:save：credential 全空白 → 视为清空（null），不留纯空白脏值', () => {
    const save = handlers.get('mcp:save')!
    save({}, { ...baseDto, credential: ' \t ' })
    expect(McpService.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ credential: null })
    )
  })

  it('temp 测试通道：credential / commandOrUrl 带首尾空白 → 进 runTest 前被 trim', async () => {
    const test = handlers.get('mcp:testConnection')! as (...a: unknown[]) => Promise<unknown>
    await test({}, {
      testId: 't-12345678',
      temp: { type: 'http', commandOrUrl: ' http://dirty/mcp\t', credential: '\n tok-dirty ' },
    })
    expect(runTest).toHaveBeenCalledWith(
      't-12345678',
      expect.objectContaining({ commandOrUrl: 'http://dirty/mcp', credential: 'tok-dirty' }),
      expect.anything()
    )
  })

  it('temp 测试通道：credential 全空白 → 清空为 null', async () => {
    const test = handlers.get('mcp:testConnection')! as (...a: unknown[]) => Promise<unknown>
    await test({}, {
      testId: 't-12345678',
      temp: { type: 'http', commandOrUrl: 'http://x', credential: ' \n\t' },
    })
    expect(runTest).toHaveBeenCalledWith(
      't-12345678',
      expect.objectContaining({ credential: null }),
      expect.anything()
    )
  })
})

describe('WR-03：temp 测试（configId+temp）不污染已存配置策略缓存/测试记录', () => {
  it('configId + temp 组合成功 → 不 saveToolCache / 不 recordTestResult（未保存的表单值）', async () => {
    const test = handlers.get('mcp:testConnection')! as (...a: unknown[]) => Promise<unknown>
    await test({}, {
      testId: 't-12345678',
      configId: 7,
      temp: { type: 'http', commandOrUrl: 'http://temp-version' },
    })
    expect(runTest).toHaveBeenCalled()
    expect(McpToolPolicy.saveToolCache).not.toHaveBeenCalled()
    expect(McpService.recordTestResult).not.toHaveBeenCalled()
  })

  it('configId 且无 temp（行级「测试」）成功 → saveToolCache + recordTestResult 照旧落库', async () => {
    const test = handlers.get('mcp:testConnection')! as (...a: unknown[]) => Promise<unknown>
    await test({}, { testId: 't-12345678', configId: 7 })
    expect(McpToolPolicy.saveToolCache).toHaveBeenCalledWith(7, expect.anything())
    expect(McpService.recordTestResult).toHaveBeenCalledWith(7, 'success', 1)
  })

  it('temp 失败路径（configId+temp）→ 同样不落 failed 测试记录', async () => {
    vi.mocked(runTest).mockResolvedValue({ ok: false, tools: [], error: { code: 'MCP_TIMEOUT', message: 'x' } } as never)
    const test = handlers.get('mcp:testConnection')! as (...a: unknown[]) => Promise<unknown>
    await test({}, {
      testId: 't-12345678',
      configId: 7,
      temp: { type: 'http', commandOrUrl: 'http://temp' },
    })
    expect(McpService.recordTestResult).not.toHaveBeenCalled()
  })
})

describe('29-09 走查二：包配置（type=package）测试走包轨路由', () => {
  it('decodeForTest 返回 package → 走 testPackageConfig（不走 stdio/http 旧通道）并落库缓存', async () => {
    vi.mocked(McpService.decodeForTest).mockReturnValue({
      type: 'package', commandOrUrl: 'main.js', args: [], env: {}, credential: null,
    })
    vi.mocked(McpPackageService.testPackageConfig).mockResolvedValue({
      ok: true, protocolVersion: '1.0', tools: [{ name: 't1', inputSchema: {} }],
    })
    const test = handlers.get('mcp:testConnection')! as (...a: unknown[]) => Promise<unknown>
    await test({}, { testId: 't-12345678', configId: 9 })
    expect(McpPackageService.testPackageConfig).toHaveBeenCalledWith(9, expect.objectContaining({ testId: 't-12345678' }))
    expect(runTest).not.toHaveBeenCalled()
    expect(McpService.recordTestResult).toHaveBeenCalledWith(9, 'success', 1)
    expect(McpToolPolicy.saveToolCache).toHaveBeenCalledWith(9, expect.anything())
  })

  it('package + temp 组合 → 拒绝（temp 仅适用于 stdio/http）', async () => {
    vi.mocked(McpService.decodeForTest).mockReturnValue({
      type: 'package', commandOrUrl: 'main.js', args: [], env: {}, credential: null,
    })
    const test = handlers.get('mcp:testConnection')! as (...a: unknown[]) => Promise<unknown>
    await expect(test({}, {
      testId: 't-12345678', configId: 9, temp: { type: 'stdio', commandOrUrl: 'x' },
    })).rejects.toThrow('不支持临时参数测试')
    expect(McpPackageService.testPackageConfig).not.toHaveBeenCalled()
  })

  it('mcp:save：type=package 新建被拒；编辑放行（service 层保留包字段原值）', () => {
    const save = handlers.get('mcp:save')!
    expect(() => save({}, { name: 'x', type: 'package' })).toThrow('只能从包创建')
    save({}, { id: 5, name: 'x', type: 'package' })
    expect(McpService.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ id: 5, type: 'package' }))
  })
})
