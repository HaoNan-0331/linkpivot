---
phase: 07-experience-data-layer-security-baseline
plan: 01
subsystem: experience-data-layer
tags: [experience, data-layer, migration, service, encryption, bi-temporal]
requires:
  - "v1.0 数据/迁移基线（migrations.ts v1-v7 + crypto.ts encField/decField + knowledgeBaseService.ts 函数式范例）"
provides:
  - "experiences 表（通用列 + attrs_enc 加密列 + bi-temporal valid_at/invalid_at + 4 态 status + 溯源/复用预埋列）"
  - "exp_device_rel 多对多关联表（UNIQUE 去重 + 双向 FK CASCADE + 双向索引）"
  - "v8 幂等迁移步骤（sqlite_master sql-content 'attrs_enc' 守卫 + db.transaction）"
  - "ExperienceService 函数式 service（CRUD + 设备关联 + 软失效 + attrs 模板校验 + 字段加密 + MAX_BATCH 越权防护）"
affects:
  - "Plan 02（IPC 网关层将消费 experienceService，挂 secure/safe + IPC channel experience:*）"
  - "Phase 8 起草（draft 态草稿落库）"
  - "Phase 11 检索复用（消费 incReuseCount/touchLastVerifiedAt + bi-temporal 过滤）"
tech-stack:
  added: []
  patterns:
    - "函数式 service + 模块级 MK（CONVENTIONS Pattern 1a，与 knowledgeBaseService.ts 同形态）"
    - "bi-temporal 软失效过滤（invalid_at IS NULL OR invalid_at > now）"
    - "attrs 模板校验（troubleshooting 强制 severity 枚举）"
    - "内存 mock DB 测试（规避 DEP-1 native binding ABI 冲突，与 migrationHelpers.test.ts 思路一致）"
key-files:
  created:
    - electron/services/experienceService.ts
    - electron/services/experienceService.test.ts
  modified:
    - electron/database/init.ts
    - electron/database/migrations.ts
    - vitest.config.ts
decisions:
  - "content 明文 / attrs_enc 加密分离：content 支撑 Phase 11 FTS5 检索，敏感凭证只放 attrs"
  - "4 态 status（draft/confirmed/published/invalid）建表即预埋，为 Phase 8-10 状态机铺路避免补迁移"
  - "experienceService 采用函数式形态（非静态类），与 knowledgeBaseService.ts 同属知识库域、同读写加密列"
  - "测试用内存 mock DB 而非真实 better-sqlite3，规避 DEP-1 ABI 冲突"
metrics:
  duration: 7m24s
  completed: "2026-08-01"
---

# Phase 7 Plan 01: Experience Data Layer Summary

经验沉淀数据层地基落地——experiences + exp_device_rel 两张新表（init.ts fresh-install DDL + migrations.ts v8 幂等迁移双落地逐字一致）+ ExperienceService 函数式 service（CRUD/设备关联/bi-temporal 软失效/attrs 模板校验/AES-256-GCM 字段加密/MAX_BATCH 越权防护），为 Phase 8-11（起草/确认/浏览/检索）铺好持久化承载与安全基线。

## Tasks Completed

| # | Task | Commit | Key Files |
|---|------|--------|-----------|
| 1 | experiences + exp_device_rel 建表（init.ts DDL + v8 迁移） | 7467a0f | electron/database/init.ts, electron/database/migrations.ts |
| 2 | experienceService 函数式 service（TDD RED→GREEN） | 06d8215 (RED) / 7ba8170 (GREEN) | electron/services/experienceService.ts, electron/services/experienceService.test.ts |

## 关键设计决策

### 1. content 明文 vs attrs_enc 加密取舍

- **content 明文落盘**：attrs/正文分离设计。content 需支撑 Phase 11 FTS5 全文检索，加密则无法索引（与 kb_documents.file_path/content 同样明文的既有模式一致）。威胁 T-07-04 接受此取舍——敏感数据只放 attrs。
- **attrs_enc AES-256-GCM 加密**：troubleshooting 类处置可能贴含密码的命令，JSON blob 整体加密落盘。读写全程只走 encField/decField（自带 null/降级），禁止裸调 encrypt/decrypt（grep 词界 `\b(encrypt|decrypt)\(` = 0 验证）。

### 2. 4 态 status 预埋理由

`status CHECK(status IN ('draft','confirmed','published','invalid'))` 建表即存在 4 态枚举，对应下游 phase 状态机：
- `draft`：Phase 8 AI 起草态（默认值）
- `confirmed`：Phase 9 人工确认态
- `published`：Phase 10 浏览页发布态
- `invalid`：Phase 10/11 标失效态

