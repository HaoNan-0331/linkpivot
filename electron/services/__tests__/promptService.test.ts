import { describe, it, expect, beforeEach } from 'vitest'
import {
  PromptService,
  validateRequiredVars,
  _setPromptDbGetter,
} from '../promptService'
import { PROMPT_REGISTRY, getRegistryEntry } from '../promptRegistry'

/**
 * promptService 单测（Phase 20 20-01 Task 3）。
 *
 * DEP-1 约束：better-sqlite3 native binding 经 @electron/rebuild 按 Electron ABI 重建，
 * plain Node（vitest 运行时）无法加载——service 经 _setPromptDbGetter 注入口注入内存
 * mock DB（experienceService.test 同款范式），复刻 service 实际使用的语句子集：
 * SELECT all / SELECT by id / INSERT..ON CONFLICT upsert / DELETE。
 */

// ---------- 内存 mock DB ----------
function makeMockDb() {
  const rows = new Map<string, { prompt_id: string; content: string; based_on_version: number }>()
  const db: any = {
    prepare(sql: string) {
      if (sql.includes('INSERT INTO prompt_overrides')) {
        return {
          run: (...args: any[]) => {
            rows.set(String(args[0]), {
              prompt_id: String(args[0]),
              content: String(args[1]),
              based_on_version: Number(args[2]),
            })
            return { changes: 1 }
          },
        }
      }
      if (sql.includes('DELETE FROM prompt_overrides')) {
        return {
          run: (...args: any[]) => ({ changes: rows.delete(String(args[0])) ? 1 : 0 }),
        }
      }
      if (sql.includes('FROM prompt_overrides')) {
        const byId = sql.includes('WHERE')
        return {
          all: () => Array.from(rows.values()),
          get: (id: string) => rows.get(String(id)),
        }
      }
      throw new Error('mock DB 未覆盖的语句: ' + sql)
    },
  }
  return { db, rows }
}

