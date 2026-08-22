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
  `)
  d.prepare('INSERT INTO ai_config (id, api_key_enc, exec_mode) VALUES (?, ?, ?)').run(
    'cfg1', encField('test-key', MK), execMode
  )
  return d
}

vi.mock('../../../electron/database/connection', () => ({
  getDatabase: () => db,
}))

import { encField } from '../../../electron/utils/crypto'
import {
  chat, confirmCommand, setAiMasterKey,
  normalizeAgentKey, callAIWithUsage,
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
