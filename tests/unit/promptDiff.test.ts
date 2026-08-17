import { describe, it, expect } from 'vitest'
import { diffInline } from '../../src/components/settings/promptDiff'

describe('diffInline（自研逐词 diff 纯函数）', () => {
  it('相同输入 → 全 same 段', () => {
    const segs = diffInline('你好世界\n第二行', '你好世界\n第二行')
    expect(segs.length).toBeGreaterThanOrEqual(1)
    expect(segs.every((s) => s.type === 'same')).toBe(true)
    expect(segs.map((s) => s.text).join('')).toBe('你好世界\n第二行')
  })

  it('「世界你好」vs「你好世界」→ 含 add 与 remove 段，same 段文本一致', () => {
    const segs = diffInline('世界你好', '你好世界')
    const types = new Set(segs.map((s) => s.type))
    expect(types.has('add')).toBe(true)
    expect(types.has('remove')).toBe(true)
    // same 段拼接后两侧一致（公共子序列「你好」）
    const sameText = segs.filter((s) => s.type === 'same').map((s) => s.text).join('')
    expect(sameText.length).toBeGreaterThan(0)
    expect('世界你好'.includes(sameText)).toBe(true)
    expect('你好世界'.includes(sameText)).toBe(true)
    // 全段拼接 = 新串（add + same）
    expect(segs.filter((s) => s.type !== 'remove').map((s) => s.text).join('')).toBe('你好世界')
    expect(segs.filter((s) => s.type !== 'add').map((s) => s.text).join('')).toBe('世界你好')
  })

  it('空串边界：一侧为空 → 单个 add/remove 段', () => {
    expect(diffInline('', '新增内容')).toEqual([{ type: 'add', text: '新增内容' }])
    expect(diffInline('删除内容', '')).toEqual([{ type: 'remove', text: '删除内容' }])
  })

  it('多行混合：未变行 same、变更行行内红绿', () => {
    const a = '第一行不变\n第二行旧内容\n第三行不变'
    const b = '第一行不变\n第二行新内容\n第三行不变'
    const segs = diffInline(a, b)
    expect(segs.filter((s) => s.type !== 'remove').map((s) => s.text).join('')).toBe(b)
    expect(segs.some((s) => s.type === 'add' && s.text.includes('新'))).toBe(true)
    expect(segs.some((s) => s.type === 'remove' && s.text.includes('旧'))).toBe(true)
    expect(segs.some((s) => s.type === 'same' && s.text.includes('第一行不变'))).toBe(true)
  })
})
