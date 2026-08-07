---
phase: 10-experience-browse-page
verified: 2026-08-06T10:30:00Z
status: passed
score: 5/5 must-haves verified (truths) + 5/5 gap 闭环 + 4/4 requirements SATISFIED
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 5/5 truths verified（2 known issues 待人工决策）
  gaps_closed:
    - "CR-01 restoreExperience 双层守卫（service 层 SELECT status/invalid_at 检查 + SQL WHERE invalid_at IS NOT NULL + draft/有效/不存在 抛错 + 4 vitest 用例）"
    - "CR-02 backfillSeverityFromHistory 幂等回填（severity IS NULL 守卫 + main.ts post-MK 调用 + 2 vitest 用例）"
    - "问题 2 状态 Select 联动 includeInvalid（onChange setIncludeInvalid + service invalidOnly 路径）"
    - "问题 1a ExperienceEditForm 设备 filter 放开（删除 ssh/telnet filter，候选含全类型）"
    - "WR-01 tags ESCAPE 转义 + WR-02 setExperienceDevices 单事务原子 + WR-05 formatTs ISO 兼容"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "实机验证经验 Tab UI 全链路（含 gap 修复后回归：状态 Select 选「已失效」联动 Switch + 筛失效 + 设备候选含全类型 + 时间格式无字面 T）"
    expected: "Tabs 切换正常；状态 Select 选「已失效」自动开启「显示已失效」Switch 且列表只显失效经验；选「有效」关闭 Switch 且只显有效；关联设备 Select 候选含 ssh/telnet/web/rdp 全类型；详情 Modal 时间字段无字面 T；其余 18 项 UAT 不回归（详见 10-UAT.md）"
    why_human: "UAT 测试 6/8/10/18（状态联动 / 设备候选 / 时间格式）需肉眼确认 UI 视觉与交互；SUMMARY 的 approved 声明不构成 verifier 证据。前次 verification 已留此 checkpoint，gap closure 后需复测确认修复落地且未引入新 UI 回归。"
follow_ups:
  - id: FU-1b
    item: "ai 助手聊天设备范围扩展（非 ssh/telnet 设备可勾选聊天+查资料库，仅不连接）"
    severity: enhancement
    source: "10-UAT.md 问题 1b / 10-04-PLAN.md out_of_scope_followups"
    blocks_phase: false
  - id: FU-3
    item: "标签输入复用已有标签（Select mode='tags' 传 options 聚合已有标签供下拉复用）"
    severity: enhancement
    source: "10-UAT.md 问题 3 / 10-04-PLAN.md out_of_scope_followups"
    blocks_phase: false
  - id: FU-WR-04
    item: "loadExperiences 请求竞态保护（AbortController 或 reqId 守卫）"
    severity: warning
    source: "10-REVIEW.md WR-04"
    blocks_phase: false
  - id: FU-WR-06
    item: "IPC 入参 severity/tags/search 枚举与长度校验"
    severity: warning
    source: "10-REVIEW.md WR-06"
    blocks_phase: false
  - id: FU-WR-07
    item: "isValid/isInvalid 抽公共 util（service/DetailModal/Tab 三方漂移）"
    severity: warning
    source: "10-REVIEW.md WR-07"
    blocks_phase: false
  - id: FU-WR-08
    item: "experienceService.browse.test.ts 与 experienceService.test.ts 共享 MemDb mock（抽 __mocks__/memDb.ts）"
    severity: warning
    source: "10-REVIEW.md WR-08"
    blocks_phase: false
  - id: FU-WR-09
    item: "stripEncColumns 死代码删除（rowToDevice 白名单已保证无 _enc 列）"
    severity: info
    source: "10-REVIEW.md WR-09 / 10-04-PLAN.md out_of_scope_followups"
    blocks_phase: false
---

# Phase 10: Experience Browse Page Verification Report

**Phase Goal:** 用户可在知识库的「经验」板块独立浏览、筛选、搜索、手动维护经验，并不只依赖 AI 总结——经验资产可被人工主动管理（新增/编辑/标失效）。
**Verified:** 2026-08-06T10:30:00Z
**Status:** passed（gap closure 后最终验证：5/5 truths + 5/5 gaps + 4/4 requirements，四绿门禁 200/200 零回归）
**Re-verification:** Yes — after gap closure（前次 gaps_found → 本次 passed）

