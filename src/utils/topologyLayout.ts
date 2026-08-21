/**
 * Phase 26 / TOPO-01/03/04：拓扑布局纯函数库（26-02）
 *
 * 零 npm 依赖（dagre/elkjs 已移除，算法自研：碰撞分离/迭代松弛）。
 * 所有函数均为纯函数：不依赖 React/DOM/React Flow 实例、不修改输入对象。
 * 坐标语义与 React Flow 一致：(x, y) 为节点包围盒左上角。
 */

export interface Point {
  x: number
  y: number
}

/** 布局计算用最小节点形态（TopologyNode 取 id/position/width/height 即可映射） */
export interface LayoutNode {
  id: string
  x: number
  y: number
  width?: number
  height?: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'hDistribute' | 'vDistribute'

// ---- 模块级常量（值由 UI-SPEC 锁定） ----
/** 散开布局节点中心间距（D-03） */
export const LAYOUT_SPACING = 260
/** 吸附网格（D-11） */
export const SNAP_GRID = 20
/** 参考线对齐阈值（画布坐标） */
export const GUIDE_THRESHOLD = 6
/** 包围盒估算尺寸（供默认碰撞计算，Discretion 可由调用方按节点实际尺寸覆盖） */
export const NODE_WIDTH = 80
export const NODE_HEIGHT = 60
/** 迭代松弛收敛上限（T-26-02-01：DoS 硬顶，超大拓扑有界退出） */
export const MAX_SPREAD_ITERATIONS = 60
/** 推挤连锁深度上限 */
export const MAX_PUSH_CHAIN_DEPTH = 6

interface ResolvedNode {
  id: string
  x: number
  y: number
  width: number
  height: number
}

function resolveNode(n: LayoutNode): ResolvedNode {
  return {
    id: n.id,
    x: n.x,
    y: n.y,
    width: n.width ?? NODE_WIDTH,
    height: n.height ?? NODE_HEIGHT,
  }
}

function rectOf(n: { x: number; y: number; width: number; height: number }): Rect {
  return { x: n.x, y: n.y, width: n.width, height: n.height }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function centerOf(n: { x: number; y: number; width: number; height: number }): Point {
  return { x: n.x + n.width / 2, y: n.y + n.height / 2 }
}

/**
 * 原位散开（D-01/D-02/D-03）：以各节点当前位置为锚，迭代松弛分离重叠/过近节点
 * 至中心间距 ≥ LAYOUT_SPACING。opts.subset 存在时只移动 subset 内节点（D-10：
 * 未选中节点位置严格不变，subset 节点承担全部让位位移）。
 */
export function spreadLayout(
  nodes: LayoutNode[],
  opts?: { subset?: string[] },
): Map<string, Point> {
  const resolved = nodes.map(resolveNode)
  const movable = opts?.subset ? new Set(opts.subset) : null
  const canMove = (id: string) => movable === null || movable.has(id)

  for (let iter = 0; iter < MAX_SPREAD_ITERATIONS; iter++) {
    let anyPushed = false
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const a = resolved[i]
        const b = resolved[j]
        const ca = centerOf(a)
        const cb = centerOf(b)
        let dx = cb.x - ca.x
        let dy = cb.y - ca.y
        let dist = Math.hypot(dx, dy)
        if (dist >= LAYOUT_SPACING) continue
        if (dist === 0) {
          // 中心重合：按 id 序确定方向，保证确定性
          dx = a.id < b.id ? -1 : 1
          dy = 0
          dist = 1
        }
        const gap = LAYOUT_SPACING - dist
        const ux = dx / dist
        const uy = dy / dist
        const aMoves = canMove(a.id)
        const bMoves = canMove(b.id)
        if (aMoves && bMoves) {
          a.x -= (ux * gap) / 2
          a.y -= (uy * gap) / 2
          b.x += (ux * gap) / 2
          b.y += (uy * gap) / 2
        } else if (aMoves) {
          a.x -= ux * gap
          a.y -= uy * gap
        } else if (bMoves) {
          b.x += ux * gap
          b.y += uy * gap
        } else {
          continue // 双方均锁定（subset 外）则跳过
        }
        anyPushed = true
      }
    }
    if (!anyPushed) break
  }

