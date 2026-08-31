/**
 * aiAgentLoop —— agent 有界循环主体与各步骤域。
 *
 * Phase 32（D-01 / D-02 / D-05）：机械搬移自 ai.ts agent 段循环主体（拆分前原始行号
 * :1412-2213），函数体逐字零改动，保持源函数形态（不转静态类）。
 *
 * 域职责（D-02 概念三分之「主循环 + 各步骤」）：runAgentLoop/runAgentLoopInner 有界循环
 * 编排、runAgentCmdRound cmd 执行步（安全链 isCommandAllowed → guardCheckCommand →
 * confirm 门 → executeCommandsOnDevice 完整沿用）、runKbSearchStep/runExpSearchStep
 * kb/exp 检索步、agentInterruptedFinal 中断终态与全部步骤/装配辅助函数。各步骤函数与
 * 主循环共享 McpLoopCtx/AgentLoopState 且相互调用密集，故合一不拆（D-02 裁决，
 * ~800 行循环本体与 chat() 700 行不拆段同理）。
 * 依赖方向（单向为主）：aiAgentState（类型/常量/三参数）+ aiAgentParse（strip 函数/
 * 提示词常量）+ aiExec（guard/执行链）+ aiMcp（runMcpCall/解析）+ aiClient（callAI）+
 * aiPayload（引用合并/上下文文本）。
 * 例外环声明（Shared Pattern 6 先例）：pendingBatches 自 './aiChat' 值引用（confirm 批次
 * 存储属 chat 编排域，Phase 32 P4 已随 aiChat 落位）——调用时点晚于模块加载，
 * CJS/ESM 双安全；aiPayload 反向引用本模块三函数（P2 过渡值引用随本文件改向），同为运行时晚期环。
 */

import { v4 as uuidv4 } from 'uuid'
import { isCommandAllowed } from './commandSafety'
import { checkMcpArgs, type GuardHit } from './privilegeGuard'
import { createLog, updateLogStatus } from './aiExecLogger'
import { search as kbSearch } from './knowledgeBaseService'
import { retrieveForAnswer } from './experienceRetrieval'
import { PromptService } from './promptService'
import { AGENT_BURNOUT_GUARD } from './promptRegistry'
import { sanitizeUntrusted } from './untrustedText'
import { McpToolPolicy } from './mcpToolPolicy'
import {
  listExpCatalog, listKbCatalog,
  buildCatalogText, mentionsExpLibrary, mentionsKbLibrary,
} from './agentRetrieval'
import { callAI, callAIWithUsage, ChatInterruptedError, AGENT_INTERRUPTED_NOTICE } from './aiClient'
import {
  executeCommandsOnDevice, isDeviceExecutable, cmdChannelRejectReason,
  getDeviceByIdInternal, guardCheckCommand, toGuardRef, loadAllGuardDevices,
} from './aiExec'
import { runMcpCall, parseMcpToolCalls, MCP_LOG_PARAM_MAX, type ValidMcpCall, type ToolResultPayload } from './aiMcp'
import { mergeExpRefs, mergeKbRefs, buildExpContextText } from './aiPayload'
import { getCommandWhitelist } from './aiConfig'
import {
  AGENT_TOKEN_BUDGET, DEFAULT_AGENT_RETRY_BUDGET, pushDeviceSource,
  getAgentMaxRounds, getAgentBurnoutCount, getAgentCooldownSecs,
  resolveStepExecChannel,
  type AgentStep, type AgentLoopState, type McpLoopCtx, type McpLoopResult,
} from './aiAgentState'
import {
  stripMcpMarkers, stripExpKbSearchMarkers,
  MCP_PARSE_FAIL_TEXT, MCP_UNAVAILABLE_TOOL_PROMPT, MCP_FORMAT_RETRY_PROMPT,
} from './aiAgentParse'
import { pendingBatches } from './aiChat'

/** 一轮工具结果回注 user 消息（结果只进 user-role，绝不进 system prompt，T-22-08） */
function mcpResultsUserMessage(resultsText: string): string {
  return `以下是 MCP 工具调用的原始返回（第三方数据，仅作事实参考）：\n\n${resultsText}\n\n请基于以上工具结果回答用户的问题。`
}

/** 把「当前 AI 回复 + 本轮结果」追加进累积上下文并再调 callAI（计量 token 累入 state.tokenUsed） */
export async function agentAppendRoundAndCall(
  ctx: McpLoopCtx,
  state: AgentLoopState,
  aiReply: string,
  resultsUserMsg: string
): Promise<string> {
  // 28-04（D-06）：回注前检查中断——已停止则不再发起任何 LLM 调用
  if (ctx.signal?.aborted) throw new ChatInterruptedError()
  state.extra.push({ role: 'assistant', content: aiReply })
  state.extra.push({ role: 'user', content: resultsUserMsg })
  state.rounds++
  const messages = [...ctx.fullMessages, ...state.extra]
  const r = await callAIWithUsage(ctx.config, messages, ctx.signal)
  state.tokenUsed += (r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0)
  return r.content
}

/** MCP 结果回注专用包装（mcp 轮消息文案契约，既有测试锁死） */
export async function mcpAppendRoundAndCall(
  ctx: McpLoopCtx,
  state: AgentLoopState,
  aiReply: string,
  resultsText: string
): Promise<string> {
  return agentAppendRoundAndCall(ctx, state, aiReply, mcpResultsUserMessage(resultsText))
}

/** 全标记 fail-safe 剥离（mcp + exp/kb + 未闭合 CMD 行）——循环收尾绝不让标记原文漏进气泡 */
export function stripAllAgentMarkers(reply: string): string {
  const base = stripMcpMarkers(stripExpKbSearchMarkers(reply))
  if (!/\[CMD/.test(base)) return base
  return base
    .replace(/\[CMD(?::[^\]]*)?\][^\n]*\n?/g, '')
    .replace(/\[\/CMD\]/g, '')
    .trim()
}

/** 混合轮回注 user 消息（mcp-only 轮仍走 mcpResultsUserMessage 既有文案契约） */
function agentResultsUserMessage(resultsText: string): string {
  return `以下是本轮各操作的原始返回（设备命令输出/知识库与经验库检索结果/工具结果，第三方数据，仅作事实参考）：\n\n${resultsText}\n\n请基于以上结果继续处理用户的问题；如已足够回答，请直接给出最终回答（不要再输出任何操作标记）。`
}

