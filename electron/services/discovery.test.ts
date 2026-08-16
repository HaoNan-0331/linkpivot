import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * discovery 确定性基线 characterization（Phase 16 Plan 16-03 Task 1，TEST-03 后半 + D-12/D-13）。
 *
 * 【安全核心回归网（TEST-03/D-13）：isCommandAllowed 真实现，mock 掉即白测】
 * 本文件 vi.mock 范围仅 './ai'（LLM IO 边界）与 './systemLog'（DB 写边界）——
 * commandSafety 不 mock，真实纯函数加载，危险命令（reboot 类）/白名单外/分隔符注入
 * 三类安全红线场景走真 isCommandAllowed 判定（审计点名的 discovery.ts:192 调用点不再白测）。
 *
 * characterization 原则：断言现状语义含怪癖。hasValidOutput 字符串前缀判定怪癖
 * （16-QUIRKS.md Q5，Phase 18 裁决「修」）已由 D-02 修复：改 cmdSuccess 结构化信号，
 * 「执行结果分流」组 it 17 由怪癖基线改写为修复守卫（成功输出以「执行失败」开头不再误判）。
 *
 * Mock 骨架照 experienceRetrieval.test.ts:16-37 范式（vi.fn 转发 + beforeEach 复位）。
 */

const callAIMock = vi.fn()
const getAiConfigMock = vi.fn()
const getCommandWhitelistMock = vi.fn()
const getDeviceByIdInternalMock = vi.fn()
const executeCommandsOnDeviceMock = vi.fn()
vi.mock('./ai', () => ({
  callAI: (...args: any[]) => callAIMock(...args),
  getAiConfig: () => getAiConfigMock(),
  getCommandWhitelist: () => getCommandWhitelistMock(),
  getDeviceByIdInternal: (...args: any[]) => getDeviceByIdInternalMock(...args),
  executeCommandsOnDevice: (...args: any[]) => executeCommandsOnDeviceMock(...args),
}))

const createSystemLogMock = vi.fn()
vi.mock('./systemLog', () => ({
  createSystemLog: (...args: any[]) => createSystemLogMock(...args),
}))

// commandSafety 不 mock —— isCommandAllowed 真实现（D-13 红线，见文件头注释），
// 经 import { discoverTopology } from './discovery' 真实加载（discovery.ts 内 from './commandSafety' 纯函数，无 IO）
import { discoverTopology } from './discovery'

// ---- 测试数据（内联固定 JSON，与 discovery.ts 两处 parse 的 code-block 剥离 / 裸 JSON 形态对齐） ----

const makeDevice = (over: Record<string, unknown> = {}) => ({
  id: 'dev-1',
  name: 'SW-Core',
  vendor: 'huawei',
  model: 'S5735',
  version: 'V200R021',
  ipAddress: '10.0.0.1',
  connectionType: 'ssh',
  deviceType: 'switch',
  ...over,
})

const COMMANDS_JSON_RAW = JSON.stringify({
  devices: [
    { deviceId: 'dev-1', deviceName: 'SW-Core', vendor: '华为(Huawei)', commands: ['display version'] },
  ],
})

// ```json 代码块包裹 + 首尾多余文本（LLM 常见漂移形态，discovery.ts:163-167 剥离逻辑）
const COMMANDS_JSON_CODEBLOCK = `前置说明：
\`\`\`json
${COMMANDS_JSON_RAW}
\`\`\`
补充说明`

const TOPOLOGY_JSON = JSON.stringify({
  nodes: [
    { deviceId: 'dev-1', deviceName: 'SW-Core', position: { x: 250, y: 150 } },
    { deviceId: 'dev-x', deviceName: 'Ghost', position: { x: 400, y: 300 } },
  ],
  edges: [
    { sourceDeviceId: 'dev-1', targetDeviceId: 'dev-x', sourceInterface: 'GE0/0/1', targetInterface: '' },
  ],
})

const EXEC_OK = [{ command: 'display version', success: true, output: 'Huawei Versatile Routing Platform V200R021' }]

/** 默认 happy flow：config 有效 + 白名单受控 + dev-1 存在 + 两次 callAI 固定应答 + 执行成功 */
function setupHappyFlow() {
  getAiConfigMock.mockReturnValue({ apiKey: 'sk-test', baseUrl: 'http://mock', modelName: 'mock-model' })
  getCommandWhitelistMock.mockReturnValue(['display', 'show', 'ping'])
  getDeviceByIdInternalMock.mockImplementation((id: string) => (id === 'dev-1' ? makeDevice() : null))
  callAIMock.mockResolvedValueOnce(COMMANDS_JSON_RAW).mockResolvedValueOnce(TOPOLOGY_JSON)
  executeCommandsOnDeviceMock.mockResolvedValue(EXEC_OK)
}

