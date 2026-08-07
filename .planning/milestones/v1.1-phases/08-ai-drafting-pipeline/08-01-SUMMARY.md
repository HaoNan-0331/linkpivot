---
phase: 08-ai-drafting-pipeline
plan: 01
subsystem: experience-data-layer / ai-drafting-foundation
tags: [migration, pii-mask, duplicate-detection, experience-service, tdd]
requires:
  - "Phase 7 experienceService.listExperiences（查重复用）"
  - "Phase 7 v8 experiences 表 DDL"
  - "migrationHelpers.hasColumn（幂等守卫）"
provides:
  - "experiences.duplicate_of_exp_id TEXT nullable 列（v9 迁移 + fresh-install DDL 同步）"
  - "electron/utils/piiMask.ts: maskConversationText/maskCredentials/maskIpv4/maskMac（送 LLM 副本分级脱敏）"
  - "electron/services/duplicateDetector.ts: findExistingForDraft（同分类+设备查重，喂摘要列表）"
  - "experienceService.createExperience 扩展签名（接受可选 duplicateOfExpId，单语句原子写 duplicate_of_exp_id）"
affects:
  - "Plan 02（LLM 起草 service）消费 piiMask + duplicateDetector"
  - "Plan 03（IPC + 编排层）调 createExperience({...,duplicateOfExpId}) 不裸 SQL UPDATE"
tech-stack:
  added: []
  patterns:
    - "TDD RED→GREEN（Task 2/3/4 各自独立循环）"
    - "函数式 service 无 MK 持有（duplicateDetector 复用 Phase 7 Pattern 1b）"
    - "幂等迁移 hasColumn 守卫 + db.transaction（v9 沿用 v1-v4 第一形式）"
    - "单语句原子 INSERT（B-1/B-2 方案 A：duplicate_of_exp_id 与 draft 行同 INSERT，无 transaction 复杂度）"
key-files:
  created:
    - electron/utils/piiMask.ts
    - electron/utils/piiMask.test.ts
    - electron/services/duplicateDetector.ts
    - electron/services/duplicateDetector.test.ts
  modified:
    - electron/database/init.ts
    - electron/database/migrations.ts
    - electron/services/experienceService.ts
    - electron/services/experienceService.test.ts
decisions:
  - "MAC 脱敏采用「前三段掩码、后三段保留」（D-04 范例 AA:BB:CC:DD:EE:FF → **:**:**:DD:EE:FF），plan 注释「前两段掩码后四段保留」与范例矛盾时以范例为准"
  - "凭证分隔符接受 : = 空格 三类（D-04 规范「空格/冒号/等号」），正则 (?:\\s*[:=]\\s*|\\s+) 兼容 password xxx / 密码 xxx 形式"
  - "createExperience 选方案 A（单语句原子 INSERT 含 duplicate_of_exp_id），优于方案 B（setDuplicateOfExpId + transaction），吸收 B-1 fix_hint 提到的独立 setter 需求"
  - "duplicateOfExpId 不校验 FK 存在性：experiences 表无 self-FK，信任 Plan 03 编排层传入 LLM 判定结果 + Phase 9 人工确认兜底"
metrics:
  duration: ~12min
  completed: 2026-08-02
  tasks: 4
  files: 8
  tests-added: 28
---

# Phase 08 Plan 01: AI 起草 pipeline 地基层（v9 迁移 + PII 脱敏 + 查重 + createExperience 扩展）Summary

把 Phase 8 起草 pipeline 的四个地基产物前置落地——v9 幂等迁移加 `experiences.duplicate_of_exp_id` 列（D-03a 数据模型）、PII 脱敏 util（D-04 红线）、查重 service（D-02 判定）、`createExperience` 扩展签名（B-1 Service 封装 + B-2 原子性方案 A），让 Plan 02/03 编排层只调门面即可原子落库 + 标注，不裸 SQL、不吞错。

## Tasks Completed

### Task 1: v9 迁移加 experiences.duplicate_of_exp_id 列（commit a3d8d9e）

- `electron/database/migrations.ts`: `MIGRATION_HEAD` 8→9；新增 `v9` 函数（`hasColumn(db,'experiences','duplicate_of_exp_id')` 幂等守卫 + `db.transaction` 包裹 `ALTER TABLE experiences ADD COLUMN duplicate_of_exp_id TEXT` + `db.pragma('user_version = 9')`）；`MIGRATIONS` 数组追加 `{version:9, ...}`
- `electron/database/init.ts`: fresh-install experiences DDL 块紧跟 `attrs_enc` 后追加 `duplicate_of_exp_id TEXT,`，与迁移两路径 schema 逐字一致
- 纯 nullable TEXT 加列：无 NOT NULL/DEFAULT/CHECK，不动 status 四态枚举、不动现有列、不动 exp_device_rel；throw 即 ROLLBACK
- 验证：tsc strict + electron-main build 双绿；6 项 grep 守卫全命中

