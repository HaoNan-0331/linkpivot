# Roadmap: network_toplogy 技术债优化 Milestone

**Mode:** Brownfield 技术债（Horizontal Layers，按技术层分组）
**Granularity:** standard
**Coverage:** 14/14 v1 requirements mapped ✓

本 milestone 为代码审计延后的深度优化技术债。现有功能（设备管理/拓扑/远程连接/AI/知识库/IP监控/认证/调度）已在 PROJECT.md 标记 Validated，本轮不重复。phase 按技术层划分，非端到端功能切片。

## Phases

- [ ] **Phase 1: Build & Dependency Foundation** - 原生依赖 exact 版本锁定 + npm ci 可复现构建（低风险基础，先立基线）
- [ ] **Phase 2: Architecture & DB Migration** - 迁移版本管理 user_version + hasColumn + DB ACL 收紧 + 定时 backup
- [ ] **Phase 3: Performance Optimization** - OUI N+1 消除、ARP 事务化、FTS 触发器 WHEN、init 跳过/移出主线程
- [ ] **Phase 4: Data / IPC Safety** - 大数据 IPC 分页/上限，避免超大结果集一次性传输
- [ ] **Phase 5: Frontend Refactor & Types** - AIPage 拆分、any→types、TopologyPage getState、ChunkContent AbortController
- [ ] **Phase 6: Robustness & Resource Safety** - arpCollector/discovery try/finally + 错误上下文，杜绝句柄泄漏与静默吞错

## Phase Details

### Phase 1: Build & Dependency Foundation
**Goal**: 建立可复现构建基线，锁定原生依赖，为后续重构提供稳定回归参照
**Depends on**: Nothing (first phase，立基线优先)
**Requirements**: BUILD-01
**Success Criteria** (what must be TRUE):
  1. `package-lock.json` 中 `better-sqlite3` 与 `ssh2` 为 exact 版本（无 `^`/`~` 前缀，可 `grep` 验证）
  2. 全新 clone 后 `npm ci` 无 lock 偏差报错、构建成功（删除 `node_modules` 后 `npm ci` + 构建 exit 0）
  3. `tsc -p tsconfig.web.json` 与 electron main esbuild 打包双绿，无新增 type error
**Plans**: 1 plan
Plans:
- [x] 01-01-PLAN.md — 锁定原生依赖 exact 版本（better-sqlite3/ssh2/telnet-client）+ 重新生成 lockfile + 验证可复现全量构建

### Phase 2: Architecture & DB Migration
**Goal**: 数据库迁移可追踪可跳过，DB 文件权限收紧并具备备份机制
**Depends on**: Phase 1 (在稳定构建基线上做架构改动)
**Requirements**: ARCH-01, ARCH-02
**Success Criteria** (what must be TRUE):
  1. `PRAGMA user_version` 在 init 中被读写，散落的 `PRAGMA table_info` 检查被 `hasColumn` helper 替代（`codegraph_search hasColumn` 命中，`grep "table_info"` 调用点收敛）
  2. DB 文件 ACL 仅当前用户可读写（Windows ACL / chmod 0600 验证，非当前用户无访问）
  3. 定时 `.backup()` 机制存在并被注册（可 `codegraph_search` 命中 backup 调度 + 备份文件按计划生成）
  4. 旧库打开后 user_version 自动迁移到位且历史数据无丢失（向后兼容验证）
**Plans**: 3 plans
Plans:
**Wave 1**
- [ ] 02-01-PLAN.md — 迁移版本管理（user_version + hasColumn + 版本化注册表，重构 init.ts 散落 table_info）
- [ ] 02-02-PLAN.md — BackupConfig 类型 + 跨平台 ACL helper（restrictFilePermissions）

**Wave 2** *(blocked on Wave 1 completion)*
- [ ] 02-03-PLAN.md — BackupScheduler（定时 backup 双桶轮换）+ connection.ts 集成（premigration 备份 + ACL 收紧）+ main.ts 生命周期

