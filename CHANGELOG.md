# CHANGELOG

## 2026-07-25

### debug exec-cmd-concat · H3C 多命令 exec 字符串粘连修复（每命令独立 SSH 连接）

- **根因（DB 日志铁证）**：discovery Phase 3 `executeCommandsOnDevice` 在【单个 SSH 连接（同一 client）上串行 `client.exec` 多条命令】。H3C SSH server 把 exec request 的命令通过 vty 逐字符注入 console，前一条命令字符串尾部字符尚未被设备 console 消费完毕，下一条 exec 即追加注入，致命令字符串粘连（`display arp` → `display arpp neighbor-information list`）。叠加 `execOne` silence 2s 提前 resolve（H3C exec 不主动 close channel），下一条发送过快加剧粘连。仅第 1 条 LLDP 有数据，ARP/version/routing/interface 全报 `% Unrecognized/Wrong command` → AI 拓扑分析素材残缺 → `edges: []`。
- **修复（方案 A）**：`electron/services/ai.ts` `executeCommandsOnDevice` 重构为【每条命令独立 SSH 连接】—— `runOne(idx)` 内 `new Client → connect(buildSSHConfig) → ready 后 execOne → end 回收`。不同 SSH session = 不同 vty，物理隔离彻底杜绝粘连。仍用 exec（非 PTY），不引入注入面，不改白名单 / 安全模型；复用 `sshConfig.ts` 的 `SSH_READY_TIMEOUT_MS` / `SSH_ALGORITHMS`；`execOne` 签名 / stream silence / retry / timeout 逻辑完全不变。
- **对外契约零改**：`executeCommandsOnDevice(device, commands[]): Promise<结果[]>` 签名不变；结果数组与 `commands` 同序同长（`results[i]` ↔ `cmds[i]`）；首条命令连接失败 reject 整批（与旧 `client.on('error')` 同语义，discovery `catch` 按连接失败跳过设备）；后续命令连接失败填 `success:false` 不中断（保结果同长同序）。
- **代价**：握手次数 = 命令数（单设备 5 条约 10s，远好于历史卡顿，可接受）。
- **改动范围**：仅 `electron/services/ai.ts` `executeCommandsOnDevice`（line 291-386），`execOne`/`buildSSHConfig`/`executeCommandOnDevice` 不动。
- 验证：tsc web strict + noUnusedLocals 全绿；esbuild 主进程打包不回归；vitest 25/25 全绿；待人工 HV（对 H3C 设备跑自动发现，查 `ai_system_logs` collectionText 确认第 2 条起命令回显干净、edges 非空）。

## 2026-07-02

