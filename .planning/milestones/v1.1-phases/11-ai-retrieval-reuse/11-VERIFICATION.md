---
phase: 11-ai-retrieval-reuse
verified: 2026-08-06T13:35:00Z
status: passed
score: 10/10 truths verified
overrides_applied: 0
human_verification:
  - test: "与 Phase 10 published 经验对话提问，AI 回答末尾渲染来源列表（经验 📖 + 会话 💬 引用）"
    expected: "末尾出现「参考来源：」分隔区，列出经验引用；若该经验有 source_session_id 同时列出会话引用"
    why_human: "renderer UI 渲染 + 真 LLM 端到端联调（需配 AI Key 与已发布经验数据），grep/tsc/vitest 无法验证视觉与点击流"
  - test: "点击经验引用 → 打开 ExperienceDetailModal；点击会话引用 → 打开 SessionMessagesModal"
    expected: "Modal 弹出经验详情（标题/分类/attrs/复用次数/最后验证时间）/ 会话原文消息列表，可关闭"
    why_human: "DOM 点击 + Modal 视觉 + IPC 异步拉取的真机行为，自动化断言不到"
  - test: "命令失支持经验（unsupported=true）显「⚠ 命令已失支持」warning Tag"
    expected: "经验引用行旁出现 antd Tag warning 色（金色）标注，不引新自定义色"
    why_human: "颜色与 Tag 视觉、unsupported 字段在真实命令扫描下的取值需真机观察"
---

# Phase 11: AI Retrieval & Reuse Verification Report

**Phase Goal:** 后续任意 AI 对话中，AI 自动检索并引用相关经验辅助回答，且复用前即时验证证据（命令白名单/有效期）仍成立、过期/失效自动降权剔除，回答附可回查的引用来源。
**Verified:** 2026-08-06T13:35:00Z
**Status:** passed（UAT 2026-08-06 真机通过，见 11-HUMAN-UAT.md；UAT 期发现 2 个 gap 已 commit 8af468b 修复 + 1 个 follow-up 记 HUMAN-UAT Gaps）
**Re-verification:** No — initial verification（无前置 VERIFICATION.md）

## Goal Achievement

### Observable Truths

合并来源：ROADMAP.md Phase 11 Success Criteria（4 条契约）+ 11-01/11-02 PLAN must_haves truths。

