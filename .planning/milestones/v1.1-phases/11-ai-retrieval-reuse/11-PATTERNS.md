# Phase 11: AI Retrieval & Reuse - Pattern Map

**Mapped:** 2026-08-06
**Files analyzed:** 8（5 新建 + 3 修改；编排层倾向串联复用，IPC 倾向不新增）
**Analogs found:** 8 / 8（全部命中精确/角色匹配，无 No-Analog）

> 无 RESEARCH.md（Phase 11 未做独立 research），权威输入为 `11-CONTEXT.md`（4 议题 12 决策）。
> 本 phase 零迁移（D-11-5 LIKE + 精排，不建 FTS5 虚拟表）、零新表、零加密列变更——主要是 main 进程编排逻辑新建 + renderer 来源列表注入。

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `electron/services/experienceRetrieval.ts`（**新建**） | service（编排层） | request-response（多阶段串行）| `electron/services/experienceDrafting.ts` | **exact**（两阶段编排 + 函数式无 MK + 返结构化结果） |
| `electron/services/experienceRerank.ts`（**新建**，或并入 retrieval） | service（LLM 精排） | request-response（LLM call + schema gate）| `electron/services/draftingService.ts`（`validateDrafts`/`judgeVerdicts`） | **exact**（强 schema JSON + 重试 + 反幻觉 prompt） |
| `electron/services/experienceRetrieval.ts` 内嵌 read-time 验证（**新建**，函数粒度） | service（验证） | request-response（同步纯函数）| `electron/services/commandSafety.ts`（`isCommandAllowed`）+ `experienceService.ts`（`incReuseCount`/`touchLastVerifiedAt`） | **exact**（白名单 + 复用计数直接复用） |
| `electron/services/ai.ts`（**修改**，`chat()` 编排注入） | service | request-response（LLM 二轮注入）| `electron/services/ai.ts:731-785`（`[KB_SEARCH]` 二轮注入） | **exact**（同文件内既有二轮注入模式，触发方式改 b 自动预取） |
| `electron/ipc/experienceIpc.ts`（**倾向不新增**，或追加 `experience:retrieve` 1 个 channel） | route（IPC gateway）| request-response | `electron/ipc/experienceIpc.ts`（自身，全 secure 包装模式） | **exact**（同文件追加） |
| `electron/preload.ts`（**条件修改**，视上条决定） | config（contextBridge）| request-response | `electron/preload.ts:124-141`（`experience` namespace） | **exact**（同 namespace 追加 1 方法） |
| `src/components/pages/ai/ChatMessageList.tsx`（**修改**，末尾来源列表） | component | request-response（消费注入的 references）| 自身 `ChatMessageList.tsx:61-71`（已渲染 `msg.references` KB 来源） | **exact**（既有 references 渲染分支，扩 experience 类型） |
| `src/components/pages/ai/types.ts`（**修改**，`ChatMsg.references` 扩联合类型） | model（DTO）| — | 自身 `types.ts:19-25`（`references?: Array<{docTitle;chunkTitle;docId}>`） | **exact**（扩字段联合） |
| `electron/services/experienceService.ts`（**零改动**，仅消费预埋接口） | service（数据层）| CRUD | 自身（`listExperiences`/`incReuseCount`/`touchLastVerifiedAt`） | exact |

**复用而不新建的资产（D-11 全部直接调用，planner 不重复造）：**

| 资产 | 复用点 |
|------|--------|
| `experienceService.listExperiences(opts)` | 粗筛入口（search/severity/tags/category/deviceId/includeInvalid 全就绪，零改动） |
| `experienceService.incReuseCount(id)` / `touchLastVerifiedAt(id)` | 命中即刷新（Phase 7 预埋，SC2） |
| `commandSafety.isCommandAllowed(cmd, whitelist)` | read-time 命令白名单验证（D-11-6/7） |
| `callAI(config, messages)`（ai.ts:258） | 精排 + 正式答 LLM 调用（不改签名） |
| `ai.getCommandWhitelist` | 喂 `isCommandAllowed`（白名单来源，复用 `ai_config`/`command_whitelist` seed） |
| `ExperienceDetailModal`（Phase 10）/ `SessionMessagesModal`（Phase 9） | 引用回查复用，**不新建 Modal**（D-11-12） |
| `experience:getSessionMessages` IPC（Phase 9） | 会话原文取回（已 secure 包装） |

