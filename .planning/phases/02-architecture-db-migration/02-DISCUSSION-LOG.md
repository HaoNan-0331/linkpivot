# Phase 2: Architecture & DB Migration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-28
**Phase:** 2-Architecture & DB Migration
**Mode:** discuss（无 --power/--auto/--chain 等标志；ADVISOR 模式关闭）
**Areas discussed:** 备份策略、迁移前安全网、ACL 收紧范围与时机、遗留库版本化

---

## 选择入口（Gray Area 选择）

呈现 4 个 gray area 供用户勾选深聊。用户未逐项选择，而是通过 "Other" 全权委托：

| 选项 | 描述 | Selected |
|--------|-------------|----------|
| 备份策略 | 定时 .backup() 触发时机/保留/位置 | |
| 迁移前安全网 | 迁移前自动备份 + 失败处理 | |
| ACL 收紧范围与时机 | 保护文件/强制时机/遗留处理/跨平台 | |
| 遗留库版本戳 | stamp vs 幂等重跑 | |
| **（Other）用户全权委托** | "直接按照你认为对项目的最优解执行" | ✓ |

**User's choice:** 全权委托 Claude 按"对项目最优"原则对 4 个 gray area 逐一拍板，不再逐一追问。
**Notes:** 用户依据 CLAUDE.md "所有项目只考虑对项目最优秀的方案，不考虑 token 成本" 的原则，将实现决策权下放。Claude 依据代码现状（SchedulerService/init.ts/connection.ts）、PROJECT.md 约束（向后兼容/打包红线/WAL）、核心价值（数据安全可控）做出决策，记录于 CONTEXT.md，用户保留 plan-phase 前审阅/修改权。

---

## 备份策略

| Option | Description | Selected |
|--------|-------------|----------|
| 单一定时备份 | 仅周期调度 | |
| **双触发 + 双桶** | 定时周期桶(7) + 迁移前桶(5) + 启动补跑 | ✓ |
| 启动即备份 | 每次 app start 一份（无轮换） | |

**Notes:** 选双触发双桶——定时满足 Success Criteria #3，迁移前备份服务数据安全，双桶防止迁移恢复点被高频周期备份挤掉。格式用 `db.backup()` 保证 WAL 一致性，不裸拷文件。

---

## 迁移前安全网

| Option | Description | Selected |
|--------|-------------|----------|
| 迁移前备份 + 失败中止 | 强制备份；步骤事务原子；失败中止指明备份 | ✓ |
| 仅事务不备份 | 依赖事务回滚，不额外备份 | |
| 失败自动恢复 | 自动从备份还原重试 | |

**Notes:** 选强制备份 + 步骤原子（DDL 与 user_version 同事务）+ 失败中止。自动恢复会掩盖问题，列为 Deferred。

---

## ACL 收紧范围与时机

| Option | Description | Selected |
|--------|-------------|----------|
| 仅主库 | 只收紧 topology.db | |
| 主库 + sidecar + 备份 + 幂等重跑 | db/wal/shm/backups 全覆盖，每次启动幂等收紧，失败非致命 | ✓ |
| 一次性 + sentinel | 首次收紧后记 marker 不再跑 | |

**Notes:** sidecar 含活跃数据必须覆盖；每次启动幂等收紧无需 sentinel 且防篡改；失败非致命（数据已 AES+safeStorage 加密，ACL 是纵深防御）。

---

## 遗留库版本化

| Option | Description | Selected |
|--------|-------------|----------|
| Stamp（戳版本） | 检测 schema 似当前→直接戳到 head，跳过迁移 | |
| **幂等重跑** | 迁移保持幂等守卫，旧库重跑全部待执行，自我校验 | ✓ |

**Notes:** 选幂等重跑——现有迁移本就幂等，零额外成本却增加校验；纯 stamp 无法发现/修正部分态旧库。契合数据安全核心价值。

---

## Claude's Discretion

全部 4 个 gray area 由用户委托 Claude 决策（见上方"选择入口"）。决策详见 CONTEXT.md D-01~D-16。纯实现细节（文件拆分、注册表数据结构、icacls 封装、是否抽公共调度基类）留给 researcher/planner。

## Deferred Ideas

- 备份路径用户可配置
- 迁移失败自动恢复
- 压缩备份 / 备份文件加密
- BackupScheduler 与 SchedulerService 抽公共基类（实现细节，planner 裁量）