/** 取第二次 callAI（阶段4 拓扑分析）的 user content —— outputs 经 collectionText 进 prompt，是观察内部 outputs 的唯一窗口 */
function phase4Prompt(): string {
  expect(callAIMock).toHaveBeenCalledTimes(2)
  const messages = callAIMock.mock.calls[1][1] as Array<{ role: string; content: string }>
  return messages[1].content
}

beforeEach(() => {
  // resetAllMocks 而非 clearAllMocks：mockResolvedValueOnce 队列必须清空——
  // 提前 return 的用例（设备不存在/Web 跳过/全失败）会残留未消费的 once 应答，
  // clearAllMocks 只清调用记录不清队列，污染后续用例的第一次 callAI（实跑踩坑）。
  vi.resetAllMocks()
  setupHappyFlow()
})

describe('前置分流', () => {
  it('1. getAiConfig 返 null → throw 请先配置 AI 服务（discovery.ts:60）', async () => {
    getAiConfigMock.mockReturnValue(null)
    await expect(discoverTopology(['dev-1'])).rejects.toThrow('请先配置 AI 服务')
    expect(callAIMock).not.toHaveBeenCalled()
  })
})

describe('阶段1：AI 命令生成与解析', () => {
  it('2. callAI 返 ```json 代码块包裹的 devices JSON → 剥离后正确 parse（discovery.ts:163-167）', async () => {
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(COMMANDS_JSON_CODEBLOCK).mockResolvedValueOnce(TOPOLOGY_JSON)
    const result = await discoverTopology(['dev-1'])
    expect(callAIMock).toHaveBeenCalledTimes(2)
    expect(executeCommandsOnDeviceMock).toHaveBeenCalledWith(makeDevice(), ['display version'])
    expect(result.nodes).toHaveLength(2)
    expect(result.failedDevices).toEqual([])
  })

  it('3. callAI 返裸 JSON → 同样 parse，全链路走通', async () => {
    const result = await discoverTopology(['dev-1'])
    expect(callAIMock).toHaveBeenCalledTimes(2)
    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toHaveLength(1)
  })

  it('4. callAI 返坏 JSON → throw enriched message 含「AI 命令结果解析失败」+「原始片段」+ 前 200 字 + safeLog failed 落库一次', async () => {
    const BAD_PREFIX = 'AI 漂移输出 {broken json '
    const badRaw = BAD_PREFIX + 'y'.repeat(300)
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(badRaw)
    const err = await discoverTopology(['dev-1']).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('AI 命令结果解析失败')
    expect(err.message).toContain('原始片段')
    // enrichParseError slice(0,200)：原始片段按字符截断，300 个 y 只保留 200-前缀长度 个（discovery.ts:27-30）
    expect(err.message.match(/y/g)).toHaveLength(200 - BAD_PREFIX.length)
    expect(callAIMock).toHaveBeenCalledTimes(1)
    expect(createSystemLogMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'discovery',
      status: 'failed',
      errorMessage: expect.stringContaining('AI 命令结果解析失败'),
    }))
  })

  it('5. callAI reject → throw 原错 + safeLog「AI 命令生成失败」', async () => {
    callAIMock.mockReset()
    callAIMock.mockRejectedValueOnce(new Error('LLM 网络异常'))
    await expect(discoverTopology(['dev-1'])).rejects.toThrow('LLM 网络异常')
    expect(createSystemLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('AI 命令生成失败'),
    }))
  })
})

describe('mutex 并发互斥（D-12）', () => {
  it('6. 执行中二次调用 → rejects 已有发现任务在执行中；完成后复位，第三次可正常执行（discovery.ts:48 + finally）', async () => {
    callAIMock.mockReset()
    let resolveFirst!: (v: string) => void
    callAIMock.mockReturnValueOnce(new Promise<string>((res) => { resolveFirst = res }))
      .mockResolvedValueOnce(TOPOLOGY_JSON)

    const first = discoverTopology(['dev-1'])
    await expect(discoverTopology(['dev-1'])).rejects.toThrow('已有发现任务在执行中，请等待完成')

    resolveFirst(COMMANDS_JSON_RAW)
    const firstResult = await first
    expect(firstResult.nodes).toHaveLength(2)

    // finally 复位佐证：mutex 释放后第三次调用不再 throw
    callAIMock.mockResolvedValueOnce(COMMANDS_JSON_RAW).mockResolvedValueOnce(TOPOLOGY_JSON)
    const third = await discoverTopology(['dev-1'])
    expect(third.nodes).toHaveLength(2)
  })
})

