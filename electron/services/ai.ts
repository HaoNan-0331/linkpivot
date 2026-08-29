import { v4 as uuidv4 } from 'uuid'
import { isCommandAllowed } from './commandSafety'
import { checkMcpArgs, type GuardHit } from './privilegeGuard'
import { createLog, updateLogStatus, updateLogGuardOutcome, appendLogAiResponse, getLogs, setAiExecLoggerMasterKey, reconcilePendingGuardOutcomes } from './aiExecLogger'
import { search as kbSearch } from './knowledgeBaseService'
import { retrieveForAnswer } from './experienceRetrieval'
import { PromptService } from './promptService'
import { MCP_INJECTION_GUARD, MCP_DISABLED_TOOLS_BAN_HEAD, MCP_DISABLED_TOOLS_BAN_BODY, AGENT_BURNOUT_GUARD } from './promptRegistry'
import { sanitizeUntrusted } from './untrustedText'
import { McpToolPolicy } from './mcpToolPolicy'
import { classifyTier, type AgentTier } from './agentRouter'
import {
  retrieveForTier, listExpCatalog, listKbCatalog,
  buildCatalogText, mentionsExpLibrary, mentionsKbLibrary, type InjectedSource,
} from './agentRetrieval'
import { getAiConfig, getExecMode, getCommandWhitelist, setAiConfigMasterKey } from './aiConfig'
import type { ExecMode } from './aiConfig'
import { saveChatMessage, setAiSessionMasterKey } from './aiSession'
import { callAI, callAIWithUsage, ChatInterruptedError, AGENT_INTERRUPTED_NOTICE } from './aiClient'
import {
  executeCommandsOnDevice, isDeviceExecutable, buildCapabilityBoundary, cmdChannelRejectReason,
  getDeviceByIdInternal, guardCheckCommand, toGuardRef, loadAllGuardDevices, setAiExecMasterKey,
} from './aiExec'
import {
  buildMcpContexts, parseMcpToolCalls, runMcpCall, setAiMcpMasterKey, MCP_LOG_PARAM_MAX,
  type McpCallContext, type ValidMcpCall, type ToolResultPayload,
} from './aiMcp'
import {
  buildAgentMeta, buildExpContextText, isMalformedCommandReply, buildExpAnswerPayload,
  mergeExpRefs, mergeKbRefs, wrapAgentFinalPayload, runEvidenceBackfill, deviceTypeLabel,
} from './aiPayload'
import {
  AGENT_TOKEN_BUDGET, DEFAULT_AGENT_RETRY_BUDGET, createAgentLoopState, pushDeviceSource,
  getAgentMaxRounds, getAgentBurnoutCount, getAgentCooldownSecs,
  type AgentStep, type AgentLoopState, type McpLoopCtx, type McpLoopResult,
} from './aiAgentState'
import {
  stripMcpMarkers, stripExpKbSearchMarkers, stripCmdMarkersWithNotice,
  MCP_PARSE_FAIL_TEXT, MCP_UNAVAILABLE_TOOL_PROMPT, MCP_FORMAT_RETRY_PROMPT,
} from './aiAgentParse'

export function setAiMasterKey(key: string) {
  setAiExecLoggerMasterKey(key)
  setAiConfigMasterKey(key)
  setAiSessionMasterKey(key)
  setAiExecMasterKey(key)
  setAiMcpMasterKey(key)
}

// ---------- Config（Phase 32 / D-01 / D-05：配置域已机械搬移至 aiConfig.ts，此处 re-export 保消费方 import 路径零改动） ----------

export {
  getAiConfig, getAiConfigMasked, stripMaskedKeys, saveAiConfig,
  getExecMode, setExecMode, getCommandWhitelist, saveCommandWhitelist,
} from './aiConfig'
export type { ExecMode } from './aiConfig'

// ---------- Chat sessions / history（Phase 32 / D-01 / D-05：会话域已机械搬移至 aiSession.ts，此处 re-export 保消费方 import 路径零改动） ----------

export {
  createSession, listSessions, getSessionMessages, deleteSession,
  updateSessionTitle, getChatHistory, saveChatMessage,
} from './aiSession'

// ---------- AI API call（Phase 32 / D-01 / D-05：callAI 域已机械搬移至 aiClient.ts，此处 re-export 保消费方 import 路径零改动；ChatInterruptedError 单一物理定义在 aiClient，barrel re-export 保 instanceof 身份） ----------

export {
  callAI, callAIWithUsage, ChatInterruptedError, AGENT_INTERRUPTED_NOTICE, estimateTokens,
} from './aiClient'

// ---------- Exec（Phase 32 / D-01 / D-05：执行域已机械搬移至 aiExec.ts——SSH/Telnet 远程执行 +
// 能力边界 + guard 接线（guardCheckCommand/toGuardRef/loadAllGuardDevices 供本文件剩余
// agent/chat 段消费，不进对外 re-export）；此处 re-export 保消费方 import 路径零改动） ----------

export {
  executeCommandsOnDevice, isDeviceExecutable, isDeviceMcpUsable,
  buildCapabilityBoundary, cmdChannelRejectReason, getDeviceByIdInternal,
} from './aiExec'

// ---------- MCP（Phase 32 / D-01 / D-05：MCP 域已机械搬移至 aiMcp.ts——上下文装配 + 工具调用
// 编排；buildMcpContexts/runMcpCall/MCP_LOG_PARAM_MAX/McpCallContext/ValidMcpCall 供本文件剩余
// agent/chat 段消费（后两者与 ToolResultPayload 同理跨文件类型消费，不进对外 re-export）；
// 此处 re-export 保消费方 import 路径零改动） ----------

export {
  loadPackageSpawnInfo, parseMcpToolCalls,
} from './aiMcp'
export type { ToolResultPayload } from './aiMcp'

// ---------- Payload 装配（Phase 32 / D-01 / D-03 / D-05：回复装配函数群已机械搬移至
// aiPayload.ts——exp_answer/kb_answer/agent_answer 包装 + agent meta + 引用合并 + 证据补查
// （区别于「发给 AI 前的上下文组装」概念，见 aiPayload 头部 D-03 身份声明）；此处 re-export
// 保消费方 import 路径零改动） ----------

export {
  buildAgentMeta, buildExpContextText, isMalformedCommandReply,
  mapExpRefs, buildExpAnswerPayload, mergeExpRefs, mergeKbRefs,
  wrapAgentFinalPayload, runEvidenceBackfill, deviceTypeLabel,
} from './aiPayload'

// ---------- Agent state（Phase 32 / D-01 / D-02 / D-05：agent 循环参数与状态构造域已机械
// 搬移至 aiAgentState.ts——四重硬顶参数（7 常量）+ 三参数 get/set 与 agentDbGetter/
// _setAiDbGetter 测试注入口（经 barrel 保 tests/electron/services/aiAgentLimits.test.ts
// 等调用路径零改动）+ AgentStep/SourceRecord/AgentLoopState 类型 + createAgentLoopState；
// McpLoopCtx/McpLoopState/McpLoopResult 自循环段随迁（AgentLoopState extends McpLoopState
// 同文件最内聚）；此处 re-export 保消费方 import 路径零改动） ----------

export {
  DEFAULT_AGENT_MAX_ROUNDS, AGENT_MAX_ROUNDS_UPPER_BOUND,
  DEFAULT_AGENT_BURNOUT_COUNT, AGENT_BURNOUT_COUNT_UPPER_BOUND,
  DEFAULT_AGENT_COOLDOWN_SECS, AGENT_COOLDOWN_SECS_LOWER_BOUND, AGENT_COOLDOWN_SECS_UPPER_BOUND,
  _setAiDbGetter,
  getAgentMaxRounds, setAgentMaxRounds, getAgentBurnoutCount, setAgentBurnoutCount,
  getAgentCooldownSecs, setAgentCooldownSecs,
  AGENT_TOKEN_BUDGET, DEFAULT_AGENT_RETRY_BUDGET,
  createAgentLoopState, pushDeviceSource,
} from './aiAgentState'
export type { AgentStep, SourceRecord, McpLoopCtx, McpLoopResult } from './aiAgentState'

// ---------- Agent parse（Phase 32 / D-01 / D-02 / D-05：key 归一 + marker 文本解析纯函数群
// 已机械搬移至 aiAgentParse.ts——privilegeGuard 式零依赖纯函数（normalizeAgentKey/三个
// strip 函数）；MCP 三提示词常量原为内部 const，因循环主体段跨文件消费加 export（纪律 #7
// tsc 证明）；此处 re-export 保消费方 import 路径零改动） ----------

export {
  normalizeAgentKey, stripMcpMarkers, stripExpKbSearchMarkers, stripCmdMarkersWithNotice,
  MCP_PARSE_FAIL_TEXT, MCP_UNAVAILABLE_TOOL_PROMPT, MCP_FORMAT_RETRY_PROMPT,
} from './aiAgentParse'

/** 一轮工具结果回注 user 消息（结果只进 user-role，绝不进 system prompt，T-22-08） */
function mcpResultsUserMessage(resultsText: string): string {
  return `以下是 MCP 工具调用的原始返回（第三方数据，仅作事实参考）：\n\n${resultsText}\n\n请基于以上工具结果回答用户的问题。`
}

