import net from 'net'

/**
 * TCP 端口探活 + errno→中文消息映射单一来源。
 *
 * 模板逐字照搬 connection.ts testRDPConnection（Telnet/Web/RDP 三份探活的内嵌 Promise 同构），
 * 超时 10000ms 沿用现值；调用方在 15-02 收敛接线。
 */

/** TCP 探活默认超时（沿用 connection.ts testTelnet/testWeb/testRDP 现值 10000ms）。 */
export const TCP_PROBE_TIMEOUT_MS = 10000

/**
 * errno → 中文连接失败消息。
 * 判定顺序与 connection.ts testSSHConnection 现状 errno 部分一致；
 * ENOTFOUND 进基础映射是研究 ARCHITECTURE §2.1.3 指定的统一超集
 * （原 Telnet/RDP 版无此分支走兜底文案），非随手加。
 */
export function errnoToChinese(err: Error): string {
  return err.message.includes('ECONNREFUSED') ? '连接被拒绝'
    : err.message.includes('ENOTFOUND') ? '主机名无法解析'
    : err.message.includes('ETIMEDOUT') ? '连接超时'
    : err.message.includes('EHOSTUNREACH') ? '主机不可达'
    : `连接失败: ${err.message}`
}

export interface TcpProbeOptions {
  /** 探活超时，默认 TCP_PROBE_TIMEOUT_MS(10000ms) */
  timeoutMs?: number
  /** 成功消息前缀（如 'Telnet 连接成功' / 'RDP 端口可达'），默认 'TCP 连接成功' */
  successLabel?: string
}

/**
 * TCP 连通性探活：connect 即成功（探活不读数据），超时 destroy，错误映射 errnoToChinese。
 * 模板与 connection.ts testRDPConnection 逐字同构（仅 timeout/label 参数化）。
 */
export function testTcpConnect(
  host: string,
  port: number,
  opts?: TcpProbeOptions
): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ success: false, message: `连接超时 (${host}:${port})` })
    }, opts?.timeoutMs ?? TCP_PROBE_TIMEOUT_MS)

    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ success: true, message: `${opts?.successLabel ?? 'TCP 连接成功'} (${host}:${port})` })
    })
    socket.on('error', (err: Error) => {
      clearTimeout(timer)
      resolve({ success: false, message: errnoToChinese(err) })
    })
    socket.connect(port, host)
  })
}
