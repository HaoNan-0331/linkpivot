/**
 * aiPayload —— AI 回复后的 payload 装配纯函数群（Phase 32 / D-03）。
 *
 * 身份声明：本模块是「AI 回复后的 payload 装配」（exp_answer/kb_answer/agent_answer 包装、
 * agent meta 生成、kb/exp 引用合并、收尾证据补查），区别于 harness 报告 §2.3 设想的
 * aiContext「发给 AI 前的上下文组装」概念——报告该设想不采纳（见 32-CONTEXT.md canonical refs）。
 *
 * Phase 32（D-01 / D-03 / D-05）：机械搬移自 ai.ts 原装配段（拆分前原始行号 :2566-2819），
 * 函数体逐字零改动，保持源函数形态（不转静态类）。
 *
 * 依赖方向：供 aiChat / confirm 链引用，import 方向单向（本模块不反向 import aiChat）。
 * AgentStep/SourceRecord/AgentLoopState/McpLoopCtx 类型自 Phase 32 P3 起 import type 直连
 * './aiAgentState'（type-only 编译后擦除）；pushTaggedRetrievalStep/buildKbRoundContext/
 * stripAllAgentMarkers 自 P3 起值引用 './aiAgentLoop'——该三函数的调用时点晚于模块加载，
 * 与既存 ai.ts ↔ knowledgeBaseService 运行时环同构（CJS/ESM 双安全）；P2 的 './ai'
 * 过渡引用已全部清零。
 */

import { sanitizeUntrusted } from './untrustedText'
import { search as kbSearch } from './knowledgeBaseService'
import { retrieveForAnswer } from './experienceRetrieval'
import { callAI } from './aiClient'
import { verifySourcesEvidence, TIER_RETRIEVAL_PLAN } from './agentRetrieval'
import type { AgentTier } from './agentRouter'
import type { AgentStep, SourceRecord, AgentLoopState, McpLoopCtx } from './aiAgentState'
import { resolveBackfillMode } from './aiAgentState'
import { parseBackfillQueries, stripBackfillMarkers } from './aiAgentParse'
import { pushTaggedRetrievalStep, buildKbRoundContext, stripAllAgentMarkers } from './aiAgentLoop'

// ---------- Phase 11 experience references helpers ----------
// UAT fix：经验引用 references 映射——chat()/confirmCommand 所有返回路径（无命令 exp_answer /
// 有命令 confirm+auto / confirmCommand finalReply）统一用它，确保命令执行场景也返来源列表。

/** expReferences → exp_answer references 数组（统一 camelCase + kind:'experience'）。 */
export function mapExpRefs(
  expRefs: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
) {
  return expRefs.map((e) => ({
    kind: 'experience' as const,
    expId: e.exp_id,
    title: e.title,
    sourceSessionId: e.source_session_id,
    unsupported: e.unsupported,
  }))
}

/** 把最终回复包装成 exp_answer JSON（renderer useAIChat 解析 references 渲染来源列表）。 */
export function buildExpAnswerPayload(
  content: string,
  expRefs: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
): string {
  return JSON.stringify({ type: 'exp_answer', content, references: mapExpRefs(expRefs) })
}

// ---------- Phase 28（28-04）：分档预取接线 + 后置证据校验 + agent_answer payload ----------

/**
 * AGENT-05（D-09/D-11）：代码层按 AgentLoopState 真实执行轨迹生成 agent meta——
 * sources/steps/tier 全部来自代码记录，prompt 文本无参与路径（T-28-04-04 防 prompt 伪造）。
 * noRealtimeData = 零检索来源且无任何 cmd/mcp 执行步（纯既有知识作答）。
 */
export function buildAgentMeta(
  state: Pick<AgentLoopState, 'steps' | 'sources' | 'backfillNotes' | 'unqueriedSources'> & { hardStop?: 'user_cancel' },
  tier: AgentTier
): { sources: SourceRecord[]; steps: AgentStep[]; tier: AgentTier; noRealtimeData: boolean; hardStop?: 'user_cancel'; backfillNotes?: string[]; unqueriedSources?: string[] } {
  const noRealtimeData =
    state.sources.length === 0 &&
    !state.steps.some((s) => s.actionType === 'cmd' || s.actionType === 'mcp')
  const meta: ReturnType<typeof buildAgentMeta> = {
    sources: state.sources,
    steps: state.steps,
    tier,
    noRealtimeData,
  }
  if (state.backfillNotes && state.backfillNotes.length > 0) meta.backfillNotes = state.backfillNotes
  if (state.unqueriedSources && state.unqueriedSources.length > 0) meta.unqueriedSources = state.unqueriedSources
  if (state.hardStop) meta.hardStop = state.hardStop
  return meta
}

