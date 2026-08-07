---
phase: quick
plan: 260807-fzd
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - electron/services/vendor-commands.ts
  - electron/services/ai.ts
  - CHANGELOG.md
autonomous: true
requirements: [HEALTH-AUDIT-2.1]
must_haves:
  truths:
    - "package.json devDependencies 不再含 @types/uuid"
    - "electron/services/vendor-commands.ts 文件不存在"
    - "electron/services/ai.ts 不再 export executeCommandOnDevice（单数 wrapper）"
    - "executeCommandsOnDevice（复数）签名与调用点零改动"
    - "tsc / vitest / build:electron-main / vite build 四绿门禁全绿"
  artifacts:
    - path: "package.json"
      provides: "devDependencies 移除 @types/uuid"
    - path: "electron/services/vendor-commands.ts"
      provides: "（删除，文件不存在）"
    - path: "electron/services/ai.ts"
      provides: "移除 516-522 行 executeCommandOnDevice 单数 wrapper"
    - path: "CHANGELOG.md"
      provides: "dead code 清理条目"
  key_links:
    - from: "electron/services/discovery.ts"
      to: "electron/services/ai.ts"
      via: "import { executeCommandsOnDevice } from './ai'"
      pattern: "executeCommandsOnDevice"
---

<objective>
清理体检报告 §2.1 标记的三项 dead code（codegraph_callers=0 + grep 双验证零引用）：

1. `package.json` devDependencies 的 `@types/uuid`（uuid v14+ 自带类型，旁路 @types 冗余）
2. `electron/services/vendor-commands.ts` 整文件（Vendor/detectVendor/getDiscoveryCommands 三 export 全 0 caller，CHANGELOG:239 已记载移除）
3. `electron/services/ai.ts:516` 的 `executeCommandOnDevice`（单数 wrapper，discovery.ts 实际 import 的是复数 `executeCommandsOnDevice`）

Purpose: 纯删除任务，清掉 v1.0/v1.1 重写后遗留的零引用死代码，不引入新代码、不动 IPC/加密/安全红线（commandSafety/authGuard/encField 零触碰）。
Output: 3 处删除 + CHANGELOG 更新 + 四绿门禁全绿。
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/audits/2026-08-07-health-audit.md
@./CLAUDE.md
@package.json
@electron/services/vendor-commands.ts

<interfaces>
<!-- 删除后保留契约的复数 API（删除单数 wrapper 不得影响此签名） -->
From electron/services/ai.ts:
```typescript
export function executeCommandsOnDevice(
  device: any,
  commands: string[]
): Promise<Array<{ success: boolean; output: string; command: string }>>
```
discovery.ts:2 import 的是 `executeCommandsOnDevice`（复数），删除单数 wrapper 不影响。
</interfaces>
</context>

<delete_audit>
执行前显式列出删除对象（CLAUDE.md「删除动作执行前必须列出删除对象确认」红线，体检报告 §2.1 已列，此处再列一次）：

| # | 删除对象 | 位置 | 类型 | 零引用证据 |
|---|---------|------|------|-----------|
| 1 | `@types/uuid` devDep | package.json:41 | 依赖 | uuid v14+ 自带类型，10 处 `from 'uuid'` 均用包内类型，无 `from '@types/uuid'` |
| 2 | `vendor-commands.ts` 整文件 | electron/services/vendor-commands.ts | 整文件 | 三 export（Vendor/detectVendor/getDiscoveryCommands）codegraph_callers=0，grep 仅命中 CHANGELOG/docs/计划文档/自引用 |
| 3 | `executeCommandOnDevice` 函数 | electron/services/ai.ts:516-522 | 函数 | codegraph_callers=0，grep 仅命中自身定义 + 内部对复数的调用 |

**不删**（误判排除，体检报告 §2.2 标 keep/investigate）：
- `executeCommandsOnDevice`（复数，ai.ts:324）— discovery.ts:202 + ai.ts:621/972 + telnetRouting.test.ts 13 处调用，保留
- uuid 运行时依赖（package.json deps）— 10 处 import，保留
</delete_audit>

<tasks>

<task type="auto">
  <name>Task 1: 删 vendor-commands.ts 整文件 + ai.ts 单数 wrapper</name>
  <files>electron/services/vendor-commands.ts, electron/services/ai.ts</files>
  <action>
两处删除（已 grep 双验证零引用，安全删除）：

1. 删除整个文件 `electron/services/vendor-commands.ts`（47 行，含 Vendor type + detectVendor + getDiscoveryCommands 三 export）。CHANGELOG:239 记载 v1.0 discovery.ts 重写时已移除对该文件的依赖，discovery.ts 走 AI 动态生成命令的新方案。

2. 删除 `electron/services/ai.ts:516-522` 的 `executeCommandOnDevice`（单数 wrapper，7 行含空行）：
   - 整段删除：从 `export function executeCommandOnDevice(device: any, command: string): Promise<string> {` 到对应的闭合 `}`
   - 删除该函数后紧跟的一行空行（保持文件格式：2 空格缩进、单引号、无分号约定）
   - **不要动** ai.ts:324 的 `executeCommandsOnDevice`（复数）— 这是 discovery.ts:2/202 + ai.ts:621/972 + telnetRouting.test.ts 实际调用的活跃函数

