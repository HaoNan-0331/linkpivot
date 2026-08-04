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
 * - finally 清 timer；非 timeout 路径走 end（优雅发 EOF），timeout 路径（已 destroy）跳过 end
 *   直接幂等 destroy（WR-07：避免 socket 已 destroy 后再 end 的时序耦合脆弱度）。
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
  /** 覆盖 connect 的 shellPrompt（命令结束判定）。华为/H3C 长输出含裸 # 段落分隔，默认 /[>#]/ 会误匹配截断，需传精确 prompt（如 /(<[^>]+>|\[[^\]]+\])/）。默认 /[>#]/ */
  shellPrompt?: RegExp
}

/**
 * 按 device.vendor 选关闭 telnet 分页命令。
 * cisco/锐捷 → terminal length 0；华为/H3C/默认 → screen-length 0 temporary。
 * 命令仅本 telnet 会话关分页（退出恢复），util 内部发不经 AI 命令白名单（与 arpCollector 直接发采集命令同模式）。
 *
 * WR-03：从 ai.ts 抽到 telnetExec.ts 共用——ai.ts telnet 分流 与 arpCollector collectFromDevice 同 util，
 * 关分页命令应统一来源，避免两处漂移（arpCollector 长 ARP 表 ---- More ---- 截断风险）。
 */
export function pickDisablePaginationCmd(vendor: string | undefined | null): string {
  const v = String(vendor || '').toLowerCase()
  if (v.includes('cisco') || v.includes('ruijie')) return 'terminal length 0'
  return 'screen-length 0 temporary'
}

/**
 * 按 device.vendor 选 telnet 命令结束判定的 shellPrompt。
 * Root cause（debug 260804）：华为配置用裸 # 做段落分隔，默认 /[>#]/ 会在配置的 # 处误匹配致 exec 提前 resolve 截断。
 * 华为/H3C/默认 → 只匹配真实 prompt <hostname>/[hostname]（配置无 <>/[]，不误匹配）；
 * 思科/锐捷 → \S[>#]（配置用 ! 分隔，# 即真实 prompt，要求 # 前有 hostname 字符，不匹配行首裸 #）。
 *
 * WR-03：从 ai.ts 抽到 telnetExec.ts 共用，同 pickDisablePaginationCmd 理由。
 */
export function pickShellPrompt(vendor: string | undefined | null): RegExp {
  const v = String(vendor || '').toLowerCase()
  if (v.includes('huawei') || v.includes('h3c')) {
    // 华为/H3C：真实 prompt <hostname>（用户视图）/ [hostname]（系统视图），配置无 <>/[]，严格匹配绝不误判裸 #
    return /(<[^>]+>|\[[^\]]+\])/
  }
  if (v.includes('cisco') || v.includes('ruijie')) {
    // 思科/锐捷：配置用 ! 分隔（无裸 #），prompt hostname# / hostname>，要求 #/> 前有 hostname
    return /\S[>#]/
  }
  // 未知/缺失 vendor 通用兜底：覆盖 <host>/[host]/host#/host> 所有主流厂商 prompt 格式，
  // 换设备/换厂商（含 Juniper/Arista 等未来新增）自动适配，仍不匹配行首裸 #。已知厂商走精确分支更稳。
  return /(<[^>]+>|\[[^\]]+\]|\S[>#])/
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
  const shellPrompt = options.shellPrompt
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

    // IN-03：双 reject 路径安全说明——本 IIFE catch 内 reject(err) 与 timer 的 reject(timeout)
    // 是两条独立 reject 路径。Promise 规范保证首次 reject 后 settled，二次调 reject/resolve 被忽略无害。
    // 场景：timer 先 destroy + reject(timeout)，IIFE 内 await connection.exec 才抛「socket destroyed」
    // → catch → reject(err)（被忽略），无双重结算风险。
    ;(async () => {
      try {
        await connection.connect({
          host, port, timeout, username, password,
          loginPrompt: /Username:|login:/i,
          passwordPrompt: /Password:/i,
          shellPrompt: shellPrompt ?? /[>#]/,
          echoLines: 0, stripShellPrompt: true, execTimeout: timeout,
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
    // WR-07：timedOut 路径已 destroy（timeout 兜底分支内 connection.destroy()），不再发 EOF（end）。
    // 旧实现对所有路径都 await end() 再二次 destroy——依赖 telnet-client end() 在 socket 已 destroy
    // 时幂等。改：timedOut 直接 destroy 幂等；非 timedOut 走优雅 end() 发 EOF。降低时序耦合脆弱度。
    if (!timedOut) {
      try { await connection.end() } catch { /* ignore */ }
    } else {
      try { connection.destroy() } catch { /* ignore */ }
    }
  })

  if (!rawOutputIsBuffer) return result

  // telnet-client exec 返回 string；解码/剥离需基于字节，对 string 先按 utf-8 编码回 Buffer
  // 再走 decodeBuffer（与 SSH 路径 decodeDeviceBuffer 语义一致）。
  const buf = Buffer.from(result, 'utf-8')
  const decoded = decodeBuffer(buf, decodeGbk)
  return stripAnsiFlag ? stripAnsiString(decoded) : decoded
}
