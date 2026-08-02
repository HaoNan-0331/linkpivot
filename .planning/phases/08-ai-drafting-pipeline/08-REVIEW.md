---
phase: 08-ai-drafting-pipeline
reviewed: 2026-08-02T00:00:00Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - electron/database/init.ts
  - electron/database/migrations.ts
  - electron/ipc/experienceDraftingIpc.ts
  - electron/main.ts
  - electron/preload.ts
  - electron/services/draftingService.test.ts
  - electron/services/draftingService.ts
  - electron/services/duplicateDetector.test.ts
  - electron/services/duplicateDetector.ts
  - electron/services/experienceDrafting.test.ts
  - electron/services/experienceDrafting.ts
  - electron/services/experienceService.test.ts
  - electron/services/experienceService.ts
  - electron/utils/piiMask.test.ts
  - electron/utils/piiMask.ts
  - src/components/pages/AIPage.tsx
  - src/components/pages/ai/ChatInput.tsx
  - src/components/pages/ai/types.ts
  - src/components/pages/ai/useAIChat.ts
  - src/types/electron.d.ts
  - src/types/experience.ts
findings:
  critical: 2
  warning: 7
  info: 4
  total: 13
status: issues_found
---

# Phase 08: Code Review Report

**Reviewed:** 2026-08-02
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

审阅了 Phase 8「AI 起草管道」21 个文件：DB schema/migration、IPC 网关、4 个 service（draftingService / duplicateDetector / experienceDrafting / experienceService）、PII 脱敏 util、preload、renderer（AIPage / ChatInput / useAIChat / types）。

红线核查结果：
- **IPC 鉴权**（`experienceDraftingIpc.ts:19`）—— `secure(...)` 包装到位，sessionId 校验非空字符串 ✅
- **B-1 Service facade 红线** —— `duplicate_of_exp_id` 唯一写入路径是 `createExperience({duplicateOfExpId})`，编排层 `experienceDrafting.ts` 无裸 SQL UPDATE（grep 全仓确认）✅
- **B-2 原子性** —— `createExperience`（experienceService.ts:180-183）单语句 INSERT 同时写 draft 行 + dup_id，无 try/catch 吞错 ✅
- **callAI 签名未改** —— `(config, messages)` 一致 ✅
- **无 encrypt/decrypt 裸调用**（service 内只走 encField/decField）✅
- **LLM schema 门**（validateDrafts/validateVerdicts）—— category/severity/verdict 枚举锁 + W-2 confidence 边界 + 重试 3 次 ✅

但发现 **2 个 Critical（PII 脱敏漏判 + 中文关键词负向越界）** 与若干 quality 缺陷，详下。`tsc -p tsconfig.web.json --noEmit` 全绿（严格类型 gate 通过）。

## Critical Issues

### CR-01: PII 脱敏「password is hunter2」类自然语言凭据漏判（值只吞第一词）

**File:** `electron/utils/piiMask.ts:21-24, 34-42`
**Issue:** `CRED_RE` 关键词后的值模式为 `(?:\\s*[:=]\\s*|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`。当关键词后是自然语言连接词（如英文 "is"/"are"/"为"）而非 `:`/`=`/直接空格时，正则把连接词本身当成值吞掉，**真正的凭据值残留明文**送 LLM。

具体反例（D-04 红线"原始 chat_history 明文不动 / 送 LLM 前必须脱敏"被绕过）：
- `password is hunter2` → `password ****`（吞掉 "is"，"hunter2" 明文残留）
- `the api key is sk-abc123` → `the api ****`（吞 "is"，"sk-abc123" 残留）
- `token 为 abc-secret` → `token ****`（吞"为"，"abc-secret"残留）

运维会话常含"我的密码是 xxx""登录密钥是 xxx"等中文自然语言，`: = 直接空格` 三分隔符集合不足以覆盖。

**Fix:** 把"关键词 + 分隔符 + 值"模型升级为"关键词 + (可选连接词) + 值"，并显式排除常见连接词被误吞；或追加二次清洗：凡关键词后紧跟的连接词（is/are/was/为/是/等于），跳过它再吃下一个非空白 token。最低成本兜底——在 `maskConversationText` 末尾追加"关键词 + 空格 + 连接词 + 空格 + 非空白"二段模式：