---

## Pattern Assignments

### 1. `electron/services/experienceRetrieval.ts`（编排 service，新建）

**Analog:** `electron/services/experienceDrafting.ts`（Phase 8 经验总结编排，**最贴合**的两阶段编排范例）

**形态决策：** 函数式（无 class、无 MK）——本 service 纯编排，加密列由下游 `experienceService`/`ai.ts` 解密回填后传入，本层不碰密文（CONTEXT `<code_context>` Established Patterns + CONVENTIONS Pattern 1b）。

**Imports pattern**（仿 `experienceDrafting.ts:1-8`，全部相对路径，main 进程不用 `@/`）：
```typescript
// 仿 experienceDrafting.ts:1-8
import { callAI, getAiConfig, getCommandWhitelist } from './ai'          // LLM + 配置 + 白名单
import { listExperiences, incReuseCount, touchLastVerifiedAt } from './experienceService'  // 粗筛 + 刷新
import { isCommandAllowed } from './commandSafety'                       // read-time 验证
// 无 MK、无 encField/decField（不读写加密列）
```

**核心编排模式（仿 `summarizeSessionForUi` experienceDrafting.ts:70-156）——多阶段串行 + demoMode 早返 + empty 早返：**
```typescript
// experienceDrafting.ts:70-94 编排骨架（Phase 11 复刻同结构）
export async function retrieveForAnswer(input: RetrieveInput): Promise<RetrieveResult> {
  const empty: RetrieveResult = { injected: [], reranked: [], finalAnswer: input.userMessage, demoMode: false }
  // 1. 判 demoMode（未配 AI）—— 不抛错，返空注入（仿 :79-81）
  const config = getAiConfig()
  if (!config || !config.apiKey) return { ...empty, demoMode: true }
  // 2. 空库短路（D-11 discretion）—— 粗筛返空则跳过精排不空转
  const candidates = listExperiences({ search: input.userMessage, /* D-11-2 窄查策略 */ })
  if (candidates.rows.length === 0) return empty
  // 3. 精排 callAI（强 schema）→ 4. 阈值过滤 → 5. read-time 验证 → 6. 刷新计数 → 7. 返引用元数据
  ...
}
```

**关键差异（planner 注意，不能照抄 experienceDrafting）：**
- `experienceDrafting` 是「会话→草稿落库」（写路径，调 `createExperience`）；Phase 11 编排是「读路径」（粗筛读 + 精排 LLM + 验证 + 刷新计数，不落新经验）。
- `experienceDrafting` 的 W-4 阶段 B 是「按 category 窄查同分类存量」；Phase 11 的 D-11-2 是「有勾选设备按关联设备+同分类窄查，无勾选用问题原文全库宽匹配」——粗筛策略不同，但「编排层串两阶段 + 中间结果喂下一阶段」的同构骨架可直接复刻。
- 落库 try/catch 包 `createSystemLog` 降级（experienceDrafting.ts:131-145 `relateDevice` 失败写日志模式）→ Phase 11 命中刷新 `incReuseCount`/`touchLastVerifiedAt` 失败可仿此「不阻塞主路径」降级（D-11-9 不阻塞）。

**返回值契约（仿 `DraftingResult` 结构化结果 experienceDrafting.ts:38-44）：**
```typescript
// 仿 experienceDrafting.ts:38-44 —— 结构化结果，renderer 据此渲染末尾来源列表（D-11-11）
export interface RetrieveResult {
  demoMode: boolean
  injected: Array<{ exp_id: string; title: string; source_session_id?: string | null; unsupported?: boolean }>
  reranked: Array<{ exp_id: string; score: number; reason: string }>  // 供调试/未来阈值调参
  finalAnswer: string
}
```

---

### 2. `electron/services/experienceRerank.ts`（精排 LLM service，新建或并入 #1）

**Analog:** `electron/services/draftingService.ts`（Phase 8 强 schema + 重试 + 反幻觉 prompt，**精排评分的精确范式**）

