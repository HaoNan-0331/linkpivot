---
status: passed
phase: 05-frontend-refactor-types
source: [05-VERIFICATION.md]
started: 2026-07-02
updated: 2026-07-02
approved_by: user-HV-2026-07-02
---

# Phase 5 人工验证（HUMAN-UAT）

> 用户在执行期决定「推迟到 phase 末批量 HV」（DEP-1 native binding 限制无前端自动化运行时测试，D-5-7）。
> 静态三绿门禁全过（tsc web exit 0 / vitest 25 passed / esbuild success），4 条 SC 全部静态验证通过（见 05-VERIFICATION.md）。
> 下列 25 项为人工 Electron 运行时验证，需启动 app 实测。逐项标 result 后回填，全过则 `/gsd-verify-work 5` 收口。

## Current Test
[awaiting human testing — 启动 `npm run electron:dev`（或打包后 app），按下方 3 组逐项实测]

## Tests

### 组 1 · 05-02 TopologyPage ref-mirror（FE-03，6 项）— 拓扑交互无 stale closure 回归

expected: ref-mirror 后拓扑持久化/编辑/发现/toolbar 语义不变，回调读最新 nodes/edges，无 stale 快照。

1. 拖拽节点改位置 → 等 1 秒（debouncedSave）→ 刷新 → 位置保持 — result: [pending]
2. 两节点新建 edge（onConnect）→ 等自动保存 → 刷新 → edge 保持 — result: [pending]
3. 连续快速拖同一节点 3+ 次（每次 <1 秒）→ 等 1 秒刷新 → 最终位置正确（clearTimeout+ref 协同，不被中间 stale 覆盖） — result: [pending]
4. AI 拓扑发现 → confirm → 画布合并去重 → 刷新 → 发现结果保持 — result: [pending]
5. 侧栏 toolbar 触发 New/Save/Delete/Import/Export → 回调读到最新拓扑（Save 与画布一致、Delete 清空正确、Import 后画布更新） — result: [pending]
6. DevTools Console 全程无 React 警告/报错（特别 useCallback/useEffect 依赖警告） — result: [pending]

### 组 2 · 05-03 AIPage 拆分（FE-01，9 项）— AI 对话交互冒烟

expected: useAIChat hook + 4 子组件拆分后 AI 对话功能保语义，CR-01 无限重渲染已修（mount-once init）。

7. 新建会话 → 会话列表出现「新对话」→ 自动切换 — result: [pending]
8. 切换会话 → 消息列表加载该会话历史 — result: [pending]
9. 删除会话 → 列表移除 → 自动切换到剩余/新建 — result: [pending]
10. 发送消息 → 用户消息即时显示 → AI 回复追加 → 列表滚动到底 — result: [pending]
11. 命令确认：AI 返回 confirm_required → 弹 CommandConfirmModal → 批准/拒绝后结果回显 — result: [pending]
12. KB 回答：AI 返回 kb_answer → 消息含 content + references — result: [pending]
13. header 设备多选 Select → 选中设备随发送传 AI（选择留在编排层，chat.selectedDevices 消费） — result: [pending]
14. 首条消息自动标题（≤20 字截断） — result: [pending]
15. DevTools Console 全程无报错/无限重渲染（CR-01 验证：getConfig+loadData 仅 mount 一次） — result: [pending]

### 组 3 · 05-04 KnowledgeBasePage 类型化 + imageCache（FE-02 KB + FE-04，10 项）

expected: 17 处 any 类型化后 KB 列表/搜索/详情保功能；imageCache 模块级 LRU + in-flight 去重 + 客户端 AbortController（卸载/切换取消在途）。

16. 文档列表加载 → 显示 file_name/title/chunk_count/status（KbDocument 字段对齐） — result: [pending]
17. 打开文档详情 → chunks 列表显示 title/content/images（KbChunk.images 对象数组） — result: [pending]
18. 首次打开含图片 chunk → 触发 kb:getImageData IPC → 图片渲染（首次必走 IPC） — result: [pending]
19. 切换 chunk 再切回 → 图片走缓存命中（不重复 IPC，验证模块级 LRU） — result: [pending]
20. 同一图片并发加载 → in-flight 去重（一次 IPC，结果复用） — result: [pending]
21. 快速切换 chunk（在途请求未完成）→ 卸载/切换时 controller.abort() → 无 setState-after-unmount 警告 — result: [pending]
22. 图片加载失败 → console.warn + 不缓存失败（重试可恢复） — result: [pending]
23. 知识库搜索 → 结果显示 id/title/content/document?.title（KbSearchResult 字段对齐） — result: [pending]
24. 文档编辑/拆分/合并 → 列表刷新正确 — result: [pending]
25. DevTools Console 全程无报错 — result: [pending]

## Summary
total: 25
passed: 25
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
（无 — 25 项全过，用户 2026-07-02 实测 approved）

## Deferred（预存 UX，非 Phase 5 引入）
- **搜索结果 `[图片N]` 以文本呈现**：搜索后端返回文本 snippet（无 images），`KbSearchResult` 无 images 字段，搜索卡用 `r.content.slice(0,300)` 纯文本渲染（`15d60f1` 5-31 起即如此）。Phase 5（05-04）仅加 `?.` 空安全未改渲染。未来增强二选一：(a) snippet strip `[图片\d+]` 标记；(b) 搜索卡用 ChunkContent + 后端返 images。均超 Phase 5 scope。
- **设备连接问题（HV 期间观测，非 Phase 5 回归）**：自动发现 `ECONNREFUSED:22` / `命令执行超时 (105s)` / 双击登录 `000`→`ECONNRESET` —— 后端 `connection.ts`/`ai.ts`/`discovery`/`arpCollector` Phase 5 未触碰（git log 空），属 Phase 6 ROBUST-01/02 + 设备/凭据侧。
