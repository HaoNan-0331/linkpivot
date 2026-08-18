// tests/electron/_helpers/mockMcpServer.ts
//
// 最小 MCP 对端（21-05，SC3/SC4/SC5 测试闭环）。双形态：
//  1. stdio 子进程形态：测试把本文件复制为临时 .mjs（copyToTempMjs），
//     经 mcpClient 真 StdioClientTransport spawn（node / electron.exe 兜底 / 绝对路径三路径）。
//     行为 flags（--child 时生效）：--mode=stdio --pages=N --hang --crash --structured --version=X
//  2. http.Server 形态（startMockHttpMcpServer，进程内 loopback）：
//     默认 Streamable HTTP（POST /mcp JSON-RPC）；sseOnly=true 时 POST /mcp 404 +
//     GET …/sse 旧协议（event: endpoint + POST /messages）——驱动 mcpClient SSE 显式 fallback。
//     记录 requestUrls/authHeaders 供「token 只进 header，URL 零凭证」断言（T-21-03-03）。
//
// 红线：
//  - 本文件必须保持**纯 JS 语法**（零 TS 注解）——它会被原样复制成 .mjs 交 node 执行。
//  - stdio 走 stdin/stdout UTF-8 换行分隔 JSON-RPC（勿用任何 GBK 解码基建）。
//  - 安全域：listen 127.0.0.1 随机端口（禁止 0.0.0.0）；测试 MK/凭证均为固定测试串（T-21-05-02）。

import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'

/** 每页工具数（--pages=N 即 N 页，共 N*2 个工具——分页取完断言用） */
const TOOLS_PER_PAGE = 2

function parseFlags(argv) {
  const flags = { mode: 'stdio', pages: 1, hang: false, hangInit: false, crash: false, structured: false, version: '2025-06-18' }
  for (const a of argv) {
    if (a === '--child') continue
    if (a.startsWith('--mode=')) flags.mode = a.slice(7)
    else if (a.startsWith('--pages=')) flags.pages = parseInt(a.slice(8), 10) || 1
    else if (a === '--hang') flags.hang = true
    else if (a === '--hang-init') flags.hangInit = true
    else if (a === '--crash') flags.crash = true
    else if (a === '--structured') flags.structured = true
    else if (a.startsWith('--version=')) flags.version = a.slice(10)
  }
  return flags
}

/** JSON-RPC 分发（stdio 与 http 共用）：返回 result 对象；通知返回 null（不回话） */
function handleRpc(msg, flags, initialized) {
  if (msg.method === 'initialize') {
    initialized.done = true
    return {
      protocolVersion: flags.version,
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp-server', version: '1.0.0' }
    }
  }
  if (msg.method === 'notifications/initialized') return null
  if (msg.method === 'tools/list') {
    // cursor 分页（spike V-4：nextCursor = 下一页首工具透传 token）
    const start = msg.params && typeof msg.params.cursor === 'string' ? parseInt(msg.params.cursor, 10) : 0
    const tools = []
    for (let i = start; i < start + TOOLS_PER_PAGE && i < flags.pages * TOOLS_PER_PAGE; i++) {
      tools.push({
        name: 'tool_' + i,
        description: 'mock tool ' + i,
        inputSchema: { type: 'object', properties: {} }
      })
    }
    const result = { tools }
    if (start + TOOLS_PER_PAGE < flags.pages * TOOLS_PER_PAGE) result.nextCursor = String(start + TOOLS_PER_PAGE)
    return result
  }
  if (msg.method === 'tools/call') {
    const result = { content: [{ type: 'text', text: 'mock call result' }] }
    if (flags.structured) result.structuredContent = { answer: 42, nested: { ok: true } }
    return result
  }
  return null
}

// ---------------------------------------------------------------------------
// stdio 子进程形态（--child 入口）
// ---------------------------------------------------------------------------

