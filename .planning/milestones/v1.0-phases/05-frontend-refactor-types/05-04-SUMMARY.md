---
phase: 05-frontend-refactor-types
plan: 04
subsystem: frontend-kb
tags: [frontend, types, kb, fe-02, fe-04, abort-controller, lru-cache]
requirements: [FE-02, FE-04]
requires:
  - "05-01 (electron.d.ts 非 kb 通道建模 + src/types/ai.ts 先例)"
provides:
  - "src/types/kb.ts (KbDocument/KbChunk/KbImage/KbStatus/KbSearchResult)"
  - "electron.d.ts kb.* 通道强类型 (05-01 保留 → 05-04 接力收类型)"
  - "src/components/pages/kb/imageCache.ts (模块级 LRU + in-flight 去重 + AbortSignal)"
  - "KnowledgeBasePage.tsx 17 处 any → 0 + ChunkContent AbortController 结构化取消"
affects:
  - "KnowledgeBasePage.tsx (FE-02 类型化 + FE-04 缓存，同文件串行)"
  - "electron.d.ts (kb.* 通道签名)"
tech-stack:
  added: []
  patterns:
    - "renderer 侧首例模块级 LRU 缓存 (既有模块级缓存只在主进程 ouiService，FE-04 照搬为 file-scope Map)"
    - "AbortController 结构化取消 (better-sqlite3 同步读不可真中断，客户端语义：取消标志 + 卸载防 setState + in-flight 去重)"
    - "DB 行原生下划线字段保留 (device_id/error_message/created_at/chunk_index/char_count，非驼峰)"
key-files:
  created:
    - "src/types/kb.ts"
    - "src/components/pages/kb/imageCache.ts"
  modified:
    - "src/types/electron.d.ts"
    - "src/components/pages/KnowledgeBasePage.tsx"
decisions:
  - "D-5-5: 不改 IPC kb:getImageData 签名 (better-sqlite3 同步读不可真中断，Phase 4 IPC 契约稳定)；AbortController 落地为客户端结构化取消标志"
  - "D-5-6: 缓存模块级 (非 per-instance)，ChunkContent 频繁 re-mount 跨实例复用、存活卸载"
  - "issue 1: KB DTO 字段反推自 KnowledgeBasePage.tsx 真实消费面 (file_name 非 filename、images 对象数组非 image_ids、document?.title 嵌套非 docId)"
  - "D-5-6 LRU 容量阈值选 count (100 条) 而非 bytes (Claude's Discretion)"
  - "in-flight 共享 Promise 不因单方 abort 取消 (其他调用方仍待结果)；abort 语义由调用方读 signal.aborted 守卫 setState"
metrics:
  duration: "~30min"
  completed: "2026-07-02"
  tasks: "2 auto + 1 checkpoint(human-verify)"
  files: "2 created + 2 modified"
---

# Phase 5 Plan 04: FE-02 KB 类型化 + FE-04 ChunkContent 取消与缓存 Summary

KB 页 17 处 any 全收敛（含 src/types/kb.ts 新建 DTO 字段反推自真实消费面 + electron.d.ts kb.* 通道收类型）+ ChunkContent 改 AbortController 结构化取消 + 模块级 LRU 图片缓存 + in-flight 去重，IPC kb:getImageData 签名不动。

## What Was Built

### Task 1: FE-02 KB 类型化（commit 7db81f2）

- **新建 `src/types/kb.ts`**：5 个 DTO（KbDocument/KbChunk/KbImage/KbStatus/KbSearchResult），字段严格反推自 KnowledgeBasePage.tsx 真实消费面（每字段附消费行号注释）：
  - KbDocument：`file_name`（非 filename，line 299/351/464）/ `title` / `file_type` / `file_size` / `chunk_count` / `category` / `device_id`（下划线，line 311/316）/ `status` / `error_message`（下划线，line 332）/ `created_at`（下划线，line 339）/ `chunks`
  - KbChunk：`id` / `doc_id` / `chunk_index` / `title` / `content` / `char_count` / `images`（KbImage[]）
  - KbImage：`id` / `file_path` / `description?` / `chunk_id?`（**图片对象数组**，非 image_ids 字符串，line 40/41/63/67 消费）
  - KbSearchResult：`id` / `title?` / `content?` / `document?: { title: string }`（**嵌套对象**，非 docId/docTitle 扁平，line 442 消费 `r.document?.title`）/ `score?`