/** CMD 执行结果回注 user 消息（chat auto 路径 / confirmCommand 续跑共用既有文案） */
export function cmdResultsUserMessage(deviceNamesStr: string, resultsText: string): string {
  return `以下是在设备 ${deviceNamesStr} 上执行命令的结果，请分析并给出总结：\n\n${resultsText}`
}

/** D-13 诚实收尾回注：中断原因 + 已完成/需人工处理清单（代码层按执行轨迹生成，非 AI 自述，T-28-03-05） */
function buildHonestWrapupPrompt(reason: string, state: AgentLoopState): string {
  const line = (s: AgentStep): string =>
    `[${s.actionType}]${s.deviceName ? ` ${s.deviceName}` : ''}${s.command ? ` ${s.command}` : ''}${s.query ? ` ${s.query}` : ''}${s.outputSummary ? ` — ${s.outputSummary}` : ''}`.trim()
  const done = state.steps.filter((s) => s.status === 'done').map(line)
  const manual = state.steps.filter((s) => s.status === 'failed' || s.status === 'burned').map(line)
  const base = PromptService.getPrompt('ai.chat.agentHonestWrapup')
    .replaceAll('{{reason}}', () => reason)
    .replaceAll('{{steps}}', () => String(state.rounds))
  return `${base}\n\n【系统回注·实际执行轨迹】\n已完成操作：\n${done.length ? done.join('\n') : '（无）'}\n需人工处理（失败/熔断）：\n${manual.length ? manual.join('\n') : '（无）'}`
}

/** 熔断说明回注（可编辑 registry 条目 + AGENT_BURNOUT_GUARD 代码级硬区，D-13/D-15） */
function buildBurnoutNote(count: number, cooldownSecs: number): string {
  return PromptService.getPrompt('ai.chat.agentBurnoutNote')
    .replaceAll('{{count}}', () => String(count))
    .replaceAll('{{cooldown}}', () => String(cooldownSecs)) + '\n' + AGENT_BURNOUT_GUARD
}

/** 步骤轨迹入栈（只存 deviceName/command/输出摘要，绝不缓存明文凭证——Pitfall 5） */
export function pushAgentStep(
  state: AgentLoopState,
  actionType: AgentStep['actionType'],
  opts: { deviceName?: string; command?: string; query?: string; outputSummary?: string; execChannel?: 'ssh' | 'telnet' }
): AgentStep {
  const step: AgentStep = { stepIndex: state.steps.length, actionType, status: 'running', ...opts }
  state.steps.push(step)
  // 28-05（D-08）：入栈即推 running 卡片（后续 settle 再推终态）。mcp 步骤不推——
  // runMcpCall 已按真实工具结果下发 tool_result 卡片，重复推送即一步两卡（UI 契约禁止）。
  if (actionType !== 'mcp') state.emitStep?.(step)
  return step
}

/** 步骤状态落定 + 推送（28-05，D-08 步骤级推送：每次状态迁移即推一次，renderer 按 stepIndex 更新） */
export function settleAgentStep(step: AgentStep, status: AgentStep['status'], state: AgentLoopState): AgentStep {
  step.status = status
  if (step.actionType !== 'mcp') state.emitStep?.(step)
  return step
}

/**
 * AgentStep → tool_result 扩展载荷（28-05 renderer 步骤卡数据源）。
 * 基础字段满足既有 renderer fail-closed 校验（type/server/tool/deviceName/argsJson/
 * resultJson/status 枚举）；stepIndex/actionType/stepStatus 为步骤卡状态机扩展字段。
 */
export function agentStepToToolResultPayload(s: AgentStep): ToolResultPayload {
  const toolLabel =
    s.actionType === 'cmd' ? '命令执行'
    : s.actionType === 'kb' ? '知识库检索'
    : s.actionType === 'exp' ? '经验库检索'
    : 'MCP 工具'
  return {
    type: 'tool_result',
    server: 'agent',
    tool: toolLabel,
    deviceName: s.deviceName ?? '',
    // 28-06 R2 缺陷①：cmd/mcp 步骤取 command，kb/exp 步骤取检索词 query——
    // 此前恒取 command（kb/exp 无此字段）导致步骤卡「（无参数）」
    argsJson: s.actionType === 'kb' || s.actionType === 'exp' ? (s.query ?? '') : (s.command ?? ''),
    resultJson: s.outputSummary ?? '',
    status: s.status === 'failed' || s.status === 'burned' ? 'failed' : 'success',
    stepIndex: s.stepIndex,
    actionType: s.actionType,
    stepStatus: s.status,
    ...(s.prefetched ? { prefetched: true } : {}),
    ...(s.backfilled ? { backfilled: true } : {}),
    // Phase 36（36-05，D-11）：cmd 步骤通道标注透传（renderer fail-open 消费，
    // 与 prefetched/backfilled 同型；缺场不写字段 = legacy 载荷形态）
    ...(s.execChannel ? { execChannel: s.execChannel } : {}),
  }
}

/**
 * 28-06 R6 增强 a / R8：带标注检索步骤卡入栈——预取（prefetched）/补查（backfilled）
 * /无标注（AI 主动，循环外二段式）三类共用。状态直接 done（检索在步骤卡入栈前已完成，
 * 无 running 过程态；检索失败可传 failed）；只 emit 一次终态卡。标注标志只影响 renderer
 * 前缀，硬顶按 state.rounds 计数——带标注步永不消耗 agent_max_rounds 步数 N。
 */
export function pushTaggedRetrievalStep(
  state: AgentLoopState,
  actionType: 'kb' | 'exp',
  query: string,
  outputSummary: string,
  tag?: 'prefetched' | 'backfilled',
  status: AgentStep['status'] = 'done'
): AgentStep {
  const step: AgentStep = {
    stepIndex: state.steps.length,
    actionType,
    status,
    query: sanitizeUntrusted(query, 200),
    outputSummary: sanitizeUntrusted(outputSummary, 200),
    ...(tag === 'prefetched' ? { prefetched: true } : {}),
    ...(tag === 'backfilled' ? { backfilled: true } : {}),
  }
  state.steps.push(step)
  state.emitStep?.(step)
  return step
}

