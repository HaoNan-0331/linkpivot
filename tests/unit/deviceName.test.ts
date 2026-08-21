import { describe, it, expect } from 'vitest'
import { normalizeDeviceName, hashDeviceName } from '../../electron/services/deviceName'

/**
 * Phase 25 Plan 25-01 Task 1 —— 归一化单一来源（ASSET-03 数据层地基）。
 *
 * 绕过案例矩阵（plan behavior 4 条）：
 *   1. 首尾空格 trim：' Core-SW' === 'Core-SW'
 *   2. U+2011 non-breaking hyphen：NFC 归一后与 ASCII '-' 相同
 *   3. 大小写：toLowerCase
 *   4. hashDeviceName：64 位 hex SHA-256、归一化同输入同 hash、空串不 throw
 */
describe('normalizeDeviceName', () => {
  it('首尾空格 trim：与去空格形式一致', () => {
    expect(normalizeDeviceName(' Core-SW')).toBe(normalizeDeviceName('Core-SW'))
    expect(normalizeDeviceName('Core-SW ')).toBe('core-sw')
    expect(normalizeDeviceName('  Core-SW  ')).toBe('core-sw')
  })

  it('U+2011 non-breaking hyphen 归一到 ASCII 连字符（NFC）', () => {
    expect(normalizeDeviceName('Core‑SW')).toBe(normalizeDeviceName('Core-SW'))
  })

  it('大小写归一（toLowerCase）', () => {
    expect(normalizeDeviceName('CORE-SW')).toBe(normalizeDeviceName('core-sw'))
    expect(normalizeDeviceName('Core-SW')).toBe('core-sw')
  })
})

describe('hashDeviceName', () => {
  it('返回 64 位十六进制 SHA-256 字符串', () => {
    const h = hashDeviceName('Core-SW')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('归一化相同输入产出相同 hash（三变体）', () => {
    const base = hashDeviceName('Core-SW')
    expect(hashDeviceName(' Core-SW')).toBe(base)
    expect(hashDeviceName('Core‑SW')).toBe(base)
    expect(hashDeviceName('CORE-SW')).toBe(base)
    expect(hashDeviceName('core-sw')).toBe(base)
  })

  it('空串不 throw，返回确定性 hash', () => {
    expect(() => hashDeviceName('')).not.toThrow()
    expect(hashDeviceName('')).toBe(hashDeviceName(''))
    expect(hashDeviceName('')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('不同归一化名产出不同 hash', () => {
    expect(hashDeviceName('core-sw')).not.toBe(hashDeviceName('core-sw-2'))
  })
})
