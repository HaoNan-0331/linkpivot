import { v4 as uuidv4 } from 'uuid'
import { getAiConfig, callAI, getDeviceByIdInternal, executeCommandsOnDevice } from './ai'
import { getCommandWhitelist } from './ai'
import { isDeviceExecutable } from './aiExec'
import { isCommandAllowed } from './commandSafety'
import { createSystemLog } from './systemLog'
import { PromptService } from './promptService'

/**
 * discovery 模块局部非致命日志 helper（D-6-4）。
 * DB 写库失败时 console.warn 兜底（可观测，非纯静默，遵循 Phase 3 D-P4 可观测性原则），
 * 不中断发现主流程（SC#3）。局限于 discovery.ts，不跨模块（跨模块统一 safeLog defer）。
 */
function safeLog(entry: Parameters<typeof createSystemLog>[0]): string | undefined {
  try {
    return createSystemLog(entry)
  } catch (e: any) {
    console.warn('[safeLog] discovery 日志写库失败', e?.message)
    return undefined
  }
}

/**
 * 包装 JSON.parse 失败为带原始片段的 enriched Error（D-6-3，SC#2）。
 * SyntaxError 自带 position（"Unexpected token ... in JSON at position N"），
 * 但不含原始内容——补 slice(0,200) 让运维定位 AI 漂移/截断/转义错误。
 * 局限于 discovery.ts（两处 parse 同模式去重）。
 */
function enrichParseError(prefix: string, raw: string, err: unknown): Error {
  const errMessage = err instanceof Error ? err.message : String(err)
  return new Error(`${prefix}: ${errMessage} | 原始片段: ${(raw || '').slice(0, 200)}`)
}

export interface DiscoveryFailedDevice {
  deviceId: string
  deviceName: string
  error: string
}

export interface DiscoveryResult {
  nodes: any[]
  edges: any[]
  failedDevices: DiscoveryFailedDevice[]
}

// Mutex: prevent concurrent discovery
let discoveryInProgress = false

export async function discoverTopology(deviceIds: string[]): Promise<DiscoveryResult> {
  if (discoveryInProgress) throw new Error('已有发现任务在执行中，请等待完成')
  discoveryInProgress = true

  try {
    return await discoverTopologyInner(deviceIds)
  } finally {
    discoveryInProgress = false
  }
}

