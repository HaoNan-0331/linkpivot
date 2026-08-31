/**
 * aiExec —— AI 命令执行域（SSH/Telnet 远程执行 + 设备能力边界 + privilegeGuard 越权防线接线）。
 *
 * Phase 32（D-01 / D-05）：机械搬移自 ai.ts 原执行域（拆分前原始行号 :429-850，含 stripAnsi
 * :429-436 与 guard 接线 :819-850），函数体逐字零改动，保持源函数形态（不转静态类）。
 *
 * 依赖方向：→ aiConfig（getCommandWhitelist 消费：executeCommandsOnDevice 白名单判定）；
 * 被 aiMcp / aiAgentLoop / aiChat（ai.ts 剩余段）消费。
 * 红线（三红线之一，不可回退）：executeCommandsOnDevice 开头的最后一道防线注释块 +
 * getCommandWhitelist() + isCommandAllowed 判定链逐字在场（见函数体）。
 * MK 形态：模块级 let MK + setAiExecMasterKey 启动注入（getDeviceByIdInternal 解密十余 _enc 列、
 * loadAllGuardDevices 全库设备投影消费），由 ai.ts setAiMasterKey 链式调用（Shared Pattern 2）。
 */

import { Client } from 'ssh2'
import { decodeDeviceBuffer } from '../utils/textDecode'
import { getDatabase } from '../database/connection'
import { decField } from '../utils/crypto'
import { SSH_READY_TIMEOUT_MS, buildSSHConnectConfig } from '../utils/sshConfig'
import { executeTelnetCommand, pickDisablePaginationCmd, pickShellPrompt } from '../utils/telnetExec'
import { isCommandAllowed, tokenizeCommand } from './commandSafety'
import { checkCommand, type GuardHit, type GuardDeviceRef } from './privilegeGuard'
import { getCommandWhitelist } from './aiConfig'
import { AI_QONLY_EXEC_BAN } from './promptRegistry'
import { deriveCapabilities, getDeviceChannels, resolveExecChannel } from './device'

let MK = ''
export function setAiExecMasterKey(key: string) {
  MK = key
}

// ---------- SSH execution (shell mode) ----------

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
}

// （已移除交互式 shell 的 prompt 检测/输出提取函数）
// 命令执行改为 client.exec 非交互模式，不再需要 isPromptLine / detectPrompt / extractCommandOutput。
//
// WR-03：telnet 关分页命令 (pickDisablePaginationCmd) 与 shellPrompt (pickShellPrompt) 已抽到
// electron/utils/telnetExec.ts 共用——ai.ts telnet 分流 与 arpCollector collectFromDevice 同 util，
// 关分页/精确 prompt 统一来源（导入见顶部 import），避免两处实现漂移。

// SSH 配置构造已收敛 utils/sshConfig.ts buildSSHConnectConfig

