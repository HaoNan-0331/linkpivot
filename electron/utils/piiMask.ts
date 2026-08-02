/**
 * PII 脱敏 util（Phase 8 D-04）。
 * 送 LLM 起草前的会话正文副本专用——原始 chat_history 明文不动（Phase 9 原始会话回链用明文）。
 * 不复用 ai.ts getAiConfigMasked 的 `****xxxx`（那是 apiKey 给 renderer 的脱敏，场景不同）。
 *
 * 分级（D-04 逐字）：
 * - 凭证（最敏感）全脱敏 ****：password/passwd/pwd/secret/token/apiKey/api_key/key/密码/口令/凭证 后跟值
 * - IPv4 保留尾4：前三段掩码，末段保留（LLM 可区分不同设备）
 * - MAC 保留尾4：前两段掩码，后四段保留
 *
 * 纯字符串 transform，不涉加密、不读写 DB、不依赖 masterKey。
 */

// 凭证关键词后跟分隔符与值，值替换为 ****。值 = 分隔符后到下一个空白/行尾/引号闭合的连续非空白串。
// 关键词词界隔离，避免把 username 里的 'name' 误匹配（用显式关键词列表 + 不含 username/login）。
// 关键词后允许的分隔符：: = 空格（最常见「password: xxx」「api_key=xxx」「密码 xxx」），引号包裹的值单独处理。
// 注意「key」为短关键词，须用 (?![A-Za-z]) 词界防 apiKey/api_key 之外的误匹配（如 keyboard）；
// 但「key」需紧跟分隔符 [:=\s]，自然限定，不另加边界。
const CRED_KEYWORDS = 'password|passwd|pwd|secret|token|apiKey|api_key|key|密码|口令|凭证'
// 关键词 + 分隔符（: = 或空白）+ 非空白值（含引号值整体替换）
const CRED_RE = new RegExp(
  `(?:${CRED_KEYWORDS})(?:\\s*[:=]\\s*|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`,
  'gi'
)

// IPv4 前三段掩码，末段保留（$2 = 末段）
const IPV4_RE = /(\d{1,3}\.){3}(\d{1,3})/g

// MAC 前三段掩码，后三段保留（$1 = 后三段）
// D-04 范例：AA:BB:CC:DD:EE:FF → **:**:**:DD:EE:FF（前三段掩码、后三段保留，尾4 字符可见）
const MAC_RE = /(?:[0-9A-Fa-f]{2}:){3}([0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})/g

/** 凭证脱敏：关键词 + 分隔符 + 值整体替换为「关键词+分隔符+****」。 */
export function maskCredentials(text: string): string {
  return text.replace(CRED_RE, (full) => {
    // full 形如 "password: admin123" / "api_key='sk-xxx'" → 保留关键词+分隔符，值替换 ****
    // 找到最后一个分隔符位置（: = 或空白），保留其左侧
    const m = full.match(/^(\S*?\s*[:=]\s*)(.*)$/s)
    if (m) return `${m[1]}****`
    return full.replace(/(?<=[:=\s])\S+$/s, '****')
  })
}

/** IPv4 脱敏：前三段掩码，末段保留。 */
export function maskIpv4(text: string): string {
  return text.replace(IPV4_RE, '***.***.***.$2')
}

/** MAC 脱敏：前两段掩码，后四段保留。 */
export function maskMac(text: string): string {
  return text.replace(MAC_RE, '**:**:**:$1')
}

/** 串联三步（顺序：凭证 → IPv4 → MAC，避免凭证值被 IP/MAC 误伤或反之）。 */
export function maskConversationText(text: string): string {
  if (!text || !text.trim()) return text || ''
  let out = maskCredentials(text)
  out = maskIpv4(out)
  out = maskMac(out)
  return out
}
