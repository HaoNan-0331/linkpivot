import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'

/**
 * 真 AI 冒烟测试（Phase 16 Plan 16-03 Task 2，TEST-03 双轨之二 / D-11）。
 *
 * 跑法（默认 skip，零网络零花费——T-16-03-04）：
 *   NT_TEST_REAL_AI=1 NT_TEST_AI_API_KEY=sk-xxx NT_TEST_AI_BASE_URL=https://api.example.com/v1 \
 *     NT_TEST_AI_MODEL=xxx npm run test:electron
 *
 * 四 env 全齐才真跑：callAI 走真 fetch 调 LLM，executeCommandsOnDevice 走真 ssh2.Client
 * 连 mockSshServer（127.0.0.1 loopback）。松断言（D-11「只验链路走得通不崩溃」）：
 * 不要求具体拓扑形状——LLM 输出不确定，只断言三键齐全 + 数组类型。
 *
 * 断网容错（D-11「断网自动 skip」，T-16-03-05 防假绿）：
 *   catch 后按错误特征分流——仅网络类错误（EAI_AGAIN/ENOTFOUND/ETIMEDOUT/ECONNRESET/
 *   EHOSTUNREACH/ENETUNREACH/fetch failed/network timeout/timeout，大小写不敏感）warn 标注后
 *   视作通过（return 不 fail）；解析/逻辑/断言类错误一律 rethrow 让 it fail（链路真崩溃不能被吞）。
 *
 * 安全（T-16-03-03）：apiKey 仅经 env → config 对象进 callAI Authorization 头，
 * 断言与 console 禁出现 key 值；断网容错 warn 只输出 err.message 不含 env 值。
 *
 * Mock 边界（只 mock 进程/IO 边界红线内）：
 *   - commandSafety 不 mock —— isCommandAllowed 真实现，安全过滤两层真跑（discovery 层受控白名单
 *     ['display','show','ping'] + executeCommandsOnDevice 执行层内部白名单经 getDatabase stub 同集）
 *   - ai 模块 importActual 混合：callAI/executeCommandsOnDevice 真实现；getAiConfig（env 组装）、
 *     getCommandWhitelist（受控白名单）、getDeviceByIdInternal（loopback 设备）mock
 *   - knowledgeBaseService/aiExecLogger/experienceRetrieval/connection/telnetExec：同 ai.execCommands.real.test.ts
 *     范式（防级联重依赖 / getDatabase stub 支撑白名单 SELECT / telnet spy）
 *   - systemLog：mock 防审计日志 DB 级联
 */

// ---- env 门控（D-11：默认 skip；四 env 全齐才真跑） ----
const RUN = process.env.NT_TEST_REAL_AI === '1'
  && !!process.env.NT_TEST_AI_API_KEY
  && !!process.env.NT_TEST_AI_BASE_URL
  && !!process.env.NT_TEST_AI_MODEL
const itReal = RUN ? it : it.skip

// mockSshServer 端口需在 vi.mock 工厂（hoisted）里可引用 —— vi.hoisted 持有可变状态
const state = vi.hoisted(() => ({ sshPort: 0 }))

// ---- Mock：ai 模块（importActual 混合——callAI/executeCommandsOnDevice 真实现） ----
vi.mock('../../electron/services/ai', async () => {
  const actual = await vi.importActual<any>('../../electron/services/ai')
  return {
    ...actual,
    getAiConfig: () => ({
      apiKey: process.env.NT_TEST_AI_API_KEY,
      baseUrl: process.env.NT_TEST_AI_BASE_URL,
      modelName: process.env.NT_TEST_AI_MODEL,
    }),
    getCommandWhitelist: () => ['display', 'show', 'ping'],
    getDeviceByIdInternal: (id: string) => ({
      id,
      name: 'smoke-loopback',
      vendor: 'huawei',
      model: 'S5735',
      version: 'V200R021',
      ipAddress: '127.0.0.1',
      port: state.sshPort,
      connectionType: 'ssh',
      username: 'test',
      password: 'test',
      deviceType: 'switch',
    }),
  }
})

// ---- Mock：knowledgeBaseService（防级联加载重依赖） ----
vi.mock('../../electron/services/knowledgeBaseService', () => ({
  search: vi.fn().mockResolvedValue([]),
}))

// ---- Mock：aiExecLogger（防加密列/DB 牵连） ----
vi.mock('../../electron/services/aiExecLogger', () => ({
  createLog: vi.fn(),
  updateLogStatus: vi.fn(),
  appendLogAiResponse: vi.fn(),
  getLogs: vi.fn().mockReturnValue([]),
  setAiExecLoggerMasterKey: vi.fn(),
}))

