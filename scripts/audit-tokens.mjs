#!/usr/bin/env node
// Phase 33 / SC1+SC2 静态审计工具（33-UI-SPEC §九命令集 + §十 Q1 图标豁免 / Q6 terminal 裁决）。
// 四查（违规 = 行级命中，四域迁移后应收口全零）：
//   ① 色值：hex（#abc / #aabbcc 等）或 rgb(/rgba( 裸值
//   ② fontFamily 裸值：fontFamily: '字符串' 且同行不含 var(--nt-（裸 'monospace' 是其子集）
//   ③ fontSize 数字：fontSize: 数字 或 fontSize={数字}——命中行上下 ±2 行窗口内含
//      (Outlined|Filled|TwoTone) 图标标识则豁免（图标 sizing 非排版语义，§十 Q1 裁决）
//   ④ lineHeight 孤儿：lineHeight: 数字且同行不含 var(--nt-（fontSize 迁 token 后残留的
//      数字 lineHeight 即破坏成对性的孤儿；图标豁免窗口不适用——图标不设 lineHeight）
// 豁免清单（硬编码）：src/theme/（antd theme 字面值营地）、src/components/TerminalWindow.tsx
//   （xterm option 字面值 + 终端语义色，§十 Q6 裁决）。
// 用法：node scripts/audit-tokens.mjs [文件或目录...]——无参数扫整个 src/；
//   传入参数则只扫所列范围（供 33-02~05 分域收口）。零依赖，可无限次重跑。
// 退出码：任一项违规 exit 1（存量基线期属预期）；四项全零打印 PASS exit 0。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const EXEMPT = ['src/theme/', 'src/components/TerminalWindow.tsx']
const SCAN_ROOT = resolve(ROOT, 'src')

const isExempt = (relPath) =>
  EXEMPT.some((e) => relPath === e.replace(/\/$/, '') || relPath.startsWith(e))

const walk = (dir, out) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const targets = []
if (process.argv.length > 2) {
  for (const arg of process.argv.slice(2)) {
    const abs = resolve(ROOT, arg)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, targets)
    else if (/\.(ts|tsx)$/.test(abs)) targets.push(abs)
  }
} else {
  walk(SCAN_ROOT, targets)
}

const rel = (f) => relative(ROOT, f).split(sep).join('/')

const findings = { color: [], fontFamily: [], fontSize: [], lineHeight: [] }

for (const file of targets) {
  const relPath = rel(file)
  if (isExempt(relPath)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, idx) => {
    const loc = `${relPath}:${idx + 1}:${line.trim()}`
    // ① 色值（hex + rgb/rgba）
    if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /rgba?\(/.test(line)) findings.color.push(loc)
    // ② fontFamily 裸值（含 var(--nt- 引用则合规）
    if (/fontFamily:\s*['"]/.test(line) && !line.includes('var(--nt-')) findings.fontFamily.push(loc)
    // ③ fontSize 数字（图标 ±2 行窗口豁免）
    if (/fontSize:\s*\d/.test(line) || /fontSize=\{\d+\}/.test(line)) {
      const window = lines.slice(Math.max(0, idx - 2), idx + 3).join('\n')
      if (!/(Outlined|Filled|TwoTone)/.test(window)) findings.fontSize.push(loc)
    }
    // ④ lineHeight 孤儿（无图标豁免）
    if (/lineHeight:\s*[\d.]/.test(line) && !line.includes('var(--nt-')) findings.lineHeight.push(loc)
  })
}

let failed = false
const labels = {
  color: '① 色值（hex / rgb / rgba）',
  fontFamily: '② fontFamily 裸值',
  fontSize: '③ fontSize 数字（图标 ±2 行已豁免）',
  lineHeight: '④ lineHeight 数字孤儿',
}
for (const key of Object.keys(labels)) {
  const items = findings[key]
  console.log(`\n${labels[key]}：${items.length} 处`)
  if (items.length > 0) {
    failed = true
    for (const item of items) console.log(`  ${item}`)
  }
}

if (failed) {
  console.log(`\nFAIL（存量待四域迁移清零属预期；分域收口：node scripts/audit-tokens.mjs <路径>）`)
  process.exit(1)
}
console.log('\n① 色值 PASS  ② fontFamily PASS  ③ fontSize PASS  ④ lineHeight PASS')
process.exit(0)
