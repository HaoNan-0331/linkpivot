---
phase: 08-ai-drafting-pipeline
verified: 2026-08-02T13:50:00Z
status: human_needed
score: 5/5 must-haves verified (1 override-equivalent acceptance noted inline)
overrides_applied: 0
human_verification:
  - test: "在配置真实 AI 的运行 app 中，于 AI 对话窗发送若干含凭证/IP/MAC 的运维消息后点「经验总结」按钮，确认产出 1~N 条 draft 草稿且 IPC 返回 DraftingResult.created/updated 计数 ≥1"
    expected: "antd message.success「经验总结完成：新增/更新 N 条草稿（草稿待确认）」；DB experiences 表新增 status='draft' 行；落库行 content 不含 [CMD]/[KB_SEARCH]"
    why_human: "需真实 LLM provider + Electron 主进程 + DB，vitest 已 mock callAI 无法验真实 LLM 输出与端到端落库"
  - test: "对一段纯闲聊无可总结经验的会话点「经验总结」，确认 UI 提示「该会话无可总结经验」且不落空草稿"
    expected: "antd message.info 提示；experiences 表无新增 draft 行（empty=true 不强产）"
    why_human: "「无可总结」判定依赖真实 LLM 返空数组，单测用 mock 无法替代真实语义判定"
  - test: "对已含同分类存量的会话点「经验总结」，确认 UPDATE 草稿在 DB 行 duplicate_of_exp_id 列正确写入命中 exp_id（标注命中条目）"
    expected: "experiences 表新增行 status='draft' 且 duplicate_of_exp_id 列 = 同分类某存量行 id；UI 提示「更新 N 条草稿」"
    why_human: "需真实 LLM 复判 + 真实存量 DB；单测 mock judgeVerdicts 返值，无法验 LLM 真实复判质量"
  - test: "断网或临时把 apiKey 设为无效后点「经验总结」，确认重试 3 次后 IPC throw 经 secure 脱敏透出，且原会话可再次点击重跑（追加不覆盖）"
    expected: "antd message.error 显示脱敏后错误；后续网络恢复后再次点击生独立 draft 行（source_session_id 相同但 id 不同）"
    why_human: "限流/失败/重试的运行时行为与时间敏感，需真实网络故障注入"
---

# Phase 8: AI Drafting Pipeline — Verification Report

**Phase Goal:** 用户在与 AI 对话完成后点「经验总结」，AI 自动回顾整段会话、脱敏、查重、按固定分类模板结构化起草 1~N 条 draft 态草稿——不污染存量、不泄密、不乱造分类。
**Verified:** 2026-08-02T13:50:00Z
**Status:** human_needed
**Re-verification:** No — initial verification（CODEBASE = master HEAD，含 08-REVIEW.md 13 finding 中 CR-01/CR-02 + WR-02/03/04/06 的修复 commit fe0715b 后状态）

## Verification Scope

