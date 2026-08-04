---
status: complete
quick_id: 260804-t2q
slug: fix-telnet-long-output-pagination-trunca
date: 2026-08-04
---

# Quick Task 260804-t2q: 修 telnet 长输出分页截断

## 问题
ai-telnet-exec-routing debug（commit 8df4166）修了 AI 执行命令按 connectionType 分流（telnet 能连），但用户实机验证发现 `display current-configuration`（华为长输出）只返回第一屏（版本 + sysname + 开头），接口/VLAN/路由全丢。

## Root Cause
`electron/utils/telnetExec.ts executeTelnetCommand` 直接 `connection.exec(command)`，`shellPrompt /[>#]/`，无分页处理。华为长输出默认 `---- More ----` 分页，telnet-client exec 不自动翻页 → 设备在第一屏暂停 → 数据流静默 → exec 误判命令结束 → 截断第一屏。arpCollector 用短命令（display arp all）未暴露。

## Fix（最小变量，先治主因）
exec 真命令前先发「关闭分页」命令（运维自动化标准做法）：
- `telnetExec.ts`：`TelnetExecOptions` 加 `disablePaginationCmd?: string`；connect 后若提供则先 `connection.exec(disablePaginationCmd)`（try/catch 忽略输出与不支持错误，不阻断主命令）
- `ai.ts`：加 `pickDisablePaginationCmd(vendor)` helper（cisco/锐捷 → `terminal length 0`，华为/H3C/默认 → `screen-length 0 temporary`）；`executeCommandsOnDevice` telnet 分支（runOne 外算一次）传入
- `arpCollector` 不传（短输出保持原行为）

`shellPrompt /[>#]/` 暂不动（systematic-debugging Phase 3 一次一变量），先修分页主因，实机验证后若仍截断再精确化 prompt。

## 改动文件
- `electron/utils/telnetExec.ts` — TelnetExecOptions 加 disablePaginationCmd + connect 后 exec 该命令
- `electron/services/ai.ts` — pickDisablePaginationCmd helper + telnet 分支传 disablePaginationCmd
- `electron/services/ai.telnetRouting.test.ts` — 补 2 case（华为/思科 vendor 选对分页命令）

## 验证（三绿门禁）
- `tsc -p tsconfig.web.json --noEmit` exit 0
- `npm run build:electron-main` exit 0（dist-electron/main.js 1.9mb）
- `npx vitest run` **174 passed**（原 172 + 新 2，无回归）

## 安全
`screen-length 0 temporary` / `terminal length 0` 是只读会话级配置命令（仅本 telnet 会话关分页，退出恢复），util 内部发不经 AI 命令白名单（与 arpCollector 直接发 getARPCommand 同模式）。

## 实机验证（第一轮分页修复后仍截断 → 源码取证）

实机验证发现 `display current-configuration` 仍截断（只第一屏）。加临时诊断日志取证，**推翻分页假设**：`hasMore=false`（screen-length 0 temporary 已生效，无 `---- More ----`），不是分页问题。

**第二轮源码取证锁定真因**（telnet-client `index.js:394`）：exec 在**累积 buffer** 里 `search(shellPrompt)`，`/[>#]/` 在华为配置裸 `#` 段落分隔处 `promptIndex>=0` → 提前 resolve → **跳过 pageSeparator 自动翻页分支**（翻页只在 `promptIndex<0` 时触发）→ 截断第一屏。叠加 `newlineReplace: true` bug（`response.join(true)` 把布尔转字符串 `"true"` 当分隔符，`index.js:232`）。

## 第二轮修复（commit 913aade，截断真因）

1. **shellPrompt 按 vendor 精确化**：华为/H3C `/(<[^>]+>|\[[^\]]+\])/` 只匹配 `<host>`/`[host]` 真实 prompt 不匹配裸 `#`；思科/锐捷 `/\S[>#]/`；**未知 vendor 通用兜底** `/(<[^>]+>|\[[^\]]+\]|\S[>#])/` 覆盖所有主流 prompt 格式（换设备/换厂商自动适配）
2. **去掉 `newlineReplace: true`**（fallback `'\n'`）
3. `telnetExec` 加 `shellPrompt` 选项；`ai.ts` `pickShellPrompt` helper；test 补华为/思科/default 通用 shellPrompt 行为断言

实机验证：`display current-configuration` **完整返回**（接口/VLAN/路由/aaa 齐全）。vitest 175 全绿。

## 两轮修复的关系
- 第一轮（`534fdc9`）`disablePaginationCmd`：关分页减少翻页往返（screen-length 生效验证），**保留**——性能优化 + 设备不支持 screen-length 时让 pageSeparator 自动翻页接管
- 第二轮（`913aade`）shellPrompt 精确化 + 去 newlineReplace bug：**截断真因，必装**

## 教训
第一轮基于「分页」假设盲改（违反 systematic-debugging root cause first），实测失败后才源码取证找到 shellPrompt 真因。诊断日志（临时 instrumentation）是区分假设的关键——`hasMore=false` 一行数据推翻了分页假设。
