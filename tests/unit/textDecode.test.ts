import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { decodeDeviceBuffer } from '../../electron/utils/textDecode'

describe('textDecode.decodeDeviceBuffer', () => {
  it('decodes utf-8 buffer directly (utf-8 first path)', () => {
    const buf = Buffer.from('正常中文utf8')
    expect(decodeDeviceBuffer(buf)).toBe('正常中文utf8')
  })

  it('falls back to gbk when utf-8 decode contains replacement char', () => {
    const buf = iconv.encode('中文gbk内容', 'gbk')
    expect(decodeDeviceBuffer(buf)).toBe('中文gbk内容')
  })

  it('decodes plain ascii buffer unchanged', () => {
    const buf = Buffer.from('plain ascii')
    expect(decodeDeviceBuffer(buf)).toBe('plain ascii')
  })
})
