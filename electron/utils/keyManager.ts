import fs from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import crypto from 'crypto'

const KEY_FILE = 'master.key'

/**
 * 主加密密钥管理。
 * masterKey 值为 32 字节随机 base64，是所有设备凭证 / 大模型 Key / ARP 数据的根密钥。
 * 落盘时通过 Electron safeStorage（Windows=DPAPI 绑定用户 / macOS=Keychain / Linux=libsecret）
 * 加密存储，使密钥文件离开本机或当前用户无法解密。
 * masterKey 值本身不变，历史加密数据无需迁移即可解密。
 */
// R3: masterKey 合法性校验。masterKey 为 32 字节随机 base64。
// 切断 safeStorage 翻转（换账户/换机）时把 DPAPI blob 当 UTF-8 明文 trim 出错误 masterKey 的破坏路径
// （该错误 key 与 decField 静默吞错叠加会无声丢失全库历史凭证/AI Key/chat_history）。
// 合法历史明文 base64 32 字节仍可回退（向后兼容历史 headless 落盘）。
function isValidMasterKey(s: string): boolean {
  try {
    return Buffer.from(s, 'base64').length === 32
  } catch {
    return false
  }
}

export function getOrCreateMasterKey(): string {
  const keyPath = path.join(app.getPath('userData'), KEY_FILE)

  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath)
    // 1) 优先 safeStorage 解密（正常路径：safeStorage 加密的 blob）
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(raw))
        if (isValidMasterKey(decrypted)) return decrypted
      } catch {
        // safeStorage 解密失败（账户变更/文件损坏）：落入明文回退判定
      }
    }
    // 2) 明文回退：必须是合法 base64 32 字节（历史明文 masterKey，向后兼容）
    const asText = raw.toString('utf8').trim()
    if (isValidMasterKey(asText)) return asText
    // 3) 两条路都无法解读 → safeStorage 翻转或文件损坏，显式抛错
    //    （安全失败优于静默返回错误 masterKey + 数据丢失；main.ts startup catch 会 dialog 提示从 backups 恢复）
    throw new Error('master.key 无法解读（safeStorage 不可用或系统账户变更），请从 backups 目录恢复历史 master.key 后重试')
  }

  const key = crypto.randomBytes(32).toString('base64')
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(keyPath, safeStorage.encryptString(key))
  } else {
    // headless / 异常环境兜底：明文 + 警告（仅极端环境，正常桌面端 safeStorage 可用）
    console.error('[security] safeStorage 不可用，主密钥将以明文存储，运行环境需加固')
    fs.writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 })
  }
  return key
}
