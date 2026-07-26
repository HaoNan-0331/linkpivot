# 文档-代码一致性审计报告

**日期:** 2026-07-26
**项目:** network_toplogy (v0.1.2 pre-release)
**审计方法:** 多 agent workflow（Run `wf_45eb3743-5a2`）
**规模:** 32 agent / 2,174,857 token / 523 工具调用 / 12 分钟
**覆盖:** 14 维度并行核查 + HIGH/critical 对抗性验证 + 综合
**数据源:** `.planning/codebase/*.md`（7 篇）+ `.planning/STATE|ROADMAP|MILESTONES|PROJECT.md` + 全部 6 phase VERIFICATION/HUMAN-UAT + 项目/根 CLAUDE.md + 实际代码（codegraph 104 文件索引 + Read/Grep + git log）

---

## 1. 执行摘要

本次审计覆盖 14 维度，共 **121 条真发现（0 误报）**，其中：

- **文档漂移 (doc-drift) 85 条** 为绝对主导——根因是 `.planning/codebase/` 7 份文档冻结于 **2026-06-28**，而 Phase 4（data/ipc）/ Phase 5（frontend/types）/ Phase 6（robustness）+ 0.1.2 pre-release hardening（commit b6a689b/490c20f）**全部在之后落地**，导致 CONCERNS/STACK/ARCHITECTURE/INTEGRATIONS 系统性把已修 bug（BUG-2/4/5、FRAG-1）标为残留、file:line 整体漂移、pdfjs-dist「缺失依赖」等关键告警完全失真。
- **代码风险 (risk) 36 条**，其中 4 条 HIGH 经对抗性独立验证确认会实质影响后续 milestone。

**结论：**
- 文档漂移**不阻塞 0.1.2 发版**，但若不更新，后续 milestone 规划者会反复在已修项上浪费排期，且 CLAUDE.md 过期声明会持续误导 AI 协作。
- 4 条真高风险（加密静默吞错 / safeStorage 翻转 / VERIFICATION 不一致 / 安全核心零单测）+ BUG-3（before-quit 不等 backup）是后续工作必须先处理的实质风险。

---

## 2. ⚠️ 重要修正：R1 经用户澄清降级撤销

审计 workflow 原报告将「SSH 未强制密钥认证（4 处密码兜底）」列为 **HIGH 风险 R1**，依据是 CLAUDE.md「SSH 密钥认证不可回退」硬约束。

**用户澄清（2026-07-26）：** 该 CLAUDE.md 约束针对的是 **Claude Code 本地连接设备时的操作规范**，**不是 network_toplogy 产品的 SSH 功能约束**。项目支持「密钥 + 密码」双通道是**正确的产品设计**（运维场景大量设备用密码认证，产品必须支持）。

**据此处置：**
- R1 **撤销**，不作为风险。代码 4 处密码兜底（`ai.ts:280-287 buildSSHConfig`、`connection.ts:153-160 connectSSH`、`connection.ts:318-324 testSSHConnection`、`arpCollector.ts:66-69`）保持现状。
- 衍生 1 个文档措辞项（并入文档同步）：`network_toplogy/CLAUDE.md` 的 `Constraints.Security` 把「SSH 密钥认证」与命令白名单/IPC 鉴权并列为「不可回退」，措辞易误导（本次即误导了审计 agent），需澄清为「操作规范」而非「产品功能约束」。
- 已写入 memory `ssh-constraint-scope.md` 防止未来审计再次误判。

> 教训：未来安全评估须严格区分「操作规范（约束 Claude 行为）」与「产品功能约束（约束应用代码）」。

---

## 3. 分级统计

| 类别 | critical | high | medium | low | info | 小计 |
|------|----------|------|--------|-----|------|------|
| 文档漂移 (doc-drift) | 0 | 8 | 28 | 31 | 18 | **85** |
| 代码风险 (risk) | 0 | 4 | 22 | 9 | 1 | **36** |
| **合计** | **0** | **12** | **50** | **40** | **19** | **121** |

- **对抗性验证:** 所有 HIGH/critical 发现均经独立 verifier 重查 `file:line`，**0 条被推翻（0 误报）**。

---

## 4. Top 15 发现