CODEBASE 状态：master HEAD（commit dac3943 及之前），即 08-REVIEW.md 指出的 2 个 Critical（CR-01 PII 自然语言连接词漏判 / CR-02 `key` 跨词误匹配）+ 关键 Warning（WR-02 空 catch / WR-03 NOOP 漏落库 / WR-04 AIPage toUpperCase 防空 / WR-06 PII 负向用例缺失）**均已修复**并落测试回归。本验证针对修复后代码。

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth (SC) | Status | Evidence |
|---|------------|--------|----------|
| 1 | 用户点「经验总结」后 AI 回顾 sessionId 全部消息产出 1~N 条 draft；无可总结提示不强产空条目 | ✓ VERIFIED | `ChatInput.tsx:41-50` 渲染「经验总结」Button（ThunderboltOutlined）+ `useAIChat.ts:168-189` handleSummarize 调 `window.api.experience.summarizeSession` → IPC `experienceDraftingIpc.ts:19-24` secure 包装 → `experienceDrafting.ts:70 summarizeSessionForUi` 读 `getChatHistory(sessionId)`（全消息）→ `draftSession` 产出 drafts[] → `draftsA.length===0` 返 `empty=true`（行 94，SC1 不强产）→ `useAIChat.ts:175` `message.info('该会话无可总结经验')`。单测 experienceDrafting.test.ts case 8 验 draftSession 返 [] → empty=true 不调 createExperience。**端到端运行时确认需人工（live LLM）** |
| 2 | 送 LLM 前会话正文 PII 自动脱敏，LLM 永不收明文凭证/IP | ✓ VERIFIED | `experienceDrafting.ts:85 maskConversationText(conversationText)` 在行 91 `draftSession({maskedConversation,...})` 之前执行；`draftingService.ts:84 input.maskedConversation` 只引用脱敏后文本入 prompt。`piiMask.ts:29-32 CRED_RE` 含 CR-01 连接词模式（is/are/was/为/是/等于）+ CR-02 `key(?![a-z])` 后置词界 + `(?<![A-Za-z0-9_])` 前置 lookbehind；piiMask.test.ts:39-70 含 CR-01（`password is hunter2`→`password is ****`、`token 为 abc-secret`、`密码 是 p@ss123`、`the api key is sk-abc123`）+ CR-02（`monkey=bar`→原样、`keyboard shortcut`→原样）回归单测全 PASS。LLM 明文泄漏路径已堵 |
| 3 | 起草前按设备/分类查存量，AI 判 ADD/UPDATE/NOOP，UPDATE/疑似重复标注命中条目 | ✓ VERIFIED | `duplicateDetector.ts:33-61 findExistingForDraft`：有 deviceIds→按 category+deviceId 查 listExperiences 去重；无→全库同分类；返 `{exp_id, title, content_preview(≤150)}` 喂 LLM。`experienceDrafting.ts:96-104` 阶段 B 按 distinct category 调 findExistingForDraft（≤50/分类截断 MAX_EXISTING_PER_CATEGORY=50）→ judgeVerdicts 复判覆盖 verdict+dupId。`draftingService.ts:296-315 judgeVerdicts` 回填 verdict + duplicate_of_exp_id；WR-03 已修（行 305-315：LLM 未覆盖且同分类有存量→保守判 NOOP 宁漏勿重）。落库：ADD→createExperience(dupId=null) / UPDATE→createExperience(duplicateOfExpId=命中id) / NOOP→不落库（experienceDrafting.ts:111-115）。SC3「UPDATE 标注命中条目」= duplicate_of_exp_id 列写入 + DraftingResult.updated[].duplicate_of_exp_id 回传 |
| 4 | AI 输出按固定枚举分类 + 分类专属模板强制 JSON schema，分类不超枚举、字段不瞎编、缺数据标 gap | ✓ VERIFIED | `draftingService.ts:23 VALID_CATEGORIES` 4 枚举锁；行 119 `!VALID_CATEGORIES.includes(d.category)` fail；行 124-128 troubleshooting severity 5 枚举校验；行 129-142 duplication_verdict ADD/UPDATE/NOOP 枚举 + ADD/UPDATE dupId 规则；行 143-150 W-2 confidence 0-1 边界（'85%'→0.85、'high'→fail、1.5→fail）；行 70-73 SYSTEM_PROMPT 明确缺数据填 "gap" + 分类固定枚举 + 反 [CMD]/[KB_SEARCH]；fail 整体重试 MAX_DRAFT_RETRIES=3（行 178-184）。draftingService.test.ts 23 case 覆盖 happy/包裹剥离/非数组重试/超枚举重试/缺 severity 重试/第2次成功/空数组/demoMode/未配 AI/ADD-UPDATE-NOOP dupId 规则 + W-2 4 sub-case + judgeVerdicts 2 case，全 PASS |
| 5 | 同一 session 可多次总结（追加不覆盖），LLM 限流/失败可重试不丢总结（断点续传 source_session_id 幂等） | ✓ VERIFIED | `experienceDrafting.ts:123 sourceSessionId: sessionId` 每条 draft 透传；createExperience 每次生独立 uuid（`experienceService.ts:171 const id = uuidv4()`）——同 session 两次总结各生独立行 id，source_session_id 相同但行 id 不同（追加不覆盖）。experienceDrafting.test.ts case 6（SC5）验两次 summarize 各生 exp-A/exp-B 不同 uuid。重试：draftSession 行 178-184 + judgeVerdicts 行 293-320 各重试 3 次不丢总结；source_session_id 幂等支持用户重复点按钮重跑（useAIChat.ts:168-189 summarizing 状态防并发但不阻止重跑） |

