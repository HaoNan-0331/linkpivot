---
phase: 11-ai-retrieval-reuse
reviewed: 2026-08-06T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - electron/services/experienceRerank.ts
  - electron/services/experienceRetrieval.ts
  - electron/services/experienceRetrieval.test.ts
  - electron/services/ai.ts
  - src/components/pages/ai/types.ts
  - src/components/pages/ai/useAIChat.ts
  - src/components/pages/ai/ChatMessageList.tsx
findings:
  critical: 2
  warning: 8
  info: 4
  total: 14
status: issues_found
---

# Phase 11: Code Review Report

**Reviewed:** 2026-08-06
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found（6 项已修复，8 项留二期）

## Remediation（2026-08-06，commit 8789fce）

代码审查后立即闭环 2 BLOCKER + 4 关键 WARNING（用户选「修 BLOCKER + 关键 WARNING」）：

| Finding | Severity | 处置 |
|---------|----------|------|
| CR-01 粗筛未过滤 status，draft 经验泄漏进检索池（违反红线③） | BLOCKER | ✅ 修复：opts 强制 `status:'published'` + test 19/20 断言 |
| CR-02 validateRerank 不去重 exp_id，reuse_count 重复累加 | BLOCKER | ✅ 修复：`seen` Set 去重 + test 9b |
| WR-01 KB/经验同命中时 kb_answer 早 return 丢经验 references | WARNING | ✅ 修复：ai.ts 合并 exp_answer + useAIChat kb 分流 |
| WR-03 CMD_EXTRACT_RE 含 interface/terminal/debug 误标 unsupported | WARNING | ✅ 修复：收窄为 display/show/ping/traceroute + 重写 test 24/25 |
| WR-06 openExperience 无 catch/null 判 | WARNING | ✅ 修复：null 判 + .catch |
| WR-07 search LIKE 未转义 \\\\ % _ | WARNING | ✅ 修复：ESCAPE 子句 + browse mock 容忍 |

**留二期**（不影响本期交付质量，记 follow-up）：WR-02 extractJsonArray 前置文字 / WR-04 类型断言当文档 / WR-05 JSON.parse 纯文本巧合 / WR-08 截断 tiebreaker / IN-01~04（import 合并、时区、a11y、retry 语义）。

四绿门禁复核：tsc 0 + vitest 231/231 + vite build + build:electron-main。

## Summary

Phase 11 经验检索复用主链路：`retrieveForAnswer`（粗筛 → 精排 → 阈值 → 两项验证 → 刷新 reuse_count）+ `ai.chat` 自动预取串联注入 + renderer `exp_answer` 消费渲染。

整体设计清晰、单测覆盖较全（rerank schema gate / 阈值 / 有效期 / 命令失支持 / 不阻塞主路径均有用例）。但存在 **2 个 BLOCKER**：

1. **粗筛未过滤 `status`，把 `draft` 草稿喂进 LLM 精排并刷新 reuse_count**——直接绕过 Phase 9「draft 必须经 confirmDrafts 人工闸口才发布」红线③，让未审草稿被自动注入回答 + 计数 inflated。
2. **`validateRerank` 不去重 exp_id**——LLM 返回重复条目时 `passed` 含重复 id，`incReuseCount` 同 id 被多次累加，reuse_count 失真；renderer references 也会重复渲染。

另有 8 个 WARNING（renderer 类型断言脆弱 / `extractJsonArray` 跨 `[` `]` 字面量截断 / `unsupported` 取消保守语义与 prompt 矛盾 / `commands.length === 0` 早返分支丢失经验注入等）和 4 个 INFO。

---

## Critical Issues

### CR-01: 粗筛未指定 `status`，把 draft 草稿喂进精排并刷新 reuse_count（绕过 Phase 9 红线③）

**File:** `electron/services/experienceRetrieval.ts:62-66`
**Issue:**
`listExperiences(opts)` 调用只传了 `deviceId`/`search`/`includeInvalid`/`limit`，**未传 `status`**。`listExperiences`（`experienceService.ts:274-277`）仅在 `opts.status` 显式传入时才加 `e.status = ?` 条件——不传则返回所有状态。

