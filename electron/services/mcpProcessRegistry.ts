/**
 * McpProcessRegistry —— MCP stdio 子进程登记与树杀（21-03，MCP-04/MCP-05，T-21-03-04/T-21-03-07）。
 *
 * 职责（只管登记与杀，spawn 在 SDK transport 内）：
 *  - register(pid, configId)：pid 全量登记，killTree 只接受登记表内 pid（防滥杀任意进程）
 *  - killTree(pid)：Windows `taskkill /pid X /T /F` 树杀（npx→cmd→node 孙进程链不存活）；
 *    execSync 失败（进程已退）吞错并 unregister；不使用 node child 的 kill（无句柄、不树杀）
 *  - cleanupAll(timeoutMs=3000)：before-quit 同步快路径，逐个 taskkill，总耗时超时即停止继续等待
 *  - listActive()：测试/SC5 断言「测试完成后无存活子进程」
 *
 * 空闲回收核算：markUsed(pid)/lastUsedAt 查询由本表提供，**sweep 定时器由 mcpClient 驱动**
 * （裁决：Registry 不自持 setInterval——连接生命周期归 mcpClient，Registry 保持纯登记/杀的
 * 最小职责，unref 问题随连接器一并消化，见 mcpClient.ts IDLE_TIMEOUT_MS 注释）。
 */

import { execSync } from 'child_process'

interface RegisteredProcess {
  configId: string
  startedAt: number
  lastUsedAt: number
}

export class McpProcessRegistry {
  private static processes = new Map<number, RegisteredProcess>()

  static register(pid: number, configId: string): void {
    McpProcessRegistry.processes.set(pid, {
      configId,
      startedAt: Date.now(),
      lastUsedAt: Date.now()
    })
  }

  static unregister(pid: number): void {
    McpProcessRegistry.processes.delete(pid)
  }

  /** 空闲回收核算：RPC 完成后刷新 lastUsedAt */
  static markUsed(pid: number): void {
    const rec = McpProcessRegistry.processes.get(pid)
    if (rec) rec.lastUsedAt = Date.now()
  }

  /** 空闲回收核算：返回 [pid, configId, idleMs] 列表供 mcpClient sweep 判定 */
  static listIdleInfo(): Array<{ pid: number, configId: string, idleMs: number }> {
    const now = Date.now()
    return Array.from(McpProcessRegistry.processes.entries()).map(([pid, rec]) => ({
      pid,
      configId: rec.configId,
      idleMs: now - rec.lastUsedAt
    }))
  }

  /**
   * 树杀：仅接受登记表内 pid（T-21-03-07，禁止外部任意 pid kill 误杀）。
   * /T 杀进程树（npx→cmd→node 孙进程链）、/F 强杀；进程已退（taskkill 报错）吞错并 unregister。
   */
  static killTree(pid: number): boolean {
    if (!McpProcessRegistry.processes.has(pid)) return false
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    } catch {
      // 进程已退 / taskkill 不可用——统一按已清退处理，避免阻塞调用方
    }
    McpProcessRegistry.processes.delete(pid)
    return true
  }

  /**
   * before-quit 清理（3s 预算）：同步遍历逐个 killTree（单个 taskkill 快路径），
   * 总耗时超 timeoutMs 即停止继续等待——勿阻塞 quit（强杀 Electron 场景靠
   * 「不持长寿命子进程」架构保证：连接测试测完即杀、长连接 10min 空闲回收）。
   */
  static cleanupAll(timeoutMs = 3000): number {
    const deadline = Date.now() + timeoutMs
    let killed = 0
    for (const pid of Array.from(McpProcessRegistry.processes.keys())) {
      if (Date.now() > deadline) break
      if (McpProcessRegistry.killTree(pid)) killed++
    }
    return killed
  }

  /** 测试/SC5 断言面：当前登记的存活子进程快照 */
  static listActive(): Array<{ pid: number, configId: string, startedAt: number }> {
    return Array.from(McpProcessRegistry.processes.entries()).map(([pid, rec]) => ({
      pid,
      configId: rec.configId,
      startedAt: rec.startedAt
    }))
  }

  /** @internal 测试专用 */
  static _reset(): void {
    McpProcessRegistry.processes.clear()
  }
}