**Score:** 5/5 truths verified（自动化层全 VERIFIED；4 项运行时行为需人工 live-LLM 复核）

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `electron/database/migrations.ts` | v9 迁移加 duplicate_of_exp_id 列（hasColumn 幂等） | ✓ VERIFIED | `MIGRATION_HEAD=9`（行 16）；`v9` 函数（行 249-261）含 `hasColumn` 守卫 + `db.transaction` + ALTER ADD COLUMN TEXT；MIGRATIONS 数组追加 version:9（行 272） |
| `electron/database/init.ts` | fresh-install DDL 含 duplicate_of_exp_id 列 | ✓ VERIFIED | 行 305 `duplicate_of_exp_id TEXT,` 与迁移逐字一致 |
| `electron/utils/piiMask.ts` | 分级 PII 脱敏（凭证/IPv4/MAC），4 导出 | ✓ VERIFIED | maskCredentials/maskIpv4/maskMac/maskConversationText 全导出；CR-01 连接词 + CR-02 词界修复落地；串联顺序 cred→ipv4→mac |
| `electron/services/duplicateDetector.ts` | findExistingForDraft（同分类+设备查重） | ✓ VERIFIED | 函数式，复用 listExperiences 门面，PREVIEW_LEN=150，无加密裸调用 |
| `electron/services/experienceService.ts` | createExperience 扩展接受 duplicateOfExpId 单语句原子 | ✓ VERIFIED | `ExperienceInput.duplicateOfExpId?: string\|null`（行 89）；INSERT 含第 10 列 duplicate_of_exp_id 单语句原子（行 180-183），无 try/catch 吞错 |
| `electron/services/draftingService.ts` | draftSession + judgeVerdicts 两阶段 + validateDrafts/Verdicts | ✓ VERIFIED | 6 导出全落地（draftSession/judgeVerdicts/validateDrafts/buildDraftingPrompt/buildVerdictPrompt/validateVerdicts）；MAX_DRAFT_RETRIES=3；WR-03 修复（未覆盖 + 有存量→NOOP） |
| `electron/services/experienceDrafting.ts` | summarizeSessionForUi 两阶段编排 | ✓ VERIFIED | 读会话→脱敏→阶段A draftSession(existingSummaries=[])→阶段B findExistingForDraft 窄查→judgeVerdicts 复判→门面落库；WR-02 修复（relateDevice catch 内 createSystemLog + console.warn 兜底，行 134-145） |
| `electron/ipc/experienceDraftingIpc.ts` | experience:summarizeSession secure 包装 | ✓ VERIFIED | `secure(...)` 包装 + sessionId 非空字符串校验（行 19-24） |
| `electron/preload.ts` | experience.summarizeSession 白名单方法 | ✓ VERIFIED | 行 135 暴露 ipcRenderer.invoke('experience:summarizeSession') |
| `electron/main.ts` | 注册 registerExperienceDraftingIpc | ✓ VERIFIED | 行 30 import + 行 138 调用（紧跟 registerExperienceIpc 之后） |
| `src/types/electron.d.ts` | experience.summarizeSession + DraftingResult 类型声明 | ✓ VERIFIED | 行 10 import DraftingResult + 行 213 summarizeSession 类型 |
| `src/types/experience.ts` | DraftingResult DTO | ✓ VERIFIED | 行 85+ DraftingResult interface |
| `src/components/pages/ai/ChatInput.tsx` | 「经验总结」Button（loading/disabled） | ✓ VERIFIED | 行 41-50 条件渲染 Button，loading/disabled 守卫 |
| `src/components/pages/ai/useAIChat.ts` | handleSummarize + summarizing + canSummarize | ✓ VERIFIED | 行 31 summarizing state；行 168-189 handleSummarize；行 209 canSummarize = messages.length > 0 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| IPC handler | summarizeSessionForUi | import secure 调用 | ✓ WIRED | experienceDraftingIpc.ts:2 import + 行 23 调用 |
| experienceDrafting | ai.getChatHistory | import 读会话 | ✓ WIRED | experienceDrafting.ts:1 import + 行 75 调用 |
| experienceDrafting | piiMask.maskConversationText | import 脱敏 | ✓ WIRED | 行 2 import + 行 85 调用（draftSession 前） |
| experienceDrafting | duplicateDetector.findExistingForDraft | import 阶段B窄查 | ✓ WIRED | 行 3 import + 行 100 调用 |
| experienceDrafting | draftingService.draftSession + judgeVerdicts | import 两阶段 | ✓ WIRED | 行 4 import + 行 91/104 调用 |
| experienceDrafting | experienceService.createExperience + relateDevice | import 门面落库 | ✓ WIRED | 行 6 import + 行 118/133 调用 |
| experienceDrafting | systemLog.createSystemLog（WR-02） | import 日志 | ✓ WIRED | 行 8 import + 行 136 调用（relateDevice catch 内） |
| ChatInput | window.api.experience.summarizeSession | useAIChat.handleSummarize | ✓ WIRED | useAIChat.ts:172 调用 |
| IPC↔preload channel 三向 | 'experience:summarizeSession' | 字面量逐字 | ✓ WIRED | ipcMain.handle + ipcRenderer.invoke 字面量一致（types 用属性名无需字面量） |
| duplicateDetector | experienceService.listExperiences | import 复用门面 | ✓ WIRED | duplicateDetector.ts:1 import + 行 52/56 调用 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| summarizeSessionForUi | messages | getChatHistory(sessionId) SELECT * FROM chat_history + decField 解密 | ✓ DB 真实查询 | ✓ FLOWING |
| draftSession | maskedConversation | maskConversationText(conversationText) 真实脱敏 transform | ✓ 真实字符串 transform | ✓ FLOWING |
| judgeVerdicts | existingByCategory | findExistingForDraft→listExperiences SELECT 真实存量 | ✓ DB 真实查询 | ✓ FLOWING |
| createExperience 落库 | input | drafts[]（judgeVerdicts 真实 LLM 输出） | ✓ LLM 输出（mock 单测验证结构） | ✓ FLOWING（live-LLM 需人工） |
| DraftingResult 回传 | created/updated/noop | createExperience 返回 exp.id + drafts verdict | ✓ 真实落库行 id | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| tsc strict gate | `npx tsc -p tsconfig.web.json --noEmit` | EXIT 0 | ✓ PASS |
| Phase 8 单测 5 文件 | `npx vitest run piiMask duplicateDetector experienceService draftingService experienceDrafting` | 5 files / 91 tests PASS | ✓ PASS |
| 全量单测 | `npx vitest run` | 12 files / 146 tests PASS（含 CR-01/CR-02/WR-02/WR-03 回归） | ✓ PASS |
| B-1 反向守卫 | grep `UPDATE experiences SET duplicate_of_exp_id` / `getDatabase().prepare` / `updateExperience(` / `\b(encrypt\|decrypt)\(` in experienceDrafting.ts | 全 0 | ✓ PASS |
| callAI 签名不改 | grep `response_format\|json_object\|raw.json` in draftingService.ts | 0 | ✓ PASS |
| SC2 脱敏前置 | grep maskConversationText 行号（85）< draftSession 行号（91） | 85 < 91 | ✓ PASS |
| 真实 LLM 端到端 | （需运行 Electron + AI provider） | N/A | ? SKIP（人工） |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DRAFT-01 | 08-03 | 点「经验总结」AI 回顾整段会话产 1~N 条 draft | ✓ SATISFIED | ChatInput Button + summarizeSessionForUi 全消息回顾 + draftSession；无可总结→empty=true（SC1） |
| DRAFT-02 | 08-01, 08-03 | 会话 PII 送 AI 前自动脱敏 | ✓ SATISFIED | piiMask.ts 分级脱敏 + experienceDrafting.ts:85 maskConversationText 前置于 draftSession；CR-01/CR-02 修复 + 回归单测 |
| DRAFT-03 | 08-01, 08-03 | 起草前查存量判 ADD/UPDATE/NOOP，提示疑似重复 | ✓ SATISFIED | duplicateDetector.findExistingForDraft + judgeVerdicts 两阶段复判 + duplicate_of_exp_id 标注命中 |
| DRAFT-04 | 08-02 | 固定枚举分类 + 模板强制 JSON schema | ✓ SATISFIED | VALID_CATEGORIES 4 枚举锁 + severity 5 枚举 + verdict 3 枚举 + confidence W-2 边界 + 缺数据 'gap' + 重试 3 次 |

