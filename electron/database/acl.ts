import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { createSystemLog } from '../services/systemLog'

/**
 * 跨平台收紧单个文件权限为「仅当前用户可读写」（D-10/D-11/D-12）。
 * - Windows: icacls "<path>" /inheritance:r /grant:r "<currentUser>:(F)"
 *   （剥离继承、仅当前用户完全控制、替换显式项）
 * - Unix/macOS: fs.chmod(path, 0o600)
 *
 * 幂等（D-12）：每次 app 启动对活跃 db 文件 + 每个备份创建后立即调用，无 sentinel。
 * 非致命（D-13）：失败（权限不足/非管理员/文件不存在）写 system log 警告后继续，不抛异常——
 *   数据已在应用层 AES-256-GCM + safeStorage 加密，ACL 是纵深防御第二层。
 *
 * @param filePath 待收紧的文件绝对路径
 * @param label 日志标识（如 'topology.db' / 'topology.db-wal' / 备份文件名），便于 system log 定位
 */
export function restrictFilePermissions(filePath: string, label: string): void {
  // 文件不存在则静默跳过（WAL/SHM sidecar 在 checkpoint 后可能不存在；备份目录刚建时为空）
  if (!fs.existsSync(filePath)) return

  try {
    if (process.platform === 'win32') {
      const currentUser = process.env.USERNAME || os.userInfo().username
      if (!currentUser) {
        throw new Error('无法确定当前 Windows 用户名（USERNAME / os.userInfo 均为空）')
      }
      // /inheritance:r 剥离继承；/grant:r 替换（非追加）显式 ACE，仅当前用户完全控制
      execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${currentUser}:(F)`], {
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
        timeout: 10000,
      })
    } else {
      // Unix/macOS：仅 owner 读写
      fs.chmodSync(filePath, 0o600)
    }
  } catch (err) {
    // D-13：非致命——写 system log 警告后继续，不抛异常
    const msg = (err as Error).message
    try {
      createSystemLog({
        type: 'acl',
        status: 'warning',
        errorMessage: `文件权限收紧失败 [${label}] (${filePath}): ${msg}。数据已在应用层加密，ACL 为纵深防御层，不影响数据安全。`,
      })
    } catch {
      // 日志失败亦不抛（避免 createSystemLog 自身故障阻塞调用方）
    }
  }
}

/**
 * 收紧指定目录下所有文件权限（D-10：userData/backups/ 下所有备份文件同等保护）。
 * 幂等、非致命（委托 restrictFilePermissions）。
 * @param dirPath 目录绝对路径
 */
export function restrictDirPermissions(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return
  let entries: string[]
  try {
    entries = fs.readdirSync(dirPath)
  } catch (err) {
    try {
      createSystemLog({
        type: 'acl',
        status: 'warning',
        errorMessage: `备份目录读取失败 (${dirPath}): ${(err as Error).message}`,
      })
    } catch {
      /* 非致命 */
    }
    return
  }
  for (const entry of entries) {
    const fullPath = `${dirPath}/${entry}`
    try {
      const stat = fs.statSync(fullPath)
      if (stat.isFile()) {
        restrictFilePermissions(fullPath, `backups/${entry}`)
      }
    } catch {
      // 单文件失败已由 restrictFilePermissions 内部记录，此处跳过
    }
  }
}
