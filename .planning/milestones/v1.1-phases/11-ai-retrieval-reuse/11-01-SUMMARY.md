---
phase: 11-ai-retrieval-reuse
plan: 01
subsystem: ai-retrieval
tags: [ai, retrieval, rerank, llm, experience, security]
requires:
  - "Phase 7 experienceService.listExperiences/incReuseCount/touchLastVerifiedAt 预埋接口"
  - "Phase 7 commandSafety.isCommandAllowed 三层校验"
  - "Phase 8 draftingService 强 schema + 重试 + 反幻觉 prompt 范式"
  - "Phase 10 listExperiences opts search/deviceId/includeInvalid 粗筛参数"
provides:
  - "experienceRerank.rerank/validateRerank/buildRerankPrompt/MAX_RERANK_RETRIES/RELEVANCE_THRESHOLD（精排 LLM service）"
  - "experienceRetrieval.retrieveForAnswer/RetrieveInput/RetrieveResult/INJECT_LIMIT/MAX_CANDIDATES（编排 service）"
  - "ai.ts chat() b 自动预取串联 + exp_answer 返回类型"
affects:
  - "electron/services/ai.ts chat() 入口增加每轮自动预取（D-11-1 b 方案）"
  - "Plan 02 renderer 将消费 exp_answer references 渲染来源列表"
tech-stack:
  added: []
  patterns:
    - "强 schema JSON LLM 输出 + Drift Gate + 重试（复刻 draftingService Pattern C）"
    - "Service 函数式无 class 无 MK（CONVENTIONS Pattern 1b，不读写加密列）"
    - "多阶段编排串行 + demoMode/empty 早返（复刻 experienceDrafting Pattern 1）"
    - "信任边界：精排 prompt 只送 exp_id+title+content 前150字，references 回 renderer 只含元数据"
key-files:
  created:
    - electron/services/experienceRerank.ts
    - electron/services/experienceRetrieval.ts
    - electron/services/experienceRetrieval.test.ts
  modified:
    - electron/services/ai.ts
decisions:
  - "D-11-1 b 自动预取：chat() 入口先调 retrieveForAnswer，不靠 AI 自主标记（[EXP_SEARCH] 协议不抄）"
  - "D-11-3 方案 Y：精排 AI 承担理解（不单独加关键词提取步骤），每轮 2 次 LLM（精排+正式答）"
  - "D-11-4 RELEVANCE_THRESHOLD=0.6 硬编码模块常量（二期可提 env）"
  - "D-11-5 零迁移：复用 listExperiences 的 search/LIKE 宽匹配，不上 FTS5"
  - "D-11-6 两项验证：commandSafety 白名单 + 有效期，不验设备状态（D-11-8）"
  - "D-11-7 降级策略：命令失支持标 unsupported=true 降权不剔除；有效期失效剔除"
  - "D-11-9 不阻塞主路径：刷新失败 console.warn 兜底；chat() 串联整体 try/catch 异常 expReferences=[]"
  - "D-11-11 references 从注入记录拿（service 已知注入哪些经验，不需 AI 标记）"
  - "INJECT_LIMIT=5 / MAX_CANDIDATES=20：经验注入要精不要多（比 Phase 8 W-4 ≤50 窄，防 context 溢出）"
  - "CMD_EXTRACT_RE 限定只读首词（display/show/ping/traceroute/debug/terminal/interface），不提取变更类（T-11-02 mitigate）"
metrics:
  duration: ~12min
  tasks: 2
  files: 4
  tests_added: 30
---

# Phase 11 Plan 01: AI 检索复用 main 进程 service 层 Summary

实现 Phase 11 检索复用的 main 进程 service 层：每轮 AI 对话自动预取经验（D-11-1 方案 b），SQL 粗筛（复用 listExperiences，零迁移）→ LLM 精排强 schema 打分（D-11-3，2 次 LLM）→ 相关度阈值过滤（D-11-4 防噪声）→ read-time 两项验证（D-11-6）→ 命中刷新 reuse_count/last_verified_at → 经验正文注入正式 callAI context → references 元数据随 ai:chat 返回。

## What Was Built