### Task 2: PII 脱敏 util piiMask（commit 958c7b3）

`electron/utils/piiMask.ts` 导出 4 函数（纯字符串 transform，无 DB/加密/masterKey 依赖）：

| 导出 | 行为 |
|------|------|
| `maskCredentials(text)` | 凭证关键词（password/passwd/pwd/secret/token/apiKey/api_key/key/密码/口令/凭证）+ 分隔符(:/=/空格) + 值整体替换 `****`，引号值整体脱敏，不保留尾4 |
| `maskIpv4(text)` | 前三段掩码 `***.***.***.`、末段保留（`$2` 反向引用，尾段多位数字正确） |
| `maskMac(text)` | 前三段掩码 `**:**:**:`、后三段保留（`$1` 反向引用，对齐 D-04 范例） |
| `maskConversationText(text)` | 串联三步（凭证→IPv4→MAC，避免凭证值被 IP/MAC 正则误伤），空串/纯空白原样返回 |

测试：19 case 全 PASS（凭证 6 + IPv4 4 + MAC 3 + 串联 6）

### Task 3: 查重 service duplicateDetector（commit 538c6ad）

`electron/services/duplicateDetector.ts` 函数式（无 class、无 MK 持有，复用 Phase 7 listExperiences 门面，不读写加密列）：

```typescript
findExistingForDraft({ category, deviceIds? }): ExistingExperienceSummary[]
// ExistingExperienceSummary = { exp_id, title, content_preview(≤150字) }
```

- 有 deviceIds（非空数组）→ 对每 deviceId 调 `listExperiences({category, deviceId, includeInvalid:false, limit:MAX_BATCH, offset:0})`，合并去重（同 exp_id 多设备命中只保留一条）
- 无 deviceIds（空数组/undefined）→ `listExperiences({category, includeInvalid:false, limit:MAX_BATCH, offset:0})` 全库同分类
- 自动过滤已失效（`includeInvalid:false` 复用 Phase 7 bi-temporal），无硬相似度阈值（信任 LLM + 红线③人工确认兜底）
- 反向守卫：grep `encrypt(`/`decrypt(` = 0

测试：5 case 全 PASS（多设备去重/空数组全库/undefined/空结果/<150字）

### Task 4: 扩展 createExperience 接受可选 duplicateOfExpId（commit b76cfa0）

`electron/services/experienceService.ts`:

- `ExperienceInput` interface 增可选 `duplicateOfExpId?: string | null`（不传/传 null → 写 NULL，向后兼容 Phase 7 既有调用方零改动）
- `createExperience` INSERT 语句加第 10 列 `duplicate_of_exp_id` + 第 10 个占位参数；CREATE 与标注同 INSERT **单语句原子**写入（CREATE 失败 throw → 整条不落库，标注与 draft 行共存亡——B-2 同源解决）
- 经 service 门面写入（B-1 不绕数据访问门面），prepared statement 参数化无 SQL 注入；不校验 FK 存在性（experiences 表无 self-FK，信任 Plan 03 编排层 + Phase 9 人工确认兜底）
- 不动 `updateExperience`（CR-01 白名单仍不含 duplicate_of_exp_id；Phase 8 只经 create 入口写）；反向守卫 grep `UPDATE experiences SET duplicate_of_exp_id` = 0

测试：24 case 全 PASS（既有 20 + 新增 4：不传写 NULL / 字符串写值 / null 写 NULL / troubleshooting+dup 两不误）

## 三绿门禁

- `npx tsc -p tsconfig.web.json --noEmit` EXIT 0（noUnusedLocals 全绿）
- `npm run build:electron-main` EXIT 0（v9 迁移 + 新 util/service + createExperience 扩展经 esbuild bundle 通过）
- `npx vitest run` 全 PASS：10 文件 / **103 测试**（既有 75 + piiMask 19 + duplicateDetector 5 + experienceService 新增 4，基线不破坏）

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MAC 脱敏正则与 D-04 范例不一致**
- **Found during:** Task 2 GREEN
- **Issue:** Plan 的 MAC_RE `(?:[0-9A-Fa-f]{2}:){2}(...)` 注释为「前两段掩码、后四段保留」，但 D-04 范例 `AA:BB:CC:DD:EE:FF → **:**:**:DD:EE:FF` 实际是「前三段掩码、后三段保留」。原正则替换串 `**:**:**:$1` 与捕获组（后四段）组合会多出一个段（7 段 vs 原 6 段）。
- **Fix:** 以范例为准，MAC_RE 改为 `(?:[0-9A-Fa-f]{2}:){3}([0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})`（前三段掩码、后三段保留），替换串 `**:**:**:$1`。
- **Files modified:** electron/utils/piiMask.ts（MAC_RE + 注释）
- **Commit:** 958c7b3

