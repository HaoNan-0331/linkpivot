---
phase: 07-experience-data-layer-security-baseline
plan: 02
subsystem: experience-ipc-gateway
tags: [ipc, auth, preload, types, security, experience]
requires:
  - "07-01 experienceService 函数式 service（CRUD/设备关联/bi-temporal/字段加密/MAX_BATCH）"
  - "v1.0 IPC 鉴权基线（authGuard secure/safe + knowledgeBaseIpc 范例 + main.ts masterKey 注入 + preload contextBridge）"
provides:
  - "registerExperienceIpc()：10 个 experience:* channel 全 secure 包装（鉴权+异常脱敏）+ listDevices 边界剥离 _enc 列"
  - "window.api.experience.* 10 方法白名单（preload contextBridge 暴露，channel 名与 ipcMain.handle 逐字一致）"
  - "Experience/ExperienceInput/ExperienceUpdateInput/ExperienceListInput/ExperienceListResult/ExperienceRelatedDevice DTO（src/types/experience.ts）"
  - "ElectronAPI.experience 类型声明（src/types/electron.d.ts，renderer 类型安全调用）"
  - "main.ts setExperienceMasterKey 注入点 + registerExperienceIpc 注册点"
affects:
  - "Phase 8 起草（draft 态草稿经 experience:create 落库）"
  - "Phase 9 确认（draft→confirmed 经 experience:update）"
  - "Phase 10 浏览页（消费 experience:list/get/create/update/delete/invalidate/relateDevice/unrelateDevice/listByDevice/listDevices）"
  - "Phase 11 检索（消费 incReuseCount/touchLastVerifiedAt 经后续检索通道，本 plan 不暴露此 2 接口）"
tech-stack:
  added: []
  patterns:
    - "函数式 service 具名 import 调用面（非 class 静态方法，IPC 按需 import createExperience 等）"
    - "IPC 边界 stripEncColumns 脱敏（map 删除所有 _enc 后缀 key，renderer 永不收设备密文）"
    - "channel 命名全仓 camelCase 事实约定（复合词 action 用 camelCase）"
    - "preload 宽松类型 unknown + electron.d.ts 强类型（避免双份类型漂移）"
key-files:
  created:
    - electron/ipc/experienceIpc.ts
    - src/types/experience.ts
  modified:
    - electron/main.ts
    - electron/preload.ts
    - src/types/electron.d.ts
decisions:
  - "10 channel 全 secure 包装（无 safe）——经验数据属登录后特权操作（涉敏感 attrs/凭证片段），无登录前场景"
  - "experience:listDevices 经 IPC 边界 stripEncColumns 剥离 _enc 列——service 不解密设备名（不越域调 device 解密通道），IPC 边界统一删除密文列，renderer 永不可见 name_enc"
  - "IPC 层不 import MAX_BATCH——透传 opts.limit 不二次校验，service 层 listExperiences 内 MAX_BATCH=1000 throw 已强制，避免双层校验逻辑漂移与 noUnusedLocals 触发"
  - "channel 命名遵循全仓 camelCase 事实约定——复合词 action 用 camelCase（relateDevice/unrelateDevice/listByDevice/listDevices），与 kb:listDocuments/anomaly:acknowledgeAll 等一致"
  - "preload 入参用 unknown（非强类型）——与 kb 块模式一致，强类型在 electron.d.ts ElectronAPI 声明，避免 preload/renderer 双份类型漂移"
metrics:
  duration: 5m56s
  completed: "2026-08-01"
---

# Phase 7 Plan 02: Experience IPC Gateway & Security Baseline Summary

经验沉淀 IPC 网关层落地——10 个 experience:* channel 全 secure 包装（鉴权+异常脱敏）+ preload 暴露 10 方法白名单 + main.ts 注入 setExperienceMasterKey 并注册 registerExperienceIpc + experience.ts DTO + electron.d.ts 类型声明，SEC-01（IPC 鉴权）/SEC-02（脱敏规范）在 IPC 层全面落地，为 Phase 8-11（起草/确认/浏览/检索）铺好类型安全、鉴权强制的 IPC 契约。

## Tasks Completed

| # | Task | Commit | Key Files |
|---|------|--------|-----------|
| 1 | experienceIpc.ts（10 channel 全 secure + listDevices 边界脱敏）+ experience.ts DTO + electron.d.ts 类型 | 8e4ac43 | electron/ipc/experienceIpc.ts, src/types/experience.ts, src/types/electron.d.ts |
| 2 | main.ts 注入 setExperienceMasterKey + 注册 registerExperienceIpc + preload 暴露 experience.* 白名单 | 592f368 | electron/main.ts, electron/preload.ts |

## 关键设计决策

### 1. 10 channel 全 secure 包装（无 safe）

经验数据天然属登录后特权操作（troubleshooting 类 attrs 可能贴含密码的命令、设备关联涉敏感拓扑），无登录前场景，故全部 10 个 channel 经 `secure(...)` 包装（鉴权 + 异常脱敏），无 `safe(...` 登录前通道。未登录调任意 experience channel → throw `'未登录或会话已过期'`（secure 包装在 try 之外抛出，不被脱敏覆盖）。

