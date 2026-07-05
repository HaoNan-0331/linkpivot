---
phase: 06-robustness-resource-safety
plan: 02
subsystem: discovery AI JSON parse 错误上下文 + createSystemLog 非致命包裹
tags:
  - discovery
  - error-context
  - safe-log
  - observability
  - robust
requires:
  - ROBUST-02
  - D-6-3
  - D-6-4
provides:
  - "discovery safeLog helper（局部非致命日志包裹，DB 写库失败 console.warn 兜底）"
  - "enrichParseError helper（JSON.parse 失败 enriched Error 含原始片段 slice(0,200)）"
  - "5 处 createSystemLog 全部经 safeLog 包裹（line 116/126/240/258/266 → safeLog）"
  - "两处 JSON parse 失败均落审计日志 + enriched errorMessage（command parse 补 safeLog 与 topology parse 对齐）"
affects:
  - "electron/services/discovery.ts (safeLog + enrichParseError helper + 5 处替换 + 两处 parse 改造)"
tech-stack:
  added: []
  patterns:
    - "局部 safeLog helper（Parameters<typeof createSystemLog>[0] 入参，string|undefined 返回，try/catch + console.warn 兜底）"
    - "enrichParseError helper（prefix + raw + err 三参，统一 enriched Error 模板，两处 parse 同模式去重）"
    - "console.warn 兜底非纯静默（遵循 Phase 3 D-P4 可观测性原则）"
key-files:
  created: []
  modified:
    - electron/services/discovery.ts
decisions:
  - "D-6-3 落地：enrichParseError helper 抽取（planner 委托，executor 裁量抽 vs 内联——选抽，两处 parse 同模式去重）"
  - "D-6-4 落地：safeLog helper 局限 discovery.ts（跨模块统一 safeLog defer，FRAG-2 静默吞错散落非本 plan scope）"
  - "enriched errorMessage 模板：`${prefix}: ${err.message} | 原始片段: ${raw.slice(0,200)}`，prefix 与现状一致仅追加 | 原始片段:"
  - "command parse 补 safeLog 是 D-6-3 对齐而非新需求（topology parse 已有 createSystemLog，command parse 缺失是遗漏）"
  - "不扩 ai_system_logs schema：enriched errorMessage 复用 errorMessage TEXT 字段（systemLog truncate 16000，slice 200 + err.message < 500 远低于截断线）"
metrics:
  duration: "~5min"
  completed: "2026-07-05"
  tasks_completed: 2
  files_modified: 1
  commits: 2
requirements:
  - ROBUST-02
---

# Phase 6 Plan 2: ROBUST-02 discovery JSON parse 错误上下文 + createSystemLog 非致命包裹 Summary

在 discovery.ts 内（独占文件，与 06-01 零文件重叠）做两件事：抽局部 safeLog helper 包裹 5 处 createSystemLog 裸调用（D-6-4，DB 写库失败 console.warn 兜底不中断发现主流程，含 line 258 嵌套陷阱切断），并抽 enrichParseError helper 让两处 JSON parse 失败抛 enriched Error（含「原始片段: slice(0,200)」，D-6-3，command parse 补 safeLog 与 topology parse 对齐）。SC#2（parse 错误上下文）+ SC#3（createSystemLog try/catch）代码级闭环达成。

## 落地形态（per D-6-3 / D-6-4）

### safeLog helper（discovery.ts line 12-19，模块级局部）
- 签名：`function safeLog(entry: Parameters<typeof createSystemLog>[0]): string | undefined`
- 入参类型复用 `Parameters<typeof createSystemLog>[0]`（与 createSystemLog 入参结构完全一致，避免重复定义 interface）
- 函数体：`try { return createSystemLog(entry) } catch (e:any) { console.warn('[safeLog] discovery 日志写库失败', e?.message); return undefined }`
- console.warn 兜底非纯静默（遵循 Phase 3 D-P4 可观测性原则）
- 返回 `string | undefined`：5 处调用现状均不取返回值，undefined 安全

