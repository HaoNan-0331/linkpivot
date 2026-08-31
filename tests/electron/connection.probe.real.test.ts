import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { Server } from 'ssh2'
import crypto from 'crypto'
import net from 'net'

/**
 * connection 真路径回归（Phase 16 Plan 16-04 Task 2，TEST-04 / D-10 / D-08）。
 *
 * D-10 断言面：连内联验凭证 SSH Server（PATTERNS 方案 A——mockSshServer.ts ctx.accept() 任意
 * 凭证放行，不支持验凭证，故密码错被拒场景必须内联 ssh2.Server，照 connectSSH.algorithms.real.test.ts 范式）：
 *   密码对能连 / 密钥对能连 / 密码错被拒且用户看到 '认证失败(用户名/密码/密钥错误)'。
 *
 * D-08 安全底线：devices 表凭证列经真实 encField 加密落库——裸 SQL 断言 password_enc/
 * ssh_key_content_enc 密文非明文 + 'v2:' 前缀（AES-256-GCM v2，crypto.ts）+ decField 回读一致
 * + 真实 getDeviceById 解密一致。device service 真实实现（不 mock device），仅 IO 边界
 * vi.mock database/connection 注入 makeRealDb 真库。
 *
 * D-08 覆盖范围说明：本 phase 经 connection 凭证流经路径覆盖设备表加密列底线断言
 * （password_enc/ssh_key_content_enc）；kb_documents/kb_chunks 无加密列（现状怪癖 Q1），
 * kb 加密断言待 Phase 17 S-M1 / Phase 18 kb 加密列落地后有靶子再补（16-QUIRKS.md 记录）。
 *
 * Mock 策略（12-02 反向范式：被测协议 ssh2/net 不 mock 走真 binding）：
 *   - ssh2 / net：真实现（真路径铁律）
 *   - ../../electron/database/connection：IO 边界 mock，getDatabase 返 realDb 真库（D-07 红线内零生产改动）
 *   - ../../electron/services/device：**不 mock**（真实 createDevice/getDeviceById 走真实 encField 加密）
 *
 * 安全域（threat_model T-16-04-01/02/05）：
 *   - 密码仅 'test-*' 字面量；密钥 crypto.generateKeyPairSync 现场随机生成（不写死凭证）
 *   - 全部 Server listen(0, '127.0.0.1') 严格 loopback
 *   - afterEach setConnectionMasterKey('') 复位防 MK 跨文件漂移 + holder.handle.close() 严格删 tmpdir 真库
 */

import { makeRealDb, type RealDbHandle } from './_helpers/realDb'
import { expectNoHandleLeak } from './_helpers/handleLeakDetector'
import { testDeviceConnection, setConnectionMasterKey } from '../../electron/services/connection'
import { createDevice, getDeviceById } from '../../electron/services/device'
import { decField } from '../../electron/utils/crypto'

// 句柄泄漏检测（默认白名单已含 TCPServerWrap/TCPWrap/SimpleWriteWrap，覆盖 mock server + ssh2 stream）
expectNoHandleLeak()

// ---- Mock：database/connection（IO 边界，vi.hoisted 可变句柄防 hoisting 报错） ----
const holder = vi.hoisted(() => ({
  handle: null as null | { db: import('better-sqlite3').Database },
}))
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => {
    if (!holder.handle) throw new Error('realDb not ready')
    return holder.handle.db
  },
}))

const TEST_MK = 'nt-test-mk-16f'

// ---- 验凭证 SSH Server 状态（每个 it 设定期望凭证） ----
let expectedUser = ''
let expectedPassword = ''
let expectedKeyBlob: Buffer | null = null

/** RSA 公钥 → SSH wire 格式 blob（'ssh-rsa' || e || n），用于与 ctx.key.data 比对（T-16-04-04 accept：blob 比对后 accept） */
function rsaSshPublicKeyBlob(publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { e: string; n: string }
  const mpint = (b: Buffer): Buffer => {
    // SSH mpint：最高位为 1 时须补前导 0x00（JWK 的 n/e 无前导零，需按 SSH wire 格式补齐）
    const v = b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b
    const len = Buffer.alloc(4)
    len.writeUInt32BE(v.length)
    return Buffer.concat([len, v])
  }
  return Buffer.concat([
    mpint(Buffer.from('ssh-rsa', 'utf8')),
    mpint(Buffer.from(jwk.e, 'base64url')),
    mpint(Buffer.from(jwk.n, 'base64url')),
  ])
}