| # | 维度 | 发现 | 类别 | 严重度 | 位置 |
|---|------|------|------|--------|------|
| 1 | risk-crypto | decField 静默吞掉所有解密失败，masterKey 变更后历史密文无声变空 | risk | high | `crypto.ts:93-102` |
| 2 | risk-crypto | keyManager safeStorage 翻转时把历史 DPAPI blob 当明文 masterKey | risk | high | `keyManager.ts:18-38` |
| 3 | verification/state | STATE 称 03/06-VERIFICATION partial，但两份实际未回填（human_needed / HV 全 pending） | doc-drift | high | `STATE.md:48-50` vs `03,06-VERIFICATION.md` |
| 4 | risk-types/testing | 安全核心 commandSafety/authGuard/crypto v1-v2 零自动化回归 | risk | high | `tests/unit/` 缺失 |
| 5 | risk-bugs | BUG-3 before-quit 同步不等 in-flight backup，退出可截断 `.db.bak` | risk | medium | `main.ts:199-203`, `backupScheduler.ts:58-71` |
| 6 | risk-security | 4 个 `auth:*` IPC handler 未走 secure/safe 包装，异常原始透传渲染层 | risk | medium | `main.ts:129-136` |
| 7 | risk-security | 打包流程不设 `NODE_ENV=production`，dev/prod 判定靠「恰好不等于 development」 | risk | medium | `package.json:8,13`; `main.ts:45,61` |
| 8 | risk-types | electron/ 后端 197 处 any 未收口，better-sqlite3 row `as any` 密集 | risk | medium | `knowledgeBaseService.ts:34` 等 |
| 9 | codebase-stack | STACK.md 称 pdfjs-dist 缺失会运行时失败，实际已声明并安装 | doc-drift | medium | `STACK.md:67-68` vs `package.json:22` |
| 10 | codebase-arch | `safe()` 鉴权包装器被文档列为红线但代码从未调用（零 caller） | doc-drift | medium | `authGuard.ts:44`, `main.ts:129-136` |
| 11 | codebase-arch | INTEGRATIONS 把 buildSSHConfig 幽灵引用到不存在的 `connection.ts:162` | doc-drift | medium | `INTEGRATIONS.md:68` |
| 12 | claude-md | CLAUDE.md Technology Stack / Conventions / Architecture 三段仍为占位符 | doc-drift | medium | `CLAUDE.md:19-35` |
| 13 | concerns | CONCERNS 把已修的 BUG-2/4/5 + FRAG-1 仍标残留/high | doc-drift | medium | `CONCERNS.md:56-83,171-179,265` |
| 14 | risk-build | package.json 无显式 rebuild 步骤，ABI 重建完全依赖 npmRebuild 隐式行为无 CI 兜底 | risk | medium | `package.json:6-16`, `electron-builder.yml:32` |
| 15 | concerns | BUG-1 anomalyService `new_ip` 计数恒为 0（仍未修） | risk | low | `anomalyService.ts:172-181` |

---

## 5. 确认的真高风险（4 HIGH + 1 未闭环数据 bug）

### R2 · decField 静默吞掉所有解密失败 → 历史密文无声变空【HIGH】
- **位置:** `electron/utils/crypto.ts:93-102`
- **问题:** `decField` 把所有解密失败统一 `return ''`，无 system_log、无 IPC 告警。masterKey 文件丢失/损坏或 safeStorage 翻转后，**全库历史设备凭证 / AI Key / 拓扑 chat_history 无声变空**，运维误判为「数据丢失」。
- **修复:** 在 decField 之上加解密失败率遥测：每 N 行统计失败率，超阈值写 `system_log` + IPC 一次性告警，区分「密钥不匹配」vs「单行损坏」。

### R3 · keyManager safeStorage 翻转把历史 DPAPI blob 当明文 masterKey【HIGH】
- **位置:** `electron/utils/keyManager.ts:18-38`
- **问题:** safeStorage 可用性翻转（换机/换系统账户）时，把历史 DPAPI 二进制 blob 当 UTF-8 字符串 trim 取用，派生出错误 masterKey，无法解密任何历史密文。**与 R2 叠加 = 破坏性数据丢失路径。**
- **修复:** 读取前 sniff：尝试 `decryptString` + base64/长度校验；解不出且 safeStorage 不可用时显式抛错，加 magic 字节区分 blob vs 明文。

