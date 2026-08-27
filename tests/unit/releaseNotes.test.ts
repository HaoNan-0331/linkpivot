import { describe, it, expect } from 'vitest'
import { sanitizeReleaseNotes } from '../../src/utils/releaseNotes'

describe('sanitizeReleaseNotes（release notes 清洗纯函数，UPD-01 防注入）', () => {
  it('HTML 标签整段剥离：<script> 载荷消失且输出零 < 字符', () => {
    const out = sanitizeReleaseNotes('<script>alert(1)</script>正文')
    expect(out.includes('<')).toBe(false)
    expect(out.includes('>')).toBe(false)
    expect(out.includes('script')).toBe(false)
    expect(out.includes('正文')).toBe(true)
  })

  it('markdown 链接文本化：javascript: 协议沦为纯文本（零执行面）', () => {
    const out = sanitizeReleaseNotes('[x](javascript:alert(1))')
    expect(out.includes('x')).toBe(true)
    expect(out).toBe('x (javascript:alert(1))')
  })

  it('图片整段消失（正文保留）', () => {
    const out = sanitizeReleaseNotes('前文\n![img](https://evil/x.png)\n后文')
    expect(out.includes('evil')).toBe(false)
    expect(out.includes('x.png')).toBe(false)
    expect(out.includes('前文')).toBe(true)
    expect(out.includes('后文')).toBe(true)
  })

  it('超长输入截断：68KB → 输出 ≤ 65536', () => {
    const big = 'a'.repeat(68 * 1024)
    expect(sanitizeReleaseNotes(big).length).toBeLessThanOrEqual(65536)
  })

  it('截断撕裂标签兜底：中段截断的 <scr 残片也被剥离', () => {
    const out = sanitizeReleaseNotes('<script src="https://evil/x">' + 'b'.repeat(65530))
    expect(out.includes('<')).toBe(false)
    expect(out.includes('>')).toBe(false)
  })

  it('控制字符剥离（\\n 与 \\t 保留）', () => {
    expect(sanitizeReleaseNotes('a\x00\x01b')).toBe('ab')
    expect(sanitizeReleaseNotes('a\nb\tc')).toBe('a\nb\tc')
  })

  it('markdown 标记折叠：标题/加粗/斜体/删除线/列表', () => {
    expect(sanitizeReleaseNotes('# 标题')).toBe('标题')
    expect(sanitizeReleaseNotes('## 二级标题')).toBe('二级标题')
    expect(sanitizeReleaseNotes('**粗**')).toBe('粗')
    expect(sanitizeReleaseNotes('*斜*')).toBe('斜')
    expect(sanitizeReleaseNotes('_下划线_')).toBe('下划线')
    expect(sanitizeReleaseNotes('~~删~~')).toBe('删')
    expect(sanitizeReleaseNotes('- 项')).toBe('• 项')
    expect(sanitizeReleaseNotes('1. 甲')).toBe('• 甲')
  })

  it('代码围栏去围栏留内容', () => {
    const out = sanitizeReleaseNotes('```bash\nping 8.8.8.8\n```')
    expect(out.includes('```')).toBe(false)
    expect(out.includes('ping 8.8.8.8')).toBe(true)
  })

  it('连续 ≥3 空行压缩为 1 空行（2 空行不动）', () => {
    expect(sanitizeReleaseNotes('a\n\n\n\n\nb')).toBe('a\n\nb')
    expect(sanitizeReleaseNotes('a\n\n\nb')).toBe('a\n\n\nb')
  })

  it('空串/全空白输入 → 空串', () => {
    expect(sanitizeReleaseNotes('')).toBe('')
    expect(sanitizeReleaseNotes('   \n\t  ')).toBe('')
  })
})
