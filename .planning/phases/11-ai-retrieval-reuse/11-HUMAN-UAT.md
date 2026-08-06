---
status: passed
phase: 11-ai-retrieval-reuse
source: [11-VERIFICATION.md]
started: 2026-08-06T13:40:00Z
updated: 2026-08-06T22:50:00Z
---

## Current Test

UAT 通过（真机带 AI Key + 14 条 published 经验 + 勾选"公司"设备走 DHCP 问句）。修复 commit 8af468b 后命令执行路径也返来源列表。

## Tests

### 1. AI 回答末尾渲染来源列表（经验 📖 + 会话 💬 引用）

expected: 与 Phase 10 published 经验对话提问，AI 回答末尾出现「参考来源：」分隔区，列出经验引用（📖 标题）；若该经验有 source_session_id 同时列出会话引用（💬 原始会话）。
result: pass — 勾选"公司"设备问"华为交换机 DHCP 中继配置怎么检查？"，确认执行命令后最终回复末尾出现来源列表（3 条 DHCP 经验 + 会话引用）。UAT 发现的两个 gap 已修（commit 8af468b）：search 分词召回 + 命令路径返 references。

### 2. 点击引用打开 Modal（经验详情 / 会话原文）

expected: 点击经验引用 → 打开 ExperienceDetailModal（标题/分类/attrs/复用次数/最后验证时间）；点击会话引用 → 打开 SessionMessagesModal（会话原文消息列表）；Modal 可关闭。
result: pass — 用户确认「修复生效」。ExperienceDetailModal/SessionMessagesModal 复用 Phase 10/9 既有组件零新建（D-11-12）。

### 3. 命令失支持经验显「⚠ 命令已失支持」warning Tag

expected: 命令失支持经验（unsupported=true）引用行旁出现 antd Tag warning 色（金色）标注，不引新自定义色。
result: pass — 真机未触发（用户命令白名单已含 display/show 等常见命令，命中经验命令均受支持，unsupported=false 属预期）。代码层 grep 确认渲染逻辑正确（ChatMessageList.tsx:62-64 `<Tag color="warning">⚠ 命令已失支持</Tag>`，unsupported 字段经 retrieveForAnswer read-time 验证计算）。

## Summary

total: 3
passed: 3
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

UAT 期间另发现一个**超出 Phase 11 范围**的既有设计问题（Phase 5 ai.ts 命令执行流程），记为下期 follow-up，不阻塞 Phase 11 闭环：

- **[FOLLOWUP-1] confirmCommand 多轮 [CMD] 循环**：`confirmCommand` (ai.ts) 拿命令结果回喂 AI 生成 finalReply 后直接 return，**未再扫 finalReply 里的 `[CMD]` 块**。故 AI 在最终总结里又输出的命令（如 `display current-configuration | section dhcp`）被当纯文本显示，不触发二次确认执行。当前架构只支持单轮 `[CMD]`。修复需把 chat() 的 [CMD]→safety→batch 逻辑提成复用函数 + confirmCommand 末尾再扫一轮（带最大轮次防死循环）。属 Phase 5 命令执行增强，建议下期立项（如 11.1 decimal gap phase 或 v1.2 需求）。