  const result = new Map<string, Point>()
  for (const n of resolved) result.set(n.id, { x: n.x, y: n.y })
  return result
}

/**
 * 拖拽推挤位移计算（D-04）：拖动节点压到旧节点时，计算旧节点沿最小位移方向让位的
 * 新位置（可连锁：让位节点压到更远节点时递归让位，深度上限 MAX_PUSH_CHAIN_DEPTH）。
 * 返回结果永不包含 draggedId（拖动节点永不被弹回，红线）。
 */
export function resolvePushAside(
  draggedId: string,
  draggedRect: Rect,
  others: LayoutNode[],
): Map<string, Point> {
  const nodes = others.map(resolveNode).filter((n) => n.id !== draggedId)
  const displaced = new Map<string, Point>()

  const press = (presser: Rect, depth: number): void => {
    if (depth > MAX_PUSH_CHAIN_DEPTH) return
    for (const n of nodes) {
      if (displaced.has(n.id)) continue
      const rect = rectOf(n)
      if (!rectsOverlap(presser, rect)) continue
      // 最小位移方向：取穿透量较小的轴推出
      const pc = centerOf(presser)
      const nc = centerOf(rect)
      const dx = nc.x - pc.x
      const dy = nc.y - pc.y
      const overlapX = (presser.width + rect.width) / 2 - Math.abs(dx)
      const overlapY = (presser.height + rect.height) / 2 - Math.abs(dy)
      const pad = 1
      if (overlapX <= overlapY) {
        const dir = dx === 0 ? 1 : Math.sign(dx)
        n.x += dir * (overlapX + pad)
      } else {
        const dir = dy === 0 ? 1 : Math.sign(dy)
        n.y += dir * (overlapY + pad)
      }
      displaced.set(n.id, { x: n.x, y: n.y })
      press(rectOf(n), depth + 1)
    }
  }

  press(draggedRect, 0)
  return displaced
}

/**
 * 吸附 + 防重叠次序判定（D-05 + D-11 参考线）：
 * 1) 先找 GUIDE_THRESHOLD 内的邻边/邻中心对齐候选（参考线对齐）；
 * 2) 否则按 grid 吸附（round 到 grid 倍数）；
 * 3) 候选落点若与第三节点重叠 → 放弃吸附，返回原 candidatePos + snapped:false
 *    （弹开让位优先于吸附，由调用方走 resolvePushAside）。
 */
export function snapWithAntiOverlap(
  candidatePos: Point,
  draggedId: string,
  others: LayoutNode[],
  grid: number = SNAP_GRID,
): { pos: Point; snapped: boolean } {
  const nodes = others.map(resolveNode).filter((n) => n.id !== draggedId)

  const free = (p: Point): boolean => {
    const rect: Rect = { x: p.x, y: p.y, width: NODE_WIDTH, height: NODE_HEIGHT }
    return nodes.every((n) => !rectsOverlap(rect, rectOf(n)))
  }

  // 参考线对齐候选：邻边/邻中心对齐（源/目标各 3 条线）
  let guide: Point | null = null
  let guideDist = GUIDE_THRESHOLD + 1
  for (const n of nodes) {
    const xTargets = [n.x, n.x + n.width / 2, n.x + n.width]
    const yTargets = [n.y, n.y + n.height / 2, n.y + n.height]
    for (const t of xTargets) {
      for (const s of [candidatePos.x, candidatePos.x + NODE_WIDTH / 2, candidatePos.x + NODE_WIDTH]) {
        const d = Math.abs(t - s)
        if (d <= GUIDE_THRESHOLD && d < guideDist) {
          const p = { x: candidatePos.x + (t - s), y: candidatePos.y }
          if (free(p)) {
            guide = p
            guideDist = d
          }
        }
      }
    }
    for (const t of yTargets) {
      for (const s of [candidatePos.y, candidatePos.y + NODE_HEIGHT / 2, candidatePos.y + NODE_HEIGHT]) {
        const d = Math.abs(t - s)
        if (d <= GUIDE_THRESHOLD && d < guideDist) {
          const p = { x: candidatePos.x, y: candidatePos.y + (t - s) }
          if (free(p)) {
            guide = p
            guideDist = d
          }
        }
      }
    }
  }
  if (guide) return { pos: guide, snapped: true }

  // 网格吸附
  const snappedPos: Point = {
    x: Math.round(candidatePos.x / grid) * grid,
    y: Math.round(candidatePos.y / grid) * grid,
  }
  if (free(snappedPos)) return { pos: snappedPos, snapped: true }
  return { pos: { ...candidatePos }, snapped: false }
}

