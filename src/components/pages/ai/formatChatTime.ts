/**
 * formatChatTime —— AI 对话时间戳三档格式化纯函数（Phase 34 / 34-01，D-07/D-08）。
 *
 * 三消费方共享（ChatMessageList 用户气泡/助手末尾、ToolResultCard 行尾），
 * 杜绝 ExperienceTab formatTs 式双副本漂移先例。
 *
 * 源出处：src/components/knowledge/ExperienceTab.tsx formatTs——
 * - `ts.replace(' ', 'T')` 双格式兼容（DB 'YYYY-MM-DD HH:mm:ss' localtime 与 ISO 'T'）照抄；
 * - `Number.isNaN(d.getTime())` 降级不崩 + `pad` 闭包照抄；
 * - 降级目标从「返回原值」改为「返回空串」——时间戳槽位缺场不渲染（fail-open，
 *   渲染端判空跳过，34-UI-SPEC §6.4 兜底）。
 *
 * 三档分支（34-UI-SPEC §6.4，本地时区判定）：同天 HH:mm；同年 MM-DD HH:mm；
 * 跨年 YYYY-MM-DD HH:mm。now 参数可注入（测试确定性），默认当前时刻。
 */
export function formatChatTime(createdAt?: string, now: Date = new Date()): string {
  if (!createdAt) return ''
  const d = new Date(createdAt.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
  }
  if (d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
  }
  return hm
}