后果链：
1. `draft` 状态的草稿（Phase 8 AI 起草产出，Phase 9 `confirmDrafts` 闸口**未发布**）会被粗筛捞进候选；
2. 喂给精排 LLM 打分（draft 内容可能不完整——`validateAndStringifyAttrs` 允许 troubleshooting draft 缺 symptoms/resolution）；
3. 命中阈值后被 `incReuseCount`/`touchLastVerifiedAt` 刷新——一条**未发布草稿**的 `reuse_count` 被累加，把 Phase 9「人工确认闸口才发布」的红线③变成空话；
4. draft 注入到回答 systemPrompt，renderer 还会渲染「📖 {title}」让用户点击查看——用户能直接看到未审草稿内容（可能含 LLM 误判的 `duplicate_of_exp_id` 指向错误旧经验）。

T-11-07「references 不泄私有经验」mitigate 不覆盖此：draft 非私有，但**未发布**就是不应自动复用。这与 11-01-PLAN.md「已发布经验才进检索池」语义冲突。

**Fix:**
```typescript
const opts = input.deviceIds && input.deviceIds.length > 0
  ? { deviceId: input.deviceIds, status: 'published' as const, includeInvalid: false, limit: MAX_CANDIDATES }
  : { search: input.userMessage, status: 'published' as const, includeInvalid: false, limit: MAX_CANDIDATES }
```
并在单测 19/20 断言 `opts.status === 'published'`。

---

### CR-02: `validateRerank` 不去重 exp_id，导致 reuse_count 重复累加与 references 重复渲染

**File:** `electron/services/experienceRerank.ts:78-111`、`electron/services/experienceRetrieval.ts:78-117`
**Issue:**
`validateRerank` 的循环只校验 `exp_id ∈ 候选集`，**未去重**。LLM 完全可能返回 `[{exp_id:'e1',...},{exp_id:'e1',...}]`（重试后第二次、或同 exp_id 不同 reason）。

链路：
- `passed = entries.filter(>=阈值).sort().slice(0, INJECT_LIMIT)` 不去重；
- `for (const e of passed)` 中 `incReuseCount(row.id)` 对同一 `row.id` 调用 N 次 → `reuse_count += N`（单次回答 inflated）；
- `injected.push` 推入重复条目 → renderer references 渲染两条「📖 {title}」+ 两条 session 引用；
- `ai.chat` systemPrompt 也注入两段重复 `[经验1]`/`[经验2]`，污染 LLM 上下文。

T-11-06「LLM 不编造 exp_id」mitigate 的是「编造候选集外的 id」，对「重复同一 id」无防御。

**Fix:** 在 `validateRerank` 循环里加去重（`seen` Set），或在 `retrieveForAnswer` 的 `passed` 计算后按 `exp_id` 去重：
```typescript
// validateRerank 循环内
const seen = new Set<string>()
for (let i = 0; i < arr.length; i++) {
  // ... 已有校验 ...
  if (seen.has(d.exp_id)) continue  // 或 return { ok:false, error: `第 ${i+1} 条 exp_id 重复` }
  seen.add(d.exp_id)
  entries.push(...)
}
```
并补单测「LLM 返重复 exp_id → ok 仍 true 但 entries 去重 / 或 fail」。

---

## Warnings

### WR-01: `ai.chat` 经验注入命中时，`commands.length === 0` 早返分支丢失经验注入（功能断流）

**File:** `electron/services/ai.ts:822-839`
**Issue:**
经验注入发生在 `chat()` 顶部（line 729-745），`expReferences` 已填充。但 line 823 的早返判断 `if (commands.length === 0 || targetDevices.length === 0)` 分支内：
- 当 AI 回复**无 `[CMD]` 标记且命中 KB** → 走 `kb_answer` 分支（line 827），**丢弃 expReferences**；
- 当无 CMD 且无 KB 命中 → 走 `exp_answer` 分支（line 831），但前提是 `expReferences.length > 0`。