建表即预埋避免后续补迁移。同样预埋的还有 `source_session_id`（Phase 8/9 溯源）、`last_verified_at` + `reuse_count`（Phase 11 复用验证）、`relation_type`（多类关联扩展 FUTURE-02）。

### 3. experienceService 函数式形态决策

采用 CONVENTIONS Pattern 1a（函数式 + 模块级 `let MK` + `setExperienceMasterKey` 注入），**非**静态类。理由：与 knowledgeBaseService.ts 同属知识库域、同读写加密列（attrs_enc），形态一致便于维护；masterKey 是运行期注入的可变状态，函数式闭包绑 MK 比挂 static 字段直观。`rowToExperience` helper 在 enc/dec 闭包内解密回填 attrs 且 delete 密文列（不外泄给调用方）。

### 4. 测试用内存 mock DB（规避 DEP-1）

vitest 在 plain Node 运行，better-sqlite3 native binding 经 @electron/rebuild 按 Electron ABI 重建（NODE_MODULE_VERSION 145），与 plain Node（137）不匹配无法加载。故用内存 mock DB 复刻 better-sqlite3 子集 API（prepare/exec/transaction/pragma），含括号/引号感知的 VALUES 分词器（处理 `datetime('now','localtime')` 内含逗号）+ JOIN/COUNT 语义。与现有 migrationHelpers.test.ts 规避 better-sqlite3 的思路一致。

service 经 `_setExperienceDbGetter`（@internal，仅测试调用）注入 db getter；生产路径默认走 `getDatabase()` 单例。公共 API 不暴露此内部钩子。

## ExperienceService 调用契约（供 Plan 02 IPC 层消费）

```typescript
// masterKey 注入（main.ts 启动时，紧随 setKbMasterKey/setDeviceMasterKey 之后）
import { setExperienceMasterKey } from './services/experienceService'
setExperienceMasterKey(masterKey)

// CRUD
createExperience(input: ExperienceInput): ExperienceRow          // status 默认 'draft'
getExperience(id: string): ExperienceRow | null                  // attrs 已解密回填，attrs_enc 已 delete
listExperiences(opts: ListExperiencesOpts): PaginatedResult<ExperienceRow>  // {rows,total,truncated}
updateExperience(id: string, fields: ExperienceUpdateFields): ExperienceRow
invalidateExperience(id: string): ExperienceRow                  // 软失效设 invalid_at
deleteExperience(id: string): void                               // 物理删（CASCADE 清 exp_device_rel）

// 设备关联
relateDevice(experienceId, deviceId, relationType='primary'): void   // INSERT OR IGNORE 幂等
unrelateDevice(experienceId, deviceId): void
listDevicesByExperience(experienceId): DeviceRow[]              // name_enc 密文原样，脱敏由 IPC 层
listExperiencesByDevice(deviceId, includeInvalid=false): ExperienceRow[]

// Phase 11 复用接口预埋（本 phase 实现，Phase 11 消费）
incReuseCount(id: string): void
touchLastVerifiedAt(id: string): void
```

IPC 层（Plan 02）应：每个 handler 走 `secure(...)` 包装（特权通道鉴权+脱敏）；channel 命名 `experience:<action>`；list 类通道经网关 `validateLimit`/`validateOffset`（service 内已有 MAX_BATCH=1000 二次防护）；`listDevicesByExperience` 返回的 name_enc 须经 IPC 层 decField + 脱敏 `****xxxx` 形式回 renderer。

## 验证证据

### 三绿门禁

| Gate | 命令 | 结果 |
|------|------|------|
| tsc web strict | `npx tsc -p tsconfig.web.json --noEmit` | EXIT 0（无错误） |
| electron-main build | `npm run build:electron-main` | EXIT 0（dist-electron/main.js 1.8mb） |
| 全量 vitest | `npx vitest run` | 8 files / 73 tests passed（基线 7/55 → +1 file +18 tests） |

### Task 1 acceptance grep（全部命中）

- `MIGRATION_HEAD = 8` × 1；`version: 8` × 1；`const v8 = ` × 1
- `CREATE TABLE IF NOT EXISTS experiences` × 1；`exp_device_rel` × 1
- `attrs_enc` × 2（init.ts）；`source_session_id TEXT` × 1；`last_verified_at|reuse_count` × 3
- `CHECK(status IN ('draft','confirmed','published','invalid'))` × 1
- `idx_experiences_source_session` × 1（无 expressions 笔误，反向守卫 × 0）
- `UNIQUE(experience_id, device_id)` × 1；FK CASCADE experience × 1 / device × 2
- `expSchema.includes('attrs_enc')` × 1（v8 幂等守卫）