### Phase 5 Plan 04 · FE-02 KB 类型化 + FE-04 ChunkContent 取消与缓存（D-5-2/D-5-3/D-5-5/D-5-6）
- **新建 `src/types/kb.ts`**：KbDocument / KbChunk / KbImage / KbStatus / KbSearchResult，字段**严格反推自 KnowledgeBasePage.tsx 真实消费面**（issue 1 修正：`file_name` 非 filename、`images` 图片对象数组非 image_ids 字符串、`document?: { title: string }` 嵌套非 docId/docTitle；DB 行原生下划线 `device_id`/`error_message`/`created_at`/`chunk_index`/`char_count` 保留）
- **`src/types/electron.d.ts` kb.* 通道收类型**（05-01 保留 Promise<any>，本 plan 接力）：listDocuments→`Promise<KbDocument[]>`、getDocument→`Promise<KbDocument|null>`、getStatus→`Promise<KbStatus>`、search→`Promise<KbSearchResult[]>`、uploadBuffer/reprocess→`Promise<{id:string}>`
- **`KnowledgeBasePage.tsx` 17 处 any 全收敛**：ChunkContent `images: any[]` → `KbImage[]`、`img: any` → `KbImage`；documents/devices/searchResults/detailDoc 状态用 DTO；Table 列 render（file_name/status/操作）+ Select options（upload/filter）+ chunk map 全用强类型；nullable 字段窄化（`file_type??''`、`content?.length??0`、`status??''`、`chunks?.length??0`、handleMerge 前置 null 守卫、`chunks!` 断言）
- **新建 `src/components/pages/kb/imageCache.ts`**：模块级 LRU 缓存 Map（`CACHE_MAX_ENTRIES=100`，按 count 有界，Map 插入顺序淘汰最老，O(1)）+ in-flight 去重 Map（同 file_path 并发复用 Promise，finally 清除允许重试）+ `getImage(path, signal)` 封装「缓存命中 → in-flight 复用 → 否则 IPC 并入缓存」+ `clearImageCache()` 手动清
- **`ChunkContent` effect 改造**：`let cancelled = false` → `AbortController`（cleanup 调 `controller.abort()`，D-5-5 结构化取消）；`window.api.kb.getImageData` 直调 → `getImage(file_path, signal)` 走缓存层；FRAG-2 顺带：图片失败 `console.warn('[kb] 图片加载失败')` 提供反馈（不再完全静默，UI 不崩）
- **D-5-5 红线守住**：`kb.getImageData` IPC 通道签名不动（preload.ts 未改）—— better-sqlite3 同步读不可真中断，AbortController 落地为「结构化取消标志 + 卸载防 setState + 配合 in-flight 去重」客户端语义，非真中断主进程 IO
- **D-5-6 红线守住**：缓存**模块级**（非 per-instance，ChunkContent 频繁 re-mount 跨实例复用、存活卸载）
- FE-02 类型化先于 FE-04 缓存（同文件串行，Task1 → Task2，FE-04 用 FE-02 的 KbImage 类型）
- 验证：tsc web strict + noUnusedLocals 全绿；vitest 25 测试不回归；esbuild 主进程打包不回归；KB any after 绝对值 = 0（grep `:\s*any|as any|<any>` = 0）；preload.ts 无 kb 通道改动
- 待人工 HV（DEP-1 限制无前端自动化运行时测试，推迟 phase 末批量 HV）

### Phase 5 Plan 03 · FE-01 AIPage 拆分 4 子组件 + useAIChat hook（D-5-1/D-5-2）
- **拆分结构落地**：`src/components/pages/AIPage.tsx`（399 行）拆为 4 独立子组件文件 + 1 个 useAIChat 自定义 hook + 本地 types.ts，AIPage 退化为 ~95 行薄编排层
- **新建 `src/components/pages/ai/` 目录**（6 文件）：
  - `types.ts`：DeviceOption/ChatMsg/ConfirmData/UseAIChatReturn（迁移自 AIPage 本地 interface）
  - `useAIChat.ts`：page-local 会话态自定义 hook（8 state + 7 handler，typed contract 返回）
  - `ChatSessionList.tsx`：会话列表子组件（render-only）
  - `ChatMessageList.tsx`：消息列表子组件（含 chatEndRef 滚动 effect）
  - `ChatInput.tsx`：输入框子组件（event-driven）
  - `CommandConfirmModal.tsx`：命令确认弹窗子组件
- **D-5-1 红线守住**：useAIChat 是**自定义 hook**（非 zustand store、非 prop drilling）；设备多选 `<Select mode="multiple">` **留 AIPage 编排层 header**（经 `chat.selectedDevices/setSelectedDevices` 消费，非子组件职责）；未引入 `aiChatStore` 全局单例
- **FE-02 顺带收敛（D-5-2，AIPage 由 FE-01 独占）**：原 line 60/61 `(d: any)` → Device[] 强类型 filter 去标注；原 line 101 `m.role as 'user'|'assistant'` → role 已联合类型去 cast；原 line 160/175 `catch (e: any)` → `catch (e: unknown)` + `instanceof Error` 窄化。AIPage any 清零（before 4 → 0）
- **configLoading/hasConfig 留编排层**（page 守卫，非 hook 契约）；hook 暴露 `loadData(hasConfig)` 供守卫通过后调用
- **导入路径迁移**：`@/types/electron` → `@/types/ai`（ChatMessage/ChatSession）；electron.d.ts 的 re-export 兼容层保留（无回退需求，但保留不阻塞）
- 验证：tsc web strict + noUnusedLocals 全绿；vitest 25 测试不回归；esbuild 主进程打包不回归；AIPage 4 处 any 清零；header Select 多选保留；待人工 HV（DEP-1 无前端自动化运行时测试，推迟 phase 末批量 HV）

