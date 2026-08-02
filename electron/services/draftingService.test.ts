import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * draftingService 单测（Phase 8 D-01/D-03/D-04 起草侧 + DRAFT-04 + W-4 两阶段复判）。
 *
 * mock callAI + getAiConfig，覆盖：
 * - draftSession happy / ```json 包裹剥离 / 非数组重试 / 超枚举重试 / 缺 severity 重试 /
 *   第2次成功 / 空数组不强产 / demoMode 直接返 / 未配 AI 抛错
 * - validateDrafts ADD-UPDATE-NOOP dupId 规则 + W-2 confidence 边界（'85%' / '0.9' / 'high' / 1.5）
 * - judgeVerdicts 复判（覆盖 verdict+dupId）+ judgeVerdicts demoMode（不调 LLM）
 */

const callAIMock = vi.fn()
const getAiConfigMock = vi.fn()
vi.mock('./ai', () => ({
  callAI: (...args: any[]) => callAIMock(...args),
  getAiConfig: () => getAiConfigMock(),
}))

import {
  draftSession,
  judgeVerdicts,
  validateDrafts,
  buildDraftingPrompt,
  buildVerdictPrompt,
  validateVerdicts,
} from './draftingService'

const validConfig = { apiKey: 'sk-test', baseUrl: 'http://x', modelName: 'm' }

const troubDraft = {
  category: 'troubleshooting',
  title: '交换机端口 flapping',
  content: '端口频繁 up/down，更换光模块解决',
  tags: ['switch'],
  attrs: { severity: 'high', symptoms: '端口抖动', resolution: '换光模块' },
  confidence: 0.8,
  reasoning: '对话明确描述了该问题与解决方法',
  duplication_verdict: 'ADD' as const,
  duplicate_of_exp_id: null,
}

const prodDraft = {
  category: 'product',
  title: '华为 S5700 默认 SSH 端口',
  content: 'S5700 默认 SSH 端口 22',
  tags: ['huawei'],
  attrs: {},
  confidence: 0.7,
  reasoning: '产品文档查证',
  duplication_verdict: 'ADD' as const,
  duplicate_of_exp_id: null,
}

describe('draftSession / validateDrafts（D-01 schema 校验 + D-04 反幻觉）', () => {
  beforeEach(() => {
    callAIMock.mockReset()
    getAiConfigMock.mockReset()
    getAiConfigMock.mockReturnValue(validConfig)
  })

  it('1. happy path：返 1 条 troubleshooting + 1 条 product → 2 条', async () => {
    callAIMock.mockResolvedValueOnce(JSON.stringify([troubDraft, prodDraft]))
    const out = await draftSession({ maskedConversation: '对话...', existingSummaries: [] })
    expect(out).toHaveLength(2)
    expect(out[0].category).toBe('troubleshooting')
    expect(out[1].category).toBe('product')
    expect(callAIMock).toHaveBeenCalledTimes(1)
  })

  it('2. ```json 包裹 + 首尾多余文字 → 剥离后 ok', async () => {
    const wrapped = '这是结果：\n```json\n[' + JSON.stringify(troubDraft).slice(1, -1) + ']\n```\n解释'
    callAIMock.mockResolvedValueOnce(wrapped)
    const out = await draftSession({ maskedConversation: '对话', existingSummaries: [] })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('交换机端口 flapping')
  })

  it('3. callAI 返非数组 → 重试 3 次后 throw', async () => {
    callAIMock.mockResolvedValue('{"not":"array"}')
    await expect(
      draftSession({ maskedConversation: '对话', existingSummaries: [] })
    ).rejects.toThrow(/AI 起草失败（已重试 3 次）/)
    expect(callAIMock).toHaveBeenCalledTimes(3)
  })

  it('4. callAI 返超枚举 category → 重试 3 次后 throw', async () => {
    callAIMock.mockResolvedValue(JSON.stringify([{ ...troubDraft, category: 'random' }]))
    await expect(
      draftSession({ maskedConversation: '对话', existingSummaries: [] })
    ).rejects.toThrow(/category 非法/)
    expect(callAIMock).toHaveBeenCalledTimes(3)
  })

  it('5. troubleshooting 缺 severity → fail 重试', async () => {
    callAIMock.mockResolvedValue(
      JSON.stringify([{ ...troubDraft, attrs: { symptoms: 'x' } }])
    )
    await expect(
      draftSession({ maskedConversation: '对话', existingSummaries: [] })
    ).rejects.toThrow(/severity/)
  })

  it('6. 第 1 次坏 JSON，第 2 次合法 → 第 2 次成功（重试机制）', async () => {
    callAIMock
      .mockResolvedValueOnce('not json at all')
      .mockResolvedValueOnce(JSON.stringify([troubDraft]))
    const out = await draftSession({ maskedConversation: '对话', existingSummaries: [] })
    expect(out).toHaveLength(1)
    expect(callAIMock).toHaveBeenCalledTimes(2)
  })

  it('7. callAI 返 [] 空数组（无可总结）→ 返 []（不强产，SC1）', async () => {
    callAIMock.mockResolvedValueOnce('[]')
    const out = await draftSession({ maskedConversation: '对话', existingSummaries: [] })
    expect(out).toEqual([])
  })

  it('8. demoMode=true → 直接返 []，不调 callAI', async () => {
    const out = await draftSession({
      maskedConversation: '对话',
      existingSummaries: [],
      demoMode: true,
    })
    expect(out).toEqual([])
    expect(callAI).toBeDefined()
    expect(callAIMock).toHaveBeenCalledTimes(0)
  })

  it('9. getAiConfig 返 null → 抛「请先配置 AI 服务」', async () => {
    getAiConfigMock.mockReturnValue(null)
    await expect(
      draftSession({ maskedConversation: '对话', existingSummaries: [] })
    ).rejects.toThrow(/请先配置 AI 服务/)
  })

  it('9b. getAiConfig 返空 apiKey → 抛「请先配置 AI 服务」', async () => {
    getAiConfigMock.mockReturnValue({ apiKey: '', baseUrl: 'x', modelName: 'm' })
    await expect(
      draftSession({ maskedConversation: '对话', existingSummaries: [] })
    ).rejects.toThrow(/请先配置 AI 服务/)
  })
})

