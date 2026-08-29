import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Phase 20 20-02 promptConsumers 测试网：
 *
 * 1. 收敛断言（PMT-01）：7 处真实 LLM prompt 调用点全部走 PromptService.getPrompt(id)
 *    - 轻依赖模块（drafting / rerank）功能级断言：build 出的 system === registry 默认文案
 *    - 重依赖模块（ai / discovery / kb）源码级断言：文件内出现对应 getPrompt('<id>') 调用
 * 2. T-20-04 fail-closed（PMT-04 / Success Criteria 5）：confirm 模式下 AI 回复命令结构解析失败
 *    （用户改坏提示词 → AI 输出畸形 [CMD] 标记 / 空命令体）不进入执行路径，回落
 *    confirm_required 同型人工确认输出；auto 模式维持既有行为不变。
 *
 * Mock 策略（ai.saveChatMessage.test.ts 同款 + 扩展）：getDatabase 按 SQL 分流、
 * ssh2 / telnetExec / aiExecLogger / knowledgeBaseService / experienceRetrieval 桩化，
 * callAI 经 global.fetch stub 控制回复内容（不改 ai.ts 内部结构，真路径跑 chat()）。
 *
 * F-01 归位（27-01 Rule 3 先例）：原居 electron/services/__tests__/ 不被 vitest.electron.config.ts
 * 采集，现迁 tests/electron/services/ 由 electron 轨唯一采集（mock 轨 exclude tests/electron/**）。
 */

// ---------- 共享 mock：getDatabase 按 SQL 分流 ----------

const dbRows: Record<string, any> = {}
const prepareRun = vi.fn()
const prepareGet = vi.fn((...args: any[]) => {
  const sql = prepareGetSql
  if (sql.includes('exec_mode')) return { exec_mode: dbRows.execMode }
  if (sql.includes('FROM ai_config')) return dbRows.aiConfig
  if (sql.includes('FROM devices')) return dbRows.device ?? null
  if (sql.includes('FROM prompt_overrides')) return undefined
  if (sql.includes('FROM command_whitelist')) return { all: () => [] }
  return undefined
})
let prepareGetSql = ''
const prepareFn = vi.fn((sql: string) => {
  prepareGetSql = sql
  if (sql.includes('INSERT') || sql.includes('UPDATE') || sql.includes('DELETE')) {
    return { run: prepareRun, get: prepareGet, all: () => [] }
  }
  if (sql.includes('SELECT pattern FROM command_whitelist')) {
    return { all: () => [{ pattern: 'display' }], run: prepareRun, get: prepareGet }
  }
  return { get: prepareGet, all: () => [], run: prepareRun }
})

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => ({ prepare: prepareFn }),
}))

vi.mock('ssh2', () => {
  class Client {
    on = vi.fn()
    connect = vi.fn()
    end = vi.fn()
    destroy = vi.fn()
  }
  return { Client }
})

vi.mock('../../../electron/utils/telnetExec', () => ({
  executeTelnetCommand: vi.fn(),
  pickDisablePaginationCmd: vi.fn(),
  pickShellPrompt: vi.fn(),
}))

vi.mock('../../../electron/services/aiExecLogger', () => ({
  createLog: vi.fn(() => 'log-test-1'),
  updateLogStatus: vi.fn(),
  appendLogAiResponse: vi.fn(),
  getLogs: vi.fn(() => []),
  setAiExecLoggerMasterKey: vi.fn(),
}))

vi.mock('../../../electron/services/knowledgeBaseService', () => ({
  search: vi.fn(async () => ({ rows: [] })),
}))

vi.mock('../../../electron/services/experienceRetrieval', () => ({
  retrieveForAnswer: vi.fn(async () => ({ injected: [] })),
}))

import { encField } from '../../../electron/utils/crypto'
import { PROMPT_REGISTRY, getRegistryEntry } from '../../../electron/services/promptRegistry'
import { buildDraftingPrompt, buildVerdictPrompt } from '../../../electron/services/draftingService'
import { buildRerankPrompt } from '../../../electron/services/experienceRerank'
import { chat, confirmCommand, setAiMasterKey, buildExpContextText } from '../../../electron/services/ai'

const MK = 'test-mk-for-prompt-consumers'

function makeConfigRow(): any {
  return {
    provider_enc: encField('openai', MK),
    api_key_enc: encField('sk-test', MK),
    base_url_enc: encField('http://localhost:1', MK),
    model_name_enc: encField('gpt-test', MK),
    vision_base_url_enc: null,
    vision_api_key_enc: null,
    vision_model_enc: null,
  }
}

