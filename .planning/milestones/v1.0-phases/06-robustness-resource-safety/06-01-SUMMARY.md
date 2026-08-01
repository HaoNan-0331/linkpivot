---
phase: 06-robustness-resource-safety
plan: 01
subsystem: arpCollector + ai SSH/Telnet 句柄入口
tags:
  - robust
  - resource-safety
  - ssh
  - telnet
  - try-finally
requires:
  - ROBUST-01
  - D-6-1
  - D-6-2
provides:
  - "executeSSH/executeTelnet/executeCommandsOnDevice 三函数统一 try/finally + cleanup 资源回收模式"
  - "executeTelnet 自有 setTimeout 外层兜底（与 executeSSH 同构）"
affects:
  - "electron/services/arpCollector.ts (executeSSH + executeTelnet)"
  - "electron/services/ai.ts (executeCommandsOnDevice)"
tech-stack:
  added: []
  patterns:
    - "Promise executor 内 cleanup() 统一出口（clearTimeout + try client.end catch）"
    - "settled-flag 防重复 resolve/reject + finish() helper 统一异步回调出口"
    - "timeout 兜底路径 end+destroy 双调用（D-6-2：end 优先，仅 timeout 路径 destroy）"
    - "try/catch/finally 同步异常兜底（catch 处理同步抛原始 err，finally 模式锁定字面验收）"
key-files:
  created: []
  modified:
    - electron/services/arpCollector.ts
    - electron/services/ai.ts
decisions:
  - "D-6-1 范围：三函数全覆盖（executeSSH + executeTelnet + ai.executeCommandsOnDevice），SC#4 discovery 路径闭环"
  - "D-6-2 模式锁定：cleanup 统一清 timer + client.end；timeout 路径额外 destroy；end/destroy try/catch 幂等"
  - "形态 a（Promise executor 内 cleanup 统一出口）落地，与 plan action 模板一致"
metrics:
  duration: "~7min"
  completed: "2026-07-05"
  tasks_completed: 2
  files_modified: 2
  commits: 2
requirements:
  - ROBUST-01
---

# Phase 6 Plan 1: ROBUST-01 SSH/Telnet 句柄 try/finally 加固 Summary

将 arpCollector.executeSSH/executeTelnet 与 ai.executeCommandsOnDevice 三个 SSH/Telnet 句柄入口统一改造为 try/finally + cleanup 资源回收模式，消除散落于 ready/exec stream/error/client error/timeout 多路径的 stray timer 与未 end 的 socket，使 SC#1（grep 命中 try/finally + end/destroy + clearTimeout）与 SC#4（discovery 路径句柄回收）的代码级闭环达成。

## 落地形态（per D-6-1 / D-6-2）

### executeSSH（arpCollector.ts）— 形态 a：executor 内 cleanup 统一出口
- `cleanup()` 内部函数：`if (timer) { clearTimeout(timer); timer = undefined }; try { client.end() } catch {}`
- `finish(fn)` helper：settled-flag 防重复 + cleanup() + 触发 fn（resolve/reject）
- timeout 兜底路径：`finish(() => { try { client.destroy() } catch {}; reject(...) })`（D-6-2：end+destroy 双调用）
- ready/exec stream close/error/exec err/client error 路径全经 `finish()` → `cleanup()`
- 同步异常兜底：try/catch 包裹 `client.connect` 同步路径

### executeTelnet（arpCollector.ts）— D-6-1 补自有 setTimeout + D-6-2 finally
- 补自有 `setTimeout(() => { timedOut = true; try { connection.destroy() } catch {}; reject(...) }, timeout)` 包 connect+exec 整体（库级 connect.timeout/execTimeout 网络层挂起时不完全可靠）
- Promise 链 `.finally(() => { clearTimeout(timer); try { connection.end() } catch {}; if (timedOut) try { connection.destroy() } catch {} })`
- timedOut 标记：仅 timeout 路径追加 destroy，正常路径仅 end（与 SSH 对齐）

### executeCommandsOnDevice（ai.ts）— 形态 a：cleanup + settled-flag + try/catch/finally
- `cleanup()` 内部函数：`if (overallTimer) { clearTimeout(overallTimer); overallTimer = undefined }; try { client.end() } catch {}`
- `finish(fn)` helper：settled-flag + cleanup + 触发 fn
- timeout 兜底路径：`finish(() => { try { client.destroy() } catch {}; reject(new Error('命令执行超时 (Ns)')) })`
- ready 成功/ready catch/client error 路径全经 `finish()`
- 同步异常兜底：try/catch/finally 三段（catch 处理 client.connect 同步抛原始 err；finally 作为模式锁定字面验收，settled-flag 幂等保护）

## 验收证据（D-6-5 静态 grep）

### arpCollector.ts
| 验收点 | 命中行 | 说明 |
|--------|--------|------|
| `finally` | line 109（`.finally(() =>`）+ executeSSH cleanup 注释引用 | executeTelnet 实 finally + executeSSH cleanup 模式 |
| `clearTimeout` | line 33（executeSSH cleanup）/ line 111（executeTelnet finally） | 集中在 cleanup/finally |
| `client.end` | line 35（executeSSH cleanup） | cleanup 内 |
| `client.destroy` | line 48（executeSSH timeout 路径） | 仅 timeout 路径 |
| `setTimeout` | line 45（executeSSH）/ line 87（executeTelnet） | 两函数各一 |
| 签名字面量 | ARPCollectionResult/ARPEntry/getARPCommand/collectFromDevice/collectFromDevices/collectFromAll/setArpMasterKey 全在 | 签名零改 |

