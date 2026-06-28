# Codebase Concerns

**Analysis Date:** 2026-06-28
**Scope:** full repo（network_toplogy — Electron + React + TypeScript + better-sqlite3）
**Method:** ROADMAP Phase 4-6 待做技术债 + 02/03-VERIFICATION 残留 anti-patterns + CHANGELOG 审计批1-4b 已修历史 + 全量 grep（`: any` / TODO / FIXME）

> **阅读说明：** 本文档区分两类条目——
> **[已修]** CHANGELOG 审计批1-4b 修复项（仅作历史参照，列在末尾「已缓解项」）；
> **[待做/残留]** 当前代码仍存在的 debt，按 **critical / high / medium / low / info** 分级。每条标注 ROADMAP 对应 Phase（P4/P5/P6）或验证债（HV）。

---

## Tech Debt

### TD-1 `any` 类型大面积泄漏（276 处 / 37 文件）[待做 · P5 FE-02] · severity: medium

- **Issue:** 全仓库 `: any` / `as any` / `: any[]` / `<any>` 共 **276 occurrences across 37 files**。前端尤为密集，IP 管理 4 个 Tab + KnowledgeBasePage + AIPage 的 `api: any` props 与 `catch (e: any)` 满天飞；后端 `electron/services/*.ts` 的 better-sqlite3 row 普遍 `.get() as any` / `.all() as any[]`。
- **Files:**
  - 前端热点：`src/components/ip-management/{ArpTab,AnomalyTab,NetworkTab,OuiTab}.tsx`（props `api: any`）、`src/components/pages/AIPage.tsx`（4 处）、`src/components/pages/KnowledgeBasePage.tsx`（17 处，全页最多）、`src/components/pages/SettingsPage.tsx`（8 处）、`src/components/pages/DevicesPage.tsx`（4 处）
  - 后端热点：`electron/services/ai.ts`（23 处，含 `device: any` / `buildSSHConfig(device: any)`）、`electron/services/device.ts`（12 处）、`electron/services/topology.ts`（12 处）、`electron/services/networkSegmentService.ts`（13 处）、`electron/services/knowledgeBaseService.ts`（33 处，后端最多）、`electron/services/ouiService.ts`（12 处）
  - 类型声明缺口：`src/types/electron.d.ts`（12 处 `Promise<any>`，device/topology/connection/kb handler 返回类型未建模）
  - mock：`src/mock-api.ts`（11 处，dev-only 浏览器预览模式）
- **Impact:** `tsconfig.web.json` 严格模式 + noUnusedLocals 对 `any` 不报错，类型安全形同虚设；重构（重命名 DB 列、改 IPC 签名）无编译期保护，回归风险高；`device: any` 导致 `buildSSHConfig` 访问 `device.password` 等字段无类型校验。
- **Fix approach:** ROADMAP Phase 5 FE-02。前端 `api: any` → 改用 `window.api` 强类型（`src/types/electron.d.ts` 已声明 `DeviceAPI`/`TopologyAPI` 等，补全 `ip-management` 子接口）；后端 better-sqlite3 row 定义 `interface XxxRow` 替代 `as any`（参考 `src/types/device.ts` / `src/types/network.ts` 已有 DTO）。优先级：先收 `electron.d.ts`（一处修复多处受益）+ 4 个 IP Tab + KnowledgeBasePage。**注意 mock-api.ts 为 dev-only，可保留宽松。**

### TD-2 AIPage / KnowledgeBasePage / ai.ts / knowledgeBaseService.ts 超大单文件 [待做 · P5 FE-01/FE-04] · severity: medium

- **Issue:** 单文件过千行，职责混杂，AIPage 需拆分、knowledgeBaseService 无拆分计划但同等臃肿。
- **Files:**
  - `src/components/pages/AIPage.tsx`（399 行，FE-01 待拆 ChatSessionList/ChatMessageList/ChatInput/CommandConfirmModal 4 子组件）
  - `src/components/pages/KnowledgeBasePage.tsx`（540 行，内嵌 `ChunkContent` 子组件 + 搜索/上传/编辑/拆分/合并多模态）
  - `electron/services/ai.ts`（827 行，配置管理 + SSH 执行 + 对话 + 命令安全 + 日志 + 设备查询杂糅）
  - `electron/services/knowledgeBaseService.ts`（759 行，PDF 解析 + 图片提取 + FTS 索引 + CRUD + 搜索）
