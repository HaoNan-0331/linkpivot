// tests/electron/_helpers/mockSshServer.ts
//
// SSH mock 对端（Phase 12 DEP-1 ABI 缓解，TEST-01/02 SSH 真路径测试复用）。
// 用 ssh2.Server（项目已装 ssh2 1.17.0 双向 Client↔Server API）起内存级 SSH server，
// 监听 127.0.0.1 随机端口（端口 0），接受任意凭证，回显 onExec(command) 预设输出。
//
// 安全域（threat_model T-12-01/T-12-02）：
//   - hostKey 用 crypto.generateKeyPairSync 随机生成（每次测试新密钥对，不写死真实凭证）
//   - listen(0, '127.0.0.1') 严格 loopback，禁止 0.0.0.0；端口 0 随机分配防撞
//   - tests/ 不进 electron-builder 安装包（排除规则不变）
//
// A2 checkpoint（RESEARCH Assumptions Log A2）：ssh2.Server 在 ELECTRON_RUN_AS_NODE 下 listen + 接受连接
// 已在 Plan 12-02 ai.execCommands.real.test 实跑验证。

import { Server } from 'ssh2'
import crypto from 'crypto'

export interface MockSshHandle {
  port: number
  close: () => Promise<void>
}

/**
 * 起一个内存级 mock SSH server（监听 127.0.0.1 随机端口）。
 * @param onExec 收到 client.exec(command) 时返回的回显字符串
 * @returns { port, close } —— close() 返回 Promise 等 server.close 回调（Pitfall 4 异步 close）
 */
export function startMockSshServer(onExec: (cmd: string) => string): Promise<MockSshHandle> {
  return new Promise((resolve, reject) => {
    // 随机生成测试 hostKey（不写死真实凭证，T-12-01 mitigate）
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

    const server = new Server({ hostKeys: [privateKeyPem] }, (client) => {
      // 接受任意凭证（username/password/key 全 accept，测试侧不验真实身份）
      client.on('authentication', (ctx) => {
        ctx.accept()
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (acceptAccept, _channel, { command }) => {
            const stream = acceptAccept()
            // 回显预设输出（镜像 arpCollector/ai 的 client.exec → stream.on('data') 消费流）
            stream.end(onExec(command))
          })
        })
      })
      client.on('error', (_err: unknown) => {
        /* 客户端断连等忽略，由被测代码 try/catch 处理 */
      })
    })

    // CR-02 修复：error handler 分两阶段 —— listen 阶段用 once + reject（仅 listen/early error 有效），
    // listen 成功后解绑 reject 改挂运行期 error → console.error（不再静默吞）。
    // 之前 server.on('error')→reject 在 listen resolve 之后是 no-op，运行期 accept/connection error 全被吞，
    // CI 上表现为「测试间歇性静默挂起或断言失败但无 error 线索」。
    const onListenError = (err: unknown) => reject(err)
    server.once('error', onListenError)

    // 严格 loopback + 端口 0 随机分配（T-12-02 mitigate）
    server.listen(0, '127.0.0.1', () => {
      // listen 成功：解绑 listen 阶段 reject，改挂运行期 error → console.error（让 CI 日志可见，不静默吞）
      server.off('error', onListenError)
      server.on('error', (err) => {
        // 运行期 error（accept 阶段 connection error / ssh2 内部 stream error 传播到 server）
        // 不应静默 —— 打到 stderr 让 CI 日志可见，便于定位「测试间歇性静默挂起」类问题
        console.error('[mockSshServer] runtime error:', err)
      })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : -1
      resolve({
        port,
        // close 返回 Promise 等 close 回调（Pitfall 4：mock server 异步 close，不 await 会致句柄泄漏误报）
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}
