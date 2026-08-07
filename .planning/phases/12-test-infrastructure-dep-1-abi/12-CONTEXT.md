---
phase: 12
name: Test Infrastructure (DEP-1 ABI 缓解)
milestone: v1.2
gathered: 2026-08-07
status: Ready for research+planning（轻量 discuss，gray areas 交 researcher）
---

# Phase 12 CONTEXT: Test Infrastructure (DEP-1 ABI 缓解)

<domain>

## Task Boundary

让 vitest 跑进 Electron 进程（加载 @electron/rebuild 重建的 better-sqlite3/ssh2），自动化 SSH/Telnet/DB 真路径 + 句柄泄漏回归，消除 DEP-1 native binding ABI 限制下的人工 HV 依赖。

**REQ:** TEST-01（ABI 缓解，electron-vite+vitest 集成）+ TEST-02（句柄泄漏自动化检测）。

**Domain 性质：** 纯测试基础设施，不加业务功能、不改生产代码路径。

</domain>

<decisions>

## Implementation Decisions（锁定约束，downstream 必须遵守）

### 1. 不改生产代码路径（ROADMAP SC4 红线）
DEP-1 缓解只加测试通道 + 工具配置。**不改**：electron/main.ts 生产逻辑、better-sqlite3/ssh2 生产用法、electron-builder 打包路径、esbuild/vite 生产构建。生产依赖与安装包产物不变。

### 2. 三红线不可回退
IPC 鉴权（secure/safe）/ 字段加密（_enc + encField/decField）/ commandSafety.isCommandAllowed — 测试基础设施改动不得影响这三层运行。

### 3. 渐进保留现有 mock 测试
现有 `_setExperienceDbGetter` mock DB 测试（16 文件 244 用例）**保留不删**，真路径测试并行新增。**不搞 mock→真 全量替换**（风险大、工作量不抵收益）。两套并存：mock 测业务逻辑、真路径测 native 集成。

### 4. 句柄泄漏自动化替代人工 HV
TEST-02 的句柄检测要覆盖 Phase 6 SC#4 + Phase 3 defer 的人工 HV 项（arpCollector/ai.executeCommandsOnDevice/execOne/executeTelnet 的 try/finally cleanup 路径），落地后这些 defer 项可标 resolved。

</decisions>

<deferred>

## Gray Areas（交 researcher/planner，不预判）

- **electron-vite 集成幅度**：完整迁移（替换 vite+esbuild 双构建为 electron-vite 统一）vs 最小侵入（只加 Electron 内 test runner，保留现有构建）→ **researcher 调研 electron-vite 方案后给推荐**，planner 据此规划
- **句柄泄漏检测机制**：具体技术方案（hook/计数/snapshot/leak detector 库）→ **researcher 调研**
- **CI 扩展**：Electron 内测试只本地跑，还是进 build-smoke.yml CI（锁回归但延长 CI 时间）→ **planner 评估 CI 成本后建议**，用户 plan review 时定
- **测试用例优先级**：SSH/Telnet/DB/句柄 先自动化哪些 → **planner 基于 SC 定**

</deferred>

<canonical_refs>

## Canonical References

- `.planning/ROADMAP.md` — Phase 12（SC1-4 + Risk 段，红线约束）
- `.planning/REQUIREMENTS.md` — TEST-01 / TEST-02
- `.planning/audits/2026-08-07-health-audit.md` — §1.1 #3 DEP-1（体检来源）
- `.planning/STATE.md` — §Deferred Items（DEP-1 历史 defer 项 + Phase 3/6 真机 HV）
- `.planning/codebase/TESTING.md` — 测试现状（16 文件 244 用例 + DEP-1 mock 范式 _setExperienceDbGetter + vitest.config include）
- `.planning/codebase/ARCHITECTURE.md` — 三进程信任边界 + native 模块外部化清单

</canonical_refs>

<codebase_context>

## 可复用资产

- **现有 mock 范式**：`_setExperienceDbGetter`（experienceService）/ `_setXxxDbGetter` 系列 — 测试专用 db 注入钩子，生产走 getDatabase() 单例。真路径测试接入点：getDatabase() 真实 DB。
- **现有测试布局**：co-located（electron/services/*.test.ts）+ tests/unit/ 并存，vitest.config.ts include `['tests/**/*.test.ts', 'electron/**/*.test.ts']`，environment=node。
- **native 外部化清单**：package.json build:electron-main 的 `--external:better-sqlite3 --external:ssh2 --external:telnet-client --external:pdfjs-dist`。
- **@electron/rebuild 现状**：rebuild:native script（electron-rebuild -f -w better-sqlite3 -w ssh2），CI build-smoke.yml 已用。

</codebase_context>
