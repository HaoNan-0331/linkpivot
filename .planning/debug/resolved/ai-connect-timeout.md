---
status: resolved
trigger: "AI 调用连接工具 / 自动发现 / AI 对话调用设备均报连接超时，但拓扑双击设备直连正常"
created: 2026-07-05
updated: 2026-07-05
fix_commit: 9416c98
---

# Debug: ai-connect-timeout

## Symptoms

- **Expected**: AI 调用连接工具 / 自动发现 / AI 对话调用设备 应正常 SSH 连接并执行命令（与拓扑双击设备直连一致）
- **Actual**: 均报"连接超时" / "连接设备超时"，命令无法执行
- **Error messages**:
  - 自动发现功能：显示"连接设备超时"
  - AI 对话里调用设备：连接超时
  - AI 调用连接工具：超时报错
- **Timeline**: v1.0 milestone 归档后用户测试中发现。Phase 6 改造了 executeCommandsOnDevice（try/finally + cleanup）与 execOne（补 stream.on('error')），但 git blame 确认 `readyTimeout: 10000` 是既存代码（commit 883bd81, 2026-05-14，v1.0 milestone 之前），**非 Phase 6 回归**。
- **Reproduction**:
  - 拓扑双击设备 → SSH 直连**正常**（arpCollector.executeSSH，readyTimeout: 30000）
  - AI 对话 / 自动发现调设备 → **超时**（ai.executeCommandsOnDevice → buildSSHConfig，readyTimeout: 10000）
- **关键差异**: 直连路径（executeSSH，30s）正常；AI/discovery 路径（executeCommandsOnDevice 经 buildSSHConfig，10s）超时。

## Current Focus

- **hypothesis**: 已确认。`buildSSHConfig`（ai.ts:276）`readyTimeout: 10000`（10s）远小于 `executeSSH`（arpCollector.ts:66）的 `readyTimeout: timeout`（30s）。慢设备 SSH 握手 ready 时间落在 10–30s 区间时，AI/discovery 路径在 10s 触发 ssh2 readyTimeout → client emit 'error' → `finish(()=>reject(err))`（ai.ts:382），各调用方包装为"连接超时"/"连接设备超时"。
- **next_action**: 等待用户选择修复方式（Fix now / Plan / Manual）。
- **reasoning_checkpoint**:
  1. ssh2 语义：`readyTimeout` 是 SSH 握手（TCP connect + KEX + auth → 'ready' 事件）的硬超时；超时后 client emit `'error'`（类似 `Connect timeout` / `ERR_SOCKET_CONNECTION_TIMEOUT`），不是静默挂起。
  2. 时序：AI 路径 `overallTimeout = 30000 + N*15000`（≥30s），但 `readyTimeout=10000` 先 fire（10s < 30s+），故 reject 由 readyTimeout 触发，而非 overallTimer。`overallTimer` 兜底（`命令执行超时 (30s+)`）用户**没看到**这个文案，反向印证是 readyTimeout 路径。
  3. 错误传播：`client.on('error')` → `finish(()=>reject(err))`（ai.ts:382）→ 调用方 catch → 包装"连接超时"/"连接设备超时"（connection.ts:296/308、discovery.ts:202 上游 catch）。
  4. algorithms 次要不一致：ai.ts 多列 `diffie-hellman-group15/16-sha512`、`blowfish-cbc`、`ssh-dss`；arpCollector 多列 `curve25519-sha256`、`aes128-gcm`（无 `@openssh.com`）。可能加剧握手慢/失败，但主因是 readyTimeout 数值。

## Evidence

