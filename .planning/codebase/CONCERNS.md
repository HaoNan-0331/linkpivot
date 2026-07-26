# Codebase Concerns

**Analysis Date:** 2026-07-26（基于 HEAD `3adbbeb` 刷新；上次冻结 2026-06-28）
**Scope:** full repo（network_toplogy — Electron + React + TypeScript + better-sqlite3）
**Method:** ROADMAP Phase 4-6 落地后的剩余技术债 + 02/03-VERIFICATION 残留 anti-patterns + CHANGELOG 审计批1-4b + Phase 4-6 + 0.1.2 加固（260726-upa R2/R3 + 260726-vcu R5 单测）已修历史 + 全量 grep（`: any` 204 处 / 30 文件）

> **阅读说明：** 本文档区分两类条目——
> **[已修]** 历史修复项（列在末尾「已缓解项」，含 Phase 4-6 + 0.1.2 pre-release 加固）；
> **[待做/残留]** 当前代码仍存在的 debt，按 **critical / high / medium / low / info** 分级。每条标注 ROADMAP 对应 Phase（P5/P6）或验证债（HV）。
>
> **2026-07-26 刷新要点：** Phase 4（DATA-01 分页）/ Phase 5（FE-01/02 AIPage 拆分 + any 收口）/ Phase 6（ROBUST-01/02 句柄/解析加固）+ 0.1.2 quick task（260726-upa R2/R3 加密核心加固、260726-vcu R5 安全核心单测）落地后，BUG-2/BUG-3/BUG-4/BUG-5/FRAG-1/MISS-1/PERF-D1/TEST-1 安全核心 全部转入「已缓解项」；剩余 debt 收敛为 TD-1/TD-2/TD-3 + BUG-1 + 类型/前端测试缺口。

---

## Tech Debt

### TD-1 `any` 类型大面积泄漏（204 处 / 30 文件）[待做 · P5 FE-02 后续收口] · severity: medium

- **Issue:** 全仓库 `: any` / `as any` / `: any[]` / `<any>` 共 **204 occurrences across 30 files**（2026-06-28 基线 276 处 / 37 文件，Phase 5 FE-02 拆分 AIPage + 收口前端类型后下降）。后端 `electron/services/*.ts` 的 better-sqlite3 row 普遍 `.get() as any` / `.all() as any[]` 仍是主要残留面。
- **Files（当前热点，按 grep 重新统计）:**
  - 后端密集：`electron/services/knowledgeBaseService.ts`（34 处，后端最多）、`electron/services/ai.ts`（24 处，含 `device: any` / `buildSSHConfig(device: any)` ai.ts:280-287）、`electron/services/anomalyService.ts`（14 处）、`electron/services/networkSegmentService.ts`（13 处）、`electron/services/ouiService.ts`（13 处）、`electron/services/topology.ts`（12 处）、`electron/services/device.ts`（12 处）、`electron/services/discovery.ts`（12 处）、`electron/services/schedulerService.ts`（8 处）、`electron/services/exportService.ts`（6 处）、`electron/services/ipStatusService.ts`（4 处）、`electron/utils/authGuard.ts`（6 处）
  - IPC 网关：`electron/ipc/arpIpc.ts`（6 处）、`electron/ipc/ouiIpc.ts`（3 处）、`electron/ipc/networkIpc.ts`（3 处）、`electron/ipc/anomalyIpc.ts`（2 处）、`electron/ipc/schedulerIpc.ts`（1 处）
  - 类型声明缺口：`src/types/electron.d.ts`（1 处 `Promise<any>` 残留，device/topology/connection/kb handler 返回类型大部分已在 Phase 5 建模）
  - mock：`src/mock-api.ts`（11 处，dev-only 浏览器预览模式）
