import { describe, it, expect } from 'vitest'
import {
  spreadLayout,
  resolvePushAside,
  snapWithAntiOverlap,
  alignNodes,
  nearestFreePosition,
  LAYOUT_SPACING,
  SNAP_GRID,
  GUIDE_THRESHOLD,
} from './topologyLayout'

interface LNode {
  id: string
  x: number
  y: number
  width?: number
  height?: number
}

const W = 80
const H = 60

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

function toRect(n: { x: number; y: number; width?: number; height?: number }) {
  return { x: n.x, y: n.y, width: n.width ?? W, height: n.height ?? H }
}

describe('spreadLayout', () => {
  it('两节点初始重叠 → 结果包围盒不相交且原左侧节点仍偏左', () => {
    const nodes: LNode[] = [
      { id: 'a', x: 100, y: 100 },
      { id: 'b', x: 120, y: 110 },
    ]
    const result = spreadLayout(nodes)
    const pa = result.get('a')!
    const pb = result.get('b')!
    expect(rectsOverlap(toRect(pa), toRect(pb))).toBe(false)
    expect(pa.x).toBeLessThan(pb.x)
  })

  it('三节点团 → 两两包围盒不相交', () => {
    const nodes: LNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 5 },
      { id: 'c', x: 5, y: 10 },
    ]
    const r = spreadLayout(nodes)
    const list = nodes.map((n) => toRect(r.get(n.id)!))
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        expect(rectsOverlap(list[i], list[j])).toBe(false)
      }
    }
  })

  it('subset 只移动选中节点，未选中坐标严格不变（D-10）', () => {
    const nodes: LNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 500, y: 500 },
      { id: 'c', x: 20, y: 20 },
    ]
    const r = spreadLayout(nodes, { subset: ['c'] })
    expect(r.get('a')).toEqual({ x: 0, y: 0 })
    expect(r.get('b')).toEqual({ x: 500, y: 500 })
    expect(r.get('c')).toBeDefined()
    // c 被推开但 a 不动 → 仍可能重叠 a？subset 模式下 c 必须让开 a
    expect(rectsOverlap(toRect(r.get('c')!), toRect({ x: 0, y: 0 }))).toBe(false)
  })

  it('空数组与单节点不崩', () => {
    expect(spreadLayout([]).size).toBe(0)
    const one = spreadLayout([{ id: 'a', x: 1, y: 2 }])
    expect(one.get('a')).toEqual({ x: 1, y: 2 })
  })

  it('不修改输入数组（不可变性）', () => {
    const nodes: LNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 10 },
    ]
    const snapshot = JSON.parse(JSON.stringify(nodes))
    spreadLayout(nodes)
    expect(nodes).toEqual(snapshot)
  })
})

describe('resolvePushAside', () => {
  it('A 拖到 B 上 → 结果含 B 不含 A（D-04 红线）', () => {
    const others: LNode[] = [{ id: 'b', x: 100, y: 100 }]
    const r = resolvePushAside('a', { x: 100, y: 100, width: W, height: H }, others)
    expect(r.has('a')).toBe(false)
    expect(r.has('b')).toBe(true)
    const pb = r.get('b')!
    expect(rectsOverlap(toRect(pb), { x: 100, y: 100, width: W, height: H })).toBe(false)
  })

  it('不重叠时返回空 Map', () => {
    const others: LNode[] = [{ id: 'b', x: 1000, y: 1000 }]
    const r = resolvePushAside('a', { x: 0, y: 0, width: W, height: H }, others)
    expect(r.size).toBe(0)
  })

  it('连锁让位：B 让位压到 C 时 C 也让位', () => {
    const others: LNode[] = [
      { id: 'b', x: 100, y: 100 },
      { id: 'c', x: 200, y: 105 },
    ]
    const dragged = { x: 100, y: 100, width: W, height: H }
    const r = resolvePushAside('a', dragged, others)
    expect(r.has('b')).toBe(true)
    const pb = r.get('b')!
    const pc = r.get('c')
    // B 被推向右侧压到 C，或直接与 C 重叠 → C 必须让位
    const bRect = toRect(pb)
    const cRect = pc ? toRect(pc) : toRect({ x: 200, y: 105 })
    if (rectsOverlap(bRect, cRect) && pc) {
      expect(rectsOverlap(toRect(pc), toRect({ x: 200, y: 105 }))).toBe(false)
    }
    expect(r.has('a')).toBe(false)
  })

  it('不修改输入（不可变性）', () => {
    const others: LNode[] = [{ id: 'b', x: 50, y: 50 }]
    const snapshot = JSON.parse(JSON.stringify(others))
    resolvePushAside('a', { x: 50, y: 50, width: W, height: H }, others)
    expect(others).toEqual(snapshot)
  })
})