export function executeCommandsOnDevice(
  device: any,
  commands: string[],
  opts?: { guardApproved?: boolean; conversationSet?: GuardDeviceRef[] }
): Promise<Array<{ command: string; output: string; success: boolean }>> {
  if (commands.length === 0) return Promise.resolve([])

  // 执行层强制安全校验（最后一道防线）：不依赖调用方（chat/confirmCommand/auto）是否已校验，
  // 任何未经 isCommandAllowed 通过的命令在此直接拒绝，杜绝新增入口漏检。
  const whitelist = getCommandWhitelist()
  // Phase 27（T-27-08/Pitfall 4）：privilegeGuard 兜底重检——新增执行入口漏检防线。
  // guardApproved=true 仅由 confirmCommand 用户确认后置位传递（防无限弹窗）；无标记且命中 → 拒绝执行。
  const guardApproved = opts?.guardApproved === true
  const guardConversationSet: GuardDeviceRef[] = opts?.conversationSet ?? [toGuardRef(device)]
  const allGuardDevices = guardApproved ? [] : loadAllGuardDevices()
  const checked = commands.map((cmd) => {
    const safety = isCommandAllowed(cmd, whitelist)
    if (!safety.allowed) return { cmd, allowed: false, reason: safety.reason }
    if (guardApproved) return { cmd, allowed: true, reason: '' }
    const tokens = tokenizeCommand(cmd)
    const hits = checkCommand({
      firstWord: tokens[0] ?? '',
      tokens,
      currentDevice: toGuardRef(device),
      conversationSet: guardConversationSet,
      allDevices: allGuardDevices,
    })
    if (hits.length > 0) {
      return { cmd, allowed: false, reason: `越权防线拦截: ${hits.map((h) => h.explanation).join('；')}` }
    }
    return { cmd, allowed: true, reason: '' }
  })

  // connectionType 分流：ssh（含默认）走 buildSSHConfig + client.exec + execOne（密钥/密码、stream silence/retry/H3C 粘连全保留）；
  // telnet 走 executeTelnetCommand（共用 util，telnet-client connect loginPrompt/PasswordPrompt/shellPrompt + exec + gbk + ANSI + 超时兜底）。
  // 安全层 checked 数组两路径共用，无新增注入面。
  const isTelnet = String(device.connectionType || '').toLowerCase() === 'telnet'
  // telnet 长输出（display current-configuration 等）默认 ---- More ---- 分页，telnet-client exec 不自动翻页会截断第一屏。
  // exec 真命令前先发关闭分页命令（按 vendor 选），由 executeTelnetCommand 内部 connect 后发出。
  const paginationCmd = isTelnet ? pickDisablePaginationCmd(device.vendor) : undefined
  const shellPrompt = isTelnet ? pickShellPrompt(device.vendor) : undefined

  // SSH-only config（telnet 路径不用）
  const cfg = buildSSHConnectConfig(device)
  const overallTimeout = 30000 + checked.length * (SSH_READY_TIMEOUT_MS + 15000)

  // runOne：按 connectionType 分流单命令执行。
  // SSH 路径：单命令独立连接 —— new Client → connect → ready 后 execOne → end 回收。
  // Telnet 路径：每命令独立 Telnet 实例（executeTelnetCommand 内 connect+exec+cleanup），与 SSH「每命令独立连接」同构。
  // 返回该命令结果；连接失败/超时抛出由调用方决定（首条抛出 → reject 整批；后续抛出 → 填充 success:false 不中断）。
  const runOne = (idx: number): Promise<{ command: string; output: string; success: boolean }> => {
    return new Promise((resolve, reject) => {
      const { cmd, allowed, reason } = checked[idx]
      if (!allowed) {
        resolve({ command: cmd, output: `命令被安全策略拒绝: ${reason}`, success: false })
        return
      }

      // ---- Telnet 分流：复用共用 util，输出 gbk 解码 + ANSI 剥离（与 SSH 路径 execOne 内 decodeDeviceBuffer + stripAnsi 对齐） ----
      if (isTelnet) {
        const tport = device.port || 23
        // WR-02：telnet 单命令用「单命令预算」而非整批 overallTimeout。
        // overallTimeout 是整批累计（30s + N*(ready+15)），telnet util 内部 connect+exec 共用单一 timeout
        // 无 per-command 早触发，N=5 时 overallTimeout≈180s，单命令挂起会卡死整批。
        // 改传与 SSH 单命令对齐的预算（30s ready + 15s exec silence/兜底），慢设备超时早触发。
        const perCmdTimeout = 30000 + SSH_READY_TIMEOUT_MS + 15000
        executeTelnetCommand(
          device.ipAddress, tport,
          device.username || '', device.password || '',
          cmd,
          { timeout: perCmdTimeout, decodeGbk: true, stripAnsi: true, disablePaginationCmd: paginationCmd, shellPrompt }
        ).then((output) => {
          resolve({ command: cmd, output: output.trim(), success: true })
        }).catch((err: any) => {
          // telnet 连接/执行失败：抛出由外层决定（首条 reject 整批，后续填 success:false）—— 与 SSH 路径 client.on('error') 同语义
          reject(err instanceof Error ? err : new Error(String(err)))
        })
        return
      }

      // ---- SSH 路径（默认） ----
      const client = new Client()
      let settled = false
      let perCmdTimer: NodeJS.Timeout | undefined

      const cleanup = (): void => {
        if (perCmdTimer) { clearTimeout(perCmdTimer); perCmdTimer = undefined }
        // client.end() 优雅发 EOF；已 end/destroy 后再 end 可能抛，幂等忽略（与 Phase 6 cleanup 同构）
        try { client.end() } catch { /* ignore */ }
      }
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }

      // 单命令兜底超时 = readyTimeout + exec silence/timeout 余量
      perCmdTimer = setTimeout(() => {
        finish(() => {
          try { client.destroy() } catch { /* ignore */ }
          reject(new Error(`命令执行超时 (${cmd}, ${Math.round(overallTimeout / 1000)}s)`))
        })
      }, overallTimeout)

      try {
        client.on('ready', async () => {
          try {
            const output = await execOne(client, cmd)
            finish(() => resolve({ command: cmd, output, success: true }))
          } catch (err: any) {
            // execOne 失败（stream timeout/error 等）：按索引填 success:false，不 reject 整批（保结果同长）
            finish(() => resolve({ command: cmd, output: `执行失败: ${err.message}`, success: false }))
          }
        })
        client.on('error', (err) => {
          // 连接失败抛出 —— 首条命令触发外层 reject（语义同旧 ready 不达 → 设备不可达 → discovery 跳过）
          finish(() => reject(err))
        })
        client.connect(cfg)
      } catch (err) {
        // 同步异常兜底（client.connect 同步抛等罕见场景）
        finish(() => reject(err))
      }
    })
  }

  return (async () => {
    const results: Array<{ command: string; output: string; success: boolean }> = new Array(checked.length)
    for (let i = 0; i < checked.length; i++) {
      try {
        results[i] = await runOne(i)
      } catch (err: any) {
        // 首条命令连接失败 → reject 整批（与旧实现 client.on('error') reject 同语义，调用方按连接失败处理）
        if (i === 0) throw err
        // 后续命令连接失败：填充 success:false（设备中途抖动），保持结果数组同长同序
        results[i] = { command: checked[i].cmd, output: `执行失败: ${err.message}`, success: false }
      }
    }
    return results
  })()
}