describe('旁路行为（D-12）', () => {
  it('7. getDeviceByIdInternal 返 null → failedDevices 含 {error:"设备不存在"} + deviceName 未知 + 全旁路提前返回空拓扑（discovery.ts:75-77/93-95）', async () => {
    getDeviceByIdInternalMock.mockReturnValue(null)
    const result = await discoverTopology(['dev-missing'])
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.failedDevices).toEqual([{ deviceId: 'dev-missing', deviceName: '未知', error: '设备不存在' }])
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('8. connectionType=web → failedDevices 含 {error:"Web设备不支持SSH采集"}（discovery.ts:79-81）', async () => {
    getDeviceByIdInternalMock.mockReturnValue(makeDevice({ connectionType: 'web' }))
    const result = await discoverTopology(['dev-1'])
    expect(result.failedDevices).toEqual([{ deviceId: 'dev-1', deviceName: 'SW-Core', error: 'Web设备不支持SSH采集' }])
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('9. 阶段3 deviceCommands 引用不存在的设备 → failedDevices 含 设备不存在 且不中断其余设备采集（discovery.ts:184-187）', async () => {
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      devices: [
        { deviceId: 'dev-1', deviceName: 'SW-Core', vendor: '华为(Huawei)', commands: ['display version'] },
        { deviceId: 'dev-ghost', deviceName: 'Ghost', vendor: 'x', commands: ['display version'] },
      ],
    })).mockResolvedValueOnce(TOPOLOGY_JSON)
    const result = await discoverTopology(['dev-1'])
    expect(result.failedDevices).toEqual([{ deviceId: 'dev-ghost', deviceName: 'Ghost', error: '设备不存在' }])
    expect(result.nodes).toHaveLength(2)
    expect(callAIMock).toHaveBeenCalledTimes(2)
  })
})

describe('命令安全（D-13：isCommandAllowed 真实现——安全红线场景单独入基线）', () => {
  it('10. reboot / rm -rf / / display version 三条混合 → 危险命令被绝对拦截、白名单内放行，executeCommandsOnDevice 仅收 safeCommands', async () => {
    getCommandWhitelistMock.mockReturnValue(['display', 'show'])
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      devices: [{ deviceId: 'dev-1', deviceName: 'SW-Core', vendor: 'x', commands: ['reboot', 'rm -rf /', 'display version'] }],
    })).mockResolvedValueOnce(TOPOLOGY_JSON)

    const result = await discoverTopology(['dev-1'])

    // 双向断言：被拒命令绝不出现在 executeCommandsOnDevice 入参（T-16-03-02）
    expect(executeCommandsOnDeviceMock).toHaveBeenCalledTimes(1)
    expect(executeCommandsOnDeviceMock.mock.calls[0][1]).toEqual(['display version'])

    // outputs[reboot] / outputs['rm -rf /'] 以「命令被安全策略拒绝」开头（discovery.ts:194）——
    // outputs 内部不可直接观察，经阶段4 collectionText 进第二次 callAI prompt 断言
    const prompt = phase4Prompt()
    expect(prompt).toContain('命令被安全策略拒绝: 禁止的变更命令: reboot')
    expect(prompt).toContain('命令被安全策略拒绝: 命令首词不在白名单中')
    // 白名单内命令真实输出进 prompt
    expect(prompt).toContain('Huawei Versatile Routing Platform V200R021')
    expect(result.nodes).toHaveLength(2)
  })

  it('11. 白名单外 clear arp → 拒绝，全拒后 failedDevices「所有命令执行失败」且 executeCommandsOnDevice 不被调', async () => {
    getCommandWhitelistMock.mockReturnValue(['display', 'show'])
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      devices: [{ deviceId: 'dev-1', deviceName: 'SW-Core', vendor: 'x', commands: ['clear arp'] }],
    }))
    const result = await discoverTopology(['dev-1'])
    expect(executeCommandsOnDeviceMock).not.toHaveBeenCalled()
    expect(result.failedDevices).toEqual([{ deviceId: 'dev-1', deviceName: 'SW-Core', error: '所有命令执行失败，无有效输出' }])
    // collectedData 空 → 阶段4 不触发（discovery.ts:239-241）
    expect(callAIMock).toHaveBeenCalledTimes(1)
    expect(result.nodes).toEqual([])
  })

  it('12. 分隔符注入 display version;reboot → 命令安全层分隔符拦截拒绝（commandSafety SEPARATOR_RE）', async () => {
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      devices: [{ deviceId: 'dev-1', deviceName: 'SW-Core', vendor: 'x', commands: ['display version;reboot', 'display version'] }],
    })).mockResolvedValueOnce(TOPOLOGY_JSON)
    const result = await discoverTopology(['dev-1'])
    // 注入命令被拒（拒绝原因进 outputs → prompt），干净命令照常执行
    expect(executeCommandsOnDeviceMock.mock.calls[0][1]).toEqual(['display version'])
    expect(phase4Prompt()).toContain('命令被安全策略拒绝: 命令包含非法分隔符（禁止多命令/注入）')
    expect(result.nodes).toHaveLength(2)
  })
})