### Phase 5 Plan 02 · FE-03 TopologyPage stale closure ref-mirror（D-5-4）
- **`src/components/pages/TopologyPage.tsx` ref-mirror 落地**：新增 `nodesRef`/`edgesRef`（紧邻既有 `saveTimerRef`/`isLoadingRef` 同模式），两个同步 effect `nodesRef.current = nodes` / `edgesRef.current = edges`（O(1) 赋值，无性能影响）
- **全 stale closure 点改读 ref.current**：`saveTopology`、`debouncedSave`（setTimeout 闭包）、`handleDiscoveryConfirm`、`handleEditSelectedNode` —— 体内读 `nodesRef.current`/`edgesRef.current` 取最新拓扑，`useCallback` deps 去掉裸 `nodes`/`edges`，回调注册稳定（消除「注册与调用间窗口」stale 风险，D-5-4 意图）
- **拓扑持久化语义 byte-for-byte 不变**：保存触发时机（debouncedSave effect 仍依赖 nodes/edges 触发）、保存内容（nodes/edges 浅拷贝）、保存 API（topology.update）全部不动；仅读取路径从闭包变量改为 ref.current
- **D-5-4 红线守住**：`useNodesState`/`useEdgesState` 契约不变，**未迁 nodes/edges 到 zustand store**（外迁触及核心价值「拓扑准确呈现」最高优先级面，风险不抵收益）
- 函数式更新 `setNodes(nds => ...)` / `setEdges(eds => ...)` 本就读最新，无 stale 风险，不改（handleConnect/handleAddDevices/handleDeleteSelected/handleEditConfirm/handleNew/handleDelete/handleImport）
- 验证：tsc web strict + noUnusedLocals 全绿；vitest 25 测试不回归；esbuild 主进程打包不回归；grep `nodesRef\|edgesRef` 命中 11；待人工 HV（DEP-1 限制无前端自动化运行时测试）

### Phase 5 Plan 01 · FE-02 类型契约 foundation（D-5-2/D-5-3）
- **重写 `src/types/electron.d.ts`**：非 kb 通道全部 `any` 替换为 src/types DTO（Device/Topology/NetworkSegment/IPDetail/IPMACChange/IPMACBinding/ExcludedIP/ChangeStats 等）；`PaginatedResult<any>` 泛型收为 IPDetail/IPMACChange/OUIRow；3 list 通道（network/anomaly/oui）信封类型化
- **新建 `src/types/ai.ts`**：ChatMessage（role 收 `'user'|'assistant'`）/ ChatSession / DiscoverResult（复用 TopologyNode/TopologyEdge）
- **`src/types/oui.ts` 补 `OUIRow`**：snake_case DB 行（ouiService 未做 camelCase 映射，旧 OUIEntry camelCase 与 IPC 真实返回不符，D-5-3 缺 DTO 就近补，Rule 1 bug 修复）
- **`electron.d.ts` 新增通道**：`scheduler`（getConfig/updateConfig/runNow/getStatus，对齐 preload.ts:104-109 + schedulerIpc.ts 真实签名，无臆造 saveConfig/start/stop）、`arp`（collectFromDevice/collectFromAll）、`export`（arpTable/changes/networkUsage）—— 三组 preload 已暴露但旧 electron.d.ts 漏标
- **`electron.d.ts` re-export ChatMessage/ChatSession**：维持 AIPage.tsx 既有 import 不中断（FE-01 Wave 2 迁移导入路径）
- **4 个 IP Tab + SettingsPage + DevicesPage 清 any**（6 文件 any after 全 0，issue 4 绝对值验收）：
  - props `api:any` → `ElectronAPI`；useState `any` → 真实 DTO（ARPEntry/IPMACChange/NetworkSegment/OUIRow/Device）
  - SettingsPage 删 `(window as any).api` 绕过，scheduler 走 `window.api.scheduler.*`；schedulerConfig/Status 收为 `ScheduleConfig`/`SchedulerStatus`
  - 全部 `catch (e:any)` → `catch (e:unknown)` + `instanceof Error` 窄化（统一错误处理模式）
  - Phase 4 信封 `.rows` 读路径保留无回退
