import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execSync } from 'child_process'
import fs from 'fs'

/**
 * Phase 21 Plan 21-05 Task 2 —— mcpClient 真路径三分支测试（SC3/SC4/SC5）。
 *
 * 真路径形态：不 mock SDK / 不 mock mockMcpServer——stdio 用真 StdioClientTransport spawn
 * mock 对端临时 .mjs（node PATH / electron.exe ELECTRON_RUN_AS_NODE 兜底 / 绝对路径三路径），
 * http 用进程内 http.Server loopback 对端（Streamable 主路径 + SSE-only fallback，含 query-string 回归锁）。
 * mcpClient 仅 type-only 依赖 mcpService（import type），无需 mock DB（连接器不碰库）。
 *
 * 跑法红线：npm run test:electron（记忆 electron-run-as-node-db-query，T-21-05-03）。
 * 子进程零残留：afterEach 经 expectNoHandleLeak(_, { expectNoMcpChildren: true }) 核算 listActive()==0。
 */

import {
  testConnection,
  cancelTest,
  getConnection,
  callToolWithTimeout,
  closeMcpConnection,
  _activeConnectionKeys,
  resolveStdioCommand
} from '../../electron/services/mcpClient'
import { McpProcessRegistry } from '../../electron/services/mcpProcessRegistry'
import { copyToTempMjs, startMockHttpMcpServer } from './_helpers/mockMcpServer'
import { expectNoHandleLeak } from './_helpers/handleLeakDetector'

expectNoHandleLeak(['ChildProcess', 'Immediate'], { expectNoMcpChildren: true })

let serverScript: string

beforeAll(() => {
  serverScript = copyToTempMjs()
})

afterAll(() => {
  try { fs.unlinkSync(serverScript) } catch { /* ENOENT 容错 */ }
})

afterEach(() => {
  // 连接表零残留（closeConnection 均应清理；孤儿 work 兜底由 cancel 路径接管）
  expect(_activeConnectionKeys()).toEqual([])
  McpProcessRegistry._reset()
})

/** stdio 被测配置（真 StdioClientTransport spawn mock 对端 .mjs） */
function stdioConfig(extraFlags: string[]): { type: 'stdio', commandOrUrl: string, args: string[], env: Record<string, string>, credential: null } {
  return {
    type: 'stdio',
    commandOrUrl: 'node',
    args: [serverScript, '--child', '--mode=stdio', ...extraFlags],
    env: {},
    credential: null
  }
}

