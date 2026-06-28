# Codebase Structure

**Analysis Date:** 2026-06-28

## Directory Layout

```
network_toplogy/
├── electron/                 # 主进程 + preload（Node 信任边界）
│   ├── main.ts               # 入口：app.whenReady 启动序列
│   ├── preload.ts            # 主窗口 preload → window.api
│   ├── terminal-preload.ts   # 终端窗口 preload
│   ├── services/             # 业务层（领域逻辑 + DB 读写 + 加解密）
│   ├── database/             # 数据层（better-sqlite3 + 迁移 + ACL）
│   ├── ipc/                  # IPC 网关层（模块化 ipcMain.handle 注册）
│   └── utils/                # 安全原语（crypto/authGuard/keyManager/webSecurity）
├── src/                      # renderer（React 19，纯 UI，无 Node）
│   ├── main.tsx              # renderer 入口
│   ├── App.tsx               # 首启/登录/主布局分流
│   ├── terminal-main.tsx     # 终端窗口 renderer 入口
│   ├── components/           # UI 组件
│   │   ├── pages/            # 路由级页面（AI/Devices/Topology/IP/Knowledge/Log/Settings）
│   │   ├── topology/         # 拓扑画布相关（React Flow 节点/边/工具栏/模态框）
│   │   ├── ip-management/    # IP 管理标签页（ARP/Network/Anomaly/OUI）
│   │   ├── settings/         # 设置（命令白名单编辑/执行模式/日志查看）
│   │   └── *.tsx             # 通用组件（MainLayout/Sidebar/Login/ErrorBoundary 等）
│   ├── stores/               # Zustand store
│   ├── types/                # 共享 TS 类型 + electron.d.ts（window.api 类型声明）
│   ├── styles/               # 全局 CSS
│   └── assets/               # 静态资源
├── tests/unit/               # vitest 单测（auth/crypto/migrationHelpers）
├── scripts/                  # 构建脚本（build-electron.cjs）
├── build/                    # electron-builder 图标等
├── public/                   # 静态公共资源
├── docs/                     # 项目文档
├── index.html                # 主窗口 HTML
├── terminal.html             # 终端窗口 HTML
├── package.json              # main: dist-electron/main.js
├── vite.config.ts            # renderer 构建
├── vitest.config.ts          # 测试配置
├── tsconfig.json / tsconfig.web.json / tsconfig.node.json  # 多 tsconfig
├── electron-builder.yml      # 打包配置（排除用户数据/DB/账号）
└── CHANGELOG.md              # 变更记录
```

## Directory Purposes

**`electron/services/`（业务层）:**
- Purpose: 领域逻辑 + DB 读写 + 字段加解密 + 外部协议。
- Contains: 20 个 `.ts` 文件，每个服务持有模块级 `MK`，由 `setXxxMasterKey()` 注入。
- Key files: `device.ts`/`topology.ts`/`ai.ts`/`connection.ts`/`commandSafety.ts`/`discovery.ts`/`knowledgeBaseService.ts`/`arpCollector.ts`/`ouiService.ts`/`networkSegmentService.ts`/`anomalyService.ts`/`schedulerService.ts`/`backupScheduler.ts`/`systemLog.ts`/`aiExecLogger.ts`/`auth.ts`/`vendor-commands.ts`。

**`electron/database/`（数据层）:**
- Purpose: better-sqlite3 生命周期、基线 DDL、版本化迁移、文件 ACL。
- Key files: `connection.ts`（init/close/migrateAndSecure）、`init.ts`（createTables+seed）、`migrations.ts`（注册表 `MIGRATION_HEAD=7`）、`migrationHelpers.ts`（`hasColumn` 等幂等守卫）、`acl.ts`（`restrictFilePermissions`/`restrictDirPermissions`）。

**`electron/ipc/`（IPC 网关层）:**
- Purpose: 模块化注册 `ipcMain.handle`，含参数校验与 `secure()` 包裹。
- Key files: `arpIpc.ts`/`networkIpc.ts`/`anomalyIpc.ts`/`ouiIpc.ts`/`exportIpc.ts`/`schedulerIpc.ts`/`knowledgeBaseIpc.ts`。
- 注：auth/device/topology/connection/ai 的 IPC 仍 inline 在 `electron/main.ts`。

**`electron/utils/`（工具层）:**
- Purpose: 横切安全原语。
- Key files: `crypto.ts`（AES-256-GCM + PBKDF2）、`keyManager.ts`（masterKey + safeStorage）、`authGuard.ts`（`secure`/`safe`/登录态/脱敏）、`webSecurity.ts`（窗口加固）。

