# Phase 12 Discussion Log

**Phase:** 12 — Test Infrastructure (DEP-1 ABI 缓解)
**Date:** 2026-08-07
**Mode:** 轻量 discuss（skip 正式多轮讨论，gray areas 交 researcher/planner）

## 背景

Phase 12 为纯测试基础设施（DEP-1 ABI 缓解）。discuss-phase 分析判定：gray areas（electron-vite 集成幅度 / CI 扩展 / 测试迁移策略 / 句柄检测机制）均偏技术实现（HOW），按 discuss-phase 哲学（用户定 vision/方向，技术实现交 researcher/planner）应交下游。

## 用户决策

1. **确认做 Phase 12**（理解 DEP-1 问题 + 做与不做区别后，决定做）
2. **选方案 A**：skip 正式 discuss，技术方案交 researcher/planner；方向约束记入 CONTEXT.md 作锚

## 锁定约束（写入 12-CONTEXT.md `<decisions>`）

- 不改生产代码路径（SC4 红线）
- 三红线（IPC 鉴权 / 字段加密 / commandSafety）不可回退
- 渐进保留现有 mock 测试（16/244），真路径并行新增，不搞全量替换
- 句柄自动化要覆盖 Phase 6 SC#4 + Phase 3 defer 的人工 HV

## Deferred（交下游）

- electron-vite 集成幅度 → researcher 调研推荐
- 句柄检测机制 → researcher 调研
- CI 扩展 → planner 评估，plan review 时用户定
- 测试用例优先级 → planner 基于 SC 定

## 下一步

`/gsd:plan-phase 12 --research` — researcher 调研 electron-vite 集成 + 句柄检测方案，planner 出 PLAN，用户 review。
