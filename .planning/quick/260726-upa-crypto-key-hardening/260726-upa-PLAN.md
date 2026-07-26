---
quick_id: 260726-upa
slug: crypto-key-hardening
date: 2026-07-26
status: complete
mode: quick
---

# Quick Task 260726-upa: R2/R3 加密核心加固（TDD）

## Task

修复 doc-code 审计（`.planning/audits/2026-07-26-doc-code-audit.md`）确认的 2 条加密高风险，向后兼容：

- **R2** `crypto.ts:93-102` decField 静默吞所有解密失败 → 加可观测层
- **R3** `keyManager.ts:18-38` safeStorage 翻转把 DPAPI blob 当明文 masterKey → 明文回退加校验

BUG-3（before-quit）**暂缓**：经精读 `backupScheduler.executeTask` 内 `getDatabase().backup()` 是 better-sqlite3 同步原子 API，before-quit 同步回调下不存在 in-flight 截断窗口，审计 medium 评级被高估。

## Tasks

### Task 1: TDD 测试（RED→GREEN）
- `crypto.test.ts` +6 case：v1 legacy IV / v2 IV 兼容、decField 坏密文降级、handler 触发、限流去重
- `keyManager.test.ts` 新建 +3 case：新建 key / 明文回退 / safeStorage 翻转抛错（mock electron+fs）

### Task 2: R2 实现
- `crypto.ts`：`setDecryptFailureHandler` 注入式 handler + 60s 限流去重；crypto.ts 不 import services（零 DB 依赖，保持可单测）
- `main.ts`：启动注入写 system_log（type=security, status=warning）的 handler

### Task 3: R3 实现
- `keyManager.ts`：`isValidMasterKey`（base64 32 字节）+ `getOrCreateMasterKey` 三路径编排，翻转时显式抛错

## Verify

- vitest 34/34 ✓（原 25 + 新 9）
- esbuild build:electron-main 1.8mb ✓
- tsc -p tsconfig.web.json --noEmit exit 0 ✓
- 改动文件（main/crypto/keyManager）无新类型 error；electron 既存 tsc error 与本次无关，项目 electron 用 esbuild 不走 tsc
