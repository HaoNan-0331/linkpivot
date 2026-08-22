/**
 * Phase 27（GUARD-01~06）：越权检测归一化/判定唯一实现。
 *
 * privilegeGuard 位于 commandSafety.isCommandAllowed 通过之后、命令执行之前的独立纯函数检测层：
 * - GUARD-01：探测/普通命令目标不在对话设备集 → 黄级确认（确认即执行，弹窗是提醒不是拒绝）
 * - GUARD-02：跳转类命令（ssh/telnet 等）目标 ≠ 当前执行设备 → 红级强确认（无集内豁免，D-01/SC2）
 * - GUARD-03：MCP 工具 args 夹带绑定集外目标 → 红级强确认（unresolvable 黄级 fail-closed）
 *
 * 纯函数：不依赖 MK、不读 DB（设备清单含明文 IP 由调用方注入，Pitfall 7）。
 * token 化与 commandSafety 共用 tokenizeCommand（单一来源，物理防两套解析器 drift，T-27-04）。
 * 归一化复用 normalizeDeviceName（NFC + 连字符变体折叠，勿重写折叠表）与 ipToNumber 输出契约。
 * JUMP_FIRST_WORDS / PROBE_EXEMPT 硬编码模块级常量（D-02），不做设置页可配——
 * 漏新命令仅多弹一次确认（fail-closed 兜底），不会漏拦。
 */

import { tokenizeCommand } from './commandSafety'
import { normalizeDeviceName } from './deviceName'
import { ipToNumber } from '../utils/ipMath'

/** 跳转类命令首词（建立新登录会话 = 打开新通道，目标非当前设备即强确认）。console 非跳转不列。 */
export const JUMP_FIRST_WORDS = new Set([
  'ssh', 'telnet', 'ftp', 'sftp', 'scp', 'slogin', 'rlogin', 'rsh',
])

/** 探测类豁免清单（目标在对话设备集内 → 豁免直执；集外 → 黄级确认即执行）。arp/nslookup 冗余无害。 */
export const PROBE_EXEMPT = new Set(['ping', 'tracert', 'traceroute', 'arp', 'nslookup'])

/**
 * 带值选项集合（D-02 硬编码）：选项后跟一个值参数，目标定位时需连值一起跳过。
 * 覆盖 ping/tracert（-c/-n/-w/-W/-s/-i/-t/-I/-a/-S/-m/-q/-f/-r）、Windows ping（-n/-l/-w/-i/-s/-a）、
 * ssh/telnet/scp/sftp（-l/-p/-P/-o/-b/-e/-F/-J/-g/-N/-Q/-R/-V）。
 * 无值选项（-v/-4/-6/-h 等）刻意不入集合——入集合会误跳真目标；
 * 清单不可能穷举（如华为 ping -a <源IP>），由 rest 全量保守扫描兜底（fail-closed）。
 */
export const OPTIONS_WITH_VALUE = new Set([
  '-c', '-n', '-w', '-W', '-s', '-i', '-t', '-I', '-a', '-S', '-m', '-q', '-f', '-r',
  '-l', '-p', '-P', '-o', '-b', '-e', '-F', '-J', '-g', '-N', '-Q', '-R', '-V',
])

// 十进制整数还原 IP 下限 = 1.0.0.0（防 `ping 100` / TTL 数字假阳性，Pitfall 3）
const DECIMAL_IP_MIN = 16777216
const VARIABLE_RE = /^\$|^%[^%]*%$/ // $x / ${x} / %x% —— 近似解析不可靠，fail-closed
const SCHEME_RE = /^[a-z0-9+.-]+:\/\//
const HOSTPORT_RE = /^(.+):(\d{1,5})$/

export interface GuardDeviceRef {
  id: string
  name: string
  ipAddress: string
}

export interface GuardHit {
  ruleId: 'GUARD-01' | 'GUARD-02' | 'GUARD-03'
  level: 'red' | 'yellow' // 越权红 / 提醒黄（27/28 共同契约）
  target: string // 实际目标原文 token
  explanation: string // 人话解释（含公网/内网差异文案，D-05 弹窗直接使用）
}

type Identifier =
  | { kind: 'ip'; num: number; text: string }
  | { kind: 'host'; normalized: string }
  | { kind: 'unresolvable' }
  | { kind: 'non-identifier' }