/**
 * Phase 37（37-02，D-05/D-06，planner_ruling 5）：智能模式「未查询源」判定——
 * TIER_RETRIEVAL_PLAN[tier] 中未 attempted 的 kind。attempted 口径：
 * - sources 中出现过的 kind；
 * - steps 中 actionType 为 'kb'/'exp' 的 kind（**任意 status**——failed 卡本身已对用户可见，
 *   再标「未查询」自相矛盾）；
 * - device 判定：存在 actionType 'cmd' 或 'mcp' 的 step，或 sources 含 kind='device'。
 * 纯函数、代码层按 state 真实轨迹计算（T-37-08 防 prompt 伪造，与 noRealtimeData 同型）；
 * 落本文件而不动 agentRetrieval.ts（保其测试基线，plan 裁决）。
 */
export function computeUnqueriedSources(state: Pick<AgentLoopState, 'sources' | 'steps'>, tier: AgentTier): string[] {
  const plan = TIER_RETRIEVAL_PLAN[tier] ?? TIER_RETRIEVAL_PLAN.knowledge
  const attempted = new Set<string>()
  for (const s of state.sources) attempted.add(s.kind)
  if (state.sources.some((s) => s.kind === 'device')) attempted.add('device')
  for (const s of state.steps) {
    if (s.actionType === 'kb' || s.actionType === 'exp') attempted.add(s.actionType)
    if (s.actionType === 'cmd' || s.actionType === 'mcp') attempted.add('device')
  }
  return plan.filter((k) => !attempted.has(k)).map(String)
}

/** exp 引用合并（exp_id 去重——预取与循环/补查同源命中只计一次，D-09） */
export function mergeExpRefs(
  existing: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>,
  injected: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
): void {
  const byId = new Map(existing.map((e) => [e.exp_id, e]))
  for (const e of injected) {
    const prev = byId.get(e.exp_id)
    if (!prev) {
      existing.push(e)
      byId.set(e.exp_id, e)
    } else if (prev.source_session_id == null && e.source_session_id != null) {
      // 预取条目缺 source_session_id 时被完整条目覆写（保留更丰富溯源）
      Object.assign(prev, e)
    }
  }
}

/** kb 引用合并（docTitle+chunkTitle 去重——预取与循环检索的 docId 口径不同，标题对齐更稳） */
export function mergeKbRefs(
  existing: Array<{ docTitle: string; chunkTitle: string; docId: string }>,
  refs: Array<{ docTitle: string; chunkTitle: string; docId: string }>
): void {
  const seen = new Set(existing.map((r) => `${r.docTitle}|${r.chunkTitle}`))
  for (const r of refs) {
    const key = `${r.docTitle}|${r.chunkTitle}`
    if (!seen.has(key)) {
      existing.push(r)
      seen.add(key)
    }
  }
}

/**
 * 最终回答统一 payload 组装（AGENT-05）：
 * - kb/exp 引用在场：保持既有 exp_answer/kb_answer 契约（renderer 已消费），meta 字段（sources/steps/
 *   tier/noRealtimeData）随 payload 附带；
 * - 无 kb/exp 引用但有执行轨迹（cmd/mcp 步骤或非空 sources）：包装 { type:'agent_answer', content, ...meta }
 *   （28-05 renderer parseAiReply 消费）；
 * - 零轨迹纯文本：原样返回（不把普通问答变 JSON，renderer 零影响）。
 */
export function wrapAgentFinalPayload(
  content: string,
  refs: {
    kbReferences: Array<{ docTitle: string; chunkTitle: string; docId: string }>
    expReferences: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
  },
  state: AgentLoopState,
  tier: AgentTier
): string {
  const meta = buildAgentMeta(state, tier)
  const hasTrajectory =
    state.sources.length > 0 || state.steps.some((s) => s.actionType === 'cmd' || s.actionType === 'mcp')
  // kb/exp 引用在场：保持既有 kb_answer/exp_answer 契约（renderer 已消费），meta 字段附带
  if (refs.kbReferences.length > 0 && refs.expReferences.length > 0) {
    const merged = [
      ...refs.kbReferences.map((r) => ({ kind: 'kb', docTitle: r.docTitle, chunkTitle: r.chunkTitle, docId: r.docId })),
      ...mapExpRefs(refs.expReferences),
    ]
    return JSON.stringify({ type: 'exp_answer', content, references: merged, ...meta })
  }
  if (refs.kbReferences.length > 0) {
    return JSON.stringify({ type: 'kb_answer', content, references: refs.kbReferences, ...meta })
  }
  if (refs.expReferences.length > 0) {
    return JSON.stringify({ type: 'exp_answer', content, references: mapExpRefs(refs.expReferences), ...meta })
  }
  // 无 kb/exp 引用但有执行轨迹（cmd/mcp 步骤或非空 sources）→ agent_answer（28-05 renderer 消费）
  if (hasTrajectory) {
    return JSON.stringify({ type: 'agent_answer', content, references: [], ...meta })
  }
  return content
}