describe('执行结果分流', () => {
  it('13. executeCommandsOnDevice resolve success:true → outputs[cmd]=原始输出（进阶段4 prompt）', async () => {
    const result = await discoverTopology(['dev-1'])
    expect(phase4Prompt()).toContain('Huawei Versatile Routing Platform V200R021')
    expect(result.failedDevices).toEqual([])
  })

  it('14. success:false → outputs[cmd] 以「执行失败: 」开头（discovery.ts:204），设备仍有效采集', async () => {
    executeCommandsOnDeviceMock.mockResolvedValue([
      { command: 'display version', success: true, output: 'GOOD-OUTPUT' },
      { command: 'display arp', success: false, output: 'Timeout retry' },
    ])
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      devices: [{ deviceId: 'dev-1', deviceName: 'SW-Core', vendor: 'x', commands: ['display version', 'display arp'] }],
    })).mockResolvedValueOnce(TOPOLOGY_JSON)
    const result = await discoverTopology(['dev-1'])
    const prompt = phase4Prompt()
    expect(prompt).toContain('执行失败: Timeout retry')
    expect(prompt).toContain('GOOD-OUTPUT')
    // 至少一条有效输出 → 设备采集成功，不进 failedDevices
    expect(result.failedDevices).toEqual([])
  })

  it('15. executeCommandsOnDevice reject → failedDevices 含「连接失败: 连接超时」且不中断后续设备（两设备场景第二台仍采集）', async () => {
    getDeviceByIdInternalMock.mockImplementation((id: string) =>
      id === 'dev-1' ? makeDevice() : id === 'dev-2' ? makeDevice({ id: 'dev-2', name: 'SW-Access', ipAddress: '10.0.0.2' }) : null)
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      devices: [
        { deviceId: 'dev-1', deviceName: 'SW-Core', vendor: 'x', commands: ['display version'] },
        { deviceId: 'dev-2', deviceName: 'SW-Access', vendor: 'x', commands: ['display version'] },
      ],
    })).mockResolvedValueOnce(TOPOLOGY_JSON)
    executeCommandsOnDeviceMock.mockImplementation((device: { id: string }) =>
      device.id === 'dev-1'
        ? Promise.reject(new Error('连接超时'))
        : Promise.resolve([{ command: 'display version', success: true, output: 'SW2-OUTPUT' }]))

    const result = await discoverTopology(['dev-1', 'dev-2'])
    expect(result.failedDevices).toEqual([{ deviceId: 'dev-1', deviceName: 'SW-Core', error: '连接失败: 连接超时' }])
    // 第二台设备不受牵连，采集成功 → 阶段4 正常运行
    expect(phase4Prompt()).toContain('SW2-OUTPUT')
    expect(result.nodes).toHaveLength(2)
    // 连接失败设备落审计日志（discovery.ts:218-222）
    expect(createSystemLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('连接失败: 连接超时'),
    }))
  })

  it('16. 全部 outputs 无效（唯一命令执行失败）→ failedDevices「所有命令执行失败，无有效输出」（discovery.ts:229-236）', async () => {
    executeCommandsOnDeviceMock.mockResolvedValue([{ command: 'display version', success: false, output: '命令超时' }])
    const result = await discoverTopology(['dev-1'])
    expect(result.failedDevices).toEqual([{ deviceId: 'dev-1', deviceName: 'SW-Core', error: '所有命令执行失败，无有效输出' }])
    expect(callAIMock).toHaveBeenCalledTimes(1)
    expect(result.nodes).toEqual([])
  })

  it('17. 【Phase 18 D-02 修复后】成功执行但输出本身以「执行失败」开头 → cmdSuccess 结构化信号判定有效采集，不再误判 failedDevices', async () => {
    // D-02（16-QUIRKS Q5 裁决「修」落地）：hasValidOutput 弃字符串前缀判定改
    // cmdSuccess[r.command] = r.success 结构化信号——设备真实输出恰好以「执行失败」开头
    // （如中文故障回显）且 success:true → 正常采集进阶段4，修复守卫防回归前缀判定。
    executeCommandsOnDeviceMock.mockResolvedValue([
      { command: 'display version', success: true, output: '执行失败: 这是合法设备输出但以执行失败开头' },
    ])
    const result = await discoverTopology(['dev-1'])
    expect(result.failedDevices).toEqual([])
    // 设备进 collectedData → 阶段4 拓扑分析触发（callAI 两次）+ 原始输出进 prompt
    expect(callAIMock).toHaveBeenCalledTimes(2)
    expect(phase4Prompt()).toContain('执行失败: 这是合法设备输出但以执行失败开头')
    expect(result.nodes).toHaveLength(2)
  })
})