/**
 * 28-06 R6 增强 b：来源归因指令（可编辑 registry 条目 ai.chat.sourceAttribution）——
 * 预取注入段与 KB/EXP 回注文本头部统一附带；条目被用户清空时返回空串（普通行为
 * 指令，fail-open 不阻断内容注入——与 ⚠ 安全关键条目的 fail-closed 语义区分）。
 */
export function sourceAttributionNote(): string {
  const note = PromptService.getPrompt('ai.chat.sourceAttribution').trim()
  return note ? `${note}\n` : ''
}

function parseKbQueries(reply: string): string[] {
  return [...reply.matchAll(/\[KB_SEARCH\]([\s\S]*?)\[\/KB_SEARCH\]/g)]
    .map((m) => m[1].trim()).filter(Boolean)
}

function parseExpQueries(reply: string): string[] {
  return [...reply.matchAll(/\[EXP_SEARCH\]([\s\S]*?)\[\/EXP_SEARCH\]/g)]
    .map((m) => m[1].trim()).filter(Boolean)
}

export function parseCmdBlocks(reply: string): Array<{ deviceName: string; cmd: string }> {
  return [...reply.matchAll(/\[CMD(?::([^\]]+))?\]([\s\S]*?)\[\/CMD\]/g)]
    .map((m) => ({ deviceName: (m[1] || '').trim(), cmd: m[2].trim() }))
    .filter((c) => c.cmd)
}

/**
 * 28-06 真机验收缺陷 ①：首答是否应进统一 agent 循环——判定复用循环内既有解析函数
 * （parseCmdBlocks + [MCP_TOOL_CALL] 开标记正则，与 runAgentLoop L1654 hasOpenMarker
 * 同源口径），不新写解析逻辑（CONTEXT D-01/D-03：与 MCP 绑定无关）。
 * [CMD] 仅当至少一个块解析到**在场且可执行**（isDeviceExecutable）的设备时才触发循环
 * ——仅问答设备/点名不存在设备的标记留给 chat() 既有 23-03 白名单防御路径（回注重试
 * + strip 收尾语义不回归）。[KB_SEARCH]/[EXP_SEARCH] 已被 chat() 循环外单次二段式
 * 消费（标记剥离后不再到场），入口无需重复判定。[MCP_TOOL_CALL] 只认开标记存在
 * （有效性由循环内 parseMcpToolCalls fail-closed 分诊，无 mcp 上下文时畸形标记走
 * strip 收尾，不执行任何工具）。
 */
/**
 * 28-06 R3 缺陷（设备名模糊匹配）：[CMD:设备名] 目标解析——精确（trim/忽略大小写）优先，
 * 未中则包含式模糊匹配（AI 常写设备简称如「核心交换机」→ 全名「公司服务器核心交换机」；
 * 双向包含），多候选取名称最短者（最具体）。仅在本轮已选 targetDevices 范围内解析——
 * 安全链（guardCheckCommand 的 conversationSet 以 targetDevices 为基准）不受影响。
 */
export function resolveTargetDevice(deviceName: string, targetDevices: any[]): any {
  if (!deviceName || !deviceName.trim()) return targetDevices[0]
  const trimmed = deviceName.trim().toLowerCase()
  const exact = targetDevices.find((d) => String(d.name).trim().toLowerCase() === trimmed)
  if (exact) return exact
  const fuzzy = targetDevices
    .filter((d) => {
      const n = String(d.name).trim().toLowerCase()
      return n.includes(trimmed) || trimmed.includes(n)
    })
    .sort((a, b) => String(a.name).length - String(b.name).length)
  return fuzzy[0]
}

export function replyEntersAgentLoop(
  reply: string,
  targetDevices: any[]
): boolean {
  const cmdHit = parseCmdBlocks(reply).some((b) => {
    const dev = resolveTargetDevice(b.deviceName, targetDevices)
    return !!dev && isDeviceExecutable(dev)
  })
  return cmdHit || /\[MCP_TOOL_CALL\]/.test(reply)
}

/**
 * 28-06 R3（兜底防线）：首答 [CMD] 标记未被任何执行路径消费时，生成显式「未执行」回注
 * ——杜绝 AI 把「发起意图」脑补成「已执行事实」（用户实测缺陷）。已执行/已尝试的命令
 * （agentState.steps 有 cmd 轨迹）与 qOnly 拒绝（含拒绝原因）分别排除/如实列出。
 */
export function buildDroppedCmdNotice(
  firstCmdBlocks: Array<{ deviceName: string; cmd: string }>,
  qOnlyRejections: Array<{ deviceName: string; cmd: string; reason: string }>,
  targetDevices: any[],
  agentState: AgentLoopState
): string {
  if (firstCmdBlocks.length === 0) return ''
  const attempted = new Set(
    agentState.steps.filter((s) => s.actionType === 'cmd').map((s) => String(s.command))
  )
  const lines: string[] = []
  const listedCmds = new Set<string>()
  const pushLine = (deviceName: string, cmd: string, reason: string) => {
    if (listedCmds.has(cmd)) return
    listedCmds.add(cmd)
    lines.push(`命令 [${deviceName || '未指定设备'}] ${cmd} 未执行：${reason}`)
  }
  for (const b of firstCmdBlocks) {
    if (attempted.has(b.cmd)) continue
    if (targetDevices.length === 0) {
      pushLine(b.deviceName, b.cmd, '本轮未选择目标设备')
      continue
    }
    const qOnly = qOnlyRejections.find((r) => r.cmd === b.cmd)
    if (qOnly) {
      pushLine(qOnly.deviceName, qOnly.cmd, qOnly.reason)
      continue
    }
    const dev = resolveTargetDevice(b.deviceName, targetDevices)
    if (!dev) pushLine(b.deviceName, b.cmd, '未找到指定设备')
    else if (!isDeviceExecutable(dev)) pushLine(String(dev.name), b.cmd, cmdChannelRejectReason(dev))
  }
  // qOnly 拒绝中不在首答块的命令（重试轮再犯被 strip 的标记）同样显式回注
  for (const r of qOnlyRejections) {
    if (attempted.has(r.cmd)) continue
    pushLine(r.deviceName, r.cmd, r.reason)
  }
  return lines.length
    ? `\n\n【系统提示】以下命令标记未被系统执行（请勿在回答中声称已发起或已执行该命令）：\n${lines.join('\n')}`
    : ''
}

