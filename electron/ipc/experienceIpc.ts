import { ipcMain } from 'electron'
import {
  createExperience,
  getExperience,
  listExperiences,
  updateExperience,
  invalidateExperience,
  deleteExperience,
  relateDevice,
  unrelateDevice,
  listDevicesByExperience,
  listExperiencesByDevice,
} from '../services/experienceService'
import type { ExperienceInput, ExperienceUpdateInput, ExperienceListInput } from '../../src/types/experience'
import { secure } from '../utils/authGuard'

/**
 * ExperienceService IPC 网关层（Phase 7 Plan 02）。
 *
 * 安全红线（SEC-01/SEC-02）：
 * - 全部 10 个 experience:* channel 经 secure 鉴权 + 异常脱敏包装。经验数据属登录后特权操作
 *   （涉敏感 attrs/凭证片段），无登录前 safe channel。
 * - experience:listDevices 返 devices 原始行含 name_enc 等密文列，IPC handler 返回前经 stripEncColumns
 *   删除所有 `_enc` 后缀 key（SEC-02 边界脱敏），renderer 永不收设备密文。
 * - 其余 channel（list/get/create/update/invalidate）返回值不经 IPC 二次处理——service 层 getExperience/
 *   listExperiences 已 decField 回填 attrs 并 delete attrs_enc，密文/凭证不外泄。
 *
 * channel 命名遵循全仓 camelCase 事实约定（CONVENTIONS line 35）：
 * 复合词 action 用 camelCase（relateDevice/unrelateDevice/listByDevice/listDevices），
 * 单词 action 不变（list/get/create/update/delete/invalidate），与既有 channel
 * （kb:listDocuments / anomaly:acknowledgeAll / oui:addBatch / network:getIPDetails）一致。
 *
 * 函数式 service 调用面：service 已函数式（无 class），IPC 按需 import 具名函数（createExperience 等），
 * 不 import ExperienceService class、不 import MAX_BATCH（IPC 透传 opts.limit 不二次校验，service 层
 * listExperiences 内 MAX_BATCH=1000 throw 已强制，避免双层校验逻辑漂移与 noUnusedLocals 触发）。
 */

// IPC 边界剥离设备密文列：listDevicesByExperience 返 devices 原始行含 name_enc 等 `_enc` 后缀列，
// renderer 不可见密文。在 IPC handler 返回前 map 删除所有以 `_enc` 结尾的 key（SEC-02）。
function stripEncColumns(rows: any[]): any[] {
  return rows.map((row) => {
    const safe: Record<string, unknown> = {}
    for (const key of Object.keys(row)) {
      if (!key.endsWith('_enc')) safe[key] = (row as Record<string, unknown>)[key]
    }
    return safe
  })
}

export function registerExperienceIpc() {
  // 经验属特权操作（涉敏感 attrs/凭证片段），全 secure 包装（鉴权 + 异常脱敏）
  ipcMain.handle('experience:list', secure((_e, opts?: ExperienceListInput) =>
    listExperiences(opts || {})))

  ipcMain.handle('experience:get', secure((_e, id: string) =>
    getExperience(id)))

  ipcMain.handle('experience:create', secure((_e, input: ExperienceInput) =>
    createExperience(input)))

  ipcMain.handle('experience:update', secure((_e, id: string, fields: ExperienceUpdateInput) =>
    updateExperience(id, fields)))

  ipcMain.handle('experience:delete', secure((_e, id: string) =>
    deleteExperience(id)))

  ipcMain.handle('experience:invalidate', secure((_e, id: string) =>
    invalidateExperience(id)))

  ipcMain.handle('experience:relateDevice', secure((_e, experienceId: string, deviceId: string, relationType?: string) =>
    relateDevice(experienceId, deviceId, relationType)))

  ipcMain.handle('experience:unrelateDevice', secure((_e, experienceId: string, deviceId: string) =>
    unrelateDevice(experienceId, deviceId)))

  ipcMain.handle('experience:listByDevice', secure((_e, deviceId: string, includeInvalid?: boolean) =>
    listExperiencesByDevice(deviceId, includeInvalid)))

  ipcMain.handle('experience:listDevices', secure((_e, experienceId: string) =>
    stripEncColumns(listDevicesByExperience(experienceId))))
}
