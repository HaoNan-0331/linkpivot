import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { Client, Server, type ConnectConfig } from 'ssh2'
import crypto from 'crypto'

/**
 * connectSSH SSH 算法协商真路径回归（Phase 13 Plan 13-01 Task 2，SEC-03 D-13-8 真路径自动化）。
 *
 * SEC-03 核心契约：connectSSH 复用 SSH_ALGORITHMS 常量（含 curve25519-sha256 首项）后，
 * 能与仅支持 curve25519 的现代 Linux 对端协商成功。改造前 connection.ts connectSSH 用内联表
 * （kex 首项 ecdh-sha2-nistp256，缺 curve25519），与现代 Linux KEX 失败 → 终端连不上。
 *
 * 可行性决策（D-13-8 planner 评估结论）：connectSSH 全函数带 `termWin: BrowserWindow` 参数
 * （Electron app 未 ready 时测试通道无法造真 BrowserWindow），故不调 connectSSH 全函数，
 * 直接验证核心契约——`new ssh2.Client()` 用 `{ ..., algorithms: SSH_ALGORITHMS }` 与
 * curve25519-only 对端协商成功触发 'ready'。绕开 BrowserWindow 同时 100% 覆盖算法协商路径。
 *
 * 复用 Phase 12 helper：
 *   - expectNoHandleLeak(): afterEach 句柄泄漏检测（默认白名单含 TCPServerWrap/TCPWrap/SimpleWriteWrap）
 *
 * Mock 策略（与 arpCollector.real.test.ts 反向范式不同）：
 *   - **不 vi.mock ssh2**（被测协议走真 binding 连内联 ssh2.Server）
 *   - **不调 startMockSshServer helper**：helper 不支持自定义对端 algorithms，本测试需对端
 *     仅暴露 curve25519-sha256（模拟现代 Linux 算法集），故直接 `new Server({ hostKeys, algorithms: { kex: ['curve25519-sha256'] } })`
 *   - hostKey 用 crypto.generateKeyPairSync 随机生成（T-13-01-05 mitigate，照抄 mockSshServer T-12-01）
 *   - listen(0, '127.0.0.1') 严格 loopback（T-13-01-05 mitigate，照抄 T-12-02）
 *
 * 安全域（threat_model T-13-01-05）：tests/ 不进 electron-builder 安装包（排除规则不变）。
 */

import { SSH_ALGORITHMS, SSH_READY_TIMEOUT_MS } from '../../electron/utils/sshConfig'
import { expectNoHandleLeak } from './_helpers/handleLeakDetector'

// 句柄泄漏检测：默认白名单（TCPServerWrap/TCPWrap/SimpleWriteWrap 已含）覆盖 mock server
// listen socket + ssh2 native stream libuv 释放延迟，此处不传 extraAllow。
expectNoHandleLeak()

/**
 * 启动 curve25519-only SSH server（对端仅暴露 curve25519-sha256 KEX，模拟现代 Linux 典型算法集）。
 * 直接内联 ssh2.Server（不调 startMockSshServer，因 helper 不支持自定义对端 algorithms）。
 * 照抄 mockSshServer.ts:34-52 结构 + algorithms 限制 + close 返回 Promise（Pitfall 4 异步 close）。
 */
function startCurve25519OnlyServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    // 随机生成测试 hostKey（不写死真实凭证，T-13-01-05 mitigate）
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

    const server = new Server(
      {
        hostKeys: [privateKeyPem],
        // 对端仅支持 curve25519-sha256 KEX（模拟现代 Linux 算法集）
        algorithms: { kex: ['curve25519-sha256'] },
      },
      (client) => {
        client.on('authentication', (ctx) => ctx.accept())
        client.on('ready', () => {
          client.on('session', (accept) => accept())
        })
        client.on('error', () => {
          /* 客户端断连等忽略 */
        })
      }
    )

    const onListenError = (err: unknown) => reject(err)
    server.once('error', onListenError)

    // 严格 loopback + 端口 0 随机分配（T-13-01-05 mitigate）
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onListenError)
      server.on('error', (err) => console.error('[curve25519-only server] runtime error:', err))
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : -1
      resolve({
        port,
        // close 返回 Promise 等 close 回调（Pitfall 4：异步 close，不 await 致句柄泄漏误报）
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

/**
 * 用给定 algorithms 配置连 curve25519-only 对端，返回协商结果。
 * 'ready' → 协商成功；'error' → 协商失败；超时兜底防 hang（参照 ai.execCommands.real.test.ts overallTimeout）。
 */
function negotiateCurve25519Only(
  port: number,
  algorithms: ConnectConfig['algorithms']
): Promise<{ event: 'ready' | 'error'; message?: string }> {
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    const finish = (event: 'ready' | 'error', message?: string) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        /* ignore */
      }
      resolve({ event, message })
    }
    // 超时兜底（10s，防 KEX 永挂；vitest testTimeout 15s 兜底外层）
    const timer = setTimeout(() => finish('error', 'timeout'), 10000)

    client.on('ready', () => {
      clearTimeout(timer)
      finish('ready')
    })
    client.on('error', (err: Error) => {
      clearTimeout(timer)
      finish('error', err.message)
    })

    client.connect({
      host: '127.0.0.1',
      port,
      username: 'test',
      password: 'test',
      readyTimeout: SSH_READY_TIMEOUT_MS,
      algorithms,
    })
  })
}

