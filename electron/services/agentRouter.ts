/**
 * Phase 28（AGENT-01）：用户问题四档归一化分类唯一实现。
 *
 * 纯函数：不依赖 MK、不读 DB、不调 LLM——规则关键词匹配（中文运维语料），
 * 分类结果只决定「查什么」（agentRetrieval 分档预取组合），不决定「免确认什么」
 * （执行/确认策略永远由 commandSafety + privilegeGuard + execMode 决定，架构红线 T-28-02-01）。
 * 零命中 / 空串 / 纯空白 → 默认知识问答档（最保守：只查 KB/EXP，不注入设备上下文提示）。
 * 优先级：troubleshoot > inspection > configQuery（故障处置时效性最高，巡检次之）。
 */

/** 四档类型（UI/检索编排共用契约）。 */
export type AgentTier = 'troubleshoot' | 'configQuery' | 'knowledge' | 'inspection'

/** 档位中文名（UI-SPEC 文案，分档标签直接使用）。 */
export const TIER_LABELS: Record<AgentTier, string> = {
  troubleshoot: '故障排查',
  configQuery: '配置查询',
  knowledge: '知识问答',
  inspection: '巡检执行',
}

/** 故障排查关键词（RESEARCH 矩阵草案：故障/不通/告警/down/断/慢/排查/丢包）。 */
const TROUBLESHOOT_KEYWORDS = new Set([
  '故障', '不通', '告警', 'down', '断', '慢', '排查', '丢包', '宕机', '掉线', '异常',
])

/** 配置查询关键词（配置/config/怎么配/vlan/路由表）。 */
const CONFIG_QUERY_KEYWORDS = new Set([
  '配置', 'config', '怎么配', '如何配', 'vlan', '路由表', '怎样配',
])

/** 巡检执行关键词（巡检/检查一遍/批量看状态）。 */
const INSPECTION_KEYWORDS = new Set([
  '巡检', '检查一遍', '批量看状态', '巡一遍', '健康检查',
])

/**
 * 28-06 真机验收缺陷 ③：查询动词 × 设备状态目标 复合规则——「查询/查看这个设备的
 * 版本/接口信息」类中文运维语料（单设备状态查询）此前零命中落 knowledge 默认档。
 * 命中 → inspection（巡检执行：注入设备上下文提示 AI 可 [CMD] 查实时状态，28-02
 * 四档语义）；配置类目标（配置/vlan/路由）不在此列——由 CONFIG_QUERY_KEYWORDS
 * 平面命中保持 configQuery（「查询配置」语义即配置查询）。
 */
const INSPECTION_QUERY_VERBS = new Set(['查询', '查看', '查一下', '看一下', '看下', '获取', 'show'])
const INSPECTION_QUERY_TARGETS = new Set([
  '版本', 'version', '接口', 'interface', '状态', '内存', 'cpu', '温度', '电源', '风扇', 'mac地址', 'arp',
])

/**
 * 四档分类：输入 toLowerCase().trim() 归一后按优先级匹配（troubleshoot > inspection > configQuery），
 * 零命中返回 'knowledge'（fail-closed 最保守默认档）。
 */
export function classifyTier(userMessage: string): AgentTier {
  const normalized = (userMessage ?? '').toLowerCase().trim()
  if (!normalized) return 'knowledge'

  for (const kw of TROUBLESHOOT_KEYWORDS) if (normalized.includes(kw)) return 'troubleshoot'
  for (const kw of INSPECTION_KEYWORDS) if (normalized.includes(kw)) return 'inspection'
  // 28-06 缺陷 ③：查询动词 + 设备状态目标 复合命中 → inspection（先于 configQuery——
  // 「查看接口状态」是设备实时状态查询而非配置语义）
  const hasQueryVerb = [...INSPECTION_QUERY_VERBS].some((v) => normalized.includes(v))
  if (hasQueryVerb && [...INSPECTION_QUERY_TARGETS].some((t) => normalized.includes(t))) {
    return 'inspection'
  }
  for (const kw of CONFIG_QUERY_KEYWORDS) if (normalized.includes(kw)) return 'configQuery'
  return 'knowledge'
}