async function discoverTopologyInner(deviceIds: string[]): Promise<DiscoveryResult> {
  const config = getAiConfig()
  if (!config?.apiKey) throw new Error('请先配置 AI 服务')
  const whitelist = getCommandWhitelist()

  const collectedData: Array<{
    deviceId: string
    deviceName: string
    vendor: string
    outputs: Record<string, string>
  }> = []
  const failedDevices: DiscoveryFailedDevice[] = []

  // Phase 1: Collect device info
  const deviceInfos: Array<{ deviceId: string; deviceName: string; vendor: string; model: string; version: string; ipAddress: string }> = []
  for (const deviceId of deviceIds) {
    const device = getDeviceByIdInternal(deviceId)
    if (!device) {
      failedDevices.push({ deviceId, deviceName: '未知', error: '设备不存在' })
      continue
    }
    // Phase 36（36-03，D-10 适配）：排除判定 connectionType === 'web' → isDeviceExecutable
    // capabilities 判定——多通道下 web/rdp 默认但配了 ssh/telnet 的设备可采集（经
    // getDeviceByIdInternal D-10 投影自动带有效命令通道）；零命令行通道设备 fail-closed 跳过。
    if (!isDeviceExecutable(device)) {
      failedDevices.push({ deviceId, deviceName: device.name, error: '无 SSH/Telnet 命令通道，不支持采集' })
      continue
    }
    deviceInfos.push({
      deviceId: device.id,
      deviceName: device.name,
      vendor: device.vendor || '未知',
      model: device.model || '未知',
      version: device.version || '未知',
      ipAddress: device.ipAddress || '',
    })
  }

  if (deviceInfos.length === 0) {
    return { nodes: [], edges: [], failedDevices }
  }

  // Phase 2: Ask AI which commands to execute for each device
  // Phase 20 PMT-01：prompt 收敛到 promptRegistry（用户可 override），文案与收敛前逐字一致
  const commandPrompt = PromptService.getPrompt('discovery.vendor')

  const deviceListText = deviceInfos.map(d =>
    `- 设备名: ${d.deviceName}, ID: ${d.deviceId}, 厂商: ${d.vendor}, 型号: ${d.model}, 版本: ${d.version}, IP: ${d.ipAddress}`
  ).join('\n')

  const commandMessages = [
    { role: 'system', content: commandPrompt },
    { role: 'user', content: `以下是需要发现的设备：\n${deviceListText}` },
  ]

  const commandPromptText = JSON.stringify(commandMessages, null, 2)
  const deviceIdsStr = deviceIds.join(',')
  const deviceNamesStr = deviceInfos.map(d => d.deviceName).join(',')

  let commandAiResponse: string
  try {
    commandAiResponse = await callAI(config, commandMessages)
  } catch (err: any) {
    safeLog({
      type: 'discovery', status: 'failed',
      deviceIds: deviceIdsStr, deviceNames: deviceNamesStr,
      promptText: commandPromptText,
      errorMessage: `AI 命令生成失败: ${err.message}`,
    })
    throw err
  }

  // Log first AI call
  safeLog({
    type: 'discovery', status: 'success',
    deviceIds: deviceIdsStr, deviceNames: deviceNamesStr,
    promptText: commandPromptText,
    aiResponse: commandAiResponse,
    parsedResult: `阶段1: AI命令生成`,
  })

  // Parse AI response for commands
  let deviceCommands: Array<{ deviceId: string; deviceName: string; vendor: string; commands: string[] }>
  const commandRaw = commandAiResponse
  try {
    let jsonStr = commandAiResponse.trim()
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim()
    const parsed = JSON.parse(jsonStr)
    deviceCommands = parsed.devices || []
  } catch (err: any) {
    // D-6-3：补 safeLog 与 topology parse 对齐（两处 parse 失败均落审计日志，运维可追溯）
    // WR-02: 复用 enriched.message，杜绝 safeLog 落库与抛出错误 message 双源不一致
    const enriched = enrichParseError('AI 命令结果解析失败', commandRaw, err)
    safeLog({
      type: 'discovery', status: 'failed',
      deviceIds: deviceIdsStr, deviceNames: deviceNamesStr,
      promptText: commandPromptText,
      aiResponse: commandRaw,
      errorMessage: enriched.message,
    })
    throw enriched
  }

  // Phase 3: Execute commands on each device
  for (const dc of deviceCommands) {
    const device = getDeviceByIdInternal(dc.deviceId)
    if (!device) {
      failedDevices.push({ deviceId: dc.deviceId, deviceName: dc.deviceName, error: '设备不存在' })
      continue
    }

    const outputs: Record<string, string> = {}
    // Phase 18 D-02（16-QUIRKS Q5 裁决「修」）：结构化成功信号，与 outputs 平行记录。
    // 供 hasValidOutput 判定（替代字符串前缀判定，防「输出本身以『执行失败』开头的成功命令」被误判）；
    // outputs 字符串赋值语义不变（AI 分析文本 + failedDevices 聚合消费，Pitfall 8）。
    const cmdSuccess: Record<string, boolean> = {}
    const safeCommands = dc.commands.filter(cmd => {
      const safety = isCommandAllowed(cmd, whitelist)
      if (!safety.allowed) {
        outputs[cmd] = `命令被安全策略拒绝: ${safety.reason}`
        return false
      }
      return true
    })

    if (safeCommands.length > 0) {
      try {
        const results = await executeCommandsOnDevice(device, safeCommands)
        for (const r of results) {
          outputs[r.command] = r.success ? r.output : `执行失败: ${r.output}`
          cmdSuccess[r.command] = r.success
        }
        // Phase 3 日志：每设备命令执行结果（成功摘要 / 失败原因），运维可追溯 channel failure 等
        const summary = results.map(r =>
          `${r.command}: ${r.success ? `OK(${r.output.length} chars)` : `FAIL(${r.output.slice(0, 80)})`}`
        ).join(' | ')
        safeLog({
          type: 'discovery', status: 'success',
          deviceIds: dc.deviceId, deviceNames: dc.deviceName,
          promptText: `阶段3: 命令执行 (${safeCommands.join(', ')})`,
          parsedResult: summary,
        })
      } catch (err: any) {
        // Connection failed entirely — skip this device
        safeLog({
          type: 'discovery', status: 'failed',
          deviceIds: dc.deviceId, deviceNames: dc.deviceName,
          errorMessage: `连接失败: ${err.message}`,
        })
        failedDevices.push({ deviceId: dc.deviceId, deviceName: dc.deviceName, error: `连接失败: ${err.message}` })
        continue
      }
    }

    // Check if device has any valid output
    // Phase 18 D-02：结构化信号判定——executeCommandsOnDevice 返回的 r.success 单布尔
    // 同时覆盖「命令被安全策略拒绝」与「执行失败」两路径（ai.ts :356/:414/:438），
    // 替代原字符串前缀判定（16-QUIRKS Q5：合法输出恰以「执行失败」开头曾被误判为全失败）。
    const hasValidOutput = Object.values(cmdSuccess).some(s => s === true)
    if (hasValidOutput) {
      collectedData.push({ deviceId: dc.deviceId, deviceName: dc.deviceName, vendor: dc.vendor, outputs })
    } else {
      failedDevices.push({ deviceId: dc.deviceId, deviceName: dc.deviceName, error: '所有命令执行失败，无有效输出' })
    }
  }

  if (collectedData.length === 0) {
    return { nodes: [], edges: [], failedDevices }
  }

  // Phase 4: Send results to AI for topology analysis
  const collectionText = collectedData
    .map((d) => {
      const outputsText = Object.entries(d.outputs)
        .map(([cmd, out]) => `--- ${cmd} ---\n${out}`)
        .join('\n\n')
      return `设备: ${d.deviceName} (ID: ${d.deviceId}, 厂商: ${d.vendor})\n${outputsText}`
    })
    .join('\n\n==========\n\n')

  // Phase 20 PMT-01：prompt 收敛到 promptRegistry（用户可 override），文案与收敛前逐字一致
  const topologyPrompt = PromptService.getPrompt('discovery.topology')

  const topologyMessages = [
    { role: 'system', content: topologyPrompt },
    { role: 'user', content: `以下是采集到的设备信息：\n\n${collectionText}` },
  ]

  const topologyPromptText = JSON.stringify(topologyMessages, null, 2)

  let aiResponse: string
  try {
    aiResponse = await callAI(config, topologyMessages)
  } catch (err: any) {
    safeLog({
      type: 'discovery', status: 'failed',
      deviceIds: deviceIdsStr, deviceNames: deviceNamesStr,
      promptText: topologyPromptText,
      errorMessage: `AI 拓扑分析失败: ${err.message}`,
    })
    throw err
  }

  // Parse topology result
  let parsed: any
  try {
    let jsonStr = aiResponse.trim()
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim()
    parsed = JSON.parse(jsonStr)

    // Log second AI call - topology analysis
    safeLog({
      type: 'discovery', status: 'success',
      deviceIds: deviceIdsStr, deviceNames: deviceNamesStr,
      promptText: topologyPromptText,
      aiResponse,
      parsedResult: JSON.stringify(parsed, null, 2),
    })
  } catch (err: any) {
    // D-6-3：errorMessage 补原始片段 slice(0,200)（现状仅 ${err.message}）
    // WR-02: 复用 enriched.message，杜绝 safeLog 落库与抛出错误 message 双源不一致
    const enriched = enrichParseError('AI 分析结果解析失败', aiResponse, err)
    safeLog({
      type: 'discovery', status: 'failed',
      deviceIds: deviceIdsStr, deviceNames: deviceNamesStr,
      promptText: topologyPromptText,
      aiResponse,
      errorMessage: enriched.message,
    })
    throw enriched
  }

  // Convert to topology format
  const nodes = (parsed.nodes || []).map((n: any) => {
    const dev = getDeviceByIdInternal(n.deviceId)
    return {
      id: n.deviceId,
      type: 'deviceNode',
      position: n.position || { x: Math.random() * 600 + 100, y: Math.random() * 400 + 100 },
      data: {
        deviceId: n.deviceId,
        deviceName: n.deviceName,
        deviceType: dev?.deviceType || 'generic',
        ipAddress: dev?.ipAddress || '',
        connectionType: dev?.connectionType || 'ssh',
      },
    }
  })

  const edges = (parsed.edges || []).map((e: any) => ({
    id: uuidv4(),
    source: e.sourceDeviceId,
    target: e.targetDeviceId,
    type: 'edgeWithInterfaces',
    data: {
      sourceInterface: e.sourceInterface || '',
      targetInterface: e.targetInterface || '',
    },
  }))

  return { nodes, edges, failedDevices }
}
