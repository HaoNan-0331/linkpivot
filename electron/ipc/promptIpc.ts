/**
 * 提示词 override IPC 通道（Phase 20 20-03，PMT-02/PMT-03/PMT-04）。
 *
 * 红线：4 个 channel 全部经 secure 包装（鉴权 + 异常脱敏），登录前不可达（T-20-06）。
 * channel 命名 <domain>:<action>。
 *
 * prompt:save 网关兜底（D-05 第二层，T-20-07/T-20-08）：
 * string/非空/长度上限校验 + validateRequiredVars 占位符校验（service 层已有第三层），
 * 拒绝时 { ok:false, error } 原样返回不 throw（validateDrafts 风格，error 文案含缺失变量名）。
 */

import { ipcMain } from 'electron'
import { PromptService, validateRequiredVars } from '../services/promptService'
import { getRegistryEntry } from '../services/promptRegistry'
import { secure } from '../utils/authGuard'

/** 单条 prompt 内容长度硬上限（T-20-08 DoS 网关截断拒绝） */
const MAX_PROMPT_LENGTH = 100000

export function registerPromptIpc() {
  // registry 全量 + override/conflict/safetyCritical/requiredVars 元数据（UI 列表数据源）
  ipcMain.handle('prompt:list', secure(() => PromptService.listEntries()))

  ipcMain.handle('prompt:save', secure((_e, id: string, content: string) => {
    if (typeof id !== 'string' || !id) throw new Error('参数无效：id')
    if (typeof content !== 'string' || content.trim() === '') throw new Error('参数无效：content 不能为空')
    if (content.length > MAX_PROMPT_LENGTH) throw new Error(`内容超过长度上限 ${MAX_PROMPT_LENGTH} 字符`)
    // 网关层占位符校验（D-05 兜底，未知 id 直接拒绝，不触达 service/DB）
    const entry = getRegistryEntry(id)
    if (!entry) return { ok: false, error: `未知的提示词 id：${id}` }
    const varsCheck = validateRequiredVars(content, entry.requiredVars)
    if (!varsCheck.ok) return varsCheck
    // service 内部再次校验（registry 占位）后落库；{ok:false} 不以异常形式抛给 renderer
    return PromptService.saveOverride(id, content)
  }))

  // 恢复默认（删除 override 行，service 幂等）
  ipcMain.handle('prompt:reset', secure((_e, id: string) => {
    if (typeof id !== 'string' || !id) throw new Error('参数无效：id')
    PromptService.resetOverride(id)
    return { ok: true }
  }))

  // 三选弹窗数据源（保留我的 / 采用新默认 / 手动合并）
  ipcMain.handle('prompt:diff', secure((_e, id: string) => {
    if (typeof id !== 'string' || !id) throw new Error('参数无效：id')
    return PromptService.getDiffBase(id)
  }))
}
