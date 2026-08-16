// FE-02 (05-04)：KB DTO，字段严格反推自 KnowledgeBasePage.tsx 真实消费面（行号见注释）。
// D-5-3「缺 DTO 就近补」，DB 行原生字段保留下划线（非驼峰），与消费面一致。

/** KB 图片对象（chunk 内嵌，line 38/40/41/63/67 消费） */
export interface KbImage {
  id: string
  file_path: string
  description?: string
  chunk_id?: string | null
}

/** KB 分块（line 211/245/246/473/484/490/515 消费） */
export interface KbChunk {
  id: string
  doc_id?: string
  chunk_index: number
  title?: string
  content: string
  char_count?: number
  images?: KbImage[]
}

/** KB 文档（line 296-361 列 + 455-466 详情渲染） */
export interface KbDocument {
  id: string
  file_name: string             // 非 filename（line 299/351/464）
  title?: string                // line 455 detailDoc.title
  file_type?: string            // line 303 FILE_TYPE_ICONS key
  file_size?: number            // line 320 formatSize
  chunk_count?: number          // line 321/466
  category?: string             // line 308
  device_id?: string | null     // line 311/316（下划线，非 deviceId）
  status?: string               // line 324/465（pending/processing/ready/error）
  error_message?: string        // line 332（下划线，非 errorMessage）
  created_at?: string           // line 339（下划线，非 createdAt）
  chunks?: KbChunk[]            // line 473 detailDoc.chunks
}

export type KbStatus = 'pending' | 'processing' | 'ready' | 'error'

/** KB 检索结果（line 437-446 消费） */
export interface KbSearchResult {
  id: string                    // line 438 r.id（key）
  title?: string                // line 441 r.title
  content?: string              // line 446 r.content slice 300
  document?: { title: string }  // line 442 r.document?.title（嵌套，非 docId/docTitle）
  score?: number
  images?: KbImage[]            // FE-04 defer：检索结果 attach 图片，供 ChunkContent 渲染 [图片N]
}

/**
 * KB 检索信封（TXN-04 / 18-01，沿 PaginatedResult 命名族）。
 *
 * kb:search 返回值由裸数组改为信封对象：降级可观测（Q4 三处 fallback 不再静默）+
 * 索引截断标注（Q3 无界 prompt 收敛后，LLM 只见前 MAX_INDEX_ENTRIES 条索引）。
 * renderer 消费 .rows 渲染，degraded / indexCapped 驱动 Alert warning（D-08）。
 */
export interface KbSearchEnvelope {
  /** 检索结果行（降级时为 fallback 前 topK 行，形态与 AI 选中路径一致） */
  rows: KbSearchResult[]
  /** 是否走了降级路径（未经 LLM 筛选，直接按索引序返回前 topK 行） */
  degraded: boolean
  /** 降级原因（仅 degraded=true 时有值；固定三值枚举，无自由文本穿越 IPC——T-18-01） */
  degradedReason?: 'no_api_key' | 'empty_pick' | 'callai_error'
  /** 裁剪前虚拟索引全量条数 */
  indexTotal: number
  /** 裁剪后索引条数（null = 未截断；非 null 时 prompt 索引块尾部有截断标注——T-18-03） */
  indexCapped: number | null
}