问题场景：**AI 回复既命中经验注入又触发 KB_SEARCH**。此时 `kbReferences.length > 0` 先返 `kb_answer`，经验 references 被 `kb_answer` 的 references 数组覆盖丢失（line 827 早 return，到不了 line 831）。renderer 只看到 KB 来源，看不到经验来源——经验注入的副作用（reuse_count 已刷新、systemPrompt 已污染）已发生但收益丢失。

**Fix:** 在 line 827 的 `kb_answer` 返回前合并经验 references（注意 ReferenceItem 联合类型——kb 与 experience 不同 kind 可并存）：
```typescript
if (kbReferences.length > 0) {
  const refs: Array<{ kind:'kb'; docTitle:string; chunkTitle:string; docId:string } | { kind:'experience'; expId:string; title:string; sourceSessionId:string|null; unsupported:boolean }> = [
    ...kbReferences.map(r => ({ ...r })),  // kb 无 kind 字段，renderer useAIChat line 156 已兜底补 kind:'kb'
    ...expReferences.map(e => ({ kind:'experience', expId:e.exp_id, title:e.title, sourceSessionId:e.source_session_id, unsupported:e.unsupported })),
  ]
  return JSON.stringify({ type:'kb_answer', content: finalAiReply, references: refs })
}
```
或在 PLAN 阶段明确「KB 与经验互斥」并在代码 assert。

---

### WR-02: `extractJsonArray` 用首尾 `[`/`]` 截取，JSON 字符串字面量内含 `[`/`]` 会截错

**File:** `electron/services/experienceRerank.ts:57-64`
**Issue:**
`extractJsonArray` 取 `raw.indexOf('[')` 到 `raw.lastIndexOf(']')`。若 LLM 输出形如：
```
结果如下：[注：这是说明文字]
[{ "exp_id": "e1", "reason": "排查[核心]" }]
```
- `first` 命中说明文字里的 `[`；
- `last` 命中末尾 `]`；
- 中间跨越了非 JSON 文字，`JSON.parse` 可能仍失败（被 retry 兜底，不致命）。

但更隐蔽：`reason` 字段含 `]` 时，若 LLM 在数组后还补了「解释：...[ref]」，`lastIndexOf(']')` 取到最后一个，**字符串内的 `]` 不会截断**（因为是 last）；但 `indexOf('[')` 取第一个 `[` 可能落在数组前的说明文字里。复刻自 `draftingService.ts:97-104` 不代表正确，只是历史同 bug。

实际影响有限（retry 3 次 + JSON.parse 失败兜底），但当 LLM 稳定输出某前置 `[文字]` 时，3 次重试全失败 → throw → `ai.chat` 顶部 try/catch 兜底为「不注入继续答」，经验检索能力静默失效。

**Fix:** 优先匹配 ```json ... ``` 代码块，退而求其次才用首尾 `[`/`]`：
```typescript
function extractJsonArray(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : raw
  const first = body.indexOf('[')
  const last = body.lastIndexOf(']')
  if (first === -1 || last === -1 || last <= first) throw new Error('输出未找到 JSON 数组边界')
  return body.slice(first, last + 1)
}
```

---

### WR-03: `unsupported` 取保守「任一失支持即标 true」，但 systemPrompt 提示与渲染语义不一致

**File:** `electron/services/experienceRetrieval.ts:99-100`、`electron/services/ai.ts:733`
**Issue:**
- `retrieveForAnswer` line 99-100：`unsupported = cmds.length > 0 && cmds.some(c => !isCommandAllowed(c, whitelist).allowed)`——经验正文里**任意一条**提取到的命令失支持就标 `unsupported=true`。
- `ai.chat` line 733：systemPrompt 注入提示「⚠ 此条经验命令已失支持，请提示用户手动执行或更新白名单」。
- renderer `ChatMessageList` line 62-64：渲染 Tag「⚠ 命令已失支持」。

