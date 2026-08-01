# Phase 6: Robustness & Resource Safety - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-05
**Phase:** 6-Robustness & Resource Safety
**Mode:** Default (interactive) → 全权委托（用户未选任何 gray area，沿用 P2-P5 委托模式）
**Areas discussed:** ROBUST-01 改造范围 / ROBUST-01 清理模式 / ROBUST-02 错误上下文 / ROBUST-02 createSystemLog 包裹 / SC#4 验收方式 / BUG-3 fold 决策（全部由 Claude 委托拍板）

---

## 前置：ROADMAP.md 数据完整性修复

`init.phase-op 6` 初次返回 `phase_found: false`。排查发现 `.planning/ROADMAP.md` 已损坏（仅 19 行、只含 Phase 5；Phase 5 期间每个 `docs(05-XX): complete ... plan` 提交递进重写覆盖了原 6-phase 视图）。

| 选项 | 描述 | 选中 |
|------|------|------|
| 恢复完整 6-phase 视图（推荐） | 从 git 历史（ad6089e~1）还原全部 6 phase，更新进度表（P1-5 完成、P6 当前焦点） | ✓ |
| 仅追加 Phase 6 段 | 在当前 19 行末尾补 Phase 6，最小改动但 P1-4 与进度表仍缺 | |
| 取消，用户自己修 | 用户手动恢复，稍后重跑 | |

**用户选择：** 恢复完整 6-phase 视图（推荐）
**执行：** 从 ad6089e~1 还原，Phase 1-5 标记完成、Phase 6 当前焦点，进度表用 ✓/- 替代精确日期（避免编造）。恢复后 `init.phase-op 6` 返回 `phase_found: true`。

---

## 呈现的 gray area（全部委托 Claude）

以下 4 个 gray area 经 AskUserQuestion (multiSelect) 呈现，用户未选任何项（ dismissed）→ 按 P2-P5 既定委托模式解读为全权委托。每项 Claude 拍板结果见 CONTEXT.md 对应 D-6-X。

### Gray Area 1: ROBUST-01 改造范围

| 选项 | 描述 | 选中 |
|------|------|------|
| 仅 arpCollector 两函数 | 严格 SC#1 字面 | |
| arpCollector + ai.executeCommandsOnDevice + Telnet 自有 timeout | CONCERNS FRAG-1「P6 一并审视」+ SC#4 闭环 | ✓（Claude 委托拍板） |

**Claude 决策（D-6-1）：** 扩到 executeCommandsOnDevice（discovery SSH 入口，SC#4 验收口径一致）+ executeTelnet 补自有 setTimeout（telnet-client 库级超时不完全可靠）。
**依据：** SC#4 覆盖 discovery 路径，只改 arpCollector 则 SC#4 在 discovery 循环下仍可能泄漏。

### Gray Area 2: ROBUST-02 错误处理策略

| 选项 | 描述 | 选中 |
|------|------|------|
| 5 处全包 try/catch + 抽 safeLog helper | discovery 局部去重，console.warn 兜底 | ✓（Claude 委托拍板） |
| 仅包不在 try 内的 4 处 | line 258 已在 try 内跳过 | |
| 抽全局 safeLog util | 跨模块复用（backupScheduler/keyManager/arpIpc） | |

**Claude 决策（D-6-3 / D-6-4）：** 错误对象 enriched（slice(0,200) + err.message + position）+ command parse 补 createSystemLog 对齐 topology parse；5 处全包 + discovery 局部 safeLog helper（不跨模块，全局 util defer）。
**依据：** line 258 嵌套陷阱（catch 内二次 createSystemLog 自身可能抛中断）需每处独立 try/catch；enriched errorMessage 复用现有 TEXT 字段无需 v8 迁移。

### Gray Area 3: SC#4 验收方式

| 选项 | 描述 | 选中 |
|------|------|------|
| 静态 grep + Electron 人工 HV（同 Phase 3） | DEP-1 限制下标准模式 | ✓（Claude 委托拍板） |
| 加 Node --inspect 句柄计数脚本 | 自动化句柄快照 | |

**Claude 决策（D-6-5）：** 静态 grep（try/finally + clearTimeout + end/destroy 模式）+ 人工 HV（连真实设备反复采集，`process._getActiveHandles()` 句柄快照对比，含 error 路径兜底 HV）。
**依据：** DEP-1 下 mock client 句柄无意义；与 Phase 3 HV-1~5 / Phase 5 FE-HV 同模式。

### Gray Area 4: BUG-3 是否 fold 进本阶段

| 选项 | 描述 | 选中 |
|------|------|------|
| defer（不纳入） | 非 ROBUST-01/02 字面，无对应 REQ ID | ✓（Claude 委托拍板） |
| fold 进 Phase 6 | CONCERNS 标「P6」 | |

**Claude 决策：** defer。BUG-3 是 backupScheduler/main.ts 备份退出健壮性，非采集/发现路径；REQUIREMENTS.md traceability 仅 ROBUST-01/02 两 REQ。CONCERNS 已记录不丢失，独立 hotfix 或后续「备份健壮性」phase 处理。

---

## Claude's Discretion

全部 gray area 委托（用户未选任何项，沿用 P2-P5 模式）。D-6-1~D-6-5 详见 CONTEXT.md `<decisions>`。**用户保留 `/gsd-plan-phase` 前审阅/修改权**（与 Phase 5 同机制）。

## Deferred Ideas

- BUG-3 before-quit 不等 in-flight backup（独立 hotfix / 后续备份健壮性 phase）
- 全局静默吞错收敛 FRAG-2（未来「全局日志/错误健壮性」debt）
- executeTelnet shellPrompt 正则过宽 FRAG-3
- 全局 safeLog util 跨模块复用
- SSH/Telnet 句柄自动化测试（依赖 DEP-1 migration plan：@electron/rebuild + electron-vite vitest）
- 后端 any 清理 + ai.ts/kbService 拆分（milestone 外，Phase 5 已界定）