/**
 * 选中集对齐（D-12）：mode ∈ left/right/top/bottom/hDistribute/vDistribute。
 * 均分模式在选中数 < 3 时返回空 Map（调用方禁用按钮）。
 */
export function alignNodes(
  ids: string[],
  nodes: LayoutNode[],
  mode: AlignMode,
): Map<string, Point> {
  const result = new Map<string, Point>()
  const selected = nodes.filter((n) => ids.includes(n.id)).map(resolveNode)
  if (selected.length === 0) return result

  if (mode === 'hDistribute' || mode === 'vDistribute') {
    if (selected.length < 3) return result
    const axis: 'x' | 'y' = mode === 'hDistribute' ? 'x' : 'y'
    const sorted = [...selected].sort((a, b) => a[axis] - b[axis])
    const first = sorted[0][axis]
    const last = sorted[sorted.length - 1][axis]
    const step = (last - first) / (sorted.length - 1)
    sorted.forEach((n, i) => {
      result.set(n.id, { x: n.x, y: n.y, [axis]: first + step * i } as Point)
    })
    return result
  }

  let target: number
  if (mode === 'left') target = Math.min(...selected.map((n) => n.x))
  else if (mode === 'right') target = Math.max(...selected.map((n) => n.x))
  else if (mode === 'top') target = Math.min(...selected.map((n) => n.y))
  else target = Math.max(...selected.map((n) => n.y)) // bottom

  for (const n of selected) {
    if (mode === 'left' || mode === 'right') result.set(n.id, { x: target, y: n.y })
    else result.set(n.id, { x: n.x, y: target })
  }
  return result
}

/**
 * 视野中心最近空位（D-13）：从 center 起环状搜索首个与所有现有节点包围盒
 * 不相交的落点。
 */
export function nearestFreePosition(center: Point, others: LayoutNode[]): Point {
  const nodes = others.map(resolveNode)
  const isFree = (p: Point): boolean => {
    const rect: Rect = { x: p.x, y: p.y, width: NODE_WIDTH, height: NODE_HEIGHT }
    return nodes.every((n) => !rectsOverlap(rect, rectOf(n)))
  }
  if (isFree(center)) return { ...center }

  const ringStep = Math.max(SNAP_GRID * 2, Math.floor(LAYOUT_SPACING / 2))
  const maxRings = 24
  for (let ring = 1; ring <= maxRings; ring++) {
    const r = ring * ringStep
    const count = Math.max(8, Math.round((2 * Math.PI * r) / ringStep))
    for (let k = 0; k < count; k++) {
      const angle = (2 * Math.PI * k) / count
      const p = { x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) }
      if (isFree(p)) return p
    }
  }
  // 兜底：极远处必空（有界退出，T-26-02-01）
  return { x: center.x + maxRings * ringStep, y: center.y + maxRings * ringStep }
}