- **Impact:** 维护成本高，局部改动易引入副作用；ai.ts 单文件 827 行违反单一职责（配置/执行/对话应分层）。
- **Fix approach:** P5 FE-01 先拆 AIPage；ai.ts 建议后续拆 `ai/config.ts` / `ai/executor.ts` / `ai/chat.ts`（非当前 milestone scope，登记为后续 debt）。

### TD-3 `ipInCIDR` / `ipToNumber` 逻辑重复两份 [残留 · IN-02] · severity: low

- **Issue:** `electron/services/networkSegmentService.ts:5-19` 与 `electron/services/anomalyService.ts:45-66` 各有一份 IPv4→数值 + CIDR 匹配实现。
- **Files:** `electron/services/networkSegmentService.ts:5-19`、`electron/services/anomalyService.ts:45-66`
- **Impact:** 两份逻辑各自演进易发散（anomalyService 版已因 WR-04 加健壮性，networkSegmentService 版未同步），bug 修一处漏一处。
- **Fix approach:** 抽 `electron/utils/ipMath.ts` 共享 util，两处 import。非当前 milestone scope。

---

## Known Bugs

### BUG-1 `AnomalyService.getStats` `new_ip` 计数恒为 0 [残留 · IN-01] · severity: low

- **Symptoms:** IP 异常统计页「新增 IP」数永远显示 0。
- **Files:** `electron/services/anomalyService.ts:172-181`（`newIp: COUNT(change_type='new_ip')`）
- **Trigger:** `processARPEntries` 写 `ip_mac_changes` 时无任何代码路径写入 `change_type='new_ip'`，该字面量只在 `getStats` 的 SQL 出现。
- **Workaround:** 无（功能缺失，非崩溃）。Phase 3 未触碰 getStats，预存缺陷。
- **Fix approach:** 在 `processARPEntries` 中对「首次见到的 IP」写 `change_type='new_ip'`，或从 `getStats` 移除该字段避免误导。非当前 milestone scope。

### BUG-2 `BackupScheduler.pruneBackups` `retention=0` 删光全部备份 [残留 · WR-02] · severity: high

- **Symptoms:** 用户将 `backup_config.periodic_retention` 或 `premigration_retention` 配为 0，下一次备份触发时 `files.slice(0)` 删除该桶**全部**历史备份（含刚创建的）。
- **Files:** `electron/services/backupScheduler.ts:89-104`（`const toDelete = files.slice(retention)`）
- **Trigger:** `schedulerIpc.ts` 入参校验（interval 1-10080）未覆盖 retention 字段；`BackupScheduler.updateConfig` 直接透传用户值，无 clamp。
- **Workaround:** 用户勿配 0。但这是数据安全风险（备份是 ARCH-02 安全网）。
- **Fix approach:** `pruneBackups` 入口 clamp `retention = Math.max(1, retention)`；`schedulerIpc.ts` updateConfig 校验 retention ≥ 1。Phase 2 VERIFICATION 标注「需 clamp」，可在 Phase 6 ROBUST-01 一并处理或单独 hotfix。

### BUG-3 `app.before-quit` 不等 in-flight backup，退出可能截断备份 [残留 · WR-04] · severity: medium

- **Symptoms:** 用户退出 app 时若周期备份（`getDatabase().backup(backupPath)`）正在进行中，`before-quit` 同步调用 `BackupScheduler.stop()` + `closeDatabase()`，不等待异步 backup 完成，可能生成损坏的 `.db.bak`。
- **Files:** `electron/main.ts:171`（`app.on('before-quit', () => { BackupScheduler.stop(); closeDatabase() })`）；`backupScheduler.ts:64`（async `executeTask`）
- **Trigger:** 备份进行中关闭窗口/退出 app。
- **Fix approach:** `before-quit` 改为 async event handler（`e.preventDefault()` + `await` in-flight backup + `app.exit()`），或 `BackupScheduler` 暴露 `awaitPending()` 守卫。Phase 2 VERIFICATION 标注，可在 Phase 6 ROBUST-01 处理。