### 2. experience:listDevices 边界脱敏（SEC-02 关键落地）

`listDevicesByExperience` 返 devices 原始行含 `name_enc` 等密文列。脱敏决策：**service 层不解密设备名**（避免越域调 device 解密通道、避免跨 service 依赖），改由 **IPC 边界 `stripEncColumns` 统一删除所有 `_enc` 后缀 key** 后返回。renderer 永不可见设备密文（既不解密也不外泄密文）。

```typescript
function stripEncColumns(rows: any[]): any[] {
  return rows.map((row) => {
    const safe: Record<string, unknown> = {}
    for (const key of Object.keys(row)) {
      if (!key.endsWith('_enc')) safe[key] = (row as Record<string, unknown>)[key]
    }
    return safe
  })
}
```

其余 channel（list/get/create/update/invalidate）返回值不经 IPC 二次处理——service 层 `rowToExperience` 已 decField 回填 attrs 并 delete attrs_enc，密文/凭证不外泄。

### 3. IPC 层不 import MAX_BATCH（避免双层校验漂移）

IPC 层透传 opts.limit 至 service，service 层 `listExperiences` 内 MAX_BATCH=1000 throw 已强制。IPC 层不重复校验、不 import MAX_BATCH，避免双层逻辑漂移与未使用 import 触发 tsconfig.web noUnusedLocals。批量越权防护（T-07-11）由 service 层单一权威点强制。

### 4. channel 命名遵循全仓 camelCase 事实约定

复合词 action 用 camelCase（`relateDevice`/`unrelateDevice`/`listByDevice`/`listDevices`），单词 action 不变（`list`/`get`/`create`/`update`/`delete`/`invalidate`），与既有 channel（`kb:listDocuments`/`anomaly:acknowledgeAll`/`oui:addBatch`/`network:getIPDetails`/`arp:collectFromAll`/`export:arpTable`）一致。`'experience:[a-zA-Z-]+'` 精确匹配 10（字符类含 A-Z 以匹配 camelCase，词界隔离防 list 被 listDevices 子串重复命中）。

### 5. preload 入参宽松类型 unknown

preload.ts experience 块入参用 `unknown`（input/fields/opts）而非强类型——与 kb 块模式一致（preload.ts line 110-123 用 `unknown`/`ArrayBuffer` 等宽松类型）。强类型在 electron.d.ts ElectronAPI 声明，preload 实现层不重复标注，避免 preload/renderer 双份类型漂移。

## experienceService IPC 调用契约（供 Phase 8-11 复用）

### 10 channel 清单（全 secure 包装）

| Channel | service 函数 | 入参 | 返回 |
|---------|-------------|------|------|
| `experience:list` | `listExperiences(opts)` | `ExperienceListInput?` | `ExperienceListResult` |
| `experience:get` | `getExperience(id)` | `string` | `Experience \| null` |
| `experience:create` | `createExperience(input)` | `ExperienceInput` | `Experience` |
| `experience:update` | `updateExperience(id, fields)` | `string, ExperienceUpdateInput` | `Experience` |
| `experience:delete` | `deleteExperience(id)` | `string` | `void` |
| `experience:invalidate` | `invalidateExperience(id)` | `string` | `Experience` |
| `experience:relateDevice` | `relateDevice(eid, did, rt?)` | `string, string, string?` | `void` |
| `experience:unrelateDevice` | `unrelateDevice(eid, did)` | `string, string` | `void` |
| `experience:listByDevice` | `listExperiencesByDevice(did, inc?)` | `string, boolean?` | `Experience[]` |
| `experience:listDevices` | `stripEncColumns(listDevicesByExperience(eid))` | `string` | `ExperienceRelatedDevice[]`（_enc 已剥离） |

### main.ts 注入点

```typescript
// line 91 附近（masterKey 注入区，紧跟 setKbMasterKey）
setKbMasterKey(masterKey)
setExperienceMasterKey(masterKey)   // ← 本 plan 追加，与 6 个既有 service 共享 masterKey

// line 132 附近（IPC 注册区，紧跟 registerKbIpc）
registerKbIpc()
registerExperienceIpc()             // ← 本 plan 追加
```

### preload 暴露面

`window.api.experience.*` 10 方法白名单，channel 名与 ipcMain.handle 第一参逐字一致（grep 双向校验 diff exit 0）。contextBridge.exposeInMainWorld 单一暴露点，renderer 无 nodeIntegration、contextIsolation:true、sandbox:true（架构既有红线）。

## 验证证据

### 三绿门禁

| Gate | 命令 | 结果 |
|------|------|------|
| tsc web strict | `npx tsc -p tsconfig.web.json --noEmit` | EXIT 0（无错误，noUnusedLocals 通过——IPC 无未使用 import） |
| electron-main build | `npm run build:electron-main` | EXIT 0（dist-electron/main.js 1.8mb，含新 experienceIpc + main.ts 注入） |
| 全量 vitest | `npx vitest run` | 8 files / 73 tests passed（07-01 的 18 单测 + 既有 55 测试未破坏） |

### Task 1 acceptance grep（全部命中）

