/**
 * Phase 35 / UI-07（D-06/D-07）：AppFrame 三栏骨架边界计算纯函数库（35-01）。
 *
 * 零 npm 依赖、不触 window/DOM 全局（frameWidth 由调用方注入，node-env vitest 可直测）。
 * 所有函数均为纯函数：同输入同输出、不修改输入对象。
 */

// ---- 模块级常量（值由 Phase 35 RESEARCH「宽度边界终值推荐」锁定） ----
/** details 栏最小宽度（D-06「约 240」取整；13/14px 正文字号下列表/键值行可读下限） */
export const DETAILS_MIN_WIDTH = 240
/** details 栏展开默认宽（占位期舒适 + 未来设备详情面板典型宽） */
export const DETAILS_DEFAULT_WIDTH = 320
/** details 栏最大宽占窗口比例（D-06：拓扑是 Core Value，画布永远保有主导空间） */
export const DETAILS_MAX_RATIO = 0.4

/** localStorage 持久化载荷形态（appFrameStore 读写共用，D-07） */
export interface PersistedFrame {
  width: number
  collapsed: boolean
}

/**
 * 宽度边界钳制（D-06 画布优先边界）：
 * - 上限 = max(240, floor(frameWidth × 0.4))——窗口 < 600px 时 40% < min，min 胜
 *   （保证展开永远有意义，边界冲突在纯函数内消化）；
 * - 任一输入非有限值（NaN/Infinity：width 见 localStorage 载荷被篡改场景；
 *   frameWidth 见未来外部调用方注入（D-08 预留接口）不可控）一律回默认宽 320——
 *   否则 NaN 经 Math.min 透传会一路写进 store、inline style 与持久化载荷
 *   （"width":null，35-REVIEW WR-02）；
 * - 小数宽度四舍五入取整（拖拽像素语义）。
 */
export function clampDetailsWidth(width: number, frameWidth: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(frameWidth)) return DETAILS_DEFAULT_WIDTH
  const max = Math.max(DETAILS_MIN_WIDTH, Math.floor(frameWidth * DETAILS_MAX_RATIO))
  return Math.min(max, Math.max(DETAILS_MIN_WIDTH, Math.round(width)))
}

/**
 * 读盘载荷解析（D-07 宽度记忆 / Pitfall 4 + Pitfall 7 三重兜底）：
 * try/catch JSON.parse + 逐字段 typeof 校验（width: number、collapsed: boolean），
 * 任一失败或抛错整体回退 { width: 320, collapsed: true }（D-02 默认折叠）；
 * 通过则 width 经 clampDetailsWidth 收敛——防历史大屏存盘宽 vs 今小窗口启动爆版。
 * frameWidth 由调用方注入（不触 window 全局）。
 */
export function parsePersistedFrame(raw: string | null, frameWidth: number): PersistedFrame {
  const fallback: PersistedFrame = { width: DETAILS_DEFAULT_WIDTH, collapsed: true }
  if (typeof raw !== 'string') return { ...fallback }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...fallback }
    const { width, collapsed } = parsed as Record<string, unknown>
    if (typeof width !== 'number' || typeof collapsed !== 'boolean') return { ...fallback }
    return { width: clampDetailsWidth(width, frameWidth), collapsed }
  } catch {
    return { ...fallback }
  }
}