// 单命令非交互执行（client.exec）：不分配 PTY，设备不触发分页，
// 天然杜绝交互式 shell 的换行/分号注入与 prompt 误判。
function execOne(client: Client, command: string, perCmdTimeoutMs = 15000, silenceMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stream: any
    let timer: NodeJS.Timeout | undefined
    let silenceTimer: NodeJS.Timeout | undefined
    let settled = false
    let retried = false
    let buf = ''
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = undefined }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = undefined }
      fn()
    }
    // A: 静默检测——设备输出完不 close channel（H3C display version 行为）时，data 静默 silenceMs 后
    // 主动 resolve + close，快速释放 channel 避免后续命令撞 MaxSessions（比 perCmdTimeout 更早触发）。
    const triggerSilence = (): void => {
      if (silenceTimer) clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => {
        finish(() => {
          try { stream?.close() } catch { /* ignore */ }
          resolve(stripAnsi(buf).trim())
        })
      }, silenceMs)
    }
    // per-command 兜底：极端情况（持续有 data 但永不静默 + 不 close）的最终超时
    timer = setTimeout(() => {
      finish(() => {
        try { stream?.close() } catch { /* ignore */ }
        try { stream?.destroy() } catch { /* ignore */ }
        reject(new Error(`命令执行无响应 (${perCmdTimeoutMs}ms 未收到 stream close)`))
      })
    }, perCmdTimeoutMs)
    const doExec = (): void => {
      client.exec(command, (err, s) => {
        if (err) {
          // C: channel open failure 重试一次（前序 channel session 释放延迟致 open 被拒）
          if (/channel open failure|open failed/i.test(err.message) && !retried) {
            retried = true
            setTimeout(doExec, 500)
            return
          }
          finish(() => reject(err))
          return
        }
        stream = s
        s.on('data', (data: Buffer) => { buf += decodeDeviceBuffer(data); triggerSilence() })
        const stderr = (s as any).stderr
        if (stderr && typeof stderr.on === 'function') {
          stderr.on('data', () => { /* 忽略 stderr */ })
        }
        // CR-01: stream error 兜底——对端 RST / 网络中断 / ssh2 channel 失败时 stream emit 'error'
        s.on('error', (e: Error) => {
          finish(() => reject(e))
        })
        s.on('close', () => {
          finish(() => resolve(stripAnsi(buf).trim()))
        })
        triggerSilence() // 启动初始静默计时（无 data 也计时，避免空输出卡满 timeout）
      })
    }
    doExec()
  })
}