### BUG-4 discovery JSON parse 失败错误上下文不足 [待做 · P6 ROBUST-01] · severity: medium

- **Symptoms:** AI 返回非 JSON 或截断 JSON 时，`discovery.ts:273` 抛 `AI 分析结果解析失败: ${err.message}`，不含原始内容片段与解析位置，运维无法定位是 AI 漂移还是截断。
- **Files:** `electron/services/discovery.ts:136-144`（命令 JSON parse）、`electron/services/discovery.ts:250-274`（拓扑 JSON parse）
- **Trigger:** AI 返回非严格 JSON（含解释文本、截断、转义错误）。
- **Fix approach:** ROADMAP Phase 6 ROBUST-02。catch 块携带 `aiResponse.slice(0, 200)` 原始片段 + `err.message`（含位置），写 `createSystemLog` 已在 line 266-272 部分做了，但 `commandAiResponse` 的 parse（line 142-144）未带上下文直接 throw。

### BUG-5 discovery `createSystemLog` 调用未 try/catch，日志写库失败影响主流程 [待做 · P6 ROBUST-02] · severity: medium

- **Symptoms:** `discovery.ts` 多处 `createSystemLog({...})`（line 116-122 / 126-132 / 240-247 / 258-264 / 266-272）直接调用，若 DB 异常（如 ai_system_logs CHECK 窄库 v6 前场景、DB 锁）抛出，会中断发现流程。
- **Files:** `electron/services/discovery.ts:116,126,240,258,266`
- **Trigger:** DB 写日志失败时恰好在发现流程中。
- **Fix approach:** ROADMAP Phase 6 ROBUST-02「createSystemLog 调用被 try/catch 包裹，日志写库失败不影响主流程」。包装为 `try { createSystemLog(...) } catch { /* 非致命 */ }`。

---

## Security Considerations

### SEC-1 IPC 鉴权网关 `secure` 覆盖完整 [已验证 · 无 gap] · severity: info

- **Risk:** 特权 handler 漏包 `secure` 导致未登录可调用。
- **Files:** `electron/utils/authGuard.ts:31-41`（`secure` = 登录态校验 + `sanitizeMessage` 异常脱敏）、`electron/main.ts:106-163`、`electron/ipc/*.ts`（7 文件全部 `secure` 包装）
- **Current mitigation:** **完整覆盖**。`auth:*`（4 handler）登录前可用、不鉴权（设计如此）；其余全部特权 handler（device/topology/connection/terminal/ai/anomaly/arp/network/oui/export/scheduler/kb）grep 确认 100% `secure(...)` 包装。`secure` 在 try 之外 reject 未登录，不被脱敏覆盖。
- **Recommendations:** 维持现状。新增 handler 必须包 `secure`（建议加 lint 规则：`ipcMain.handle` 必须包 `secure`/`safe`）。

### SEC-2 命令白名单 `commandSafety` 三层防护 [已加固 · 批1] · severity: info

- **Files:** `electron/services/commandSafety.ts`、`electron/services/ai.ts:308-369`（`executeCommandsOnDevice` 执行层强制 `isCommandAllowed` 作为最后防线）
- **Current mitigation:**
  1. `SEPARATOR_RE`（`electron/services/commandSafety.ts:14`）拒绝多命令分隔符 `\r \n ; & \` $() && ||`（保留 `|` 管道过滤不误杀华为/Cisco `| include`）
  2. `BLOCKED_FIRST_WORDS`（line 17-22）首词黑名单：`shutdown/configure/delete/reset/reboot/system-view/interface/vlan/acl/aaa/no` 等
  3. 白名单首词严格相等匹配（非前缀子串），其余拒绝
  4. `executeCommandsOnDevice`（ai.ts:316-320）执行层强制再校验一次，不依赖调用方
  5. ai.ts 由交互式 `client.shell` 改非交互 `client.exec`（批1），杜绝注入
- **Recommendations:** 维持。注意 `BLOCKED_FIRST_WORDS` 是静态白盒，新型厂商配置命令需手动补。

### SEC-3 CSP / webSecurity 加固 [已加固 · 批2] · severity: info

