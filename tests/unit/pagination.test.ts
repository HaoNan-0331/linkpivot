import { describe, it, expect } from 'vitest'
import { validateLimit, validateOffset } from '../../electron/utils/pagination'
import type { PaginatedResult } from '../../src/types/pagination'

/**
 * DATA-01 / D-4-4: 共享分页校验 helper 单元测试。
 * 校验模式与 anomalyIpc.ts:7-11 既有 validateLimit 先例一致：
 * Number.isInteger + 范围校验 + 非法/超界 → 落回默认值（非钳到 ceiling）。
 */
describe('validateLimit', () => {
  it('returns defaultValue when limit is undefined', () => {
    expect(validateLimit(undefined, 2000, 50000)).toBe(2000)
  })

  it('passes through legal in-range integer', () => {
    expect(validateLimit(150, 2000, 50000)).toBe(150)
    expect(validateLimit(1, 100, 10000)).toBe(1)
  })

  it('returns defaultValue when limit exceeds maxCeiling (overflow → default, not clamp)', () => {
    expect(validateLimit(999999, 2000, 50000)).toBe(2000)
    expect(validateLimit(50001, 2000, 50000)).toBe(2000)
  })

  it('returns defaultValue when limit < 1 (underflow)', () => {
    expect(validateLimit(0, 2000, 50000)).toBe(2000)
    expect(validateLimit(-5, 2000, 50000)).toBe(2000)
  })

  it('returns defaultValue for non-integer numeric', () => {
    expect(validateLimit(1.5, 2000, 50000)).toBe(2000)
  })

  it('returns defaultValue for non-numeric / malformed', () => {
    expect(validateLimit('abc', 2000, 50000)).toBe(2000)
    expect(validateLimit(null, 2000, 50000)).toBe(2000)
    expect(validateLimit(NaN, 2000, 50000)).toBe(2000)
  })

  it('accepts boundary maxCeiling value exactly', () => {
    expect(validateLimit(50000, 2000, 50000)).toBe(50000)
    expect(validateLimit(10000, 100, 10000)).toBe(10000)
  })
})

describe('validateOffset', () => {
  it('returns 0 when offset is undefined', () => {
    expect(validateOffset(undefined)).toBe(0)
  })

  it('passes through legal non-negative integer', () => {
    expect(validateOffset(50)).toBe(50)
    expect(validateOffset(0)).toBe(0)
  })

  it('returns 0 for negative offset', () => {
    expect(validateOffset(-1)).toBe(0)
  })

  it('returns 0 for non-integer offset', () => {
    expect(validateOffset(1.5)).toBe(0)
  })

  it('returns 0 for non-numeric / malformed', () => {
    expect(validateOffset('abc')).toBe(0)
    expect(validateOffset(null)).toBe(0)
  })
})

describe('PaginatedResult envelope type', () => {
  it('constructs an envelope with rows/total/truncated', () => {
    const env: PaginatedResult<number> = { rows: [1, 2], total: 5, truncated: true }
    expect(env.rows).toHaveLength(2)
    expect(env.total).toBe(5)
    expect(env.truncated).toBe(true)
  })
})
