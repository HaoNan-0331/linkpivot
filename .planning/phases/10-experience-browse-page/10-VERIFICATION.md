---
phase: 10-experience-browse-page
verified: 2026-08-05T22:00:00Z
status: gaps_found
score: 5/5 must-haves verified (truths); 2 known issues 待人工决策
overrides_applied: 0
re_verification:
  previous_status: N/A
  previous_score: N/A
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps:
  - truth: "restoreExperience 受控接口必须保留 Phase 9 红线③不变量（draft 经 confirmDrafts 才能转 published）"
    status: partial
    reason: "restoreExperience UPDATE 无状态守卫，对 draft id 调用会强制 status='published'，绕过 confirmDrafts 质量门（CLAUDE.md/PROJECT 红线③ + Phase 9 红线③）。UI 正常流程不会触发（行操作按状态切换、draft 不进浏览页），但 IPC 面暴露给 renderer，安全不变量被破坏。browse 测试套件无 draft→restore 抛错用例（已确认）。这是安全防线缺失，非 goal 阻塞，但属 BLOCKER 级代码缺陷需闭环。"
    artifacts:
      - path: "electron/services/experienceService.ts"
        issue: "L421-427 restoreExperience 的 UPDATE 语句 WHERE 仅 id=?，缺 AND invalid_at IS NOT NULL 守卫；未对 draft/不存在 id 抛错"
    missing:
      - "restoreExperience 加状态守卫：SELECT 当前 status/invalid_at；draft 抛错（须走 confirmDrafts）；invalid_at IS NULL 抛错（无需恢复）；UPDATE WHERE 加 AND invalid_at IS NOT NULL"
      - "experienceService.browse.test.ts 补「draft 调 restore 抛错」+「有效经验调 restore 抛错」用例"
  - truth: "BROWSE-02 严重度筛选保证历史数据可筛（与 rowToExperience fallback 读语义一致）"
    status: partial
    reason: "listExperiences severity 直筛 WHERE e.severity = ? 只覆盖明文列；历史数据（severity 列 NULL + attrs.severity 有值）fallback 在 rowToExperience 读层生效，但 WHERE 筛不到 → 用户看一条经验显「高」但筛「高」查不到。新数据双写后命中（10-01 create/update 已双写），缺陷仅影响 v10 迁移前的历史 troubleshooting 经验。UI 无提示。属数据完整性不一致（read vs filter），非 goal 阻塞，但与 CONTEXT D-10-2「保证历史数据可查」承诺存在张力。"
    artifacts:
      - path: "electron/services/experienceService.ts"
        issue: "L283-286 severity 直筛；fallback 仅在 L208-213 rowToExperience 读层；筛/读不对称"
    missing:
      - "post-MK 启动钩子一次性回填历史 severity（解密 attrs_enc → 取 severity → UPDATE 明文列），治本"
      - "或 severity 筛选器旁加 UI 兜底提示「仅含已回填 severity 数据，历史经验需先编辑保存」"
human_verification:
  - test: "实机验证经验 Tab UI 全链路（Tabs 切换/筛选 bar 8 元素/关联设备列 N 台全局渲染/三能力按状态切换/详情 Modal 元数据/Phase 9 不回归）"
    expected: "KnowledgeBasePage Tabs（文档|经验）切换正常；经验 Tab 列表展示 published/invalid（draft 不显示）；筛选 bar 设备/标签 mode multiple 多选生效；关联设备列 device_count>0 显「N 台」、0 显「全局」灰 Tag；行操作按状态切换（有效显编辑/标失效/删除，失效显编辑/恢复有效/删除）；Popconfirm 软/硬文案与 UI-SPEC copy contract 逐字一致；详情 Modal（width 900）元数据齐全 + 「查看原始会话」叠层 SessionMessagesModal；severity Tag 语义色（critical=red/high=volcano/...）；Phase 9 ReviewConfirmModal 链路不回归"
    why_human: "10-03 Task 4 checkpoint:human-verify SUMMARY 称用户 approved「信任门禁收尾跳过实机」，但 verifier 不能代行人工实机决策；UI 交互、视觉色板、Popconfirm 文案视觉、Tab 切换流畅度均需肉眼确认。"
---

# Phase 10: Experience Browse Page Verification Report