/** 内联验凭证 SSH Server（mockSshServer 不支持验凭证，方案 A）：密码/公钥 blob 条件 accept/reject */
function startAuthServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    // 随机生成测试 hostKey（不写死真实凭证，T-16-04-01 mitigate）
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const hostKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

    const server = new Server(
      { hostKeys: [hostKeyPem] },
      (client) => {
        client.on('authentication', (ctx) => {
          if (
            ctx.method === 'password' &&
            ctx.username === expectedUser &&
            ctx.password === expectedPassword
          ) {
            return ctx.accept()
          }
          if (
            ctx.method === 'publickey' &&
            expectedKeyBlob &&
            // 不比对 algo 名：ssh2/OpenSSH 客户端对 RSA 密钥可能以 rsa-sha2-512/256 算法名
            // 发起认证（blob 格式与 ssh-rsa 相同），以 key blob 比对为准（T-16-04-04 accept）
            expectedKeyBlob.equals(ctx.key.data)
          ) {
            return ctx.accept()
          }
          ctx.reject()
        })
        client.on('ready', () => {
          client.on('session', (accept) => accept())
        })
        client.on('error', () => { /* 客户端断连等忽略 */ })
      }
    )

    // error handler 两阶段（mockSshServer.ts CR-02 范式：listen 阶段 once+reject，listen 后 off 改挂 console.error）
    const onListenError = (err: unknown) => reject(err)
    server.once('error', onListenError)

    // 严格 loopback + 端口 0 随机分配（T-16-04-02 mitigate）
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onListenError)
      server.on('error', (err) => console.error('[auth server] runtime error:', err))
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : -1
      resolve({
        port,
        // close 返回 Promise 等 close 回调（Pitfall 4：异步 close 防句柄泄漏误报）
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

describe('connection 真路径 — 凭证 + 探活 + D-08 加密底线', () => {
  let ssh: { port: number; close: () => Promise<void> }

  beforeAll(async () => {
    ssh = await startAuthServer()
  })

  afterAll(async () => {
    // Pitfall 4：mock server 异步 close
    await ssh.close()
  })

  beforeEach(() => {
    // 每个 it 独立真库（tmpdir 唯一名）+ devices/device_credentials DDL 逐字照抄 init.ts
    // （36-02 后 fresh 形态：devices 无六行内凭证列，凭证唯一真源 device_credentials；
    // createDevice INSERT 不含 topology_id 列，留 NULL 不触发 FK）
    const handle = makeRealDb()
    holder.handle = handle
    holder.handle.db.exec(`
      CREATE TABLE IF NOT EXISTS topologies (
        id TEXT PRIMARY KEY,
        name_enc TEXT NOT NULL,
        data_enc TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','pending','draft')),
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        topology_id TEXT,
        name_enc TEXT NOT NULL,
        vendor_enc TEXT,
        model_enc TEXT,
        version_enc TEXT,
        ip_enc TEXT,
        device_type TEXT DEFAULT 'generic' CHECK(device_type IN ('router','switch','firewall','server','generic')),
        connection_type TEXT CHECK(connection_type IN ('ssh','telnet','web','rdp')),
        name_hash TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (topology_id) REFERENCES topologies(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS device_credentials (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('ssh','telnet','web','rdp')),
        port_enc TEXT,
        username_enc TEXT,
        password_enc TEXT,
        ssh_key_path_enc TEXT,
        ssh_key_content_enc TEXT,
        web_url_enc TEXT,
        resolution TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(device_id, channel),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_device_credentials_device ON device_credentials(device_id);
    `)
    // MK 注入必须在 createDevice 之前（加密落库依赖模块级 MK）
    setConnectionMasterKey(TEST_MK)
    expectedUser = ''
    expectedPassword = ''
    expectedKeyBlob = null
  })

  afterEach(() => {
    // MK 复位防跨文件漂移（T-16-04-05）+ realDb 严格清理（镜像 realDb.ts close 删主文件/-wal/-shm）
    setConnectionMasterKey('')
    holder.handle?.close()
    holder.handle = null
  })

  it('密码对能连（D-10）：createDevice 密码凭证 → 认证 accept → SSH 连接成功', async () => {
    expectedUser = 'nt-ssh-user'
    expectedPassword = 'test-pw-correct'
    const dev = createDevice({
      name: 'nt-real-ssh-pw',
      ipAddress: '127.0.0.1',
      // 36-04：凭证按通道节提交（shim 已移除），默认通道经 D-09 滑落收敛为 ssh
      channels: [{ channel: 'ssh', enabled: true, port: ssh.port, username: expectedUser, password: expectedPassword }],
    })
    const r = await testDeviceConnection(dev.id)
    expect(r).toEqual({
      success: true,
      message: `SSH 连接成功 (127.0.0.1:${ssh.port})`,
      channels: [{ channel: 'ssh', success: true, message: `SSH 连接成功 (127.0.0.1:${ssh.port})` }],
    })
  })

  it('密钥对能连（D-10）：现场生成密钥对 → sshKeyContent 走 buildSSHConnectConfig privateKey 分支真路径', async () => {
    expectedUser = 'nt-key-user'
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    expectedKeyBlob = rsaSshPublicKeyBlob(publicKey)
    const dev = createDevice({
      name: 'nt-real-ssh-key',
      ipAddress: '127.0.0.1',
      channels: [{ channel: 'ssh', enabled: true, port: ssh.port, username: expectedUser, sshKeyContent: privateKeyPem }],
    })
    const r = await testDeviceConnection(dev.id)
    expect(r.success).toBe(true)
  })

  it('密码错被拒（D-10 核心）：对端 ctx.reject() → 用户看到 认证失败(用户名/密码/密钥错误)', async () => {
    expectedUser = 'nt-ssh-user'
    expectedPassword = 'test-pw-correct' // 服务器期待的正确密码
    const dev = createDevice({
      name: 'nt-real-ssh-badpw',
      ipAddress: '127.0.0.1',
      channels: [{ channel: 'ssh', enabled: true, port: ssh.port, username: expectedUser, password: 'test-pw-WRONG' }], // 设备存的是错误密码
    })
    const r = await testDeviceConnection(dev.id)
    // D-10 核心断言：用户看到的报错提示正确（ssh2 'All configured authentication methods failed'
    // 经真 mapSshProbeError AUTH 分支映射，文案逐字对齐 sshConfig.ts）
    expect(r).toEqual({
      success: false,
      message: '认证失败(用户名/密码/密钥错误)',
      channels: [{ channel: 'ssh', success: false, message: '认证失败(用户名/密码/密钥错误)' }],
    })
  })

  it('D-08 凭证加密底线：device_credentials 凭证列经真实 encField 加密落库（v2: 密文非明文 + 解密回读一致）', () => {
    const dev = createDevice({
      name: 'nt-real-enc',
      ipAddress: '127.0.0.1',
      channels: [{ channel: 'ssh', enabled: true, port: ssh.port, username: 'nt-enc-user', password: 'test-pw-plain', sshKeyContent: 'test-key-plain' }],
    })
    // 裸 SQL 直读加密列（不经过 service 解密路径）——36-02 起凭证落 device_credentials 子表
    const row = holder.handle!.db
      .prepare("SELECT password_enc, ssh_key_content_enc, username_enc FROM device_credentials WHERE device_id = ? AND channel = 'ssh'")
      .get(dev.id) as { password_enc: string; ssh_key_content_enc: string; username_enc: string }
    // 密文非空 + 不等于明文（D-08：凭证不以明文落库）+ 'v2:' 前缀（AES-256-GCM v2 格式，crypto.ts）
    expect(row.password_enc).toBeTruthy()
    expect(row.password_enc).not.toBe('test-pw-plain')
    expect(row.password_enc.startsWith('v2:')).toBe(true)
    expect(row.ssh_key_content_enc).toBeTruthy()
    expect(row.ssh_key_content_enc).not.toBe('test-key-plain')
    expect(row.ssh_key_content_enc.startsWith('v2:')).toBe(true)
    expect(row.username_enc.startsWith('v2:')).toBe(true)
    // decField 回读与传入一致（密文可逆且密钥正确）
    expect(decField(row.password_enc, TEST_MK)).toBe('test-pw-plain')
    expect(decField(row.ssh_key_content_enc, TEST_MK)).toBe('test-key-plain')
    // 真实 getDeviceById channels 投影解密路径一致性（36-02 起凭证唯一真源为子表；
    // connection.ts 探活消费的经 loadDeviceInfo 平铺桥取自同一条解密链）
    const got: any = getDeviceById(dev.id)
    const sshCh = got?.channels?.find((c: any) => c.channel === 'ssh')
    expect(sshCh?.password).toBe('test-pw-plain')
    expect(sshCh?.sshKeyContent).toBe('test-key-plain')
  })

  it('telnet 探活真路径：connectionType telnet 设备连 mock 对端 → Telnet 连接成功', async () => {
    // 用裸 net.Server 静默对端（plan 允许「startMockTelnetServer 或裸 net.Server」）：
    // mockTelnetServer 连接即写 shellPrompt，而探活 connect 即 destroy，未读数据触发 RST →
    // 对端 socket 无 error handler 抛 unhandled ECONNRESET；静默对端 destroy 走正常 FIN 无此问题
    const tel = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
      const server = net.createServer(() => { /* 探活只连不读，accept 即可 */ })
      const onListenError = (err: unknown) => reject(err)
      server.once('error', onListenError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onListenError)
        server.on('error', (err) => console.error('[telnet probe server] runtime error:', err))
        const addr = server.address()
        resolve({
          port: typeof addr === 'object' && addr ? addr.port : -1,
          close: () => new Promise<void>((res) => server.close(() => res())),
        })
      })
    })
    try {
      const dev = createDevice({
        name: 'nt-real-telnet',
        ipAddress: '127.0.0.1',
        channels: [{ channel: 'telnet', enabled: true, port: tel.port, username: 'a', password: 'test-telnet-pw' }],
      })
      const r = await testDeviceConnection(dev.id)
      expect(r).toEqual({
        success: true,
        message: `Telnet 连接成功 (127.0.0.1:${tel.port})`,
        channels: [{ channel: 'telnet', success: true, message: `Telnet 连接成功 (127.0.0.1:${tel.port})` }],
      })
    } finally {
      await tel.close()
    }
  })

  it('超时兜底防挂（T-16-04-03）：对端不响应认证 → 探活 8s readyTimeout/10s timer 兜底内必然 resolve', async () => {
    // 不响应认证的 Server（authentication 直接不响应/挂起）
    const hanging = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
      const hostKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
      const server = new Server({ hostKeys: [hostKeyPem] }, (client) => {
        client.on('authentication', () => { /* 挂起：不 accept 也不 reject */ })
        client.on('error', () => { /* 客户端超时断连忽略 */ })
      })
      const onListenError = (err: unknown) => reject(err)
      server.once('error', onListenError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onListenError)
        server.on('error', (err) => console.error('[hanging server] runtime error:', err))
        const addr = server.address()
        resolve({
          port: typeof addr === 'object' && addr ? addr.port : -1,
          close: () => new Promise<void>((res) => server.close(() => res())),
        })
      })
    })
    try {
      const dev = createDevice({
        name: 'nt-real-hang',
        ipAddress: '127.0.0.1',
        channels: [{ channel: 'ssh', enabled: true, port: hanging.port, username: 'nt-hang-user', password: 'test-pw-hang' }],
      })
      // settled+timer 竞速（connectSSH.algorithms.real.test.ts:90-128 范式）：外层 13s 兜底，
      // SSH 探活自身 8s readyTimeout + 10s timer 会在兜底前 resolve false（vitest testTimeout 15s 外层再兜一层）
      const r = await Promise.race([
        testDeviceConnection(dev.id),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('outer timeout: testDeviceConnection 永久挂起')), 13000)
        ),
      ])
      expect(r.success).toBe(false)
    } finally {
      await hanging.close()
    }
  })
})
