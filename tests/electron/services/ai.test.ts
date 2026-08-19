import { describe, it, expect, beforeEach, vi } from 'vitest'
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
vi.mock('../../../electron/services/commandSafety', () => ({
  isCommandAllowed: vi.fn().mockReturnValue({ allowed: false, reason: 'mock 拒绝' }),
}))
vi.mock('../../../electron/services/aiExecLogger', () => ({
  createLog: vi.fn().mockReturnValue('log-1'),
  updateLogStatus: vi.fn(),
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
vi.mock('../../../electron/services/promptService', () => ({
  PromptService: {
    getPrompt: vi.fn((id: string) =>
      id === 'ai.chat.systemPrompt'
        ? '{{deviceInfo}}{{experienceContext}}'
        : id === 'ai.chat.resourceMap'
          ? RESOURCE_MAP_TEXT
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
      device_id TEXT, session_id TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
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
import { chat, setAiMasterKey } from '../../../electron/services/ai'

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

  it('无标记：不触发经验检索（自动预取彻底移除，D-10）', async () => {
    queueReplies('普通回答，无标记')
    const out = await chat([{ role: 'user', content: '你好' }], ['dev1'], null)
    expect(retrieveForAnswerMock).not.toHaveBeenCalled()
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
