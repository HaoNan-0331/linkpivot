---
phase: 01-build-dependency-foundation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - package-lock.json
autonomous: true
requirements_addressed:
  - BUILD-01
tags:
  - build
  - dependency-lock

must_haves:
  truths:
    - "package-lock.json 中 better-sqlite3 与 ssh2 为 exact 版本，无 ^ / ~ 前缀"
    - "package.json 中 better-sqlite3 与 ssh2 为 exact 版本，无 ^ / ~ 前缀"
    - "删除 node_modules 后 npm ci 干净退出（exit 0，无 lock 偏差 warning）"
    - "锁版本后 tsc 新增 type error 集合为空（test ! -s tsc-new-errors.txt 通过；判定依据是新 error 集，非 tsc 原始退出码 —— 既存 error 允许）"
    - "electron main esbuild 打包（npm run build:electron-main）退出码 0"
    - "electron-builder 用户数据排除规则未被本 phase 改动破坏"
  artifacts:
    - path: "package.json"
      provides: "原生依赖 exact 版本声明"
      contains: '"better-sqlite3": "12.9.0"'
    - path: "package-lock.json"
      provides: "与 package.json 一致的可复现 lockfile"
      contains: '"better-sqlite3": "12.9.0"'
  key_links:
    - from: "package.json"
      to: "package-lock.json"
      via: "npm ci 一致性校验"
      pattern: "npm ci exit 0"
---

<objective>
建立可复现构建基线：将原生依赖 better-sqlite3 / ssh2（及同属原生编译的 telnet-client）从 caret 范围锁定为 exact 版本，重新生成与 package.json 完全一致的 package-lock.json，并验证全新 clone 后 `npm ci` + 全量构建双绿。

Purpose: 为后续 5 个 phase 的重构提供稳定的回归参照基线；消除 caret 范围导致的依赖漂移与供应链风险（ASVS L1 供应链完整性）。
Output: 改写后的 package.json、重新生成的 package-lock.json。
</objective>

<execution_context>
@.claude/get-shit-done/workflows/execute-plan.md
@.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@package.json

<interfaces>
<!-- Phase 1 为文件级配置操作，无代码接口契约。以下为构建链 ground truth（来自 package.json scripts，executor 不得偏离）-->

构建链 scripts（package.json 当前值，验收基准）：
- build:electron-main = `esbuild electron/main.ts --outfile=dist-electron/main.js --platform=node --format=cjs --bundle --external:better-sqlite3 --external:ssh2 --external:telnet-client --external:electron --external:pdfjs-dist`
- build:preload = esbuild 打包 preload.ts + terminal-preload.ts（external:electron）
- build:electron = `npm run build:electron-main && npm run build:preload && node scripts/build-electron.cjs`
- build = `tsc -p tsconfig.web.json && vite build && npm run build:electron`

原生依赖当前声明（须改为 exact，目标值逐字如下）：
- better-sqlite3: "^12.9.0" → "12.9.0"
- ssh2: "^1.17.0" → "1.17.0"
- telnet-client: "^2.2.13" → "2.2.13"（原生编译依赖，一并锁 exact 以彻底消除漂移面）

devDependencies 原生编译工具（保持现状，不改）：
- @electron/rebuild: "^4.0.4"（better-sqlite3 重建 electron ABI 所需，已是 caret，本 phase 不动 —— BUILD-01 验收只强制 better-sqlite3/ssh2，devTools 锁定不在范围）

