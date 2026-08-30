import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 28 Plan 28-03 —— runAgentLoop 四标记统一循环 + 四重硬顶 + 重试降级（AGENT-04/06）。
 *
 * Task 1: AgentLoopState 对象化底座——normalizeAgentKey 归一化 / callAIWithUsage 计量。
 * Task 2 (TDD): 四类标记统一循环 / 步数·熔断·冷却·token 预算四重硬顶 / D-13 诚实收尾 /
 *   CMD confirm 续跑不断头（Pitfall 2）/ 安全拒绝不计失败冷却（Pitfall 10）/ D-15 新循环不受旧冷却影响。
 *
 * Mock 策略（mcpAiFlow.test.ts 同款）：connection.getDatabase → :memory: 真库；
 * ssh2 用可控行为的 FakeClient（ready→exec→close 微任务时序，静默期前 close 即成功）；
 * commandSafety.isCommandAllowed / aiExecLogger / knowledgeBaseService / experienceRetrieval /
 * promptService / telnetExec / sshConfig / mcpClient / mcpService 全 mock 防级联。
 */

const { FakeClient } = vi.hoisted(() => {
  class FakeClient {
    static count = 0
    /** true = exec 阶段失败（execOne 捕获 → success:false 不 reject 整批） */
    static fail = false
    /** exec stream data 事件下发的命令输出（空 = 无输出只有 close） */
    static output = ''
    constructor() {
      FakeClient.count++
    }
    on(ev: string, cb: (...a: any[]) => void) {
      if (ev === 'ready') setTimeout(cb, 0)
      return this
    }
    connect() { /* no-op */ }
    end() { /* no-op */ }
    destroy() { /* no-op */ }
    exec(_cmd: string, cb: (err: Error | null, s?: any) => void) {
      setTimeout(() => {
        if (FakeClient.fail) {
          cb(new Error('mock exec fail'))
          return
        }
        cb(null, {
          on(ev: string, c: (...a: any[]) => void) {
            if (ev === 'data' && FakeClient.output) setTimeout(() => c(Buffer.from(FakeClient.output)), 0)
            if (ev === 'close') setTimeout(c, 0)
          },
          close() { /* no-op */ },
          stderr: { on() { /* no-op */ } },
        })
      }, 0)
    }
  }
  return { FakeClient }
})

vi.mock('ssh2', () => ({ Client: FakeClient }))
vi.mock('../../../electron/services/commandSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/services/commandSafety')>()
  return {
    tokenizeCommand: actual.tokenizeCommand,
    isCommandAllowed: vi.fn().mockReturnValue({ allowed: false, reason: 'mock 拒绝' }),
  }
})
vi.mock('../../../electron/services/aiExecLogger', () => ({
  createLog: vi.fn().mockReturnValue('log-1'),
  updateLogStatus: vi.fn(),
  updateLogGuardOutcome: vi.fn(),
  appendLogAiResponse: vi.fn(),
  getLogs: vi.fn().mockReturnValue([]),
  setAiExecLoggerMasterKey: vi.fn(),
}))
vi.mock('../../../electron/services/knowledgeBaseService', () => ({
  search: vi.fn().mockResolvedValue({ rows: [] }),
}))
const retrieveForAnswerMock = vi.fn()
vi.mock('../../../electron/services/experienceRetrieval', () => ({
  retrieveForAnswer: (...args: any[]) => retrieveForAnswerMock(...args),
}))
vi.mock('../../../electron/services/promptService', () => ({
  PromptService: {
    getPrompt: vi.fn((id: string) =>
      id === 'ai.chat.systemPrompt'
        ? '{{deviceInfo}}{{experienceContext}}'
        : id === 'ai.chat.resourceMap'
          ? '资源地图：可用 [CMD]/[KB_SEARCH]/[EXP_SEARCH] 标记。'
          : id === 'ai.chat.agentHonestWrapup'
            ? '自主执行已因系统限制停止：{{reason}}（已进行 {{steps}} 步）。\n【执行进度】进行到第 {{steps}} 步，因 {{reason}} 停止。请按模板输出收尾报告。'
            : id === 'ai.chat.agentConflictGuide'
              ? '三源冲突标注（D-10）：经验库/知识库/设备实时输出不一致时，正文内联「⚠ X 与 Y 不一致」并在末尾输出冲突清单，禁止静默取舍。'
              : ''
    ),
  },
}))
vi.mock('../../../electron/utils/telnetExec', () => ({
  executeTelnetCommand: vi.fn(),
  pickDisablePaginationCmd: vi.fn(),
  pickShellPrompt: vi.fn(),
}))
vi.mock('../../../electron/utils/sshConfig', () => ({
  SSH_READY_TIMEOUT_MS: 1000,
  buildSSHConnectConfig: vi.fn(),
}))
vi.mock('../../../electron/services/mcpClient', () => ({
  callToolWithTimeout: vi.fn(),
}))
vi.mock('../../../electron/services/mcpService', () => ({
  McpService: {
    decodeForTest: vi.fn().mockReturnValue({ type: 'http', commandOrUrl: 'http://x', args: [], env: {}, credential: null }),
  },
}))

// ---------- in-memory DB ----------

let db: Database.Database
const MK = 'test-mk-28-03'

