---
phase: quick-260705-sj1
plan: 01
subsystem: kb-search
tags: [kb, search, image-render, fe-04-defer]
requires:
  - getDocument image attach 模式（electron/services/knowledgeBaseService.ts:86-94）
  - ChunkContent 组件（src/components/pages/KnowledgeBasePage.tsx:34-97）
  - imageCache.getImage（src/components/pages/kb/imageCache.ts）
provides:
  - kb.search IPC 返回扩展 images: {id, file_path, description}[]
  - KbSearchResult.images 类型字段
affects:
  - KB 检索结果渲染（检索测试 Card body）
tech-stack:
  added: []
  patterns:
    - 复用 getDocument image attach 模式 + ids.length=0 守卫
    - 复用 ChunkContent 渲染（滚动浏览替代截断隐藏）
key-files:
  created: []
  modified:
    - electron/services/knowledgeBaseService.ts
    - src/types/kb.ts
    - src/components/pages/KnowledgeBasePage.tsx
decisions:
  - ids.length=0 守卫加在 attachImages helper，getDocument 历史隐患不回改（scope 收紧）
  - 检索卡用 ChunkContent（maxHeight:300 overflow:auto），滚动浏览优于原 maxHeight:80 hidden；topK=5 不会过长
  - KbSearchResult.images 可选（向后兼容旧响应）
metrics:
  duration: ~15min
  completed: 2026-07-05
  tasks: 2
  files: 3
---

# Phase quick-260705-sj1 Plan 01: KB 检索 [图片N] → 真实图片渲染 Summary

让 KB 检索结果中的 `[图片N]` 标记渲染为真实缩略图（点击放大），消除 Phase 5 FE-04 defer 项。后端 search 4 条返回路径统一 attach 含 file_path 的 images，前端检索卡用 ChunkContent 替换纯文本 div。

## 改动详情

### Task 1: 后端 search 4 条返回路径统一 attachImages（含 file_path）

**文件：** `electron/services/knowledgeBaseService.ts`

**改动 1 — 新增 attachImages helper（line 659-674，紧贴 search 上方）：**

```typescript
function attachImages(db: ReturnType<typeof getDatabase>, chunk: any) {
  if (chunk.image_ids) {
    try {
      const ids = JSON.parse(chunk.image_ids) as string[]
      chunk.images = ids.length
        ? db.prepare('SELECT id, file_path, description FROM kb_images WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids)
        : []
    } catch { chunk.images = [] }
  } else {
    chunk.images = []
  }
  return chunk
}
```

复刻 getDocument line 86-94 模式，差异：
- SELECT 含 `file_path`（ChunkContent 渲染必需，原 AI pick 内联块 line 727 缺此字段，是本次 bug 根因）
- `ids.length=0` 守卫，避免 `IN ()` 语法错（getDocument 历史隐患，本次 scope 不回改）

**改动 2 — 4 条返回路径统一调用：**

| 路径 | 原行号 | 改动 |
|------|--------|------|
| 无 AI config fallback | 687-691 | `return c` → `return attachImages(db, c)` |
| 空 indices fallback | 713-716 | `return c` → `return attachImages(db, c)` |
| AI pick | 720-731 | 删除 line 724-729 内联 attach 块（缺 file_path），改 `return attachImages(db2, chunk)` |
| catch | 733-737 | `c.images = []` → `return attachImages(db, c)`（catch 路径也能渲染已知图片） |

### Task 2: 前端 KbSearchResult 类型补 images + 检索卡用 ChunkContent 渲染

**文件 1：** `src/types/kb.ts:48`

`KbSearchResult` 新增可选字段（向后兼容）：

```typescript
images?: KbImage[]            // FE-04 defer：检索结果 attach 图片，供 ChunkContent 渲染 [图片N]
```

复用 KbImage（line 5-10，已含 file_path），无需新类型。

**文件 2：** `src/components/pages/KnowledgeBasePage.tsx:457`

检索 Card body 替换：

```tsx
// 替换前（纯文本 div，maxHeight:80 hidden，[图片N] 原样泄漏）
<div style={{ maxHeight: 80, overflow: 'hidden' }}>
  {r.content?.slice(0, 300)}{(r.content?.length ?? 0) > 300 ? '...' : ''}
</div>

// 替换后（ChunkContent 自带 maxHeight:300 overflow:auto，[图片N] → 缩略图 + 预览）
<ChunkContent content={r.content || ''} images={r.images || []} />
```

UX 权衡（planner 已决）：滚动浏览优于截断隐藏；topK=5 不会过长。`r.images || []` 守 undefined，旧响应走 ChunkContent 空分支（`[图片N]` 降级为灰底 placeholder span，不崩）。

## 验证结果

### 三绿门禁

| 门禁 | 命令 | 结果 |
|------|------|------|
| esbuild | `npx esbuild electron/services/knowledgeBaseService.ts --bundle=false --format=cjs --platform=node --outfile=__t.js` | `__t.js 27.2kb, Done in 23ms` → esbuild-ok |
| tsc | `npx tsc -p tsconfig.web.json --noEmit` | 全绿（含 noUnusedLocals）→ tsc-ok |
| vitest | `npx vitest run` | 4 test files / 25 tests passed，0 回归 |

### grep 验收

| 检查 | 命令 | 结果 |
|------|------|------|
| attachImages helper 唯一定义（含 file_path） | `grep "SELECT id, file_path, description FROM kb_images"` | 命中 2 处：line 94（getDocument）+ line 666（attachImages helper），AI pick 内联块已删 |
| 4 条返回路径调用 attachImages | `grep -c "attachImages(db"` | 5 处（1 定义 db 参数 + 3 db 调用 + 1 db2 调用）|
| KbSearchResult.images 字段 | `grep -c "images?: KbImage\[\]"` | 2 处（KbChunk + KbSearchResult）|
| 检索卡 ChunkContent 命中 | `grep "ChunkContent content={r.content"` | line 457 |
| 原 `slice(0, 300)` 已删除 | `grep -c "slice\(0, 300\)"` | 0 命中 |

## Deviations from Plan

None — plan 执行完全一致。无 Rule 1-3 触发。

- esbuild 验证命令：plan 给的 `node -e "...format:cjs..."` 在 bash 下 `cjs` 被 shell 当变量解释（ReferenceError），改用 `npx esbuild ... --format=cjs` CLI 形式，等价效果（仅 shell 调用方式调整，非逻辑改动）。

## Auth Gates

None。

## Known Stubs

None。无 placeholder/TODO/FIXME 引入；ChunkContent + imageCache 既有完整实现被复用。

## Threat Flags

None。T-sj1-01（file_path IPC 暴露）accept：与 getDocument line 86-94 同行为，不引入新暴露面。T-sj1-02（JSON.parse 异常）mitigate：attachImages helper try/catch 已守。

## 手动验证（execute-plan 阶段非本 plan 内）

1. 上传含图片的 docx → 等 ready
2. 检索关键词命中含 `[图片N]` 的 chunk
3. 检索卡内 `[图片N]` 渲染为缩略图，点击放大正常

## Self-Check: PASSED

- 文件存在：electron/services/knowledgeBaseService.ts / src/types/kb.ts / src/components/pages/KnowledgeBasePage.tsx — 均已修改并 commit
- commit 存在：
  - `a49b495` feat(quick-260705-sj1): search 4 返回路径统一 attachImages（含 file_path）
  - `68c6ea3` feat(quick-260705-sj1): 检索卡用 ChunkContent 渲染 [图片N] → 图片
- 三绿门禁全通过
