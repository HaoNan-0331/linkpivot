import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * experienceDrafting 编排 service 单测（Phase 8 Plan 03，W-3）。
 *
 * 覆盖 5 case（SC1/SC5 + B-1/B-2 透传 + demoMode）：
 * (a) SC5 追加不覆盖：同 sessionId 两次 summarize 各生独立行
 * (b) sourceSessionId 透传：createExperience 入参含 sourceSessionId === sessionId
 * (c) NOOP 不落库：mock drafts 含 NOOP，断言 createExperience 调用 0 次
 * (d) UPDATE 透传 dup_id：createExperience 入参含 duplicateOfExpId='exp-old-1'
 * (e) demoMode：getAiConfig 返 null → 不调 draftSession，返 empty + demoMode=true
 *
 * mock 三层依赖：ai（getChatHistory/getAiConfig）+ draftingService（draftSession/judgeVerdicts）+
 * duplicateDetector（findExistingForDraft）+ experienceService（createExperience/relateDevice）+ piiMask。
 * 透传 piiMask（t => t）——本 service 测试不验脱敏细节，脱敏由 Plan 01 单测覆盖。
 */

vi.mock('./ai', () => ({
  getChatHistory: vi.fn(),
  getAiConfig: vi.fn(),
}))

vi.mock('./draftingService', () => ({
  draftSession: vi.fn(),
  judgeVerdicts: vi.fn(),
  MAX_DRAFT_RETRIES: 3,
}))

vi.mock('./duplicateDetector', () => ({
  findExistingForDraft: vi.fn(),
}))

vi.mock('./experienceService', () => ({
  createExperience: vi.fn(),
  relateDevice: vi.fn(),
}))

vi.mock('../utils/piiMask', () => ({
  maskConversationText: vi.fn((t: string) => t),
}))

import { getChatHistory, getAiConfig } from './ai'
import { draftSession, judgeVerdicts } from './draftingService'
import { findExistingForDraft } from './duplicateDetector'
import { createExperience, relateDevice } from './experienceService'
import { summarizeSessionForUi } from './experienceDrafting'

const mockedGetChatHistory = vi.mocked(getChatHistory)
const mockedGetAiConfig = vi.mocked(getAiConfig)
const mockedDraftSession = vi.mocked(draftSession)
const mockedJudgeVerdicts = vi.mocked(judgeVerdicts)
const mockedFindExisting = vi.mocked(findExistingForDraft)
const mockedCreateExperience = vi.mocked(createExperience)
const mockedRelateDevice = vi.mocked(relateDevice)

/** 单条 user/assistant 会话明文（任意非空）。 */
const SAMPLE_MSGS = [
  { id: 'm1', role: 'user', content: '核心交换机 ARP 表满了怎么办', deviceId: 'dev-1', createdAt: '2026-08-01 10:00:00' },
  { id: 'm2', role: 'assistant', content: '清理 ARP 表：clear arp', deviceId: 'dev-1', createdAt: '2026-08-01 10:00:05' },
]

beforeEach(() => {
  vi.clearAllMocks()
  // 默认配置已就绪（非 demoMode）
  mockedGetAiConfig.mockReturnValue({ provider: 'openai', apiKey: 'sk-x', baseUrl: '', modelName: '' } as any)
  mockedFindExisting.mockReturnValue([])
})