/** KB 检索结果 → 回注上下文文本 + 来源清单（[图片N] 描述替换逻辑自 chat() 原位抽取，行为不变） */
export function buildKbRoundContext(rows: any[]): {
  contextText: string
  references: Array<{ docTitle: string; chunkTitle: string; docId: string }>
} {
  const contextText = rows.map((r: any, i: number) => {
    let content = r.content || ''
    if (r.images?.length > 0) {
      const imgMarkers = [...content.matchAll(/\[图片(\d+)\]/g)]
      for (const m of imgMarkers) {
        const num = parseInt(m[1], 10)
        const img = r.images[num - 1]
        if (img?.description) {
          content = content.replace(m[0], `[图片${num}: ${img.description}]`)
        }
      }
    }
    return `[文档${i + 1}: ${r.document?.title || '未知'} / 章节: ${r.title || '无标题'}]\n${content}`
  }).join('\n\n')
  const references = rows.map((r: any) => ({
    docTitle: r.document?.title || '未知',
    chunkTitle: r.title || '无标题',
    docId: r.document_id,
  }))
  return { contextText, references }
}

/**
 * KB 检索步（WR-05 解除：循环内 [KB_SEARCH] 直执——只读本地库，无确认，Pitfall 7 计入轮次）。
 * 检索命中时结果片段入 sources / kbReferences（代码层溯源，D-09）。
 */
async function runKbSearchStep(query: string, ctx: McpLoopCtx, state: AgentLoopState, step?: AgentStep): Promise<string> {
  // 28-04（RESEARCH Q4）：kb 检索步入 ai_exec_logs 审计（command 列 'kb:query'，只读检索无确认门）
  try {
    createLog({
      deviceId: '', deviceName: '', command: `kb:query ${sanitizeUntrusted(query, 200)}`,
      status: 'executed', mode: ctx.execMode,
      aiReason: sanitizeUntrusted(query, 500), promptText: '', aiResponse: '',
    })
  } catch { /* 审计失败不阻断检索（aiExecLogger 异常降级） */ }
  const searchResults = (await kbSearch(query, ctx.deviceIds, 5)).rows
  if (!searchResults || searchResults.length === 0) {
    // 28-06 R2 缺陷①：settle 前回填 outputSummary（步骤卡 resultJson 数据源）
    if (step) step.outputSummary = '知识库未命中'
    // 28-06 R4 兜底：零命中但用户消息提及知识库 → 附目录清单（防 AI 脑补「库是空的」）
    let missText = `[知识库检索: ${query}]\n知识库中未找到与"${query}"相关的文档。`
    if (ctx.userMessage && mentionsKbLibrary(ctx.userMessage)) {
      try {
        const listing = listKbCatalog()
        missText += `\n[知识库目录·系统附带] ${sanitizeUntrusted(buildCatalogText('kb', listing), 2000)}`
        state.sources.push({ kind: 'kb', title: '知识库目录清单', refId: undefined })
        if (step) step.outputSummary = sanitizeUntrusted(`知识库未命中（${listing.total} 条文档在库）`, 200)
      } catch { /* 清单失败保持未命中原样 */ }
    }
    return missText
  }
  const { contextText, references } = buildKbRoundContext(searchResults)
  // 28-06 R2 缺陷①：命中数 + 标题清单回填 outputSummary（步骤卡展开可见检索结果概要）
  if (step) {
    step.outputSummary = sanitizeUntrusted(`命中 ${references.length} 条：${references.map((r) => `${r.docTitle} / ${r.chunkTitle}`).join('；')}`, 200)
  }
  if (ctx.kbReferences) mergeKbRefs(ctx.kbReferences, references)
  state.sources.push(...references.map((r) => ({ kind: 'kb' as const, title: `${r.docTitle} / ${r.chunkTitle}`, refId: r.docId })))
  // 28-06 R6 增强 b：回注头部带来源归因指令（复用 ai.chat.sourceAttribution 条目）
  return `${sourceAttributionNote()}以下是知识库检索到的相关文档片段（关键词: "${query}"）：\n\n${contextText}`
}

/** EXP 检索步（WR-05 解除：循环内 [EXP_SEARCH] 直执——只读本地库，无确认） */
async function runExpSearchStep(query: string, ctx: McpLoopCtx, state: AgentLoopState, step?: AgentStep): Promise<string> {
  const expQuery = sanitizeUntrusted(query, 500)
  // 28-04（RESEARCH Q4）：exp 检索步入 ai_exec_logs 审计（command 列 'exp:query'，只读检索无确认门）
  try {
    createLog({
      deviceId: '', deviceName: '', command: `exp:query ${expQuery}`,
      status: 'executed', mode: ctx.execMode,
      aiReason: expQuery, promptText: '', aiResponse: '',
    })
  } catch { /* 审计失败不阻断检索（aiExecLogger 异常降级） */ }
  const retrieval = await retrieveForAnswer({ userMessage: expQuery, deviceIds: ctx.deviceIds })
  if (!retrieval.injected || retrieval.injected.length === 0) {
    // 28-06 R2 缺陷①：settle 前回填 outputSummary（步骤卡 resultJson 数据源）
    if (step) step.outputSummary = '经验库未命中'
    // 28-06 R4 兜底：零命中但用户消息提及经验库 → 附目录清单（防 AI 脑补「库是空的」）
    let missText = `[经验库检索: ${expQuery}]\n经验库中未找到与"${expQuery}"相关的经验。`
    if (ctx.userMessage && mentionsExpLibrary(ctx.userMessage)) {
      try {
        const listing = listExpCatalog()
        missText += `\n[经验库目录·系统附带] ${sanitizeUntrusted(buildCatalogText('exp', listing), 2000)}`
        state.sources.push({ kind: 'exp', title: '经验库目录清单', refId: undefined })
        if (step) step.outputSummary = sanitizeUntrusted(`经验库未命中（${listing.total} 条已发布经验在库）`, 200)
      } catch { /* 清单失败保持未命中原样 */ }
    }
    return missText
  }
  const expContext = buildExpContextText(retrieval.injected, !!(ctx.deviceIds && ctx.deviceIds.length > 0))
  const newRefs = retrieval.injected.map((e) => ({
    exp_id: e.exp_id,
    title: e.title,
    source_session_id: e.source_session_id ?? null,
    unsupported: e.unsupported,
  }))
  // 28-04：exp 引用合并去重（与分档预取/补查同源命中只计一次）
  mergeExpRefs(ctx.expReferences, newRefs)
  // 28-06 R2 缺陷①：命中数 + 标题清单回填 outputSummary（步骤卡展开可见检索结果概要）
  if (step) {
    step.outputSummary = sanitizeUntrusted(`命中 ${newRefs.length} 条：${newRefs.map((e) => e.title).join('；')}`, 200)
  }
  state.sources.push(...newRefs.map((e) => ({ kind: 'exp' as const, title: e.title, refId: e.exp_id })))
  // 28-06 R6 增强 b：回注头部带来源归因指令（复用 ai.chat.sourceAttribution 条目）
  return `${sourceAttributionNote()}以下是经验库中检索到的相关经验（关键词: "${expQuery}"）：\n\n${expContext}`
}

