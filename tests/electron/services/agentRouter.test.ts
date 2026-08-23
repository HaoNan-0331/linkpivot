import { describe, it, expect } from 'vitest'

/**
 * Phase 28（28-02 Task 1，AGENT-01）：agentRouter 四档分类纯函数 TDD。
 *
 * 覆盖：四档正例、默认档（knowledge fail-closed）、大小写归一、空串/空白边界、
 * 优先级冲突例（同句含故障 + 配置关键词 → troubleshoot）。
 * 纯函数测试：零 DB 零 MK 零 import 副作用（privilegeGuard.test.ts 先例）。
 */

import {
  classifyTier,
  TIER_LABELS,
  type AgentTier,
} from '../../../electron/services/agentRouter'

describe('四档正例', () => {
  it('故障排查：端口 down 不通', () => {
    expect(classifyTier('核心交换机端口 down 了不通')).toBe('troubleshoot')
  })

  it('配置查询：怎么配置 vlan 20 的路由', () => {
    expect(classifyTier('怎么配置 vlan 20 的路由')).toBe('configQuery')
  })

  it('知识问答（默认档）：OSPF 和 BGP 的区别', () => {
    expect(classifyTier('OSPF 和 BGP 的区别')).toBe('knowledge')
  })

  it('巡检执行：帮我巡检一遍所有设备状态', () => {
    expect(classifyTier('帮我巡检一遍所有设备状态')).toBe('inspection')
  })
})

describe('默认档 fail-closed（最保守，只查 KB/EXP 不碰设备）', () => {
  it('空串 → knowledge', () => {
    expect(classifyTier('')).toBe('knowledge')
  })

  it('纯空白 → knowledge', () => {
    expect(classifyTier('   \n\t  ')).toBe('knowledge')
  })

  it('零关键词命中（普通知识提问）→ knowledge', () => {
    expect(classifyTier('什么是三层交换和二层交换的区别')).toBe('knowledge')
  })
})

describe('大小写归一', () => {
  it("'VLAN Down' 命中故障排查档", () => {
    expect(classifyTier('VLAN Down')).toBe('troubleshoot')
  })

  it("'How to CONFIG vlan' 命中配置查询档", () => {
    expect(classifyTier('How to CONFIG vlan')).toBe('configQuery')
  })
})

describe('优先级冲突：troubleshoot > inspection > configQuery', () => {
  it('同句含 down + 配置 → troubleshoot', () => {
    expect(classifyTier('端口 down 了，顺便看下配置怎么改')).toBe('troubleshoot')
  })

  it('同句含巡检 + 配置 → inspection', () => {
    expect(classifyTier('巡检一遍所有设备，重点看下配置')).toBe('inspection')
  })
})

describe('中文运维语料关键词覆盖（RESEARCH 矩阵草案）', () => {
  it('故障关键词：故障/不通/告警/断/慢/排查/丢包', () => {
    for (const m of ['设备故障了', '网络不通', '有告警', '链路断了', '特别慢', '帮我排查', '在丢包']) {
      expect(classifyTier(m), m).toBe('troubleshoot')
    }
  })

  it('配置关键词：配置/config/怎么配/vlan/路由表', () => {
    for (const m of ['配置一下 snmp', 'config mode', '怎么配地址', 'vlan 划分', '看路由表']) {
      expect(classifyTier(m), m).toBe('configQuery')
    }
  })

  it('巡检关键词：巡检/检查一遍/批量看状态', () => {
    for (const m of ['做一次巡检', '把设备检查一遍', '批量看状态']) {
      expect(classifyTier(m), m).toBe('inspection')
    }
  })
})

describe('28-06 缺陷③：查询动词 × 设备状态目标 复合规则', () => {
  it('「查询这个设备的版本信息」→ inspection（真机缺陷复现句）', () => {
    expect(classifyTier('查询这个设备的版本信息')).toBe('inspection')
  })

  it('接口/状态/内存等状态目标 × 查询动词 → inspection', () => {
    for (const m of ['查看一下接口情况', '查一下设备状态', '看下内存使用', 'show version 结果帮我看看', '获取接口列表']) {
      expect(classifyTier(m), m).toBe('inspection')
    }
  })

  it('配置类目标仍走 configQuery（查询配置 ≠ 状态查询）', () => {
    for (const m of ['查询这个设备的配置', '查看 vlan 配置', '看下路由表']) {
      expect(classifyTier(m), m).toBe('configQuery')
    }
  })

  it('故障词优先级不因复合规则改变：接口 down 了查看状态 → troubleshoot', () => {
    expect(classifyTier('接口 down 了查看状态')).toBe('troubleshoot')
  })

  it('纯状态名词无查询动词不误升档：设备版本是什么意思 → knowledge', () => {
    expect(classifyTier('设备版本是什么意思')).toBe('knowledge')
  })
})

describe('TIER_LABELS 中文名映射（UI-SPEC 文案）', () => {
  it('四档齐全', () => {
    expect(TIER_LABELS.troubleshoot).toBe('故障排查')
    expect(TIER_LABELS.configQuery).toBe('配置查询')
    expect(TIER_LABELS.knowledge).toBe('知识问答')
    expect(TIER_LABELS.inspection).toBe('巡检执行')
  })

  it('键集与 AgentTier 联合类型一致', () => {
    const tiers: AgentTier[] = ['troubleshoot', 'configQuery', 'knowledge', 'inspection']
    expect(Object.keys(TIER_LABELS).sort()).toEqual([...tiers].sort())
  })
})
