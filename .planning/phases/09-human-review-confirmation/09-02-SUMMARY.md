---
phase: 09-human-review-confirmation
plan: 02
status: complete
started_at: 2026-08-04T00:50:00+08:00
completed_at: 2026-08-04T00:57:00+08:00
duration: ~7min
commits:
  - f168ef1  # feat: 3 secure IPC channels + renderer DTOs (Task 1)
  - 9172476  # feat: preload APIs + electron.d.ts signatures (Task 2)
files_modified:
  - electron/ipc/experienceIpc.ts
  - electron/preload.ts
  - src/types/experience.ts
  - src/types/electron.d.ts
requirements: [REVIEW-01, REVIEW-02, REVIEW-03]
verdict:
  tsc: pass
  build_electron_main: pass
  vitest: 165/165 pass（无回归）
  three_way_consistency: pass（IPC ↔ preload ↔ electron.d.ts channel 名逐字一致）
---

# Plan 09-02 Summary — IPC 网关层 + preload bridge + renderer DTO

## 目标

把 Plan 01 的 3 个 service 函数（`confirmDrafts`/`listDrafts`/`getSessionMessages`）注册成 `experience:confirmDrafts` / `experience:listDrafts` / `experience:getSessionMessages` 三个 secure IPC channel，preload 暴露到 `window.api.experience.*`，并补齐 renderer 侧 DTO + electron.d.ts 类型签名。桥接 service 层与 renderer，让 Plan 03 的 ReviewConfirmModal / SessionMessagesModal 能经 `window.api.experience.*` 调用。

## 完成项

### Task 1: experienceIpc.ts 追加 3 secure channel + experience.ts 追加 renderer DTO（commit f168ef1）

**electron/ipc/experienceIpc.ts:**
- import 区追加 service 层具名函数 `confirmDrafts`/`listDrafts`/`getSessionMessages` + `MAX_BATCH` 常量（避免双常量漂移）
- import type 追加 `ConfirmDraftsInput`（renderer DTO，IPC 入参类型化，与现有 `ExperienceInput` 同模式）
- `registerExperienceIpc()` 内追加 3 channel：
  - `experience:confirmDrafts`：IPC 层校验 `Array.isArray(input.drafts)` + `length > MAX_BATCH` throw，与 service 层兜底校验双层防御（T-09-06 mitigate）
  - `experience:listDrafts`：service 层 `listExperiences(status='draft', MAX_BATCH)` 截断
  - `experience:getSessionMessages`：sessionId 形态校验防注入（T-09-08 accept 取舍）
- 全 secure 包装（鉴权 + 异常脱敏，延续 SEC-01/02 基线）

**src/types/experience.ts（追加 5 个 renderer DTO）:**
- `ConfirmDraftItem`（fields 复用 `ExperienceUpdateInput`，与 service 层 `ExperienceUpdateFields` 同构——TS 结构化类型兼容）
- `ConfirmDraftsInput` / `ConfirmDraftsResult`（采纳/丢弃/标失效计数）
- `DraftSummary = Experience`（type alias 复用现有 DTO）
- `SessionMessage`（对齐 `ai.ts getChatHistory` 明文回链形态，D-9-5）

### Task 2: preload.ts 追加 3 行 experience API + electron.d.ts 追加 3 方法签名（commit 9172476）

**electron/preload.ts:** experience 块 summarizeSession 之后追加 3 行 contextBridge API，沿用 `unknown` 入参类型与现有 create/update 一致。

**src/types/electron.d.ts:**
- import 列表追加 `ConfirmDraftsInput`/`ConfirmDraftsResult`/`DraftSummary`/`SessionMessage`
- experience 块追加 3 个方法签名（renderer 调用有类型检查）

**main.ts 无需改：** `registerExperienceIpc()` 已在 line 137 注册，3 channel 在其内部追加（grep 验证 =1）。

## 三向一致

| IPC channel (experienceIpc.ts) | preload invoke (preload.ts) | electron.d.ts 方法名 |
|--------------------------------|-----------------------------|----------------------|
| `experience:confirmDrafts` | `confirmDrafts` | `confirmDrafts` |
| `experience:listDrafts` | `listDrafts` | `listDrafts` |
| `experience:getSessionMessages` | `getSessionMessages` | `getSessionMessages` |

逐字一致，全 grep = 1（`ai.getSessionMessages` 与 `experience.getSessionMessages` 各占 1，namespace 隔离正确）。

## 安全

延续 Phase 7 SEC-01/02 基线：
- **T-09-05（Spoofing）**：全 3 channel 经 secure 包装，未登录 throw「未登录或会话已过期」
- **T-09-06（Tampering）**：confirmDrafts IPC 层校验 Array.isArray + MAX_BATCH(1000) throw，与 service 层双层防御
- **T-09-07（Info Disclosure）**：secure 经 sanitizeMessage 异常脱敏
- **T-09-08（DoS）**：listDrafts/getSessionMessages 单机运维场景，单 sessionId 查询天然有界，accept

## 验证

| Gate | 结果 |
|------|------|
| `npx tsc -p tsconfig.web.json --noEmit` | exit 0（严格 + noUnusedLocals 全绿） |
| `npm run build:electron-main` | exit 0（esbuild main/preload 打包通过） |
| `npx vitest run` | 165/165 PASS（无回归，09-01 service 测试仍全绿） |
| 三向一致 grep | 全 = 1（逐字相等） |

## 关键决策

- **IPC 层 import MAX_BATCH（与 Phase 7 07-02 不同）**：07-02 的 `experience:list` 透传 opts.limit 不二次校验（service 层兜底），但 09-02 的 `confirmDrafts` 是写操作 + untrusted renderer 直接入参 drafts 数组，IPC 层加 MAX_BATCH 校验作双层防御（T-09-06），故 import MAX_BATCH 避免 noUnusedLocals 触发。两个决策各自成立，无冲突。
- **fields 类型用 renderer `ExperienceUpdateInput`**：IPC 入参类型化用 renderer DTO（与现有 `ExperienceInput` import 同模式），service 内部接受同构 `ExperienceUpdateFields`，TS 结构化类型兼容，无运行时开销。
- **DraftSummary = Experience type alias**：复用现有 DTO，不重复定义结构，与 Phase 7 `ExperienceRelatedDevice = Device` 同模式。

## 不变量

- masterKey 值永不变（本 plan 不涉加密列，service 层 confirmDrafts 内 attrs_enc 写入复用既有 encField）
- IPC 鉴权网关（secure/safe）不可回退——3 channel 全 secure
- 三向一致（IPC ↔ preload ↔ electron.d.ts）——逐字相等

## 下游影响

Plan 03（renderer 层弹窗）现在可以经 `window.api.experience.*` 调用：
- `window.api.experience.listDrafts()` → 拉取 draft 态草稿列表
- `window.api.experience.confirmDrafts({ drafts })` → 采纳/丢弃/标失效提交
- `window.api.experience.getSessionMessages(sessionId)` → 原始会话明文溯源（D-9-5）

## 遗留

无。Plan 02 完整交付，无 defer 项。