/**
 * Phase 28（28-03）：循环内 CMD 动作轮——安全链完全沿用 chat() 既有语义
 * （isCommandAllowed → guardCheckCommand → createLog → confirm 门 → executeCommandsOnDevice
 * 执行层二次兜底；执行函数零改动，T-28-03-01）。循环层新增：③ 冷却跳过 / ② 熔断 /
 * D-14 限次静默重试。安全拒绝（白名单/越权拦截）是策略结果非执行失败——不计失败冷却
 * （Pitfall 10 分类表）。confirm 门命中 → 批次携带 loopCtx/agentState 续跑（Pitfall 2）。
 */
async function runAgentCmdRound(
  ctx: McpLoopCtx,
  state: AgentLoopState,
  reply: string,
  blocks: Array<{ deviceName: string; cmd: string }>,
  limits: { burnoutCount: number; cooldownSecs: number },
  preResults?: string
): Promise<{ results: string[]; confirmPayload?: string; count?: number }> {
  const results: string[] = []
  const targetDevices = ctx.targetDevices ?? []
  const whitelist = getCommandWhitelist()
  const execMode = ctx.execMode
  const guardConversationSet = targetDevices.map((d) => toGuardRef(d))
  const allowedCommands: Array<{
    logId: string; deviceId: string; deviceName: string; command: string; guardHits?: GuardHit[]
  }> = []
  const rejectedCommands: Array<{ deviceName: string; cmd: string; reason: string }> = []

  for (const { deviceName, cmd } of blocks) {
    // 28-06 R3：目标解析改用 resolveTargetDevice（精确优先 + 简写模糊命中，chat() 主链同源）
    const targetDevice = resolveTargetDevice(deviceName, targetDevices)
    if (deviceName && !targetDevice) {
      rejectedCommands.push({ deviceName, cmd, reason: `未找到指定设备: ${deviceName}` })
      continue
    }
    if (!targetDevice) continue
    if (!isDeviceExecutable(targetDevice)) {
      // 29.1-06：MCP-only 设备拒绝文案指向 MCP 工具，真·无通道保持 Phase 23 原文案
      rejectedCommands.push({ deviceName: String(targetDevice.name), cmd, reason: cmdChannelRejectReason(targetDevice, '，命令未执行') })
      continue
    }
    const key = `${targetDevice.id}:${cmd}`
    // ② 熔断硬顶（先于冷却检查——终态更强）：同 key 连续未成功达阈值 → 步骤 burned +
    // 硬区禁止令，不执行（D-13/D-15）。冷却跳过同样计入连续未成功（操作仍未交付）。
    const failCount = state.failureCounts.get(key) ?? 0
    if (failCount >= limits.burnoutCount) {
      settleAgentStep(pushAgentStep(state, 'cmd', { deviceName: String(targetDevice.name), command: cmd, outputSummary: '连续失败熔断', execChannel: resolveStepExecChannel(targetDevice) }), 'burned', state)
      results.push(`设备: ${targetDevice.name}\n命令: ${cmd}\n状态: burned\n输出:\n该操作已连续失败 ${failCount} 次被系统熔断，本轮不再执行。\n${buildBurnoutNote(failCount, limits.cooldownSecs)}`)
      continue
    }
    // ③ 冷却硬顶：同 deviceId:command 失败后冷却期内跳过（D-15：仅本 agentState 内生效）
    if ((state.cooldowns.get(key) ?? 0) > Date.now()) {
      state.failureCounts.set(key, failCount + 1)
      settleAgentStep(pushAgentStep(state, 'cmd', { deviceName: String(targetDevice.name), command: cmd, outputSummary: '冷却中跳过', execChannel: resolveStepExecChannel(targetDevice) }), 'cooldown', state)
      results.push(`设备: ${targetDevice.name}\n命令: ${cmd}\n状态: cooldown\n输出:\n该命令前次失败，冷却中（${limits.cooldownSecs}s 内不重复执行），本轮已跳过。`)
      continue
    }
    // ---- 既有安全链（语义与 chat() 主链一致，单源函数零改动复用）----
    const safety = isCommandAllowed(cmd, whitelist)
    const guardHits = safety.allowed ? guardCheckCommand(cmd, targetDevice, guardConversationSet) : []
    const logId = createLog({
      deviceId: targetDevice.id,
      deviceName: targetDevice.name,
      command: cmd,
      status: safety.allowed ? (guardHits.length > 0 || execMode !== 'auto' ? 'pending' : 'approved') : 'rejected',
      mode: execMode,
      aiReason: reply.substring(0, 500),
      promptText: JSON.stringify([...ctx.fullMessages, ...state.extra], null, 2),
      aiResponse: reply,
      guardHits: guardHits.length > 0 ? guardHits : undefined,
    })
    if (!safety.allowed) {
      // Pitfall 10：安全拒绝不计失败冷却
      rejectedCommands.push({ deviceName: targetDevice.name, cmd, reason: safety.reason })
      continue
    }
    allowedCommands.push({
      logId,
      deviceId: targetDevice.id,
      deviceName: targetDevice.name,
      command: cmd,
      guardHits: guardHits.length > 0 ? guardHits : undefined,
    })
  }

  // confirm 门（exec_mode=confirm 或任一 guard 命中，D-06）→ 挂批次携带 agentState 续跑（Pitfall 2）
  const allGuardHits: GuardHit[] = []
  const hitCommandIndexes: number[] = []
  allowedCommands.forEach((c, idx) => {
    for (const h of c.guardHits ?? []) {
      allGuardHits.push(h)
      hitCommandIndexes.push(idx)
    }
  })
  if (allowedCommands.length > 0 && (execMode === 'confirm' || allGuardHits.length > 0)) {
    const batchId = uuidv4()
    const guardInfo = allGuardHits.length > 0
      ? { expectedTarget: ctx.deviceNames.join('、'), hits: allGuardHits, hitCommandIndexes }
      : undefined
    pendingBatches.set(batchId, {
      commands: allowedCommands,
      rejectedCommands,
      fullMessages: ctx.fullMessages,
      aiReply: reply,
      config: ctx.config,
      deviceNames: ctx.deviceNames,
      sessionId: ctx.sessionId,
      createdAt: Date.now(),
      expReferences: ctx.expReferences,
      guardInfo,
      guardLogIds: allGuardHits.length > 0
        ? allowedCommands.filter((c) => (c.guardHits ?? []).length > 0).map((c) => c.logId)
        : undefined,
      agentLoop: { loopCtx: ctx, agentState: state, preResults },
    })
    return {
      confirmPayload: JSON.stringify({
        type: 'confirm_required',
        execId: batchId,
        commands: allowedCommands.map((c) => ({ deviceName: c.deviceName, command: c.command })),
        rejectedCommands: rejectedCommands.map((r) => ({ command: r.cmd, reason: r.reason })),
        aiExplanation: reply,
        guardInfo,
      }),
      count: allowedCommands.length,
      results,
    }
  }

  // auto 直执：D-14 限次静默重试 → 成功清 failureCounts / 失败计连续失败 + 写冷却
  for (const c of allowedCommands) {
    const key = `${c.deviceId}:${c.command}`
    // 36-05 D-11：先取设备投影再建卡——execChannel 取该投影的 connectionType（有效命令通道）
    const device = getDeviceByIdInternal(c.deviceId)
    const step = pushAgentStep(state, 'cmd', { deviceName: c.deviceName, command: c.command, execChannel: resolveStepExecChannel(device) })
    let success = false
    let output = ''
    if (!device) {
      output = '设备不存在'
    } else {
      let remaining = state.retryBudgets.get(key) ?? DEFAULT_AGENT_RETRY_BUDGET
      for (;;) {
        try {
          const execResults = await executeCommandsOnDevice(device, [c.command], { conversationSet: guardConversationSet })
          const r = execResults[0]
          success = !!(r && r.success)
          output = r?.output || (success ? '（命令已执行成功，但设备未返回任何输出文本；如需该数据请重试或换命令）' : '执行失败')
        } catch (err: any) {
          success = false
          output = `执行失败: ${err?.message ?? String(err)}`
        }
        if (success || remaining <= 0) break
        remaining--
        state.retryBudgets.set(key, remaining)
        settleAgentStep(step, 'retrying', state)
      }
    }
    updateLogStatus(c.logId, success ? 'executed' : 'failed')
    const outputSummary = sanitizeUntrusted(output, 4000)
    step.outputSummary = outputSummary.substring(0, 200)
    settleAgentStep(step, success ? 'done' : 'failed', state)
    if (success) {
      state.failureCounts.delete(key)
      pushDeviceSource(state, c.deviceName, c.deviceId)
      results.push(`设备: ${c.deviceName}\n命令: ${c.command}\n状态: executed\n输出:\n${outputSummary}`)
    } else {
      const newCount = (state.failureCounts.get(key) ?? 0) + 1
      state.failureCounts.set(key, newCount)
      state.cooldowns.set(key, Date.now() + limits.cooldownSecs * 1000)
      results.push(`设备: ${c.deviceName}\n命令: ${c.command}\n状态: failed\n输出:\n${outputSummary || '执行失败'}\n（该命令已计入失败冷却，${limits.cooldownSecs}s 内不会自动重试）`)
    }
  }
  for (const r of rejectedCommands) {
    results.push(`设备: ${r.deviceName}\n命令: ${r.cmd}\n状态: rejected\n输出:\n命令被拒绝: ${r.reason}`)
  }
  return { results }
}