**Phase Goal:** 用户可在知识库的「经验」板块独立浏览、筛选、搜索、手动维护经验，并不只依赖 AI 总结——经验资产可被人工主动管理（新增/编辑/标失效）。
**Verified:** 2026-08-05T22:00:00Z
**Status:** gaps_found（goal 达成 + 2 个 known issues 待人工决策是否作为 BLOCKER 闭环）
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths（roadmap Success Criteria + PLAN must_haves 合并）

| #   | Truth (SC) | Status | Evidence |
| --- | ---------- | ------ | -------- |
| 1   | SC1: 知识库页顶部新增「经验」Tab，切换后展示经验列表（与「文档」并列，非独立一级菜单） | ✓ VERIFIED | KnowledgeBasePage.tsx L380-483 `<Tabs defaultActiveKey="docs" items=[{key:'docs',label:'文档',...},{key:'exp',label:'经验',children: expTabLoaded ? <ExperienceTab/> : null}]`；L122 expTabLoaded state 懒加载；L7 import ExperienceTab |
| 2   | SC2: 用户可按分类/标签/关联设备/严重度/有效期/状态多维筛选 + 关键词搜索 | ✓ VERIFIED（含 CR-02 已知限制） | ExperienceTab.tsx 筛选 bar 8 元素锁定（新增经验/搜索 240 防抖/分类/严重度/状态/设备 mode multiple/标签 mode multiple/显示已失效 Switch L411-466）；调 `window.api.experience.list` 传 deviceId string[]（L135）；service listExperiences search/severity/tags/category/status 参数化 + deviceId 多选 IN 占位（experienceService.ts L266-292, L308-319） |
| 3   | SC3: 用户可在该页手动新增/编辑经验（字段与 AI 起草走同一模板） | ✓ VERIFIED | ExperienceEditForm.tsx 公共组件（279 行）字段复刻 ReviewConfirmEditForm（标题/分类/内容/标签 mode tags/troubleshooting attrs 五字段/关联设备 mode multiple）；validateDraft 单一来源（仅 ExperienceEditForm.tsx L59 export，ReviewConfirmModal.tsx L13 import + L14 re-export）；新增态直 status:'published'（L162-170）；编辑态 update 白名单（L158-160）；Phase 9 改 import 复用零回归（ReviewConfirmEditForm supersedeOld + 查看原始会话 5 处保留） |
| 4   | SC4: 用户可标记失效（invalid_at），失效后从默认视图剔除但仍可查可恢复 | ✓ VERIFIED（CR-01 安全防线缺失记入 gaps） | ExperienceTab.tsx 行操作三能力按状态切换（handleInvalidate L225-233 / handleRestore L234-243 / handleDelete L244-253）；invalidate 软 Popconfirm（L382）/ restore 轻量无 Popconfirm（L237）/ delete 硬 Popconfirm danger（L392）；service restoreExperience 落地（experienceService.ts L421-427 清 invalid_at + status 回 published）；IPC experience:restore secure 包装（experienceIpc.ts L82-83） |
| 5   | SC5: 经验详情页展示来源会话回链/关联设备/复用次数/最后验证时间等元数据 | ✓ VERIFIED | ExperienceDetailModal.tsx（235 行）width 900 footer null（L97/L117）；元数据行（来源会话截短 + 「查看原始会话」叠层 SessionMessagesModal L140 / 关联设备 listDevices L85 / 复用次数 / 最后验证 / 有效期 / 创建/更新时间）；正文 pre-wrap（L177）；troubleshooting attrs 模板块（症状/根因/解决/预防 L194-206）；severity 语义色（volcano L36） |

**Score:** 5/5 truths VERIFIED（roadmap Success Criteria 全部达成）

### PLAN must_haves 逐条验证（10-01/10-02/10-03）