- **Files:** `electron/utils/webSecurity.ts`（`hardenWindow`）、`electron/main.ts:58-77`（CSP + 全局 web-contents-created 兜底）
- **Current mitigation:**
  - 主窗口 + 终端窗口 `contextIsolation:true / nodeIntegration:false / sandbox:true`（`main.ts:37-39`）
  - production 严格 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:`（`main.ts:69`）
  - `will-navigate` 阻止外链跳转（webSecurity.ts:10-12）；`setWindowOpenHandler` 转系统浏览器（line 13-16）；全局 `web-contents-created` 兜底（main.ts:75-77）
  - dev 模式跳过 CSP 注入以兼容 vite HMR（main.ts:61-64）—— **生产构建必须 NODE_ENV!=development**
- **Risk:** dev 与 production 行为分歧，若打包流程误带 dev 标志，CSP 失效。
- **Recommendations:** 确保 `electron-builder` 打包产物 `NODE_ENV=production`；考虑 build 时断言。

### SEC-4 AES-256-GCM 加密 + safeStorage 主密钥 [已加固 · 批1/批2] · severity: info

- **Files:** `electron/utils/crypto.ts`、`electron/utils/keyManager.ts`
- **Current mitigation:**
  - 主密钥 `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密落盘（keyManager.ts:20-37），绑定机器+用户；兼容历史明文回退（line 23-28）
  - 字段加密 `v2:` 前缀 + 12 字节 IV（GCM 推荐，crypto.ts:30-38），兼容历史 16 字节 IV 密文零迁移（decrypt:41-54）
  - `deriveKey` LRU 缓存避免列表场景重复 pbkdf2Sync 10 万次（crypto.ts:13-27）
  - `verifyPasswordSync` 结构校验 + 长度上限 1024（防 pbkdf2 超长 DoS）+ 等长保护 + timingSafeEqual（crypto.ts:67-82）
  - `decField` try/catch（crypto.ts:93-102）单条坏密文不阻断整列表
- **Risk:** `safeStorage` 不可用时（headless）主密钥明文落盘（keyManager.ts:35），有 console.error 警告但无拒绝启动。
- **Recommendations:** 可考虑 safeStorage 不可用时拒绝写入凭证（仅允许只读），非当前 scope。

### SEC-5 路径遍历 / 图片 MIME 防护 [已加固 · 批1] · severity: info

- **Files:** `electron/ipc/knowledgeBaseIpc.ts:40`（`kb:getImageData`）、`electron/services/knowledgeBaseService.ts`
- **Current mitigation:** `imagePath` 限定 `imgDir()` 目录白名单内；MIME 按文件头魔数探测（非扩展名），防伪造。
- **Recommendations:** 维持。

### SEC-6 `secure` 异常脱敏范围 [残留 · 低风险] · severity: low

- **Risk:** `authGuard.ts:17-24` `sanitizeMessage` 仅移除 Windows 绝对路径 (`[A-Za-z]:\\`) 与 Unix 路径前缀（usr/home/Users/tmp/var/opt），SQL 片段、堆栈、库内部错误结构可能仍部分泄露给渲染层。
- **Files:** `electron/utils/authGuard.ts:17-24`
- **Current mitigation:** 完整 error `console.error` 到主进程日志（line 37/49），渲染层只收截断 message（≤200 字符）。
- **Recommendations:** 可加 SQL 关键字（`SELECT/INSERT/UPDATE/near "."`) 正则脱敏。非当前 scope。

---

## Performance Bottlenecks

### PERF-D1 IPC 大数据通道无分页/上限 [待做 · P4 DATA-01] · severity: high

- **Problem:** 4 个大数据 IPC 通道一次性序列化全量结果集，超 10000 行 ARP 表 / IP 详情时单次 IPC payload 过大，阻塞主进程序列化与渲染层反序列化。
- **Files:**
  - `electron/services/networkSegmentService.ts:88` `getIPDetails(...)` 返回全量 `any[]`，无 limit/offset/maxRows
  - `electron/ipc/ouiIpc.ts:8` `oui:getAll` → `OUIService.getAll()` 全量
  - `electron/ipc/anomalyIpc.ts:20` `anomaly:getChanges` 仅 limit 参数（默认 100），无 offset 分页
  - `electron/services/exportService.ts:28-30` `exportARPTable` 全量 `SELECT ... GROUP BY ip, mac` 导出 CSV（虽落盘不经 IPC，但全量查库）
