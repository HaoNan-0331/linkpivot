---
phase: 10-experience-browse-page
plan: 04
subsystem: experience-browse-gap-closure
tags: [gap-closure, security, data-integrity, uat-fix, code-review]
requires:
  - 10-01-PLAN.md（severity v10 列 + restoreExperience 受控接口 + listExperiences opts 基线）
  - 10-02-PLAN.md（ExperienceEditForm 公共组件）
  - 10-03-PLAN.md（ExperienceTab + ExperienceDetailModal UI 层）
provides:
  - CR-01 restoreExperience 双层守卫（service + SQL，draft/有效/不存在 抛错）
  - CR-02 backfillSeverityFromHistory 幂等回填钩子 + main.ts post-MK 调用
  - WR-01 tags LIKE ESCAPE 转义（\ % _ 三类元字符）
  - WR-02 setExperienceDevices 单事务原子接口 + IPC experience:setDevices 三向一致
  - 问题 2 状态 Select 与 includeInvalid 单向联动 + service invalidOnly 路径
  - 问题 1a ExperienceEditForm 关联设备候选放开全类型
  - WR-05 两处 formatTs 兼容 ISO（无字面 T）
affects:
  - electron/services/experienceService.ts
  - electron/services/__tests__/experienceService.browse.test.ts
  - electron/ipc/experienceIpc.ts
  - electron/preload.ts
  - electron/main.ts
  - src/types/electron.d.ts
  - src/types/experience.ts
  - src/components/knowledge/ExperienceTab.tsx
  - src/components/knowledge/ExperienceEditForm.tsx
  - src/components/knowledge/ExperienceDetailModal.tsx
tech-stack:
  added: []
  patterns:
    - 双层守卫（service 层 status/invalid_at 检查 + SQL WHERE invalid_at IS NOT NULL 防御）
    - post-MK 启动钩子（幂等回填，try/catch 不阻塞启动，与 FTS5 自愈同范式）
    - LIKE 通配符元字符转义 + ESCAPE 子句
    - 单事务原子 diff 接口（throw ROLLBACK，替代 renderer N IPC）
    - 单向联动（状态 Select 影响 Switch，反之不）
key-files:
  created: []
  modified:
    - electron/services/experienceService.ts
    - electron/services/__tests__/experienceService.browse.test.ts
    - electron/ipc/experienceIpc.ts
    - electron/preload.ts
    - electron/main.ts
    - src/types/electron.d.ts
    - src/types/experience.ts
    - src/components/knowledge/ExperienceTab.tsx
    - src/components/knowledge/ExperienceEditForm.tsx
    - src/components/knowledge/ExperienceDetailModal.tsx
decisions:
  - CR-01 双层守卫（service 层显式 throw 不存在/draft/有效 + SQL WHERE invalid_at IS NOT NULL 防御性二次校验），删除原 T-10-03 误导性注释
  - CR-02 backfillSeverityFromHistory 函数式（复用模块级 MK + db getter），单行失败跳过不阻塞全量回填（与 setDecryptFailureHandler 可观测策略一致）
  - WR-01 ESCAPE 子句 JS 字符串 '\\\\' 表 SQL 中 '\\'（一个反斜杠 + ESCAPE char），转义顺序先反斜杠避免二次转义
  - WR-02 setExperienceDevices 批量上限 100（单经验设备量小，MAX_BATCH=1000 不适用，对齐 CLAUDE.md 批量精神）
  - 问题 2 单向联动（Select 影响 Switch，Switch 不影响 Select），清空 Select 不强制 includeInvalid
  - WR-03 顺手清（relateDevices.length>=0 永真改 if (relateDevices)），同文件顺手标注
  - MemDb 测试支撑增强（非业务）：restoreExperience 守卫 SELECT/backfill SELECT/DELETE exp_device_rel/invalidOnly 条件/tags ESCAPE 反转义 5 处
metrics:
  duration: ~14min
  completed: 2026-08-06
  tasks: 3（Task 1 service 层 + Task 2 UI 层 + Task 3 四绿门禁复跑）
  files: 10