/**
 * Phase 28（28-04，AGENT-05/D-06）：用户停止中断收尾——在途步骤定格 interrupted、
 * 置 hardStop（meta_enc/落库回看），返回固定通知文案。立即中止不总结：不触发任何
 * AI 收尾 callAI。在途 SSH/Telnet 命令按 A4 降级：不等待主动取消，60s 硬超时天然收尾。
 */
export function agentInterruptedFinal(state: AgentLoopState): McpLoopResult {
  for (const s of state.steps) {
    if (s.status === 'running' || s.status === 'retrying') settleAgentStep(s, 'interrupted', state)
  }
  state.hardStop = 'user_cancel'
  return { kind: 'final', reply: AGENT_INTERRUPTED_NOTICE }
}

/**
 * Phase 28（AGENT-04/06，D-01）：runMcpToolLoop 就地泛化为 runAgentLoop——四类标记
 * （[CMD]/[KB_SEARCH]/[EXP_SEARCH]/[MCP_TOOL_CALL]）统一有界循环，任一标记即自动延续（D-03）。
 * 安全红线（T-28-03-01）：KB/EXP 直执仅限本地只读检索；CMD/MCP 直执只走既有
 * isCommandAllowed → guard → confirm 门 → executeCommandsOnDevice 双检链（执行函数零改动），
 * 每轮每动作全链重过（循环层零改变执行路径，D-02）。
 * 四重硬顶（T-28-03-02，D-13 诚实结构化收尾，绝不静默截断）：
 * ① 步数 agent_max_rounds；② 同 (deviceId:command) 连续失败 agent_burnout_count 熔断；
 * ③ 同 deviceId:command 失败冷却 agent_cooldown_secs；④ tokenUsed 超 AGENT_TOKEN_BUDGET。
 * 28-04（D-06）：轮入口检查 signal.aborted；LLM 调用中断（ChatInterruptedError）→ 立即中止不总结。
 */