## Goal Achievement

### Observable Truths（roadmap Success Criteria + PLAN must_haves 合并）

| #   | Truth (SC) | Status | Evidence |
| --- | ---------- | ------ | -------- |
| 1   | SC1: 知识库页顶部新增「经验」Tab，切换后展示经验列表（与「文档」并列，非独立一级菜单） | ✓ VERIFIED | KnowledgeBasePage.tsx L7 import ExperienceTab + L381 `<Tabs defaultActiveKey="docs">` + L482 `label: '经验'` + L483 `children: expTabLoaded ? <ExperienceTab/> : null`（懒加载 L121 expTabLoaded state）；Tabs 顺序：文档 \| 经验 |
| 2   | SC2: 用户可按分类/标签/关联设备/严重度/有效期/状态多维筛选 + 关键词搜索 | ✓ VERIFIED（CR-02 闭环后筛层对称） | ExperienceTab.tsx 筛选 bar 8 元素锁定（新增经验/搜索 240 防抖/分类/严重度/状态/设备 mode multiple/标签 mode multiple/显示已失效 Switch L407-475）；service listExperiences 全维度参数化 + deviceId 多选 IN 占位（experienceService.ts L313-343）；**CR-02 post-MK 回填钩子使历史 severity 列可筛**（backfillSeverityFromHistory L471-493 + main.ts L111-116 调用） |
| 3   | SC3: 用户可在该页手动新增/编辑经验（字段与 AI 起草走同一模板） | ✓ VERIFIED | ExperienceEditForm.tsx（279 行）字段复刻 ReviewConfirmEditForm（标题/分类/内容/标签 mode tags/troubleshooting attrs 五字段/关联设备 mode multiple）；validateDraft 单一来源（grep 仅 ExperienceEditForm.tsx:59 一处 export，ReviewConfirmModal.tsx L13 import + L14 re-export）；新增态直 status:'published'（L162-170）；编辑态 update 白名单（L158-160） |
| 4   | SC4: 用户可标记失效（invalid_at），失效后从默认视图剔除但仍可查可恢复 | ✓ VERIFIED（CR-01 守卫闭环） | ExperienceTab.tsx 行操作三能力按状态切换（handleInvalidate L223-231 / handleRestore L233-241 / handleDelete L243-251）；invalidate 软 Popconfirm（L378-386）/ restore 轻量无 Popconfirm（L374）/ delete 硬 Popconfirm danger（L388-398）；service restoreExperience 双层守卫落地（experienceService.ts L440-456 SELECT status/invalid_at + draft/有效/不存在 抛错 + SQL WHERE invalid_at IS NOT NULL） |
| 5   | SC5: 经验详情页展示来源会话回链/关联设备/复用次数/最后验证时间等元数据 | ✓ VERIFIED（WR-05 formatTs ISO 兼容） | ExperienceDetailModal.tsx（235 行）width 900 footer null；元数据行（来源会话截短 + 「查看原始会话」叠层 SessionMessagesModal L140 / 关联设备 listDevices / 复用次数 / 最后验证 / 有效期 / 创建/更新时间）；formatTs ISO 兼容（L43-49 `new Date(ts.replace(' ', 'T'))` + pad 格式化，无字面 T） |

**Score:** 5/5 truths VERIFIED（roadmap Success Criteria 全部达成，无回归）

### Gap Closure 确认（5 项必修，对照实际代码非 SUMMARY）

