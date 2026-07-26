---
quick_id: 260726-upa
slug: crypto-key-hardening
date: 2026-07-26
status: complete
---

# Summary: R2/R3 加密核心加固

## What

- **R2**（`crypto.ts` + `main.ts`）：decField 解密失败可观测层。保留单条坏密文降级返回 ''（不阻断 list 加载，设计意图不变），新增 `setDecryptFailureHandler` 注入式 handler + 60s 限流去重；`main.ts` 启动注入写 `system_log`（type=security, status=warning）实现。crypto.ts 零 DB 依赖（解耦 better-sqlite3，保持纯函数可单测）。
- **R3**（`keyManager.ts`）：明文回退路径加 `isValidMasterKey`（base64 32 字节）校验。safeStorage 翻转 + blob 无法解读时显式抛错（main.ts startup catch → dialog 提示从 backups 恢复），切断「DPAPI blob 当 UTF-8 明文 trim → 错误 masterKey → 与 decField 静默吞错叠加无声全库丢失」破坏路径。**向后兼容**：合法 safeStorage 加密 key + 历史明文 base64 key 仍可读。

## TDD

- **RED**：12 fail（setDecryptFailureHandler 未导出 + keyManager 不抛错 + 测试路径 bug：win32 path.join 反斜杠）
- **GREEN**：修测试路径 + 实现 → 过程中发现并修复 `lastDecryptFailNotify` 模块级状态在测试间泄漏（`setDecryptFailureHandler` 重设时重置窗口，既是测试修复也是合理语义）
- 新增 9 测试：crypto 6（v1/v2 IV 兼容、decField 降级/handler 触发/限流去重）+ keyManager 3（新建/明文回退/翻转抛错，mock electron+fs）

## Verify

- vitest **34/34** ✓（原 25 + 新 9）
- esbuild `build:electron-main` 1.8mb ✓（import 链通：setDecryptFailureHandler + createSystemLog）
- `tsc -p tsconfig.web.json --noEmit` exit 0 ✓
- 改动文件无新类型 error；electron 层既存 tsc error（arpCollector/backupScheduler/PDF destroy/bigint/rootDir）与本次无关，项目 electron 用 esbuild 打包、不走 tsc

## Deferred

- **BUG-3 before-quit**：经精读 `backupScheduler.executeTask` 的 `getDatabase().backup()` 是同步原子 API，before-quit 同步回调下不存在 in-flight 截断窗口。审计 medium 评级被高估，暂不改（CONCERNS 应标注此结论）。
- **R2/R3 运行时 HV**：真实 safeStorage 翻转场景、真实解密失败告警落 system_log 并在「系统日志页」展示——需真实 Electron 环境 human 验证（静态 + 单测已绿）。
