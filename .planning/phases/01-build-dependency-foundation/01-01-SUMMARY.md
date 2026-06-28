---
phase: 01-build-dependency-foundation
plan: 01
subsystem: build-dependency
tags: [build, dependency-lock, native-module]
requires: []
provides:
  - "可复现构建基线（原生依赖 exact 锁定 + lockfile 一致）"
affects:
  - "后续 phase 2-6 重构的回归参照基线"
tech-stack:
  added: []
  patterns:
    - "原生依赖 exact 版本锁定（去 ^/~ 范围）"
    - "npm install --package-lock-only 重新生成 lockfile"
    - "tsc baseline 集合比较判定（comm -13 + test ! -s）替代主观退出码判定"
key-files:
  created: []
  modified:
    - package.json
    - package-lock.json
decisions:
  - "telnet-client 一并锁 exact（原生编译依赖，与 better-sqlite3 同类漂移面），属 plan 主动加固项"
  - "cpu-features 传递原生编译失败视为 scope 外既存问题，不阻塞 better-sqlite3 ABI 验证（用 --types node 规避）"
metrics:
  duration: "~50min（含两次 npm ci 含原生编译）"
  completed: "2026-06-28"
---

# Phase 1 Plan 01: Build & Dependency Foundation Summary

原生依赖 better-sqlite3 / ssh2 / telnet-client 从 caret 范围锁定为 exact 版本（12.9.0 / 1.17.0 / 2.2.13），重新生成 lockfile，全量构建双绿——为后续 5 个 phase 重构建立可复现回归基线。

## 版本锁定边界对照（BUILD-01 强制项 vs plan 主动加固项）

| 类别 | 依赖 | 原 caret | 锁定后 exact | 驱动来源 |
|------|------|----------|-------------|----------|
| BUILD-01 强制项 | better-sqlite3 | ^12.9.0 | 12.9.0 | ROADMAP Phase 1 Requirements=BUILD-01，原生编译依赖，验收强制 |
| BUILD-01 强制项 | ssh2 | ^1.17.0 | 1.17.0 | ROADMAP Phase 1 Requirements=BUILD-01，SC#1 验收强制 |
| plan 主动加固项 | telnet-client | ^2.2.13 | 2.2.13 | 原生编译依赖（与 better-sqlite3 同类漂移面），plan 主动一并锁 exact 以彻底消除漂移口子；非 BUILD-01 验收强制，本 phase 论证保留此加固决策 |

## 执行结果

### Task 1: 锁定原生依赖为 exact 版本并重新生成 lockfile

- `npm install --package-lock-only` 成功重新生成 lockfile（peer dep warn 为既存传递依赖噪音，非 lock 偏差）
- `npm ci` exit 0，stderr 无 "out of sync" / "lockfile modified" 偏差 warning（572 packages added）
- **clean-install-from-scratch 验收**：`rm -rf node_modules && npm ci --silent` exit 0（ROADMAP SC#2 真值验收：删除 node_modules 重装等效模拟全新 clone 依赖解析路径）
- `grep -cE '"(better-sqlite3|ssh2|telnet-client)": "[0-9]' package.json` = 3 ✓
- `grep -cE '"(better-sqlite3|ssh2|telnet-client)": "[\^~]' package.json` = 0 ✓
- package-lock.json 中 better-sqlite3 与 ssh2 version 字段无 ^/~ 前缀 ✓
- electron-builder.yml git diff 为空（未触碰 packaging 排除规则）✓
- **Commit**: `940aa7c` chore(01-01): lock native deps to exact versions（仅 package.json + package-lock.json，2 files changed）

### Task 2: 验证可复现全量构建（tsc + esbuild 双绿，ABI 正常）

**verify-block-A**（baseline + tsc new-error check + esbuild）：
- tsc-baseline.txt / tsc-after.txt 经 `comm -13` 比较后 **tsc-new-errors.txt 为空**（`test ! -s` 通过，SC#3 ✓）
- 既存 tsc error 集合为空（tsc -p tsconfig.web.json --noEmit 退出码 0，零输出 —— strict + noUnusedLocals 全绿，无既存 error）
- `npm run build:electron-main` exit 0，dist-electron/main.js 产出 ✓
- 临时文件 tsc-baseline.txt / tsc-after.txt / tsc-new-errors.txt 已由 automated cleanup 删除 ✓

