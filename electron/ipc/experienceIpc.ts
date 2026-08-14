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
  // Phase 9 人工确认（review）—— service 层具名函数（confirmDrafts/listDrafts/getSessionMessages）
  confirmDrafts,
  listDrafts,
  getSessionMessages,
  // Phase 10 浏览页：撤销恢复（受控接口，与 invalidateExperience 对称）
  restoreExperience,
  // Phase 10 Plan 04 WR-02：单事务原子设置关联设备（替代 renderer Promise.all N IPC）
  setExperienceDevices,
  MAX_BATCH,
  // SEC-05（Phase 13 Plan 03）：severity 合法枚举单一来源 import（D-13-5 + PATTERNS 范式，
  // 非第二份手写避 drift）。sanitizeListInput 复用此常量做 severity throw 校验。
  VALID_SEVERITIES,
} from '../services/experienceService'
import type { ExperienceInput, ExperienceUpdateInput, ExperienceListInput, ConfirmDraftsInput } from '../../src/types/experience'
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
 * 函数式 service 调用面：service 已函数式（无 class），IPC 按需 import 具名函数（createExperience 等）。
 * MAX_BATCH 由 service 层导出，IPC 层 confirmDrafts 二次校验 drafts.length 上限（与 service 层兜底
 * 形成双层防御 T-09-06 mitigate，防 untrusted renderer 越权大批量）；其余 list/get/update 透传 opts.limit，
 * service 层 listExperiences 内 MAX_BATCH=1000 throw 已强制。getSessionMessages（WR-09）limit 默认 200
 * 守 MAX_BATCH，与 confirmDrafts 同一红线。
 */

// WR-05 深度防御：listDevicesByExperience 改走 deviceService.getDeviceById（rowToDevice
// 安全白名单映射），返回的 Device DTO 已无 `_enc` 密文列。此 stripEncColumns 兜底剥离保留，
// 防御未来 device 域 rowToDevice 误返密文残留——主防线已是 service 层白名单正向投影。
function stripEncColumns(rows: any[]): any[] {
  return rows.map((row) => {
    const safe: Record<string, unknown> = {}
    for (const key of Object.keys(row)) {
      if (!key.endsWith('_enc')) safe[key] = (row as Record<string, unknown>)[key]
    }
    return safe
  })
}

/**
 * SEC-05（Phase 13 Plan 03）：experience:list IPC 网关层入参校验纯函数。
 *
 * 防 untrusted renderer 廉价 DoS（体检 WR-06）：listExperiences 的 search LIKE 多词拆分
 * OR-join（experienceService.ts:284-299）/ tags LIKE OR-join（experienceService.ts:311-318）
 * 会因超长 search（如粘整段故障描述）或超量 tags 生成海量 LIKE 子句触发全表扫。
 *
 * 处置策略（D-13-5 混合 + D-13-6 阈值 100/20/30）：
 * - search/tags 钳制（静默容错，用户输入场景，参照 validateLimit 落回默认/截断风格非 throw）：
 *   search 截断到 ≤100 字符；tags 截取到前 20 个；单 tag 截断到 ≤30 字符。
 * - severity 枚举 throw（固定集合非法值暴露调用方 bug，参照 confirmDrafts throw 风格）：
 *   非空非 undefined 且非 VALID_SEVERITIES 集合内值 → throw 'severity 非法'。
 *
 * 设计为纯函数（不调 listExperiences）以最高 ROI 可测——单测直接调 sanitizeListInput 验
 * 截断/throw，无需 setAuthenticated/secure 包装/ipcMain mock（D-13-8 测试范式）。
 *
 * 红线①：throw 路径在 secure(...) 包装内经 sanitizeMessage 脱敏透出 renderer，无需额外 try/catch。
 * D-13-7：limit 不在此复查（service 层 listExperiences limit MAX_BATCH throw 兜底，双层第二层）。
 */
