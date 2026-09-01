/**
 * Phase 28（AGENT-01）：分档强制预取矩阵编排 + 后置证据校验。
 *
 * 「该查必调」架构的预取半边：classifyTier 的分类结果在这里决定「查什么」——
 * 预取是代码行为（TIER_RETRIEVAL_PLAN 矩阵硬编码），不经模型自觉打标。
 * 「设备上下文」只注入「提示 AI 可用 [CMD:设备名] 查询现网」文本（RESEARCH Q2 口径：
 * 预取=检索类动作，绝不自动执行命令——本文件不 import 任何命令执行路径，grep 可验）。
 * verifySourcesEvidence 后置对照循环轨迹 sources，必查源缺席即列 missing（fail-closed），
 * 供 28-04 agent 循环收尾补查/诚实收尾判定。
 *
 * 函数式编排（无 class、无 MK），复用 experienceRetrieval 检索链与 knowledgeBaseService.search
 * （experienceRetrieval.ts Pattern 1b 先例）。KB/EXP 命中内容属不可信文本——注入 prompt 前的
 * sanitizeUntrusted 清洗由 28-04 接线层执行（T-28-02-02），本层输出原始 injected 数组。
 */

import { getAiConfig } from './ai'
import { retrieveForAnswer } from './experienceRetrieval'
import { search as kbSearch, listDocuments } from './knowledgeBaseService'
import { listExperiences } from './experienceService'
import type { AgentTier } from './agentRouter'

/** 证据源种类（KB 文档 / EXP 经验 / 设备上下文提示 / MCP 工具调用轨迹）。 */
export type AgentSourceKind = 'kb' | 'exp' | 'device' | 'mcp'

/**
 * 四档 → 必查数据源组合矩阵（硬编码，无设置页可配）。
 * kb/exp 检索源不分档恒双库（Phase 37 GAP-3/4 用户真机裁决 2026-09-01：开预取则知识库 + 经验库都预取，
 * 强制补查缺失源两库都补）；device 上下文提示维持按档（knowledge 不含——纯问答不碰设备）：
 * - troubleshoot：EXP 处置经验 + KB 手册 + 设备上下文提示
 * - configQuery：KB 手册 + EXP 经验 + 设备上下文提示
 * - knowledge：KB 手册 + EXP 经验（不碰设备）
 * - inspection：EXP 经验 + KB 手册 + 设备上下文提示
 */
export const TIER_RETRIEVAL_PLAN: Record<AgentTier, AgentSourceKind[]> = {
  troubleshoot: ['exp', 'kb', 'device'],
  configQuery: ['kb', 'exp', 'device'],
  knowledge: ['kb', 'exp'],
  inspection: ['exp', 'kb', 'device'],
}

/** KB 预取命中条数上限（照 experienceRetrieval INJECT_LIMIT 精不多的哲学）。 */
export const KB_TOP_K = 5

/** 设备上下文提示文本（只提示可查，不给数据不执行命令）。 */
const DEVICE_HINT_TEXT =
  '设备上下文：如需现网实时状态，可使用 [CMD:设备名] 命令标记查询（命令仍经白名单与越权防线确认后执行）。'

/**
 * 28-06 R4（目录意图）：目录性问法词——「库里有什么」是目录列举请求而非检索请求，
 * 用户不知道标题含什么词，关键词检索注定空手（真机缺陷：AI 收零结果脑补「库是空的」）。
 * 命中目录意图时跳过关键词检索，代码层直接列标题清单注入。
 */
const CATALOG_QUESTION_RE =
  /(有哪些|有什么|有些什么|些什么|哪一些|包含哪些|包含什么|列一下|列出来|列个|清单|目录|列表|都是啥|都有啥|有啥|些啥|啥内容|什么内容)/

/** 目录清单注入条数上限（防超长 prompt）。 */
export const CATALOG_TOP_N = 20

/** 目录意图目标库（exp=经验库 / kb=知识库）。 */
export type CatalogKind = 'exp' | 'kb'

/** 消息是否提及经验库字样（零命中兜底防 AI 事实性错误「库是空的」）。 */
export function mentionsExpLibrary(userMessage: string): boolean {
  return /经验库|经验/.test(userMessage || '')
}

/** 消息是否提及知识库字样（含更名前「资料库」用户习惯）。 */
export function mentionsKbLibrary(userMessage: string): boolean {
  return /知识库|资料库/.test(userMessage || '')
}

/**
 * 目录意图识别（纯函数，privilegeGuard 风格可单测）：
 * 目录问法 × 库字样命中 → 返回目标库；普通检索问法返回 null（行为零回归）。
 * 同时提两库时经验库优先（先列经验清单，AI 可再触 kb 目录意图追问）。
 */
export function detectCatalogIntent(userMessage: string): CatalogKind | null {
  const msg = userMessage || ''
  if (!CATALOG_QUESTION_RE.test(msg)) return null
  if (mentionsExpLibrary(msg)) return 'exp'
  if (mentionsKbLibrary(msg)) return 'kb'
  return null
}