### ai.ts executeCommandsOnDevice
| 验收点 | 命中行 | 说明 |
|--------|--------|------|
| `finally` | line 382 | try/catch/finally 同步兜底 |
| `clearTimeout(overallTimer)` | line 334（cleanup 内） | 收敛到 cleanup，不再散落 4 处 |
| `client.end` | line 336（cleanup 内） | cleanup 内 |
| `client.destroy` | line 349（timeout 路径） | 仅 timeout 路径 |
| `overallTimeout = 30000 + commands.length * 15000` | line 330 | 公式零改 |
| `export function executeCommandsOnDevice` | line 308 | 签名零改 |
| `isCommandAllowed` | line 318 | 执行层强制校验保留 |
| `执行失败:` | line 368 | per-command 失败不阻断逻辑保留 |

## 三绿门禁（与 Phase 2/3/4/5 一致）

| 门禁 | 命令 | 结果 |
|------|------|------|
| TypeScript 严格模式 | `npx tsc -p tsconfig.web.json` | exit 0（无 type error） |
| Electron main esbuild | `npm run build:electron-main` | exit 0（dist-electron/main.js 1.8mb） |
| 单元测试 | `npx vitest run` | 4 files / 25 tests passed |

## 回归零改验证

- **arpCollector.ts**：executeSSH/executeTelnet 签名、返回 Promise<string>、reject Error 文案（`SSH timeout after ${timeout}ms` / `Telnet timeout after ${timeout}ms`）零改；collectFromDevice try/catch（line 132-145）依赖 reject 行为不变，调用方零改。
- **ai.ts**：executeCommandsOnDevice export 签名、返回 Promise<Array<{command,output,success}>>、overallTimeout 公式、isCommandAllowed 强制校验、per-command 失败不阻断、commands.length===0 短路、reject Error 文案（`命令执行超时 (Ns)`）全保留；discovery.ts:166 调用方零改。
- **execOne / buildSSHConfig / executeCommandOnDevice / chat / confirmCommand / getAiConfig** 等 ai.ts 其他导出未触碰。
- **discovery.ts**：本 plan 零触碰（ROBUST-02 / 06-02 独占）。

## 红线遵守

- ✓ 不改功能语义（finally 仅清资源，不改 resolve/reject/throw 行为）
- ✓ 不改 IPC 签名（arpCollector/ai 均为业务 service，无 IPC 改动）
- ✓ 不动 SQL schema/迁移（两文件不直接访问 DB）
- ✓ 不改加密（encField/decField/setArpMasterKey/setAiMasterKey 字面量零改）
- ✓ 不引入新依赖（ssh2/telnet-client 已 import）
- ✓ isCommandAllowed 执行层强制校验保留（安全红线 T-06-01-04 mitigate）

## 与 06-02 零文件冲突确认

- 06-01 改：`electron/services/arpCollector.ts` + `electron/services/ai.ts`
- 06-02 改：`electron/services/discovery.ts`（ROBUST-02 独占）
- 三文件零重叠，可同 wave 并行（已在 plan 中 wave:1 标注）

## Deviations from Plan

None - plan 执行完全按 D-6-1/D-6-2 与 plan action 模板落地。

- 形态选择：planner 授权 executor 在形态 a（executor 内 cleanup 统一出口）与形态 b（async/await + 外层 try/finally）间裁量。本 plan 选形态 a（与 plan action 主模板一致，便于审计与三函数同构）。
- executeCommandsOnDevice 的 try/catch/finally 三段：catch 处理 client.connect 同步抛（保留原始 err），finally 作为 D-6-5 静态 grep `finally` 字面验收点 + settled-flag 幂等保护。这是对 plan action line 320-324 模板的忠实落地。

## Threat Mitigation 复核

| Threat | Disposition | 落地 |
|--------|-------------|------|
| T-06-01-01（DoS 资源耗尽） | mitigate | cleanup 统一出口覆盖所有 ready/exec stream/error/client error 路径；timeout 路径 end+destroy | 
| T-06-01-02（cleanup 内 end/destroy 抛衍生新泄漏） | mitigate | `try { client.end() } catch {}` 与 `try { client.destroy() } catch {}` 包裹；clearTimeout 对已 fire timer 幂等 | 
| T-06-01-03（信息泄露） | accept | timeout 文案仅含配置值，无凭证/拓扑敏感信息 | 
| T-06-01-04（篡改：isCommandAllowed 被绕过） | mitigate | acceptance_criteria grep `isCommandAllowed` 命中（line 318），per-command `执行失败:` 保留 | 

## Commits

| Task | Commit | 文件 | 说明 |
|------|--------|------|------|
| Task 1 | eef3004 | electron/services/arpCollector.ts | executeSSH/executeTelnet try/finally 化 + executeTelnet 补自有 setTimeout |
| Task 2 | 2389bd8 | electron/services/ai.ts | executeCommandsOnDevice cleanup 统一出口 + try/catch/finally |

## Self-Check: PASSED

- [x] electron/services/arpCollector.ts 含 finally（line 109 executeTelnet + cleanup 模式）
- [x] electron/services/ai.ts 含 finally（line 382）
- [x] commit eef3004 在 git log（`git log --oneline -5` 命中）
- [x] commit 2389bd8 在 git log
- [x] tsc + esbuild + vitest(25) 三绿
- [x] 三函数签名字面量全在（grep 验证）