**`src/components/pages/`（路由页面）:**
- Purpose: 一页一文件，对应侧边栏导航。
- Key files: `TopologyPage.tsx`/`DevicesPage.tsx`/`AIPage.tsx`/`IpManagementPage.tsx`/`KnowledgeBasePage.tsx`/`LogAuditPage.tsx`/`SettingsPage.tsx`。

**`src/components/topology/`（拓扑画布）:**
- Purpose: React Flow 拓扑渲染与交互。
- Key files: `TopologyCanvas.tsx`（画布）、`DeviceNode.tsx`（节点）、`EdgeWithInterfaces.tsx`（边）、`TopologyToolbar.tsx`、`AddDeviceModal.tsx`/`EditNodeModal.tsx`/`ConnectionModal.tsx`、`SelectionToolbar.tsx`、`DiscoveryPanel.tsx`。

**`src/components/ip-management/`（IP 管理标签）:**
- Purpose: IP 监控模块的标签页（network-ip 合并而来）。
- Key files: `NetworkTab.tsx`/`ArpTab.tsx`/`AnomalyTab.tsx`/`OuiTab.tsx`。

**`src/components/settings/`（设置组件）:**
- Purpose: AI 执行安全相关设置 UI。
- Key files: `CommandWhitelistEditor.tsx`/`ExecModeSwitch.tsx`/`AIExecLogViewer.tsx`。

**`src/stores/`（Zustand）:**
- Purpose: renderer 全局/跨组件状态。
- Key files: `authStore.ts`（登录态）、`topologyToolbarStore.ts`（拓扑工具栏态）。

**`src/types/`（共享类型）:**
- Purpose: TS 类型定义，含 IPC 契约。
- Key files: `electron.d.ts`（`window.api` 类型声明）、`device.ts`/`topology.ts`/`network.ts`/`arp.ts`/`anomaly.ts`/`oui.ts`/`backup.ts`。

**`tests/unit/`（单测）:**
- Purpose: vitest 单元测试。
- Key files: `crypto.test.ts`/`auth.test.ts`/`migrationHelpers.test.ts`。

## Key File Locations

**Entry Points:**
- `electron/main.ts`: 主进程入口（`app.whenReady` 启动序列）。
- `electron/preload.ts`: 主窗口 preload，暴露 `window.api`。
- `src/main.tsx`: renderer 入口（React root + ConfigProvider + ErrorBoundary）。
- `src/terminal-main.tsx`: 终端窗口 renderer 入口。
- `index.html` / `terminal.html`: 两个窗口的 HTML 宿主。

**Configuration:**
- `package.json`: scripts（dev/build/electron:dev/electron:build/test）、依赖、`main: dist-electron/main.js`。
- `vite.config.ts`: renderer（vite + @vitejs/plugin-react）构建。
- `tsconfig.web.json`: renderer 严格 TS（`noUnusedLocals`）。
- `tsconfig.node.json` / `tsconfig.json`: 主进程 TS。
- `electron-builder.yml`: 打包与文件排除规则。
- `vitest.config.ts`: 测试配置。

**Core Logic:**
- `electron/utils/crypto.ts`: 加密原语。
- `electron/utils/authGuard.ts`: 鉴权网关。
- `electron/database/connection.ts`: DB 生命周期 + 迁移编排。
- `electron/services/commandSafety.ts`: 命令白名单语义校验。

**Testing:**
- `tests/unit/*.test.ts`: vitest 单测。

## Naming Conventions

**Files:**
- 主进程服务/工具：`camelCase.ts`（如 `commandSafety.ts`、`authGuard.ts`）。
- IPC 注册文件：`<domain>Ipc.ts`（如 `networkIpc.ts`、`arpIpc.ts`）。
- React 组件：`PascalCase.tsx`（如 `TopologyCanvas.tsx`、`DeviceNode.tsx`）。
- 路由页面：`<Name>Page.tsx`（如 `TopologyPage.tsx`）。
- 类型定义：`kebab/dot`（`electron.d.ts`）或领域名（`device.ts`、`topology.ts`）。
- 测试：`<module>.test.ts`（如 `crypto.test.ts`）。
- 加密列：`<field>_enc`（如 `password_enc`、`api_key_enc`、`name_enc`）。

