/**
 * MCP 包生命周期 IPC 通道（Phase 29 29-03，PKG-01/02/03/04/06）。
 *
 * 红线：channel 全部经 secure 包装（鉴权 + 异常脱敏），登录前不可达（29-05 起含 exportFormatSpec 共 9 个）。
 * channel 命名 <domain>:<action>（mcp: 域）。
 *
 * 网关校验：
 *  - mcp:importPackage / mcp:reimportPackage / mcp:confirmOverwrite 的 buffer：
 *    Uint8Array/ArrayBuffer + 200MB 上限（与校验器 MAX_PACKAGE_BYTES 同值双重拦截，T-29-03-02）
 *  - id 正整数；业务拒绝走 { ok:false, error }（网关非法 throw new Error('参数无效：xxx')）
 *  - 包名长度上限经 service 层 MAX_PKG_NAME_LENGTH（manifest 解出后判定）
 *
 * mcp:testPackage 进度事件：'mcp:packageTestProgress' { testId, stage, elapsedMs }
 * （照 mcpIpc testConnection 先例，webContents 销毁 try/catch 吞错，WR-04 同款）。
 */

import { ipcMain, dialog, app } from 'electron'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { McpPackageService, MAX_PKG_NAME_LENGTH } from '../services/mcpPackageService'
import { MAX_PACKAGE_BYTES } from '../services/mcpPackageValidator'
import { secure } from '../utils/authGuard'

/** @internal re-export 供网关常量同源引用（不新增上限值） */
export { MAX_PKG_NAME_LENGTH }

function toBuffer(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  throw new Error('参数无效：包内容必须是二进制字节流')
}

function assertBuffer(input: unknown): Uint8Array {
  const buf = toBuffer(input)
  if (buf.byteLength === 0) throw new Error('参数无效：包内容为空')
  if (buf.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error(`包文件体积超过 200MB 上限（${(buf.byteLength / 1024 / 1024).toFixed(0)}MB）`)
  }
  return buf
}

function assertId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw new Error('参数无效：id')
  return id
}

export function registerMcpPackageIpc() {
  ipcMain.handle('mcp:importPackage', secure((_e, buffer: unknown) => {
    return McpPackageService.importPackage(assertBuffer(buffer))
  }))

  ipcMain.handle('mcp:reimportPackage', secure((_e, buffer: unknown) => {
    return McpPackageService.reimportPackage(assertBuffer(buffer))
  }))

  ipcMain.handle('mcp:confirmOverwrite', secure((_e, packageId: unknown, buffer: unknown) => {
    return McpPackageService.confirmOverwrite(assertId(packageId), assertBuffer(buffer))
  }))

  ipcMain.handle('mcp:listPackages', secure(() => McpPackageService.listPackages()))

  ipcMain.handle('mcp:getPackage', secure((_e, id: unknown) => {
    const pkgId = assertId(id)
    const pkg = McpPackageService.getPackage(pkgId)
    if (!pkg) return { ok: false, error: '包不存在或已被删除' }
    return { ok: true, package: pkg }
  }))

  ipcMain.handle('mcp:getPackageDeleteImpact', secure((_e, id: unknown) => {
    const impact = McpPackageService.getPackageDeleteImpact(assertId(id))
    if (!impact) return { ok: false, error: '包不存在或已被删除' }
    return { ok: true, impact }
  }))

  ipcMain.handle('mcp:deletePackage', secure((_e, id: unknown) => {
    return McpPackageService.deletePackage(assertId(id))
  }))

  ipcMain.handle('mcp:testPackage', secure(async (e, payload: { packageId: number, testId?: string }) => {
    if (!payload || typeof payload !== 'object') throw new Error('参数无效：payload')
    const packageId = assertId(payload.packageId)
    if (payload.testId !== undefined &&
      (typeof payload.testId !== 'string' || payload.testId.length < 8 || payload.testId.length > 64 || !/^[\w-]+$/.test(payload.testId))) {
      throw new Error('参数无效：testId')
    }
    // 进度事件转发（WR-04 同款：webContents 已销毁不当作测试失败）
    return McpPackageService.testPackage(packageId, {
      ...(payload.testId !== undefined ? { testId: payload.testId } : {}),
      onStage: (stage, elapsedMs) => {
        try {
          e.sender.send('mcp:packageTestProgress', { testId: payload.testId ?? `pkg-${packageId}`, stage, elapsedMs })
        } catch { /* webContents 已销毁，忽略 */ }
      },
    })
  }))

  // D-10：导出 .mcpb 格式说明静态资源（extraResources 只读分发，T-29-05-03 accept——路径固定不可注入）
  ipcMain.handle('mcp:exportFormatSpec', secure(async () => {
    const src = app.isPackaged
      ? join(process.resourcesPath, 'docs', 'mcpb-format-spec.md')
      : join(app.getAppPath(), 'resources', 'docs', 'mcpb-format-spec.md')
    const result = await dialog.showSaveDialog({
      title: '保存 .mcpb 格式说明',
      defaultPath: 'mcpb-format-spec.md',
      filters: [{ name: 'Markdown 文件', extensions: ['md'] }, { name: '所有文件', extensions: ['*'] }],
    })
    if (result.canceled || !result.filePath) return { ok: true, canceled: true }
    try {
      await copyFile(src, result.filePath)
      return { ok: true, canceled: false, path: result.filePath }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }))
}