| #   | Truth (来源) | Status     | Evidence（file:line） |
| --- | ----------- | ---------- | -------------------- |
| 1   | SC1 RETRIEVE-01：每轮 AI 对话自动预取经验（chat 入口调 retrieveForAnswer，不靠 AI 自主标记） | ✓ VERIFIED | `electron/services/ai.ts:725-745`（chat() 入口 b 自动预取，try/catch 隔离，不靠 [EXP_SEARCH] 标记）；调用点 `await retrieveForAnswer({ userMessage, deviceIds })` :730 |
| 2   | SC1 RETRIEVE-01：SQL 粗筛（listExperiences search/deviceId）+ LLM 精排强 schema + 阈值过滤 | ✓ VERIFIED | `experienceRetrieval.ts:71-89` 粗筛两分支 + 精排 + `score >= RELEVANCE_THRESHOLD`；`experienceRerank.ts:33-141` 强 schema prompt + validateRerank Drift Gate + 重试 |
| 3   | SC1 RETRIEVE-01：经验正文注入正式 callAI context | ✓ VERIFIED | `ai.ts:731-735` 命中即把经验正文拼进 `systemPrompt`，单次 `callAI(config, fullMessages)` (:752) 即带经验答 |
| 4   | SC2 RETRIEVE-02：read-time 两项验证 commandSafety 白名单 + 有效期 invalid_at | ✓ VERIFIED | `experienceRetrieval.ts:98-108`：(a) `row.invalid_at` 失效剔除 (b) `CMD_EXTRACT_RE` 提取 + `isCommandAllowed(c, whitelist).allowed` 逐条验 |
| 5   | SC2 RETRIEVE-02：命令失支持降权 unsupported=true 标注、有效期失效剔除 | ✓ VERIFIED | `experienceRetrieval.ts:101`（失效 `continue` 剔除）；`:108` `unsupported = cmds.length > 0 && cmds.some(...)`（保守降权不剔除）；renderer Tag 渲染 `ChatMessageList.tsx:66-68` |
| 6   | SC2 RETRIEVE-02：命中刷新 incReuseCount/touchLastVerifiedAt，不阻塞主路径（D-11-9） | ✓ VERIFIED | `experienceRetrieval.ts:111-116` try/catch + console.warn 兜底；`ai.ts:743-745` 整体 try/catch 异常 expReferences=[] 继续答；test 27 断言 |
| 7   | SC3 RETRIEVE-03：回答附 references 来源（经验 exp_id + 会话 sessionId），renderer 可点击回查 | ✓ VERIFIED | `ai.ts:828-846` 返 `{type:'exp_answer', content, references}`（exp+session 元数据）；`useAIChat.ts:164-181` 消费 exp_answer；`ChatMessageList.tsx:57-83` 按 kind 分流渲染 + openExperience/openSession 点击触发 |
| 8   | SC4：检索默认 includeInvalid=false 只命中有效经验（与浏览页软失效一致） | ✓ VERIFIED | `experienceRetrieval.ts:72-73` 两分支均 `includeInvalid: false`；叠加 `status:'published'`（CR-01 fix）双过滤；test 19/20/23 断言 |
| 9   | 红线③：检索池真只含 published 经验（draft 不进检索池）— CR-01 修复点 | ✓ VERIFIED | `experienceRetrieval.ts:68-73` 两分支强制 `status: 'published'`；test 19 `opts.status==='published'` + test 20 search 分支同样断言；Review Remediation 段 commit 8789fce 闭环 |
| 10  | 红线：零迁移零新表（D-11-5）/ 精排+编排 service 函数式无 class 无 MK / renderer 永不收 attrs 密文 | ✓ VERIFIED | `migrations.ts:16` `MIGRATION_HEAD = 10`（Phase 10 值，Phase 11 零迁移）；两 service docstring 明示函数式无 class 无 MK，实际代码 grep `class `/`encField`/`decField` 仅 docstring 字面提及零实际调用；references 字段（`ai.ts:831/844`）只含 `expId/title/sourceSessionId/unsupported` 元数据，无 attrs 密文 |

**Score:** 10/10 truths verified

### CR-01 修复核实（用户指定重点）

| 检查项 | 位置 | 结果 |
| ------ | ---- | ---- |
| 粗筛强制 status:'published' | `experienceRetrieval.ts:72`（deviceId 分支）/ `:73`（search 分支） | ✓ VERIFIED 两分支均带 `status: 'published'` |
| listExperiences 接收 status 条件 | `experienceService.ts:274-277`（CR-01 报告引用） | ✓ 经验 service 仅在 `opts.status` 显式传入时加 SQL 条件——本期显式传值触发过滤 |
| test 断言 | `experienceRetrieval.test.ts:251`（test 19）/ `:261`（test 20） | ✓ `expect(opts.status).toBe('published')` 双分支断言 |
| Remediation commit | 11-REVIEW.md:29 `commit 8789fce` | ✓ 已闭环 |