### Phase 3: Performance Optimization
**Goal**: 消除已知 N+1 与逐条提交开销，冷启动加速
**Depends on**: Phase 2 (PERF-04 的"按 user_version 跳过"依赖 ARCH-01 的 user_version 机制)
**Requirements**: PERF-01, PERF-02, PERF-03, PERF-04
**Success Criteria** (what must be TRUE):
  1. OUI 查询不再 N+1：启动预载入 `Map<macPrefix, vendor>`，`/24` 网段 `getIPDetails` 无逐行 OUI 查库（日志/SQL trace 验证 OUI 查询次数从 O(n) 降为 O(1) 预载）
  2. `processARPEntries` 写库为单事务（`BEGIN/COMMIT` 包裹）+ 复用 prepared statement，无逐条 autocommit
  3. FTS 触发器带 `WHEN` 条件（content 未变不重索引，可 grep 到 `WHEN OLD.content IS NOT NEW.content`）
  4. `init` 中 OUI 初始化/DDL 按 `user_version` 跳过已完成项或移出主线程，冷启动耗时下降（二次启动跳过日志可见）
**Plans**: TBD

### Phase 4: Data / IPC Safety
**Goal**: 大数据 IPC 不再一次性传超大结果集，主进程与渲染层数据交换有界
**Depends on**: Phase 3 (在性能优化后做分页，避免重复改 IPC 通道)
**Requirements**: DATA-01
**Success Criteria** (what must be TRUE):
  1. `network:getIPDetails` / `oui:getAll` / `anomaly:getChanges` / `export:arpTable` 支持分页参数或默认行数上限（4 个通道均可 grep 到 limit/offset 或 maxRows 参数）
  2. 超大结果集（如 >10000 行 ARP 表）请求不再一次性序列化全量，单次 IPC payload 有界
  3. 现有调用方适配新签名，无回归（分页/上限默认值保证旧调用行为不变）
**Plans**: TBD

### Phase 5: Frontend Refactor & Types
**Goal**: 前端结构清晰、类型严格、无 stale closure 与在途请求泄漏
**Depends on**: Phase 4 (DATA-01 分页签名稳定后，前端 Tab 组件按新类型对接)
**Requirements**: FE-01, FE-02, FE-03, FE-04
**Success Criteria** (what must be TRUE):
  1. `AIPage` 拆分为 `ChatSessionList` / `ChatMessageList` / `ChatInput` / `CommandConfirmModal` 4 个独立子组件文件（`codegraph_files`/glob 命中 4 个文件）
  2. 前端 `any` 类型清理：ArpTab / AnomalyTab / NetworkTab / OuiTab / SettingsPage / KnowledgeBasePage 的 `api:any` 与组件 props 改用 `src/types` interface（`tsc -p tsconfig.web.json` 绿 + `grep ": any"` 显著收敛）
  3. `TopologyPage` store 回调使用 `getState()` 读最新值，无 stale closure（回调内无捕获过期 state）
  4. `ChunkContent` 图片加载带 `AbortController` + ref 缓存，组件卸载/切换时在途请求被取消（可 grep 到 AbortController + abort 调用）
**Plans**: TBD
**UI hint**: yes

### Phase 6: Robustness & Resource Safety
**Goal**: 采集/发现路径无句柄泄漏、无静默吞错，错误可追踪
**Depends on**: Phase 5 (前端稳定后收尾健壮性，集中处理底层采集/发现)
**Requirements**: ROBUST-01, ROBUST-02
**Success Criteria** (what must be TRUE):
  1. `arpCollector` 的 `executeSSH`/`executeTelnet` 带 try/finally 保证 `client.end()`/`destroy()` 执行，error 路径 `clearTimeout`（可 grep 到 try/finally + end/destroy + clearTimeout）
  2. `discovery` JSON parse 失败携带错误上下文（原始内容片段 + 位置），不再静默吞错
  3. `discovery` 中 `createSystemLog` 调用被 try/catch 包裹，日志写库失败不影响主流程
  4. 反复触发采集/发现循环后无句柄泄漏（事件句柄/timer/client 计数稳定，不单调增长）
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Build & Dependency Foundation | 0/1 | Not started | - |
| 2. Architecture & DB Migration | 0/0 | Not started | - |
| 3. Performance Optimization | 0/0 | Not started | - |
| 4. Data / IPC Safety | 0/0 | Not started | - |
| 5. Frontend Refactor & Types | 0/0 | Not started | - |
| 6. Robustness & Resource Safety | 0/0 | Not started | - |

---
*Roadmap created: 2026-06-22*
*Last updated: 2026-06-28 after Phase 1 planning*
