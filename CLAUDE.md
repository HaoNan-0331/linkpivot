<!-- GSD:project-start source:PROJECT.md -->
## Project

**network_toplogy**

network_toplogy 是面向运维人员的网络拓扑管理桌面工具（Electron + React + TypeScript + better-sqlite3）。运维人员用它可视化网络拓扑、远程连接并操控设备（SSH/Telnet/Web/RDP）、通过 AI 助手辅助分析与执行运维命令，并维护设备资料与运维知识库。

**Core Value:** 让运维人员在一个桌面工具内安全地掌握网络拓扑、远程操控设备并获得 AI 辅助分析——拓扑准确呈现与设备安全可控是最高优先级，其余皆可让步。

### Constraints

- **Tech stack**: Electron + React + TS + better-sqlite3 — 不更换核心栈
- **Compatibility**: 加密/迁移改动必须向后兼容历史数据
- **Security**: SSH 密钥认证、命令白名单执行层强制校验、IPC 鉴权网关 — 不可回退
- **Build**: tsconfig.web.json 严格模式 + noUnusedLocals 必须全绿；electron main 用 esbuild 打包
- **Packaging**: 禁止打包用户数据/账号/DB 进安装包（electron-builder.yml 排除规则）
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
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
