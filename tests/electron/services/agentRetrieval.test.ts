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
  listDocuments: vi.fn(),
}))
vi.mock('../../../electron/services/experienceService', () => ({
  listExperiences: vi.fn(),
}))

import {
  TIER_RETRIEVAL_PLAN,
  retrieveForTier,
  verifySourcesEvidence,
  detectCatalogIntent,
  buildCatalogText,
} from '../../../electron/services/agentRetrieval'
import { getAiConfig } from '../../../electron/services/ai'
import { retrieveForAnswer } from '../../../electron/services/experienceRetrieval'
import { search as kbSearch } from '../../../electron/services/knowledgeBaseService'
import { listExperiences } from '../../../electron/services/experienceService'
import { listDocuments } from '../../../electron/services/knowledgeBaseService'

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
  vi.mocked(listExperiences).mockReset()
  vi.mocked(listDocuments).mockReset()
})

describe('TIER_RETRIEVAL_PLAN 四档矩阵', () => {
  it('troubleshoot = exp + kb + device', () => {
    expect(TIER_RETRIEVAL_PLAN.troubleshoot).toEqual(['exp', 'kb', 'device'])
  })
  it('configQuery = kb + exp + device（37-04 GAP-3/4 检索源不分档，device 提示按档保留）', () => {
    expect(TIER_RETRIEVAL_PLAN.configQuery).toEqual(['kb', 'exp', 'device'])
  })
  it('knowledge = kb + exp（不含 device）', () => {
    expect(TIER_RETRIEVAL_PLAN.knowledge).toEqual(['kb', 'exp'])
  })
  it('inspection = exp + kb + device（37-04 GAP-3/4 检索源不分档，device 提示按档保留）', () => {
    expect(TIER_RETRIEVAL_PLAN.inspection).toEqual(['exp', 'kb', 'device'])
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

describe('28-06 R4：目录意图识别 + 清单注入 + 零命中兜底', () => {
  it('目录问法「我的经验库里面有些啥经验」→ 走清单注入非检索', async () => {
    vi.mocked(listExperiences).mockReturnValue({
      rows: [{ title: '评估并升级交换机固件版本' }, { title: '上联配置链路聚合增加冗余' }],
      total: 2, truncated: false,
    } as any)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [], degraded: false, indexTotal: 0, indexCapped: null } as any)

    const r = await retrieveForTier({ tier: 'knowledge', userMessage: '我的经验库里面有些啥经验' })
    // 清单走 listExperiences published 池，不走关键词检索链
    expect(listExperiences).toHaveBeenCalledWith(expect.objectContaining({ status: 'published', includeInvalid: false }))
    expect(retrieveForAnswer).not.toHaveBeenCalled()
    // 注入文本含真实标题清单
    expect(r.promptSection).toContain('经验库共 2 条已发布经验')
    expect(r.promptSection).toContain('评估并升级交换机固件版本')
    expect(r.injected.some((x) => x.title === '经验库目录清单')).toBe(true)
  })

  it('知识库目录问法 → kb 清单注入（同构）', async () => {
    vi.mocked(listDocuments).mockReturnValue([
      { title: '交换机手册', file_name: 'a.pdf' }, { title: '', file_name: 'b.pdf' },
    ] as any)
    vi.mocked(retrieveForAnswer).mockResolvedValue({ demoMode: false, injected: [], reranked: [], finalAnswer: '' } as any)

    const r = await retrieveForTier({ tier: 'knowledge', userMessage: '知识库里都有哪些文档' })
    expect(kbSearch).not.toHaveBeenCalled()
    expect(r.promptSection).toContain('知识库共 2 条文档')
    expect(r.promptSection).toContain('交换机手册')
    expect(r.promptSection).toContain('b.pdf') // title 空回落 file_name
  })

  it('泛词检索零命中 + 消息含「经验库」→ 兜底清单在场', async () => {
    vi.mocked(retrieveForAnswer).mockResolvedValue({ demoMode: false, injected: [], reranked: [], finalAnswer: '' } as any)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [], degraded: false, indexTotal: 0, indexCapped: null } as any)
    vi.mocked(listExperiences).mockReturnValue({
      rows: [{ title: '环路处置经验' }], total: 1, truncated: false,
    } as any)

    const r = await retrieveForTier({ tier: 'knowledge', userMessage: '帮我从经验库找一下环路处理' })
    expect(retrieveForAnswer).toHaveBeenCalled() // 走了正常检索
    expect(r.promptSection).toContain('经验库共 1 条已发布经验') // 零命中兜底清单在场
    expect(r.promptSection).toContain('环路处置经验')
  })

  it('普通检索问法不触发目录意图（行为不回归）', async () => {
    vi.mocked(retrieveForAnswer).mockResolvedValue({ demoMode: false, injected: [], reranked: [], finalAnswer: '' } as any)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [], degraded: false, indexTotal: 0, indexCapped: null } as any)

    const r = await retrieveForTier({ tier: 'knowledge', userMessage: 'stp 环路怎么防' })
    expect(retrieveForAnswer).toHaveBeenCalled()
    expect(listExperiences).not.toHaveBeenCalled()
    expect(listDocuments).not.toHaveBeenCalled()
    expect(r.promptSection).not.toContain('目录清单')
    expect(r.promptSection).not.toContain('经验库共')
  })

  it('detectCatalogIntent 纯函数：中文目录问法变体覆盖', () => {
    expect(detectCatalogIntent('我的经验库里面有些啥经验')).toBe('exp')
    expect(detectCatalogIntent('经验库有哪些内容')).toBe('exp')
    expect(detectCatalogIntent('知识库列一下清单')).toBe('kb')
    expect(detectCatalogIntent('知识库目录是什么')).toBe('kb')
    expect(detectCatalogIntent('资料库都有啥')).toBe('kb')
    expect(detectCatalogIntent('stp 环路怎么防')).toBeNull()
    expect(detectCatalogIntent('怎么配置 vlan')).toBeNull()
  })

  it('buildCatalogText：空库给核实性空清单文案', () => {
    expect(buildCatalogText('exp', { total: 0, titles: [] })).toContain('没有已发布经验')
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
    expect(r.missing).toEqual(['exp', 'device'])
  })
})

