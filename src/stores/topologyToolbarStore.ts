import { create } from 'zustand'

interface TopologyToolbarState {
  // Phase 19 / REN-02（P14）：字段 optional 化——与 TopologySummary 对齐，兼容持久化历史 JSON
  topologies: { id?: string; name?: string; status?: string }[]
  currentTopologyId: string | null
  onTopologyChange: (id: string | null) => void
  onNew: (name: string) => void
  onSave: () => void
  onDelete: () => void
  onImport: (jsonStr: string) => void
  onExport: () => void
  onOrganizeLayout: () => void
  // Phase 26 / 26-04 再工 spec ④：画布选中设备数——整理布局 tooltip 按选中态动态文案
  selectedCount: number
  // Phase 26 / D-11：网格吸附 toggle（默认关闭）+ 预览态标记（防误离开拦截，T-26-03-03）
  snapEnabled: boolean
  onToggleSnap: () => void
  isLayoutPreviewing: boolean
}

interface ToolbarStore {
  toolbar: TopologyToolbarState | null
  setToolbar: (state: TopologyToolbarState | null) => void
}

export const useTopologyToolbarStore = create<ToolbarStore>((set) => ({
  toolbar: null,
  setToolbar: (state) => set({ toolbar: state }),
}))