不做任何其他改动；不引入新代码；不触碰 commandSafety/authGuard/encField 等安全红线。
  </action>
  <verify>
    <automated>
      git rm electron/services/vendor-commands.ts &&
      grep -n "executeCommandOnDevice\b" electron/services/ai.ts | grep -v "executeCommandsOnDevice" | grep -v '^$' && echo "FAIL: singular wrapper still present" || echo "OK: singular wrapper removed" &&
      grep -n "executeCommandsOnDevice" electron/services/ai.ts | head -5
    </automated>
  </verify>
  <done>
vendor-commands.ts 不存在；ai.ts 不再含 `executeCommandOnDevice`（单数，排除复数匹配）；ai.ts 复数 `executeCommandsOnDevice`（324 行）与定义零改动。
  </done>
</task>

<task type="auto">
  <name>Task 2: 删 package.json @types/uuid devDep</name>
  <files>package.json</files>
  <action>
删除 `package.json` devDependencies 中的一行：
```
"@types/uuid": "^10.0.0",
```
（位于 @types/ssh2 之后、@vitejs/plugin-react 之前，第 41 行）。

不删 `dependencies` 中的 `"uuid": "^14.0.0"`（运行时依赖，10 处 import 使用）。uuid v14+ 自带 TypeScript 类型，`@types/uuid` 是旁路冗余包，无任何代码 `from '@types/uuid'`（grep 验证零命中）。删除后所有 `import { v4 as uuidv4 } from 'uuid'` 仍走 uuid 包内类型解析。
  </action>
  <verify>
    <automated>
      node -e "const p=require('./package.json'); const has=(p.devDependencies && p.devDependencies['@types/uuid']) || null; if(has){console.error('FAIL: @types/uuid still in devDeps'); process.exit(1);} if(!p.dependencies.uuid){console.error('FAIL: runtime uuid dep missing'); process.exit(1);} console.log('OK: @types/uuid removed, uuid runtime dep preserved')"
    </automated>
  </verify>
  <done>
package.json devDependencies 不含 @types/uuid；dependencies.uuid（^14.0.0）保留；JSON 语法合法可解析。
  </done>
</task>

<task type="auto">
  <name>Task 3: 四绿门禁验证 + CHANGELOG 更新</name>
  <files>CHANGELOG.md</files>
  <action>
先跑四绿门禁（全绿后才更新 CHANGELOG）：

1. `tsc -p tsconfig.web.json` — 严格模式 + noUnusedLocals 必绿（删 wrapper 不得遗留 dangling import；删 @types/uuid 不得破坏 uuid 类型解析）
2. `npx vitest run` — 全绿，预期 232 用例零回归（删 vendor-commands.ts 不应影响任何测试，因零 caller；删单数 wrapper 不应影响 telnetRouting.test.ts，因测试用复数）
3. `npm run build:electron-main` — esbuild 打包 main 必绿（确认 vendor-commands.ts 不在任何 bundle 路径上，ai.ts 仍可打包）
4. `npx vite build` — renderer 必绿

四绿全过后，在 `CHANGELOG.md` 顶部新增一条 dead code 清理条目（日期 2026-08-07，简述三项删除 + 引用体检报告 §2.1 证据）。条目格式沿用 CHANGELOG 既有风格（中文、简练、列删除项 + 原因）。

任一门禁非绿 → 立即停止、回滚改动、报告（不得为过门禁而引入新代码或修改活跃逻辑）。
  </action>
  <verify>
    <automated>
      npx tsc -p tsconfig.web.json &&
      npx vitest run &&
      npm run build:electron-main &&
      npx vite build
    </automated>
  </verify>
  <done>
四绿门禁全过（tsc + vitest 232/232 + build:electron-main + vite build），CHANGELOG.md 新增 dead code 清理条目，无回归。
  </done>
</task>

</tasks>

<threat_model>
## 信任边界

| Boundary | Description |
|----------|-------------|
| 无 | 纯删除任务，无新增代码路径、无 IPC/加密/auth 改动、无用户输入流经 |

## STRIDE 威胁登记

本任务为纯删除已验证零引用的死代码，不改变任何信任边界、IPC channel、加密路径或命令安全层。STRIDE 评估：无新增威胁。

| Threat ID | Category | Component | Disposition | Mitigation |
|-----------|----------|-----------|-------------|------------|
| T-quick-01 | Tampering | 删除致回归 | mitigate | 四绿门禁（tsc noUnusedLocals + vitest 232 用例 + build:electron-main + vite build）零回归硬门禁 |
| T-quick-02 | Information Disclosure | N/A | accept | 不触碰加密/脱敏/IPC 通道，无数据流改动 |

**红线核查**（CLAUDE.md「不可回退」三项）：
- IPC 鉴权网关（secure/safe）：零触碰
- 字段加密（_enc/encField/decField）：零触碰
- commandSafety.isCommandAllowed：零触碰
</threat_model>

<verification>
- 四绿门禁全绿（tsc / vitest 232 用例 / build:electron-main / vite build）
- vendor-commands.ts 文件不存在
- ai.ts 不含 executeCommandOnDevice（单数），含 executeCommandsOnDevice（复数）
- package.json devDeps 不含 @types/uuid，deps 含 uuid
- CHANGELOG.md 有 dead code 清理条目
</verification>

<success_criteria>
- 三项 dead code 全部删除（@types/uuid + vendor-commands.ts 整文件 + ai.ts 单数 wrapper）
- 四绿门禁全绿，零回归（vitest 232/232）
- 三条不可回退红线（IPC 鉴权/字段加密/commandSafety）零触碰
- CHANGELOG.md 记录本次清理
</success_criteria>

<output>
Create `.planning/quick/260807-fzd-dead-code-types-uuid-vendor-commands-ts-/260807-fzd-SUMMARY.md` when done
</output>