**核心模式 A — 强 schema JSON 输出 + Drift Gate（仿 `validateDrafts` draftingService.ts:106-164）：**
```typescript
// draftingService.ts:106-164 schema Gate 骨架（Phase 11 精排返 exp_id+score+reason）
export function validateRerank(raw: string): { ok: true; entries: RerankEntry[] } | { ok: false; error: string } {
  let arr: any[]
  try { arr = JSON.parse(extractJsonArray(raw)) }        // 复用 extractJsonArray（draftingService.ts:97-104）
  catch (e: any) { return { ok: false, error: 'JSON 解析失败: ' + e?.message } }
  if (!Array.isArray(arr)) return { ok: false, error: '输出非数组' }
  // 逐条校验 exp_id 在候选集 + score 0-1 数值边界（仿 confidence 校验 draftingService.ts:144-150）
  // reason 字符串必填
  ...
}
```

**关键复用点：**
- `extractJsonArray(raw)`（draftingService.ts:97-104）—— 剥 ```` ```json ```` 包裹 + 取首 `[` 末 `]`，**精排输出 JSON 提取直接复用**（精排 prompt 也要求纯 JSON 数组）。
- confidence 边界归一化（draftingService.ts:144-150：`'85%' → 0.85`、`'0.9' → 0.9`、超界 fail）—— **精排 score 校验直接套同模式**，LLM 返 `'0.85'`/`'85%'` 都能兜住。
- `VALID_VERDICTS`/`VALID_CATEGORIES` 模块级常量枚举守卫（draftingService.ts:23-25）—— 精排若需分类校验复用同枚举。

**核心模式 B — 重试 + demoMode 短路（仿 `draftSession` draftingService.ts:166-185）：**
```typescript
// draftingService.ts:166-185 重试骨架（Phase 11 精排直接套）
export const MAX_DRAFT_RETRIES = 3   // draftingService.ts:21，模块级常量

