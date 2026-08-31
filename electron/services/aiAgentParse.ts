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
 * Phase 37（37-02，D-04）：收尾补查标记 [EXP_BACKFILL]/[KB_BACKFILL] 解析与 strip
 * 落本域（消费方 aiPayload 收尾路径，纯函数域免循环依赖，planner_rulings 2）。
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
 * Phase 37（37-02，D-04）：解析收尾补查标记——AI 在回答末尾输出的
 * `[EXP_BACKFILL]检索词[/EXP_BACKFILL]` / `[KB_BACKFILL]检索词[/KB_BACKFILL]`
 * （沿 [EXP_SEARCH]/[KB_SEARCH] 成对英文大写先例，planner_rulings 1；按源成对
 * 使 AI 可只标补 EXP 不补 KB）。每 kind 只取首个非空标记（提示词「每类最多一次」
 * + 解析层首匹配双保险——补查追加轮有界，T-37-06）；纯解析不做 sanitize
 * （清洗职责在消费方 aiPayload.runEvidenceBackfill，标记体检索词与用户原话同通道）。
 */
export function parseBackfillQueries(reply: string): Array<{ kind: 'exp' | 'kb'; query: string }> {
  const picks: Array<{ kind: 'exp' | 'kb'; query: string; at: number }> = []
  const regexByKind: Array<['exp' | 'kb', RegExp]> = [
    ['exp', /\[EXP_BACKFILL\]([\s\S]*?)\[\/EXP_BACKFILL\]/g],
    ['kb', /\[KB_BACKFILL\]([\s\S]*?)\[\/KB_BACKFILL\]/g],
  ]
  for (const [kind, re] of regexByKind) {
    for (const m of reply.matchAll(re)) {
      const query = m[1].trim()
      if (query) {
        picks.push({ kind, query, at: m.index ?? 0 })
        break
      }
    }
  }
  // 按标记在回复中的出现序返回（多 kind 同现时消费方按序处理）
  return picks.sort((a, b) => a.at - b.at).map(({ kind, query }) => ({ kind, query }))
}

/**
 * Phase 37（37-02，D-04）：剥离 [EXP_BACKFILL]/[KB_BACKFILL] 补查标记——逐字对齐
 * stripExpKbSearchMarkers 三层兜底（完整段含闭合 DOTALL 非贪婪 / 未闭合开标签沿
 * 标签到行尾 / 孤立闭合标签），最终回答绝不漏标记原文进气泡（T-37-07）。
 *
 * ⚠ 生命周期红线（<critical_asymmetry>，与 KB/EXP_SEARCH 相反）：本函数**禁止**加入
 * stripAllAgentMarkers 组合——BACKFILL 标记设计上必须穿过循环收尾存活，由收尾后的
 * runEvidenceBackfill 消费（智能模式 AI 决策补查的标记载体）；若在循环出口剥离，
 * 智能模式标记即死。出口仅限：runEvidenceBackfill 内部全部返回值 + backfill 之后的
 * 终态出口（aiChat 收尾链）。同样禁止在 :374/:812 等 backfill 待消费点前追加。
 */
export function stripBackfillMarkers(reply: string): string {
  if (!/\[(?:EXP|KB)_BACKFILL\]/.test(reply) && !/\[\/(?:EXP|KB)_BACKFILL\]/.test(reply)) return reply
  return reply
    .replace(/\[EXP_BACKFILL\][\s\S]*?\[\/EXP_BACKFILL\]/g, '')
    .replace(/\[KB_BACKFILL\][\s\S]*?\[\/KB_BACKFILL\]/g, '')
    .replace(/\[(?:EXP|KB)_BACKFILL\][^\n]*\n?/g, '')
    .replace(/\[\/(?:EXP|KB)_BACKFILL\]/g, '')
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