/**
 * Phase 37 GAP-2（2026-09-01 用户真机裁决）：换词重查请求构造——同词已查不再是跳过理由
 * 而是换词理由。runEvidenceBackfill 守卫命中后向 AI 追加单轮换词请求：逐源列出已查关键词，
 * 要求给出**不同的**、更具体的关键词并以 [EXP_BACKFILL]/[KB_BACKFILL] 标记输出；AI 判断
 * 某源确实无相关内容可不输出标记、基于现有信息直接作答（fail-open）。
 * triedQuery 一律为 sanitize-200 形态的已入库 query（无二次清洗必要但不得变形，T-37G5-01）。
 * 纯函数（消息体拼装），不触 state。
 */
export function buildRewordRequest(pending: Array<{ kind: 'exp' | 'kb'; triedQuery: string }>): string {
  const KIND_LABELS: Record<'exp' | 'kb', string> = { exp: '经验库', kb: '知识库' }
  const lines = pending.map((p) => `${KIND_LABELS[p.kind]}：已查关键词 "${p.triedQuery}"`)
  return (
    '系统提示：以下数据源在本轮对话中已用所示关键词检索且未命中，需要换词重查：\n' +
    lines.join('\n') +
    '\n请为每个仍需检索的数据源重新提炼一个与已查关键词不同的、更具体的关键词，在回复末尾单独一行输出对应标记：\n' +
    '[EXP_BACKFILL]经验库新关键词[/EXP_BACKFILL]\n' +
    '[KB_BACKFILL]知识库新关键词[/KB_BACKFILL]\n' +
    '若你判断某数据源确实无相关内容，可不输出对应标记，并基于现有信息直接给出最终回答；不要输出与已查关键词相同的词。'
  )
}

/**
 * AGENT-03 收尾证据校验（fail-closed 闭环）：对照 TIER_RETRIEVAL_PLAN 检查循环轨迹 sources，
 * 必查源缺席 → 对缺席检索源（exp/kb）自动补查一次：
 * - 补查命中 → user-role 回注 + 一次 callAI 收尾（结果只进 user 消息，T-22-08）；
 * - 补查零命中/失败/设备源未查 → 知情记录落 state.backfillNotes（随 payload/meta_enc 持久化，D-11），
 *   不追加 LLM 轮、不改写回复正文（既有回复文本契约零污染）。
 * 同词已查守卫（260830 quick → Phase 37 GAP-2 语义升级 2026-09-01）：该源已用同 kind + 同 query
 * 检索过且未命中（status 非 failed）→ 不再是跳过理由而是换词理由（用户真机裁决），记入
 * rewordPending 请求 AI 换词重查（单次有界）；failed 步骤不算已查过（保留一次重试），
 * 未查过的源照常补查。
 * 用户中断（hardStop）后不再发起任何 LLM 调用（D-06 立即中止不总结，换词轮前同样复检）。
 *
 * Phase 37（37-02，D-01~D-08）：强制/智能双模式分流（单入口签名不变，5 调用点零改动）——
 * 模式经 resolveBackfillMode(tier) 裁决（D-02 troubleshoot 恒 force 的唯一权威点，禁止内联判断）：
 * - FORCE（开关 force / troubleshoot 档）：保留既有 verify→missing→逐 kind 骨架与全部文案；
 *   每缺失源检索词升级为「AI 标记词优先（[EXP_BACKFILL]/[KB_BACKFILL] 标记体，sanitize 双
 *   形态链，ruling 4），无标记 fallback 用户原话」（D-07）；missing 之外 AI 换词标记的已查源
 *   同样受理检索（D-08）。
 * - SMART（开关 smart，默认）：AI 决策驱动——回复无标记即零检索零卡零 LLM 轮，仅按档位矩阵
 *   产出 state.unqueriedSources 未查源清单（D-05/D-06）；有标记则按标记词针对性检索（D-04），
 *   命中回注再答一轮。BACKFILL 标记是智能模式的补查载体，本函数全部返回值统一经
 *   stripBackfillMarkers——任何出口不漏标记原文（T-37-07）；早返条件 missing 空且零标记才放行。
 * Phase 37 GAP-2（37-05）：同词已查不再是跳过理由而是换词理由（2026-09-01 用户真机裁决）；
 * 守卫命中 → 换词轮（单次有界）→ 新词检索三件套，智能 + 强制两模式统一。
 * 换词轮标记形态区分出口基准（2026-09-01 UAT 修复）：换词轮有标记（过渡语形态）且新词
 * 检索未命中 → 返回原始 reply；零标记（作答形态）→ 返回 rewordReply。
 */
