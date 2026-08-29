import { setAiExecLoggerMasterKey } from './aiExecLogger'
import { setAiConfigMasterKey } from './aiConfig'
import { setAiSessionMasterKey } from './aiSession'
import { setAiExecMasterKey } from './aiExec'
import { setAiMcpMasterKey } from './aiMcp'

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

// ---------- Agent loop（Phase 32 / D-01 / D-02 / D-05：agent 有界循环主体与各步骤域已机械
// 搬移至 aiAgentLoop.ts——runAgentLoop/runAgentLoopInner 编排 + runAgentCmdRound 安全链
// （isCommandAllowed → guardCheckCommand → confirm 门 → executeCommandsOnDevice 完整沿用）+
// runKbSearchStep/runExpSearchStep 检索步 + agentInterruptedFinal 中断终态；agentInterruptedFinal/
// runAgentLoop 族及 pushAgentStep/settleAgentStep 等供 aiChat.ts 编排域直连消费（纪律 #7
// tsc 证明加 export），mcpResultsUserMessage/runAgentLoopInner 等纯段内函数保持非 export；
// confirm 批次存储已随 chat 编排域迁 aiChat.ts（aiAgentLoop 直连 './aiChat' 值引用，
// 运行时晚期环，Shared Pattern 6 先例）；此处 re-export 保消费方 import 路径零改动） ----------

export {
  runAgentLoop, agentInterruptedFinal,
  agentAppendRoundAndCall, mcpAppendRoundAndCall, cmdResultsUserMessage,
  pushAgentStep, settleAgentStep, agentStepToToolResultPayload,
  pushTaggedRetrievalStep, sourceAttributionNote, parseCmdBlocks, resolveTargetDevice,
  replyEntersAgentLoop, buildDroppedCmdNotice, buildKbRoundContext, stripAllAgentMarkers,
} from './aiAgentLoop'

// ---------- Chat（Phase 32 / D-01 / D-03 / D-05，P4：chat 编排域已机械搬移至 aiChat.ts——
// chat 主函数（700 行本体不拆段，D-05）+ confirmCommand 确认续跑 + confirm 批次存储
// （含 TTL 清理模块级副作用）+ 取消注册表四函数，经本 re-export 触发 aiChat 模块体加载
// （副作用保活，Shared Pattern 7）；此处 re-export 保消费方 import 路径零改动） ----------

export {
  reconcileGuardLogs, confirmCommand, chat,
  cancelChatControllers, registerChatCancel, finishChatCancel, cancelChatForWebContents,
} from './aiChat'

// ---------- Re-export getLogs ----------

export { getLogs as getAiLogs } from './aiExecLogger'