**2. [Rule 1 - Bug] 凭证正则不接受空格分隔符**
- **Found during:** Task 2 GREEN
- **Issue:** Plan 的 CRED_RE `(?:${CRED_KEYWORDS})\\s*[:=]\\s*...` 仅接受 `:`/`=` 分隔符，但 D-04 规范明确「空格/冒号/等号」三类分隔符，测试用例 `password p@ss`、`密码 admin@123`（空格分隔）无法命中。
- **Fix:** CRED_RE 改为 `(?:${CRED_KEYWORDS})(?:\\s*[:=]\\s*|\\s+)...`，兼容 `password xxx` / `密码 xxx` 形式；`maskCredentials` 后处理器 fallback `(?<=[:=\s])\S+$` 已覆盖空格分隔场景，无需改函数体。
- **Files modified:** electron/utils/piiMask.ts（CRED_RE）
- **Commit:** 958c7b3

**3. [Rule 1 - Bug] Task 4 grep 守卫 duplicateOfExpId ≥3 与 plan GREEN 代码矛盾**
- **Found during:** Task 4 done 校验
- **Issue:** Plan 的 done 标准 `grep -c "duplicateOfExpId" experienceService.ts ≥ 3`，但 plan 自身 GREEN 代码用 `const dupId = input.duplicateOfExpId ?? null` 把 input 字段收拢为局部变量后再传 `.run(..., dupId)`，故 `duplicateOfExpId` 仅出现 2 次（interface 字段 + 局部变量赋值），第 3 处被 `dupId` 替代。
- **Fix:** 按 plan GREEN 代码实现（正确做法，局部变量收拢更清晰），接受 grep 计数 = 2 < 3。这是 plan done 标准与 plan 代码自相矛盾的 spec bug，以 plan 代码为准。
- **Files modified:** 无（实现按 plan 代码）
- **Commit:** b76cfa0

## Known Stubs

无 — 四个产物均为完整可执行实现，无 placeholder/mock 数据流。piiMask 纯函数已全脱敏；duplicateDetector 经 listExperiences 真实查询路径；createExperience 经 prepared statement 真实落库；v9 迁移经真实 ALTER + user_version。Plan 02/03 才会消费这些产物（送 LLM、IPC 编排），本 plan 不触发 LLM、不落 draft，符合"地基层"定位。

## Threat Flags

无新增威胁面。本 plan 实现严格对齐 plan `<threat_model>` 已登记的 T-08-01~06 + T-08-19：

- T-08-01/02（PII 泄露）：piiMask 分级脱敏 + 串联顺序（凭证→IP→MAC）单测覆盖混合文本三者全脱敏 ✓
- T-08-03（迁移破坏历史）：v9 hasColumn 幂等守卫 + db.transaction（throw ROLLBACK）+ 纯 ALTER ADD COLUMN nullable TEXT ✓
- T-08-04（查重泄露 attrs）：duplicateDetector 只取 id/title/content（明文），不取 attrs_enc ✓
- T-08-05（查重爆内存）：limit:MAX_BATCH=1000 复用 listExperiences throw 强制 ✓
- T-08-19（编排层裸 SQL）：duplicate_of_exp_id 唯一写入入口是 createExperience CREATE 语句（参数化 prepared statement），grep 反向守卫 UPDATE=0 ✓

## Self-Check: PASSED

文件存在性：
- electron/utils/piiMask.ts FOUND
- electron/utils/piiMask.test.ts FOUND
- electron/services/duplicateDetector.ts FOUND
- electron/services/duplicateDetector.test.ts FOUND
- electron/database/init.ts（已含 duplicate_of_exp_id TEXT）FOUND
- electron/database/migrations.ts（已含 v9）FOUND
- electron/services/experienceService.ts（已扩展 createExperience）FOUND
- electron/services/experienceService.test.ts（已增 4 case）FOUND

提交存在性：
- a3d8d9e FOUND
- 958c7b3 FOUND
- 538c6ad FOUND
- b76cfa0 FOUND
