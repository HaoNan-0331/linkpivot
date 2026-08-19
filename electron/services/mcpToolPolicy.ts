/**
 * McpToolPolicy —— Phase 22 MCP 工具级策略 service（22-01，MCS-01/MCS-02）。
 *
 * 职责：连接测试成功后的工具清单缓存持久化（mcp_tools 表）+ 工具级 enabled/skip_confirm
 * CRUD + 双条件只读判定（判定权单一来源在 main，renderer 只消费 skipConfirmEligible 契约字段）。
 *
 * 形态：静态类 facade（CONVENTIONS 红线，mcpService 同款），非加密数据无 MK，
 * 测试经 _setDbGetter 注入内存库。
 *
 * 双条件判定（MCS-02 从严，T-22-01）：
 *   server 声明 readOnlyHint=true **AND** 工具名匹配本地只读正则 → 才可 skip_confirm=1。
 *   两个条件缺一不可：不信任 server 单方声明（hint 可伪造），也不只凭名字（get_ 前缀可被恶意复用）。
 *
 * tool_meta 为 MCP server 不可信数据（T-22-03）：仅 JSON.stringify 存储，
 * 读出后 renderer 只做展示，不参与 SQL 拼接；后续展示/回注截断清洗由 22-03/22-05 处理。
 */

import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'

/** 工具清单批量写入上限（T-22-04 DoS 守卫，MAX_BATCH 哲学；超出截断） */
export const MAX_TOOLS_PER_CONFIG = 500

/**
 * 本地只读工具名正则（planner 定初始集）：
 * 以只读动词前缀开头（get/show/list/read/status/query/ping/health/describe）
 * 或名字中含 _get / _list 段（如 device_get_info）。
 */
export const READONLY_TOOL_NAME_RE =
  /^(get_|show_|list_|read_|status_|query_|ping_|health_|describe_)|_get_|_list_/

/** MCP server 返回的工具 annotations（SDK v2 结构，只关心 readOnlyHint） */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
}

/** 连接测试成功后清单缓存入参（mcpClient listTools 投影） */
export interface McpToolCacheInput {
  name: string
  description?: string
  annotations?: McpToolAnnotations
  inputSchema?: unknown
}

/** getToolCache 出口行（IPC 直传 renderer；skipConfirmEligible 由 mcpIpc 注入） */
export interface McpToolCacheRow {
  name: string
  description?: string
  annotations?: McpToolAnnotations
  inputSchema?: unknown
  enabled: 0 | 1
  skipConfirm: 0 | 1
}

export class McpToolPolicy {
  // 默认走生产单例 db；测试经 _setDbGetter 注入内存 mock（mcpService 同款惯例）。
  private static dbGetter: () => Database.Database = getDatabase

  /** @internal 测试专用：注入 db getter（生产不调用）。 */
  static _setDbGetter(fn: () => Database.Database): void {
    McpToolPolicy.dbGetter = fn
  }

  private static db(): Database.Database {
    return McpToolPolicy.dbGetter()
  }

  /**
   * 双条件只读判定（MCS-02）：readOnlyHint=true AND 名字匹配 READONLY_TOOL_NAME_RE。
   * 无 hint 一律 false（从严）。
   */
  static isReadOnlyEligible(tool: { name: string; annotations?: McpToolAnnotations }): boolean {
    if (!tool.annotations?.readOnlyHint) return false
    return READONLY_TOOL_NAME_RE.test(tool.name)
  }

  /**
   * 工具清单缓存落库（testConnection 成功分支调用）。策略保留语义：
   * 事务内先读回旧 (tool_name, enabled, skip_confirm) → DELETE 该 config_id 旧行 →
   * 批量 INSERT 新清单并回填旧策略值（旧行不存在的用默认 enabled=1/skip_confirm=0）。
   * 已消失工具随 DELETE 自然清除。工具数 >MAX_TOOLS_PER_CONFIG 截断（T-22-04）。
   */
  static saveToolCache(configId: number, tools: McpToolCacheInput[]): void {
    const conn = McpToolPolicy.db()
    const capped = tools.slice(0, MAX_TOOLS_PER_CONFIG)
    const tx = conn.transaction((): void => {
      const oldRows = conn.prepare(
        'SELECT tool_name, enabled, skip_confirm FROM mcp_tools WHERE config_id = ?'
      ).all(configId) as Array<{ tool_name: string; enabled: number; skip_confirm: number }>
      const oldMap = new Map(oldRows.map((r) => [r.tool_name, r]))

      conn.prepare('DELETE FROM mcp_tools WHERE config_id = ?').run(configId)

      const stmtIns = conn.prepare(
        `INSERT INTO mcp_tools (config_id, tool_name, enabled, skip_confirm, tool_meta, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`
      )
      for (const t of capped) {
        const old = oldMap.get(t.name)
        stmtIns.run(
          configId,
          t.name,
          old?.enabled ?? 1,
          old?.skip_confirm ?? 0,
          JSON.stringify({
            description: t.description ?? null,
            annotations: t.annotations ?? null,
            inputSchema: t.inputSchema ?? null,
          })
        )
      }
    })
    tx()
  }

