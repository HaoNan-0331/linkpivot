import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Phase 28（28-02 Task 2，AGENT-01）：agentRetrieval 分档预取矩阵 + 后置证据校验 TDD。
 *
 * 检索函数注入：vi.mock experienceRetrieval / knowledgeBaseService / ai（ai.test.ts 先例）。
 * 覆盖：四档矩阵、demoMode 短路、设备上下文只给提示文本、校验缺席/齐全（fail-closed）。
 * 安全域：纯 mock，零 DB。
 */

vi.mock('../../../electron/services/ai', () => ({
  getAiConfig: vi.fn(),
}))
vi.mock('../../../electron/services/experienceRetrieval', () => ({
  retrieveForAnswer: vi.fn(),
}))
vi.mock('../../../electron/services/knowledgeBaseService', () => ({
  search: vi.fn(),
}))

import {
  TIER_RETRIEVAL_PLAN,
  retrieveForTier,
  verifySourcesEvidence,
} from '../../../electron/services/agentRetrieval'
import { getAiConfig } from '../../../electron/services/ai'
import { retrieveForAnswer } from '../../../electron/services/experienceRetrieval'
import { search as kbSearch } from '../../../electron/services/knowledgeBaseService'

const EXP_HIT = {
  exp_id: 'e1', title: '端口 down 处置', content: '先看光衰', source_session_id: null, unsupported: false,
}
const KB_ROW = {
  id: 'c1', title: 'VLAN 章节', content: 'vlan 20 配置',
  document: { id: 'd1', title: '交换机手册', file_name: 'doc.pdf' },
}

beforeEach(() => {
  vi.mocked(getAiConfig).mockReturnValue({ apiKey: 'k' } as any)
  vi.mocked(retrieveForAnswer).mockReset()
  vi.mocked(kbSearch).mockReset()
})

describe('TIER_RETRIEVAL_PLAN 四档矩阵', () => {
  it('troubleshoot = exp + kb + device', () => {
    expect(TIER_RETRIEVAL_PLAN.troubleshoot).toEqual(['exp', 'kb', 'device'])
  })
  it('configQuery = kb + device', () => {
    expect(TIER_RETRIEVAL_PLAN.configQuery).toEqual(['kb', 'device'])
  })
  it('knowledge = kb + exp（不含 device）', () => {
    expect(TIER_RETRIEVAL_PLAN.knowledge).toEqual(['kb', 'exp'])
  })
  it('inspection = exp + device', () => {
    expect(TIER_RETRIEVAL_PLAN.inspection).toEqual(['exp', 'device'])
  })
})

describe('retrieveForTier', () => {
  it('troubleshoot 档：plan 含 exp+kb+device，injected 含两库命中', async () => {
    vi.mocked(retrieveForAnswer).mockResolvedValue({
      demoMode: false, injected: [EXP_HIT as any], reranked: [], finalAnswer: '',
    } as any)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [KB_ROW as any], degraded: false, indexTotal: 1, indexCapped: null } as any)

    const r = await retrieveForTier({ tier: 'troubleshoot', userMessage: '端口 down 不通' })
    expect(r.plan).toEqual(['exp', 'kb', 'device'])
    expect(r.injected.filter((x) => x.kind === 'exp')).toHaveLength(1)
    expect(r.injected.filter((x) => x.kind === 'kb')).toHaveLength(1)
    expect(r.demoMode).toBe(false)
  })

  it('knowledge 档：plan 仅 kb+exp，不含 deviceHint', async () => {
    vi.mocked(kbSearch).mockResolvedValue({ rows: [], degraded: false, indexTotal: 0, indexCapped: null } as any)
    vi.mocked(retrieveForAnswer).mockResolvedValue({ demoMode: false, injected: [], reranked: [], finalAnswer: '' } as any)

    const r = await retrieveForTier({ tier: 'knowledge', userMessage: 'OSPF 和 BGP 的区别' })
    expect(r.plan).toEqual(['kb', 'exp'])
    expect(r.plan).not.toContain('device')
    expect(r.promptSection).not.toContain('[CMD')
  })

  it('device 档位只注入提示文本（不自动执行命令）', async () => {
    vi.mocked(retrieveForAnswer).mockResolvedValue({ demoMode: false, injected: [], reranked: [], finalAnswer: '' } as any)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [], degraded: false, indexTotal: 0, indexCapped: null } as any)

    const r = await retrieveForTier({ tier: 'inspection', userMessage: '巡检一遍' })
    expect(r.plan).toContain('device')
    expect(r.promptSection).toContain('[CMD')
    // 预取阶段绝不触发命令执行
    expect(r.injected.some((x) => x.kind === 'mcp')).toBe(false)
  })

  it('apiKey 缺失 → demoMode:true + 空注入不抛错', async () => {
    vi.mocked(getAiConfig).mockReturnValue(null as any)
    const r = await retrieveForTier({ tier: 'troubleshoot', userMessage: 'down' })
    expect(r.demoMode).toBe(true)
    expect(r.injected).toEqual([])
    expect(r.promptSection).toBe('')
    expect(retrieveForAnswer).not.toHaveBeenCalled()
  })

  it('单源检索抛错不炸全链（fail-closed 返空该源注入）', async () => {
    vi.mocked(retrieveForAnswer).mockRejectedValue(new Error('db locked'))
    vi.mocked(kbSearch).mockResolvedValue({ rows: [KB_ROW as any], degraded: false, indexTotal: 1, indexCapped: null } as any)

    const r = await retrieveForTier({ tier: 'troubleshoot', userMessage: 'down' })
    expect(r.demoMode).toBe(false)
    expect(r.injected.filter((x) => x.kind === 'exp')).toHaveLength(0)
    expect(r.injected.filter((x) => x.kind === 'kb')).toHaveLength(1)
  })
})

describe('verifySourcesEvidence（后置证据校验 fail-closed）', () => {
  it('troubleshoot 档零 sources → missing 含 exp 与 kb，remedy 可执行', () => {
    const r = verifySourcesEvidence({ tier: 'troubleshoot', sources: [] })
    expect(r.missing).toContain('exp')
    expect(r.missing).toContain('kb')
    expect(r.remedy.length).toBeGreaterThan(0)
  })

  it('troubleshoot 档 sources 含 kb+exp+device → missing 为空', () => {
    const r = verifySourcesEvidence({
      tier: 'troubleshoot',
      sources: [{ kind: 'kb' }, { kind: 'exp' }, { kind: 'device' }],
    })
    expect(r.missing).toEqual([])
  })

  it('knowledge 档不要求 device（sources 无 device 不算缺席）', () => {
    const r = verifySourcesEvidence({
      tier: 'knowledge',
      sources: [{ kind: 'kb' }, { kind: 'exp' }],
    })
    expect(r.missing).toEqual([])
  })

  it('缺席即列（partial sources）', () => {
    const r = verifySourcesEvidence({ tier: 'configQuery', sources: [{ kind: 'kb' }] })
    expect(r.missing).toEqual(['device'])
  })
})