- **Phase 5 已收口区域（不再列为热点）:** Phase 5 FE-01/02 已拆分 `AIPage.tsx`（399→99 行）与 `KnowledgeBasePage.tsx`，二者原 4+17 处 `api: any` / `catch (e: any)` 热点已消除——本次 grep 的 30 文件清单中 `AIPage.tsx` / `KnowledgeBasePage.tsx` / 4 个 IP 管理 Tab 均不再出现，残余前端 any 仅 `useAIChat.ts`（2）、`IpManagementPage.tsx`（1）、`DiscoveryPanel.tsx`（3）、`CommandWhitelistEditor.tsx`（2）、`ExecModeSwitch.tsx`（1）。
- **Impact:** `tsconfig.web.json` 严格模式 + noUnusedLocals 对 `any` 不报错，类型安全形同虚设；重构（重命名 DB 列、改 IPC 签名）无编译期保护，回归风险高；`device: any` 导致 `buildSSHConfig` 访问 `device.password` 等字段无类型校验。
- **Fix approach:** 后端 better-sqlite3 row 定义 `interface XxxRow` 替代 `as any`（参考 `src/types/device.ts` / `src/types/network.ts` 已有 DTO）；优先级：`knowledgeBaseService.ts`（34）/ `ai.ts`（24）/ `anomalyService.ts`（14）。**注意 mock-api.ts 为 dev-only，可保留宽松。** 非当前 milestone scope。

### TD-2 `knowledgeBaseService.ts` / `ai.ts` 超大单文件 [待做 · 后续 debt] · severity: medium

- **Issue:** 单文件过千行，职责混杂。Phase 5 FE-01 已拆分 AIPage（见下），但后端两大服务仍臃肿。
- **Files:**
  - `electron/services/ai.ts`（**891 行**，配置管理 + SSH 执行 + 对话 + 命令安全 + 日志 + 设备查询杂糅；2026-06-28 基线 827 行，Phase 4-6 后增至 891）
  - `electron/services/knowledgeBaseService.ts`（759 行，PDF 解析 + 图片提取 + FTS 索引 + CRUD + 搜索）
  - ~~`src/components/pages/AIPage.tsx`（399 行）~~ → **Phase 5 FE-01 已拆分为 99 行外壳 + `src/components/pages/ai/` 子组件**（ChatSessionList/ChatMessageList/ChatInput/CommandConfirmModal/useAIChat 等），此条不再列为 debt
  - ~~`src/components/pages/KnowledgeBasePage.tsx`（540 行）~~ → Phase 5 FE-01 一并瘦身
- **Impact:** 维护成本高，局部改动易引入副作用；ai.ts 单文件 891 行违反单一职责（配置/执行/对话应分层）。
- **Fix approach:** ai.ts 建议后续拆 `ai/config.ts` / `ai/executor.ts` / `ai/chat.ts`（非当前 milestone scope，登记为后续 debt）；knowledgeBaseService 按 PDF 解析 / FTS / CRUD 分层。

### TD-3 `ipInCIDR` / `ipToNumber` 逻辑重复三份 [残留 · IN-02] · severity: low

- **Issue:** IPv4→数值 + CIDR 匹配实现现存 **3 份**（2026-06-28 基线 2 份，Phase 4 DATA-01 exportService 重构时新增第 3 份）。
- **Files:** `electron/services/networkSegmentService.ts:132-156`（`ipToNumber` line 132 / `ipInCIDR` line 139）、`electron/services/anomalyService.ts:52-66`（`ipInCIDR` line 52 / `ipToNumber` line 63）、`electron/services/exportService.ts:8-22`（`ipToNumber` line 8 / `ipInCIDR` line 14）
- **Impact:** 三份逻辑各自演进易发散（anomalyService 版已因 WR-04 加健壮性，networkSegmentService/exportService 版未完全同步），bug 修一处漏两处。
- **Fix approach:** 抽 `electron/utils/ipMath.ts` 共享 util，三处 import。非当前 milestone scope。

---

## Known Bugs

### BUG-1 `AnomalyService.getStats` `new_ip` 计数恒为 0 [残留 · IN-01] · severity: low

