// FE-04 (D-5-6): 模块级 LRU 缓存（非 per-instance），ChunkContent 频繁 re-mount 时跨实例复用，
// 存活卸载。keyed by file_path → base64 data url。LRU 按 count 有界。
// FE-04 (D-5-5): in-flight 去重 Map，同图并发请求复用同一 Promise（chunk 搜索切换/编辑去重）。
// 客户端 AbortController：better-sqlite3 同步读不可真中断，AbortController 落地为
// 结构化取消标志 + 卸载防 setState + 配合 in-flight 去重。不改 IPC kb:getImageData 签名。

const CACHE_MAX_ENTRIES = 100 // LRU 容量阈值（D-5-6 count vs bytes 选 count）

/** LRU 缓存（Map 保持插入顺序，淘汰最老） */
const cache = new Map<string, string>()
/** in-flight 去重：同 file_path 并发请求复用同一 Promise */
const inFlight = new Map<string, Promise<string>>()

/**
 * 取 KB 图片数据。优先读缓存 → 复用 in-flight → 否则调 IPC 并入缓存。
 *
 * signal.aborted 不取消共享的 IPC 请求（其他调用方仍待结果）；
 * 调用方在 await 前后判 signal.aborted 决定是否 setState（见 ChunkContent 改造）。
 */
export async function getImage(path: string, _signal: AbortSignal): Promise<string> {
  // 1. 缓存命中
  // 1. 缓存命中
  const cached = cache.get(path)
  if (cached !== undefined) return cached

  // 2. in-flight 复用（同图并发请求）
  const existing = inFlight.get(path)
  if (existing) return existing

  // 3. 发起新请求
  const p = (async () => {
    try {
      const data = await window.api.kb.getImageData(path)
      if (data) {
        // LRU 淘汰：超容量删最老（Map 迭代顺序 = 插入顺序）
        if (cache.size >= CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(path, data)
        return data
      }
      throw new Error('图片数据为空')
    } finally {
      inFlight.delete(path) // 请求结束（成功/失败）清 in-flight，允许后续重试
    }
  })()
  inFlight.set(path, p)

  return p
}

/** 测试/切换场景可手动清缓存 */
export function clearImageCache(): void {
  cache.clear()
  inFlight.clear()
}
