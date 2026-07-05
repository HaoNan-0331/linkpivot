# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — 技术债优化

**Shipped:** 2026-07-05
**Phases:** 6 | **Plans:** 16 | **Tasks:** 20

### What Was Built
- 构建基线 + 架构/迁移层（user_version + hasColumn + 版本化迁移注册表 + BackupScheduler 双桶轮换 + DB ACL 跨平台收紧）
- 性能优化（OUI vendorMap 内存缓存消除 N+1 + ARP 整批事务化 + FTS trigger WHEN + init 幂等跳过冷启动加速）
- 数据/IPC 安全（3 list 通道 hybrid 分页 + 截断信封 + exportARPTable 流式分块写 CSV）
- 前端重构与类型（AIPage 399→95 行拆 4 子组件 + useAIChat hook + any→src/types + TopologyPage ref-mirror + ChunkContent AbortController LRU 缓存）
- 健壮性/资源安全（arpCollector/ai 三函数 + execOne 全 try/finally 统一回收 + discovery safeLog + enrichParseError）

### What Worked
- **CodeGraph 全符号索引 + 84-agent 审计前置**：跳过 map-codebase + domain research，CONTEXT.md 逐行号引用活代码，planner/executor 改造精准，6 phase 16 plan 几乎零返工。
- **委托决策模式（P2-P6 一致）**：用户全权委托 + Claude 按「项目最优」拍板 + 决策附代码依据，discuss→plan→execute 全链路流畅。
- **静态三绿门禁（tsc + esbuild + vitest 25）作为代码级验收**：跨 6 phase 一致，DEP-1 限制下用人工 HV 补真实运行时验证。
- **code review 门（gsd-code-reviewer + gsd-code-fixer）**：Phase 5 抓 CR-01 无限重渲染、Phase 6 抓 CR-01 execOne stream + CR-02 use-after-destroy 两个真实句柄泄漏（vitest mock 抓不到），fixer 精确修复。
- **files_modified 零重叠分 wave/plan**：每 phase plans 按文件归属划分，并行/串行无冲突。

### What Was Inefficient
- **DEP-1 native binding ABI 冲突**：ssh2/telnet-client/better-sqlite3 无法 plain node/vitest 实测真实 client，导致 SC#4 句柄泄漏等只能静态 grep + 人工 HV，code review 发现的 race（CR-02 use-after-destroy）在 vitest mock 下不显现。下一 milestone 应优先 DEP-1 缓解（@electron/rebuild + electron-vite）。
- **summary-extract 噪音**：milestone.complete 自动提取的 accomplishments 含 "verify-block-A"/"Files exist:" 等非成果文本，需手工清理 MILESTONES.md。
- **Windows git worktree 风险**：Phase 6 execute 选择串行（非 worktree 并行）规避 Windows 锁/路径问题，代价是速度（小 phase 可接受）。
- **phase.complete requirements_updated 返回值与实际不符**：SDK 报 false 但实际改了 REQUIREMENTS.md，导致 Edit 失败需重读。

### Patterns Established
- **DEP-1 验证策略**：静态三绿门禁 + 人工 HV（process._getActiveHandles 句柄快照 / Electron 真实设备），不加 mock 句柄计数到 vitest。
- **CONTEXT.md 决策授权说明 + D-X 标号 + 逐行号活代码引用**：discuss-phase 输出格式，planner/executor 高保真落地。
- **safeLog 局部 helper（console.warn 兜底）+ enrichParseError**：discovery 模式，可推广到全局静默吞错收敛（FRAG-2 defer）。
- **try/finally cleanup 统一出口（clearTimeout + end，timeout 路径 destroy）**：SSH/Telnet 句柄回收模式，ssh2 事件驱动下所有出口经 cleanup。

### Key Lessons
1. **code review 必须独立于 Self-Check**：executor Self-Check PASSED + vitest 25 绿仍可能漏真实句柄泄漏（race / stream error handler），gsd-code-reviewer 的 ssh2 事件模型专项审查是唯一抓到 CR-01/CR-02 的环节。advisory 不 block 但应在 verify 前修复 Critical。
2. **DEP-1 是验证天花**：native binding ABI 冲突使真实 client 测试不可能（plain node），所有 SSH/Telnet/DB 路径的运行时验证必须人工 HV。下 milestone 优先缓解。
3. **委托决策 + CodeGraph 索引 = 高保真执行**：用户全权委托 + CONTEXT.md 逐行号引用 + codegraph 结构检索，6 phase 16 plan 几乎零返工。

### Cost Observations
- Model mix: planner opus / executor+checker+reviewer+fixer+verifier sonnet（balanced profile）
- Sessions: 跨多 session（discuss→plan→execute→complete 各 phase）
- Notable: Phase 6 code-review→fixer 链（2 Critical 修复）是质量关键，单 agent Self-Check 不足

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 6 | 16 | 首里程碑：CodeGraph 索引 + 委托决策 + 静态门禁 + 人工 HV 模式建立 |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 25 (vitest) | 静态门禁全绿 | 0 新增依赖（纯加固/重构） |

### Top Lessons (Verified Across Milestones)

1. 待第二里程碑验证（code review 独立于 Self-Check / DEP-1 验证天花 / 委托决策+CodeGraph 高保真）