问题：经验正文常含**多条**命令（如 `display version` + `display interface` + 旧版本 `terminal monitor`）。若 `terminal monitor` 因白名单不含 `terminal` 而失支持，整条经验被打 `unsupported=true`——renderer 与 LLM 都把**整条经验**当失支持处理，但实际可能 9/10 命令仍可用。

更隐蔽：`CMD_EXTRACT_RE`（line 48）限定首词为 `display|show|ping|traceroute|debug|terminal|interface`，其中 `interface`/`debug`/`terminal` 在 `commandSafety.BLOCKED_FIRST_WORDS`（`interface`/`debug` 不在黑名单但 `debug`/`terminal` 通常不在白名单首词）会被判失支持 → 经验含 `interface gi0/0/1`/`terminal monitor` 类描述就被一概打 unsupported。这把「经验里描述了某个命令」误判成「此经验全部命令不可执行」。

**Fix:**
- 细化语义：`unsupported` 改为「失支持命令占比」或仅标注失支持命令列表（renderer 展示具体哪条），而非整条经验布尔值；
- 或收紧 `CMD_EXTRACT_RE` 只提取确定只读的（`display|show|ping|traceroute`），不提 `debug|terminal|interface`（这三个本就是黑名单/灰区）。

---

### WR-04: renderer `parsed.references` 类型断言把 `kind` 当已存在字段读，与 main 实际返回不一致

**File:** `src/components/pages/ai/useAIChat.ts:141-178`
**Issue:**
`parsed` 声明为 `ConfirmData & { type; content?; references?: ReferenceItem[] }`，其中 `ReferenceItem` 是联合类型（每个分支都含 `kind` 字段）。

但 main `ai.chat` 返回：
- `kb_answer`（line 827）：`references = kbReferences`，元素是 `{ docTitle, chunkTitle, docId }`——**无 `kind` 字段**；
- `exp_answer`（line 835）：`references` 元素是 `{ kind:'experience', expId, title, sourceSessionId, unsupported }`——含 `kind`。

line 156 的 kb 分支已正确判断 `if ('kind' in r) return r` 兜底。但 line 167-173 的 `exp_answer` 分支：
```typescript
for (const r of parsed.references || []) {
  if (r.kind === 'experience') {  // ← r 类型是 ReferenceItem，r.kind 视为已存在
```
若 main 因 bug 返回了缺 `kind` 的 exp reference（或 kb/exp 混返——见 WR-01），`r.kind` 为 `undefined`，循环跳过，**静默丢引用**。

更关键：line 171 `const sid = (r as { sourceSessionId?: string | null }).sourceSessionId`——`ReferenceItem` 联合里 `experience` 分支**没有 `sourceSessionId` 字段**（types.ts:25），main 是「运行时多带」字段，TS 类型未声明。这是「类型断言当文档」反模式，未来 main 改字段名 renderer 不会编译报错。

**Fix:**
- 把 `sourceSessionId` 显式加入 `ReferenceItem` 的 `experience` 分支类型（既然 main 必返）；
- `exp_answer` 分支用窄化守卫 `if ('expId' in r && r.expId)` 而非 `r.kind === 'experience'`，对 schema 漂移更鲁棒。

---

### WR-05: `parsed.type` 多分支判断未覆盖 `confirm_required` 之外的「正常 reply 巧合是合法 JSON」

**File:** `src/components/pages/ai/useAIChat.ts:140-183`
**Issue:**
`try { JSON.parse(reply) }` 后只匹配 `confirm_required`/`kb_answer`/`exp_answer` 三种 `type`，其他 `type` 值（或巧合是合法 JSON 对象的纯文本回复，如 AI 回复 `{"note":"..."}`）会落到 line 183 `setMessages([...newMessages, { role:'assistant', content: reply }])`。

问题：纯文本回复巧合是合法 JSON 时（如 AI 回复 `{"status":"ok"}` 描述某状态），用户看到的是**带引号的原始 JSON 字符串**而非自然语言。这不是新 bug（kb_answer/exp_answer 之前就有），但 Phase 11 新增 `exp_answer` 后，`type` 命名空间扩大，碰撞概率上升。

