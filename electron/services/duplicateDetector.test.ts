import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * duplicateDetector 单测（Phase 8 D-02）。
 * 经 vi.mock('./experienceService') 替换 listExperiences 返回受控 rows，
 * 断言 findExistingForDraft 返回的 summary 含 exp_id/title/content_preview(≤150字)。
 */

const listExperiencesMock = vi.fn()
vi.mock('./experienceService', () => ({
  listExperiences: (...args: any[]) => listExperiencesMock(...args),
  MAX_BATCH: 1000,
}))

import { findExistingForDraft } from './duplicateDetector'

const longContent = 'c'.repeat(200)

describe('findExistingForDraft（D-02 查重）', () => {
  beforeEach(() => {
    listExperiencesMock.mockReset()
  })

  it('有 deviceIds 多设备命中 → 合并去重，content 截到 150 字', () => {
    // d1 返 e1（content 200 字），d2 返 e1（同 id，去重）+ e2
    listExperiencesMock
      .mockReturnValueOnce({
        rows: [{ id: 'e1', title: 't1', content: longContent }],
        total: 1,
        truncated: false,
      })
      .mockReturnValueOnce({
        rows: [
          { id: 'e1', title: 't1', content: 'c2' },
          { id: 'e2', title: 't2', content: 'c3' },
        ],
        total: 2,
        truncated: false,
      })

    const out = findExistingForDraft({ category: 'best_practices', deviceIds: ['d1', 'd2'] })
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ exp_id: 'e1', title: 't1', content_preview: 'c'.repeat(150) })
    expect(out[1]).toEqual({ exp_id: 'e2', title: 't2', content_preview: 'c3' })
    // 调 listExperiences 2 次（每设备一次），都带 includeInvalid:false + MAX_BATCH
    expect(listExperiencesMock).toHaveBeenCalledTimes(2)
    expect(listExperiencesMock).toHaveBeenCalledWith({
      category: 'best_practices',
      deviceId: 'd1',
      includeInvalid: false,
      limit: 1000,
      offset: 0,
    })
  })

  it('deviceIds=[] → 走全库分支，mock 返 3 条 → 3 条 summary', () => {
    listExperiencesMock.mockReturnValue({
      rows: [
        { id: 'a', title: 'ta', content: 'ca' },
        { id: 'b', title: 'tb', content: 'cb' },
        { id: 'c', title: 'tc', content: 'cc' },
      ],
      total: 3,
      truncated: false,
    })

    const out = findExistingForDraft({ category: 'troubleshooting', deviceIds: [] })
    expect(out).toHaveLength(3)
    // 全库分支不传 deviceId
    expect(listExperiencesMock).toHaveBeenCalledWith({
      category: 'troubleshooting',
      includeInvalid: false,
      limit: 1000,
      offset: 0,
    })
    expect(listExperiencesMock).toHaveBeenCalledTimes(1)
  })

  it('deviceIds=undefined → 同空数组分支（全库）', () => {
    listExperiencesMock.mockReturnValue({ rows: [{ id: 'x', title: 'tx', content: 'cx' }], total: 1, truncated: false })
    const out = findExistingForDraft({ category: 'product' })
    expect(out).toHaveLength(1)
    expect(out[0].exp_id).toBe('x')
  })

  it('mock 返空 rows → 返 []', () => {
    listExperiencesMock.mockReturnValue({ rows: [], total: 0, truncated: false })
    const out = findExistingForDraft({ category: 'env', deviceIds: ['d1'] })
    expect(out).toEqual([])
  })

  it('content 长度 < 150 → content_preview 原长不补齐', () => {
    listExperiencesMock.mockReturnValue({ rows: [{ id: 's', title: 'ts', content: 'short' }], total: 1, truncated: false })
    const out = findExistingForDraft({ category: 'best_practices' })
    expect(out[0].content_preview).toBe('short')
  })
})