**10-01（数据/服务/IPC 基线）— 全 VERIFIED：**
- v10 severity 列迁移幂等（migrations.ts L275 hasColumn 守卫 + L276 ALTER + L278 user_version=10 + L16 MIGRATION_HEAD=10 + L293 注册表）✓
- init.ts fresh-install DDL 含 severity TEXT（L306）✓ 两路径一致
- listExperiences opts 扩 search/severity/tags + deviceId string|string[] IN 占位（experienceService.ts L275-292, L299-301）✓ 参数化（无字符串拼接用户输入）
- 两分支 rowsSql 都带 device_count 子查询（deviceCountSub 共享常量 L304 注入 L313/L332）✓ 零 N+1
- createExperience status? 默认 draft + severity 列双写（L220, L231-237）✓
- updateExperience severity 双写（L373-384，attrs/category 跨边界重算）✓
- rowToExperience severity fallback（L208-213，明文列 NULL 读 attrs.severity）✓
- restoreExperience 受控接口落地（L421-427）✓（缺守卫 = CR-01）
- IPC experience:restore secure + preload + electron.d.ts 三向一致（experienceIpc.ts L82 / preload.ts L131 / electron.d.ts L209 channel 名逐字相等）✓
- Experience DTO 加 severity + device_count；ExperienceListInput 扩 deviceId string|string[]（src/types/experience.ts）✓
- 9 vitest 用例覆盖 fallback/device_count/多选 OR-join（experienceService.browse.test.ts，191/191 全绿）✓

**10-02（公共表单组件）— 全 VERIFIED：**
- ExperienceEditForm.tsx 存在并导出 ExperienceEditForm + validateDraft（L59）✓
- 字段结构复刻 ReviewConfirmEditForm（去 Phase 9 专属 UI supersedeOld/查看原始会话 grep=0 in ExperienceEditForm）✓
- 实时质量门 + disabled={errs.length>0}（L144, L155）✓
- 手动新增直 published（L162-170）；编辑态走 update 白名单（L158-160）✓
- footer 文案「保存」✓
- ReviewConfirmModal 改 import 复用 validateDraft 单一来源（L13-14，本地定义已删）✓
- ReviewConfirmEditForm supersedeOld + 查看原始会话 5 处保留（Phase 9 专属 UI 不丢）✓

**10-03（UI 层）— 全 VERIFIED（人工实机 checkpoint 见 human_verification）：**
- Tabs 改造（文档 | 经验）默认文档 + 懒加载（KnowledgeBasePage.tsx）✓
- ExperienceTab 筛选 bar 8 元素锁定顺序含设备/标签 mode multiple（L446/L455）✓
- Table 9 列含第 5 列「N 台/全局」用 record.device_count 渲染（L309-315）✓
- 行操作三能力按状态切换 + Popconfirm 软硬区分 ✓
- draft 前端 filter 兜底（L137 r.status !== 'draft'）✓
- ExperienceDetailModal width 900 footer null + 元数据 + SessionMessagesModal 叠层（L4 import）✓
- 全 copy 中文锁定（新增经验/搜索经验标题或正文/显示已失效/将彻底删除经验/失效后将从默认视图剔除/已标记为失效/已恢复为有效/加载经验列表失败/暂无经验）✓

### Required Artifacts（Three Levels + Data-Flow）