function makeDb(execMode: string): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE ai_config (
      id TEXT PRIMARY KEY, provider_enc TEXT, api_key_enc TEXT, base_url_enc TEXT, model_name_enc TEXT,
      vision_base_url_enc TEXT, vision_api_key_enc TEXT, vision_model_enc TEXT,
      exec_mode TEXT DEFAULT 'confirm', mcp_max_rounds INTEGER DEFAULT 5,
      agent_max_rounds INTEGER, agent_burnout_count INTEGER, agent_cooldown_secs INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE command_whitelist (id TEXT PRIMARY KEY, pattern TEXT NOT NULL UNIQUE);
    CREATE TABLE chat_history (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, content_enc TEXT NOT NULL,
      device_id TEXT, session_id TEXT, meta_enc TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, device_id TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE ai_exec_logs (
      id TEXT PRIMARY KEY, device_id TEXT, device_name_enc TEXT, command TEXT NOT NULL,
      status TEXT CHECK(status IN ('approved','rejected','pending','executed','failed')),
      mode TEXT CHECK(mode IN ('confirm','smart','auto')),
      ai_reason TEXT, prompt_text_enc TEXT, ai_response_enc TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE devices (id TEXT PRIMARY KEY, name_enc TEXT, ip_enc TEXT, vendor_enc TEXT, model_enc TEXT,
      version_enc TEXT, device_type TEXT, connection_type TEXT, port_enc TEXT, username_enc TEXT,
      password_enc TEXT, ssh_key_path_enc TEXT, ssh_key_content_enc TEXT, status TEXT, last_checked TEXT);
    CREATE TABLE mcp_device_rel (id TEXT PRIMARY KEY, mcp_config_id INTEGER NOT NULL, device_id TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now','localtime')));
  `)
  d.prepare('INSERT INTO ai_config (id, api_key_enc, exec_mode) VALUES (?, ?, ?)').run(
    'cfg1', encField('test-key', MK), execMode
  )
  return d
}

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => db,
}))

import { encField, decField } from '../../../electron/utils/crypto'
import {
  chat, confirmCommand, setAiMasterKey,
  normalizeAgentKey, callAIWithUsage,
  getChatHistory, buildAgentMeta, getSessionMessages,
} from '../../../electron/services/ai'
// 28-06 R5 缺陷A：renderer 历史恢复纯函数（parseAiReply.ts 无 DOM 依赖，可被 electron 套件直接消费）
import { historyMessageToChatMsgs } from '../../../src/components/pages/ai/parseAiReply'
import { isCommandAllowed } from '../../../electron/services/commandSafety'
import { search as kbSearch } from '../../../electron/services/knowledgeBaseService'
import { createLog as createLogMock, updateLogStatus as updateLogStatusMock } from '../../../electron/services/aiExecLogger'

// ---------- Task 1: AgentLoopState 底座（归一化 + usage 计量） ----------

describe('Task 1: normalizeAgentKey 参数归一化', () => {
  it('JSON 对象 key 顺序无关：{b:2,a:1} 与 {a:1,b:2} 产出相同 key', () => {
    expect(normalizeAgentKey('{"b":2,"a":1}')).toBe(normalizeAgentKey('{"a":1,"b":2}'))
  })

  it('非 JSON 输入退原串 trim；嵌套对象同样按 key 排序', () => {
    expect(normalizeAgentKey('  ping 8.8.8.8 ')).toBe('ping 8.8.8.8')
    expect(normalizeAgentKey('{"z":{"b":1,"a":2},"a":1}')).toBe(normalizeAgentKey('{"a":1,"z":{"a":2,"b":1}}'))
  })

  it('JSON 数组/数字/字符串标量不做对象排序（原样 trim stringify）', () => {
    expect(normalizeAgentKey('[3,2,1]')).toBe('[3,2,1]')
    expect(normalizeAgentKey(' 42 ')).toBe('42')
  })
})

describe('Task 1: callAIWithUsage 计量（data.usage 消费 + 估算 fallback）', () => {
  it('网关返回 usage → 原样透传', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    }))
    global.fetch = fetchMock as unknown as typeof fetch
    const r = await callAIWithUsage({ baseUrl: 'http://x', apiKey: 'k', modelName: 'm' }, [
      { role: 'user', content: 'hi' },
    ])
    expect(r.content).toBe('hello')
    expect(r.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7 })
  })

  it('网关缺 usage → 字符数/4 估算 fallback（Pitfall 6）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'abcd'.repeat(10) } }] }),
    }))
    global.fetch = fetchMock as unknown as typeof fetch
    const r = await callAIWithUsage({ baseUrl: 'http://x', apiKey: 'k', modelName: 'm' }, [
      { role: 'user', content: 'hi' },
    ])
    expect(r.usage).toBeTruthy()
    expect(r.usage!.completion_tokens).toBe(10) // 40 字符 / 4
    expect(r.usage!.prompt_tokens).toBeGreaterThan(0)
  })
})

// ---------- Task 2 (TDD): runAgentLoop 四标记统一循环 + 四重硬顶 + 重试降级 ----------

import { AGENT_BURNOUT_GUARD } from '../../../electron/services/promptRegistry'

function insertDevice(id: string, name: string) {
  db.prepare(
    'INSERT INTO devices (id, name_enc, ip_enc, connection_type) VALUES (?, ?, ?, ?)'
  ).run(id, encField(name, MK), encField('10.0.0.1', MK), 'ssh')
}

/** fetch 队列 mock：callAI 逐次消费 replies */
function queueReplies(...replies: string[]) {
  const queue = [...replies]
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: queue.shift() ?? '' } }] }),
  }))
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function allowCmd() {
  vi.mocked(isCommandAllowed).mockReturnValue({ allowed: true, reason: '' } as any)
}

const KB_ROWS = {
  rows: [
    { content: 'VLAN 划分原理：按端口/按 MAC。', document: { title: '网络手册' }, title: 'VLAN 章节', document_id: 'doc1', images: [] },
  ],
}
const EXP_HIT = {
  demoMode: false,
  injected: [
    { exp_id: 'exp-1', title: 'ARP 排查', content: '先 display arp', source_session_id: 's1', unsupported: false },
  ],
  reranked: [],
  finalAnswer: '',
}

/** 取第 n 次（0 基）callAI 请求体 messages */
function reqMsgs(fetchMock: any, n: number) {
  return JSON.parse((fetchMock.mock.calls[n][1] as any).body).messages
}

beforeEach(() => {
  db = makeDb('auto')
  insertDevice('dev1', 'dev1')
  setAiMasterKey(MK)
  FakeClient.count = 0
  FakeClient.fail = false
  FakeClient.output = ''
  vi.mocked(kbSearch).mockReset()
  vi.mocked(kbSearch).mockResolvedValue({ rows: [] } as any)
  retrieveForAnswerMock.mockReset()
  vi.mocked(isCommandAllowed).mockReturnValue({ allowed: false, reason: 'mock 拒绝' } as any)
  vi.mocked(createLogMock).mockClear()
  vi.mocked(updateLogStatusMock).mockClear()
})

describe('Task 2: 四标记统一循环（混合动作 + KB/EXP 循环内直执）', () => {
  it('混合标记同轮执行：[CMD]+[KB_SEARCH] 一轮内两类动作都执行且各占一步', async () => {
    allowCmd()
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display clock[/CMD] 同时查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '混合轮总结'
    )
    const out = await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], null)
    // 28-04：有执行轨迹的最终回答附带 meta（kb 引用在场保持 kb_answer 契约 + meta 字段）
    const payload = JSON.parse(out)
    expect(payload.type).toBe('kb_answer')
    expect(payload.content).toBe('混合轮总结')
    expect(payload.noRealtimeData).toBe(false)
    expect(payload.tier).toBe('knowledge')
    expect(payload.sources.some((s: any) => s.kind === 'device')).toBe(true)
    expect(payload.sources.some((s: any) => s.kind === 'kb')).toBe(true)
    expect(payload.steps.some((s: any) => s.actionType === 'cmd' && s.status === 'done')).toBe(true)
    expect(vi.mocked(kbSearch)).toHaveBeenCalledWith('vlan 原理', ['dev1'], 5)
    // 命令两轮各执行一次（inline 轮 + loop 轮），无重试（成功路径）
    expect(FakeClient.count).toBe(2)
    // 第 3 次 callAI：同一条回注 user 消息同时含命令结果与文档片段（同轮两类动作）
    const userMsg = reqMsgs(fetchMock, 2).filter((m: any) => m.role === 'user').pop()
    expect(userMsg.content).toContain('display clock')
    expect(userMsg.content).toContain('文档片段')
  })

  it('EXP 循环内直执：检索命中回注经验片段，最终返 exp_answer 带来源', async () => {
    allowCmd()
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '再查经验 [EXP_SEARCH]ARP 异常[/EXP_SEARCH]',
      '经验总结'
    )
    const out = await chat([{ role: 'user', content: '排查' }], ['dev1'], null)
    expect(retrieveForAnswerMock).toHaveBeenCalledWith({ userMessage: 'ARP 异常', deviceIds: ['dev1'] })
    const third = reqMsgs(fetchMock, 2)
    expect(third.some((m: any) => m.role === 'user' && m.content.includes('经验库中检索到的相关经验'))).toBe(true)
    const payload = JSON.parse(out)
    // 28-04：exp 引用在场保持 exp_answer 契约 + meta 字段附带
    expect(payload.type).toBe('exp_answer')
    expect(payload.references).toHaveLength(1)
    expect(payload.references[0]).toMatchObject({ kind: 'experience', expId: 'exp-1' })
  })
})

describe('Task 2: 硬顶①步数 + 硬顶④token 预算 → D-13 诚实收尾', () => {
  it('步数硬顶：agent_max_rounds=1，第 2 轮标记不执行，回注诚实收尾 prompt', async () => {
    allowCmd()
    db.prepare('UPDATE ai_config SET agent_max_rounds = 1').run()
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display clock[/CMD]',
      '【执行进度】收尾报告'
    )
    const out = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    expect(JSON.parse(out).content).toBe('【执行进度】收尾报告')
    // 第 2 轮命令未执行（仅 inline 轮 1 次）
    expect(FakeClient.count).toBe(1)
    // 第 3 次 callAI 回注诚实收尾模板（含步数上限原因 + 当前步数）
    const wrapMsg = reqMsgs(fetchMock, 2).filter((m: any) => m.role === 'user').pop()
    expect(wrapMsg.content).toContain('自主执行已因系统限制停止')
    expect(wrapMsg.content).toContain('步数上限')
    expect(wrapMsg.content).toContain('第 1 步')
  })

  it('token 预算硬顶：估算超 200000 → 收尾回注 token 原因，不抛错', async () => {
    allowCmd()
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      'a'.repeat(850000) + '[CMD:dev1]display clock[/CMD]',
      'token 收尾'
    )
    const out = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    expect(JSON.parse(out).content).toBe('token 收尾')
    expect(FakeClient.count).toBe(1)
    const wrapMsg = reqMsgs(fetchMock, 2).filter((m: any) => m.role === 'user').pop()
    expect(wrapMsg.content).toContain('token 预算')
  })
})

describe('Task 2: 硬顶②熔断 + 硬顶③冷却 + 重试降级（Pitfall 10 / D-15）', () => {
  it('重试降级：失败动作自动重试至预算耗尽（1+2 次），仍失败计一次连续失败', async () => {
    allowCmd()
    FakeClient.fail = true
    queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '重试轮总结'
    )
    await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    // 28-06 缺陷①：无 MCP 绑定 + 首答含 [CMD] 也进 runAgentLoop——两轮都在循环内：
    // r1 直执 1+2 重试（3 连接）失败计 fc=1 + 写冷却；r2 同 key 命中冷却跳过（0 连接）
    expect(FakeClient.count).toBe(3)
  })

  it('28-06 缺陷①：无 MCP 上下文 + 首答含 [CMD] → 进 runAgentLoop（首轮直执带 D-14 重试）', async () => {
    allowCmd()
    FakeClient.fail = true
    // 旧代码（mcpContexts 空不进循环）退回单轮 [CMD] 路径：直执仅 1 次连接、无重试；
    // 循环路径首轮 1+2 重试 = 3 连接（RED=1 / GREEN=3，行为分水岭即循环入口）
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '收尾'
    )
    await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    expect(FakeClient.count).toBe(3)
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('熔断：连续第 burnout_count 轮失败后，同命令不再执行并回注 AGENT_BURNOUT_GUARD', async () => {
    allowCmd()
    FakeClient.fail = true
    db.prepare('UPDATE ai_config SET agent_burnout_count = 2').run()
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '熔断收尾'
    )
    const out = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    expect(JSON.parse(out).content).toBe('熔断收尾')
    // 28-06 缺陷①后全循环内：r1 直执 1+2 重试（3 次全失败，fc=1 + 写冷却）+
    // r2 冷却跳过（fc=2）+ r3/r4 熔断 0 次 = 3
    expect(FakeClient.count).toBe(3)
    const r4Msg = reqMsgs(fetchMock, 4).filter((m: any) => m.role === 'user').pop()
    expect(r4Msg.content).toContain('熔断')
    expect(r4Msg.content).toContain(AGENT_BURNOUT_GUARD)
  })

  it('冷却：同 deviceId:command 失败后冷却期内跳过；不同命令不受影响（D-15 同循环内）', async () => {
    allowCmd()
    FakeClient.fail = true
    db.prepare('UPDATE ai_config SET agent_cooldown_secs = 600').run()
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display clock[/CMD]',
      '冷却收尾'
    )
    await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    // 28-06 缺陷①后全循环内：r1 3次(重试全失败写冷却) + r2 冷却跳过(fc=2) +
    // r3 熔断跳过 + r4 display clock 3次(新 key 自有预算) = 6
    expect(FakeClient.count).toBe(6)
    const r4Req = reqMsgs(fetchMock, 2).filter((m: any) => m.role === 'user').pop()
    expect(r4Req.content).toContain('冷却中')
  })

  it('D-15：新循环（新 agentState）不受旧冷却影响', async () => {
    allowCmd()
    FakeClient.fail = true
    db.prepare('UPDATE ai_config SET agent_cooldown_secs = 600').run()
    queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '第一轮结束'
    )
    await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    const countAfterFirst = FakeClient.count
    // 第二次 chat：全新 agentState，同命令再次进入执行（不受旧冷却影响）
    queueReplies('[CMD:dev1]display version[/CMD]', '第二轮结束')
    await chat([{ role: 'user', content: '再查' }], ['dev1'], null)
    expect(FakeClient.count).toBeGreaterThan(countAfterFirst)
  })

  it('安全拒绝不计失败冷却（Pitfall 10）：白名单拒绝后下轮同命令不落入「冷却中」', async () => {
    allowCmd()
    // 第 1 轮（inline）放行成功；第 2/3 轮（loop）改为安全拒绝（fetch 第二次起翻转 mock）
    const replies = [
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display version[/CMD]',
      '安全拒绝收尾',
    ]
    let callIdx = 0
    const fetchMock = vi.fn(async () => {
      if (callIdx >= 1) {
        vi.mocked(isCommandAllowed).mockReturnValue({ allowed: false, reason: '不在白名单' } as any)
      }
      const content = replies[callIdx] ?? ''
      callIdx++
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const out = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    // 28-04：首轮直执成功入轨迹 → agent_answer payload（content 承载正文）
    expect(JSON.parse(out).content).toBe('安全拒绝收尾')
    // loop 两轮均为安全拒绝：零执行、零冷却（若误计冷却，第 3 轮会显示冷却中）
    expect(FakeClient.count).toBe(1)
    const r3Req = reqMsgs(fetchMock, 3).filter((m: any) => m.role === 'user').pop()
    expect(r3Req.content).toContain('不在白名单')
    expect(r3Req.content).not.toContain('冷却中')
  })
})

describe('Task 2: CMD confirm 续跑不断头（Pitfall 2 主路径修复）', () => {
  it('confirm 档：确认执行后续跑 runAgentLoop——后续 [KB_SEARCH] 轮直执到最终回答', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    allowCmd()
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '命令完成，再查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '续跑收尾'
    )
    const out1 = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    expect(JSON.parse(out1).type).toBe('confirm_required')
    const final = await confirmCommand(JSON.parse(out1).execId, true)
    expect(JSON.parse(final).content).toBe('续跑收尾')
    // 确认后命令执行 + KB 检索在续跑循环内发生
    expect(FakeClient.count).toBe(1)
    expect(vi.mocked(kbSearch)).toHaveBeenCalledWith('vlan 原理', ['dev1'], 5)
    expect(fetchMock.mock.calls.length).toBe(3)
  })

  it('confirm 档：确认后下轮再出 [CMD] → 再次 confirm_required（循环内 CMD 确认门）', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    allowCmd()
    queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display clock[/CMD]',
      '二轮确认后收尾'
    )
    const out1 = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    const out2 = await confirmCommand(JSON.parse(out1).execId, true)
    const payload2 = JSON.parse(out2)
    expect(payload2.type).toBe('confirm_required')
    expect(payload2.commands[0].command).toContain('display clock')
    // 第 1 条已执行，第 2 条挂起未执行
    expect(FakeClient.count).toBe(1)
    const final = await confirmCommand(payload2.execId, true)
    expect(JSON.parse(final).content).toBe('二轮确认后收尾')
    expect(FakeClient.count).toBe(2)
  })
})

// ---------- Phase 28 Plan 28-04：chat() 分档预取接线 + 后置证据校验 + agent_answer + meta_enc ----------

describe('28-04 Task 1: 分档强制预取 + 后置证据校验 + agent_answer payload', () => {
  it('buildAgentMeta 零轨迹：noRealtimeData===true（代码层判定，D-11）', () => {
    const state = { steps: [], sources: [] } as any
    const meta = buildAgentMeta(state, 'knowledge')
    expect(meta.noRealtimeData).toBe(true)
    expect(meta.tier).toBe('knowledge')
    expect(meta.sources).toEqual([])
  })

  it('buildAgentMeta 有 CMD 步骤/来源：noRealtimeData===false', () => {
    const state = {
      steps: [{ stepIndex: 0, actionType: 'cmd', status: 'done' }],
      sources: [{ kind: 'device', title: 'dev1' }],
    } as any
    expect(buildAgentMeta(state, 'troubleshoot').noRealtimeData).toBe(false)
  })

  it('troubleshoot 档缺 exp → 收尾自动补查一次并回注（AGENT-03 证据闭环）', async () => {
    // 预取 exp 零命中（第一次调用），收尾补查命中（第二次调用）
    retrieveForAnswerMock
      .mockResolvedValueOnce({ injected: [] })
      .mockResolvedValue(EXP_HIT)
    const fetchMock = queueReplies('初步分析', '补查后总结')
    const out = await chat([{ role: 'user', content: '网络故障排查' }], undefined, null)
    // 预取（callAI 前）+ 补查各一次检索
    expect(retrieveForAnswerMock).toHaveBeenCalledTimes(2)
    // 补查命中 → 追加一次 callAI 回注补查结果
    expect(fetchMock.mock.calls.length).toBe(2)
    const second = reqMsgs(fetchMock, 1)
    expect(second.some((m: any) => m.role === 'user' && m.content.includes('系统补查经验库命中'))).toBe(true)
    const payload = JSON.parse(out)
    // 补查 exp 引用并入 → exp_answer 契约 + meta（sources 含补查 exp 溯源）
    expect(payload.type).toBe('exp_answer')
    expect(payload.tier).toBe('troubleshoot')
    expect(payload.sources.some((s: any) => s.kind === 'exp')).toBe(true)
    expect(payload.noRealtimeData).toBe(false)
  })

  it('补查零命中：不加 LLM 轮，知情落 meta_enc（backfillNotes），零轨迹回复正文不变（纯文本契约）', async () => {
    retrieveForAnswerMock.mockResolvedValue({ injected: [] })
    const fetchMock = queueReplies('直接回答')
    const out = await chat([{ role: 'user', content: '网络故障排查' }], undefined, 'sess-zero')
    expect(fetchMock.mock.calls.length).toBe(1)
    // 零检索零执行 → 纯文本原样返回（不把普通问答变 JSON），无源标签经 meta_enc 持久化
    expect(out).toBe('直接回答')
    const row = db.prepare(
      "SELECT meta_enc FROM chat_history WHERE role='assistant' AND session_id=? ORDER BY created_at DESC LIMIT 1"
    ).get('sess-zero') as any
    const meta = JSON.parse(decField(row.meta_enc, MK) as string)
    expect(meta.noRealtimeData).toBe(true)
    expect(meta.backfillNotes.some((n: string) => n.includes('无相关内容'))).toBe(true)
  })

  it('systemPrompt 追加三源冲突指令（D-10：内联 ⚠ + 末尾冲突清单，禁止静默取舍）', async () => {
    const fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '你好' }], undefined, null)
    const sys = reqMsgs(fetchMock, 0)[0]
    expect(sys.role).toBe('system')
    expect(sys.content).toContain('禁止静默取舍')
  })

  it('meta_enc 持久化：最终回答落 chat_history.meta_enc（sources/steps/tier/noRealtimeData）', async () => {
    allowCmd()
    queueReplies('[CMD:dev1]display version[/CMD]', '执行完成总结')
    await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], 'sess-28-04')
    const row = db.prepare(
      "SELECT meta_enc FROM chat_history WHERE role='assistant' AND session_id=? ORDER BY created_at DESC LIMIT 1"
    ).get('sess-28-04') as any
    expect(row.meta_enc).toBeTruthy()
    const meta = JSON.parse(decField(row.meta_enc, MK) as string)
    expect(meta.tier).toBe('knowledge')
    expect(meta.noRealtimeData).toBe(false)
    expect(meta.sources.some((s: any) => s.kind === 'device')).toBe(true)
    expect(meta.steps.some((s: any) => s.actionType === 'cmd')).toBe(true)
  })

  it('无 meta_enc 历史行读取不 throw（降级 meta undefined）', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      CREATE TABLE chat_history (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, content_enc TEXT NOT NULL,
        device_id TEXT, session_id TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE ai_config (id TEXT PRIMARY KEY, provider_enc TEXT, api_key_enc TEXT, base_url_enc TEXT, model_name_enc TEXT,
        vision_base_url_enc TEXT, vision_api_key_enc TEXT, vision_model_enc TEXT,
        exec_mode TEXT DEFAULT 'confirm', mcp_max_rounds INTEGER DEFAULT 5,
        agent_max_rounds INTEGER, agent_burnout_count INTEGER, agent_cooldown_secs INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime')));
    `)
    legacy.prepare('INSERT INTO chat_history (id, role, content_enc) VALUES (?, ?, ?)')
      .run('h1', 'user', encField('历史消息', MK))
    db = legacy
    const rows = getChatHistory()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].content).toBe('历史消息')
    expect(rows[0].meta).toBeUndefined()
  })
})

