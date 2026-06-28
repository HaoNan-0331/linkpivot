# Requirements: network_toplogy

**Defined:** 2026-06-21
**Core Value:** 让运维人员在一个桌面工具内安全地掌握网络拓扑、远程操控设备并获得 AI 辅助分析。

## v1 Requirements

本轮 milestone = 代码审计延后的深度优化技术债。现有功能能力（设备管理/拓扑/远程连接/AI/知识库/IP监控/认证/调度）已在 PROJECT.md 标记为 Validated，不在此重复。以下为本轮 Active 优化项。

### Performance

- [ ] **PERF-01**: OUI 厂商查询消除 N+1 —— 启动时全量预载入 `Map<macPrefix, vendor>`，`getIPDetails` 等批量场景不再逐行查 OUI
- [ ] **PERF-02**: `processARPEntries` 写库包入事务 + 复用 prepared statement，降低逐条提交开销
- [ ] **PERF-03**: FTS 搜索触发器加 `WHEN` 条件，content 未变时不重索引
- [ ] **PERF-04**: `init` 中 OUI 初始化/DDL 移出主线程（或按 `user_version` 跳过已完成初始化），加速冷启动

### Architecture

- [x] **ARCH-01**: 迁移版本管理 —— 引入 `PRAGMA user_version` + `hasColumn` helper，替代散落的 `PRAGMA table_info` 检查，迁移可追踪可跳过 _(02-01 落地注册表+hasColumn；init.ts 散落块删除+runMigrations 接入归 02-03，完成后整体交付)_
- [x] **ARCH-02**: 数据库文件 ACL 收紧（仅当前用户可读写）+ 定时 `.backup()` 机制

### Data

- [ ] **DATA-01**: 大数据 IPC 加分页/默认上限 —— `network:getIPDetails` / `oui:getAll` / `anomaly:getChanges` / `export:arpTable` 避免一次性传超大结果集

### Frontend

- [ ] **FE-01**: `AIPage` 拆分为 `ChatSessionList` / `ChatMessageList` / `ChatInput` / `CommandConfirmModal` 4 子组件
- [ ] **FE-02**: 前端 `any` 类型替换为 `src/types` interface（ArpTab / AnomalyTab / NetworkTab / OuiTab / SettingsPage / KnowledgeBasePage 等 `api:any` 与组件 props）
- [ ] **FE-03**: `TopologyPage` store 回调改用 `getState()` 读最新值，消除 stale closure
- [ ] **FE-04**: `ChunkContent` 图片加载加 `AbortController` + ref 缓存，卸载/切换时取消在途请求

### Robustness

- [ ] **ROBUST-01**: `arpCollector` 的 `executeSSH`/`executeTelnet` 加 try/finally 保证 `client.end()`/`destroy()`，error 路径 `clearTimeout`，杜绝句柄泄漏
- [ ] **ROBUST-02**: `discovery` JSON parse 失败带错误上下文 + `createSystemLog` 调用 try/catch，避免静默吞错

### Build

- [x] **BUILD-01**: 原生依赖（better-sqlite3 / ssh2）锁 exact 版本 + 打包用 `npm ci`，保证可复现构建

## v2 Requirements

暂无 —— 本轮聚焦技术债，新功能待后续 milestone。

## Out of Scope

| Feature | Reason |
|---------|--------|
| 新功能开发 | 用户明确"新增功能后面再说"，本轮聚焦技术债 |
| IPv6 支持 | 现有 ipToNumber/CIDR 仅 IPv4，属未来扩展 |

## Traceability

由 roadmap 创建时填充（每个 REQ 映射到恰好一个 phase）。

| Requirement | Phase | Status |
|-------------|-------|--------|
| BUILD-01 | Phase 1 | Complete |
| ARCH-01 | Phase 2 | In Progress (02-01 done, 02-03 pending) |
| ARCH-02 | Phase 2 | Complete |
| PERF-01 | Phase 3 | Pending |
| PERF-02 | Phase 3 | Pending |
| PERF-03 | Phase 3 | Pending |
| PERF-04 | Phase 3 | Pending |
| DATA-01 | Phase 4 | Pending |
| FE-01 | Phase 5 | Pending |
| FE-02 | Phase 5 | Pending |
| FE-03 | Phase 5 | Pending |
| FE-04 | Phase 5 | Pending |
| ROBUST-01 | Phase 6 | Pending |
| ROBUST-02 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14 ✓
- Unmapped: 0

---
*Requirements defined: 2026-06-21*
*Last updated: 2026-06-22 after roadmap creation (traceability filled)*
