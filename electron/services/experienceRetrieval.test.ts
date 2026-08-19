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
import { retrieveForAnswer, INJECT_LIMIT, MAX_CANDIDATES } from './experienceRetrieval'

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

  it('9b. exp_id 重复（LLM 返同 id 两次）→ fail（CR-02 防 reuse_count 重复累加、references 重复渲染）', () => {
    const r = validateRerank(
      JSON.stringify([
        { exp_id: 'e1', score: 0.8, reason: 'r1' },
        { exp_id: 'e1', score: 0.9, reason: 'r2' },
      ]),
      candSet(['e1', 'e2'])
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/重复/)
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

// ---------- Task 2: retrieveForAnswer 编排 ----------

function makeRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'e1',
    title: '核心交换机离线排查',
    content: '检查电源和光模块，display version 查看状态',
    status: 'published',
    source_session_id: 'sess-1',
    invalid_at: null,
    reuse_count: 0,
    last_verified_at: null,
    attrs: { severity: 'high', resolution: 'display interface 检查端口' },
    tags: ['switch'],
    ...overrides,
  }
}

describe('retrieveForAnswer（编排）', () => {
  beforeEach(() => {
    listExperiencesMock.mockReset()
    incReuseCountMock.mockReset()
    touchLastVerifiedAtMock.mockReset()
    isCommandAllowedMock.mockReset()
    getAiConfigMock.mockReset()
    getCommandWhitelistMock.mockReset()
    callAIMock.mockReset()
    getAiConfigMock.mockReturnValue(validConfig)
    getCommandWhitelistMock.mockReturnValue(['display', 'show', 'ping', 'traceroute'])
    isCommandAllowedMock.mockImplementation((cmd: string) => {
      const first = cmd.trim().toLowerCase().split(/\s+/)[0]
      const allowed = ['display', 'show', 'ping', 'traceroute'].includes(first)
      return { allowed, reason: allowed ? 'ok' : 'denied' }
    })
  })

  it('17. demoMode（未配 AI）→ 返 demoMode:true injected:[] 不调 listExperiences/rerank', async () => {
    getAiConfigMock.mockReturnValue(null)
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.demoMode).toBe(true)
    expect(r.injected).toEqual([])
    expect(listExperiencesMock).not.toHaveBeenCalled()
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('18. 空库（listExperiences rows=[]）→ 返 empty injected:[] 不调 rerank', async () => {
    listExperiencesMock.mockReturnValue({ rows: [], total: 0 })
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected).toEqual([])
    expect(callAIMock).not.toHaveBeenCalled()
  })

  it('19. 有勾选设备 → 走 deviceId 窄查分支（opts.deviceId 数组）', async () => {
    listExperiencesMock.mockReturnValue({ rows: [], total: 0 })
    await retrieveForAnswer({ userMessage: '问题', deviceIds: ['d1', 'd2'] })
    expect(listExperiencesMock).toHaveBeenCalledTimes(1)
    const opts = listExperiencesMock.mock.calls[0][0]
    expect(opts.deviceId).toEqual(['d1', 'd2'])
    expect(opts.status).toBe('published')  // CR-01：强制 published，draft 不进检索池（红线③）
    expect(opts.includeInvalid).toBe(false)
    expect(opts.limit).toBe(MAX_CANDIDATES)
  })

  it('20. 无勾选设备 → 走 search 宽匹配分支（opts.search = userMessage）', async () => {
    listExperiencesMock.mockReturnValue({ rows: [], total: 0 })
    await retrieveForAnswer({ userMessage: '交换机离线' })
    const opts = listExperiencesMock.mock.calls[0][0]
    expect(opts.search).toBe('交换机离线')
    expect(opts.status).toBe('published')  // CR-01：search 分支同样强制 published
    expect(opts.deviceId).toBeUndefined()
  })

  it('21. 精排 score < 阈值 → 过滤掉不注入', async () => {
    listExperiencesMock.mockReturnValue({ rows: [makeRow({ id: 'e1' })], total: 1 })
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.3, reason: '不太相关' }]))
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected).toEqual([])
    expect(incReuseCountMock).not.toHaveBeenCalled()
  })

  it('22. 精排 score >= 阈值 → 命中注入 + incReuseCount + touchLastVerifiedAt 各调一次', async () => {
    listExperiencesMock.mockReturnValue({ rows: [makeRow({ id: 'e1' })], total: 1 })
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.85, reason: '高度相关' }]))
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected).toHaveLength(1)
    expect(r.injected[0].exp_id).toBe('e1')
    expect(r.injected[0].source_session_id).toBe('sess-1')
    expect(incReuseCountMock).toHaveBeenCalledWith('e1')
    expect(touchLastVerifiedAtMock).toHaveBeenCalledWith('e1')
  })

  it('23. 有效期失效（invalid_at 过期）→ 剔除不注入', async () => {
    const past = new Date(Date.now() - 86400000).toISOString().replace('T', ' ').slice(0, 19)
    listExperiencesMock.mockReturnValue({ rows: [makeRow({ id: 'e1', invalid_at: past })], total: 1 })
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.9, reason: 'r' }]))
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected).toEqual([])
  })

  it('24. 命令全失支持（提取到的命令首词不在白名单）→ 标 unsupported=true（降权不剔除）', async () => {
    // WR-03 fix 后 CMD_EXTRACT_RE 只提取 display/show/ping/traceroute；
    // 覆盖 isCommandAllowed 全 deny 模拟「用户白名单未含这些命令」→ 全失支持
    listExperiencesMock.mockReturnValue({
      rows: [makeRow({ id: 'e1', content: 'display version 查看版本', attrs: { resolution: 'show interface' } })],
      total: 1,
    })
    isCommandAllowedMock.mockImplementation(() => ({ allowed: false, reason: 'denied' }))
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.8, reason: 'r' }]))
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected).toHaveLength(1)
    expect(r.injected[0].unsupported).toBe(true)
  })

  it('25. 命令部分失支持（任一失支持）→ 标 unsupported=true（保守宁可多标）', async () => {
    // content 含 display（allowed）+ resolution 含 traceroute（denied）→ cmds.some 失支持即标
    listExperiencesMock.mockReturnValue({
      rows: [makeRow({ id: 'e1', content: 'display version', attrs: { resolution: 'traceroute 10.0.0.1 路由追踪' } })],
      total: 1,
    })
    isCommandAllowedMock.mockImplementation((cmd: string) => {
      const first = cmd.trim().toLowerCase().split(/\s+/)[0]
      return { allowed: first === 'display', reason: first === 'display' ? 'ok' : 'denied' }
    })
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.8, reason: 'r' }]))
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected[0].unsupported).toBe(true)
  })

  it('26. 无命令正文 → unsupported=false', async () => {
    listExperiencesMock.mockReturnValue({
      rows: [makeRow({ id: 'e1', content: '检查电源连接和散热', attrs: { resolution: '更换硬件' } })],
      total: 1,
    })
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.8, reason: 'r' }]))
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected[0].unsupported).toBe(false)
  })

  it('27. incReuseCount 失败 → 不阻塞主路径（仍注入，console.warn 兜底 D-11-9）', async () => {
    listExperiencesMock.mockReturnValue({ rows: [makeRow({ id: 'e1' })], total: 1 })
    incReuseCountMock.mockImplementation(() => { throw new Error('db locked') })
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.85, reason: 'r' }]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('28. INJECT_LIMIT 截断（精排返 > INJECT_LIMIT 条够分候选 → 只注入前 INJECT_LIMIT）', async () => {
    const rows = []
    for (let i = 1; i <= INJECT_LIMIT + 3; i++) rows.push(makeRow({ id: `e${i}` }))
    listExperiencesMock.mockReturnValue({ rows, total: rows.length })
    callAIMock.mockResolvedValueOnce(
      JSON.stringify(rows.map((r) => ({ exp_id: r.id, score: 0.9, reason: 'r' })))
    )
    const r = await retrieveForAnswer({ userMessage: '问题' })
    expect(r.injected).toHaveLength(INJECT_LIMIT)
    expect(incReuseCountMock).toHaveBeenCalledTimes(INJECT_LIMIT)
  })

  it('29. finalAnswer 永远等于 userMessage（编排不答，正式答交 chat() callAI）', async () => {
    listExperiencesMock.mockReturnValue({ rows: [], total: 0 })
    const r = await retrieveForAnswer({ userMessage: '我的运维问题' })
    expect(r.finalAnswer).toBe('我的运维问题')
  })

  // ---------- Phase 23 Plan 04 C1/C4：全局经验并入检索池 + rerank 降权 ----------

  it('30. 有勾选设备 → deviceId 分支 opts.includeGlobal=true（C1 检索池并集）', async () => {
    listExperiencesMock.mockReturnValue({ rows: [], total: 0 })
    await retrieveForAnswer({ userMessage: '问题', deviceIds: ['d1'] })
    const opts = listExperiencesMock.mock.calls[0][0]
    expect(opts.includeGlobal).toBe(true)
  })

  it('31. C4 全局经验 rerank 降权 ×0.85——同分时关联经验排前；降权后跌破阈值剔除', async () => {
    listExperiencesMock.mockReturnValue({
      rows: [
        makeRow({ id: 'e-linked', isGlobal: false }),
        makeRow({ id: 'e-global', isGlobal: true }),
      ],
      total: 2,
    })
    // LLM 打分：全局 0.9 > 关联 0.8；降权后 global=0.765 < linked=0.8 → 关联优先
    callAIMock.mockResolvedValueOnce(
      JSON.stringify([
        { exp_id: 'e-global', score: 0.9, reason: 'r' },
        { exp_id: 'e-linked', score: 0.8, reason: 'r' },
      ])
    )
    const r = await retrieveForAnswer({ userMessage: '问题', deviceIds: ['d1'] })
    expect(r.injected.map((e: any) => e.exp_id)).toEqual(['e-linked', 'e-global'])
    expect(r.reranked[0].exp_id).toBe('e-linked')
    expect(r.reranked[0].score).toBeCloseTo(0.8)
    expect(r.reranked[1].score).toBeCloseTo(0.9 * 0.85)
  })

  it('31b. C4 边界——全局经验原始分 0.65（过阈值），降权后 0.5525 < 0.6 被剔除', async () => {
    listExperiencesMock.mockReturnValue({
      rows: [makeRow({ id: 'e-g', isGlobal: true }), makeRow({ id: 'e-l', isGlobal: false })],
      total: 2,
    })
    callAIMock.mockResolvedValueOnce(
      JSON.stringify([
        { exp_id: 'e-g', score: 0.65, reason: 'r' },
        { exp_id: 'e-l', score: 0.7, reason: 'r' },
      ])
    )
    const r = await retrieveForAnswer({ userMessage: '问题', deviceIds: ['d1'] })
    expect(r.injected.map((e: any) => e.exp_id)).toEqual(['e-l'])
  })

  it('32. C2 供源——injected[].linked 标注（关联=true / 全局=false）', async () => {
    listExperiencesMock.mockReturnValue({
      rows: [makeRow({ id: 'e-l', isGlobal: false }), makeRow({ id: 'e-g', isGlobal: true })],
      total: 2,
    })
    callAIMock.mockResolvedValueOnce(
      JSON.stringify([
        { exp_id: 'e-l', score: 0.9, reason: 'r' },
        { exp_id: 'e-g', score: 0.9, reason: 'r' },
      ])
    )
    const r = await retrieveForAnswer({ userMessage: '问题', deviceIds: ['d1'] })
    const linked = r.injected.find((e: any) => e.exp_id === 'e-l') as any
    const global = r.injected.find((e: any) => e.exp_id === 'e-g') as any
    expect(linked.linked).toBe(true)
    expect(global.linked).toBe(false)
  })

  it('33. 无勾选设备（search 分支）→ 无 isGlobal 语义：不降权、injected 不带 linked', async () => {
    listExperiencesMock.mockReturnValue({ rows: [makeRow({ id: 'e1' })], total: 1 })
    callAIMock.mockResolvedValueOnce(JSON.stringify([{ exp_id: 'e1', score: 0.62, reason: 'r' }]))
    const r = await retrieveForAnswer({ userMessage: '问题' })
    // 0.62 过阈值；若被误降权 0.527 < 0.6 会被剔除
    expect(r.injected).toHaveLength(1)
    expect((r.injected[0] as any).linked).toBeUndefined()
    expect(r.reranked[0].score).toBeCloseTo(0.62)
  })
})
