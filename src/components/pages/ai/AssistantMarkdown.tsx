/**
 * AssistantMarkdown —— 助手回复 markdown 子集渲染组件（Phase 34 / 34-02，SC2 / UI-04）。
 *
 * 载体 = react-markdown@10 + remark-gfm@4（34-02 依赖审查小节 planner 裁决；
 * 精确版本经 blocking-human checkpoint 人工批准后安装，npm registry 官方源，
 * 无任何批准外依赖）。
 *
 * 渲染安全红线（T-22-17 同源：AI 输出是不可信输入）：
 * - 零 innerHTML 直灌——本文件不使用任何 React 原生 HTML 注入式渲染 API；
 * - 零 raw-HTML rehype 插件——react-markdown 默认形态下源文本中的 HTML 标签
 *   按纯文本呈现（其内部将 raw 节点降级为 text 节点，见 lib/index.js transform）；
 * - urlTransform 仅放行 http:/https: 绝对 URL（new URL 解析判协议），
 *   相对路径与 javascript:/data: 等一律返回空串；
 * - a 组件双门（T-34-04）：renderer 侧协议复验 + target=_blank 一律带
 *   rel="noopener noreferrer"（T-34-05），外开经 main webSecurity hardenWindow
 *   setWindowOpenHandler → openExternalSafe 协议白名单通道（纵深，单层被绕不破）。
 *
 * 排版全部消费 --nt-* token 的炸开子 token（fontSize/lineHeight 两件套 + 字重），
 * 零 hex/rgb 字面量（audit:tokens 四查口径，34-UI-SPEC §三字号表）。
 * 纯呈现组件：无 state、无副作用。
 */
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 协议门：仅 http:/https: 绝对 URL 放行；相对路径 new URL 无 base 抛错 → false */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** urlTransform：非 http/https 一律空串（含 javascript:/data:/相对路径，T-34-03） */
const httpOnlyUrlTransform = (url: string): string => (isHttpUrl(url) ? url : '')

/** p/li 共用正文排版（16/28 + label-primary，34-UI-SPEC §三 markdown-base 档） */
const PARAGRAPH_STYLE = {
  fontSize: 'var(--nt-font-markdown-base-font-size)',
  lineHeight: 'var(--nt-font-markdown-base-line-height)',
  color: 'var(--nt-alias-label-primary)',
} as const

/** h1-h4 标题排版（24/34、22/32、20/30、16/28，字重随 h1~h4 子 token 700/700/700/600） */
const HEADING_STYLE = {
  h1: {
    fontSize: 'var(--nt-font-markdown-h1-font-size)',
    lineHeight: 'var(--nt-font-markdown-h1-line-height)',
    fontWeight: 'var(--nt-font-markdown-h1-font-weight)',
    margin: '16px 0 8px',
    color: 'var(--nt-alias-label-primary)',
  },
  h2: {
    fontSize: 'var(--nt-font-markdown-h2-font-size)',
    lineHeight: 'var(--nt-font-markdown-h2-line-height)',
    fontWeight: 'var(--nt-font-markdown-h2-font-weight)',
    margin: '16px 0 8px',
    color: 'var(--nt-alias-label-primary)',
  },
  h3: {
    fontSize: 'var(--nt-font-markdown-h3-font-size)',
    lineHeight: 'var(--nt-font-markdown-h3-line-height)',
    fontWeight: 'var(--nt-font-markdown-h3-font-weight)',
    margin: '16px 0 8px',
    color: 'var(--nt-alias-label-primary)',
  },
  h4: {
    fontSize: 'var(--nt-font-markdown-h4-font-size)',
    lineHeight: 'var(--nt-font-markdown-h4-line-height)',
    fontWeight: 'var(--nt-font-markdown-h4-font-weight)',
    margin: '16px 0 8px',
    color: 'var(--nt-alias-label-primary)',
  },
} as const