红线③「AI 产出永远先进 draft 人工确认才 published」守住——draft 草稿不会进检索池被注入 systemPrompt 或被 incReuseCount 刷新。

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `electron/services/experienceRerank.ts` | 精排 LLM service（强 schema JSON + Drift Gate + 重试 + 反幻觉） | ✓ VERIFIED | 存在 + 函数式无 class 无 MK（grep 实际用法 0）+ 导出 `rerank/validateRerank/buildRerankPrompt/MAX_RERANK_RETRIES/RELEVANCE_THRESHOLD`（见 :16/:19/:41/:78/:120）+ CR-02 去重已加（:104-107 `seen` Set） |
| `electron/services/experienceRetrieval.ts` | 检索编排（粗筛→精排→阈值→验证→刷新→返元数据） | ✓ VERIFIED | 存在 + 函数式 + 导出 `retrieveForAnswer/RetrieveInput/RetrieveResult/INJECT_LIMIT/MAX_CANDIDATES`（:25/:27/:29/:34/:55）+ CR-01 status:'published' 已落（:72-73） |
| `electron/services/experienceRetrieval.test.ts` | 编排+精排单测 | ✓ VERIFIED | 存在 + 31 用例全绿（vitest run 退出 0）；含 CR-01（test 19/20）/ CR-02（test 9b）/ WR-03（test 24/25）/ WR-06/null 判断覆盖 |
| `electron/services/ai.ts` | chat() 自动预取串联 + exp_answer 返回 | ✓ VERIFIED | import :13 + 调用 :730 + systemPrompt 注入 :735 + expReferences 填充 :736-741 + exp_answer 返回 :828-846（含 WR-01 kb+exp 合并分支） |
| `src/components/pages/ai/types.ts` | ChatMsg.references 联合类型（kb/experience/session） | ✓ VERIFIED | :23-26 `ReferenceItem` 联合三态 + ChatMsg.references 改为 `ReferenceItem[]`（:35） |
| `src/components/pages/ai/useAIChat.ts` | exp_answer 返回类型消费 + references 注入 | ✓ VERIFIED | :164-181 exp_answer 分支消费 camelCase 字段（expId/sourceSessionId）+ session 引用拆出（:172-173）+ kb kind 补全（:155-159） |
| `src/components/pages/ai/ChatMessageList.tsx` | 末尾来源列表 + 点击回查 Modal | ✓ VERIFIED | renderRef 三分流 :48-83 + ExperienceDetailModal/SessionMessagesModal import+JSX :6-7/:146-147 + openExperience null 判+catch :33-39（WR-06 fix）+ unsupported Tag :66-68 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `ai.ts chat()` | `experienceRetrieval.ts retrieveForAnswer` | chat 入口自动预取（b 方案） | ✓ WIRED | `ai.ts:730` `await retrieveForAnswer({ userMessage, deviceIds })` |
| `experienceRetrieval.ts` | `experienceService.ts listExperiences/incReuseCount/touchLastVerifiedAt` | 粗筛 + 命中刷新 | ✓ WIRED | `:74` listExperiences / `:112-113` incReuseCount + touchLastVerifiedAt |
| `experienceRetrieval.ts` | `experienceRerank.ts rerank` | 粗筛候选喂精排 | ✓ WIRED | `:83` `await rerank({ userMessage, candidates })` |
| `experienceRetrieval.ts` | `commandSafety.ts isCommandAllowed` | read-time 命令验证 | ✓ WIRED | `:108` `cmds.some((c) => !isCommandAllowed(c, whitelist).allowed)` |
| `ai.ts` | renderer `useAIChat` exp_answer JSON | ai:chat 返回 JSON | ✓ WIRED | `ai.ts:833/842-845` JSON.stringify({type:'exp_answer',...}) → `useAIChat.ts:164` `parsed.type === 'exp_answer'` |
| `ChatMessageList.tsx` | `ExperienceDetailModal.tsx`（Phase 10 复用） | 点击经验引用 → experience.get 拉 Modal | ✓ WIRED | `ChatMessageList.tsx:33` `window.api.experience.get(expId)` + `:146` `<ExperienceDetailModal open=.../>` |
| `ChatMessageList.tsx` | `SessionMessagesModal.tsx`（Phase 9 复用） | 点击会话引用 → Modal sessionId 直传 | ✓ WIRED | `:42-45` openSession setSessionModalId + `:147` `<SessionMessagesModal open=... sessionId=.../>` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `useAIChat.ts` `messages[].references` | `parsed.references` | `window.api.ai.chat()` → `ai.ts chat()` 返回 JSON | 真（ai.ts:844 references 来自 expReferences，来自 retrieveForAnswer.injected，来自 listExperiences DB 行） | ✓ FLOWING |
| `ai.ts` `expReferences` | `retrieval.injected` | `retrieveForAnswer()`（listExperiences DB → rerank LLM 打分 → 验证过滤） | 真（DB 查询 + LLM 评分，非硬编码空数组；空库短路返空是正常降级） | ✓ FLOWING |
| `experienceRetrieval.ts` `injected[].content` | `row.content` | `listExperiences()` rows（experienceService 已解密 attrs 明文） | 真（Phase 7/10 已验证 rowToExperience 解密链） | ✓ FLOWING |
| `ChatMessageList.tsx` `detailExp` | `window.api.experience.get(expId)` | `experience:get` secure IPC → `getExperience()` DB | 真（与浏览页详情同 IPC 路径，Phase 10 已验证） | ✓ FLOWING |

