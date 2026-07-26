---
quick_id: 260726-udg
slug: doc-code-audit
date: 2026-07-26
status: complete
---

# Summary: 落盘 doc-code 一致性审计报告

## What

将 14 维度 doc-code 一致性 workflow 审计（Run `wf_45eb3743-5a2`，121 发现 / 0 误报 / 85 doc-drift + 36 risk）落盘为 `.planning/audits/2026-07-26-doc-code-audit.md`，作为后续 milestone 规划、`/gsd-docs-update` 文档同步、高风险代码修复的统一依据。

## Key correction

原报告 R1「SSH 未强制密钥认证（4 处密码兜底）」**经用户澄清降级撤销**：CLAUDE.md 的 SSH 密钥约束针对的是 Claude Code 本地连接设备的操作规范，不是 network_toplogy 产品功能约束；项目支持密码+密钥双通道是正确产品行为，代码保持现状。衍生 1 个文档措辞项（CLAUDE.md Constraints.Security 易误导需澄清），已写入 memory `ssh-constraint-scope.md`。

## Artifacts

- `.planning/audits/2026-07-26-doc-code-audit.md`（主报告，8 章节）

## Confirmed real risks (后续处理)

- **R2** `crypto.ts:93-102` decField 静默吞解密失败 → 历史密文无声变空
- **R3** `keyManager.ts:18-38` safeStorage 翻转把 DPAPI blob 当明文 masterKey
- **R4** STATE.md vs 03/06-VERIFICATION.md 严重不一致（governance）
- **R5** 安全核心 commandSafety/authGuard/crypto v1-v2 零单测
- **BUG-3** `main.ts:199-203` before-quit 不等 in-flight backup（未闭环数据 bug）

## Next

按报告 §7 推荐行动：P0 修 R2/R3/BUG-3 → P1 安全/测试/构建/governance → P2 `/gsd-docs-update` 批量同步 85 条 doc-drift → P3 技术债。