### R4 · STATE.md vs 03/06-VERIFICATION.md 严重不一致【HIGH · governance】
- **位置:** `.planning/STATE.md:48-50` vs `phases/03,06-VERIFICATION.md` frontmatter
- **问题:** STATE 称 partial（HV 已 pass），但两份 VERIFICATION.md 实际仍 `status: human_needed` / HV 全 pending。**夸大 v1.0 milestone 验证闭环度**，影响 milestone close gate 与审计可追溯性。
- **修复:** 在 03/06-VERIFICATION.md frontmatter 同步 status 与 human_verification 节，回填 HUMAN-UAT 的 pass/defer 结果与 STATE 对齐。

### R5 · 安全核心零自动化回归【HIGH】
- **位置:** `tests/unit/`（无 `commandSafety.test.ts` / `authGuard.test.ts`）
- **问题:** `commandSafety` / `authGuard.sanitizeMessage` / `crypto v1↔v2 IV 兼容` 全无单测。Phase 5 重构已成既成事实，无回归网——改一行白名单可能放行 `reboot` 而无测试拦截。
- **修复:** 优先补 `commandSafety.test.ts`（纯函数最高 ROI）：SEPARATOR_RE / BLOCKED_FIRST_WORDS / 白名单严格匹配 / 管道豁免；补 crypto v1/v2 IV 兼容与 sanitizeMessage 单测。

### BUG-3 · before-quit 不等 in-flight backup【MEDIUM · 未闭环数据 bug】
- **位置:** `electron/main.ts:199-203`, `backupScheduler.ts:58-71`
- **问题:** `before-quit` 同步调用 `BackupScheduler.stop()` + `closeDatabase()`，不等异步 backup 完成，可能生成截断的 `.db.bak`。0.1.2 的 L5 加固**未覆盖**此项。
- **修复:** before-quit 改 async：`e.preventDefault()` + `await BackupScheduler.awaitPending()` + `closeDatabase()` + `app.exit()`。

---

## 6. 文档更新清单（11 项，批量同步）

| 文件 | 需更新的内容 |
|------|-------------|
| `.planning/codebase/CONCERNS.md` | BUG-2(retention clamp)/BUG-4(enrichParseError)/BUG-5(safeLog)/FRAG-1(try-finally)/MISS-1/PERF-D1 移入已缓解项；TD-1 any 计数 276→218、移除 KB/AIPage 热点；TD-2 AIPage 399→99、ai.ts 827→891；TD-3 ipInCIDR 2→3 份；BUG-1 标仍未修；删除残留表 BUG-2 行与 schedulerIpc 错位建议；修正 BUG-3 line 漂移 |
| `.planning/codebase/STACK.md` | `:67-68` pdfjs-dist 改写为已声明依赖，移入 Critical 区标 `^6.1.200`，import 行号 393→413 |
| `.planning/codebase/INTEGRATIONS.md` | `system_logs`→`ai_system_logs`(L73/L76)；删 `connection.ts:162` 幽灵引用、ai.ts 行号整体 +64(L9/23/24/25/50/68)；RDP 行号 398→390(L43)；拆 Telnet net vs telnet-client(L105)；补 web_url_enc(L64)；`oui:getAll` 示例加分页参数 |
| `.planning/codebase/ARCHITECTURE.md` | main.ts 行号整体刷新 +23 行(L116/117/134/137/207/228) |
| `.planning/codebase/CONVENTIONS.md` | Pattern 1 承认两种合法 service 风格（函数式+模块级 MK / 静态类 facade）；`oui:getAll` 示例更新 |
| `.planning/codebase/STRUCTURE.md` | services 补 `arpParser.ts/exportService.ts/ipStatusService.ts`；utils 补 `pagination.ts/sshConfig.ts`；types 补 `ai.ts/kb.ts/pagination.ts`；tests 补 `pagination.test.ts` |
| `.planning/codebase/TESTING.md` | 3 文件/12 tests → 4 文件/25 tests，补 `pagination.test.ts` 条目 |
| `CLAUDE.md`（项目级） | `:19-35` 回填 GSD stack/conventions/architecture 三段占位符；Constraints.Security 补 Telnet/Web/RDP 通道声明、SSH 措辞改「密钥优先」或代码强制（**注:经用户澄清,SSH 密钥约束是操作规范,此处应澄清措辞而非强制代码**）；Build 补 external 清单 |
| `.planning/STATE.md` | Todos Phase 2 02-02/02-03 改 `[x]`；git range 163→115(L36)；frontmatter last_updated 刷到 2026-07-26、footer 同步；PROJECT.md:92 跳过 map-codebase 决策更正为已执行 |
| `phases/03,06-VERIFICATION.md` | frontmatter status 按 HV 回填刷新为 partial，human_verification 节标 #1/#2/#4 pass、HV-1/2/3 pass |
| `phases/05-VERIFICATION.md` + `CHANGELOG.md:12` + `STATE.md:66` + `CONCERNS.md:216` | 05-VERIFICATION status `human_needed`→`passed`（05-HUMAN-UAT 已 25/25 user approved 2026-07-02）；订正 telnet-client 为纯 JS 非 native，asarUnpack 理由修正 |