// ---------- Phase 28 Plan 28-04 Task 2：ai:cancelChat 中断通道（AGENT-05/D-06） ----------

import {
  agentInterruptedFinal, AGENT_INTERRUPTED_NOTICE, ChatInterruptedError,
  cancelChatControllers, registerChatCancel, finishChatCancel, cancelChatForWebContents,
  createAgentLoopState,
} from '../../../electron/services/ai'

describe('28-04 Task 2: ai:cancelChat 中断通道', () => {
  it('agentInterruptedFinal：在途 running/retrying 步骤定格 interrupted + hardStop 置位（D-06）', () => {
    const state = createAgentLoopState()
    state.steps.push({ stepIndex: 0, actionType: 'cmd', status: 'running' } as any)
    state.steps.push({ stepIndex: 1, actionType: 'mcp', status: 'retrying' } as any)
    state.steps.push({ stepIndex: 2, actionType: 'kb', status: 'done' } as any)
    const res = agentInterruptedFinal(state)
    expect(res.kind).toBe('final')
    expect(res.reply).toBe(AGENT_INTERRUPTED_NOTICE)
    expect(state.steps[0].status).toBe('interrupted')
    expect(state.steps[1].status).toBe('interrupted')
    expect(state.steps[2].status).toBe('done')
    expect(state.hardStop).toBe('user_cancel')
  })

  it('runAgentLoop 轮入口中断：零追加 LLM 调用，返回中断通知（hardStop 落 meta）', async () => {
    allowCmd()
    const controller = new AbortController()
    const replies = [
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display clock[/CMD]',
    ]
    let callIdx = 0
    const fetchMock = vi.fn(async () => {
      const content = replies[callIdx] ?? ''
      callIdx++
      // 第 2 笔回复送达后立即停止——runAgentLoop 轮入口应检测到 aborted 不再发起第 3 次调用
      if (callIdx >= 2) controller.abort()
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const out = await chat([{ role: 'user', content: '查' }], ['dev1'], null, undefined, controller.signal)
    expect(fetchMock.mock.calls.length).toBe(2) // 中断后零追加 LLM 调用
    expect(FakeClient.count).toBe(1) // 第 2 轮命令未执行（display clock 中止）
    const payload = JSON.parse(out)
    expect(payload.content).toBe(AGENT_INTERRUPTED_NOTICE)
    expect(payload.hardStop).toBe('user_cancel')
    expect(payload.steps.some((s: any) => s.status === 'done')).toBe(true)
  })

  it('callAIWithUsage fetch 传 signal：中断 → ChatInterruptedError（非裸 AbortError）', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort()
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    await expect(callAIWithUsage(
      { baseUrl: 'http://x', apiKey: 'k', modelName: 'm' },
      [{ role: 'user', content: 'hi' }],
      controller.signal
    )).rejects.toBeInstanceOf(ChatInterruptedError)
  })

  it('28-06 缺陷②：停止落在响应体 json 消费中 → 同样归一 ChatInterruptedError（非裸 AbortError）', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      // fetch 已成功返回（headers 到达），body 下载中被用户停止
      return {
        ok: true,
        json: async () => {
          controller.abort()
          throw new DOMException('This operation was aborted', 'AbortError')
        },
      }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    await expect(callAIWithUsage(
      { baseUrl: 'http://x', apiKey: 'k', modelName: 'm' },
      [{ role: 'user', content: 'hi' }],
      controller.signal
    )).rejects.toBeInstanceOf(ChatInterruptedError)
  })

  it('取消注册表：register → cancelChatForWebContents abort + 清空；finishChatCancel 不误删他人条目（T-28-04-01/05）', () => {
    cancelChatControllers.clear()
    const c1 = registerChatCancel(101)
    const c2 = registerChatCancel(202)
    expect(cancelChatControllers.size).toBe(2)
    // 窗口 101 只取消自己的对话（他人窗口不可误取消）
    expect(cancelChatForWebContents(101)).toEqual({ success: true })
    expect(c1.signal.aborted).toBe(true)
    expect(c2.signal.aborted).toBe(false)
    expect(cancelChatControllers.has(101)).toBe(false)
    // 无进行中对话：显式回误不抛错
    expect(cancelChatForWebContents(101).success).toBe(false)
    // finish 只清理自己注册的 controller（旧条目不可被后注册者误删）
    const stale = registerChatCancel(303)
    const fresh = registerChatCancel(303)
    finishChatCancel(303, stale)
    expect(cancelChatControllers.get(303)).toBe(fresh)
    finishChatCancel(303, fresh)
    expect(cancelChatControllers.size).toBe(1) // 仅剩 202
    cancelChatControllers.clear()
  })
})