### 5 处 createSystemLog → safeLog 替换（D-6-4，字段零改）
| 原 line | 改造后 line | 触发场景 | 字段（原样保留） |
|---------|-------------|----------|------------------|
| 116 | 130 | command AI 调用失败 | type/status/deviceIds/deviceNames/promptText/errorMessage=`AI 命令生成失败: ${err.message}` |
| 126 | 140 | command AI 成功 | + aiResponse + parsedResult=`阶段1: AI命令生成` |
| 240 | 254 | topology AI 调用失败 | + errorMessage=`AI 拓扑分析失败: ${err.message}` |
| 258 | 272 | topology parse 成功（在 try 内，嵌套陷阱切断点） | + aiResponse + parsedResult=JSON.stringify(parsed,null,2) |
| 266 | 280 | topology parse 失败（catch 内二次调用） | + aiResponse + errorMessage=`JSON 解析失败: ${err.message} \| 原始片段: ${aiResponse.slice(0,200)}` |

**line 258 嵌套陷阱切断（T-06-02-03 mitigate）**：line 272 safeLog 在 topology parse try 块内（line 269-276），其自身抛错被 safeLog 内部 try/catch 吞为 console.warn，不再触发外层 catch（line 277）→ 二次 createSystemLog（line 280）链。line 280 自身（catch handler 内调用）也经 safeLog 包裹，自身抛同样被吞，彻底切断「日志写库失败中断发现主流程」链。

### enrichParseError helper（discovery.ts line 27-30，模块级局部）
- 签名：`function enrichParseError(prefix: string, raw: string, err: unknown): Error`
- 函数体：`const errMessage = err instanceof Error ? err.message : String(err); return new Error(\`${prefix}: ${errMessage} | 原始片段: ${(raw || '').slice(0, 200)}\`)`
- 返回 `new Error(...)`（instanceof Error 不变，T-06-02-04 mitigate）
- 两处 parse 同模式去重（planner 委托，executor 选抽 helper）

### 两处 JSON parse 改造（D-6-3）

**command parse（原 line 136-144，改造后 line 161-178）**：
- 补 `const commandRaw = commandAiResponse`（保留原始引用给 enrichParseError + safeLog aiResponse）
- catch 块补 safeLog（status:failed，promptText + aiResponse:commandRaw + enriched errorMessage 含 `AI 命令结果解析失败: ${err.message} | 原始片段: ${commandRaw.slice(0,200)}`）—— 与 topology parse 对齐（两处 parse 失败均落审计日志）
- throw 走 `enrichParseError('AI 命令结果解析失败', commandRaw, err)`，消除裸 throw 无原始片段旧形态

**topology parse catch（原 line 265-274，改造后 line 277-309）**：
- safeLog errorMessage 补 ` | 原始片段: ${(aiResponse || '').slice(0, 200)}`（现状仅 `${err.message}`）
- throw 走 `enrichParseError('AI 分析结果解析失败', aiResponse, err)`，消除裸 throw 无原始片段旧形态
- errorMessage prefix `JSON 解析失败` 与现状一致，仅追加 slice

## 验收证据（D-6-5 静态 grep）

### SC#3（createSystemLog try/catch 包裹）

| 验收点 | 命中 | 说明 |
|--------|------|------|
| `function safeLog` | line 12 命中 1 | helper 定义 |
| `[safeLog] discovery 日志写库失败` | line 16 命中 1 | console.warn 兜底文案（D-6-4 锁定） |
| `console.warn` | line 16 命中 1 | 兜底非纯静默（D-P4 可观测性） |
| `createSystemLog({` 直接调用 | 命中 0 | 5 处全部替换为 safeLog |
| `createSystemLog` 总命中 | line 5（import）+ line 14（helper 内）= 2 | import 保留，helper 内调用 |
| `safeLog(` 调用 | line 130/140/254/272/280 = 5 | 5 处替换点位 |
| `import { createSystemLog } from './systemLog'` | line 5 命中 | import 不动 |

