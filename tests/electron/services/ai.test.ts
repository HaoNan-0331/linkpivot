import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Phase 23 Plan 23-02 —— [EXP_SEARCH] 经验库标记协议（D-06/D-07/D-08/D-10）。
 *
 * 覆盖五分支：
 * - 标记提取 + 命中：retrieveForAnswer 以标记内 query 调用 → 经验片段只回注 user-role
 *   消息（不进 system）→ 再调 callAI → 返 exp_answer（expReferences 溯源结构不变，D-08）
 * - 未命中：回注「未检索到相关经验」说明，无 expReferences 空卡片
 * - 异常：strip 标记降级（照 KB catch 形态）
 * - 无标记：不触发经验检索（自动预取移除，D-10）
 * - 资源地图注入：systemPrompt 含 [EXP_SEARCH] 用法说明（D-07，registry 条目恒注入）
 *
 * Mock 策略（mcpAiFlow.test.ts 同款）：connection.getDatabase → :memory: 真库；
 * 重依赖（ssh2/knowledgeBaseService/experienceRetrieval/aiExecLogger/telnet/sshConfig）全 mock。
 */

vi.mock('ssh2', () => ({ Client: class {} }))
vi.mock('../../../electron/services/commandSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/services/commandSafety')>()
  return {
    // tokenizeCommand 用真实现（Phase 27 privilegeGuard 单一 token 源）；isCommandAllowed 可控 mock
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
const RESOURCE_MAP_TEXT = '资源地图测试文本。[EXP_SEARCH] 用法：输出标记查询经验库，优先查经验库。'
const CMD_STYLE_TEXT = '命令风格指引测试文本：服务器用 uname/hostnamectl，网络设备用 show/display。'
vi.mock('../../../electron/services/promptService', () => ({
  PromptService: {
    getPrompt: vi.fn((id: string) =>
      id === 'ai.chat.systemPrompt'
        ? '{{deviceInfo}}{{experienceContext}}'
        : id === 'ai.chat.resourceMap'
          ? RESOURCE_MAP_TEXT
          : id === 'ai.chat.cmdStyle'
            ? CMD_STYLE_TEXT
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
const MK = 'test-mk-23-02'

function makeDb(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE ai_config (
      id TEXT PRIMARY KEY, provider_enc TEXT, api_key_enc TEXT, base_url_enc TEXT, model_name_enc TEXT,
      vision_base_url_enc TEXT, vision_api_key_enc TEXT, vision_model_enc TEXT,
      exec_mode TEXT DEFAULT 'confirm', mcp_max_rounds INTEGER DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE command_whitelist (id TEXT PRIMARY KEY, pattern TEXT NOT NULL UNIQUE);
    CREATE TABLE chat_history (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, content_enc TEXT NOT NULL,
      device_id TEXT, session_id TEXT, meta_enc TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
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
    CREATE TABLE mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL,
      command_or_url TEXT NOT NULL, args_json TEXT, env_json_enc TEXT, credential_enc TEXT,
      enabled INTEGER DEFAULT 1, source TEXT DEFAULT 'manual',
      last_test_at TEXT, last_test_status TEXT, last_test_tool_count INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE mcp_device_rel (id TEXT PRIMARY KEY, mcp_config_id INTEGER NOT NULL, device_id TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE mcp_tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT, config_id INTEGER NOT NULL, tool_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1, skip_confirm INTEGER DEFAULT 0, tool_meta TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(config_id, tool_name)
    );
  `)
  return d
}

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => db,
}))

import { encField } from '../../../electron/utils/crypto'
import { chat, setAiMasterKey, isDeviceExecutable, stripExpKbSearchMarkers } from '../../../electron/services/ai'
import { isCommandAllowed } from '../../../electron/services/commandSafety'
import { AI_QONLY_EXEC_BAN } from '../../../electron/services/promptRegistry'
import { search as kbSearch } from '../../../electron/services/knowledgeBaseService'

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

const EXP_HIT = {
  demoMode: false,
  injected: [
    {
      exp_id: 'exp-1',
      title: 'ARP 表异常排查',
      content: '先 display arp 检查表项',
      source_session_id: 'sess-1',
      unsupported: false,
    },
  ],
  reranked: [],
  finalAnswer: '',
}
const EXP_MISS = { demoMode: false, injected: [], reranked: [], finalAnswer: '' }

beforeEach(() => {
  db = makeDb()
  db.prepare('INSERT INTO ai_config (id, api_key_enc) VALUES (?, ?)').run('cfg1', encField('test-key', MK))
  setAiMasterKey(MK)
  retrieveForAnswerMock.mockReset()
})

describe('EXP_SEARCH 标记协议（Phase 23 23-02）', () => {
  it('命中：query 提取→检索→经验只回注 user-role→再调 callAI→exp_answer 溯源保留（D-06/D-08）', async () => {
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    const fetchMock = queueReplies(
      '让我查经验库 [EXP_SEARCH]ARP 异常[/EXP_SEARCH]',
      '根据经验：先 display arp 检查表项。'
    )
    const out = await chat([{ role: 'user', content: 'ARP 表异常怎么排查' }], ['dev1'], null)
    // query 以标记内文本调用（deviceIds 透传）
    expect(retrieveForAnswerMock).toHaveBeenCalledWith({ userMessage: 'ARP 异常', deviceIds: ['dev1'] })
    // 第二次 callAI 请求体：经验片段只在 user-role 消息，绝不进 system
    const second = JSON.parse((fetchMock.mock.calls[1][1] as any).body)
    expect(second.messages[0].role).toBe('system')
    expect(second.messages[0].content).not.toContain('display arp 检查表项')
    const userMsgs = second.messages.filter((m: any) => m.role === 'user')
    expect(userMsgs.some((m: any) => m.content.includes('ARP 表异常排查') && m.content.includes('不要包含 [EXP_SEARCH]'))).toBe(true)
    // 返 exp_answer：content=最终回复，references 结构不变（D-08）
    const payload = JSON.parse(out)
    expect(payload.type).toBe('exp_answer')
    expect(payload.content).toBe('根据经验：先 display arp 检查表项。')
    expect(payload.references).toHaveLength(1)
    expect(payload.references[0]).toMatchObject({
      kind: 'experience', expId: 'exp-1', title: 'ARP 表异常排查', sourceSessionId: 'sess-1', unsupported: false,
    })
  })

  it('未命中：回注未检到说明，无 expReferences 空卡片', async () => {
    retrieveForAnswerMock.mockResolvedValue(EXP_MISS)
    const fetchMock = queueReplies(
      '查一下 [EXP_SEARCH]冷门问题[/EXP_SEARCH]',
      '经验库中暂无相关经验，基于已有知识回答。'
    )
    const out = await chat([{ role: 'user', content: '冷门问题' }], ['dev1'], null)
    const second = JSON.parse((fetchMock.mock.calls[1][1] as any).body)
    expect(second.messages.some(
      (m: any) => m.role === 'user' && m.content.includes('未找到与"冷门问题"相关的经验')
    )).toBe(true)
    // 纯文本收尾，不是 exp_answer JSON
    expect(out).toBe('经验库中暂无相关经验，基于已有知识回答。')
    expect(out).not.toContain('exp_answer')
  })

  it('异常：strip 标记降级，原回复去标记后直接返回（照 KB catch 形态）', async () => {
    retrieveForAnswerMock.mockRejectedValue(new Error('检索挂了'))
    const fetchMock = queueReplies('分析中 [EXP_SEARCH]任意词[/EXP_SEARCH] 后文')
    const out = await chat([{ role: 'user', content: '问题' }], ['dev1'], null)
    expect(fetchMock.mock.calls.length).toBe(1) // 无第二次 callAI
    expect(out).toBe('分析中  后文')
    expect(out).not.toContain('[EXP_SEARCH]')
  })

  it('无标记：循环外不再触发经验检索——28-04 分档强制预取按代码层矩阵执行（AGENT-01 取代 D-10）', async () => {
    queueReplies('普通回答，无标记')
    const out = await chat([{ role: 'user', content: '你好' }], ['dev1'], null)
    // 28-04：classifyTier('你好')=knowledge → 预取矩阵 exp+kb，检索由代码层发起（不经模型打标）
    expect(retrieveForAnswerMock).toHaveBeenCalledWith({ userMessage: '你好', deviceIds: ['dev1'] })
    expect(out).toBe('普通回答，无标记')
  })

  it('资源地图注入：systemPrompt 恒含 [EXP_SEARCH] 用法说明（D-07 registry 条目）', async () => {
    const fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '你好' }], ['dev1'], null)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body)
    expect(body.messages[0].content).toContain(RESOURCE_MAP_TEXT)
    expect(body.messages[0].content).toContain('[EXP_SEARCH] 用法')
  })
})

// ---------- Phase 23 Plan 23-03 —— CMD 白名单防御 + 能力声明注入（D-03/D-04/D-05） ----------

/** 插入设备（connectionType=null → capabilities 三布尔全 false → 仅问答） */
function insertDevice(id: string, name: string, connectionType: string | null) {
  db.prepare(
    'INSERT INTO devices (id, name_enc, ip_enc, connection_type) VALUES (?, ?, ?, ?)'
  ).run(id, encField(name, MK), encField('10.0.0.1', MK), connectionType)
}

describe('CMD 白名单防御 + 能力声明注入（Phase 23 23-03）', () => {
  afterEach(() => {
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: false, reason: 'mock 拒绝' } as any)
  })

  it('isDeviceExecutable 矩阵：ssh/telnet 可执行，三布尔全 false、capabilities 缺失、null 均 fail-closed 不可执行（D-04）', () => {
    expect(isDeviceExecutable({ capabilities: { hasSSH: true, hasTelnet: false, hasMcp: false } })).toBe(true)
    expect(isDeviceExecutable({ capabilities: { hasSSH: false, hasTelnet: true, hasMcp: false } })).toBe(true)
    expect(isDeviceExecutable({ capabilities: { hasSSH: false, hasTelnet: false, hasMcp: true } })).toBe(false)
    expect(isDeviceExecutable({ capabilities: undefined })).toBe(false)
    expect(isDeviceExecutable(null)).toBe(false)
  })

  it('单台仅问答设备打 [CMD]：白名单拦截 → 回注「无执行通道」说明重试一次（点名设备），干净回复收尾（D-04）', async () => {
    insertDevice('q1', '仅问答机', null)
    const fetchMock = queueReplies(
      '我来执行 [CMD:仅问答机] display version[/CMD]',
      '该设备无命令执行通道，无法执行，仅可基于知识库作答。'
    )
    const out = await chat([{ role: 'user', content: '查版本' }], ['q1'], null)
    expect(fetchMock.mock.calls.length).toBe(2) // 回注重试恰好一次
    const second = JSON.parse((fetchMock.mock.calls[1][1] as any).body)
    const promptMsg = second.messages.find(
      (m: any) => m.role === 'user' && m.content.includes('无命令执行通道')
    )
    expect(promptMsg).toBeTruthy()
    expect(promptMsg.content).toContain('仅问答机') // 点名设备 + 原因
    expect(out).toBe('该设备无命令执行通道，无法执行，仅可基于知识库作答。')
    expect(out).not.toContain('[CMD')
  })

  it('顽固再犯：重试后仍对仅问答设备打标 → strip 标记收尾，命令不进执行/确认流（D-04）', async () => {
    insertDevice('q1', '仅问答机', null)
    const fetchMock = queueReplies(
      '顽固 [CMD:仅问答机] display version[/CMD]',
      '再犯 [CMD:仅问答机] display clock[/CMD]'
    )
    const out = await chat([{ role: 'user', content: '查时间' }], ['q1'], null)
    expect(fetchMock.mock.calls.length).toBe(2) // 只重试一次，不再无限回注
    expect(out).toBe('再犯') // 标记被 strip，命令未执行
    expect(out).not.toContain('[CMD')
  })

  it('混选并存：[CMD:可执行A] 入确认流、[CMD:仅问答B] 被拒并显式回传（D-05 非整单拒绝）', async () => {
    insertDevice('a1', '可执行A', 'ssh')
    insertDevice('b1', '仅问答B', null)
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: true, reason: '' } as any)
    const fetchMock = queueReplies('[CMD:可执行A] display version[/CMD] [CMD:仅问答B] display arp[/CMD]')
    const out = await chat([{ role: 'user', content: '批量查询' }], ['a1', 'b1'], null)
    expect(fetchMock.mock.calls.length).toBe(1) // 混选不回注重试
    const payload = JSON.parse(out)
    expect(payload.type).toBe('confirm_required')
    expect(payload.commands).toHaveLength(1)
    expect(payload.commands[0].deviceName).toBe('可执行A')
    const rejected = payload.rejectedCommands.find((r: any) => r.command === 'display arp')
    expect(rejected).toBeTruthy()
    expect(rejected.reason).toContain('无命令执行通道')
  })

  it('不存在设备名：既有拒绝路径不变（未找到指定设备，不因白名单改造回退）', async () => {
    insertDevice('a1', '可执行A', 'ssh')
    queueReplies('[CMD:幽灵设备] display version[/CMD]')
    const out = await chat([{ role: 'user', content: '查版本' }], ['a1'], null)
    expect(out).toContain('未找到指定设备: 幽灵设备')
    expect(out).toContain('被拒绝')
  })

  it('能力声明注入：单台仅问答含能力说明 + 硬区禁止令；混选含跳过语义与点名；全可执行均不出现（D-03/D-05）', async () => {
    // 单台仅问答
    insertDevice('q1', '仅问答机', null)
    let fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '你好' }], ['q1'], null)
    let sys = JSON.parse((fetchMock.mock.calls[0][1] as any).body).messages[0].content
    expect(sys).toContain('能力说明')
    expect(sys).toContain('仅问答机')
    expect(sys).toContain(AI_QONLY_EXEC_BAN) // 硬区拒绝执行指令拼接注入

    // 混选：跳过语义 + 点名仅问答设备
    db = makeDb()
    db.prepare('INSERT INTO ai_config (id, api_key_enc) VALUES (?, ?)').run('cfg1', encField('test-key', MK))
    insertDevice('a1', '可执行A', 'ssh')
    insertDevice('q1', '仅问答机', null)
    fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '你好' }], ['a1', 'q1'], null)
    sys = JSON.parse((fetchMock.mock.calls[0][1] as any).body).messages[0].content
    expect(sys).toContain('仅问答机')
    expect(sys).toContain('跳过')
    expect(sys).toContain(AI_QONLY_EXEC_BAN)

    // 全可执行：均不注入（提示词干净）
    db = makeDb()
    db.prepare('INSERT INTO ai_config (id, api_key_enc) VALUES (?, ?)').run('cfg1', encField('test-key', MK))
    insertDevice('a1', '可执行A', 'ssh')
    fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '你好' }], ['a1'], null)
    sys = JSON.parse((fetchMock.mock.calls[0][1] as any).body).messages[0].content
    expect(sys).not.toContain('能力说明')
    expect(sys).not.toContain(AI_QONLY_EXEC_BAN)
  })
})

// ---------- Phase 23（23-03 复验反馈）—— 服务器类设备命令适配 ----------

/** 插入带类型设备（device_type 注入断言用） */
function insertTypedDevice(id: string, name: string, deviceType: string, connectionType: string | null) {
  db.prepare(
    'INSERT INTO devices (id, name_enc, ip_enc, device_type, connection_type) VALUES (?, ?, ?, ?, ?)'
  ).run(id, encField(name, MK), encField('10.0.0.1', MK), deviceType, connectionType)
}

describe('设备类型注入 + 命令风格指引（Phase 23 23-03 复验反馈）', () => {
  it('单台服务器：deviceInfo 含「类型: 服务器」，命令风格指引注入', async () => {
    insertTypedDevice('srv1', 'kali', 'server', 'ssh')
    const fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '查询版本信息' }], ['srv1'], null)
    const sys = JSON.parse((fetchMock.mock.calls[0][1] as any).body).messages[0].content
    expect(sys).toContain('类型: 服务器')
    expect(sys).toContain(CMD_STYLE_TEXT)
  })

  it('混选服务器+路由器：多台段各自标注类型（中文映射），网络设备为「类型: 路由器」', async () => {
    insertTypedDevice('srv1', 'kali', 'server', 'ssh')
    insertTypedDevice('r1', '核心路由', 'router', 'ssh')
    const fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '查询所有设备的版本信息' }], ['srv1', 'r1'], null)
    const sys = JSON.parse((fetchMock.mock.calls[0][1] as any).body).messages[0].content
    expect(sys).toContain('类型: 服务器')
    expect(sys).toContain('类型: 路由器')
    expect(sys).toContain(CMD_STYLE_TEXT)
  })

  it('未分类兜底：device_type 为空 → 「类型: 未分类」', async () => {
    db.prepare(
      'INSERT INTO devices (id, name_enc, ip_enc, connection_type) VALUES (?, ?, ?, ?)'
    ).run('g1', encField('裸机', MK), encField('10.0.0.9', MK), 'ssh')
    const fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '查版本' }], ['g1'], null)
    const sys = JSON.parse((fetchMock.mock.calls[0][1] as any).body).messages[0].content
    expect(sys).toContain('类型: 未分类')
  })

  it('无目标设备：命令风格指引不注入（提示词干净）', async () => {
    const fetchMock = queueReplies('好的')
    await chat([{ role: 'user', content: '你好' }], undefined, null)
    const sys = JSON.parse((fetchMock.mock.calls[0][1] as any).body).messages[0].content
    expect(sys).not.toContain(CMD_STYLE_TEXT)
  })
})

// ---------- Phase 23 code-review 回归（WR-02 ~ WR-06） ----------

const KB_ROWS = {
  rows: [
    { content: 'ARP 表异常时先查接口计数。', document: { title: '排障手册' }, title: 'ARP 章节', document_id: 'doc1', images: [] },
  ],
}

describe('Phase 23 code-review 回归（WR-02 ~ WR-06）', () => {
  afterEach(() => {
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: false, reason: 'mock 拒绝' } as any)
    vi.mocked(kbSearch).mockReset()
    vi.mocked(kbSearch).mockResolvedValue({ rows: [] } as any)
  })

  it('WR-02：KB+EXP 同轮命中，EXP 回注历史含 KB 轮 user 消息且 assistant 轮用改写后回复（自洽）', async () => {
    vi.mocked(kbSearch).mockResolvedValue(KB_ROWS as any)
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    insertDevice('a1', '可执行A', 'ssh')
    const fetchMock = queueReplies(
      '先查文档 [KB_SEARCH]ARP 异常[/KB_SEARCH]',
      '根据文档：查接口计数。再查经验 [EXP_SEARCH]ARP 异常[/EXP_SEARCH]',
      '综合文档与经验：先 display arp 再查接口计数。'
    )
    const out = await chat([{ role: 'user', content: 'ARP 异常怎么排查' }], ['a1'], null)
    // 第三次 callAI 上下文：KB 轮 user 消息 + assistant 轮为 KB 改写后回复 + EXP user 消息
    const third = JSON.parse((fetchMock.mock.calls[2][1] as any).body)
    expect(third.messages.some((m: any) => m.role === 'user' && m.content.includes('资料库检索到的相关文档片段'))).toBe(true)
    expect(third.messages.some((m: any) => m.role === 'assistant' && m.content.includes('根据文档：查接口计数'))).toBe(true)
    expect(third.messages.some((m: any) => m.role === 'user' && m.content.includes('经验库中检索到的相关经验'))).toBe(true)
    // 混合 references：kb + experience（Phase 11 WR-01 合并路径）
    const payload = JSON.parse(out)
    expect(payload.type).toBe('exp_answer')
    expect(payload.references).toHaveLength(2)
  })

  it('WR-03：二次回复仍含 [EXP_SEARCH] 标记 → fail-safe 剥离，气泡零残留', async () => {
    retrieveForAnswerMock.mockResolvedValue(EXP_MISS)
    queueReplies(
      '查经验 [EXP_SEARCH]q[/EXP_SEARCH]',
      '结果 [EXP_SEARCH]再查一个[/EXP_SEARCH] 收尾'
    )
    const out = await chat([{ role: 'user', content: '问题' }], ['dev1'], null)
    expect(out).not.toContain('[EXP_SEARCH]')
    expect(out).not.toContain('[&#91;EXP_SEARCH&#93;')
    expect(out).toContain('结果')
    expect(out).toContain('收尾')
  })

  it('WR-04：命令全拒路径用最终回复 + 补 expReferences 包装（断流修复）', async () => {
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    insertDevice('a1', '可执行A', 'ssh')
    // 默认 isCommandAllowed mock = 拒绝
    queueReplies(
      '先查经验 [EXP_SEARCH]ARP 异常[/EXP_SEARCH]',
      '根据经验分析如下 [CMD:可执行A] display version[/CMD]'
    )
    const out = await chat([{ role: 'user', content: '查版本' }], ['a1'], null)
    const payload = JSON.parse(out)
    expect(payload.type).toBe('exp_answer')
    expect(payload.content).toContain('根据经验分析如下')
    expect(payload.content).toContain('被拒绝')
    expect(payload.content).not.toContain('[EXP_SEARCH]')
    expect(payload.references).toHaveLength(1)
  })

  it('WR-06：confirm 弹窗 aiExplanation 用最终回复（无 EXP 标记残留）', async () => {
    retrieveForAnswerMock.mockResolvedValue(EXP_HIT)
    insertDevice('a1', '可执行A', 'ssh')
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: true, reason: '' } as any)
    queueReplies(
      '先查经验 [EXP_SEARCH]ARP 异常[/EXP_SEARCH]',
      '基于经验建议执行 [CMD:可执行A] display version[/CMD]'
    )
    const out = await chat([{ role: 'user', content: '查版本' }], ['a1'], null)
    const payload = JSON.parse(out)
    expect(payload.type).toBe('confirm_required')
    expect(payload.aiExplanation).toBe('基于经验建议执行 [CMD:可执行A] display version[/CMD]')
    expect(payload.aiExplanation).not.toContain('[EXP_SEARCH]')
  })

  it('stripExpKbSearchMarkers 单元：完整段/未闭合开标签/孤立闭合标签三层剥离（WR-03/WR-05）', () => {
    expect(stripExpKbSearchMarkers('前 [EXP_SEARCH]kw[/EXP_SEARCH] 后')).toBe('前  后')
    expect(stripExpKbSearchMarkers('前 [KB_SEARCH]kw[/KB_SEARCH] 后')).toBe('前  后')
    expect(stripExpKbSearchMarkers('未闭合 [EXP_SEARCH]kw 到行尾\n第二行')).toBe('未闭合 第二行')
    expect(stripExpKbSearchMarkers('孤立闭合 [/EXP_SEARCH] 残留')).toBe('孤立闭合  残留')
    expect(stripExpKbSearchMarkers('干净回复')).toBe('干净回复')
  })
})

// ---------- Phase 27 Plan 27-03 —— privilegeGuard 四接入点接线 ----------

import { createLog as createLogMock, updateLogGuardOutcome as updateLogGuardOutcomeMock } from '../../../electron/services/aiExecLogger'
import { confirmCommand, executeCommandsOnDevice } from '../../../electron/services/ai'

/** 插入带独立 IP 的设备（GUARD 检测需明文 IP 投影） */
function insertGuardDevice(id: string, name: string, ip: string, connectionType: string) {
  db.prepare(
    'INSERT INTO devices (id, name_enc, ip_enc, connection_type) VALUES (?, ?, ?, ?)'
  ).run(id, encField(name, MK), encField(ip, MK), connectionType)
}

describe('privilegeGuard 接入（Phase 27 27-03）', () => {
  afterEach(() => {
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: false, reason: 'mock 拒绝' } as any)
    vi.mocked(createLogMock).mockClear()
    vi.mocked(updateLogGuardOutcomeMock).mockClear()
  })

  it('R18 语义：auto 模式 GUARD-02 命中仍走挂起路径——confirm_required 带 guardInfo，createLog status=pending + guardHits（D-06）', async () => {
    insertGuardDevice('ga', 'GuardA', '10.0.0.1', 'ssh')
    insertGuardDevice('gb', 'GuardB', '10.0.0.2', 'ssh')
    db.prepare("UPDATE ai_config SET exec_mode = 'auto'").run()
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: true, reason: '' } as any)
    queueReplies('执行 [CMD:GuardA] ssh 10.0.0.2[/CMD]')
    const out = await chat([{ role: 'user', content: '跳到 GuardB' }], ['ga'], null)
    const payload = JSON.parse(out)
    expect(payload.type).toBe('confirm_required')
    expect(payload.guardInfo).toBeTruthy()
    expect(payload.guardInfo.expectedTarget).toBe('GuardA')
    expect(payload.guardInfo.hits[0].ruleId).toBe('GUARD-02')
    expect(payload.guardInfo.hits[0].level).toBe('red')
    // 审计：guardHits 落库 + status 强制 pending（auto 不再直执）
    expect(createLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      mode: 'auto',
      guardHits: expect.arrayContaining([expect.objectContaining({ ruleId: 'GUARD-02' })]),
    }))
  })

  it('混批分区：1 条命中 + 1 条普通 → hitCommandIndexes 与 hits 对齐且指向命中命令下标（checkpoint 方案 A）', async () => {
    insertGuardDevice('ga', 'GuardA', '10.0.0.1', 'ssh')
    insertGuardDevice('gb', 'GuardB', '10.0.0.2', 'ssh')
    db.prepare("UPDATE ai_config SET exec_mode = 'auto'").run()
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: true, reason: '' } as any)
    // 第 1 条命中 GUARD-02，第 2 条普通
    queueReplies('执行 [CMD:GuardA] ssh 10.0.0.2[/CMD] 和 [CMD:GuardA] display version[/CMD]')
    const out = await chat([{ role: 'user', content: '跳到 GuardB 并查版本' }], ['ga'], null)
    const payload = JSON.parse(out)
    expect(payload.type).toBe('confirm_required')
    expect(payload.commands).toHaveLength(2)
    expect(payload.guardInfo).toBeTruthy()
    expect(payload.guardInfo.hits).toHaveLength(1)
    // hitCommandIndexes 与 hits 对齐，指向命中命令在 commands 中的索引（0）
    expect(payload.guardInfo.hitCommandIndexes).toHaveLength(1)
    expect(payload.guardInfo.hitCommandIndexes[0]).toBe(0)
    expect(payload.commands[0].command).toContain('ssh 10.0.0.2')
  })

  it('auto 模式无命中：行为不变——不弹 confirm_required（guardHits 不落库）', async () => {
    insertGuardDevice('ga', 'GuardA', '10.0.0.1', 'ssh')
    db.prepare("UPDATE ai_config SET exec_mode = 'auto'").run()
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: true, reason: '' } as any)
    // display version 非 JUMP/PROBE、无已知设备参数 → 无命中；执行走 mock ssh（连接失败填 failed 不弹窗），
    // 需第二笔回复供结果回注追评（否则空回复在 saveChatMessage 抛错）
    queueReplies('执行 [CMD:GuardA] display version[/CMD]', '执行结果已分析完毕')
    const out = await chat([{ role: 'user', content: '查版本' }], ['ga'], null)
    expect(out).not.toContain('confirm_required')
    expect(createLogMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      mode: 'auto',
      guardHits: undefined,
    }))
  })

  it('confirmCommand 确认/取消：guard 命中 logId 落 user_confirmed/user_cancelled（T-27-11），未命中批次不写 outcome', async () => {
    insertGuardDevice('ga', 'GuardA', '10.0.0.1', 'ssh')
    insertGuardDevice('gb', 'GuardB', '10.0.0.2', 'ssh')
    db.prepare("UPDATE ai_config SET exec_mode = 'confirm'").run()
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: true, reason: '' } as any)
    queueReplies('执行 [CMD:GuardA] ssh 10.0.0.2[/CMD]', '取消确认后的回复')
    const out = await chat([{ role: 'user', content: '跳到 GuardB' }], ['ga'], null)
    const batchId = JSON.parse(out).execId
    // 取消：guard 命中行落 user_cancelled
    await confirmCommand(batchId, false)
    expect(updateLogGuardOutcomeMock).toHaveBeenCalledWith('log-1', 'user_cancelled')
    vi.mocked(updateLogGuardOutcomeMock).mockClear()
    // 再造一批走确认分支（追加一笔回复供结果回注追评）
    queueReplies('执行 [CMD:GuardA] ssh 10.0.0.2[/CMD]', '执行结果已分析')
    const out2 = await chat([{ role: 'user', content: '再跳一次' }], ['ga'], null)
    const batchId2 = JSON.parse(out2).execId
    // 确认：guard 命中行落 user_confirmed；执行层 guardApproved=true 放行（mock ssh 连接失败由 try/catch 填 failed）
    await confirmCommand(batchId2, true)
    expect(updateLogGuardOutcomeMock).toHaveBeenCalledWith('log-1', 'user_confirmed')
  })

  it('executeCommandsOnDevice 兜底重检：无 guardApproved 标记且命中 → 拒绝执行（T-27-08/Pitfall 4）', async () => {
    insertGuardDevice('ga', 'GuardA', '10.0.0.1', 'ssh')
    insertGuardDevice('gb', 'GuardB', '10.0.0.2', 'ssh')
    vi.mocked(isCommandAllowed).mockReturnValue({ allowed: true, reason: '' } as any)
    const results = await executeCommandsOnDevice(
      { id: 'ga', name: 'GuardA', ipAddress: '10.0.0.1', connectionType: 'ssh' },
      ['ssh 10.0.0.2'],
    )
    expect(results[0].success).toBe(false)
    expect(results[0].output).toContain('越权防线拦截')
    // guardApproved=true（用户已确认批次）→ 放行重检（防无限弹窗），执行进入 ssh 连接阶段：
    // mock ssh2 Client（空 class）在 client.on 处同步抛错 → 首条 reject 整批（证明已越过 guard 拦截层）
    await expect(executeCommandsOnDevice(
      { id: 'ga', name: 'GuardA', ipAddress: '10.0.0.1', connectionType: 'ssh' },
      ['ssh 10.0.0.2'],
      { guardApproved: true },
    )).rejects.toThrow()
  })
})
