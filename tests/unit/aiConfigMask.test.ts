import { describe, it, expect, vi } from 'vitest'

// H-3（v0.3.0 audit）：ai:saveConfig 掩码守卫回归网。
//
// 红线：设置页任意保存不会把 **** 掩码串落库覆盖真实 apiKey/visionApiKey。
// 主进程侧兜住一切掩码回传（不依赖 renderer 行为）。

vi.mock('../../electron/database/connection', () => ({
  getDatabase: () => { throw new Error('aiConfigMask 测试不应触达 DB') },
}))

import { stripMaskedKeys } from '../../electron/services/ai'

describe('H-3 stripMaskedKeys（saveAiConfig 掩码守卫）', () => {
  it('剔除 **** 前缀值的键，保留正常值键', () => {
    const out = stripMaskedKeys({ apiKey: '****abcd', provider: 'openai' })
    expect(out).not.toHaveProperty('apiKey')
    expect(out.provider).toBe('openai')
  })

  it('仅剔掩码键，真实 apiKey 保留（多模态掩码单独剔除）', () => {
    const out = stripMaskedKeys({ apiKey: 'sk-real', visionApiKey: '****ef12' })
    expect(out.apiKey).toBe('sk-real')
    expect(out).not.toHaveProperty('visionApiKey')
  })

  it("null/''/undefined 值的键不剔除（?? 语义交给 merge，守卫只管 **** 前缀）", () => {
    const out = stripMaskedKeys({ apiKey: '', visionBaseUrl: null, visionModel: undefined })
    expect(out).toHaveProperty('apiKey', '')
    expect(out).toHaveProperty('visionBaseUrl', null)
    expect(out).toHaveProperty('visionModel', undefined)
  })
})