| Gap | 必修理由 | 验证手段 | Status | Evidence（实读代码） |
| --- | -------- | -------- | ------ | ------------------- |
| **CR-01** restoreExperience 双层守卫 | 红线③ 不变量恢复（draft 不可经 IPC restore 直 published，绕 confirmDrafts） | service SELECT 守卫 + SQL WHERE + 4 vitest 用例 | ✓ CLOSED | experienceService.ts L440-456：`SELECT status, invalid_at` → 不存在 throw `经验不存在: ${id}` / draft throw `草稿不可经 restore 发布，请走 confirmDrafts 质量门` / 有效 throw `经验当前有效，无需恢复`；L453 UPDATE `WHERE id = ? AND invalid_at IS NOT NULL`（SQL 二次防御）；browse.test.ts L731 `describe('Phase 10 Plan 04 CR-01: restoreExperience 双层守卫')` + L740 `expect(() => restoreExperience(e.id)).toThrow(/草稿不可经 restore.*confirmDrafts/)`；vitest 200/200 PASS |
| **CR-02** backfillSeverityFromHistory 幂等回填 | D-10-2「保证历史数据可查」兑现到筛层（read/filter 对称） | post-MK 钩子 + severity IS NULL 守卫 + 2 vitest 用例 | ✓ CLOSED | experienceService.ts L471-493 `export function backfillSeverityFromHistory(): { backfilled: number }`：`SELECT id, attrs_enc, severity FROM experiences WHERE severity IS NULL AND attrs_enc IS NOT NULL` → `decField` → `JSON.parse` → VALID_SEVERITIES 校验 → UPDATE（单行失败 catch 跳过不阻塞全量）；main.ts L28 import + L111-116 post-MK post-migrate `try { const r = backfillSeverityFromHistory() ... } catch (e) { console.warn(...) }`（不阻塞启动）；browse.test.ts L759 `describe('Phase 10 Plan 04 CR-02: backfillSeverityFromHistory 幂等回填')` + L773 backfilled=2 + L778 再跑 backfilled=0（幂等） |
| **问题 2** 状态 Select 联动 includeInvalid + invalidOnly | UAT major bug（选「已失效」查不到失效经验） | onChange 联动 + service invalidOnly 路径 + tsc/build gate | ✓ CLOSED | ExperienceTab.tsx L445-449 状态 Select `onChange={(v) => { setStatus(v); if (v === 'invalid') setIncludeInvalid(true); else if (v === 'published') setIncludeInvalid(false) }}`（单向联动：Select 影响 Switch，Switch 不影响 Select）；L131-142 loadExperiences opts：`status: status === 'published' ? 'published' : undefined` + `invalidOnly: status === 'invalid' ? true : undefined` + `includeInvalid: status === 'published' ? false : status === 'invalid' ? true : includeInvalid`；experienceService.ts L139-142 ListExperiencesOpts 加 invalidOnly + L305-307 `WHERE e.invalid_at IS NOT NULL AND e.invalid_at <= datetime('now','localtime')`（筛 invalid_at<=now 非 status='invalid'） |
| **问题 1a** ExperienceEditForm 设备 filter 放开 | 设计意图对齐（手动 CRUD 关联设备应含全类型 SSH/Telnet/Web/RDP） | grep filter=0 + tsc/build gate | ✓ CLOSED | ExperienceEditForm.tsx L106-110 `useEffect(() => { window.api.device.list().then((all: Device[]) => setDevices(all.map((d) => ({ id: d.id, name: d.name })))) ... })`——**filter 已删除**，候选含全类型；L102-105 注释说明 T-10-08 mitigation 仅适用 AI 起草模块，手动 CRUD 不适用 + rowToDevice 白名单无密文泄露 + 关联≠连接（T-10-04-05 accept） |
| **WR-01** tags ESCAPE 转义 | 消除注入面 + 标签含 % / _ 字面值语义匹配正确 | ESCAPE 子句 + 转义 + 1 vitest 用例 | ✓ CLOSED | experienceService.ts L295-302：`const ors = opts.tags.map(() => "e.tags LIKE ? ESCAPE '\\\\'")` + `const esc = t.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')`（先反斜杠避免二次转义）+ `params.push('%"${esc}"%')`；browse.test.ts L800 `describe('Phase 10 Plan 04 WR-01: tags LIKE ESCAPE 转义')` + L524 测试支撑代码 ESCAPE 反转义 |
| **WR-02** setExperienceDevices 单事务原子 | IPC 三向一致 + renderer 单 IPC（部分失败不留半成品） | 单 transaction + IPC 三向 + 2 vitest 用例 | ✓ CLOSED | experienceService.ts L524-538 `export function setExperienceDevices(expId, expectIds)`：`if (expectIds.length > 100) throw`（批量上限）+ `conn.transaction(() => { ... toAdd relateDevice + toRemove unrelateDevice })`（throw ROLLBACK）；experienceIpc.ts L20 import + L95-96 `ipcMain.handle('experience:setDevices', secure(...))`；preload.ts L134 `setDevices:`；electron.d.ts L212 `setDevices:` 签名（三向一致，channel 名逐字相等）；ExperienceTab.tsx L186-188 `syncRelateDevices = async (expId, nextIds) => { await window.api.experience.setDevices(expId, nextIds) }`（单 IPC）；browse.test.ts L812 describe + L822 diff [A,B]→[B,C] + L838 throw 回滚 |
| **WR-05** formatTs 兼容 ISO | 时间格式鲁棒性（防未来 ISO 时间戳显字面 T） | ts.replace(' ', 'T') 两处 + tsc/build gate | ✓ CLOSED | ExperienceTab.tsx L81-87 + ExperienceDetailModal.tsx L43-49 两处 `formatTs` 改为 `const d = new Date(ts.replace(' ', 'T')); if (Number.isNaN(d.getTime())) return ts; const pad = ...; return ${YYYY-MM-DD HH:MM}`（兼容空格分隔 + ISO T 两种格式） |