function runStdioChild() {
  const flags = parseFlags(process.argv)
  const initialized = { done: false }
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    // 握手挂起泄漏路径（CR-01 测试）：任何输入一概不回话、永不退出——spawn 成功但 connect 永不落定
    if (flags.hangInit) return
    const s = line.trim()
    if (!s) return
    let msg
    try {
      msg = JSON.parse(s)
    } catch {
      return
    }
    if (msg.method === 'initialize') {
      const res = { jsonrpc: '2.0', id: msg.id, result: handleRpc(msg, flags, initialized) }
      process.stdout.write(JSON.stringify(res) + '\n')
      return
    }
    if (flags.crash && msg.method === 'tools/list') {
      // 崩溃分支：握手成功后收到 tools/list 即进程退出（确定性——不等定时器竞态）
      process.exit(1)
    }
    if (flags.hang && initialized.done && msg.method === 'tools/list') {
      // 卡死分支：进程活着，收到请求不回话
      return
    }
    const result = handleRpc(msg, flags, initialized)
    if (result === null) return
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  })
  rl.on('close', () => process.exit(0))
}

// 复制本文件为临时 .mjs（node 可直接执行；用后由测试删除——临时脚本红线）
export function copyToTempMjs() {
  const src = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const tmp = path.join(os.tmpdir(), 'nt-mock-mcp-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs')
  fs.copyFileSync(src, tmp)
  return tmp
}

// ---------------------------------------------------------------------------
// http.Server 形态（进程内 loopback）
// ---------------------------------------------------------------------------

export function startMockHttpMcpServer(opts) {
  const flags = {
    mode: 'http',
    pages: opts && opts.pages ? opts.pages : 1,
    hang: !!(opts && opts.hang),
    crash: false,
    structured: !!(opts && opts.structured),
    version: opts && opts.version ? opts.version : '2025-06-18'
  }
  const sseOnly = !!(opts && opts.sseOnly)
  const requestUrls = []
  const authHeaders = []
  const initialized = { done: false }
  let sseRes = null

  const server = http.createServer((req, res) => {
    requestUrls.push(req.method + ' ' + req.url)
    if (req.headers.authorization) authHeaders.push(req.headers.authorization)

    const isSseGet = req.method === 'GET' && /\/sse(\?|$)/.test(req.url || '')
    if (isSseGet) {
      // 旧协议 SSE 通道（SSEClientTransport fallback 目标；query 原样保留——21-04 回归锁定）
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write('event: endpoint\ndata: /messages?sessionId=s1\n\n')
      sseRes = res
      return
    }
    if (sseOnly && (req.url || '').split('?')[0] === '/mcp') {
      // SSE-only 对端：Streamable POST /mcp 一律 404 → 触发 mcpClient 显式 fallback（spike V-3）
      res.writeHead(404).end('not streamable')
      return
    }
    if (req.method === 'GET') {
      // Streamable 可选 SSE 流通道：405 明确不支持（SDK 容忍，POST-only stateless server）
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let msg = null
      try { msg = JSON.parse(body) } catch { /* 坏包 400 */ }
      if (!msg) { res.writeHead(400).end(); return }
      const respond = (payload) => {
        const ssePost = (req.url || '').split('?')[0] === '/messages'
        if (ssePost) {
          res.writeHead(202).end()
          if (sseRes && !flags.hang) {
            sseRes.write('event: message\ndata: ' + JSON.stringify(payload) + '\n\n')
          }
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return }
      const result = handleRpc(msg, flags, initialized)
      if (result === null) { res.writeHead(202).end(); return }
      if (flags.hang && initialized.done && msg.method === 'tools/list') {
        // 卡死分支：hold 住不回话
        return
      }
      respond({ jsonrpc: '2.0', id: msg.id, result })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port,
        requestUrls,
        authHeaders,
        close: () => new Promise((r) => { if (sseRes) { try { sseRes.destroy() } catch { /* ignore */ } } server.close(() => r()) })
      })
    })
  })
}

// 子进程入口守卫：仅「本文件被复制为 .mjs 且带 --child」时进入（vitest import 永不命中）
if (process.argv.includes && process.argv.includes('--child')) {
  runStdioChild()
}