### SC#2（JSON parse 错误上下文）

| 验收点 | 命中 | 说明 |
|--------|------|------|
| `function enrichParseError` | line 27 命中 1 | helper 定义 |
| `原始片段:` | line 29（helper）+ line 175（command safeLog）+ line 306（topology safeLog）= 3 | enriched errorMessage 模板 |
| `.slice(0, 200)` | line 29 + line 175 + line 306 = 3 | 原始片段截取 |
| `throw enrichParseError('AI 命令结果解析失败'` | line 177 命中 1 | command parse throw 走 helper |
| `throw enrichParseError('AI 分析结果解析失败'` | line 308 命中 1 | topology parse throw 走 helper |
| `JSON 解析失败: ${err.message} \| 原始片段:` | line 306 命中 1 | topology safeLog enriched 新形态 |
| 旧裸 throw `throw new Error(\`AI 命令结果解析失败: ${err.message}\`)` | 命中 0 | 已消除 |
| 旧裸 errorMessage `JSON 解析失败: ${err.message}` 无原始片段 | 命中 0 | 已消除 |

## 三绿门禁（与 Phase 2/3/4/5/06-01 一致）

| 门禁 | 命令 | 结果 |
|------|------|------|
| TypeScript 严格模式 | `npx tsc -p tsconfig.web.json` | exit 0（`Parameters<typeof createSystemLog>[0]` 类型推导无 error） |
| Electron main esbuild | `npm run build:electron-main` | exit 0（dist-electron/main.js 1.8mb） |
| 单元测试 | `npx vitest run` | 4 files / 25 tests passed |

## 回归零改验证

- **discovery.ts 签名零改**：`discoverTopology`（line 32）/ `discoverTopologyInner`（line 43）签名与 throw 语义不变；throw 仍为 Error 实例（enrichParseError 返回 `new Error(...)`），调用方（IPC 层）catch (err:any) 行为兼容（T-06-02-04 mitigate）。
- **DiscoveryResult / DiscoveryFailedDevice interface 零改**（line 21-32）。
- **callAI / executeCommandsOnDevice / getDeviceByIdInternal 调用语义零改**（commandRaw 仅是 commandAiResponse 的别名引用，不改原赋值）。
- **systemLog.ts 零改**：createSystemLog 实现不动（truncate 16000 上限保留），仅 discovery 侧包 safeLog；其他调用方（acl.ts / connection.ts / migrations.ts / init.ts / backupScheduler.ts）零影响。
- **errorMessage prefix 与现状一致**：`AI 命令结果解析失败` / `JSON 解析失败` / `AI 分析结果解析失败` / `AI 命令生成失败` / `AI 拓扑分析失败` 全保留，仅 parse 失败处追加 ` | 原始片段:`。

## 红线遵守

- ✓ 不改功能语义（safeLog 仅包 try/catch + console.warn 兜底，不改 createSystemLog 调用语义；enrichParseError 仅丰富 errorMessage，throw 仍为 Error 实例）
- ✓ 不改 IPC 签名（discovery 为业务 service，本 plan 无 IPC 改动）
- ✓ 不动 SQL schema/迁移（不扩 ai_system_logs schema，enriched errorMessage 复用 errorMessage TEXT 字段）
- ✓ 不改加密（encField/decField/setArpMasterKey/setAiMasterKey 字面量零改，本 plan 不触碰）
- ✓ 不引入新依赖（createSystemLog 已 import）
- ✓ console.warn 兜底遵循 Phase 3 D-P4 可观测性原则（非纯静默）

## 与 06-01 零文件冲突确认

- 06-01 改：`electron/services/arpCollector.ts` + `electron/services/ai.ts`
- 06-02 改：`electron/services/discovery.ts`（ROBUST-02 独占）
- 三文件零重叠，已串行执行（06-01 DONE 后 06-02 启动，无冲突）

## Deviations from Plan

