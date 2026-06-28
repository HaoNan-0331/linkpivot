---
phase: quick
plan: 260628-trt
subsystem: build-dependency + backup-scheduler
tags: [security, data-integrity, dependency, pdfjs, backup]
requires:
  - "knowledgeBaseService.ts parsePdf await import('pdfjs-dist/legacy/build/pdf.mjs')"
  - "backupScheduler.ts pruneBackups(retention) FIFO 裁剪"
provides:
  - "pdfjs-dist ^6.1.200 进入 dependencies（PDF 知识库解析恢复）"
  - "pruneBackups retention clamp 防删光（数据完整性）"
affects:
  - "PDF 知识库导入功能"
  - "周期/预迁移备份保留策略"
tech-stack:
  added:
    - pdfjs-dist@^6.1.200
  patterns:
    - "retention clamp (Math.max(1, x)) 防 0 值边界"
key-files:
  created: []
  modified:
    - package.json
    - package-lock.json
    - electron/services/backupScheduler.ts
decisions:
  - "接受 npm 默认解析的 pdfjs-dist 6.1.200（非计划预估的 4.x）：6.x 仍发布 legacy/build/pdf.mjs 路径，knowledgeBaseService.ts:393 import 语句无需改动，文件物理存在 + tsc/esbuild 双绿确认兼容"
  - "better-sqlite3 native binding (ABI 145 vs Node ABI 137) 阻塞运行时测试，Task 2 tdd 按计划以静态验证（tsc+esbuild+grep clamp）为准，未写 vitest 运行时用例"
  - "pruneBackups 用最小改动 clamp（不改签名/调用方/DB schema），retention<=0 一律按 1 处理"
metrics:
  duration: "~6min"
  completed: "2026-06-28"
  tasks: 2
  files: 3
requirements: [BUG-pdfjs-dist-missing, BUG-2-retention-zero-purge]
---

# Quick 260628-trt: pdfjs-dist 依赖补齐 + backupScheduler retention=0 删光修复 Summary

恢复 PDF 知识库解析运行时依赖（pdfjs-dist 6.1.200）并 clamp `pruneBackups` 的 retention 防 0 值删光全部备份——tsc + esbuild 双绿。

## What Was Done

### Task 1: 安装 pdfjs-dist 到 dependencies（critical, 12b1758）

`knowledgeBaseService.ts:393` 的 `await import('pdfjs-dist/legacy/build/pdf.mjs')` 在 dependencies 缺该包时运行时 broken。执行 `npm install pdfjs-dist`（绕过失效代理 `--no-proxy`）后：

- npm 解析为 **6.1.200**（计划预估 4.x，实际 registry 给 6.x）——`node_modules/pdfjs-dist/legacy/build/pdf.mjs` 文件物理存在，import 路径兼容，未改业务代码
- package.json `dependencies` 新增 `"pdfjs-dist": "^6.1.200"`
- esbuild `build:electron-main` 既有的 `--external:pdfjs-dist` 现可在运行时从 node_modules 解析
- 验证：`test -f node_modules/pdfjs-dist/legacy/build/pdf.mjs` ✓ / `tsc -p tsconfig.web.json --noEmit` 退出 0 / `build:electron-main` 退出 0

### Task 2: BUG-2 修复 pruneBackups retention=0 删光（high, ba06854）

`backupScheduler.ts:97` `files.slice(retention)` 在 `retention=0` 时返回全部文件 → 全删（用户配 `periodic_retention=0` 或 `premigration_retention=0` 即数据丢失）。最小改动 clamp：

```typescript
const safeRetention = Math.max(1, retention) // BUG-2: 防 retention=0 时 slice(0) 删光全部
const toDelete = files.slice(safeRetention)
```

- `retention<=0` 一律按 1 处理（至少保留最新 1 份）；`retention>=1` 行为完全不变
- 不动调用方、不动 DB schema、不动 `pruneBackups` 签名、不动 catch
- 验证：`tsc` 0 / `esbuild` 0 / `grep -c "Math.max(1, retention)"` = 1

## Deviations from Plan

**1. [Rule 3 - Blocking] pdfjs-dist 版本 6.1.200 而非计划预估的 4.x**
- **Found during:** Task 1
- **Issue:** 计划假设 `npm install pdfjs-dist` 装 4.x；实际 npm registry 默认解析 6.1.200
- **Fix:** 校验 6.x 是否仍发布 `legacy/build/pdf.mjs`——文件物理存在（`test -f` 通过），knowledgeBaseService.ts:393 import 语句（`pdfjs-dist/legacy/build/pdf.mjs`）在 6.x 仍匹配，未改业务代码
- **Files modified:** 仅 package.json + package-lock.json（如计划）
- **Commit:** 12b1758
- **决策依据:** 计划 done criteria 写明"4.x"是版本预估非硬约束（must_haves.truths 只要求 import 路径可解析 + esbuild external 解析成功）；6.x 物理满足两项约束，无 Rule 4 架构变更必要

**2. [Rule 3 - Blocking] npm 代理失效需绕过**
- **Found during:** Task 1
- **Issue:** npm 全局配 proxy=127.0.0.1:10809 但代理端口 ECONNREFUSED；npmmirror registry 本身直连可达（curl 200）
- **Fix:** `npm install pdfjs-dist --noproxy="*" --no-proxy --proxy=null --https-proxy=null` 绕过失效代理直连 npmmirror
- **Commit:** 12b1758

## TDD Note (Task 2)

Task 2 标 `tdd="true"`，但 better-sqlite3 native binding 编译给 Electron(ABI 145)，plain Node(ABI 137) 无法运行 backupScheduler 运行时单测（依赖 `getDatabase()` / `BACKUPS_DIR()` 等运行时上下文）。计划 `<verify>` 与 `<action>` 明确指示以静态验证为准（tsc + esbuild + grep clamp）。RED/GREEN 用例无法在当前主工作树运行时执行——按计划豁免，静态三绿（tsc 0 / esbuild 0 / grep=1）作为验收门。无 TDD gate commit 生成（vitest 运行时被 native binding 阻塞）。

## Known Stubs

无。两项修复均落地真实逻辑，无占位/空数据流。

## Threat Flags

无新增计划外安全面。Task 2 实现 threat_model T-quick-01（Tampering mitigation）。T-quick-02（PDF DoS）/ T-quick-03（供应链）按计划 accept disposition，不在本次 quick 修复范围。

## Verification Results

| Check | Command | Result |
|-------|---------|--------|
| pdfjs 文件存在 | `test -f node_modules/pdfjs-dist/legacy/build/pdf.mjs` | FILE_OK |
| tsc 严格模式 | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 |
| esbuild external 解析 | `npm run build:electron-main` | exit 0 (1.8mb) |
| BUG-2 clamp 植入 | `grep -c "Math.max(1, retention)" electron/services/backupScheduler.ts` | 1 |

## Commits

| Task | Commit | Audit ID | Files |
|------|--------|----------|-------|
| Task 1 | 12b1758 | pdfjs-dist-missing | package.json, package-lock.json |
| Task 2 | ba06854 | BUG-2 | electron/services/backupScheduler.ts |

## Self-Check: PASSED
