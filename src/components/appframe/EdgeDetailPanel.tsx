import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Button, Input } from 'antd'
import { useDeviceDetailStore } from '@/stores/deviceDetailStore'
import {
  ACTION_ROW_STYLE,
  DEVICE_NAME_STYLE,
  FIELD_LABEL_STYLE,
  FIELD_ROW_STYLE,
  FIELD_VALUE_STYLE,
  PANEL_STYLE,
  SECTION_STYLE,
  SECTION_TITLE_STYLE,
} from './DeviceDetailPanel'

/**
 * EdgeDetailPanel —— details 栏连线详情内容组件（Phase 39 / LINK-01 · D-02/D-04/D-07）。
 *
 * 「恰好单选一条连线」时三区常驻展示：链路两端区（两端设备名，已纳管端可点击跳转
 * D-04）+ 接口标注区（源/目标接口 Input 失焦即存 D-02，走既有 1s debounce 自动落库链
 * 零确认按钮——改错可重新改回）+ 操作区（删除连线 D-07 轻删免确认——线可重连可重做）。
 *
 * 数据源：selectedEdge 写侧换算快照（TopologyPage 选中同步 effect 经 edgesRef/nodesRef
 * 换算，39-01）——快照同步可得，无 loading 态；空选/设备选中/多选快照为 null 直接
 * return null（空态并入，stale edge 由写侧清空保证——PATTERNS §7 三态映射裁决）。
 * 本组件经 DetailsPanel 无条件挂载（35 SC2 折叠保挂载红线——内容切换非挂载切换）。
 *
 * 跨层命令消费：getState().canvasActions 一次性取用调用（applyEdgeInterfaces/
 * removeEdgeFromCanvas/focusDevice，Pattern 3 读清即走——consumePendingAiDevice 同款
 * 语义家族，不订阅）。样式常量 import 自 DeviceDetailPanel（单一来源不复制），新增
 * 样式仅容器级组装，全走 var(--nt-*) token（audit:tokens 零字面量红线）。
 * H-1 红线：仅渲染画布快照（设备名/接口字符串），零凭证类字段。
 */

/** 接口输入框：code 栈字体（FIELD_VALUE_CODE_STYLE 同款 fontFamily 的功能性字体选择） */
const INTERFACE_INPUT_STYLE: CSSProperties = {
  fontFamily: 'var(--nt-font-family-code)',
}

/** 两端设备名跳转按钮：强调色 + padding 0 + 内容高（DEFAULT_BADGE 同款强调色先例；
 * plan 裁决的 AntD link 覆写例外；字号对齐 FIELD_VALUE xs-13 保持行内视觉一致） */
const DEVICE_LINK_STYLE: CSSProperties = {
  font: 'var(--nt-font-xs-13)',
  color: 'var(--nt-alias-state-business-primary)',
  padding: 0,
  height: 'auto',
}

/** 接口输入框填充列：吃剩余宽度（FIELD_VALUE 的 fill 语义用于 Input 容器） */
const INTERFACE_FIELD_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
}