  /** 全量清单（含禁用行——UI 抽屉展示需要；enabled 过滤用 getEnabledTools） */
  static getToolCache(configId: number): McpToolCacheRow[] {
    const conn = McpToolPolicy.db()
    const rows = conn.prepare(
      'SELECT tool_name, tool_meta, enabled, skip_confirm FROM mcp_tools WHERE config_id = ? ORDER BY tool_name'
    ).all(configId) as Array<{ tool_name: string; tool_meta: string | null; enabled: number; skip_confirm: number }>
    return rows.map((r) => {
      let meta: { description?: string | null; annotations?: McpToolAnnotations | null; inputSchema?: unknown } = {}
      try {
        meta = r.tool_meta ? JSON.parse(r.tool_meta) : {}
      } catch {
        // 坏 JSON 降级空 meta（展示层自然得到 undefined 字段）
      }
      return {
        name: r.tool_name,
        description: meta.description ?? undefined,
        annotations: meta.annotations ?? undefined,
        inputSchema: meta.inputSchema ?? undefined,
        enabled: r.enabled ? 1 : 0,
        skipConfirm: r.skip_confirm ? 1 : 0,
      }
    })
  }

  /** 工具级启用开关（22-03 注入过滤数据源） */
  static setEnabled(configId: number, toolName: string, enabled: boolean): void {
    McpToolPolicy.db().prepare(
      "UPDATE mcp_tools SET enabled = ?, updated_at = datetime('now','localtime') WHERE config_id = ? AND tool_name = ?"
    ).run(enabled ? 1 : 0, configId, toolName)
  }

  /**
   * 免确认开关（T-22-01 提权防线）：写 1 前调 isReadOnlyEligible 守卫，
   * 不满足双条件返回 false 拒绝写入；关 0（撤回免确认）不受限。
   */
  static setSkipConfirm(configId: number, toolName: string, skip: boolean): boolean {
    const conn = McpToolPolicy.db()
    if (skip) {
      const row = conn.prepare(
        'SELECT tool_meta FROM mcp_tools WHERE config_id = ? AND tool_name = ?'
      ).get(configId, toolName) as { tool_meta: string | null } | undefined
      if (!row) return false
      let annotations: McpToolAnnotations | undefined
      try {
        annotations = row.tool_meta ? (JSON.parse(row.tool_meta)?.annotations ?? undefined) : undefined
      } catch {
        annotations = undefined
      }
      if (!McpToolPolicy.isReadOnlyEligible({ name: toolName, annotations })) return false
    }
    const info = conn.prepare(
      "UPDATE mcp_tools SET skip_confirm = ?, updated_at = datetime('now','localtime') WHERE config_id = ? AND tool_name = ?"
    ).run(skip ? 1 : 0, configId, toolName)
    return info.changes > 0
  }

  /** 只返回 enabled=1 行（22-03 AI 注入过滤数据源） */
  static getEnabledTools(configId: number): McpToolCacheRow[] {
    return McpToolPolicy.getToolCache(configId).filter((t) => t.enabled === 1)
  }

  /** 已开免确认的工具名集合（22-03 exec 决策数据源） */
  static getSkipConfirmTools(configId: number): Set<string> {
    const rows = McpToolPolicy.db().prepare(
      'SELECT tool_name FROM mcp_tools WHERE config_id = ? AND skip_confirm = 1'
    ).all(configId) as Array<{ tool_name: string }>
    return new Set(rows.map((r) => r.tool_name))
  }

  // ---------- Phase 22（22-03）三档确认分类（纯静态方法，MCS-02/D-04） ----------

  /**
   * 单工具三档分类（纯函数，无 DB）：
   * - confirm 档总闸：任何工具（含已勾免确认）一律 'confirm'（MCS-02 优先级语义）；
   * - auto 档：全部 'execute'；
   * - smart 档：skipConfirmSet.has(name) **AND** isReadOnlyEligible(row) 双查——
   *   库内 skip_confirm 值可能被外改（防御纵深），实时以 annotations 重判（不信任库值）。
   */
  static classifyTool(
    execMode: 'confirm' | 'smart' | 'auto',
    toolName: string,
    skipConfirmSet: Set<string>,
    cacheRow: { name: string; annotations?: McpToolAnnotations }
  ): 'confirm' | 'execute' {
    if (execMode === 'confirm') return 'confirm'
    if (execMode === 'auto') return 'execute'
    // smart：双条件缺一不可
    if (!skipConfirmSet.has(toolName)) return 'confirm'
    return McpToolPolicy.isReadOnlyEligible(cacheRow) ? 'execute' : 'confirm'
  }

  /**
   * 批次分类（D-04）：批次内全部 classify='execute' → 'execute_all'（smart 整批直执）；
   * 任一 'confirm' 或空批次 → 'confirm_each'（从严）。
   */
  static classifyBatch(
    execMode: 'confirm' | 'smart' | 'auto',
    tools: Array<{ name: string; annotations?: McpToolAnnotations }>,
    skipConfirmSet: Set<string>
  ): 'execute_all' | 'confirm_each' {
    if (tools.length === 0) return 'confirm_each'
    for (const t of tools) {
      if (McpToolPolicy.classifyTool(execMode, t.name, skipConfirmSet, t) === 'confirm') {
        return 'confirm_each'
      }
    }
    return 'execute_all'
  }
}