- **kb.* 通道保留 `Promise<any>`**：归 05-04 建模（KB DTO 下沉 05-04 就近定义，避免跨 wave 依赖）
- **不在本 plan**：AIPage（FE-01 独占）、KnowledgeBasePage（05-04）、后端 services any（milestone 外）、mock-api.ts（dev-only）
- 验证：tsc web strict + noUnusedLocals 全绿；vitest 25 测试不回归；esbuild 主进程打包不回归

## 2026-06-28

### Phase 4 Plan 01 · DATA-01 三 list 通道 hybrid 分页契约（D-4-1~D-4-4, D-4-6）
- **新增 `src/types/pagination.ts`**：`PaginatedResult<T>` 信封类型（rows/total/truncated），renderer+main 共用
- **新增 `electron/utils/pagination.ts`**：共享 `validateLimit`/`validateOffset` helper（Number.isInteger + 范围校验，超界落回默认非钳制，复用 anomalyIpc 先例）
- **新增 `tests/unit/pagination.test.ts`**：13 个单测覆盖校验 behavior
- **`networkSegmentService.getIPDetails`**：加 `limit=2000, offset=0`，返回信封；JS CIDR 过滤后 slice 分页（D-4-6 不下推 SQL）；保留 PERF-01 `OUIService.getVendor` 读路径不退化为逐行查库
- **`ouiService.getAll`**：加 `limit=5000, offset=0`，SQL 下推 `LIMIT ? OFFSET ?`（prepared statement 防 SQL 注入）+ COUNT(*) total + 信封
- **`anomalyService.getChanges`**：补 `offset=0` + `OFFSET ?` + COUNT(*) total + 信封（维持默认 100/硬上限 10000）
- **3 个 IPC handler**：网关层 `validateLimit/validateOffset` 校验后转发 service（不信 renderer）；`anomalyIpc` 删本地 validateLimit 改 import 共享
- **`preload.ts`**：三通道签名加可选 `limit?/offset?`（向后兼容，旧调用零改动）
- **trade-off（T-04-04 accept）**：ip_status 无物理 purge 单调增长，D-4-6 限定 IPC payload 不限 DB 全表读；物理清理越界 DATA-01（独立 phase）
- 验证：tsc + esbuild + vitest(25) 三绿；Task1 TDD RED→GREEN 合规

## 2026-06-28

### 项目文件审计与清理
- **磁盘清理（.gitignore 覆盖，不入 git）**：`.playwright-mcp/`（playwright MCP 老日志，90 文件 530K）、`login-page.png`/`topology-page.png`（dev 参考截图）、`tsconfig.node.tsbuildinfo`（TS 增量缓存，tsc 自动重生）
- **`.gitignore`**：补全 `.codegraph/`（CodeGraph 索引，local to machine，不应提交）
- **资源跟踪**：`git add src/assets/icons/*.svg`（5 个设备图标 router/switch/firewall/server/equipment，DeviceNode.tsx 引用，之前漏跟踪）
- **mock-api.ts**：经核实为浏览器 dev 预览模式必要文件（index.html `!window.api` 时动态注入），保留；曾误判为死代码已纠正并恢复

## 2026-06-21

### 代码审计批4b · 前端 low 清理（死代码 / 类型 / 静默失败）
- **ArpTab.tsx**：删除 collectSelected 中恒为 0 的 totalChanges/totalDeprecated 死代码（曾误导运维"无异常"），stats 仅设 entries，变更/弃用项显示 '-'
- **AnomalyTab.tsx**：删除未使用的 _notesModal/_notes 死状态
- **App.tsx**：checkFirstRun 补 .catch（失败不再静默卡 loading）+ useEffect 依赖补全
- **DeviceNode.tsx**：删除未使用的 import React（react-jsx 无需）
- **electron.d.ts**：connection 补 rdpConnect 声明（消除 TopologyPage 类型错误，web 端 tsc 全绿）