function numToIpText(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

function isPrivateIp(num: number): boolean {
  const a = (num >>> 24) & 255
  const b = (num >>> 16) & 255
  return (
    a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254
  )
}

/**
 * 标识符判定管线（决策表 MP-2 token 形态行）。
 * targetPosition=true 时（JUMP/PROBE 目标参数位）普通词也按主机名候选处理——
 * `ssh core-sw` / `ping baidu.com` 都需走设备名匹配；非目标位普通词默认忽略（Pitfall 1 防洪泛）。
 */
function resolveIdentifier(raw: string, targetPosition: boolean): Identifier {
  if (!raw) return { kind: 'non-identifier' }
  if (VARIABLE_RE.test(raw)) return { kind: 'unresolvable' }

  let t = raw
  const scheme = t.match(SCHEME_RE)
  if (scheme) t = t.slice(scheme[0].length)
  if (!t) return { kind: 'non-identifier' }
  if (t.includes('@')) t = t.slice(t.lastIndexOf('@') + 1) // user@host 取 host
  const hostPort = t.match(HOSTPORT_RE)
  if (hostPort) t = hostPort[1] // host:port 取 host
  if (t.includes(':')) return { kind: 'unresolvable' } // IPv6 / 端口残留（MISC-F01 defer）

  // 十六进制整数（0x0A010105）
  if (/^0x[0-9a-f]+$/.test(t)) {
    const n = parseInt(t, 16)
    if (n >= DECIMAL_IP_MIN && n <= 0xFFFFFFFF) return { kind: 'ip', num: n, text: numToIpText(n) }
    return { kind: 'non-identifier' }
  }

  if (t.includes('.')) {
    const segs = t.split('.')
    if (segs.length === 4 && segs.every((s) => /^\d+$/.test(s))) {
      // 前导 0 段优先按八进制还原（inet_aton 语义，A3）；八进制非法（08/09）回退十进制
      const hasLeadingZero = segs.some((s) => s.length > 1 && s.startsWith('0'))
      const oct = segs.map((s) => (s.length > 1 && s.startsWith('0') ? parseInt(s, 8) : Number(s)))
      const dec = segs.map((s) => Number(s))
      const num = ipToNumber((hasLeadingZero && oct.every(Number.isInteger) ? oct : dec).map(String).join('.'))
      if (num !== null) return { kind: 'ip', num, text: numToIpText(num) }
    }
    return { kind: 'host', normalized: normalizeDeviceName(t) } // 域名 / 多段标识
  }

  if (/^\d+$/.test(t)) {
    const n = Number(t)
    if (n >= DECIMAL_IP_MIN && n <= 0xFFFFFFFF) return { kind: 'ip', num: n, text: numToIpText(n) }
    return { kind: 'non-identifier' } // 普通数字参数（TTL/计数/接口号）
  }

  // 非 ASCII（含连字符 Unicode 变体/全角）→ normalizeDeviceName 管线；目标位普通词 → 主机名候选
  if (/[^\x20-\x7e]/.test(t) || targetPosition) {
    return { kind: 'host', normalized: normalizeDeviceName(t) }
  }
  return { kind: 'non-identifier' }
}

function matchDevice(id: Identifier, dev: GuardDeviceRef): boolean {
  if (id.kind === 'ip') return ipToNumber(dev.ipAddress) === id.num
  if (id.kind === 'host') return normalizeDeviceName(dev.name) === id.normalized
  return false
}

function findDevice(id: Identifier, devices: GuardDeviceRef[]): GuardDeviceRef | undefined {
  return devices.find((d) => matchDevice(id, d))
}

function ipDesc(id: Extract<Identifier, { kind: 'ip' }>): string {
  return `目标 IP ${id.text}${isPrivateIp(id.num) ? '（内网地址）' : '（公网地址）'}`
}

export interface GuardCheckInput {
  firstWord: string // 来自共享 tokenizeCommand
  tokens: string[] // 共享 token 化产物
  currentDevice: GuardDeviceRef // 当前执行设备（GUARD-02 基准）
  conversationSet: GuardDeviceRef[] // 对话设备集（GUARD-01 基准，含明文 IP）
  /** 可选全库设备投影（Pitfall 7：区分「库内未选」vs「库外陌生」文案，缺省降级统一文案） */
  allDevices?: GuardDeviceRef[]
}

function checkJumpTarget(
  target: string,
  currentDevice: GuardDeviceRef,
  conversationSet: GuardDeviceRef[],
  allDevices: GuardDeviceRef[]
): GuardHit[] {
  const id = resolveIdentifier(target, true)
  if (id.kind === 'non-identifier') return []
  if (id.kind === 'unresolvable') {
    return [{
      ruleId: 'GUARD-02',
      level: 'red',
      target,
      explanation: `跳转类命令目标「${target}」无法解析（变量/IPv6 形态），fail-closed 强确认`,
    }]
  }
  if (matchDevice(id, currentDevice)) return []
  const known = findDevice(id, [...conversationSet, ...allDevices])
  const desc = known
    ? `目标匹配库内设备「${known.name}」`
    : id.kind === 'ip'
      ? ipDesc(id)
      : `目标「${target}」不匹配任何已知设备`
  return [{
    ruleId: 'GUARD-02',
    level: 'red',
    target,
    explanation: `跳转类命令目标非当前执行设备「${currentDevice.name}」：${desc}。登录会话建立后可在目标设备继续执行后续命令（借道横向移动风险）`,
  }]
}

function checkProbeTarget(
  target: string,
  currentDevice: GuardDeviceRef,
  conversationSet: GuardDeviceRef[],
  allDevices: GuardDeviceRef[]
): GuardHit[] {
  const id = resolveIdentifier(target, true)
  if (id.kind === 'non-identifier') return []
  if (id.kind === 'unresolvable') {
    return [{
      ruleId: 'GUARD-01',
      level: 'yellow',
      target,
      explanation: `探测类命令目标「${target}」无法解析（变量/IPv6 形态），确认后执行`,
    }]
  }
  if (findDevice(id, conversationSet)) return [] // D-01：集内豁免直执
  const known = findDevice(id, allDevices)
  const desc = known
    ? `目标「${known.name}」是库内设备但不在本次对话设备集`
    : id.kind === 'ip'
      ? `${ipDesc(id)}，不在对话设备集`
      : `目标「${target}」不在对话设备集`
  return [{
    ruleId: 'GUARD-01',
    level: 'yellow',
    target,
    explanation: `探测类命令目标不在对话设备集：${desc}。确认后执行`,
  }]
}

/**
 * 目标 token 定位（JUMP/PROBE 共用）：跳过选项 token；带值选项（OPTIONS_WITH_VALUE）
 * 连同其值一起跳过——`ping -c 5 <ip>` 中 5 是 count 值，不是目标。
 */
export function findTargetToken(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (tok.startsWith('-')) {
      if (OPTIONS_WITH_VALUE.has(tok) && i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
        i++ // 跳过选项值
      }
      continue
    }
    return tok
  }
  return undefined
}

