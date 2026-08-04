---
slug: ai-telnet-exec-routing
status: resolved
trigger: "AI 对话引用 telnet 设备执行命令时，错误走 SSH（端口 22）导致 ECONNREFUSED。设备 connectionType=telnet，AI 执行层无视该字段。"
created: 2026-08-04
updated: 2026-08-04
goal: find_and_fix
---

# Debug: ai-telnet-exec-routing

> 起步状态：root cause 已在 systematic-debugging Phase 1-3 定位（orchestrator 取证完成），session 从 `fixing` 起步，直接进入「实施修复 + 测试」，勿重复调查。

## Symptoms

- **Expected**: AI 对话引用 telnet 设备（如「公司」10.7.8.252）查配置时，应按 `device.connectionType=telnet` 走 telnet 23 端口执行 show/display 命令。
- **Actual**: AI 执行命令无条件走 SSH 端口 22，对 telnet 设备 `ECONNREFUSED`，反馈「连接设备失败：无法通过 SSH（端口 22）连接到 10.7.8.252」。
- **Error**: SSH `ECONNREFUSED`（端口 22 对 telnet 设备无 SSH 服务）。
- **Timeline**: v1.0 遗留（`executeCommandsOnDevice` 自初版只支持 SSH exec，telnet 通道漏接）。Phase 9 验证时用户撞出。
- **Reproduction**: 设备 connectionType=telnet → AI 对话引用该设备 → AI 决定执行命令 → 用户确认 → `executeCommandsOnDevice` 走 SSH → ECONNREFUSED。

## Current Focus

- **hypothesis**: `electron/services/ai.ts:310` `executeCommandsOnDevice` 在 `runOne` 内无条件 `buildSSHConfig(device)` 走 SSH exec，不判断 `device.connectionType`。telnet 自动化 exec 能力已存在于 `arpCollector.ts:77 executeTelnet`（telnet-client），AI 执行层漏接。
- **test**: ✅ 已写 `electron/services/ai.telnetRouting.test.ts`（7 cases 全绿）——mock telnet-client（经共用 util）+ ssh2 Client（真 class），断言 connectionType=telnet 走 telnet 通道不实例化 ssh2 Client；ssh/缺省走 SSH 通道不调 telnet；大小写不敏感；空命令短路；telnet 抛错首条 reject 整批。
- **expecting**: telnet 设备命令经 telnet-client exec 返回输出，SSH 路径不被触发。
- **next_action**: ✅ 完成——分流实施 + 共用 util 抽取 + 单测 + 三绿门禁全过。
- **reasoning_checkpoint**:
- **tdd_checkpoint**:

## Evidence

- timestamp: 2026-08-04 — `ai.ts:290-310` executeCommandsOnDevice 无条件 `buildSSHConfig`（grep + Read 确认，line 310）；line 298-302 `isCommandAllowed` 安全层在 `checked` 数组（telnet 路径可复用，无新增注入面）。
- timestamp: 2026-08-04 — `arpCollector.ts:77-115` executeTelnet 成熟实现（telnet-client connect `loginPrompt/PasswordPrompt/shellPrompt` + exec + gbk + 超时兜底 + cleanup），`arpCollector.ts:134-138` collectFromDevice 正确分流 ssh/telnet（**working example**）。
- timestamp: 2026-08-04 — `connection.ts` openTerminal(80-84) / testDeviceConnection(272-280) 均正确按 connectionType 分流；唯 ai.ts executeCommandsOnDevice 漏。
- timestamp: 2026-08-04 — 影响调用点 4 处：`ai.ts:453` / `ai.ts:557` / `ai.ts:842` / `discovery.ts:202`。
- timestamp: 2026-08-04 — `arpCollector.executeTelnet` 当前是模块私有 function（未 export）；SSH 侧 ai.ts 用 `buildSSHConfig`(支持密钥/密码) + `execOne`(stream silence/retry/H3C 粘连)，语义比 arpCollector.executeSSH(仅 password 简单 exec) 更丰富，**SSH 路径不可替换为 arpCollector 版**，仅 telnet 侧可复用/同构。
- timestamp: 2026-08-04 — 实施决策：抽共用 util `electron/utils/telnetExec.ts`（消除 arpCollector/ai.ts 双份），arpCollector.executeTelnet 改薄壳调用 util；ai.ts runOne 按 isTelnet 分流，telnet 路径调 util（decodeGbk+stripAnsi 输出后处理，与 SSH 路径 execOne 内 decodeDeviceBuffer+stripAnsi 对齐）。
- timestamp: 2026-08-04 — 三绿门禁：`tsc -p tsconfig.web.json --noEmit` exit 0；`npm run build:electron-main` exit 0（dist-electron/main.js 1.9mb）；`npx vitest run` 172/172 全绿（原 165 + 新增 7，无回归）。

## Eliminated

- (无——root cause 直接定位，无需排除其他假设)

## Resolution

- **root_cause**: `ai.ts executeCommandsOnDevice` 无条件 SSH，无视 `device.connectionType`。
- **fix**: `executeCommandsOnDevice` 在 runOne 内按 `device.connectionType` 分流——telnet（大小写不敏感）走新增共用 util `electron/utils/telnetExec.ts` 的 `executeTelnetCommand`（telnet-client connect loginPrompt/PasswordPrompt/shellPrompt + exec + 自有 timeout 兜底 + finally cleanup + 可选 gbk 解码/ANSI 剥离），SSH（含默认/缺省）保留原 `buildSSHConfig + client.exec + execOne` 路径不动；`arpCollector.executeTelnet` 改薄壳调 util 消除双份；安全层 `checked` 数组两路径共用（无新增注入面）；输出后处理 telnet 套 decodeGbk+stripAnsi 对齐 SSH。
- **verification**: `electron/services/ai.telnetRouting.test.ts` 7 cases（telnet 分流不实例化 ssh2 Client / SSH 分流不调 telnet / 端口缺省回退 23 / 大小写不敏感 / 空命令短路 / telnet 抛错首条 reject 整批）；三绿门禁全过（tsc exit 0 / build:electron-main exit 0 / vitest 172 全绿无回归）。
- **files_changed**:
  - 新增 `electron/utils/telnetExec.ts` — telnet 自动化 exec 共用 util（arpCollector + ai.ts 共享）
  - 修改 `electron/services/arpCollector.ts` — 删除模块私有 executeTelnet，改薄壳调 executeTelnetCommand
  - 修改 `electron/services/ai.ts` — executeCommandsOnDevice runOne 按 connectionType 分流（telnet→executeTelnetCommand，ssh→原路径）
  - 新增 `electron/services/ai.telnetRouting.test.ts` — connectionType 分流单测 7 cases