/** 目录清单（titles 为原始标题，不可信文本——注入 prompt 前由接线层 sanitizeUntrusted 清洗）。 */
export interface CatalogListing {
  total: number
  titles: string[]
}

/** 经验库目录清单（只列已发布经验，published + bi-temporal 过滤同检索池口径）。 */
export function listExpCatalog(limit = CATALOG_TOP_N): CatalogListing {
  const { rows, total } = listExperiences({ status: 'published', includeInvalid: false, limit })
  return { total: total ?? rows.length, titles: rows.map((r: any) => r.title || '无标题') }
}

/** 知识库目录清单（文档标题，复用既有 listDocuments 最小查询，不新建接口）。 */
export function listKbCatalog(limit = CATALOG_TOP_N): CatalogListing {
  const docs = listDocuments()
  return { total: docs.length, titles: docs.slice(0, limit).map((d: any) => d.title || d.file_name || '无标题') }
}

/** 目录清单 → 注入文本（经验库共 N 条已发布经验：1. xxx 2. xxx ...）。 */
export function buildCatalogText(kind: CatalogKind, listing: CatalogListing): string {
  const name = kind === 'exp' ? '经验库' : '知识库'
  if (!listing.titles || listing.titles.length === 0) {
    return `${name}当前没有${kind === 'exp' ? '已发布经验' : '任何文档'}（此为系统核实的真实清单，非推测）`
  }
  return `${name}共 ${listing.total} 条${kind === 'exp' ? '已发布经验' : '文档'}：${listing.titles
    .map((t, i) => `${i + 1}. ${t}`)
    .join(' ')}`
}

export interface TierRetrieveInput {
  tier: AgentTier
  userMessage: string
  deviceIds?: string[]
}

/** 注入引用条目（kind 区分来源，payload 供 28-04 溯源 UI / sanitize 后入 prompt）。 */
export interface InjectedSource {
  kind: AgentSourceKind
  title: string
  content: string
  /** 溯源 id（exp_id / chunk id / null=device 提示）。 */
  sourceId: string | null
}

export interface TierRetrieveResult {
  demoMode: boolean
  /** 本档强制预取计划（TIER_RETRIEVAL_PLAN[tier] 原样回显，供轨迹记录）。 */
  plan: AgentSourceKind[]
  /** 实际命中的注入引用（原始文本，未 sanitize）。 */
  injected: InjectedSource[]
  /** 组装好的 prompt 注入文本段（demoMode/零命中为空串）。 */
  promptSection: string
}

/**
 * 分档预取：按矩阵组合检索 EXP/KB 并组装注入段。
 * demoMode（未配 AI）短路不抛错（照 retrieveForAnswer）；单源检索抛错降级为该源零命中
 * （fail-closed——缺席由 verifySourcesEvidence 后置暴露，不静默放行）。
 */
