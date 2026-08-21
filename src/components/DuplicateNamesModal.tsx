import { useCallback, useEffect, useState } from 'react'
import { Modal, Collapse, Input, Button, Space, Typography, Empty, Spin, message } from 'antd'
import type { UpdateDeviceDTO } from '../types/device'

const { Text } = Typography

/** 25-05（ASSET-04/D-09）：listDuplicates 返回的重名分组结构（见 electron.d.ts device.listDuplicates） */
interface DupDevice {
  id: string
  name: string
  ipAddress: string
  model: string
  vendor: string
}

interface DupGroup {
  nameHash: string
  devices: DupDevice[]
}

interface Props {
  open: boolean
  onClose: () => void
  /** 任一台改名成功后回调（DevicesPage 刷新 Alert 与设备列表）；清零时也触发 */
  onChanged: () => void
}

/**
 * Phase 25（D-09/D-10）：存量重名清单弹窗。
 * - 按重名组折叠展示，组内设备并排展示 IP/型号/厂商区分信息
 * - 名称 Input 内联编辑 + 单台保存（走 device.update → service 唯一拦截，编辑路径排除自身）
 * - 改完该组该组消失；全部清零后展示「唯一防护已启用 ✓」
 *   （25-03 裁决：updateDevice 事务提交后后端自动检测清零并建 UNIQUE 索引，
 *    listDuplicates 返回空 = 索引已真实存在，此处是状态展示而非前端判定）
 */
export default function DuplicateNamesModal({ open, onClose, onChanged }: Props) {
  const [groups, setGroups] = useState<DupGroup[]>([])
  const [loading, setLoading] = useState(false)
  // 正在保存的设备 id → 保存按钮 loading
  const [savingId, setSavingId] = useState<string | null>(null)
  // 每台设备的内联输入值（id → 当前输入名）
  const [nameMap, setNameMap] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.device.listDuplicates()
      setGroups(result)
      setNameMap(Object.fromEntries(result.flatMap((g) => g.devices.map((d) => [d.id, d.name]))))
    } catch (e: unknown) {
      // 只读通道异常不阻断弹窗骨架，展示错误信息
      message.error(e instanceof Error ? e.message : String(e))
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  // D-11/D-12：内联改名单台保存——service 层事务内查重（排除自身），
  // 冲突报错信息含对方名称+IP，辅助用户改成不同名
  const handleSave = async (device: DupDevice) => {
    const newName = (nameMap[device.id] ?? device.name).trim()
    if (!newName || newName === device.name) return
    setSavingId(device.id)
    try {
      await window.api.device.update(device.id, { name: newName } as UpdateDeviceDTO)
      message.success(`已改名为『${newName}』`)
      await refresh()
      onChanged()
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingId(null)
    }
  }

  const cleared = open && !loading && groups.length === 0

  return (
    <Modal
      title="重名设备清单"
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnHidden
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
      ) : cleared ? (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <Text strong style={{ color: '#52c41a', fontSize: 16 }}>唯一防护已启用 ✓</Text>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">所有重名已处理，数据库唯一索引已自动建立，后续同名保存将被拦截。</Text>
          </div>
        </div>
      ) : groups.length === 0 ? (
        <Empty description="无重名设备" />
      ) : (
        <>
          <Collapse
            items={groups.map((g) => ({
              key: g.nameHash,
              header: <span>{g.devices[0]?.name} <Text type="danger">×{g.devices.length}</Text></span>,
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  {g.devices.map((d) => (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <Text type="secondary" style={{ minWidth: 220 }}>
                        {`${d.ipAddress}${d.model ? ` / ${d.model}` : ''}${d.vendor ? ` / ${d.vendor}` : ''}`}
                      </Text>
                      <Input
                        style={{ width: 200 }}
                        value={nameMap[d.id] ?? d.name}
                        onChange={(e) => setNameMap((prev) => ({ ...prev, [d.id]: e.target.value }))}
                        onPressEnter={() => handleSave(d)}
                      />
                      <Button
                        size="small"
                        type="primary"
                        loading={savingId === d.id}
                        disabled={!(nameMap[d.id] ?? d.name).trim() || (nameMap[d.id] ?? d.name).trim() === d.name}
                        onClick={() => handleSave(d)}
                      >
                        保存
                      </Button>
                    </div>
                  ))}
                </Space>
              ),
            }))}
          />
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">清零后：唯一索引自动启用 ✓（改完最后一组重名时后台立即生效）</Text>
          </div>
        </>
      )}
    </Modal>
  )
}