- **Symptoms:** IP 异常统计页「新增 IP」数永远显示 0。
- **Files:** `electron/services/anomalyService.ts:180-189`（`getStats`，SQL `newIp: COUNT(change_type='new_ip')` 在 line 186）
- **Trigger:** `processARPEntries` 写 `ip_mac_changes` 时无任何代码路径写入 `change_type='new_ip'`，该字面量只在 `getStats` 的 SQL 出现（grep 确认仅 line 186 一处）。
- **Workaround:** 无（功能缺失，非崩溃）。Phase 3 未触碰 getStats，预存缺陷；Phase 4-6 仍未修。
- **Fix approach:** 在 `processARPEntries` 中对「首次见到的 IP」写 `change_type='new_ip'`，或从 `getStats` / AnomalyTab / `exportService.exportChanges` 移除该字段避免误导。非当前 milestone scope。

> **BUG-2/BUG-3/BUG-4/BUG-5 已修复，转入「已缓解项」节。** 残留 anti-patterns 表中原 BUG-2（`backupScheduler.ts:97` retention=0）/BUG-3（`main.ts before-quit`）两行已删除。

---

## Security Considerations

### SEC-1 IPC 鉴权网关 `secure` 覆盖完整 [已验证 · 无 gap] · severity: info

- **Risk:** 特权 handler 漏包 `secure` 导致未登录可调用。
- **Files:** `electron/utils/authGuard.ts:31-41`（`secure` = 登录态校验 + `sanitizeMessage` 异常脱敏）、`electron/main.ts:106-163`、`electron/ipc/*.ts`（7 文件全部 `secure` 包装）
- **Current mitigation:** **完整覆盖**。`auth:*`（4 handler）登录前可用、不鉴权（设计如此）；其余全部特权 handler（device/topology/connection/terminal/ai/anomaly/arp/network/oui/export/scheduler/kb）grep 确认 100% `secure(...)` 包装。`secure` 在 try 之外 reject 未登录，不被脱敏覆盖。
- **Recommendations:** 维持现状。新增 handler 必须包 `secure`（建议加 lint 规则：`ipcMain.handle` 必须包 `secure`/`safe`）。
- **注（与 audit finding #6/#10 关联，非本文档 debt）:** `safe()`（仅脱敏不鉴权，authGuard.ts:44）当前零 caller——`auth:*` 4 handler 仍直传 `secure`/裸 handler，异常原始透传渲染层。属 audit 列出的独立 medium 风险（R6/auth 脱敏），不属 CONCERNS 历史条目，此处仅作交叉引用。

### SEC-2 命令白名单 `commandSafety` 三层防护 [已加固 · 批1 + R5 单测] · severity: info

- **Files:** `electron/services/commandSafety.ts`、`electron/services/ai.ts:308-369`（`executeCommandsOnDevice` 执行层强制 `isCommandAllowed` 作为最后防线）、`tests/unit/commandSafety.test.ts`（14 case，260726-vcu）
- **Current mitigation:**
  1. `SEPARATOR_RE`（`electron/services/commandSafety.ts:14`）拒绝多命令分隔符 `\r \n ; & \` $() && ||`（保留 `|` 管道过滤不误杀华为/Cisco `| include`）
  2. `BLOCKED_FIRST_WORDS`（line 17-22）首词黑名单：`shutdown/configure/delete/reset/reboot/system-view/interface/vlan/acl/aaa/no` 等
  3. 白名单首词严格相等匹配（非前缀子串），其余拒绝
  4. `executeCommandsOnDevice`（ai.ts:316-320）执行层强制再校验一次，不依赖调用方
  5. ai.ts 由交互式 `client.shell` 改非交互 `client.exec`（批1），杜绝注入
  6. **R5 回归网（260726-vcu）：** `commandSafety.test.ts` 14 case 覆盖白名单严格相等/分隔符注入拒绝/单管道豁免/黑名单首词/case insensitive/空命令；未来白名单改一行有自动化拦截
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

### SEC-4 AES-256-GCM 加密 + safeStorage 主密钥 [已加固 · 批1/批2 + R2/R3 加固] · severity: info

