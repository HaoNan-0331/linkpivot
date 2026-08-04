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

## 待实机验证
用户设备「公司」华为 telnet，`display current-configuration` 应拿完整配置（接口/VLAN/路由）。若仍截断，下一步精确化 shellPrompt（区分「配置里的 # 段落分隔」与「prompt 的 hostname#」）。