/**
 * rest 全量保守扫描（GUARD-01 黄，fail-closed 兜底）：仅 unresolvable 或精确命中
 * 已知设备（非当前设备，整 token 匹配）。JUMP/PROBE 定位失败与默认路径三处共用。
 *
 * probeFallback=true（WR-01，仅 PROBE 分支）：形似 IP 的 token（含被带值选项跳过的值，
 * 如 `ping -w 8.8.8.8`）不在任何已知设备 → 集外黄级。PROBE 上下文中形似目标的值
 * 不得静默丢弃（fail-closed）；纯数字 count/TTL 值是 non-identifier 天然不触发。
 */
function scanRestTokens(
  rest: string[],
  currentDevice: GuardDeviceRef,
  conversationSet: GuardDeviceRef[],
  allDevices: GuardDeviceRef[],
  seen: Set<string>,
  probeFallback = false
): GuardHit[] {
  const hits: GuardHit[] = []
  for (const tok of rest) {
    if (seen.has(tok)) continue
    const id = resolveIdentifier(tok, false)
    if (id.kind === 'unresolvable') {
      seen.add(tok)
      hits.push({
        ruleId: 'GUARD-01',
        level: 'yellow',
        target: tok,
        explanation: `命令参数「${tok}」无法解析（变量/IPv6 形态），确认后执行`,
      })
    } else if (id.kind === 'ip' || id.kind === 'host') {
      const known = findDevice(id, [...conversationSet, ...allDevices])
      if (known && known.id !== currentDevice.id) {
        seen.add(tok)
        hits.push({
          ruleId: 'GUARD-01',
          level: 'yellow',
          target: tok,
          explanation: `命令参数指向库内设备「${known.name}」（非当前执行设备「${currentDevice.name}」），确认后执行`,
        })
      } else if (probeFallback && id.kind === 'ip' && !known) {
        seen.add(tok)
        hits.push({
          ruleId: 'GUARD-01',
          level: 'yellow',
          target: tok,
          explanation: `探测类命令参数含设备集外目标（${ipDesc(id)}），不在对话设备集，确认后执行`,
        })
      }
    }
  }
  return hits
}

