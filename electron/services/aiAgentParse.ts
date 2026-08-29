/**
 * aiAgentParse —— key 归一 + agent marker 文本解析纯函数群。
 *
 * Phase 32（D-02 / D-05）：机械搬移自 ai.ts agent 段（拆分前原始行号 :1299-1380），
 * 函数体逐字零改动，保持源函数形态（不转静态类）。
 *
 * 域职责（D-02 概念三分之「文本解析」）：privilegeGuard 式可单测纯函数群——
 * 熔断/重试 key 归一（normalizeAgentKey）、MCP/EXP/KB/CMD 协议标记剥离与回注提示
 * 常量。零依赖（无 MK、不读 DB、不 import 任何 ai 域模块），被 aiAgentLoop（值）
 * 与 ai.ts chat 段 / barrel re-export 单向引用。
 */

/**
 * 参数归一化（熔断/重试 key）：JSON 对象按 key 排序后 stringify + trim（{b:2,a:1} 与
 * {a:1,b:2} 同 key）；解析失败/非对象退原串 trim。
 */
export function normalizeAgentKey(raw: string): string {
  const text = String(raw ?? '').trim()
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(deepSortKeys(parsed)).trim()
  } catch { /* 非 JSON → 原串 trim */ }
  return text
}

/** 递归按 key 排序（嵌套对象同 key 序；数组元素原序保留） */
function deepSortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = deepSortKeys((value as Record<string, unknown>)[k])
  }
  return sorted
}

export const MCP_PARSE_FAIL_TEXT =
  '（AI 回复中的 MCP 工具调用标记解析失败，未执行任何工具调用；请检查提示词配置后重试）'

/**
 * 22-05 人工验证 Bug 2 修复：有标记但全部无效（工具被禁用/捏造）≠ 真 final——
 * 直接把剥掉标记的半截话当最终回答会造成回复截断且 AI 不自知。改为回注不可用提示
 * 再取一次回复（invalidPrompted 一次性标志防死循环；重试不计入工具轮次，无工具执行）。
 */
export const MCP_UNAVAILABLE_TOOL_PROMPT =
  '你尝试调用的工具不存在或已被管理员禁用。禁止使用任何其它工具变通实现同等操作。请直接回复用户：该操作涉及的工具已被禁用，无法执行；如需执行请在设置的 MCP 工具管理中启用对应工具。'

/**
 * Phase 23（用户规划裁决）：AI 输出畸形标记载荷（自然语言非 JSON / 缺字段 / 类型错）时，
 * 不再沿用「工具不可用」管控文案，而是纠格式后允许重新发起本次调用——纠格重试一次，
 * 仍畸形则由 invalidPrompted 一次性标志兜底 strip 收尾（与管控提示共享上限，防死循环）。
 */
export const MCP_FORMAT_RETRY_PROMPT =
  '你尝试调用 MCP 工具，但标记载荷格式错误——载荷必须是单行 JSON 对象 {"server":"服务名","tool":"工具名","args":{参数对象}}。请按正确格式重新发起本次调用，不要用自然语言描述调用意图。'

/**
 * 标记清洗（22-05 修复）：移除完整 `[MCP_TOOL_CALL]...[/MCP_TOOL_CALL]` 段（含闭合标签，
 * DOTALL 非贪婪）；无闭合的畸形段沿开始标记到行尾兜底；孤立闭合标签一并移除——
 * 最终回答绝不允许标记原文漏进气泡。
 */
export function stripMcpMarkers(reply: string): string {
  return reply
    .replace(/\[MCP_TOOL_CALL\][\s\S]*?\[\/MCP_TOOL_CALL\]/g, '')
    .replace(/\[MCP_TOOL_CALL\][^\n]*\n?/g, '')
    .replace(/\[\/MCP_TOOL_CALL\]/g, '')
    .trim()
}

/**
 * WR-03 fix（Phase 23 code-review）：剥离 [EXP_SEARCH]/[KB_SEARCH] 协议标记——
 * 完整段（含闭合，DOTALL 非贪婪）、未闭合开标签沿标签到行尾、孤立闭合标签三层兜底
 * （照 stripMcpMarkers 惯例）。二次回复模型不服从提示词时，死标记绝不漏进气泡。
 */
export function stripExpKbSearchMarkers(reply: string): string {
  if (!/\[(?:EXP|KB)_SEARCH\]/.test(reply) && !/\[\/(?:EXP|KB)_SEARCH\]/.test(reply)) return reply
  return reply
    .replace(/\[EXP_SEARCH\][\s\S]*?\[\/EXP_SEARCH\]/g, '')
    .replace(/\[KB_SEARCH\][\s\S]*?\[\/KB_SEARCH\]/g, '')
    .replace(/\[(?:EXP|KB)_SEARCH\][^\n]*\n?/g, '')
    .replace(/\[\/(?:EXP|KB)_SEARCH\]/g, '')
    .trim()
}

/**
 * WR-06 fix（Phase 22 code-review）：剥离 [CMD(:设备名)]...[/CMD] 协议标记（保留
 * 命令体文本供参考），未闭合开标签沿标签到行尾一并移除、孤立闭合标签移除；
 * 命中标记时追加「未执行的命令请求」提示——混合协议收尾回复绝不带标记原文进气泡。
 */
export function stripCmdMarkersWithNotice(reply: string): string {
  if (!/\[CMD/.test(reply)) return reply
  const stripped = reply
    .replace(/\[CMD(?::[^\]]*)?\]([\s\S]*?)\[\/CMD\]/g, (_m, cmd: string) => cmd.trim())
    .replace(/\[CMD(?::[^\]]*)?\][^\n]*\n?/g, '')
    .replace(/\[\/CMD\]/g, '')
    .trim()
  return `${stripped}\n\n（注意：以上回复中包含未执行的命令请求，已剥离命令标记；如需执行请重新发送指令让 AI 单独输出命令。）`
}
