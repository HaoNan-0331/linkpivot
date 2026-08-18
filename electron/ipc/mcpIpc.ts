/**
 * MCP 配置 CRUD IPC 通道（Phase 21 21-02，MCP-01/MCP-02）。
 *
 * 红线：4 个 channel 全部经 secure 包装（鉴权 + 异常脱敏），登录前不可达（T-21-02-02）。
 * channel 命名 <domain>:<action>。
 *
 * mcp:save 网关校验（T-21-02-03）：typeof / 枚举 / 长度上限 / 数组结构 / MAX_BATCH=1000，
 * 拒绝时 { ok:false, error } 原样返回不 throw（promptIpc 同款风格）。
 *
 * 21-04 新增：mcp:testConnection / mcp:cancelTest（secure）。
 *  - testConnection 入参 { testId, configId?, temp? }：configId 走 decodeForTest 解密已存配置；
 *    temp 为表单未保存值（明文凭证单向即抛即用，Open Question 3 边界），响应永不回含凭证（T-21-04-01）。
 *  - 阶段进度经 e.sender.send('mcp:testProgress', { testId, stage, elapsedMs })（T-21-04-04：
 *    testId 由 renderer 生成随机串，事件仅含 stage/elapsed 数据字段）。
 *  - 已存配置测试结束（成功/失败）调 McpService.recordTestResult 落库（D-09）。
 *  - env 值哨兵 UNCHANGED_ENV_SENTINEL：未修改的脱敏回显值不重传，临时测试路径直接剔除。
 */

import { ipcMain } from 'electron'
import { McpService, MAX_BATCH, UNCHANGED_ENV_SENTINEL } from '../services/mcpService'
import type { McpSaveInput } from '../services/mcpService'
import { testConnection as runTest, cancelTest } from '../services/mcpClient'
import type { McpTestResult } from '../services/mcpClient'
import { secure } from '../utils/authGuard'

const MAX_NAME_LENGTH = 100
const MAX_COMMAND_URL_LENGTH = 2000
const MAX_COMMAND_URL_LENGTH_TEST = 2000
const MAX_ARG_LENGTH = 500
const MAX_ENV_PAIRS = 50
const MAX_ENV_KEY_LENGTH = 100
const MAX_ENV_VALUE_LENGTH = 2000
const VALID_TYPES = ['stdio', 'http']

