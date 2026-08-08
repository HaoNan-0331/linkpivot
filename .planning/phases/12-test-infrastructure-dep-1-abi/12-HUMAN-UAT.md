---
status: partial
phase: 12-test-infrastructure-dep-1-abi
source: [12-VERIFICATION.md]
started: 2026-08-08T05:25:00Z
updated: 2026-08-08T05:25:00Z
---

## Current Test

 awaiting human testing —— GHA 实跑（SC2 CI 侧 defer）+ CR-01 质量修复决策

自动化验证已全绿（4/4 must-haves SC1-4 VERIFIED，TEST-01/02 SATISFIED，三绿门禁实测通过）。以下 3 项需人工/外部环境（GHA）确认，非 goal 阻塞。

## Tests

### 1. GHA windows-latest 实跑 build-smoke workflow（SC2 之 CI 侧 defer）

expected: push 到 master 或开 PR 触发 build-smoke.yml —— test:electron step 绿（22 it 通过）+ npm test（rebuild 前）绿（244 通过）+ verify native binding step 绿；CI 总时长增量 +30~60s；无 xvfb/antivirus 问题

result: [pending]

### 2. CR-03 ssh2 cpu-features ABI mismatch 风险（GHA 实跑时确认）

expected: GHA 实跑时 test:electron step 不出现 NODE_MODULE_VERSION 或 cpu-features 加载错误（rebuild:native 的 -w ssh2 不递归到 cpu-features dependency，windows-latest 上 ssh2 native 路径加载成功）

result: [pending]

### 3. CR-01 handleLeakDetector baseline 跨 it 共享（防御性质量缺陷）

expected: 确认跨 it 累积泄漏检测准确性 —— 若未来引入跨多个 it 的真实累积泄漏，检测器仍能 fail；或采纳 code review 建议把 baseline 移到 beforeEach（建议交 /gsd:code-review 12 --fix）

result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