无 ORPHANED 需求（REQUIREMENTS.md 行 82-85 全 4 ID 映射 Phase 8 且全在 plan requirements 字段声明）。

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| draftingService.ts | 178-184 | draftSession 重试循环无指数退避 | ℹ️ Info | 设计决策（avoid 叠加等待），不阻塞 |
| draftingService.ts | 96-104 | extractJsonArray 首[末] 切片（IN-02） | ℹ️ Info | 靠重试兜底，非 bug |
| experienceService.ts | 178 | createExperience 不校验 dupId FK 存在性（IN-04） | ℹ️ Info | 有意决策（无 self-FK + 信任 LLM + Phase 9 兜底），Phase 9 需 UI 提示指向已删除 |
| piiMask.ts | 29,35,39 | 模块级 /g 正则跨调用复用（IN-01） | ℹ️ Info | 仅 .replace 使用安全，已加注释提示勿用于 .test/.exec |

无 🛑 Blocker、无 ⚠️ Warning（08-REVIEW 的 CR/WR 均已修复并回归）。

### Human Verification Required

见 frontmatter `human_verification`，共 4 项需 live LLM + Electron 运行时复核：

1. **真实 LLM 端到端起草** — 含凭证/IP/MAC 会话点按钮，确认产出 draft 且落库 content 无 [CMD]
2. **无可总结不强产** — 纯闲聊会话点按钮，确认 message.info 提示且不落空草稿
3. **UPDATE 标注命中** — 同分类存量会话点按钮，确认 duplicate_of_exp_id 列正确写入
4. **限流/失败/重试 + 断点续传** — 断网点按钮，确认 secure 脱敏透出 + 恢复后重跑追加不覆盖