**Fix:** 在 main 端给所有「控制类」回复加统一前缀字段（如 `_control: true`），renderer 仅在 `_control === true` 时按 type 分流；否则一律当自然语言。或反向：自然语言回复包一层 `{ type:'text', content }` 走同一通道。

---

### WR-06: `openExperience` 无错误处理，IPC 失败 / 经验已删时 Modal 卡在空态

**File:** `src/components/pages/ai/ChatMessageList.tsx:31-36`
**Issue:**
```typescript
const openExperience = (expId: string) => {
  window.api.experience.get(expId).then((e) => {
    setDetailExp(e)
    setDetailOpen(true)
  })
}
```
- 无 `.catch`：IPC 抛错（DB 锁、解密失败）成为 unhandled rejection；
- `getExperience` 返 `null`（经验被删 / id 错）时仍 `setDetailOpen(true)`，Modal 弹出空 `experience`，`ExperienceDetailModal` 内部访问 `experience.title` 等可能崩或显示空白；
- references 里的 `expId` 来自历史会话消息（持久化的 `exp_answer`），用户切换会话后该经验可能已被 `deleteExperience`/`invalidateExperience` 删除——此时点击必失败。

**Fix:**
```typescript
const openExperience = (expId: string) => {
  window.api.experience.get(expId).then((e) => {
    if (!e) { message.warning('该经验已不存在'); return }
    setDetailExp(e)
    setDetailOpen(true)
  }).catch((err) => message.error(`加载失败: ${err instanceof Error ? err.message : String(err)}`))
}
```

---

### WR-07: `retrieveForAnswer` 粗筛 `search` 分支传 `userMessage` 原文，LIKE 通配符未转义

**File:** `electron/services/experienceRetrieval.ts:65`
**Issue:**
```typescript
: { search: input.userMessage, includeInvalid: false, limit: MAX_CANDIDATES }
```
`listExperiences` 的 `search` 分支（`experienceService.ts:279-283`）：
```typescript
const kw = `%${opts.search}%`
params.push(kw, kw)
```
直接拼接用户输入到 LIKE 模式，**未转义 `%`/`_`/`\`**。用户提问含「100%」「a_b」时，`%` 被当通配符，`_` 匹配任意单字符——粗筛捞进无关经验（如问「100% 丢包」匹配到标题含「100X丢包」的经验），污染精排候选池。

注意：`experienceService` 的 `tags` 分支（line 295-302）已正确转义，但 `search` 分支未转义——这是 Phase 10 既存 bug，但 Phase 11 第一次把用户自由文本（`userMessage`）灌进 `search`，攻击面从「UI 输入框」扩到「AI 对话」，触发概率显著上升。

**Fix:** 在 `experienceService.ts:279-283` 的 search 分支补转义（与 tags 分支同模式）：
```typescript
if (opts.search) {
  conditions.push('(e.title LIKE ? OR e.content LIKE ?)')
  const esc = opts.search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  params.push(`%${esc}%`, `%${esc}%`)
  // SQL 需追加 ESCAPE '\\'
}
```

---

### WR-08: `INJECT_LIMIT` 截断在阈值过滤后，但「等分并列」时按数组顺序取前 N 不稳定

**File:** `electron/services/experienceRetrieval.ts:78-81`
**Issue:**
```typescript
const passed = entries
  .filter((e) => e.score >= RELEVANCE_THRESHOLD)
  .sort((a, b) => b.score - a.score)  // 稳定排序，但同分保持原序
  .slice(0, INJECT_LIMIT)