/**
 * 命令越权检测（GUARD-01/02）。返回空数组 = 放行；命中 → 调用方挂 confirm_required
 * + guardInfo（无论 confirm/auto 模式均打断，D-06）。
 */
export function checkCommand(input: GuardCheckInput): GuardHit[] {
  const { firstWord, tokens, currentDevice } = input
  const conversationSet = input.conversationSet
  const allDevices = input.allDevices ?? []
  const first = (firstWord || '').toLowerCase()
  const rest = tokens.slice(1).map((t) => t.toLowerCase())

  // URI 形态（ssh://x@y）首词本身即目标
  const schemeJump = Array.from(JUMP_FIRST_WORDS).some((w) => first.startsWith(w + '://'))
  if (JUMP_FIRST_WORDS.has(first) || schemeJump) {
    if (schemeJump && !JUMP_FIRST_WORDS.has(first)) {
      // WR-02：与非 scheme 分支同构——主目标（URI 首词）放行 ≠ 整条命令安全，
      // rest 仍走全量保守扫描兜底（seen 预置主目标）
      const schemeHits = checkJumpTarget(first, currentDevice, conversationSet, allDevices)
      if (schemeHits.length > 0) return schemeHits
      return scanRestTokens(rest, currentDevice, conversationSet, allDevices, new Set([first]))
    }
    const target = findTargetToken(rest)
    if (!target) return scanRestTokens(rest, currentDevice, conversationSet, allDevices, new Set())
    const hits = checkJumpTarget(target, currentDevice, conversationSet, allDevices)
    if (hits.length > 0) return hits
    // 主目标放行（non-identifier/自身）≠ 整条命令安全：rest 全量保守扫描兜底（fail-closed）
    const seen = new Set([target])
    return scanRestTokens(rest, currentDevice, conversationSet, allDevices, seen)
  }
  if (PROBE_EXEMPT.has(first)) {
    const target = findTargetToken(rest)
    // WR-01：兜底扫描开 probeFallback——目标定位失败（全部 token 被带值选项消费，如
    // `ping -w 8.8.8.8`）时形似 IP 的选项值不得静默放行
    if (!target) return scanRestTokens(rest, currentDevice, conversationSet, allDevices, new Set(), true)
    const hits = checkProbeTarget(target, currentDevice, conversationSet, allDevices)
    if (hits.length > 0) return hits
    const seen = new Set([target])
    return scanRestTokens(rest, currentDevice, conversationSet, allDevices, seen, true)
  }

  // 其它白名单命令：保守扫描
  return scanRestTokens(rest, currentDevice, conversationSet, allDevices, new Set())
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out)
  }
}

/**
 * MCP 工具 args 越权检测（GUARD-03）：递归遍历 string 值，按 [\s,;@:/] 拆词走同一归一化管线。
 * token 精确命中已知设备形态且 ≠ 绑定设备 → 红；unresolvable → 黄 fail-closed。
 * 整 token 匹配禁子串（`10.1.1.50` 不得误命中 `10.1.1.5`，GUARD-06 词界）。
 */
export function checkMcpArgs(
  args: Record<string, unknown>,
  boundDevice: GuardDeviceRef,
  conversationSet: GuardDeviceRef[],
  allDevices?: GuardDeviceRef[]
): GuardHit[] {
  const strings: string[] = []
  collectStrings(args, strings)
  const known = [boundDevice, ...conversationSet, ...(allDevices ?? [])]
  const hits: GuardHit[] = []
  const seen = new Set<string>()
  for (const s of strings) {
    for (const tok of s.toLowerCase().split(/[\s,;@:/]+/).filter(Boolean)) {
      if (seen.has(tok)) continue
      const id = resolveIdentifier(tok, false)
      if (id.kind === 'unresolvable') {
        seen.add(tok)
        hits.push({
          ruleId: 'GUARD-03',
          level: 'yellow',
          target: tok,
          explanation: `MCP 参数「${tok}」无法解析（变量/IPv6 形态），fail-closed 确认`,
        })
      } else if (id.kind === 'ip' || id.kind === 'host') {
        const dev = findDevice(id, known)
        if (dev && dev.id !== boundDevice.id) {
          seen.add(tok)
          hits.push({
            ruleId: 'GUARD-03',
            level: 'red',
            target: tok,
            explanation: `MCP 参数目标「${tok}」命中设备「${dev.name}」，超出工具绑定的设备「${boundDevice.name}」`,
          })
        }
      }
    }
  }
  return hits
}
