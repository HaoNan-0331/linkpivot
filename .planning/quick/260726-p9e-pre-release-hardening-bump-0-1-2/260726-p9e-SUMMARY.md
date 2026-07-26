---
phase: quick-260726-p9e
plan: 01
subsystem: electron-main, packaging
tags: [security, hardening, release, csp, shell-injection, asar-unpack]
requires:
  - "pre-release-audit verdict GO-WITH-FIXES（28 findings：0 critical / 1 high / 7 medium / 16 low）"
provides:
  - "openExternalSafe 共享函数（http/https 白名单统一门）"
  - "version 0.1.2 发版基线"
affects:
  - "electron/utils/webSecurity.ts"
  - "electron/main.ts"
  - "electron/services/connection.ts"
  - "electron-builder.yml"
  - "package.json / package-lock.json"
  - ".gitignore / CHANGELOG.md"
tech-stack:
  added: []
  patterns:
    - "openExternalSafe 统一外链白名单门（DRY，三处入口复用防漂移）"
    - "execFile + shell:false 取代 exec shell 拼接（与 acl.ts execFileSync 风格统一）"
    - "app.whenReady 链尾 .catch → dialog.showErrorBox + app.quit 启动期异常不卡渲染层"
    - "生产 CSP 收紧：connect-src 'self' + object-src 'none' + base-uri 'self' + frame-ancestors 'none'"
key-files:
  created: []
  modified:
    - "electron/utils/webSecurity.ts"
    - "electron/main.ts"
    - "electron/services/connection.ts"
    - "electron-builder.yml"
    - "package.json"
    - "package-lock.json"
    - ".gitignore"
    - "CHANGELOG.md"
decisions:
  - "H1 抽 openExternalSafe 共享函数（vs 三处各自实现白名单）— DRY 防漂移，未来加协议白名单单点改动"
  - "openWebSafe 改转发 openExternalSafe，Error 语义按 openExternalSafe 原协议错误透出（renderer 不依赖该文本分支，经 authGuard secure 异常脱敏后仅透通用消息，零行为回归）"
  - "CSP connect-src 去 https: 通配 — 渲染层无合法外联，AI/Vision 调用全在主进程 fetch 不经渲染层 CSP"
  - "openRDP 改 execFile + shell:false（vs 保留 exec）— device.id 为 UUID 无 shell 元字符，零行为变化但消除理论注入面"
  - "package-lock.json version 字段经 Edit 直改（npm install --package-lock-only 后台运行无输出疑似 registry 慢，按 environment_warnings 备用方案 Edit version 字段，等价达成 lockfile 同步）"
metrics:
  duration: "~12min"
  completed: "2026-07-26"
  tasks: 2
  files: 8
---

# quick-260726-p9e: pre-release hardening + version bump 0.1.2 Summary

pre-release-audit GO-WITH-FIXES 发版前必修 10 项（H1 + M1~M5 + L5 + L11 + L13 + L14）全部落地 + version 0.1.1 → 0.1.2，三绿门禁全过，发版基线干净。

## What Shipped

### Task 1（commit b6a689b）：H1+M1+M2+M5+L5 代码安全/健壮加固

- **H1 high·安全**：抽 `electron/utils/webSecurity.ts:openExternalSafe` 共享函数（URL 解析后仅放行 http/https，其余 deny）；`hardenWindow` setWindowOpenHandler / `main.ts:76` 全局 web-contents-created handler / `connection.ts:openWebSafe` 三处复用。grep 验收：`shell.openExternal` 在 main.ts/connection.ts 命中 0，在 webSecurity.ts 仅出现在 openExternalSafe 实现内（1 调用 + 1 注释，无漂移）。
- **M1 medium·安全**：生产 CSP 由 `connect-src 'self' https:` 收紧为 `connect-src 'self'`（去 https: 通配）；新增 `object-src 'none'`（禁插件 embed）+ `base-uri 'self'`（防 base 注入）+ `frame-ancestors 'none'`（防 clickjacking）。
- **M2 medium·健壮**：`app.whenReady().then(...)` 末尾加 `.catch((err) => { dialog.showErrorBox('启动失败', err.message); app.quit() })`，启动期 initDatabase/migrateAndSecure/createTables/OUIService.preload/IPC register 任意 throw 不再吞错卡渲染层 loading。
- **M5 medium·安全**：`connection.ts:openRDP` 由 `exec(\`mstsc "${tmpPath}"\`)` 改 `execFile('mstsc', [tmpPath], { shell: false })`，import 由 `exec` 改 `execFile`（grep 确认 exec 在本文件仅 openRDP 一处使用）。消除 shell 拼接注入面，与同文件 acl.ts:30 `execFileSync(shell:false)` 风格统一。device.id 为 UUID 零行为变化。
- **L5 low·健壮**：`main.ts` before-quit 的 `closeDatabase()` 包 try/catch + `console.error('[before-quit] closeDatabase failed')`，退出路径平稳不中断 WAL checkpoint。

### Task 2（commit 490c20f）：M3+M4+L11+L13+L14 + version bump 打包/发版配置

