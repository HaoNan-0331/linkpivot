// Phase 19 REN-02 / D-10：parseAiReply 纯函数回归网（命令确认流程是安全链路一环）
// 四类边界（命令块/确认流/普通文本/混合）+ 异常输入防御。
// 期望值以抽取前 useAIChat handleSend :154-200 / handleConfirm :222-238 行为为基准推导。
// 真机 AI 日志实样：执行时无法从应用内读路径导出（日志列加密不可直读），按 D-07 以构造样静态兜底覆盖。
// vitest plain node 入口（npm test），纯函数断言无 DOM 无 mock。
import { describe, it, expect } from 'vitest'
import { parseAiReply } from '@/components/pages/ai/parseAiReply'

describe('parseAiReply 四类边界（D-10）', () => {
  it('普通文本（非 JSON）——降级 plain 不崩，content 原样', () => {
    const r = parseAiReply('这是一段普通 AI 回复，建议检查接口 vlan 配置')
    expect(r).toEqual({ kind: 'plain', content: '这是一段普通 AI 回复，建议检查接口 vlan 配置' })
  })

  it('命令块（纯文本含命令段）——plain，命令文本逐字保留', () => {
    const raw = '请执行以下命令排查：\ndisplay interface brief\ndisplay arp | include 10.1.1'
    const r = parseAiReply(raw)
    expect(r.kind).toBe('plain')
    expect(r.kind === 'plain' && r.content).toBe(raw)
  })

  it('确认流（confirm_required JSON）——kind=confirm + ConfirmData 字段逐项断言（抽取前 handleSend :163-167 语义）', () => {
    const raw = JSON.stringify({
      type: 'confirm_required',
      execId: 'exec-001',
      commands: [{ deviceName: 'SW-Core', command: 'display version' }],
      rejectedCommands: [{ command: 'reboot', reason: '黑名单命令' }],
      aiExplanation: '需要确认后执行',
    })
    const r = parseAiReply(raw)
    expect(r.kind).toBe('confirm')
    if (r.kind !== 'confirm') return
    expect(r.confirm.type).toBe('confirm_required')
    expect(r.confirm.execId).toBe('exec-001')
    expect(r.confirm.commands).toEqual([{ deviceName: 'SW-Core', command: 'display version' }])
    expect(r.confirm.rejectedCommands).toEqual([{ command: 'reboot', reason: '黑名单命令' }])
    expect(r.confirm.aiExplanation).toBe('需要确认后执行')
  })

  it('混合（kb_answer 含 references 无 kind）——补 kind:kb 归一（handleSend :168-177 语义）', () => {
    const raw = JSON.stringify({
      type: 'kb_answer',
      content: '根据文档，ARP 表超限应扩容',
      references: [{ docTitle: '运维手册', chunkTitle: 'ARP 排查', docId: 'doc-9' }],
    })
    const r = parseAiReply(raw)
    expect(r.kind).toBe('answer')
    if (r.kind !== 'answer') return
    expect(r.content).toBe('根据文档，ARP 表超限应扩容')
    expect(r.references).toEqual([
      { kind: 'kb', docTitle: '运维手册', chunkTitle: 'ARP 排查', docId: 'doc-9' },
    ])
  })

  it('混合（exp_answer 含 experience 引用 + sourceSessionId 拆 session 项，D-11-10）', () => {
    const raw = JSON.stringify({
      type: 'exp_answer',
      content: '参考既有经验处理',
      references: [
        { kind: 'experience', expId: 'exp-1', title: '核心交换机堆叠分裂处置', unsupported: true, sourceSessionId: 'sess-a' },
        { kind: 'kb', docTitle: '手册', chunkTitle: '章节', docId: 'doc-1' },
      ],
    })
    const r = parseAiReply(raw)
    expect(r.kind).toBe('answer')
    if (r.kind !== 'answer') return
    expect(r.references).toEqual([
      { kind: 'experience', expId: 'exp-1', title: '核心交换机堆叠分裂处置', unsupported: true },
      { kind: 'session', sessionId: 'sess-a', title: '原始会话' },
      { kind: 'kb', docTitle: '手册', chunkTitle: '章节', docId: 'doc-1' },
    ])
  })

  it('experience 引用无 sourceSessionId——不拆 session 项（handleConfirm flatMap 语义）', () => {
    const raw = JSON.stringify({
      type: 'exp_answer',
      content: 'ans',
      references: [{ kind: 'experience', expId: 'e2', title: '无会话来源' }],
    })
    const r = parseAiReply(raw)
    expect(r.kind === 'answer' && r.references).toEqual([
      { kind: 'experience', expId: 'e2', title: '无会话来源' },
    ])
  })
})