export async function retrieveForTier(input: TierRetrieveInput): Promise<TierRetrieveResult> {
  const plan = TIER_RETRIEVAL_PLAN[input.tier] ?? TIER_RETRIEVAL_PLAN.knowledge
  const empty: TierRetrieveResult = { demoMode: true, plan, injected: [], promptSection: '' }

  const config = getAiConfig()
  if (!config || !config.apiKey) return empty

  const injected: InjectedSource[] = []

  // 28-06 R4：目录意图（「经验库里有些啥」类）——目录列举请求不做关键词检索，
  // 代码层直接列标题清单注入（检索对泛问句注定零命中，AI 拿零结果会脑补「库是空的」）。
  const catalogIntent = detectCatalogIntent(input.userMessage)

  // EXP 检索（复用 experienceRetrieval 检索链：粗筛→精排→阈值→验证）
  if (plan.includes('exp')) {
    if (catalogIntent === 'exp') {
      try {
        const text = buildCatalogText('exp', listExpCatalog())
        injected.push({ kind: 'exp', title: '经验库目录清单', content: text, sourceId: null })
      } catch (err) {
        console.warn('[agentRetrieval] exp catalog failed', (err as Error).message)
      }
    } else {
      try {
        const exp = await retrieveForAnswer({ userMessage: input.userMessage, deviceIds: input.deviceIds })
        for (const e of exp.injected) {
          injected.push({ kind: 'exp', title: e.title, content: e.content, sourceId: e.exp_id })
        }
      } catch (err) {
        console.warn('[agentRetrieval] exp source failed', (err as Error).message)
      }
      // 28-06 R4 兜底防线：零命中且用户消息提及经验库 → 附目录清单（防 AI 事实性错误「库是空的」）
      if (injected.every((x) => x.kind !== 'exp') && mentionsExpLibrary(input.userMessage)) {
        try {
          const text = buildCatalogText('exp', listExpCatalog())
          injected.push({ kind: 'exp', title: '经验库目录清单', content: text, sourceId: null })
        } catch (err) {
          console.warn('[agentRetrieval] exp catalog fallback failed', (err as Error).message)
        }
      }
    }
  }

  // KB 检索（knowledgeBaseService.search：LLM 索引挑选，含降级路径）
  if (plan.includes('kb')) {
    if (catalogIntent === 'kb') {
      try {
        const text = buildCatalogText('kb', listKbCatalog())
        injected.push({ kind: 'kb', title: '知识库目录清单', content: text, sourceId: null })
      } catch (err) {
        console.warn('[agentRetrieval] kb catalog failed', (err as Error).message)
      }
    } else {
      try {
        const kb = await kbSearch(input.userMessage, input.deviceIds, KB_TOP_K)
        for (const row of kb.rows ?? []) {
          injected.push({
            kind: 'kb',
            title: `${row.document?.title ?? '文档'} / ${row.title || '无标题'}`,
            content: row.content || '',
            sourceId: row.id ?? null,
          })
        }
      } catch (err) {
        console.warn('[agentRetrieval] kb source failed', (err as Error).message)
      }
      // 28-06 R4 兜底防线：零命中且用户消息提及知识库 → 附目录清单
      if (injected.every((x) => x.kind !== 'kb') && mentionsKbLibrary(input.userMessage)) {
        try {
          const text = buildCatalogText('kb', listKbCatalog())
          injected.push({ kind: 'kb', title: '知识库目录清单', content: text, sourceId: null })
        } catch (err) {
          console.warn('[agentRetrieval] kb catalog fallback failed', (err as Error).message)
        }
      }
    }
  }

  // 组装注入段（device 档追加提示文本；零命中知识源时仍给提示，缺席交由后置校验暴露）
  const sections: string[] = []
  const expHits = injected.filter((x) => x.kind === 'exp')
  const kbHits = injected.filter((x) => x.kind === 'kb')
  if (expHits.length > 0) {
    sections.push('相关运维经验：\n' + expHits.map((e) => `- ${e.title}：${e.content}`).join('\n'))
  }
  if (kbHits.length > 0) {
    sections.push('相关知识库文档：\n' + kbHits.map((k) => `- ${k.title}：${k.content}`).join('\n'))
  }
  // 28-06 增强a：预取零命中显式告知 + 换词主动检索引导——预取/后置补查都用用户原话做检索词，
  // 词不匹配时两层代码检索全白搭；唯一换词路径是 AI 主动打标记（模型行为），此处把「可以换词」
  // 从资源地图的隐性能力变成针对本次零命中的明确指令，杜绝 AI 拿零命中当「库为空」直接收尾。
  const qBrief = input.userMessage.length > 40 ? `${input.userMessage.slice(0, 40)}…` : input.userMessage
  if (expHits.length === 0 && plan.includes('exp')) {
    sections.push(
      `经验库预取（关键词：「${qBrief}」）未命中相关经验。若你认为可能存在相关运维经验，` +
        '请在回复中单独输出一行标记 [EXP_SEARCH]更具体的关键词[/EXP_SEARCH] 主动检索；检索前不要断言经验库为空。'
    )
  }
  if (kbHits.length === 0 && plan.includes('kb')) {
    sections.push(
      `知识库预取（关键词：「${qBrief}」）未命中相关文档。若你认为可能存在相关文档，` +
        '请用 [KB_SEARCH]更具体的关键词[/KB_SEARCH] 主动检索。'
    )
  }
  if (plan.includes('device')) sections.push(DEVICE_HINT_TEXT)

  return { demoMode: false, plan, injected, promptSection: sections.join('\n\n') }
}

export interface VerifyEvidenceInput {
  tier: AgentTier
  /** agent 循环实际查过的源轨迹（28-04 循环收尾时回填）。 */
  sources: Array<{ kind: AgentSourceKind }>
}

export interface VerifyEvidenceResult {
  /** 缺席必查源 kind 清单（空=证据齐全）。 */
  missing: string[]
  /** 可执行的补救描述（fail-closed：缺席必须给出补查指引，绝不静默放行）。 */
  remedy: string
}

/**
 * 后置证据校验：按 TIER_RETRIEVAL_PLAN 对照循环轨迹 sources 判必查源缺席。
 * 纯函数；缺席即列 kind 名，供 28-04 循环收尾补查或诚实收尾（声明未查实时数据）。
 */
export function verifySourcesEvidence(input: VerifyEvidenceInput): VerifyEvidenceResult {
  const plan = TIER_RETRIEVAL_PLAN[input.tier] ?? TIER_RETRIEVAL_PLAN.knowledge
  const visited = new Set((input.sources ?? []).map((s) => s.kind))
  const missing = plan.filter((k) => !visited.has(k)).map(String)
  if (missing.length === 0) return { missing: [], remedy: '' }
  return {
    missing,
    remedy: `必查源缺席（${missing.join('、')}）：请补查对应数据源后再作答，或在回复中明确声明未查询该来源。`,
  }
}