export async function runEvidenceBackfill(
  ctx: McpLoopCtx,
  state: AgentLoopState,
  tier: AgentTier,
  reply: string
): Promise<string> {
  // Phase 37：模式裁决（D-02 唯一权威点 resolveBackfillMode）+ 标记解析（收尾补查载体）
  const mode = resolveBackfillMode(tier)
  const markers = parseBackfillQueries(reply)
  if (state.hardStop) return stripBackfillMarkers(reply)
  if (mode === 'smart') {
    // ---- SMART 分支（D-01 智能语义：AI 决策驱动，未标记即不补）----
    if (markers.length === 0) {
      // 未标记：零检索零卡零 LLM 轮；仅产出「未查询源」meta（D-05/D-06，非空才写 state）
      const unqueried = computeUnqueriedSources(state, tier)
      if (unqueried.length > 0) state.unqueriedSources = unqueried
      return stripBackfillMarkers(reply)
    }
    const sections: string[] = []
    let hasNewEvidence = false
    // GAP-2（37-05，2026-09-01 用户真机裁决）：同词已查守卫命中 → 不再跳过，记入 rewordPending
    // 请求 AI 换词重查（同词是换词的理由，不是不查的理由）
    const rewordPending: Array<{ kind: 'exp' | 'kb'; triedQuery: string }> = []
    /** 单 kind 补查三件套（卡入轨 + 命中回注素材 + 失败卡）——首轮标记循环与换词轮新标记共用（37-05 提取） */
    const runSmartRetrieval = async (kind: 'exp' | 'kb', query: string): Promise<void> => {
      if (kind === 'exp') {
        try {
          const retrieval = await retrieveForAnswer({ userMessage: query, deviceIds: ctx.deviceIds })
          const injected = retrieval?.injected ?? []
          pushTaggedRetrievalStep(state, 'exp', query,
            injected.length > 0 ? `命中 ${injected.length} 条：${injected.map((e: any) => e.title).join('；')}` : '经验库未命中（补查）',
            'backfilled')
          if (injected.length > 0) {
            hasNewEvidence = true
            sections.push(`以下是系统补查经验库命中的相关经验（关键词: "${query}"）：\n\n${buildExpContextText(injected, !!(ctx.deviceIds && ctx.deviceIds.length > 0))}`)
            mergeExpRefs(ctx.expReferences, injected.map((e: any) => ({
              exp_id: e.exp_id, title: e.title, source_session_id: e.source_session_id ?? null, unsupported: e.unsupported,
            })))
            for (const e of injected) state.sources.push({ kind: 'exp', title: e.title, refId: e.exp_id })
          } else {
            sections.push(`【系统补查·经验库】经验库无相关内容（系统已自动补查"${query}"，未命中）。`)
          }
        } catch {
          pushTaggedRetrievalStep(state, 'exp', query, '经验库补查失败', 'backfilled', 'failed')
          sections.push('【系统补查·经验库】经验库补查失败。')
        }
      } else {
        try {
          const rows = (await kbSearch(query, ctx.deviceIds, 5)).rows ?? []
          pushTaggedRetrievalStep(state, 'kb', query,
            rows.length > 0 ? `命中 ${rows.length} 条：${rows.map((r: any) => `${r.document?.title ?? '文档'} / ${r.title || '无标题'}`).join('；')}` : '知识库未命中（补查）',
            'backfilled')
          if (rows.length > 0) {
            hasNewEvidence = true
            const { contextText, references } = buildKbRoundContext(rows)
            sections.push(`以下是系统补查知识库命中的相关文档片段（关键词: "${query}"）：\n\n${contextText}`)
            if (ctx.kbReferences) mergeKbRefs(ctx.kbReferences, references)
            for (const r of references) state.sources.push({ kind: 'kb', title: `${r.docTitle} / ${r.chunkTitle}`, refId: r.docId })
          } else {
            sections.push(`【系统补查·知识库】知识库无相关内容（系统已自动补查"${query}"，未命中）。`)
          }
        } catch {
          pushTaggedRetrievalStep(state, 'kb', query, '知识库补查失败', 'backfilled', 'failed')
          sections.push('【系统补查·知识库】知识库补查失败。')
        }
      }
    }
    for (const { kind, query: markerQuery } of markers) {
      // ruling 4：AI 生成检索词清洗——与既有用户原话幂等链逐字同构（保 alreadySearched 守卫可比性）
      const query = sanitizeUntrusted(markerQuery, 500)
      const canonicalQuery = sanitizeUntrusted(query, 200)
      // 91e35da 同词已查守卫（判定谓词原样保留，只改命中响应——GAP-2）：命中 → 换词重查
      const alreadySearched = state.steps.some(
        (s) => s.actionType === kind && s.status !== 'failed' && (s.query === query || s.query === canonicalQuery)
      )
      if (alreadySearched) {
        const libName = kind === 'exp' ? '经验库' : '知识库'
        sections.push(`【系统补查·${libName}】${libName}已用关键词 "${canonicalQuery}" 检索未命中，已请求换词重查。`)
        rewordPending.push({ kind, triedQuery: canonicalQuery })
        continue
      }
      await runSmartRetrieval(kind, query)
    }
    // 换词轮（GAP-2，37-05）：单次有界——结构性单个 if 块无循环回跳，换词后仍同词仅落事实文案，
    // 绝无第二次换词（T-37G5-03 DoS 轮次放大防护）
    let finalBasis = reply
    // UAT 修复（2026-09-01 真机实证）：换词轮是否产出标记决定未命中出口的返回基准（见下方出口注释）
    let rewordProducedMarkers = false
    if (rewordPending.length > 0) {
      if (state.hardStop) return stripBackfillMarkers(reply)
      state.extra.push({ role: 'assistant', content: stripBackfillMarkers(reply) })
      state.extra.push({ role: 'user', content: buildRewordRequest(rewordPending) })
      const rewordReply = await callAI(ctx.config, [...ctx.fullMessages, ...state.extra], ctx.signal)
      finalBasis = rewordReply
      const rewordMarkers = parseBackfillQueries(rewordReply)
      rewordProducedMarkers = rewordMarkers.length > 0
      for (const { kind, query: markerQuery } of rewordMarkers) {
        const query = sanitizeUntrusted(markerQuery, 500)
        const canonicalQuery = sanitizeUntrusted(query, 200)
        // 守卫复检（换词有界）：换词后仍与已查词相同 → 事实告知收尾，不再检索
        const stillSearched = state.steps.some(
          (s) => s.actionType === kind && s.status !== 'failed' && (s.query === query || s.query === canonicalQuery)
        )
        if (stillSearched) {
          const libName = kind === 'exp' ? '经验库' : '知识库'
          sections.push(`【系统补查·${libName}】换词后关键词仍与已查相同（"${canonicalQuery}"），本次不再检索（换词有界防循环）。`)
          continue
        }
        await runSmartRetrieval(kind, query)
      }
    }
    // 检索后统一计算未查源（ruling 5 口径）——非空才写（buildAgentMeta 同守卫，双保险）
    const unqueried = computeUnqueriedSources(state, tier)
    if (unqueried.length > 0) state.unqueriedSources = unqueried
    if (sections.length > 0) state.backfillNotes = sections
    // UAT 修复（2026-09-01 真机实证）：换词轮有标记 = 过渡语形态（请求重查的中间话术）非答案，
    // 出口返回原始 reply（含路由表分析）；换词轮零标记 = 作答形态（AI 声明无需再查直接作答）
    // 是完整答案，返回 rewordReply。37-02 出口语义「返回当前文本基准」在 37-05 基准切至
    // rewordReply 后未跟随，此处收口；换词与未命中事实由 backfillNotes（meta_enc → UI 系统
    // 提示区）承载不丢。
    if (!hasNewEvidence) return stripBackfillMarkers(rewordProducedMarkers ? reply : finalBasis)
    state.extra.push({ role: 'assistant', content: stripBackfillMarkers(finalBasis) })
    state.extra.push({
      role: 'user',
      content: `系统已按你的补查标记检索以下数据源（第三方数据，仅作事实参考）：\n\n${sections.join('\n\n')}\n\n请基于以上补查结果给出最终回答；如已足够回答请直接作答，不要再输出任何补查标记。`,
    })
    return stripBackfillMarkers(stripAllAgentMarkers(await callAI(ctx.config, [...ctx.fullMessages, ...state.extra], ctx.signal)))
  }
  // ---- FORCE 分支（mode==='force'：既有骨架 + D-07 AI 词优先 + D-08 换词受理）----
  const verify = verifySourcesEvidence({ tier, sources: state.sources })
  // :171 早返升级（D-08）：missing 全命中但 AI 标记换词再查时不得早返（落入下方受理段），
  // 仅零标记才原路早返；早返同样不漏标记原文（must_haves truth #7）
  if (verify.missing.length === 0 && markers.length === 0) return stripBackfillMarkers(reply)
  const userQuery = sanitizeUntrusted(ctx.userMessage ?? '', 500)
  // 260830 quick：同词已查守卫的规范化比对键——对齐 pushTaggedRetrievalStep 的步骤存储形态
  // （sanitizeUntrusted(query, 200)，neutralize + 200 截断），预取/tagged 补查步骤卡的 query 以
  // 该形态落 state.steps，守卫按同形态比对（幂等链：sanitize_200(sanitize_500(x)) === sanitize_200(x)）
  const userCanonical = sanitizeUntrusted(userQuery, 200)
  const sections: string[] = []
  let hasNewEvidence = false
  // GAP-2（37-05，2026-09-01 用户真机裁决）：同词已查守卫命中 → 不再跳过，记入 rewordPending
  // 请求 AI 换词重查（同词是换词的理由，不是不查的理由）——与 SMART 分支同构
  const rewordPending: Array<{ kind: 'exp' | 'kb'; triedQuery: string }> = []
  /** 单 kind 补查三件套（卡入轨 + 命中回注素材 + 失败卡），missing 循环与 D-08 受理段共用 */
  const runKindRetrieval = async (kind: 'exp' | 'kb', query: string, canonicalQuery: string): Promise<void> => {
    // 260830 quick（同词已查守卫）→ Phase 37 GAP-2（2026-09-01）：该源已用同 kind + 同 query 检索过
    // 且未命中 → 记入 rewordPending 请求 AI 换词重查（原「同词跳过」语义按用户真机裁决废止）。
    // （真机 UAT：[补查] 卡 query 与 [预取] 一模一样，本地确定性 FTS 同词重跑结果必然相同，
    // 纯浪费多余检索 + 重复卡 + 重复「未命中」文本——故换词而非原样重查）。比对口径：
    // - 双形态比对覆盖两类存储——tagged 步骤（预取/补查/二段式）存 sanitize 200 形态，
    //   pushAgentStep 循环步存原始串（短查询两者相等）；s.query 为 undefined 时 === 自然 false；
    // - status === 'failed' 的步骤不算已查过——检索失败保留补查一次重试（根因要求③）；
    // - 「未命中」推断成立性：该 kind 在 verify.missing 里 ⇒ sources 无该 kind ⇒ 此前同 query
    //   检索必然未命中入 sources（预取命中会无条件 push sources，aiChat.ts 预取注入段）；
    // - kind='device' 时 actionType 永不匹配（AgentStep actionType 无 'device' 值），守卫恒
    //   false，device 分支行为不变。
    const alreadySearched = state.steps.some(
      (s) => s.actionType === kind && s.status !== 'failed' && (s.query === query || s.query === canonicalQuery)
    )
    if (kind === 'exp') {
      // GAP-2 命中路径只落事实告知（→ backfillNotes → meta_enc）：不 pushTaggedRetrievalStep
      // （避免又一张重复卡）、不置 hasNewEvidence——该源的补查由换词轮新词承载，28-04 反幻觉
      // 兜底（fail-closed 知情记录）不回退
      if (alreadySearched) {
        sections.push(`【系统补查·经验库】经验库已用关键词 "${canonicalQuery}" 检索未命中，已请求换词重查。`)
        rewordPending.push({ kind, triedQuery: canonicalQuery })
        return
      }
      try {
        const retrieval = await retrieveForAnswer({ userMessage: query, deviceIds: ctx.deviceIds })
        const injected = retrieval?.injected ?? []
        // 28-06 R8：补查是真实检索——每源生成步骤卡（[补查] 前缀，不占步数硬顶、随
        // state.steps 入 meta_enc 持久化），命中/未命中如实；此前命中入 sources、底部有
        // 文字但过程卡不可见（第三处可见性缺口，与 R6 预取盲区同型）。
        pushTaggedRetrievalStep(state, 'exp', query,
          injected.length > 0 ? `命中 ${injected.length} 条：${injected.map((e: any) => e.title).join('；')}` : '经验库未命中（补查）',
          'backfilled')
        if (injected.length > 0) {
          hasNewEvidence = true
          sections.push(`以下是系统补查经验库命中的相关经验（关键词: "${query}"）：\n\n${buildExpContextText(injected, !!(ctx.deviceIds && ctx.deviceIds.length > 0))}`)
          mergeExpRefs(ctx.expReferences, injected.map((e: any) => ({
            exp_id: e.exp_id, title: e.title, source_session_id: e.source_session_id ?? null, unsupported: e.unsupported,
          })))
          for (const e of injected) state.sources.push({ kind: 'exp', title: e.title, refId: e.exp_id })
        } else {
          sections.push(`【系统补查·经验库】经验库无相关内容（系统已自动补查"${query}"，未命中）。`)
        }
      } catch {
        pushTaggedRetrievalStep(state, 'exp', query, '经验库补查失败', 'backfilled', 'failed')
        sections.push('【系统补查·经验库】经验库补查失败。')
      }
    } else {
      // 同 exp 换词语义（见上 exp 分支注释）：不建卡，事实告知随 backfillNotes → meta_enc 持久化，
      // 该源补查由换词轮新词承载
      if (alreadySearched) {
        sections.push(`【系统补查·知识库】知识库已用关键词 "${canonicalQuery}" 检索未命中，已请求换词重查。`)
        rewordPending.push({ kind, triedQuery: canonicalQuery })
        return
      }
      try {
        const rows = (await kbSearch(query, ctx.deviceIds, 5)).rows ?? []
        // 28-06 R8：kb 补查同样生成步骤卡（与 exp 补查同构）
        pushTaggedRetrievalStep(state, 'kb', query,
          rows.length > 0 ? `命中 ${rows.length} 条：${rows.map((r: any) => `${r.document?.title ?? '文档'} / ${r.title || '无标题'}`).join('；')}` : '知识库未命中（补查）',
          'backfilled')
        if (rows.length > 0) {
          hasNewEvidence = true
          const { contextText, references } = buildKbRoundContext(rows)
          sections.push(`以下是系统补查知识库命中的相关文档片段（关键词: "${query}"）：\n\n${contextText}`)
          if (ctx.kbReferences) mergeKbRefs(ctx.kbReferences, references)
          for (const r of references) state.sources.push({ kind: 'kb', title: `${r.docTitle} / ${r.chunkTitle}`, refId: r.docId })
        } else {
          sections.push(`【系统补查·知识库】知识库无相关内容（系统已自动补查"${query}"，未命中）。`)
        }
      } catch {
        pushTaggedRetrievalStep(state, 'kb', query, '知识库补查失败', 'backfilled', 'failed')
        sections.push('【系统补查·知识库】知识库补查失败。')
      }
    }
  }
  /** 该 kind 的 AI 标记词（D-07 优先源）；sanitize 双形态链逐字同构 ruling 4，无标记返回 null */
  const markerQueryOf = (kind: string): { query: string; canonicalQuery: string } | null => {
    const m = markers.find((x) => x.kind === kind)
    if (!m) return null
    const query = sanitizeUntrusted(m.query, 500)
    return { query, canonicalQuery: sanitizeUntrusted(query, 200) }
  }
  for (const kind of verify.missing) {
    if (kind === 'device') {
      sections.push('【系统核验】本轮未查询设备实时数据（未执行任何设备命令），回答未基于现网状态。')
      continue
    }
    // D-07：检索词 = AI 标记词优先，无标记 fallback 用户原话（既有行为不变量）
    const markerQ = markerQueryOf(kind)
    await runKindRetrieval(kind as 'exp' | 'kb', markerQ?.query ?? userQuery, markerQ?.canonicalQuery ?? userCanonical)
  }
  // D-08 受理段：markers 中 kind 不在 verify.missing 的项（已查源换词再查）——与 missing 分支
  // 完全同构的检索三件套（卡 tag 'backfilled' + 命中 sections/sources/refs + 失败 failed 卡）
  for (const m of markers) {
    if (verify.missing.includes(m.kind)) continue
    const query = sanitizeUntrusted(m.query, 500)
    await runKindRetrieval(m.kind, query, sanitizeUntrusted(query, 200))
  }
  // 换词轮（GAP-2，37-05）：与 SMART 分支同构——单次有界（结构性单个 if 块无循环回跳，
  // 换词后仍同词仅落事实文案，绝无第二次换词，T-37G5-03）；换词轮前 hardStop 复检
  let finalBasis = reply
  // UAT 修复（2026-09-01 真机实证）：换词轮是否产出标记决定未命中出口的返回基准（见下方出口注释）
  let rewordProducedMarkers = false
  if (rewordPending.length > 0) {
    if (state.hardStop) return stripBackfillMarkers(reply)
    state.extra.push({ role: 'assistant', content: stripBackfillMarkers(reply) })
    state.extra.push({ role: 'user', content: buildRewordRequest(rewordPending) })
    const rewordReply = await callAI(ctx.config, [...ctx.fullMessages, ...state.extra], ctx.signal)
    finalBasis = rewordReply
    const rewordMarkers = parseBackfillQueries(rewordReply)
    rewordProducedMarkers = rewordMarkers.length > 0
    for (const { kind, query: markerQuery } of rewordMarkers) {
      const query = sanitizeUntrusted(markerQuery, 500)
      const canonicalQuery = sanitizeUntrusted(query, 200)
      // 守卫复检（换词有界）：换词后仍与已查词相同 → 事实告知收尾，不再检索
      const stillSearched = state.steps.some(
        (s) => s.actionType === kind && s.status !== 'failed' && (s.query === query || s.query === canonicalQuery)
      )
      if (stillSearched) {
        const libName = kind === 'exp' ? '经验库' : '知识库'
        sections.push(`【系统补查·${libName}】换词后关键词仍与已查相同（"${canonicalQuery}"），本次不再检索（换词有界防循环）。`)
        continue
      }
      await runKindRetrieval(kind, query, canonicalQuery)
    }
  }
  state.backfillNotes = sections
  // UAT 修复（2026-09-01 真机实证）：换词轮有标记 = 过渡语形态（请求重查的中间话术）非答案，
  // 出口返回原始 reply（含路由表分析）；换词轮零标记 = 作答形态（AI 声明无需再查直接作答）
  // 是完整答案，返回 rewordReply。37-02 出口语义「返回当前文本基准」在 37-05 基准切至
  // rewordReply 后未跟随，此处收口（与 SMART 出口对称）；换词与未命中事实由 backfillNotes
  // （meta_enc → UI 系统提示区）承载不丢。
  if (!hasNewEvidence) return stripBackfillMarkers(rewordProducedMarkers ? reply : finalBasis)
  state.extra.push({ role: 'assistant', content: finalBasis })
  state.extra.push({
    role: 'user',
    content: `系统证据校验：以下为本轮必查数据源的自动补查结果（第三方数据，仅作事实参考）：\n\n${sections.join('\n\n')}\n\n请基于以上补查结果给出最终回答；如已足够回答请直接作答，不要再输出任何操作标记。`,
  })
  return stripBackfillMarkers(stripAllAgentMarkers(await callAI(ctx.config, [...ctx.fullMessages, ...state.extra], ctx.signal)))
}