// ---------- 28-06 第三轮真机复测缺陷修复（混合标记轮 [CMD] 蒸发） ----------

describe('28-06 R3：混合标记轮 [CMD] 不蒸发（首答 [KB_SEARCH]+[CMD] 必进循环）', () => {
  it('smart 模式首答 [KB_SEARCH]+[CMD:精确设备名]：命令进执行链 + kb 检索同轮执行 + 两类步骤入轨迹', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'smart'").run()
    allowCmd()
    FakeClient.output = 'VRP V500'
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    const fetchMock = queueReplies(
      '先查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH] 再查版本 [CMD:dev1]display version[/CMD]',
      '混合任务总结'
    )
    const out = await chat([{ role: 'user', content: '先查版本再查资料' }], ['dev1'], null)
    const payload = JSON.parse(out)
    expect(payload.content).toBe('混合任务总结')
    // RED 分水岭：修复前 KB 二段式消费首答 → 二答无 [CMD] → 循环未进 → 命令静默蒸发（FakeClient 0 连接）
    expect(FakeClient.count).toBe(1)
    expect(vi.mocked(kbSearch)).toHaveBeenCalledWith('vlan 原理', ['dev1'], 5)
    expect(payload.steps.some((s: any) => s.actionType === 'cmd' && s.status === 'done')).toBe(true)
    expect(payload.steps.some((s: any) => s.actionType === 'kb' && s.status === 'done')).toBe(true)
    // 第 2 次 callAI 的回注 user 消息同时含命令输出与文档片段（同轮两类动作结果）
    const userMsg = reqMsgs(fetchMock, 1).filter((m: any) => m.role === 'user').pop()
    expect(userMsg.content).toContain('display version')
    expect(userMsg.content).toContain('VRP V500')
  })

  it('smart 模式首答 [KB_SEARCH]+[CMD 不带设备名]：默认目标设备执行命令', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'smart'").run()
    allowCmd()
    FakeClient.output = 'OK'
    vi.mocked(kbSearch).mockResolvedValue({ rows: [] } as any)
    queueReplies(
      '[KB_SEARCH]vlan[/KB_SEARCH] [CMD]display version[/CMD]',
      '总结'
    )
    const out = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    expect(FakeClient.count).toBe(1)
    const payload = JSON.parse(out)
    expect(payload.steps.some((s: any) => s.actionType === 'cmd' && s.status === 'done')).toBe(true)
    // KB 未命中有真实检索轨迹
    expect(vi.mocked(kbSearch)).toHaveBeenCalledWith('vlan', ['dev1'], 5)
  })

  it('简写设备名 [CMD:核心交换机] 模糊命中全名「公司服务器核心交换机」→ 进循环执行（不再因精确匹配失败被拒）', async () => {
    insertDevice('dev2', '公司服务器核心交换机')
    allowCmd()
    FakeClient.output = 'VERSION 5.20'
    queueReplies(
      '[CMD:核心交换机]display version[/CMD]',
      '总结'
    )
    const out = await chat([{ role: 'user', content: '查版本' }], ['dev2'], null)
    // 修复前：精确匹配失败 → 旧路径拒绝「未找到指定设备」（0 连接）；修复后模糊命中直接执行
    expect(FakeClient.count).toBe(1)
    const payload = JSON.parse(out)
    expect(payload.steps.some((s: any) => s.actionType === 'cmd' && s.status === 'done')).toBe(true)
  })

  it('兜底防线：未执行的 [CMD]（点名不存在设备）最终回复必带明确未执行系统提示（AI 不得脑补已发起）', async () => {
    allowCmd()
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    queueReplies(
      '[KB_SEARCH]vlan[/KB_SEARCH] 同时 [CMD:不存在的设备]display version[/CMD]',
      '总结'
    )
    const out = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    const payload = JSON.parse(out)
    // RED：修复前二段式消费首答后二答无标记 → 直接返回「总结」，未执行命令零提示
    expect(payload.content).toContain('未执行')
    expect(payload.content).toContain('display version')
    expect(payload.content).toContain('不存在的设备')
  })
})

// ---------- 28-06 第二轮真机复测缺陷修复 ----------

