# Milestones

## v1.0 技术债优化 (Shipped: 2026-07-05)

**Phases completed:** 6 phases, 16 plans, 20 tasks
**Requirements delivered:** 14/14（BUILD-01, ARCH-01/02, PERF-01~04, DATA-01, FE-01~04, ROBUST-01/02）
**Known deferred items at close:** 7（见 STATE.md §Deferred Items — DEP-1 native binding 限制下的人工 HV/验证项 + 1 quick_task artifact 残留）
**Git range:** af12dc0（Phase 1 plan）→ d906cab（Phase 6 PROJECT），163 commits

**Key accomplishments:**

1. **构建基线（Phase 1, BUILD-01）**：原生依赖 better-sqlite3/ssh2/telnet-client exact 版本锁定（12.9.0/1.17.0/2.2.13）+ npm ci 可复现构建，为后续 5 phase 重构提供稳定回归参照。
2. **架构/迁移层（Phase 2, ARCH-01/02）**：user_version + hasColumn + 版本化迁移注册表（v1-v7）替换散落 table_info；DB 文件 ACL 跨平台收紧（db/wal/shm/backups，icacls/chmod 0600，非致命）；BackupScheduler 定时 .backup() 双桶轮换（周期 7/迁移 5）+ 迁移前安全网。
3. **性能优化（Phase 3, PERF-01~04）**：OUI vendorMap 内存缓存消除 N+1 + getIPDetails 双查修复；processARPEntries 整批单事务 + prepared statement 复用 + isIPExcluded 预载 Set；kb_chunks_au FTS trigger 加 WHEN（v7 迁移 HEAD=7）；init 幂等跳过可观测日志 + 冷启动 performance.now() 计时。
4. **数据/IPC 安全（Phase 4, DATA-01）**：3 list 通道（getIPDetails/oui:getAll/anomaly:getChanges）hybrid 分页契约（默认 cap 2000/5000/100 + 硬上限 + validateLimit 钳制）+ 截断信封 {rows,total,truncated}；export:arpTable 流式分块写 CSV（分批 LIMIT/OFFSET + append，内存峰值 O(单批) 非 O(全表)）。
5. **前端重构与类型（Phase 5, FE-01~04）**：AIPage 399→95 行拆 4 子组件（ChatSessionList/ChatMessageList/ChatInput/CommandConfirmModal）+ useAIChat 自定义 hook；前端 any→src/types（electron.d.ts 26 处建模 + ai/kb DTO + oui OUIRow，6 REQ 组件 + DevicesPage 清零）；TopologyPage ref-mirror 消 stale closure；ChunkContent AbortController + 模块级 LRU + in-flight 去重图片缓存。
6. **健壮性/资源安全（Phase 6, ROBUST-01/02）**：arpCollector.executeSSH/executeTelnet + ai.executeCommandsOnDevice + execOne 全 try/finally 化（cleanup 统一出口 clearTimeout+end，timeout 路径 destroy，executeTelnet 补自有 setTimeout，execOne 补 stream.on('error')，code review 2 Critical 句柄泄漏 CR-01/CR-02 修复）；discovery safeLog helper（5 处 createSystemLog 非致命包裹 + console.warn 兜底，line 258 嵌套陷阱切断）+ enrichParseError enriched Error（原始片段 slice 0,200）。

**验证：** 三绿门禁（tsc -p tsconfig.web.json + esbuild + vitest 25）全 phase 全绿；6 phase code review 全 Critical 修复（Phase 5 CR-01 无限重渲染 / Phase 6 CR-01 execOne stream + CR-02 use-after-destroy）；4 项 SC#4 句柄快照 HV defer（DEP-1）。

---
