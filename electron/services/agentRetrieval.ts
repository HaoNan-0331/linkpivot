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
import { search as kbSearch } from './knowledgeBaseService'
import type { AgentTier } from './agentRouter'

/** 证据源种类（KB 文档 / EXP 经验 / 设备上下文提示 / MCP 工具调用轨迹）。 */
export type AgentSourceKind = 'kb' | 'exp' | 'device' | 'mcp'

/**
 * 四档 → 必查数据源组合矩阵（硬编码，无设置页可配）：
 * - troubleshoot：EXP 处置经验 + KB 手册 + 设备上下文提示
 * - configQuery：KB 手册 + 设备上下文提示
 * - knowledge：KB 手册 + EXP 经验（不碰设备）
 * - inspection：EXP 经验 + 设备上下文提示
 */
export const TIER_RETRIEVAL_PLAN: Record<AgentTier, AgentSourceKind[]> = {
  troubleshoot: ['exp', 'kb', 'device'],
  configQuery: ['kb', 'device'],
  knowledge: ['kb', 'exp'],
  inspection: ['exp', 'device'],
}

/** KB 预取命中条数上限（照 experienceRetrieval INJECT_LIMIT 精不多的哲学）。 */
export const KB_TOP_K = 5

/** 设备上下文提示文本（只提示可查，不给数据不执行命令）。 */
const DEVICE_HINT_TEXT =
  '设备上下文：如需现网实时状态，可使用 [CMD:设备名] 命令标记查询（命令仍经白名单与越权防线确认后执行）。'

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

  // EXP 检索（复用 experienceRetrieval 检索链：粗筛→精排→阈值→验证）
  if (plan.includes('exp')) {
    try {
      const exp = await retrieveForAnswer({ userMessage: input.userMessage, deviceIds: input.deviceIds })
      for (const e of exp.injected) {
        injected.push({ kind: 'exp', title: e.title, content: e.content, sourceId: e.exp_id })
      }
    } catch (err) {
      console.warn('[agentRetrieval] exp source failed', (err as Error).message)
    }
  }

  // KB 检索（knowledgeBaseService.search：LLM 索引挑选，含降级路径）
  if (plan.includes('kb')) {
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
