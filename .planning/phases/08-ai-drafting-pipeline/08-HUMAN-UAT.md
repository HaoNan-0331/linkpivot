---
status: partial
phase: 08-ai-drafting-pipeline
source: [08-VERIFICATION.md]
started: 2026-08-02T13:51:20Z
updated: 2026-08-02T13:51:20Z
---

## Current Test

[awaiting human testing — 代码层 5/5 SC 全 VERIFIED（见 08-VERIFICATION.md），以下 4 项需 live LLM + Electron 手动复核]

## Tests

### 1. 真实 LLM 端到端起草（PII 脱敏 + 反幻觉 + 落库）
expected: 配置真实 AI 服务后，在 AI 对话窗进行含凭证/IP/MAC 的设备排障对话（如「password is hunter2」「网关 192.168.1.1」「MAC AA:BB:CC:DD:EE:FF」），点「经验总结」→ AI 回顾会话产出 1~N 条 draft 草稿入库（status=draft）；落库草稿 content 不含 [CMD]/[KB_SEARCH] 执行标记；main 进程日志/调试确认送 LLM 的会话正文中凭证已全脱敏（password is ****）、IPv4/MAC 保留尾4。
result: [pending]

### 2. 无可总结不强产（SC1）
expected: 纯闲聊会话（无可提炼的运维经验）点「经验总结」→ UI 弹 message.info「该会话无可总结经验」，experiences 表无新增 draft 条目（不强产空草稿）。
result: [pending]

### 3. UPDATE 标注命中（SC3 + B-2 原子）
expected: 对同分类已有存量的设备排障会话点「经验总结」→ AI 复判判 UPDATE 的草稿落库后，experiences.duplicate_of_exp_id 列写入命中的旧 exp_id（单语句原子，标注与 draft 行共存亡）；NOOP 草稿不落库（noop[] 提示）。
result: [pending]

### 4. 限流/失败/重试 + 断点续传（SC5）
expected: 断网或 AI 限流时点「经验总结」→ 错误经 secure 脱敏透出 renderer（message.error，不含敏感细节）；恢复后对同一 session 再次点「经验总结」→ 追加生成独立 draft 行（uuid 不同、source_session_id 相同），不覆盖既有草稿。
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
