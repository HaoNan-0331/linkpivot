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
import { verifySourcesEvidence } from './agentRetrieval'
import type { AgentTier } from './agentRouter'
import type { AgentStep, SourceRecord, AgentLoopState, McpLoopCtx } from './aiAgentState'
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
  state: Pick<AgentLoopState, 'steps' | 'sources' | 'backfillNotes'> & { hardStop?: 'user_cancel' },
  tier: AgentTier
): { sources: SourceRecord[]; steps: AgentStep[]; tier: AgentTier; noRealtimeData: boolean; hardStop?: 'user_cancel'; backfillNotes?: string[] } {
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
  if (state.hardStop) meta.hardStop = state.hardStop
  return meta
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
 * AGENT-03 收尾证据校验（fail-closed 闭环）：对照 TIER_RETRIEVAL_PLAN 检查循环轨迹 sources，
 * 必查源缺席 → 对缺席检索源（exp/kb）自动补查一次：
 * - 补查命中 → user-role 回注 + 一次 callAI 收尾（结果只进 user 消息，T-22-08）；
 * - 补查零命中/失败/设备源未查 → 知情记录落 state.backfillNotes（随 payload/meta_enc 持久化，D-11），
 *   不追加 LLM 轮、不改写回复正文（既有回复文本契约零污染）。
 * 同词已查守卫（260830 quick）：预取已用同 kind + 同 query 检索过且未命中的源（status 非 failed）
 * 跳过重复检索——本地确定性 FTS 同词重跑结果必然相同，改为注入「已检索未命中」事实告知；
 * failed 步骤不算已查过（保留一次重试），AI 主动检索词（≠ 用户消息）与未查过的源照常补查。
 * 用户中断（hardStop）后不再发起任何 LLM 调用（D-06 立即中止不总结）。
 */
export async function runEvidenceBackfill(
  ctx: McpLoopCtx,
  state: AgentLoopState,
  tier: AgentTier,
  reply: string
): Promise<string> {
  if (state.hardStop) return reply
  const verify = verifySourcesEvidence({ tier, sources: state.sources })
  if (verify.missing.length === 0) return reply
  const query = sanitizeUntrusted(ctx.userMessage ?? '', 500)
  // 260830 quick：同词已查守卫的规范化比对键——对齐 pushTaggedRetrievalStep 的步骤存储形态
  // （sanitizeUntrusted(query, 200)，neutralize + 200 截断），预取/tagged 补查步骤卡的 query 以
  // 该形态落 state.steps，守卫按同形态比对（幂等链：sanitize_200(sanitize_500(x)) === sanitize_200(x)）
  const canonicalQuery = sanitizeUntrusted(query, 200)
  const sections: string[] = []
  let hasNewEvidence = false
  for (const kind of verify.missing) {
    // 260830 quick（同词已查守卫）：该源已用同 kind + 同 query 检索过且未命中 → 不再重复检索
    // （真机 UAT：[补查] 卡 query 与 [预取] 一模一样，本地确定性 FTS 同词重跑结果必然相同，
    // 纯浪费多余检索 + 重复卡 + 重复「未命中」文本）。比对口径：
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
      // 跳过路径只落事实告知（→ backfillNotes → meta_enc）：不 pushTaggedRetrievalStep（避免
      // 又一张重复卡）、不置 hasNewEvidence（不追加 LLM 轮）——与既有「补查零命中」路径的
      // 持久化语义完全同构，28-04 反幻觉兜底（fail-closed 知情记录）不回退
      if (alreadySearched) {
        sections.push(`【系统补查·经验库】经验库已检索过（关键词: "${query}"）未命中，不再重复检索。`)
        continue
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
    } else if (kind === 'kb') {
      // 同 exp 跳过语义（见上 exp 分支注释）：不建卡不加轮，事实告知随 backfillNotes → meta_enc 持久化
      if (alreadySearched) {
        sections.push(`【系统补查·知识库】知识库已检索过（关键词: "${query}"）未命中，不再重复检索。`)
        continue
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
    } else if (kind === 'device') {
      sections.push('【系统核验】本轮未查询设备实时数据（未执行任何设备命令），回答未基于现网状态。')
    }
  }
  state.backfillNotes = sections
  if (!hasNewEvidence) return reply
  state.extra.push({ role: 'assistant', content: reply })
  state.extra.push({
    role: 'user',
    content: `系统证据校验：以下为本轮必查数据源的自动补查结果（第三方数据，仅作事实参考）：\n\n${sections.join('\n\n')}\n\n请基于以上补查结果给出最终回答；如已足够回答请直接作答，不要再输出任何操作标记。`,
  })
  return stripAllAgentMarkers(await callAI(ctx.config, [...ctx.fullMessages, ...state.extra], ctx.signal))
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