### 代码审计批4a · 后端 low 清理（错误处理 / 数据校验 / 性能 / 依赖）
- **crypto.ts**：`decField` try/catch，单条坏密文不再让整个列表加载失败
- **device.ts**：update/delete 拓扑解析 try/catch，跳过坏拓扑不中断整批
- **topology.ts**：importTopology 节点上限 5000，防超大 JSON 撑大库
- **systemLog.ts**：createSystemLog 字段截断（16000），防大 prompt/aiResponse 撑库
- **networkSegmentService.ts**：maskToCIDR 校验掩码格式与二进制连续性，拒绝 255.0.255.0 类非法掩码
- **connection.ts**：`busy_timeout=5000` + `wal_autocheckpoint=1000`，降低并发锁冲突
- **schedulerService.ts**：`runTask().catch` 防 unhandled rejection；ARP insert catch 区分 UNIQUE 记日志
- **package.json**：移除未使用依赖 pdf-parse(21MB) + @types/pdf-parse + build 脚本 external 残留
- **vite.config.ts**：代理 target 抽环境变量 `VITE_AI_PROXY_TARGET`
- **exportService.ts**：csvEscape RFC4180 转义，修复逗号/引号/换行破坏 CSV 列
- **anomalyService.ts**：recordChange catch 加日志，避免静默吞掉插入失败

