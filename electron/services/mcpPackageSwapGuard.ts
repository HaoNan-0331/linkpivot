/**
 * McpPackageSwapGuard —— 29.1 CR MD-02：包换盘窗口进程内守卫。
 *
 * confirmOverwrite 顺序为「DB 事务提交（新指纹）→ 杀运行实例 → rmSync 旧目录 + rename 换入」。
 * 提交之后、换盘完成之前（以及换盘失败的持续态），任何 spawn 侧指纹重验都会用**新指纹**
 * 比对**旧磁盘** → 必然失败 → TOCTOU 误判 → 包被永久禁用（恢复只能完整重导）。
 *
 * 守卫语义：confirmOverwrite 在事务开始前置位、换盘结束后清零（finally）；
 * getConnection（AI 工具调用主链）/ testPackage / testPackageConfig / loadPackageSpawnInfo
 * 检测到标记即返回结构化 MCP_PACKAGE_SWAPPING「包正在更新，请稍后重试」——不触发指纹
 * 重验与 integrity 副作用（fail-closed 换成 fail-retry，窗口毫秒级、调用方可重试）。
 *
 * 独立小模块（零依赖）：mcpClient（零 DB 依赖红线）与 mcpPackageService/ai 共用，无环。
 * 形态：静态类 facade（conventions）。
 */

export class McpPackageSwapGuard {
  private static swapping = new Set<number>()

  static begin(packageId: number): void {
    McpPackageSwapGuard.swapping.add(packageId)
  }

  static end(packageId: number): void {
    McpPackageSwapGuard.swapping.delete(packageId)
  }

  static isSwapping(packageId: number): boolean {
    return McpPackageSwapGuard.swapping.has(packageId)
  }

  /** @internal 测试专用：清空标记 */
  static _reset(): void {
    McpPackageSwapGuard.swapping.clear()
  }
}

/** 换盘窗口统一结构化错误（可重试语义，非 integrity 副作用路径） */
export function packageSwappingError(): { code: string; reason: string } {
  return { code: 'MCP_PACKAGE_SWAPPING', reason: 'MCP 包正在更新（覆盖导入换盘中），请稍后重试' }
}