```ts
const CRED_CONNECTOR_RE = new RegExp(
  `(?:${CRED_KEYWORDS})\\s+(?:is|are|was|to|for|为|是|等于)\\s+(\\S+)`,
  'gi'
)
// maskCredentials 内首次 replace 后追加：
out = out.replace(CRED_CONNECTOR_RE, (m, _v) => m.replace(/(\S+)$/, '****'))
```

并补对应单测（`password is hunter2` → 全脱敏），否则 D-04 形同虚设。

### CR-02: `CRED_KEYWORDS` 含裸词 `key` 触发跨词误匹配（"monkey=bar" / "keyboard" 被吞值）

**File:** `electron/utils/piiMask.ts:17-19`
**Issue:** 注释声称「key 需用 `(?![A-Za-z])` 词界防 apiKey/api_key 之外的误匹配（如 keyboard）」并称"自然限定"，但 **实际 `CRED_RE` 正则根本没有前置 `\b` 也没有后置词界断言**。后果：

- `monkey=bar` → `mon****`（"mon**key**=bar" 中的 key 被当成关键词，bar 被吞）
- `donkey hay` → `don****`（hay 被吞成 ****）
- `keyboard shortcut = ctrl+c` → `**** shortcut = ctrl+c`（"**key**board shortcut" 被 key 关键词匹配，分隔符 `\s+` 吃到空格，`\S+` 吃 "shortcut"）

这是双向问题：(a) **过度脱敏**降低 LLM 可读性（运维贴 "monkey 见树" 之类英文被破坏）；(b) **被吞的"值"位置错乱**使 CR-01 漏判更难诊断；(c) 注释与代码不一致，后续维护者按注释信任会被误导。

**Fix:** 在关键词组的 `key` 后追加负向词界，并在整个 CRED_RE 前置 `\b`：

