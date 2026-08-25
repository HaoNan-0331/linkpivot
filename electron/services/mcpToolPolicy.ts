/**
 * McpToolPolicy —— Phase 22 MCP 工具级策略 service（22-01，MCS-01/MCS-02）。
 *
 * 职责：连接测试成功后的工具清单缓存持久化（mcp_tools 表）+ 工具级 enabled/skip_confirm
 * CRUD + 单条件只读判定（判定权单一来源在 main，renderer 只消费 skipConfirmEligible 契约字段）。
 *
 * 形态：静态类 facade（CONVENTIONS 红线，mcpService 同款），非加密数据无 MK，
 * 测试经 _setDbGetter 注入内存库。
 *
 * 单条件判定（22-04 用户裁决，推翻 22-01 双条件设计）：
 *   server 声明 readOnlyHint=true 即可 skip_confirm=1（信任 server 自称）。
 *   原双条件（hint AND 名字正则）下通用 MCP server（如 playwright 全系 browser_*）名字
 *   永不命中网络设备风格正则，真只读工具全部置灰，免确认功能形同虚设。
 *   名字正则保留但降级为展示层「已验证只读」加强标记（isVerifiedReadOnlyName）。
 *
 * tool_meta 为 MCP server 不可信数据（T-22-03）：仅 JSON.stringify 存储，
 * 读出后 renderer 只做展示，不参与 SQL 拼接；后续展示/回注截断清洗由 22-03/22-05 处理。
 */

import type Database from 'better-sqlite3'
import { getDatabase } from '../database/connection'

/** 工具清单批量写入上限（T-22-04 DoS 守卫，MAX_BATCH 哲学；超出截断） */
export const MAX_TOOLS_PER_CONFIG = 500

/**
 * WR-07 fix（Phase 22 code-review）：单条 tool_meta JSON 序列化尺寸上限（64_000 字符）。
 * MCP server 为不可信来源——单条巨型 description/inputSchema 会明文膨胀 DB、撑爆
 * mcp:getToolCache IPC 传输与成功面板渲染。超限降级：先丢展示字段（description/
 * inputSchema），仍超限则 annotations 只保留 readOnlyHint（skip_confirm 判定依赖，
 * 不可随展示字段一并丢弃）。
 */
export const MAX_TOOL_META_CHARS = 64_000

/** tool_meta 序列化（带 WR-07 两级降级；annotations 的 readOnlyHint 永不因超限丢失） */
function serializeToolMeta(t: McpToolCacheInput): string {
  const meta = { description: t.description ?? null, annotations: t.annotations ?? null, inputSchema: t.inputSchema ?? null }
  let s = JSON.stringify(meta)
  if (s.length <= MAX_TOOL_META_CHARS) return s
  s = JSON.stringify({ description: null, annotations: meta.annotations, inputSchema: null })
  if (s.length <= MAX_TOOL_META_CHARS) return s
  return JSON.stringify({ description: null, annotations: { readOnlyHint: t.annotations?.readOnlyHint ?? null }, inputSchema: null })
}

/**
 * 本地只读工具名正则（planner 定初始集）：
 * 以只读动词前缀开头（get/show/list/read/status/query/ping/health/describe）
 * 或名字中含 _get / _list 段（如 device_get_info）。
 *
 * 22-04 裁决后不再参与可勾性判定，仅供展示层「已验证只读」加强标记
 * （见 isVerifiedReadOnlyName）。
 */
export const READONLY_TOOL_NAME_RE =
  /^(get_|show_|list_|read_|status_|query_|ping_|health_|describe_)|_get_|_list_/

