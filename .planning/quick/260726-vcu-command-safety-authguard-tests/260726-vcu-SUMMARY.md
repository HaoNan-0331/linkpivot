---
quick_id: 260726-vcu
slug: command-safety-authguard-tests
date: 2026-07-26
status: complete
---

# Summary: R5 安全核心单测收尾

## What

补齐审计 R5/TEST-1「安全核心零自动化回归」的最后两块：

- **commandSafety.test.ts（14 case）**：白名单严格相等（非前缀子串）、多命令分隔符（`\n ; & ` ` $() && ||`）注入拒绝、单管道 `|` 豁免（华为/Cisco `| include` 只读过滤不误杀）、黑名单首词（reboot/configure/system-view/no 等）、case insensitive + trim、空命令、reason 字符串。
- **authGuard.test.ts（7 case）**：secure 未登录 reject（在 try 之外，不被脱敏覆盖）、Windows/Unix 绝对路径脱敏、>200 字符截断、空 message 兜底「操作失败」、safe 仅脱敏不鉴权。`sanitizeMessage` 未 export，通过 secure/safe reject 的 message 间接验证（攻击面在 reject message）。

## 安全回归网现状（R5 完整闭环）

| 模块 | 覆盖 | 来源 |
|------|------|------|
| commandSafety 白名单 | ✓ 14 case | 本 task |
| authGuard sanitizeMessage/secure/safe | ✓ 7 case | 本 task |
| crypto v1/v2 IV 兼容 + decField 可观测 | ✓ 6 case | 260726-upa |
| keyManager 翻转抛错 | ✓ 3 case | 260726-upa |

未来 commandSafety 改一行白名单 / sanitizeMessage 改脱敏规则 / 加密兼容调整，有自动化测试拦截回归。

## Verify

- vitest **55/55** ✓（原 34 + 新 21）
- 纯函数 / 无 DB 依赖，符合项目测试惯例

## 仍缺（非本次 scope）

- 前端组件测试（0 覆盖，非安全核心，后续技术债）
- better-sqlite3 DB 层（DEP-1 native binding 限制，用 mock 规避，非纯函数难补）
