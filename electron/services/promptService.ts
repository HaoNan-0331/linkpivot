/**
 * 提示词 override 管理 service（Phase 20 20-01 Task 3，PMT-02/PMT-04）。
 *
 * 形态：静态类 facade（CONVENTIONS 1b，ouiService 为模板）——全方法 static、模块级
 * private static 缓存、循环外 prepare、throw 中文 Error（未知 id，T-20-02）。
 *
 * 读取语义（PMT-01 零回归核心不变量）：getPrompt(id) = override ?? registry 默认。
 * override-only 落库：prompt_overrides 表只存用户改动行，未改条目零行开销。
 *
 * 缓存一致性（ouiService D-P1 同款）：preload() 启动预热 + save/reset 写后增量同步
 * （可选链，缓存未预载时 no-op）——零脏读窗口；preload 失败置 null 回退逐条查库。
 *
 * 冲突判定（D-01/D-07）：registry 默认文案升版后，override 行的 based_on_version
 * 落后于 registry.version 即 conflict=true，UI 走三选弹窗（getDiffBase 供数据）。
 *
 * 测试注入口：_setPromptDbGetter（DEP-1 better-sqlite3 ABI 规避，experienceService 同款）。
 */

import { getDatabase } from '../database/connection'
import { PROMPT_REGISTRY, getRegistryEntry } from './promptRegistry'

interface OverrideRow {
  prompt_id: string
  content: string
  based_on_version: number
}

export interface PromptEntryView {
  id: string
  group: string
  description: string
  version: number
  defaultContent: string
  overrideContent: string | null
  basedOnVersion: number | null
  /** override 基线落后于 registry 当前版本（D-01 冲突，UI 三选弹窗） */
  conflict: boolean
  safetyCritical: boolean
  requiredVars: string[]
  optionalVars: Array<{ name: string; desc: string }>
}

export interface PromptDiffBase {
  defaultContent: string
  overrideContent: string | null
  basedOnVersion: number | null
  currentVersion: number
}

// 测试注入口：默认走真实 getDatabase；单测注入内存 mock（DEP-1 ABI 规避）
type DbGetter = typeof getDatabase
let _getDb: DbGetter = getDatabase

/** @internal 仅供单测注入 mock DB，生产代码不得调用 */
export function _setPromptDbGetter(fn: DbGetter): void {
  _getDb = fn
}

/**
 * 网关兜底校验（D-05 第二层）：content 必须含每个 requiredVars 变量的 `{{var}}` 占位符。
 * 独立导出供 promptIpc 复用（UI 层另有即时提示，两层防御）。
 * 不-throw 返回风格（draftingService.validateDrafts 同款）。
 */
export function validateRequiredVars(
  content: string,
  requiredVars: string[]
): { ok: true } | { ok: false; error: string } {
  for (const v of requiredVars) {
    if (!content.includes(`{{${v}}}`)) {
      return { ok: false, error: `缺少必需变量 {{${v}}}` }
    }
  }
  return { ok: true }
}

export class PromptService {
  // 模块级缓存。null = 未预载（启动 preload() 全量载入；失败优雅降级回退查库）
  private static overrideCache: Map<string, { content: string; basedOnVersion: number }> | null = null

  /** @internal 仅供单测重置缓存状态，生产代码不得调用 */
  static resetCacheForTest(): void {
    PromptService.overrideCache = null
  }

  /**
   * 启动预热：全量载入 prompt_overrides 到内存 Map。
   * 失败 → Map 保持 null → getPrompt 回退逐条查库（ouiService D-P1 优雅降级同款）。
   */
  static preload(): void {
    try {
      const rows = _getDb()
        .prepare('SELECT prompt_id, content, based_on_version FROM prompt_overrides')
        .all() as OverrideRow[]
      const map = new Map<string, { content: string; basedOnVersion: number }>()
      for (const r of rows) {
        map.set(r.prompt_id, { content: r.content, basedOnVersion: r.based_on_version })
      }
      PromptService.overrideCache = map
    } catch (e: any) {
      PromptService.overrideCache = null
      console.error('[prompt] preload 失败，回退逐条查库:', e.message)
    }
  }