describe('parseAiReply 异常输入防御（T-19-06）', () => {
  it('非法 JSON 字符串——降级 plain 不抛异常', () => {
    const r = parseAiReply('{"type": "confirm_required", broken')
    expect(r).toEqual({ kind: 'plain', content: '{"type": "confirm_required", broken' })
  })

  it('JSON 但非对象（数组/数字/null）——降级 plain', () => {
    expect(parseAiReply('[1,2,3]').kind).toBe('plain')
    expect(parseAiReply('42').kind).toBe('plain')
    expect(parseAiReply('null').kind).toBe('plain')
  })

  it('畸形 confirm_required（缺 execId/commands 非数组）——不进入确认流降级 plain（防伪造触发）', () => {
    expect(parseAiReply(JSON.stringify({ type: 'confirm_required', aiExplanation: 'x' })).kind).toBe('plain')
    expect(
      parseAiReply(
        JSON.stringify({ type: 'confirm_required', execId: 'e', aiExplanation: 'a', commands: 'not-array' })
      ).kind
    ).toBe('plain')
  })

  it('answer JSON 缺 references/缺 content——空引用 + content 空串，不抛异常', () => {
    const r = parseAiReply(JSON.stringify({ type: 'kb_answer' }))
    expect(r).toEqual({ kind: 'answer', content: '', references: [] })
  })

  it('references 含形状不合法项——该项丢弃，合法项保留', () => {
    const raw = JSON.stringify({
      type: 'exp_answer',
      content: 'c',
      references: [
        'garbage-string',
        null,
        { kind: 'experience', expId: 123, title: 'bad' },
        { kind: 'experience', expId: 'ok', title: 'good' },
        { docTitle: 't', chunkTitle: 'c', docId: 1 },
      ],
    })
    const r = parseAiReply(raw)
    expect(r.kind === 'answer' && r.references).toEqual([{ kind: 'experience', expId: 'ok', title: 'good' }])
  })

describe('parseAiReply Phase 22 tool 载荷扩展（22-05，T-22-16 fail-closed）', () => {
  const validToolResult = {
    type: 'tool_result',
    server: 'mock-server',
    tool: 'set_vlan',
    deviceName: 'SW-Core',
    argsJson: '{"vlan":10}',
    resultJson: '{"ok":true}',
    status: 'success',
  }

  it('合法 tool_result 载荷——解析为 toolResult 类型（22-03 契约字段全量）', () => {
    const r = parseAiReply(JSON.stringify(validToolResult))
    expect(r).toEqual({ kind: 'toolResult', toolResult: { ...validToolResult } })
  })

  it('tool_result 含 errorText（failed/timeout 态）——透传可选字段', () => {
    const raw = JSON.stringify({ ...validToolResult, status: 'timeout', errorText: '工具调用超时' })
    const r = parseAiReply(raw)
    expect(r.kind).toBe('toolResult')
    if (r.kind !== 'toolResult') return
    expect(r.toolResult.status).toBe('timeout')
    expect(r.toolResult.errorText).toBe('工具调用超时')
  })

  it('畸形 tool_result（字段缺失/类型错/status 越界）——降级 plain 不进 tool 分支', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...validToolResult, server: 123 },
      { ...validToolResult, tool: undefined },
      { ...validToolResult, argsJson: { vlan: 1 } },
      { ...validToolResult, resultJson: null },
      { ...validToolResult, status: 'error' },
      { ...validToolResult, status: 'SUCCESS' },
      { type: 'tool_result', server: 's' },
    ]
    for (const b of bad) {
      expect(parseAiReply(JSON.stringify(b)).kind).toBe('plain')
    }
  })

  it('tool_result 类型字段错（type 非 tool_result 字面量）——降级 plain', () => {
    const raw = JSON.stringify({ ...validToolResult, type: 'tool-result' })
    expect(parseAiReply(raw).kind).toBe('plain')
  })

  it('confirm_required 混合 MCP 工具行与普通命令行——均通过校验，MCP 可选字段透传', () => {
    const raw = JSON.stringify({
      type: 'confirm_required',
      execId: 'exec-mcp-1',
      aiExplanation: '需要调用 MCP 工具',
      commands: [
        { deviceName: 'SW-Core', command: 'display version' },
        { deviceName: 'SW-Core', command: 'set_vlan', server: 'mock-server', tool: 'set_vlan', argsJson: '{"vlan":10}' },
      ],
    })
    const r = parseAiReply(raw)
    expect(r.kind).toBe('confirm')
    if (r.kind !== 'confirm') return
    expect(r.confirm.commands[0]).toEqual({ deviceName: 'SW-Core', command: 'display version' })
    expect(r.confirm.commands[1]).toEqual({
      deviceName: 'SW-Core', command: 'set_vlan', server: 'mock-server', tool: 'set_vlan', argsJson: '{"vlan":10}',
    })
  })

  it('confirm_required MCP 行可选字段类型错（argsJson 非 string）——畸形行被拒降级 plain', () => {
    const raw = JSON.stringify({
      type: 'confirm_required',
      execId: 'e',
      aiExplanation: 'a',
      commands: [{ deviceName: 'SW', command: 'c', server: 1, tool: 't', argsJson: 'x' }],
    })
    expect(parseAiReply(raw).kind).toBe('plain')
  })

  it('tool_result 非 JSON 事件对象经 isValidToolResultPayload——合法 true / 畸形 false（useAIChat 事件订阅消费）', async () => {
    const mod = await import('@/components/pages/ai/parseAiReply')
    expect(mod.isValidToolResultPayload(validToolResult)).toBe(true)
    expect(mod.isValidToolResultPayload({ ...validToolResult, status: 'oops' })).toBe(false)
    expect(mod.isValidToolResultPayload(null)).toBe(false)
    expect(mod.isValidToolResultPayload('tool_result')).toBe(false)
    expect(mod.isValidToolResultPayload([validToolResult])).toBe(false)
  })
})

  it('未知 type / 无 type 的 JSON——按普通文本原样返回', () => {
    expect(parseAiReply(JSON.stringify({ foo: 'bar' }))).toEqual({
      kind: 'plain',
      content: JSON.stringify({ foo: 'bar' }),
    })
    expect(parseAiReply(JSON.stringify({ type: 'other', content: 'x' })).kind).toBe('plain')
  })
})