// ---------- Device query helper ----------

// ---------- Phase 23（23-03，D-03/D-04）：设备能力边界 ----------

/**
 * D-04 [CMD] 白名单判定（fail-closed）：仅 SSH/Telnet 通道设备可执行命令。
 * capabilities 缺失/undefined 一律按不可执行处理（照 parseMcpToolCalls unknown 校验哲学）。
 */
export function isDeviceExecutable(device: any): boolean {
  return device?.capabilities?.hasSSH === true || device?.capabilities?.hasTelnet === true
}

/**
 * 29.1 CR MD-03：hasMcp 设备的 MCP 工具可用性判定（感知包禁用/配置停用态）。
 * 复用 buildMcpContexts 同款 SQL 字段面（enabled + pkgDisabled）单查；查询异常/无绑定
 * → false（fail-closed：宁可误报「不可用」也不注入指向不存在工具清单的矛盾声明——
 * buildMcpContexts 出错时同样跳过该设备，两处降级方向一致）。
 * 手工 stdio/http 配置（package_id NULL → LEFT JOIN pkgDisabled NULL）按可用（true），
 * 维持 29.1-06 第二组语义不回退。
 */
export function isDeviceMcpUsable(dev: any): boolean {
  try {
    const rel = getDatabase()
      .prepare(
        `SELECT c.enabled AS enabled, p.disabled AS pkgDisabled
         FROM mcp_device_rel r
         JOIN mcp_configs c ON c.id = r.mcp_config_id
         LEFT JOIN mcp_packages p ON p.id = c.package_id
         WHERE r.device_id = ?`
      )
      .get(String(dev?.id ?? '')) as { enabled: number; pkgDisabled: number | null } | undefined
    return !!rel && !!rel.enabled && !rel.pkgDisabled
  } catch {
    return false
  }
}

/**
 * 29.1-06（UAT 缺陷修复）+ 29.1 CR MD-03：能力边界注入四组语义（Phase 23 D-03/D-05
 * fail-closed 不回退）。
 *
 * 缺陷现场（29.1-06）：MCP-only 设备（无 SSH/Telnet、仅绑 MCP 包）此前落入 qOnlyDevices →
 * 注入「无命令执行通道（仅可问答）」+ AI_QONLY_EXEC_BAN 硬区禁令，与同轮注入的 MCP 工具
 * 清单自相矛盾 → 模型服从禁令拒用 MCP 工具。
 * 反向复发（MD-03）：hasMcp 不感知包禁用态——绑禁用包的设备仍被注入「操作经 MCP 工具完成
 * （见下方 MCP 工具清单）」而 buildMcpContexts 因 pkgDisabled 跳过该设备（清单为空）。
 *
 * 四组分组（isDeviceExecutable 本身不动——它是 [CMD] 执行通道语义，MCP 设备确实不能执行 [CMD]）：
 * ① 可执行（hasSSH/hasTelnet）：不注入（提示词干净，现状不变）；
 * ② MCP-only 可用（不可执行、hasMcp=true 且绑定包/配置可用）：中性能力说明——无 SSH/Telnet
 *    命令通道、不可输出 [CMD] 标记、查询与操作经绑定 MCP 工具完成；**不进「仅问答」名单、
 *    不拼 AI_QONLY_EXEC_BAN**（措辞不出现「仅可问答/不可执行」，与 MCP 工具清单注入配套）；
 * ③ MCP-only 不可用（MD-03 第四组）：包被禁用/配置停用 → 中性「MCP 工具当前不可用」表述，
 *    不承诺工具清单；此时该设备真零通道，[CMD] 禁令照注入（fail-closed）；
 * ④ 仅问答（不可执行且无 hasMcp）：保持 Phase 23 原注入（D-03 能力声明 + AI_QONLY_EXEC_BAN
 *    硬区禁令），真·无通道设备 fail-closed 语义不回退。
 *
 * isMcpUsable 参数：默认走 isDeviceMcpUsable（DB 单查）；纯函数单测可注入替身。
 */
