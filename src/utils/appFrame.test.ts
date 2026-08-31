import { describe, it, expect } from 'vitest'
import {
  clampDetailsWidth,
  parsePersistedFrame,
  DETAILS_MIN_WIDTH,
  DETAILS_DEFAULT_WIDTH,
  DETAILS_MAX_RATIO,
} from './appFrame'

describe('Phase 35 / UI-07 appFrame 纯函数', () => {
  it('常量值符合 Phase 35 裁定（D-06 / D-02）', () => {
    expect(DETAILS_MIN_WIDTH).toBe(240)
    expect(DETAILS_DEFAULT_WIDTH).toBe(320)
    expect(DETAILS_MAX_RATIO).toBe(0.4)
  })

  describe('clampDetailsWidth（D-06 画布优先边界）', () => {
    it('40% 窗口上限封顶：1920 窗口超宽输入收敛 768', () => {
      expect(clampDetailsWidth(9999, 1920)).toBe(768)
    })

    it('低于下限兜底回 240', () => {
      expect(clampDetailsWidth(100, 800)).toBe(240)
    })

    it('非有限值（NaN）回默认宽 320', () => {
      expect(clampDetailsWidth(NaN, 1920)).toBe(320)
    })

    it('frameWidth 非有限值（NaN/Infinity）同样回退 320——上限计算不产生 NaN 透传（WR-02）', () => {
      // 修前 NaN 上限经 Math.max/Math.min 透传：clampDetailsWidth(400, NaN) 返回 NaN
      // → store/inline style width:NaNpx 塌宽 + persist 序列化 "width":null
      expect(clampDetailsWidth(400, NaN)).toBe(320)
      expect(clampDetailsWidth(400, Number.POSITIVE_INFINITY)).toBe(320)
      expect(clampDetailsWidth(NaN, NaN)).toBe(320)
    })

    it('窗口 500 时 40%=200 < min 240，min 胜（展开永远有意义）', () => {
      expect(clampDetailsWidth(500, 500)).toBe(240)
    })

    it('小数宽度四舍五入取整', () => {
      expect(clampDetailsWidth(700.6, 1920)).toBe(701)
    })

    it('Infinity 输入同样走非有限回退 320', () => {
      expect(clampDetailsWidth(Number.POSITIVE_INFINITY, 1920)).toBe(320)
    })
  })

  describe('parsePersistedFrame（D-07 读盘三重兜底 / Pitfall 7）', () => {
    it('合法载荷原样通过（读盘宽度经 clamp 收敛）', () => {
      expect(parsePersistedFrame('{"width":400,"collapsed":false}', 1920)).toEqual({
        width: 400,
        collapsed: false,
      })
    })

    it('读盘宽度超界经 clamp 收敛——防大屏存盘小屏启动爆版（Pitfall 4）', () => {
      expect(parsePersistedFrame('{"width":9999,"collapsed":false}', 1920)).toEqual({
        width: 768,
        collapsed: false,
      })
    })

    it('腐化 JSON 回默认 { width: 320, collapsed: true }（D-02 默认折叠）', () => {
      expect(parsePersistedFrame('not-json', 1920)).toEqual({
        width: 320,
        collapsed: true,
      })
    })

    it('null 载荷（首次启动无存盘）回默认 { width: 320, collapsed: true }', () => {
      expect(parsePersistedFrame(null, 1920)).toEqual({
        width: 320,
        collapsed: true,
      })
    })

    it('字段类型不符（width:"abc" / collapsed:1）整体回退默认——逐字段 typeof 校验', () => {
      expect(parsePersistedFrame('{"width":"abc","collapsed":1}', 1920)).toEqual({
        width: 320,
        collapsed: true,
      })
    })

    it('载荷非对象形态（JSON 数组）整体回退默认', () => {
      expect(parsePersistedFrame('[1,2,3]', 1920)).toEqual({
        width: 320,
        collapsed: true,
      })
    })
  })
})
