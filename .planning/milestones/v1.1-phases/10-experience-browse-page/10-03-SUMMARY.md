---
phase: 10-experience-browse-page
plan: 03
subsystem: ui
tags: [renderer, react, antd, table, modal, tabs, crud]

# Dependency graph
requires:
  - phase: 10-experience-browse-page (Plan 01)
    provides: listExperiences opts 扩 search/severity/tags + deviceId 多选 IN 占位 OR-join + device_count 子查询零 N+1 + createExperience status? 默认 draft + restoreExperience 受控接口 + experience:restore IPC secure + Experience DTO 加 severity/device_count
  - phase: 10-experience-browse-page (Plan 02)
    provides: ExperienceEditForm 公共编辑/新增表单组件 + validateDraft 单一来源（troubleshooting severity/symptoms/resolution 标红 + ExperienceInput DTO 扩 status?）
  - phase: 09-human-review-confirmation (Plan 03)
    provides: SessionMessagesModal 既有组件（详情 Modal 叠层复用）+ ReviewConfirmModal 经验链路（不回归基线）
provides:
  - KnowledgeBasePage Tabs 容器（文档 | 经验），默认 Tab=文档，经验 Tab 懒加载 ExperienceTab
  - ExperienceTab 经验浏览页主组件（筛选 bar 8 元素含设备多选 + Table 9 列含第 5 列「N 台/全局」渲染 + 行操作三能力 + 新增/编辑/详情 Modal 编排）
  - ExperienceDetailModal 只读详情 Modal（width 900 footer null + 元数据行 + troubleshooting attrs 模板块 + 复用 SessionMessagesModal 叠层 + severity 语义色 Tag）
  - BROWSE-01/02/03/04 UI 层落地（手动 CRUD + 多维筛选 + 三能力 + 详情）
affects: [11-ai-retrieval-reuse（Phase 11 检索复用经验库浏览页同基础数据契约）, future-browse-ux（二期经验可视化/图遍历复用 ExperienceTab 数据加载范式）]

# Tech tracking
tech-stack:
  added: []  # 无新依赖，纯 renderer 层消费现有 AntD 6 + React 19 + window.api.experience.* 契约
  patterns:
    - "Tabs 懒加载模式（expTabLoaded state + onChange 切到 exp 才挂载 ExperienceTab，避免默认 Tab 文档时无谓加载经验列表）"
    - "Table 第 5 列锁定渲染范式（record.device_count > 0 显「N 台」/ 0 显「全局」灰 Tag，零 N+1，子查询数据来自 service）"
    - "筛选 bar 锁定 8 元素顺序（新增 primary → 搜索 → 分类 → 严重度 → 状态 → 设备多选 → 标签多选 → 显示已失效 Switch）"
    - "draft 前端 filter 兜底（dataSource 前置 filter status !== 'draft'，draft 是 Phase 9 待确认草稿不进浏览页，最简不改 service）"
    - "Modal 编排模式（编辑/新增 Modal width 640 footer null + ExperienceEditForm 公共组件；详情 Modal width 900 footer null + 元数据 + 叠层 SessionMessagesModal）"
    - "行操作按状态切换（有效显「标失效」/ 失效显「恢复有效」，restore 轻量无 Popconfirm / invalidate 软 Popconfirm / delete 硬 Popconfirm danger）"

key-files:
  created:
    - src/components/knowledge/ExperienceDetailModal.tsx  # 只读详情 Modal（235 行，width 900 + 元数据 + attrs 模板 + SessionMessagesModal 叠层）
    - src/components/knowledge/ExperienceTab.tsx  # 经验 Tab 主组件（471 行，筛选 bar + Table 9 列 + 行操作 + Modal 编排）
  modified:
    - src/components/pages/KnowledgeBasePage.tsx  # 顶部包 Tabs（文档 | 经验），现有两 Card 移入 docs pane，经验 pane 懒加载
    - src/components/knowledge/ExperienceEditForm.tsx  # onSubmit 扩第二参 relateDevices（解决 10-02 遗留，调用方 diff 同步）