function makeDeviceRow(): any {
  return {
    id: 'dev-1',
    name_enc: encField('SW-Core', MK),
    vendor_enc: encField('huawei', MK),
    model_enc: encField('S5735', MK),
    version_enc: encField('V200', MK),
    ip_enc: encField('10.1.1.1', MK),
    device_type: 'switch',
    connection_type: 'ssh',
    port_enc: encField('22', MK),
    username_enc: encField('admin', MK),
    password_enc: null,
    ssh_key_path_enc: null,
    ssh_key_content_enc: null,
  }
}

function stubFetchReply(content: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  setAiMasterKey(MK)
  dbRows.execMode = 'confirm'
  dbRows.aiConfig = makeConfigRow()
  dbRows.device = makeDeviceRow()
})

// ---------- 1. 收敛断言（PMT-01：7 调用点统一 getPrompt） ----------

describe('7 处 prompt 调用点收敛到 PromptService.getPrompt（PMT-01）', () => {
  it('drafting.experience：buildDraftingPrompt 的 system === registry 默认文案', () => {
    const { system } = buildDraftingPrompt({ maskedConversation: '会话正文', existingSummaries: [] })
    expect(system).toBe(getRegistryEntry('drafting.experience')!.content)
  })

  it('drafting.verdict：buildVerdictPrompt 的 system === registry 默认文案', () => {
    const { system } = buildVerdictPrompt({ drafts: [], existingByCategory: { troubleshooting: [], best_practices: [], product: [], env: [] } })
    expect(system).toBe(getRegistryEntry('drafting.verdict')!.content)
  })

  it('rerank.experience：buildRerankPrompt 的 system === registry 默认文案', () => {
    const { system } = buildRerankPrompt({ userMessage: 'ARP 超限', candidates: [{ exp_id: 'e1', title: 't', content_preview: 'p' }] })
    expect(system).toBe(getRegistryEntry('rerank.experience')!.content)
  })

  it('registry 恰好 15 条（口径锁死：真实 LLM prompt 调用点 + 资源地图/cmdStyle/禁止令静态条目 + Phase 28 agent 循环五条目）', () => {
    // 原 10 条口径：7 处 LLM 调用点 + ai.chat.resourceMap（23-02 D-07）+ ai.chat.cmdStyle（23-03）+ kb.pick
    // Phase 28 新增 5 条：agentHonestWrapup / agentRetryHint / agentBurnoutNote（28-01 硬顶诚实收尾、
    // 重试提示、熔断说明）+ agentConflictGuide（28-04 D-10 三源冲突标注）+ sourceAttribution（28-06 R6 来源归因）
    expect(PROMPT_REGISTRY).toHaveLength(15)
  })

  // 重依赖模块（ai / discovery / kb）源码级收敛断言：内联 prompt 已删、getPrompt(id) 接入
  const srcDir = path.resolve(__dirname, '../../../electron/services')
  const sourceLevel: Array<[string, string]> = [
    // Phase 32（32-04）：chat 本体自 ai.ts 迁 aiChat.ts，源码断言随实现文件改向（断言意图不变）
    ['aiChat.ts', "PromptService.getPrompt('ai.chat.systemPrompt')"],
    ['discovery.ts', "PromptService.getPrompt('discovery.vendor')"],
    ['discovery.ts', "PromptService.getPrompt('discovery.topology')"],
    ['knowledgeBaseService.ts', "PromptService.getPrompt('kb.pick')"],
  ]
  for (const [file, needle] of sourceLevel) {
    it(`源码断言：${file} 含 ${needle.slice(-25)}`, () => {
      const src = fs.readFileSync(path.join(srcDir, file), 'utf-8')
      expect(src).toContain(needle)
    })
  }
  it('源码断言：内联 prompt 常量已删（SYSTEM_PROMPT = / 你是网络运维 不再出现在 service 源码）', () => {
    for (const f of ['ai.ts', 'discovery.ts', 'draftingService.ts', 'experienceRerank.ts', 'knowledgeBaseService.ts']) {
      const src = fs.readFileSync(path.join(srcDir, f), 'utf-8')
      expect(src).not.toMatch(/SYSTEM_PROMPT = \[/)
      expect(src).not.toContain('你是网络运维经验提炼助手')
      expect(src).not.toContain('你是一个网络设备管理AI助手')
    }
  })
})

// ---------- 2. T-20-04 fail-closed（confirm 解析失败回落人工确认） ----------

describe('ai.chat confirm 解析失败 fail-closed（T-20-04 / PMT-04）', () => {
  it('畸形回复（未闭合 [CMD] 标签）+ confirm 模式 → confirm_required 同型人工确认输出，不进执行路径', async () => {
    const malformed = '建议检查版本：[CMD]display version（标签未闭合，无法解析）'
    stubFetchReply(malformed)
    const raw = await chat([{ role: 'user', content: '查下版本' }], ['dev-1'], 'sess-1')
    const payload = JSON.parse(raw)
    expect(payload.type).toBe('confirm_required')
    expect(payload.commands).toEqual([])
    expect(payload.aiExplanation).toBe(malformed)
    expect(payload.rejectedCommands[0].reason).toMatch(/解析失败/)
    expect(typeof payload.execId).toBe('string')
    expect(payload.execId.length).toBeGreaterThan(0)
  })

  it('混合畸形回复（空命令体块）+ confirm 模式 → 空块剔除不产生命令，合法命令仍走人工确认不进执行路径', async () => {
    // 28-03 parseCmdBlocks 分块语义（F-01 随真实合同更新）：[CMD] [/CMD] 空命令体 trim 后被
    // filter 剔除（不产生任何命令条目）；同回复内合法块照常提取进 confirm_required——
    // confirm 模式下用户确认门保留，T-20-04 fail-closed 红线（畸形部分永不进执行路径）不回归。
    const malformed = '两段命令：[CMD]display version[/CMD] 与空命令体 [CMD] [/CMD]'
    stubFetchReply(malformed)
    const raw = await chat([{ role: 'user', content: '查下版本' }], ['dev-1'], 'sess-1')
    const payload = JSON.parse(raw)
    expect(payload.type).toBe('confirm_required')
    // 合法块提取 1 条；空命令体块不产生命令条目（不混入空串/畸形命令）
    expect(payload.commands).toEqual([{ deviceName: 'SW-Core', command: 'display version' }])
  })

  it('畸形回复 + auto 模式 → 既有行为不变（无命令可提取时原样返回纯文本回复）', async () => {
    dbRows.execMode = 'auto'
    const malformed = '建议检查版本：[CMD]display version（标签未闭合，无法解析）'
    stubFetchReply(malformed)
    const raw = await chat([{ role: 'user', content: '查下版本' }], ['dev-1'], 'sess-1')
    expect(raw).toBe(malformed)
  })

  it('fail-closed 空批次确认不触发 LLM 追问（confirmCommand 空命令守卫）', async () => {
    const malformed = '建议检查版本：[CMD]display version（标签未闭合，无法解析）'
    const fetchSpy = stubFetchReply(malformed)
    const raw = await chat([{ role: 'user', content: '查下版本' }], ['dev-1'], 'sess-1')
    const { execId } = JSON.parse(raw)
    fetchSpy.mockClear()
    const result = await confirmCommand(execId, true)
    expect(result).toMatch(/fail-closed|无待执行命令/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('正常回复 + confirm 模式（控制组）：完整 [CMD] 块仍走既有 confirm_required 流程', async () => {
    const normal = '请执行：\n[CMD]display version[/CMD]'
    stubFetchReply(normal)
    const raw = await chat([{ role: 'user', content: '查下版本' }], ['dev-1'], 'sess-1')
    const payload = JSON.parse(raw)
    expect(payload.type).toBe('confirm_required')
    expect(payload.commands).toEqual([{ deviceName: 'SW-Core', command: 'display version' }])
  })
})

// ---------- Phase 23 Plan 04 C2：经验注入文本可信度分级标注 ----------

describe('buildExpContextText（EXP_SEARCH 注入文本分级标注）', () => {
  const injected = [
    { exp_id: 'e1', title: '核心交换机离线排查', content: '检查电源', source_session_id: null, unsupported: false, linked: true },
    { exp_id: 'e2', title: '通用巡检经验', content: '日常巡检', source_session_id: null, unsupported: false, linked: false },
    { exp_id: 'e3', title: '含失效命令经验', content: 'reboot 重启', source_session_id: null, unsupported: true, linked: true },
  ]

  it('有目标设备时：linked 标注「关联当前设备，高可信」，全局标注「全局经验…供参考」', () => {
    const text = buildExpContextText(injected, true)
    expect(text).toContain('[经验1: 核心交换机离线排查（关联当前设备，高可信）]')
    expect(text).toContain('[经验2: 通用巡检经验（全局经验，来自其它设备场景，供参考）]')
    // unsupported 提示仍保留（与分级标注叠加）
    expect(text).toContain('此条经验命令已失支持')
  })

  it('无目标设备时：不做分级标注（无「关联当前设备」字样），unsupported 提示保留', () => {
    const text = buildExpContextText(injected, false)
    expect(text).toContain('[经验1: 核心交换机离线排查]')
    expect(text).not.toContain('关联当前设备')
    expect(text).not.toContain('全局经验')
    expect(text).toContain('此条经验命令已失支持')
  })
})