describe('PromptService', () => {
  let mock: ReturnType<typeof makeMockDb>

  beforeEach(() => {
    mock = makeMockDb()
    _setPromptDbGetter(() => mock.db)
    // 每个用例重置模块级缓存（ preload 状态不跨用例泄漏）
    PromptService.resetCacheForTest()
  })

  it('1. getPrompt 无 override 时返回 registry 默认（v1）', () => {
    const content = PromptService.getPrompt('ai.chat.systemPrompt')
    expect(content).toBe(getRegistryEntry('ai.chat.systemPrompt')!.content)
    expect(content).toContain('{{deviceInfo}}')
  })

  it('2. getPrompt 未知 id 抛中文 Error', () => {
    expect(() => PromptService.getPrompt('no.such.prompt')).toThrow('未知')
  })

  it('3. save 后 getPrompt 返回 override；其余条目不受影响；DB 只存改动行', () => {
    const entry = getRegistryEntry('kb.pick')!
    const modified = entry.content.replace('你是一个文档检索助手', '你是文档检索专家')
    const result = PromptService.saveOverride('kb.pick', modified)
    expect(result).toEqual({ ok: true })
    expect(PromptService.getPrompt('kb.pick')).toBe(modified)
    // 其余条目不受影响
    expect(PromptService.getPrompt('rerank.experience')).toBe(getRegistryEntry('rerank.experience')!.content)
    // override-only 落库：DB 只有改动行
    expect(mock.rows.size).toBe(1)
    expect(mock.rows.get('kb.pick')!.based_on_version).toBe(entry.version)
  })

  it('4. save 二次覆盖走 upsert（同 id 单行，content 更新）', () => {
    PromptService.saveOverride('kb.pick', 'A'.repeat(10) + '{{query}}{{indexBlock}}{{topK}}')
    PromptService.saveOverride('kb.pick', 'B'.repeat(10) + '{{query}}{{indexBlock}}{{topK}}')
    expect(mock.rows.size).toBe(1)
    expect(PromptService.getPrompt('kb.pick')).toBe('B'.repeat(10) + '{{query}}{{indexBlock}}{{topK}}')
  })

  it('5. save 缺 requiredVars 占位符返回 { ok:false } 且不落库', () => {
    const result = PromptService.saveOverride('kb.pick', '缺少全部占位符的文案')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('{{query}}')
    expect(mock.rows.size).toBe(0)
    // 缺部分占位符同样拒绝
    const partial = PromptService.saveOverride('kb.pick', '只有 {{query}}')
    expect(partial.ok).toBe(false)
    expect(mock.rows.size).toBe(0)
  })

  it('6. save 未知 id 返回 { ok:false } 且不落库', () => {
    const result = PromptService.saveOverride('no.such.prompt', 'whatever')
    expect(result.ok).toBe(false)
    expect(mock.rows.size).toBe(0)
  })

  it('7. reset 后 getPrompt 恢复默认，与未改过完全一致；reset 幂等', () => {
    const original = PromptService.getPrompt('rerank.experience')
    PromptService.saveOverride('rerank.experience', '改过的文案（无必需变量）')
    expect(PromptService.getPrompt('rerank.experience')).not.toBe(original)
    PromptService.resetOverride('rerank.experience')
    expect(PromptService.getPrompt('rerank.experience')).toBe(original)
    expect(mock.rows.size).toBe(0)
    // 幂等：reset 不存在的 override 不 throw
    expect(() => PromptService.resetOverride('rerank.experience')).not.toThrow()
  })

  it('8. preload 预热缓存：save/reset 后增量同步（getPrompt 全程一致，无脏读窗口）', () => {
    // DB 预置一行 override（模拟另一路径写入）
    mock.rows.set('kb.pick', { prompt_id: 'kb.pick', content: '预热内容 {{query}}{{indexBlock}}{{topK}}', based_on_version: 1 })
    PromptService.preload()
    expect(PromptService.getPrompt('kb.pick')).toBe('预热内容 {{query}}{{indexBlock}}{{topK}}')
    // 写后增量同步缓存
    PromptService.saveOverride('kb.pick', '新内容 {{query}}{{indexBlock}}{{topK}}')
    expect(PromptService.getPrompt('kb.pick')).toBe('新内容 {{query}}{{indexBlock}}{{topK}}')
    PromptService.resetOverride('kb.pick')
    expect(PromptService.getPrompt('kb.pick')).toBe(getRegistryEntry('kb.pick')!.content)
  })

  it('9. listEntries：registry 全量 + override 视图 + conflict 判定（D-01/D-07）', () => {
    PromptService.saveOverride('kb.pick', '我的版本 {{query}}{{indexBlock}}{{topK}}')
    const entries = PromptService.listEntries()
    expect(entries).toHaveLength(PROMPT_REGISTRY.length)
    const kbPick = entries.find((e) => e.id === 'kb.pick')!
    expect(kbPick.overrideContent).toBe('我的版本 {{query}}{{indexBlock}}{{topK}}')
    expect(kbPick.basedOnVersion).toBe(1)
    expect(kbPick.conflict).toBe(false)
    const untouched = entries.find((e) => e.id === 'ai.chat.systemPrompt')!
    expect(untouched.overrideContent).toBeNull()
    expect(untouched.basedOnVersion).toBeNull()
    expect(untouched.safetyCritical).toBe(true)

    // registry 升版 v2 + override based_on_version=1 → conflict=true
    const entry = getRegistryEntry('kb.pick')!
    const savedVersion = entry.version
    entry.version = 2
    try {
      const conflicted = PromptService.listEntries().find((e) => e.id === 'kb.pick')!
      expect(conflicted.conflict).toBe(true)
    } finally {
      entry.version = savedVersion
    }
  })

  it('10. getDiffBase 返回三选弹窗所需的四元组', () => {
    PromptService.saveOverride('kb.pick', 'diff 版本 {{query}}{{indexBlock}}{{topK}}')
    const base = PromptService.getDiffBase('kb.pick')
    expect(base.currentVersion).toBe(getRegistryEntry('kb.pick')!.version)
    expect(base.defaultContent).toBe(getRegistryEntry('kb.pick')!.content)
    expect(base.overrideContent).toBe('diff 版本 {{query}}{{indexBlock}}{{topK}}')
    expect(base.basedOnVersion).toBe(1)
    // 无 override 时 overrideContent/basedOnVersion 为 null
    const bare = PromptService.getDiffBase('rerank.experience')
    expect(bare.overrideContent).toBeNull()
    expect(bare.basedOnVersion).toBeNull()
  })
})

describe('validateRequiredVars', () => {
  it('全部占位符命中 → ok；缺失 → error 指明首个缺失变量', () => {
    expect(validateRequiredVars('a {{x}} b {{y}}', ['x', 'y'])).toEqual({ ok: true })
    const miss = validateRequiredVars('a {{x}} b', ['x', 'y'])
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.error).toContain('{{y}}')
    // 空变量表恒 ok
    expect(validateRequiredVars('任意文案', [])).toEqual({ ok: true })
  })
})