无 HOLLOW_PROP / STATIC / DISCONNECTED。

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| 编排+精排单测全绿 | `npx vitest run electron/services/experienceRetrieval.test.ts` | 31 passed (1 file) | ✓ PASS |
| 全量单测零回归 | `npx vitest run` | 231 passed (16 files) | ✓ PASS |
| 严格类型 gate | `npx tsc -p tsconfig.web.json` | EXIT=0（0 error，strict + noUnusedLocals） | ✓ PASS |
| CR-01 status:'published' 真落代码 | `grep "status: 'published'" experienceRetrieval.ts` | 两分支命中（:72/:73） | ✓ PASS |
| CR-02 validateRerank 去重 | grep `seen.has` experienceRerank.ts | 命中 :104 | ✓ PASS |
| D-11-5 零迁移 | grep `MIGRATION_HEAD` migrations.ts | = 10（Phase 10 值，未递增） | ✓ PASS |
| WR-07 LIKE 转义 | grep `ESCAPE` experienceService.ts | :283/:300 双处（search + tags） | ✓ PASS |
| 函数式无 class | grep 实际用法（非 docstring） | 两 service 零 `class `/`encField`/`decField`/`MK` 实际调用 | ✓ PASS |
| references 无 attrs 密文 | grep `attrs` 在 ai.ts references map | references 只含 expId/title/sourceSessionId/unsupported 元数据 | ✓ PASS |

注：`npm run build`（vite renderer）+ `npm run build:electron-main`（esbuild main）门禁 SUMMARY 自报全绿，本次未重跑（vite/esbuild 较重），但 tsc=0 + 231 vitest 全绿已为 renderer/main 编译可行性强证据；若需 100% 复核可在人工 checkpoint 时附带跑一次。

### Probe Execution

无 `scripts/*/tests/probe-*.sh` 约定（本项目 service 层验证走 vitest，无 probe 机制）。SKIPPED（项目无 probe 约定）。

### Requirements Coverage

RETRIEVE-01/02/03 全部 trace 到 REQUIREMENTS.md 第 40-42 行（Phase 11 标注 Complete），traceability 表 :93-95 标 Complete。

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| RETRIEVE-01 | 11-01 | 后续 AI 对话自动检索相关经验并引用辅助回答（SQL 粗筛 + LLM 精排） | ✓ SATISFIED | Truth #1/2/3（ai.ts 自动预取 + experienceRetrieval 粗筛+精排 + 正文注入） |
| RETRIEVE-02 | 11-01 | AI 复用经验前即时验证（命令白名单/有效期），过期失效降权或剔除 | ✓ SATISFIED | Truth #4/5/6（read-time 两项验证 + 命令失支持降权 + 有效期失效剔除 + 命中刷新不阻塞） |
| RETRIEVE-03 | 11-02 | AI 回答附引用来源（哪条经验/哪次会话），可回查 | ✓ SATISFIED | Truth #7（exp_answer references 经验+会话 + ChatMessageList 点击回查 Modal 复用） |

