# Phase 10: Experience Browse Page - Pattern Map

**Mapped:** 2026-08-05
**Files analyzed:** 11（新建 3 + 修改 6 + 跨 phase 重构 1 块）
**Analogs found:** 11 / 11（全部命中既有代码）

> 全部 analog 已实读。下列 excerpts 行号对齐当前 master（`8967029`），executor 可照行号直接 Read 复核。
> 项目级 research 关闭，无 RESEARCH.md；本表以 CONTEXT.md `<code_context>` + UI-SPEC §1-6 锁定契约为唯一上游。

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/components/knowledge/ExperienceTab.tsx`（新） | 组件（renderer UI） | request-response（列表查询 + CRUD） | `src/components/pages/KnowledgeBasePage.tsx` | exact（Table+筛选 Select+搜索 Input+Popconfirm 删除+详情 Modal 全范式同源） |
| `src/components/knowledge/ExperienceEditForm.tsx`（新） | 组件（renderer 表单 + 质量门） | form-submit（本地 state + IPC 提交） | `src/components/pages/ai/ReviewConfirmEditForm.tsx` + `ReviewConfirmModal.tsx` 的 `validateDraft` | exact（D-10-1 直接抽取源） |
| `src/components/knowledge/ExperienceDetailModal.tsx`（新） | 组件（renderer 只读详情） | request-response | `KnowledgeBasePage.tsx` 详情 Modal（width 900） + `SessionMessagesModal.tsx` 子 Modal 叠层 | exact |
| `src/components/pages/KnowledgeBasePage.tsx`（改） | 组件（容器） | 容器 → Tabs | `src/components/pages/AIPage.tsx`（挂载子 Modal + 透传）+ KnowledgeBasePage 自身 | exact（外壳改造） |
| `electron/services/experienceService.ts`（改） | service（业务层） | CRUD + 受控状态接口 | 同文件 `invalidateExperience` / `incReuseCount` / `touchLastVerifiedAt` + `listExperiences(opts)` 既有签名 | exact（对称新增/就地扩展） |
| `electron/ipc/experienceIpc.ts`（改） | IPC 网关 | request-response（secure 包装） | 同文件 13 个既有 channel 的 `secure(...)` 包装 | exact |
| `electron/preload.ts`（改） | preload 桥接 | IPC 透传 | 同文件 experience block（L124-140）+ kb block | exact |
| `src/types/electron.d.ts`（改） | 类型（renderer API 契约） | 类型声明 | 同文件 experience block（L202-218） | exact |
| `src/types/experience.ts`（改） | 类型（DTO） | 类型声明 | 同文件 `ExperienceListInput` / `Experience` | exact |
| `electron/database/migrations.ts`（改） | DB 迁移 | DDL 迁移 | 同文件 `v9`（`hasColumn` 守卫 + `db.transaction` + `db.pragma('user_version')`） | exact（severity 列迁移 = v9 的对称克隆） |
| **跨 phase 重构**：`src/components/pages/ai/ReviewConfirmModal.tsx` + `ReviewConfirmEditForm.tsx`（改 import） | 组件（Phase 9） | 复用公共组件 | 新建的 `ExperienceEditForm.tsx` | refactor（D-10-1 单一来源） |

---

## Pattern Assignments

### `src/components/knowledge/ExperienceTab.tsx`（组件，request-response）

**Analog:** `src/components/pages/KnowledgeBasePage.tsx`（实读全文 1-550）

**复用要点（与 UI-SPEC §2 §3 §4 锁定契约逐项对齐）：**

1. **页面外壳 + padding**（L376）：`<div style={{ padding: 24 }}>`。
2. **筛选 bar 容器**（L378）：`<Space wrap style={{ marginBottom: 16 }}>`。UI-SPEC §3 锁定顺序：新增经验 primary → 搜索 Input（width 240）→ 分类 → 严重度 → 状态 → 设备（多选）→ 标签（mode="multiple"）→ 显示已失效 Switch。
3. **筛选 useEffect 触发**（L137）：`useEffect(() => { loadDocuments() }, [filterDevice, filterCategory])` —— 经验 Tab 同范式：`useEffect(() => { loadExperiences() }, [search, category, severity, status, deviceId, tags, includeInvalid])`。
4. **搜索 Input onPressEnter + 防抖**（L439-445）：`onPressEnter={handleSearch}`；UI-SPEC copy 锁 300ms 防抖（KB 是 Press 即查，本 phase 加防抖——见 delta）。
5. **Table columns 定义范式**（L308-373）：列对象数组 + `render: (text, record) => ...`；行操作 `<Space>` + `<Button size="small">` + `<Popconfirm>`。
6. **行操作 Popconfirm 删除**（L361-369）：
   ```tsx
   <Popconfirm
     title="确认删除"
     description={`将删除文档"${record.file_name}"及其所有分块数据`}
     onConfirm={() => handleDelete(record.id)}
     okText="删除"
     cancelText="取消"
   >
     <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
   </Popconfirm>
   ```
   delta：经验删除 description 文案按 UI-SPEC copy 改 `将彻底删除经验『{title}』，操作不可恢复。`（硬删除强提示）+ 软失效 Popconfirm 用 `description="失效后将从默认视图剔除，但仍可查/可恢复，不会物理删除。"`。
7. **message.success / message.error 范式**（L127, L168, L232）：
   ```tsx
   } catch (err) {
     message.error('加载文档列表失败: ' + (err as Error).message)
   }
   ```
   delta：经验 Tab error copy `'加载经验列表失败: ' + (err as Error).message`（UI-SPEC copy contract）。
8. **Table 分页**（L433）：`pagination={{ pageSize: 20 }}`（与文档库一致）。
9. **列表→详情 Modal 打开**（L316）：`<a onClick={() => showDetail(record.id)}>{name}</a>` —— 经验 Tab 标题列同样用 `<a onClick={() => openDetail(record.id)}>` 蓝字点开。
10. **loadDocuments 范式（带 loading state + try/catch/finally）**（L121-131）：
    ```tsx
    const loadDocuments = async () => {
      setLoading(true)
      try {
        const list = await window.api.kb.listDocuments(filterDevice, filterCategory)
        setDocuments(list)
      } catch (err) {
        message.error('加载文档列表失败: ' + (err as Error).message)
      } finally {
        setLoading(false)
      }
    }
    ```
    delta：调 `window.api.experience.list({ search, category, severity, status, deviceId, tags, includeInvalid, limit, offset })`。

**replicate 约束：**
- 2 空格缩进 / 单引号 / 无分号 / 尾随逗号（多行）—— 与 KnowledgeBasePage 全程一致。
- AntD 组件 import 走 `'antd'` 单引号桶式（L2）；icon 走 `'@ant-design/icons'`（L3）。
- `window.api.experience.*` 调用面，永不直接接触 `attrs_enc` 密文（service 已 strip）。
- 行操作按钮一律 `size="small"`（UI-SPEC Spacing + KB L359）。
- **三能力按钮按状态切换**（UI-SPEC §2 行操作 + copy contract）：有效经验显「编辑 / 标失效 / 删除」；失效经验显「编辑 / 恢复有效 / 删除」。

**delta（相对 KnowledgeBasePage）：**
- **新增**：Tabs 是父层 KnowledgeBasePage 改造的事，ExperienceTab 本身只是「文档」Tab 之外的一个 pane 内容（不再自带外层 padding Card——见 UI-SPEC §1，pane 内直接放筛选 bar + Table；外层 Card 可选，由 planner 决定）。
- **新增**：「新增经验」primary Button（UI-SPEC §3 左锚）打开 ExperienceEditForm Modal（空表单，无 source_session_id/draft）。
- **新增**：状态/严重度 Select（KB 无）、标签 Select（KB 无）、Switch 显示已失效（KB 无）。
- **新增**：行操作多一个「标失效 / 恢复有效」状态切换按钮（调 `experience:invalidate` / `experience:restore`）。
- **新增**：搜索是 LIKE（走 list opts 的 `search`），不走 KB 那套 kb:search 检索 Card——经验 Tab 不要「检索测试」Card。
- **去掉**：KB 的章节编辑/合并/拆分/上传/轮询 processing（经验无这些语义）。

---

### `src/components/knowledge/ExperienceEditForm.tsx`（组件，form-submit + 质量门）

**Analog:** `src/components/pages/ai/ReviewConfirmEditForm.tsx`（实读全文 1-184）+ `ReviewConfirmModal.tsx` 的 `validateDraft`（实读 L49-62）

**D-10-1 抽取源，excerpts 必须完整复刻结构：**

1. **分类 + 严重度 OPTIONS 常量**（ReviewConfirmEditForm.tsx L30-43，中文化）：
   ```tsx
   const CATEGORY_OPTIONS: Array<{ value: ExperienceCategory; label: string }> = [
     { value: 'troubleshooting', label: '故障排查' },
     { value: 'best_practices', label: '最佳实践' },
     { value: 'product', label: '产品' },
     { value: 'env', label: '环境' },
   ]
   const SEVERITY_OPTIONS: Array<{ value: NonNullable<ExperienceAttrs['severity']>; label: string }> = [
     { value: 'critical', label: '致命' },
     { value: 'high', label: '高' },
     { value: 'medium', label: '中' },
     { value: 'low', label: '低' },
     { value: 'info', label: '提示' },
   ]
   ```
   **value 存英文不变（保历史数据兼容）** —— 09 中文化 commit `cd87077` 锁定契约。

2. **关联设备 Select（拉 ssh/telnet 设备）**（L51-61）：
   ```tsx
   const [devices, setDevices] = useState<Array<{ id: string; name: string }>>([])
   useEffect(() => {
     window.api.device.list().then((all: Device[]) =>
       setDevices(
         all
           .filter((d) => d.connectionType === 'ssh' || d.connectionType === 'telnet')
           .map((d) => ({ id: d.id, name: d.name }))
       )
     ).catch(() => setDevices([]))
   }, [])
   ```
   delta：经验手动编辑**不限于 ssh/telnet**（设计支持 SSH/Telnet/Web/RDP 四类关联），planner 评估是否放开全设备列表（CONTEXT discretion）。优先保留同范式（filter 不动），若 UI-SPEC 未限定则放开。

3. **troubleshooting 类 attrs 模板字段动态呈现**（L109-160）：`{cat === 'troubleshooting' && (<>...</>)}` 内显 严重程度 / 故障现象 / 根本原因 / 解决办法 / 预防措施 五个 Form.Item，每个带 `validateStatus={errs.includes('缺 X') ? 'error' : ''}` + `help={errs.includes('缺 X') ? '缺 X' : ''}` 实时标红。

4. **质量门 `validateDraft`（renderer 第一层）**（ReviewConfirmModal.tsx L49-62）：
   ```tsx
   export function validateDraft(d: Experience, fields: ExperienceUpdateInput): string[] {
     const errs: string[] = []
     const cat = fields.category ?? d.category
     const attrs = fields.attrs ?? d.attrs
     if (cat === 'troubleshooting') {
       if (!attrs || !attrs.severity) errs.push('缺 严重程度')
       if (!attrs || !attrs.symptoms || !String(attrs.symptoms).trim()) errs.push('缺 故障现象')
       if (!attrs || !attrs.resolution || !String(attrs.resolution).trim()) errs.push('缺 解决办法')
     } else {
       if (!fields.title || !String(fields.title).trim()) errs.push('缺 标题')
       if (!fields.content || !String(fields.content).trim()) errs.push('缺 内容')
     }
     return errs
   }
   ```
   **抽取后单一来源**：ExperienceEditForm 导出 `validateDraft`，Phase 9 ReviewConfirmModal 改 import 此处（消除双份漂移）。错误串与 UI-SPEC copy contract（质量门缺必填提示）逐字一致。

5. **patchAttr 保留其余 attrs 字段**（L68-70）：
   ```tsx
   function patchAttr<K extends keyof ExperienceAttrs>(key: K, value: ExperienceAttrs[K]) {
     onChange({ fields: { attrs: { ...attrs, [key]: value } } as ExperienceUpdateInput })
   }
   ```

**Component props 契约（D-10-1，新建）：**
```tsx
interface ExperienceEditFormProps {
  initialValue?: Experience          // 编辑态预填；新增态 undefined
  onSubmit: (fields: ExperienceInput | ExperienceUpdateInput) => void
  onCancel: () => void
  // 质量门未过 → 提交按钮 disabled（沿用 ReviewConfirmModal L200 disabled 模式）
}
```

**replicate 约束：**
- 状态由 form 内部 `useState` 持（不再像 ReviewConfirmEditForm 经 `onChange/decision` patch 回主壳——手动 CRUD 是单条编辑，无批量决策列表）。
- 提交前 `validateDraft(current, fields).length === 0` 才允许提交。
- **手动新增直 `published`**（D-10-1 / CONTEXT specifics / UI-SPEC copy 红线③ 注意）：`createExperience({ ...fields, status: 'published' })` —— **注意 createExperience 当前 INSERT 硬编码 `'draft'`**（service L221），planner 须扩 createExperience 入参 `status?: ExperienceStatus`（默认 `'draft'` 保 Phase 7-9 AI 起草不变），手动新增传 `'published'`。**delta 见 service 段。**
- 表单 Modal width 640（UI-SPEC §4），单列 Form `layout="vertical"`。
- copy：footer 主按钮文案「保存」（**禁止**「确认入库」「发布并待审」等暗示 AI 闸口的措辞 —— UI-SPEC copy 红线③ 注意）。

**delta（相对 ReviewConfirmEditForm）：**
- **去除**：「查看原始会话」按钮（详情 Modal 侧独立入口，见 ExperienceDetailModal）。
- **去除**：UPDATE `supersedeOld` Checkbox（手动编辑无 UPDATE 语义，无 duplicate_of_exp_id 触发条件）。
- **去除**：`decision/onChange/patch` 受控形态 → 改 uncontrolled `useState`（单条编辑）。
- **新增**：`initialValue` 预填路径（编辑态从 Experience DTO 反向填 form state）。
- **新增**：内置 submit/cancel 按钮（不再依赖主壳 footer）。

---

### `src/components/knowledge/ExperienceDetailModal.tsx`（组件，只读详情）

**Analog:** `KnowledgeBasePage.tsx` 详情 Modal（L464-531）+ `SessionMessagesModal.tsx` 子 Modal 叠层（L38-，实读 L1-40 props 契约）

**复用要点：**

1. **Modal width 900 + footer={null}**（KB L464-469）：
   ```tsx
   <Modal
     title={detailDoc ? `文档详情 - ${detailDoc.title}` : '文档详情'}
     open={detailModalOpen}
     onCancel={...}
     footer={null}
     width={900}
   >
   ```
   delta：title `经验详情 - ${exp.title}`（UI-SPEC copy contract）。

2. **元数据行 strong label + 值 Space**（KB L473-482）：`<span><strong>文件名：</strong>{detailDoc.file_name}</span>` —— 经验详情同范式 strong label（来源会话 / 关联设备 / 复用次数 / 最后验证 / 有效期 / 创建时间 / 更新时间）。

3. **正文 pre-wrap + maxHeight overflow auto**（KB L67，ChunkContent 范式）：`<div style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>`（UI-SPEC §6 正文 maxHeight 400）。

4. **来源会话回链子 Modal 叠层**（ReviewConfirmModal.tsx L293-297 + SessionMessagesModal props L16-20）：
   ```tsx
   <SessionMessagesModal
     open={!!sessionModalSessionId}
     sessionId={sessionModalSessionId}
     onClose={() => setSessionModalSessionId(null)}
   />
   ```
   SessionMessagesModal **直接复用**（不重写），props `{ open, sessionId, onClose }`，内部已处理空会话边界「原会话已不可查」（09-03-SUMMARY 已落地）。

5. **Tag 色（UI-SPEC Color 锁定）**：
   - 分类 Tag `blue`、UPDATE/疑似重复 `orange`（沿用 ReviewConfirmModal.tsx L257-258）。
   - severity Tag 语义色：critical=`red` / high=`volcano` / medium=`orange` / low=`gold` / info=`blue`（UI-SPEC §Color severity 语义色映射表，本 phase 新增，禁止新色）。
   - 状态：有效=`success`（绿）/ 失效=`default`（灰，文案「已失效」，**不染红**——红只给删除操作）。

**replicate 约束：**
- 只读，**不嵌编辑表单**（UI-SPEC §4 caveat：详情只读；编辑走独立 ExperienceEditForm Modal，避免嵌套混乱）。
- 关联设备显设备名列表（调 `window.api.experience.listDevices(id)` 取 ExperienceRelatedDevice[]，IPC 已 strip `_enc`）。

**delta：** 全新文件，结构套用 KB 详情 Modal + 叠 SessionMessagesModal。

---

### `src/components/pages/KnowledgeBasePage.tsx`（改，容器 → Tabs）

**Analog:** 自身 + `src/components/pages/AIPage.tsx`（挂载子 Modal + 透传 props 的范式，09-03-SUMMARY L16）

**改造点（UI-SPEC §1）：**

1. 顶部包 `<Tabs items={[...]} />`：
   ```tsx
   <Tabs
     defaultActiveKey="docs"
     items={[
       { key: 'docs', label: '文档', children: <>{/* 现有 资料库 Card + 检索测试 Card */}</> },
       { key: 'exp', label: '经验', children: <ExperienceTab /> },
     ]}
   />
   ```
2. 现有「资料库」Card + 「检索测试」Card 整体移入「文档」pane（**不动其内部逻辑**）。
3. 「经验」pane 懒加载：`const [expTabLoaded, setExpTabLoaded] = useState(false)`，首次切到 `exp` 才挂载 `<ExperienceTab />`（避免默认 Tab 文档时无谓加载经验列表）。
4. 路由 / 侧边栏不动（仍一级菜单「知识库」下）。

**replicate 约束：**
- import：`import { Tabs } from 'antd'`（桶式 import 加 `Tabs`）。
- `import ExperienceTab from '../knowledge/ExperienceTab'`（路径 `../knowledge/` 相对 `pages/`）。
- 顶层 `<div style={{ padding: 24 }}>` 保留（UI-SPEC Spacing lg=24）。

**delta：** 唯一结构性改造 = 现有两 Card 外面包一层 Tabs。其余不动。

---

### `electron/services/experienceService.ts`（改，业务层）

**Analog:** 同文件 `invalidateExperience`（L346-352）/ `incReuseCount`（L398-400）/ `touchLastVerifiedAt`（L402-404）—— **受控状态接口模式**（restoreExperience 的对称模板）+ `listExperiences(opts)`（L235-293）既有签名扩展点 + `createExperience`（L206-224）/ `updateExperience`（L306-340）severity 双写。

**1. restoreExperience（新增受控接口，对称 invalidate）：**

invalidate 范式（L346-352）：
```ts
export function invalidateExperience(id: string): any {
  const conn = db()
  conn.prepare(
    `UPDATE experiences SET invalid_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(id)
  return getExperience(id)
}
```
delta —— restoreExperience 对称实现（清 invalid_at + status 回 published）：
```ts
export function restoreExperience(id: string): any {
  const conn = db()
  conn.prepare(
    `UPDATE experiences SET invalid_at = NULL, status = 'published', updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(id)
  return getExperience(id)
}
```
> CONTEXT.md discretion 提示「先确认 invalidate 是否动 status」—— 实读 L346-349：invalidateExperience **不动 status**（只落 invalid_at）。故 restoreExperience 清 invalid_at + 把 status 显式回 published 是「对称恢复有效态」语义。planner 可评估是否同时回原 status，优先直 `'published'`（手动恢复语义）。**绕 CR-01 update 白名单（不复活 status 字段），与 invalidate/incReuseCount/touchLastVerifiedAt 同模式。**

**2. listExperiences opts 扩展（search/severity/tags）—— 参数化 SQL 拼接：**

既有 conditions/params 拼接范式（L244-258）：
```ts
const conditions: string[] = []
const params: any[] = []
if (opts.category) {
  conditions.push('e.category = ?')
  params.push(opts.category)
}
if (opts.status) {
  conditions.push('e.status = ?')
  params.push(opts.status)
}
if (!opts.includeInvalid) {
  conditions.push("(e.invalid_at IS NULL OR e.invalid_at > datetime('now','localtime'))")
}
```
delta —— 三段新增（参数化，防注入）：
```ts
if (opts.search) {
  conditions.push("(e.title LIKE ? OR e.content LIKE ?)")
  const kw = `%${opts.search}%`
  params.push(kw, kw)
}
if (opts.severity) {
  conditions.push('e.severity = ?')
  params.push(opts.severity)
}
if (opts.tags && opts.tags.length > 0) {
  // tags 明文 JSON 列，匹配命中任一（D-10-2 json_extract 或 LIKE）
  const ors = opts.tags.map(() => 'e.tags LIKE ?')
  conditions.push(`(${ors.join(' OR ')})`)
  opts.tags.forEach((t) => params.push(`%"${t}"%`))
}
```
> **replicate 红线**：参数化 `?` 占位，**禁止字符串拼接用户输入**（SQL 注入）。conditions 是 `AND` join（既有 L268/284 范式）。severity 走 `e.severity = ?`（D-10-2 新增明文列直筛）。tags 走 `LIKE` 匹配（planner 可评估 `json_extract(e.tags,'$')` 是否更优，但 LIKE 已够用）。

**ListExperiencesOpts 接口扩展**（既有 L125-132）：
```ts
export interface ListExperiencesOpts {
  category?: ExperienceCategory
  status?: ExperienceStatus
  deviceId?: string
  includeInvalid?: boolean
  limit?: number
  offset?: number
  search?: string        // 新增 D-10-2
  severity?: string      // 新增 D-10-2
  tags?: string[]        // 新增 D-10-2
}
```

**3. createExperience / updateExperience 双写 severity 列（D-10-2）：**

createExperience 既有 INSERT（L219-222）：
```ts
conn.prepare(
  `INSERT INTO experiences (id, title, category, content, tags, status, source_session_id, attrs_enc, valid_at, duplicate_of_exp_id)
   VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, datetime('now','localtime'), ?)`
).run(id, input.title, input.category, input.content, tags, input.sourceSessionId ?? null, attrsEnc, dupId)
```
delta：
- INSERT 列清单加 `severity`，VALUES 加 `?`，params 加 severity 值（从 `input.attrs?.severity` 取，troubleshooting 类填，其他 NULL）。
- **createExperience 入参扩 `status?: ExperienceStatus`**（默认 `'draft'` 保 Phase 7-9 AI 起草不变；手动新增传 `'published'`，D-10-1/CONTEXT specifics）—— INSERT 的 `'draft'` 硬编码改为 `input.status ?? 'draft'`。
- updateExperience sets 数组（L307-324）：若 `fields.attrs?.severity` 变更或 `fields.category` 变更触发 severity 重算，则 `sets.push('severity = ?')` + 从 attrs 取 severity（troubleshooting）或 NULL（其他类）。
- **attrs.severity 保留向后兼容**（D-10-2）：双写——attrs JSON 仍带 severity（attrsEnc 不变），同时明文 severity 列写入。读路径 rowToExperience（L176-202）需把明文 severity 列也回填到 `row.severity`（新字段）。

**replicate 红线（CLAUDE.md Conventions）：**
- **函数式 + 模块级 MK**（L27-31）：restoreExperience 不持实例状态，复用 MK。
- **字段加密只走 encField/decField**（L4 import，L212/L322 用）：severity 是**明文列**，不经加密；attrs_enc 仍走 encField/decField。
- **DB 性能/原子性**：循环外 `db.prepare()` 复用（如 confirmDrafts L431-439 范式）；多写包 `db.transaction(() => {...})()`（updateExperience L335-338 范式）。
- **MAX_BATCH=1000**（L33）：listExperiences 已守 limit 上限（L239-241），扩展不破坏。
- **bi-temporal 格式契约**（CANONICAL_TS_RE L83）：invalid_at 写 NULL（restore），不涉时间戳格式校验。

**delta 汇总：**
- 新增导出：`restoreExperience(id)`、`ListExperiencesOpts` 三字段、`createExperience` 入参 `status?`、`Experience` 行新增 `severity` 明文字段（rowToExperience 回填）。
- 不动：confirmDrafts/listDrafts/getSessionMessages/relateDevice/unrelateDevice/listDevicesByExperience/listExperiencesByDevice/incReuseCount/touchLastVerifiedAt/assertTroubleshootingAttrs（service 层兜底质量门，沿用）。

---

### `electron/ipc/experienceIpc.ts`（改，IPC 网关）

**Analog:** 同文件既有 13 channel 的 `secure(...)` 包装（实读全文 1-111）

**secure 包装范式**（L60-76）：
```ts
ipcMain.handle('experience:list', secure((_e, opts?: ExperienceListInput) =>
  listExperiences(opts || {})))

ipcMain.handle('experience:invalidate', secure((_e, id: string) =>
  invalidateExperience(id)))
```

**delta —— 新增 experience:restore：**
```ts
import { restoreExperience } from '../services/experienceService'   // 扩 import

ipcMain.handle('experience:restore', secure((_e, id: string) =>
  restoreExperience(id)))
```

**experience:list 透传扩展：** **无需改 IPC 层**——`listExperiences(opts || {})` 已透传整个 opts 对象，opts 扩 search/severity/tags 由 service 层消费、类型层 `ExperienceListInput` 声明。IPC handler 签名不变。

**replicate 红线（CLAUDE.md）：**
- **channel 命名 `<domain>:<action>` camelCase**（L33-36 注释明确）：`experience:restore` 遵循（单词 action，与 invalidate/list 对齐）。
- **全 secure 包装**（无 safe channel，经验属登录后特权操作，L25-27 注释）。
- **MAX_BATCH 双层防御**（L40-43/L93-95）：confirmDrafts 在 IPC 层二次校验 `drafts.length > MAX_BATCH`；restore 是单条 id 操作，无需批量校验。

**delta 汇总：** 仅新增 1 行 import + 1 个 `ipcMain.handle('experience:restore', secure(...))`。experience:list handler 不动。

---

### `electron/preload.ts`（改，桥接）

**Analog:** 同文件 experience block（L124-140）+ L131 relateDevice 多参范式

**delta —— experience block 加 restore + 透传扩展 opts：**
```ts
experience: {
  list: (opts?: unknown) => ipcRenderer.invoke('experience:list', opts),  // 透传，opts 类型由 electron.d.ts 收紧
  // ... 既有不动 ...
  invalidate: (id: string) => ipcRenderer.invoke('experience:invalidate', id),
  restore: (id: string) => ipcRenderer.invoke('experience:restore', id),  // 新增
  // ... 既有不动 ...
}
```
> preload 的 `list` 实参 `opts?: unknown` 已透传，**无需改 preload 实现**——只需在 L130（invalidate 后）插入 restore 一行。list 的 opts 类型在 `electron.d.ts` 端收紧（见下）。

**replicate 约束：** 三向一致（channel 名 = preload invoke = electron.d.ts 方法名，逐字，见 electron.d.ts L214 注释）。

---

### `src/types/electron.d.ts`（改，类型契约）

**Analog:** 同文件 experience block（L202-218）+ L200-201 注释范式

**delta —— 加 restore 签名：**
```ts
experience: {
  list: (opts?: ExperienceListInput) => Promise<ExperienceListResult>   // opts 类型已在 ExperienceListInput 扩（见下）
  // ... 既有不动 ...
  invalidate: (id: string) => Promise<Experience>
  restore: (id: string) => Promise<Experience>                           // 新增（与 invalidate 对称返回 Experience）
  // ... 既有不动 ...
}
```

> import 行（L10）已含 `ExperienceListInput`，无需扩 import。list 的 opts 扩字段由 `ExperienceListInput` 端带动。

---

### `src/types/experience.ts`（改，DTO）

**Analog:** 同文件 `ExperienceListInput`（L44-51）+ `Experience`（L54-72）

**delta 1 —— ExperienceListInput 扩 search/severity/tags：**
```ts
export interface ExperienceListInput {
  category?: ExperienceCategory
  status?: ExperienceStatus
  deviceId?: string
  includeInvalid?: boolean
  limit?: number
  offset?: number
  search?: string          // 新增 D-10-2（SQL LIKE title+content）
  severity?: string        // 新增 D-10-2（明文 severity 列直筛）
  tags?: string[]          // 新增 D-10-2（tags JSON 列 LIKE 命中任一）
}
```

**delta 2 —— Experience 加 severity 字段：**
```ts
export interface Experience {
  id: string
  title: string
  category: ExperienceCategory
  content: string
  tags: string[]
  status: ExperienceStatus
  source_session_id?: string | null
  attrs?: ExperienceAttrs | null
  valid_at: string
  invalid_at?: string | null
  last_verified_at?: string | null
  reuse_count: number
  created_at: string
  updated_at: string
  duplicate_of_exp_id?: string | null
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info' | null   // 新增（明文列，troubleshooting 类填，其他 NULL）
}
```

**replicate 约束：** DTO 保留下划线 snake_case（文件头注释 L3，DB 行原生字段保留）；severity 是新明文列，与 attrs.severity 双源（attrs.severity 保留向后兼容，Experience.severity 是 DB 明文列投影——planner 评估 renderer 用哪个，优先用顶层 severity 直筛/排序，attrs.severity 兜底）。

---

### `electron/database/migrations.ts`（改，DB 迁移）

**Analog:** 同文件 `v9`（L249-261）—— severity 列迁移的**对称克隆模板**。

**v9 范式（hasColumn 守卫 + db.transaction + bump user_version）：**
```ts
const v9 = (db: Database.Database): void => {
  const step = db.transaction(() => {
    if (!hasColumn(db, 'experiences', 'duplicate_of_exp_id')) {
      db.exec('ALTER TABLE experiences ADD COLUMN duplicate_of_exp_id TEXT')
    }
    db.pragma('user_version = 9')
  })
  step()
}
```

**delta —— 新增 v10（severity 列迁移）：**
```ts
const v10 = (db: Database.Database): void => {
  // Phase 10（D-10-2）：experiences 加 severity TEXT nullable 明文列。
  // 支撑浏览页 SQL 直筛/排序 + Phase 11 检索复用，从加密 attrs 拆明文列。
  // attrs.severity 保留向后兼容（双写）。troubleshooting 类填 critical/high/medium/low/info，其他类 NULL。
  // 幂等守卫 D-14 第一形式：hasColumn（与 v1/v2/v3/v4/v9 同构，纯 ALTER ADD COLUMN）。
  const step = db.transaction(() => {
    if (!hasColumn(db, 'experiences', 'severity')) {
      db.exec('ALTER TABLE experiences ADD COLUMN severity TEXT')
    }
    db.pragma('user_version = 10')
  })
  step()
}
```

**MIGRATIONS 注册表 + HEAD bump**（L263-273, L16）：
```ts
export const MIGRATION_HEAD = 10   // L16: 9 → 10

const MIGRATIONS: MigrationStep[] = [
  // ... 既有 v1-v9 不动 ...
  { version: 10, name: 'experiences.severity (Phase 10 browse filter/sort)', run: v10 },
]
```

**replicate 红线（CLAUDE.md Conventions + migrations.ts L24-27 注释）：**
- **幂等守卫 hasColumn**（不靠 user_version 判定，遗留库重跑也安全，D-14）。
- **DDL 包 db.transaction**（throw 自动 ROLLBACK，D-08）。
- **bump MIGRATION_HEAD**（每版本 = 一个原子步骤）。
- **不动 status 枚举**（沿用 Phase 7 四态，D-10-2）。
- **不加 CHECK/DEFAULT**（与 v9 同款，纯 ALTER ADD COLUMN；severity 值由 service 层 VALID_SEVERITIES 校验，见 experienceService.ts L51）。

**delta 汇总：** 新增 v10 函数 + 注册表加一行 + MIGRATION_HEAD 9→10。

> **数据回填 caveat（planner 评估）**：迁移只加空列；存量 troubleshooting 经验的 severity 仍只在 attrs_enc（加密）里。**首启 listExperiences 读不到 severity 明文**。planner 须评估是否在 v10 内加回填步骤（解密 attrs_enc 读 severity 写明文列）——但这需 MK 注入，迁移在 MK 注入前跑（`migrateAndSecure` 早于 `setExperienceMasterKey`），**无法在迁移内解密**。**推荐方案**：v10 只加列，service 层 create/update 双写 + 读路径 `rowToExperience` 兜底（severity 列 NULL 时 fallback 到 attrs.severity）。这样历史数据读到 severity（来自 attrs），新数据读到明文列，筛选/排序对历史数据失效但**不丢数据**——planner 在 PATTERNS 标注此 fallback，由 service 层实现。

---

### 跨 phase 重构：`src/components/pages/ai/ReviewConfirmModal.tsx` + `ReviewConfirmEditForm.tsx`（改 import）

**Analog:** 新建的 `src/components/knowledge/ExperienceEditForm.tsx`（D-10-1 单一来源）

**改造（D-10-1，UI-SPEC §5）：**
1. **`validateDraft` 迁移**：从 `ReviewConfirmModal.tsx`（L49-62）迁到 `ExperienceEditForm.tsx` 导出；ReviewConfirmModal 改 `import { validateDraft } from '../../knowledge/ExperienceEditForm'`（删除本地 L49-62 的导出定义，保留 re-export 或直接 import）。
2. **ReviewConfirmEditForm 复用 ExperienceEditForm**（可选，UI-SPEC §5 planner 评估）：
   - 优先方案：ReviewConfirmEditForm 改为薄壳，内部渲染 `<ExperienceEditForm initialValue={draft} onSubmit={...} onCancel={...} />`，主壳传决策 patch 回写。
   - 保守方案：仅共享 `validateDraft`（Phase 9 表单字段结构不动），降低回归风险。
3. **Phase 9 不动语义**：UPDATE supersedeOld / 查看原始会话 / 批量决策列表 是 Phase 9 专属，ExperienceEditForm 去除这些（见 ExperienceEditForm delta）—— 若 ReviewConfirmEditForm 复用 ExperienceEditForm，须在主壳层补回这两个 UI（supersedeOld Checkbox + 查看原始会话 Button），不能丢。

**replicate 约束：**
- **质量门单一来源**（消除漂移，D-10-1）：renderer 与 service 层 assertTroubleshootingAttrs 各自单一（service 层不动），renderer 层 validateDraft 单一。
- import 路径：`'../../knowledge/ExperienceEditForm'`（从 `pages/ai/` 到 `knowledge/`）。

**delta 汇总：** 改 import 路径 + 删除本地 validateDraft 定义（或保留 re-export）。Planner 决定 ReviewConfirmEditForm 是否进一步薄壳化（建议保守方案：仅共享 validateDraft，避免 Phase 9 回归）。

---

## Shared Patterns

### IPC 鉴权（secure 包装红线）
**Source:** `electron/utils/authGuard.ts`（`secure` / `safe` 导出）
**Apply to:** `experience:restore` 新增 channel
```ts
// experienceIpc.ts 范式（L60-76）
ipcMain.handle('experience:restore', secure((_e, id: string) =>
  restoreExperience(id)))
```
**红线（不可回退）：** 经验属登录后特权操作（涉敏感 attrs），**全 secure 包装**（鉴权 + 异常脱敏），无 safe channel。channel 命名 `<domain>:<action>` camelCase。

### 字段加密（encField/decField 红线）
**Source:** `electron/utils/crypto.ts`
**Apply to:** experienceService.ts 任何 attrs_enc 读写
```ts
// experienceService.ts L4 import + L212/L322 用法
import { encField, decField } from '../utils/crypto'
const attrsEnc = attrsStr ? encField(attrsStr, MK) : null
const dec = decField(row.attrs_enc, MK)
```
**红线：** 敏感列 `_enc` 后缀，**只走 encField/decField**（自带 null/降级），禁止裸调 encrypt/decrypt。severity 是**明文列**（不经加密），与 attrs_enc 双写。

### DB 迁移幂等（hasColumn 守卫红线）
**Source:** `electron/database/migrationHelpers.ts` `hasColumn`
**Apply to:** migrations.ts v10（severity 列）
```ts
// migrations.ts v9 范式（L249-261）
const step = db.transaction(() => {
  if (!hasColumn(db, 'experiences', '<col>')) {
    db.exec('ALTER TABLE experiences ADD COLUMN <col> TEXT')
  }
  db.pragma('user_version = N')
})
step()
```
**红线：** 幂等守卫必须自带（hasColumn 或 sqlite_master sql 特征串），**不靠 user_version 判定**；DDL 包 db.transaction（throw ROLLBACK）；bump MIGRATION_HEAD。

### 受控状态接口模式（绕 CR-01 update 白名单）
**Source:** experienceService.ts `invalidateExperience` / `incReuseCount` / `touchLastVerifiedAt`
**Apply to:** `restoreExperience` 新增
```ts
// invalidateExperience 范式（L346-352）
export function invalidateExperience(id: string): any {
  const conn = db()
  conn.prepare(`UPDATE experiences SET invalid_at = ..., updated_at = datetime('now','localtime') WHERE id = ?`).run(id)
  return getExperience(id)
}
```
**红线：** status / invalid_at / valid_at / last_verified_at / reuse_count 五审计字段**不经 update 白名单**，只走专用受控接口。restoreExperience 清 invalid_at + status 回 published，同模式新增（不复活 update 的 status 字段）。

### Table + 筛选 Space + Popconfirm 删除（renderer UI 范式）
**Source:** KnowledgeBasePage.tsx（L308-373 columns / L378 Space wrap / L361-369 Popconfirm）
**Apply to:** ExperienceTab.tsx 全部
```tsx
<Space wrap style={{ marginBottom: 16 }}>
  <Button type="primary">新增经验</Button>
  <Input placeholder="搜索经验标题或正文" style={{ width: 240 }} onPressEnter={...} />
  <Select placeholder="全部分类" style={{ width: 120 }} ... />
  ...
</Space>
<Table columns={columns} rowKey="id" loading={loading} size="small" pagination={{ pageSize: 20 }} />
```
**红线：** 行操作 Button 一律 `size="small"`；删除走 Popconfirm（硬删除加强提示「不可恢复」，软失效强调「可恢复」）；message.success/error 文案中文。

### 质量门（renderer validateDraft + service assertTroubleshootingAttrs 三层纵深）
**Source:** ReviewConfirmModal.tsx `validateDraft`（L49-62）+ experienceService.ts `assertTroubleshootingAttrs`（L59-70）
**Apply to:** ExperienceEditForm.tsx + createExperience/updateExperience 双写
```ts
// renderer 第一层（validateDraft，迁入 ExperienceEditForm）
if (cat === 'troubleshooting') {
  if (!attrs.severity) errs.push('缺 严重程度')
  if (!attrs.symptoms?.trim()) errs.push('缺 故障现象')
  if (!attrs.resolution?.trim()) errs.push('缺 解决办法')
}
```
**红线：** renderer 实时标红 + 提交禁用（第一层），service 层 confirmDrafts adopt 时 `assertTroubleshootingAttrs` 兜底（第三层，L454-469）—— **手动新增/编辑走 createExperience/updateExperience，service 入口 `validateAndStringifyAttrs` 强制 severity**（L161-170），与 confirmDrafts 兜底分层。错误串中文单一来源。

---

## No Analog Found

**无。** 全部 11 个待建/待改文件均命中既有 exact analog（renderer 组件 / service / IPC / 迁移 / 类型 / preload 全套范式已在 Phase 7-9 落地，本 phase 是就地扩展 + 抽取复用）。

---

## Metadata

**Analog search scope:**
- `src/components/pages/`（KnowledgeBasePage / AIPage / ai/ReviewConfirm* / ai/SessionMessagesModal）
- `electron/services/experienceService.ts`
- `electron/ipc/experienceIpc.ts`
- `electron/database/{migrations.ts,init.ts,migrationHelpers.ts}`
- `electron/preload.ts` + `src/types/electron.d.ts` + `src/types/experience.ts`
- `.planning/phases/09-human-review-confirmation/09-03-SUMMARY.md`（Phase 9 文件清单交叉验证）

**Files scanned:** 9（实读 6 个核心 analog + 3 个交叉验证）

**关键事实校验（实读确认）：**
- `invalidateExperience`（L346-349）**不动 status**，只落 invalid_at —— restoreExperience 对称设计需显式回 status='published'。
- `createExperience`（L221）INSERT status **硬编码 `'draft'`** —— 手动新增直 published 须扩入参 `status?: ExperienceStatus`（默认 draft 保 Phase 7-9 不变）。
- IPC `experience:list` handler（L60-61）**已透传整个 opts** —— 扩 search/severity/tags 无需改 IPC 层，仅类型层声明。
- migrations.ts `MIGRATION_HEAD = 9`（L16），v10 接 v9 之后，bump 到 10。
- 迁移在 MK 注入前跑（`migrateAndSecure` 早于 `setExperienceMasterKey`）—— **v10 无法解密 attrs_enc 回填 severity 明文列**，须 service 层 `rowToExperience` fallback（severity 列 NULL 时读 attrs.severity）。

**Pattern extraction date:** 2026-08-05
