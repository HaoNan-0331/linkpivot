// tests/electron/_helpers/mockTelnetServer.ts
//
// Telnet mock 对端（Phase 12 DEP-1 ABI 缓解，TEST-01/02 telnet 真路径测试复用）。
// 用 Node 内建 net.Server 起明文 TCP echo server，模拟 telnet shellPrompt + 命令回显。
//
// telnet IAC 协商 checkpoint（RESEARCH + PATTERNS 标记未完全展开，本 helper 落地策略）：
//   telnet-client connect 默认发 IAC WILL/WONT 协商字节（0xFF 0xFB/0xFC 子序列）。
//   策略：socket.on('data') 内识别 IAC 序列（buf[0]===0xFF / 255）并显式吞掉，
//   不做真实协商响应（极简 echo server 不需要 telnet 选项语义），
//   仅处理明文命令行。若 connect 因 IAC 无响应卡住，回退加 IAC DONT(0xFF 0xFE) 响应。
//   Plan 12-02 telnetExec.real.test 连真实 telnet-client 实跑验证；若 connect 卡住超 testTimeout，回此修。
//
// 安全域（threat_model T-12-02）：listen(0, '127.0.0.1') 严格 loopback，端口 0 随机分配。
//
// WR-04 隐式契约固化：executeTelnetCommand connect 配置含 loginPrompt/passwordPrompt
// （telnetExec.ts:129-135），但 telnet-client@2.2.13 的 getprompt 状态机在 shellPrompt
// 优先匹配时跳过 login/password（直接进 standby emit ready，不发凭证）—— 故本 mock 只发
// shellPrompt 不发 Username:/Password: 也能 work（username/password 参数被忽略）。
// 假设 telnet-client@2.2.13 此状态机顺序不变（package.json 已 pin 2.2.13）；若库升级改了
// 状态机顺序（如要求 login 先于 shellPrompt），需补 login/password prompt 状态机
// （参考 telnet-client/lib/index.js:356 getprompt 分支）。

import net from 'net'

export interface MockTelnetHandle {
  port: number
  close: () => Promise<void>
}

// telnet 协议字节常量
const IAC = 255 // 0xFF — Interpret As Command
const WILL = 251 // 0xFB
const WONT = 252 // 0xFC
const DO = 253 // 0xFD
const DONT = 254 // 0xFE
const SB = 250 // 0xFA — Subnegotiation Begin
const SE = 240 // 0xF0 — Subnegotiation End

/**
 * 起一个 mock telnet echo server（监听 127.0.0.1 随机端口）。
 * @param onCmd 收到明文命令时返回的回显字符串
 * @param shellPrompt 模拟的 shell 提示符（默认 'mock>'）
 * @returns { port, close } —— close() 返回 Promise 等 server.close 回调（Pitfall 4）
 */
export function startMockTelnetServer(
  onCmd: (cmd: string) => string,
  shellPrompt = 'mock>'
): Promise<MockTelnetHandle> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      // 连接建立后先发 shellPrompt（模拟登录后 prompt）
      socket.write(shellPrompt)

      socket.on('data', (buf: Buffer) => {
        // telnet IAC 协商处理（checkpoint）：识别 IAC 序列并显式响应 DONT/WONT（最小协商，避免 connect 卡住）
        const first = buf[0]
        if (buf.length > 0 && typeof first === 'number' && first === IAC) {
          // 解析并响应所有 IAC 命令（WILL→DONT，DO→WONT，其他吞掉）
          handleIac(socket, buf)
          // 若 IAC 序列后还有明文 payload（极少见），剥离 IAC 部分处理明文
          const textPart = stripIac(buf)
          handleText(socket, textPart, onCmd, shellPrompt)
          return
        }
        // 纯明文命令
        handleText(socket, buf.toString(), onCmd, shellPrompt)
      })
    })

    // CR-02 修复：error handler 分两阶段 —— listen 阶段用 once + reject（仅 listen/early error 有效），
    // listen 成功后解绑 reject 改挂运行期 error → console.error（不再静默吞）。
    // 之前 server.on('error')→reject 在 listen resolve 之后是 no-op，运行期 accept/connection error 全被吞。
    const onListenError = (err: unknown) => reject(err)
    server.once('error', onListenError)

    // 严格 loopback + 端口 0 随机分配（T-12-02 mitigate）
    server.listen(0, '127.0.0.1', () => {
      // listen 成功：解绑 listen 阶段 reject，改挂运行期 error → console.error（让 CI 日志可见，不静默吞）
      server.off('error', onListenError)
      server.on('error', (err) => {
        console.error('[mockTelnetServer] runtime error:', err)
      })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : -1
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

/** 处理 IAC 协商序列：对 WILL/DO 回 DONT/WONT（拒绝所有选项，最小协商）。 */
function handleIac(socket: net.Socket, buf: Buffer): void {
  let i = 0
  while (i < buf.length) {
    if (buf[i] !== IAC) {
      i++
      continue
    }
    // IAC 后跟命令字节
    if (i + 1 >= buf.length) break
    const cmd = buf[i + 1]
    if (cmd === WILL || cmd === DO) {
      // WR-02 修复：长度守卫防畸形 WILL/DO（末尾缺 option 字节）—— 之前 buf[i+2] ?? 0
      // 在缺字节时发 option=0（Binary Transmission）的 DONT/WONT，语义错误；应跳过不响应。
      if (i + 2 >= buf.length) break // 畸形：缺 option 字节，跳过不响应
      // 回 DONT/WONT（拒绝选项）
      const resp = cmd === WILL ? DONT : WONT
      socket.write(Buffer.from([IAC, resp, buf[i + 2]]))
      i += 3 // IAC + cmd + option
    } else if (cmd === WONT || cmd === DONT) {
      i += 3
    } else if (cmd === SB) {
      // 子协商：跳到 IAC SE
      i += 2
      while (i < buf.length - 1 && !(buf[i] === IAC && buf[i + 1] === SE)) i++
      i += 2
    } else {
      i += 2
    }
  }
}

/** 剥离 IAC 字节，返回纯明文部分。 */
function stripIac(buf: Buffer): string {
  const parts: number[] = []
  let i = 0
  while (i < buf.length) {
    if (buf[i] === IAC) {
      // 跳过 IAC + cmd(+option)
      if (i + 2 < buf.length) i += 3
      else i += 1
    } else {
      parts.push(buf[i])
      i++
    }
  }
  return Buffer.from(parts).toString()
}

/** 处理明文命令：trim + 回显 onCmd 结果 + shellPrompt。 */
function handleText(
  socket: net.Socket,
  text: string,
  onCmd: (cmd: string) => string,
  shellPrompt: string
): void {
  const trimmed = text.replace(/\r?\n$/, '').trim()
  if (trimmed) {
    socket.write(onCmd(trimmed) + '\r\n' + shellPrompt)
  }
}
