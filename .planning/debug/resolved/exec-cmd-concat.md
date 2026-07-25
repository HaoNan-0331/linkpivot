---
slug: exec-cmd-concat
status: resolved
trigger: |
  discovery Phase 3 executeCommandsOnDevice 在单 SSH 连接上串行 exec 多条命令时，从第 2 条起命令字符串被前一条命令（display lldp neighbor-information list）的尾部子串污染，H3C 报 Unrecognized/Wrong command，ARP/version/routing/interface 全无数据，拓扑 edges 为空，发现不准。
created: 2026-07-25
updated: 2026-07-25
goal: find_and_fix
---

# Debug Session: exec-cmd-concat

## Symptoms

- **Expected**: 自动发现正确产出设备间连接关系（edges 非空），ARP/version/routing/interface 等命令均返回真实数据供 AI 拓扑分析。
- **Actual**: discovery topology 分析返回 `edges: []`（无连线）；Phase 3 日志显示命令全 OK，但 ARP/version/routing/interface 输出长度异常一致地卡在 ~500 chars。
- **Error**: H3C 设备回显 `% Unrecognized command found at '^' position.` 与 `% Wrong parameter found at '^' position.`
- **Timeline**: 一直存在。`ai-connect-timeout` debug（commit 9416c98，stream silence + channel retry）修复 channel 层后，命令不再整体失败，本污染问题暴露。
- **Reproduction**: 对 H3C 设备（server / 核心）触发自动发现，查 `ai_system_logs` 表 `type=discovery` 最近 Phase 4 topology prompt 的 `prompt_text`（含 collectionText），可见第 2 条起命令回显被污染。

## Root Cause（已查明 — DB 日志铁证）

H3C SSH server 把 `exec` request 的命令**通过 vty 逐字符注入 console**。`executeCommandsOnDevice` 在**单个 SSH 连接（同一 client）上串行调用 `client.exec` 多条命令**，前一条命令字符串的尾部字符尚未被设备 console 消费完毕，下一条 exec request 的命令即追加注入，导致命令字符串粘连。叠加 `execOne` 的 silence 2s 提前 resolve（H3C exec 不主动 close channel），下一条命令发送过快，加剧粘连。

**设备实际收到的命令（从 H3C 回显还原）**：

| 期望发送 | 设备收到 | 结果 |
|---|---|---|
| display lldp neighbor-information list | display lldp neighbor-information list | ✅ 正常 |
| display arp | display arpp neighbor-information list | % Unrecognized |
| display version | display versionighbor-information list | % Unrecognized |
| display ip routing-table | display ip routing-tableformation list | % Unrecognized |
| display interface brief | display interface briefeformation list | % Wrong parameter |

追加的尾巴均为第 1 条命令 `display lldp neighbor-information list` 的后缀子串（`p neighbor-information list` → `ighbor-information list` → `formation list` → `eformation list`，逐步缩短）。

**影响**：仅第 1 条命令（LLDP）有数据，ARP/version/routing/interface 全报错无输出 → AI 拓扑分析素材残缺 → edges 推断为空 → 发现不准。

**证据来源**：`ai_system_logs` 表（`C:/Users/wanghaonan/AppData/Roaming/network-topology-manager/topology.db`），`type=discovery`，`prompt_text` 含 collectionText 的 Phase 4 记录（2026-07-25 13:35:46 / 13:16:41 等）。Phase 3 summary 显示全 OK（命令执行层正常），污染发生在命令字符串进入设备 vty 之前。

## Fix Plan（方案 A — 用户已确认）

**`executeCommandsOnDevice` 改为每条命令独立 SSH 连接**：

- 每命令 `new Client → connect(buildSSHConfig) → exec → end`
- 不同 SSH session = 不同 vty，物理隔离，彻底杜绝命令字符串粘连
- 仍用 `exec`（非 PTY），不引入注入面，不改白名单 / 安全模型
- 复用 `electron/utils/sshConfig.ts` 的 `SSH_READY_TIMEOUT_MS` / `SSH_ALGORITHMS`
- `execOne`（单命令 stream silence + retry + timeout 逻辑）签名 / 行为基本不变：仍接收 `client` + `command`，由调用方负责每命令 `new Client` 并在结束后 `end`

**代价**：握手次数 = 命令数（单设备 5 条约 10s，可接受，远好于历史卡顿）。

