---
phase: quick
plan: 260628-trt
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - package-lock.json
  - electron/services/backupScheduler.ts
autonomous: true
requirements:
  - BUG-pdfjs-dist-missing
  - BUG-2-retention-zero-purge
must_haves:
  truths:
    - "PDF 知识库解析运行时 import('pdfjs-dist/legacy/build/pdf.mjs') 成功（不再 require 失败）"
    - "backup_config.periodic_retention=0 或 premigration_retention=0 时，pruneBackups 至少保留 1 份备份，不再删光"
  artifacts:
    - path: "package.json"
      provides: "pdfjs-dist 进入 dependencies"
      contains: "pdfjs-dist"
    - path: "node_modules/pdfjs-dist/legacy/build/pdf.mjs"
      provides: "运行时 import 路径解析的物理文件"
    - path: "electron/services/backupScheduler.ts"
      provides: "pruneBackups 的 retention clamp 防删光"
      contains: "Math.max(1, retention)"
  key_links:
    - from: "electron/services/knowledgeBaseService.ts:393"
      to: "node_modules/pdfjs-dist/legacy/build/pdf.mjs"
      via: "await import('pdfjs-dist/legacy/build/pdf.mjs')"
      pattern: "pdfjs-dist/legacy/build/pdf\\.mjs"
    - from: "electron/services/backupScheduler.ts pruneBackups"
      to: "fs.unlinkSync"
      via: "safeRetention slice"
      pattern: "Math\\.max\\(1, retention\\)"
---

<objective>
修复代码审计（gsd-map-codebase CONCERNS.md）发现的 2 个 critical+high 问题：

① 🔴 pdfjs-dist 缺失依赖（critical）：`knowledgeBaseService.ts` 用 `await import('pdfjs-dist/legacy/build/pdf.mjs')` 但 dependencies 无该包 → PDF 解析运行时 broken。
② 🟠 BUG-2 retention=0 删光备份（high）：`backupScheduler.ts pruneBackups` 行 97 `files.slice(retention)` 在 retention=0 时返回全部文件 → 删光所有备份。

Purpose: 恢复 PDF 知识库解析功能 + 防止用户配 retention=0 触发数据丢失。
Output: package.json/package-lock.json (pdfjs-dist 加入 dependencies)；backupScheduler.ts (retention clamp)。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@.planning/STATE.md
@electron/services/knowledgeBaseService.ts
@electron/services/backupScheduler.ts
@package.json

<interfaces>
<!-- 关键运行时 import 与 bug 现场，executor 直接据此修复，无需 codebase 探索 -->

knowledgeBaseService.ts:392-394 (PDF 解析入口，不动代码，仅靠 npm install 修复):
```typescript
async function parsePdf(buffer: Buffer): Promise<Array<{ title: string; content: string; level: number }>> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')   // 4.x legacy build 路径
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
```

backupScheduler.ts:88-104 (BUG-2 现场，行 97 是 bug 点):
```typescript
private static pruneBackups(bucket: 'periodic' | 'premigration', retention: number): void {
  // ...
  const toDelete = files.slice(retention) // BUG-2: retention=0 → slice(0) 返回全部 → 删光
  // ...
}
```

package.json build:electron-main 已有 `--external:pdfjs-dist`（无需改 esbuild 配置，仅缺 npm 包本身）。
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: 安装 pdfjs-dist 到 dependencies 并验证 import 路径双绿</name>
  <files>package.json, package-lock.json</files>
  <action>
修复 critical：PDF 知识库解析缺失依赖。

1. 在 main tree（项目根 E:\knowlegdge_base\claude\network_toplogy）执行 `npm install pdfjs-dist`，使 pdfjs-dist 进入 dependencies（非 devDependencies）。
2. 版本策略：npm 默认装最新 4.x（兼容 knowledgeBaseService.ts:393 用的 `pdfjs-dist/legacy/build/pdf.mjs` 路径——`.mjs` 即 4.x legacy build 形态）。装完后确认 package.json dependencies 出现 `"pdfjs-dist": "^4.x"` 形式条目。
3. 物理验证：确认 `node_modules/pdfjs-dist/legacy/build/pdf.mjs` 文件存在（knowledgeBaseService 的 await import 路径必须可解析）。
4. esbuild `--external:pdfjs-dist` 已存在于 build:electron-main 脚本（package.json:8），无需改 esbuild 配置——external 意味着打包时不内联、运行时从 node_modules 解析，所以必须物理安装。
5. 不动 knowledgeBaseService.ts 任何代码（import 语句本身正确，缺的只是 npm 包）。