- `ipcMain.handle('experience:` × 10（10 channel 全注册）
- `'experience:[a-zA-Z-]+'` 去重精确 10（action 遵循全仓 camelCase 事实约定）
- `secure(` × 10（每个 handler 都 secure 包装，注释已 reword 避免 `secure(...)` 字面命中致虚高）
- `safe(` × 0（无 safe——经验无登录前 channel）
- `export function registerExperienceIpc` × 1
- `import { ... createExperience ... }` × 1（函数式 service 具名 import）
- `MAX_BATCH` × 0（IPC 层不二次校验）
- `ExperienceService` × 0（service 已函数式，无 class 引用）
- `stripEncColumns` × 2（定义 1 + listDevices 调用 1，SEC-02 边界脱敏落地）
- `endsWith('_enc')` × 1（剥离逻辑按 `_enc` 后缀判定）
- experience.ts: `export interface Experience ` × 1 / `ExperienceRelatedDevice` × 1 / `ExperienceCategory|ExperienceStatus` × 2 / `ExperienceListResult = PaginatedResult` × 1
- electron.d.ts: experience 块 10 方法声明（grep -A 12 确认 10 方法命中）

### Task 2 acceptance grep（全部命中）

- `import { setExperienceMasterKey } from './services/experienceService'` × 1
- `import { registerExperienceIpc } from './ipc/experienceIpc'` × 1
- `setExperienceMasterKey(masterKey)` × 1（紧跟 setKbMasterKey）
- `registerExperienceIpc()` × 1（紧跟 registerKbIpc）
- `ipcRenderer.invoke('experience:` × 10（10 channel 全暴露）
- preload experience 块 10 方法（grep -A 12 确认 10 方法命中）

### 三向 channel 命名一致性

ipc 契约（`ipcMain.handle` 第一参）与 preload（`ipcRenderer.invoke` 第一参）10 channel `sort -u | diff` exit 0（逐字一致）；electron.d.ts 方法名（list/get/create/update/delete/invalidate/relateDevice/unrelateDevice/listByDevice/listDevices）与 channel action 1:1 映射。

## SEC-01/SEC-02 落地证据

### SEC-01（IPC 鉴权 + 异常脱敏）

- 10 channel 全 `secure(...)` 包装（grep 计数 = 10）
- 未登录调任意 experience channel → throw `'未登录或会话已过期'`（secure 包装保证，在 try 之外不被脱敏覆盖）
- handler 抛错 → `sanitizeMessage` 移除绝对路径、截断超长 message（>200 字符），不泄露 SQL/内部细节

### SEC-02（脱敏规范，密文/凭证/设备密文不外泄）

- experience attrs_enc：service 层 rowToExperience 已 decField 回填 attrs 并 delete attrs_enc（IPC 返回值不含密文列）
- experience listDevices 设备密文：IPC 边界 `stripEncColumns` 删除所有 `_enc` 后缀 key（renderer 永不收 name_enc 等）
- 异常脱敏：secure 包装的 sanitizeMessage 保证 handler 抛错时不泄露路径/SQL/内部细节

## STRIDE 威胁闭环

| Threat ID | Category | Mitigation 落地证据 |
|-----------|----------|---------------------|
| T-07-07 | Spoofing（IPC 鉴权绕过） | 10 channel 全 secure 包装，secure 计数=10，无 safe 漏网 channel |
| T-07-08 | Information Disclosure（密文/凭证泄露） | 双路径脱敏：service decField+delete attrs_enc / IPC stripEncColumns 删 _enc 设备列；secure sanitizeMessage 异常脱敏 |
| T-07-09 | Tampering（channel 命名致误绑定） | channel 命名遵循全仓 camelCase 约定，ipc↔preload 三向逐字一致（diff exit 0） |
| T-07-11 | DoS（批量越权拉全表） | service 层 MAX_BATCH=1000 强制（IPC 透传不绕过、不二次校验） |
| T-07-12 | EoP（preload 超白名单） | preload 仅暴露 10 白名单方法（grep 计数=10），contextBridge 单一暴露点 |

T-07-10（Repudiation 特权操作溯源）accept——本 phase 不做操作审计日志，source_session_id 列已为 AI 起草溯源预埋（Phase 10 浏览页 CRUD 审计由后续 phase 评估）。

## Deviations from Plan

None - plan executed exactly as written.

（注：experienceIpc.ts 注释中"全部 10 个 experience:* channel 经 secure(...) 包装"原含字面 `secure(...)`，与 acceptance grep `secure(` = 10 冲突（grep 命中 11 = 10 handler + 1 注释），已 reword 为"经 secure 鉴权 + 异常脱敏包装"。非功能变更，仅注释措辞调整以满足严格 grep 验证。）

## Self-Check: PASSED

- 文件存在性:
  - FOUND: electron/ipc/experienceIpc.ts
  - FOUND: src/types/experience.ts
  - FOUND: electron/main.ts（已修改）
  - FOUND: electron/preload.ts（已修改）
  - FOUND: src/types/electron.d.ts（已修改）
- commit 存在性:
  - FOUND: 8e4ac43（Task 1）
  - FOUND: 592f368（Task 2）
