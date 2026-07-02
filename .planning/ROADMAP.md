### Phase 5: Frontend Refactor & Types
**Goal**: 前端结构清晰、类型严格、无 stale closure 与在途请求泄漏
**Depends on**: Phase 4 (DATA-01 分页签名稳定后，前端 Tab 组件按新类型对接)
**Requirements**: FE-01, FE-02, FE-03, FE-04
**Success Criteria** (what must be TRUE):
  1. `AIPage` 拆分为 `ChatSessionList` / `ChatMessageList` / `ChatInput` / `CommandConfirmModal` 4 个独立子组件文件（`codegraph_files`/glob 命中 4 个文件）
  2. 前端 `any` 类型清理：ArpTab / AnomalyTab / NetworkTab / OuiTab / SettingsPage / KnowledgeBasePage 的 `api:any` 与组件 props 改用 `src/types` interface（`tsc -p tsconfig.web.json` 绿 + `grep ": any"` 显著收敛）
  3. `TopologyPage` store 回调使用 `getState()` 读最新值，无 stale closure（回调内无捕获过期 state）
  4. `ChunkContent` 图片加载带 `AbortController` + ref 缓存，组件卸载/切换时在途请求被取消（可 grep 到 AbortController + abort 调用）
**Plans**: 4 plans
Plans:
**Wave 1**（2 plans 并行，files_modified 零重叠）
- [x] 05-01-PLAN.md — FE-02 类型契约 foundation：electron.d.ts 全建模（含新增 scheduler 通道）+ 新建 src/types/{kb,ai}.ts 补缺 DTO + 4 IP Tab + SettingsPage + DevicesPage 清 any（D-5-2/D-5-3）
- [x] 05-02-PLAN.md — FE-03 TopologyPage ref-mirror（nodesRef/edgesRef）：debouncedSave/saveTopology/toolbar 注册/handleDiscoveryConfirm 读 ref.current，useCallback deps 去 nodes/edges，不迁 store（D-5-4）+ 人工 HV

**Wave 2** *(blocked on Wave 1 / 05-01 完成)*（2 plans 并行，files_modified 零重叠）
- [ ] 05-03-PLAN.md — FE-01 AIPage 拆分：useAIChat hook（page-local，不用 zustand/prop drilling）+ 4 子组件（ChatSessionList/ChatMessageList/ChatInput/CommandConfirmModal）+ types.ts，AIPage 退化为薄编排层，顺带收 AIPage 4 处 any（D-5-1）+ 人工 HV
- [ ] 05-04-PLAN.md — FE-02 KB 类型化（17 处 any，含 ChunkContent images→KbImage[]）串行接 FE-04 新建 kb/imageCache.ts（模块级 LRU + in-flight 去重 + AbortSignal）+ ChunkContent 改 AbortController（D-5-5/D-5-6）+ 人工 HV
**UI hint**: yes