export function sanitizeListInput(opts: ExperienceListInput | undefined): ExperienceListInput {
  const sanitized: ExperienceListInput = { ...(opts || {}) }
  // search 钳制（D-13-6 ≤100 字符）：超长搜索串截断，阻断超长 LIKE 多词 OR-join 全表扫 DoS 面。
  if (typeof sanitized.search === 'string' && sanitized.search.length > 100) {
    sanitized.search = sanitized.search.slice(0, 100)
  }
  // tags 钳制（D-13-6 ≤20 个 + 单 tag ≤30 字符）：超量 tags 截取前 20 + 每个超长 tag 截断。
  // W-1 fix（v1.2 audit）：filter 只留 string tag——原 map 守卫让非 string 元素（如 123/null）原样透传，
  // 下游 listExperiences t.replace throw（虽经 sanitizeMessage 脱敏，但崩溃面下沉 service 层）。
  // IPC 层是 untrusted renderer→main 边界，在此洗净类型，service 层不再假设 tags 全 string。
  if (Array.isArray(sanitized.tags)) {
    const stringTags = sanitized.tags.filter((tag): tag is string => typeof tag === 'string')
    const capped = stringTags.length > 20 ? stringTags.slice(0, 20) : stringTags
    sanitized.tags = capped.map((tag) => (tag.length > 30 ? tag.slice(0, 30) : tag))
  }
  // severity throw（D-13-5 固定集合非法值暴露 bug）：非空非 undefined 且非合法枚举 → throw。
  // 复用 service 层 export 的 VALID_SEVERITIES 单一来源（D-13-6 + PATTERNS 范式），非第二份手写。
  if (
    sanitized.severity !== undefined &&
    sanitized.severity !== '' &&
    !(VALID_SEVERITIES as readonly string[]).includes(sanitized.severity)
  ) {
    throw new Error('severity 非法，合法值: critical/high/medium/low/info')
  }
  return sanitized
}

export function registerExperienceIpc() {
  // 经验属特权操作（涉敏感 attrs/凭证片段），全 secure 包装（鉴权 + 异常脱敏）
  // SEC-05：入参经 sanitizeListInput 钳制 search/tags + throw 非法 severity（D-13-5/D-13-6/D-13-7），
  // 防 untrusted renderer 廉价 DoS（体检 WR-06）。handler 仍包在 secure(...) 内（红线①不变），
  // throw 经 sanitizeMessage 脱敏透出 renderer。
  ipcMain.handle('experience:list', secure((_e, opts?: ExperienceListInput) =>
    listExperiences(sanitizeListInput(opts))))

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

  // Phase 10 D-10-3：撤销恢复（清 invalid_at + status 回 published），与 invalidate 对称的受控接口。
  // 全 secure 包装（鉴权 + 异常脱敏），延续 experience:* 全 secure 基线（T-10-02 mitigate）。
  ipcMain.handle('experience:restore', secure((_e, id: string) =>
    restoreExperience(id)))

  ipcMain.handle('experience:relateDevice', secure((_e, experienceId: string, deviceId: string, relationType?: string) =>
    relateDevice(experienceId, deviceId, relationType)))

  ipcMain.handle('experience:unrelateDevice', secure((_e, experienceId: string, deviceId: string) =>
    unrelateDevice(experienceId, deviceId)))

  // Phase 10 Plan 04 WR-02：单事务原子设置关联设备（service 层 diff，throw ROLLBACK 无半成品）。
  // 全 secure 包装（鉴权 + 异常脱敏），延续 experience:* 全 secure 基线。
  ipcMain.handle('experience:setDevices', secure((_e, experienceId: string, deviceIds: string[]) =>
    setExperienceDevices(experienceId, deviceIds)))

  ipcMain.handle('experience:listByDevice', secure((_e, deviceId: string, includeInvalid?: boolean) =>
    listExperiencesByDevice(deviceId, includeInvalid)))

  ipcMain.handle('experience:listDevices', secure((_e, experienceId: string) =>
    stripEncColumns(listDevicesByExperience(experienceId))))

  // Phase 9：人工确认（review）—— 全 secure 包装（鉴权 + 异常脱敏），延续 experience:* 基线。
  // confirmDrafts：IPC 层校验入参 drafts 数组 + MAX_BATCH 上限，与 service 层兜底校验（experienceService
  // 内 drafts.length > MAX_BATCH throw）形成双层防御（T-09-06 mitigate），避免 untrusted renderer 越权大批量调用。
  ipcMain.handle('experience:confirmDrafts', secure((_e, input: ConfirmDraftsInput) => {
    if (!input || !Array.isArray(input.drafts) || input.drafts.length > MAX_BATCH) {
      throw new Error(`批量上限 ${MAX_BATCH} 条（或入参无效）`)
    }
    return confirmDrafts(input)
  }))

  // listDrafts：返 draft 态 Experience 列表（service 层 listExperiences status='draft' 内 MAX_BATCH 截断）。
  ipcMain.handle('experience:listDrafts', secure(() => listDrafts()))

  // getSessionMessages：单 sessionId 查询，limit 守 MAX_BATCH（WR-09，与 service 层兜底双层防御）。
  // sessionId 形态校验防注入；limit 默认 200 取最近 N 条防超大历史会话无界返回。
  ipcMain.handle('experience:getSessionMessages', secure((_e, sessionId: string, limit?: number) => {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('sessionId 无效')
    }
    return getSessionMessages(sessionId, limit ?? 200)
  }))
}
