/**
 * aiClient —— LLM HTTP client（callAI / callAIWithUsage / usage 统计 / ChatInterruptedError）。
 *
 * Phase 32（D-01/D-05，P1）：机械搬移自 ai.ts:335-428，函数体逐字零改动，保持源函数式
 * 形态不转静态类（32-PATTERNS Shared Pattern 1）。config 经参数传入，不 import aiConfig
 * （叶子模块，无 MK、无 ai 域内依赖）。
 *
 * 独立小模块裁决（Claude's Discretion，32-CONTEXT）：discovery/draftingService/
 * experienceRerank/knowledgeBaseService 四个非 AI 编排域消费 callAI/getAiConfig——独立模块
 * 避免低层域依赖 agent 循环/chat 编排高层域的倒挂。
 *
 * ChatInterruptedError 单一物理定义在本文件（main.ts instanceof 身份依据）——其余模块仅经
 * ai.ts barrel re-export，禁止任何复制。
 */

// ---------- AI API call ----------

export async function callAI(
  config: Record<string, string>,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal
): Promise<string> {
  return (await callAIWithUsage(config, messages, signal)).content
}

/** Phase 28（28-04，AGENT-05/D-06）：用户停止 → 中断信号唯一异常类型（main 侧兜底识别） */
export class ChatInterruptedError extends Error {
  constructor() {
    super('用户已停止本次 AI 对话')
  }
}

/** Phase 28（28-04，D-06）：中断收尾文案——立即中止不总结（不触发 AI 收尾 callAI，已执行步骤保留） */
export const AGENT_INTERRUPTED_NOTICE =
  '（用户已停止：本次 AI 执行已中断，不再继续后续步骤，也不生成总结。已执行的步骤与来源见下方轨迹。）'

/**
 * Phase 28（AGENT-04，Pitfall 6）：callAI 计量扩展——消费网关 data.usage（原实现直接丢弃），
 * 缺失时按字符数/4 估算 fallback，供 runAgentLoop token 预算硬顶累计。既有调用方经 callAI
 * 包装保持旧行为（返回 content 字符串）不变。
 */
export async function callAIWithUsage(
  config: Record<string, string>,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal
): Promise<{ content: string; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelName,
        messages,
      }),
      // 28-04（D-06）：用户停止 → AbortController 立即断 LLM fetch
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw new ChatInterruptedError()
    throw err
  }
  // 28-06 缺陷②：停止若落在响应体下载中（fetch 已返回、text/json 未完成），原生
  // AbortError 会绕过上方 catch 逃逸——body 消费同样按 aborted 归一为
  // ChatInterruptedError（用户停止是既定意图，非错误）。
  let data: any
  try {
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`AI API 错误 (${response.status}): ${text}`)
    }
    data = await response.json()
  } catch (err) {
    if (signal?.aborted && !(err instanceof Error && err.message.startsWith('AI API 错误'))) {
      throw new ChatInterruptedError()
    }
    throw err
  }
  const content: string = data.choices?.[0]?.message?.content || ''
  const usage = normalizeUsage(data.usage, messages, content)
  return { content, usage }
}

/** usage 归一：网关缺失/字段非法 → 估算 fallback（请求消息 + 回复按字符数/4） */
function normalizeUsage(
  raw: unknown,
  messages: Array<{ role: string; content: string }>,
  content: string
): { prompt_tokens: number; completion_tokens: number } {
  const promptTokens = Number((raw as any)?.prompt_tokens)
  const completionTokens = Number((raw as any)?.completion_tokens)
  return {
    prompt_tokens: Number.isFinite(promptTokens) && promptTokens > 0
      ? promptTokens
      : estimateTokens(messages.map((m) => `${m.role}:${m.content}`).join('\n')),
    completion_tokens: Number.isFinite(completionTokens) && completionTokens > 0
      ? completionTokens
      : estimateTokens(content),
  }
}

/** 粗估 token 数（字符数/4，向上取整）——RESEARCH Pitfall 6 估算口径 */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4)
}
