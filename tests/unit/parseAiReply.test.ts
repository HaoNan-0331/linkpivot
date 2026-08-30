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

  it('确认流含 guardInfo（Phase 27 checkpoint fix）——guardInfo 完整透传（此前白名单式挑字段丢弃，弹窗永远普通形态）', () => {
    const raw = JSON.stringify({
      type: 'confirm_required',
      execId: 'exec-002',
      commands: [
        { deviceName: 'claude_whn_servicr', command: 'ssh root@192.168.10.29 hostname' },
        { deviceName: 'claude_whn_servicr', command: 'uptime' },
      ],
      aiExplanation: '混批 1 命中 1 常规',
      guardInfo: {
        expectedTarget: 'claude_whn_servicr',
        hits: [
          { ruleId: 'GUARD-02', level: 'red', target: 'root@192.168.10.29', explanation: '跳转类命令目标非当前执行设备' },
        ],
        hitCommandIndexes: [0],
      },
    })
    const r = parseAiReply(raw)
    expect(r.kind).toBe('confirm')
    if (r.kind !== 'confirm') return
    expect(r.confirm.guardInfo).toEqual({
      expectedTarget: 'claude_whn_servicr',
      hits: [{ ruleId: 'GUARD-02', level: 'red', target: 'root@192.168.10.29', explanation: '跳转类命令目标非当前执行设备' }],
      hitCommandIndexes: [0],
    })
  })

  it('确认流 guardInfo 畸形（level 越枚举）——整载荷降级 plain（T-19-06 fail-closed，防伪造绕过警示层）', () => {
    const raw = JSON.stringify({
      type: 'confirm_required',
      execId: 'exec-003',
      commands: [{ deviceName: 'SW-Core', command: 'display version' }],
      aiExplanation: 'x',
      guardInfo: {
        expectedTarget: 'SW-Core',
        hits: [{ ruleId: 'GUARD-02', level: 'green', target: '1.1.1.1', explanation: '伪造分色' }],
      },
    })
    const r = parseAiReply(raw)
    expect(r.kind).toBe('plain')
  })

  it('确认流 guardInfo 缺 hitCommandIndexes（历史/异常 payload）——可选项缺失不拒绝，透传既有字段', () => {
    const raw = JSON.stringify({
      type: 'confirm_required',
      execId: 'exec-004',
      commands: [{ deviceName: 'SW-Core', command: 'ping 8.8.8.8' }],
      aiExplanation: 'x',
      guardInfo: {
        expectedTarget: 'SW-Core',
        hits: [{ ruleId: 'GUARD-01', level: 'yellow', target: '8.8.8.8', explanation: '目标不在对话设备集' }],
      },
    })
    const r = parseAiReply(raw)
    expect(r.kind).toBe('confirm')
    if (r.kind !== 'confirm') return
    expect(r.confirm.guardInfo?.hitCommandIndexes).toBeUndefined()
    expect(r.confirm.guardInfo?.hits).toHaveLength(1)
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
    })))).toEqual([{ role: 'assistant', content: '', toolResult: expect.objectContaining({ tool: 't' }), createdAt: expect.any(String) }])
    expect(parsedToMessages(parseAiReply('纯文本'))).toEqual([{ role: 'assistant', content: '纯文本', createdAt: expect.any(String) }])
  })
})