| Artifact | Expected | Exists | Substantive | Wired | Data Flows | Status |
| -------- | -------- | ------ | ----------- | ----- | ---------- | ------ |
| `electron/database/migrations.ts` | v10 severity 迁移 | ✓ | hasColumn + transaction + user_version=10 + 注册表 | — | — | ✓ VERIFIED |
| `electron/database/init.ts` | fresh DDL 含 severity TEXT | ✓ | L306 | — | — | ✓ VERIFIED |
| `electron/services/experienceService.ts` | restore + listExperiences opts + device_count + create status? + severity 双写 + fallback | ✓ (588 行) | restore L421/listExperiences L254-342/create L220/update L355 | IPC 调用 | service→DB 真查询 | ✓ VERIFIED |
| `electron/ipc/experienceIpc.ts` | experience:restore secure channel | ✓ | L82-83 secure 包装 | service+preload | — | ✓ VERIFIED |
| `electron/preload.ts` | experience.restore 暴露 | ✓ | L131 | IPC invoke | — | ✓ VERIFIED |
| `src/types/experience.ts` | ExperienceListInput 扩 + Experience 加 severity/device_count | ✓ | search/severity/tags/deviceId string\|string[]/severity/device_count | renderer 消费 | — | ✓ VERIFIED |
| `src/types/electron.d.ts` | restore 签名 | ✓ | L209 restore: (id)=>Promise<Experience> | preload 对齐 | — | ✓ VERIFIED |
| `electron/services/__tests__/experienceService.browse.test.ts` | fallback + device_count + 多选用例 | ✓ (9 用例) | severity fallback/device_count/deviceId OR-join | — | — | ✓ VERIFIED（缺 draft→restore 抛错用例，记入 CR-01 gap） |
| `src/components/knowledge/ExperienceEditForm.tsx` | 公共表单 + validateDraft 单一来源 | ✓ (279 行) | 字段完整 + validateDraft L59 + status published L169 | ExperienceTab import L25 | form state→onSubmit 真数据 | ✓ VERIFIED |
| `src/components/knowledge/ExperienceTab.tsx` | 经验 Tab 主组件 | ✓ (555 行) | 筛选 bar + Table 9 列 + 行操作 + Modal 编排 | KnowledgeBasePage Tabs + window.api.experience.* | IPC list→Table dataSource 真数据 | ✓ FLOWING |
| `src/components/knowledge/ExperienceDetailModal.tsx` | 详情 Modal width 900 | ✓ (235 行) | 元数据 + attrs 模板 + SessionMessagesModal | ExperienceTab L500 | listDevices 真数据 | ✓ FLOWING |
| `src/components/pages/KnowledgeBasePage.tsx` | Tabs 容器改造 | ✓ (574 行) | L380-483 Tabs docs/exp + 懒加载 | ExperienceTab L7 | — | ✓ VERIFIED |
| `src/components/pages/ai/ReviewConfirmModal.tsx` | 改 import validateDraft | ✓ | L13 import + L14 re-export（本地定义已删） | ExperienceEditForm | — | ✓ VERIFIED |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| experienceIpc.ts | experienceService.restoreExperience | ipcMain.handle secure | ✓ WIRED | L82-83 secure 包装 + L18 import |
| preload.ts | experience:restore channel | ipcRenderer.invoke | ✓ WIRED | L131 |
| experienceService.listExperiences | experiences.severity + exp_device_rel device_count | WHERE/子查询 SQL | ✓ WIRED | L283-285 severity 直筛 + L304 deviceCountSub 注入两分支 |
| ExperienceTab.tsx | window.api.experience.list | loadExperiences useEffect | ✓ WIRED | L135 调用 + L137 setList |
| ExperienceTab.tsx | ExperienceEditForm | import + Modal 包裹 | ✓ WIRED | L25 import + L493 使用 |
| ExperienceTab.tsx | ExperienceDetailModal | openDetail state | ✓ WIRED | L26 import + L500 使用 |
| KnowledgeBasePage.tsx | ExperienceTab | Tabs exp pane | ✓ WIRED | L7 import + L483 children |
| ExperienceDetailModal.tsx | SessionMessagesModal | 查看原始会话叠层 | ✓ WIRED | L4 import + L140 触发 |
| ReviewConfirmModal.tsx | ExperienceEditForm#validateDraft | import 单一来源 | ✓ WIRED | L13 import + L14 re-export |
| ExperienceEditForm.tsx | window.api.experience.create (status published) | onSubmit 新增态 | ✓ WIRED | L162-170 input 含 status:'published' |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| ExperienceTab Table | list | window.api.experience.list | service listExperiences 真 SQL 查 experiences 表 | ✓ FLOWING |
| ExperienceTab 关联设备列 | record.device_count | service 子查询 | SELECT COUNT(*) FROM exp_device_rel 真计数 | ✓ FLOWING |
| ExperienceDetailModal 关联设备 | devices | window.api.experience.listDevices | listDevicesByExperience 真 device_id 查询 + getDeviceById | ✓ FLOWING |
| ExperienceEditForm 编辑态预填 | relateDevices | window.api.experience.listDevices | 真查询已关联设备 | ✓ FLOWING |

无 HOLLOW / STATIC / DISCONNECTED。

### Behavioral Spot-Checks（三绿门禁复跑）

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| tsc strict + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 | ✓ PASS |
| vite build | `npx vite build` | exit 0（vendor-antd chunk 1.1MB，仅 chunk size 警告非错误） | ✓ PASS |
| electron-main esbuild | `npm run build:electron-main` | exit 0（dist-electron/main.js 1.9mb） | ✓ PASS |
| vitest run 全量 | `npx vitest run` | 15 files / 191 tests 全 PASS（2.49s） | ✓ PASS |
| validateDraft 单一来源 | `grep -rn "export function validateDraft" src/` | 仅 ExperienceEditForm.tsx:59（ReviewConfirmModal 改 import re-export） | ✓ PASS |
| IPC 三向一致 | grep experience:restore in ipc/preload/d.ts | 三处各 1 命中 | ✓ PASS |

