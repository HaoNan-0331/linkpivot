# Phase 3: Performance Optimization - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-28
**Phase:** 3-Performance Optimization
**Areas discussed:** OUI 缓存一致性 (PERF-01), ARP 事务失败语义 (PERF-02), FTS WHEN 覆盖范围 (PERF-03), init 优化路径 (PERF-04)

---

## 讨论流程总览

用户在 `present_gray_areas` 阶段对"4 个灰色地带选哪些深入讨论"的多选问题统一回复 **"你决定"**——全权委托 Claude 拍板（与 Phase 2 委托模式一致）。Claude 作为 thinking partner 基于 CodeGraph 全符号索引确认的代码现状 + PROJECT.md 约束 + 核心价值 + Phase 2 先例，对 4 个 area 逐一给出决策（D-P1~D-P4），经用户"认可,写 CONTEXT"确认后落盘。

---

## OUI 缓存一致性 (PERF-01)

| Option | Description | Selected |
|--------|-------------|----------|
| 增量同步 | 启动全量预载 Map<macPrefix,vendor>；5 个写方法（add/addBatch/update/delete/deleteBatch）写库成功后即时 set/delete Map entry，零脏读 | ✓ |
| 失效重载 | 写操作标记 dirty，下次 getIPDetails 或定时全量重载 Map | |

**User's choice:** "你决定"（委托 Claude）
**Claude 选定:** 增量同步（D-P1）
**Notes:** `getIPDetails` 是高频读路径必须零脏读；写点少且全集中在 `OUIService`，set/delete 是 O(1)。失效重载引入脏读窗口 + 重载时机复杂，收益更低风险更高。附带强制优雅降级（preload 失败回退查库路径）+ 修复 `getIPDetails:107` 双查 getVendor bug（N+1 翻倍放大）。

---

## ARP 事务失败语义 (PERF-02)

| Option | Description | Selected |
|--------|-------------|----------|
| 整批单事务 + 单条失败跳过继续 | 循环包一次 COMMIT；条目级 try/catch 保留，单条失败跳过不 abort 整批（保留现有"尽力而为"语义） | ✓ |
| 整批单事务 + 单条失败 abort 整批 | 严格一致性，任一条目失败回滚整批 | |

**User's choice:** "你决定"（委托 Claude）
**Claude 选定:** 单条失败跳过继续（D-P2）
**Notes:** PERF-02 目标是降低逐条提交开销，非改变异常语义。当前 recordChange/createBinding 已 try/catch 吞错（ARP 周期采集合理语义）。abort 整批会使原本可处理的条目被回滚阻断，违背向后兼容红线。better-sqlite3 transaction 下"单条跳过"须用条目级 try/catch 捕获（不冒泡触发 ROLLBACK）。附带消除 isIPExcluded 隐含 N+1（每行查 excluded_ips，预载 Set）+ 4 处 prepared statement 提到循环外复用。

---

## FTS WHEN 覆盖范围 (PERF-03)

| Option | Description | Selected |
|--------|-------------|----------|
| content + title + image_ids | WHEN 覆盖 FTS 索引全部来源字段，任一变化才重索引 | ✓ |
| 仅 content | 最小化 WHEN，仅 content 变化重索引 | |

**User's choice:** "你决定"（委托 Claude）
**Claude 选定:** content + title + image_ids（D-P3）
**Notes:** kb_chunks_fts 索引 title/content/image_desc。title/content 直接来自 kb_chunks 列；image_desc 由 image_ids 关联的 kb_images 决定。仅 content 会漏 title 改动。chunk_index/level/char_count 等变化不影响 FTS 内容，跳过是正确优化。已知限制：kb_images.description 跨表变化不触发 kb_chunks UPDATE（设计固有），本 phase 不修（避免 scope creep）。落地两处：init.ts:273 DDL（新装库）+ 新增 v7 迁移（现有库 DROP+CREATE，遵循 D-07/D-14），MIGRATION_HEAD 6→7。

---

## init 优化路径 (PERF-04)

| Option | Description | Selected |
|--------|-------------|----------|
| 幂等化加固 + 跳过可观测日志 | 现状已三重幂等跳过（IF NOT EXISTS / count>0 / user_version>=HEAD）；加固 + 加启动跳过日志使可观测；DDL/OUI seed 保持主线程同步 | ✓ |
| 移到 worker thread 异步化 | createTables/migrate 移到 worker_threads 独立连接，主线程异步等待 | |
| OUI seed 延迟加载 | seed data 延迟到首次需要时加载 | |

**User's choice:** "你决定"（委托 Claude）
**Claude 选定:** 幂等化加固 + 可观测日志（D-P4）
**Notes:** 代码现状分析——真正瓶颈是首次启动，二次启动已基本幂等。worker thread 收益有限（首屏硬依赖 DB 就绪，"异步"只是挪阻塞）且风险高（native ABI/IPC/生命周期），不符合核心价值（数据安全 > 启动毫秒）。OUI seed 的 count>0 是 data seed 的正确幂等判定，不强行版本化（避免混淆 data seed 与 schema migration）。核心硬指标：满足 success criteria"二次启动跳过日志可见"。

---

## Claude's Discretion

用户在全部 4 个 gray area 均回复"你决定"，全权委托 Claude 决策。D-P1~D-P4 由 Claude 依据代码现状、PROJECT.md 约束、核心价值、Phase 2 先例拍板。用户保留 `/gsd-plan-phase` 前审阅/修改权（已在 gate 确认环节行使——"认可,写 CONTEXT"）。

下游 researcher/planner 对纯实现细节（Map 封装、事务重构形式、v7 迁移写法、日志 type/字段、耗时测量方式）有自由度。

## Deferred Ideas

- `kb_images` 跨表反向触发器（让图片描述变化重索引 FTS image_desc）——超出 PERF-03 scope 的新能力
- init 移到 worker thread / utilityProcess——经分析收益有限风险高，幂等化方案优先；未来实测首次启动显著慢时再评估
- OUI seed 纳入 user_version 版本化——评估后判定 count>0 守卫对 data seed 正确，不强行版本化
- 冷启动性能基准测试套件——本 phase 仅 before/after 测量，持久化基准属未来增强
- 大数据 IPC 分页（oui:getAll/anomaly:getChanges 等）——明确属 Phase 4 (DATA-01)
