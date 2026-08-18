/**
 * MCP 配置 CRUD IPC 通道（Phase 21 21-02，MCP-01/MCP-02）。
 *
 * 红线：4 个 channel 全部经 secure 包装（鉴权 + 异常脱敏），登录前不可达（T-21-02-02）。
 * channel 命名 <domain>:<action>。
 *
 * mcp:save 网关校验（T-21-02-03）：typeof / 枚举 / 长度上限 / 数组结构 / MAX_BATCH=1000，
 * 拒绝时 { ok:false, error } 原样返回不 throw（promptIpc 同款风格）。
 * mcp:testConnection 留 21-04 落地（依赖 21-03 mcpClient）。
 */

import { ipcMain } from 'electron'
import { McpService, MAX_BATCH } from '../services/mcpService'
import type { McpSaveInput } from '../services/mcpService'
import { secure } from '../utils/authGuard'

const MAX_NAME_LENGTH = 100
const MAX_COMMAND_URL_LENGTH = 2000
const VALID_TYPES = ['stdio', 'http']

export function registerMcpIpc() {
  // 配置列表（出口只含 Masked 凭证，T-21-02-01）
  ipcMain.handle('mcp:list', secure(() => McpService.listConfigs()))

  ipcMain.handle('mcp:save', secure((_e, dto: McpSaveInput) => {
    if (!dto || typeof dto !== 'object') throw new Error('参数无效：dto')
    if (dto.id != null && (typeof dto.id !== 'number' || !Number.isInteger(dto.id))) {
      throw new Error('参数无效：id')
    }
    if (typeof dto.name !== 'string' || dto.name.trim() === '') throw new Error('参数无效：name 不能为空')
    if (dto.name.length > MAX_NAME_LENGTH) throw new Error(`名称超过长度上限 ${MAX_NAME_LENGTH} 字符`)
    if (!VALID_TYPES.includes(dto.type)) throw new Error(`参数无效：type 必须是 ${VALID_TYPES.join('/')}`)
    if (typeof dto.commandOrUrl !== 'string' || dto.commandOrUrl.trim() === '') {
      throw new Error('参数无效：commandOrUrl 不能为空')
    }
    if (dto.commandOrUrl.length > MAX_COMMAND_URL_LENGTH) {
      throw new Error(`命令/URL 超过长度上限 ${MAX_COMMAND_URL_LENGTH} 字符`)
    }
    if (dto.args !== undefined) {
      if (!Array.isArray(dto.args)) throw new Error('参数无效：args 必须为数组')
      if (dto.args.some((a) => typeof a !== 'string')) throw new Error('参数无效：args 数组元素必须均为 string')
    }
    if (dto.env !== undefined && dto.env !== null) {
      if (typeof dto.env !== 'object' || Array.isArray(dto.env)) throw new Error('参数无效：env 必须为键值对对象')
      for (const v of Object.values(dto.env)) {
        if (typeof v !== 'string') throw new Error('参数无效：env 值必须均为 string')
      }
    }
    if (dto.credential !== undefined && dto.credential !== null && typeof dto.credential !== 'string') {
      throw new Error('参数无效：credential')
    }
    if (dto.enabled !== undefined && typeof dto.enabled !== 'boolean') {
      throw new Error('参数无效：enabled 必须为 boolean')
    }
    if (dto.deviceIds !== undefined) {
      if (!Array.isArray(dto.deviceIds)) throw new Error('参数无效：deviceIds 必须为数组')
      if (dto.deviceIds.length > MAX_BATCH) throw new Error(`deviceIds 超过批量上限 ${MAX_BATCH}`)
      if (dto.deviceIds.some((d) => typeof d !== 'string' || !d)) throw new Error('参数无效：deviceIds 元素')
    }
    // 业务拒绝（D-04 绑定冲突等）走 { ok:false, error }，不以异常形式抛给 renderer
    return McpService.saveConfig(dto)
  }))

  // 删除（Popconfirm；mcp_device_rel 随 FK CASCADE 级联）
  ipcMain.handle('mcp:delete', secure((_e, id: number) => {
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('参数无效：id')
    McpService.deleteConfig(id)
    return { ok: true }
  }))

  // 启用/停用
  ipcMain.handle('mcp:setEnabled', secure((_e, id: number, enabled: boolean) => {
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('参数无效：id')
    if (typeof enabled !== 'boolean') throw new Error('参数无效：enabled')
    McpService.setEnabled(id, enabled)
    return { ok: true }
  }))
}