  /**
   * 读取 override 行：缓存优先，miss（缓存未预载）回退查库。
   * 20-02：查库异常（如调用方单测无 DB 环境）优雅降级返回 null → getPrompt 落 registry 默认，
   * 保证 prompt 读取链路永不因 override 表不可达而打断 AI 主流程（fail-safe 到默认文案）。
   */
  private static loadOverride(id: string): { content: string; basedOnVersion: number } | null {
    if (PromptService.overrideCache !== null) {
      return PromptService.overrideCache.get(id) ?? null
    }
    try {
      const row = _getDb()
        .prepare('SELECT prompt_id, content, based_on_version FROM prompt_overrides WHERE prompt_id = ?')
        .get(id) as OverrideRow | undefined
      return row ? { content: row.content, basedOnVersion: row.based_on_version } : null
    } catch (e: any) {
      console.warn('[prompt] override 查库失败，回落 registry 默认:', e.message)
      return null
    }
  }

  /**
   * 取生效 prompt：override ?? registry 默认（PMT-01 核心不变量）。
   * 未知 id throw 中文 Error（T-20-02，IPC 层 secure 脱敏返回）。
   */
  static getPrompt(id: string): string {
    const entry = getRegistryEntry(id)
    if (!entry) throw new Error(`未知的提示词 id：${id}`)
    return PromptService.loadOverride(id)?.content ?? entry.content
  }

  /**
   * 保存 override（upsert）。网关兜底：registry 条目存在 + requiredVars 占位符齐全（D-05）。
   * 不-throw 返回风格；通过则落库 + 增量同步缓存（零脏读窗口）。
   */
  static saveOverride(id: string, content: string): { ok: true } | { ok: false; error: string } {
    const entry = getRegistryEntry(id)
    if (!entry) return { ok: false, error: `未知的提示词 id：${id}` }
    const varsCheck = validateRequiredVars(content, entry.requiredVars)
    if (!varsCheck.ok) return varsCheck
    _getDb()
      .prepare(`INSERT INTO prompt_overrides(prompt_id, content, based_on_version) VALUES(?, ?, ?)
        ON CONFLICT(prompt_id) DO UPDATE SET content=excluded.content, based_on_version=excluded.based_on_version, updated_at=CURRENT_TIMESTAMP`)
      .run(id, content, entry.version)
    // 写库成功后增量同步缓存（可选链，未预载时 no-op）
    PromptService.overrideCache?.set(id, { content, basedOnVersion: entry.version })
    return { ok: true }
  }

  /** 删除 override 行（恢复默认）。幂等：行不存在时 no-op 不 throw。 */
  static resetOverride(id: string): void {
    _getDb().prepare('DELETE FROM prompt_overrides WHERE prompt_id = ?').run(id)
    PromptService.overrideCache?.delete(id)
  }

  /** registry 全量 + override 视图（UI 列表；D-07 冲突判定）。 */
  static listEntries(): PromptEntryView[] {
    const overrideRows = _getDb()
      .prepare('SELECT prompt_id, content, based_on_version FROM prompt_overrides')
      .all() as OverrideRow[]
    const byId = new Map(overrideRows.map((r) => [r.prompt_id, r]))
    return PROMPT_REGISTRY.map((entry) => {
      const ov = byId.get(entry.id)
      return {
        id: entry.id,
        group: entry.group,
        description: entry.description,
        version: entry.version,
        defaultContent: entry.content,
        overrideContent: ov?.content ?? null,
        basedOnVersion: ov?.based_on_version ?? null,
        conflict: ov != null && ov.based_on_version < entry.version,
        safetyCritical: entry.safetyCritical === true,
        requiredVars: entry.requiredVars,
        optionalVars: entry.optionalVars ?? [],
      }
    })
  }

  /** 三选弹窗数据（保留我的 / 采用新默认 / 手动合并）。未知 id throw 中文 Error。 */
  static getDiffBase(id: string): PromptDiffBase {
    const entry = getRegistryEntry(id)
    if (!entry) throw new Error(`未知的提示词 id：${id}`)
    const ov = PromptService.loadOverride(id)
    return {
      defaultContent: entry.content,
      overrideContent: ov?.content ?? null,
      basedOnVersion: ov?.basedOnVersion ?? null,
      currentVersion: entry.version,
    }
  }
}