SUMMARY claimed 的 191/191 与实际一致，零回归。

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| BROWSE-01 | 10-03 | 知识库页新增「经验」Tab，展示经验列表 | ✓ SATISFIED | KnowledgeBasePage Tabs（文档\|经验）+ ExperienceTab 列表 |
| BROWSE-02 | 10-01 + 10-03 | 按分类/标签/关联设备/严重度/有效期/状态多维筛选 + 关键词搜索 | ✓ SATISFIED（CR-02 已知限制：历史 severity 列 NULL 数据筛不到） | service listExperiences 全维度参数化 + ExperienceTab 筛选 bar 8 元素 + 搜索防抖 |
| BROWSE-03 | 10-02 + 10-03 | 用户可手动新增/编辑经验 | ✓ SATISFIED | ExperienceEditForm 公共组件 + 新增直 published + 编辑走 update 白名单 + 关联设备 diff |
| BROWSE-04 | 10-01 + 10-03 | 用户可将经验标记为失效（invalid_at） | ✓ SATISFIED（CR-01 安全防线缺失记入 gaps） | invalidate/restore/delete 三能力 + 软/硬 Popconfirm 区分 + restore 受控接口 |

无 ORPHANED 需求（REQUIREMENTS.md Phase 10 映射 4 条 = PLAN claimed 4 条）。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| experienceService.ts | 421-427 | restoreExperience UPDATE 无状态守卫 | 🛑 BLOCKER（CR-01，安全不变量破坏） | renderer 调 experience:restore 传 draft id → draft 强转 published，绕 confirmDrafts 红线③ |
| experienceService.ts | 283-286 | severity 直筛漏 attrs.severity fallback 历史数据 | 🛑 BLOCKER（CR-02，数据完整性不一致） | 历史经验显「高」但筛「高」查不到；read 与 filter 不对称 |
| experienceService.ts | 288-292 | tags LIKE 通配符未转义 + 含 `"` 匹配失败 | ⚠️ WARNING（WR-01） | tag=`100%` 模式错配；语义正确性破坏（非注入） |
| ExperienceTab.tsx | 177-191 | syncRelateDevices Promise.all 非原子 | ⚠️ WARNING（WR-02） | 部分失败留半成品关联；与 Phase 9 confirmDrafts 单事务不一致 |
| ExperienceTab.tsx | 205 | relateDevices.length >= 0 永真条件 | ⚠️ WARNING（WR-03） | 可读性陷阱；编辑态每次触发 syncRelateDevices |
| ExperienceTab.tsx | 121-155 | loadExperiences 无请求竞态保护 | ⚠️ WARNING（WR-04） | 快速切筛选可能显示过期列表 |
| ExperienceDetailModal.tsx / ExperienceTab.tsx | 42-46/79-82 | formatTs 对 ISO 时间戳显示异常 | ⚠️ WARNING（WR-05） | 未来混入 ISO 时间戳会显字面 `T` |
| experienceIpc.ts | 62-63 | severity/tags/search IPC 入参缺枚举/长度校验 | ⚠️ WARNING（WR-06） | untrusted renderer 可发起廉价 DoS（超长 search LIKE） |

无 TBD/FIXME/XXX 等 unreferenced 债务 marker。9 WARNING + 4 INFO 见 10-REVIEW.md。

### BLOCKER Verdict

**CR-01（restoreExperience 缺状态守卫）：影响红线③不变量，不阻塞 phase goal。**
- 红线③「AI 产出必先进 draft 人工确认才 published」（CLAUDE.md/PROJECT.md + Phase 9）是项目级 CLAUDE.md 约束。`restoreExperience` 是受控接口，但实现对所有 id（含 draft）生效，破坏不变量。
- **但是**：phase goal「用户独立浏览/筛选/搜索/手动维护经验」+ 5 SC + 4 BROWSE 均未要求 draft→published 转换；CONTEXT 明确「draft 不进浏览页」（draft 属 Phase 9 范围）。UI 正常流程不会触发（行操作按状态切换，draft 不在 list）。
- 滥用路径需 renderer 主动绕过 UI 调 IPC（单机桌面工具威胁模型有限，但 IPC 面是 untrusted 边界）。
- **Verdict**：是 known security defense gap，非 phase goal blocker。**强烈建议下个 phase 修复**（守卫 + 测试用例），但 phase 10 goal 已达成。记入 gaps 待人工决策：作为 BLOCKER 阻塞 phase complete，还是作为 known issue（带 follow-up issue 编号）放行。

