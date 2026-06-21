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
export function getOrCreateMasterKey(): string {
  const keyPath = path.join(app.getPath('userData'), KEY_FILE)

  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath)
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(raw))
      } catch {
        // 历史明文落盘或文件损坏：回退明文 base64
      }
    }
    return raw.toString('utf8').trim()
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