export function buildCapabilityBoundary(
  targetDevices: any[],
  isMcpUsable: (dev: any) => boolean = isDeviceMcpUsable
): string {
  const mcpOnlyDevices = targetDevices.filter(
    (d) => !isDeviceExecutable(d) && d?.capabilities?.hasMcp === true
  )
  const mcpUsableDevices = mcpOnlyDevices.filter((d) => isMcpUsable(d))
  const mcpUnavailableDevices = mcpOnlyDevices.filter((d) => !isMcpUsable(d))
  const qOnlyDevices = targetDevices.filter(
    (d) => !isDeviceExecutable(d) && d?.capabilities?.hasMcp !== true
  )
  let injection = ''
  if (mcpUsableDevices.length > 0) {
    if (targetDevices.length === 1) {
      injection +=
        '\n\n能力说明：该设备无 SSH/Telnet 命令通道，不可对其输出 [CMD] 命令标记；该设备的查询与操作通过其绑定的 MCP 工具完成（见下方 MCP 工具清单）。'
    } else {
      const mNames = mcpUsableDevices.map((d) => String(d.name)).join('、')
      injection +=
        `\n\n能力说明：以下设备无 SSH/Telnet 命令通道，不可对其输出 [CMD] 命令标记，其查询与操作通过各自绑定的 MCP 工具完成（见下方 MCP 工具清单）：${mNames}。`
    }
  }
  if (mcpUnavailableDevices.length > 0) {
    const uNames = mcpUnavailableDevices.map((d) => String(d.name)).join('、')
    if (targetDevices.length === 1) {
      injection +=
        '\n\n能力说明：该设备当前无可用命令执行通道（无 SSH/Telnet，绑定的 MCP 工具因包被禁用/配置停用暂不可用），不可对其输出 [CMD] 命令标记；恢复对应 MCP 包/配置前仅可基于关联知识库/经验作答。\n' +
        AI_QONLY_EXEC_BAN
    } else {
      injection +=
        `\n\n能力说明：以下设备当前无可用命令执行通道（无 SSH/Telnet，绑定的 MCP 工具因包被禁用/配置停用暂不可用）：${uNames}。不可对这些设备输出 [CMD] 命令标记；恢复 MCP 包/配置前仅可基于关联知识库/经验作答，请在回复中主动说明已跳过它们（点名设备名）。\n` +
        AI_QONLY_EXEC_BAN
    }
  }
  if (qOnlyDevices.length > 0) {
    const qNames = qOnlyDevices.map((d) => String(d.name)).join('、')
    if (targetDevices.length === 1) {
      injection +=
        '\n\n能力说明：该设备无命令执行通道（仅可基于关联知识库/经验作答，不可执行命令）。\n' +
        AI_QONLY_EXEC_BAN
    } else {
      injection +=
        `\n\n能力说明：以下设备无命令执行通道（仅可问答，不可执行命令）：${qNames}。命令只可作用于其余有执行通道的设备；若用户请求涉及这些仅问答设备，请在回复中主动说明已跳过它们（点名设备名），不要对其输出 [CMD] 标记。\n` +
        AI_QONLY_EXEC_BAN
    }
  }
  return injection
}

/**
 * 29.1-06 + MD-03：[CMD] 拒绝原因文案（MCP-aware）——目标设备无 SSH/Telnet 但绑定 MCP
 * 且工具可用时指向 MCP 工具（消除「仅可问答」与 MCP 工具清单的矛盾声明）；绑定 MCP 但
 * 包禁用/配置停用时指明工具当前不可用（不指向不存在的清单）；真·无通道设备（含
 * capabilities 缺失）保持 Phase 23 原文案（fail-closed 不回退）。qOnlyTail 为仅问答
 * 分支的既有尾缀。isMcpUsable 同 buildCapabilityBoundary 注入口。
 */
export function cmdChannelRejectReason(dev: any, qOnlyTail = '', isMcpUsable: (dev: any) => boolean = isDeviceMcpUsable): string {
  if (dev?.capabilities?.hasMcp === true) {
    if (isMcpUsable(dev)) {
      return '该设备无 SSH/Telnet 命令通道（[CMD] 未执行；该设备操作请通过 MCP 工具完成）'
    }
    return '该设备无 SSH/Telnet 命令通道（[CMD] 未执行；绑定的 MCP 工具当前不可用：包被禁用/配置停用）'
  }
  return `该设备无命令执行通道（仅可问答）${qOnlyTail}`
}

