# Technology Stack

**Analysis Date:** 2026-06-28

## Languages

**Primary:**
- TypeScript `^6.0.3` — renderer (`src/`) + Electron main/preload (`electron/`), strict mode enforced
- SQL (DDL + prepared statements) — embedded in `electron/database/init.ts` (schema), `electron/database/migrations.ts` (versioned migrations), and across `electron/services/*.ts`

**Secondary:**
- HTML — `index.html` (主窗口), `terminal.html` (终端窗口)
- CSS — `src/styles/global.css`
- SVG — `src/assets/icons/{router,switch,firewall,server,equipment}.svg` (拓扑节点图标)
- JavaScript (CJS, build artifacts) — `scripts/build-electron.cjs`, emitted `dist-electron/*.js`

## Runtime

**Environment:**
- Electron `^41.0.3` (Chromium + Node, desktop runtime)
- Node.js (bundled by Electron; native modules rebuilt via `@electron/rebuild`)
- 目标平台：Windows x64 (NSIS 安装包，`electron-builder.yml`)

**Package Manager:**
- npm (`package-lock.json` present, lockfile version via package-lock)
- `"type": "module"` — renderer 与 vite 用 ESM；Electron main/preload 经 esbuild 打包为 CJS (`--format=cjs`)

## Frameworks

**Core:**
- React `^19.2.6` + `react-dom` `^19.2.6` — renderer UI (`src/main.tsx`, `src/App.tsx`)
- React Router `react-router-dom` `^7.15.0` — 页面路由
- Ant Design `antd` `^6.3.7` + `@ant-design/icons` `^6.2.2` — 组件库
- React Flow `reactflow` `^11.11.4` — 拓扑可视化画布 (`src/components/topology/TopologyCanvas.tsx`)
- Zustand `^5.0.13` — 客户端状态 (`src/stores/authStore.ts`, `src/stores/topologyToolbarStore.ts`)
- Electron IPC (`ipcMain.handle` / `contextBridge`) — 主进程↔渲染进程桥 (`electron/main.ts`, `electron/preload.ts`)

**Testing:**
- Vitest `^4.1.5` — 单测 runner (`vitest.config.ts`, `tests/**/*.test.ts`)
- jsdom `^29.1.1` — DOM 环境（devDependency，当前 vitest `environment: 'node'`）

**Build/Dev:**
- Vite `^8.0.11` + `@vitejs/plugin-react` `^6.0.1` — renderer 构建/dev server (`vite.config.ts`, port 5173 strictPort)
- esbuild `^0.28.0` — Electron main/preload 打包 (`npm run build:electron-main`, `build:preload`)
- `tsc -p tsconfig.web.json` — renderer 类型检查（strict + noUnusedLocals，CI gate）
- electron-builder `^26.8.1` — Windows NSIS 打包 (`electron-builder.yml`)
- concurrently `^9.2.1`, wait-on `^9.0.5`, cross-env `^10.1.0` — `electron:dev` 编排
- `@electron/rebuild` `^4.0.4` — native 模块按 Electron ABI 重建

## Key Dependencies

**Critical (native / 平台绑定):**
- `better-sqlite3` `12.9.0` — 同步 SQLite，存储 `topology.db`（WAL）。`.node` 二进制需 `npmRebuild`。类型 `@types/better-sqlite3`。
- `ssh2` `1.17.0` — 纯 JS SSH 客户端（终端 + AI 命令执行）。类型 `@types/ssh2`。
- `telnet-client` `2.2.13` — Telnet 客户端（用于 `electron/services/arpCollector.ts` ARP 采集，非终端连接——终端 Telnet 走原生 `net` 模块）。

**Critical (功能核心):**
- `reactflow` `^11.11.4` — 拓扑编辑/渲染核心
- `antd` `^6.3.7` + `@ant-design/icons` — UI 组件
- `xterm` `^5.3.0` + `xterm-addon-fit` `^0.8.0` — 终端模拟器前端（终端窗口 `src/terminal-main.tsx`）
- `mammoth` `^1.12.0` — 知识库 `.docx` → HTML 解析 (`electron/services/knowledgeBaseService.ts`)

