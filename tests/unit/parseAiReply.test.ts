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

  it('未知 type / 无 type 的 JSON——按普通文本原样返回', () => {
    expect(parseAiReply(JSON.stringify({ foo: 'bar' }))).toEqual({
      kind: 'plain',
      content: JSON.stringify({ foo: 'bar' }),
    })
    expect(parseAiReply(JSON.stringify({ type: 'other', content: 'x' })).kind).toBe('plain')
  })
})