- **`electron.d.ts` kb.* 通道收类型**（05-01 保留 Promise<any>，本 plan 接力）：listDocuments/getDocument/getStatus/search/uploadBuffer/reprocess 全部强类型；顶部 `import type { KbDocument, KbStatus, KbSearchResult } from './kb'`
- **`KnowledgeBasePage.tsx` 17 处 any 全收敛**：ChunkContent 签名 `images: any[]` → `KbImage[]`、`img: any` → `KbImage`；documents/devices/searchResults/detailDoc 状态用 DTO；3 处 Table 列 render（file_name/status/操作）；2 处 Select options（upload/filterDevice）；2 处 chunk map（detail/merge）；`as any[]` 全去
- **nullable 字段窄化**（strict 模式必须）：`record.file_type ?? ''`（line 305 index 类型）、`r.content?.length ?? 0`（line 449 比较）、`detailDoc.status ?? ''`（line 468 STATUS_MAP key）、`(detailDoc.chunks?.length ?? 0) > 0 ? detailDoc.chunks!.map(...)`（line 475）、handleMerge 前置 `if (!detailDoc || !detailDoc.chunks) return` 守卫（line 247）
- **Task 1 完成后 ChunkContent effect 保留 `let cancelled = false` + `window.api.kb.getImageData` 直调**（plan action item 11，仅收 `img: any` → `KbImage`，取消逻辑归 Task 2）

### Task 2: FE-04 取消与缓存（commit 5ce3483）

- **新建 `src/components/pages/kb/imageCache.ts`**（renderer 侧首例模块级 LRU 缓存，模式照搬主进程 `ouiService.vendorMap`）：
  - 模块级 `const cache = new Map<string, string>()`（LRU，Map 插入顺序淘汰最老，`CACHE_MAX_ENTRIES=100` 上限，按 count 有界 O(1)）
  - 模块级 `const inFlight = new Map<string, Promise<string>>`（in-flight 去重，同 file_path 并发复用 Promise，`finally` 清除允许失败后重试）
  - `export async function getImage(path, signal)`：缓存命中 → in-flight 复用 → 否则 `window.api.kb.getImageData` IPC 并入缓存
  - `export function clearImageCache()`：测试/切换场景手动清
- **ChunkContent effect 改造**（D-5-5 结构化取消）：
  - `let cancelled = false` + `return () => { cancelled = true }` → `const controller = new AbortController()` + `return () => { controller.abort() }`
  - `window.api.kb.getImageData(img.file_path)` 直调 → `getImage(img.file_path, signal)` 走缓存层
  - setState 前判 `if (!signal.aborted && data)`（卸载/切换后 abort → 不 setState）
  - FRAG-2 顺带：图片失败 `catch { console.warn('[kb] 图片加载失败:', img.file_path) }`（不再完全静默，UI 不崩）
- **设计要点**：in-flight 共享 Promise **不因单个调用方 abort 取消**（其他调用方仍待结果）；abort 语义由调用方在 `.then` 前判 `signal.aborted` 决定是否 setState。better-sqlite3 同步读不可真中断，IPC 仍执行完但结果被丢弃。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Strict nullable 窄化追加**
- **Found during:** Task 1 tsc 验证
- **Issue:** KbDocument/KbChunk/KbSearchResult 大量可选字段（DB row 现实 + DTO 谨慎可选），但消费面用 `.length > 0` / `STATUS_MAP[status]` / `FILE_TYPE_ICONS[file_type]` 等不接受 undefined 的位置，strict 模式报 TS18047/TS18048/TS2538
- **Fix:** nullable 字段窄化（`?? ''` / `?? 0` / `?.` / `!` 断言 + null 守卫），非改 DTO（DTO 反映 DB row 真实可选性正确）
- **Files modified:** src/components/pages/KnowledgeBasePage.tsx (line 247/305/449/468/475)
- **Commit:** 7db81f2

无其他偏离。EBUSY 文件锁偶发（Windows 并发写），重试即恢复，不影响结果。

## Verification Results

三绿门禁全过：