describe('28-06 R2 缺陷①：步骤卡内容非空（argsJson=resultJson 数据源修复）', () => {
  it('kb 步骤卡 argsJson=检索词、resultJson=命中概要；cmd 步骤卡 resultJson=命令输出摘要', async () => {
    allowCmd()
    FakeClient.output = 'VRP (R) V500R005C10'
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '命令完成，再查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '混合任务总结'
    )
    const payloads: any[] = []
    await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], null, (p) => payloads.push(p))
    // 28-06 R6 后预取卡也在场（prefetched=true）——循环内步骤卡按 !prefetched 区分
    const cmdP = payloads.find((p) => p.actionType === 'cmd' && p.stepStatus === 'done')
    expect(cmdP).toBeTruthy()
    expect(cmdP.argsJson).toBe('display version')
    expect(cmdP.resultJson).toContain('VRP (R) V500R005C10')
    const kbP = payloads.find((p) => p.actionType === 'kb' && p.stepStatus === 'done' && !p.prefetched)
    expect(kbP).toBeTruthy()
    // 缺陷①修复前：kb 步骤无 command → argsJson=''（renderer 显示「（无参数）」）、
    // settle 不回填 outputSummary → resultJson=''（「（无返回内容）」）
    expect(kbP.argsJson).toBe('vlan 原理')
    expect(kbP.resultJson).toContain('命中 1 条')
    expect(kbP.resultJson).toContain('网络手册')
  })
})

describe('28-06 R2 缺陷⑥：历史恢复 meta 通道（getSessionMessages 返回 meta）', () => {
  it('agent 会话消息 meta_enc 解密回读——steps/query/outputSummary/tier 齐全（renderer 历史恢复数据源）', async () => {
    allowCmd()
    FakeClient.output = 'VRP V500'
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '命令完成，再查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '最终总结'
    )
    await chat([{ role: 'user', content: '查' }], ['dev1'], 'sess-r2-6')
    const msgs = getSessionMessages('sess-r2-6')
    // user 行无 meta；assistant 行 meta 含步骤轨迹与检索词/输出摘要（历史步骤卡重建依据）
    const assistant = msgs.filter((m) => m.role === 'assistant' && m.meta).pop()
    expect(assistant).toBeTruthy()
    const meta = assistant!.meta as any
    expect(meta.tier).toBe('knowledge')
    const cmdStep = meta.steps.find((s: any) => s.actionType === 'cmd')
    expect(cmdStep.command).toBe('display version')
    expect(String(cmdStep.outputSummary)).toContain('VRP V500')
    const kbStep = meta.steps.find((s: any) => s.actionType === 'kb' && !s.prefetched)
    expect(kbStep.query).toBe('vlan 原理')
    expect(String(kbStep.outputSummary)).toContain('网络手册')
    expect(meta.sources.some((s: any) => s.kind === 'device')).toBe(true)
  })

  it('无 meta 历史行读取不 throw（meta 降级 undefined，renderer 走纯文本路径）', () => {
    const msgs = getSessionMessages('no-such-session')
    expect(msgs).toEqual([])
  })
})

describe('28-06 R2 缺陷②：device 来源按设备判重（同设备多命令只计一条）', () => {
  it('同设备两条命令 sources 只一条 device；kb/exp 条目不去重', async () => {
    allowCmd()
    FakeClient.output = 'OK'
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    queueReplies(
      '[CMD:dev1]display version[/CMD] [CMD:dev1]display vlan[/CMD]',
      '再查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '总结'
    )
    const out = await chat([{ role: 'user', content: '查' }], ['dev1'], null)
    const payload = JSON.parse(out)
    const deviceSources = payload.sources.filter((s: any) => s.kind === 'device')
    expect(deviceSources).toHaveLength(1)
    // kb 来源照常（不同文档条目不去重）
    expect(payload.sources.some((s: any) => s.kind === 'kb')).toBe(true)
  })
})

describe('28-06 R2 缺陷⑤：confirm 续跑结果回注（命令输出必须送达 LLM）', () => {
  it('confirm 档：确认执行后续跑 callAI 的回注 user 消息包含命令真实输出', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    allowCmd()
    FakeClient.output = 'Huawei Versatile Routing Platform Software VRP (R) V500R005C10'
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '已拿到版本信息的最终回答'
    )
    const out1 = await chat([{ role: 'user', content: '查版本' }], ['dev1'], null)
    expect(JSON.parse(out1).type).toBe('confirm_required')
    const final = await confirmCommand(JSON.parse(out1).execId, true)
    expect(JSON.parse(final).content).toBe('已拿到版本信息的最终回答')
    // 续跑 callAI（第 2 次）：最后一条 user 消息 = 命令结果回注，必须包含真实输出与命令名
    const msgs = reqMsgs(fetchMock, 1)
    const userMsg = msgs.filter((m: any) => m.role === 'user').pop()
    expect(userMsg.content).toContain('display version')
    expect(userMsg.content).toContain('VRP (R) V500R005C10')
  })

  it('confirm 档多步：两轮确认续跑的累积上下文保留第一轮命令输出', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    allowCmd()
    FakeClient.output = 'Vlan ID: 100'
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '第一轮完成，继续 [CMD:dev1]display vlan[/CMD]',
      '两步都完成的最终回答'
    )
    const out1 = await chat([{ role: 'user', content: '查版本和 vlan' }], ['dev1'], null)
    const out2 = await confirmCommand(JSON.parse(out1).execId, true)
    expect(JSON.parse(out2).type).toBe('confirm_required')
    FakeClient.output = 'VERSION 5.20'
    const final = await confirmCommand(JSON.parse(out2).execId, true)
    expect(JSON.parse(final).content).toBe('两步都完成的最终回答')
    // 第 3 次 callAI：第一轮（display version）与第二轮（display vlan）输出都在累积上下文中
    const msgs3 = reqMsgs(fetchMock, 2)
    const userMsgs = msgs3.filter((m: any) => m.role === 'user')
    expect(userMsgs.some((m: any) => m.content.includes('Vlan ID: 100'))).toBe(true)
    expect(userMsgs.some((m: any) => m.content.includes('VERSION 5.20'))).toBe(true)
  })

  it('成功但零输出：回注落显式 ground 文本（LLM 不得脑补「未获得输出」放弃任务）', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    allowCmd()
    FakeClient.output = '' // 执行成功但设备零输出（data 无内容）
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '收到，继续任务'
    )
    const out1 = await chat([{ role: 'user', content: '查版本' }], ['dev1'], null)
    await confirmCommand(JSON.parse(out1).execId, true)
    const msgs = reqMsgs(fetchMock, 1)
    const userMsg = msgs.filter((m: any) => m.role === 'user').pop()
    expect(userMsg.content).toContain('状态: executed')
    expect(userMsg.content).toContain('设备未返回任何输出文本')
  })
})

describe('28-06 R5 缺陷A：中断轨迹持久化（切会话再切回步骤卡不丢）', () => {
  it('多步任务中断：chat_history.meta_enc 落库且 steps 含已执行步骤 + interrupted 定格 + hardStop', async () => {
    allowCmd()
    const controller = new AbortController()
    let calls = 0
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      calls++
      if (calls === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: '[CMD:dev1]display version[/CMD]' } }] }) }
      }
      // 第 1 步命令已执行、第 2 次 callAI（循环续跑）中被用户停止
      controller.abort()
      if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const out = await chat([{ role: 'user', content: '查版本再查时钟' }], ['dev1'], 'sess-r5-int', undefined, controller.signal)
    const payload = JSON.parse(out)
    expect(payload.hardStop).toBe('user_cancel')
    expect(FakeClient.count).toBe(1)
    // 中断轨迹必须持久化到 meta_enc（历史恢复数据源）
    const row = db.prepare(
      "SELECT meta_enc FROM chat_history WHERE role='assistant' AND session_id=? ORDER BY created_at DESC LIMIT 1"
    ).get('sess-r5-int') as any
    expect(row.meta_enc).toBeTruthy()
    const meta = JSON.parse(decField(row.meta_enc, MK) as string)
    expect(meta.hardStop).toBe('user_cancel')
    expect(meta.steps.some((s: any) => s.actionType === 'cmd' && s.status === 'done')).toBe(true)
    // 全链路：getSessionMessages 读回 meta → renderer 历史恢复重建步骤卡（含 interrupted 定格）
    const msgs = getSessionMessages('sess-r5-int')
    const last = msgs[msgs.length - 1]
    expect(last.meta?.steps).toBeTruthy()
    const restored = last.meta ? historyMessageToChatMsgs({
      id: last.id, role: 'assistant', content: last.content, createdAt: last.createdAt, meta: last.meta,
    }) : []
    const cards = restored.filter((m) => m.toolResult)
    expect(cards.length).toBe((last.meta!.steps as unknown[]).length)
    expect(cards.some((c) => c.toolResult!.stepStatus === 'done')).toBe(true)
  })

  it('首答阶段中断（尚无轨迹）：main 兜底回文中断通知也落库（含空 meta）——切回会话中断说明不丢', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      controller.abort()
      throw new DOMException('This operation was aborted', 'AbortError')
    })
    global.fetch = fetchMock as unknown as typeof fetch
    // chat 直接 throw ChatInterruptedError（main handler 兜底路径）
    await expect(chat([{ role: 'user', content: '你好' }], undefined, 'sess-r5-first', undefined, controller.signal))
      .rejects.toBeInstanceOf(ChatInterruptedError)
  })
})