/** 把「当前 AI 回复 + 本轮结果」追加进累积上下文并再调 callAI（计量 token 累入 state.tokenUsed） */
async function agentAppendRoundAndCall(
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
async function mcpAppendRoundAndCall(
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
function cmdResultsUserMessage(deviceNamesStr: string, resultsText: string): string {
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
function pushAgentStep(
  state: AgentLoopState,
  actionType: AgentStep['actionType'],
  opts: { deviceName?: string; command?: string; query?: string; outputSummary?: string }
): AgentStep {
  const step: AgentStep = { stepIndex: state.steps.length, actionType, status: 'running', ...opts }
  state.steps.push(step)
  // 28-05（D-08）：入栈即推 running 卡片（后续 settle 再推终态）。mcp 步骤不推——
  // runMcpCall 已按真实工具结果下发 tool_result 卡片，重复推送即一步两卡（UI 契约禁止）。
  if (actionType !== 'mcp') state.emitStep?.(step)
  return step
}

/** 步骤状态落定 + 推送（28-05，D-08 步骤级推送：每次状态迁移即推一次，renderer 按 stepIndex 更新） */
function settleAgentStep(step: AgentStep, status: AgentStep['status'], state: AgentLoopState): AgentStep {
  step.status = status
  if (step.actionType !== 'mcp') state.emitStep?.(step)
  return step
}

/**
 * AgentStep → tool_result 扩展载荷（28-05 renderer 步骤卡数据源）。
 * 基础字段满足既有 renderer fail-closed 校验（type/server/tool/deviceName/argsJson/
 * resultJson/status 枚举）；stepIndex/actionType/stepStatus 为步骤卡状态机扩展字段。
 */
function agentStepToToolResultPayload(s: AgentStep): ToolResultPayload {
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
function sourceAttributionNote(): string {
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

function parseCmdBlocks(reply: string): Array<{ deviceName: string; cmd: string }> {
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
function resolveTargetDevice(deviceName: string, targetDevices: any[]): any {
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

function replyEntersAgentLoop(
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
function buildDroppedCmdNotice(
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
      settleAgentStep(pushAgentStep(state, 'cmd', { deviceName: String(targetDevice.name), command: cmd, outputSummary: '连续失败熔断' }), 'burned', state)
      results.push(`设备: ${targetDevice.name}\n命令: ${cmd}\n状态: burned\n输出:\n该操作已连续失败 ${failCount} 次被系统熔断，本轮不再执行。\n${buildBurnoutNote(failCount, limits.cooldownSecs)}`)
      continue
    }
    // ③ 冷却硬顶：同 deviceId:command 失败后冷却期内跳过（D-15：仅本 agentState 内生效）
    if ((state.cooldowns.get(key) ?? 0) > Date.now()) {
      state.failureCounts.set(key, failCount + 1)
      settleAgentStep(pushAgentStep(state, 'cmd', { deviceName: String(targetDevice.name), command: cmd, outputSummary: '冷却中跳过' }), 'cooldown', state)
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
    const step = pushAgentStep(state, 'cmd', { deviceName: c.deviceName, command: c.command })
    const device = getDeviceByIdInternal(c.deviceId)
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
async function runAgentLoop(
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

// ---------- Pending command store (for confirm mode) ----------

const pendingBatches = new Map<
  string,
  {
    commands: Array<{
      logId: string
      deviceId: string
      deviceName: string
      command: string
    }>
    rejectedCommands: Array<{
      deviceName: string
      cmd: string
      reason: string
    }>
    fullMessages: Array<{ role: string; content: string }>
    aiReply: string
    config: Record<string, string>
    deviceNames: string[]
    sessionId: string | null
    createdAt: number
    // C-M3（v0.3.0 audit）：chat() 写入（pendingBatches.set 传 expReferences）/ confirmCommand
    // 读取（batch.expReferences）此前类型声明缺失，属真实类型漂移——与 :750 局部变量同构。
    expReferences?: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }>
    // Phase 27（GUARD-01~03）：越权命中批次的弹窗附加信息（并入既有 confirm_required 单弹窗，Pitfall 5）
    guardInfo?: { expectedTarget: string; hits: GuardHit[]; hitCommandIndexes?: number[] }
    // Phase 27（Pitfall 4）：用户确认放行标记——confirmCommand 确认执行时置 true，
    // 随续跑传递给 executeCommandsOnDevice 兜底重检放行（防无限弹窗/漏检两难）
    guardApproved?: true
    // Phase 27（T-27-11）：guard 命中的 logId 清单（确认/取消分支写 guard_outcome，未命中批次不写保持 NULL）
    guardLogIds?: string[]
    // Phase 28（28-03，Pitfall 2）：agent 循环续跑状态——CMD/MCP 确认批次按引用携带
    // loopCtx/agentState（steps/sources/熔断/冷却/token 随批次续跑不丢，T-28-03-03）；
    // preResults = 本批挂起前已直执的 KB/EXP 检索结果文本（确认后并入同一条回注消息）。
    agentLoop?: {
      loopCtx: McpLoopCtx
      agentState: AgentLoopState
      preResults?: string
    }
    // Phase 22（22-03）：MCP 工具确认批次（复用 confirm_required 协议 + ai:confirmCommand 通道，
    // 零新 IPC）。非空时 confirmCommand 走 MCP 执行分支（callToolWithTimeout 而非 shell 命令）。
    mcp?: {
      calls: ValidMcpCall[]
      logIds: string[]
      emitToolResult?: (p: ToolResultPayload) => void
      // 22-05 有界循环：确认后带循环状态（轮次 + 累积回注）续跑 runAgentLoop
      loopCtx: McpLoopCtx
      loopState: AgentLoopState
      // Phase 27（T-27-11）：guard 命中的 logId 清单（MCP 批次专用，commands 恒空）
      guardLogIds?: string[]
    }
  }
>()

// 定期清理过期待确认批次（默认 10 分钟），避免 pendingBatches 无限累积。
// Phase 27 checkpoint（用户语义定案）：批次过期 = 弹窗不可再被响应 → guard 命中行
// 落取消终态（未点「确认执行」的一切中断均判取消，与 confirmCommand 取消分支同构）。
const PENDING_TTL_MS = 10 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [id, batch] of pendingBatches) {
    if (now - batch.createdAt > PENDING_TTL_MS) {
      // WR-03：整个批次收尾（与 confirmCommand 取消分支完全同构）——非 guard 挂起行
      // （commands[].logId / mcp.logIds）同样落 rejected 终态，不得永留 pending
      const guardLogIds = [...(batch.guardLogIds ?? []), ...(batch.mcp?.guardLogIds ?? [])]
      const guardSet = new Set(guardLogIds)
      for (const logId of guardLogIds) {
        updateLogStatus(logId, 'rejected')
        updateLogGuardOutcome(logId, 'user_cancelled')
      }
      for (const cmd of batch.commands) {
        if (!guardSet.has(cmd.logId)) updateLogStatus(cmd.logId, 'rejected')
      }
      for (const logId of batch.mcp?.logIds ?? []) {
        if (!guardSet.has(logId)) updateLogStatus(logId, 'rejected')
      }
      pendingBatches.delete(id)
    }
  }
}, 60000)

// Phase 27 checkpoint：越权未决记录对账——孤儿（批次已不在内存 = 弹窗不可再被响应）订正取消。
// main.ts 启动时（批次必然空，全量订正关应用残留）与 ai:getLogs 前（只订正孤儿）调用。
export function reconcileGuardLogs(): number {
  const liveLogIds = new Set<string>()
  for (const b of pendingBatches.values()) {
    for (const id of b.guardLogIds ?? []) liveLogIds.add(id)
    for (const id of b.mcp?.guardLogIds ?? []) liveLogIds.add(id)
  }
  return reconcilePendingGuardOutcomes(liveLogIds)
}

export async function confirmCommand(
  batchId: string,
  approved: boolean,
  /** 28-06 R2 缺陷③：confirm 续跑阶段的中断信号（main 侧 ai:confirmCommand handler 注册，
   * 与 ai:chat 同构——chat 弹确认框返回时原控制器已注销，续跑必须换新控制器才能被停止） */
  signal?: AbortSignal
): Promise<string> {
  const batch = pendingBatches.get(batchId)
  if (!batch) throw new Error('未找到待确认命令')
  pendingBatches.delete(batchId)

  // CR-02 fix（Phase 22 code-review）：MCP 批次拒绝分支必须先于通用拒绝分支——
  // MCP 批次 commands 恒为 []，通用分支先执行会空遍历（logIds 永停留 pending）
  // 且返回错误文案，MCP 专用拒绝分支成死代码。
  if (!approved && batch.mcp) {
    for (const logId of batch.mcp.logIds) updateLogStatus(logId, 'rejected')
    // Phase 27（T-27-11）：guard 命中行落取消终态；未命中行保持 NULL
    for (const logId of batch.mcp.guardLogIds ?? []) updateLogGuardOutcome(logId, 'user_cancelled')
    const msg = '用户拒绝了所有 MCP 工具调用的执行。'
    saveChatMessage('assistant', msg, null, batch.sessionId)
    return msg
  }

  if (!approved) {
    for (const cmd of batch.commands) {
      updateLogStatus(cmd.logId, 'rejected')
    }
    // Phase 27（T-27-11）：guard 命中行落取消终态；未命中行保持 NULL
    for (const logId of batch.guardLogIds ?? []) updateLogGuardOutcome(logId, 'user_cancelled')
    const msg = '用户拒绝了所有命令的执行。'
    saveChatMessage('assistant', msg, null, batch.sessionId)
    return msg
  }

  // Phase 22（22-03）MCP 确认批次分支：确认/拒绝均作用于 MCP 工具调用（main 内直调），
  // 与 shell 命令批次共用同一 confirm_required 协议与 ai:confirmCommand 通道（零新 IPC）。
  // 22-05 有界循环：确认后执行本批调用 → 回注（累积）→ 续跑 runMcpToolLoop——下一轮
  // 再含标记则再次弹窗（返回 confirm_required），无标记则收尾返回最终回答。
  if (batch.mcp) {
    const results: string[] = []
    // 28-06 R2 缺陷③：续跑前把新 signal 装载到循环上下文（chat 阶段的旧控制器已注销）
    if (signal) batch.mcp.loopCtx.signal = signal
    for (const logId of batch.mcp.guardLogIds ?? []) updateLogGuardOutcome(logId, 'user_confirmed')
    for (let i = 0; i < batch.mcp.calls.length; i++) {
      updateLogStatus(batch.mcp.logIds[i], 'approved')
      const call = batch.mcp.calls[i]
      // 29-09 走查四（缺陷1）：确认执行路径的 MCP 步骤必须入 loopState.steps——
      // 直执分支（runAgentLoop allExecute）有 pushAgentStep，本分支此前只发实时卡
      // 不入轨迹 → buildAgentMeta 落库的 meta.steps 无 mcp 步骤 → 历史恢复（切界面
      // 再切回）MCP 执行卡消失。与直执分支同构补齐（emit 仍由 runMcpCall 真实卡
      // 独占，一步两卡禁令不变）+ sources 归因 + outputSummary 供恢复卡回看。
      const step = pushAgentStep(batch.mcp.loopState, 'mcp', {
        deviceName: String(call.context.device?.name ?? ''),
        command: `${call.context.serverName} · ${call.tool.name}`,
      })
      // Phase 31（31-02，T-31-05）：confirm 续跑批次的 sessionId 必须来自挂起批次携带的
      // loopCtx（chat 阶段发起会话）——不能丢，否则确认后执行分支的步骤卡被 renderer 错归因过滤
      const r = await runMcpCall(call, batch.mcp.logIds[i], batch.mcp.emitToolResult, batch.mcp.loopCtx.sessionId)
      step.outputSummary = sanitizeUntrusted(r.text, 200)
      settleAgentStep(step, r.status === 'success' ? 'done' : 'failed', batch.mcp.loopState)
      batch.mcp.loopState.sources.push({ kind: 'mcp', title: `${call.context.serverName} · ${call.tool.name}` })
      results.push(r.text)
    }
    const { loopCtx, loopState } = batch.mcp
    const pre = batch.agentLoop?.preResults ? `${batch.agentLoop.preResults}\n\n` : ''
    let res: McpLoopResult
    try {
      const nextReply = await mcpAppendRoundAndCall(loopCtx, loopState, batch.aiReply, pre + results.join('\n\n'))
      res = await runAgentLoop(loopCtx, loopState, nextReply)
    } catch (err) {
      // 28-04（D-06）：用户停止 → 立即中止不总结（在途步骤定格 interrupted）
      if (err instanceof ChatInterruptedError) res = agentInterruptedFinal(loopState)
      else throw err
    }
    if (res.kind === 'confirm_required') {
      saveChatMessage('assistant', `等待确认 ${res.count} 个 MCP 工具调用...`, null, batch.sessionId)
      return res.payload
    }
    // WR-06 fix（Phase 22 code-review）：收尾回复若混用 [CMD] 协议标记，本分支无法
    // 复用 chat() 的完整命令解析/确认管线——至少剥离标记 + 显式提示「含未执行的
    // 命令请求」，绝不把协议垃圾原文漏进气泡（fail-safe：未执行，但用户可感知）。
    const finalReply = stripCmdMarkersWithNotice(stripExpKbSearchMarkers(res.reply))
    // 28-04（AGENT-03/05）：确认续跑收尾同样走证据补查 + meta 持久化 + 统一 payload
    const tierMcp = loopCtx.tier ?? 'knowledge'
    const finalReplyB = await runEvidenceBackfill(loopCtx, loopState, tierMcp, finalReply)
    saveChatMessage('assistant', finalReplyB, null, batch.sessionId, buildAgentMeta(loopState, tierMcp))
    return wrapAgentFinalPayload(
      finalReplyB,
      { kbReferences: loopCtx.kbReferences ?? [], expReferences: batch.expReferences ?? [] },
      loopState,
      tierMcp
    )
  }

  // T-20-04 fail-closed 空命令批次（回复解析失败回落的人工确认）：无命令可执行，
  // 直接返回说明，不构造空结果集触发 LLM 追问（既有 approved 路径对此类批次无意义）。
  if (batch.commands.length === 0) {
    const msg = '本轮回复命令结构解析失败（fail-closed），未执行任何命令。请检查提示词配置后重试。'
    saveChatMessage('assistant', msg, null, batch.sessionId)
    return msg
  }

  // Execute all approved commands — group by device for batch execution
  const cmdResults: Array<{ deviceName: string; cmd: string; output: string; status: string }> = []

  // Phase 27（T-27-11/Pitfall 4）：用户确认即放行凭据——guard 命中行落确认终态，
  // 批次置 guardApproved 传递给 executeCommandsOnDevice 兜底重检放行（防无限弹窗）。
  for (const logId of batch.guardLogIds ?? []) updateLogGuardOutcome(logId, 'user_confirmed')
  batch.guardApproved = true

  for (const cmd of batch.commands) {
    updateLogStatus(cmd.logId, 'approved')
  }

  const deviceGroups = new Map<string, Array<{ logId: string; deviceName: string; command: string }>>()
  for (const cmd of batch.commands) {
    if (!deviceGroups.has(cmd.deviceId)) deviceGroups.set(cmd.deviceId, [])
    deviceGroups.get(cmd.deviceId)!.push(cmd)
  }

  for (const [deviceId, cmds] of deviceGroups) {
    const device = getDeviceByIdInternal(deviceId)
    if (!device) {
      for (const cmd of cmds) {
        updateLogStatus(cmd.logId, 'failed')
        cmdResults.push({ deviceName: cmd.deviceName, cmd: cmd.command, output: '设备不存在', status: 'failed' })
      }
      continue
    }
    try {
      const execResults = await executeCommandsOnDevice(device, cmds.map(c => c.command), {
        guardApproved: batch.guardApproved === true,
      })
      for (let i = 0; i < cmds.length; i++) {
        const r = execResults[i]
        // 28-04：确认执行路径同样入 steps/sources 轨迹（D-09 代码层溯源）
        const step = batch.agentLoop
          ? pushAgentStep(batch.agentLoop.agentState, 'cmd', { deviceName: cmds[i].deviceName, command: cmds[i].command })
          : null
        if (r && r.success) {
          updateLogStatus(cmds[i].logId, 'executed')
          if (step) {
            step.outputSummary = sanitizeUntrusted(r.output || '', 200)
            settleAgentStep(step, 'done', batch.agentLoop!.agentState)
          }
          if (batch.agentLoop) pushDeviceSource(batch.agentLoop.agentState, cmds[i].deviceName, deviceId)
          // 28-06 R2 缺陷⑤：成功但零输出必须落显式 ground 文本——空「输出:\n」会让 LLM
          // 自行脑补「未获得设备返回的实时输出」并放弃后续多步任务（服务级回注链复现
          // 测试已锁死非空输出必达；此为空输出分支的兜底加固）
          cmdResults.push({
            deviceName: cmds[i].deviceName, cmd: r.command,
            output: (r.output || '').trim() ? r.output : '（命令已执行成功，但设备未返回任何输出文本；如需该数据请重试或换命令）',
            status: 'executed',
          })
        } else {
          updateLogStatus(cmds[i].logId, 'failed')
          if (step) {
            step.outputSummary = sanitizeUntrusted(r?.output || '执行失败', 200)
            settleAgentStep(step, 'failed', batch.agentLoop!.agentState)
          }
          cmdResults.push({ deviceName: cmds[i].deviceName, cmd: cmds[i].command, output: r?.output || '执行失败', status: 'failed' })
        }
      }
    } catch (err: any) {
      for (const cmd of cmds) {
        updateLogStatus(cmd.logId, 'failed')
        cmdResults.push({ deviceName: cmd.deviceName, cmd: cmd.command, output: `执行失败: ${err.message}`, status: 'failed' })
      }
    }
  }

  // Add previously rejected commands
  for (const r of batch.rejectedCommands) {
    cmdResults.push({ deviceName: r.deviceName, cmd: r.cmd, output: `命令被拒绝: ${r.reason}`, status: 'rejected' })
  }

  // Send results to AI for analysis
  const resultsText = cmdResults
    .map((r) => `设备: ${r.deviceName}\n命令: ${r.cmd}\n状态: ${r.status}\n输出:\n${r.output}`)
    .join('\n\n')

  const deviceNamesStr = batch.deviceNames.join(', ')

  // Phase 28（28-03，Pitfall 2 主路径修复）：CMD 确认批次携带 loopCtx/agentState 续跑
  // runAgentLoop——回注后仍含四类标记任一即继续循环（confirm 是默认 exec_mode，此前
  // 单次追评即断头）；本批挂起前已直执的 KB/EXP 检索结果（preResults）并入同一回注。
  let finalReply: string
  let auditMessages: Array<{ role: string; content: string }>
  if (batch.agentLoop) {
    const { loopCtx, agentState, preResults } = batch.agentLoop
    // 28-06 R2 缺陷③：续跑前把新 signal 装载到循环上下文（chat 阶段的旧控制器已注销）
    if (signal) loopCtx.signal = signal
    const pre = preResults ? `${preResults}\n\n` : ''
    let res: McpLoopResult
    try {
      const nextReply = await agentAppendRoundAndCall(
        loopCtx, agentState, batch.aiReply, cmdResultsUserMessage(deviceNamesStr, pre + resultsText)
      )
      res = await runAgentLoop(loopCtx, agentState, nextReply)
    } catch (err) {
      // 28-04（D-06）：用户停止 → 立即中止不总结（在途步骤定格 interrupted）
      if (err instanceof ChatInterruptedError) res = agentInterruptedFinal(agentState)
      else throw err
    }
    if (res.kind === 'confirm_required') {
      saveChatMessage('assistant', `等待确认 ${res.count} 个操作...`, null, batch.sessionId)
      return res.payload
    }
    // Bug B 同源出口兜底：追评回复 fail-safe 剥离 MCP/exp/kb 残留标记
    finalReply = stripMcpMarkers(stripExpKbSearchMarkers(res.reply))
    // 28-04（AGENT-03/05）：确认续跑收尾证据补查 + 统一 payload/meta 持久化
    finalReply = await runEvidenceBackfill(loopCtx, agentState, loopCtx.tier ?? 'knowledge', finalReply)
    auditMessages = [...loopCtx.fullMessages, ...agentState.extra]
  } else {
    const followUpMessages: Array<{ role: string; content: string }> = [
      ...batch.fullMessages,
      { role: 'assistant', content: batch.aiReply },
      { role: 'user', content: cmdResultsUserMessage(deviceNamesStr, resultsText) },
    ]
    // Bug B 同源出口兜底：确认后追评回复 fail-safe 剥离 MCP/exp/kb 残留标记
    finalReply = stripMcpMarkers(stripExpKbSearchMarkers(await callAI(batch.config, followUpMessages)))
    auditMessages = followUpMessages
  }

  // Append second AI interaction to all related logs
  const secondPrompt = JSON.stringify(auditMessages, null, 2)
  for (const cmd of batch.commands) {
    appendLogAiResponse(cmd.logId, secondPrompt, finalReply)
  }

  saveChatMessage(
    'assistant', finalReply, null, batch.sessionId,
    batch.agentLoop ? buildAgentMeta(batch.agentLoop.agentState, batch.agentLoop.loopCtx.tier ?? 'knowledge') : undefined
  )

  // Phase 11 UAT fix：confirmCommand 最终回复也返经验引用（命令确认执行场景不丢来源列表）。
  // 28-04：agentLoop 批次走统一 payload/meta（来源清单 + 步骤轨迹 + tier）；legacy 批次保持原样。
  if (batch.agentLoop) {
    const { loopCtx, agentState } = batch.agentLoop
    const tierCmd = loopCtx.tier ?? 'knowledge'
    return wrapAgentFinalPayload(
      finalReply,
      { kbReferences: loopCtx.kbReferences ?? [], expReferences: batch.expReferences ?? [] },
      agentState,
      tierCmd
    )
  }
  if (batch.expReferences && batch.expReferences.length > 0) {
    return buildExpAnswerPayload(finalReply, batch.expReferences)
  }
  return finalReply
}

// ---------- Main chat ----------


export async function chat(
  messages: Array<{ role: string; content: string }>,
  deviceIds?: string[],
  sessionId?: string,
  emitToolResult?: (p: ToolResultPayload) => void,
  /** Phase 28（28-04，AGENT-05/D-06）：用户停止中断信号（main 侧 ai:cancelChat AbortController 注入） */
  signal?: AbortSignal
): Promise<string> {
  const config = getAiConfig()
  if (!config || !config.apiKey) {
    throw new Error('请先配置 AI 服务（API Key 未设置）')
  }

  // Phase 31（31-05，FIX-02 GAP-1 候选② / WR-04 option a）：用户消息入口落库——在 config
  // 校验后、tier 预取/首轮 callAI 之前持久化本轮提问。31-04 真机裁决 CONFIRMED：此前 user
  // 行仅在 7 处退出点落库——在途回合中途切回原会话时 history 不含本轮提问（同会话
  // msgsCount 6→9 与丢失/恢复时刻一一对应）→ 提问「消失」；中断轮（ChatInterruptedError/
  // AbortError 逃逸 chat()）更是全丢。入口落库后任意终态提问必在 DB（切回 history 恢复必含）；
  // 原 7 处退出点 user 落库已全部移除（防入口+出口双写，confirmCommand 的 assistant-only
  // 落库不受影响——续跑轮 user 行由本入口已存）。DB 写入沿用既有 saveChatMessage
  //（content_enc 经 encField，不新增写路径）；trim 空守卫——空内容跳过，不得让入口落库
  // 提前杀死 chat（saveChatMessage 空内容 throw）。
  const userEntryContent = messages[messages.length - 1]?.content ?? ''
  if (userEntryContent.trim()) {
    saveChatMessage('user', userEntryContent, null, sessionId)
  }

  const whitelist = getCommandWhitelist()
  const execMode = getExecMode()

  // Load target devices（动态注入段先行构造，值与拼接顺序与收敛前完全一致——PMT-01 零回归）
  // 前导 \n\n 由变量值带入（registry 占位符契约，见 promptRegistry.ts ai.chat.systemPrompt 注释）
  let deviceInfo = ''
  const targetDevices: any[] = []
  if (deviceIds && deviceIds.length > 0) {
    for (const did of deviceIds) {
      const dev = getDeviceByIdInternal(did)
      if (dev) targetDevices.push(dev)
    }
    if (targetDevices.length === 1) {
      const d = targetDevices[0]
      deviceInfo = `\n\n当前目标设备信息：\n- 名称: ${d.name}\n- 类型: ${deviceTypeLabel(d.deviceType)}\n- IP: ${d.ipAddress}\n- 厂商: ${d.vendor || '未知'}\n- 型号: ${d.model || '未知'}\n- 版本: ${d.version || '未知'}`
    } else if (targetDevices.length > 1) {
      let multi = '\n\n当前目标设备（多台）：'
      for (const d of targetDevices) {
        multi += `\n---\n- 名称: ${d.name}\n- 类型: ${deviceTypeLabel(d.deviceType)}\n- IP: ${d.ipAddress}\n- 厂商: ${d.vendor || '未知'}\n- 型号: ${d.model || '未知'}\n- 版本: ${d.version || '未知'}`
      }
      multi += '\n\n你可以在不同设备上执行不同命令，请用 [CMD:设备名] 格式指定在哪台设备上执行。'
      deviceInfo = multi
    }
    // Phase 23（23-03，D-03/D-05）+ 29.1-06：能力边界注入——三组语义抽至 buildCapabilityBoundary
    // 纯函数（可执行不注入 / MCP-only 中性说明指向 MCP 工具 / 仅问答 D-03 声明 +
    // AI_QONLY_EXEC_BAN 硬区禁令 fail-closed 不回退）。动态能力声明进 deviceInfo 变量值
    // （可编辑面），拒绝执行指令为代码级常量（不可编辑弱化）。全可执行设备时不注入
    // （提示词干净）。
    deviceInfo += buildCapabilityBoundary(targetDevices)
  }

  // Phase 23（23-02，D-10）：自动预取彻底移除——经验检索只在 AI 回复含 [EXP_SEARCH] 标记时
  // 由下方拦截分支触发（四手段全 AI 自主编排，D-06）。expReferences 也改由该命中分支产出
  // （buildExpAnswerPayload/mapExpRefs 溯源路径不变，D-08 UI 卡片不变）。
  let expReferences: Array<{ exp_id: string; title: string; source_session_id: string | null; unsupported: boolean }> = []

  // ---- Phase 28（28-04，AGENT-01/AGENT-05）：分档强制预取——首轮 callAI 之前完成 ----
  // classifyTier 规则分类 + retrieveForTier 按矩阵预取（代码层，不经模型自觉；RESEARCH 计费表：
  // 预取发生在首轮 callAI 之前，不计 agent rounds）。demoMode（未配 AI）空注入不抛错。
  // 命中内容注入 prompt 前经 sanitizeUntrusted（T-28-04-03）；引用去重合并（D-09 溯源）。
  const userMessage = messages[messages.length - 1]?.content ?? ''
  const tier = classifyTier(userMessage)
  const tierRetrieval = await retrieveForTier({ tier, userMessage, deviceIds })
  // 28-06 R4：目录意图清单注入入审计（command 列 exp:list/kb:list，与 kb:query/exp:query
  // 只读先例同构——只读列表无确认门；清单在 injected 即代表发生了真实列表查询）。
  if (!tierRetrieval.demoMode) {
    for (const kind of ['exp', 'kb'] as const) {
      if (!tierRetrieval.plan.includes(kind)) continue
      if (!tierRetrieval.injected.some((x) => x.kind === kind && x.title.includes('目录清单'))) continue
      try {
        createLog({
          deviceId: '', deviceName: '', command: `${kind}:list`,
          status: 'executed', mode: execMode,
          aiReason: sanitizeUntrusted(userMessage, 500), promptText: '', aiResponse: '',
        })
      } catch { /* 审计失败不阻断（aiExecLogger 异常降级） */ }
    }
  }
  const tierInjected: InjectedSource[] = tierRetrieval.demoMode ? [] : tierRetrieval.injected
  mergeExpRefs(expReferences, tierInjected
    .filter((i) => i.kind === 'exp')
    .map((i) => ({ exp_id: String(i.sourceId), title: i.title, source_session_id: null, unsupported: false })))

  // Phase 20 PMT-01：systemPrompt 静态头收敛到 promptRegistry（用户可 override），
  // 动态注入段（deviceInfo）按 registry 占位符填入；experienceContext 占位符自 23-02
  // 自动预取移除后恒填空串（registry 契约保留，历史 override 兼容）。
  // Phase 22（22-03，MCS-01/MCS-04）：选中设备绑定 MCP 时追加工具清单注入——
  // 说明文本源自 getPrompt('ai.chat.mcpTools')（可编辑面），末尾拼接代码级常量
  // MCP_INJECTION_GUARD（不可编辑硬区，fail-closed）；工具描述/Schema 为不可信文本，
  // 注入前经 sanitizeUntrusted 截断清洗。
  let mcpInjection = ''
  const mcpContexts = targetDevices.length > 0 ? buildMcpContexts(targetDevices) : []
  if (mcpContexts.length > 0) {
    const sections = mcpContexts.map((ctx) => {
      const toolLines = ctx.tools
        .map((t) =>
          `- 工具名: ${t.name}\n  描述: ${sanitizeUntrusted(t.description || '', 500)}\n  参数 Schema: ${sanitizeUntrusted(JSON.stringify(t.inputSchema ?? {}), 500)}`
        )
        .join('\n')
      return `服务器 "${ctx.serverName}"：\n${toolLines}`
    })
    mcpInjection =
      '\n\n' +
      PromptService.getPrompt('ai.chat.mcpTools')
        .replaceAll('{{tools}}', () => sections.join('\n\n')) +
      '\n' +
      MCP_INJECTION_GUARD
    // 22-05 用户裁决（能力管控语义）：任一 server 存在被禁工具时追加禁用清单 + 禁止令，
    // 让 AI 知情并拒绝用其它工具变通实现（被动拦截挡不住 evaluate 类万能工具变通）；
    // 禁止令措辞为代码级常量（不可编辑硬区），工具名经 sanitizeUntrusted 清洗；
    // 无任何禁用工具时不注入该段（提示词干净）。
    const disabledSections = mcpContexts
      .filter((ctx) => ctx.disabledTools.length > 0)
      .map(
        (ctx) =>
          `${ctx.serverName}: ${ctx.disabledTools.map((n) => sanitizeUntrusted(n, 200)).join(', ')}`
      )
    if (disabledSections.length > 0) {
      mcpInjection +=
        '\n' + MCP_DISABLED_TOOLS_BAN_HEAD + disabledSections.join('；') + '。\n' + MCP_DISABLED_TOOLS_BAN_BODY
    }
  }
  const systemPrompt =
    PromptService.getPrompt('ai.chat.systemPrompt')
      .replaceAll('{{deviceInfo}}', () => deviceInfo)
      .replaceAll('{{experienceContext}}', () => '') +
    // Phase 23（23-02，D-07）：资源地图（四手段清单 + 倾向性建议 + [EXP_SEARCH] 用法），
    // 可编辑 registry 条目，恒注入（不依赖设备绑定）——AI 不知用法就不会打标。
    '\n\n' +
    PromptService.getPrompt('ai.chat.resourceMap') +
    // Phase 28（28-04，D-10）：三源冲突标注指令（prompt 驱动口径）——正文内联「⚠ X 与 Y 不一致」+
    // 末尾冲突清单；静默取舍禁止。代码层另有 sources 轨迹保证三源并列可见（不静默）。
    '\n\n' +
    (PromptService.getPrompt('ai.chat.agentConflictGuide') || '') +
    // Phase 23（23-03 复验反馈）：命令风格指引——按设备类型选命令风格（服务器→Linux
    // 只读命令、网络设备→show/display）。可编辑 registry 条目，仅选中设备时注入
    //（无目标设备时指引无意义，提示词保持干净）。
    (targetDevices.length > 0 ? '\n\n' + PromptService.getPrompt('ai.chat.cmdStyle') : '') +
    mcpInjection

  const fullMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ]
  // 28-04：分档预取注入段只进 user-role 消息（结果绝不进 system prompt，T-22-08），
  // KB/EXP 命中内容属不可信文本，注入前经 sanitizeUntrusted 截断清洗（T-28-04-03）。
  if (!tierRetrieval.demoMode && tierRetrieval.promptSection) {
    // 28-06 R6 增强 b：注入头部带来源归因指令（引用库内容必须标注《标题》）
    fullMessages.push({
      role: 'user',
      content: `[系统预取·分档上下文]\n${sourceAttributionNote()}${sanitizeUntrusted(tierRetrieval.promptSection, 8000)}`,
    })
  }

  const aiReply = await callAI(config, fullMessages, signal)

  // 28-06 R3 缺陷（主根因）：首答混合标记判定前置——首答含 [CMD]（命中可执行设备，含
  // 简写模糊匹配）或 [MCP_TOOL_CALL] 时**跳过**循环外 KB/EXP 二段式，直接进统一 agent
  // 循环（循环内 KB/EXP 步自会执行检索，D-01/D-03 四类标记统一循环）。此前二段式先消费
  // [KB_SEARCH] → 二次 LLM 问答通常不再输出 [CMD] → 首答命令标记静默蒸发（AI 把「发起
  // 意图」脑补成「已执行」）。无 CMD/MCP 的纯 KB/EXP 问答轮保持二段式既有语义不回归。
  const firstReplyEntersLoop = replyEntersAgentLoop(aiReply, targetDevices)
  // 28-06 R3（兜底防线数据源）：首答原始 [CMD] 块——二段式/循环未消费时用于未执行回注
  const firstReplyCmdBlocks = firstReplyEntersLoop ? [] : parseCmdBlocks(aiReply)

  // Check for KB_SEARCH tool call
  const kbSearchMatch = aiReply.match(/\[KB_SEARCH\](.*?)\[\/KB_SEARCH\]/s)
  let kbReferences: Array<{ docTitle: string; chunkTitle: string; docId: string }> = []
  // 28-04：分档预取 kb 引用并入（docId+chunkTitle 去重）
  mergeKbRefs(kbReferences, tierInjected
    .filter((i) => i.kind === 'kb')
    .map((i) => ({ docTitle: i.title.split(' / ')[0] ?? i.title, chunkTitle: i.title.split(' / ')[1] ?? '', docId: String(i.sourceId ?? '') })))
  let finalAiReply = aiReply
  // WR-02/WR-05 fix（Phase 23 code-review）：KB/EXP 回注轮收敛到共享累积上下文——
  // 后续二段式（EXP/qOnly 重试）与 MCP 循环 loopCtx.fullMessages 都以此为基底，
  // 模型不再丢失已注入的文档/经验上下文。
  const extraContext: Array<{ role: string; content: string }> = []

  // ---- 28-06 R8：agentState 提前创建（二段式 KB/EXP 分支之前）----
  // 此前 state 在二段式之后才创建，导致循环外二段式检索（AI 主动 [KB_SEARCH]/[EXP_SEARCH]
  // 的真实检索路径）既无步骤卡、也不入 sources 轨迹（收尾补查会重复检索同一源）。
  // 提前后：二段式检索同样生成步骤卡（无前缀=AI 主动）+ sources 记录（审计表路径⑤）。
  const agentState = createAgentLoopState()
  // 28-05（D-08 步骤级推送）：注入 emitStep——步骤轨迹经 ctx.emitToolResult 以 tool_result
  // 扩展载荷（stepIndex/actionType/stepStatus）推送 renderer 步骤卡。agentState 随
  // pendingBatches 按引用携带，confirm 续跑推送不断链。emitToolResult 缺席（无窗口）零推送。
  // Phase 31（31-02，FIX-02 D-01）：包装 spread 注入 chat 作用域 sessionId（与下方
  // agentLoopCtx 组装 `sessionId: sessionId || null` 同源）——步骤卡载荷可标识归属会话。
  agentState.emitStep = emitToolResult
    ? (s) => emitToolResult({ ...agentStepToToolResultPayload(s), ...(sessionId ? { sessionId } : {}) })
    : undefined
  // 28-04：分档预取命中即入 sources 轨迹（代码层溯源，D-09——预取是真实检索而非模型自述）
  for (const inj of tierInjected) {
    agentState.sources.push({ kind: inj.kind, title: inj.title, refId: inj.sourceId ?? undefined })
  }
  // 28-06 R6 增强 a：分档预取生成步骤卡（过程可见）——按预取实际发生顺序（exp 先于 kb，
  // 与 retrieveForTier 执行序一致）每源一张，状态直接 done；硬顶按 state.rounds 计数，
  // 预取步不占步数 N。目录清单注入（R4）同样给卡（query 标「目录清单」）。
  if (!tierRetrieval.demoMode) {
    for (const kind of ['exp', 'kb'] as const) {
      if (!tierRetrieval.plan.includes(kind)) continue
      const hits = tierInjected.filter((x) => x.kind === kind)
      const isCatalog = hits.some((x) => x.title.includes('目录清单'))
      const libName = kind === 'exp' ? '经验库' : '知识库'
      const summary = isCatalog
        ? `${libName}目录清单已注入`
        : hits.length > 0
          ? `命中 ${hits.length} 条：${hits.map((h) => h.title).join('；')}`
          : '未命中'
      pushTaggedRetrievalStep(agentState, kind, isCatalog ? `${libName}目录清单` : userMessage, summary, 'prefetched')
    }
  }

  if (!firstReplyEntersLoop && kbSearchMatch) {
    const searchQuery = kbSearchMatch[1].trim()
    // 28-06 R8：二段式 KB 检索是真实检索路径——入 ai_exec_logs 审计（与循环内 runKbSearchStep
    // 同构 kb:query，只读无确认门）+ 步骤卡 + sources 轨迹（收尾补查不再重复检索已查源）。
    try {
      createLog({
        deviceId: '', deviceName: '', command: `kb:query ${sanitizeUntrusted(searchQuery, 200)}`,
        status: 'executed', mode: execMode,
        aiReason: sanitizeUntrusted(searchQuery, 500), promptText: '', aiResponse: '',
      })
    } catch { /* 审计失败不阻断检索（aiExecLogger 异常降级） */ }
    try {
      const searchResults = (await kbSearch(searchQuery, deviceIds, 5)).rows
      // 28-06 R8：检索步骤卡（无前缀=AI 主动打标检索），命中/未命中如实
      pushTaggedRetrievalStep(agentState, 'kb', searchQuery,
        searchResults && searchResults.length > 0
          ? `命中 ${searchResults.length} 条：${searchResults.map((r: any) => `${r.document?.title ?? '文档'} / ${r.title || '无标题'}`).join('；')}`
          : '知识库未命中')
      if (searchResults.length > 0) {
        // Build context from search results, replacing [图片N] with descriptions
        // Phase 28（28-03）：抽取为 buildKbRoundContext——chat() 首答回复分支与
        // runAgentLoop 循环内 KB 动作分支（WR-05 解除）共用同一构造，避免两处漂移。
        const { contextText: kbContext, references: kbRefs } = buildKbRoundContext(searchResults)
        mergeKbRefs(kbReferences, kbRefs)
        // 28-06 R8：kb 命中入 sources 轨迹（D-09——二段式检索是代码层可溯源的真实检索）
        agentState.sources.push(...kbRefs.map((r) => ({ kind: 'kb' as const, title: `${r.docTitle} / ${r.chunkTitle}`, refId: r.docId })))

        // Feed results back to AI for final answer（WR-02：回注轮入共享 extraContext）
        extraContext.push({ role: 'assistant', content: aiReply })
        extraContext.push({
          role: 'user',
          // 28-06 R6 增强 b：回注头部带来源归因指令（引用文档内容必须标注《标题》）
          content: `${sourceAttributionNote()}以下是知识库检索到的相关文档片段（关键词: "${searchQuery}"）：\n\n${kbContext}\n\n请基于以上文档内容回答用户的问题。如果文档中没有相关信息，请说明。回答中不要包含 [KB_SEARCH] 标记。`,
        })
        finalAiReply = await callAI(config, [...fullMessages, ...extraContext], signal)
      } else {
        // No results found — let AI know
        extraContext.push({ role: 'assistant', content: aiReply })
        extraContext.push({ role: 'user', content: `知识库中未找到与"${searchQuery}"相关的文档。请基于你已有的知识回答，并说明知识库中暂无相关文档。回答中不要包含 [KB_SEARCH] 标记。` })
        finalAiReply = await callAI(config, [...fullMessages, ...extraContext], signal)
      }
    } catch {
      // 28-06 R8：检索失败同样落步骤卡（failed）——真实尝试过的检索过程可见
      pushTaggedRetrievalStep(agentState, 'kb', searchQuery, '知识库检索失败', undefined, 'failed')
      // KB search failed — strip the tag and use original reply
      finalAiReply = aiReply.replace(/\[KB_SEARCH\].*?\[\/KB_SEARCH\]/gs, '').trim()
    }
  }

  // ---- Phase 23（23-02，D-06/D-10）：[EXP_SEARCH] 经验库标记协议（与 KB_SEARCH 同构）----
  // 循环外单次二段式（planner 裁决）：不并入 runMcpToolLoop、不计 mcp_max_rounds。
  // 检索执行体 = retrieveForAnswer（编排骨架不变，仅调用时机改为 AI 主动打标）；
  // 结果只回注 **user-role** 消息（绝不进 system prompt，T-23-05），回注文本经
  // sanitizeUntrusted 清洗截断（T-23-05）；query 仅作检索关键词（T-23-04）。
  const expSearchMatch = finalAiReply.match(/\[EXP_SEARCH\](.*?)\[\/EXP_SEARCH\]/s)
  if (!firstReplyEntersLoop && expSearchMatch) {
    const expQuery = sanitizeUntrusted(expSearchMatch[1].trim(), 500)
    // 28-06 R8：二段式 EXP 检索同样入审计（exp:query）+ 步骤卡 + sources（与 KB 分支同构）
    try {
      createLog({
        deviceId: '', deviceName: '', command: `exp:query ${expQuery}`,
        status: 'executed', mode: execMode,
        aiReason: expQuery, promptText: '', aiResponse: '',
      })
    } catch { /* 审计失败不阻断检索（aiExecLogger 异常降级） */ }
    try {
      const retrieval = await retrieveForAnswer({ userMessage: expQuery, deviceIds })
      pushTaggedRetrievalStep(agentState, 'exp', expQuery,
        retrieval.injected && retrieval.injected.length > 0
          ? `命中 ${retrieval.injected.length} 条：${retrieval.injected.map((e: any) => e.title).join('；')}`
          : '经验库未命中')
      if (retrieval.injected.length > 0) {
        agentState.sources.push(...retrieval.injected.map((e: any) => ({ kind: 'exp' as const, title: e.title, refId: e.exp_id })))
        const expContext = buildExpContextText(retrieval.injected, !!(deviceIds && deviceIds.length > 0))
        // expReferences 溯源产出（原自动预取段迁移至此，payload 结构不变，D-08；
        // 28-04：与分档预取引用合并去重）
        mergeExpRefs(expReferences, retrieval.injected.map((e) => ({
          exp_id: e.exp_id,
          title: e.title,
          source_session_id: e.source_session_id ?? null,
          unsupported: e.unsupported,
        })))
        // WR-02 fix：assistant 轮用改写后的最终回复（KB 命中时 finalAiReply 是基于
        // KB 回注的第二次回复），KB 轮消息已在共享 extraContext 中——历史自洽。
        const followUpMessages = [
          ...fullMessages,
          ...extraContext,
          { role: 'assistant', content: finalAiReply },
          {
            role: 'user',
            content: `${sourceAttributionNote()}以下是经验库中检索到的相关经验（关键词: "${expQuery}"）：\n\n${expContext}\n\n请参考以上经验回答用户的问题，回答中引用经验内容时须按开头归因要求标注来源。如果经验中没有相关信息，请说明。回答中不要包含 [EXP_SEARCH] 标记。`,
          },
        ]
        finalAiReply = await callAI(config, followUpMessages, signal)
      } else {
        // 未命中回注说明（无 expReferences 空卡片）
        const followUpMessages = [
          ...fullMessages,
          ...extraContext,
          { role: 'assistant', content: finalAiReply },
          { role: 'user', content: `经验库中未找到与"${expQuery}"相关的经验。请基于你已有的知识回答，并说明经验库中暂无相关经验。回答中不要包含 [EXP_SEARCH] 标记。` },
        ]
        finalAiReply = await callAI(config, followUpMessages, signal)
      }
    } catch {
      // 28-06 R8：检索失败同样落步骤卡（failed）——真实尝试过的检索过程可见
      pushTaggedRetrievalStep(agentState, 'exp', expQuery, '经验库检索失败', undefined, 'failed')
      // 检索失败 — strip 标记降级（照 KB catch 形态）
      finalAiReply = finalAiReply.replace(/\[EXP_SEARCH\].*?\[\/EXP_SEARCH\]/gs, '').trim()
    }
  }

  // WR-03 fix：二次回复 fail-safe 剥离残留 [EXP_SEARCH]/[KB_SEARCH] 标记（提示词
  // 约束非强制，模型不服从时死标记不得漏进 saveChatMessage/用户气泡）。
  // 28-06 R3：首答直进 agent 循环时**不剥离**——[KB_SEARCH]/[EXP_SEARCH] 标记留给
  // 循环内检索步消费（剥离即静默丢弃检索意图，同轮 [CMD] 蒸发缺陷的同族路径）；
  // 循环收尾自带 stripAllAgentMarkers 兜底，死标记不会漏进气泡。
  if (!firstReplyEntersLoop) finalAiReply = stripExpKbSearchMarkers(finalAiReply)

  // ---- Phase 22（22-03）MCP 工具调用分支（[MCP_TOOL_CALL] 文本标记协议）----
  // 解析 fail-closed（T-22-09）：畸形/未知 server/未知工具不入执行；
  // 三档确认映射（MCS-02/D-04）：classifyBatch 全 execute → 整批直执；任一 confirm →
  // 复用 confirm_required 协议整批弹窗（confirm 档总闸压制 per-tool）。
  // Phase 28（28-03，D-01）：统一 agent 循环上下文 + 对象化状态——四类标记共享
  // （runAgentLoop）；confirm 挂起批次按引用携带续跑（Pitfall 1/Pitfall 2 修复）。
  // 上下文以 KB/EXP 回注轮为基底（WR-05 fix 语义保留：不丢已注入的文档/经验上下文）。
  const agentLoopCtx: McpLoopCtx = {
    fullMessages: [...fullMessages, ...extraContext],
    config,
    execMode: execMode as ExecMode,
    deviceNames: targetDevices.map((d) => d.name),
    mcpContexts,
    emitToolResult,
    sessionId: sessionId || null,
    expReferences,
    targetDevices,
    deviceIds,
    kbReferences: kbReferences,
    tier,
    userMessage,
    signal,
  }
  // 28-06 R8：agentState 创建/emitStep 注入/预取 sources+步骤卡已提前到二段式 KB/EXP
  // 分支之前（循环外二段式检索同享步骤卡与 sources 轨迹），此处不再重复创建。
  // 28-04（AGENT-03）：收尾证据补查一次性标志（多出口只补查一次）
  let evidenceBackfilled = false

  // 28-06 真机验收缺陷 ①（根因修复）：循环入口不再挂死在 MCP 绑定上——首答 [CMD]
  // 命中可执行设备或含 [MCP_TOOL_CALL] 标记即进统一循环（CONTEXT D-01/D-03），未绑
  // MCP 的设备同样获得步骤卡/硬顶/重试/循环续跑；无 mcp 上下文时 [MCP_TOOL_CALL]
  // 标记由循环内 parseMcpToolCalls fail-closed 分诊（无有效调用 → strip 收尾，不执行
  // 任何工具，零 NPE）。仅问答/不存在设备的 [CMD] 留给下方旧单轮路径（23-03 白名单
  // 防御语义不回归），首答无标记时旧路径保持兜底不变。
  if (mcpContexts.length > 0 || replyEntersAgentLoop(finalAiReply, targetDevices)) {
    // Phase 28（28-03）：runMcpToolLoop 已泛化为 runAgentLoop——四类标记统一有界循环
    // （任一标记自动延续，D-03）；MCP 分类/确认/守卫语义不变（mcp 分支一行不改）。
    const res = await runAgentLoop(agentLoopCtx, agentState, finalAiReply)
    if (res.kind === 'confirm_required') {
      saveChatMessage('assistant', `等待确认 ${res.count} 个操作...`, null, sessionId)
      return res.payload
    }
    finalAiReply = res.reply
    // WR-06 语义升级（Phase 28）：循环收尾回复中的 [CMD] 已在循环内按既有安全链处理
    // （此前 strip+提示的降级路径由统一循环取代）；无标记时下方常规路径完成落库与
    // kb+exp references 合并（IN-06 语义保留）。
  }

  // Bug B（生产实测，出口兜底）：mcpContexts 为空（未选设备 / 配置禁用 / 绑定缺失）时
  // 上方 MCP 分支整体跳过——历史会话中的标记样例可能诱导模型输出畸形
  // [MCP_TOOL_CALL] 自然语言载荷标记，此前无任何出口 strip，标记原文直接漏进气泡。
  // 此处无条件 fail-safe 剥离（上下文非空时 loop 收尾回复已不含标记，此为幂等兜底）。
  finalAiReply = stripMcpMarkers(finalAiReply)

  // Extract [CMD:device]...[/CMD] or [CMD]...[/CMD] blocks
  const cmdRegex = /\[CMD(?::([^\]]+))?\](.*?)\[\/CMD\]/g
  const commands: Array<{ deviceName: string; cmd: string }> = []
  let match: RegExpExecArray | null
  while ((match = cmdRegex.exec(finalAiReply)) !== null) {
    const deviceName = (match[1] || '').trim()
    const cmd = match[2].trim()
    commands.push({ deviceName, cmd })
  }

  // T-20-04 fail-closed（Phase 20 PMT-04 / Success Criteria 5）：
  // 用户改坏 ai.chat.systemPrompt（override）可能导致 AI 输出畸形命令结构（未闭合 [CMD] 标签 /
  // 空命令体）。confirm 模式下解析失败不进入执行路径、也不静默当作"无命令"处理，而是回落输出
  // 与下方 confirm_required 同型的人工确认结构（携带原始回复供 UI 展示）——
  // 宁可多一次人工确认，绝不因解析失败漏确认或误执行。auto 模式维持既有行为不变。
  if (targetDevices.length > 0 && execMode === 'confirm' && isMalformedCommandReply(finalAiReply, commands)) {
    const batchId = uuidv4()
    // 注册空命令批次：确认/拒绝均无害（confirmCommand 空命令守卫直接返回说明，不触发 LLM 追问）
    pendingBatches.set(batchId, {
      commands: [],
      rejectedCommands: [],
      fullMessages,
      aiReply: finalAiReply,
      config,
      deviceNames: targetDevices.map((d) => d.name),
      sessionId: sessionId || null,
      createdAt: Date.now(),
      expReferences,
    })
    const failClosedResponse = JSON.stringify({
      type: 'confirm_required',
      execId: batchId,
      commands: [],
      rejectedCommands: [
        { command: '（回复命令结构解析失败）', reason: 'AI 回复命令标记解析失败（fail-closed），未提取到可执行命令；请检查提示词配置后重试' },
      ],
      aiExplanation: finalAiReply,
    })
    saveChatMessage('assistant', '回复命令结构解析失败（fail-closed），等待人工确认...', null, sessionId)
    return failClosedResponse
  }

  // ---- Phase 23（23-03，D-04）：[CMD] 白名单防御（fail-closed）----
  // 命令标记的目标设备必须可执行（isDeviceExecutable：hasSSH||hasTelnet；capabilities 缺失
  // 按不可执行）。仅问答设备命中 → 标记无效：全量被拒时回注「该设备无执行通道」说明重试一次
  //（照 invalidPrompted 一次性标志模式），再犯 strip 标记收尾；混选时命令作用于可执行子集、
  // 被拒标记转 rejectedCommands 显式回传（D-05 非整单拒绝）。不存在设备名走既有拒绝路径不变。
  const qOnlyRejections: Array<{ deviceName: string; cmd: string; reason: string }> = []
  if (targetDevices.length > 0 && commands.length > 0) {
    let qOnlyPrompted = false
    const resolveTarget = (deviceName: string): any => resolveTargetDevice(deviceName, targetDevices)
    for (;;) {
      const blocked: Array<{ deviceName: string; cmd: string; dev?: any }> = []
      const pass: Array<{ deviceName: string; cmd: string }> = []
      for (const c of commands) {
        const dev = resolveTarget(c.deviceName)
        if (dev && !isDeviceExecutable(dev)) {
          blocked.push({ deviceName: String(dev.name), cmd: c.cmd, dev })
        } else {
          pass.push(c)
        }
      }
      if (blocked.length === 0) break
      if (pass.length > 0 || qOnlyPrompted) {
        // 混选（D-05）：可执行子集继续走既有安全链路；被拒标记显式回传（29.1-06：
        // MCP-only 设备拒绝文案指向 MCP 工具，真·无通道保持原文案）。
        // 顽固再犯（pass 为空）：strip 标记收尾，命令不进执行/确认流。
        for (const b of blocked) {
          qOnlyRejections.push({ deviceName: b.deviceName, cmd: b.cmd, reason: cmdChannelRejectReason(b.dev, '，命令未执行') })
        }
        if (pass.length === 0) {
          finalAiReply = finalAiReply
            .replace(/\[CMD(?::[^\]]*)?\][\s\S]*?\[\/CMD\]/g, '')
            .replace(/\[CMD(?::[^\]]*)?\][^\n]*\n?/g, '')
            .replace(/\[\/CMD\]/g, '')
            .trim()
        }
        commands.length = 0
        commands.push(...pass)
        break
      }
      qOnlyPrompted = true
      // 29.1-06：回注重试提示按能力分组——MCP-only 设备指向 MCP 工具（不出现「仅可问答」
      // 矛盾语义），真·无通道设备保持 Phase 23 原提示（fail-closed 不回退）。
      const mcpBlockedNames = [...new Set(blocked.filter((b) => b.dev?.capabilities?.hasMcp === true).map((b) => b.deviceName))]
      const qOnlyBlockedNames = [...new Set(blocked.filter((b) => b.dev?.capabilities?.hasMcp !== true).map((b) => b.deviceName))]
      const retryParts: string[] = []
      if (mcpBlockedNames.length > 0) {
        retryParts.push(`以下 [CMD] 命令标记指向的设备无 SSH/Telnet 命令通道，已被系统拦截未执行：${mcpBlockedNames.join('、')}。这些设备的查询与操作请通过其绑定的 MCP 工具完成，不要再对其输出 [CMD] 命令标记。`)
      }
      if (qOnlyBlockedNames.length > 0) {
        retryParts.push(`以下 [CMD] 命令标记指向的设备无命令执行通道（仅可问答），已被系统拦截未执行：${qOnlyBlockedNames.join('、')}。请直接回答用户问题，或仅对有执行通道的设备输出 [CMD] 命令标记；不要再对无命令执行通道的设备输出 [CMD] 标记。`)
      }
      finalAiReply = stripExpKbSearchMarkers(await callAI(config, [
        ...fullMessages,
        ...extraContext,
        { role: 'assistant', content: finalAiReply },
        {
          role: 'user',
          content: retryParts.join(''),
        },
      ], signal))
      commands.length = 0
      const reParse = /\[CMD(?::([^\]]+))?\](.*?)\[\/CMD\]/g
      let m2: RegExpExecArray | null
      while ((m2 = reParse.exec(finalAiReply)) !== null) {
        commands.push({ deviceName: (m2[1] || '').trim(), cmd: m2[2].trim() })
      }
    }
  }

  // No commands or no devices — just return the reply
  if (commands.length === 0 || targetDevices.length === 0) {
    // 28-04（AGENT-03）：收尾证据校验——必查源缺席自动补查一次（多出口只补一次）
    if (!evidenceBackfilled) {
      evidenceBackfilled = true
      finalAiReply = await runEvidenceBackfill(agentLoopCtx, agentState, tier, finalAiReply)
    }
    // 28-06 R3（兜底防线）：首答 [CMD] 未被任何路径执行时显式回注未执行提示
    finalAiReply += buildDroppedCmdNotice(firstReplyCmdBlocks, qOnlyRejections, targetDevices, agentState)
    // 28-04（D-07）：agent 轨迹 meta 加密落 chat_history.meta_enc（encField 红线）
    saveChatMessage('assistant', finalAiReply, null, sessionId, buildAgentMeta(agentState, tier))
    // 28-04（AGENT-05）：统一 payload 组装——既有 kb_answer/exp_answer 契约保留 + meta 附带；
    // 有轨迹无引用 → agent_answer（Phase 11 WR-01 合并语义由 wrapAgentFinalPayload 内同构保留）
    return wrapAgentFinalPayload(finalAiReply, { kbReferences, expReferences }, agentState, tier)
  }

  // Collect all commands with safety check
  const allowedCommands: Array<{
    logId: string
    deviceId: string
    deviceName: string
    command: string
    guardHits?: GuardHit[]
  }> = []
  const rejectedCommands: Array<{ deviceName: string; cmd: string; reason: string }> = []
  // Phase 27：对话设备集投影（GUARD-01 基准，含明文 IP 由本层注入，Pitfall 7）
  const guardConversationSet = targetDevices.map((d) => toGuardRef(d))

  for (const { deviceName, cmd } of commands) {
    // 28-06 R3：目标解析改用 resolveTargetDevice（精确优先 + 简写模糊命中，与循环内同源）
    const targetDevice = resolveTargetDevice(deviceName, targetDevices)
    if (deviceName && !targetDevice) {
      rejectedCommands.push({ deviceName, cmd, reason: `未找到指定设备: ${deviceName}` })
      continue
    }

    const safety = isCommandAllowed(cmd, whitelist)
    // Phase 27（GUARD-01/02，主插入点）：isCommandAllowed 通过后 privilegeGuard.checkCommand。
    // 命中 → 无论 confirm/auto 均挂起（D-06 单点收敛），status 强制 pending、guardHits 落审计。
    const guardHits = safety.allowed ? guardCheckCommand(cmd, targetDevice, guardConversationSet) : []
    const logId = createLog({
      deviceId: targetDevice.id,
      deviceName: targetDevice.name,
      command: cmd,
      status: safety.allowed ? (guardHits.length > 0 || execMode !== 'auto' ? 'pending' : 'approved') : 'rejected',
      mode: execMode,
      // WR-06 fix：审计留痕用最终改写后回复（命令解析基于 finalAiReply，二者同源），
      // 不用带 [EXP_SEARCH]/[KB_SEARCH] 原文的第一次中间态。
      aiReason: finalAiReply.substring(0, 500),
      promptText: JSON.stringify(fullMessages, null, 2),
      aiResponse: finalAiReply,
      guardHits: guardHits.length > 0 ? guardHits : undefined,
    })

    if (!safety.allowed) {
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

  // D-04 白名单被拒标记并入拒绝清单（confirm UI / 拒绝说明 / auto 结果回注统一可见）
  rejectedCommands.push(...qOnlyRejections)

  // No allowed commands — return AI reply + rejection notices
  if (allowedCommands.length === 0) {
    const rejectionText = rejectedCommands.map((r) => `命令 [${r.deviceName}] ${r.cmd} 被拒绝: ${r.reason}`).join('\n')
    // WR-04 fix：用最终改写后回复（EXP 回注/qOnly 重试版本，已 strip 标记），不用
    // 原始 aiReply（含 [EXP_SEARCH]/[CMD] 原文中间态）；并补齐 references 包装——
    // 该路径不再断流（与其余三条返回路径同构）。
    if (!evidenceBackfilled) {
      evidenceBackfilled = true
      finalAiReply = await runEvidenceBackfill(agentLoopCtx, agentState, tier, finalAiReply)
    }
    const fullReplyAfterBackfill = finalAiReply + '\n\n' + rejectionText
    saveChatMessage('assistant', fullReplyAfterBackfill, null, sessionId, buildAgentMeta(agentState, tier))
    return wrapAgentFinalPayload(fullReplyAfterBackfill, { kbReferences, expReferences }, agentState, tier)
  }

  // Confirm mode（或 guard 命中，D-06：auto 模式命中也打断）: store batch and wait for approval
  // Phase 27 checkpoint：聚合 guard 命中时同步收集 hit ↔ allowedCommands（即 payload commands）索引映射
  const allGuardHits: GuardHit[] = []
  const hitCommandIndexes: number[] = []
  allowedCommands.forEach((c, idx) => {
    for (const h of c.guardHits ?? []) {
      allGuardHits.push(h)
      hitCommandIndexes.push(idx)
    }
  })
  if (execMode === 'confirm' || allGuardHits.length > 0) {
    const batchId = uuidv4()
    const guardInfo = allGuardHits.length > 0
      ? { expectedTarget: targetDevices.map((d) => d.name).join('、'), hits: allGuardHits, hitCommandIndexes }
      : undefined
    pendingBatches.set(batchId, {
      commands: allowedCommands,
      rejectedCommands,
      fullMessages,
      // WR-06 fix：批次与弹窗解释用最终改写后回复（qOnly 重试/EXP 回注后的版本，
      // 已 strip 标记）——confirmCommand 兜底分析同源受益。
      aiReply: finalAiReply,
      config,
      deviceNames: targetDevices.map((d) => d.name),
      sessionId: sessionId || null,
      createdAt: Date.now(),
      expReferences,
      // Phase 27：guard 命中信息挂批次（单弹窗聚合，Pitfall 5）+ 命中 logId 清单（T-27-11）
      guardInfo,
      guardLogIds: allGuardHits.length > 0
        ? allowedCommands.filter((c) => (c.guardHits ?? []).length > 0).map((c) => c.logId)
        : undefined,
      // Phase 28（28-03，Pitfall 2 主路径修复）：CMD 确认批次携带 agent 循环状态，
      // confirmCommand 确认后经 runAgentLoop 续跑（confirm 是默认 exec_mode，不补即断头）。
      agentLoop: { loopCtx: agentLoopCtx, agentState },
    })

    const confirmResponse = JSON.stringify({
      type: 'confirm_required',
      execId: batchId,
      commands: allowedCommands.map((c) => ({ deviceName: c.deviceName, command: c.command })),
      rejectedCommands: rejectedCommands.map((r) => ({ command: r.cmd, reason: r.reason })),
      aiExplanation: finalAiReply,
      // Phase 27（Pitfall 5）：越权命中信息并入既有 payload，同一批次同一弹窗
      guardInfo,
    })
    saveChatMessage('assistant', `等待确认 ${allowedCommands.length} 条命令...`, null, sessionId)
    return confirmResponse
  }

  // Auto mode: execute all commands — group by device for batch execution
  const cmdResults: Array<{ deviceName: string; cmd: string; output: string; status: string }> = []

  const autoGroups = new Map<string, Array<{ logId: string; deviceName: string; command: string }>>()
  for (const cmd of allowedCommands) {
    if (!autoGroups.has(cmd.deviceId)) autoGroups.set(cmd.deviceId, [])
    autoGroups.get(cmd.deviceId)!.push({ logId: cmd.logId, deviceName: cmd.deviceName, command: cmd.command })
  }

  for (const [deviceId, cmds] of autoGroups) {
    const device = getDeviceByIdInternal(deviceId)
    if (!device) continue
    try {
      const execResults = await executeCommandsOnDevice(device, cmds.map(c => c.command), {
        conversationSet: guardConversationSet,
      })
      for (let i = 0; i < cmds.length; i++) {
        const r = execResults[i]
        // 28-04：直执路径同样入 steps/sources 轨迹（D-09 代码层溯源，meta_enc/agent_answer 消费）
        const step = pushAgentStep(agentState, 'cmd', { deviceName: cmds[i].deviceName, command: cmds[i].command })
        if (r && r.success) {
          updateLogStatus(cmds[i].logId, 'executed')
          step.outputSummary = sanitizeUntrusted(r.output || '', 200)
          settleAgentStep(step, 'done', agentState)
          pushDeviceSource(agentState, cmds[i].deviceName, deviceId)
          cmdResults.push({
            deviceName: cmds[i].deviceName, cmd: r.command,
            output: (r.output || '').trim() ? r.output : '（命令已执行成功，但设备未返回任何输出文本；如需该数据请重试或换命令）',
            status: 'executed',
          })
        } else {
          updateLogStatus(cmds[i].logId, 'failed')
          step.outputSummary = sanitizeUntrusted(r?.output || '执行失败', 200)
          settleAgentStep(step, 'failed', agentState)
          cmdResults.push({ deviceName: cmds[i].deviceName, cmd: cmds[i].command, output: r?.output || '执行失败', status: 'failed' })
        }
      }
    } catch (err: any) {
      for (const cmd of cmds) {
        updateLogStatus(cmd.logId, 'failed')
        settleAgentStep(pushAgentStep(agentState, 'cmd', {
          deviceName: cmd.deviceName, command: cmd.command, outputSummary: sanitizeUntrusted(`执行失败: ${err.message}`, 200),
        }), 'failed', agentState)
        cmdResults.push({ deviceName: cmd.deviceName, cmd: cmd.command, output: `执行失败: ${err.message}`, status: 'failed' })
      }
    }
  }

  // Add rejected commands to results
  for (const r of rejectedCommands) {
    cmdResults.push({ deviceName: r.deviceName, cmd: r.cmd, output: `命令被拒绝: ${r.reason}`, status: 'rejected' })
  }

  // Send results back to AI for final analysis
  const resultsText = cmdResults
    .map((r) => `设备: ${r.deviceName}\n命令: ${r.cmd}\n状态: ${r.status}\n输出:\n${r.output}`)
    .join('\n\n')

  const deviceNamesStr = targetDevices.map((d) => d.name).join(', ')

  // Phase 28（28-03，D-03）：auto 执行结果经统一 agent 循环回注续跑——追评回复仍含
  // 四类标记任一即自动进循环（此前单次追评即断头）；无标记时循环立即 final 收尾，
  // 行为与既有单次追评一致（回注消息文案沿用既有 CMD 结果格式）。
  let agentRes: McpLoopResult
  try {
    const nextReply = await agentAppendRoundAndCall(
      agentLoopCtx, agentState, finalAiReply, cmdResultsUserMessage(deviceNamesStr, resultsText)
    )
    agentRes = await runAgentLoop(agentLoopCtx, agentState, nextReply)
  } catch (err) {
    // 28-04（D-06）：用户停止 → 立即中止不总结（在途步骤定格 interrupted）
    if (err instanceof ChatInterruptedError) agentRes = agentInterruptedFinal(agentState)
    else throw err
  }
  if (agentRes.kind === 'confirm_required') {
    // 循环后续轮命中 confirm 门（guard 命中打断，D-06）→ 挂起弹窗等待用户确认
    saveChatMessage('assistant', `等待确认 ${agentRes.count} 个操作...`, null, sessionId)
    return agentRes.payload
  }

  // Bug B 同源出口兜底：命令执行追评回复可能夹带畸形 MCP 标记（历史标记样例诱导），
  // 此前无 strip 直进气泡——统一 fail-safe 剥离（exp/kb 残留标记同此处理）
  // 28-04（AGENT-03）：出口前收尾证据校验补查（一次）
  if (!evidenceBackfilled) {
    evidenceBackfilled = true
    agentRes = { ...agentRes, reply: await runEvidenceBackfill(agentLoopCtx, agentState, tier, agentRes.reply) }
  }
  const finalReply = stripMcpMarkers(stripExpKbSearchMarkers(agentRes.reply))

  saveChatMessage('assistant', finalReply, null, sessionId, buildAgentMeta(agentState, tier))

  // Phase 11 UAT fix 语义保留（auto 命令路径返来源列表）+ 28-04 agent_answer/meta 统一组装
  return wrapAgentFinalPayload(finalReply, { kbReferences, expReferences }, agentState, tier)
}

// ---------- Phase 28（28-04，AGENT-05）：ai:cancelChat 取消注册表 ----------
// webContentsId → AbortController：按窗口隔离，只取消自己会话的对话（T-28-04-01，
// 取消请求经 secure IPC 鉴权后按 sender.webContentsId 定位，他人窗口不可误取消）。
export const cancelChatControllers = new Map<number, AbortController>()

/** main 侧 ai:chat 调用前注册（T-28-04-05：chat() 结束由 finishChatCancel 清理防泄漏） */
export function registerChatCancel(webContentsId: number): AbortController {
  const controller = new AbortController()
  cancelChatControllers.set(webContentsId, controller)
  return controller
}

/** chat() finally 清理——只清理自己注册的 controller（并发/旧条目不可误删） */
export function finishChatCancel(webContentsId: number, controller: AbortController): void {
  if (cancelChatControllers.get(webContentsId) === controller) {
    cancelChatControllers.delete(webContentsId)
  }
}

/** ai:cancelChat 动作：abort 该窗口进行中的对话（无进行中对话显式回误不抛错） */
export function cancelChatForWebContents(webContentsId: number): { success: boolean; error?: string } {
  const controller = cancelChatControllers.get(webContentsId)
  if (!controller) return { success: false, error: '当前窗口没有进行中的 AI 对话' }
  controller.abort()
  cancelChatControllers.delete(webContentsId)
  return { success: true }
}

// ---------- Re-export getLogs ----------

export { getLogs as getAiLogs }