describe('mcpClient 真路径（stdio 三路径 + http 双形态 + 异常分支）', () => {
  it('a) stdio 主路径（node PATH）：握手 + listTools 成功', async () => {
    const res = await testConnection('t-a', stdioConfig([]))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.protocolVersion).toBe('2025-06-18')
      expect(res.tools.map((t) => t.name)).toEqual(['tool_0', 'tool_1'])
    }
  }, 30000)

  it('b) ELECTRON_RUN_AS_NODE 兜底路径：主路径 ENOENT 后 process.execPath 重试成功', async () => {
    // 不存在的命令名 → resolveStdioCommand 生成 process.execPath + ELECTRON_RUN_AS_NODE 兜底预案
    const cfg = stdioConfig([])
    cfg.commandOrUrl = 'nt-definitely-missing-mcp-cmd'
    const res = await testConnection('t-b', cfg)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.tools.length).toBeGreaterThan(0)
  }, 30000)

  it('c) 绝对路径 exe：existsSync 校验直用（真 node 绝对路径）', async () => {
    const nodeAbs = execSync('where node', { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
    const plan = resolveStdioCommand(nodeAbs, [])
    expect(plan.command).toBe(nodeAbs)
    expect(plan.fallback).toBeNull()
    const cfg = stdioConfig(['--version=2024-11-05'])
    cfg.commandOrUrl = nodeAbs
    const res = await testConnection('t-c', cfg)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.protocolVersion).toBe('2024-11-05')
  }, 30000)

  it('d) http Streamable 主路径：token 只进 Authorization header，URL 零凭证', async () => {
    const srv = await startMockHttpMcpServer({ pages: 2 })
    try {
      const res = await testConnection('t-d', {
        type: 'http',
        commandOrUrl: `http://127.0.0.1:${srv.port}/mcp`,
        args: [], env: {}, credential: 'secret-token-12345'
      })
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.tools.length).toBe(4)
      // T-21-03-03：token 只出现在 header；对端记录的所有请求 URL 均不含 token 明文
      expect(srv.authHeaders).toContain('Bearer secret-token-12345')
      for (const u of srv.requestUrls) expect(u).not.toContain('secret-token-12345')
    } finally {
      await srv.close()
    }
  }, 30000)

  it('d3) Bug A：credential 带 \\t\\n 前后缀 → header 构造前被 trim（存量脏数据自愈）', async () => {
    const srv = await startMockHttpMcpServer({ pages: 1 })
    try {
      const res = await testConnection('t-d3', {
        type: 'http',
        commandOrUrl: `http://127.0.0.1:${srv.port}/mcp`,
        args: [], env: {}, credential: '\tsecret-token-12345\r\n'
      })
      expect(res.ok).toBe(true)
      // 对端收到的 Authorization 必须是干净 Bearer（无任何空白字符）
      expect(srv.authHeaders).toContain('Bearer secret-token-12345')
      for (const h of srv.authHeaders) expect(h).toBe(h.trim())
    } finally {
      await srv.close()
    }
  }, 30000)

  it('d2) SSE-only + query string 对端：显式 fallback 握手成功（c8a4848 回归锁）', async () => {
    const srv = await startMockHttpMcpServer({ sseOnly: true, pages: 1 })
    try {
      const res = await testConnection('t-d2', {
        type: 'http',
        // 带 query 认证串的 URL——fallback URL 推导必须保留 query（字符串 endsWith 拼接会断链）
        commandOrUrl: `http://127.0.0.1:${srv.port}/mcp?key=test-key-2026`,
        args: [], env: {}, credential: null
      })
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.tools.length).toBe(2)
      // fallback GET 打到 /mcp/sse 且 query 原样保留
      const sseGet = srv.requestUrls.find((u) => u.startsWith('GET ') && u.includes('/sse'))
      expect(sseGet).toContain('key=test-key-2026')
    } finally {
      await srv.close()
    }
  }, 30000)

  it('e) --hang 卡死分支：listTools 10s 硬超时触发，结构化错误 + 子进程树杀', async () => {
    const t0 = Date.now()
    const res = await testConnection('t-e', stdioConfig(['--hang']))
    const elapsed = Date.now() - t0
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('MCP_TIMEOUT')
      expect(res.error.reason).toContain('列出工具')
      // WR-01：超时文案完整透传，不得退化为 "[object Object]"
      expect(res.error.reason).toContain('预算耗尽')
      expect(res.error.reason).not.toContain('[object Object]')
    }
    expect(elapsed).toBeGreaterThanOrEqual(9000)
    // 超时后结构化错误返回且子进程被树杀（SC5 零残留）
    expect(McpProcessRegistry.listActive()).toEqual([])
  }, 30000)

  it('f) --crash 崩溃分支：握手后进程退出，返回结构化错误不挂死', async () => {
    const res = await testConnection('t-f', stdioConfig(['--crash']))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(typeof res.error.reason).toBe('string')
    expect(McpProcessRegistry.listActive()).toEqual([])
  }, 30000)

  it('g) --pages=3 cursor 分页取完：客户端收到工具数 == server 总数（6）', async () => {
    const res = await testConnection('t-g', stdioConfig(['--pages=3']))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.tools.length).toBe(6)
      expect(res.tools.map((t) => t.name)).toEqual(['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4', 'tool_5'])
    }
  }, 30000)

  it('h) --structured 双兼容：callTool 结果 content 与 structuredContent 双字段透传', async () => {
    const srv = await startMockHttpMcpServer({ structured: true })
    try {
      const cfg = { type: 'http' as const, commandOrUrl: `http://127.0.0.1:${srv.port}/mcp`, args: [], env: {}, credential: null }
      await getConnection('cfg-h', cfg)
      const result = await callToolWithTimeout('cfg-h', cfg, 'tool_0', {}) as Record<string, unknown>
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.structuredContent).toEqual({ answer: 42, nested: { ok: true } })
      await closeMcpConnection('cfg-h')
    } finally {
      await srv.close()
    }
  }, 30000)

  it('i) cancel：进行中取消即时生效（不等 10s 超时），子进程被树杀', async () => {
    const t0 = Date.now()
    const p = testConnection('t-i', stdioConfig(['--hang']))
    // 等 spawn + initialize 完成（进入卡死的 listTools）
    await new Promise((r) => setTimeout(r, 1000))
    expect(cancelTest('t-i')).toBe(true)
    const res = await p
    const elapsed = Date.now() - t0
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('MCP_CANCELLED')
    // 即时性：远早于 10s 硬超时（race 被 abort 抢占）
    expect(elapsed).toBeLessThan(8000)
    expect(McpProcessRegistry.listActive()).toEqual([])
  }, 30000)

  // ---- CR-01 / CR-02 回归锁（21 review）----

  /** 按 marker（命令行子串）统计存活的 mock 子进程数（node.exe / electron.exe 兜底形态） */
  function countProbeChildren(marker: string): number {
    const out = execSync(
      `powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \\"name='node.exe' or name='electron.exe'\\" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count"`,
      { encoding: 'utf8', windowsHide: true }
    ).trim()
    return parseInt(out, 10) || 0
  }

  it('j) CR-01 握手挂起 + 取消：孤儿 connect 路径子进程零残留（spawn 成功但 connect 未落定）', async () => {
    const marker = 'nt-mcp-probe-t-j'
    expect(countProbeChildren(marker)).toBe(0)
    const p = testConnection('t-j', stdioConfig(['--hang-init', `--probe=${marker}`]))
    // 等 spawn 完成、握手挂起中：连接表无条目、子进程确已存活
    await new Promise((r) => setTimeout(r, 2500))
    expect(_activeConnectionKeys()).toEqual([])
    expect(countProbeChildren(marker)).toBe(1)
    expect(cancelTest('t-j')).toBe(true)
    const res = await p
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('MCP_CANCELLED')
      expect(res.error.reason).not.toContain('[object Object]')
    }
    // 取消清理由 pendingStdioCleanups 兜底接管——树杀后零残留
    await new Promise((r) => setTimeout(r, 1500))
    expect(countProbeChildren(marker)).toBe(0)
    expect(McpProcessRegistry.listActive()).toEqual([])
  }, 30000)

  it('k) CR-01 握手失败（版本协商被拒）：结构化错误 + 已 spawn 子进程清退', async () => {
    const res = await testConnection('t-k', stdioConfig(['--version=1999-01-01']))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(typeof res.error.reason).toBe('string')
    expect(McpProcessRegistry.listActive()).toEqual([])
    expect(_activeConnectionKeys()).toEqual([])
  }, 30000)

  it('l) CR-02 长连接子进程自然退出：onclose 即时注销登记（防 pid 复用误杀）', async () => {
    const cfg = stdioConfig(['--crash'])
    const client = await getConnection('t-l', cfg)
    await expect(client.listTools()).rejects.toThrow()
    // 进程 close 事件 → transport.onclose → unregister（不依赖 closeConnection/killTree）
    await new Promise((r) => setTimeout(r, 1500))
    expect(McpProcessRegistry.listActive()).toEqual([])
    await closeMcpConnection('t-l')
  }, 30000)
})