- **Cause:** ROADMAP Phase 4（DATA-01）尚未开始（STATE.md Phase 4 status: Not started）。
- **Improvement path:** Phase 4 为 4 通道加 `limit/offset` 或 `maxRows` 参数，默认值保证旧调用行为不变。建议优先级：`getIPDetails`（/24 网段可达数千行）> `oui:getAll`（seed ~150 行但用户可导入）> `getChanges`（已部分有 limit）。

### PERF-D2 `processARPEntries` 事务化 / OUI N+1 / FTS WHEN [已修 · Phase 3] · severity: info

- **已修：**
  - PERF-01 OUI N+1：`ouiService.ts:5,25-55` `vendorMap` 预载 + `getVendor` 读 Map（O(1)），`networkSegmentService.ts:106` 单查
  - PERF-02 `processARPEntries` 单事务：`anomalyService.ts:113-125` `db.transaction` 整批 + 4 prepared 复用 + WR-01 savepoint
  - PERF-03 FTS WHEN：`init.ts:274-275` + `migrations.ts:178-187` v7 两处 `WHEN OLD.content IS NOT NEW.content` 逐字一致
  - PERF-04 init 跳过：`init.ts:298-303` + `migrations.ts:217-223` 两处幂等跳过日志 + `main.ts:80,86` `performance.now()` 计时
- **运行时验证债：** 见 HV-1~HV-5（better-sqlite3 native binding 限制，静态全绿，运行期待 Electron 实测）。

---

## Fragile Areas

### FRAG-1 arpCollector `executeSSH`/`executeTelnet` 句柄泄漏 [待做 · P6 ROBUST-01] · severity: high

- **Files:** `electron/services/arpCollector.ts:24-50`（`executeSSH`）、`arpCollector.ts:52-65`（`executeTelnet`）
- **Why fragile:**
  - `executeSSH`（line 24-50）多个 early-return/error 路径未用 try/finally 保证 `client.end()`：line 32 `if (err) { client.end(); reject(err); return }`、line 36 close 时 end、line 37 stream error 时 end——但若 `client.on('ready')` 回调内 `client.exec` 抛同步异常，client 可能不 end；`timeoutId`（line 27）仅在 ready/error 清除，stream error/close 路径不清 timeout（已 end 但 timer 仍可能 fire 后 `client.destroy()`）。
  - `executeTelnet`（line 52-65）：`connection.end()` + `connection.destroy()` 在 try 之外，若 `connection.exec` 抛错，连接句柄泄漏。
  - 反复触发采集循环后 SSH client / Telnet connection / setTimeout 计数可能单调增长（ROADMAP Phase 6 SC#4 验收点）。
- **Safe modification:** ROADMAP Phase 6 ROBUST-01。统一改 try/finally：`try { ... } finally { clearTimeout(timeoutId); try { client.end() } catch {} }`。注意 `ai.ts:executeCommandsOnDevice`（line 322-368）已用 `settled` flag + 各路径 `clearTimeout` + `client.end()`，相对健壮但仍非 try/finally 模式，P6 一并审视。
- **Test coverage:** 无（better-sqlite3 限制外，SSH/Telnet 也无单测）。

### FRAG-2 静默吞错点散落 [残留 · 多处] · severity: medium

- **Files:**
  - `src/components/pages/KnowledgeBasePage.tsx:42` `catch { /* ignore */ }` 图片加载失败静默
  - `src/components/pages/KnowledgeBasePage.tsx:123` `.catch(() => {})` device.list 失败静默
  - `electron/services/backupScheduler.ts:52,99,102` 多处 `catch { /* 非致命 */ }`
  - `electron/services/keyManager.ts:23` `catch { /* 回退明文 */ }` safeStorage 解密失败静默
  - `electron/ipc/arpIpc.ts:17` 仅 `UNIQUE|CONSTRAINT` 记日志，其他写库失败完全静默