- **Files:** `electron/utils/crypto.ts`、`electron/utils/keyManager.ts`、`tests/unit/crypto.test.ts`（R2 新增 6 case）、`tests/unit/keyManager.test.ts`（R3 新增 3 case）
- **Current mitigation:**
  - 主密钥 `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密落盘（keyManager.ts:20-46），绑定机器+用户；兼容历史明文回退（line 36/43，**经 `isValidMasterKey`（line 19）base64 32 字节校验**——R3 加固，防 safeStorage 翻转把 DPAPI blob 当明文 trim）
  - 字段加密 `v2:` 前缀 + 12 字节 IV（GCM 推荐，crypto.ts:30-38），兼容历史 16 字节 IV 密文零迁移（decrypt:41-54）
  - `deriveKey` LRU 缓存避免列表场景重复 pbkdf2Sync 10 万次（crypto.ts:13-27）
  - `verifyPasswordSync` 结构校验 + 长度上限 1024（防 pbkdf2 超长 DoS）+ 等长保护 + timingSafeEqual（crypto.ts:67-82）
  - `decField` try/catch（crypto.ts:107-）单条坏密文不阻断整列表；**R2 加固（260726-upa）：** 新增 `setDecryptFailureHandler`（crypto.ts:102）注入式 handler + 60s 限流去重，`main.ts:94` 启动注入写 `system_log`（type=security, status=warning），masterKey 翻转/损坏导致的批量解密失败不再静默
- **Risk:** ~~safeStorage 不可用时（headless）主密钥明文落盘，有 console.error 警告但无拒绝启动~~。R3 后明文回退路径加 `isValidMasterKey` 校验，safeStorage 翻转 + blob 无法解读时显式抛错（main.ts startup catch → dialog 提示从 backups 恢复）。
- **Recommendations:** R2/R3 静态 + 单测已绿，运行时 HV（真实 safeStorage 翻转告警落 system_log 并在「系统日志页」展示）待真实 Electron 环境 human 验证（见 MISS-1）。

### SEC-5 路径遍历 / 图片 MIME 防护 [已加固 · 批1] · severity: info

- **Files:** `electron/ipc/knowledgeBaseIpc.ts:40`（`kb:getImageData`）、`electron/services/knowledgeBaseService.ts`
- **Current mitigation:** `imagePath` 限定 `imgDir()` 目录白名单内；MIME 按文件头魔数探测（非扩展名），防伪造。
- **Recommendations:** 维持。

### SEC-6 `secure` 异常脱敏范围 [残留 · 低风险] · severity: low

- **Risk:** `authGuard.ts:17-24` `sanitizeMessage` 仅移除 Windows 绝对路径 (`[A-Za-z]:\\`) 与 Unix 路径前缀（usr/home/Users/tmp/var/opt），SQL 片段、堆栈、库内部错误结构可能仍部分泄露给渲染层。
- **Files:** `electron/utils/authGuard.ts:17-24`
- **Current mitigation:** 完整 error `console.error` 到主进程日志（line 37/49），渲染层只收截断 message（≤200 字符）。**R5 加固（260726-vcu）：** `authGuard.test.ts` 7 case 覆盖 secure 未登录 reject / Windows+Unix 路径脱敏 / >200 截断 / 空 message 兜底 / safe 仅脱敏不鉴权。
- **Recommendations:** 可加 SQL 关键字（`SELECT/INSERT/UPDATE/near "."`) 正则脱敏。非当前 scope。

---

## Performance Bottlenecks

### ~~PERF-D1 IPC 大数据通道无分页/上限~~ [已修 · Phase 4 DATA-01] · severity: info

> **已修（转入「已缓解项」节）：** Phase 4 DATA-01 为 4 个大数据通道全部加 `limit/offset` 或流式分批，共享 `electron/utils/pagination.ts` 的 `validateLimit/validateOffset` 网关层校验。详见「已缓解项 → Phase 4」。

### PERF-D2 `processARPEntries` 事务化 / OUI N+1 / FTS WHEN [已修 · Phase 3] · severity: info

- **已修：**
  - PERF-01 OUI N+1：`ouiService.ts:5,25-55` `vendorMap` 预载 + `getVendor` 读 Map（O(1)），`networkSegmentService.ts:106` 单查
  - PERF-02 `processARPEntries` 单事务：`anomalyService.ts:113-125` `db.transaction` 整批 + 4 prepared 复用 + WR-01 savepoint
  - PERF-03 FTS WHEN：`init.ts:274-275` + `migrations.ts:178-187` v7 两处 `WHEN OLD.content IS NOT NEW.content` 逐字一致
  - PERF-04 init 跳过：`init.ts:298-303` + `migrations.ts:217-223` 两处幂等跳过日志 + `main.ts:80,86` `performance.now()` 计时
- **运行时验证债：** 见 HV-1~HV-5（better-sqlite3 native binding 限制，静态全绿，运行期待 Electron 实测）。

---

## Fragile Areas

### ~~FRAG-1 arpCollector `executeSSH`/`executeTelnet` 句柄泄漏~~ [已修 · Phase 6 ROBUST-01] · severity: info

> **已修（转入「已缓解项」节）：** Phase 6 ROBUST-01 D-6-2 统一资源回收——`executeSSH`（arpCollector.ts:25-）引入 `settled` flag + `cleanup()` 统一出口（clearTimeout + 幂等 client.end，timeout 路径追加 client.destroy），任意 ready/exec stream/error/client error/timeout 路径均经 `finish()` → `cleanup()`；`executeTelnet` 改 `.finally(async () => ...)`（clearTimeout + await connection.end + 超时 destroy）。stray timer / 残留 socket / 句柄泄漏路径已闭合。

### FRAG-2 静默吞错点散落 [残留 · 多处] · severity: medium

- **Files:**
  - `src/components/pages/KnowledgeBasePage.tsx:42` `catch { /* ignore */ }` 图片加载失败静默
  - `src/components/pages/KnowledgeBasePage.tsx:123` `.catch(() => {})` device.list 失败静默
  - `electron/services/backupScheduler.ts:52,99,102` 多处 `catch { /* 非致命 */ }`（部分已有 console.error/console.warn 兜底）
  - `electron/services/keyManager.ts:23` `catch { /* 回退明文 */ }` safeStorage 解密失败（**R3 后明文回退经 `isValidMasterKey` 校验**，翻转场景显式抛错，不再纯静默）
  - `electron/ipc/arpIpc.ts:17` 仅 `UNIQUE|CONSTRAINT` 记日志，其他写库失败完全静默
  - ~~`electron/services/discovery.ts` 多处 `createSystemLog` 裸调用~~ → **Phase 6 D-6-4 已包装为 `safeLog`（discovery.ts:12-19）try/catch + console.warn 兜底**
- **Why fragile:** 部分为设计意图（非致命），但 `KnowledgeBasePage.tsx:42` 图片加载失败用户无任何反馈（应有 fallback 占位）。
- **Safe modification:** 区分「致命」与「非致命」：非致命保留 catch 但加 `console.warn`（main 进程）或 UI message（渲染层）；图片失败显示占位符。

### FRAG-3 `executeTelnet` shellPrompt 正则过宽 [残留 · 低风险] · severity: low

- **Files:** `electron/services/arpCollector.ts:97`（`shellPrompt: /[>#]/`）
- **Why fragile:** `[>#]` 匹配任意含 `>` 或 `#` 的输出，设备 banner/MOTD 含这些字符会误判 prompt 边界，导致采集输出截断或混入 MOTD。
- **Safe modification:** 收紧为厂商特定 prompt（如 `/[>#]$/` 行尾锚定）。非当前 scope。

---

## Scaling Limits

### SCALE-1 better-sqlite3 同步阻塞主进程 · severity: medium

- **Current capacity:** better-sqlite3 为同步 API，所有 DB 操作跑在 Electron 主进程事件循环，`busy_timeout=5000` + `wal_autocheckpoint=1000`（connection.ts，批4a 已加）缓解锁冲突。
- **Limit:** 大表全量扫描（ARP 表数万行）会阻塞 UI 渲染层 IPC 响应；~~`getIPDetails` 仍全量返回~~ → Phase 4 DATA-01 已加分页（见「已缓解项」）。`crypto.pbkdf2Sync`（10 万次，crypto.ts:20/76）虽有 LRU 缓存但仍同步阻塞。
- **Scaling path:** Phase 4 分页已落地（PERF-D1 已修）；考虑重 DB 操作移 worker thread（STATE.md 显式「不引入 worker thread」为 Phase 3 决策，未来可重评估）。

---

## Dependencies at Risk

### DEP-1 better-sqlite3 native binding ABI 冲突 [known limitation] · severity: medium

- **Risk:** better-sqlite3 为 Electron ABI 145 编译，plain Node ABI 137 `require` 报 `ERR_DLOPEN_FAILED`，**无法在 vitest/plain node 实例化真实 DB 做运行时测试**。
- **Impact:** 所有 DB 相关逻辑只能静态验证 + Electron 运行时人工验证（见 HV 系列），自动化测试覆盖薄。**R5 后（260726-vcu）：** 安全核心（commandSafety / authGuard / crypto v1/v2 IV / keyManager）已有 7 文件 55 单测覆盖，DB 层仍用 typed mock 规避。
- **Migration plan:** 已锁 exact 版本（Phase 1 BUILD-01：better-sqlite3 12.9.0 / ssh2 1.17.0 / telnet-client 2.2.13）；可考虑 `@electron/rebuild` 在 CI 自动重建，或 `electron-vite` 集成 vitest 跑 Electron 内测试。

### DEP-2 `pdf-parse` 已移除（批4a），改用 `pdfjs-dist` · severity: info

- **Status:** `pdf-parse`（21MB，未使用）已在批4a 移除，PDF 解析改 `pdfjs-dist`（knowledgeBaseService.ts，含图片提取）。无遗留风险。

---

## Missing Critical Features

### ~~MISS-1 运行时验证机制缺失（9+ 项 Electron human verification 待测）~~ [部分缓解] · severity: medium

> **状态降级（原 high → medium）：** 9 项 Electron 运行时 HV 中，安全核心相关项（命令白名单实际拦截 / 加密 v1↔v2 兼容 / safeStorage 翻转告警）已由 R5 单测 + R2/R3 加固在纯函数层闭环（vitest 55/55）；剩余 better-sqlite3 native binding 强相关的运行时行为（ACL 实际生效 / 备份文件实际生成 / 旧库端到端迁移 / savepoint 回滚 / FTS WHEN 跳过 / 冷启动加速）仍需真实 Electron 环境实测。
- **Files:** `.planning/phases/02-architecture-db-migration/02-VERIFICATION.md`（4 项）、`.planning/phases/03-performance-optimization/03-VERIFICATION.md` + `03-HUMAN-UAT.md`（5 项）
- **Fix approach:** 在真实 Windows Electron 环境逐项执行 HUMAN-UAT（03-HUMAN-UAT.md 已列 5 项详细步骤），结果回填。

---

## Test Coverage Gaps

### TEST-1 测试覆盖（7 文件 / 55 tests，安全核心已闭环）· severity: medium

- **What's covered（R5 + R2/R3 + Phase 4 后）:**
  - `tests/unit/commandSafety.test.ts`（14 case）— 白名单严格相等 / 分隔符注入 / 管道豁免 / 黑名单首词（260726-vcu）
  - `tests/unit/authGuard.test.ts`（7 case）— secure 未登录 reject / 路径脱敏 / 截断 / safe 仅脱敏（260726-vcu）
  - `tests/unit/crypto.test.ts` — v1/v2 IV 兼容 + decField 降级/handler 触发/限流去重（批2 + 260726-upa R2）
  - `tests/unit/keyManager.test.ts`（3 case）— 新建 / 明文回退 / 翻转抛错（260726-upa R3）
  - `tests/unit/pagination.test.ts` — validateLimit/validateOffset（Phase 4 DATA-01）
  - `tests/unit/auth.test.ts` / `tests/unit/migrationHelpers.test.ts`（既有）
- **What's still not tested:**
  - DB 层全部（init.ts / migrations.ts / connection.ts / 所有 service）—— DEP-1 限制，用 mock 规避
  - SSH/Telnet 采集与执行（arpCollector.ts / ai.ts executeCommandsOnDevice）
  - 前端组件全部（0 前端测试）
- **Risk:** ~~安全核心（commandSafety / authGuard / crypto 兼容）无自动化回归~~ → **R5 已闭环**；剩余 DB / SSH / 前端无回归网，改动依赖人工审计。
- **Priority:** Medium。后续优先前端组件测试通道（vitest jsdom + @testing-library/react）。

### TEST-2 前端零测试 · severity: medium

- **What's not tested:** 7 个 page + IP 管理 4 Tab + 拓扑组件全部无测试。
- **Risk:** ~~Phase 5 FE-01 拆 AIPage / FE-02 清 any 重构无回归网~~ → Phase 5 已落地（AIPage 399→99），重构靠静态类型 + 人工 UAT 兜底；后续前端改动仍无自动化回归。
- **Priority:** Medium。建议补 AIPage 关键交互冒烟测试（vitest + @testing-library/react），登记为后续技术债。

---

## Residual Anti-Patterns（02/03-VERIFICATION 残留，非 goal-blocking）

| File | Line | Pattern | Severity | Phase |
|------|------|---------|----------|-------|
| `electron/database/init.ts` | 296 | `initDefaultOUIData(db: any)` + `as any` | ℹ info | 后续 any 收口 |
| `electron/database/acl.ts` | 77 | `restrictDirPermissions` 路径用 `/` 拼接（Windows fs 兼容潜在不一致） | ℹ info | 后续 |
| `electron/services/backupScheduler.ts` | 117 | `getConfig row as any` | ℹ info | 后续 any 收口 |

> **2026-07-26 删除：** 原 BUG-2 行（`backupScheduler.ts:97 retention=0 删全部`）—— `pruneBackups` 已 clamp `Math.max(1, retention)`；原 BUG-3 行（`main.ts:171 before-quit 非 async`）—— 行号漂移至 `main.ts:207-211`，且经精读 better-sqlite3 `backup()` 为同步原子 API、不存在 in-flight 截断窗口（详见「已缓解项 → BUG-3」）。

---

## 已缓解项（历史修复追溯，非当前 debt）

> 以下为已完成的安全/正确性修复，列为变更追溯。**2026-07-26 新增 Phase 4-6 + 0.1.2 quick task 加固项。**

- **批1 安全核心（8 项）：** keyManager safeStorage / kb 路径遍历 / commandSafety 重构 / ai exec 非交互 / init CHECK 事务 / crypto deriveKey 缓存 / ErrorBoundary / arpIpc 异常隔离
- **批2 Medium（11 项）：** crypto v2 IV / auth CSPRNG+锁定 / webSecurity CSP+ / ai pendingBatches TTL / CIDR 数值匹配
- **批3 鉴权+IPC 网关：** authGuard secure/sanitize / 全 handler secure 包装 / 7 文件入参校验
- **批4a 后端 low：** decField try/catch / device 级联 try/catch / topology 节点上限 / systemLog 截断 / maskToCIDR 校验 / connection busy_timeout / scheduler runTask catch / csvEscape RFC4180
- **批4b 前端 low：** ArpTab 死代码 / AnomalyTab 死状态 / App checkFirstRun catch / DeviceNode import / electron.d.ts rdpConnect
- **Phase 2（ARCH-01/02）：** user_version + hasColumn + ACL + BackupScheduler + 向后兼容（CR-01/CR-02/CR-03 已闭环）
- **Phase 3（PERF-01~04）：** OUI vendorMap / processARPEntries 事务化 / FTS WHEN / init 跳过日志（静态全绿，运行时 HV 待测）
- **Phase 4（DATA-01，PERF-D1 闭环）：** 4 个大数据 IPC 通道全部加 `limit/offset` 或流式分批，共享 `electron/utils/pagination.ts`（`validateLimit`/`validateOffset`）网关校验——
  - `oui:getAll`（ouiIpc.ts:9-11）：默认 5000、硬上限 50000，下推 SQL LIMIT/OFFSET
  - `anomaly:getChanges`（anomalyIpc.ts:15-17）：默认 100、硬上限 10000，复用共享校验
  - `networkSegmentService.getIPDetails`（networkSegmentService.ts:100-129）：JS 过滤后数组分页（slice）+ `{rows, total, truncated}` 信封
  - `exportService.exportARPTable`（exportService.ts:5-6,53-61）：流式分批（`ARP_BATCH_SIZE=1000`）LIMIT/OFFSET + appendFile，内存峰值 O(单批)
- **Phase 5（FE-01/02）：** AIPage 拆分（399→99 行外壳 + `src/components/pages/ai/` 子组件）/ KnowledgeBasePage 瘦身 / 前端 `api: any` 热点收口（AIPage / KnowledgeBasePage / 4 个 IP 管理 Tab 不再出现在 any 清单）/ `src/types/electron.d.ts` handler 返回类型建模
- **Phase 6（ROBUST-01/02）：**
  - FRAG-1 arpCollector 句柄泄漏：`executeSSH` settled+cleanup 统一回收 / `executeTelnet` `.finally(async)` 兜底（D-6-2，arpCollector.ts:25-69/91-113）
  - BUG-4 discovery JSON parse 错误上下文：`enrichParseError`（discovery.ts:27-30）补 `slice(0,200)` 原始片段 + SyntaxError position（D-6-3，SC#2）
  - BUG-5 discovery `createSystemLog` 裸调用：包装为 `safeLog`（discovery.ts:12-19）try/catch + console.warn 兜底，日志写库失败不中断发现主流程（D-6-4，SC#3）
- **0.1.2 pre-release hardening（commit b6a689b/490c20f/9429833）：** 安全/健壮加固 H1+M1+M2+M5+L5（详见 CHANGELOG 0.1.2 段）
- **BUG-2 `BackupScheduler.pruneBackups` retention=0 删光全部 [已修]：** `electron/services/backupScheduler.ts:97` `const safeRetention = Math.max(1, retention)`（注释标注 BUG-2），至少保留最新 1 份；clamp 下沉到 `pruneBackups` 入口，`schedulerIpc.ts` 网关层仅校验 interval/enabled（retention 由 backupScheduler 兜底）
- **BUG-3 `app.before-quit` 不等 in-flight backup [已评估·不修]：** `electron/main.ts:207-211` 仍为同步 handler（`BackupScheduler.stop()` + `closeDatabase()`），但经精读 `backupScheduler.executeTask`（backupScheduler.ts:64）的 `getDatabase().backup(backupPath)` 是 better-sqlite3 **同步原子 API**，before-quit 同步回调下不存在 in-flight 截断窗口——审计 medium 评级高估（依据 `.planning/quick/260726-upa-crypto-key-hardening/260726-upa-SUMMARY.md` Deferred 段）。结论：无需改 async event handler。
- **260726-upa R2（decField 解密失败可观测）：** `setDecryptFailureHandler`（crypto.ts:102）注入式 handler + 60s 限流去重，`main.ts:94` 启动注入写 `system_log`（type=security, status=warning）；crypto.ts 零 DB 依赖保持纯函数可单测。新增 crypto 6 单测。
- **260726-upa R3（keyManager safeStorage 翻转防误读）：** 明文回退路径加 `isValidMasterKey`（keyManager.ts:19，base64 32 字节）校验，safeStorage 翻转 + blob 无法解读时显式抛错（main.ts startup catch → dialog 提示从 backups 恢复），切断「DPAPI blob 当 UTF-8 明文 trim → 错误 masterKey → 与 decField 静默吞错叠加无声全库丢失」破坏路径。向后兼容：合法 safeStorage 加密 key + 历史明文 base64 key 仍可读。新增 keyManager 3 单测。
- **260726-vcu R5（安全核心单测收尾）：** `commandSafety.test.ts`（14 case）+ `authGuard.test.ts`（7 case），配合 260726-upa 的 crypto（6）/ keyManager（3），安全核心（commandSafety 白名单 / authGuard sanitizeMessage / crypto v1↔v2 IV / keyManager 翻转）全部建立自动化回归网。vitest 55/55。

---

*Concerns audit: 2026-07-26（HEAD `3adbbeb`）*
*Source: ROADMAP.md + 02/03-VERIFICATION.md + CHANGELOG.md + Phase 4-6 VERIFICATION + 260726-upa/260726-vcu SUMMARY + 全量 grep（`: any` 204 处 / 30 文件）+ vitest 55/55*