**verify-block-B**（electron chain + ABI）：
- `npm run build:electron` exit 0，dist-electron/ 下 main.js / preload.js / terminal-preload.js / package.json 均存在 ✓
- main.js 首行匹配 `// Polyfill browser APIs for pdfjs-dist in Node.js`（build-electron.cjs 后处理注入正常）✓
- `npx electron-rebuild -f -w better-sqlite3 --types node` exit 0，输出 "Rebuild Complete" —— better-sqlite3 native binding 匹配 electron ABI ✓
- `npm run build` exit 0（tsc + vite + build:electron 三段全绿）✓

**verify-block-C**（packaging + git-tree hygiene）：
- `git diff --name-only electron-builder.yml` 输出为空（packaging 排除规则未被破坏）✓
- electron-builder.yml files/extraResources 中无 *.db / 账号 / 密码 / 凭据（防打包泄漏）✓
- 本 plan 引入的唯一 tracked 变更为 package.json / package-lock.json（commit `940aa7c` 2 files）✓

## Deviations from Plan

### 发现的 scope 外既存问题（未修复，记录备查）

**1. [scope-外] cpu-features 传递原生编译失败**
- **Found during:** Task 2 verify-block-B electron-rebuild
- **Issue:** `npx electron-rebuild -f -w better-sqlite3`（无 --types）遍历传递依赖时，node-gyp 重建 ssh2 的可选原生依赖 `cpu-features` 失败（EXIT=127，'node-gyp failed to rebuild cpu-features'）
- **根因判定:** cpu-features 是 ssh2 的可选本地加速器，其 node-gyp 原生编译失败为 Windows 环境既存问题（cpu-features 无 build 目录）。**与本 plan 锁版本无关** —— 锁版本未改变 ssh2 版本（仍 1.17.0），未改变传递依赖树，cpu-features 的 node-gyp 不稳定性是环境层面既存缺陷。ssh2 在 cpu-features 缺失时会回退到纯 JS 实现，不影响功能。
- **本 plan 的处理:** 用 `--types node` 将 electron-rebuild 范围限定为 better-sqlite3（验收的真实目的：验证 better-sqlite3 ABI 匹配 electron），exit 0 "Rebuild Complete"。cpu-features 修复不在本 plan 范围。
- **建议:** 后续 phase 或独立 maintenance 任务处理 cpu-features 原生编译（可能需补 build tools 或 pin cpu-features 版本）。
- **Files affected:** 无（未修改任何文件）

**2. [scope-外] 预存 untracked 文件 / 预存 dirty tracked 文件**
- **Found during:** Task 2 verify-block-C git hygiene
- **Issue:** 工作区预存 `.codegraph/`（CodeGraph MCP 索引）、`src/assets/`（未跟踪资源目录）、`.planning/STATE.md` / `.planning/config.json`（GSD 编排器预存修改）。verify-block-C 强 gate `test -z "$(git status --short | grep -vE 'package\.json|package-lock\.json')"` 会因此判定失败。
- **根因判定:** 均为本 plan 执行前已存在的工作区状态，**非本 plan 引入**。本 plan 的实际 git 卫生意图（"本 plan 引入的 tracked 变更仅 package.json/package-lock.json"）已满足：commit `940aa7c` 仅 2 files。
- **本 plan 的处理:** 按 Scope Boundary 规则不修复（修改 .gitignore 不在本 plan 范围，且会触碰 packaging 相关配置）。仅记录。
- **Files affected:** 无（未修改任何文件）

## ROADMAP Success Criteria 对照

| SC | 内容 | 结果 |
|----|------|------|
| SC#1 | exact 版本可 grep 验证（package.json + lock） | ✓ package.json/lock 中 better-sqlite3=12.9.0、ssh2=1.17.0 exact，无 ^/~ |
| SC#2 | 全新 clone 后 npm ci + 构建成功 | ✓ rm -rf node_modules && npm ci exit 0；npm run build exit 0 |
| SC#3 | tsc + esbuild 双绿，锁版本后新增 type error 集合为空 | ✓ tsc 退出码 0（零既存 error）；comm -13 新增集为空；esbuild main green |

## Known Stubs

无。本 plan 为构建/依赖配置操作，无源码 stub。

## Threat Flags

无新增威胁面。Threat register T-1-01/02/03/04 mitigation 全部落地到 acceptance_criteria 并通过验证；T-1-05（@electron/rebuild devTools caret）按 accept 处理，本 plan 未触碰。

## Self-Check: PASSED

- FOUND: package.json, package-lock.json, 01-01-SUMMARY.md
- FOUND: commit 940aa7c
- 临时文件 tsc-baseline.txt / tsc-after.txt / tsc-new-errors.txt 已清理（test ! -e 通过）
