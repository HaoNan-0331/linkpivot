# Roadmap: network_toplogy

## Milestones

- ✅ **v1.0 技术债优化** — Phases 1-6（shipped 2026-07-05，14 REQ 全交付，归档于 `milestones/v1.0-ROADMAP.md`）
- ✅ **v1.1 AI 对话经验沉淀** — Phases 7-11（shipped 2026-08-06，20 REQ 全交付，归档于 `milestones/v1.1-ROADMAP.md`）
- 🚧 **v1.2 安全与稳定性加固** — Phases 12-14（in progress，7 REQ：TEST-01/02 + SEC-03/04/05 + FIX-01/02）

## Phases

<details>
<summary>✅ v1.0 技术债优化 (Phases 1-6) — SHIPPED 2026-07-05</summary>

- [x] Phase 1: Build & Dependency Foundation (1/1 plans) — completed 2026-06-28
- [x] Phase 2: Architecture & DB Migration (3/3 plans) — completed 2026-06-28
- [x] Phase 3: Performance Optimization (3/3 plans) — completed 2026-06-28
- [x] Phase 4: Data / IPC Safety (3/3 plans) — completed 2026-06-28
- [x] Phase 5: Frontend Refactor & Types (4/4 plans) — completed 2026-07-05
- [x] Phase 6: Robustness & Resource Safety (2/2 plans) — completed 2026-07-05

</details>

<details>
<summary>✅ v1.1 AI 对话经验沉淀 (Phases 7-11) — SHIPPED 2026-08-06</summary>

- [x] Phase 7: Experience Data Layer & Security Baseline (2/2 plans) — completed 2026-08-01
- [x] Phase 8: AI Drafting Pipeline (3/3 plans) — completed 2026-08-02
- [x] Phase 9: Human Review & Confirmation (3/3 plans) — completed 2026-08-05
- [x] Phase 10: Experience Browse Page (4/4 plans) — completed 2026-08-06
- [x] Phase 11: AI Retrieval & Reuse (2/2 plans) — completed 2026-08-06

</details>

### 🚧 v1.2 安全与稳定性加固 (In Progress)

**Milestone Goal:** 补齐测试基础设施（DEP-1 ABI 缓解解锁自动化回归）+ 收紧安全（SSH 算法 / IPC 入参 / pre-release hardening）+ 清偿旧规划技术债（BUG-1 + 回退项甄别），让 network_toplogy 在真机路径上可自动化验证、安全无盲点。

**Phase Numbering:**
- 续 v1.1（止于 Phase 11）→ v1.2 从 **Phase 12** 起（不 reset，沿用 sequential naming）
- Integer phases (12, 13, 14): Planned milestone work
- Decimal phases (12.1, 12.2): Urgent insertions (marked INSERTED)

**Execution Order:** 12 → 13 → 14

- [ ] **Phase 12: Test Infrastructure (DEP-1 ABI 缓解)** - electron-vite + vitest Electron 内测试通道，补 SSH/Telnet/DB 真路径自动化回归 + 句柄泄漏自动化
- [ ] **Phase 13: Security Hardening Cluster** - SSH connection.ts 现代算法 + pre-release 安全项收尾 + experience:list IPC 入参校验防廉价 DoS
- [ ] **Phase 14: Defect & Legacy Rollback Closure** - BUG-1 new_ip 计数修复 + 旧规划回退项甄别修复（confirm 防重复/ai_exec_logs/会话标题/H3C LLDP）

## Phase Details

### Phase 12: Test Infrastructure (DEP-1 ABI 缓解)
**Goal**: 用户/CI 在自动化通道（非人工 HV）下能跑通 SSH/Telnet/DB/better-sqlite3 真路径回归，句柄泄漏有自动化网兜，告别 DEP-1 长期 defer 的人工核实
**Depends on**: Nothing（v1.2 基础设施 phase，下游安全/缺陷 phase 借此回归网）
**Requirements**: TEST-01, TEST-02
**Success Criteria** (what must be TRUE):
  1. `vitest` 在 Electron 内（electron-vite 集成）可加载 @electron/rebuild 重建的 better-sqlite3 native binding，plain Node 无法加载的限制消除（命令运行可观测：测试进程加载真实 native .node 不再 throw ABI 冲突）
  2. SSH/Telnet/DB 真路径有自动化回归用例（execOne / executeCommandsOnDevice / executeTelnet / DB 读写经 getDatabase() 单例），无需真实设备即可在 CI/本地绿
  3. 句柄泄漏有自动化检测（arpCollector/ai/execOne 的 try/finally cleanup 路径回归，替代 Phase 6 SC#4 + Phase 3 真机 HV 长期 defer 项）
  4. DEP-1 缓解不改动生产代码路径（只加测试通道 + 测试工具配置），生产 better-sqlite3/ssh2/telnet-client 依赖与打包路径不变