// ---------- 28-06 R6 用户裁决增强：预取步骤卡可见 + AI 引用归因 ----------

import { PromptService } from '../../../electron/services/promptService'
import { getRegistryEntry } from '../../../electron/services/promptRegistry'

const defaultPromptImpl = PromptService.getPrompt.getMockImplementation()!
const ATTRIBUTION_TEXT = '来源归因：根据经验库《标题》…／知识库文档《标题》指出…，禁止无来源陈述。'

function withAttributionPrompt() {
  vi.mocked(PromptService.getPrompt).mockImplementation((id: string) =>
    id === 'ai.chat.sourceAttribution' ? ATTRIBUTION_TEXT : defaultPromptImpl(id))
}

describe('28-06 R6 增强 a：分档预取生成步骤卡（过程可见，不占步数硬顶）', () => {
  it('knowledge 档预取 kb+exp：每源一张 prefetched 步骤卡（status=done、emit 推送、query/outputSummary 非空）', async () => {
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    const payloads: any[] = []
    queueReplies('初步分析', '最终回答')
    await chat([{ role: 'user', content: 'vlan 原理与排查经验' }], ['dev1'], 'sess-r6-a', (p) => payloads.push(p))
    const preKb = payloads.find((p) => p.actionType === 'kb' && p.prefetched === true && p.stepStatus === 'done')
    const preExp = payloads.find((p) => p.actionType === 'exp' && p.prefetched === true && p.stepStatus === 'done')
    expect(preKb).toBeTruthy()
    expect(preExp).toBeTruthy()
    expect(preKb.argsJson).toContain('vlan 原理与排查经验')
    expect(preKb.resultJson).toContain('命中 1 条')
    expect(preExp.resultJson).toContain('ARP 排查')
  })

  it('预取步不占步数硬顶：agent_max_rounds=1 下预取卡在场，但收尾仍报「第 1 步」（预取不消耗 N）', async () => {
    allowCmd()
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    db.prepare('UPDATE ai_config SET agent_max_rounds = 1').run()
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display clock[/CMD]',
      '【执行进度】收尾报告'
    )
    const out = await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], null)
    const wrapMsg = reqMsgs(fetchMock, 2).filter((m: any) => m.role === 'user').pop()
    expect(wrapMsg.content).toContain('第 1 步')
    const payload = JSON.parse(out)
    // 预取卡在场（kb 命中 + exp 命中各一张）但 rounds 计数不含预取——若预取占步数此处会是「第 3 步」
    expect(payload.steps.filter((s: any) => s.prefetched === true)).toHaveLength(2)
  })

  it('meta_enc 持久化 + 历史恢复：预取步骤随轨迹落库，renderer 重建卡片 prefetched 标志透传', async () => {
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    queueReplies('初步分析', '最终回答')
    await chat([{ role: 'user', content: 'vlan 原理与排查经验' }], ['dev1'], 'sess-r6-c')
    const msgs = getSessionMessages('sess-r6-c')
    const last = msgs[msgs.length - 1]
    expect(last.meta?.steps.some((s: any) => s.prefetched === true)).toBe(true)
    const restored = historyMessageToChatMsgs({
      id: last.id, role: 'assistant', content: last.content, createdAt: last.createdAt, meta: last.meta,
    })
    const preCard = restored.find((m) => m.toolResult?.prefetched === true)
    expect(preCard).toBeTruthy()
    expect(preCard!.toolResult!.stepStatus).toBe('done')
    // Phase 34（34-01，D-07/D-10）：历史重建步骤卡宿主行继承本体消息 DB createdAt（非 now）
    const stepRow = restored.find((m) => m.toolResult)
    expect(stepRow).toBeTruthy()
    expect(typeof stepRow!.createdAt).toBe('string')
    expect(stepRow!.createdAt).toBe(last.createdAt)
  })
})

describe('28-06 R6 增强 b：来源归因指令（预取注入 + 循环内回注双侧）', () => {
  it('registry 含 ai.chat.sourceAttribution 可编辑条目（普通行为指令，无 ⚠ 前缀语义）', () => {
    const entry = getRegistryEntry('ai.chat.sourceAttribution')
    expect(entry).toBeTruthy()
    expect(entry!.content).toContain('经验库《')
    expect(entry!.content).toContain('知识库文档《')
    expect(entry!.content).not.toContain('⚠')
  })

  it('预取注入 user 消息头部含归因指令（[系统预取·分档上下文] 段）', async () => {
    withAttributionPrompt()
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    const fetchMock = queueReplies('回答')
    await chat([{ role: 'user', content: '网络故障排查' }], undefined, null)
    const preMsg = reqMsgs(fetchMock, 0).find((m: any) => m.role === 'user' && m.content.includes('[系统预取·分档上下文]'))
    expect(preMsg).toBeTruthy()
    expect(preMsg.content).toContain(ATTRIBUTION_TEXT)
    expect(preMsg.content.indexOf(ATTRIBUTION_TEXT)).toBeLessThan(preMsg.content.indexOf('相关运维经验'))
  })

  it('循环内 [KB_SEARCH] 回注头部含归因指令（复用同一条目）', async () => {
    withAttributionPrompt()
    allowCmd()
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '总结'
    )
    await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], null)
    const userMsg = reqMsgs(fetchMock, 2).filter((m: any) => m.role === 'user').pop()
    expect(userMsg.content).toContain(ATTRIBUTION_TEXT)
    expect(userMsg.content.indexOf(ATTRIBUTION_TEXT)).toBeLessThan(userMsg.content.indexOf('文档片段'))
  })
})

// ---------- 28-06 R7：循环内检索卡不显示（renderer stepIndex 跨轮覆盖） ----------

import { applyStepCardToMessages } from '../../../src/components/pages/ai/parseAiReply'

describe('28-06 R7 renderer：stepIndex 定位不跨轮（同会话第二轮任务检索卡不被轮 1 卡吞掉）', () => {
  const card = (stepIndex: number, actionType: string, stepStatus = 'done') => ({
    type: 'tool_result', server: 'agent', tool: 'x', deviceName: '',
    argsJson: '', resultJson: '', status: 'success', stepIndex, actionType, stepStatus,
  })

  it('RED 复现：轮 1 已有 stepIndex 0-3 卡，轮 2 同 index 新卡必须追加而非原地覆盖旧卡', () => {
    // 轮 1（多步任务）：预取 0/1 + cmd 2 + kb 3 + 最终回答
    const prev: any[] = [
      { role: 'user', content: '第一轮任务' },
      { role: 'assistant', content: '', toolResult: card(0, 'exp') },
      { role: 'assistant', content: '', toolResult: card(1, 'kb') },
      { role: 'assistant', content: '', toolResult: card(2, 'cmd') },
      { role: 'assistant', content: '', toolResult: card(3, 'kb') },
      { role: 'assistant', content: '第一轮回答' },
      // 轮 2：用户发第二条消息，agent 开始新任务（新 agentState，stepIndex 从 0 重数）
      { role: 'user', content: '第二轮任务' },
    ]
    // 轮 2 预取卡（stepIndex 0）→ 应追加为本轮新卡
    let next = applyStepCardToMessages(prev, card(0, 'exp'))
    expect(next.filter((m: any) => m.toolResult)).toHaveLength(5)
    expect(next[next.length - 1].toolResult.stepIndex).toBe(0)
    // 轮 2 循环内 kb 检索卡（stepIndex 2，running）→ 追加；随后 done 更新同一张（本轮内定位）
    next = applyStepCardToMessages(next, card(2, 'kb', 'running'))
    expect(next.filter((m: any) => m.toolResult)).toHaveLength(6)
    next = applyStepCardToMessages(next, card(2, 'kb', 'done'))
    expect(next.filter((m: any) => m.toolResult)).toHaveLength(6)
    expect(next[next.length - 1].toolResult.stepStatus).toBe('done')
    // 轮 1 的 4 张卡内容零改动（不被跨轮覆盖）
    expect(next[1].toolResult.stepStatus).toBe('done')
    expect(next[3].toolResult.actionType).toBe('cmd')
  })

  it('同轮内状态机不变：running→done 定位更新同一张卡（禁一步两卡）', () => {
    const prev: any[] = [
      { role: 'user', content: '任务' },
      { role: 'assistant', content: '', toolResult: card(0, 'kb', 'running') },
    ]
    const next = applyStepCardToMessages(prev, card(0, 'kb', 'done'))
    expect(next).toHaveLength(2)
    expect(next[1].toolResult.stepStatus).toBe('done')
  })

  it('无 stepIndex 旧 MCP tool_result 载荷：保持追加兼容', () => {
    const legacy: any = {
      type: 'tool_result', server: 'srv', tool: 't', deviceName: 'd',
      argsJson: '{}', resultJson: 'ok', status: 'success',
    }
    const next = applyStepCardToMessages([{ role: 'user', content: 'x' }], legacy)
    expect(next).toHaveLength(2)
    expect(next[1].toolResult).toBe(legacy)
  })
})

// ---------- 28-06 R7：循环内检索卡不显示（动态复现——emit 序列全可见 + stepIndex 唯一） ----------

