/**
 * ai.ts —— AI 域门面 barrel（Phase 32 / D-04）。
 *
 * 全部实逻辑已按域拆至 aiConfig / aiSession / aiClient / aiExec / aiMcp / aiAgentState /
 * aiAgentParse / aiAgentLoop / aiPayload / aiChat 十个模块（Phase 32 P1-P4，D-01/D-02
 * 机械搬移 + 字节一致性 diff 实证）。本文件只做 re-export，保 main.ts 与全部测试的
 * import/mock 路径零改动（test:electron 720|1 / npm test 431 双基线风险最小化）；
 * 对外面 = 拆分前 ai.ts 的 67 个符号，不多不少（Phase 32 纪律 #6——跨文件接线新增的
 * 内部符号不进 barrel）。禁止在此添加任何实现。
 *
 * CONVENTIONS 豁免声明：项目规范「无 barrel files（无 index.ts 桶导出）」——本门面是
 * Phase 32 / D-04 用户显式豁免决策的唯一特例，不构成项目惯例，后续新模块勿仿效。
 */

// ---------- aiConfig（配置域：ai_config CRUD + 掩码 + exec mode + 命令白名单 + setAiMasterKey 终态链式注入） ----------

export {
  setAiMasterKey, getAiConfig, getAiConfigMasked, stripMaskedKeys, saveAiConfig,
  getExecMode, setExecMode, getCommandWhitelist, saveCommandWhitelist,
  type ExecMode,
} from './aiConfig'

// ---------- aiSession（会话域：chat_sessions/chat_history CRUD，_enc 加密读写） ----------

export {
  createSession, listSessions, getSessionMessages, deleteSession,
  updateSessionTitle, getChatHistory, saveChatMessage,
} from './aiSession'

// ---------- aiClient（callAI 域：LLM HTTP client；ChatInterruptedError 单一物理定义在此，re-export 保 main.ts instanceof 身份） ----------

export {
  callAI, ChatInterruptedError, AGENT_INTERRUPTED_NOTICE, callAIWithUsage, estimateTokens,
} from './aiClient'

// ---------- aiExec（执行域：SSH/Telnet 远程执行 + 能力边界 + 设备解密读） ----------

export {
  executeCommandsOnDevice, isDeviceExecutable, isDeviceMcpUsable,
  buildCapabilityBoundary, cmdChannelRejectReason, getDeviceByIdInternal,
} from './aiExec'

// ---------- aiMcp（MCP 域：上下文装配 + 工具调用编排） ----------

export {
  loadPackageSpawnInfo, parseMcpToolCalls, type ToolResultPayload,
} from './aiMcp'

// ---------- aiAgentState（agent 参数与状态构造：四重硬顶 7 常量 + 三参数 get/set + _setAiDbGetter + 类型） ----------

export {
  DEFAULT_AGENT_MAX_ROUNDS, AGENT_MAX_ROUNDS_UPPER_BOUND,
  DEFAULT_AGENT_BURNOUT_COUNT, AGENT_BURNOUT_COUNT_UPPER_BOUND,
  DEFAULT_AGENT_COOLDOWN_SECS, AGENT_COOLDOWN_SECS_LOWER_BOUND, AGENT_COOLDOWN_SECS_UPPER_BOUND,
  _setAiDbGetter,
  getAgentMaxRounds, setAgentMaxRounds, getAgentBurnoutCount, setAgentBurnoutCount,
  getAgentCooldownSecs, setAgentCooldownSecs,
  AGENT_TOKEN_BUDGET, DEFAULT_AGENT_RETRY_BUDGET, createAgentLoopState,
  type AgentStep, type SourceRecord, type AgentLoopState,
} from './aiAgentState'

// ---------- aiAgentParse（key 归一 + marker 文本解析零依赖纯函数群） ----------

export {
  normalizeAgentKey, stripMcpMarkers, stripExpKbSearchMarkers, stripCmdMarkersWithNotice,
} from './aiAgentParse'

// ---------- aiAgentLoop（agent 有界循环主体与各步骤：cmd 安全链 + kb/exp 检索步 + 中断终态） ----------

export { agentInterruptedFinal } from './aiAgentLoop'

// ---------- aiPayload（回复装配域：agent meta + 引用合并 + 证据补查，见模块头 D-03 身份声明） ----------

export { buildAgentMeta, buildExpContextText, isMalformedCommandReply } from './aiPayload'

// ---------- aiChat（chat 编排域：chat 主函数（700 行不拆段）+ confirmCommand 确认续跑 + confirm 批次存储（TTL 副作用）+ 取消注册表） ----------

export {
  reconcileGuardLogs, confirmCommand, chat,
  cancelChatControllers, registerChatCancel, finishChatCancel, cancelChatForWebContents,
} from './aiChat'

// ---------- aiExecLogger（审计日志 re-export，源 :3586 既有形态） ----------

export { getLogs as getAiLogs } from './aiExecLogger'