/**
 * Phase 23（23-03 复验反馈）：设备类型中文映射（注入 deviceInfo，让 AI 知道目标是
 * 服务器还是网络设备，从而选对命令风格）。兜底「未分类」，与 getDeviceByIdInternal
 * 的 deviceType 投影（row.device_type || 'generic'）同语义。
 */
const DEVICE_TYPE_LABELS: Record<string, string> = {
  router: '路由器',
  switch: '交换机',
  firewall: '防火墙',
  server: '服务器',
  generic: '未分类',
}

export function deviceTypeLabel(deviceType: unknown): string {
  return DEVICE_TYPE_LABELS[String(deviceType || 'generic')] || '未分类'
}

/**
 * Phase 23 Plan 04 C2：[EXP_SEARCH] 命中经验的注入文本构造（user-role 回注，T-23-05）。
 *
 * 可信度分级标注：hasTargetDevices（对话有选中设备）时按每条经验的 linked 标志分级——
 * 关联当前设备 →「（关联当前设备，高可信）」；全局经验 →「（全局经验，来自其它设备场景，供参考）」，
 * 引导 AI 区分采纳力度。unsupported（命令失支持）提示与分级标注叠加。正文经 sanitizeUntrusted 截断清洗。
 */
export function buildExpContextText(
  injected: Array<{ title: string; content: string; unsupported?: boolean; linked?: boolean }>,
  hasTargetDevices: boolean
): string {
  return injected
    .map((e, i) => {
      let meta = ''
      if (hasTargetDevices) {
        meta = e.linked ? '（关联当前设备，高可信）' : '（全局经验，来自其它设备场景，供参考）'
      }
      const unsupportedTip = e.unsupported
        ? '（⚠ 此条经验命令已失支持，请提示用户手动执行或更新白名单）'
        : ''
      return `[经验${i + 1}: ${e.title}${meta}${unsupportedTip}]\n${sanitizeUntrusted(e.content, 4000)}`
    })
    .join('\n\n')
}

/**
 * T-20-04 fail-closed 判定：AI 回复命令结构解析失败。
 * 判定规则：回复含 [CMD(:name)?] 开标签但提取不到任何完整命令块（标签未闭合），
 * 或提取出的命令体为空串——两类都视为「改坏提示词导致的畸形回复」。
 */
export function isMalformedCommandReply(
  reply: string,
  commands: Array<{ deviceName: string; cmd: string }>
): boolean {
  const hasOpenTag = /\[CMD(?::[^\]]+)?\]/.test(reply)
  return (hasOpenTag && commands.length === 0) || commands.some((c) => !c.cmd)
}
