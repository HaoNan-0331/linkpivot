# Technology Stack

**Analysis Date:** 2026-07-26 · **2026-08-07 增量刷新**（v1.1 Phases 7-11 落地后补录经验沉淀能力栈）

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
- Vitest `^4.1.5` — 单测 runner (`vitest.config.ts`, `tests/**/*.test.ts` + `electron/**/*.test.ts` co-located)
- jsdom `^29.1.1` — DOM 环境（devDependency，当前 vitest `environment: 'node'`）

**Build/Dev:**
- Vite `^8.0.11` + `@vitejs/plugin-react` `^6.0.1` — renderer 构建/dev server (`vite.config.ts`, port 5173 strictPort)
- esbuild `^0.28.0` — Electron main/preload 打包 (`npm run build:electron-main`, `build:preload`)
- `tsc -p tsconfig.web.json` — renderer 类型检查（strict + noUnusedLocals，CI gate）
- electron-builder `^26.8.1` — Windows NSIS 打包 (`electron-builder.yml`)
- concurrently `^9.2.1`, wait-on `^9.0.5`, cross-env `^10.1.0` — `electron:dev` 编排
- `@electron/rebuild` `^4.0.4` — native 模块按 Electron ABI 重建（`rebuild:native` = `electron-rebuild -f -w better-sqlite3 -w ssh2`，CI build-smoke job 与本地 build 前置均经此）

## Key Dependencies

**Critical (native / 平台绑定):**
- `better-sqlite3` `12.9.0` — 同步 SQLite，存储 `topology.db`（WAL）。`.node` 二进制需 `npmRebuild`（CI build-smoke 校验产物存在）。类型 `@types/better-sqlite3`。
- `ssh2` `1.17.0` — 纯 JS SSH 客户端（终端 + AI 命令执行）。类型 `@types/ssh2`。
- `telnet-client` `2.2.13` — Telnet 客户端（用于 `electron/services/arpCollector.ts` ARP 采集，非终端连接——终端 Telnet 走原生 `net` 模块）。

**Critical (功能核心):**
- `reactflow` `^11.11.4` — 拓扑编辑/渲染核心
- `antd` `^6.3.7` + `@ant-design/icons` — UI 组件
- `xterm` `^5.3.0` + `xterm-addon-fit` `^0.8.0` — 终端模拟器前端（终端窗口 `src/terminal-main.tsx`）
- `mammoth` `^1.12.0` — 知识库 `.docx` → HTML 解析 (`electron/services/knowledgeBaseService.ts`)
- `pdfjs-dist` `^6.1.200` — 知识库 PDF 解析，`electron/services/knowledgeBaseService.ts:413` 动态 `import('pdfjs-dist/legacy/build/pdf.mjs')`（在 `parsePdf` 内，`getDocument` 抽取文本）。已显式声明于 `package.json` `dependencies`，esbuild main 打包脚本 `--external:pdfjs-dist` 保留运行时动态 import，PDF 解析路径可正常工作。

**经验沉淀能力栈（v1.1 Phases 7-11 新增，2026-08-07 补录）:**
> v1.1 经验子系统为纯 TS + better-sqlite3 + 复用现有 LLM 通道（`callAI`），**无新外部依赖**，全部为项目内 service 模块。LLM 输出统一走「prompt 强 schema + JSON 解析校验」模式，未引入 OpenAI function-calling SDK。

- **经验检索 `electron/services/experienceRetrieval.ts`** — `retrieveForAnswer()` 编排：粗筛（listExperiences by category/device，复用 `experienceService`）→ 精排（调 `experienceRerank`）→ 阈值过滤（`RELEVANCE_THRESHOLD=0.6`）→ top INJECT_LIMIT 注入 chat prompt + 更新 `reuse_count`/`last_verified_at`（复用计数）。ai.ts chat 内调用，命中经验作引用溯源注入回复。
- **经验精排 `electron/services/experienceRerank.ts`** — `rerank()` 喂 LLM 强 schema 打分（每条 `{exp_id, score, reason}`，score 边界归一化）；`extractJsonArray` 提取 + `validateRerank` 校验；`buildRerankPrompt` 构造 system/user。`RELEVANCE_THRESHOLD` 作为模块常量被 retrieval 复用。
- **经验起草 `electron/services/draftingService.ts` + `experienceDrafting.ts`** — 两阶段编排：阶段 A `draftSession()` 纯起草（`validateDrafts` 强 schema JSON）+ 阶段 B `judgeVerdicts()` 复判（`validateVerdicts` 校验，按 category 窄查喂 LLM，覆盖 verdict + dupId）；`summarizeSessionForUi()`（experienceDrafting.ts:70）串接两阶段，IPC 入口 `experience:summarizeSession`。`buildDraftingPrompt`/`buildVerdictPrompt` 构造 prompt。
- **重复检测 `electron/services/duplicateDetector.ts`** — `findExistingForDraft()` 按 draft.category 窄查存量经验摘要喂 judgeVerdicts 复判（编排层调用，非独立 LLM 调用）；命中经 `duplicate_of_exp_id` 列（migrations v9）链向存量。
- **PII 分级脱敏 `electron/utils/piiMask.ts`** — 纯字符串 transform（无 DB/LLM 依赖）：`maskCredentials` / `maskIpv4` / `maskMac` / `maskConversationText`。会话正文进起草 prompt 前先脱敏，分级（凭证全脱敏 / IP/MAC 部分掩码）。
- **经验数据层 `electron/services/experienceService.ts`** — 函数式 service（非静态类，持模块级 `MK`），CRUD + browse/filter/sort + `incReuseCount`/`touchLastVerifiedAt` + `backfillSeverityFromHistory`（启动钩子，main.ts:112）；masterKey 经 `setExperienceMasterKey`（experienceService.ts:29）启动注入。表 `experiences` + `exp_device_rel` 详见 INTEGRATIONS.md「Data Storage」。
- **经验类型 `src/types/experience.ts`** — Experience/Draft/Verdict/Rerank 等 DTO 定义（renderer + main 共享），TD-1 any 收口的目标建模参考。

