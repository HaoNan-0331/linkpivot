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
/** 星型分层放射：层间半径步长（量级沿用 LAYOUT_SPACING，26-04 再工 spec ③） */
export const RING_GAP = LAYOUT_SPACING
/** 叶子扇区半角（±30°） */
const SECTOR_HALF = (30 * Math.PI) / 180
const TAU = Math.PI * 2

/** 布局计算用最小边形态（TopologyEdge 取 source/target 即可映射） */
export interface LayoutEdge {
  source: string
  target: string
}

/** spreadLayout 模式选项：centerId（选 1 台定根）/ subset（选多台仅整理选中集） */
export interface SpreadLayoutOptions {
  centerId?: string
  subset?: string[]
}

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
 * 星型分层放射（26-04 再工 spec ③，替换 D-01/D-02/D-03 原位散开）：
 * - auto（无 centerId/subset）：剔除度=1 叶子后取度数最大者为根（核心胜出，
 *   接入交换机剔除终端后只剩上行线抢不过核心——用户痛点），从根 BFS 按最短跳数分层；
 * - center（centerId）：以该设备为根，全图同规则分层排布，根落点 = 其原位置；
 * - selection（subset）：仅整理选中集——选中诱导子图同规则分层，质心为圆心；
 * 根居中，第 i 层均匀分布在半径 ≥ i × RING_GAP 的圆环（弧长不足扩半径）；
 * 叶子（度=1）放最外环且挂在其唯一上游邻居的角度扇区（±30° 均分）。
 * 防重叠红线：最终落点两两包围盒不相交（放置序贪心径向外推兜底）；
 * 输出确定性（同输入同输出）；纯函数，不依赖 DOM/React。
 */