**Directories:**
- 业务域小写复数（`services`/`database`/`ipc`/`utils`/`stores`/`types`）。
- 组件域 kebab-case（`ip-management`）或小写（`topology`/`pages`/`settings`）。

**IPC channel 命名:**
- `<domain>:<action>`（如 `device:list`、`topology:create`、`ai:chat`、`connection:ssh`、`network:getIPDetails`）。
- 终端数据回推用参数化 channel：`connection:data:<sessionId>`。

**导出:**
- service 用具名函数导出（`export function listDevices()`），不用 default。
- React 组件用 default 导出（`export default function App()`）。

## Where to Add New Code

**新业务域（CRUD 服务）:**
- 业务逻辑: `electron/services/<domain>.ts`，顶部 `let MK=''` + `export function set<Domain>MasterKey(key)`，并在 `electron/main.ts` 启动序列调 `set<Domain>MasterKey(masterKey)`。
- IPC 网关: 新建 `electron/ipc/<domain>Ipc.ts`，导出 `register<Domain>Ipc()`，每个 `ipcMain.handle('<domain>:<action>', secure(fn))`，并在 `electron/main.ts` 调 `register<Domain>Ipc()`。
- preload 暴露: 在 `electron/preload.ts` 的 `api` 对象加 `<domain>: { ... }`，每方法 `ipcRenderer.invoke('<domain>:<action>', ...)`。
- 类型契约: 在 `src/types/electron.d.ts` 补 `window.api.<domain>` 类型。

**新 IPC channel（已有域）:**
- service 函数: 对应 `electron/services/<domain>.ts`。
- 注册: inline 域加到 `electron/main.ts`；模块化域加到 `electron/ipc/<domain>Ipc.ts`。特权 handler 必须包 `secure()`，登录前 handler 用 `safe()`。
- preload + `electron.d.ts`: 同步暴露与类型。

**新 DB 表/列:**
- 基线表: 加到 `electron/database/init.ts` 的 `createTables()` DDL（`CREATE TABLE IF NOT EXISTS`）。
- 增量列/数据迁移: 加到 `electron/database/migrations.ts` 新增 `v8` 步骤（包单事务 + `hasColumn` 幂等守卫），并 bump `MIGRATION_HEAD`。不得在 `init.ts` 散落 `ALTER`。
- 敏感字段: 列名 `<field>_enc`，读写用 `encField`/`decField`（`electron/utils/crypto.ts`）。

**新 React 页面:**
- 页面组件: `src/components/pages/<Name>Page.tsx`（default 导出）。
- 路由: 在 `src/components/MainLayout.tsx`（或路由配置）登记。
- 侧边栏入口: `src/components/Sidebar.tsx`。

**新拓扑元素:**
- 节点/边/模态: `src/components/topology/`。

**新共享类型:**
- `src/types/<domain>.ts`，并在需要处 import。

**新单测:**
- `tests/unit/<module>.test.ts`，vitest 风格。

**Utilities / 共享 helper:**
- 主进程横切: `electron/utils/`。
- renderer 共享: 直接在 `src/components/` 或新建 `src/utils/`（当前未单独建 utils 目录，通用组件放 `src/components/`）。

## Special Directories

**`dist/`:**
- Purpose: vite renderer 构建产物。
- Generated: Yes（`vite build`）。
- Committed: No（`.gitignore`）。

**`dist-electron/`:**
- Purpose: esbuild 打包的主进程/preload 产物（`main.js`/`preload.js`/`terminal-preload.js`）。
- Generated: Yes（`npm run build:electron`）。
- Committed: No。

**`build/`:**
- Purpose: electron-builder 资源（图标等）。
- Generated: No。
- Committed: Yes。

**`.planning/`:**
- Purpose: GSD 工作流产物（`PROJECT.md`/`REQUIREMENTS.md`/`ROADMAP.md`/`STATE.md`/`phases/`/`codebase/`）。
- Generated: 部分（由 `/gsd-*` 命令维护）。
- Committed: Yes。

**`.codegraph/`:**
- Purpose: CodeGraph 符号索引（SQLite 知识图谱）。
- Generated: Yes（`codegraph init`）。
- Committed: No（应忽略）。

**`docs/`:**
- Purpose: 项目文档。
- Committed: Yes。

**用户数据（运行时，非仓库内）:**
- `app.getPath('userData')` 下的 `topology.db`（+ `-wal`/`-shm`）、`master.key`（safeStorage 加密）、`backups/`。禁止打包进安装包（`electron-builder.yml` 排除规则）。

---

*Structure analysis: 2026-06-28*