/**
 * renderer onToolResult 消费逻辑同构模拟：stepIndex 定位更新（倒序找匹配）→ 找不到追加。
 * 返回最终卡片列表（renderer 实际可见形态）——服务层 emit 序列经此函数还原用户所见。
 */
function simulateRendererCards(payloads: any[]): any[] {
  const cards: any[] = []
  for (const p of payloads) {
    if (typeof p.stepIndex === 'number') {
      let hit = false
      for (let i = cards.length - 1; i >= 0; i--) {
        if (cards[i].stepIndex === p.stepIndex) { cards[i] = p; hit = true; break }
      }
      if (!hit) cards.push(p)
    } else {
      cards.push(p)
    }
  }
  return cards
}

describe('28-06 R7：预取卡 + 循环内检索卡全序列可见且 stepIndex 唯一', () => {
  it('auto 档混合任务：预取 2 卡 + 循环 kb 检索卡（running→done）全可见、index 零重复', async () => {
    allowCmd()
    FakeClient.output = 'VRP V500'
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    const payloads: any[] = []
    queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '再查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '最终总结'
    )
    await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], null, (p) => payloads.push(p))
    // 预取 2 卡（kb+exp，prefetched，只 emit 一次终态）
    const preKb = payloads.filter((p) => p.actionType === 'kb' && p.prefetched)
    const preExp = payloads.filter((p) => p.actionType === 'exp' && p.prefetched)
    expect(preKb).toHaveLength(1)
    expect(preExp).toHaveLength(1)
    // 循环内 kb 检索卡：running + done 两态 emit，stepIndex 与预取卡不同
    const loopKb = payloads.filter((p) => p.actionType === 'kb' && !p.prefetched)
    expect(loopKb.map((p) => p.stepStatus)).toEqual(['running', 'done'])
    // 全序列 stepIndex 唯一性（每个 index 恰对应一张卡）
    const cards = simulateRendererCards(payloads)
    const idxes = cards.map((c) => c.stepIndex)
    expect(new Set(idxes).size).toBe(idxes.length)
    // renderer 最终可见：预取 2 张 + 循环 kb 1 张 + cmd 卡
    expect(cards.filter((c) => c.prefetched)).toHaveLength(2)
    expect(cards.some((c) => c.actionType === 'kb' && !c.prefetched && c.stepStatus === 'done')).toBe(true)
    expect(cards.some((c) => c.actionType === 'cmd' && c.stepStatus === 'done')).toBe(true)
  })

  it('confirm 档续跑：续跑循环 kb 检索卡 stepIndex 接续预取卡（不与预取卡同 index 互覆）', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    allowCmd()
    FakeClient.output = 'VRP V500'
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    const payloads: any[] = []
    const emit = (p: any) => payloads.push(p)
    queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '再查资料 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '最终总结'
    )
    const out1 = await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], null, emit)
    expect(JSON.parse(out1).type).toBe('confirm_required')
    // 续跑步骤卡经 agentState.emitStep（chat() 注入的原 emit 引用）继续推送
    const final = await confirmCommand(JSON.parse(out1).execId, true)
    expect(JSON.parse(final).content).toBe('最终总结')
    // 续跑 state 与 chat() state 同引用：预取步在场 + 循环 kb 卡 index 接续不重置
    const cards = simulateRendererCards(payloads)
    const idxes = cards.map((c) => c.stepIndex)
    expect(new Set(idxes).size).toBe(idxes.length)
    expect(cards.filter((c) => c.prefetched)).toHaveLength(2)
    expect(cards.some((c) => c.actionType === 'kb' && !c.prefetched && c.stepStatus === 'done')).toBe(true)
  })

  it('AI 主动换词检索（预取零命中 → 循环内 [EXP_SEARCH]）：循环卡可见且不被预取卡吞掉', async () => {
    allowCmd()
    retrieveForAnswerMock
      .mockResolvedValueOnce({ injected: [] }) // 预取零命中（触发换词引导）
      .mockResolvedValue(EXP_HIT) // 循环内换词命中
    const payloads: any[] = []
    queueReplies(
      '先查设备状态 [CMD:dev1]display interface[/CMD]',
      '换词检索经验 [EXP_SEARCH]接口错误计数[/EXP_SEARCH]',
      '总结'
    )
    await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], null, (p) => payloads.push(p))
    const cards = simulateRendererCards(payloads)
    const idxes = cards.map((c) => c.stepIndex)
    expect(new Set(idxes).size).toBe(idxes.length)
    // 预取 exp 卡（未命中）与循环 exp 卡（命中）各一张，互不覆盖
    expect(cards.filter((c) => c.actionType === 'exp' && c.prefetched)).toHaveLength(1)
    expect(cards.filter((c) => c.actionType === 'exp' && !c.prefetched)).toHaveLength(1)
    expect(cards.some((c) => c.actionType === 'exp' && !c.prefetched && c.stepStatus === 'done')).toBe(true)
  })
})

describe('28-06 R2 缺陷③：confirm 续跑阶段停止有效（signal 贯穿续跑链）', () => {
  it('确认续跑中 cancelChat 能中断：续跑 callAI 被 abort → ChatInterruptedError → 中断收尾回文', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    allowCmd()
    let calls = 0
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      calls++
      if (calls === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: '[CMD:dev1]display version[/CMD]' } }] }) }
      }
      // 续跑 callAI：挂起至 abort（模拟流式/长请求中被用户停止）
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const out1 = await chat([{ role: 'user', content: '查版本' }], ['dev1'], null)
    expect(JSON.parse(out1).type).toBe('confirm_required')
    // 模拟 main handler：注册本窗口控制器后续跑（缺陷③修复前 confirmCommand 不接收 signal）
    cancelChatControllers.clear()
    registerChatCancel(101)
    const c = cancelChatControllers.get(101)!
    const p = confirmCommand(JSON.parse(out1).execId, true, c.signal)
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(2))
    expect(cancelChatForWebContents(101)).toEqual({ success: true })
    const out2 = await p
    const payload = JSON.parse(out2)
    expect(payload.hardStop).toBe('user_cancel')
  })
})

// ---------- 28-06 R8：后置证据补查步骤卡 + 检索路径卡片覆盖审计 ----------

describe('28-06 R8：后置证据补查生成步骤卡（真实检索过程可见）', () => {
  it('troubleshoot 档预取双零命中 → 补查 exp 命中 + kb 未命中：补查卡 backfilled 标志、命中/未命中如实、stepIndex 唯一、meta 持久化', async () => {
    // 预取 exp/kb 双零命中（第 1 次检索），补查 exp 命中（第 2 次）、kb 仍零命中
    retrieveForAnswerMock
      .mockResolvedValueOnce({ injected: [] })
      .mockResolvedValue(EXP_HIT)
    const payloads: any[] = []
    // 预取零命中 → 引导 AI 换词；AI 纯文本收尾不换词 → 补查（callAI：首答 + 补查回注）
    const fetchMock = queueReplies('初步分析', '补查后总结')
    await chat([{ role: 'user', content: '网络故障排查' }], undefined, 'sess-r8-a', (p) => payloads.push(p))
    // 补查命中 → 追加回注轮
    expect(fetchMock.mock.calls.length).toBe(2)
    // 预取卡 2 张（exp/kb 未命中）+ 补查卡 2 张（exp 命中 / kb 未命中）全部 emit
    const preCards = payloads.filter((p) => p.prefetched === true)
    expect(preCards).toHaveLength(2)
    const backfillExp = payloads.find((p) => p.backfilled === true && p.actionType === 'exp' && p.stepStatus === 'done')
    const backfillKb = payloads.find((p) => p.backfilled === true && p.actionType === 'kb' && p.stepStatus === 'done')
    expect(backfillExp).toBeTruthy()
    expect(backfillExp.resultJson).toContain('命中 1 条')
    expect(backfillExp.resultJson).toContain('ARP 排查')
    expect(backfillKb).toBeTruthy()
    expect(backfillKb.resultJson).toContain('未命中')
    // stepIndex 全序列唯一（renderer 同构模拟零互覆）
    const cards = simulateRendererCards(payloads)
    const idxes = cards.map((c) => c.stepIndex)
    expect(new Set(idxes).size).toBe(idxes.length)
    expect(cards.filter((c) => c.backfilled)).toHaveLength(2)
    // 补查步随 meta_enc 持久化（历史恢复可见）+ renderer 透传 backfilled 标志
    const msgs = getSessionMessages('sess-r8-a')
    const last = msgs[msgs.length - 1]
    expect(last.meta?.steps.some((s: any) => s.backfilled === true)).toBe(true)
    const restored = historyMessageToChatMsgs({
      id: last.id, role: 'assistant', content: last.content, createdAt: last.createdAt, meta: last.meta,
    })
    expect(restored.some((m) => m.toolResult?.backfilled === true)).toBe(true)
  })

  it('补查步不占步数硬顶：agent_max_rounds=1 下补查卡在场，收尾仍报「第 1 步」', async () => {
    allowCmd()
    db.prepare('UPDATE ai_config SET agent_max_rounds = 1').run()
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [] } as any)
    const fetchMock = queueReplies(
      '[CMD:dev1]display version[/CMD]',
      '[CMD:dev1]display clock[/CMD]',
      '【执行进度】收尾报告'
    )
    const out = await chat([{ role: 'user', content: '网络故障排查' }], ['dev1'], null)
    const wrapMsg = reqMsgs(fetchMock, 2).filter((m: any) => m.role === 'user').pop()
    expect(wrapMsg.content).toContain('第 1 步')
    const payload = JSON.parse(out)
    expect(payload.steps.some((s: any) => s.backfilled === true)).toBe(true)
  })

  it('inspection 档补查源与分档一致：plan 不含 kb → kbSearch 零调用、零 kb 卡（补查只按 TIER_RETRIEVAL_PLAN）', async () => {
    retrieveForAnswerMock.mockResolvedValue({ injected: [] })
    const payloads: any[] = []
    queueReplies('巡检总结')
    await chat([{ role: 'user', content: '帮我巡检一遍网络情况' }], undefined, null, (p) => payloads.push(p))
    // inspection plan = [exp, device]：exp 预取一次，kb 全链路零检索
    expect(retrieveForAnswerMock).toHaveBeenCalledTimes(2) // 预取 + 补查（exp 缺席补一次）
    expect(vi.mocked(kbSearch)).not.toHaveBeenCalled()
    expect(payloads.some((p) => p.actionType === 'kb')).toBe(false)
    expect(payloads.some((p) => p.backfilled === true && p.actionType === 'exp')).toBe(true)
  })
})