```
当多条候选同分（LLM 倾向给 0.8/0.9 等圆整分），`sort` 稳定但顺序取决于 LLM 输出顺序（非确定）。同一问题在不同时间检索，可能因 LLM 输出顺序不同而注入不同的 5 条——`incReuseCount` 累加到不同经验，reuse_count 排名漂移。

非致命（检索结果本身就有随机性），但与「经验复用计数反映真实价值」语义有冲突。

**Fix:** 二级排序加确定性 tiebreaker（如 `exp_id` 字典序）：
```typescript
.sort((a, b) => b.score - a.score || a.exp_id.localeCompare(b.exp_id))
```

---

## Info

### IN-01: `RELEVANCE_THRESHOLD` 与 `rerank` 拆两条 import 语句

**File:** `electron/services/experienceRetrieval.ts:4-5`
**Issue:**
```typescript
import { rerank } from './experienceRerank'
import { RELEVANCE_THRESHOLD } from './experienceRerank'
```
应合并为一条。INFO 级——风格问题，无功能影响。
**Fix:** `import { rerank, RELEVANCE_THRESHOLD } from './experienceRerank'`

---

### IN-02: `experienceRetrieval.test.ts` 用例 23 的 `invalid_at` 时间格式与生产写入路径不一致

**File:** `electron/services/experienceRetrieval.test.ts:271`
**Issue:**
```typescript
const past = new Date(Date.now() - 86400000).toISOString().replace('T', ' ').slice(0, 19)
```
构造的 `past` 是 `YYYY-MM-DD HH:MM:SS`（localtime，CR-02 契约格式）。但生产 `invalidateExperience` 用 `datetime('now','localtime')` 写——也是 localtime。两者格式一致，但测试用 `Date.now() - 86400000` 是 UTC 毫秒转 ISO 再 replace，**时区偏移**：`toISOString()` 返 UTC，slice 后是 UTC 时间字符串，与 localtime 比较差 8 小时（中国时区）。测试断言只判「已过期剔除」，8 小时偏移不影响「昨天」判定，但若有人复用此模式构造「刚刚过期 1 分钟」用例会失败。
**Fix:** 用 `new Date(Date.now() - 86400000 - new Date().getTimezoneOffset() * 60000).toISOString()` 或直接硬编码字符串。

---

### IN-03: `ChatMessageList` 中 `book`/`session` 引用点击无 hover 反馈且无 keyboard 可达性

**File:** `src/components/pages/ai/ChatMessageList.tsx:53-79`
**Issue:**
经验/会话引用用 `<div onClick>` 实现，无 `role="button"`/`tabIndex`/`onKeyDown`——键盘用户无法触发，屏幕阅读器不识别为可交互。`cursor: pointer` 仅视觉提示。INFO 级（无功能 bug，a11y 缺陷）。
**Fix:** 改用 `<button>` 或加 `role="button" tabIndex={0} onKeyDown`。

---

### IN-04: `rerank` 函数内 `lastError` 初始值 `'unknown'` 永不显示（要么覆盖要么 throw 前必有 result）

**File:** `electron/services/experienceRerank.ts:127-134`
**Issue:**
`lastError = 'unknown'` 是死值——循环内每次迭代必赋值 `lastError = result.error`（`result.ok` 为 true 时已 return），所以 `throw new Error(...${lastError})` 永远显示真实错误。但若 `callAI` 自身 throw（网络错），异常直接冒泡，**不进 retry**——`for` 循环内 `await callAI` 抛出未被 catch，循环中断，line 134 的 throw 不执行。
后果：精排因网络抖动一次失败就直接冒泡到 `ai.chat` 顶部 try/catch（line 743）→ 经验检索静默降级为不注入。这其实符合 D-11-9「不阻塞主路径」，但**与注释「已重试 N 次」语义不符**——网络错根本没重试。
**Fix:** 若希望网络错也重试，循环内包 try/catch：
```typescript
for (let attempt = 1; attempt <= MAX_RERANK_RETRIES; attempt++) {
  try {
    const raw = await callAI(config, messages)
    const result = validateRerank(raw, candidateExpIds)
    if (result.ok) return result.entries
    lastError = result.error
  } catch (e: any) {
    lastError = 'callAI 异常: ' + (e?.message || String(e))
  }
}
throw new Error(`AI 精排失败（已重试 ${MAX_RERANK_RETRIES} 次）：${lastError}`)
```
否则更新注释明确「只重试 schema 失败，网络错即时冒泡」。

---

_Reviewed: 2026-08-06_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
