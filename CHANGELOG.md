# CHANGELOG

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
