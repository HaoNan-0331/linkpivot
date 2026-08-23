import { useState, useEffect } from 'react'
import { Card, InputNumber, Button, Typography, Space, message } from 'antd'

const { Text } = Typography

/**
 * Phase 28（28-05，D-04）：Agent 硬顶三参数系统设置（McpRoundsInput 全形态同款）。
 * - Agent 步数上限：默认 12，合法 1-30
 * - 连续重复熔断次数：默认 2，合法 1-5
 * - 设备失败冷却（秒）：默认 60，合法 10-600
 * 双重防线：InputNumber min/max 钳制（越界提示「已调整为允许范围内的值 {n}」）+
 * main 侧 set 层硬校验（非法值拒绝落库，错误文案显式回传）。
 */

interface ParamSpec {
  key: 'maxRounds' | 'burnoutCount' | 'cooldownSecs'
  label: string
  min: number
  max: number
  fallback: number
  hint: string
}

const PARAM_SPECS: ParamSpec[] = [
  {
    key: 'maxRounds',
    label: 'Agent 步数上限',
    min: 1,
    max: 30,
    fallback: 12,
    hint: 'AI agent 任务最多执行的步骤数（检索/命令/工具各算一步），超限后诚实收尾总结。范围 1-30，默认 12。',
  },
  {
    key: 'burnoutCount',
    label: '连续重复熔断次数',
    min: 1,
    max: 5,
    fallback: 2,
    hint: '同一设备同一命令连续失败达到该次数后熔断（本轮不再重试，转「需人工处理」）。范围 1-5，默认 2。',
  },
  {
    key: 'cooldownSecs',
    label: '设备失败冷却（秒）',
    min: 10,
    max: 600,
    fallback: 60,
    hint: '命令失败后该设备同一命令进入冷却，冷却期内不自动重试。范围 10-600 秒，默认 60。',
  },
]

export default function AgentLimitsCard() {
  const [values, setValues] = useState<Record<ParamSpec['key'], number>>({
    maxRounds: 12,
    burnoutCount: 2,
    cooldownSecs: 60,
  })
  const [dirty, setDirty] = useState<Record<ParamSpec['key'], boolean>>({
    maxRounds: false,
    burnoutCount: false,
    cooldownSecs: false,
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const [r, b, c] = await Promise.all([
          window.api.ai.getAgentMaxRounds(),
          window.api.ai.getAgentBurnoutCount(),
          window.api.ai.getAgentCooldownSecs(),
        ])
        setValues({ maxRounds: r, burnoutCount: b, cooldownSecs: c })
      } catch {
        // ignore — 保持默认展示
      }
    })()
  }, [])

  const handleChange = (spec: ParamSpec, v: number | null) => {
    if (typeof v !== 'number') return
    // 越界钳制提示（UI-SPEC：越界输入 InputNumber 钳制 + 提示「已调整为允许范围内的值 {n}」）
    if (v < spec.min || v > spec.max) {
      const clamped = Math.min(Math.max(v, spec.min), spec.max)
      message.info(`已调整为允许范围内的值 ${clamped}`)
      setValues((prev) => ({ ...prev, [spec.key]: clamped }))
      setDirty((prev) => ({ ...prev, [spec.key]: true }))
      return
    }
    setValues((prev) => ({ ...prev, [spec.key]: v }))
    setDirty((prev) => ({ ...prev, [spec.key]: true }))
  }

  const handleSave = async (spec: ParamSpec) => {
    const setters = {
      maxRounds: (n: number) => window.api.ai.setAgentMaxRounds(n),
      burnoutCount: (n: number) => window.api.ai.setAgentBurnoutCount(n),
      cooldownSecs: (n: number) => window.api.ai.setAgentCooldownSecs(n),
    }
    setLoading(true)
    try {
      const result = await setters[spec.key](values[spec.key])
      if (result.success) {
        setDirty((prev) => ({ ...prev, [spec.key]: false }))
        message.success(`已保存：${spec.label} = ${values[spec.key]}`)
      } else {
        // main 侧硬校验拒绝文案显式回传（如「Agent 步数上限必须在 1-30 之间」）
        message.error(result.error || '保存失败')
      }
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  return (
    <Card title="Agent 任务硬顶" size="small">
      <Space direction="vertical" size={4}>
        {PARAM_SPECS.map((spec) => (
          <div key={spec.key}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text>{spec.label}</Text>
              <InputNumber
                min={spec.min}
                max={spec.max}
                value={values[spec.key]}
                disabled={loading}
                onChange={(v) => handleChange(spec, v)}
              />
              <Button
                type="primary"
                size="small"
                loading={loading}
                disabled={!dirty[spec.key]}
                onClick={() => handleSave(spec)}
              >
                保存
              </Button>
            </div>
            <Text type="secondary">{spec.hint}</Text>
          </div>
        ))}
        <Text type="secondary">
          调整硬顶参数不改变安全行为：命令/工具执行仍逐条独立执行确认检查与越权检测。
        </Text>
      </Space>
    </Card>
  )
}