describe('validateDrafts ADD/UPDATE/NOOP dupId 规则', () => {
  it('10. ADD 时 dupId 必须为空；UPDATE 必填；NOOP 必填', () => {
    // ADD 带 dupId → fail
    expect(
      validateDrafts(JSON.stringify([{ ...troubDraft, duplicate_of_exp_id: 'exp-1' }])).ok
    ).toBe(false)
    // UPDATE 无 dupId → fail
    expect(
      validateDrafts(
        JSON.stringify([{ ...troubDraft, duplication_verdict: 'UPDATE', duplicate_of_exp_id: null }])
      ).ok
    ).toBe(false)
    // UPDATE 有 dupId → ok
    const r1 = validateDrafts(
      JSON.stringify([{ ...troubDraft, duplication_verdict: 'UPDATE', duplicate_of_exp_id: 'exp-1' }])
    )
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.drafts[0].duplication_verdict).toBe('UPDATE')
      expect(r1.drafts[0].duplicate_of_exp_id).toBe('exp-1')
    }
    // NOOP 有 dupId → ok（NOOP 不落库由 Plan 03 过滤，本 service 仍返回）
    const r2 = validateDrafts(
      JSON.stringify([{ ...troubDraft, duplication_verdict: 'NOOP', duplicate_of_exp_id: 'exp-2' }])
    )
    expect(r2.ok).toBe(true)
  })
})

describe('W-2 confidence 边界', () => {
  it("11a. confidence '85%' → 0.85 通过", () => {
    const r = validateDrafts(JSON.stringify([{ ...troubDraft, confidence: '85%' }]))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.drafts[0].confidence).toBeCloseTo(0.85)
  })

  it("11b. confidence 'high'（非法非数值非百分比）→ fail", () => {
    expect(validateDrafts(JSON.stringify([{ ...troubDraft, confidence: 'high' }])).ok).toBe(false)
  })

  it("11c. confidence '0.9'（字符串数值）→ 0.9 通过", () => {
    const r = validateDrafts(JSON.stringify([{ ...troubDraft, confidence: '0.9' }]))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.drafts[0].confidence).toBeCloseTo(0.9)
  })

  it('11d. confidence 1.5（超界）→ fail', () => {
    expect(validateDrafts(JSON.stringify([{ ...troubDraft, confidence: 1.5 }])).ok).toBe(false)
  })
})

