/**
 * 自研轻量逐词 diff（Phase 20 / D-02 冲突三选弹窗数据源）。
 *
 * 纯函数、无第三方依赖（避免 diff 库引入 review 成本；输入为提示词文本量级，LCS 性能足够）。
 * 词切分规则：中文按单字、拉丁按连续非空白词、空白串（含换行）各为一个 token，
 * LCS 在 token 序列上天然同时覆盖行级与行内差异。
 */

export interface DiffSegment {
  type: 'same' | 'add' | 'remove'
  text: string
}

// 中文单字 | 连续非中文非空白 | 连续空白（含换行，作为独立 token 保留原文格式）
const TOKEN_RE = /[一-鿿]|[^\s一-鿿]+|\s+/gu

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

/** token 序列 LCS → 前缀对齐的操作序列 */
function lcsOps(a: string[], b: string[]): Array<{ type: 'same' | 'add' | 'remove'; token: string }> {
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度（滚动到全矩阵便于回溯）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: Array<{ type: 'same' | 'add' | 'remove'; token: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', token: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', token: a[i] })
      i++
    } else {
      ops.push({ type: 'add', token: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ type: 'remove', token: a[i++] })
  while (j < m) ops.push({ type: 'add', token: b[j++] })
  return ops
}

/** 逐词 diff：返回 add/remove/same 段序列（相邻同类型 token 合并，文本拼接分别等于 a 与 b） */
export function diffInline(a: string, b: string): DiffSegment[] {
  const ops = lcsOps(tokenize(a), tokenize(b))
  const segs: DiffSegment[] = []
  for (const op of ops) {
    const last = segs[segs.length - 1]
    if (last && last.type === op.type) {
      last.text += op.token
    } else {
      segs.push({ type: op.type, text: op.token })
    }
  }
  return segs
}