**Infrastructure (运行时工具):**
- `uuid` `^14.0.0` — 主键/批次 ID 生成 (`v4 as uuidv4`)
- `iconv-lite` (transitive, present in `node_modules`) — 设备输出 GBK↔UTF-8 解码 (`decodeDeviceBuffer`/`decodeBuffer` in `electron/services/ai.ts`, `connection.ts`)。**未在 package.json 显式声明，属隐式依赖。**

**⚠️ 缺失/未声明依赖:**
- `pdfjs-dist` — `electron/services/knowledgeBaseService.ts:393` 动态 `import('pdfjs-dist/legacy/build/pdf.mjs')` 用于 PDF 解析，且 `package.json` build script 将其标为 `--external:pdfjs-dist`，但该包**不在 `dependencies`/`devDependencies`，也不在 `package-lock.json`，`node_modules/pdfjs-dist` 不存在**。PDF 知识库解析路径在当前依赖树下会运行时失败。

## Configuration

**TypeScript (三份 tsconfig):**
- `tsconfig.json` — solution references 聚合（`files: []` + references）
- `tsconfig.web.json` — renderer：`target ES2020`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `jsx react-jsx`, path alias `@/* → ./src/*`, `noEmit`（类型检查 gate，产物由 vite 出）
- `tsconfig.node.json` — Electron main：`composite`, `module ESNext`, `moduleResolution bundler`, `outDir dist-electron`, `rootDir electron`

**Build config:**
- `vite.config.ts` — alias `@`, `base './'`, manualChunks 分包 (`vendor-react`/`vendor-antd`/`vendor-reactflow`), dev proxy `/proxy/ai → ${VITE_AI_PROXY_TARGET||https://ark.cn-beijing.volces.com}` (changeOrigin + path rewrite)
- `vitest.config.ts` — `environment: node`, `tests/**/*.test.ts`, `server.deps.inline: ['../../electron']` (允许测试 import 主进程模块), alias `@`
- `electron-builder.yml` — NSIS x64，`asarUnpack: **/*.node + better-sqlite3 + ssh2`，严格 `files` 过滤（排除 `src/`, `electron/`, `tests/`, `docs/`, `scripts/`, `*.ts/tsx/map`），`npmRebuild: true`，语言包限 zh-CN/en-US

**Environment:**
- Dev：`NODE_ENV=development` 区分（vite HMR、严格 CSP 在 dev 跳过、`loadURL http://localhost:5173`）
- 可选：`VITE_AI_PROXY_TARGET`（dev server AI 代理目标，默认火山方舟）
- 数据/密钥存储：`app.getPath('userData')` 下 `topology.db`(+`-wal`/`-shm`)、`backups/`、`kb_files/`、`kb_images/`、master key 文件（见 INTEGRATIONS.md）

**ESLint/Prettier:** 未检测到配置文件 (`.eslintrc*`, `.prettierrc*`, `eslint.config.*`, `biome.json` 均缺失)。代码风格由 `tsconfig` strict + code review 约束。

## Platform Requirements

**Development:**
- Node.js + npm，Windows 环境（打包目标为 win x64）
- `@electron/rebuild` 用于 native 模块（`better-sqlite3`）ABI 对齐 Electron 41
- 启动：`npm run electron:dev`（构建 electron → vite → wait-on 5173 → electron .）

**Production:**
- Windows 桌面安装包（NSIS, `appId: com.network-topology.manager`, productName `网络拓扑管理工具`）
- 单机本地 SQLite，无服务端依赖
- 禁止打包用户数据/DB/账号进安装包（`electron-builder.yml` `files` 排除规则 + `CLAUDE.md` 约束）

---

*Stack analysis: 2026-06-28*
