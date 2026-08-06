import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 经验精排 + 编排 service 单测（Phase 11 RETRIEVE-01/02）。
 *
 * Task 1（rerank/validateRerank）：mock callAI + getAiConfig，覆盖：
 * - validateRerank ```json 包裹剥离 / 非数组 fail / exp_id 编造 fail /
 *   score '85%' 归一化 / score 'high' NaN fail / score 1.5 超界 fail / score '0.9' 字符串归一化
 * - rerank demoMode 返 [] / 候选空返 [] / 第1次 fail 第2次成功 / 3 次全失败 throw
 *
 * Task 2（retrieveForAnswer）：mock listExperiences/incReuseCount/touchLastVerifiedAt/isCommandAllowed，
 * 覆盖空库短路 / demoMode / deviceId 窄查分支 / search 宽匹配分支 / 阈值过滤 / 有效期失效剔除 /
 * 命令全失支持标 unsupported / incReuseCount 失败不阻塞 / 命中即刷新计数。
 */

const callAIMock = vi.fn()
const getAiConfigMock = vi.fn()
const getCommandWhitelistMock = vi.fn()
vi.mock('./ai', () => ({
  callAI: (...args: any[]) => callAIMock(...args),
  getAiConfig: () => getAiConfigMock(),
  getCommandWhitelist: () => getCommandWhitelistMock(),
}))

const listExperiencesMock = vi.fn()
const incReuseCountMock = vi.fn()
const touchLastVerifiedAtMock = vi.fn()
vi.mock('./experienceService', () => ({
  listExperiences: (...args: any[]) => listExperiencesMock(...args),
  incReuseCount: (...args: any[]) => incReuseCountMock(...args),
  touchLastVerifiedAt: (...args: any[]) => touchLastVerifiedAtMock(...args),
}))

const isCommandAllowedMock = vi.fn()
vi.mock('./commandSafety', () => ({
  isCommandAllowed: (...args: any[]) => isCommandAllowedMock(...args),
}))

// systemLog 在 retrieveForAnswer 中未使用（刷新失败 console.warn 兜底），无需 mock 也行，
// 但本 service 不 import systemLog，故无需 mock。

import { rerank, validateRerank, buildRerankPrompt, MAX_RERANK_RETRIES, RELEVANCE_THRESHOLD } from './experienceRerank'

const validConfig = { apiKey: 'sk-test', baseUrl: 'http://x', modelName: 'm' }

const candSet = (ids: string[]) => new Set(ids)

describe('validateRerank（精排强 schema Gate）', () => {
  it("1. ```json 包裹 + 首尾多余文字 → 剥离后 ok", () => {
    const raw = '这是结果：\n```json\n' + JSON.stringify([{ exp_id: 'e1', score: 0.8, reason: '相关' }]) + '\n```\n解释'
    const r = validateRerank(raw, candSet(['e1']))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entries[0].exp_id).toBe('e1')
  })

  it('2. callAI 返非数组 → fail', () => {
    const r = validateRerank('{"not":"array"}', candSet(['e1']))
    expect(r.ok).toBe(false)
  })

  it('3. exp_id 不在候选集（LLM 编造）→ fail', () => {
    const r = validateRerank(JSON.stringify([{ exp_id: 'fabricated', score: 0.9, reason: 'x' }]), candSet(['e1']))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/不在候选集/)
  })

  it("4. score '85%' 百分比字符串 → 归一化为 0.85", () => {
    const r = validateRerank(JSON.stringify([{ exp_id: 'e1', score: '85%', reason: 'r' }]), candSet(['e1']))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entries[0].score).toBeCloseTo(0.85)
  })

  it("5. score 'high'（非数值非百分比）→ fail（NaN）", () => {
    const r = validateRerank(JSON.stringify([{ exp_id: 'e1', score: 'high', reason: 'r' }]), candSet(['e1']))
    expect(r.ok).toBe(false)
  })

  it('6. score 1.5（超界）→ fail', () => {
    const r = validateRerank(JSON.stringify([{ exp_id: 'e1', score: 1.5, reason: 'r' }]), candSet(['e1']))
    expect(r.ok).toBe(false)
  })

  it("7. score '0.9' 字符串数值 → 归一化为 0.9", () => {
    const r = validateRerank(JSON.stringify([{ exp_id: 'e1', score: '0.9', reason: 'r' }]), candSet(['e1']))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entries[0].score).toBeCloseTo(0.9)
  })

  it('8. reason 非字符串 → fail', () => {
    const r = validateRerank(JSON.stringify([{ exp_id: 'e1', score: 0.8, reason: 123 }]), candSet(['e1']))
    expect(r.ok).toBe(false)
  })

  it('9. 空数组 [] → ok（全部不相关）', () => {
    const r = validateRerank('[]', candSet(['e1']))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entries).toEqual([])
  })
})