key-decisions:
  - "[Phase 10]: 10-03 Tabs 懒加载 ExperienceTab（expTabLoaded state + onChange 触发首次挂载）—— 默认 Tab=文档时不无谓调 experience.list 加载经验列表，UI 响应快；首次切到经验才挂载子组件触发 useEffect→loadExperiences"
  - "[Phase 10]: 10-03 关联设备列第 5 列锁定渲染用 record.device_count 直读（device_count > 0 显「N 台」/ 0 或 undefined 显「全局」灰 Tag）—— 数据来自 10-01 listExperiences 子查询（零 N+1），render 内不调 listDevices，详情 Modal 单条点开才调 listDevices 显完整设备名列表（T-10-15 mitigate）"
  - "[Phase 10]: 10-03 draft 前端 filter 兜底（dataSource 前置 r.status !== 'draft'）—— draft 是 Phase 9 待确认草稿专属（不进浏览页），前端 filter 最简且不改 service（T-10-16 mitigate）；UI-SPEC §1 / CONTEXT D-10-3 明确语义"
  - "[Phase 10]: 10-03 设备 Select 锁定 mode=\"multiple\"（UI-SPEC §3，禁止改单选）—— 多选 string[] 经 IPC 透传到 service listExperiences IN 占位 OR-join 参数化（10-01 落地 T-10-01），renderer 不拼接 SQL 无注入面（T-10-18 mitigate）"
  - "[Phase 10]: 10-03 行操作按状态切换（有效显「编辑/标失效/删除」/ 失效显「编辑/恢复有效/删除」）—— restore 受控接口只清 invalid_at+status 回 published（10-01 落地 T-10-12 mitigate），不开放任意字段修改；invalidate 软 Popconfirm（不可恢复只物理删除）/ delete 硬 Popconfirm danger（title「确认删除」+ description「不可恢复」+ danger 按钮强提示，T-10-11 mitigate）"
  - "[Phase 10]: 10-03 详情 Modal footer={null} + 底部 Space 触发 onEdit/onInvalidate/onRestore/onDelete 回调（由调用方 ExperienceTab 传入后关闭详情 Modal 并打开对应 Modal/Popconfirm）—— 单一职责：详情 Modal 只读展示，操作流转回 ExperienceTab 编排"
  - "[Phase 10]: 10-03 ExperienceEditForm.onSubmit 扩第二参 relateDevices 解决 10-02 遗留 —— 10-02 抽出公共组件时 onSubmit 仅 (values)，但 09-03 既有调用方需传 relateDevices 触发设备关联 diff；本 plan Task 2 扩 onSubmit 为 (values, relateDevices?) + 调用方 diff 同步，10-02 遗留彻底解决"

patterns-established:
  - "Tabs 懒加载：const [loaded, setLoaded] = useState(false) + Tabs onChange key==='exp' 时 setLoaded(true) + children 改 {loaded ? <Child/> : null}（避免默认 Tab 无谓挂载子组件触发其 useEffect 加载远程数据）"
  - "Table 列锁定渲染范式：列 render 内用 record.{子查询字段} 直读 + 三元渲染（>0 显 N / 0 显 fallback Tag），零 N+1，完整列表/详情在点开 Modal 时单条调 IPC；pageSize 20 + service limit 100 + MAX_BATCH=1000 三层兜底"
  - "前端 filter 兜底（不改 service）：dataSource={list.filter(r => r.status !== 'draft')}，针对 UI 边界语义（draft 不进浏览页）的最简方案，与 service 层 includeInvalid 参数互补（service 管 invalid 前端管 draft）"

requirements-completed: [BROWSE-01, BROWSE-02, BROWSE-03, BROWSE-04]

# Metrics
duration: ~14min
completed: 2026-08-05
---

# Phase 10 Plan 03: Experience Browse Page UI Summary

**KnowledgeBasePage 改造为 Tabs（文档 | 经验）+ ExperienceTab 列表/多维筛选/手动 CRUD/三能力/详情 Modal 严格遵循 UI-SPEC §2/§3 锁定渲染（设备多选 Select + 关联设备列「N 台/全局」+ draft 前端过滤兜底），消费 10-01 service/IPC 与 10-02 ExperienceEditForm 公共组件。**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-08-05
- **Completed:** 2026-08-05
- **Tasks:** 4（3 auto + 1 checkpoint:human-verify resolved approved）
- **Files modified:** 4（2 新建 + 2 改造）

## Accomplishments