**改动范围**：`electron/services/ai.ts` 的 `executeCommandsOnDevice`（line 291-385）。`execOne`（line 389-460）内部 stream 处理保留。

## Files Changed

- [x] `electron/services/ai.ts` — `executeCommandsOnDevice` 重构为每命令独立 SSH 连接（line 291-386），已实施，三绿（tsc/esbuild/vitest 25/25）

## Current Focus

- **hypothesis**: 单 SSH 连接串行 exec 致 H3C vty 命令字符串粘连；每命令独立连接可物理隔离消除粘连。
- **test**: 修后对 H3C 设备跑自动发现，查 `ai_system_logs` collectionText，确认第 2 条起命令回显干净（`display arp` 不再带 `neighbor-information list` 尾巴），ARP/version/routing/interface 输出非 ~500 chars 报错回显而是真实数据，topology edges 非空。
- **expecting**: 设备回显与发送命令逐字一致；输出长度反映真实数据规模；edges 出现设备间连接。
- **next_action**: 实施方案 A（`executeCommandsOnDevice` 每命令独立 `new Client`，保留 `execOne` stream 处理），tsc + esbuild + vitest 三绿后启动应用实测。

## Evidence

- timestamp: 2026-07-25 — `ai_system_logs` discovery Phase 3 summary 全 OK（A+B+C 修复后命令不再失败），但 ARP/version/routing/interface 输出卡在 ~500 chars，LLDP 较长（734 / 1020）
- timestamp: 2026-07-25 — Phase 4 collectionText 显示第 2 条起命令被第 1 条 lldp 命令尾部污染（`display arp` → `display arpp neighbor-information list` 等），H3C 回 `% Unrecognized/Wrong command`
- timestamp: 2026-07-25 — 所有 topology 分析 `edges: []`（13:35:46 / 13:16:41 / 13:07:26 / 13:06:00）

## Eliminated

- hypothesis: 命令执行失败 / 超时（channel 层问题）— 已由 `ai-connect-timeout` debug（commit 9416c98）修复，Phase 3 日志显示全 OK，排除
- hypothesis: 输出被 silence 2s 截断 — 长度 ~500 一致是命令报错回显（`Unrecognized` + prompt），非真实数据被截断；根因为命令字符串本身被污染致设备报错


## Resolution

- **root_cause**: `executeCommandsOnDevice` 在单个 SSH 连接上串行 `client.exec` 多条命令，H3C vty 逐字符注入 console 致命令字符串粘连（第 2 条起被第 1 条 `display lldp neighbor-information list` 尾部污染），ARP/version/routing/interface 全报 `% Unrecognized/Wrong command` → 拓扑 `edges: []`。
- **fix**: `executeCommandsOnDevice` 重构为【每条命令独立 SSH 连接】（`runOne(idx)`：`new Client → connect → execOne → end`），不同 session = 不同 vty 物理隔离彻底消除粘连；签名零改、结果同序同长；`execOne` stream silence/retry/timeout 逻辑不变。
- **status**: 已实施，三绿门禁通过（tsc web strict + esbuild 主进程 + vitest 25/25）。待人工 HV（H3C 设备实测自动发现，确认 collectionText 第 2 条起命令回显干净、edges 非空）。

## Evidence (post-fix)

- timestamp: 2026-07-25 — `electron/services/ai.ts` `executeCommandsOnDevice` 重构落地（每命令独立 `new Client` → connect → ready → execOne → end），首条连接失败 reject 整批、后续连接失败填 success:false 保结果同长；复用 SSH_READY_TIMEOUT_MS / SSH_ALGORITHMS；`execOne` 未改
- timestamp: 2026-07-25 — 三绿门禁通过：`npx tsc -p tsconfig.web.json --noEmit` exit 0；`esbuild electron/main.ts` exit 0（dist-electron/main.js 1.8mb）；`npx vitest run` 25/25 passed（4 files）
- timestamp: 2026-07-25 — 对外契约零改：discovery.ts:202 / chat auto(852) / confirmCommand(567) / executeCommandOnDevice(462) 四调用方均依赖 results[i] ↔ commands[i]，新实现保持同序同长不变

## Eliminated (post-fix)

- hypothesis: 命令字符串粘连（vty 逐字符注入 + 单连接串行 exec）—— 已由方案 A 每命令独立连接物理隔离消除，待 H3C 实测 HV 最终确认
