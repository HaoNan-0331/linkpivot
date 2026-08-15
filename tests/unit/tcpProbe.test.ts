import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'net'
import { EventEmitter } from 'events'
import { testTcpConnect, errnoToChinese } from '../../electron/utils/tcpProbe'

describe('tcpProbe.errnoToChinese', () => {
  it('maps ECONNREFUSED to 连接被拒绝', () => {
    expect(errnoToChinese(new Error('connect ECONNREFUSED 1.2.3.4:23'))).toBe('连接被拒绝')
  })

  it('maps ENOTFOUND to 主机名无法解析 (unified superset per ARCHITECTURE §2.1.3)', () => {
    expect(errnoToChinese(new Error('getaddrinfo ENOTFOUND bogus.invalid'))).toBe('主机名无法解析')
  })

  it('maps ETIMEDOUT to 连接超时', () => {
    expect(errnoToChinese(new Error('connect ETIMEDOUT 1.2.3.4:22'))).toBe('连接超时')
  })

  it('maps EHOSTUNREACH to 主机不可达', () => {
    expect(errnoToChinese(new Error('connect EHOSTUNREACH 10.255.255.1:22'))).toBe('主机不可达')
  })

  it('falls back to 连接失败: <message> for non-errno errors', () => {
    expect(errnoToChinese(new Error('boom'))).toBe('连接失败: boom')
  })
})

describe('tcpProbe.testTcpConnect', () => {
  let server: net.Server | null = null

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
    vi.doUnmock('net')
    vi.resetModules()
  })

  it('resolves success on listening loopback port (custom successLabel)', async () => {
    server = net.createServer(() => { /* accept and hold */ })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port

    const result = await testTcpConnect('127.0.0.1', port, { successLabel: 'Telnet 连接成功' })
    expect(result).toEqual({ success: true, message: `Telnet 连接成功 (127.0.0.1:${port})` })
  })

  it('uses default label "TCP 连接成功" when successLabel omitted', async () => {
    server = net.createServer(() => { /* accept and hold */ })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port

    const result = await testTcpConnect('127.0.0.1', port)
    expect(result).toEqual({ success: true, message: `TCP 连接成功 (127.0.0.1:${port})` })
  })

  it('resolves 连接被拒绝 on non-listening port', async () => {
    // 占一个端口再关掉，保证该端口确定未被监听（loopback → ECONNREFUSED）
    server = net.createServer(() => { /* noop */ })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((r) => server!.close(() => r()))
    server = null

    const result = await testTcpConnect('127.0.0.1', port)
    expect(result).toEqual({ success: false, message: '连接被拒绝' })
  })

  it('resolves 连接超时 (host:port) when connect never completes, timeoutMs=200', async () => {
    // plan 描述的「accept 后不响应」对端在探活模板（connect 即成功 destroy）下必然走成功分支，
    // 无法触发超时——改用 doMock 挂起 socket（connect() 永不 emit connect/error）确定性触发超时路径。
    class HangingSocket extends EventEmitter {
      connect() { return this }
      destroy() { this.emit('close') }
    }
    vi.doMock('net', () => ({
      default: { Socket: HangingSocket },
      Socket: HangingSocket,
    }))
    const { testTcpConnect: probe } = await import('../../electron/utils/tcpProbe')

    const start = Date.now()
    const result = await probe('1.2.3.4', 22, { timeoutMs: 200 })
    expect(result).toEqual({ success: false, message: '连接超时 (1.2.3.4:22)' })
    expect(Date.now() - start).toBeGreaterThanOrEqual(200)
    expect(Date.now() - start).toBeLessThan(5000)
  })
})
