// tests/electron/_helpers/handleLeakDetector.ts
//
// 句柄泄漏检测器（Phase 12 DEP-1 ABI 缓解，TEST-02 句柄自动化检测）。
// 用 process.getActiveResourcesInfo()（Node 17.3+ 内置，Electron 41 内嵌 Node 满足）snapshot 对比，
// afterEach 检测新增非放行句柄 → 触发 wtfnode.dump() 打印调用栈（best-effort 诊断，A4）→ fail 测试。
// 替代 Phase 6 SC#4 + Phase 3 defer 的人工 HV 项（ai/arpCollector/telnetExec 的 try/finally cleanup 路径）。
//
// 关键 pitfall：
//   - baseline 在「beforeEach（每个 it 紧贴被测代码执行前）」取，**每 it 独立基线**（CR-01 修复）
//     —— 之前在「调用点（describe 顶层，首个 it 前）」取一份共享基线，跨多 it 共享，
//        会让累积泄漏检测（Plan 12-03 it4 5 次循环无累积）失效：首个 it 漂移的临时句柄污染基线，
//        后续 it 即使泄漏同类型也被 baseline.includes(h) 放行。
//   - 默认 allowlist 放行 vitest 自身常见句柄（Timeout/GetAddrInfoReqWrap，Pitfall 5）
//   - afterEach 前 await sleep(50) 给 ssh2.end() 异步 EOF 时间（Pitfall 4：mock server 异步 close）
//   - wtfnode best-effort import（装失败/异步失败不阻塞，A4 fallback）

import { beforeEach, afterEach } from 'vitest'
import { McpProcessRegistry } from '../../../electron/services/mcpProcessRegistry'

export interface HandleLeakOptions {
  /**
   * 21-05 扩展：MCP stdio 子进程存活核算（SC5「零残留」断言）。
   * true 时 afterEach 断言 McpProcessRegistry.listActive() 长度为 0；
   * 非零（测试泄漏子进程，T-21-05-01）先 cleanupAll 树杀再 fail，错误信息列残留 pid/configId。
   * 默认 false（既有 12/21-04 前套件不涉及 MCP 子进程，行为不变）。
   */
  expectNoMcpChildren?: boolean
}

/**
 * 注册句柄泄漏检测（beforeEach 取基线 + afterEach 比对）。
 *
 * baseline 在 beforeEach 取（紧贴每个 it 执行前），afterEach 对比新增非放行句柄。
 * 每 it 独立基线，避免跨 it 共享基线致累积泄漏检测失效（CR-01）。
 *
 * @param extraAllow 额外放行的句柄类型（如 mock server 偶发残留 TCPWrap）
 * @param options.expectNoMcpChildren true 时附带 MCP 子进程零残留断言（21-05）
 *
 * 用法：在 describe 内顶部调用 expectNoHandleLeak()，每个 it 执行后自动检测泄漏。
 */
export function expectNoHandleLeak(extraAllow: string[] = [], options?: HandleLeakOptions): void {
  // baseline 在 beforeEach 取（CR-01：每 it 独立基线，避免跨 it 共享致累积泄漏检测失效）
  // —— Pitfall 5 注意：不取在 beforeAll（avoid vitest runner timer 漂移），beforeEach 取在每个 it 紧贴执行前，
  //    it 间漂移的临时句柄（如 vitest runner 心跳 Timeout）会进入当 it 基线，不会污染下一 it。
  let baseline: string[] = []
  beforeEach(() => {
    baseline = process.getActiveResourcesInfo()
  })

  // 默认放行：
  //   - Timeout / GetAddrInfoReqWrap: vitest runner 自身常见句柄（心跳 Timeout / DNS 解析，Pitfall 5）
  //   - TCPServerWrap: mockSshServer/mockTelnetServer 自身 listen socket（beforeAll 起 afterAll 关，
  //     afterEach 时仍在 listen = 预期，非被测代码泄漏）—— 12-02 SSH/Telnet 真路径测试反馈环补入
  //   - TCPWrap / SimpleWriteWrap: ssh2/telnet-client native stream 的 libuv socket/写句柄
  //     （异步释放时序慢于 afterEach sleep(50)，被测 cleanup 已正确调 end/destroy，此为库内部释放延迟）
  const allowDefault = ['Timeout', 'GetAddrInfoReqWrap', 'TCPServerWrap', 'TCPWrap', 'SimpleWriteWrap']
  const allow = new Set([...allowDefault, ...extraAllow])

  afterEach(async () => {
    // 给 cleanup 异步时间（ssh2.end() 异步发 EOF，mock server 异步 close，Pitfall 4）
    await new Promise((r) => setTimeout(r, 50))
    const after = process.getActiveResourcesInfo()
    // 泄漏 = after 中存在但 (不在 allow 白名单) 且 (不在 baseline 基线) 的句柄
    const leaked = after.filter((h) => !allow.has(h) && !baseline.includes(h))
    if (leaked.length > 0) {
      // 触发 wtfnode 诊断（打印泄漏句柄调用栈），方便定位（best-effort，装失败不阻塞，A4）
      // wtfnode 无 @types 声明，import 经 // @ts-expect-error 抑制隐式 any；catch 兜底装失败/异步失败
      // @ts-expect-error wtfnode 无 @types/wtfnode，best-effort 动态 import
      const wtf = (await import('wtfnode').catch(() => null)) as { dump?: () => void } | null
      if (wtf) {
        try {
          wtf.dump?.()
        } catch {
          /* wtfnode.dump 失败不影响 fail 信号 */
        }
      }
      throw new Error(`句柄泄漏: ${JSON.stringify(leaked)}`)
    }

    // 21-05 扩展（T-21-05-01）：MCP stdio 子进程零残留断言。
    // 非零 = 测试泄漏存活子进程（污染 CI/开发机）——先 cleanupAll 树杀止损，再 fail 并列残留 pid/configId。
    if (options?.expectNoMcpChildren) {
      const active = McpProcessRegistry.listActive()
      if (active.length > 0) {
        const detail = active.map((a) => `pid=${a.pid} configId=${a.configId}`).join(', ')
        McpProcessRegistry.cleanupAll(1000)
        throw new Error(`MCP 子进程残留（应零存活）: ${detail}`)
      }
    }
  })
}