export async function rerank(input: RerankInput): Promise<RerankEntry[]> {
  if (input.demoMode) return []                       // 仿 :167 demoMode 短路
  const config = getAiConfig()
  if (!config || !config.apiKey) throw new Error('请先配置 AI 服务（API Key 未设置）')   // 仿 :169-171
  const messages = [{ role: 'system', content: RERANK_SYSTEM_PROMPT }, { role: 'user', content: buildRerankPrompt(input) }]
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= MAX_DRAFT_RETRIES; attempt++) {     // 仿 :178-184 重试循环
    const raw = await callAI(config, messages)
    const result = validateRerank(raw)
    if (result.ok) return result.entries
    lastError = result.error
  }
  throw new Error(`AI 精排失败（已重试 ${MAX_DRAFT_RETRIES} 次）：${lastError}`)
}
```

**核心模式 C — 反幻觉 prompt（仿 `SYSTEM_PROMPT` draftingService.ts:59-73）：**
```typescript
// draftingService.ts:59-73 prompt 红线（Phase 11 精排 prompt 套同结构）
const RERANK_SYSTEM_PROMPT = [
  '你是网络运维经验检索助手。对每条候选经验，结合用户问题判相关度并打分。',
  '【反幻觉红线】禁止编造 exp_id；score 必须 0-1 数值；只对给定候选打分，不得新增。',
  '【输出格式】严格输出 JSON 数组，不得有任何额外文字。每条对象字段：',
  'exp_id(候选列表中既有的 id), score(0-1 数值), reason(为何相关/不相关)。',
  '若全部不相关，返回空数组 []。',
].join('\n')
```

**精排 prompt 输入构造（仿 `buildDraftingPrompt` draftingService.ts:75-94 + `buildVerdictPrompt` draftingService.ts:200-223）：**
- 候选列表喂 `exp_id | 标题 | 内容前 N 字`（仿 draftingService.ts:200-203 的 `draft_index` 引用模式——精排 prompt 里给每条候选编号/exp_id，让 LLM 回填 score，避免 LLM 重排丢映射）。

---

### 3. read-time 验证（`experienceRetrieval.ts` 内函数粒度，新建）

**Analog 1 — 命令白名单：** `electron/services/commandSafety.ts`（`isCommandAllowed`，**直接调用，零适配**）

```typescript
// commandSafety.ts:24-52 —— Phase 11 直接调，不改
const result = isCommandAllowed(cmd, whitelist)   // 返 { allowed: boolean; reason: string }
// 三层校验已就绪：分隔符注入拦截（:32-34）→ 黑名单首词（:39-41）→ 白名单首词严格相等（:44-49）
```

**白名单来源（喂 isCommandAllowed 的第二参）：** `ai.getCommandWhitelist()`（经 `ai:getCommandWhitelist` IPC 同源，DB `command_whitelist` 表）。

**Analog 2 — 命令提取（D-11 discretion「正文扫描」）：** 无结构化字段（Phase 7 troubleshooting attrs 无 `command[]` 字段，命令散落 `resolution`/`content` 正文）。**正则提取是新逻辑，无现成 analog**——planner 自行设计扫描正则（如 `/(display|show|ping|traceroute)\s[\w-]+/g` 类命令首词），风险记 deferred（D-11-7 二期加 `attrs.command[]`）。

**Analog 3 — 有效期判断（D-11-6/7）：** `experienceService.listExperiences` 的 bi-temporal 过滤条件可直接复用（experienceService.ts:309-311）：
```typescript
// experienceService.ts:310 —— 有效期判断逻辑（Phase 11 read-time 验证复用同表达式）
"(e.invalid_at IS NULL OR e.invalid_at > datetime('now','localtime'))"
// 粗筛 listExperiences 默认已过滤失效（includeInvalid 默认 false），命中候选天然有效；
// 但精排后若需二次确认有效期（防窗口跨天），同表达式比对 last_verified 时刻即可。
```

**Analog 4 — 命中刷新：** `experienceService.incReuseCount`/`touchLastVerifiedAt`（experienceService.ts:565-571，**Phase 7 预埋，直接调**）：
```typescript
// experienceService.ts:565-571 —— 命中即刷新（SC2），单语句 UPDATE，复用零改动
incReuseCount(exp_id)                // reuse_count = reuse_count + 1
touchLastVerifiedAt(exp_id)          // last_verified_at = datetime('now','localtime')
```

**分类降级策略（D-11-7，新逻辑，无 analog 但语义清晰）：**
- 命令失支持 → 不剔除，标 `unsupported: true` 注入（prompt 附「⚠ 此条命令已失支持」，AI 回答提示用户手动执行/更新白名单）。
- 有效期失效 → 剔除（粗筛已默认过滤，二次确认失效即不注入）。

---

### 4. `electron/services/ai.ts`（`chat()` 修改，二轮注入）

**Analog:** `ai.ts:731-787`（同文件 `[KB_SEARCH]` 二轮注入机制，**Phase 11 经验注入的精确范式**）

**关键差异（CONTEXT `<canonical_refs>` 已锁定，planner 必须区分）：**
- `[KB_SEARCH]`（既有）：**AI 自主标记**——AI 首轮回 `[KB_SEARCH]kw[/KB_SEARCH]` 标记 → 正则 `aiReply.match(/\[KB_SEARCH\](.*?)\[\/KB_SEARCH\]/s)`（ai.ts:732）→ 调 `kbSearch` → 二轮 `callAI` 喂文档片段（ai.ts:765-773）。
- Phase 11 经验注入（D-11-1 方案 b）：**后台自动预取**——`chat()` 入口先调 `retrieveForAnswer`（编排层），命中即把经验正文拼进正式 `callAI` 的 `fullMessages` context，**不靠 AI 自主标记**（不抄 `[EXP_SEARCH]` 文本协议）。

**注入模式（仿 ai.ts:765-773 的 `followUpMessages` 拼装）：**
```typescript
// ai.ts:765-773 二轮注入消息拼装（Phase 11 套同结构，但触发前置）
const expContext = injectedExps.map((e, i) =>
  `[经验${i + 1}: ${e.title}${e.unsupported ? '（⚠ 此条命令已失支持）' : ''}]\n${e.content}`
).join('\n\n')
const fullMessages = [
  { role: 'system', content: systemPrompt + `\n\n以下是经验库中检索到的相关经验（仅供参考，回答末尾无需标注）：\n${expContext}` },
  ...messages,
]
const finalAiReply = await callAI(config, fullMessages)   // 单次正式答（精排是另一次 callAI）
```

**返回值末尾来源列表（仿 ai.ts:803-804 `kb_answer` 分支的 `references` 字段）：**
```typescript
// ai.ts:803-804 —— KB answer 返 { type:'kb_answer', content, references }（Phase 11 套同 JSON 结构）
// D-11-11：references 来源直接用 retrieveForAnswer 返回的 injected 记录（不需 AI 标记）
if (injectedExps.length > 0) {
  return JSON.stringify({
    type: 'exp_answer',            // 新类型，或并入 kb_answer 扩 references 联合类型
    content: finalAiReply,
    references: injectedExps.map((e) => ({
      exp_id: e.exp_id,
      title: e.title,
      source_session_id: e.source_session_id,    // 会话引用回查（D-11-12）
    })),
  })
}
```

**信任边界（CONTEXT 锁定）：** 注入走 service 解密 attrs 后明文 + commandSafety 验证后标注，renderer 永不收密文（`references` 只含 `exp_id`/`title`/`source_session_id`，不含 `attrs` 密文/凭证片段）。

---

### 5. `electron/ipc/experienceIpc.ts`（条件修改，倾向不新增）

**Analog:** 自身（experienceIpc.ts 全 secure 包装模式）

**倾向方案（CONTEXT discretion + `<code_context>` Integration Points）：** 编排层串联不新增 IPC——`chat()` 内部调 `retrieveForAnswer`（service 间互调，不经 IPC），renderer 仍走既有 `ai:chat`，来源列表随 `ai:chat` 返回值带回。

**备选方案（若 planner 选新增 `experience:retrieve` 编排入口）：** 仿 experienceIpc.ts:62-124 secure 包装模式追加 1 个 channel：
```typescript
// experienceIpc.ts:64-65 + :107-112 secure + MAX_BATCH 校验双层防御模式
ipcMain.handle('experience:retrieve', secure((_e, input: RetrieveInput) => {
  if (!input || typeof input.userMessage !== 'string') throw new Error('参数无效')
  return retrieveForAnswer(input)
}))
```

**红线（CLAUDE.md + CONVENTIONS line 88-116，不可回退）：**
- 全 secure 包装（鉴权 + 异常脱敏）。
- channel 命名 `<domain>:<action>` camelCase（`experience:retrieve`）。
- 若入参含数组，守 `MAX_BATCH = 1000`（experienceIpc.ts:108-110 模式）。

---

### 6. `electron/preload.ts`（条件修改）

**Analog:** 自身 `preload.ts:124-141`（`experience` namespace）

**仅当 #5 新增 channel 时改**（追加 1 行，仿 preload.ts:137-141）：
```typescript
// preload.ts:137 模式 —— contextBridge 暴露白名单方法
retrieve: (input: unknown) => ipcRenderer.invoke('experience:retrieve', input),
```

若编排层串联不新增 IPC → **preload 零改动**（`ai:chat` 已暴露，来源列表随其返回值回）。

---

### 7. `src/components/pages/ai/ChatMessageList.tsx`（修改，末尾来源列表）

**Analog:** 自身 `ChatMessageList.tsx:61-71`（**已渲染 `msg.references` KB 来源——这是 Phase 11 来源列表的精确注入点，D-11-10/11 直接扩此分支**）

```tsx
// ChatMessageList.tsx:61-71 —— 既有 KB references 渲染（Phase 11 扩 experience/session 类型）
{msg.role === 'assistant' && msg.references && msg.references.length > 0 && (
  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e8e8e8' }}>
    <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>参考来源：</div>
    {msg.references.map((ref, ri) => (
      <div key={ri} style={{ fontSize: 12, color: '#666', lineHeight: 1.8 }}>
        <BookOutlined style={{ marginRight: 4, color: '#1890ff' }} />
        {ref.docTitle} — {ref.chunkTitle}      {/* ← Phase 11 扩：experience 显 title + 点击回查 Modal */}
      </div>
    ))}
  </div>
)}
```

**Phase 11 修改方向（D-11-10/11/12）：**
- `ChatMsg.references`（types.ts:24 当前 `Array<{docTitle;chunkTitle;docId}>`）扩联合类型，加 `{ kind: 'experience'; expId: string; title: string }` 与 `{ kind: 'session'; sessionId: string; title: string }`。
- 渲染分支按 `ref.kind` 分流：experience → 点击打开 `ExperienceDetailModal`（需先 `experience:get(expId)` 拉详情，或 references 直接带够渲染的最小字段）；session → 点击打开 `SessionMessagesModal`（复用既有 `experience:getSessionMessages`）。
- 「⚠ 命令已失支持」标注（D-11-7）→ references 项加 `unsupported?: boolean` 显黄色 Tag（仿 ExperienceDetailModal.tsx:34-40 `SEVERITY_TAG` 模式，但用 `warning`/`gold` 色，**禁止新色**——CONVENTIONS 与 UI-SPEC Color 锁定）。
- 「本次参考池」（D-11-11 列全部注入的，不区分 AI 实际用到几条）→ 直接渲染 `references` 全量，不做按句脚注。

**复用组件（D-11-12 不新建 Modal）：**
- `ExperienceDetailModal`（`src/components/knowledge/ExperienceDetailModal.tsx:68-238`）——经验引用回查。props：`{ open, experience, onClose, ... }`，需先 `window.api.experience.get(expId)` 取 `Experience` 对象传入（仿 ExperienceDetailModal.tsx:87-91 拉 devices 的 useEffect 模式）。
- `SessionMessagesModal`（`src/components/pages/ai/SessionMessagesModal.tsx:22-75`）——会话引用回查。props：`{ open, sessionId, onClose }`，内部已 `window.api.experience.getSessionMessages`（SessionMessagesModal.tsx:32-34），**零适配直接复用**。

---

### 8. `src/components/pages/ai/types.ts`（修改，DTO 扩字段）

**Analog:** 自身 `types.ts:19-25`（`ChatMsg.references`）

```typescript
// types.ts:19-25 当前定义（Phase 11 扩 references 联合类型）
export interface ChatMsg {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  references?: Array<{ docTitle: string; chunkTitle: string; docId: string }>   // ← 当前 KB 专用
  // Phase 11 扩为联合：
  // | Array<ReferenceItem>
  // type ReferenceItem =
  //   | { kind: 'kb'; docTitle: string; chunkTitle: string; docId: string }
  //   | { kind: 'experience'; expId: string; title: string; unsupported?: boolean }
  //   | { kind: 'session'; sessionId: string; title: string }
}
```

**注意（D-11-11）：** references 数据**从精排注入记录拿（service 层已知注入哪些经验），不需 AI 标记**——`ai:chat` 返回的 JSON（ai.ts:803-804 模式）已带 `references` 数组，renderer 直接消费。types.ts 仅声明其联合形态，不引入 AI 标记协议。

---

## Shared Patterns

### A. IPC 鉴权（红线，全 channel 强制）
**Source:** `electron/utils/authGuard.ts:31-53`
**Apply to:** 若新增 `experience:retrieve` channel（#5/#6）
```typescript
// authGuard.ts:31-41 secure 包装（鉴权 + 异常脱敏，不可回退）
export function secure(handler: (e: any, ...args: any[]) => any) {
  return async (e: any, ...args: any[]) => {
    if (!authenticated) throw new Error('未登录或会话已过期')   // try 之外不被脱敏覆盖
    try { return await handler(e, ...args) }
    catch (err: any) {
      console.error('[ipc] handler error:', err)
      throw new Error(sanitizeMessage(err?.message || '操作失败'))   // 移路径 + 截 200 字符
    }
  }
}
```

### B. Service 函数式 + 无 MK（精排/编排层）
**Source:** `electron/services/draftingService.ts:1-19`（header 注释明示「函数式（无 class、无 MK）——本 service 不读写加密列，与 CONVENTIONS Pattern 1b 一致」）
**Apply to:** `experienceRetrieval.ts` + `experienceRerank.ts`（两 service 都不读写加密列：粗筛经 `listExperiences` 已解密回填 attrs 明文；精排只收明文候选；正式注入走 `ai.ts` 已解密配置）
```typescript
// draftingService.ts:1-19 模式 —— 顶部 import + 模块级常量，无 let MK、无 setXxxMasterKey
import { callAI, getAiConfig } from './ai'
export const MAX_DRAFT_RETRIES = 3   // 模块级常量 UPPER_SNAKE_CASE
// 加密列若需读写（本 phase 不需要）才转 Pattern 1a（let MK + encField/decField）
```

### C. 强 schema JSON LLM 输出（Drift Gate + 重试）
**Source:** `electron/services/draftingService.ts:97-104`（`extractJsonArray`）+ `:106-164`（`validateDrafts` schema Gate）+ `:166-185`（重试循环）
**Apply to:** 精排 LLM 调用（#2）
- LLM 返 ```` ```json [...] ```` 包裹 → `extractJsonArray` 取首 `[` 末 `]`。
- 逐条校验枚举（exp_id 在候选集）+ 数值边界（score 0-1，复用 confidence 边界归一化 draftingService.ts:144-150）。
- `MAX_DRAFT_RETRIES = 3` 重试，全失败 throw（经 secure 脱敏透出）。