**Infrastructure (运行时工具):**
- `uuid` `^14.0.0` — 主键/批次 ID 生成 (`v4 as uuidv4`)
- `iconv-lite` (transitive, present in `node_modules`) — 设备输出 GBK↔UTF-8 解码 (`decodeDeviceBuffer`/`decodeBuffer` in `electron/services/ai.ts`, `connection.ts`)。**未在 package.json 显式声明，属隐式依赖。**

## Configuration

**TypeScript (三份 tsconfig):**
- `tsconfig.json` — solution references 聚合（`files: []` + references）
- `tsconfig.web.json` — renderer：`target ES2020`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `jsx react-jsx`, path alias `@/* → ./src/*`, `noEmit`（类型检查 gate，产物由 vite 出）
- `tsconfig.node.json` — Electron main：`composite`, `module ESNext`, `moduleResolution bundler`, `outDir dist-electron`, `rootDir electron`

**Build config:**
- `vite.config.ts` — alias `@`, `base './'`, manualChunks 分包 (`vendor-react`/`vendor-antd`/`vendor-reactflow`), dev proxy `/proxy/ai → ${VITE_AI_PROXY_TARGET||https://ark.cn-beijing.volces.com}` (changeOrigin + path rewrite)
- `vitest.config.ts` — `environment: node`, `tests/**/*.test.ts` + `electron/**/*.test.ts`（v1.1 后 co-located 测试并入）, `server.deps.inline: ['../../electron']` (允许测试 import 主进程模块), alias `@`
- `electron-builder.yml` — NSIS x64，`asarUnpack: **/*.node + better-sqlite3 + ssh2`，严格 `files` 过滤（排除 `src/`, `electron/`, `tests/`, `docs/`, `scripts/`, `*.ts/tsx/map`），`npmRebuild: true`，语言包限 zh-CN/en-US
- `.github/workflows/build-smoke.yml` — CI 冒烟 job（windows-latest + node 20 + npm ci + rebuild:native + build + test + 校验 .node 产物，详见 INTEGRATIONS.md「CI/CD」）

**Environment:**
- Dev：`NODE_ENV=development` 区分（vite HMR、严格 CSP 在 dev 跳过、`loadURL http://localhost:5173`）
- 可选：`VITE_AI_PROXY_TARGET`（dev server AI 代理目标，默认火山方舟）
- 数据/密钥存储：`app.getPath('userData')` 下 `topology.db`(+`-wal`/`-shm`)、`backups/`、`kb_files/`、`kb_images/`、master key 文件（见 INTEGRATIONS.md）

**ESLint/Prettier:** 未检测到配置文件 (`.eslintrc*`, `.prettierrc*`, `eslint.config.*`, `biome.json` 均缺失)。代码风格由 `tsconfig` strict + code review 约束。

## Platform Requirements

**Development:**
- Node.js + npm，Windows 环境（打包目标为 win x64）
- `@electron/rebuild` 用于 native 模块（`better-sqlite3` / `ssh2`）ABI 对齐 Electron 41 — 本地 `npm run rebuild:native` = `electron-rebuild -f -w better-sqlite3 -w ssh2`
- 启动：`npm run electron:dev`（构建 electron → vite → wait-on 5173 → electron .）

**Production:**
- Windows 桌面安装包（NSIS, `appId: com.network-topology.manager`, productName `网络拓扑管理工具`）
- 单机本地 SQLite，无服务端依赖
- 禁止打包用户数据/DB/账号进安装包（`electron-builder.yml` `files` 排除规则 + `CLAUDE.md` 约束）

---

*Stack analysis: 2026-07-26 · 增量刷新 2026-08-07（v1.1 Phases 7-11 落地后补录经验沉淀能力栈 + rebuild:native / CI build-smoke）*
