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
              ? '三源冲突标注（D-10）：经验库/资料库/设备实时输出不一致时，正文内联「⚠ X 与 Y 不一致」并在末尾输出冲突清单，禁止静默取舍。'
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
  getChatHistory, buildAgentMeta,
} from '../../../electron/services/ai'
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