**CR-02（severity 筛选漏历史 fallback 数据）：数据完整性不一致，不阻塞 phase goal。**
- BROWSE-02「按...严重度...多维筛选」字面达成（severity 筛选对新数据有效）。
- 缺陷仅影响 v10 迁移前已存在的 troubleshooting 经验（severity 列 NULL，attrs.severity 有值）。规模取决于 Phase 7-9 既有 troubleshooting 经验数量。
- CONTEXT D-10-2 承诺「保证历史数据可查」——读层 fallback 落地（可查），但筛层不一致（筛不到）。
- **Verdict**：是 known data completeness gap，非 phase goal blocker（BROWSE-02 字面满足）。**建议**：post-MK 启动钩子一次性回填历史 severity（治本）或 UI 兜底提示。记入 gaps 待人工决策。

**总结**：两 BLOCKER 均非 phase goal 阻塞（5 SC + 4 BROWSE 全达成），但均代表质量/安全防线缺失。按 verifier 对抗性原则（缺守卫 + 缺测试 = 不可审计的完成度），status 设为 `gaps_found`，由人工决策是否：
- (A) 接受为 known issues（加 VERIFICATION.md overrides + 开 follow-up issue 编号 DEF-*，转 passed with warnings）；或
- (B) 触发 `/gsd:plan-phase --gaps` 修复（restore 守卫 + 测试 + severity 回填）后再 close phase。

### Human Verification Required

#### 1. 经验 Tab UI 全链路实机验证

**Test:** 启动 `npm run dev`，登录后进入「知识库」，按 10-03 Task 4 `<how-to-verify>` 10 步骤验证：Tabs 切换 / draft 不进浏览页 / 关联设备列「N 台/全局」渲染 / 设备 Select 多选 / 三能力按钮按状态切换 / 详情 Modal 元数据完整 / severity Tag 语义色 / 状态 Tag 绿灰 / Phase 9 ReviewConfirmModal 链路不回归
**Expected:** UI-SPEC §1-6 全落实；用户 approved
**Why human:** 10-03 Task 4 是 checkpoint:human-verify（blocking gate）。SUMMARY 称「用户 approved 信任门禁收尾跳过实机」——但 verifier 不能代行人工实机决策；UI 视觉/交互/Popconfirm 文案视觉/Tab 流畅度需肉眼确认；SUMMARY 的 approved 声明不构成证据。

### Gaps Summary

Phase 10 goal **已达成**：5/5 roadmap Success Criteria + 4/4 BROWSE 需求 全 VERIFIED；13 artifacts 全 VERIFIED（exist/substantive/wired/data-flowing）；10 key links 全 WIRED；三绿门禁 191/191 全绿（与 SUMMARY claimed 一致，零回归）；UI-SPEC §1-6 锁定渲染全落实。

**但** 2 个 BLOCKER 级代码缺陷需闭环（源自 10-REVIEW.md）：
1. **CR-01** restoreExperience 缺状态守卫 → 破坏红线③不变量（draft 可经 IPC 直 published，绕 confirmDrafts）。修法明确（守卫 + 抛错 + 测试用例）。
2. **CR-02** severity 筛选漏历史 fallback 数据 → 数据完整性不一致（read vs filter 不对称）。修法两选一（post-MK 回填治本 / UI 兜底提示）。

两 BLOCKER 均非 phase goal 阻塞（不影响 5 SC + 4 BROWSE 字面达成），但按 verifier 对抗性原则（安全不变量破坏 + 数据完整性缺陷不可静默放行），status 设为 `gaps_found`，frontmatter `gaps` 列出结构化条目，供 `/gsd:plan-phase --gaps` 消费；或人工加 overrides + follow-up issue（DEF-*）转 passed with warnings。

另有 1 个人工实机 checkpoint（10-03 Task 4）需肉眼验证 UI 全链路（SUMMARY 的 approved 声明不构成 verifier 证据）。

---

_Verified: 2026-08-05T22:00:00Z_
_Verifier: Claude (gsd-verifier)_