### Task 2 acceptance grep（全部命中）

- 函数式入口全命中：createExperience/setExperienceMasterKey/getExperience/listExperiences/updateExperience/invalidateExperience/relateDevice/listDevicesByExperience/incReuseCount 各 × 1
- `let MK` × 1（函数式形态标志）；`export class ` = 0（反向守卫：无 class）
- `export const MAX_BATCH = 1000` × 1
- `encField|decField` × 7；`\b(encrypt|decrypt)\(` = 0（字段加密红线：无裸调）
- `validateAndStringifyAttrs` × 3（定义 + 2 调用）
- `troubleshooting 类经验 attrs 缺少合法 severity` × 1（质量门错误信息）
- `limit 超过 MAX_BATCH` × 1（批量越权防护）
- `invalid_at IS NULL OR invalid_at > datetime` × 1（bi-temporal 有效过滤）
- `INSERT OR IGNORE INTO exp_device_rel` × 1（关联幂等去重）
- `reuse_count = reuse_count + 1` × 1（Phase 11 复用接口预埋）

### 18 单测覆盖矩阵

create 合法/非法 category、troubleshooting 缺 severity 抛错（缺 + 非法枚举双场景）、非 troubleshooting 空 attrs 不加密、getExperience 解密回填 + 不存在返 null + 不外泄 attrs_enc、list includeInvalid 过滤（true/false 双场景）、list limit>MAX_BATCH 抛错、list 截断信封形态、update 动态字段 + attrs 重新校验、update troubleshooting 改 attrs 缺 severity 抛错、invalidate 软失效、relateDevice 幂等去重、unrelateDevice、listByDevice 反查、incReuseCount/touchLastVerifiedAt、decField 坏密文降级 attrs={}

## Deviations from Plan

### Rule 3 — 阻塞性问题自动修复

**测试无法用真实 better-sqlite3（DEP-1 native binding ABI 冲突）**

- **Found during:** Task 2 TDD setup
- **Issue:** Plan 指示「用 vitest 内存 better-sqlite3」跑测试，但 better-sqlite3 经 @electron/rebuild 按 Electron ABI（NODE_MODULE_VERSION 145）重建，在 plain Node（vitest 运行时，NODE_MODULE_VERSION 137）下 `require('better-sqlite3')` 直接抛 `NODE_MODULE_VERSION mismatch`，无法实例化 `:memory:` db。这是 v1.0 既有 DEP-1 约束（STATE.md Deferred Items 已记录）。
- **Fix:** 用内存 mock DB 复刻 better-sqlite3 子集 API（prepare/exec/transaction/pragma），覆盖 service 实际使用的语句形态（INSERT/UPDATE/DELETE/SELECT/COUNT/JOIN/sqlite_master 查询/PRAGMA）。与现有 migrationHelpers.test.ts 规避 better-sqlite3 的思路一致。service 经 `_setExperienceDbGetter`（@internal 钩子）注入 db getter；生产路径默认走 `getDatabase()` 单例，公共 API 不受影响。
- **Files modified:** electron/services/experienceService.ts（新增 `_setExperienceDbGetter` 内部钩子 + `dbGetter` 默认值），electron/services/experienceService.test.ts（内存 mock DB + 括号/引号感知 VALUES 分词器 + JOIN/COUNT 语义）
- **Impact:** service 生产契约零变更（仍是 `getDatabase()` 单例）；测试可重复运行（vitest 73 tests 全绿）。`_setExperienceDbGetter` 标注 @internal 仅测试调用，不进 IPC 暴露面。

### Plan 测试数量调整（11 → 18）

- Plan 行为规格写「11 个测试」，实际实现为 18 个（更细粒度覆盖 troubleshooting 缺 severity 双场景、includeInvalid true/false 双场景、update 改 attrs 缺 severity 独立场景、decField 坏密文降级独立场景）。覆盖更全属 Rule 2 精神（补强正确性验证），无任何 plan 要求的测试被遗漏。

## Self-Check: PASSED

- 文件存在性:
  - FOUND: electron/database/init.ts
  - FOUND: electron/database/migrations.ts
  - FOUND: electron/services/experienceService.ts
  - FOUND: electron/services/experienceService.test.ts
  - FOUND: vitest.config.ts
- commit 存在性:
  - FOUND: 7467a0f（Task 1）
  - FOUND: 06d8215（Task 2 RED）
  - FOUND: 7ba8170（Task 2 GREEN）