---

## 7. 推荐行动（按优先级）

| 优先级 | 行动 |
|--------|------|
| **P0 数据** | R2 + R3：为 decField 增加解密失败可观测层（超阈值 system_log + IPC 告警，区分密钥不匹配 vs 单行损坏）；keyManager 读取分支加 blob sniff，safeStorage 翻转时不把 DPAPI blob 当明文，显式抛错要求从 backups 恢复 |
| **P0 数据** | 修复 BUG-3 before-quit：改 async event handler（`e.preventDefault` + `await BackupScheduler.awaitPending` + `closeDatabase` + `app.exit`），消除退出时 `.db.bak` 截断风险 |
| **P1 安全** | 4 个 `auth:*` handler 改 `safe(fn)` 包装兑现脱敏红线；dev/prod 判定锚定到 `app.isPackaged` 或 esbuild `--define NODE_ENV=production` |
| **P1 测试** | 优先补 `commandSafety.test.ts`（纯函数最高 ROI）+ crypto v1/v2 IV 兼容 + authGuard sanitizeMessage 单测，建立安全核心回归网（R5） |
| **P1 构建** | `electron:build` 前加显式 `electron-rebuild -f -w better-sqlite3,ssh2` + GitHub Actions 打包冒烟 job 验证 asarUnpack 产物含 `.node`，防 ABI 静默失配 |
| **P1 governance** | R4：03/06-VERIFICATION.md frontmatter 按 HV 回填刷新；05-VERIFICATION.md 改 passed；与 STATE 对齐 |
| **P2 文档批量** | 运行 `/gsd-docs-update` 基于当前 HEAD 刷新 `.planning/codebase/` 7 文档 + STATE/PROJECT/MILESTONES + 项目 CLAUDE.md（消除 85 条 doc-drift + SSH 措辞澄清） |
| **P3 技术债** | 后端 any 收口（KB 34/ai 24/anomaly 14 优先定义 `XxxRow` interface）；移除 `@types/uuid` 死包与 jsdom 死 devDep；收窄 `.gitignore` `*.png` 通配；登记 reactflow@11/xterm@5 legacy 迁移 + 激进版本栈复现性（强制 `npm ci`）为后续技术债；登记前端测试通道（vitest jsdom + testing-library）缺口 |
| **P3 功能** | 补 BUG-1：processARPEntries 首次见 IP 写 `change_type='new_ip'`，或从 getStats/AnomalyTab/exportService 移除该字段避免误导 |

---

## 8. 附录：审计维度与方法

**14 个 Find 维度：**
1. CONCERNS.md 技术债/bug 漂移（逐条核对 TD/BUG/FRAG）
2. STACK.md + STRUCTURE.md vs 依赖/目录
3. ARCHITECTURE/CONVENTIONS/INTEGRATIONS vs 代码
4. TESTING.md vs 实际测试
5. STATE/ROADMAP/MILESTONES/PROJECT 一致性
6. 6 phase VERIFICATION + HUMAN-UAT deferred 项
7. CLAUDE.md 声明 vs 实际
8. BUG-1~5 / FRAG-1~3 当前真实态
9. 安全约束实现（IPC 鉴权/CSP/SSH/加密降级）
10. 打包/构建/发版（用户数据排除、native ABI）
11. 依赖风险（exact 锁定、激进版本、未用依赖）
12. 类型安全（any 计数/strict/tsc 实跑）
13. 静默吞错 + 资源泄漏
14. 加密/迁移向后兼容

**质量设计：** 每维度 HIGH/critical 发现立即对抗性验证（独立 verifier 重查 file:line，默认怀疑）；验证推翻的误报在综合时过滤。本次 0 误报。

**Workflow 产物：** Run `wf_45eb3743-5a2`，脚本 `doc-code-consistency-audit`，完整 JSON 输出见会话 task `wrwwbotar.output`。

---

*审计执行: 2026-07-26 | Quick task `260726-udg` | 下一步见推荐行动 P0-P3*