- **Why fragile:** 部分为设计意图（非致命），但 `KnowledgeBasePage.tsx:42` 图片加载失败用户无任何反馈（应有 fallback 占位）。
- **Safe modification:** 区分「致命」与「非致命」：非致命保留 catch 但加 `console.warn`（main 进程）或 UI message（渲染层）；图片失败显示占位符。

### FRAG-3 `executeTelnet` shellPrompt 正则过宽 [残留 · 低风险] · severity: low

- **Files:** `electron/services/arpCollector.ts:58`（`shellPrompt: /[>#]/`）
- **Why fragile:** `[>#]` 匹配任意含 `>` 或 `#` 的输出，设备 banner/MOTD 含这些字符会误判 prompt 边界，导致采集输出截断或混入 MOTD。
- **Safe modification:** 收紧为厂商特定 prompt（如 `/\[>#]$/` 行尾锚定）。非当前 scope。

---

## Scaling Limits

### SCALE-1 better-sqlite3 同步阻塞主进程 · severity: medium

- **Current capacity:** better-sqlite3 为同步 API，所有 DB 操作跑在 Electron 主进程事件循环，`busy_timeout=5000` + `wal_autocheckpoint=1000`（connection.ts，批4a 已加）缓解锁冲突。
- **Limit:** 大表全量扫描（ARP 表数万行 + OUI N+1 已修但 getIPDetails 仍全量返回）会阻塞 UI 渲染层 IPC 响应；`crypto.pbkdf2Sync`（10 万次，crypto.ts:20/76）虽有 LRU 缓存但仍同步阻塞。
- **Scaling path:** Phase 4 分页（PERF-D1）+ 考虑重 DB 操作移 worker thread（STATE.md 显式「不引入 worker thread」为 Phase 3 决策，未来可重评估）。

---

## Dependencies at Risk

### DEP-1 better-sqlite3 native binding ABI 冲突 [known limitation] · severity: medium

- **Risk:** better-sqlite3 为 Electron ABI 145 编译，plain Node ABI 137 `require` 报 `ERR_DLOPEN_FAILED`，**无法在 vitest/plain node 实例化真实 DB 做运行时测试**。
- **Impact:** 所有 DB 相关逻辑只能静态验证 + Electron 运行时人工验证（见 HV 系列），自动化测试覆盖薄（仅 `tests/unit/{auth,crypto,migrationHelpers}.test.ts` 3 文件，DB 测试用 typed mock 规避）。
- **Migration plan:** 已锁 exact 版本（Phase 1 BUILD-01：better-sqlite3 12.9.0 / ssh2 1.17.0 / telnet-client 2.2.13）；可考虑 `@electron/rebuild` 在 CI 自动重建，或 `electron-vite` 集成 vitest 跑 Electron 内测试。

### DEP-2 `pdf-parse` 已移除（批4a），改用 `pdfjs-dist` · severity: info

- **Status:** `pdf-parse`（21MB，未使用）已在批4a 移除，PDF 解析改 `pdfjs-dist`（knowledgeBaseService.ts，含图片提取）。无遗留风险。

---

## Missing Critical Features

### MISS-1 运行时验证机制缺失（9+ 项 Electron human verification 待测） · severity: high

- **Problem:** 因 DEP-1 native binding 限制，Phase 2 + Phase 3 共 **9 项** Electron 运行时行为仅有静态验证，未实测。
- **Files:** `.planning/phases/02-architecture-db-migration/02-VERIFICATION.md`（4 项）、`.planning/phases/03-performance-optimization/03-VERIFICATION.md` + `03-HUMAN-UAT.md`（5 项，total: 5 / passed: 0 / pending: 5）
- **Blocks:** 无法确认 ACL 实际生效 / 备份文件实际生成 / 旧库端到端迁移 / savepoint 回滚 / FTS WHEN 跳过 / 冷启动加速等核心承诺。
- **Fix approach:** 在真实 Windows Electron 环境逐项执行 HUMAN-UAT（03-HUMAN-UAT.md 已列 5 项详细步骤），结果回填。这是 Phase 3 status=`human_needed` 的唯一阻塞项。

---

## Test Coverage Gaps

### TEST-1 测试覆盖极薄（3 文件 / 12 tests） · severity: high