export function getDeviceByIdInternal(id: string): any {
  const row = getDatabase()
    .prepare(
      `SELECT d.*, (r.device_id IS NOT NULL) AS has_mcp
       FROM devices d LEFT JOIN mcp_device_rel r ON r.device_id = d.id
       WHERE d.id = ?`
    )
    .get(id) as any
  if (!row) return null
  // Phase 36（36-03，D-10）：凭证六列读取删除（D-08 已清列）——经 device.ts 子表投影解析
  // 有效命令通道（默认 ssh/telnet 用之；web/rdp 默认回退已配 SSH > Telnet）后平铺该通道
  // 凭证到既有字段名（Pattern 1 平铺投影，executeCommandsOnDevice / buildSSHConnectConfig /
  // executeTelnetCommand 消费链零改动）；无命令行通道 → 凭证空值 + connectionType 保持
  // 原 connection_type（capabilities 全 false，isDeviceExecutable fail-closed 既有行为）。
  const channels = getDeviceChannels(id)
  const channelNames = channels.map((c) => c.channel)
  const execChannel = resolveExecChannel(row.connection_type ?? null, channelNames)
  const ch = execChannel !== null ? channels.find((c) => c.channel === execChannel) : undefined
  return {
    id: row.id,
    name: decField(row.name_enc, MK),
    vendor: decField(row.vendor_enc, MK),
    model: decField(row.model_enc, MK),
    version: decField(row.version_enc, MK),
    ipAddress: decField(row.ip_enc, MK),
    // H-4：补 deviceType 投影（与 device.ts rowToDevice 同语义兜底）——修复 discovery.ts
    // `dev?.deviceType` 恒 undefined 导致节点图标/EditNodeModal 预填/nodes JSON 落库错型。
    deviceType: row.device_type || 'generic',
    connectionType: execChannel ?? row.connection_type,
    port: ch?.port ?? null,
    username: ch?.username ?? '',
    password: ch?.password ?? '',
    sshKeyPath: ch?.sshKeyPath ?? '',
    sshKeyContent: ch?.sshKeyContent ?? '',
    webUrl: ch?.webUrl ?? '',
    // Phase 23（23-03）→ Phase 36（36-03 收口）：能力三布尔按子表通道集合派生（D-05，
    // 第二参数必传——device.ts deriveCapabilities 单源派生；缺失按不可执行 fail-closed）
    capabilities: deriveCapabilities(row, channelNames),
  }
}

// ---------- Phase 27（GUARD-01~03）：越权检测接线辅助 ----------
// privilegeGuard 纯函数不读 DB（Pitfall 7），设备投影（含明文 IP）由本层注入。

/** 设备投影 → GuardDeviceRef（id/name/ipAddress 三字段，privilegeGuard 契约） */
export function toGuardRef(dev: any): GuardDeviceRef {
  return { id: String(dev.id ?? ''), name: String(dev.name ?? ''), ipAddress: String(dev.ipAddress ?? '') }
}

/** 全库设备投影（Pitfall 7：文案区分「库内未选」vs「库外陌生」；单查一次，量级可接受） */
export function loadAllGuardDevices(): GuardDeviceRef[] {
  try {
    const rows = getDatabase().prepare('SELECT id, name_enc, ip_enc FROM devices').all() as any[]
    return rows.map((r) => ({
      id: String(r.id),
      name: decField(r.name_enc, MK),
      ipAddress: decField(r.ip_enc, MK),
    }))
  } catch {
    return [] // 降级：缺列/异常时按无全库上下文判定（检测层自身仍 fail-closed）
  }
}

/** 命令文本越权检测（chat 主插入点 / executeCommandsOnDevice 兜底共用） */
export function guardCheckCommand(cmd: string, currentDevice: any, conversationSet: GuardDeviceRef[]): GuardHit[] {
  const tokens = tokenizeCommand(cmd)
  return checkCommand({
    firstWord: tokens[0] ?? '',
    tokens,
    currentDevice: toGuardRef(currentDevice),
    conversationSet,
    allDevices: loadAllGuardDevices(),
  })
}
