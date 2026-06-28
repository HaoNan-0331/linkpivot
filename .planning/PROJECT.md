# network_toplogy

## What This Is

network_toplogy 是面向运维人员的网络拓扑管理桌面工具（Electron + React + TypeScript + better-sqlite3）。运维人员用它可视化网络拓扑、远程连接并操控设备（SSH/Telnet/Web/RDP）、通过 AI 助手辅助分析与执行运维命令，并维护设备资料与运维知识库。

## Core Value

让运维人员在一个桌面工具内安全地掌握网络拓扑、远程操控设备并获得 AI 辅助分析——拓扑准确呈现与设备安全可控是最高优先级，其余皆可让步。

## Requirements

### Validated

<!-- 已实现并投入使用的能力，从现有代码推断 -->

- ✓ 设备管理 CRUD（凭证 AES-256-GCM 加密 + safeStorage 主密钥绑定机器）— 现有
- ✓ 网络拓扑可视化（React Flow）+ SSH 自动发现（AI 分析连接关系）— 现有
- ✓ 设备远程连接（SSH/Telnet/Web/RDP 独立终端窗口）— 现有
- ✓ AI 助手（对话 + Tool Use 远程执行 + 命令白名单/黑名单安全 + 执行日志）— 现有
- ✓ 知识库（PDF/文档解析 + 向量检索 + 多模态图片识别）— 现有
- ✓ IP/MAC 监控（ARP 采集 + 异常检测 + 网段管理 + OUI 厂商识别）— 现有
- ✓ 认证与安全（登录 + 验证码 + 口令策略 + IPC 鉴权网关 + CSP/sandbox）— 现有
- ✓ 定时调度（ARP 定时采集）— 现有
- ✓ 构建/依赖：原生依赖（better-sqlite3/ssh2/telnet-client）exact 版本锁定 + npm ci 可复现构建基线 — Validated in Phase 1: Build & Dependency Foundation

### Active

<!-- 本轮 milestone：代码审计延后的深度优化技术债（详细 REQ-IDs 见 REQUIREMENTS.md） -->

- [ ] 性能/资源：OUI N+1 查询消除（启动预载入 Map）、processARPEntries 事务化、FTS 触发器 WHEN 优化、init OUI/DDL 移出主线程
- [ ] 架构/迁移：迁移版本管理（PRAGMA user_version + hasColumn）、DB 文件 ACL 收紧 + 定时 backup
- [ ] IPC/数据：大数据 IPC 分页/上限（getIPDetails/oui:getAll/anomaly:getChanges/export:arpTable）
- [ ] 前端重构：AIPage 拆分 4 子组件、前端 any 类型替换为 src/types、TopologyPage store getState 防 stale closure、ChunkContent 图片 AbortController
- [ ] 健壮性：arpCollector/discovery 句柄 try/finally + 错误上下文

### Out of Scope

- 新功能开发 — 用户明确"新增功能后面再说"，本轮聚焦技术债
- IPv6 支持 — 现有 ipToNumber/CIDR 仅 IPv4，属未来扩展

## Context

- 项目已完成 Task 5-14 功能开发，代码成熟
- 刚完成代码安全审计（5 批 commit：0a6bfdf / 22622d7 / 09f878a / d3d05dc / 9ac5201），修复 1 critical + 8 high + 11 medium + ~35 low
- 本轮为审计延后的深度优化/大重构（low 级），通过 GSD 结构化分批处理
- 项目已有 CodeGraph 全符号索引（tree-sitter），结构查询优先用 `codegraph_*` 工具
- 技术栈：Electron 主进程（esbuild 打包）+ React 渲染层（Vite）+ TypeScript（严格模式 + noUnusedLocals）+ better-sqlite3（WAL）+ ssh2 + xterm.js + React Flow + Ant Design
- 加密：AES-256-GCM + 版本前缀 `v2:`（12 字节 IV）兼容历史 v1（16 字节 IV），零迁移
- **Phase 1 complete (2026-06-28)**：原生依赖 exact 锁定 + npm ci 可复现构建基线（BUILD-01，commit 940aa7c），为 Phase 2-6 重构提供稳定回归参照

## Constraints

- **Tech stack**: Electron + React + TS + better-sqlite3 — 不更换核心栈
- **Compatibility**: 加密/迁移改动必须向后兼容历史数据
- **Security**: SSH 密钥认证、命令白名单执行层强制校验、IPC 鉴权网关 — 不可回退
- **Build**: tsconfig.web.json 严格模式 + noUnusedLocals 必须全绿；electron main 用 esbuild 打包
- **Packaging**: 禁止打包用户数据/账号/DB 进安装包（electron-builder.yml 排除规则）

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 采用 GSD 流程管理技术债优化 | CLAUDE.md 规范要求中大型项目用 /gsd；技术债需结构化分批 | — Pending |
| 跳过 map-codebase + domain research | 已有 CodeGraph 索引 + 84-agent 全量审计，架构充分掌握；外部搜索工具不可用 | — Pending |
| 本轮仅技术债，不含新功能 | 用户明确延后新功能 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-28 after Phase 1 completion (BUILD-01)*
