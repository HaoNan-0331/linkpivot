<!-- GSD:project-start source:PROJECT.md -->
## Project

**network_toplogy**

network_toplogy 是面向运维人员的网络拓扑管理桌面工具（Electron + React + TypeScript + better-sqlite3）。运维人员用它可视化网络拓扑、远程连接并操控设备（SSH/Telnet/Web/RDP）、通过 AI 助手辅助分析与执行运维命令，并维护设备资料与运维知识库。

**Core Value:** 让运维人员在一个桌面工具内安全地掌握网络拓扑、远程操控设备并获得 AI 辅助分析——拓扑准确呈现与设备安全可控是最高优先级，其余皆可让步。

### Constraints

- **Tech stack**: Electron + React + TS + better-sqlite3 — 不更换核心栈
- **Compatibility**: 加密/迁移改动必须向后兼容历史数据
- **Security**: 分两层语义，不可混用——
  - **操作规范（约束 Claude Code 本地连设备的行为）**: Claude Code 远程连接任何设备时**必须使用 SSH 密钥认证**，禁止密码认证（沿用全局安全规范）。
  - **产品功能约束（约束 network_toplogy 应用代码）**: 应用层支持 **SSH（密钥 + 密码双通道）/ Telnet / Web / RDP** 四类远程通道是设计意图（运维场景大量设备仅支持密码认证，必须兼容）；命令白名单执行层强制校验（`commandSafety.isCommandAllowed`）、IPC 鉴权网关（`authGuard.secure`/`safe`）——后两者不可回退。
- **Build**: tsconfig.web.json 严格模式 + noUnusedLocals 必须全绿；electron main 用 esbuild 打包，native/平台依赖外部化清单 `better-sqlite3` / `ssh2` / `telnet-client` / `electron` / `pdfjs-dist`（见 `package.json` `build:electron-main`）
- **Packaging**: 禁止打包用户数据/账号/DB 进安装包（electron-builder.yml 排除规则）
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Electron 三进程桌面应用（main / preload / renderer）。详见 `.planning/codebase/STACK.md`。

- **语言**: TypeScript（strict）为主，覆盖 renderer(`src/`) 与 Electron main/preload(`electron/`)；SQL 内嵌于 `electron/database/{init,migrations}.ts` 及各 service。
- **运行时**: Electron 41（Chromium + Node），Windows x64 NSIS 安装包；native 模块经 `@electron/rebuild` 按 ABI 重建。
- **核心框架**: React 19 + react-router-dom 7 + Ant Design 6 + React Flow 11（拓扑画布）+ Zustand 5（renderer 状态）。
- **数据/加密**: better-sqlite3 12.9.0（同步 SQLite，WAL）；AES-256-GCM 字段级加密（`crypto.ts`，PBKDF2 派生 + 派生密钥 LRU 缓存）；masterKey 经 `keyManager.ts` 走 safeStorage（Windows DPAPI）落盘。
- **远程协议**: ssh2 1.17.0（SSH 终端 + AI 命令执行）、telnet-client 2.2.13（ARP 采集）、原生 `net`（Telnet 终端）、.rdp 文件 + xfreerdp 通道（RDP）、`openExternalSafe`（Web）。
- **构建**: Vite 8（renderer）+ esbuild 0.28（main/preload，CJS bundle）+ `tsc -p tsconfig.web.json`（严格类型 gate）；electron-builder 26 NSIS 打包。
- **测试**: Vitest 4（详见 TESTING.md）。无 ESLint/Prettier，风格由 tsconfig strict + code review 约束。
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

详见 `.planning/codebase/CONVENTIONS.md`。核心红线：

- **Service 风格**: 静态类 facade（`export class XService { static ... }`，全方法 static，内部调 `getDatabase()`，不持实例状态；缓存例外挂 `private static`）——`ouiService.ts`/`anomalyService.ts` 为范例；加密型 service 也允许函数式 + 模块级 `MK` 变体。新建 service 沿用静态类模式，不要 `new` 实例化。
- **IPC 鉴权（红线，不可回退）**: 每个 IPC handler 必须经 `secure(...)`（特权通道：鉴权 + 异常脱敏）或 `safe(...)`（登录前通道：仅脱敏）包装；channel 命名 `<domain>:<action>`；批量上限模块常量 `MAX_BATCH = 1000`。
- **字段加密**: 敏感列以 `_enc` 后缀存 AES-256-GCM 密文；读写加密列**只走** `encField`/`decField`（自带 null/降级处理），禁止裸调 `encrypt`/`decrypt`。
- **DB 性能/原子性**: 循环外 `db.prepare()` 复用 prepared statement（消除重复解析）；多写操作包 `db.transaction(() => {...})()`；迁移步骤必须自带幂等守卫（`hasColumn` 或 `sqlite_master.sql` 特征串判定），不靠 `user_version` 判定。
- **masterKey 注入**: service 不直接读 keyManager，启动时由 `main.ts` 经 `setXxxMasterKey()` 注入（便于测试/解耦）。
- **命名**: 文件 `camelCase.ts`（service/util）/ `PascalCase.tsx`（React 组件）/ `<domain>Ipc.ts`（IPC 注册）；模块级常量 `UPPER_SNAKE_CASE`。
- **格式**: 缩进 2 空格、单引号、无分号、尾随逗号（多行）——事实约定，无 formatter 配置，手工保持一致。
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Electron 三进程 + 分层单进程后端。详见 `.planning/codebase/ARCHITECTURE.md`。

- **信任边界**: main 进程是唯一持有 Node/DB/masterKey 的信任边界；renderer `contextIsolation:true` + `sandbox:true` + `nodeIntegration:false`，仅经 preload `contextBridge` 暴露的白名单 `window.api.*` 访问能力，永远拿不到明文凭证（只接收 `****xxxx` 脱敏形式）。
- **分层**: IPC 网关层（`electron/ipc/*Ipc.ts` + `main.ts` inline，`secure`/`safe` 鉴权脱敏）→ 业务层（`electron/services/*.ts`，持模块级 `MK`，纯函数 + 同步 better-sqlite3）→ 数据层（`electron/database/`，单例 `db` + WAL + 版本化迁移 + 文件 ACL）→ 工具层（`electron/utils/`，crypto/keyManager/authGuard/webSecurity）。
- **命令执行安全层**: AI/远程执行命令统一过 `commandSafety.isCommandAllowed()`（分隔符注入拦截 → 黑名单首词 → 白名单首词严格相等），`exec_mode`（confirm/auto）决定是否二次确认。
- **远程会话映射**: `sessions: Map<sessionId, ActiveSession>` + `windowSessionMap: Map<webContentsId, sessionId>`，按 webContents.id 隔离注入终端窗口 ↔ SSH/Telnet 会话。
- **关键不变量**: masterKey 值永不变（保证历史密文可解）；`decrypt` 兼容 v1（16B IV 无前缀）与 v2（12B IV + `v2:` 前缀）双格式；迁移原子性（throw 即 ROLLBACK）；premigration 备份由 `dbPreExisted()` 门控（CR-02）。
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