### Task 1: 精排 service `experienceRerank.ts`
- **函数式无 class 无 MK**（CONVENTIONS Pattern 1b，不读写加密列，候选经 listExperiences 已解密 attrs 明文）
- `validateRerank(raw, candidateExpIds)`：剥 ```json 包裹（复刻 draftingService.ts:97-104 extractJsonArray）→ JSON.parse → Array.isArray → 逐条校验 exp_id 必须命中候选集 Set（T-11-06 防编造）+ score 边界归一化（'85%'→0.85 / '0.9'→0.9 / 'high'→NaN fail / 1.5→超界 fail，复刻 confidence 边界模式）+ reason 字符串必填
- `rerank(input)`：demoMode 短路返 [] + 候选空短路不调 LLM + 3 次重试 MAX_RERANK_RETRIES + 全失败 throw 'AI 精排失败（已重试 3 次）'；非 demoMode 时 config 缺失 throw '请先配置 AI 服务'
- `buildRerankPrompt`：每条候选给 exp_id+title+content 前150字（draft_index 引用模式防丢映射）
- `RERANK_SYSTEM_PROMPT`：反幻觉红线（禁编造 exp_id + 严格 JSON 数组 + 全不相关返 []）
- `RELEVANCE_THRESHOLD=0.6` / `MAX_RERANK_RETRIES=3` 模块级常量导出

### Task 2: 编排 service `experienceRetrieval.ts` + chat() 串联
- **`retrieveForAnswer(input)`**（仿 experienceDrafting.ts:70-156 编排骨架）：
  1. demoMode 判定（未配 AI → 返空注入不抛错）
  2. 粗筛（D-11-2）：deviceIds 非空 → listExperiences({deviceId, includeInvalid:false, limit:MAX_CANDIDATES})；空 → listExperiences({search:userMessage, ...})
  3. 空库短路（rows.length===0 → 返 empty 不调精排 LLM）
  4. 精排 rerank 喂候选 {exp_id, title, content_preview: 前150字}
  5. 阈值过滤 score >= RELEVANCE_THRESHOLD + top INJECT_LIMIT=5 截断
  6. read-time 两项验证：(a) 有效期二次确认 row.invalid_at 失效剔除；(b) 命令扫描 CMD_EXTRACT_RE 提取只读首词逐条 isCommandAllowed，cmds.some 失支持标 unsupported=true（保守宁可多标）
  7. 命中刷新 incReuseCount+touchLastVerifiedAt，失败 console.warn 不阻塞（D-11-9）
  8. 返 RetrieveResult（injected 含 exp_id/title/content/source_session_id/unsupported，不含 attrs 密文）
- **ai.ts chat() 串联**（D-11-1 b 自动预取）：
  - 在 fullMessages 拼装前调 retrieveForAnswer，整体 try/catch 隔离（异常 expReferences=[] 继续正常答）
  - 命中即把经验正文拼进 systemPrompt（附「⚠ 此条经验命令已失支持」标注）
  - no-commands 分支返 exp_answer 类型（references 含 kind:'experience' 联合，Plan 02 renderer 消费）
- **`INJECT_LIMIT=5` / `MAX_CANDIDATES=20`**：经验注入要精不要多，防 context 溢出

## Verification

四绿门禁全绿：
1. `npx tsc -p tsconfig.web.json` — 0 error（strict + noUnusedLocals）
2. `npm run build`（vite renderer）— 成功
3. `npm run build:electron-main`（esbuild main）— 成功（新 service + ai.ts 改动无解析错误）
4. `npx vitest run` — 230/230 全绿（既有 200 + 新增 30，零回归）

grep 红线断言全通过：
- experienceRerank.ts / experienceRetrieval.ts：`grep -c "class "` = 0（函数式）
- 两文件 `grep -cE "encField|decField|\bMK\b"` 实际用法 = 0（仅 docstring 字面提及，与 draftingService.ts header 注释同格式）
- ai.ts：retrieveForAnswer 串联 3 处（import + 调用 + 注释）/ exp_answer 返回类型 1 处

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test 24 命令全失支持测试用例初始与正则约束冲突**
- **Found during:** Task 2 测试编写
- **Issue:** 原测试用 `reload now` / `reboot force` 模拟失支持命令，但 CMD_EXTRACT_RE 按威胁模型 T-11-02 mitigate 设计为「只提取只读首词（display/show/ping/traceroute/debug/terminal/interface），不提取变更类」，故 reload/reboot 不被提取 → cmds=[] → unsupported=false，测试失败
- **Fix:** 改用 `debug ip packet` / `terminal monitor`（只读首词被提取，但不在测试白名单数组）模拟失支持场景，语义与正则约束一致（提取到但白名单不通过），非变更类命令
- **Files modified:** electron/services/experienceRetrieval.test.ts（test 24 用例）
- **Commit:** 8653f90

无其他偏离——plan 执行精确。

## TDD Gate Compliance

Plan frontmatter `type: execute`，两 task 均 `tdd="true"`。本技术栈（better-sqlite3 native + Vitest）采用 service+test 同 commit 验证式 TDD（与 Phase 8 draftingService.test.ts 同模式）：先写 service 骨架 + 失败用例 → 跑红 → 补实现 → 跑绿 → 提交。

- Task 1: test→impl→17 用例一次绿（feat commit e4c0809）
- Task 2: test 追加 13 用例 → 1 红（Rule 1 修正）→ 重跑 30 全绿（feat commit 8653f90）

无 RED/GREEN gate 缺失警告。

## Self-Check: PASSED

文件存在性 + commit 存在性验证：
- FOUND: electron/services/experienceRerank.ts（e4c0809）
- FOUND: electron/services/experienceRetrieval.ts（8653f90）
- FOUND: electron/services/experienceRetrieval.test.ts（30 tests pass）
- FOUND: electron/services/ai.ts chat() 串联（retrieveForAnswer + exp_answer）
- FOUND: commit e4c0809（git log）
- FOUND: commit 8653f90（git log）

## Notes for Plan 02

- ai:chat 返回值新增联合类型：`{ type: 'exp_answer', content, references: Array<{kind:'experience', expId, title, sourceSessionId, unsupported}> }`
- references 字段加了 `kind` 标签便于 renderer 联合类型分流（kb vs experience），Plan 02 需扩 `src/components/pages/ai/types.ts` ChatMsg.references 联合类型 + ChatMessageList.tsx 渲染分支（点击回查复用 ExperienceDetailModal/SessionMessagesModal，D-11-12）
- exp_answer 与 kb_answer 当前互斥（kbReferences 优先 return，expReferences 在其后），若需并存可合并 references 数组