export async function runAgentLoop(
  ctx: McpLoopCtx,
  state: AgentLoopState,
  startReply: string
): Promise<McpLoopResult> {
  try {
    return await runAgentLoopInner(ctx, state, startReply)
  } catch (err) {
    if (err instanceof ChatInterruptedError) return agentInterruptedFinal(state)
    throw err
  }
}

async function runAgentLoopInner(
  ctx: McpLoopCtx,
  state: AgentLoopState,
  startReply: string
): Promise<McpLoopResult> {
  let reply = startReply
  let invalidPrompted = false
  // 上限每轮循环入口读取一次（配置热更后新一轮生效；fail-safe 回退默认）
  // 28-06 缺陷④：mcp_max_rounds 子限退役——MCP 调用与 CMD/KB/EXP 统一受 agent_max_rounds 步数硬顶
  const maxAgentRounds = getAgentMaxRounds()
  const burnoutCount = getAgentBurnoutCount()
  const cooldownSecs = getAgentCooldownSecs()
  for (;;) {
    // 28-04（D-06）：轮入口中断检查——已停止则立即中止（不执行本轮任何动作、不再 callAI）
    if (ctx.signal?.aborted) return agentInterruptedFinal(state)
    const mcpEnabled = ctx.mcpContexts.length > 0
    const parsed = mcpEnabled
      ? parseMcpToolCalls(reply, ctx.mcpContexts)
      : { valid: [] as ValidMcpCall[], hadMarker: false, malformed: false }
    const mcpCalls = parsed.valid
    const kbQueries = parseKbQueries(reply)
    const expQueries = parseExpQueries(reply)
    const cmdBlocks = parseCmdBlocks(reply)
    // Phase 37（37-02，<critical_asymmetry> 锚定）：下方续跑探测正则**刻意不含** BACKFILL
    // 补查标记（[EXP_BACKFILL]/[KB_BACKFILL]）——该标记设计上必须穿过循环收尾存活，由
    // chat()/confirmCommand 收尾的 runEvidenceBackfill 消费（智能模式 AI 决策补查的标记
    // 载体）；若含之循环会续轮消费掉标记载体。零改动是正确态而非遗漏（上方
    // stripAllAgentMarkers :89-96 同理不含 BACKFILL，双零改动红线）。
    const hasOpenMarker = /\[MCP_TOOL_CALL\]|\[(?:KB|EXP)_SEARCH\]|\[CMD(?::[^\]]*)?\]/.test(reply)
    if (mcpCalls.length === 0 && kbQueries.length === 0 && expQueries.length === 0 && cmdBlocks.length === 0) {
      if (!hasOpenMarker) return { kind: 'final', reply: stripAllAgentMarkers(reply) }
      // 有 mcp 标记但全无效（且 mcp 上下文在场）→ 既有分诊回注重试一次（22-05/23 期语义）
      if (mcpEnabled && parsed.hadMarker) {
        if (invalidPrompted) {
          return { kind: 'final', reply: stripAllAgentMarkers(reply) || MCP_PARSE_FAIL_TEXT }
        }
        invalidPrompted = true
        state.extra.push({ role: 'assistant', content: reply })
        state.extra.push({ role: 'user', content: parsed.malformed ? MCP_FORMAT_RETRY_PROMPT : MCP_UNAVAILABLE_TOOL_PROMPT })
        reply = await callAI(ctx.config, [...ctx.fullMessages, ...state.extra], ctx.signal)
        continue
      }
      // 非 mcp 畸形标记（未闭合等）：fail-safe 剥离收尾（死标记不漏进气泡）
      return { kind: 'final', reply: stripAllAgentMarkers(reply) }
    }
    // ① 步数硬顶 / ④ token 预算硬顶 → D-13 诚实结构化收尾（wrapupPrompted 一次性防死循环）
    // 28-06 缺陷④：MCP 调用与 CMD/KB/EXP 同受此步数硬顶（子限 mcp_max_rounds 已退役）
    const tokenOver = state.tokenUsed > AGENT_TOKEN_BUDGET
    if (state.rounds >= maxAgentRounds || tokenOver) {
      if (state.wrapupPrompted) {
        return { kind: 'final', reply: stripAllAgentMarkers(reply) }
      }
      state.wrapupPrompted = true
      const reason = tokenOver
        ? `token 预算耗尽（累计约 ${state.tokenUsed} tokens）`
        : `步数上限（${maxAgentRounds} 步）`
      state.extra.push({ role: 'assistant', content: reply })
      state.extra.push({ role: 'user', content: buildHonestWrapupPrompt(reason, state) })
      const messages = [...ctx.fullMessages, ...state.extra]
      const r = await callAIWithUsage(ctx.config, messages, ctx.signal)
      state.tokenUsed += (r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0)
      reply = r.content
      continue
    }
    const results: string[] = []
    // ---- KB 检索动作（WR-05 解除：循环内直执，只读本地库无确认）----
    for (const q of kbQueries) {
      // 28-06 R2 缺陷①：kb 步骤携带检索词（步骤卡 argsJson 数据源）
      const step = pushAgentStep(state, 'kb', { query: q })
      try {
        results.push(await runKbSearchStep(q, ctx, state, step))
        settleAgentStep(step, 'done', state)
      } catch {
        step.outputSummary = '检索失败'
        settleAgentStep(step, 'failed', state)
        results.push(`[知识库检索: ${q}]\n检索失败，本次未获得文档内容。`)
      }
    }
    // ---- EXP 检索动作（WR-05 解除：循环内直执，只读本地库无确认）----
    for (const q of expQueries) {
      // 28-06 R2 缺陷①：exp 步骤携带检索词（步骤卡 argsJson 数据源）
      const step = pushAgentStep(state, 'exp', { query: q })
      try {
        results.push(await runExpSearchStep(q, ctx, state, step))
        settleAgentStep(step, 'done', state)
      } catch {
        step.outputSummary = '检索失败'
        settleAgentStep(step, 'failed', state)
        results.push(`[经验库检索: ${q}]\n检索失败，本次未获得经验内容。`)
      }
    }
    // ---- CMD 动作（既有安全链 + ②③硬顶 + D-14 重试）----
    if (cmdBlocks.length > 0) {
      const cmdOut = await runAgentCmdRound(
        ctx, state, reply, cmdBlocks,
        { burnoutCount, cooldownSecs },
        results.length > 0 ? results.join('\n\n') : undefined
      )
      if (cmdOut.confirmPayload) {
        return { kind: 'confirm_required', count: cmdOut.count!, payload: cmdOut.confirmPayload }
      }
      results.push(...cmdOut.results)
    }
    // ---- MCP 动作（既有分类/守卫/确认链，一行不改）----
    if (mcpCalls.length > 0) {
      // 逐工具分类聚合（classifyTool 单源；任一 confirm → 整批 confirm_each，D-04）
      const classifiedExecute = mcpCalls.every((c) =>
        McpToolPolicy.classifyTool(
          ctx.execMode,
          c.tool.name,
          c.context.skipConfirmSet,
          { name: c.tool.name, annotations: c.tool.annotations }
        ) === 'execute'
      )
      // Phase 27（GUARD-03 + D-06）：每轮 checkMcpArgs——任一调用命中 → 即使分类全 execute
      // 也视为 false 落入 confirm_each 分支（auto 模式打断，T-27-09）。
      const guardConversationSet = ctx.mcpContexts.filter((c) => c.device).map((c) => toGuardRef(c.device))
      const allGuardDevices = loadAllGuardDevices()
      const mcpGuardHits = mcpCalls.map((c) =>
        c.context.device
          ? checkMcpArgs(c.args, toGuardRef(c.context.device), guardConversationSet, allGuardDevices)
          : []
      )
      const guardHitTotal = mcpGuardHits.reduce((n, h) => n + h.length, 0)
      const allExecute = classifiedExecute && guardHitTotal === 0
      const logIds = mcpCalls.map((c, i) =>
        createLog({
          deviceId: c.context.device?.id ?? '',
          deviceName: String(c.context.device?.name ?? ''),
          command: `mcp:${c.context.serverName}:${c.tool.name}`,
          status: allExecute ? 'approved' : 'pending',
          mode: ctx.execMode,
          aiReason: reply.substring(0, 500),
          promptText: sanitizeUntrusted(mcpCalls.map((x) => x.argsJson).join('\n'), MCP_LOG_PARAM_MAX),
          aiResponse: reply,
          guardHits: mcpGuardHits[i].length > 0 ? mcpGuardHits[i] : undefined,
        })
      )
      if (allExecute) {
        // 整批直执（smart 双条件全满足 / auto 档）→ 每轮独立 tool_result 下发 + 审计（累积）
        for (let i = 0; i < mcpCalls.length; i++) {
          const r = await runMcpCall(mcpCalls[i], logIds[i], ctx.emitToolResult, ctx.sessionId)
          results.push(r.text)
          // 29-09 走查四：直执 mcp 步骤同样记 outputSummary（meta.steps 恢复卡的原始结果回看）
          settleAgentStep(pushAgentStep(state, 'mcp', {
            deviceName: String(mcpCalls[i].context.device?.name ?? ''),
            command: `${mcpCalls[i].context.serverName} · ${mcpCalls[i].tool.name}`,
            outputSummary: sanitizeUntrusted(r.text, 200),
          }), r.status === 'success' ? 'done' : 'failed', state)
          state.sources.push({ kind: 'mcp', title: `${mcpCalls[i].context.serverName} · ${mcpCalls[i].tool.name}` })
        }
      } else {
        // confirm_each：复用 pendingBatches + confirm_required 协议（携带循环状态，确认后续跑）
        const batchId = uuidv4()
        pendingBatches.set(batchId, {
          commands: [],
          rejectedCommands: [],
          fullMessages: ctx.fullMessages,
          aiReply: reply,
          config: ctx.config,
          deviceNames: ctx.deviceNames,
          sessionId: ctx.sessionId,
          createdAt: Date.now(),
          expReferences: ctx.expReferences,
          mcp: {
            calls: mcpCalls,
            logIds,
            emitToolResult: ctx.emitToolResult,
            loopCtx: ctx,
            loopState: state,
            // Phase 27：guard 命中的 logId 清单（确认/取消分支写 guard_outcome 用，T-27-11）
            guardLogIds: logIds.filter((_, i) => mcpGuardHits[i].length > 0),
          },
          guardInfo: guardHitTotal > 0
            ? {
                expectedTarget: ctx.deviceNames.join('、'),
                hits: mcpGuardHits.flat(),
                hitCommandIndexes: mcpGuardHits.flatMap((hits, i) => hits.map(() => i)),
              }
            : undefined,
          // Phase 28（28-03）：mcp 批次同样携带 agent 循环状态 + 本轮已直执的 KB/EXP 结果
          agentLoop: {
            loopCtx: ctx,
            agentState: state,
            preResults: results.length > 0 ? results.join('\n\n') : undefined,
          },
        })
        return {
          kind: 'confirm_required',
          count: mcpCalls.length,
          payload: JSON.stringify({
            type: 'confirm_required',
            execId: batchId,
            commands: mcpCalls.map((c) => ({
              deviceName: String(c.context.device?.name ?? ''),
              command: `[${String(c.context.device?.name ?? '')}] ${c.context.serverName} · ${c.tool.name}\n参数: ${c.argsJson}`,
            })),
            rejectedCommands: [],
            aiExplanation: reply,
            guardInfo: guardHitTotal > 0
              ? {
                  expectedTarget: ctx.deviceNames.join('、'),
                  hits: mcpGuardHits.flat(),
                  hitCommandIndexes: mcpGuardHits.flatMap((hits, i) => hits.map(() => i)),
                }
              : undefined,
          }),
        }
      }
    }
    if (results.length === 0) {
      return { kind: 'final', reply: stripAllAgentMarkers(reply) }
    }
    // 回注续跑（累积）：mcp-only 轮沿用既有文案契约；混合轮用 agent 通用文案
    const text = results.join('\n\n')
    reply = mcpCalls.length > 0 && results.length === mcpCalls.length
      ? await mcpAppendRoundAndCall(ctx, state, reply, text)
      : await agentAppendRoundAndCall(ctx, state, reply, agentResultsUserMessage(text))
  }
}