无 orphaned requirement（REQUIREMENTS.md Phase 11 三 REQ 全在 plan frontmatter 显式 claim）。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| experienceRerank.ts | 10 | docstring 含字面 `class`/`MK`（Pattern 1b 自描述，非实际用法） | ℹ️ Info | 无功能影响——grep `class `/`encField`/`decField`/`\bMK\b` 实际代码用法为 0，仅注释字面提及 |
| experienceRetrieval.ts | 20 | 同上 docstring 字面 | ℹ️ Info | 同上 |
| experienceRetrieval.ts | 4-5 | IN-01：rerank 与 RELEVANCE_THRESHOLD 拆两条 import（可合并） | ℹ️ Info | 风格问题零功能影响，11-REVIEW 留二期 |
| ChatMessageList.tsx | 57-83 | IN-03：经验/会话引用用 `<div onClick>` 无 role/tabIndex/onKeyDown | ℹ️ Info | a11y 缺陷（非功能 bug），11-REVIEW 留二期 |
| experienceRerank.ts | 134-141 | IN-04：lastError='unknown' 死值；网络错未包 try 不重试即时冒泡 | ℹ️ Info | 符合 D-11-9（不阻塞主路径），但注释「已重试 N 次」语义对网络错不准；留二期 |

零 TBD/FIXME/XXX 阻塞性 debt marker（grep 三核心文件均无命中）。11-REVIEW 8 项 WARNING 中 6 项已 commit 8789fce 闭环（CR-01/CR-02/WR-01/WR-03/WR-06/WR-07），剩 WR-02/WR-04/WR-05/WR-08 + 4 INFO 均为非阻塞性二期项，已记 follow-up。

### Human Verification Required

来源：11-01-PLAN.md `<verification>` 人工验证段 + 11-02-PLAN.md `<verification>` end-of-phase checkpoint + verifier 自身 UI 流分析。

#### 1. AI 回答末尾渲染来源列表

**Test:** 与 Phase 10 published 经验（建议带 source_session_id 的 troubleshooting 经验）对话提问，触发经验注入后查看 AI 回答末尾
**Expected:** 末尾出现「参考来源：」分隔区，列出 📖 经验引用；若该经验有 source_session_id 同时列出 💬 会话引用
**Why human:** renderer UI 视觉渲染 + 真 LLM 端到端联调（需配 AI Key 与已发布经验数据），grep/tsc/vitest 无法验证渲染外观与 LLM 真实输出形态

#### 2. 点击引用打开复用 Modal

**Test:** 在 AI 回答末尾点击 📖 经验引用行；再点击 💬 会话引用行
**Expected:** 经验引用点击弹出 ExperienceDetailModal（标题/分类/attrs/复用次数/最后验证时间）；会话引用点击弹出 SessionMessagesModal（会话原文消息列表）；均可关闭
**Why human:** DOM 点击 + Modal 视觉 + IPC 异步拉取的真机行为；自动化断言不到 Modal 内容与交互

#### 3. 命令失支持 warning Tag

**Test:** 触发一条 unsupported=true 的经验引用（白名单未含经验正文提取到的命令首词）
**Expected:** 经验引用行旁出现 antd Tag warning 色（金色）「⚠ 命令已失支持」标注，不引新自定义 hex 色
**Why human:** 颜色与 Tag 视觉、unsupported 字段在真实命令扫描下的取值需真机观察

### Gaps Summary

无 BLOCKER / 无 FAILED truth。所有 10 条 must-have truth 全部 VERIFIED（含用户重点核实的 CR-01 红线③ status:'published' + CR-02 去重 + WR-07 LIKE 转义 + 函数式无 class 无 MK + 零迁移 + references 无 attrs 密文）。RETRIEVE-01/02/03 三 REQ 全 SATISFIED。

状态为 `human_needed`：自动化层（tsc/vitest/数据流/key_link）全绿，但 phase goal 的「回答附可回查的引用来源」端到端 UX 流（点击回查 Modal / unsupported Tag 视觉 / 末尾来源列表渲染）属 11-01/11-02-PLAN 显式声明的 end-of-phase human checkpoint，必须人工在真机带 AI Key + published 经验数据下走一遍方可闭环。3 项 human verification 项已列。

---

_Verified: 2026-08-06T13:35:00Z_
_Verifier: Claude (gsd-verifier)_