describe('阶段4：拓扑分析与投影', () => {
  it('18. 拓扑 JSON 投影：node id/type/position/data.*（缺失设备 fallback generic）+ edge uuid/type/接口缺省 \'\'（discovery.ts:331-356）', async () => {
    const result = await discoverTopology(['dev-1'])

    // node[0]：dev-1 存在 → data 来自 getDeviceByIdInternal
    const n0 = result.nodes[0]
    expect(n0.id).toBe('dev-1')
    expect(n0.type).toBe('deviceNode')
    expect(n0.position).toEqual({ x: 250, y: 150 })
    expect(n0.data).toEqual({
      deviceId: 'dev-1',
      deviceName: 'SW-Core',
      deviceType: 'switch',
      ipAddress: '10.0.0.1',
      connectionType: 'ssh',
    })

    // node[1]：dev-x 不在设备库（getDeviceByIdInternal 返 null）→ fallback generic / '' / 'ssh'
    const n1 = result.nodes[1]
    expect(n1.data.deviceType).toBe('generic')
    expect(n1.data.ipAddress).toBe('')
    expect(n1.data.connectionType).toBe('ssh')

    const e0 = result.edges[0]
    expect(e0.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(e0.source).toBe('dev-1')
    expect(e0.target).toBe('dev-x')
    expect(e0.type).toBe('edgeWithInterfaces')
    expect(e0.data).toEqual({ sourceInterface: 'GE0/0/1', targetInterface: '' })
  })

  it('19. 阶段4 AI 未返 position → position 为随机对象（断言 x∈[100,700) y∈[100,500) 范围而非精确值，discovery.ts:336）', async () => {
    callAIMock.mockReset()
    callAIMock.mockResolvedValueOnce(COMMANDS_JSON_RAW).mockResolvedValueOnce(JSON.stringify({
      nodes: [{ deviceId: 'dev-1', deviceName: 'SW-Core' }],
      edges: [],
    }))
    const result = await discoverTopology(['dev-1'])
    expect(result.nodes).toHaveLength(1)
    const { x, y } = result.nodes[0].position
    expect(x).toBeGreaterThanOrEqual(100)
    expect(x).toBeLessThan(700)
    expect(y).toBeGreaterThanOrEqual(100)
    expect(y).toBeLessThan(500)
  })

  it('20. 阶段4 坏 JSON → throw「AI 分析结果解析失败」+ 原始片段 + safeLog failed', async () => {
    callAIMock.mockReset()
    const BAD_PREFIX = '拓扑分析输出 {broken '
    callAIMock.mockResolvedValueOnce(COMMANDS_JSON_RAW).mockResolvedValueOnce(BAD_PREFIX + 'z'.repeat(250))
    const err = await discoverTopology(['dev-1']).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('AI 分析结果解析失败')
    expect(err.message).toContain('原始片段')
    expect(err.message.match(/z/g)).toHaveLength(Math.min(200 - BAD_PREFIX.length, 250))
    expect(createSystemLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('AI 分析结果解析失败'),
    }))
  })
})