<!-- pipefail 约定：所有用于验收 gate 的管道（含 `| tee` / `| sort` / `| comm`），
     其所在 <automated> 块首行必须 `set -o pipefail &&`，使 pipeline 退出码取被测命令（tsc）而非下游命令（tee/sort/comm），
     防止 tsc 非 0 退出码被 tee 恒为 0 的返回值掩盖导致假绿。无管道的块可不加。-->
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: 锁定原生依赖为 exact 版本并重新生成 lockfile</name>
  <files>package.json, package-lock.json</files>

  <read_first>
    - package.json（核实 dependencies.dependencies 中 better-sqlite3 / ssh2 / telnet-client 当前 caret 值，本 plan context 已给出目标 exact 值）
    - package-lock.json 顶层 packages."" 节点（核实 lock 与 package.json 一致后才动手；当前 lock 也是 caret，须随 package.json 同步重生成）
    - scripts/build-electron.cjs（确认 esbuild --external 列表含 better-sqlite3/ssh2/telnet-client，锁版本不改变 external 声明）
    - electron-builder.yml（仅读取确认排除规则存在，本 task 不修改它）
  </read_first>

  <action>
  按"原生依赖 exact 锁定"语义执行以下精确改动：

  1. 编辑 package.json 的 dependencies 三行，逐字替换为（去掉 ^ 前缀，版本号不变）：
     - `"better-sqlite3": "12.9.0"`
     - `"ssh2": "1.17.0"`
     - `"telnet-client": "2.2.13"`
     其余 dependencies / devDependencies 行一字不动。

  2. 不手动编辑 package-lock.json。改为运行：
     `npm install --package-lock-only`
     该命令以改写后的 package.json 为准，重新生成 lock，使 lock 顶层 packages[""].dependencies 与 node_modules/*.package-lock 节点中三者的 version 字段均为 exact（无 ^/~），并保证 lockfileVersion 与传递依赖树一致。

  3. 安装依赖到 node_modules 以便后续构建验证：
     `npm ci`
     若 npm ci 报 lock 偏差（"npm ERR! `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync"），回到步骤 2 重新 `npm install --package-lock-only` 后再 npm ci，直到 npm ci 干净退出。

  4. 不改 scripts、不改 devDependencies、不改 electron-builder.yml、不改 tsconfig.web.json。

  注意：telnet-client 虽不在 BUILD-01 验收强制清单，但属原生编译依赖（与 better-sqlite3 同类漂移面），按"原生依赖 exact 锁定"语义一并锁，避免遗留 caret 漂移口子。
  </action>

  <verify>
    <automated>
    cd "E:\knowlegdge_base\claude\network_toplogy" &&
    echo "[1] package.json exact check" &&
    grep -cE '"(better-sqlite3|ssh2|telnet-client)": "[0-9]' package.json | grep -qx 3 &&
    echo "[2] package.json no caret/tilde on these three" &&
    ! grep -qE '"(better-sqlite3|ssh2|telnet-client)": "[\^~]' package.json &&
    echo "[3] lock exact check" &&
    grep -cE '"(better-sqlite3|ssh2)": "[0-9]' package-lock.json | grep -qv 0 &&
    echo "[4] npm ci clean" &&
    npm ci --silent && echo "npm ci exit 0"
    </automated>
    <automated>
    cd "E:\knowlegdge_base\claude\network_toplogy" &&
    rm -rf node_modules && npm ci --silent && echo "clean-install-from-scratch exit 0"
    </automated>
  </verify>

  <acceptance_criteria>
    - package.json 中存在精确字符串 `"better-sqlite3": "12.9.0"`、`"ssh2": "1.17.0"`、`"telnet-client": "2.2.13"`
    - `grep -cE '"(better-sqlite3|ssh2|telnet-client)": "[\^~]' package.json` 返回 0（三者均无 ^/~ 前缀）
    - package-lock.json 中 better-sqlite3 与 ssh2 的 version 字段无 ^/~ 前缀（grep 命中 `"better-sqlite3": "12.9.0"` 与 `"ssh2": "1.17.0"` 形式）
    - `npm ci` 退出码 0，stderr 无 "lockfile has been modified" / "out of sync" 偏差 warning
    - `rm -rf node_modules && npm ci` 退出码 0，无 "out of sync" / "lockfile modified" warning（ROADMAP SC#2「全新 clone」真值验收：删除 node_modules 后 npm ci 等效模拟全新 clone 的依赖解析路径）
    - package.json 其余行（scripts、devDependencies、antd/react 等非原生依赖）未被改动
    - electron-builder.yml 未被改动（git diff 为空）
  </acceptance_criteria>

  <done>
  package.json 三项原生依赖为 exact 版本；package-lock.json 经 `npm install --package-lock-only` 重新生成且与 package.json 一致；`npm ci` 干净退出。
  </done>
</task>

<task type="auto">
  <name>Task 2: 验证可复现全量构建（tsc + esbuild 双绿，ABI 正常）</name>
  <files>（只读验证，不改源文件）</files>

  <read_first>
    - package.json（核实 build / build:electron-main / build:preload / build:electron 四条 script 的精确命令，验收时按这些命令执行）
    - tsconfig.web.json（确认 strict / noUnusedLocals 仍为 true，构建验收以此为门槛）
    - electron-builder.yml（确认 asar / files / extraResources 排除规则，验收步骤 4 检查未被破坏）
    - scripts/build-electron.cjs（确认 dist-electron/package.json 注入逻辑，构建产物校验基准）
  </read_first>

  <action>
  在 Task 1 完成（node_modules 已 npm ci 安装到位）后，按构建链顺序执行验证。这些是只读验证命令，不改源文件。

  0. 固化 tsc baseline（在执行任何锁版本后的构建检查之前，先固化"基线"的 tsc error 集合，使后续"未新增 error"判定为客观集合比较，而非主观清单核对）：
     `set -o pipefail && npx tsc -p tsconfig.web.json --noEmit 2>&1 | tee tsc-baseline.txt`
     （`set -o pipefail` 使 pipeline 退出码取 tsc 而非 tee，避免 tsc 非 0 被 tee 恒 0 掩盖。）
     将本次 phase run 的 tsc 输出（含 error 清单或 "0 errors"）写入仓库根 `tsc-baseline.txt`（临时文件，phase 结束后删除）。
     该 baseline 为后续 step 1 客观判定的参照：锁版本后 tsc error 集合 ⊆ baseline error 集合 即视为"未新增"。

  1. 前端严格类型检查（ASVS L1 构建完整性门槛；与 step 0 baseline 做集合比较，客观判定）：
     `set -o pipefail && npx tsc -p tsconfig.web.json --noEmit 2>&1 | tee tsc-after.txt`
     再做集合比较：
     `comm -13 <(sort tsc-baseline.txt) <(sort tsc-after.txt) > tsc-new-errors.txt`
     `test ! -s tsc-new-errors.txt`
     即：锁版本后 tsc 输出写入 tsc-after.txt，与 baseline 做 `comm -13`，新增 error 集合（tsc-new-errors.txt）必须为空。
     判定依据为 tsc-new-errors.txt 是否为空（test ! -s），而非 tsc 原始退出码 —— pipefail 下 tsc 因既存 error 非 0 退出时，comm 比较与 test ! -s 仍执行（tee 后用 ;），既存 error 允许，仅断言未新增。若 tsc-new-errors.txt 非空，则锁版本引入了新 type error，回退 Task 1 并排查 better-sqlite3/@types 版本漂移。

  2. electron main esbuild 打包：
     `npm run build:electron-main`
     必须 exit 0，产出 dist-electron/main.js，且 main.js 顶部含 scripts/build-electron.cjs 注入的 `// Polyfill browser APIs` 注释行（证明 build-electron.cjs 后处理链未被破坏）。

  3. 完整 electron 构建链（main + preload + cjs 后处理）：
     `npm run build:electron`
     必须 exit 0，dist-electron/ 下存在 main.js / preload.js / terminal-preload.js / package.json（type:commonjs）。

  4. 原生模块 ABI 验证（better-sqlite3 须匹配 electron ABI，@electron/rebuild 已在 devDependencies）：
     `npx electron-rebuild -f -w better-sqlite3`
     退出码 0，输出含 "Rebuild complete" 或无 ERROR。证明 better-sqlite3 native binding 可在当前 electron 版本加载（这是 ROADMAP Success Criteria 2"构建成功"的隐性前置 —— dist-electron/main.js require('better-sqlite3') 不抛 NODE_MODULE_VERSION mismatch）。

  5. 打包排除规则回归检查（ASVS L1 防打包泄漏）：
     `git diff --name-only electron-builder.yml`
     必须为空（本 phase 未触碰 packaging 排除规则）。读取 electron-builder.yml 确认 files/extraResources 中无 *.db / 账号配置 / 用户数据被纳入打包源。

  6. 全量构建冒烟：
     `npm run build`
     必须 exit 0（tsc + vite + build:electron 三段全绿）。

  7. phase 结束清理临时 baseline / 比对文件（CLAUDE.md "临时脚本使用后立即删除"）：
     `rm -f tsc-baseline.txt tsc-after.txt tsc-new-errors.txt`
     必须在 step 1 的 `comm` 比较与 `test ! -s` 断言完成之后、acceptance 断言文件不存在之前执行（见 verify-block-A 末尾）。

  不修改任何源文件。任一 verify 步骤非 0 退出即停止，记录失败步号到 SUMMARY，并按 acceptance_criteria 中"失败回退"路径处理。
  </action>

  <verify>
    <automated>
    set -o pipefail &&
    cd "E:\knowlegdge_base\claude\network_toplogy" &&
    echo "[verify-block-A] baseline + tsc new-error check + esbuild" &&
    echo "[A1] capture baseline" &&
    npx tsc -p tsconfig.web.json --noEmit 2>&1 | tee tsc-baseline.txt ; echo "baseline captured (exit ignored; compared below)" &&
    echo "[A2] capture after, compare new-error set (must be empty)" &&
    npx tsc -p tsconfig.web.json --noEmit 2>&1 | tee tsc-after.txt ;  # ; not && : allow comm/test gate to run even if tsc exits non-zero (existing errors allowed, only new-error set must be empty)
    comm -13 <(sort tsc-baseline.txt) <(sort tsc-after.txt) > tsc-new-errors.txt &&
    test ! -s tsc-new-errors.txt && echo "tsc no-new-error ok (SC#3)" &&
    echo "[A3] esbuild main" &&
    npm run build:electron-main && echo "esbuild main green" &&
    echo "[A4] cleanup temp tsc files (after compare, before artifact assertions)" &&
    rm -f tsc-baseline.txt tsc-after.txt tsc-new-errors.txt &&
    test ! -e tsc-baseline.txt -a ! -e tsc-after.txt -a ! -e tsc-new-errors.txt &&
    echo "[verify-block-A] OK"
    </automated>
    <automated>
    set -o pipefail &&
    cd "E:\knowlegdge_base\claude\network_toplogy" &&
    echo "[verify-block-B] electron chain + ABI" &&
    npm run build:electron && echo "electron chain green" &&
    test -f dist-electron/main.js && test -f dist-electron/preload.js && test -f dist-electron/terminal-preload.js && echo "artifacts present" &&
    npx electron-rebuild -f -w better-sqlite3 >/dev/null 2>&1 && echo "native ABI ok" &&
    npm run build && echo "full build green" &&
    echo "[verify-block-B] OK"
    </automated>
    <automated>
    cd "E:\knowlegdge_base\claude\network_toplogy" &&
    echo "[verify-block-C] packaging + git-tree hygiene (gate)" &&
    git diff --name-only electron-builder.yml | grep -qx "" && echo "packaging untouched" &&
    git status --short | grep -qE '^( M |M  |MM |\?\? ).*(package\.json|package-lock\.json)' && echo "lockfile changes present" &&
    test -z "$(git status --short | grep -vE 'package\.json|package-lock\.json')" && echo "git hygiene ok: only package.json/package-lock.json tracked changes" &&
    echo "[verify-block-C] OK"
    </automated>
  </verify>

  <acceptance_criteria>
    - `npx tsc -p tsconfig.web.json --noEmit` 退出码 0；若非 0，则锁版本后 tsc error 集合 ⊆ step 0 固化的 `tsc-baseline.txt` error 集合
    - **锁版本后 tsc 新增 type error 集合为空（`tsc-new-errors.txt` 为空，`test ! -s tsc-new-errors.txt` 通过；由 verify-block-A 的 `comm -13 <(sort tsc-baseline.txt) <(sort tsc-after.txt)` 自动断言；对应 ROADMAP SC#3）**
    - `npm run build:electron-main` 退出码 0，dist-electron/main.js 存在且首行匹配 `// Polyfill browser APIs`
    - `npm run build:electron` 退出码 0，dist-electron/ 下同时存在 main.js / preload.js / terminal-preload.js / package.json
    - `npx electron-rebuild -f -w better-sqlite3` 退出码 0（better-sqlite3 native binding 匹配 electron ABI）
    - `git diff --name-only electron-builder.yml` 输出为空（packaging 排除规则未被破坏）
    - `npm run build` 退出码 0（tsc + vite + electron 三段全绿）
    - （防御性回归加固）`test -z "$(git status --short | grep -vE 'package\.json|package-lock\.json')"` 通过 —— 工作区 tracked 变更仅 package.json/package-lock.json（dist-electron/ 与 node_modules/ 已被 .gitignore 排除，构建产物不得污染 git 脏文件清单）
    - phase 结束后临时文件已删除（`test ! -e tsc-baseline.txt -a ! -e tsc-after.txt -a ! -e tsc-new-errors.txt`，由 verify-block-A 末尾 automated cleanup 执行）
    - 失败回退：若 tsc/esbuild 因锁版本变红，回退 Task 1（`git checkout -- package.json package-lock.json` 后重跑 npm ci），并在 SUMMARY 中记录失败根因与失败步号
  </acceptance_criteria>

  <done>
  tsc baseline 客观固化并比对（锁版本后新增 error 集合 tsc-new-errors.txt 为空，`test ! -s` 自动断言）；tsc 严格模式 + electron main esbuild 打包双绿；electron-rebuild 验证 better-sqlite3 ABI 正常；electron-builder.yml 排除规则未被破坏；全量 `npm run build` exit 0；git 树仅 package.json/package-lock.json 变更（强 gate 断言）；临时 baseline/比对文件（tsc-baseline.txt / tsc-after.txt / tsc-new-errors.txt）已由 automated cleanup 删除。
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| 依赖源 → node_modules | npm registry 传递依赖经 package-lock.json 进入本地 node_modules，caret 范围允许 patch/minor 漂移 |
| package.json ↔ package-lock.json | 两文件一致性边界，不一致导致 npm ci 失败或静默重算 |
| better-sqlite3 native binding ↔ electron ABI | 原生模块须匹配 electron NODE_MODULE_VERSION，否则运行时 require 抛 mismatch |
| 构建产物 → 安装包 | electron-builder 排除规则边界，用户数据/DB/账号不得进入安装包 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-1-01 | Tampering (供应链) | dependencies (better-sqlite3/ssh2/telnet-client) | mitigate | exact 版本锁定，去除 ^/~ 范围，消除 patch/minor 漂移引入未审计传递依赖的面 |
| T-1-02 | Tampering (lockfile 漂移) | package-lock.json | mitigate | 用 `npm install --package-lock-only` 重新生成 lock，并以 `npm ci` 干净退出校验一致性 |
| T-1-03 | Denial of Service (构建失败) | build chain (tsc/esbuild/electron-rebuild) | mitigate | Task 2 全量构建验证 + electron-rebuild ABI 校验，确保可复现构建 exit 0；所有 tsc 验收管道配 `set -o pipefail` 防假绿 |
| T-1-04 | Information Disclosure (打包泄漏) | electron-builder.yml 排除规则 | mitigate | 验收断言 electron-builder.yml git diff 为空，确认排除规则未被本 phase 破坏 |
| T-1-05 | Tampering (devTools 范围) | @electron/rebuild devDependency | accept | BUILD-01 验收仅强制 better-sqlite3/ssh2；devTools 锁定不在本 phase 范围，caret 范围风险为低（仅构建期工具，不入运行时信任边界） |

无未缓解 HIGH 威胁：T-1-01/02/03/04 均有具体 mitigation 落地到 task acceptance_criteria；T-1-05 为 accept 并附低风险理由。
</threat_model>

<verification>
Phase 1 整体验收（映射 ROADMAP Success Criteria）：

1. **Success Criteria 1（exact 版本可 grep 验证）**：
   - `grep -E '"better-sqlite3": "12.9.0"' package-lock.json` 命中
   - `grep -E '"ssh2": "1.17.0"' package-lock.json` 命中
   - `grep -qE '"(better-sqlite3|ssh2)": "[\^~]' package-lock.json` 无命中

2. **Success Criteria 2（全新 clone 后 npm ci + 构建成功）**：
   - 删除 node_modules 后 `npm ci` exit 0 —— 已落到 Task 1 verify 的第二块 `<automated>`：`rm -rf node_modules && npm ci --silent && echo "clean-install-from-scratch exit 0"`，并在 Task 1 acceptance_criteria 显式断言"`rm -rf node_modules && npm ci` 退出码 0，无 out of sync / lockfile modified warning"
   - `npm run build` exit 0（Task 2 acceptance 已覆盖，verify-block-B 显式断言）

3. **Success Criteria 3（tsc + esbuild 双绿，无新增 type error）**：
   - `npx tsc -p tsconfig.web.json --noEmit`：判定依据为新增 error 集（line 299 的 comm 断言），非原始退出码 —— 既存 error 允许（acceptance_criteria 第一条已覆盖：退出码非 0 时须 ⊆ baseline）
   - `npm run build:electron-main` exit 0
   - **锁版本后新增 type error 集合为空**：verify-block-A 自动执行 `comm -13 <(sort tsc-baseline.txt) <(sort tsc-after.txt) > tsc-new-errors.txt && test ! -s tsc-new-errors.txt`，pipeline 首 `set -o pipefail` 保证 tsc 退出码不被 tee/sort/comm 掩盖

（全新 clone 真值验证由 Task 1 的 `npm ci` + Task 2 的 `npm run build` 联合覆盖；删除 node_modules 重装等效模拟全新 clone 的依赖解析路径。）
</verification>

<success_criteria>
- package.json 与 package-lock.json 中 better-sqlite3=12.9.0、ssh2=1.17.0、telnet-client=2.2.13 均为 exact，无 ^/~
- npm ci 干净退出，无 lock 偏差
- tsc -p tsconfig.web.json --noEmit 与 build:electron-main 双绿，且锁版本后 tsc 新增 error 集合为空（comm -13 自动断言）
- electron-rebuild 验证 better-sqlite3 ABI 正常
- electron-builder.yml 排除规则未被破坏（git diff 空）
- npm run build 全量 exit 0
- 临时 tsc 文件（baseline/after/new-errors）由 automated cleanup 删除，无残留
</success_criteria>

<output>
完成后创建 `.planning/phases/01-build-dependency-foundation/01-01-SUMMARY.md`，记录：

## 版本锁定边界对照（区分 BUILD-01 强制项 vs plan 主动加固项）

| 类别 | 依赖 | 原 caret | 锁定后 exact | 驱动来源 |
|------|------|----------|-------------|----------|
| **BUILD-01 强制项** | better-sqlite3 | ^12.9.0 | 12.9.0 | ROADMAP Phase 1 Requirements=BUILD-01，原生编译依赖，验收强制 |
| **BUILD-01 强制项** | ssh2 | ^1.17.0 | 1.17.0 | ROADMAP Phase 1 Requirements=BUILD-01，SC#1 验收强制 |
| **plan 主动加固项** | telnet-client | ^2.2.13 | 2.2.13 | 原生编译依赖（与 better-sqlite3 同类漂移面），plan 主动一并锁 exact 以彻底消除漂移口子；非 BUILD-01 验收强制，本 phase 论证保留此加固决策 |

其余记录项：
- npm install --package-lock-only 与 npm ci 输出摘要（含 Task 1 第二块 automated 的 `rm -rf node_modules && npm ci` clean-install-from-scratch 退出码）
- tsc baseline 文件名（`tsc-baseline.txt`）与 baseline error 集合；锁版本后 tsc-after.txt 与 baseline 的 `comm -13` 比较结果（tsc-new-errors.txt 内容，应为空）
- tsc / esbuild / electron-rebuild / npm run build 退出码（分块记录 verify-block-A / B / C）
- electron-builder.yml git diff 确认为空的证据
- 若 tsc 存在既存 type error（非本 phase 引入，comm -13 输出为空证明），逐条列出 baseline 中已存在项并标注"既存"
- git status --short 仅 package.json / package-lock.json tracked 变更的证据（防御性回归加固，强 gate）
- verify-block-A 末尾 automated cleanup 删除 tsc-baseline.txt / tsc-after.txt / tsc-new-errors.txt 的确认
</output>
