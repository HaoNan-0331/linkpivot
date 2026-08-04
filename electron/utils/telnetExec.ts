import { Telnet } from 'telnet-client'
import iconv from 'iconv-lite'

/**
 * Telnet 自动化 exec 共用 util（ai.ts executeCommandsOnDevice 与 arpCollector.executeTelnet 共享）。
 *
 * 抽取自 arpCollector.ts:77 原 executeTelnet，保持 connect（loginPrompt/PasswordPrompt/shellPrompt）
 * + exec + 自有 timeout 兜底 + finally cleanup 全部语义不变；新增 gbk 解码与 ANSI 剥离选项，
 * 供 ai.ts 输出后处理（与 SSH 路径 decodeDeviceBuffer + stripAnsi 对齐）。
 *
 * 设计说明：
 * - 自有 setTimeout 包 connect+exec 整体（telnet-client 库级 connect.timeout/execTimeout 在
 *   网络层挂起时不完全可靠），与 executeSSH 外层兜底对齐，使两协议同构。
 * - finally 清 timer + end（优雅），timeout 路径已 destroy 则幂等（destroy 之后再 end/destroy 无害）。
 *   telnet-client end() 是 async（发 EOF 包），未 await 即返回则紧接 destroy 可能使 EOF 写入失败，
 *   故 finally 回调为 async，外层 await 会等待 Promise.prototype.finally 的 async 回调。
 */

export interface TelnetExecOptions {
  /** 整体超时（connect + exec）兜底，默认 30000ms */
  timeout?: number
  /** 是否对输出做 gbk 解码（出现替换符 � 时回退 iconv gbk），默认 false */
  decodeGbk?: boolean
  /** 是否剥离 ANSI 转义序列与 \r，默认 false */
  stripAnsi?: boolean
  /** exec 真命令前先发这条命令关闭分页（如华为 screen-length 0 temporary / 思科 terminal length 0），忽略其输出与不支持错误，不阻断主命令 */
  disablePaginationCmd?: string
}

function stripAnsiString(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
}

function decodeBuffer(data: Buffer, decodeGbk: boolean): string {
  if (!decodeGbk) return data.toString('utf-8')
  const text = data.toString('utf-8')
  if (!text.includes('�')) return text
  return iconv.decode(data, 'gbk')
}

/**
 * 通过 telnet-client 连接设备并执行单条命令，返回（可选解码/剥离后的）输出。
 *
 * @param host 设备 IP
 * @param port telnet 端口（默认 23）
 * @param username 登录用户名
 * @param password 登录密码
 * @param command 待执行命令（白名单校验由调用方负责，本 util 不重复）
 * @param options 超时/解码/剥离选项
 */
export async function executeTelnetCommand(
  host: string,
  port: number,
  username: string,
  password: string,
  command: string,
  options: TelnetExecOptions = {}
): Promise<string> {
  const timeout = options.timeout ?? 30000
  const decodeGbk = options.decodeGbk ?? false
  const stripAnsiFlag = options.stripAnsi ?? false
  const disablePaginationCmd = options.disablePaginationCmd
  const rawOutputIsBuffer = decodeGbk || stripAnsiFlag

  const connection = new Telnet()
  let timer: NodeJS.Timeout | undefined
  let timedOut = false

  const result = await new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      // timeout 兜底：destroy 强制销毁 socket（telnet-client end 优雅，destroy 强制）
      try { connection.destroy() } catch { /* ignore */ }
      reject(new Error(`Telnet timeout after ${timeout}ms`))
    }, timeout)

    ;(async () => {
      try {
        await connection.connect({
          host, port, timeout, username, password,
          loginPrompt: /Username:|login:/i,
          passwordPrompt: /Password:/i,
          shellPrompt: /[>#]/,
          echoLines: 0, stripShellPrompt: true, execTimeout: timeout, newlineReplace: true,
        })
        // 关闭分页（华为 screen-length 0 temporary / 思科 terminal length 0）：长输出（display current-configuration 等）
        // 默认 ---- More ---- 分页，telnet-client exec 不自动翻页会截断在第一屏。忽略分页命令输出与不支持错误，不阻断主命令。
        if (disablePaginationCmd) {
          try { await connection.exec(disablePaginationCmd) } catch { /* 设备不支持该命令则忽略 */ }
        }
        const out = await connection.exec(command)
        resolve(out)
      } catch (err) {
        reject(err)
      }
    })()
  }).finally(async () => {
    if (timer) clearTimeout(timer)
    try { await connection.end() } catch { /* ignore */ }
    if (timedOut) { try { connection.destroy() } catch { /* ignore */ } }
  })

  if (!rawOutputIsBuffer) return result

  // telnet-client exec 返回 string；解码/剥离需基于字节，对 string 先按 utf-8 编码回 Buffer
  // 再走 decodeBuffer（与 SSH 路径 decodeDeviceBuffer 语义一致）。
  const buf = Buffer.from(result, 'utf-8')
  const decoded = decodeBuffer(buf, decodeGbk)
  return stripAnsiFlag ? stripAnsiString(decoded) : decoded
}