```ts
// 把裸 'key' 替换为带负向边界的变体：key 后不能跟字母（排除 keyboard/keys），
// 前置 \b 排除 monkey/donkey/hockey 等。
const CRED_KEYWORDS = 'password|passwd|pwd|secret|token|apiKey|api_key|\\bkey(?![a-z])|密码|口令|凭证'
const CRED_RE = new RegExp(
  `\\b(?:${CRED_KEYWORDS})(?:\\s*[:=]\\s*|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`,
  'gi'
)
```

补单测：`monkey=bar` 原样返回、`keyboard shortcut` 原样返回、`api key: sk-x` 仍正确脱敏。

## Warnings

### WR-01: 反幻觉红线仅 prompt 提示，validateDrafts 未做代码层 `[CMD]`/`[KB_SEARCH]` 标记扫描

**File:** `electron/services/draftingService.ts:59-73, 106-164`
**Issue:** phase_context 把「禁止 [CMD]/[KB_SEARCH] 执行标记」列为反幻觉红线。实现层只在 system prompt 文字提示（行 61），`validateDrafts` 的 schema 门**不扫描** `title/content/reasoning` 是否含 `[CMD]`/`[KB_SEARCH]` 标记。LLM 不遵守提示（实际发生率不可忽视）时，含执行标记的草稿会被静默落库，Phase 9 浏览页/未来执行层可能误把它当命令执行。

**Fix:** validateDrafts 末尾加守卫：

```ts
const FORBIDDEN_MARKERS = ['[CMD]', '[KB_SEARCH]']
const joined = `${d.title}\n${d.content}\n${d.reasoning}`
for (const mk of FORBIDDEN_MARKERS) {
  if (joined.includes(mk)) {
    return { ok: false, error: `第 ${i + 1} 条含禁止标记 ${mk}（反幻觉红线）` }
  }
}
```

### WR-02: `experienceDrafting.ts` relateDevice 失败空 catch，注释称"日志兜底"但无任何日志

**File:** `electron/services/experienceDrafting.ts:129-131`
**Issue:** 注释写「关联失败不阻塞 draft 入库，日志兜底」，但实际 `catch {}` 完全空——无 `createSystemLog`、无 `console.warn`。设备关联失败（FK 违反、UUID 冲突等）无声丢失，运维感知不到 draft 已落但关联缺失，与项目"删除/失败动作必须可观测"惯例（main.ts:96-102 setDecryptFailureHandler 模式）相悖。

**Fix:** catch 内至少 `createSystemLog({ type: 'security', status: 'warning', errorMessage: \`experience \${exp.id} 关联设备 \${did} 失败: \${(e as Error).message}\` })`（沿用项目既有 systemLog 模式，try/catch 包外层防日志失败二阶吞错）。

### WR-03: judgeVerdicts 部分覆盖语义下，NOOP 命中草稿仍可能落库（违反"NOOP 不落库"）

**File:** `electron/services/draftingService.ts:294-302`, `electron/services/experienceDrafting.ts:110-114`
**Issue:** `judgeVerdicts` 文档明示「LLM 未返某 draft_index → 该条保守保持原 ADD 初值」（测试 12c 验证）。但 draftSession 阶段 A 给所有草稿的初值就是 ADD，若 LLM 阶段 B 本应判 NOOP 却因单条输出格式错被 validateVerdicts 整体判 fail（重试 3 次后 throw 整个 pipeline），OR LLM 漏返该 index → 草稿维持 ADD → **NOOP 命中被误当 ADD 落库**，产生重复 draft。这是 D-02 查重的核心失败模式，没有兜底。

**Fix:** 两种缓解二选一：
1. judgeVerdicts 对"有同分类存量但 LLM 未覆盖某 index"的情况，把未覆盖的草稿**保守判 NOOP**（而非 ADD），宁可漏落库也不重复落库；
2. 编排层在落库前对 ADD 草稿再调一次 `findExistingForDraft` 做精确二次核对（成本高但确定性强）。建议选 1。

### WR-04: AIPage 设备 Select 标签 `d.connectionType.toUpperCase()` 未防空（renderer 崩溃风险）

**File:** `src/components/pages/AIPage.tsx:84`
**Issue:** `label={\`${d.name} (${d.connectionType.toUpperCase()})\`}`——若 device 行 `connection_type` 列为 NULL（DB schema 允许 `connection_type TEXT CHECK(...)` 无 NOT NULL，旧数据/未配置设备可能为 null），`Device` DTO 经 rowToDevice 映射后 `connectionType` 可能为 `null`/`''`/`undefined`，`.toUpperCase()` 在 null/undefined 上抛 TypeError，**整个 AIPage 渲染崩溃**（白屏）。loadData 已 filter `=== 'ssh' || === 'telnet'`，看似能挡，但 filter 是字符串严格相等——若 DTO 给出 `null` 会被 filter 排除，看似安全；但若 rowToDevice 对未设置 connection_type 返回字符串 `'unknown'` 或空串 `''`（不在 filter 排除内但 `.toUpperCase()` 仍可调用），风险有限。真正风险：DTO 契约未在 TS 层断言非空。

**Fix:** 防御性改写 `((d.connectionType || '').toUpperCase() || 'N/A')`，或显式 `(d.connectionType ?? 'unknown').toUpperCase()`。

### WR-05: getAiConfig 在单次 summarize 流程内被调 3 次（demoMode 判定 × 1 + draftSession × 1 + judgeVerdicts × 1）

**File:** `electron/services/experienceDrafting.ts:78`, `electron/services/draftingService.ts:168-171, 282-285`
**Issue:** 编排层 `summarizeSessionForUi` 先 `getAiConfig()` 判 demoMode（行 78），再调 `draftSession`（内部又 `getAiConfig()` 行 168），再调 `judgeVerdicts`（内部第三次 `getAiConfig()` 行 282）。每次 `getAiConfig` 都是一次 `decField(api_key_enc)` 解密 + DB SELECT。非红线违反（功能正确），但 demoMode 检测与下游重复、解密次数 ×3 浪费。

**Fix:** 编排层把判好的 `config`（或 demoMode 标志）作为参数传给 `draftSession`/`judgeVerdicts`，避免重复解密；或 draftSession/judgeVerdicts 改接受 `config` 入参而非内部自取。

### WR-06: `maskCredentials` 单元测试缺关键负向用例（CR-01/CR-02 漏判无回归保护）

**File:** `electron/utils/piiMask.test.ts`
**Issue:** 现有用例覆盖 `password: xxx`/`密码=xxx`/引号值/无关键词原样返回，但**未测**：(a) 自然语言连接词 `password is xxx`/`密码 是 xxx`（CR-01）；(b) 裸词 `key` 误匹配 `monkey=bar`/`keyboard`（CR-02）。CR-01/CR-02 是生产可触发的真实漏判/误判，缺测试等于无回归护栏。

**Fix:** 补两个 describe 块覆盖上述场景，作为 CR-01/CR-02 fix 的回归门。

### WR-07: `maskConversationText` 三步串联顺序对凭据值含 IP/MAC 的混合场景可能残留

**File:** `electron/utils/piiMask.ts:54-61`
**Issue:** 顺序为 cred → ipv4 → mac。当凭据值本身是 IP（如 `management-ip: 10.0.0.1`）时，cred 步先把整段 `10.0.0.1` 吞成 `****`（正确）；但若凭据值是 MAC（如 `base-mac: aa:bb:cc:dd:ee:ff`），cred 步用 `\S+` 匹配会吞掉整段 MAC（正确）。看似没问题，但**反例**：`the gateway is 10.0.0.1 and password foo`——cred 步先吞 "is"（CR-01 漏判），后续 ipv4 步把 `10.0.0.1` 脱敏（**但 password foo 残留**）。这是 CR-01 的下游放大。

**Fix:** CR-01 修好后此顺序问题自动消失；不建议单独改顺序（cred 优先是对的）。

## Info

### IN-01: 模块级 `/g` 正则常量（CRED_RE/IPV4_RE/MAC_RE）跨调用复用

**File:** `electron/utils/piiMask.ts:21, 27, 31`
**Issue:** 三个 `/g` 正则为模块级常量，当前仅经 `.replace()` 使用（JS replace 自动重置 lastIndex，安全）。但若未来有同事用 `CRED_RE.test()`/`.exec()` 做探测，粘滞 `lastIndex` 会导致间歇性漏匹配。属隐患。

**Fix:** 改为函数内 `new RegExp(...)` 局部实例，或加注释 `// 仅限 .replace 使用，勿用于 .test/.exec`。

### IN-02: `extractJsonArray` 用首 `[` 末 `]` 切片，对 LLM 输出嵌套括号文本有边界风险

**File:** `electron/services/draftingService.ts:96-104`
**Issue:** 对 `[{...tags:[...],...}{...}]` 嵌套数组正常（lastIndexOf 取最外层 `]`）。但若 LLM 在 JSON 后追加"注：以上结果[note]"，`lastIndexOf(']')` 仍取 JSON 闭合 `]`（前一个），切片正确；若 LLM 在 JSON 前加"以下是 [结果]："，`indexOf('[')` 会取到描述里的 `[`，切片错位 → JSON.parse fail → 触发重试（容错路径正确）。结论：当前实现靠重试兜底，**不构成 bug**，仅可读性提示。

**Fix:** 可选——改用 `` `json ` `` 围栏优先剥（先查 ```json ... ```），找不到再 fallback 首 `[` 末 `]`，降低重试率。

### IN-03: B-1 红线「grep 反向守卫 = 0」无自动化校验

**File:** 全仓（设计约束）
**Issue:** phase_context 要求「编排层不裸 SQL UPDATE duplicate_of_exp_id，grep 反向守卫 = 0」。人工 grep 确认 `experienceDrafting.ts` 无裸 UPDATE 该列（满足），但项目无 CI 脚本/测试断言此不变量。未来回归（如某同事在编排层加 `db.prepare('UPDATE experiences SET duplicate_of_exp_id=?')`）不会被任何门挡住。

**Fix:** 加一个 vitest 测试，读取 `experienceDrafting.ts` 源码字符串，断言不含 `UPDATE experiences SET ... duplicate_of_exp_id` 模式（轻量级架构守卫）。

### IN-04: `experienceService.createExperience` 不校验 `duplicateOfExpId` 指向的 exp_id 存在性

**File:** `electron/services/experienceService.ts:175-178`
**Issue:** 注释明示"不校验指向 exp_id 存在性（信任编排层 + Phase 9 人工兜底；experiences 表无 self-FK）"。这是有意决策（无 self-FK 约束 + 信任 LLM 判定），可接受，但 LLM 可能产出 hallucinated exp_id（如 "exp-old-1" 实际不存在）→ UPDATE 草稿落库时 dup_id 指向不存在的行，Phase 9 跳转定位失败。

**Fix:** 可选——createExperience 接受 `duplicateOfExpId` 时，若非 null 则 `SELECT 1 FROM experiences WHERE id=?` 校验存在性，不存在则 throw（编排层 catch 后把该 draft 降级为 ADD）。或保持现状但 Phase 9 UI 对找不到 dup_id 的情况显式提示"指向的经验已删除"。

---

_Reviewed: 2026-08-02_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