// ---- Mock：experienceRetrieval（防 chat() 路径牵连，本文件不测 chat） ----
vi.mock('../../electron/services/experienceRetrieval', () => ({
  retrieveForAnswer: vi.fn().mockResolvedValue([]),
}))

// ---- Mock：systemLog（防 discovery safeLog 审计写库级联） ----
vi.mock('../../electron/services/systemLog', () => ({
  createSystemLog: vi.fn(),
}))

// ---- Mock：getDatabase（支撑 executeCommandsOnDevice 执行层内部 getCommandWhitelist SELECT，
//      返回与 discovery 层同集的受控白名单——真实 isCommandAllowed 两层一致真跑；get() 兜底 null） ----
vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({
      all: () => [{ pattern: 'display' }, { pattern: 'show' }, { pattern: 'ping' }],
      get: () => null,
    }),
  }),
}))

// ---- Mock：telnetExec.executeTelnetCommand（spy——本文件设备是 ssh，telnet 分流不应被调） ----
const telnetExecSpy = vi.fn()
vi.mock('../../electron/utils/telnetExec', async () => {
  const actual = await vi.importActual<any>('../../electron/utils/telnetExec')
  return {
    ...actual,
    executeTelnetCommand: (...args: any[]) => telnetExecSpy(...args),
  }
})

// ssh2 / commandSafety 不 mock —— 被测协议与安全过滤走真实现
import { discoverTopology } from '../../electron/services/discovery'
import { startMockSshServer } from './_helpers/mockSshServer'

// ---- 断网容错分流（D-11 / T-16-03-05）：特征串白名单严格限定网络类，其余一律 throw fail ----
const NETWORK_ERR_PATTERNS = [
  'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'fetch failed', 'network timeout', 'timeout',
]

function isNetworkError(err: unknown): boolean {
  const e = err as { message?: unknown; cause?: { message?: unknown } }
  const hay = [String(e?.message ?? ''), String(e?.cause?.message ?? '')].join(' | ').toLowerCase()
  return NETWORK_ERR_PATTERNS.some((p) => hay.includes(p.toLowerCase()))
}

describe('discoverTopology 真 AI 全链路冒烟（env 门控，默认 skip）', () => {
  let sshHandle: { port: number; close: () => Promise<void> } | null = null

  beforeAll(async () => {
    // 默认 skip 状态不起 server（0 网络 0 花费，T-16-03-04）
    if (!RUN) return
    sshHandle = await startMockSshServer((cmd) => {
      // 华为风格回显：阶段1 prompt 引导 LLM 生成 display 系命令，mock 对端给可分析的邻居/版本输出
      if (cmd.includes('display version')) {
        return 'Huawei Versatile Routing Platform Software\nVRP (R) Software, Version 5.170 (S5735 V200R021)\nCopyright (C) 2000-2020 Huawei Technologies Co., Ltd.\n'
      }
      if (cmd.includes('lldp')) {
        return 'GigabitEthernet0/0/1 has 1 neighbor(s):\nNeighbor index : 1, Chassis type :MAC address, Chassis ID :48-46-fb-00-00-02\nPort ID type :Interface name, Port ID :GigabitEthernet0/0/24\nSystem name :SW-Access-2\n'
      }
      return `Huawei Versatile Routing Platform\n${cmd} output placeholder\n`
    })
    state.sshPort = sshHandle.port
  })

  afterAll(async () => {
    if (sshHandle) await sshHandle.close()
  })

  itReal('真 AI 全链路冒烟：LLM 生成命令 → 真实安全过滤 → 真 ssh2 采集 → LLM 拓扑分析，链路走通不崩溃', async () => {
    let result: Awaited<ReturnType<typeof discoverTopology>>
    try {
      result = await discoverTopology(['dev-smoke'])
    } catch (err) {
      // 断网容错分流（D-11）：网络不可达 warn 标注后视作通过，不算 fail
      if (isNetworkError(err)) {
        console.warn('[smoke] 网络不可达，视作通过（D-11 断网容错）:', (err as Error).message)
        return
      }
      // 解析/逻辑/断言类错误：链路真崩溃，必须 fail 不能被容错吞掉（T-16-03-05 防假绿）
      throw err
    }

    // 松断言（D-11）：LLM 输出不确定，只验三键齐全 + 数组类型 + 非负长度，不要求拓扑形状
    expect(result).toBeTruthy()
    expect(Array.isArray(result.nodes)).toBe(true)
    expect(Array.isArray(result.edges)).toBe(true)
    expect(Array.isArray(result.failedDevices)).toBe(true)
    expect(result.nodes.length).toBeGreaterThanOrEqual(0)
    expect(result.edges.length).toBeGreaterThanOrEqual(0)

    // telnet 分流反向断言：设备是 ssh，telnet 通道不应被调
    expect(telnetExecSpy).not.toHaveBeenCalled()
  })
})
