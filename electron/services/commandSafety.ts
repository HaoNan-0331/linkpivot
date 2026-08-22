/**
 * 命令白名单安全校验（基于命令语义而非纯文本模式）。
 *
 * 校验规则：
 * 1. 拒绝多命令注入：命令含分隔符 (\r \n ; & ` $() && ||) 直接拒绝，
 *    杜绝 "display version\nreboot" / "show int; reload" 类绕过。
 *    （单独的 | 不拦截：华为/Cisco 设备 CLI 用 `| include` 做只读过滤。）
 * 2. 黑名单作用于命令首词：首词命中变更 / 配置视图入口命令直接拒绝，
 *    不再对整条文本扫描，避免误杀 "display ... | include reset" 等只读命令。
 * 3. 白名单作用于命令首词：首词必须严格相等匹配白名单（非前缀子串），其余一律拒绝。
 */

// 多命令 / shell 注入分隔符
const SEPARATOR_RE = /[\r\n;&`]|\$\(|&&|\|\|/

// 变更与进入配置视图的命令首词（黑名单，优先于白名单）
const BLOCKED_FIRST_WORDS = new Set([
  'shutdown', 'configure', 'config', 'delete', 'erase', 'reset', 'reboot', 'reload',
  'write', 'save', 'commit', 'undo', 'system-view', 'system', 'interface', 'vlan',
  'acl', 'aaa', 'ospf', 'bgp', 'route-map', 'traffic-filter', 'traffic-policy',
  'password', 'no',
  // WR-01 fix（Phase 23 code-review）：enable（进入特权模式）补入黑名单——system-view
  // 已在列。即使存量库 command_whitelist 仍残留 enable/system-view 种子行，黑名单
  // 优先于白名单匹配，AI 执行通道立即 fail-closed。
  'enable',
])

/**
 * token 化单一来源（Phase 27 T-27-04）：isCommandAllowed 首词判定与 privilegeGuard
 * 标识符扫描共用，物理上禁两套解析器 drift。trim + toLowerCase + 空白折叠 + 空串过滤。
 */
export function tokenizeCommand(command: string): string[] {
  return command.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function isCommandAllowed(
  command: string,
  whitelist: string[]
): { allowed: boolean; reason: string } {
  const tokens = tokenizeCommand(command)
  if (tokens.length === 0) return { allowed: false, reason: '空命令' }
  // 分隔符检测用原始命令文本（token 化会把 \n 等空白折叠掉，注入形态必须先于拆分拦截）
  const cmd = command.trim().toLowerCase()

  // 1. 拒绝多命令注入
  if (SEPARATOR_RE.test(cmd)) {
    return { allowed: false, reason: '命令包含非法分隔符（禁止多命令/注入）' }
  }

  const firstWord = tokens[0]

  // 2. 黑名单首词（变更 / 配置视图入口）
  if (BLOCKED_FIRST_WORDS.has(firstWord)) {
    return { allowed: false, reason: `禁止的变更命令: ${firstWord}` }
  }

  // 3. 白名单首词严格相等匹配
  const wl = whitelist.map((w) => w.trim().toLowerCase()).filter(Boolean)
  for (const prefix of wl) {
    if (firstWord === prefix) {
      return { allowed: true, reason: `匹配白名单: ${prefix}` }
    }
  }

  return { allowed: false, reason: '命令首词不在白名单中' }
}