**Why human:** vitest 全程 mock callAI/getChatHistory/listExperiences/createExperience，无法验真实 LLM 输出质量、真实 DB 落库、真实运行时点击交互与限流时间行为。

### Gaps Summary

无阻塞性 gap。代码层 5/5 SC 全 VERIFIED，DRAFT-01/02/03/04 全 SATISFIED，三绿门禁（tsc strict EXIT 0 / 146 vitest PASS / 含 CR-01/02 + WR-02/03/06 修复回归）全绿，所有 key link WIRED，B-1/callAI 反向守卫全 0，数据流无 HOLLOW/DISCONNECTED。

仅 4 项运行时行为（真实 LLM 起草质量、无可总结判定、UPDATE 命中标注、限流重试断点续传）需 live AI provider + Electron 手动 UI 复核，无法在自动化层验证——故 status = **human_needed**（per Step 9 decision tree：human verification section 非空 → human_needed，即便 truths 全 VERIFIED）。

**Note on 08-REVIEW.md findings:** 13 finding 中 2 Critical（CR-01/CR-02 PII 脱敏）+ 关键 Warning（WR-02 空 catch / WR-03 NOOP 漏落库 / WR-04 AIPage toUpperCase / WR-06 负向用例缺失）**均已修复**并落测试回归：
- CR-01：piiMask.ts:30 CRED_RE 含连接词模式 + piiMask.test.ts:39-52 4 回归 case
- CR-02：piiMask.ts:19 `key(?![a-z])` + :29 `(?<![A-Za-z0-9_])` lookbehind + piiMask.test.ts:60-70 2 回归 case
- WR-02：experienceDrafting.ts:134-145 relateDevice catch 内 createSystemLog + console.warn 兜底
- WR-03：draftingService.ts:305-315 judgeVerdicts 未覆盖 + 有存量→保守 NOOP
- WR-04：AIPage.tsx:84 `(d.connectionType \|\| 'unknown').toUpperCase()` 防空
- WR-06：piiMask.test.ts 含 CR-01/CR-02 全部负向用例

剩余 Info（IN-01~IN-04，WR-01/WR-05/WR-07）为非阻塞质量提示或被 CR 修复自然消解，不影响 phase goal 达成。

---

_Verified: 2026-08-02T13:50:00Z_
_Verifier: Claude (gsd-verifier)_