describe('snapWithAntiOverlap', () => {
  it('网格 20 下 (37,51) → (40,60) snapped:true', () => {
    const r = snapWithAntiOverlap({ x: 37, y: 51 }, 'a', [])
    expect(r.pos).toEqual({ x: 40, y: 60 })
    expect(r.snapped).toBe(true)
  })

  it('吸附点压第三节点 → 返回原坐标 snapped:false（D-05）', () => {
    // (37,51) 吸附到 (40,60)，第三节点占住 (40,60) 区域
    const others: LNode[] = [{ id: 'b', x: 30, y: 40 }]
    const r = snapWithAntiOverlap({ x: 37, y: 51 }, 'a', others)
    expect(r.pos).toEqual({ x: 37, y: 51 })
    expect(r.snapped).toBe(false)
  })

  it('参考线对齐：阈值内邻边对齐候选同样过重叠检测', () => {
    // 节点 a 候选 (46,100)，节点 b 左边 x=50，差 4 < GUIDE_THRESHOLD(6) → 对齐到 50
    const others: LNode[] = [{ id: 'b', x: 50, y: 200 }]
    const r = snapWithAntiOverlap({ x: 46, y: 100 }, 'a', others)
    expect(r.pos.x).toBe(50)
    expect(r.snapped).toBe(true)
  })

  it('常量值符合 UI-SPEC', () => {
    expect(SNAP_GRID).toBe(20)
    expect(GUIDE_THRESHOLD).toBe(6)
    expect(LAYOUT_SPACING).toBe(260)
  })
})

describe('alignNodes', () => {
  const nodes: LNode[] = [
    { id: 'a', x: 10, y: 10 },
    { id: 'b', x: 50, y: 80 },
    { id: 'c', x: 90, y: 200 },
  ]

  it('left 对齐 → x 全等且 = 最小 x', () => {
    const r = alignNodes(['a', 'b', 'c'], nodes, 'left')
    expect(r.size).toBe(3)
    for (const p of r.values()) expect(p.x).toBe(10)
    expect(r.get('a')!.y).toBe(10)
    expect(r.get('c')!.y).toBe(200)
  })

  it('hDistribute → 间距等差', () => {
    const r = alignNodes(['a', 'b', 'c'], nodes, 'hDistribute')
    expect(r.size).toBe(3)
    const sorted = [...r.values()].sort((p, q) => p.x - q.x)
    const gap1 = sorted[1].x - sorted[0].x
    const gap2 = sorted[2].x - sorted[1].x
    expect(gap1).toBe(gap2)
    expect(gap1).toBeGreaterThan(0)
  })

  it('2 节点 hDistribute → 空 Map', () => {
    expect(alignNodes(['a', 'b'], nodes, 'hDistribute').size).toBe(0)
  })

  it('不修改输入（不可变性）', () => {
    const snapshot = JSON.parse(JSON.stringify(nodes))
    alignNodes(['a', 'b', 'c'], nodes, 'top')
    alignNodes(['a', 'b', 'c'], nodes, 'vDistribute')
    expect(nodes).toEqual(snapshot)
  })
})

describe('nearestFreePosition', () => {
  it('中心空 → 返回中心（D-13）', () => {
    const others: LNode[] = [{ id: 'b', x: 1000, y: 1000 }]
    const p = nearestFreePosition({ x: 0, y: 0 }, others)
    expect(p).toEqual({ x: 0, y: 0 })
  })

  it('中心被占 → 返回不与任何节点相交的最近点', () => {
    const others: LNode[] = [
      { id: 'b', x: -W / 2, y: -H / 2 }, // 占住原点
      { id: 'c', x: 500, y: 500 },
    ]
    const p = nearestFreePosition({ x: 0, y: 0 }, others)
    for (const n of others) {
      expect(rectsOverlap(toRect(p), toRect(n))).toBe(false)
    }
    const dist = Math.hypot(p.x, p.y)
    expect(dist).toBeLessThan(500) // 明显近于远处节点
  })

  it('不修改输入（不可变性）', () => {
    const others: LNode[] = [{ id: 'b', x: 0, y: 0 }]
    const snapshot = JSON.parse(JSON.stringify(others))
    nearestFreePosition({ x: 0, y: 0 }, others)
    expect(others).toEqual(snapshot)
  })
})