describe('summarizeSessionForUi（Phase 8 Plan 03 W-3 编排单测）', () => {
  it('(e) demoMode：getAiConfig 返 null → 不调 draftSession，返 empty + demoMode=true', async () => {
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    mockedGetAiConfig.mockReturnValue(null)

    const result = await summarizeSessionForUi({ sessionId: 's1' })

    expect(result.demoMode).toBe(true)
    expect(result.empty).toBe(true)
    expect(mockedDraftSession).not.toHaveBeenCalled()
    expect(mockedCreateExperience).not.toHaveBeenCalled()
  })

  it('空会话（messages.length===0）→ 返 empty，不调 draftSession', async () => {
    mockedGetChatHistory.mockReturnValue([] as any)

    const result = await summarizeSessionForUi({ sessionId: 's1' })

    expect(result.empty).toBe(true)
    expect(result.demoMode).toBe(false)
    expect(mockedDraftSession).not.toHaveBeenCalled()
    expect(mockedCreateExperience).not.toHaveBeenCalled()
  })

  it('(c) NOOP 不落库：mock drafts 含 1 条 NOOP → createExperience 调用 0 次 + result.noop.length===1', async () => {
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    const noopDraft = {
      category: 'best_practices' as const,
      title: '重复内容',
      content: 'c',
      tags: [],
      attrs: {},
      confidence: 0.9,
      reasoning: '与存量重复',
      duplication_verdict: 'NOOP' as const,
      duplicate_of_exp_id: 'exp-old-noop',
    }
    mockedDraftSession.mockResolvedValueOnce([noopDraft])
    mockedJudgeVerdicts.mockResolvedValueOnce([noopDraft])

    const result = await summarizeSessionForUi({ sessionId: 's1' })

    expect(mockedCreateExperience).toHaveBeenCalledTimes(0)
    expect(result.noop.length).toBe(1)
    expect(result.noop[0].duplicate_of_exp_id).toBe('exp-old-noop')
    expect(result.created.length).toBe(0)
    expect(result.updated.length).toBe(0)
  })

  it('(b) sourceSessionId 透传：createExperience 入参含 sourceSessionId === sessionId', async () => {
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    const addDraft = {
      category: 'best_practices' as const,
      title: '定期备份',
      content: '每周备份配置',
      tags: ['backup'],
      attrs: {},
      confidence: 0.9,
      reasoning: '新增经验',
      duplication_verdict: 'ADD' as const,
      duplicate_of_exp_id: null,
    }
    mockedDraftSession.mockResolvedValueOnce([addDraft])
    mockedJudgeVerdicts.mockResolvedValueOnce([addDraft])
    mockedCreateExperience.mockReturnValueOnce({ id: 'exp-new-1', title: '定期备份', category: 'best_practices' })

    await summarizeSessionForUi({ sessionId: 's1' })

    expect(mockedCreateExperience).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: 's1' })
    )
  })

  it('(d) UPDATE 透传 dup_id：createExperience 入参含 duplicateOfExpId=exp-old-1', async () => {
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    const updateDraft = {
      category: 'best_practices' as const,
      title: '补充备份',
      content: '补充增量备份',
      tags: [],
      attrs: {},
      confidence: 0.8,
      reasoning: '补充旧经验',
      duplication_verdict: 'UPDATE' as const,
      duplicate_of_exp_id: 'exp-old-1',
    }
    mockedDraftSession.mockResolvedValueOnce([updateDraft])
    mockedJudgeVerdicts.mockResolvedValueOnce([updateDraft])
    mockedCreateExperience.mockReturnValueOnce({ id: 'exp-new-2', title: '补充备份', category: 'best_practices' })

    const result = await summarizeSessionForUi({ sessionId: 's1' })

    expect(mockedCreateExperience).toHaveBeenCalledWith(
      expect.objectContaining({ duplicateOfExpId: 'exp-old-1' })
    )
    expect(result.updated.length).toBe(1)
    expect(result.updated[0].duplicate_of_exp_id).toBe('exp-old-1')
  })

  it('(a) SC5 追加不覆盖：同 sessionId 两次 summarize 各生独立行（createExperience 每次返不同 id）', async () => {
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    const addDraft = {
      category: 'best_practices' as const,
      title: '定期备份',
      content: '每周备份',
      tags: [],
      attrs: {},
      confidence: 0.9,
      reasoning: '新增',
      duplication_verdict: 'ADD' as const,
      duplicate_of_exp_id: null,
    }
    mockedDraftSession.mockResolvedValue([addDraft])
    mockedJudgeVerdicts.mockResolvedValue([addDraft])
    // 第一次总结生 exp-A，第二次总结生 exp-B（不同 uuid）
    mockedCreateExperience
      .mockReturnValueOnce({ id: 'exp-A', title: '定期备份', category: 'best_practices' })
      .mockReturnValueOnce({ id: 'exp-B', title: '定期备份', category: 'best_practices' })

    const r1 = await summarizeSessionForUi({ sessionId: 's1' })
    const r2 = await summarizeSessionForUi({ sessionId: 's1' })

    expect(r1.created[0].exp_id).toBe('exp-A')
    expect(r2.created[0].exp_id).toBe('exp-B')
    expect(r1.created[0].exp_id).not.toBe(r2.created[0].exp_id)
    // 两次 createExperience 入参 sourceSessionId 都等于 s1（SC5 source_session_id 溯源）
    expect(mockedCreateExperience).toHaveBeenNthCalledWith(1, expect.objectContaining({ sourceSessionId: 's1' }))
    expect(mockedCreateExperience).toHaveBeenNthCalledWith(2, expect.objectContaining({ sourceSessionId: 's1' }))
    expect(mockedCreateExperience).toHaveBeenCalledTimes(2)
  })

  it('阶段B：对 distinct categories 逐个调 findExistingForDraft 窄查', async () => {
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    // 两条不同分类的 ADD 草稿
    const d1 = {
      category: 'best_practices' as const, title: 't1', content: 'c1', tags: [], attrs: {},
      confidence: 0.9, reasoning: 'r1', duplication_verdict: 'ADD' as const, duplicate_of_exp_id: null,
    }
    const d2 = {
      category: 'env' as const, title: 't2', content: 'c2', tags: [], attrs: {},
      confidence: 0.9, reasoning: 'r2', duplication_verdict: 'ADD' as const, duplicate_of_exp_id: null,
    }
    mockedDraftSession.mockResolvedValueOnce([d1, d2])
    mockedJudgeVerdicts.mockResolvedValueOnce([d1, d2])
    mockedCreateExperience
      .mockReturnValueOnce({ id: 'e1', title: 't1', category: 'best_practices' })
      .mockReturnValueOnce({ id: 'e2', title: 't2', category: 'env' })

    await summarizeSessionForUi({ sessionId: 's1' })

    // distinct categories = [best_practices, env]，findExistingForDraft 应被调 2 次（每分类一次）
    expect(mockedFindExisting).toHaveBeenCalledTimes(2)
    const calledCategories = mockedFindExisting.mock.calls.map((c) => c[0].category)
    expect(calledCategories).toContain('best_practices')
    expect(calledCategories).toContain('env')
  })

  it('SC1：draftSession 返 [] → empty=true（无可总结不强产）', async () => {
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    mockedDraftSession.mockResolvedValueOnce([])

    const result = await summarizeSessionForUi({ sessionId: 's1' })

    expect(result.empty).toBe(true)
    expect(result.created.length).toBe(0)
    expect(result.updated.length).toBe(0)
    expect(mockedJudgeVerdicts).not.toHaveBeenCalled()
    expect(mockedCreateExperience).not.toHaveBeenCalled()
  })

  it('maskConversationText 在调 draftSession 前执行（D-04 脱敏前置，原始 messages 不动）', async () => {
    const { maskConversationText } = await import('../utils/piiMask')
    const mockedMask = vi.mocked(maskConversationText)
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    mockedDraftSession.mockResolvedValueOnce([])
    mockedMask.mockClear()

    await summarizeSessionForUi({ sessionId: 's1' })

    expect(mockedMask).toHaveBeenCalledTimes(1)
  })

  it('relateDevice 调用：ADD draft 落库后按 deviceIds 关联', async () => {
    mockedGetChatHistory.mockReturnValue(SAMPLE_MSGS as any)
    const addDraft = {
      category: 'best_practices' as const, title: 't', content: 'c', tags: [], attrs: {},
      confidence: 0.9, reasoning: 'r', duplication_verdict: 'ADD' as const, duplicate_of_exp_id: null,
    }
    mockedDraftSession.mockResolvedValueOnce([addDraft])
    mockedJudgeVerdicts.mockResolvedValueOnce([addDraft])
    mockedCreateExperience.mockReturnValueOnce({ id: 'exp-x', title: 't', category: 'best_practices' })

    await summarizeSessionForUi({ sessionId: 's1' })

    // SAMPLE_MSGS 含 deviceId='dev-1'，relateDevice 应被调一次关联 dev-1
    expect(mockedRelateDevice).toHaveBeenCalledWith('exp-x', 'dev-1', 'primary')
  })
})