### D. LLM 二轮注入（检索结果喂 context）
**Source:** `electron/services/ai.ts:731-787`（`[KB_SEARCH]` → kbSearch → 二轮 callAI）
**Apply to:** 正式答注入（#4），**触发方式改 b 自动预取（D-11-1），不抄 AI 自主标记协议**
```typescript
// ai.ts:765-773 followUpMessages 拼装（Phase 11 套同结构，但前置触发）
const followUpMessages = [
  ...fullMessages,
  { role: 'assistant', content: aiReply },     // Phase 11 可省（不靠 AI 中转）
  { role: 'user', content: `以下是检索到的相关经验：\n${expContext}\n\n请基于以上回答。` },
]
finalAiReply = await callAI(config, followUpMessages)
```

### E. 信任边界（renderer 永不收密文）
**Source:** `electron/services/experienceService.ts:187-220`（`rowToExperience` 解密回填 attrs 后 `delete row.attrs_enc`）+ `electron/ipc/experienceIpc.ts:52-60`（`stripEncColumns` 深度防御）
**Apply to:** 所有从 main 回 renderer 的 references / 注入结果（#1/#4/#7）
- references 只含 `exp_id`/`title`/`source_session_id`/`unsupported`，**不含 attrs 密文 / 凭证片段**。
- 精排 service 收到的是 `listExperiences` 已解密的明文候选（rowToExperience 已 delete attrs_enc），编排层不再触碰密文。