**Score:** 5/5 gap CLOSED（CR-01 / CR-02 / 问题 2 / 问题 1a / WR-01+02+05 全部对照实际代码闭环）

### Required Artifacts（Three Levels + Data-Flow）

| Artifact | Expected | Exists | Substantive | Wired | Data Flows | Status |
| -------- | -------- | ------ | ----------- | ----- | ---------- | ------ |
| `electron/database/migrations.ts` | v10 severity 迁移 | ✓ | hasColumn 守卫 + transaction + user_version=10 + 注册表 | — | — | ✓ VERIFIED |
| `electron/database/init.ts` | fresh DDL 含 severity TEXT | ✓ | L306 | — | — | ✓ VERIFIED |
| `electron/services/experienceService.ts` | restore 守卫 + backfill + setDevices + tags ESCAPE + listExperiences opts | ✓ (694 行) | restore L440-456 / backfill L471-493 / setDevices L524-538 / tags ESCAPE L295-302 / invalidOnly L305-307 | IPC 调用 | service→DB 真查询 | ✓ VERIFIED |
| `electron/main.ts` | post-MK backfill 钩子 | ✓ | L28 import + L111-116 try/catch 调用（不阻塞启动） | service import | — | ✓ VERIFIED |
| `electron/ipc/experienceIpc.ts` | experience:restore + experience:setDevices secure | ✓ | L84 restore secure + L95-96 setDevices secure | service+preload | — | ✓ VERIFIED |
| `electron/preload.ts` | restore + setDevices 暴露 | ✓ | L131 restore + L134 setDevices | IPC invoke | — | ✓ VERIFIED |
| `src/types/experience.ts` | ExperienceListInput 扩 + invalidOnly | ✓ | search/severity/tags/deviceId/includeInvalid/invalidOnly L62 | renderer 消费 | — | ✓ VERIFIED |
| `src/types/electron.d.ts` | restore + setDevices 签名 | ✓ | L209 restore + L212 setDevices | preload 对齐 | — | ✓ VERIFIED |
| `electron/services/__tests__/experienceService.browse.test.ts` | CR-01/CR-02/WR-01/WR-02 用例（9 新） | ✓ | L731 CR-01 / L759 CR-02 / L800 WR-01 / L812 WR-02 | — | — | ✓ VERIFIED |
| `src/components/knowledge/ExperienceEditForm.tsx` | 公共表单 + validateDraft + 全类型设备候选 | ✓ (279 行) | validateDraft L59 + 新增 published L169 + 设备 filter 删 L106-110 | ExperienceTab import L25 | form state→onSubmit 真数据 | ✓ VERIFIED |
| `src/components/knowledge/ExperienceTab.tsx` | 经验 Tab + 状态联动 + 单 IPC sync + formatTs ISO | ✓ (563 行) | 状态 Select 联动 L445-449 + invalidOnly L131-142 + setDevices L186-188 + formatTs L81-87 | KnowledgeBasePage Tabs + window.api.experience.* | IPC list→Table dataSource 真数据 | ✓ FLOWING |
| `src/components/knowledge/ExperienceDetailModal.tsx` | 详情 Modal width 900 + formatTs ISO | ✓ (235 行) | 元数据 + attrs 模板 + SessionMessagesModal + formatTs L43-49 | ExperienceTab import | listDevices 真数据 | ✓ FLOWING |
| `src/components/pages/KnowledgeBasePage.tsx` | Tabs 容器（文档\|经验） | ✓ (574 行) | L381 defaultActiveKey="docs" + L482 经验 label + L483 懒加载 | ExperienceTab L7 | — | ✓ VERIFIED |
| `src/components/pages/ai/ReviewConfirmModal.tsx` | 改 import validateDraft | ✓ | L13 import + L14 re-export（本地定义已删） | ExperienceEditForm | — | ✓ VERIFIED |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| experienceIpc.ts | experienceService.restoreExperience / setExperienceDevices / backfillSeverityFromHistory | ipcMain.handle secure | ✓ WIRED | L84 restore + L95-96 setDevices secure 包装；backfill 经 main.ts L111 调用（非 IPC） |
| preload.ts | experience:restore / experience:setDevices channel | ipcRenderer.invoke | ✓ WIRED | L131 restore + L134 setDevices |
| electron.d.ts | restore / setDevices 签名 | 类型契约 | ✓ WIRED | L209 restore + L212 setDevices（与 preload 逐字相等） |
| main.ts | backfillSeverityFromHistory | post-MK 调用 | ✓ WIRED | L28 import + L111-116 调用（migrateAndSecure 之后） |
| experienceService.listExperiences | experiences.severity + exp_device_rel device_count + invalid_at | WHERE/子查询 SQL | ✓ WIRED | L287-289 severity 直筛 + L305-307 invalidOnly + L319 deviceCountSub 注入两分支 |
| ExperienceTab.tsx | window.api.experience.list / setDevices | loadExperiences + syncRelateDevices | ✓ WIRED | L143 list 调用 + L145 setList；L186-188 setDevices 单 IPC |
| ExperienceTab.tsx | ExperienceEditForm / ExperienceDetailModal | import + Modal 编排 | ✓ WIRED | L24-25 import + L500 / L507 使用 |
| KnowledgeBasePage.tsx | ExperienceTab | Tabs exp pane | ✓ WIRED | L7 import + L483 children |
| ExperienceDetailModal.tsx | SessionMessagesModal | 查看原始会话叠层 | ✓ WIRED | L4 import + L140 触发 |
| ReviewConfirmModal.tsx | ExperienceEditForm#validateDraft | import 单一来源 | ✓ WIRED | L13 import + L14 re-export |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| ExperienceTab Table | list | window.api.experience.list | service listExperiences 真 SQL 查 experiences 表 | ✓ FLOWING |
| ExperienceTab 关联设备列 | record.device_count | service 子查询 | SELECT COUNT(*) FROM exp_device_rel 真计数 | ✓ FLOWING |
| ExperienceDetailModal 关联设备 | devices | window.api.experience.listDevices | listDevicesByExperience 真 device_id 查询 + getDeviceById | ✓ FLOWING |
| ExperienceEditForm 编辑态预填 | relateDevices | window.api.experience.listDevices | 真查询已关联设备 | ✓ FLOWING |
| ExperienceEditForm 设备候选 | devices | window.api.device.list | 真查询全类型设备（filter 已删） | ✓ FLOWING |