注意：better-sqlite3 native binding 编译给 electron(ABI 145)，plain node(ABI 137) 跑不了运行时测试——以静态验证（文件存在 + tsc/esbuild 双绿）为准，不跑 PDF 解析运行时用例。
  </action>
  <verify>
    <automated>test -f node_modules/pdfjs-dist/legacy/build/pdf.mjs && npx tsc -p tsconfig.web.json --noEmit && npm run build:electron-main</automated>
  </verify>
  <done>
    - node_modules/pdfjs-dist/legacy/build/pdf.mjs 存在
    - package.json dependencies 含 pdfjs-dist（4.x）
    - tsc -p tsconfig.web.json --noEmit 绿
    - npm run build:electron-main 绿（esbuild --external:pdfjs-dist 解析成功）
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: BUG-2 修复 pruneBackups retention=0 删光备份</name>
  <files>electron/services/backupScheduler.ts</files>
  <behavior>
    - retention=0 时：pruneBackups 不删任何文件（至少保留最新 1 份），等价 retention=1 行为
    - retention=1 时：保留最新 1 份，删除其余（行为不变）
    - retention>=2 时：保留最新 N 份，删除其余（行为不变）
    - 单文件删除失败仍跳过（既有 try/catch 行为不变）
  </behavior>
  <action>
修复 high BUG-2：`electron/services/backupScheduler.ts` 行 97 `files.slice(retention)` 在 retention=0 时返回全部文件 → 删光所有备份（用户配 backup_config.periodic_retention=0 即数据丢失）。

最小改动（不动调用方、不动 DB schema、不动 pruneBackups 签名）：
1. 在 pruneBackups 内、slice 之前插入 clamp：
   `const safeRetention = Math.max(1, retention) // BUG-2: 防 retention=0 slice(0) 删光全部`
2. 将行 97 `files.slice(retention)` 改为 `files.slice(safeRetention)`。
3. 不动行 88 注释、不动行 98-100 删除循环、不动行 101-103 catch。

修复后语义：retention<=0 一律按 1 处理（至少保留最新 1 份备份），retention>=1 行为完全不变。

由于 better-sqlite3 native binding 编译给 electron，plain node 跑不了 backupScheduler 运行时单测（依赖 getDatabase()/BACKUPS_DIR() 等运行时上下文）——以静态验证（tsc/esbuild 双绿 + 代码 grep 确认 Math.max(1, retention) 存在）为准。
  </action>
  <verify>
    <automated>npx tsc -p tsconfig.web.json --noEmit && npm run build:electron-main && grep -c "Math.max(1, retention)" electron/services/backupScheduler.ts</automated>
  </verify>
  <done>
    - backupScheduler.ts pruneBackups 内含 `Math.max(1, retention)` clamp
    - `files.slice(safeRetention)`（非裸 `files.slice(retention)`）
    - tsc -p tsconfig.web.json --noEmit 绿
    - npm run build:electron-main 绿
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| 用户配置 → 备份裁剪逻辑 | backup_config.retention 由用户配置，跨信任边界进入 pruneBackups |
| npm 包 → 运行时 import | pdfjs-dist 作为第三方依赖进入 Electron main 进程 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-quick-01 | Tampering | pruneBackups(retention=0) | mitigate | Task 2: Math.max(1, retention) clamp 防止 0 值删光备份（数据完整性） |
| T-quick-02 | DoS | pdfjs-dist 解析恶意 PDF | accept | 本次仅补依赖恢复既有功能；PDF 解析的 DoS 防护属 Phase 4-6 已规划范围，不在此 quick 修复 |
| T-quick-03 | Supply Chain | pdfjs-dist npm 包 | accept | 使用 npm 官方 registry 默认安装，遵循既有依赖管理流程（与 mammoth/ssh2 同级） |
</threat_model>

<verification>
- `test -f node_modules/pdfjs-dist/legacy/build/pdf.mjs`（pdfjs 物理就位）
- `npx tsc -p tsconfig.web.json --noEmit` 双绿之一
- `npm run build:electron-main` 双绿之二（esbuild external:pdfjs-dist 解析成功）
- `grep -c "Math.max(1, retention)" electron/services/backupScheduler.ts` 返回 1（clamp 已植入）
</verification>

<success_criteria>
- pdfjs-dist 进入 package.json dependencies（4.x），node_modules/legacy/build/pdf.mjs 物理存在
- backupScheduler.ts pruneBackups 含 Math.max(1, retention) clamp，retention=0 不再删光
- tsc + esbuild 双绿
- 两个 task 各自 atomic commit，commit message 含 BUG-2 + pdfjs-dist 审计发现 ID
- 临时脚本（如有）用后即删
</success_criteria>

<output>
After completion, create `.planning/quick/260628-trt-pdfjs-dist-backupscheduler-retention-0/260628-trt-SUMMARY.md`
</output>