**Plans**: TBD

Plans:
- [ ] 12-01: TBD（plan-phase 补充）

**Risk / 红线:**
- DEP-1 缓解不改生产代码路径，只加测试通道与工具配置（三红线之 IPC/commandSafety/加密不可回退的前提不变）
- electron-vite + vitest 集成是新增 dev 工具链，不影响 electron-builder 打包排除规则
- 测试通道加载的 native binding 与生产一致（@electron/rebuild 重建），不可引入第二套 ABI

### Phase 13: Security Hardening Cluster
**Goal**: SSH 终端连接可用现代算法连通现代 Linux、pre-release 安全相关 hardening 项收尾、untrusted renderer 无法用 experience:list 入参廉价触发全表 LIKE DoS
**Depends on**: Phase 12（建议借自动化回归网验证 connection.ts algorithms 改动不破坏既有 SSH 连接 + experience:list 校验加测试）
**Requirements**: SEC-03, SEC-04, SEC-05
**Success Criteria** (what must be TRUE):
  1. 设备终端连接（connection.ts 内联 SSH 配置）含 curve25519-sha256 等现代算法，与 sshConfig.ts SSH_ALGORITHMS 对齐，现代 Linux（仅支持 curve25519）终端可正常连接（体检 §1.0 半残留闭环）
  2. pre-release 14 项里安全相关项收尾（L1 弱 SSH 算法 / L4 Login / L6 authGuard / L2 ai limit / L3 captcha，审计 P3 `260726-p9e` 显式排除的发版后项），每项要么修要么显式 defer 并登记
  3. experience:list IPC 入参类型/长度受限（severity 枚举校验 + search 长度上限 + tags 数组上限），untrusted renderer 传超长 search 或非法 severity 不触发全表 LIKE 扫描而是被拒/钳制（体检 WR-06）
  4. 三红线（IPC secure/safe 鉴权 / 字段加密 _enc / commandSafety.isCommandAllowed）改动后仍生效，校验加在 IPC 网关层不绕过 service 层兜底
**Plans**: TBD

Plans:
- [ ] 13-01: TBD（plan-phase 补充）

**Risk / 红线:**
- SSH algorithms 改动是终端连接路径，必须回归既有 SSH 设备连接不破坏（curve25519 加入是补集不是替换，不可移除既有兼容算法致老设备连不上）
- pre-release hardening L1/L4/L6 涉及 authGuard / Login 安全门，改动不可削弱既有鉴权（secure/safe 包装全 IPC 不回退）
- experience:list 校验加在 IPC 网关层，service 层 listExperiences 兜底不删（双层防御，与 Phase 9 09-02 confirmDrafts MAX_BATCH 双层模式一致）