describe('28-06 R8：循环外二段式 KB/EXP 检索生成步骤卡（真实检索过程可见 + 不重复补查）', () => {
  it('AI 主动 [KB_SEARCH]（无 CMD/MCP，不进循环）：检索卡无前缀、命中入 sources、kb 不被补查重复检索', async () => {
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT) // knowledge 档 exp 预取命中 → exp 不缺席
    const payloads: any[] = []
    queueReplies(
      '查文档 [KB_SEARCH]vlan 原理[/KB_SEARCH]',
      '基于文档的回答'
    )
    const out = await chat([{ role: 'user', content: 'vlan 原理与排查经验' }], undefined, null, (p) => payloads.push(p))
    // 预取 kb 1 次 + 二段式 kb 1 次 = 恰 2 次（修复前 sources 不记二段式 → 补查第 3 次重复检索）
    expect(vi.mocked(kbSearch)).toHaveBeenCalledTimes(2)
    // 二段式检索卡：无前缀（AI 主动），stepStatus done，命中概要
    const plainKb = payloads.find((p) => p.actionType === 'kb' && !p.prefetched && !p.backfilled && p.stepStatus === 'done')
    expect(plainKb).toBeTruthy()
    expect(plainKb.argsJson).toBe('vlan 原理')
    expect(plainKb.resultJson).toContain('命中 1 条')
    // exp+kb 双引用在场 → exp_answer 合并契约（wrapAgentFinalPayload 既有优先序）
    expect(JSON.parse(out).type).toBe('exp_answer')
  })

  it('AI 主动 [EXP_SEARCH] 二段式：检索卡 + sources 记录（exp 不被补查重复检索）', async () => {
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any) // kb 预取命中
    const payloads: any[] = []
    queueReplies(
      '查经验 [EXP_SEARCH]ARP 异常[/EXP_SEARCH]',
      '基于经验的回答'
    )
    await chat([{ role: 'user', content: 'vlan 原理与排查经验' }], undefined, null, (p) => payloads.push(p))
    // 预取 exp 1 次 + 二段式 1 次 = 恰 2 次（补查不再第 3 次）
    expect(retrieveForAnswerMock).toHaveBeenCalledTimes(2)
    const plainExp = payloads.find((p) => p.actionType === 'exp' && !p.prefetched && !p.backfilled && p.stepStatus === 'done')
    expect(plainExp).toBeTruthy()
    expect(plainExp.argsJson).toBe('ARP 异常')
    expect(plainExp.resultJson).toContain('ARP 排查')
  })

  it('二段式检索失败（kbSearch throw）：failed 步骤卡如实（检索失败过程可见）', async () => {
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    vi.mocked(kbSearch).mockRejectedValue(new Error('kb down'))
    const payloads: any[] = []
    queueReplies('查文档 [KB_SEARCH]vlan[/KB_SEARCH]')
    await chat([{ role: 'user', content: 'vlan 原理与排查经验' }], undefined, null, (p) => payloads.push(p))
    expect(payloads.some((p) => p.actionType === 'kb' && p.stepStatus === 'failed' && p.status === 'failed')).toBe(true)
  })
})

// ---------- Phase 31（31-02，FIX-02 D-01）：main 侧 ai:toolResult 载荷携带 sessionId ----------
// emitStep 包装注入（chat 作用域 sessionId spread 进 agentStepToToolResultPayload 载荷）——
// 回复进行中切换会话时 renderer 据此归属步骤卡（FIX-02「流式内容不串会话」的地基）。
// runMcpCall 两路注入（直执 ctx.sessionId / 确认续跑 loopCtx.sessionId，T-31-05）由
// mcpAiFlow.test.ts 既有 emit 捕获用例追加断言锁死。

describe('31 FIX-02（31-02）：main 侧 ai:toolResult 载荷携带 sessionId', () => {
  it('chat() 全程 emit 的每张步骤卡载荷均携带传入 sessionId（emitStep 包装注入，含预取/补查/二段式）', async () => {
    // troubleshoot 档（故障排查话术）驱动分档预取 + 收尾补查链路——多源步骤卡全量 emit
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    queueReplies('初步分析', '补查后总结')
    const emitted: any[] = []
    // 第 4 参即 emitToolResult（调用形态参照 electron/main.ts:405 ai:chat handler）
    await chat([{ role: 'user', content: '网络故障排查' }], ['dev1'], 's31-fix02', (p) => { emitted.push(p) })
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.every((p: any) => p.sessionId === 's31-fix02')).toBe(true)
  })

  it('sessionId 缺席（null）——载荷不携带 sessionId 字段（legacy 形态，renderer 归因走回退分支）', async () => {
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    queueReplies('初步分析', '补查后总结')
    const emitted: any[] = []
    await chat([{ role: 'user', content: '网络故障排查' }], ['dev1'], null, (p) => { emitted.push(p) })
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.every((p: any) => p.sessionId === undefined)).toBe(true)
  })
})

// ---------- Phase 31（31-05，FIX-02 候选② / WR-04 option a）：chat() 入口持久化用户消息 ----------
// 31-04 真机裁决 CONFIRMED：用户消息仅在各退出点落库——在途回合中途切回原会话时 DB
// history 不含本轮提问（同会话 msgsCount 6→9 与丢失/恢复时刻一一对应），提问「消失」。
// 31-05 修复：user 行自 chat() 入口（config 校验后、tier 预取/首轮 callAI 前）即落库
//（trim 非空守卫），chat() 内 7 处退出点 user 落库全部移除（防入口+出口双写）。
// 不变量锁死：整轮恰 1 条 user 行 / 中断轮提问不丢 / confirm_required 出口计数。

describe('31-05 候选②：chat() 入口持久化用户消息（WR-04 option a）', () => {
  /** 取指定会话的解密行（role/content 明文，按插入序） */
  function sessionRows(sessionId: string): Array<{ role: string; content: string }> {
    return (db.prepare(
      'SELECT role, content_enc FROM chat_history WHERE session_id = ? ORDER BY rowid'
    ).all(sessionId) as any[]).map((r) => ({ role: r.role, content: decField(r.content_enc, MK) as string }))
  }

  it('正常完成一轮——chat_history 恰 1 条 user 行（content=最后一条 message）+ assistant 行，无重复 user 行（防入口+出口双写）', async () => {
    allowCmd()
    queueReplies('[CMD:dev1]display version[/CMD]', '执行完成总结')
    await chat([{ role: 'user', content: '查状态和资料' }], ['dev1'], 'sess-entry-1')
    const rows = sessionRows('sess-entry-1')
    const userRows = rows.filter((r) => r.role === 'user')
    expect(userRows).toHaveLength(1)
    expect(userRows[0].content).toBe('查状态和资料')
    expect(rows.some((r) => r.role === 'assistant')).toBe(true)
  })

  it('用户中断轮（首答 callAI 中止 → ChatInterruptedError 逃逸 chat()）——user 行已在 DB，提问不丢', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      controller.abort()
      if (controller.signal.aborted) throw new DOMException('This operation was aborted', 'AbortError')
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    await expect(chat(
      [{ role: 'user', content: '中途停止的提问' }], ['dev1'], 'sess-entry-2', undefined, controller.signal
    )).rejects.toBeInstanceOf(ChatInterruptedError)
    const rows = sessionRows('sess-entry-2')
    const userRows = rows.filter((r) => r.role === 'user')
    expect(userRows).toHaveLength(1)
    expect(userRows[0].content).toBe('中途停止的提问')
  })

  it('confirm_required 出口——user 行恰 1 条 + 「等待确认」assistant 行 1 条', async () => {
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    allowCmd()
    queueReplies('[CMD:dev1]display version[/CMD]')
    const out = await chat([{ role: 'user', content: '查版本' }], ['dev1'], 'sess-entry-3')
    expect(JSON.parse(out).type).toBe('confirm_required')
    const rows = sessionRows('sess-entry-3')
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1)
    expect(rows.filter((r) => r.role === 'assistant' && r.content.includes('等待确认'))).toHaveLength(1)
  })
})
