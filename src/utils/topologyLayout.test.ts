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

describe('spreadLayout 星型分层放射（26-04 再工）', () => {
  const RING_GAP = LAYOUT_SPACING
  const TAU = Math.PI * 2

  function centerPt(p: { x: number; y: number }) {
    return { x: p.x + W / 2, y: p.y + H / 2 }
  }
  function centroidOf(nodes: LNode[]) {
    return {
      x: nodes.reduce((s, n) => s + n.x + (n.width ?? W) / 2, 0) / nodes.length,
      y: nodes.reduce((s, n) => s + n.y + (n.height ?? H) / 2, 0) / nodes.length,
    }
  }
  function angleAt(p: { x: number; y: number }, c: { x: number; y: number }) {
    const q = centerPt(p)
    return Math.atan2(q.y - c.y, q.x - c.x)
  }
  function angleDiff(a: number, b: number) {
    let d = a - b
    while (d > Math.PI) d -= TAU
    while (d < -Math.PI) d += TAU
    return d
  }

  // 核心双层拓扑：core（核心）— sw1/sw2（接入交换机）— t1..t4（终端，度=1 叶子）
  const twoTierNodes: LNode[] = [
    { id: 'core', x: 300, y: 200 },
    { id: 'sw1', x: 320, y: 210 },
    { id: 'sw2', x: 280, y: 190 },
    { id: 't1', x: 330, y: 215 },
    { id: 't2', x: 325, y: 205 },
    { id: 't3', x: 275, y: 195 },
    { id: 't4', x: 285, y: 185 },
  ]
  const twoTierEdges = [
    { source: 'core', target: 'sw1' },
    { source: 'core', target: 'sw2' },
    { source: 'sw1', target: 't1' },
    { source: 'sw1', target: 't2' },
    { source: 'sw2', target: 't3' },
    { source: 'sw2', target: 't4' },
  ]

  it('auto：剔除叶子后核心胜出为根并居中（接入交换机不抢中心，用户痛点）', () => {
    const r = spreadLayout(twoTierNodes, twoTierEdges)
    expect(r.size).toBe(7)
    const c = centroidOf(twoTierNodes)
    const pc = centerPt(r.get('core')!)
    expect(Math.hypot(pc.x - c.x, pc.y - c.y)).toBeLessThan(1)
    // 接入交换机在第 1 层环上（半径 ≈ RING_GAP）
    for (const sw of ['sw1', 'sw2']) {
      const q = centerPt(r.get(sw)!)
      expect(Math.abs(Math.hypot(q.x - c.x, q.y - c.y) - RING_GAP)).toBeLessThan(1)
    }
    // 终端挂在上游接入交换机的角度扇区（±40° 容差）
    for (const [leaf, up] of [
      ['t1', 'sw1'],
      ['t2', 'sw1'],
      ['t3', 'sw2'],
      ['t4', 'sw2'],
    ] as const) {
      const d = Math.abs(angleDiff(angleAt(r.get(leaf)!, c), angleAt(r.get(up)!, c)))
      expect(d).toBeLessThan((40 * Math.PI) / 180 + 1e-9)
    }
  })

  it('auto：同层节点均匀分布且两两不重叠（防重叠红线）', () => {
    const nodes: LNode[] = [
      { id: 'core', x: 0, y: 0 },
      { id: 'sw1', x: 10, y: 10 },
      { id: 'sw2', x: 20, y: 5 },
      { id: 'sw3', x: 5, y: 20 },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `t${i + 1}`, x: 15 + i * 3, y: 25 + i * 2 })),
    ]
    const edges = [
      { source: 'core', target: 'sw1' },
      { source: 'core', target: 'sw2' },
      { source: 'core', target: 'sw3' },
      ...Array.from({ length: 9 }, (_, i) => ({ source: `sw${(i % 3) + 1}`, target: `t${i + 1}` })),
    ]
    const r = spreadLayout(nodes, edges)
    const c = centroidOf(nodes)
    // 第 1 层 3 台交换机均匀角度（相邻角差 ≈ 2π/3）
    const angles = ['sw1', 'sw2', 'sw3']
      .map((id) => angleAt(r.get(id)!, c))
      .sort((a, b) => a - b)
    const gaps = [angles[1] - angles[0], angles[2] - angles[1], angles[0] + TAU - angles[2]]
    for (const g of gaps) expect(Math.abs(g - TAU / 3)).toBeLessThan(1e-6)
    // 全图两两包围盒不相交
    const list = nodes.map((n) => toRect(r.get(n.id)!))
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        expect(rectsOverlap(list[i], list[j])).toBe(false)
      }
    }
  })

  it('center（选 1 台）：以该设备为根，根落点 = 原位置', () => {
    const nodes: LNode[] = [
      { id: 'x', x: 0, y: 0 },
      { id: 'y', x: 500, y: 50 },
      { id: 'z', x: 900, y: 100 },
    ]
    const edges = [
      { source: 'x', target: 'y' },
      { source: 'y', target: 'z' },
    ]
    const r = spreadLayout(nodes, edges, { centerId: 'z' })
    expect(r.get('z')).toEqual({ x: 900, y: 100 })
    const rc = centerPt(r.get('z')!)
    const yc = centerPt(r.get('y')!)
    expect(Math.abs(Math.hypot(yc.x - rc.x, yc.y - rc.y) - RING_GAP)).toBeLessThan(1)
  })

  it('selection（选多台）：仅整理选中集，结果只含选中 id 且选中集两两不重叠', () => {
    const nodes: LNode[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 30, y: 10 },
      { id: 'c', x: 60, y: 20 },
      { id: 'd', x: 1000, y: 1000 },
    ]
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
    ]
    const r = spreadLayout(nodes, edges, { subset: ['a', 'b', 'c'] })
    expect([...r.keys()].sort()).toEqual(['a', 'b', 'c'])
    const list = ['a', 'b', 'c'].map((id) => toRect(r.get(id)!))
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        expect(rectsOverlap(list[i], list[j])).toBe(false)
      }
    }
  })

  it('确定性：同输入两次调用结果全等', () => {
    const r1 = [...spreadLayout(twoTierNodes, twoTierEdges).entries()]
    const r2 = [...spreadLayout(twoTierNodes, twoTierEdges).entries()]
    expect(r1).toEqual(r2)
  })

  it('边界：空数组 / 单节点 / 全叶子（单连线）不崩且不重叠', () => {
    expect(spreadLayout([], []).size).toBe(0)
    expect(spreadLayout([{ id: 'a', x: 1, y: 2 }], []).get('a')).toEqual({ x: 1, y: 2 })
    const pair = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 5, y: 5 },
    ]
    const r = spreadLayout(pair, [{ source: 'a', target: 'b' }])
    expect(rectsOverlap(toRect(r.get('a')!), toRect(r.get('b')!))).toBe(false)
  })

  it('不修改输入数组（不可变性）', () => {
    const snapshot = JSON.parse(JSON.stringify({ n: twoTierNodes, e: twoTierEdges }))
    spreadLayout(twoTierNodes, twoTierEdges)
    expect({ n: twoTierNodes, e: twoTierEdges }).toEqual(snapshot)
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