/** 展示层加强标记：工具名是否命中本地只读正则（hint=true 且命中 → 「已验证只读」Tag） */
export function isVerifiedReadOnlyName(name: string): boolean {
  return READONLY_TOOL_NAME_RE.test(name)
}

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

  // -----------------------------------------------------------------
  // Phase 29.1（D-05）：策略归属键路由——mcp_tools 真包级存储
  // -----------------------------------------------------------------

  /**
   * 策略归属键（v29，D-05）：包轨（config.package_id 非空）→ mcp_tools.package_id 列
   * （config_id NULL）；手工轨（package_id NULL）→ config_id 老路径原样。
   * 表缺失/查询异常 fail-safe 回退 config 维度（旧库/测试最小 schema 不断；读路径降级
   * 空策略 = fail-closed 全禁用，方向安全）。
   * 列名来自固定字面量联合，不拼接外部输入（T-29.1-08：WHERE 恒带精确键值）。
   */
  private static resolvePolicyScope(configId: number): { keyCol: 'package_id' | 'config_id'; keyValue: number } {
    try {
      const row = McpToolPolicy.db().prepare(
        'SELECT package_id FROM mcp_configs WHERE id = ?'
      ).get(configId) as { package_id: number | null } | undefined
      if (row && row.package_id != null) return { keyCol: 'package_id', keyValue: row.package_id }
    } catch {
      // fail-safe：回退手工轨
    }
    return { keyCol: 'config_id', keyValue: configId }
  }

  /**
   * PKG-04/D-25 消费端二次过滤清单：包 last_test.extraTools（实测多出 = 默认禁用）。
   * 手工配置 / last_test 缺失 / 坏 JSON / extraTools 非数组 → 空 Set（fail-safe 不过滤）。
   */
  static getExtraToolNames(configId: number): Set<string> {
    try {
      const row = McpToolPolicy.db().prepare(
        'SELECT p.last_test AS lastTest FROM mcp_configs c JOIN mcp_packages p ON p.id = c.package_id WHERE c.id = ?'
      ).get(configId) as { lastTest: string | null } | undefined
      if (!row?.lastTest) return new Set()
      const parsed = JSON.parse(row.lastTest) as { extraTools?: unknown }
      return new Set(Array.isArray(parsed?.extraTools) ? parsed.extraTools.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  }

  /**
   * 单条件只读判定（22-04 用户裁决）：readOnlyHint === true 即可免确认（信任 server 自称）。
   * 无 hint / hint=false 一律 false。名字正则不再参与（降级为展示层标记）。
   */
  static isReadOnlyEligible(tool: { name: string; annotations?: McpToolAnnotations }): boolean {
    return tool.annotations?.readOnlyHint === true
  }

  /**
   * 工具清单缓存落库（testConnection 成功分支调用）。策略保留语义：
   * 事务内先读回旧 (tool_name, enabled, skip_confirm) → DELETE 归属键旧行 →
   * 批量 INSERT 新清单并回填旧策略值（旧行不存在的用默认 enabled=1/skip_confirm=0）。
   * 已消失工具随 DELETE 自然清除。工具数 >MAX_TOOLS_PER_CONFIG 截断（T-22-04）。
   * v29 D-05：归属键按 resolvePolicyScope 路由——包轨写 package_id（config_id NULL），
   * 手工轨原 config_id；行式 enabled/skip_confirm 结构不变。
   */
  static saveToolCache(configIdIn: number, tools: McpToolCacheInput[]): void {
    McpToolPolicy.writeToolCache(McpToolPolicy.resolvePolicyScope(configIdIn), tools)
  }

  /**
   * 包级直写入口（29.1-03，消除借存链路）：mcpPackageService 实测/创建预填直接按
   * package_id 落 mcp_tools——不再依赖「同包 MIN(id) 根配置」存在（v29 前借存形态终结）。
   */
  static savePackageToolCache(packageId: number, tools: McpToolCacheInput[]): void {
    McpToolPolicy.writeToolCache({ keyCol: 'package_id', keyValue: packageId }, tools)
  }

  /** saveToolCache / savePackageToolCache 共享事务体（读旧 → DELETE → 批量 INSERT 回填） */
  private static writeToolCache(scope: { keyCol: 'package_id' | 'config_id'; keyValue: number }, tools: McpToolCacheInput[]): void {
    const conn = McpToolPolicy.db()
    const capped = tools.slice(0, MAX_TOOLS_PER_CONFIG)
    const tx = conn.transaction((): void => {
      const oldRows = conn.prepare(
        `SELECT tool_name, enabled, skip_confirm FROM mcp_tools WHERE ${scope.keyCol} = ?`
      ).all(scope.keyValue) as Array<{ tool_name: string; enabled: number; skip_confirm: number }>
      const oldMap = new Map(oldRows.map((r) => [r.tool_name, r]))

      conn.prepare(`DELETE FROM mcp_tools WHERE ${scope.keyCol} = ?`).run(scope.keyValue)

      // 包轨行只写 package_id（config_id 落默认 NULL）；手工轨原 config_id 列
      const stmtIns = conn.prepare(
        `INSERT INTO mcp_tools (${scope.keyCol}, tool_name, enabled, skip_confirm, tool_meta, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`
      )
      for (const t of capped) {
        const old = oldMap.get(t.name)
        stmtIns.run(
          scope.keyValue,
          t.name,
          old?.enabled ?? 1,
          old?.skip_confirm ?? 0,
          serializeToolMeta(t) // WR-07：单条尺寸上限 + 两级降级
        )
      }
    })
    tx()
  }

  /** 全量清单（含禁用行——UI 抽屉展示需要；enabled 过滤用 getEnabledTools） */
  static getToolCache(configIdIn: number): McpToolCacheRow[] {
    const scope = McpToolPolicy.resolvePolicyScope(configIdIn)
    const conn = McpToolPolicy.db()
    const rows = conn.prepare(
      `SELECT tool_name, tool_meta, enabled, skip_confirm FROM mcp_tools WHERE ${scope.keyCol} = ? ORDER BY tool_name`
    ).all(scope.keyValue) as Array<{ tool_name: string; tool_meta: string | null; enabled: number; skip_confirm: number }>
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
  static setEnabled(configIdIn: number, toolName: string, enabled: boolean): void {
    const scope = McpToolPolicy.resolvePolicyScope(configIdIn)
    McpToolPolicy.db().prepare(
      `UPDATE mcp_tools SET enabled = ?, updated_at = datetime('now','localtime') WHERE ${scope.keyCol} = ? AND tool_name = ?`
    ).run(enabled ? 1 : 0, scope.keyValue, toolName)
  }

  /**
   * 免确认开关（T-22-01 提权防线）：写 1 前调 isReadOnlyEligible 守卫，
   * 不满足单条件（readOnlyHint!==true）返回 false 拒绝写入；关 0（撤回免确认）不受限。
   */
  static setSkipConfirm(configIdIn: number, toolName: string, skip: boolean): boolean {
    const scope = McpToolPolicy.resolvePolicyScope(configIdIn)
    const conn = McpToolPolicy.db()
    if (skip) {
      const row = conn.prepare(
        `SELECT tool_meta FROM mcp_tools WHERE ${scope.keyCol} = ? AND tool_name = ?`
      ).get(scope.keyValue, toolName) as { tool_meta: string | null } | undefined
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
      `UPDATE mcp_tools SET skip_confirm = ?, updated_at = datetime('now','localtime') WHERE ${scope.keyCol} = ? AND tool_name = ?`
    ).run(skip ? 1 : 0, scope.keyValue, toolName)
    return info.changes > 0
  }

  /**
   * 只返回 enabled=1 行（22-03 AI 注入过滤数据源）。
   * 29-04（PKG-04/D-25，T-29-04-03）：包 extraTools（实测多出的未声明工具）在可用集
   * 计算前被排除——消费端第二道（第一道在 29-03 缓存侧）；手工配置无此过滤。
   */
  static getEnabledTools(configId: number): McpToolCacheRow[] {
    const extra = McpToolPolicy.getExtraToolNames(configId)
    return McpToolPolicy.getToolCache(configId).filter((t) => t.enabled === 1 && !extra.has(t.name))
  }

  /**
   * 被禁工具名清单（22-05 用户裁决：禁用清单注入 AI 提示词 + 禁止令，让 AI 知情并
   * 拒绝用其它工具变通实现被禁功能——纯被动拦截挡不住 evaluate 类万能工具变通）。
   */
  static getDisabledToolNames(configIdIn: number): string[] {
    const scope = McpToolPolicy.resolvePolicyScope(configIdIn)
    const rows = McpToolPolicy.db().prepare(
      `SELECT tool_name FROM mcp_tools WHERE ${scope.keyCol} = ? AND enabled = 0 ORDER BY tool_name`
    ).all(scope.keyValue) as Array<{ tool_name: string }>
    return rows.map((r) => r.tool_name)
  }

  /** 已开免确认的工具名集合（22-03 exec 决策数据源） */
  static getSkipConfirmTools(configIdIn: number): Set<string> {
    const scope = McpToolPolicy.resolvePolicyScope(configIdIn)
    const rows = McpToolPolicy.db().prepare(
      `SELECT tool_name FROM mcp_tools WHERE ${scope.keyCol} = ? AND skip_confirm = 1`
    ).all(scope.keyValue) as Array<{ tool_name: string }>
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
    // smart：库内勾选 + 实时单条件重判，缺一即 confirm
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
