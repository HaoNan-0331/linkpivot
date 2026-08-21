import { createHash } from 'node:crypto'

/**
 * Phase 25（ASSET-03）：设备名归一化单一来源。
 *
 * devices.name_enc 是 AES-256-GCM 密文，无法直接建 UNIQUE——name_hash 列存归一化名的
 * SHA-256（碰撞比对用途，无需可逆，T-25-03 accept）。本模块是归一化/哈希的唯一实现，
 * device service 写入维护（25-02）与 v23 存量回填（25-03）共用，防两处 drift。
 *
 * 纯函数：不依赖 MK、不读 DB。
 */

/**
 * 连字符 Unicode 变体折叠：U+2010-U+2015（含 U+2011 non-breaking hyphen）、U+2212 minus、
 * U+FE58/U+FE63 小型变体、U+FF0D 全角——NFC 对这些码位无分解映射（U+2011 无 canonical/
 * compatibility decomposition 到 '-'），必须显式折叠，否则 'Core‑SW' 与 'Core-SW' 绕过唯一校验。
 */
const HYPHEN_VARIANTS = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g

/** 归一化：trim 首尾空格 + NFC + 连字符变体折叠 + toLowerCase。 */
export function normalizeDeviceName(name: string): string {
  return name.trim().normalize('NFC').replace(HYPHEN_VARIANTS, '-').toLowerCase()
}

/** 归一化名 SHA-256，64 位小写 hex。空串不 throw（返回确定性 hash）。 */
export function hashDeviceName(name: string): string {
  return createHash('sha256').update(normalizeDeviceName(name)).digest('hex')
}