### 代码审计批3 · 鉴权机制 + IPC 网关 + 入参校验（架构加固）
- **authGuard.ts（新）**：`secure` 高阶函数 = 登录鉴权（未登录 reject「未登录或会话已过期」）+ 异常脱敏（`sanitizeMessage` 移除绝对路径/截断超长，不向渲染层泄露 SQL/路径等内部细节）；单机登录态 `authenticated`
- **main.ts**：`auth:login` 成功置 `authenticated=true`；除 `auth:*` 外所有特权 handler（device/topology/connection/terminal/ai）用 `secure` 包装
- **ipc/*.ts（7 文件）**：所有 handler `secure` 包装（鉴权 + 异常脱敏）
- **入参校验**：network create/update（IPv4 正则 + 掩码二进制连续性）、oui addBatch/deleteBatch（上限 1000）、scheduler updateConfig（interval 1-10080、enabled 0/1/布尔）、anomaly getChanges（limit 范围）/acknowledge/deleteChange（id 正整数）/getBindingHistory（IP 正则）/addExcludedIP（非空）

### 代码审计批2 · Medium 安全/正确性修复（11 项）
- **crypto.ts**：字段加密新增 `v2:` 版本前缀 + 12 字节 IV（GCM 推荐值），decrypt 兼容历史 16 字节 IV 密文（零迁移）；`verifyPasswordSync` 加结构校验/长度上限/等长保护/try-catch
- **auth.ts**：验证码文本改用 `crypto.randomInt`（CSPRNG）；登录失败 5 次锁定 5 分钟；`initAdmin` 增加口令强度策略（≥10 位 + 字母数字）
- **webSecurity.ts（新）+ main.ts + connection.ts**：统一 `hardenWindow` 加固（will-navigate 阻止外链跳转 + setWindowOpenHandler 转系统浏览器）；主窗口与终端窗口 `sandbox:true`；注入严格 CSP；全局 `web-contents-created` 兜底
- **ai.ts**：pendingBatches 增加 TTL（10 分钟自动清理）与 createdAt；batchId 改独立 uuid（与 logId 解耦）；设备名匹配改为指定名未匹配则拒绝、不再回退默认设备
- **networkSegmentService.ts + exportService.ts**：getIPUsage/getIPDetails/exportNetworkUsage 改用真实 CIDR 数值匹配（新增 ipToNumber/ipInCIDR），修正 /16 等非 /24 网段的前 3 段 LIKE 跨段误计

### 代码审计批1 · 安全核心修复（8 项，覆盖 critical + high）
- **keyManager.ts**：主加密密钥改用 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密落盘，绑定机器与用户；兼容历史明文回退，masterKey 值不变不影响历史数据解密
- **knowledgeBaseIpc.ts / knowledgeBaseService.ts**：`kb:getImageData` 修复路径遍历——imagePath 限定在 `imgDir()` 目录白名单内，MIME 改按文件头魔数探测，防止扩展名伪造
- **commandSafety.ts**：重构命令安全校验——拒绝多命令分隔符（\r \n ; & ` $() && ||）、白名单改首词严格相等匹配、黑名单补 system-view/interface/vlan/acl/aaa 等进配置视图命令；保留 `|` 管道过滤不误杀
- **ai.ts**：`executeCommandsOnDevice` 由交互式 `client.shell` 改为非交互 `client.exec`，杜绝换行/分号注入与 prompt 误判；函数内部强制 `isCommandAllowed` 作为执行层最后防线
- **init.ts**：devices 表 CHECK 约束重建（DROP/CREATE/INSERT/RENAME）整段包入 `db.transaction` 并加 `foreign_key_check`，避免中途失败致表丢失/外键悬空
- **crypto.ts**：`deriveKey` 增加 LRU 缓存，避免列表场景重复执行 pbkdf2Sync（10 万次）阻塞主进程
- **ErrorBoundary.tsx / main.tsx**：新增全局错误边界，根渲染包裹，避免运行时异常白屏
- **arpIpc.ts**：ARP 采集异常隔离——try/finally 保证 endCollection 配对、逐设备 try/catch 不中断整体、返回结构增加 failures 统计

## 2026-06-04

### 修复：资产列表修改后拓扑未同步更新
- **device.ts**：`updateDevice()` 新增级联同步逻辑——更新 `devices` 表后遍历所有拓扑，将拓扑节点中嵌入的设备信息（name、deviceType、connectionType、ipAddress、vendor、model）同步更新，与 `deleteDevice()` 的级联策略保持一致

### 修复：知识库 AI 助手无法识别图片
- **knowledgeBaseService.ts**：PDF 解析新增图片提取——使用 pdfjs-dist 从 PDF 页面 operator list 中提取图片对象，编码为 PNG 后调用视觉模型生成描述
- **knowledgeBaseService.ts**：搜索索引新增图片数量标记——AI 从索引中可识别哪些章节包含图片，提升图片相关问题的检索精度
- **ai.ts**：图片描述为空时提示用户检查多模态模型配置，而非静默忽略

## 2026-05-12

### 拓扑自动发现模块重写：AI 判断厂商并生成命令
- **discovery.ts**：重写 `discoverTopologyInner()` 为四阶段流程——(1) 收集设备信息 (2) AI 根据厂商/型号判断厂商并生成采集命令 (3) SSH 执行命令 (4) AI 分析输出生成拓扑。移除对 `vendor-commands.ts` 的 `detectVendor`/`getDiscoveryCommands` 依赖
- **ai.ts**：`executeCommandOnDevice()` SSH 连接成功后增加 2 秒延迟等待设备 banner/MOTD 输出完毕，超时时间从 30s 调整为 35s
- **DeviceForm.tsx**：厂商字段改为必填（`required: true`）

### AI 助手执行日志增加完整对话记录
- **数据库迁移**：`ai_exec_logs` 表新增 `prompt_text`、`ai_response` 两列，使用 PRAGMA 检查后 ALTER TABLE（避免 try-catch 静默吞掉错误）
- **aiExecLogger**：`createLog()` 增加 `promptText`/`aiResponse` 参数，`getLogs()` 返回映射增加这两个字段
- **ai.ts**：`chat()` 调用 `createLog()` 时写入完整 messages JSON 和 AI 原始响应
- **类型定义**：`AIExecLog` 接口增加 `promptText`/`aiResponse` 字段
- **日志审计页面**：`AIExecLogTab` 增加"操作"列和详情弹窗，可查看发送给 AI 的 Prompt 和 AI 原始响应

## 2026-05-10

### 布局重构：工具栏移入侧边栏
- **TopologyToolbar 移入侧边栏**：将顶部水平工具栏改为垂直布局，集成到左侧菜单栏下方（通过 zustand store 桥接状态）
- **新增 `topologyToolbarStore.ts`**：zustand store 跨组件共享拓扑工具栏状态
- **MainLayout**：Content 移除 padding（改为各页面自行管理），侧边栏增加 `overflow: auto`
- **TopologyPage**：移除顶部 TopologyToolbar 渲染，画布直接占满内容区
- **Sidebar**：在导航菜单下方渲染拓扑操作面板（选择拓扑/新建/保存/删除/导入/导出）
- **Electron 窗口**：`autoHideMenuBar: true` 隐藏菜单栏，DevTools 改为 `mode: 'detach'` 独立窗口
- **其他页面**：DevicesPage/AIPage/SettingsPage 各自添加 `padding: 16`

### 拓扑画布 UX 改进
- **选中工具栏**：`SelectionToolbar.tsx` 选中节点显示"编辑属性"+"删除"按钮，选中连线仅显示"删除"按钮，使用 React Flow `useStore` 计算视口定位
- **编辑节点属性**：`EditNodeModal.tsx` 弹窗支持编辑 deviceName/ipAddress/deviceType/vendor/model
- **连线标签中点显示**：`EdgeWithInterfaces.tsx` 使用 `getBezierPath` 的 `labelX`/`labelY` 在连线中点显示接口标签（格式：`源接口 — 目标接口`）
- **TopologyNodeData 扩展**：新增 `vendor?` 和 `model?` 字段
- **AddDeviceModal**：创建节点时携带 vendor/model 字段
- **TopologyCanvas**：集成 `onSelectionChange` 选中追踪和 SelectionToolbar
- **TopologyPage**：添加删除选中、编辑节点属性、选中状态同步

### 增强
- **Mock AI 调用真实接口**：`mock-api.ts` 的 `ai.chat` 直接调用 AI API，通过 Vite proxy 解决 CORS
- **Vite 代理配置**：`vite.config.ts` 添加 `/proxy/ai` 代理，浏览器模式可正常使用 AI 功能
- **修复 antd 废弃 API**：`destroyOnClose` → `destroyOnHidden`（DeviceForm/ConnectionModal/DiscoveryPanel）

### Bug 修复
- **AI助手不能用**：`ai.ts` `saveAiConfig` 使用 nullish coalescing 合并现有配置，避免部分字段更新时清空其他字段；`mock-api.ts` 同步修复
- **拓扑不能连线**：`DeviceNode.tsx` Handle 组件添加 `id` 属性（top/bottom/left/right），React Flow 需要 handleId 匹配才能建立连接
- **拓扑发现面板显示异常**：`DiscoveryPanel.tsx` 使用 `nodeNameMap` 将节点 ID 映射为设备名称，边列表正确显示 "设备A → 设备B" 而非 UUID

## 2026-05-09

### Task 14: 拓扑自动发现（SSH采集+AI分析）
- 新增 `electron/services/vendor-commands.ts`：厂商命令集（Huawei/Cisco/H3C 厂商检测 + 对应发现命令）
- 新增 `electron/services/discovery.ts`：拓扑发现服务（SSH 采集设备信息 + AI 分析连接关系，返回节点/边/失败设备）
- 新增 `src/components/topology/DiscoveryPanel.tsx`：发现面板 UI（设备多选、采集进度、结果展示、失败设备列表、确认导入）
- 修改 `electron/services/ai.ts`：导出 `callAI`、`executeCommandOnDevice`、`getDeviceByIdInternal` 供 discovery 复用
- 修改 `electron/main.ts`：注册 `ai:discoverTopology` IPC 处理器
- 修改 `src/types/electron.d.ts`：补全 `discoverTopology` 返回类型（含 `failedDevices`）
- 修改 `src/components/pages/TopologyPage.tsx`：添加拓扑发现按钮（FAB 区域）和 DiscoveryPanel 集成（去重合并）

### Task 13: 系统设置页面（AI配置+白名单编辑器+执行模式切换+日志查看器+退出登录）
- 新增 `src/components/settings/CommandWhitelistEditor.tsx`：命令白名单编辑器（标签列表+添加/删除+保存）
- 新增 `src/components/settings/AIExecLogViewer.tsx`：AI 执行日志表格查看器（分页、状态彩色标签、刷新）
- 新增 `src/components/settings/ExecModeSwitch.tsx`：执行模式切换（确认/自动，切换自动需密码验证弹窗）
- 替换 `src/components/pages/SettingsPage.tsx`：完整设置页（AI模型配置表单、白名单、执行模式、日志查看、退出登录）

### Task 12: AI 服务（配置+对话+设备查询+命令安全+日志）
- 新增 `electron/services/commandSafety.ts`：命令白名单安全检查（白名单前缀匹配+黑名单正则双重防护）
- 新增 `electron/services/aiExecLogger.ts`：AI 执行日志记录（创建/更新状态/查询，设备名加密存储）
- 新增 `electron/services/ai.ts`：AI 服务核心（配置管理、OpenAI兼容API调用、设备SSH命令执行、确认/自动模式、聊天历史持久化）
- 修改 `electron/main.ts`：注册 AI IPC 处理器（chat/getConfig/saveConfig/whitelist/execMode/confirm/logs/history）
- 替换 `src/components/pages/AIPage.tsx`：完整AI聊天界面（设备选择、消息气泡、确认弹窗、未配置提示）

### Task 11: 设备连接（独立弹窗终端+SSH Key）
- 新增 `electron/services/connection.ts`：连接服务（SSH/Telnet连接管理、终端窗口创建、SSH Key认证优先）
- 新增 `electron/terminal-preload.ts`：终端弹窗预加载脚本（terminalApi 桥接）
- 新增 `terminal.html`：终端弹窗 HTML 入口
- 新增 `src/terminal-main.tsx`：终端窗口独立 React 入口
- 新增 `src/components/TerminalWindow.tsx`：xterm.js 终端组件
- 修改 `electron/main.ts`：注册连接 IPC 处理器和终端窗口 IPC
- 修改 `src/types/topology.ts`：TopologyNodeData 增加 connectionType 字段
- 修改 `src/types/electron.d.ts`：增加 TerminalAPI 类型声明
- 修改 `src/components/topology/TopologyCanvas.tsx`：增加 onNodeDoubleClick 属性
- 修改 `src/components/topology/AddDeviceModal.tsx`：节点数据包含 connectionType
- 修改 `src/components/pages/TopologyPage.tsx`：双击设备节点触发连接（SSH/Telnet/Web）

### Task 10: 拓扑管理页面（含导入导出）
- 新增 `electron/services/topology.ts`：拓扑 CRUD 服务（名称/数据加密，导入导出）
- 新增 `src/components/topology/TopologyToolbar.tsx`：工具栏（选择拓扑/新建/保存/删除/导入/导出）
- 新增 `src/components/topology/AddDeviceModal.tsx`：设备选择弹窗（从设备列表添加到画布）
- 替换 `src/components/pages/TopologyPage.tsx`：完整拓扑管理（IPC CRUD、自动保存、导入导出）
- 修改 `electron/main.ts`：注册拓扑 IPC 处理器，共享 masterKey

### Task 9: React Flow 拓扑画布
- 新增 `src/types/topology.ts`：TopologyNodeData/TopologyEdgeData/Topology 类型定义
- 新增 `src/components/topology/DeviceNode.tsx`：自定义设备节点（router/switch/firewall/server/generic 图标，设备名悬浮在图标上方）
- 新增 `src/components/topology/EdgeWithInterfaces.tsx`：自定义连线，靠近源/目标节点显示接口标签
- 新增 `src/components/topology/ConnectionModal.tsx`：Ant Design 弹窗，连接时输入源/目标接口名称
- 新增 `src/components/topology/TopologyCanvas.tsx`：React Flow 画布主组件（Controls/MiniMap/Background）
- 替换 `src/components/pages/TopologyPage.tsx`：拓扑管理页面（本地状态管理，Task 10 接入 IPC）
- 新增 `src/vite-env.d.ts`：CSS 模块声明
- 修改 `src/main.tsx`：全局引入 reactflow/dist/style.css

### Task 8: 设备管理 CRUD
- 新增 `src/types/device.ts`：Device/CreateDeviceDTO/UpdateDeviceDTO 类型定义
- 新增 `electron/services/device.ts`：设备 CRUD 服务（全字段加密、级联删除拓扑节点）
- 新增 `src/components/DeviceForm.tsx`：设备表单（设备类型选择、连接方式联动、SSH Key 支持）
- 替换 `src/components/pages/DevicesPage.tsx`：设备管理页面（列表/添加/编辑/删除）
- 修改 `electron/main.ts`：引入 device 服务、masterKey 共享、注册设备 IPC 处理器

### Task 5: 认证服务
- 新增 `electron/services/auth.ts`：验证码生成/验证、登录、首次运行检测、管理员初始化
- 修改 `electron/main.ts`：集成数据库初始化、密钥管理器、认证 IPC 处理器
- 新增 `tests/unit/auth.test.ts`：验证码相关单元测试（4 cases 全部通过）

## 2026-07-02 Phase 5 执行
- fix(05): AIPage useEffect dep `[chat]`→`[]` 修无限重渲染回归（code review CR-01，FE-01 拆分引入；useAIChat 每渲染返回新对象致 IPC 风暴）