export default function EdgeDetailPanel() {
  // Pattern 3（单字段 selector）：连线选中快照（39-01 写侧 TopologyPage 选中同步 effect）
  const selectedEdge = useDeviceDetailStore((s) => s.selectedEdge)

  // 本地编辑权威：接口两值受控 state；selectedEdge 引用变化（换选连线 / 接口回写命令执行
  // → setEdges → 选中 effect 重跑 → 新快照）时重置本地为快照值——回写链新快照与本地同值
  // 用户无感；换选连线时本地随新快照重置
  const [sourceInterface, setSourceInterface] = useState('')
  const [targetInterface, setTargetInterface] = useState('')
  useEffect(() => {
    setSourceInterface(selectedEdge?.sourceInterface ?? '')
    setTargetInterface(selectedEdge?.targetInterface ?? '')
  }, [selectedEdge])

  // D-02 接口失焦即存（DeviceForm handleIpBlur「本地受控 + onBlur 提交」同款先例）：
  // 失焦字段值与快照对应字段相等则跳过（无变化零触发）；否则两值整包回写——
  // applyEdgeInterfaces 定向换 edge.data，落库走 TopologyPage 既有 1s debounce
  // topology.update 链（零新增 IPC），零确认按钮（D-02 明示，改错可重新改回）
  const handleSourceBlur = useCallback(() => {
    const edge = useDeviceDetailStore.getState().selectedEdge
    if (!edge || sourceInterface === edge.sourceInterface) return
    useDeviceDetailStore
      .getState()
      .canvasActions?.applyEdgeInterfaces(edge.edgeId, sourceInterface, targetInterface)
  }, [sourceInterface, targetInterface])

  const handleTargetBlur = useCallback(() => {
    const edge = useDeviceDetailStore.getState().selectedEdge
    if (!edge || targetInterface === edge.targetInterface) return
    useDeviceDetailStore
      .getState()
      .canvasActions?.applyEdgeInterfaces(edge.edgeId, sourceInterface, targetInterface)
  }, [sourceInterface, targetInterface])

  // D-04 两端跳转：点击设备名 → 画布选中切换到该设备节点（focusDevice 三步直写），
  // 右栏自动切换为该设备详情（跳转闭环）
  const handleFocusDevice = useCallback((deviceId: string) => {
    useDeviceDetailStore.getState().canvasActions?.focusDevice(deviceId)
  }, [])

  // D-07 删连线（轻删免确认）：点即执行；成功后写侧清本地选中 → 选中同步 effect 上抛
  // null → 右栏自动收起，组件无需本地善后
  const handleRemoveEdge = useCallback(() => {
    const edge = useDeviceDetailStore.getState().selectedEdge
    if (!edge) return
    useDeviceDetailStore.getState().canvasActions?.removeEdgeFromCanvas(edge.edgeId)
  }, [])

  // 空选/设备选中/多选：快照 null（写侧互斥保证）——内容级门控，实例仍由父层挂载（SC2）
  if (selectedEdge === null) return null

  const { sourceDeviceId, sourceDeviceName, targetDeviceId, targetDeviceName } = selectedEdge

  return (
    <div style={PANEL_STYLE}>
      {/* 头部标题区（DeviceDetailPanel 头部形态） */}
      <div style={DEVICE_NAME_STYLE}>连线详情</div>

      {/* 链路两端区（D-04 已纳管端可点击跳转；未纳管端 deviceId null 纯文本不可点） */}
      <div style={SECTION_STYLE}>
        <div style={SECTION_TITLE_STYLE}>链路两端</div>
        <div style={FIELD_ROW_STYLE}>
          <span style={FIELD_LABEL_STYLE}>源端设备</span>
          {sourceDeviceId !== null ? (
            <Button type="link" size="small" style={DEVICE_LINK_STYLE} onClick={() => handleFocusDevice(sourceDeviceId)}>
              {sourceDeviceName}
            </Button>
          ) : (
            <span style={FIELD_VALUE_STYLE}>{sourceDeviceName || '未知设备'}</span>
          )}
        </div>
        <div style={FIELD_ROW_STYLE}>
          <span style={FIELD_LABEL_STYLE}>目标端设备</span>
          {targetDeviceId !== null ? (
            <Button type="link" size="small" style={DEVICE_LINK_STYLE} onClick={() => handleFocusDevice(targetDeviceId)}>
              {targetDeviceName}
            </Button>
          ) : (
            <span style={FIELD_VALUE_STYLE}>{targetDeviceName || '未知设备'}</span>
          )}
        </div>
      </div>

      {/* 接口标注区（D-02 失焦即存；label 与 ConnectionModal 建线引导同域措辞，
          placeholder 同款示例） */}
      <div style={SECTION_STYLE}>
        <div style={SECTION_TITLE_STYLE}>接口标注</div>
        <div style={FIELD_ROW_STYLE}>
          <span style={FIELD_LABEL_STYLE}>源端接口</span>
          <div style={INTERFACE_FIELD_STYLE}>
            <Input
              size="small"
              style={INTERFACE_INPUT_STYLE}
              value={sourceInterface}
              onChange={(e) => setSourceInterface(e.target.value)}
              onBlur={handleSourceBlur}
              placeholder="例: GigabitEthernet0/0/1"
            />
          </div>
        </div>
        <div style={FIELD_ROW_STYLE}>
          <span style={FIELD_LABEL_STYLE}>目标端接口</span>
          <div style={INTERFACE_FIELD_STYLE}>
            <Input
              size="small"
              style={INTERFACE_INPUT_STYLE}
              value={targetInterface}
              onChange={(e) => setTargetInterface(e.target.value)}
              onBlur={handleTargetBlur}
              placeholder="例: GigabitEthernet0/0/1"
            />
          </div>
        </div>
      </div>

      {/* 操作区（D-07 轻删免确认：线可重连可重做，删后右栏自动收起） */}
      <div style={SECTION_STYLE}>
        <div style={SECTION_TITLE_STYLE}>操作</div>
        <div style={ACTION_ROW_STYLE}>
          <Button size="small" danger onClick={handleRemoveEdge}>
            删除连线
          </Button>
        </div>
      </div>
    </div>
  )
}