export interface McpTempTestInput {
  type: 'stdio' | 'http'
  commandOrUrl: string
  args?: string[]
  env?: Record<string, string>
  credential?: string
}

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

  /**
   * 连接测试（21-04，D-07/D-08/D-09）。
   * 入参：{ testId, configId?, temp? }——configId 指向已存配置（解密后测试）；
   * temp 为表单未保存值（明文凭证单向即抛即用，响应不含任何凭证字段，T-21-04-01）。
   * 阶段进度经 'mcp:testProgress' 事件转发（T-21-04-04）。
   */
  ipcMain.handle('mcp:testConnection', secure(async (e, payload: {
    testId: string
    configId?: number | null
    temp?: McpTempTestInput | null
  }) => {
    if (!payload || typeof payload !== 'object') throw new Error('参数无效：payload')
    const { testId, configId, temp } = payload
    if (typeof testId !== 'string' || testId.length < 8 || testId.length > 64 || !/^[\w-]+$/.test(testId)) {
      throw new Error('参数无效：testId')
    }
    if (configId != null && (typeof configId !== 'number' || !Number.isInteger(configId))) {
      throw new Error('参数无效：configId')
    }

    // 基线：已存配置解密形态（configId 缺失时为空基线）
    const base = configId != null ? McpService.decodeForTest(configId) : null

    let config: {
      type: 'stdio' | 'http'
      commandOrUrl: string
      args: string[]
      env: Record<string, string>
      credential: string | null
    }
    if (temp !== undefined && temp !== null) {
      if (!temp || typeof temp !== 'object') throw new Error('参数无效：temp')
      if (!VALID_TYPES.includes(temp.type)) throw new Error(`参数无效：type 必须是 ${VALID_TYPES.join('/')}`)
      const commandOrUrl = typeof temp.commandOrUrl === 'string' && temp.commandOrUrl.trim() !== ''
        ? temp.commandOrUrl
        : base?.commandOrUrl
      if (typeof commandOrUrl !== 'string' || commandOrUrl.trim() === '') {
        throw new Error('参数无效：commandOrUrl 不能为空')
      }
      if (commandOrUrl.length > MAX_COMMAND_URL_LENGTH_TEST) {
        throw new Error(`命令/URL 超过长度上限 ${MAX_COMMAND_URL_LENGTH_TEST} 字符`)
      }
      let args: string[]
      if (temp.args !== undefined) {
        if (!Array.isArray(temp.args)) throw new Error('参数无效：args 必须为数组')
        if (temp.args.some((a) => typeof a !== 'string' || a.length > MAX_ARG_LENGTH)) {
          throw new Error(`参数无效：args 元素必须为 string 且不超过 ${MAX_ARG_LENGTH} 字符`)
        }
        args = temp.args
      } else {
        args = base?.args ?? []
      }
      // env 合并：temp.env 中哨兵值/未提供键沿用基线明文，其余即抛即用（T-21-04-01）
      const env: Record<string, string> = { ...(base?.env ?? {}) }
      if (temp.env !== undefined && temp.env !== null) {
        if (typeof temp.env !== 'object' || Array.isArray(temp.env)) throw new Error('参数无效：env 必须为键值对对象')
        const keys = Object.keys(temp.env)
        if (keys.length > MAX_ENV_PAIRS) throw new Error(`env 键值对超过上限 ${MAX_ENV_PAIRS}`)
        for (const k of keys) {
          const v = temp.env[k]
          if (typeof v !== 'string' || v.length > MAX_ENV_VALUE_LENGTH) {
            throw new Error('参数无效：env 值必须为 string 且不超长')
          }
          if (k.length > MAX_ENV_KEY_LENGTH) throw new Error(`env 键超过长度上限 ${MAX_ENV_KEY_LENGTH} 字符`)
          if (v === UNCHANGED_ENV_SENTINEL) continue // 未修改：沿用基线
          if (v === '') delete env[k] // 清空
          else env[k] = v
        }
      }
      // credential：undefined=未修改沿用基线；''/null=清空；string=明文即抛即用
      let credential: string | null
      if (temp.credential === undefined) credential = base?.credential ?? null
      else if (temp.credential === null || temp.credential === '') credential = null
      else {
        if (typeof temp.credential !== 'string' || temp.credential.length > MAX_ENV_VALUE_LENGTH) {
          throw new Error('参数无效：credential')
        }
        credential = temp.credential
      }
      config = { type: temp.type, commandOrUrl, args, env, credential }
    } else if (base) {
      config = base
    } else {
      throw new Error('参数无效：须提供 configId 或 temp')
    }

    // 阶段进度事件转发（T-21-04-04：仅 stage/elapsed 数据字段，无凭证）
    const result: McpTestResult = await runTest(testId, config, (stage, elapsedMs) => {
      e.sender.send('mcp:testProgress', { testId, stage, elapsedMs })
    })

    // 已存配置测试结果落库（D-09 最近测试持久化；取消不落库）
    if (configId != null) {
      if (result.ok) McpService.recordTestResult(configId, 'success', result.tools.length)
      else if (result.error.code !== 'MCP_CANCELLED') McpService.recordTestResult(configId, 'failed', null)
    }
    return result
  }))

  // 取消进行中的连接测试（按 testId abort → destroy + 树杀，21-03 cancelTest 既有路径）
  ipcMain.handle('mcp:cancelTest', secure((_e, testId: string) => {
    if (typeof testId !== 'string' || !testId) throw new Error('参数无效：testId')
    return { ok: cancelTest(testId) }
  }))
}