// ---------- Phase 34（34-01，D-07/D-10）：createdAt 补设契约 ----------
// renderer 新产消息（含在途工具卡宿主行）都携带 createdAt（ISO）；历史恢复的
// 步骤卡继承本体消息 DB 时间（非 now）。缺场历史消息渲染端判空跳过（fail-open）。
describe('34-01 时间戳数据链：createdAt 补设（D-07/D-10）', () => {
  it('parsedToMessages answer 变体也携带 createdAt 字符串', async () => {
    const { parsedToMessages } = await import('@/components/pages/ai/parseAiReply')
    const rows = parsedToMessages(parseAiReply(JSON.stringify({ type: 'kb_answer', content: '答', references: [] })))
    expect(rows).toHaveLength(1)
    expect(typeof rows[0].createdAt).toBe('string')
    expect(rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('append 的步骤卡宿主行携带 createdAt 字符串（applyStepCardToMessages 两 append 点）', async () => {
    const { applyStepCardToMessages } = await import('@/components/pages/ai/parseAiReply')
    const withIdx = {
      type: 'tool_result' as const, server: 'agent', tool: '命令执行', deviceName: 'SW-Core',
      argsJson: 'display version', resultJson: 'ok', status: 'success' as const, stepIndex: 0,
    }
    const legacy = {
      type: 'tool_result' as const, server: 'srv', tool: 't', deviceName: 'd',
      argsJson: '{}', resultJson: 'ok', status: 'success' as const,
    }
    const out1 = applyStepCardToMessages([{ role: 'user', content: 'q' }], withIdx)
    expect(typeof out1[1].createdAt).toBe('string')
    expect(out1[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const out2 = applyStepCardToMessages([{ role: 'user', content: 'q' }], legacy)
    expect(typeof out2[1].createdAt).toBe('string')
    expect(out2[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('history steps 分支的步骤卡行继承本体消息 m.createdAt（非 now）', async () => {
    const { historyMessageToChatMsgs } = await import('@/components/pages/ai/parseAiReply')
    const dbTime = '2026-08-29 23:00:00'
    const out = historyMessageToChatMsgs({
      id: 'm1',
      role: 'assistant',
      content: '最终回答',
      createdAt: dbTime,
      meta: { steps: [{ actionType: 'cmd', stepIndex: 0, status: 'done', command: 'display version', outputSummary: 'ok' }] },
    })
    expect(out).toHaveLength(2) // 步骤卡行 + 本体行
    expect(out[0].createdAt).toBe(dbTime) // 步骤卡继承 DB 时间
    expect(out[1].createdAt).toBe(dbTime) // 本体携带 DB 时间
  })
})

// ---------- Phase 31（31-02，FIX-02 D-01）：sessionId 可选字段校验 + 归因纯函数 ----------
// main 侧 ai:toolResult 载荷自 31-02 起携带发起会话 sessionId（agent 步骤卡 emitStep +
// MCP 工具卡 runMcpCall 两路注入）。此处锁死 renderer 契约语义：
// - 可选字段「在场即校验、缺失放行」（legacy 载荷兼容，照 guardInfo 先例）
// - sessionId 畸形（非 string）整条丢弃 fail-closed（T-31-03）
// - 归因纯函数三分支：payload 优先 → 回退在途回复会话 → null（legacy 按当前会话渲染）
describe('31 FIX-02（31-02）：sessionId 可选字段校验 + 归因纯函数', () => {
  const baseToolResult = {
    type: 'tool_result',
    server: 'agent',
    tool: '命令执行',
    deviceName: 'SW-Core',
    argsJson: 'display version',
    resultJson: '{"ok":true}',
    status: 'success',
  }

  it('sessionId 为 string——校验通过（31-02 新载荷合法）', async () => {
    const mod = await import('@/components/pages/ai/parseAiReply')
    expect(mod.isValidToolResultPayload({ ...baseToolResult, sessionId: 's1' })).toBe(true)
  })

  it('sessionId 非 string（number 畸形）——整条拒绝 fail-closed（T-31-03，防伪造/篡改归因）', async () => {
    const mod = await import('@/components/pages/ai/parseAiReply')
    expect(mod.isValidToolResultPayload({ ...baseToolResult, sessionId: 123 })).toBe(false)
  })

  it('无 sessionId 字段（legacy 载荷）——放行不拒绝（向后兼容，归因走回退分支）', async () => {
    const mod = await import('@/components/pages/ai/parseAiReply')
    expect(mod.isValidToolResultPayload({ ...baseToolResult })).toBe(true)
  })

  it('归因三分支——payload.sessionId 优先（在途传什么都不夺权）', async () => {
    const { attributeToolResultSession } = await import('@/components/pages/ai/parseAiReply')
    expect(attributeToolResultSession({ ...baseToolResult, sessionId: 'sA' }, 'sX')).toBe('sA')
    expect(attributeToolResultSession({ ...baseToolResult, sessionId: 'sA' }, null)).toBe('sA')
  })

  it('归因三分支——legacy 载荷回退在途回复会话 / 双缺返回 null（调用方按当前会话渲染）', async () => {
    const { attributeToolResultSession } = await import('@/components/pages/ai/parseAiReply')
    expect(attributeToolResultSession({ ...baseToolResult }, 'sB')).toBe('sB')
    expect(attributeToolResultSession({ ...baseToolResult }, null)).toBe(null)
  })
})

// ---------- Phase 31（31-05，FIX-02 候选③ / D-04）：mergeStashedCards 暂存幂等合并 ----------
// 31-04 裁决 CONFIRMED：切走前已实时上屏的步骤卡不进暂存（stash-merge stashed:0），
// handleSelectSession 以 DB history 整体替换后内存卡丢失。31-05 起在途回合载荷
// 无条件全量入暂存（与 live 上屏并行），切回统一经 mergeStashedCards 幂等合并：
// - 含 stepIndex：applyStepCardToMessages 定位更新，同 index 重放更新同一卡（天然幂等）
// - 无 stepIndex（legacy MCP tool_result）：按 server+tool+argsJson+resultJson+status 判重跳过
// - 回合存活期暂存不删（多次往返靠幂等防重复），finishReply 统一弃暂存（DB meta.steps 为准）
describe('31 FIX-02（31-05）：mergeStashedCards 暂存幂等合并（多轮往返不丢不重）', () => {
  const stepCard = (stepIndex: number, resultJson: string) => ({
    type: 'tool_result' as const,
    server: 'agent',
    tool: '命令执行',
    deviceName: 'SW-Core',
    argsJson: 'display version',
    resultJson,
    status: 'success' as const,
    stepIndex,
  })
  const legacyCard = (resultJson: string, status: 'success' | 'failed' = 'success') => ({
    type: 'tool_result' as const,
    server: 'mock-server',
    tool: 'get_status',
    deviceName: 'SW-Core',
    argsJson: '{}',
    resultJson,
    status,
  })

  it('含 stepIndex 载荷序列 reduce 后再整体 reduce 一遍（A→B→A→B→A 两轮往返）——卡片数不变、终态 status 保留（幂等）', async () => {
    const { mergeStashedCards } = await import('@/components/pages/ai/parseAiReply')
    const payloads = [stepCard(0, '{"v":"v1"}'), stepCard(1, '{"c":"c1"}'), stepCard(2, '{"p":"p1"}')]
    // 切回时 DB history：31-05 候选②修复后含本轮 user 行（合并基准）
    const history = [{ role: 'user' as const, content: '多步任务' }]
    const once = mergeStashedCards(history, payloads)
    expect(once).toHaveLength(4) // user + 3 卡
    // 第二轮往返：同序列重放（回合存活期暂存未删）
    const twice = mergeStashedCards(once, payloads)
    expect(twice).toHaveLength(4) // 幂等：重放不增卡
    expect(twice[1].toolResult?.stepIndex).toBe(0)
    expect(twice[1].toolResult?.resultJson).toBe('{"v":"v1"}')
    expect(twice[2].toolResult?.stepIndex).toBe(1)
    expect(twice[3].toolResult?.stepIndex).toBe(2)
    // 终态更新语义：step 1 结果被后续载荷更新后，重放旧序仍保留最新终态
    const updated = mergeStashedCards(twice, [stepCard(1, '{"c":"c1-final"}')])
    expect(updated).toHaveLength(4)
    expect(updated[2].toolResult?.resultJson).toBe('{"c":"c1-final"}')
    // 第三轮往返仍不变（任意次数）
    expect(mergeStashedCards(updated, payloads)).toHaveLength(4)
  })

  it('无 stepIndex 的 legacy 载荷重复合并两遍——不产生重复卡片（按 server+tool+argsJson+resultJson+status 判重）', async () => {
    const { mergeStashedCards } = await import('@/components/pages/ai/parseAiReply')
    const payloads = [legacyCard('{"ok":1}'), legacyCard('{"ok":2}')]
    const history = [{ role: 'user' as const, content: '查状态' }]
    const once = mergeStashedCards(history, payloads)
    expect(once).toHaveLength(3)
    const twice = mergeStashedCards(once, payloads)
    expect(twice).toHaveLength(3) // 重放零重复
    // 五键任一不同即不同卡（status 变体不去重，如实追加）
    const variant = mergeStashedCards(twice, [legacyCard('{"ok":1}', 'failed')])
    expect(variant).toHaveLength(4)
  })

  it('切走前已渲染卡（合并入 prev）+ 切走后到达卡（暂存序列）混合合并——全部可见且无重复', async () => {
    const { mergeStashedCards } = await import('@/components/pages/ai/parseAiReply')
    // 用户在 A 时已实时上屏的卡（切走前）——31-05 起这些载荷同时进了暂存
    const renderedBeforeSwitch = stepCard(0, '{"v":"v1"}')
    // 切走后在 B 期间到达的卡（仅在暂存）
    const arrivedWhileAway = [stepCard(1, '{"c":"c1"}'), stepCard(2, '{"p":"p1"}')]
    // 切回 A：prev = DB history（含本轮 user 行）+ 切走前已渲染卡（仍在归属会话内存的形态）
    const prev = [
      { role: 'user' as const, content: '多步任务' },
      { role: 'assistant' as const, content: '', toolResult: renderedBeforeSwitch },
    ]
    // 暂存 = 全回合载荷（切走前 + 切走后，31-05 全量暂存语义）
    const stash = [renderedBeforeSwitch, ...arrivedWhileAway]
    const merged = mergeStashedCards(prev, stash)
    expect(merged).toHaveLength(4) // user + 3 卡全可见
    expect(merged[1].toolResult?.stepIndex).toBe(0) // 切走前的卡不被覆盖
    expect(merged[2].toolResult?.stepIndex).toBe(1)
    expect(merged[3].toolResult?.stepIndex).toBe(2)
    // 再往返一次仍 4（幂等）
    expect(mergeStashedCards(merged, stash)).toHaveLength(4)
  })

  it('空暂存序列——直接返回 prev 原引用（零合并开销）', async () => {
    const { mergeStashedCards } = await import('@/components/pages/ai/parseAiReply')
    const prev = [{ role: 'user' as const, content: 'q' }]
    expect(mergeStashedCards(prev, [])).toBe(prev)
  })
})