无 HOLLOW / STATIC / DISCONNECTED。

### Behavioral Spot-Checks（gap closure 后四绿门禁复跑）

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| tsc strict + noUnusedLocals | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 | ✓ PASS |
| vite build | `npx vite build` | exit 0（vendor-antd 1.1MB chunk size 警告非错误） | ✓ PASS |
| electron-main esbuild | `npm run build:electron-main` | exit 0（dist-electron/main.js 1.9mb，native 外部化） | ✓ PASS |
| vitest run 全量 | `npx vitest run` | exit 0，15 files / **200 测试全 PASS**（2.17s） | ✓ PASS |
| validateDraft 单一来源 | `grep -rn "export function validateDraft" src/` | 仅 ExperienceEditForm.tsx:59（ReviewConfirmModal 改 import re-export） | ✓ PASS |
| IPC 三向一致（restore + setDevices） | grep experience:restore / experience:setDevices in ipc/preload/d.ts | restore 三处各 1 + setDevices 三处各 1 | ✓ PASS |
| Phase 9 不回归 | KnowledgeBasePage Tabs 文档\|经验 + ReviewConfirmModal import validateDraft | L381 defaultActiveKey="docs" + L482 经验 label + RCM L13 import 单一来源 | ✓ PASS |

vitest 200 测试 = 191 既有 + 9 新增（CR-01 4 + CR-02 2 + WR-01 1 + WR-02 2），零回归。

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| BROWSE-01 | 10-03 | 知识库页新增「经验」Tab，展示经验列表 | ✓ SATISFIED | KnowledgeBasePage Tabs（文档\|经验）+ ExperienceTab 列表（L7 import + L483 children） |
| BROWSE-02 | 10-01 + 10-03 + 10-04 | 按分类/标签/关联设备/严重度/有效期/状态多维筛选 + 关键词搜索 | ✓ SATISFIED（CR-02 闭环后筛层完全对称） | service listExperiences 全维度参数化 + ExperienceTab 筛选 bar 8 元素 + 搜索防抖 + **CR-02 post-MK 回填钩子使历史 severity 列可筛** |
| BROWSE-03 | 10-02 + 10-03 + 10-04 | 用户可手动新增/编辑经验 | ✓ SATISFIED | ExperienceEditForm 公共组件 + 新增直 published + 编辑走 update 白名单 + **WR-02 setExperienceDevices 单事务原子 diff + 问题 1a 全类型设备候选** |
| BROWSE-04 | 10-01 + 10-03 + 10-04 | 用户可将经验标记为失效（invalid_at） | ✓ SATISFIED（CR-01 守卫闭环后安全不变量恢复） | invalidate/restore/delete 三能力 + 软/硬 Popconfirm 区分 + **CR-01 restore 双层守卫（draft/有效/不存在 抛错）+ 问题 2 状态 Select 联动 invalidOnly 路径** |

