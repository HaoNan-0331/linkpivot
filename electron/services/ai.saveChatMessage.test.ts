import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * saveChatMessage 空内容守卫测试（debug: chat_history.content_enc NOT NULL 崩溃）。
 *
 * 背景：用户问「关于公司的经验」时 AI 首回纯 [KB_SEARCH] 标签，chat() KB 分支 follow-up callAI
 * 撞 deepseek 连接超时 → catch（ai.ts:776-778）把标签剥光成 '' → saveChatMessage('assistant','')
 * → encField('') 返回 null → 撞 chat_history.content_enc NOT NULL，错误信息「数据库约束失败」
 * 完全误导（真因是网络超时）。
 *
 * 修复：saveChatMessage 入口对空内容（空串/纯空格/null/undefined）抛清晰错误，不进 INSERT。
 *
 * Mock 策略（与 ai.telnetRouting.test.ts 一致——mock 掉 native/重依赖让 ai.ts 干净加载）：
 * - getDatabase → prepare/run spy（验证空内容时不调 prepare、正常内容时调一次）
 * - ssh2 / telnetExec / commandSafety → 桩，避免 native 加载（saveChatMessage 不触达，仅为模块加载）
 * - crypto 不 mock：让真实 encField 跑（MK 经 setAiMasterKey 注入），证明正常消息加密+入库链路不被守卫误伤。
 */

const prepareRun = vi.fn()
const prepareFn = vi.fn(() => ({ run: prepareRun }))

vi.mock('../database/connection', () => ({
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

vi.mock('../utils/telnetExec', () => ({
  executeTelnetCommand: vi.fn(),
  pickDisablePaginationCmd: vi.fn(),
  pickShellPrompt: vi.fn(),
}))

vi.mock('./commandSafety', () => ({
  isCommandAllowed: () => ({ allowed: true, reason: '' }),
}))

import { saveChatMessage, setAiMasterKey } from './ai'

describe('saveChatMessage 空内容守卫', () => {
  beforeEach(() => {
    prepareRun.mockClear()
    prepareFn.mockClear()
    setAiMasterKey('test-key-for-saveChatMessage-guard')
  })

  it('空串抛清晰错误且不进 INSERT', () => {
    expect(() => saveChatMessage('assistant', '', null, 's1')).toThrow(/无法保存空消息内容/)
    expect(prepareFn).not.toHaveBeenCalled()
  })

  it('纯空格抛清晰错误（trim 后判定为空）', () => {
    expect(() => saveChatMessage('assistant', '   ', null, 's1')).toThrow(/无法保存空消息内容/)
    expect(prepareFn).not.toHaveBeenCalled()
  })

  it('null content 抛清晰错误', () => {
    expect(() => saveChatMessage('assistant', null as unknown as string, null, 's1')).toThrow(
      /无法保存空消息内容/,
    )
    expect(prepareFn).not.toHaveBeenCalled()
  })

  it('undefined content 抛清晰错误', () => {
    expect(() => saveChatMessage('assistant', undefined as unknown as string, null, 's1')).toThrow(
      /无法保存空消息内容/,
    )
    expect(prepareFn).not.toHaveBeenCalled()
  })

  it('正常消息不抛 + 进 INSERT（prepare.run 调一次）—— 控制组', () => {
    expect(() => saveChatMessage('user', '正常消息内容', null, 's1')).not.toThrow()
    expect(prepareFn).toHaveBeenCalledTimes(1)
    expect(prepareRun).toHaveBeenCalledTimes(1)
  })
})