None - plan 执行完全按 D-6-3 / D-6-4 与 plan action 模板落地。

- enrichParseError helper 抽取决策：planner 委托 executor 在「抽 helper vs 两处内联」间裁量。本 plan 选抽 helper（两处 parse 同模式 trim→去 codeblock→JSON.parse→catch enrich，去重合理；helper 局限 discovery.ts 模块级不 export，符合 D-6-3「局限于 discovery.ts」约束）。
- safeLog errorMessage 内联 slice（line 175 / line 306）而非统一走 enrichParseError 文案：因 safeLog 入参 errorMessage 是 string 字段（createSystemLog 签名），而 enrichParseError 返回 Error 实例（供 throw）。两者职责分离——safeLog errorMessage 单独构造 enriched string，throw 单独走 enrichParseError。故 grep `.slice(0, 200)` 命中 3（helper 1 + 两处 safeLog errorMessage 各 1）而非 2，符合 plan acceptance_criteria「≥ 2 / ≥ 3」范围。

## Threat Mitigation 复核

| Threat | Disposition | 落地 |
|--------|-------------|------|
| T-06-02-01（信息泄露：raw.slice(0,200) 可能含设备凭证/拓扑敏感信息） | accept | 单用户桌面场景 + ai_system_logs 仅本地 better-sqlite3 DB 无网络上报 + errorMessage 经 systemLog truncate 16000 上限保护 + SC#2 字面要求「原始内容片段 + 位置」业务需求优先 + 日志脱敏层跨模块 defer。残留风险可接受 |
| T-06-02-02（DoS：日志写库失败中断主流程） | mitigate | 5 处 createSystemLog 全部经 safeLog try/catch 包裹，DB 写库失败 console.warn 兜底不抛出到调用方 |
| T-06-02-03（line 258 嵌套陷阱衍生新中断面） | mitigate | line 272 safeLog 在 try 块内，自身抛被 safeLog 内部 try/catch 吞为 console.warn，不再触发外层 catch → line 280 二次 safeLog 链；line 280 自身（catch handler 内）也经 safeLog 包裹，自身抛同样被吞 |
| T-06-02-04（Integrity：enriched errorMessage 影响 JSON.parse 解析结果或调用方 catch 行为） | mitigate | enrichParseError 返回 `new Error(...)`，instanceof Error 不变；errorMessage prefix 与现状一致仅追加 ` \| 原始片段:`；throw 行为不变，调用方 catch (err:any) err.message 兼容 |

## Commits

| Task | Commit | 文件 | 说明 |
|------|--------|------|------|
| Task 1 | 16cf9a4 | electron/services/discovery.ts | safeLog helper + 5 处 createSystemLog 非致命包裹（D-6-4，line 258 嵌套陷阱切断） |
| Task 2 | 9ad4040 | electron/services/discovery.ts | enrichParseError helper + 两处 JSON parse enriched Error + command parse 补 safeLog（D-6-3） |

## Self-Check: PASSED

- [x] electron/services/discovery.ts 含 `function safeLog`（line 12）
- [x] electron/services/discovery.ts 含 `[safeLog] discovery 日志写库失败`（line 16）
- [x] electron/services/discovery.ts 含 `function enrichParseError`（line 27）
- [x] electron/services/discovery.ts 含 `原始片段:`（line 29/175/306 = 3 命中）
- [x] electron/services/discovery.ts `createSystemLog({` 直接调用计数 0
- [x] electron/services/discovery.ts `safeLog(` 调用计数 5（line 130/140/254/272/280）
- [x] electron/services/discovery.ts 仍含 `import { createSystemLog } from './systemLog'`（line 5）
- [x] electron/services/discovery.ts 仍含 `阶段1: AI命令生成` / `AI 命令生成失败` / `AI 拓扑分析失败`（文案零改）
- [x] commit 16cf9a4 在 git log
- [x] commit 9ad4040 在 git log
- [x] tsc + esbuild + vitest(25) 三绿
