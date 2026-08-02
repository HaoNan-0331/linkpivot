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

// 凭证关键词后跟分隔符/连接词与值，值替换为 ****。
// CR-02：「key」为短关键词，用 key(?![a-z]) 加后置词界排除 keyboard/keys；前置边界由 CRED_RE 外层
//         (?<![A-Za-z0-9_]) 统一提供（排除 monkey/donkey/hockey，且兼容中文关键词「密码」——
//         \b 不认中文边界会漏匹「密码」，故用 ASCII lookbehind 而非 \b）；独立 "key" + 分隔符仍正确脱敏。
// 关键词词界隔离，避免把 username 里的 'name' 误匹配（用显式关键词列表 + 不含 username/login）。
const CRED_KEYWORDS = 'password|passwd|pwd|secret|token|apiKey|api_key|key(?![a-z])|密码|口令|凭证'
// 关键词 + 分隔符 + 值：
// - 前置边界：(?<![A-Za-z0-9_]) 排除英文词内嵌匹（monkey 里的 key）且兼容中文关键词（\b 不认中文边界）
// - 分隔符 A：\s*[:=]\s*（password: xxx / api_key=xxx）
// - 分隔符 B：空格 + 可选自然语言连接词 + 空格（CR-01，覆盖 "password is hunter2" / "token 为 xxx" / "密码 是 xxx"）
//   连接词集：英 is/are/was + 中 为/是/等于；可选，缺省时退化为单空格分隔（密码 xxx）。
//   不含 to/for——过于常见（go to / password to access），误伤代价高于漏判收益。
// 引号包裹的值单独处理（整体作为值）。
// 捕获组：组1 = 前缀（关键词 + 分隔符/连接词），组2 = 值（引号值整体或末尾非空白串）
// 用捕获组直接重组——避免回调内 \S+$ 重解析时被中文/[:=]（均为 \S）跨越吞掉前缀的 bug
const CRED_RE = new RegExp(
  `(?<![A-Za-z0-9_])((?:${CRED_KEYWORDS})(?:\\s*[:=]\\s*|\\s+(?:is|are|was|为|是|等于)?\\s*))("[^"]*"|'[^']*'|\\S+)`,
  'gi'
)

// IPv4 前三段掩码，末段保留（$2 = 末段）
const IPV4_RE = /(\d{1,3}\.){3}(\d{1,3})/g

// MAC 前三段掩码，后三段保留（$1 = 后三段）
// D-04 范例：AA:BB:CC:DD:EE:FF → **:**:**:DD:EE:FF（前三段掩码、后三段保留，尾4 字符可见）
const MAC_RE = /(?:[0-9A-Fa-f]{2}:){3}([0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})/g

/**
 * 凭证脱敏：关键词 + 分隔符/连接词 + 值整体替换为「前缀 + ****」。
 * CR-01：连接词形态（password is hunter2 / token 为 xxx）下，组2 值 = 真实凭证（hunter2 / xxx），
 *        不再把连接词本身当值吞掉导致真实凭证残留。
 * 用 CRED_RE 捕获组（组1=前缀，组2=值）直接重组，避免回调内 \S+$ 在中文/[:=] 场景跨越吞前缀。
 */
export function maskCredentials(text: string): string {
  // 组1 = 关键词 + 分隔符/连接词前缀；组2 = 值（引号整体或非空白串），替换组2 为 ****
  return text.replace(CRED_RE, (_match: string, prefix: string) => `${prefix}****`)
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
