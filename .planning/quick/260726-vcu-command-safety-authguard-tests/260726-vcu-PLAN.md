---
quick_id: 260726-vcu
slug: command-safety-authguard-tests
date: 2026-07-26
status: complete
mode: quick
---

# Quick Task 260726-vcu: R5 安全核心单测收尾

## Task

补齐审计 R5 / TEST-1「安全核心零自动化回归」的最后两块：`commandSafety`（命令白名单）+ `authGuard sanitizeMessage`（IPC 异常脱敏）。R5 的 crypto v1/v2 + decField + keyManager 部分已在 260726-upa 完成。

## Tasks

### Task 1: `commandSafety.test.ts`（纯函数，14 case）
白名单首词严格相等、多命令分隔符（\n ; & ` $() && ||）注入拒绝、单管道 | 豁免（华为/Cisco `| include` 不误杀）、黑名单首词（reboot/configure/system-view/no 等）、case insensitive + trim、空命令、reason 字符串。

### Task 2: `authGuard.test.ts`（通过 secure/safe 间接测 sanitizeMessage，7 case）
secure 未登录 reject（在 try 之外不被脱敏覆盖）、Windows/Unix 绝对路径脱敏、>200 字符截断、空 message 兜底、safe 仅脱敏不鉴权。`sanitizeMessage` 未 export，通过 reject 的 message 间接验证（攻击面在此）。

## Verify

- vitest **55/55** ✓（原 34 + commandSafety 14 + authGuard 7）
- 纯函数 / 无 DB 依赖，符合项目测试惯例（CONCERNS TEST-1：DB/electron 依赖用 mock 规避）