- 2026-07-05 — ai.ts:271-306 `buildSSHConfig` 字面确认 `readyTimeout: 10000`（硬编码，无设备覆盖入口）。
- 2026-07-05 — arpCollector.ts:24-78 `executeSSH` 字面确认 `readyTimeout: timeout`（默认 30000，与外层 timer 同值，故 ready 阶段可等到 30s）。
- 2026-07-05 — ai.ts:330 `overallTimeout = 30000 + commands.length * 15000`；ai.ts:346-352 overallTimer reject 文案 `命令执行超时 (Ns)`——与用户报错的"连接超时"不符，反向排除 overallTimer 路径。
- 2026-07-05 — ai.ts:382 `client.on('error', (err) => finish(() => reject(err)))`：readyTimeout 触发的 'error' 经此 reject，原始 err.message 含 `timeout`/`ETIMEDOUT`，调用方 connection.ts:308 `err.message.includes('ETIMEDOUT') ? '连接超时'` 命中包装。
- 2026-07-05 — 调用链确认：ai.ts:525（chat 调用设备）/ ai.ts:810（自动发现）/ connection.ts AI 连接工具 三入口全部汇入 `executeCommandsOnDevice` → `buildSSHConfig`（10s）。discovery.ts:202 同样路径。
- 2026-07-05 — git blame（orchestrator 已核查）：`ai.ts:276 readyTimeout: 10000` 由 commit 883bd81（2026-05-14）引入，早于 Phase 6（eef3004/2389bd8），非回归。

## Eliminated

- **Phase 6 回归**：git blame 排除。Phase 6 改 try/finally + cleanup + settled-flag + stream.on('error')，未动 buildSSHConfig/readyTimeout。
- **overallTimer 兜底**：用户报"连接超时"而非"命令执行超时 (30s+)"，且 10s < 30s+，readyTimeout 先 fire。
- **execOne stream.on('error') 误触发**：仅在 ready 成功后才进入 execOne；ready 阶段 10s 已 reject，不会到达 execOne。
- **DEP-1 vitest 实测**：ssh2 native binding ABI 不兼容 plain node，无法在单测复现；真实计时需 Electron 运行时加日志（非根因阻断项，根因已由代码字面 + ssh2 语义确认）。

## Resolution

- **root_cause**: `buildSSHConfig`（electron/services/ai.ts:276）`readyTimeout: 10000` 与 `executeSSH`（electron/services/arpCollector.ts:66）`readyTimeout: timeout`（30000）不一致。慢设备 SSH 握手 ready 时间落在 10–30s 区间时，AI/自动发现/AI 对话三条路径经 `executeCommandsOnDevice → buildSSHConfig` 在 10s 触发 ssh2 readyTimeout → client 'error' → reject，被调用方包装为"连接超时"/"连接设备超时"；而拓扑双击走 `executeSSH`（30s）能等到 ready 故正常。
- **fix_direction**: 将 `buildSSHConfig` 的 `readyTimeout` 与 `executeSSH` 对齐为 30000（或抽公共常量 `SSH_READY_TIMEOUT_MS = 30000`，两路径共用），消除握手阶段超时阈值不一致。可选附带统一 algorithms 列表（次要）。修复点单一（ai.ts:276 一行 + 可选 algorithms 对齐），无需改 Phase 6 的 try/finally/cleanup/settled 逻辑。
- **specialist_hint**: typescript（实际为 Node/ssh2 服务层，但 TS 项目归类 typescript-expert 审查 idiomatic 改法最贴切）。
- **fix_applied**: 已实施（commit 9416c98, 2026-07-05）。彻底修复方案：
  1. 新建 `electron/utils/sshConfig.ts`：抽 `SSH_READY_TIMEOUT_MS = 30000`（握手 ready 超时，两路径共用）与 `SSH_ALGORITHMS`（取 ai.ts/arpCollector.ts 两路径 algorithms 列表并集，保最大设备兼容）。
  2. `ai.ts buildSSHConfig`：`readyTimeout: 10000` → `readyTimeout: SSH_READY_TIMEOUT_MS`；内联 algorithms 块 → `algorithms: SSH_ALGORITHMS`。
  3. `arpCollector.ts executeSSH`：签名 `timeout: number = 30000` → `timeout: number = SSH_READY_TIMEOUT_MS`（`readyTimeout: timeout` 灵活不变）；内联 algorithms 块 → `algorithms: SSH_ALGORITHMS`。
  零签名变更（executeSSH/executeCommandsOnDevice/buildSSHConfig 签名不变），不动 Phase 6 的 try/finally/cleanup/settled 逻辑。三绿门禁：tsc -p tsconfig.web.json + esbuild electron main + vitest run 25/25 全绿。