describe('buildRerankPrompt', () => {
  it('含反幻觉红线 + JSON 数组契约 + 候选 exp_id 引用', () => {
    const { system, user } = buildRerankPrompt({
      userMessage: 'core-sw-01 突然离线怎么办',
      candidates: [{ exp_id: 'e1', title: '核心交换机离线排查', content_preview: '检查电源/光模块...' }],
    })
    expect(system).toMatch(/禁止编造 exp_id/)
    expect(system).toMatch(/JSON 数组/)
    expect(user).toContain('core-sw-01 突然离线怎么办')
    expect(user).toContain('e1')
    expect(user).toContain('核心交换机离线排查')
  })
})

describe('rerank（精排重试 + demoMode + 候选空短路）', () => {
  beforeEach(() => {
    callAIMock.mockReset()
    getAiConfigMock.mockReset()
    getAiConfigMock.mockReturnValue(validConfig)
  })

  it('10. happy path：1 次成功返 entries', async () => {
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.8, reason: 'r' }]))
    const out = await rerank({
      userMessage: '问题',
      candidates: [{ exp_id: 'e1', title: 't', content_preview: 'p' }],
    })
    expect(out).toHaveLength(1)
    expect(callAIMock).toHaveBeenCalledTimes(1)
  })

  it('11. demoMode=true → 返 [] 不调 callAI', async () => {
    const out = await rerank({
      userMessage: '问题',
      candidates: [{ exp_id: 'e1', title: 't', content_preview: 'p' }],
      demoMode: true,
    })
    expect(out).toEqual([])
    expect(callAIMock).toHaveBeenCalledTimes(0)
  })

  it('12. 候选为空 → 短路返 [] 不调 callAI', async () => {
    const out = await rerank({ userMessage: '问题', candidates: [] })
    expect(out).toEqual([])
    expect(callAIMock).toHaveBeenCalledTimes(0)
  })

  it('13. 第 1 次 fail（坏 JSON），第 2 次成功 → 第 2 次返', async () => {
    callAIMock
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.7, reason: 'r' }]))
    const out = await rerank({
      userMessage: '问题',
      candidates: [{ exp_id: 'e1', title: 't', content_preview: 'p' }],
    })
    expect(out).toHaveLength(1)
    expect(callAIMock).toHaveBeenCalledTimes(2)
  })

  it('14. 3 次全失败 → throw 包含「AI 精排失败（已重试 3 次）」', async () => {
    callAIMock.mockResolvedValue('{"not":"array"}')
    await expect(
      rerank({ userMessage: '问题', candidates: [{ exp_id: 'e1', title: 't', content_preview: 'p' }] })
    ).rejects.toThrow(/AI 精排失败（已重试 3 次）/)
    expect(callAIMock).toHaveBeenCalledTimes(MAX_RERANK_RETRIES)
  })

  it('15. getAiConfig 返 null → throw「请先配置 AI 服务」', async () => {
    getAiConfigMock.mockReturnValue(null)
    await expect(
      rerank({ userMessage: '问题', candidates: [{ exp_id: 'e1', title: 't', content_preview: 'p' }] })
    ).rejects.toThrow(/请先配置 AI 服务/)
  })

  it('16. RELEVANCE_THRESHOLD 导出为 0.6（D-11-4 planner 定值）', () => {
    expect(RELEVANCE_THRESHOLD).toBe(0.6)
  })
})
