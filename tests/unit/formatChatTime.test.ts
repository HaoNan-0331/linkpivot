// Phase 34（34-01，D-07/D-08）：formatChatTime 三档时间格式化行为锁定。
// now 参数注入保证确定性（不依赖真实时钟）；本地时区语义（getHours/getMinutes）。
// vitest plain node 入口（npm test），纯函数断言无 DOM 无 mock。
import { describe, it, expect } from 'vitest'
import { formatChatTime } from '@/components/pages/ai/formatChatTime'

describe('formatChatTime 三档格式（34-UI-SPEC §6.4）', () => {
  it('同天——HH:mm', () => {
    expect(formatChatTime('2026-08-30T07:00:00', new Date('2026-08-30T12:00:00'))).toBe('07:00')
    expect(formatChatTime('2026-08-30T23:59:00', new Date('2026-08-30T00:00:00'))).toBe('23:59')
  })

  it('跨天（同年）——MM-DD HH:mm', () => {
    expect(formatChatTime('2026-08-29T23:00:00', new Date('2026-08-30T12:00:00'))).toBe('08-29 23:00')
    expect(formatChatTime('2026-01-01T00:05:00', new Date('2026-12-31T23:00:00'))).toBe('01-01 00:05')
  })

  it('跨年——YYYY-MM-DD HH:mm', () => {
    expect(formatChatTime('2025-12-31T23:00:00', new Date('2026-08-30T12:00:00'))).toBe('2025-12-31 23:00')
    expect(formatChatTime('2027-01-01T09:01:00', new Date('2026-08-30T12:00:00'))).toBe('2027-01-01 09:01')
  })

  it('DB 空格分隔格式经 replace 兼容（照 ExperienceTab formatTs 先例，本地时区解析）', () => {
    expect(formatChatTime('2026-08-30 07:00:00', new Date('2026-08-30T12:00:00'))).toBe('07:00')
    expect(formatChatTime('2026-08-29 23:00:00', new Date('2026-08-30T12:00:00'))).toBe('08-29 23:00')
  })

  it('缺场 / 不可解析——返回空串（渲染端判空跳过，fail-open 不崩）', () => {
    expect(formatChatTime(undefined, new Date('2026-08-30T12:00:00'))).toBe('')
    expect(formatChatTime('', new Date('2026-08-30T12:00:00'))).toBe('')
    expect(formatChatTime('garbage', new Date('2026-08-30T12:00:00'))).toBe('')
  })
})