### Phase 14: Defect & Legacy Rollback Closure
**Goal**: anomaly 告警 new_ip 计数正确不再恒零、旧规划回退的 4 项（confirm 防重复点击 / ai_exec_logs 完整记录 / 会话标题更新逻辑 / H3C LLDP 邻居发现路径）逐条甄别并修或显式作废
**Depends on**: Phase 12（句柄/会话/经验相关改动借自动化回归网）+ Phase 13（confirm/ai_exec_logs 改动属 AI 命令执行链，与 hardening L2 ai limit 同域）
**Requirements**: FIX-01, FIX-02
**Success Criteria** (what must be TRUE):
  1. anomalyService new_ip 计数正确——processARPEntries 首次见 IP 写 `change_type='new_ip'`（或 getStats/AnomalyTab/exportService 移除恒零字段），用户在异常面板/导出 CSV 看到的 new_ip 数字与实际新 IP 出现一致（审计 P3 BUG-1 闭环）
  2. AI 命令确认弹窗（confirm）防重复点击保护生效——用户连点确认按钮不会触发重复命令执行/重复 IPC 调用（旧规划回退项，体检 §1.0 待甄别）
  3. ai_exec_logs 完整记录 prompt_text + ai_response——AI 命令执行链路落库可审计，事后能从日志还原完整 prompt 与 AI 响应（旧规划回退项，体检 §1.0 待甄别；若甄别发现已满足则显式登记作废）
  4. AI 会话标题更新逻辑在 confirm_required early return 之前执行——AI 命令需确认时会话标题仍正常更新不被 early return 跳过（旧规划回退项，体检 §1.0 待甄别）
  5. H3C LLDP 邻居发现路径重新评估——vendor-commands.ts 已删（死代码，体检 §2.1），H3C 邻居发现走正确路径（非自造华为命令），拓扑 edges 对 H3C 设备非空（旧规划回退项，体检 §1.0 方向过时）
**Plans**: TBD

Plans:
- [ ] 14-01: TBD（plan-phase 补充）

**Risk / 红线:**
- ai_exec_logs / 会话标题改动属 AI 命令执行链（ai.ts），不可破坏 commandSafety.isCommandAllowed 安全层与 confirm_required 二次确认闸口
- H3C LLDP 重评估不可回退已废弃的 vendor-commands 命令集（体检 §1.0 + §2.1 已确认死代码方向作废），重评估的是「正确路径」非「复活旧方案」
- anomaly new_ip 修复若选「移除恒零字段」路径，getStats/AnomalyTab/exportService 三处消费方必须同步，不可留半残字段
- 旧规划 4 项中任何一项甄别后判定「已满足/作废」必须显式登记理由（grep + 代码层佐证），不可静默跳过

## Progress

**Execution Order:**
Phases execute in numeric order: 12 → 13 → 14

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Build & Dependency Foundation | v1.0 | 1/1 | Complete | 2026-06-28 |
| 2. Architecture & DB Migration | v1.0 | 3/3 | Complete | 2026-06-28 |
| 3. Performance Optimization | v1.0 | 3/3 | Complete | 2026-06-28 |
| 4. Data / IPC Safety | v1.0 | 3/3 | Complete | 2026-06-28 |
| 5. Frontend Refactor & Types | v1.0 | 4/4 | Complete | 2026-07-05 |
| 6. Robustness & Resource Safety | v1.0 | 2/2 | Complete | 2026-07-05 |
| 7. Experience Data Layer & Security Baseline | v1.1 | 2/2 | Complete | 2026-08-01 |
| 8. AI Drafting Pipeline | v1.1 | 3/3 | Complete | 2026-08-02 |
| 9. Human Review & Confirmation | v1.1 | 3/3 | Complete | 2026-08-05 |
| 10. Experience Browse Page | v1.1 | 4/4 | Complete | 2026-08-06 |
| 11. AI Retrieval & Reuse | v1.1 | 2/2 | Complete | 2026-08-06 |
| 12. Test Infrastructure (DEP-1 ABI 缓解) | v1.2 | 0/TBD | Not started | - |
| 13. Security Hardening Cluster | v1.2 | 0/TBD | Not started | - |
| 14. Defect & Legacy Rollback Closure | v1.2 | 0/TBD | Not started | - |

## Coverage Validation

| Requirement | Phase | Status |
|-------------|-------|--------|
| TEST-01 | Phase 12 | Pending |
| TEST-02 | Phase 12 | Pending |
| SEC-03 | Phase 13 | Pending |
| SEC-04 | Phase 13 | Pending |
| SEC-05 | Phase 13 | Pending |
| FIX-01 | Phase 14 | Pending |
| FIX-02 | Phase 14 | Pending |

**Coverage:** 7/7 v1 requirements mapped ✓ (no orphans, no duplicates)

---
*Roadmap created: 2026-06-22*
*Last updated: 2026-08-07 — v1.2 milestone 启动（Phases 12-14 规划，7 REQ 全映射，覆盖率 7/7）*
