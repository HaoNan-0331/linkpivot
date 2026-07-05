# Phase 6: Robustness & Resource Safety — 人工验收 (HUMAN-UAT)

**关联决策：** D-6-5（CONTEXT.md）
**关联 plan：** 06-01-PLAN.md（ROBUST-01 句柄回收）、06-02-PLAN.md（ROBUST-02 错误上下文 + safeLog）
**为何人工：** DEP-1（CONCERNS.md line 212+）—— ssh2/telnet-client/better-sqlite3 native binding 为 Electron ABI 145 编译，plain Node/vitest ABI 137 实例化真实 client 报 ERR_DLOPEN_FAILED；mock client 不持有真实 socket，句柄计数无意义。句柄泄漏验收必须真实 Electron 运行时 + 真实 SSH/Telnet 设备。

**验收口径映射：**
- HV-1 / HV-2 → SC#4（反复触发采集/发现循环后无句柄泄漏，ROBUST-01）
- HV-3 → SC#1 + SC#4 的 error 路径兜底（ROBUST-01 finally 在 error/timeout 路径生效）
- HV-4 → SC#2 + SC#3（ROBUST-02 parse 失败错误上下文 + createSystemLog 非致命）

---

## 前置准备

1. **构建**：在真实 Windows Electron 开发环境执行
   - `npx tsc -p tsconfig.web.json`（须 exit 0）
   - electron main esbuild 打包脚本（须 exit 0）
   - `npx vitest run`（须 exit 0，既有 25 项无回归）
2. **设备清单**：至少 1 台真实 SSH 设备（华为/H3C/Cisco 任一）+ 1 台 Telnet 设备，凭证已录入设备管理。
3. **DevTools 句柄快照获取方式**：在 Electron 主进程入口（main.ts）临时注入（验证后删除，不提交）：

```typescript
// 临时调试代码（验证完删除）—— process._getActiveHandles 是 Node 私有 API，Electron 主进程可用
function snapshotHandles(tag: string) {
  const handles = (process as any)._getActiveHandles()
  const types: Record<string, number> = {}
  for (const h of handles) {
    const t = h?.constructor?.name || 'unknown'
    types[t] = (types[t] || 0) + 1
  }
  console.log(`[HANDLE-SNAPSHOT] ${tag} total=${handles.length}`, types)
}
// 在 IPC 暴露一个临时窗口：ipcMain.handle('debug:snapshot-handles', (_, tag) => snapshotHandles(tag))
```

渲染层调用方式（DevTools Console）：`window.electronAPI.debugSnapshotHandles?.('after-round-N')`（或对应 preload 暴露名；executor 按实际临时通道名）。

---

## HV-1：SSH ARP 采集反复触发无句柄泄漏（SC#4 / ROBUST-01）

**目的：** 验证 executeSSH（arpCollector.ts）try/finally 在 ready/stream close/stream error/exec err/client error/timeout 全路径回收 socket + timer，5+ 轮采集后 active handles 不单调增长。

**步骤：**
1. 启动 Electron，DevTools 打开主进程控制台（或主进程日志窗口）。
2. 触发前快照：`snapshotHandles('before-ssh-round-0')`，记录 `total` 与各 type 计数。
3. 触发 1 轮 `ARPCollector.collectFromAll()`（UI 上 ARP 采集按钮，或 IPC 通道），等待完成。
4. 快照：`snapshotHandles('after-ssh-round-1')`。
5. 重复步骤 3-4 共 5 轮（round-2 ~ round-5），每轮后快照。

**预期：**
- 每轮采集完成后 `total` 回落到接近 round-0 基线（允许 ±2 浮动，因 JS runtime 内部 timer/socket 抖动）。
- `total` 不随轮数单调增长（round-5.total 不应 > round-1.total + 3）。
- SSH-related handle type（如 `Socket` / `TLSSocket` 计 ssh2 channel）在每轮后回落到 round-0 水平，不残留。

**失败判据：** round-5.total 显著 > round-1.total（> +5）或 Socket 计数单调增长 → finally 未覆盖某路径，回查 executeSSH cleanup 出口。

---

## HV-2：Telnet ARP 采集 + discovery 反复触发无句柄泄漏（SC#4 / ROBUST-01）

**目的：** 验证 executeTelnet（arpCollector.ts，含补的自有 setTimeout）与 executeCommandsOnDevice（ai.ts）try/finally 在 discovery 路径回收 socket + timer。

**步骤：**
1. 触发前快照：`snapshotHandles('before-discovery-0')`。
2. 触发 1 轮 discovery（UI 上拓扑发现，选 1-2 台 SSH 设备），等待完成。
3. 快照：`snapshotHandles('after-discovery-1')`。
4. 重复步骤 2-3 共 2-3 轮，每轮后快照。
5. 切换到 Telnet 设备触发 1 轮 ARP 采集（验证 executeTelnet 自有 setTimeout 路径），快照。

**预期：**
- discovery 每轮后 total 回落到接近基线（discovery 内 executeCommandsOnDevice 多命令串行 exec，handle 峰值高于单次 ARP，但轮末应回落）。
- Telnet 采集后 total 回落，无残留 Telnet socket。

**失败判据：** 轮末 total 单调增长或 Telnet Socket 残留 → executeCommandsOnDevice 或 executeTelnet finally 未覆盖某路径。

---

## HV-3：error / timeout 路径 finally 兜底（SC#1 + SC#4 / ROBUST-01）