### F. 命令安全层（read-time 验证）
**Source:** `electron/services/commandSafety.ts:14-52`（`SEPARATOR_RE` + `BLOCKED_FIRST_WORDS` + `isCommandAllowed`）
**Apply to:** read-time 命令验证（#3）
- 三层校验：分隔符注入拦截 → 黑名单首词 → 白名单首词严格相等。
- 命令提取（正文扫描）是新逻辑，**正则提取无 analog**（deferred 记 D-11-7 二期加 `attrs.command[]` 结构化字段）。

---

## No Analog Found

| File/逻辑 | Role | Data Flow | Reason | Planner 对策 |
|-----------|------|-----------|--------|--------------|
| 经验正文命令提取正则（#3 read-time 验证）| service（正则扫描）| transform | Phase 7 troubleshooting attrs 无结构化 `command[]` 字段，命令散落 `resolution`/`content` 正文，仓库无「类命令文本扫描」现成模式 | 自行设计扫描正则（如首词 `display|show|ping|traceroute` 触发），风险记 deferred（D-11-7） |
| 检索节流/缓存（同会话连续类似问题不重复检索）| service（缓存）| — | MVP 可不做（CONTEXT discretion 标「开销可接受」），无现成缓存 analog | planner 评估，倾向 defer |

**注：** 其余文件均命中精确/角色匹配 analog，planner 可直接按上述 file:line 引用复制模式。

---

## Metadata

**Analog search scope:**
- `electron/services/*.ts`（29 个 service，重点 experienceDrafting/draftingService/experienceService/commandSafety/ai/knowledgeBaseService）
- `electron/ipc/*.ts`（9 个 IPC 模块，重点 experienceIpc）
- `electron/utils/authGuard.ts`
- `electron/preload.ts`（experience/ai namespace）
- `src/components/pages/ai/*.tsx`（ChatMessageList/SessionMessagesModal/types）
- `src/components/knowledge/ExperienceDetailModal.tsx`
- `src/types/experience.ts`

**Files scanned:** 13（含 4 个测试文件 grep 定位未深读——`experienceDrafting.test.ts`/`draftingService.test.ts`/`experienceService.test.ts` 等供 planner 编写测试时参考，本 phase 测试 analog = 上述 service 的同名 .test.ts）
**Pattern extraction date:** 2026-08-06
**关键决策锚点（planner 必读 CONTEXT）:** D-11-1（b 自动预取）/D-11-3（2 次 LLM）/D-11-5（LIKE + 精排，零迁移）/D-11-6/7（两项验证 + 降级策略）/D-11-11（references 从注入记录拿，不需 AI 标记）/D-11-12（复用 Modal 不新建）