- **What's not tested:**
  - DB 层全部（init.ts / migrations.ts / connection.ts / 所有 service）—— DEP-1 限制，用 mock 规避
  - SSH/Telnet 采集与执行（arpCollector.ts / ai.ts executeCommandsOnDevice）
  - 命令安全（commandSafety.ts —— 安全核心无单测）
  - 加密兼容（crypto.ts v1/v2 IV 兼容 —— 仅 crypto.test.ts 部分覆盖）
  - IPC 鉴权（authGuard.ts —— secure/sanitizeMessage 无单测）
  - 前端组件全部（0 前端测试）
- **Files:** `tests/unit/` 仅 `auth.test.ts` / `crypto.test.ts` / `migrationHelpers.test.ts`
- **Risk:** **安全核心（commandSafety / authGuard / crypto 兼容）无自动化回归**，任何改动依赖人工审计。commandSafety 改一行可能放行 `reboot` 而无测试拦截。
- **Priority:** High。建议至少为 `commandSafety.ts`（纯函数，无 DB 依赖，可纯 node 测）+ `crypto.ts` v1/v2 兼容 + `authGuard.sanitizeMessage` 补单测。

### TEST-2 前端零测试 · severity: medium

- **What's not tested:** 7 个 page + IP 管理 4 Tab + 拓扑组件全部无测试。
- **Risk:** Phase 5 FE-01 拆 AIPage / FE-02 清 any 重构无回归网。
- **Priority:** Medium。P5 重构前建议补 AIPage 关键交互冒烟测试（vitest + @testing-library/react）。

---

## Residual Anti-Patterns（02/03-VERIFICATION 残留，非 goal-blocking）

| File | Line | Pattern | Severity | Phase |
|------|------|---------|----------|-------|
| `electron/database/init.ts` | 296 | `initDefaultOUIData(db: any)` + `as any` | ℹ info | P5 FE-02 收 |
| `electron/database/acl.ts` | 77 | `restrictDirPermissions` 路径用 `/` 拼接（Windows fs 兼容潜在不一致） | ℹ info | 后续 |
| `electron/services/backupScheduler.ts` | 116 | `getConfig row as any` | ℹ info | P5 FE-02 收 |
| `electron/services/backupScheduler.ts` | 97 | `pruneBackups retention=0` 删全部（BUG-2） | ⚠ high | P6 或 hotfix |
| `electron/main.ts` | 171 | `before-quit` 非 async 不等 in-flight backup（BUG-3） | ⚠ medium | P6 |

---

## 已缓解项（CHANGELOG 审计批1-4b，历史参照）

> 以下为已完成的安全/正确性修复，列为变更追溯，**非当前 debt**。

- **批1 安全核心（8 项）：** keyManager safeStorage / kb 路径遍历 / commandSafety 重构 / ai exec 非交互 / init CHECK 事务 / crypto deriveKey 缓存 / ErrorBoundary / arpIpc 异常隔离
- **批2 Medium（11 项）：** crypto v2 IV / auth CSPRNG+锁定 / webSecurity CSP+ / ai pendingBatches TTL / CIDR 数值匹配
- **批3 鉴权+IPC 网关：** authGuard secure/sanitize / 全 handler secure 包装 / 7 文件入参校验
- **批4a 后端 low：** decField try/catch / device 级联 try/catch / topology 节点上限 / systemLog 截断 / maskToCIDR 校验 / connection busy_timeout / scheduler runTask catch / csvEscape RFC4180
- **批4b 前端 low：** ArpTab 死代码 / AnomalyTab 死状态 / App checkFirstRun catch / DeviceNode import / electron.d.ts rdpConnect
- **Phase 2（ARCH-01/02）：** user_version + hasColumn + ACL + BackupScheduler + 向后兼容（CR-01/CR-02/CR-03 已闭环）
- **Phase 3（PERF-01~04）：** OUI vendorMap / processARPEntries 事务化 / FTS WHEN / init 跳过日志（静态全绿，运行时 HV 待测）

---

*Concerns audit: 2026-06-28*
*Source: ROADMAP.md (Phase 4-6 待做) + 02/03-VERIFICATION.md (residual) + CHANGELOG.md (批1-4b 已修) + 全量 grep (`: any` 276 处 / 37 文件)*