const MD_COMPONENTS: Components = {
  a({ href, children }) {
    if (typeof href === 'string' && isHttpUrl(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      )
    }
    // 未过协议门的链接降级为纯文本 span（不可点、无 href）
    return <span>{children}</span>
  },
  code({ className, children }) {
    // v10 已移除 inline prop：围栏块 = 带语言类名或内容含换行；其余按行内码渲染
    const isBlock = /language-/.test(className ?? '') || String(children).includes('\n')
    if (isBlock) {
      return (
        <code
          className={className}
          style={{
            display: 'block',
            background: 'var(--nt-alias-markdown-code-block)',
            fontFamily: 'var(--nt-font-family-code)',
            fontSize: 'var(--nt-font-markdown-code-block-font-size)',
            lineHeight: 'var(--nt-font-markdown-code-block-line-height)',
            padding: '10px 14px',
            borderRadius: 8,
            whiteSpace: 'pre',
            overflowX: 'auto',
          }}
        >
          {children}
        </code>
      )
    }
    return (
      <code
        style={{
          background: 'var(--nt-alias-markdown-inline-code)',
          fontFamily: 'var(--nt-font-family-code)',
          fontSize: 'var(--nt-font-markdown-code-font-size)',
          lineHeight: 'var(--nt-font-markdown-code-line-height)',
          padding: '2px 6px',
          borderRadius: 4,
        }}
      >
        {children}
      </code>
    )
  },
  p({ children }) {
    return <p style={PARAGRAPH_STYLE}>{children}</p>
  },
  img({ alt }) {
    // Rule 2 加固（34-02）：markdown 图片不在验收渲染子集（34-UI-SPEC §6.1），且默认
    // 渲染 <img> 会对任意 http/https 自动发起被动网络请求（非点击门控，绕开威胁模型的
    // openExternalSafe 外开通道）——降级为 alt 纯文本呈现，零请求面
    return <span style={{ color: 'var(--nt-alias-label-secondary)' }}>[图片{alt ? `：${alt}` : ''}]</span>
  },
  li({ children }) {
    return <li style={PARAGRAPH_STYLE}>{children}</li>
  },
  ul({ children }) {
    return <ul style={{ margin: '8px 0', paddingInlineStart: 24 }}>{children}</ul>
  },
  ol({ children }) {
    return <ol style={{ margin: '8px 0', paddingInlineStart: 24 }}>{children}</ol>
  },
  strong({ children }) {
    return <strong style={{ fontWeight: 'var(--nt-font-markdown-base-strong-font-weight)' }}>{children}</strong>
  },
  h1({ children }) {
    return <h1 style={HEADING_STYLE.h1}>{children}</h1>
  },
  h2({ children }) {
    return <h2 style={HEADING_STYLE.h2}>{children}</h2>
  },
  h3({ children }) {
    return <h3 style={HEADING_STYLE.h3}>{children}</h3>
  },
  h4({ children }) {
    return <h4 style={HEADING_STYLE.h4}>{children}</h4>
  },
  table({ children }) {
    return (
      <table
        style={{
          borderCollapse: 'collapse',
          width: '100%',
          margin: '8px 0',
          fontSize: 'var(--nt-font-markdown-table-font-size)',
          lineHeight: 'var(--nt-font-markdown-table-line-height)',
        }}
      >
        {children}
      </table>
    )
  },
  th({ children }) {
    return (
      <th
        style={{
          border: '1px solid var(--nt-alias-border-l2)',
          padding: '6px 10px',
          textAlign: 'left',
          fontWeight: 'var(--nt-font-markdown-table-head-font-weight)',
          color: 'var(--nt-alias-label-primary)',
        }}
      >
        {children}
      </th>
    )
  },
  td({ children }) {
    return (
      <td
        style={{
          border: '1px solid var(--nt-alias-border-l2)',
          padding: '6px 10px',
          color: 'var(--nt-alias-label-primary)',
        }}
      >
        {children}
      </td>
    )
  },
}

export default function AssistantMarkdown({ content }: { content: string }) {
  if (!content) return null
  return (
    <div
      style={{
        color: 'var(--nt-alias-label-primary)',
        fontSize: 'var(--nt-font-markdown-base-font-size)',
        lineHeight: 'var(--nt-font-markdown-base-line-height)',
        overflowWrap: 'break-word',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={httpOnlyUrlTransform} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