export function spreadLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts?: SpreadLayoutOptions,
): Map<string, Point> {
  const result = new Map<string, Point>()
  const resolved = nodes.map(resolveNode)
  if (resolved.length === 0) return result
  if (resolved.length === 1) {
    result.set(resolved[0].id, { x: resolved[0].x, y: resolved[0].y })
    return result
  }

  const subset = opts?.subset ? new Set(opts.subset) : null
  const active = subset ? resolved.filter((n) => subset.has(n.id)) : resolved
  if (active.length === 1) {
    result.set(active[0].id, { x: active[0].x, y: active[0].y })
    return result
  }
  const activeIds = new Set(active.map((n) => n.id))

  // 邻接表（仅活跃集内边；自环忽略）
  const adj = new Map<string, Set<string>>()
  for (const n of active) adj.set(n.id, new Set())
  for (const e of edges) {
    if (!activeIds.has(e.source) || !activeIds.has(e.target) || e.source === e.target) continue
    adj.get(e.source)!.add(e.target)
    adj.get(e.target)!.add(e.source)
  }
  const deg = (id: string): number => adj.get(id)!.size

  // 根选择：centerId 优先；否则剔除度=1 叶子后在剩余子图内取度数最大者
  // （度数按剥离后子图计算：接入交换机剔除终端后只剩上行线，抢不过核心——用户痛点；
  //   平票取 id 序小者，确定性）
  const centerMode = !!(opts?.centerId && activeIds.has(opts.centerId))
  let rootId: string
  if (centerMode) {
    rootId = opts!.centerId!
  } else {
    const coreIds = new Set(active.filter((n) => deg(n.id) > 1).map((n) => n.id))
    const coreDeg = (id: string): number =>
      coreIds.has(id) ? [...adj.get(id)!].filter((nb) => coreIds.has(nb)).length : -1
    const candidates = coreIds.size > 0 ? [...coreIds] : active.map((n) => n.id)
    candidates.sort()
    rootId = candidates.reduce((best, id) => (coreDeg(id) > coreDeg(best) ? id : best))
  }

  // 全图 BFS 分层（按最短跳数）
  const layerOf = new Map<string, number>([[rootId, 0]])
  const queue = [rootId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const nb of adj.get(cur)!) {
      if (!layerOf.has(nb)) {
        layerOf.set(nb, layerOf.get(cur)! + 1)
        queue.push(nb)
      }
    }
  }

  // 叶子（度=1 且非根）走外环扇区；其余走分层环
  const leaves = active.filter((n) => n.id !== rootId && deg(n.id) === 1)
  const leafIds = new Set(leaves.map((n) => n.id))
  const ringNodes = active.filter((n) => !leafIds.has(n.id) && layerOf.has(n.id))
  const unreached = active.filter((n) => !leafIds.has(n.id) && !layerOf.has(n.id))

  // 圆心：center 模式 = 根原位置中心；auto/selection = 活跃集质心
  let cx: number
  let cy: number
  if (centerMode) {
    const root = resolved.find((n) => n.id === rootId)!
    cx = root.x + root.width / 2
    cy = root.y + root.height / 2
  } else {
    cx = active.reduce((s, n) => s + n.x + n.width / 2, 0) / active.length
    cy = active.reduce((s, n) => s + n.y + n.height / 2, 0) / active.length
  }

  // 确定性放置容器（angle/r 供最终防重叠径向外推）
  const placed: { id: string; cx: number; cy: number; w: number; h: number; angle?: number; r?: number }[] = []
  const place = (n: ResolvedNode, angle: number | undefined, r: number) => {
    placed.push({
      id: n.id,
      cx: cx + (r * (angle === undefined ? 0 : Math.cos(angle))),
      cy: cy + (r * (angle === undefined ? 0 : Math.sin(angle))),
      w: n.width,
      h: n.height,
      angle,
      r,
    })
  }

  place(resolved.find((n) => n.id === rootId)!, undefined, 0)

  // 分层环：半径 = max(i × RING_GAP, 弧长需求, 前环半径 + RING_GAP)，角度均匀 + 奇偶层错位
  let prevR = 0
  const maxLayer = ringNodes.reduce((m, n) => Math.max(m, layerOf.get(n.id)!), 0)
  for (let i = 1; i <= maxLayer; i++) {
    const members = ringNodes
      .filter((n) => layerOf.get(n.id) === i)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    if (members.length === 0) continue
    const k = members.length
    const r = Math.max(i * RING_GAP, (k * LAYOUT_SPACING) / TAU, prevR + RING_GAP)
    prevR = r
    members.forEach((n, j) => {
      place(n, (TAU * j) / k + (i % 2) * (Math.PI / k), r)
    })
  }

  // 叶子最外环：按上游分组；上游角度已知则扇区 ±SECTOR_HALF 均分（弧长不足放宽步距），否则全环均分
  const byUpstream = new Map<string, ResolvedNode[]>()
  for (const leaf of leaves) {
    const up = [...adj.get(leaf.id)!][0]
    if (!byUpstream.has(up)) byUpstream.set(up, [])
    byUpstream.get(up)!.push(leaf)
  }
  const angleOfPlaced = new Map(placed.map((p) => [p.id, p.angle]))
  const leafR = Math.max(
    prevR + RING_GAP,
    (leaves.length * LAYOUT_SPACING) / TAU
  )
  const rootLeafSlots: { n: ResolvedNode; idx: number }[] = []
  let rootLeafCount = 0
  for (const [up, group] of [...byUpstream.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    group.sort((a, b) => (a.id < b.id ? -1 : 1))
    const upAngle = angleOfPlaced.get(up)
    if (upAngle === undefined) {
      // 上游是根（圆心，无角度）：收集后全环均分
      for (const n of group) rootLeafSlots.push({ n, idx: rootLeafCount++ })
      continue
    }
    const k = group.length
    const step = Math.max((2 * SECTOR_HALF) / Math.max(k - 1, 1), LAYOUT_SPACING / leafR)
    group.forEach((n, j) => place(n, upAngle + (j - (k - 1) / 2) * step, leafR))
  }
  rootLeafSlots.forEach(({ n, idx }) =>
    place(n, (TAU * idx) / Math.max(rootLeafCount, 1), leafR)
  )
  const lastR = Math.max(
    leafR,
    rootLeafCount > 0 || leaves.length > 0 ? leafR : prevR,
    prevR
  )

  // 未连通节点：最外再增一环，按 id 序均匀
  if (unreached.length > 0) {
    const r = lastR + RING_GAP
    ;[...unreached]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .forEach((n, j) => place(n, (TAU * j) / unreached.length, r))
  }

  // 防重叠兜底：按放置序贪心——与更早落点重叠则沿自身角度径向外推（有界退出）
  const rectAtP = (p: (typeof placed)[number]): Rect => ({
    x: p.cx - p.w / 2,
    y: p.cy - p.h / 2,
    width: p.w,
    height: p.h,
  })
  const MAX_RADIAL_PUSH = 5000 / SNAP_GRID
  for (let i = 1; i < placed.length; i++) {
    const p = placed[i]
    if (p.angle === undefined) continue
    let guard = 0
    while (
      guard++ < MAX_RADIAL_PUSH &&
      placed.slice(0, i).some((q) => rectsOverlap(rectAtP(p), rectAtP(q)))
    ) {
      p.r! += SNAP_GRID
      p.cx = cx + p.r! * Math.cos(p.angle)
      p.cy = cy + p.r! * Math.sin(p.angle)
    }
  }

  for (const p of placed) result.set(p.id, { x: p.cx - p.w / 2, y: p.cy - p.h / 2 })
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
 * 吸附 + 防重叠次序判定（D-05 + D-11 参考线，26-04 再工 spec ⑤）：
 * 1) 先找 GUIDE_THRESHOLD 内的邻边/邻中心对齐候选（参考线对齐，优先级最高）；
 * 2) 候选落点若与第三节点重叠 → 放弃吸附，返回原 candidatePos + snapped:false
 *    （弹开让位优先于吸附，由调用方在松手时走 resolvePushAside）。
 * 注：D-11 原网格吸附（grid 参数 + RF snapToGrid）已移除（26-04 checkpoint round 3
 * 用户裁决「没有太大意义」），仅保留参考线对齐。
 */
export function snapWithAntiOverlap(
  candidatePos: Point,
  draggedId: string,
  others: LayoutNode[],
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