**目的：** 验证 executeSSH/executeTelnet/executeCommandsOnDevice 在错误凭证 / 不可达 IP / 超时设备场景下 finally 仍执行 cleanup，连接不残留。

**步骤：**
1. **错误凭证**：临时改 1 台 SSH 设备密码为错误值，触发 ARP 采集（client.on('error') 路径），快照前后。
2. **不可达 IP**：临时改 1 台设备 IP 为 192.0.2.1（TEST-NET-1， guaranteed 不可达），触发 ARP 采集，观察 readyTimeout / 自有 setTimeout 兜底（timeout fire 路径 end+destroy），快照前后。
3. **超时设备**：若可构造（如设备 ready 但 exec 不返回，模拟较难，可跳过或仅用不可达 IP 替代），观察 timeout fire 后 socket 是否 destroy。

**预期：**
- 每种错误路径触发后，active handles 回落到基线，无残留 Socket / Timer。
- 错误信息透传到 `ARPCollectionResult.error` 字段（arpCollector.ts:91）或 discovery failedDevices（discovery.ts:172），文案符合预期（如 `SSH timeout after 30000ms`）。
- timeout fire 路径：日志/UI 错误文案为超时，handle 回收（client.destroy 强制销毁生效）。

**失败判据：** 错误路径后 handle 残留 → 该路径未走 cleanup（如 client.on('error') 路径漏 end），回查对应函数 cleanup 出口覆盖。

---

## HV-4：discovery JSON parse 失败错误上下文 + createSystemLog 非致命（SC#2 + SC#3 / ROBUST-02）

**目的：** 验证 enriched errorMessage 含「原始片段: slice(0,200)」+ command parse 补 safeLog + createSystemLog 失败不中断主流程。

**步骤：**

### 4a. parse 失败错误上下文（SC#2）

1. **mock AI 返回非 JSON**：临时修改 callAI 返回值或拦截 AI 响应为非 JSON 文本（如 `"这是非JSON的解释文本，无法解析"`），或直接修改 `commandAiResponse` / `aiResponse` 变量为非 JSON 字符串（验证用临时 patch，验证后回滚）。
2. 触发 discovery。
3. 观察抛出的 Error message：应含 `原始片段: 这是非JSON的解释文本...`（前 200 字符）。
4. 查询 `ai_system_logs` 表：`SELECT error_message FROM ai_system_logs WHERE type='discovery' AND status='failed' ORDER BY created_at DESC LIMIT 5`，验证 errorMessage 字段含 `| 原始片段:`。

### 4b. command parse 补 safeLog（D-6-3 对齐）

1. 触发 command parse 失败（mock AI 返回 command 阶段非 JSON）。
2. 查询 `ai_system_logs`：应有 type=discovery status=failed 的记录，且 promptText（commandPromptText）+ aiResponse（commandAiResponse）+ errorMessage（含原始片段）齐全（与 topology parse 失败记录对齐）。

### 4c. createSystemLog 非致命（SC#3 / D-6-4 safeLog）

1. **模拟 DB 写库失败**：临时让 createSystemLog 抛错（如临时改 ai_system_logs 表名为不存在的表，或临时锁 DB，或在 safeLog 调用前注入 throw——executor 选最低侵入方式，验证后回滚）。
2. 触发 discovery（成功路径，应触发 5 处 safeLog 中的成功 safeLog）。
3. **预期**：主流程不被中断，discovery 正常返回结果（或正常抛 AI 业务错误，而非 DB 写库错误）；主进程 console 出现 `[safeLog] discovery 日志写库失败` warn 日志（console.warn 兜底，D-6-4 可观测性）。
4. 回滚 DB 改动。

**失败判据：**
- 4a：errorMessage 不含 `原始片段:` → enrichParseError 未生效，回查 discovery.ts Task 2。
- 4b：command parse 失败无 ai_system_logs 记录 → command parse 补 safeLog 漏改。
- 4c：DB 写库失败中断主流程（抛 DB 错到调用方）→ safeLog 包裹漏某处，回查 5 处替换完整性（grep `createSystemLog({` 应为 0）。

---

## 验收结果回填模板

| HV ID | 关联 SC | 关联 plan | 状态 (pass/fail) | 句柄快照基线 total | 末轮 total | 备注 |
|-------|---------|-----------|------------------|---------------------|------------|------|
| HV-1 | SC#4 | 06-01 | pending | - | - | |
| HV-2 | SC#4 | 06-01 | pending | - | - | |
| HV-3 | SC#1/SC#4 | 06-01 | pending | - | - | |
| HV-4a | SC#2 | 06-02 | pending | - | - | |
| HV-4b | SC#2 | 06-02 | pending | - | - | |
| HV-4c | SC#3 | 06-02 | pending | - | - | |

**全部 pass 后**：在 06-VERIFICATION.md（或对应 verification 产物）回填 HV-1~HV-4 pass，Phase 6 status 标 `human_passed`。

**重要收尾：** 验证完成后删除临时调试代码（main.ts 的 snapshotHandles + IPC 临时通道 + 任何 callAI/DB mock patch）。临时调试代码不提交（项目规范：临时脚本/调试代码用完即删）。

---

*Phase 6 HUMAN-UAT defined: 2026-07-05*
*Per D-6-5（CONTEXT.md）：静态 grep + Electron 人工 HV 验收，不自动化句柄计数（DEP-1 限制）。*