REQUIREMENTS.md Phase 10 映射 4 条 = PLAN claimed 4 条，无 ORPHANED。

### Anti-Patterns Found（gap closure 后复扫）

| File | Line | Pattern | Severity | Impact | 闭环状态 |
| ---- | ---- | ------- | -------- | ------ | -------- |
| ~~experienceService.ts restoreExperience UPDATE 无守卫~~ | ~~421-427~~ | ~~BLOCKER~~ | — | — | ✓ CR-01 已闭环（L440-456 双层守卫 + 4 用例） |
| ~~experienceService.ts severity 直筛漏历史 fallback~~ | ~~283-286~~ | ~~BLOCKER~~ | — | — | ✓ CR-02 已闭环（backfillSeverityFromHistory L471-493 + main.ts L111 钩子） |
| ~~experienceService.ts tags LIKE 未转义~~ | ~~288-292~~ | ~~WARNING（WR-01）~~ | — | — | ✓ 已闭环（L295-302 ESCAPE + 转义） |
| ~~ExperienceTab.tsx syncRelateDevices Promise.all 非原子~~ | ~~177-191~~ | ~~WARNING（WR-02）~~ | — | — | ✓ 已闭环（L186-188 单 IPC setDevices） |
| ~~ExperienceTab.tsx relateDevices.length>=0 永真~~ | ~~205~~ | ~~WARNING（WR-03）~~ | — | — | ✓ 顺手清（L203 改 `if (relateDevices)`） |
| ExperienceTab.tsx loadExperiences 无请求竞态保护 | 121-155 | ⚠️ WARNING（WR-04） | renderer fast-switch filter 过期列表覆盖 | ℹ️ follow-up（FU-WR-04，不阻塞） |
| ~~ExperienceDetailModal.tsx / ExperienceTab.tsx formatTs 对 ISO 显示异常~~ | ~~42-46/79-82~~ | ~~WARNING（WR-05）~~ | — | — | ✓ 已闭环（L43-49 / L81-87 ts.replace + pad） |
| experienceIpc.ts severity/tags/search IPC 入参缺校验 | 62-63 | ⚠️ WARNING（WR-06） | untrusted renderer 廉价 DoS（超长 search LIKE） | ℹ️ follow-up（FU-WR-06，不阻塞） |
| isValid/isInvalid 三方漂移 | DetailModal/Tab | ⚠️ WARNING（WR-07） | service/DetailModal/Tab 重复定义 | ℹ️ follow-up（FU-WR-07，不阻塞） |
| MemDb mock 重复 | browse.test/test.ts | ⚠️ WARNING（WR-08） | 维护负担 | ℹ️ follow-up（FU-WR-08，不阻塞） |
| stripEncColumns 死代码 | experienceIpc.ts 50-58 | ℹ️ INFO（WR-09） | 冗余兜底 | ℹ️ follow-up（FU-WR-09，不阻塞） |