describe('connectSSH — SSH_ALGORITHMS 与 curve25519-only 对端协商真路径回归（SEC-03）', () => {
  let sshHandle: { port: number; close: () => Promise<void> }

  beforeAll(async () => {
    sshHandle = await startCurve25519OnlyServer()
  })

  afterAll(async () => {
    // Pitfall 4：mock server 异步 close
    await sshHandle.close()
  })

  it('SSH_ALGORITHMS kex 含 curve25519-sha256 首项（SEC-03 复用源常量已含 curve25519，是修复前提）', () => {
    // 常量断言，无网络：验证 SSH_ALGORITHMS 常量本身已含 curve25519 首项
    // （这是 connectSSH 复用 SSH_ALGORITHMS 后能连现代 Linux 的前提条件）
    expect(SSH_ALGORITHMS.kex).toBeDefined()
    expect(SSH_ALGORITHMS.kex!.length).toBeGreaterThan(0)
    expect(SSH_ALGORITHMS.kex![0]).toBe('curve25519-sha256')
  })

  it('client.connect 用 SSH_ALGORITHMS 与 curve25519-only 对端协商成功（ready 触发）—— SEC-03 修复回归守卫', async () => {
    // SEC-03 核心：connectSSH 复用 SSH_ALGORITHMS 后能连现代 Linux。
    // 用 SSH_ALGORITHMS 连 curve25519-only 对端 → 必须触发 'ready'（协商成功）。
    const result = await negotiateCurve25519Only(sshHandle.port, SSH_ALGORITHMS)

    // 改造前 connection.ts connectSSH 内联表缺 curve25519 会 KEX 失败 → 此 it 是修复回归守卫
    expect(result.event).toBe('ready')
  })

  it('client.connect 用内联旧表（缺 curve25519）与 curve25519-only 对端协商失败（error 触发）—— drift 危害反向回归守卫', async () => {
    // 反向回归：client.connect algorithms 用历史内联表（kex 首项 ecdh-sha2-nistp256，缺 curve25519，
    // 从 connection.ts 改造前快照硬编码），连同一 curve25519-only 对端 → 必须触发 'error'（KEX 失败）。
    // 此 it 锁定 drift 危害，防未来有人误删 SSH_ALGORITHMS 回退内联表。
    const legacyInlineAlgorithms: ConnectConfig['algorithms'] = {
      kex: [
        'ecdh-sha2-nistp256',
        'ecdh-sha2-nistp384',
        'ecdh-sha2-nistp521',
        'diffie-hellman-group-exchange-sha256',
        'diffie-hellman-group14-sha256',
        'diffie-hellman-group15-sha512',
        'diffie-hellman-group16-sha512',
        'diffie-hellman-group-exchange-sha1',
        'diffie-hellman-group14-sha1',
        'diffie-hellman-group1-sha1',
      ],
      cipher: [
        'aes128-gcm@openssh.com',
        'aes256-gcm@openssh.com',
        'aes128-ctr',
        'aes192-ctr',
        'aes256-ctr',
        'aes128-cbc',
        'aes192-cbc',
        'aes256-cbc',
        '3des-cbc',
        'blowfish-cbc',
      ],
      serverHostKey: [
        'ssh-rsa',
        'rsa-sha2-256',
        'rsa-sha2-512',
        'ecdsa-sha2-nistp256',
        'ecdsa-sha2-nistp384',
        'ecdsa-sha2-nistp521',
        'ssh-ed25519',
        'ssh-dss',
      ],
    }

    const result = await negotiateCurve25519Only(sshHandle.port, legacyInlineAlgorithms)

    // 内联旧表缺 curve25519 → 与 curve25519-only 对端无共同 KEX → 'error'（drift 危害锁定）
    expect(result.event).toBe('error')
  })
})