| Gate | 命令 | 结果 |
|------|------|------|
| tsc web strict + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 |
| vitest 回归 | `npx vitest run` | 25 passed (4 files) |
| esbuild 主进程打包 | `npm run build:electron-main` | 不回归（1.8mb） |

acceptance grep：

| 项 | 期望 | 实际 |
|----|------|------|
| kb.ts 4 interface | 4 | 4 ✓ |
| kb.ts file_name | 1 | 1 ✓ |
| kb.ts image_ids | 0 | 0 ✓ |
| kb.ts document 嵌套 | 1 | 1 ✓ |
| electron.d.ts kb Promise<any> | 0 | 0 ✓ |
| KB DTO refs | ≥1 | 15 ✓ |
| images: KbImage[] | 1 | 1 ✓ |
| as any[] | 0 | 0 ✓ |
| imageCache getImage | 1 | 1 ✓ |
| imageCache cache Map | 1 | 1 ✓ |
| imageCache inFlight Map | 1 | 1 ✓ |
| KB AbortController | ≥1 | 2 ✓ |
| KB controller.abort() | 1 | 1 ✓ |
| KB getImage( | 1 | 1 ✓ |
| KB let cancelled = false | 0 | 0 ✓ |
| KB any after 绝对值 | 0 | 0 ✓ |
| preload.ts kb 改动 | 无 | git diff 空 ✓ |

## Known Stubs

无。所有图片加载/缓存/取消/搜索/编辑路径全打通，无占位符或 mock。

## Threat Flags

无新增安全面。imageCache 仅 renderer 内存（不持久化、不跨进程、不外发），缓存内容为 KB 文档附件 base64（低敏，T-05-04-01 accept）；LRU 上限 + in-flight finally 清除防泄漏（T-05-04-02 mitigate）；IPC 签名不动，主进程 SEC-1/SEC-5 防护不变（T-05-04-04 accept）。

## Pending Human Verification (Task 3 checkpoint, 推迟到 phase 末批量 HV)

autonomous=false 因无前端测试基建（D-5-7）。**用户已决定推迟到 phase 末批量 HV**，本 plan 返回 checkpoint，HV 项登记如下供 phase 末统一执行：

启动 app → 进入「知识库」页，验证 10 项：

1. **文档列表加载**：列表渲染正确（file_name/status/chunk_count/error_message 列无类型回归）
2. **文档详情 chunks**：点开文档 → chunks 列表渲染（chunk_index/char_count/title 正确，含图片的 chunk 显示图片）
3. **图片首次加载**：含图片 chunk 首次打开 → 图片显示；DevTools Network 观察首次有 kb:getImageData IPC
4. **图片缓存命中**：同 chunk 关闭再展开 / 搜索切回同 chunk → 图片立即显示，**无重复 IPC**（模块级缓存命中，跨 ChunkContent 实例）
5. **in-flight 去重**：快速连续展开含相同图片的多 chunk → 同一 file_path 仅 1 次 IPC（in-flight Promise 复用）
6. **卸载取消**：含图片 chunk 加载中途关闭/切换 → Console 无「setState on unmounted」React 警告（AbortController.abort() 生效）
7. **图片加载失败**：破坏图片路径/删除文件 → Console 有 `[kb] 图片加载失败` warn（FRAG-2 改善），UI 不崩
8. **搜索**：关键词 → searchResults 渲染正确（r.document?.title 嵌套对象访问）
9. **chunk 编辑/拆分/合并**：startEdit/splitChunk/mergeChunks 无回归（KbChunk 类型化）
10. **无 console 报错**：DevTools 全程无 React 警告/报错

## Self-Check: PASSED

- [x] `src/types/kb.ts` 存在（4 interface 命中，字段反推自真实消费面，issue 1 修正）
- [x] `src/components/pages/kb/imageCache.ts` 存在（getImage + cache Map + inFlight Map）
- [x] commit `7db81f2` 存在（Task 1 FE-02 KB 类型化）
- [x] commit `5ce3483` 存在（Task 2 FE-04 imageCache + AbortController）
- [x] tsc web exit 0 / vitest 25 passed / esbuild 不回归
- [x] KB any after 绝对值 = 0
- [x] preload.ts 未改（kb.getImageData IPC 签名不动，D-5-5 红线）