describe('28-06 增强a：预取零命中换词引导', () => {
  it('双源零命中 → promptSection 含 EXP/KB 换词引导段与原话关键词', async () => {
    vi.mocked(retrieveForAnswer).mockResolvedValue({ injected: [], reranked: [], finalAnswer: '' } as any)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [], degraded: false, indexTotal: 0, indexCapped: null } as any)

    const r = await retrieveForTier({ tier: 'troubleshoot', userMessage: '核心交换机 ping 不通怎么排查' })
    expect(r.promptSection).toContain('经验库预取（关键词：「核心交换机 ping 不通怎么排查」）未命中相关经验')
    expect(r.promptSection).toContain('[EXP_SEARCH]更具体的关键词[/EXP_SEARCH]')
    expect(r.promptSection).toContain('知识库预取（关键词：「核心交换机 ping 不通怎么排查」）未命中相关文档')
    expect(r.promptSection).toContain('[KB_SEARCH]更具体的关键词[/KB_SEARCH]')
  })

  it('超长原话截断为 40 字符 + 省略号', async () => {
    vi.mocked(retrieveForAnswer).mockResolvedValue({ injected: [], reranked: [], finalAnswer: '' } as any)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [], degraded: false, indexTotal: 0, indexCapped: null } as any)

    const long = 'a'.repeat(80)
    const r = await retrieveForTier({ tier: 'troubleshoot', userMessage: long })
    expect(r.promptSection).toContain(`「${'a'.repeat(40)}…」`)
    expect(r.promptSection).not.toContain(`「${long}」`)
  })

  it('命中场景不注入引导段（防污染正常上下文）', async () => {
    vi.mocked(retrieveForAnswer).mockResolvedValue({ injected: [EXP_HIT], reranked: [], finalAnswer: '' } as any)
    vi.mocked(kbSearch).mockResolvedValue({ rows: [KB_ROW as any], degraded: false, indexTotal: 1, indexCapped: null } as any)

    const r = await retrieveForTier({ tier: 'troubleshoot', userMessage: '端口 down 处置' })
    expect(r.promptSection).toContain('端口 down 处置')
    expect(r.promptSection).not.toContain('未命中相关经验')
    expect(r.promptSection).not.toContain('未命中相关文档')
  })
})