// ---------- Phase 22 code-review CR-01：函数式追加语义（parsedToMessages） ----------
// 语义锚点：await chat 期间 ai:toolResult 事件已向 messages 追加卡片行；chat 返回后
// 最终回答必须以 prev 为基准函数式追加——任何基于发送前 snapshot 的整体替换都会丢卡片。
// renderer 无组件测试工具链，此处锁死纯函数层等价断言；React state 行为列入人工验证项。
describe('parsedToMessages 函数式追加语义（CR-01）', () => {
  const toolResultCard = {
    role: 'assistant' as const,
    content: '',
    toolResult: {
      type: 'tool_result' as const,
      server: 'srv-a',
      tool: 'get_status',
      deviceName: 'dev1',
      argsJson: '{}',
      resultJson: '{"ok":1}',
      status: 'success' as const,
    },
  }
  // 模拟 handleSend await 期间事件订阅追加后的最新 state（含卡片 + 用户消息）
  const prevWithCards = [
    { role: 'user' as const, content: '查状态' },
    toolResultCard,
  ]

  it('最终回答落地后，prev 中的 tool_result 卡片仍存在（不被 snapshot 覆盖）', async () => {
    const { parsedToMessages } = await import('@/components/pages/ai/parseAiReply')
    const parsed = parseAiReply(JSON.stringify({ type: 'kb_answer', content: '总结', references: [] }))
    // 函数式更新语义：newMessages = [...prev, ...parsedToMessages(parsed)]
    const next = [...prevWithCards, ...parsedToMessages(parsed)]
    expect(next).toHaveLength(3)
    expect(next[1]).toEqual(toolResultCard) // 卡片保留
    expect(next[2]).toMatchObject({ role: 'assistant', content: '总结' })
  })

  it('toolResult/plain 变体映射正确（卡片行 content 空 / plain 带 content）', async () => {
    const { parsedToMessages } = await import('@/components/pages/ai/parseAiReply')
    expect(parsedToMessages(parseAiReply(JSON.stringify({
      type: 'tool_result', server: 's', tool: 't', deviceName: 'd',
      argsJson: '{}', resultJson: '', status: 'success',
    })))).toEqual([{ role: 'assistant', content: '', toolResult: expect.objectContaining({ tool: 't' }) }])
    expect(parsedToMessages(parseAiReply('纯文本'))).toEqual([{ role: 'assistant', content: '纯文本' }])
  })
})