describe('buildDraftingPrompt / buildVerdictPrompt / validateVerdicts', () => {
  it('buildDraftingPrompt 含反幻觉红线 + 分类枚举 + JSON 数组契约', () => {
    const { system, user } = buildDraftingPrompt({
      maskedConversation: '会话正文',
      deviceIds: ['d1'],
      existingSummaries: [{ exp_id: 'e1', title: 't', content_preview: 'p' }],
    })
    expect(system).toMatch(/禁止输出 \[CMD\]/)
    expect(system).toMatch(/troubleshooting、best_practices、product、env/)
    expect(system).toMatch(/JSON 数组/)
    expect(user).toContain('会话正文')
    expect(user).toContain('d1')
    expect(user).toContain('e1')
  })

  it('buildDraftingPrompt 无设备/无存量 → 占位文案', () => {
    const { user } = buildDraftingPrompt({
      maskedConversation: 'c',
      existingSummaries: [],
    })
    expect(user).toMatch(/无关联设备/)
    expect(user).toMatch(/暂无存量/)
  })

  it('validateVerdicts：UPDATE 必填 dupId / ADD 必空 / draft_index 越界 fail', () => {
    const ok = validateVerdicts(
      JSON.stringify([
        { draft_index: 0, verdict: 'UPDATE', duplicate_of_exp_id: 'exp-x' },
      ]),
      1
    )
    expect(ok.ok).toBe(true)

    // ADD 带 dupId → fail
    expect(
      validateVerdicts(
        JSON.stringify([{ draft_index: 0, verdict: 'ADD', duplicate_of_exp_id: 'x' }]),
        1
      ).ok
    ).toBe(false)
    // UPDATE 无 dupId → fail
    expect(
      validateVerdicts(
        JSON.stringify([{ draft_index: 0, verdict: 'UPDATE', duplicate_of_exp_id: null }]),
        1
      ).ok
    ).toBe(false)
    // draft_index 越界 → fail
    expect(
      validateVerdicts(
        JSON.stringify([{ draft_index: 5, verdict: 'ADD', duplicate_of_exp_id: null }]),
        1
      ).ok
    ).toBe(false)
  })

  it('buildVerdictPrompt 含 verdict 系统约束 + drafts 摘要 + 同分类存量分组', () => {
    const { system, user } = buildVerdictPrompt({
      drafts: [{ ...troubDraft }],
      existingByCategory: {
        troubleshooting: [{ exp_id: 'e1', title: 't', content_preview: 'p' }],
        best_practices: [],
        product: [],
        env: [],
      },
    })
    expect(system).toMatch(/查重判定/)
    expect(system).toMatch(/draft_index/)
    expect(user).toContain('troubleshooting')
    expect(user).toContain('e1')
  })
})

describe('judgeVerdicts（W-4 两阶段复判）', () => {
  beforeEach(() => {
    callAIMock.mockReset()
    getAiConfigMock.mockReset()
    getAiConfigMock.mockReturnValue(validConfig)
  })

  it("12. mock callAI 返 UPDATE+dupId → 复判覆盖 drafts[0] verdict='UPDATE' dupId='exp-old-1'", async () => {
    callAIMock.mockResolvedValueOnce(
      JSON.stringify([{ draft_index: 0, verdict: 'UPDATE', duplicate_of_exp_id: 'exp-old-1' }])
    )
    const out = await judgeVerdicts({
      drafts: [{ ...troubDraft }],
      existingByCategory: {
        troubleshooting: [{ exp_id: 'exp-old-1', title: '旧', content_preview: 'p' }],
        best_practices: [],
        product: [],
        env: [],
      },
    })
    expect(out).toHaveLength(1)
    expect(out[0].duplication_verdict).toBe('UPDATE')
    expect(out[0].duplicate_of_exp_id).toBe('exp-old-1')
    expect(callAIMock).toHaveBeenCalledTimes(1)
  })

  it('12b. 全分类无存量 → 短路不调 LLM，原 drafts 保持 ADD', async () => {
    const out = await judgeVerdicts({
      drafts: [{ ...troubDraft }],
      existingByCategory: {
        troubleshooting: [],
        best_practices: [],
        product: [],
        env: [],
      },
    })
    expect(out[0].duplication_verdict).toBe('ADD')
    expect(callAIMock).toHaveBeenCalledTimes(0)
  })

  it('12c. LLM 未返某 draft_index → 保持原 ADD 初值（保守新增）', async () => {
    // 输入 2 条 drafts，LLM 只返 draft_index=1（UPDATE）
    callAIMock.mockResolvedValueOnce(
      JSON.stringify([{ draft_index: 1, verdict: 'UPDATE', duplicate_of_exp_id: 'exp-x' }])
    )
    const out = await judgeVerdicts({
      drafts: [{ ...troubDraft }, { ...prodDraft }],
      existingByCategory: {
        troubleshooting: [{ exp_id: 'exp-x', title: 'x', content_preview: 'p' }],
        best_practices: [],
        product: [],
        env: [],
      },
    })
    expect(out[0].duplication_verdict).toBe('ADD') // 未覆盖 → 保持原值
    expect(out[1].duplication_verdict).toBe('UPDATE')
    expect(out[1].duplicate_of_exp_id).toBe('exp-x')
  })

  it('13. judgeVerdicts demoMode → 不调 callAI，原 drafts 保持', async () => {
    const out = await judgeVerdicts({
      drafts: [{ ...troubDraft, duplication_verdict: 'ADD' }],
      existingByCategory: {
        troubleshooting: [{ exp_id: 'e1', title: 't', content_preview: 'p' }],
        best_practices: [],
        product: [],
        env: [],
      },
      demoMode: true,
    })
    expect(out[0].duplication_verdict).toBe('ADD')
    expect(callAIMock).toHaveBeenCalledTimes(0)
  })
})