- **BROWSE-01 落地**：KnowledgeBasePage 顶部包 AntD Tabs（文档 | 经验），默认 Tab=文档，经验 Tab 懒加载 ExperienceTab（expTabLoaded state + onChange 首次切到 exp 才挂载，避免默认 Tab 无谓加载经验列表）。现有「资料库」+「检索测试」两 Card 整体移入 docs pane 内部逻辑零改动。
- **BROWSE-02 落地**：ExperienceTab 筛选 bar 8 元素锁定顺序（新增经验 primary → 搜索 240 防抖 300ms → 分类 120 → 严重度 120 → 状态 120 → 设备 160 **mode multiple** → 标签 160 **mode multiple** → 显示已失效 Switch）+ Table 9 列锁定顺序（标题蓝字点详情 / 分类 Tag blue / 严重度 Tag 语义色 / 标签 / **关联设备「N 台/全局」用 record.device_count 渲染** / 状态 Tag 绿灰 / 有效期 / 最后验证 / 操作）。设备 Select 多选 string[] 经 IPC 透传 service IN 占位 OR-join 参数化（T-10-18）。
- **BROWSE-03 落地**：手动新增/编辑走 ExperienceEditForm 公共组件（10-02 抽出），新增态 editingExp=null → createExperience({...fields, status: 'published'}）（红线③ 例外，人工录入非 AI 产出）；编辑态预填 → updateExperience(id, fields)（CR-01 白名单不含 status）；Modal width 640 footer null。
- **BROWSE-04 落地**：标失效/恢复/物理删除三能力按状态切换。有效显「编辑/标失效/删除」，失效显「编辑/恢复有效/删除」。invalidate 软 Popconfirm（description「失效后将从默认视图剔除，但仍可查/可恢复，不会物理删除。」）/ restore 轻量无 Popconfirm（受控接口只清 invalid_at+status 回 published）/ delete 硬 Popconfirm danger（description「将彻底删除经验『{title}』，操作不可恢复。」）。T-10-11/T-10-12 mitigate。
- **详情 Modal（SC5）落地**：ExperienceDetailModal width 900 footer null + 顶部 Space（标题 strong + 状态 Tag 绿灰 + 分类 Tag blue + severity Tag 语义色 troubleshooting 类显）+ 元数据行（来源会话截短 + 「查看原始会话」叠层 SessionMessagesModal / 关联设备名逗号分隔 listDevices 拉 / 复用次数 reuse_count / 最后验证 / 有效期 valid_at~invalid_at / 创建/更新时间）+ 正文 pre-wrap maxHeight 400 + troubleshooting attrs 模板块（症状/根本原因/解决办法/预防措施）+ 底部 Space 触发 onEdit/onInvalidate/onRestore/onDelete 回调。
- **10-02 relateDevices 遗留彻底解决**：ExperienceEditForm.onSubmit 扩第二参 relateDevices，调用方 diff 同步（Task 2 顺带 fix，10-02 抽公共组件时 onSubmit 仅 (values) 与 09-03 既有调用方需传 relateDevices 不匹配，本 plan Task 2 扩签名解决）。
- **三绿门禁全绿零回归**：tsc -p tsconfig.web.json --noEmit exit 0 / vite build exit 0 / build:electron-main exit 0 / vitest run 191/191 全 PASS（Phase 7-10 累计测试无回归）。
- **人工 checkpoint approved**：三绿门禁全绿 + UI-SPEC 关键渲染 grep 验证全命中（device_count×5 / 全局×2 / mode multiple×2 / draft filter×2 / Tabs defaultActiveKey docs / ExperienceTab import / SessionMessagesModal×3 / width 900×2），用户 approved 信任门禁收尾跳过实机。

## Task Commits

Each task was committed atomically:

1. **Task 1: 创建 ExperienceDetailModal（只读详情，width 900 + 元数据 + 复用 SessionMessagesModal）** - `23ad8a5` (feat)
2. **Task 2: 创建 ExperienceTab（筛选 bar 含设备多选 + Table 9 列含关联设备 N 台渲染 + 行操作三能力 + 新增/编辑/详情 Modal 编排）+ ExperienceEditForm onSubmit 扩 relateDevices** - `e2f4be8` (feat)
3. **Task 3: KnowledgeBasePage 改造为 Tabs 容器（文档 | 经验）** - `b525dcd` (feat)
4. **Task 4: checkpoint:human-verify** - RESOLVED approved（无代码改动，三绿门禁全绿 + UI-SPEC grep 验证通过，用户信任门禁收尾跳过实机）

**Plan metadata:** `<本 commit>` (docs: complete UI layer plan + record checkpoint approval)

## Files Created/Modified

- `src/components/knowledge/ExperienceDetailModal.tsx`（新, 235 行）—— 只读详情 Modal，width 900 footer null + 元数据行（来源会话回链 SessionMessagesModal 叠层 / 关联设备 listDevices / 复用次数 / 最后验证 / 有效期 / 创建/更新时间）+ 正文 pre-wrap maxHeight 400 + troubleshooting attrs 模板块（症状/根因/解决/预防）+ 底部 Space 触发 onEdit/onInvalidate/onRestore/onDelete 回调 + severity 语义色 Tag（critical=red/high=volcano/medium=orange/low=gold/info=blue）。
- `src/components/knowledge/ExperienceTab.tsx`（新, 471 行）—— 经验 Tab 主组件，筛选 bar 8 元素锁定顺序（新增 primary + 搜索防抖 + 分类/严重度/状态 Select + 设备/标签 mode multiple + 显示已失效 Switch）+ Table 9 列锁定顺序（含第 5 列「N 台/全局」用 record.device_count 渲染 + status Tag 绿灰 + severity 语义色）+ 行操作三能力按状态切换（编辑/标失效 or 恢复有效/删除 Popconfirm 软硬区分）+ 新增/编辑/详情 Modal 编排（width 640/640/900 footer null）+ draft 前端 filter 兜底 + 全 copy 中文锁定。
- `src/components/pages/KnowledgeBasePage.tsx`（改）—— 顶部包 AntD Tabs（defaultActiveKey="docs" items=[{key:'docs', label:'文档', children: 现有两 Card}, {key:'exp', label:'经验', children: expTabLoaded ? <ExperienceTab/> : null}]），onChange 切到 exp 首次 setExpTabLoaded(true) 懒加载。现有文档库功能零回归（资料库 Card + 检索测试 Card 内部逻辑不动）。
- `src/components/knowledge/ExperienceEditForm.tsx`（改）—— onSubmit 签名扩第二参 relateDevices?: string[]（解决 10-02 抽公共组件遗留，调用方 09-03 diff 同步）。

## Decisions Made

详见 frontmatter `key-decisions`。核心 6 条：

1. **Tabs 懒加载**（expTabLoaded state 避免默认 Tab 文档时无谓加载经验列表，UI 响应快）
2. **关联设备列用 record.device_count 直读**（数据来自 10-01 子查询零 N+1，render 内不调 listDevices，T-10-15 mitigate）
3. **draft 前端 filter 兜底**（dataSource={list.filter(r => r.status !== 'draft')}，draft 是 Phase 9 待确认草稿专属，前端 filter 最简不改 service，T-10-16 mitigate）
4. **设备 Select 锁定 mode multiple**（UI-SPEC §3 禁止改单选，多选 string[] 经 IPC 透传 service IN 占位 OR-join 参数化，T-10-18 mitigate）
5. **行操作按状态切换**（有效显标失效/失效显恢复有效，restore 受控接口只清 invalid_at+status 回 published 不开放任意字段修改，T-10-12 mitigate；delete 硬 Popconfirm danger 强提示不可恢复，T-10-11 mitigate）
6. **ExperienceEditForm.onSubmit 扩 relateDevices**（解决 10-02 抽公共组件遗留，09-03 调用方需传 relateDevices 触发设备关联 diff）

## Deviations from Plan

None - plan executed exactly as written.

唯一增量工作（非偏差，是 plan 隐含必要）：Task 2 顺带扩 ExperienceEditForm.onSubmit 第二参 relateDevices 解决 10-02 遗留——本就是 plan Task 2 消费 ExperienceEditForm 的必要前提（不扩则新增/编辑无法触发设备关联 diff），属 Rule 3 自动修复 blocking issue，已记录于 key-decisions 第 6 条与 Files Modified，无独立 commit（合并进 Task 2 e2f4be8）。

## Issues Encountered

None - 三绿门禁一次全绿（tsc + vite build + build:electron-main + vitest 191/191），UI-SPEC 锁定渲染 grep 验证全命中，Phase 7-9 既有功能零回归。

## User Setup Required

None - 本 plan 纯 renderer 层 UI，无外部服务/环境变量/配置。用户运行 `npm run dev` 启动应用后即可使用知识库页 Tabs（文档 | 经验）切换浏览经验。

## Known Stubs

None - 全部数据流已接通真实 IPC（window.api.experience.{list/create/update/delete/invalidate/restore/listDevices/getSessionMessages} 10-01 + Phase 9 已落地），无 mock/placeholder 数据。详情 Modal 关联设备名经 listDevices 实时拉取（无关联显「全局」灰 Tag）。

## UI-SPEC 锁定渲染落地清单

| UI-SPEC 维度 | 落地位置 | 验证（grep） |
|--------------|----------|--------------|
| §1 Tabs 改造（文档 \| 经验，默认文档） | KnowledgeBasePage.tsx defaultActiveKey="docs" + items docs/exp | defaultActiveKey×1, import ExperienceTab×1 ✓ |
| §2 Table 9 列锁定顺序 | ExperienceTab.tsx columns（标题 a / 分类 Tag / 严重度 Tag / 标签 / 关联设备 N 台全局 / 状态 / 有效期 / 最后验证 / 操作） | dataIndex 列对象 ≥8 + 操作列无 dataIndex ✓ |
| §2 第 5 列关联设备「N 台/全局」 | ExperienceTab.tsx render 用 record.device_count（>0 显「N 台」/ 0 显 `<Tag>全局</Tag>` 灰） | device_count×5, 全局×2, 台×≥1 ✓ |
| §3 筛选 bar 设备 Select mode multiple | ExperienceTab.tsx `<Select mode="multiple">`（设备 + 标签都多选） | mode="multiple"×2 ✓ |
| §3 筛选 bar 8 元素锁定顺序 | ExperienceTab.tsx Space wrap（新增 primary → 搜索 → 分类 → 严重度 → 状态 → 设备多选 → 标签多选 → Switch） | 新增经验×1, 搜索经验标题或正文×1, 显示已失效×1 ✓ |
| §4 Modal 尺寸（编辑 640 / 详情 900） | ExperienceTab.tsx 编辑 Modal width 640 / ExperienceDetailModal.tsx width 900 | width={900}×2, width={640}×≥1 ✓ |
| §Color severity 语义色 | ExperienceDetailModal.tsx + ExperienceTab.tsx severity Tag（critical=red/high=volcano/medium=orange/low=gold/info=blue） | volcano×≥1 ✓ |
| §Color 状态 Tag（有效=绿/失效=灰不染红） | ExperienceDetailModal.tsx + ExperienceTab.tsx（有效=success「有效」/ 失效=default「已失效」） | success/default Tag ✓ |
| §2 行操作三能力（编辑/标失效 or 恢复/删除） | ExperienceTab.tsx 按状态切换 + Popconfirm 软硬区分 | experience.{invalidate,restore,delete,create}×≥1 each, 将彻底删除经验×1, 失效后将从默认视图剔除×1, 已标记为失效×1, 已恢复为有效×1 ✓ |
| §6 详情 Modal 元数据 | ExperienceDetailModal.tsx 元数据行（来源会话回链 + 关联设备 listDevices + 复用次数 + 最后验证 + 有效期 + 创建/更新时间） | SessionMessagesModal×3, 查看原始会话×1, 经验详情×≥1, window.api.experience.listDevices×≥1 ✓ |
| 红线③ copy（footer「保存」无「确认入库」措辞） | ExperienceEditForm footer Button（10-02 已落，本 plan 不动） | grep 确认入库/发布并待审=0 ✓ |
| draft 不进浏览页（D-10-3） | ExperienceTab.tsx dataSource 前端 filter `r.status !== 'draft'` | status !== 'draft'×2 ✓ |
| Phase 9 不回归 | SessionMessagesModal 复用（不重写）+ vitest 191/191 全绿 | SessionMessagesModal import 路径 '../pages/ai/SessionMessagesModal' + vitest 全绿 ✓ |
| 10-02 relateDevices 遗留解决 | ExperienceEditForm.onSubmit 扩第二参 + ExperienceTab handleSubmitEdit 同步传 relateDevices | onSubmit 第二参 ✓ |

## Self-Check: PASSED

**Files created/modified 存在性验证：**
- `src/components/knowledge/ExperienceDetailModal.tsx` — FOUND（235 行，width 900 + SessionMessagesModal×3）
- `src/components/knowledge/ExperienceTab.tsx` — FOUND（471 行，device_count×5 + mode multiple×2 + 全局×2）
- `src/components/pages/KnowledgeBasePage.tsx` — FOUND（defaultActiveKey docs + import ExperienceTab）
- `src/components/knowledge/ExperienceEditForm.tsx` — FOUND（onSubmit 扩 relateDevices）

**Task commits 存在性验证：**
- `23ad8a5` — FOUND（feat(10-03): 创建 ExperienceDetailModal 只读详情 Modal）
- `e2f4be8` — FOUND（feat(10-03): 创建 ExperienceTab 列表+多维筛选+手动 CRUD+三能力）
- `b525dcd` — FOUND（feat(10-03): KnowledgeBasePage 改造为 Tabs 容器（文档 | 经验））

**三绿门禁状态：** tsc + vite build + build:electron-main + vitest 191/191 全绿（前序 executor 已 pass，本 continuation 复检 UI-SPEC grep 全命中，无重跑必要）。

**人工 checkpoint：** Task 4 checkpoint:human-verify RESOLVED approved（用户信任门禁收尾——三绿门禁全绿 + UI-SPEC 关键渲染 grep 验证通过，跳过实机）。
