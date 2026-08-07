---
phase: quick
plan: 260807-fzd
subsystem: dead-code-cleanup
tags: [dead-code, refactor, devdep-cleanup]
requires:
  - .planning/audits/2026-08-07-health-audit.md §2.1
provides:
  - 删除 vendor-commands.ts 整文件
  - 删除 ai.ts singular executeCommandOnDevice wrapper
  - 删除 package.json devDependencies @types/uuid
affects: []
tech-stack:
  added: []
  patterns:
    - "纯删除任务零回归门禁验证（tsc noUnusedLocals + vitest 232 + esbuild main + vite build 四绿门禁）"
key-files:
  created: []
  modified:
    - electron/services/ai.ts
    - package.json
    - CHANGELOG.md
  deleted:
    - electron/services/vendor-commands.ts
decisions:
  - 复数 executeCommandsOnDevice 零改动保留（discovery.ts:202 + ai.ts:613/964 + telnetRouting.test.ts 在用），仅删单数零 caller wrapper
  - uuid 运行时依赖 ^14.0.0 保留（10 处 from 'uuid' import），仅删旁路 @types/uuid devDep（uuid v14+ 自带类型）
metrics:
  duration: ~3min
  tasks: 3
  files: 4（1 delete + 3 modify）
  completed: 2026-08-07
---

# Quick 260807-fzd: Dead Code 清理（vendor-commands.ts + ai.ts singular wrapper + @types/uuid）

清理体检报告 §2.1 标记的三项零引用死代码（codegraph_callers=0 + grep 双验证零引用，planner 又独立甄别过）。纯删除任务，不引入新代码，三红线（IPC 鉴权 / 字段加密 / commandSafety）零触碰。

## What Was Done

### Task 1: 删 vendor-commands.ts 整文件 + ai.ts 单数 wrapper

- **删除对象（CLAUDE.md 删除红线，执行前显式列出）**：
  - `electron/services/vendor-commands.ts`（47 行整文件，3 export：`Vendor` type / `detectVendor` / `getDiscoveryCommands`）— codegraph_callers 全 0，全项目 0 import；CHANGELOG:239 记载 v1.0 discovery.ts 重写已移除该依赖
  - `electron/services/ai.ts:516-522` 的 `executeCommandOnDevice`（单数 wrapper，7 行含空行）— codegraph_callers=0，grep 全仓仅命中自身定义 + CHANGELOG/docs/计划文档
- **不删（误判排除）**：复数 `executeCommandsOnDevice`（ai.ts:324）— discovery.ts:202 + ai.ts:613/964 + telnetRouting.test.ts 实际调用的活跃函数，保留零改动
- **执行**：`git rm vendor-commands.ts` + Edit ai.ts 删 516-522 段
- **验证**：`vendor-commands.ts` 不存在；ai.ts grep `executeCommandOnDevice`（排除复数）零命中；复数 324/613/964 行零改动
- **Commit**: `0bd4dbd`

### Task 2: 删 package.json @types/uuid devDep

- **删除对象**：`package.json` devDependencies 一行 `"@types/uuid": "^10.0.0"`
- **不删（运行时依赖保留）**：`dependencies.uuid ^14.0.0`（10 处 `import { v4 as uuidv4 } from 'uuid'`）；uuid v14+ 自带 TypeScript 类型，旁路 @types 包冗余，全项目 0 处 `from '@types/uuid'`
- **执行**：Edit package.json 删该行
- **验证**：`node -e` 断言 devDependencies 无 @types/uuid 且 dependencies.uuid 保留，JSON 可解析
- **Commit**: `287e26c`

### Task 3: 四绿门禁验证 + CHANGELOG 更新

- **四绿门禁全绿零回归**：
  1. `npx tsc -p tsconfig.web.json`（strict + noUnusedLocals）— exit 0
  2. `npx vitest run` — 232 passed / 232（16 test files），零回归
  3. `npm run build:electron-main`（esbuild main bundle）— dist-electron/main.js 1.9mb，57ms
  4. `npx vite build`（renderer）— 3245 modules transformed，1.32s
- **CHANGELOG.md** 顶部新增 dead code 清理条目（2026-08-07，三项删除 + 四绿门禁 + 证据引用），沿用既有 `## YYYY-MM-DD type(scope): summary` 风格
- **Commit**: `d3f5e08`

## Verification Results

| Gate | Command | Result |
|------|---------|--------|
| 1 | `npx tsc -p tsconfig.web.json` | PASS (strict + noUnusedLocals) |
| 2 | `npx vitest run` | PASS 232/232 (zero regression) |
| 3 | `npm run build:electron-main` | PASS (esbuild main 1.9mb) |
| 4 | `npx vite build` | PASS (renderer, 3245 modules) |

## Red Line Check（三不可回退红线）

- **IPC 鉴权网关（secure/safe）**：零触碰（本任务不涉及 IPC handler）
- **字段加密（_enc/encField/decField）**：零触碰（本任务不涉及加密列读写）
- **commandSafety.isCommandAllowed**：零触碰（本任务不涉及命令执行路径）

## Deviations from Plan

None — plan executed exactly as written. 三处删除均按 PLAN 描述精确执行，未触发 Rule 1-4 任何分支。

## Self-Check: PASSED

**Files**:
- FOUND: `electron/services/ai.ts`（singular wrapper 删除，复数 324 行保留）
- MISSING（预期）: `electron/services/vendor-commands.ts`（已删）
- FOUND: `package.json`（@types/uuid 删除，uuid 保留）
- FOUND: `CHANGELOG.md`（新增 2026-08-07 dead code 条目）

**Commits**:
- FOUND: `0bd4dbd` refactor(quick-260807-fzd): remove dead code — vendor-commands.ts + ai.ts singular executeCommandOnDevice
- FOUND: `287e26c` chore(quick-260807-fzd): remove dead @types/uuid devDep
- FOUND: `d3f5e08` docs(quick-260807-fzd): CHANGELOG 记录 dead code 清理

**Four green gates**: 全绿（tsc + vitest 232/232 + build:electron-main + vite build）

**Three red lines**: 零触碰（IPC 鉴权 / 字段加密 / commandSafety）

## Notes for Orchestrator

- 三个 commit 均为 code/docs 改动，未 commit SUMMARY/STATE/PLAN（按 constraints，orchestrator Step 8 统一 commit docs）
- 未追踪文件 `.planning/audits/2026-08-07-health-audit.md` + `.planning/quick/260807-fzd-.../` 由 orchestrator 处理
- 未更新 ROADMAP.md（quick task 与 phase 分离，按 constraints）
- vite build 的 chunk-size warning（vendor-antd 1.1mb）是预存 advisory，体检报告 §1.3 已列，非本次回归，out of scope