- **M3**：package.json `version` 0.1.1 → 0.1.2；CHANGELOG 顶部新增 `## [0.1.2] - 2026-07-26` 版本头（10 项必修 + 历史已落地修复归并 + 发版后迭代排除项）。
- **M4 medium·打包正确性**：`electron-builder.yml` asarUnpack 追加 `node_modules/telnet-client/**/*`，与 better-sqlite3/ssh2 同标准（原生编译依赖必须 unpack），修正 BUILD-01 决策与打包配置不一致。
- **L11 low·一致性**：package-lock.json 根 `version` + `packages[""].version` 同步 0.1.2（Edit 直改，见 decisions）。
- **L13 low·元数据**：package.json `author` `""` → `"wanghaonan"`。
- **L14 low·安全防御**：.gitignore 追加 `master.key / *.pem / *.pfx / *.p12 / *.key`，防误提交密钥/证书（CLAUDE.md GitHub 上传规范第一道防线）。

## Verification Results（三绿门禁全过）

| Gate | Command | Result |
|------|---------|--------|
| tsc web strict | `npx tsc -p tsconfig.web.json --noEmit` | EXIT 0 |
| esbuild 主进程打包 | `npx esbuild electron/{main,preload,terminal-preload}.ts electron/services/connection.ts electron/utils/webSecurity.ts --platform=node --format=cjs --bundle ...` | EXIT 0 |
| vitest | `npx vitest run` | 25/25 passed（4 test files） |

### Done criteria grep 断言逐条核验（全过）

- `shell.openExternal` 在 main.ts/connection.ts 命中 0，webSecurity.ts 仅 openExternalSafe 实现内 1 处（+1 注释）
- `execFile('mstsc'` 命中 connection.ts:392
- CSP 含 `connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
- whenReady 链尾 `.catch` 含 `dialog.showErrorBox` + `app.quit`（main.ts:190/193）
- before-quit 含 `[before-quit] closeDatabase failed`（main.ts:202）
- package.json version === '0.1.2'，author === 'wanghaonan'
- package-lock.json 根 version === '0.1.2'（root + packages[""]）
- electron-builder.yml asarUnpack 含 `node_modules/telnet-client/**/*`
- .gitignore 含 `master.key`
- CHANGELOG.md 含 `## [0.1.2] - 2026-07-26`

## Deviations from Plan

**1. [Rule 3 - Blocking issue] package-lock.json version 改 Edit 直改而非 npm install 输出**
- **Found during:** Task 2 L11
- **Issue:** `npm install --package-lock-only` 后台运行 3min+ 无 stdout 输出（疑似 registry 慢/代理问题），lockfile version 未被更新。
- **Fix:** 按 `<environment_warnings>` 显式备用方案，Edit 直改 package-lock.json 两个 version 字段（line 3 root `version` + line 9 `packages[""].version`，0.1.0 → 0.1.2），等价达成 lockfile 与 package.json 对齐目标。
- **Files modified:** package-lock.json（仅 version 字段，依赖树不动）
- **Commit:** 490c20f

无其他偏离。

## TDD Gate Compliance

本 plan `type: execute`（非 `type: tdd`），不强制 RED/GREEN/REFACTOR gate。两个 task 均为加固/配置类改动，无新行为可 TDD（openExternalSafe/openRDP/CSP/before-quit 均涉及 Electron 主进程原生 API，DEP-1 native binding 限制下无运行时单测覆盖，沿用项目惯例代码级 grep + tsc + esbuild + vitest 三绿门禁验收）。

## Known Stubs

无。本次改动均为现有函数的加固（白名单/异常处理/CSP/execFile）和配置元数据更新，无新增 UI 渲染路径或空数据流。

## Threat Flags

无新增 threat surface。本次改动是 plan `<threat_model>` 中已登记威胁（T-p9e-01 ~ T-p9e-07）的 mitigation 落地，未引入新网络端点/文件访问/信任边界。

## Self-Check: PASSED

- [x] electron/utils/webSecurity.ts（openExternalSafe 实现 + hardenWindow 复用）FOUND
- [x] electron/main.ts（CSP 收紧 + 全局 handler + whenReady .catch + before-quit try/catch）FOUND
- [x] electron/services/connection.ts（openWebSafe 转发 + openRDP execFile）FOUND
- [x] electron-builder.yml（telnet-client asarUnpack）FOUND
- [x] package.json（version 0.1.2 + author wanghaonan）FOUND
- [x] package-lock.json（version 0.1.2）FOUND
- [x] .gitignore（master.key 兜底）FOUND
- [x] CHANGELOG.md（[0.1.2] 版本头）FOUND
- [x] commit b6a689b（Task 1）FOUND
- [x] commit 490c20f（Task 2）FOUND

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | b6a689b | feat(quick-260726-p9e): pre-release 安全/健壮加固 H1+M1+M2+M5+L5 |
| 2 | 490c20f | chore(quick-260726-p9e): bump 0.1.2 + telnet-client asarUnpack + .gitignore 兜底 + CHANGELOG 版本头 |

## Deferred to Release HV（非本 quick 验证目标）

- asarUnpack 改动由 grep 验证配置正确性；实际打包验证（`npm run electron:build`）归发版 HV（耗时长，非本 quick 目标）。
- 渲染层无外联/启动期失败弹窗/UI 行为的人工 HV 归发版 HV（DEP-1 限制无前端自动化运行时测试）。

## 发版后迭代（本 quick 显式排除，归下一 milestone / 后续 quick）

M6/M7 渲染层 any（electron 服务层）、L7 db any、L10 复杂度、L1 弱 SSH 算法、L2 ai limit、L3 captcha、L4 Login、L6 authGuard、L8/L9 渲染层、L12 rebuild 锁定、L15 xterm、L16 ssh2 license。
