/**
 * untrustedText —— Phase 22（22-03，T-22-08/T-22-10）不可信文本截断清洗纯函数。
 *
 * MCP server 提供的工具描述与工具结果均为不可信文本（可能夹带 prompt injection /
 * 伪造协议载荷）。进入 LLM 上下文（system prompt 注入、user-role 回注）与
 * tool_result 下发前必须经 sanitizeUntrusted：
 *   1. 协议保留字样中和（半角方括号替换为全角）——防工具结果伪造 [MCP_TOOL_CALL]
 *      新调用或 [CONFIRM_REQUIRED] 确认载荷；
 *   2. 截断至 maxLen——超长附「…[已截断至 N 字符]」后缀（aiReason 500 先例同量级）。
 *
 * 纯函数：无副作用、无 DB 依赖。
 */

/** 协议保留字样清单（中和 = 半角 [ ] 替换为全角 ［ ］，语义破坏、内容可读） */
const PROTOCOL_MARKERS = [
  '[MCP_TOOL_CALL]',
  '[CONFIRM_REQUIRED]',
  '[CMD]',
  '[/CMD]',
  '[KB_SEARCH]',
  '[/KB_SEARCH]',
  '[SYSTEM]',
]

/** 中和协议标记：半角括号 → 全角（grep 断言保留字样不再以半角形式出现） */
function neutralizeMarkers(text: string): string {
  let out = text
  for (const marker of PROTOCOL_MARKERS) {
    // 带 [CMD:设备名] 变体的通配处理
    out = out.split(marker).join(marker.replace(/\[/g, '［').replace(/\]/g, '］'))
  }
  out = out.replace(/\[CMD(?::[^\]]*)?\]/g, (m) => m.replace(/[\[\]:]/g, (c) => (c === '[' ? '［' : c === ']' ? '］' : '：')))
  return out
}

/**
 * 不可信文本清洗：先中和协议标记，再截断至 maxLen（超长附截断标记）。
 * 空/非字符串输入返回 ''（安全空值）。
 */
export function sanitizeUntrusted(text: string, maxLen: number): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  const safeLen = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 0
  let neutralized: string
  try {
    neutralized = neutralizeMarkers(text)
  } catch {
    return ''
  }
  if (safeLen === 0 || neutralized.length <= safeLen) return neutralized
  return neutralized.slice(0, safeLen) + `…[已截断至 ${safeLen} 字符]`
}
