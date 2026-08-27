/**
 * release notes 清洗纯函数（Phase 30 / UPD-01 防注入红线，30-04 Task 1）。
 *
 * 纯函数、无第三方依赖（避免 react-markdown + rehype-sanitize ~100KB 渲染栈与供应链面；
 * 红线是「不渲染原始 HTML」，文本节点渲染攻击面为零——RESEARCH Pattern 4）。
 * GitHub release body 是 markdown 原文（外部不可信文本），渲染前必经本函数：
 * 长度截断（64KB 防 DoS）→ 控制字符剥离（保留 \n \t）→ HTML 标签整段剥离（含孤立 <> 兜底）
 * → markdown 语法折叠（图片整段删 / 链接文本化 / 围栏去围栏 / 强调去标记 / 列表符 → • ）
 * → 连续 ≥3 空行压缩为 1 空行。输出只以 React 文本节点渲染，禁止任何原始 HTML 注入式渲染。
 */

/** 输入/输出长度上限（64KB，防超长 DoS） */
const MAX_RELEASE_NOTES_LENGTH = 65536

// 控制字符（C0 去 \n\x0A 与 \t\x09，含 DEL \x7F）
const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F]/g
// HTML 标签整段（<tag attr>、</tag>；[^>] 含跨行属性）
const HTML_TAG_RE = /<[^>]*>/g
// 标签剥离后的孤立尖括号兜底（含截断撕裂的 <scr 残片）
const STRAY_ANGLE_RE = /[<>]/g
// markdown 图片 ![alt](url) —— 必须先于链接折叠，否则 URL 被文本化保留
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g
// markdown 链接 [text](url) → text (url)（协议文本化，零执行面）
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g
// 代码围栏行（```lang 整行，含缩进）—— 去围栏留内容行
const MD_FENCE_LINE_RE = /^[ \t]*`{3,}[^`\n]*[ \t]*$/gm
// 行内代码反引号
const MD_INLINE_CODE_RE = /`([^`\n]+)`/g
// 行首标题标记（# ×1-6 + 空白）
const MD_HEADING_RE = /^#{1,6}[ \t]+/gm
// 强调标记（** 与 ~~ 先于单 * / _，防半折叠）
const MD_BOLD_RE = /\*\*([^*\n]+)\*\*/g
const MD_STRIKE_RE = /~~([^~\n]+)~~/g
const MD_ITALIC_STAR_RE = /\*([^*\n]+)\*/g
const MD_ITALIC_UNDER_RE = /_([^_\n]+)_/g
// 行首列表标记（- / * / 数字. + 空白）→ •
const MD_LIST_DASH_RE = /^[-*][ \t]+/gm
const MD_LIST_ORDERED_RE = /^[0-9]+\.[ \t]+/gm
// 连续 ≥3 空行（≥4 连续换行，含空白行归一后）→ 1 空行
const BLANK_RUN_RE = /\n{4,}/g
// 全空白行（归一为空行后再压缩）
const WHITESPACE_ONLY_LINE_RE = /^[ \t]+$/gm

/**
 * 清洗 GitHub release notes 为可安全渲染的纯文本。
 * 输入非字符串或 trim 后为空 → 返回 ''。
 */
export function sanitizeReleaseNotes(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return ''

  let out = raw.slice(0, MAX_RELEASE_NOTES_LENGTH)
  out = out.replace(CONTROL_CHARS_RE, '')
  out = out.replace(HTML_TAG_RE, '')
  out = out.replace(STRAY_ANGLE_RE, '')
  out = out.replace(MD_IMAGE_RE, '')
  out = out.replace(MD_LINK_RE, '$1 ($2)')
  out = out.replace(MD_FENCE_LINE_RE, '')
  out = out.replace(MD_INLINE_CODE_RE, '$1')
  out = out.replace(MD_HEADING_RE, '')
  out = out.replace(MD_BOLD_RE, '$1')
  out = out.replace(MD_STRIKE_RE, '$1')
  out = out.replace(MD_ITALIC_STAR_RE, '$1')
  out = out.replace(MD_ITALIC_UNDER_RE, '$1')
  out = out.replace(MD_LIST_DASH_RE, '• ')
  out = out.replace(MD_LIST_ORDERED_RE, '• ')
  out = out.replace(WHITESPACE_ONLY_LINE_RE, '')
  out = out.replace(BLANK_RUN_RE, '\n\n')

  // 折叠后终裁（链路任何一步理论上只缩短，此处为 ≤64KB 不变量兜底）
  return out.slice(0, MAX_RELEASE_NOTES_LENGTH)
}