---

# Phase 10 Plan 04: Experience Browse Gap Closure Summary

CR-01 restore 安全守卫 + CR-02 历史 severity 回填 + 问题 2 状态筛选联动 + 问题 1a 设备 filter 放开 + WR-01/02/05 高优 WARNING，5 项必修 gap 全部落地（10 文件改 + 9 新 vitest 用例 + IPC 三向一致），三绿门禁 + esbuild 四绿全通过 200/200 测试零回归。

## What Was Built

### 5 项必修 gap

| Gap | 修法 | 落地点 |
|-----|------|--------|
| **CR-01** restoreExperience 双层守卫 | service 层 SELECT status/invalid_at 显式 throw（不存在/draft/有效）+ SQL WHERE invalid_at IS NOT NULL 二次防御 | experienceService.ts:421-447 |
| **CR-02** backfillSeverityFromHistory 幂等回填 | WHERE severity IS NULL AND attrs_enc IS NOT NULL → decField → JSON.parse → VALID_SEVERITIES 校验 → UPDATE；单行失败跳过 | experienceService.ts:461-496 + main.ts post-MK 钩子 |
| **问题 2** 状态 Select 联动 + invalidOnly | Select onChange 联动 setIncludeInvalid；loadExperiences status='invalid' 走 invalidOnly 路径；service ListExperiencesOpts 加 invalidOnly | ExperienceTab.tsx:437-456 + experienceService.ts:139-146 |
| **问题 1a** 设备 filter 放开 | 删 `.filter(connectionType === 'ssh'||'telnet')`，候选含全类型；T-10-08 mitigation 仅适用 AI 起草 | ExperienceEditForm.tsx:102-111 |
| **WR-01** tags LIKE ESCAPE 转义 | `\`→`\\`、`%`→`\%`、`_`→`\_`（先反斜杠）+ `ESCAPE '\\'` 子句 | experienceService.ts listExperiences tags 分支 |
| **WR-02** setExperienceDevices 单事务原子 | conn.transaction diff toAdd/toRemove，throw ROLLBACK；IPC experience:setDevices secure 包装 + preload + d.ts 三向一致 | experienceService.ts:503-522 + experienceIpc.ts |
| **WR-05** formatTs 兼容 ISO | `new Date(ts.replace(' ', 'T'))` + pad 格式化，两处独立定义 | ExperienceTab.tsx + ExperienceDetailModal.tsx |

### 新增测试（9 vitest 用例，browse.test.ts）

- **CR-01 restoreExperience 守卫（4 用例）**：不存在 id 抛错 / draft 抛错（提示走 confirmDrafts）/ 有效经验抛错（提示无需恢复）/ invalid 成功恢复（invalid_at 清 NULL + status 回 published）
- **CR-02 backfillSeverityFromHistory（2 用例）**：历史 severity NULL + attrs_enc.severity 合法 → 回填 + 幂等（再跑 backfilled=0）/ severity 已填不动 + attrs_enc 无 severity 不报错
- **WR-01 tags 转义（1 用例）**：tag='100%' 仅命中字面 '100%'，不误匹配 '100pa'
- **WR-02 setExperienceDevices（2 用例）**：diff [A,B]→[B,C] = A 删 C 加 / throw 回滚（删表制造失败，事务 ROLLBACK 关联不变）

### MemDb 测试支撑增强（非业务）

为支持新语句扩 MemDb.buildStatement：
- `SELECT status, invalid_at FROM experiences WHERE id = ?`（CR-01 守卫）
- `SELECT id, attrs_enc, severity FROM experiences WHERE severity IS NULL AND attrs_enc IS NOT NULL`（CR-02 backfill）
- `SELECT device_id FROM exp_device_rel WHERE experience_id = ?`（WR-02 setExperienceDevices diff）
- `DELETE FROM exp_device_rel WHERE experience_id = ? AND device_id = ?`（unrelateDevice）
- applyConditions：tags LIKE 兼容 ESCAPE 子句（剥皮 + 反转义 `\%→%`）+ invalidOnly 条件分支（`invalid_at IS NOT NULL AND invalid_at <= datetime`）+ 默认过滤条件精确匹配（`invalid_at IS NULL OR invalid_at > datetime`，原模糊匹配误中 invalidOnly）

### IPC 三向一致（experience:setDevices）

| 层 | 命中 |
|----|------|
| electron/ipc/experienceIpc.ts `experience:setDevices` secure handler | 1 |
| electron/preload.ts `setDevices:` 方法 | 1 |
| src/types/electron.d.ts `setDevices:` 签名 | 1 |

## Verification Results

### 四绿门禁（Task 3 全量复跑）

| Gate | Command | Result |
|------|---------|--------|
| tsc strict + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 |
| vite build | `npx vite build` | exit 0（chunk size 警告非错误） |
| electron-main esbuild | `npm run build:electron-main` | exit 0（dist-electron/main.js 1.9mb，native 外部化） |
| vitest 全量 | `npx vitest run` | exit 0，15 files / **200 测试全 PASS**（191 既有 + 9 新增，零回归） |

### Gap 闭环 grep 断言

| Gap | grep | 命中 |
|-----|------|------|
| CR-01 SQL 守卫 | `AND invalid_at IS NOT NULL` in experienceService.ts | 2 |
| CR-01 draft 抛错 | `草稿不可经 restore` | 1 |
| CR-02 钩子调用链 | `backfillSeverityFromHistory` in main.ts | 2（1 import + 1 调用） |
| WR-01 ESCAPE | `ESCAPE` in experienceService.ts | 2 |
| WR-02 IPC 三向 | `experience:setDevices` / `setDevices:` | 三处各 1 |
| 问题 1a filter 移除 | `connectionType === 'ssh'` in ExperienceEditForm.tsx | 0 |
| 问题 2 invalidOnly | `invalidOnly` in ExperienceTab.tsx | 3 |
| WR-05 formatTs ISO | `ts.replace(' ', 'T')` 两处 | Tab 1 + Detail 1 |

## Threat Model 落地

| Threat ID | Disposition | 落地证据 |
|-----------|-------------|----------|
| T-10-04-01 EoP（draft→published 绕 confirmDrafts） | mitigate | CR-01 双层守卫 + 4 vitest 用例覆盖 |
| T-10-04-02 Tampering（backfill 解密历史 attrs_enc） | mitigate | CR-02 幂等 severity IS NULL 守卫 + 单行失败跳过 + post-MK 调用 |
| T-10-04-03 Tampering（tags LIKE 未转义） | mitigate | WR-01 ESCAPE 子句 + 三类元字符转义 + '100%' 用例 |
| T-10-04-04 Repudiation（syncRelateDevices 非原子） | mitigate | WR-02 setExperienceDevices 单事务 + renderer 单 IPC |
| T-10-04-05 Info Disclosure（问题 1a 放开设备 filter） | accept | 设备 DTO 走 rowToDevice 白名单无密文泄露；关联≠连接 |
| T-10-04-06 Tampering（status='invalid' 查不到失效） | mitigate | 问题 2 invalidOnly 路径筛 invalid_at<=now |
| T-10-04-SC npm installs | accept | 无新增依赖 |

## Decisions Made

- **CR-01 双层守卫语义优先**：service 层先 SELECT 做语义判定（不存在/draft/有效 各自显式提示），SQL WHERE invalid_at IS NOT NULL 是防御性二次校验（防 service 层与 SQL 间竞态），非唯一防线。删除原"T-10-03 mitigate：status 直回 published 无法被滥用"的误导性注释（status 不接受 renderer 入参这一事实不变，但单凭此不足以防 draft→published 越权，需双层守卫）。
- **CR-02 单行失败跳过策略**：解密/JSON/非法 severity 任一失败跳过该行不 throw，避免单条脏数据阻塞全量回填；decField 失败已走 setDecryptFailureHandler 写 system_log 告警，可观测不静默。
- **WR-01 ESCAPE 子句 JS 字符串转义**：JS 字符串 `'\\\\'` 表 SQL 中 `\\`（一个反斜杠字面 + ESCAPE char）；转义顺序先反斜杠（避免 `%`→`\%` 后反斜杠本身被二次转义）。
- **WR-02 批量上限 100**：单经验关联设备量小，MAX_BATCH=1000 不适用此场景；100 上限对齐 CLAUDE.md 批量上限精神。
- **问题 2 单向联动**：状态 Select 影响 Switch（选已失效→includeInvalid=true），Switch 不影响 Select（Switch 是独立 toggle，可单独显示含失效）。清空 Select 不强制 includeInvalid（保持当前 Switch 状态）。
- **WR-03 顺手清**：handleSubmitEdit 中 `relateDevices && relateDevices.length >= 0` 永真条件（同文件 WR-02 改动顺手），改 `if (relateDevices)` 更清晰，标注 WR-03 顺手清（plan 授权）。

## Deviations from Plan

### 偏离 1：新增 9 用例（plan 述 ~8）

- **Plan 描述**：「8 用例」（CR-01 4 + CR-02 2 + WR-01 1 + WR-02 1）
- **实际**：9 用例（WR-02 多加了 1 个 throw 回滚用例验证事务 ROLLBACK 语义）
- **理由**：plan acceptance 接受「若 mock transaction 已支持 ROLLBACK 语义（09-01 增强），可补一个 throw 回滚用例」——MemDb 09-01 已加 snapshot/restore，WR-02 第二用例覆盖事务原子性语义更完整，不算超 scope
- **影响**：测试计数 200（191 既有 + 9 新增），plan 述 ≥199 达成

### 偏离 2：MemDb applyConditions 默认过滤条件精确匹配调整

- **Plan 描述**：扩 applyConditions LIKE 分支识别 ESCAPE 转义
- **实际**：除 ESCAPE 反转义外，还把原 `invalid_at\s+IS\s+NULL` 模糊匹配改为 `invalid_at\s+IS\s+NULL\s+OR\s+invalid_at\s*>\s*datetime` 精确匹配
- **理由**：原模糊匹配 `IS NULL` 会误中 invalidOnly 新条件 `invalid_at IS NOT NULL AND ...`（正则不区分 NULL 与 NOT NULL），导致 invalidOnly 筛选行为失真。精确化是测试支撑代码纠错，非业务改动
- **影响**：既有 7 测试仍全绿（默认过滤条件精确匹配后行为等价）

## Known Stubs

无。本 gap 全是修复既有代码 + 测试补强，无新功能 stub。

## Out-of-Scope Follow-ups（plan out_of_scope_followups，本 gap 不修）

- **问题 1b**：ai 助手聊天设备范围扩展（独立新需求，本 gap 不动 ai 模块）
- **问题 3**：标签输入复用已有标签（UX 增强，用户明确讨论后处理）
- **WR-03**：relateDevices.length>=0 永真——本 gap 顺手清（同文件 WR-02 改动），完整 WR-03 范围仍 out_of_scope
- **WR-04**：loadExperiences 请求竞态（renderer fast-switch filter 过期列表覆盖）
- **WR-06**：IPC 入参 severity/tags/search 缺枚举/长度校验
- **WR-07**：isValid/isInvalid 三方漂移（service/DetailModal/Tab 重复定义），本 gap 仅修 formatTs 兼容不抽 util
- **WR-08/09**：测试 MemDb 重复 / stripEncColumns 死代码

## Self-Check: PASSED

- 10 文件 modified 全 FOUND（git log 29021cc/411b8e5）
- 四绿门禁（tsc / vite build / build:electron-main / vitest run）全 exit 0
- vitest 200 测试 PASS（既有 191 零回归 + 9 新增）
- IPC 三向一致（experience:setDevices / restore 三处各 1）
- 5 项必修 gap grep 断言全通过