无 TBD/FIXME/XXX 等 unreferenced 债务 marker。2 原始 BLOCKER + 5 高优 WARNING（WR-01/02/03/05）全部闭环；剩 4 WARNING（WR-04/06/07/08）+ 1 INFO（WR-09）记入 follow-ups 不阻塞。

### Human Verification Required

#### 1. 经验 Tab UI 全链路实机验证（含 gap 修复后回归）

**Test:** 启动 `npm run dev`，登录后进入「知识库」，重点复测 gap 修复点：
- **问题 2 修复**：状态 Select 选「已失效」→ 自动开启「显示已失效」Switch + 列表只显失效经验；选「有效」→ 关闭 Switch + 只显有效；清空 Select → Switch 保持当前态可独立 toggle
- **问题 1a 修复**：手动新增/编辑 → 关联设备 Select 候选含 ssh/telnet/web/rdp 全类型设备（非仅 ssh/telnet）
- **WR-05 修复**：详情 Modal 时间字段（创建/更新/有效期/最后验证）显 `YYYY-MM-DD HH:MM` 格式，无字面 T
- **CR-01/CR-02 修复**（间接）：恢复有效按钮仅对失效经验可见（service 守卫已防 draft/有效 经验被 restore）；severity 筛选对历史 troubleshooting 经验有效（启动钩子已回填）
- 其余 18 项 UAT 不回归（详见 10-UAT.md）

**Expected:** UI-SPEC §1-6 全落实；问题 2 / 问题 1a / WR-05 三处修复肉眼可见生效；Phase 9 链路不回归
**Why human:** UAT 测试 6/8/10/18 是 UI 交互/视觉 checkpoint。SUMMARY 的 approved 声明不构成 verifier 证据；前次 verification 已留此 checkpoint，gap closure 后需复测确认修复落地且未引入新 UI 回归。verifier 已对照代码确认逻辑链与三绿门禁全绿，仅 UI 视觉/交互/时间格式肉眼层需人工拍板。

### Gaps Summary

Phase 10 goal **完全达成**（gap closure 后最终验证）：

- **5/5 roadmap Success Criteria** 全 VERIFIED（无回归）
- **4/4 BROWSE 需求** 全 SATISFIED（无 ORPHANED）
- **5/5 必修 gap** 全 CLOSED（CR-01 / CR-02 / 问题 2 / 问题 1a / WR-01+02+05，对照实际代码非 SUMMARY 声明）
- **13 artifacts** 全 VERIFIED（exist/substantive/wired/data-flowing）
- **10 key links** 全 WIRED（IPC 三向一致 + post-MK 钩子调用链）
- **四绿门禁** 全绿（tsc + vite build + build:electron-main + vitest 200/200，零回归）
- **threat_model** T-10-04-01~06 disposition 实际生效（CR-01/CR-02/WR-01/WR-02 mitigate + 问题 1a accept）

**Status: passed。**

剩余 follow-ups（问题 1b / 问题 3 / WR-04/06/07/08/09）明确 out_of_scope，记入 frontmatter `follow_ups`，不阻塞 phase complete——它们是 UX 增强 / 代码质量改进 / 死代码清理，非 phase goal 必修项，可纳入后续 phase 或独立 item 处理。

唯一遗留：1 个人工实机 checkpoint（10-03 Task 4 + gap 修复 UI 复测），需肉眼确认 UI 全链路（SUMMARY 的 approved 声明不构成 verifier 证据）。但 verifier 已对照代码逐条确认逻辑链 + 三绿门禁全绿 + 5 gap grep/测试断言全通过，UI 层仅余视觉/交互肉眼层未拍板，按 verifier 决策树（truths/artifacts/links 全绿 + 仅 human checkpoint）→ status `passed`（人工 checkpoint 不阻塞 phase complete，作为发布前 UAT 走查项移交）。

---

_Verified: 2026-08-06T10:30:00Z_
_Verifier: Claude (gsd-verifier)_
_Re-verification: Yes — after gap closure (previous gaps_found → this passed)_
